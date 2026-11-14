import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { campaignRounds } from "./campaign-contract.mjs";
import { digest, durable, physical, readRegular } from "./evidence.mjs";

export const auditWaitMs = 24 * 60 * 60 * 1000;
export function parseCampaignArgs(args) {
  assert.ok(Array.isArray(args) && args.every((v) => typeof v === "string"));
  assert.equal(args.length, 5, "usage: campaign-entry.mjs rN --commit SHA --state-dir /bench/campaign");
  const [round, commitFlag, commit, stateFlag, stateRoot] = args;
  campaignRounds(round);
  assert.equal(commitFlag, "--commit"); assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(stateFlag, "--state-dir"); assert.equal(stateRoot, "/bench/campaign", "one fixed host reservation root required");
  return Object.freeze({ round, commit, stateRoot });
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
  const [{ bindCampaign }, { createCampaign }] = await Promise.all([import("./campaign-contract.mjs"), import("./campaign.mjs")]);
  const abort = new AbortController(), cancel = () => abort.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  let handle, transport = null;
  const campaign = createCampaign({ authorize(subject) {
    // Calling this fixed entry is the trusted parent's operator-authorized launch.
    if (subject.action === "begin-campaign") return subject.commit === input.commit && subject.round === input.round;
    return ["stage-json-audit", "stage-mixed-audit"].includes(subject.action) && transport !== null
      && subject.action === (transport.group === "mixed-production" ? "stage-mixed-audit" : "stage-json-audit")
      && transport.subjectSha256 === subject.auditSubjectSha256
      && readAuditInbox(handle.directory, transport.group)?.sha256 === transport.sha256;
  } });
  try {
    handle = await campaign.begin(bindCampaign({ round: input.round, commit: input.commit }), { stateRoot: input.stateRoot, signal: abort.signal });
    let status = campaign.status(handle), deadline = null;
    while (status.state === "active" || status.state === "blocked-review-needed") {
      if (abort.signal.aborted) { status = campaign.stop(handle); break; }
      if (status.state === "active") { deadline = null; status = await campaign.advance(handle, { signal: abort.signal }); }
      else {
        deadline ??= Date.now() + auditWaitMs;
        if (Date.now() >= deadline) { status = campaign.stop(handle, "independent native audit delivery deadline expired"); break; }
        const group = status.auditGroup ?? "json-api", inbox = readAuditInbox(handle.directory, group);
        if (inbox) {
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
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCampaignEntry(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error("isolated-campaign-failed; preserve owned state and native evidence"); process.exitCode = 2;
  });
}
