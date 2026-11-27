import assert from "node:assert/strict";
import { linkSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { auditWaitMs, campaignRounds } from "./campaign-contract.mjs";
import { alternateCampaignPlacements } from "./contract.mjs";
import { catalogFleetPlacement, jsonFleetPlacementFor } from "../cloud-contract.mjs";
import { groupNames } from "../registry.mjs";
import { digest, durable, physical, readRegular } from "./evidence.mjs";
import { superviseControlStream } from "./control-stream-remote.mjs";

export { auditWaitMs };
export function parseCampaignArgs(args) {
  assert.ok(Array.isArray(args) && args.every((v) => typeof v === "string"));
  assert.ok([5, 7, 9].includes(args.length), `usage: campaign-entry.mjs rN --commit SHA --state-dir /bench/campaign [--group GROUP [--load-layout c16-generator-v1|json-c16-generator-v1|json-c32-generator-v1 | --placement ${alternateCampaignPlacements.join("|")}]]`);
  const [round, commitFlag, commit, stateFlag, stateRoot, groupFlag, group, modeFlag, mode] = args;
  campaignRounds(round);
  assert.equal(commitFlag, "--commit"); assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(stateFlag, "--state-dir"); assert.equal(stateRoot, "/bench/campaign", "one fixed host reservation root required");
  if (args.length >= 7) {
    assert.equal(groupFlag, "--group"); assert.ok(groupNames.includes(group), "unknown registry group");
  }
  if (args.length === 9) {
    assert.ok(modeFlag === "--load-layout" && group === "catalog-page" && mode === catalogFleetPlacement.loadLayout
      || modeFlag === "--load-layout" && jsonFleetPlacementFor(group, mode)
      || modeFlag === "--placement" && group !== "catalog-page" && alternateCampaignPlacements.includes(mode), "unknown group placement");
  }
  return Object.freeze({ round, commit, stateRoot, ...(group === undefined ? {} : { group }),
    ...(modeFlag === "--load-layout" ? { loadLayout: mode } : modeFlag === "--placement" ? { placement: mode } : {}) });
}

// The parent/operator controls delivery to this same-UID private inbox. JSON fields
// describe review, not authority. There is deliberately no receipt-based resume.
export function readAuditInbox(directory, group = "json-api") {
  assert.ok(["json-api", "mixed-production"].includes(group));
  physical(directory);
  const path = join(directory, `${group === "mixed-production" ? "mixed" : "json"}-audit-delivery.json`), stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, "unsafe audit inbox");
  if (process.platform === "linux") {
    assert.equal(stat.uid, process.getuid(), "foreign audit transport owner"); assert.equal(stat.mode & 0o077, 0, "audit inbox must be private");
  }
  const bytes = readRegular(path);
  assert.ok(bytes.length <= 16 * 1024 * 1024, "audit inbox grew beyond limit");
  return { delivery: JSON.parse(bytes), sha256: digest(bytes) };
}

