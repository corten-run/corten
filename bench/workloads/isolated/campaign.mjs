import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { validateCampaign, freeze, jsonPhase, mixedPhase } from "./campaign-contract.mjs";
import { verifyWorkingSources } from "./worker.mjs";
import { copyEvidence, digest, durable, inside, phaseSnapshot, physical, readRegular, syncDirectory, tree } from "./evidence.mjs";
import { supervise } from "./process.mjs";
import { observeHost, verifyHostBoundary } from "./host-observation.mjs";
import { auditSubject, imageProof, inspectPreparation, snapshotSources, validateAuditDelivery, validateTimingAudit } from "./json-staging.mjs";
import { inspectNative } from "./native-replay.mjs";
import { beginLifetime, composeHostProof, inspectLifetime } from "./host-lifetime.mjs";
import { composePhase } from "./composition.mjs";
import { prepareMixedAudit, replayMixedSubject, validateMixedDelivery, validateMixedRun } from "./mixed-staging.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function fresh(path) {
  assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, "native output already exists");
  let parent = dirname(path); while (!lstatSync(parent, { throwIfNoEntry: false })) parent = dirname(parent);
  physical(parent);
}

/** Live-process authority only. No provider, deletion, arbitrary validator or restart API. */
export function createCampaign({ authorize }) {
  assert.equal(typeof authorize, "function", "explicit parent authorization policy required");
  const owned = new WeakMap();
  function own(handle) {
    const c = owned.get(handle); assert.ok(c, "campaign is not owned by this live job");
    physical(c.root); physical(c.directory);
    assert.equal(digest(readRegular(join(c.root, ".host-attempt.json"))), c.lockHash, "campaign reservation changed");
    const stat = lstatSync(c.directory); assert.equal(stat.ino, c.inode); assert.equal(stat.dev, c.device);
    for (const file of c.files) assert.equal(digest(readRegular(join(c.directory, file.path))), file.sha256, "campaign record/log mutated");
    return c;
  }
  function save(c, path, value) {
    own(c.handle); const bytes = json(value); durable(join(c.directory, path), bytes);
    c.files.push({ path, sha256: digest(bytes) });
  }
  function event(c, kind, data = {}) {
    const value = { schema: "benchmark-isolated-campaign-event/v1", sequence: c.sequence++, campaign: c.handle.id,
      round: c.plan.round, campaignSha256: c.plan.campaignSha256, at: new Date().toISOString(), kind, ...data, status: status(c) };
    save(c, `${String(value.sequence).padStart(5, "0")}-${kind}.json`, value);
  }
  function verifyPhases(c) {
    own(c.handle);
    for (const p of c.phases) {
      assert.deepEqual(tree(p.native), p.manifest, "sealed native evidence mutated");
      if (p.present) assert.deepEqual(tree(p.original), p.manifest, "original native evidence mutated");
      else assert.equal(lstatSync(p.original, { throwIfNoEntry: false }), undefined, "native output appeared after failure");
    }
    if (c.audit) assert.deepEqual(tree(c.audit.sourceRoot), c.audit.subject.sourcesManifest.snapshot, "sealed source snapshot mutated");
    if (c.mixedAudit) assert.deepEqual(tree(c.mixedAudit.sourceRoot), c.mixedAudit.subject.sourcesManifest.snapshot, "sealed mixed source/context snapshot mutated");
  }
  function status(c) {
    own(c.handle);
    return freeze({ schema: "benchmark-isolated-campaign-status/v1", campaign: c.handle.id, round: c.plan.round,
      campaignSha256: c.plan.campaignSha256, state: c.state, nextGroup: c.plan.order[c.index] ?? null,
      executionVersion: 3,
      outcomes: structuredClone(c.outcomes), auditSubjectSha256: c.audit?.subject.subjectSha256 ?? null,
      uncollectedNativeRoots: structuredClone(c.pendingNative),
      mixedAuditSubjectSha256: c.mixedAudit?.subject.subjectSha256 ?? null,
      auditGroup: c.state === "blocked-review-needed" ? c.plan.order[c.index] : null,
      auditInbox: c.state === "blocked-review-needed" ? `${c.handle.id}/${c.plan.order[c.index] === "mixed-production" ? "mixed" : "json"}-audit-delivery.json` : null,
      controllerReady: false, isolation: "unverified", executionAuthorized: "separate-parent-policy",
      reservation: "retained-no-release-or-restart" });
  }
  function halt(c, error) {
    c.state = "preserved-uncertain";
    for (const binding of c.plan.bindings.slice(c.index)) {
      if (!c.outcomes.some((r) => r.group === binding.request.group)) c.outcomes.push({ group: binding.request.group,
        outcome: c.attempted.has(binding.request.group) ? "preserved-uncertain" : "not-run", coverage: binding.coverage,
        blockers: ["campaign halted; no retry or assumed cleanup", error.message] });
    }
    event(c, "halted", { error: error.message });
    save(c, "campaign-result.json", { status: status(c), wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
  }
  async function exclusive(handle, fn) {
    const c = own(handle); assert.equal(c.busy, false, "campaign operation already in progress"); c.busy = true;
    try { verifyPhases(c); return await fn(c); }
    catch (error) {
      if (!["finished", "preserved-uncertain"].includes(c.state)) halt(c, error);
      throw error;
    } finally { c.busy = false; }
  }
  async function command(c, binding, invocation, directory, signal) {
    own(c.handle); verifyWorkingSources(c.plan.bindings[0]);
    const number = c.commandIndex++, path = `${directory}/command-${number}.log`, fd = openSync(join(c.directory, path), "wx", 0o600);
    let result, observer, hostManifestSha256, pid;
    try {
      event(c, "command-intent", { group: binding.request.group, invocation });
      result = await supervise({ ...invocation, shell: false }, { cwd: repo,
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: os.homedir(), LANG: "C.UTF-8", TZ: "UTC",
          GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", ...binding.resources.requestedCpuEnv }, signal,
        log(bytes) { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); assert.ok(n > 0); offset += n; } },
        onStart(value) {
          pid = value; event(c, "command-started", { pid });
          observer = beginLifetime({ campaign: c.handle.id, binding, invocation,
            directory: join(c.directory, directory, `command-${number}-host`), command: number, pid });
          observer.attach(pid);
        },
      });
    } finally { try { fsyncSync(fd); } finally { closeSync(fd); } }
    c.files.push({ path, sha256: digest(readRegular(join(c.directory, path))) });
    if (observer) {
      const manifest = observer.finish(result); hostManifestSha256 = manifest.sha256;
      for (const file of manifest.entries.filter((e) => e.type === "file")) c.files.push({
        path: `${directory}/command-${number}-host/${file.path}`, sha256: file.sha256 });
    }
    event(c, "command-exited", { ...result, ...(hostManifestSha256 ? { hostManifestSha256 } : {}) });
    assert.equal(result.terminal, true, "native process is not observed terminal");
    return { ...result, number, pid, hostManifestSha256 };
  }
  async function phase(c, binding, phaseName, signal) {
    verifyWorkingSources(c.plan.bindings[0]);
    const original = join(repo, ...binding.validation.artifactRoot.split("/")); fresh(original);
    const relative = `${String(c.index).padStart(2, "0")}-${binding.request.group}-${phaseName}`;
    const directory = join(c.directory, relative); mkdirSync(directory, { mode: 0o700 }); syncDirectory(c.directory);
    c.attempted.add(binding.request.group);
    const pending = { group: binding.request.group, phase: phaseName, artifactRoot: binding.validation.artifactRoot };
    c.pendingNative.push(pending); event(c, "native-output-reserved", pending);
    const before = observeHost(); save(c, `${relative}/host-before.json`, before);
    const commands = [];
    for (const invocation of [...binding.preparation.fixtures, binding.execution.invocation]) {
      if (signal?.aborted) throw new Error("campaign cancelled");
      if (invocation === binding.execution.invocation) fresh(original);
      const result = await command(c, binding, invocation, relative, signal); commands.push(result);
      if (!result.success) break;
    }
    let after, boundaryError;
    try {
      verifyWorkingSources(c.plan.bindings[0]); after = observeHost(); save(c, `${relative}/host-after.json`, after);
    } catch (error) { boundaryError = error; }
    const native = join(directory, "native"), present = !!lstatSync(original, { throwIfNoEntry: false });
    let manifest;
    if (present) manifest = copyEvidence(original, native);
    else { assert.ok(commands.some((r) => !r.success), "native output missing"); mkdirSync(native, { mode: 0o700 }); manifest = tree(native); }
    const p = { relative, native, original, manifest, present, commands, cleanup: null };
    c.phases.push(p); save(c, `${relative}/native-manifest.json`, manifest);
    c.pendingNative.splice(c.pendingNative.indexOf(pending), 1);
    event(c, "phase-sealed", { ...pending, nativeManifestSha256: manifest.sha256,
      phaseManifestSha256: phaseSnapshot(directory, binding.request.group === "json-api" && phaseName === "prepare").sha256 });
    if (boundaryError) throw boundaryError;
    p.cleanup = verifyHostBoundary(before, after);
    return p;
  }
  function cancelled(c, phase, signal) {
    if (!signal?.aborted && !phase.commands.some((r) => r.cancelled || r.forced)) return false;
    halt(c, new Error("campaign cancelled; no further advancement"));
    return true;
  }
  return Object.freeze({
    async begin(plan, { stateRoot, signal } = {}) {
      plan = freeze(structuredClone(plan)); validateCampaign(plan);
      assert.equal(os.platform(), "linux"); assert.ok(os.availableParallelism() >= 8);
      assert.ok(Number(process.versions.node.split(".")[0]) >= 24); assert.ok(!signal?.aborted);
      verifyWorkingSources(plan.bindings[0]);
      assert.equal(stateRoot, "/bench/campaign", "one fixed host reservation root required");
      const root = physical(stateRoot); assert.ok(!inside(repo, root) && !inside(root, repo));
      const stat = lstatSync(root);
      if (process.platform === "linux") { assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o077, 0); }
      const subject = freeze({ action: "begin-campaign", campaignSha256: plan.campaignSha256, commit: plan.commit,
        round: plan.round, stateRoot: root, host: os.hostname(), groups: plan.order });
      assert.equal(await authorize(subject), true, "parent did not authorize this exact campaign");
      assert.ok(!signal?.aborted); verifyWorkingSources(plan.bindings[0]);
      for (const b of plan.bindings) fresh(join(repo, ...b.validation.artifactRoot.split("/")));
      fresh(join(repo, ...jsonPhase(plan, "prepare").validation.artifactRoot.split("/")));
      const id = `${plan.round}-${randomBytes(8).toString("hex")}`;
      const lock = json({ schema: "benchmark-isolated-campaign-reservation/v1", id, campaignSha256: plan.campaignSha256,
        commit: plan.commit, pid: process.pid, createdAt: new Date().toISOString() });
      durable(join(root, ".host-attempt.json"), lock);
      const directory = join(root, id); mkdirSync(directory, { mode: 0o700 }); syncDirectory(root);
      const info = lstatSync(directory), handle = Object.freeze({ id, directory });
      const c = { handle, root, directory, inode: info.ino, device: info.dev, lockHash: digest(lock), plan,
        files: [], sequence: 0, commandIndex: 0, busy: false, index: 0, phases: [], outcomes: [], attempted: new Set(), pendingNative: [], state: "active", audit: null, mixedAudit: null };
      owned.set(handle, c); save(c, "plan.json", plan); event(c, "authorized", { subject, trustBoundary: "explicit trusted parent policy, not review data" });
      try {
        const observed = observeHost(); save(c, "host-initial.json", observed);
        assert.deepEqual(observed.containers, [], "fresh campaign host has preexisting containers");
        event(c, "started"); return handle;
      } catch (error) { halt(c, error); throw error; }
    },
    async advance(handle, { signal } = {}) {
      return exclusive(handle, async (c) => {
        assert.equal(c.state, "active", "campaign is not eligible to advance");
        assert.ok(!signal?.aborted, "campaign cancelled");
        const binding = c.plan.bindings[c.index]; assert.ok(binding, "campaign already exhausted");
        const group = binding.request.group;
        if (group === "mixed-production" && !c.mixedAudit) {
          const sourceRoot = join(c.directory, "mixed-audit-sources"), subject = await prepareMixedAudit(c.plan, repo, sourceRoot);
          verifyWorkingSources(c.plan.bindings[0]);
          c.mixedAudit = { sourceRoot, subject, accepted: false }; save(c, "mixed-audit-subject.json", subject);
          c.state = "blocked-review-needed"; event(c, "mixed-review-needed", { subjectSha256: subject.subjectSha256 });
          return status(c);
        }
        if (group === "json-api" && !c.audit) {
          const prepBinding = jsonPhase(c.plan, "prepare"); const p = await phase(c, prepBinding, "prepare", signal);
          if (cancelled(c, p, signal)) return status(c);
          let prepared;
          try {
            assert.ok(p.commands.slice(0, -1).every((r) => r.success));
            const last = p.commands.at(-1); assert.equal(p.commands.length, prepBinding.preparation.fixtures.length + 1);
            assert.equal(last.code, 1); assert.equal(last.error, null); assert.equal(last.cancelled, false); assert.equal(last.forced, false);
            prepared = inspectPreparation(prepBinding, p.native);
          } catch (error) {
            c.outcomes.push({ group, outcome: "failed", phase: "prepare", error: error.message, manifest: p.manifest.sha256 });
          }
          if (prepared) {
            const images = imageProof(prepared.summary); save(c, `${p.relative}/images.json`, images);
            const sourceRoot = join(c.directory, "audit-sources");
            const sources = snapshotSources(c.plan.bindings[0], repo, sourceRoot);
            const subject = auditSubject(c.plan, prepared, p.manifest, sources, images);
            c.audit = { subject, sourceRoot, prepared, accepted: false, phase: p };
            save(c, "json-audit-subject.json", subject); c.state = "blocked-review-needed";
            event(c, "review-needed", { subjectSha256: subject.subjectSha256, nativeExit: 1, qualification: "blocked", cleanup: p.cleanup });
            return status(c);
          }
        } else {
          const effective = group === "json-api" ? jsonPhase(c.plan, "timing", join(c.directory, "json-native-audits.json"))
            : group === "mixed-production" ? mixedPhase(c.plan, c.handle.id) : binding;
          if (group === "mixed-production") assert.equal(c.mixedAudit.accepted, true);
          if (group === "json-api") {
            assert.equal(c.audit.accepted, true);
            assert.deepEqual(imageProof(c.audit.prepared.summary), c.audit.subject.images, "audited built images changed");
          }
          const p = await phase(c, effective, "timing", signal);
          if (cancelled(c, p, signal)) return status(c);
          if (group === "json-api") assert.deepEqual(imageProof(c.audit.prepared.summary), c.audit.subject.images, "audited images changed during timing");
          let timingAudit;
          if (group === "mixed-production") timingAudit = { complete: validateMixedRun(effective, p.native, c.mixedAudit.subject, c.mixedAudit.bundle) };
          if (group === "json-api") {
            try { timingAudit = validateTimingAudit(effective, p.native, c.audit.subject, c.audit.bundle, c.audit.sourceRoot); }
            catch { throw new Error("timing-audit-does-not-match-accepted-subject"); }
          }
          const native = await inspectNative(effective, p.native);
          const last = p.commands.at(-1), { number, pid, hostManifestSha256, ...result } = last;
          let host = { resources: "blocked", cleanupComplete: false };
          if (hostManifestSha256) {
            const invocation = [...effective.preparation.fixtures, effective.execution.invocation][p.commands.length - 1];
            const observation = inspectLifetime(effective, invocation,
              join(c.directory, p.relative, `command-${number}-host`), { campaign: c.handle.id, command: number, pid, result });
            assert.equal(observation.manifestSha256, hostManifestSha256);
            host = composeHostProof(effective, native, observation);
          }
          c.outcomes.push({ group, ...composePhase(effective, native, host, p.commands, !["json-api", "mixed-production"].includes(group) || timingAudit.complete), host,
            nativeManifestSha256: p.manifest.sha256, cleanup: p.cleanup, isolation: "external-exclusive-host-policy" });
        }
        c.index++; event(c, "group-finished", c.outcomes.at(-1));
        if (c.index === c.plan.order.length) {
          c.state = "finished"; event(c, "finished", { controllerReady: false });
          save(c, "campaign-result.json", { status: status(c), wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
        }
        verifyPhases(c); return status(c);
      });
    },
    async submitJsonAudit(handle, delivery) {
      return exclusive(handle, async (c) => {
        assert.equal(c.state, "blocked-review-needed"); assert.ok(c.audit && !c.audit.accepted);
        assert.ok(Buffer.byteLength(JSON.stringify(delivery)) <= 16 * 1024 * 1024, "audit delivery too large");
        delivery = freeze(structuredClone(delivery)); save(c, "json-audit-delivery-retained.json", delivery);
        const inbox = join(c.directory, "json-audit-delivery.json");
        if (lstatSync(inbox, { throwIfNoEntry: false })) {
          const stat = lstatSync(inbox);
          if (process.platform === "linux") { assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o077, 0); }
          const bytes = readRegular(inbox); assert.deepEqual(JSON.parse(bytes), delivery, "audit transport changed");
          c.files.push({ path: "json-audit-delivery.json", sha256: digest(bytes) });
        }
        const subject = freeze({ action: "stage-json-audit", campaignSha256: c.plan.campaignSha256,
          auditSubjectSha256: c.audit.subject.subjectSha256, deliverySha256: digest(json(delivery)), review: delivery.review });
        assert.equal(await authorize(subject), true, "parent transport/operator did not authorize this audit delivery");
        const checked = validateAuditDelivery(delivery, c.audit.subject, c.audit.sourceRoot);
        verifyWorkingSources(c.plan.bindings[0]); verifyPhases(c);
        assert.deepEqual(imageProof(c.audit.prepared.summary), c.audit.subject.images, "built images changed during review");
        save(c, "json-native-audits.json", checked.bundle);
        c.audit.bundle = checked.bundle; c.audit.accepted = true; c.state = "active";
        event(c, "audit-staged", { subject, trustBoundary: "operator-authorized transport and independent human audit; unsigned data is not self-approval" });
        return status(c);
      });
    },
    async submitMixedAudit(handle, delivery) {
      return exclusive(handle, async (c) => {
        assert.equal(c.state, "blocked-review-needed"); assert.equal(c.plan.order[c.index], "mixed-production");
        assert.ok(c.mixedAudit && !c.mixedAudit.accepted);
        assert.ok(Buffer.byteLength(JSON.stringify(delivery)) <= 16 * 1024 * 1024);
        delivery = freeze(structuredClone(delivery)); save(c, "mixed-audit-delivery-retained.json", delivery);
        const inbox = join(c.directory, "mixed-audit-delivery.json");
        if (lstatSync(inbox, { throwIfNoEntry: false })) {
          const stat = lstatSync(inbox);
          if (process.platform === "linux") { assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o077, 0); }
          const bytes = readRegular(inbox); assert.deepEqual(JSON.parse(bytes), delivery);
          c.files.push({ path: "mixed-audit-delivery.json", sha256: digest(bytes) });
        }
        const subject = freeze({ action: "stage-mixed-audit", campaignSha256: c.plan.campaignSha256,
          auditSubjectSha256: c.mixedAudit.subject.subjectSha256, deliverySha256: digest(json(delivery)), review: delivery.review });
        assert.equal(await authorize(subject), true, "parent transport/operator did not authorize this mixed delivery");
        await replayMixedSubject(c.plan, c.mixedAudit.subject, repo, c.mixedAudit.sourceRoot);
        const checked = validateMixedDelivery(delivery, c.mixedAudit.subject, c.mixedAudit.sourceRoot);
        verifyWorkingSources(c.plan.bindings[0]); verifyPhases(c);
        save(c, "mixed-native-audits.json", checked.bundle);
        c.mixedAudit.bundle = checked.bundle; c.mixedAudit.accepted = true; c.state = "active";
        event(c, "mixed-audit-staged", { subject, trustBoundary: "operator-authorized delivery; independent source/context review, not image or OS authority" });
        return status(c);
      });
    },
    status(handle) { return status(own(handle)); },
    stop(handle, reason = "campaign job cancelled or audit deadline expired") {
      const c = own(handle); assert.equal(c.busy, false, "wait for owned command shutdown before stopping");
      if (!["finished", "preserved-uncertain"].includes(c.state)) halt(c, new Error(reason));
      return status(c);
    },
    verify(handle) { const c = own(handle); verifyPhases(c); return status(c); },
    collect(handle) {
      const c = own(handle); assert.equal(c.busy, false); assert.equal(c.state, "finished", "whole campaign is not finished");
      verifyPhases(c); return freeze({ status: status(c), manifest: tree(c.directory), wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
    },
  });
}