export async function runCampaignEntry(args) {
  const input = parseCampaignArgs(args);
  const [{ bindCampaign, bindGroupCampaign }, { createCampaign }, { bootstrapControl, controlOperation, waitControlAdmission }] =
    await Promise.all([import("./campaign-contract.mjs"), import("./campaign.mjs"), import("./control-admission.mjs")]);
  const abort = new AbortController(), cancel = () => abort.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  let handle, transport = null, stream;
  const campaign = createCampaign({ authorize(subject) {
    // Calling this fixed entry is the trusted parent's operator-authorized launch.
    if (subject.action === "begin-campaign") return subject.commit === input.commit && subject.round === input.round
      && (input.group === undefined || subject.groups?.length === 1 && subject.groups[0] === input.group);
    return ["stage-json-audit", "stage-mixed-audit"].includes(subject.action) && transport !== null
      && subject.action === (transport.group === "mixed-production" ? "stage-mixed-audit" : "stage-json-audit")
      && transport.subjectSha256 === subject.auditSubjectSha256
      && readAuditInbox(handle.directory, transport.group)?.sha256 === transport.sha256;
  } });
  try {
    const { offlineHandoff, ...control } = bootstrapControl(input);
    if (offlineHandoff) assert.ok(input.group, "offline handoff requires one group");
    const admission = await waitControlAdmission(control, "bootstrap", { signal: abort.signal, deadline: Date.now() + 45 * 60000 });
    if (offlineHandoff) assert.equal(admission.apparatus, undefined, "offline handoff has a stream apparatus");
    if (admission.apparatus) {
      stream = await superviseControlStream(control, admission, abort);
    }
    controlOperation(control, "activate");
    const request = { round: input.round, commit: input.commit };
    const plan = input.group === undefined ? bindCampaign(request) : bindGroupCampaign({ ...request, group: input.group }, input.loadLayout ?? input.placement);
    handle = await campaign.begin(plan, { stateRoot: input.stateRoot, signal: abort.signal,
      control: { binding: control, admission, stream, ...(offlineHandoff ? { offlineHandoff: true } : {}) } });
    let status = campaign.status(handle), deadline = null;
    while (status.state === "active" || status.state === "blocked-review-needed") {
      stream?.progress(status);
      if (abort.signal.aborted) { status = campaign.stop(handle); break; }
      if (status.state === "active") { deadline = null; status = await campaign.advance(handle, { signal: abort.signal }); }
      else {
        let remaining;
        if (offlineHandoff) {
          remaining = campaign.offlineAuditRemainingMs(handle);
          if (remaining === 0) {
            const collection = campaign.expireOfflineAudit(handle);
            durable(join(handle.directory, "collection-manifest.json"), `${JSON.stringify(collection, null, 2)}\n`);
            return 2; // An exact failed archive, never a completed timing run.
          }
        } else {
          deadline ??= Date.now() + auditWaitMs;
          if (Date.now() >= deadline) {
            status = campaign.stop(handle, "independent native audit delivery deadline expired"); break;
          }
        }
        const group = status.auditGroup ?? "json-api", prefix = group === "mixed-production" ? "mixed" : "json";
        const pending = join(handle.directory, `${prefix}-audit-delivery-pending.json`);
        if (lstatSync(pending, { throwIfNoEntry: false })) {
          if (stream) campaign.recordStreamAudit(handle, stream.audit(group, readRegular(pending)));
          else {
            // Offline admission uses the remaining monotonic budget, not the
            // wall deadline used by the existing bootstrap/monitored path.
            const proof = await waitControlAdmission(control, `audit-${group}`, offlineHandoff
              ? { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(remaining)]), deadline: Infinity }
              : { signal: abort.signal, deadline });
            if (offlineHandoff) assert.ok(campaign.offlineAuditRemainingMs(handle) > 0, "offline audit admission reached the deadline");
            campaign.recordControlAdmission(handle, proof);
          }
          // Exclusive hard-link publication; no overwrite, symlink traversal or shell.
          const info = lstatSync(pending);
          assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 16 * 1024 * 1024);
          if (process.platform === "linux") assert.ok(info.uid === process.getuid() && (info.mode & 0o077) === 0);
          const bytes = readRegular(pending), current = lstatSync(pending);
          assert.ok(bytes.length === info.size && current.ino === info.ino && current.dev === info.dev && current.mtimeMs === info.mtimeMs);
          linkSync(pending, join(handle.directory, `${prefix}-audit-delivery.json`)); unlinkSync(pending);
        }
        const inbox = readAuditInbox(handle.directory, group);
        if (inbox) {
          if (offlineHandoff) assert.ok(campaign.offlineAuditRemainingMs(handle) > 0, "offline audit delivery reached the deadline");
          transport = { sha256: inbox.sha256, group, subjectSha256: group === "mixed-production" ? status.mixedAuditSubjectSha256 : status.auditSubjectSha256 };
          status = group === "mixed-production" ? await campaign.submitMixedAudit(handle, inbox.delivery) : await campaign.submitJsonAudit(handle, inbox.delivery);
          transport = null;
        } else {
          try { await delay(1000, undefined, { signal: abort.signal }); }
          catch (error) { if (!abort.signal.aborted) throw error; }
        }
      }
    }
    if (status.state === "finished") {
      stream?.check();
      if (stream) {
        const proof = await stream.finish({ id: stream.registration.id, nativeTerminal: true, campaign: handle.id,
          sealSha256: digest(readRegular(join(handle.directory, "control-stream-seal.json"))) });
        durable(join(handle.directory, "control-stream-drain.json"), JSON.stringify(proof));
      }
      const collection = campaign.collect(handle);
      durable(join(handle.directory, "collection-manifest.json"), `${JSON.stringify(collection, null, 2)}\n`);
      const { validateCampaign } = await import("./campaign-verify.mjs");
      const saved = await validateCampaign({ folder: input.stateRoot, round: input.round, commit: input.commit });
      if (saved.status === "verified") return 0; // Intrinsic completion only; live controller authority remains separate.
      if (["failed", "blocked"].includes(saved.status) && saved.collectionIntegrity === "manifest-verified"
        && saved.commandLifecycle === "observed-terminal" && saved.uncollectedNativeRoots.length === 0) return 1;
    }
    return 2;
  } catch (error) {
    if (handle) campaign.stop(handle, error.message);
    throw error;
  } finally {
    await stream?.dispose();
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCampaignEntry(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error("isolated-campaign-failed; preserve owned state and native evidence"); process.exitCode = 2;
  });
}
