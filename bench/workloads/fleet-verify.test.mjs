// Synthetic saved artifacts only. These cannot establish native readiness.
import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as turn, setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { accountId, archive, commit, context, harness, syntheticInspection } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { digest, fileHash, treeHash } from "./cloud-local.mjs";
import { groupNames } from "./registry.mjs";
import { fleetChildOptions, fleetLockSnapshot, readFleet, recheckCollectedGroup, verifyCollectedGroup, verifyFleet, verifyFleetCli,
  windowsProcessStart } from "./fleet-verify.mjs";
import { localCompilerMissing } from "./cloud-validation-snapshot.mjs";
import { createErroredReceipt, createErroredRecord, setupEvidence, terminalSetupScript, unusedEvidence, unusedHostScript } from "./cloud-retirement.mjs";
import { inspectContinuation } from "./group-continuation.mjs";

function fixture(t) {
  const h = harness(t), at = "2026-11-14T00:00:00.000Z";
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16),
    tokens: Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")])),
    provider: { accountId, context }, sshKey: "42" }, at);
  const manifestPath = join(h.base, "fleet-r21.json"); writeFileSync(manifestPath, JSON.stringify(fleet));
  const reports = new Map(), jobs = new Map(), calls = [];
  function seed(group) {
    const i = groupNames.indexOf(group), local = join(h.base, group, "groups-r21"), evidence = join(local, "evidence-Synthetic");
    const report = syntheticInspection("verified");
    Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", campaign: `r21-${fleet.jobs[i].token}`,
      selection: { ...fleet.selection, groups: fleet.selection.groups.filter((g) => g.group === group) }, groups: report.groups.filter((g) => g.group === group) });
    if (group === "catalog-page") report.loadLayout = "c16-generator-v1";
    const folder = join(evidence, "campaign"), planPath = join(folder, report.campaign, "plan.json"), reservationPath = join(folder, ".host-attempt.json");
    mkdirSync(join(folder, report.campaign), { recursive: true });
    writeFileSync(reservationPath, JSON.stringify({ schema: "benchmark-isolated-campaign-reservation/v1", id: report.campaign, commit, campaignSha256: report.campaignSha256 }));
    report.reservationSha256 = digest(readFileSync(reservationPath));
    writeFileSync(planPath, JSON.stringify({ round: "r21", commit, campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256 }));
    writeFileSync(join(evidence, "exit-code"), "0\n"); writeFileSync(join(evidence, "host.txt"), "SYNTHETIC hardware, not measured\n");
    writeFileSync(join(evidence, "run.log"), "SYNTHETIC no native measurement\n");
    const archivePath = join(local, "results.tgz"); writeFileSync(archivePath, archive([{ name: "campaign/" }]));
    const state = { ...reservation({ round: "r21", commit, token: fleet.jobs[i].token, group, fleet }, at),
      provider: fleet.provider, fullGroupQualified: false, status: "collected", createIntentAt: at,
      id: String(i + 1), ip: `192.0.2.${i + 1}`, archiveSha256: fileHash(archivePath),
      evidence: "evidence-Synthetic", extractionAttempts: ["evidence-Synthetic"], evidenceSha256: treeHash(evidence),
      evidenceOutcome: "validated", exitCode: 0, collectedAt: at, deletionIntentAt: at, destroyedAt: at,
      validation: { status: "verified", campaign: report.campaign, collectionIntegrity: "manifest-verified" } };
    const path = join(local, "state.json"); writeFileSync(path, JSON.stringify(state));
    const job = { group, local, evidence, folder, path, state, report, planPath, reservationPath, archivePath,
      save() { writeFileSync(path, JSON.stringify(state)); }, rehash() { state.evidenceSha256 = treeHash(evidence); this.save(); } };
    reports.set(folder, report); jobs.set(group, job); return job;
  }
  const input = { root: h.base, round: "r21", commit };
  const inspect = async (input) => { calls.push(input); assert.deepEqual(Object.keys(input).sort(), ["commit", "folder", "round"]); return reports.get(input.folder); };
  return { h, fleet, manifestPath, input, inspect, calls, jobs, seed,
    seedAll() { groupNames.forEach(seed); }, verify(deps = {}) { return verifyFleet(input, { inspect, ...deps }); } };
}

test("all current groups replay individually; hardware/hash references and failed app outcomes remain per host", async (t) => {
  const p = fixture(t); p.seedAll();
  const app = p.jobs.get(groupNames[0]).report.groups[0].appOutcomes[0];
  Object.assign(app, { outcome: "failed", comparisonEligible: false });
  const unsupported = p.jobs.get(groupNames[1]).report.groups[0].appOutcomes[0];
  Object.assign(unsupported, { outcome: "unsupported", comparisonEligible: false });
  const before = treeHash(p.h.base), result = await p.verify();
  assert.equal(result.schema, "benchmark-group-fleet-inspection/v1"); assert.equal(result.status, "verified");
  assert.equal(result.evidenceMode, "synthetic-inspection"); assert.equal(result.nativeReadiness, false); assert.equal(result.publishableBaseline, false);
  assert.equal(result.comparisonScope, "within-group-host-only");
  assert.deepEqual(result.groups.map((g) => g.group), groupNames); assert.equal(p.calls.length, groupNames.length);
  assert.deepEqual(result.groups[0].appOutcomes[0], app); assert.deepEqual(result.groups[1].appOutcomes[0], unsupported);
  for (const row of result.groups) {
    assert.deepEqual(row.host, p.fleet.jobs.find((job) => job.group === row.group).host ?? p.fleet.host);
    assert.equal(row.id, p.jobs.get(row.group).state.id);
    assert.equal(row.hardwareEvidence.sha256, digest(readFileSync(join(p.jobs.get(row.group).evidence, "host.txt"))));
    assert.equal(row.stateSha256, digest(readFileSync(p.jobs.get(row.group).path)));
    assert.equal(row.recordedTimes.reservationCreatedAt, p.jobs.get(row.group).state.createdAt);
    assert.match(row.timeScope, /not-provider-billing-or-benchmark-elapsed/);
  }
  assert.equal(treeHash(p.h.base), before, "inspection must be read-only");
});

test("shared group replay is read-only under caller custody; fleet verification reports a live root as busy", async (t) => {
  const p = fixture(t), j = p.seed(groupNames[0]);
  writeFileSync(join(p.h.base, ".fleet-operation.lock"), JSON.stringify({ pid: process.pid, approvalSha256: "a".repeat(64) }));
  const before = treeHash(p.h.base), fleet = readFleet(p.h.base, "r21");
  const proof = await verifyCollectedGroup(fleet, groupNames[0], { inspect: p.inspect });
  assert.equal(proof.row.outcome, "verified"); assert.equal(proof.evidenceMode, "synthetic-inspection");
  assert.equal(treeHash(p.h.base), before);
  const final = await p.verify(); assert.equal(final.status, "incomplete");
  assert.equal(final.error, "fleet-operation-busy"); assert.equal(final.fleetLock, "busy");
  assert.deepEqual(final.groups, []); assert.equal(p.calls.length, 1);
  writeFileSync(join(p.h.base, groupNames[0], ".groups-launch.lock"), "SYNTHETIC-unsettled");
  assert.throws(() => recheckCollectedGroup(fleet, proof.snapshot));
  assert.equal(readFileSync(j.path, "utf8"), JSON.stringify(j.state));
});

test("a root lock acquired during verification is busy, not changed evidence", async (t) => {
  const p = fixture(t); p.seed(groupNames[0]);
  const bytes = JSON.stringify({ pid: process.pid, approvalSha256: "b".repeat(64) }), path = join(p.h.base, ".fleet-operation.lock");
  const final = await p.verify({ inspect: async (input) => {
    writeFileSync(path, bytes, { flag: "wx" });
    return p.inspect(input);
  } });
  assert.equal(final.status, "incomplete"); assert.equal(final.error, "fleet-operation-busy");
  assert.equal(final.fleetLock, "busy"); assert.deepEqual(final.groups, []);
  assert.equal(readFileSync(path, "utf8"), bytes);
});

function batchIntents(p) {
  const fleet = readFleet(p.h.base, "r21"), group = groupNames[0], options = fleetChildOptions(fleet, group, "detach");
  const child = { controllerCommit: commit, options };
  const subject = { schema: "benchmark-group-fleet-staged-approval/v1", action: "detach", controllerCommit: commit, round: "r21",
    stateRoot: fleet.root, requestedRoot: fleet.root, manifestSha256: fleet.manifestSha256, fleet: fleet.manifest, records: {},
    admission: { mode: "first-group-only", firstGroup: group, gate: "collected-verified-deleted", nativeReadiness: false },
    jobs: [{ group, outcome: "planned", missing: [], options, subject: child, approvalSha256: digest(JSON.stringify(child)) },
      ...groupNames.slice(1).map((group) => ({ group, outcome: "deferred" }))] };
  const approvalSha256 = digest(JSON.stringify(subject));
  const launch = JSON.stringify({ schema: "benchmark-group-fleet-staged-launch-intent/v1", approvalSha256, subject });
  writeFileSync(join(fleet.root, "launch-intent.json"), launch);
  const remaining = { ...subject, action: "admit-remaining", records: { "launch-intent.json": digest(launch) },
    admission: { ...subject.admission, mode: "remaining-once" }, firstGroup: { evidenceMode: "native-replay", row: { group, outcome: "verified" } },
    jobs: [{ group, outcome: "verified" }, ...groupNames.slice(1).map((group) => {
      const options = fleetChildOptions(fleet, group, "detach"), subject = { options, controllerCommit: commit };
      return { group, outcome: "planned", missing: [], options, subject, approvalSha256: digest(JSON.stringify(subject)) };
    })] };
  const remainingSha256 = digest(JSON.stringify(remaining));
  writeFileSync(join(fleet.root, "remaining-intent.json"), JSON.stringify({
    schema: "benchmark-group-fleet-remaining-intent/v1", approvalSha256: remainingSha256, subject: remaining,
  }));
  return { launch: approvalSha256, remaining: remainingSha256 };
}

test("Windows process-start adapter reads the current process creation time", { skip: process.platform !== "win32" }, () => {
  const at = windowsProcessStart(process.pid);
  assert.ok(Number.isSafeInteger(at) && at <= Date.now(), "Windows returned no valid process creation time");
  assert.ok(Math.abs(at - performance.timeOrigin) < 60_000, "creation time does not match this Node process");
});

test("report replays pinned root evidence behind a dead or provably reused batch PID, without unlocking it", async (t) => {
  const p = fixture(t), j = p.seed(groupNames[0]), intents = batchIntents(p);
  const campaign = `campaign/${j.report.campaign}`;
  writeFileSync(j.archivePath, archive([
    { name: "campaign/" }, { name: `${campaign}/` },
    ...["run.log", "host.txt", "exit-code", "campaign/.host-attempt.json", `${campaign}/plan.json`]
      .map((name) => ({ name, body: readFileSync(join(j.evidence, name)) })),
  ]));
  j.state.archiveSha256 = fileHash(j.archivePath);
  j.save();
  const path = join(p.h.base, ".fleet-operation.lock");
  const setPid = (pid, approval = intents.remaining) => writeFileSync(path, JSON.stringify({ pid, approvalSha256: approval }));
  setPid(2147483647);
  const dead = await p.verify({ processStart: () => assert.fail("an absent PID needs no start lookup") });
  assert.equal(dead.fleetLock, "retained"); assert.equal(dead.groups[0].outcome, "verified");

  setPid(process.pid);
  assert.equal((await p.verify()).fleetLock, "busy", "the operating system's real live owner must block");
  assert.equal((await p.verify({ processStart: () => undefined })).fleetLock, "busy", "unreadable start time is ambiguous");
  assert.equal((await p.verify({ processStart: () => Math.floor(statSync(path).mtimeMs) })).fleetLock, "busy", "same tick is ambiguous");
  await wait(20);
  const before = treeHash(p.h.base), deps = { processStart: (pid) => { assert.equal(pid, process.pid); return Date.now(); } };
  const historical = await p.verify(deps);
  assert.deepEqual(historical, dead);
  assert.equal(historical.status, "incomplete"); assert.equal(historical.publishableBaseline, false);
  assert.equal(historical.groups[0].archiveSha256, j.state.archiveSha256);
  assert.equal(treeHash(p.h.base), before);
  assert.equal(fleetLockSnapshot(p.h.base), "busy", "the admission check is unchanged");
  const continuation = join(p.h.temp, "continuation");
  mkdirSync(continuation);
  writeFileSync(join(continuation, "index.json"), JSON.stringify([{ root: p.h.base, checkout: p.h.repo, commit, round: "r21",
    archives: { [j.group]: j.state.archiveSha256 } }]));
  const inspected = await inspectContinuation(continuation, { ...deps, inspect: p.inspect });
  assert.equal(inspected.report.groups[0].outcome, "verified");
  inspected.recheck();

  const changed = await p.verify({ ...deps, inspect: async (input) => {
    appendFileSync(path, "\n"); await wait(20); return p.inspect(input);
  } });
  assert.equal(changed.fleetLock, "busy"); assert.deepEqual(changed.groups, []);
  assert.throws(() => inspected.recheck(), /continuation source lock changed/);
  setPid(process.pid, intents.launch); await wait(20);
  assert.deepEqual(await p.verify(deps), dead, "a retained initial launch also replays");
  setPid(process.pid, "e".repeat(64)); await wait(20);
  assert.equal((await p.verify(deps)).fleetLock, "busy", "a foreign approval stays busy");
  writeFileSync(path, JSON.stringify({ pid: process.pid, action: "prepare" })); await wait(20);
  assert.equal((await p.verify(deps)).fleetLock, "busy", "a prepare lock stays busy");
  writeFileSync(path, "{");
  assert.equal((await p.verify(deps)).fleetLock, "busy", "a malformed lock stays busy");
});

for (const change of ["manifest", "duplicate"]) {
  test(`a root lock transition with ${change} evidence reports both diagnostics`, async (t) => {
    const p = fixture(t), first = p.seed(groupNames[0]);
    if (change === "duplicate") {
      const second = p.seed(groupNames[1]); second.state.id = first.state.id; second.save();
    }
    const path = join(p.h.base, ".fleet-operation.lock");
    const bytes = JSON.stringify({ pid: process.pid, approvalSha256: "b".repeat(64) });
    const result = await p.verify({ inspect: async (input) => {
      if (p.calls.length === 0) {
        writeFileSync(path, bytes, { flag: "wx" });
        if (change === "manifest") appendFileSync(p.manifestPath, "\n");
      }
      return p.inspect(input);
    } });
    assert.equal(result.status, "incomplete");
    assert.equal(result.fleetLock, "busy");
    assert.equal(result.error, "fleet-operation-busy");
    assert.equal(result.evidenceError, "fleet-evidence-changed-or-duplicated");
    assert.deepEqual(result.groups, []);
    assert.equal(readFileSync(path, "utf8"), bytes);
  });
}

test("missing, live, busy, recoverable and cleanup-pending groups keep a partial fleet incomplete", async (t) => {
  const p = fixture(t);
  const pending = p.seed(groupNames[0]); delete pending.state.destroyedAt; pending.save();
  const live = p.seed(groupNames[1]); Object.assign(live.state, { status: "running" });
  for (const key of ["collectedAt", "destroyedAt", "deletionIntentAt"]) delete live.state[key]; live.save();
  const busy = p.seed(groupNames[2]); writeFileSync(join(busy.local, "operation.lock"), "SYNTHETIC-live");
  const ambiguous = p.seed(groupNames[3]); Object.assign(ambiguous.state, { status: "creating" });
  for (const key of ["id", "ip", "collectedAt", "destroyedAt", "deletionIntentAt"]) delete ambiguous.state[key]; ambiguous.save();
  const result = await p.verify(); assert.equal(result.status, "incomplete"); assert.equal(result.publishableBaseline, false);
  assert.deepEqual(result.groups.slice(0, 4).map((r) => r.outcome), ["cleanup-pending", "uncollected", "busy", "uncollected"]);
  assert.ok(result.groups.slice(4).every((r) => r.outcome === "missing")); assert.equal(p.calls.length, 1);
});

test("retirement evidence is independently rebound and never qualifies a partial fleet", async (t) => {
  for (const kind of ["unused", "setup-failed"]) {
    const p = fixture(t), group = groupNames[0], local = join(p.h.base, group, "groups-r21"), at = new Date().toISOString();
    mkdirSync(local, { recursive: true });
    const state = { ...reservation({ round: "r21", commit, token: p.fleet.jobs[0].token, group, fleet: p.fleet }), provider: p.fleet.provider,
      status: "retired", createIntentAt: at, deletionIntentAt: at, destroyedAt: at, fullGroupQualified: false, id: "123", ip: "192.0.2.10",
      retirement: { kind, evidenceSha256: "a".repeat(64) } };
    if (kind === "setup-failed") {
      const extracted = join(local, "evidence-Setup"); mkdirSync(extracted);
      const entries = [{ name: "run.log", body: "failed setup" }, { name: "host.txt", body: "synthetic" }, { name: "exit-code", body: "1\n" }];
      for (const entry of entries) writeFileSync(join(extracted, entry.name), entry.body);
      writeFileSync(join(local, "results.tgz"), archive(entries));
      Object.assign(state, { archiveSha256: fileHash(join(local, "results.tgz")), evidenceSha256: treeHash(extracted),
        evidence: "evidence-Setup", extractionAttempts: ["evidence-Setup"] });
    }
    const ms = Date.now(), raw = JSON.stringify({ schema: kind === "unused" ? "benchmark-unused-host/v1" : "benchmark-failed-setup-host/v1",
      hostId: state.id, unit: state.unit, observedAtMs: ms, ...(kind === "unused" ? { unused: true } : { setupFailed: true, exitCode: 1 }) });
    const record = kind === "unused" ? unusedEvidence(raw, state, unusedHostScript(state), ms, ms)
      : setupEvidence(raw, state, terminalSetupScript(state, 1), 1, ms, ms);
    const proof = join(local, kind === "unused" ? "unused-host.json" : "failed-setup-host.json"), statePath = join(local, "state.json");
    const save = () => { const bytes = JSON.stringify(record); writeFileSync(proof, bytes);
      state.retirement = { kind, evidenceSha256: digest(bytes) }; writeFileSync(statePath, JSON.stringify(state)); };
    save(); const report = await p.verify();
    assert.equal(report.status, "incomplete"); assert.equal(report.publishableBaseline, false); assert.equal(p.calls.length, 0);
    assert.equal(report.groups[0].outcome, kind === "unused" ? "unused-retired" : "setup-failed-retired");
    if (kind === "setup-failed") {
      p.seed(groupNames[1]);
      const changed = await p.verify({ async inspect(input) {
        assert.equal(p.calls.length, 0);
        writeFileSync(proof, `${JSON.stringify(record)}\n`);
        return p.inspect(input);
      } });
      assert.equal(changed.groups[0].error, "group-retirement-changed");
      save();
    }
    record.id = "124"; save();
    assert.equal((await p.verify()).groups[0].outcome, "error", "a self-consistent hash cannot authorize foreign retirement evidence");
  }
});

test("a provider-errored create with its receipt and no launch custody is resolved, never qualifying the fleet", async (t) => {
  const p = fixture(t), group = groupNames[0], stateRoot = join(p.h.base, group), local = join(stateRoot, "groups-r21"), at = new Date().toISOString();
  mkdirSync(local, { recursive: true });
  const ids = { dropletId: "123", actionId: "456" }, statePath = join(local, "state.json"), receipt = join(local, createErroredReceipt);
  const state = { ...reservation({ round: "r21", commit, token: p.fleet.jobs[0].token, group, fleet: p.fleet }), provider: p.fleet.provider,
    status: "creating", createIntentAt: at, fullGroupQualified: false, createPending: ids };
  const record = createErroredRecord(state, ids, 7, at);
  const save = (bytes = JSON.stringify(record), hash = digest(JSON.stringify(record))) => {
    writeFileSync(receipt, bytes); writeFileSync(statePath, JSON.stringify({ ...state, createErrored: { ...ids, evidenceSha256: hash } }));
  };
  save(); const report = await p.verify();
  assert.equal(report.status, "incomplete"); assert.equal(report.publishableBaseline, false); assert.equal(p.calls.length, 0);
  assert.equal(report.groups[0].outcome, "create-errored");
  // A retained launch lock is still custody; an operation lock is busy.
  writeFileSync(join(stateRoot, ".groups-launch.lock"), "SYNTHETIC");
  assert.equal((await p.verify()).groups[0].outcome, "error");
  unlinkSync(join(stateRoot, ".groups-launch.lock")); writeFileSync(join(local, "operation.lock"), "SYNTHETIC");
  assert.equal((await p.verify()).groups[0].outcome, "busy");
  unlinkSync(join(local, "operation.lock"));
  // A recheck that kept its own lock (for example after a failed teardown) is unresolved.
  writeFileSync(join(local, "create-recheck.lock"), "SYNTHETIC");
  assert.equal((await p.verify()).groups[0].outcome, "error");
  unlinkSync(join(local, "create-recheck.lock"));
  assert.equal((await p.verify()).groups[0].outcome, "create-errored");
  // A receipt that no longer matches its saved hash, or a self-consistent foreign receipt, stays unresolved.
  save(JSON.stringify({ ...record, observedAt: "2026-11-14T00:00:01.000Z" }));
  assert.equal((await p.verify()).groups[0].outcome, "error");
  const foreign = JSON.stringify({ ...record, action: { ...record.action, resourceId: 124 } }); save(foreign, digest(foreign));
  assert.equal((await p.verify()).groups[0].outcome, "error");
  // Without the record, the same unbound create is still an uncollected reservation.
  writeFileSync(statePath, JSON.stringify(state));
  assert.equal((await p.verify()).groups[0].outcome, "uncollected");
});
test("strict roster, source and all original replay/lifecycle gates cannot be supplied by receipts", async (t) => {
  for (const kind of ["manifest", "source", "schema", "selection", "lifecycle", "pending", "raw", "exit", "eligibility", "plan-source", "reservation", "archive", "tree", "duplicate-id", "duplicate-ip", "active-operation"]) {
    const p = fixture(t); p.seedAll(); const j = p.jobs.get(groupNames[0]);
    if (kind === "manifest") { const f = structuredClone(p.fleet); f.jobs.reverse(); writeFileSync(p.manifestPath, JSON.stringify(f)); }
    if (kind === "source") p.input.commit = "b".repeat(40);
    if (kind === "schema") j.report.schema = "benchmark-isolated-campaign-inspection/v1";
    if (kind === "selection") j.report.selection = p.fleet.selection;
    if (kind === "lifecycle") j.report.commandLifecycle = "incomplete-preserved";
    if (kind === "pending") j.report.uncollectedNativeRoots = [{ group: groupNames[0] }];
    if (kind === "raw") j.report.collectionIntegrity = "unsealed-partial";
    if (kind === "exit") { writeFileSync(join(j.evidence, "exit-code"), "2\n"); j.rehash(); }
    if (kind === "eligibility") Object.assign(j.report.groups[0].appOutcomes[0], { outcome: "failed", comparisonEligible: true });
    if (kind === "plan-source") { const plan = JSON.parse(readFileSync(j.planPath)); plan.sourceSha256 = "f".repeat(64); writeFileSync(j.planPath, JSON.stringify(plan)); j.rehash(); }
    if (kind === "reservation") { appendFileSync(j.reservationPath, " "); j.rehash(); }
    if (kind === "archive") appendFileSync(j.archivePath, "tampered");
    if (kind === "tree") appendFileSync(join(j.evidence, "host.txt"), "tampered");
    if (kind === "duplicate-id" || kind === "duplicate-ip") { const other = p.jobs.get(groupNames[1]); other.state[kind === "duplicate-id" ? "id" : "ip"] = j.state[kind === "duplicate-id" ? "id" : "ip"]; other.save(); }
    if (kind === "active-operation") writeFileSync(join(p.h.base, ".fleet-operation.lock"), "live");
    const result = await p.verify(); assert.equal(result.status, "incomplete", kind); assert.equal(result.publishableBaseline, false);
  }
  const p = fixture(t); mkdirSync(join(p.h.base, "receipts"));
  writeFileSync(join(p.h.base, "receipts", `detach-${"a".repeat(16)}-${groupNames[0]}.json`), JSON.stringify({ status: "verified", nativeReadiness: true }));
  const result = await p.verify(); assert.ok(result.groups.every((r) => r.outcome === "missing")); assert.deepEqual(p.calls, []);
});

test("evidence/state/manifest mutation by a verifier is rejected, including earlier sibling mutation", async (t) => {
  for (const kind of ["tree", "state", "manifest", "earlier"]) {
    const p = fixture(t); p.seedAll(); let n = 0;
    const inspect = async (input) => {
      const report = await p.inspect(input); n++;
      const j = p.jobs.get(groupNames[0]);
      if (kind === "tree" && n === 1) appendFileSync(join(j.evidence, "host.txt"), "private");
      if (kind === "state" && n === 1) { j.state.id = "999"; j.save(); }
      if (kind === "manifest" && n === 1) appendFileSync(p.manifestPath, " ");
      if (kind === "earlier" && n === 2) appendFileSync(j.archivePath, "private");
      return report;
    };
    const result = await p.verify({ inspect }); assert.equal(result.status, "incomplete", kind);
  }
});

test("bounded default worker rejects synthetic artifacts instead of trusting injected reports", async (t) => {
  const p = fixture(t); p.seed(groupNames[0]);
  const before = treeHash(p.h.base), result = await verifyFleet(p.input);
  assert.equal(result.status, "incomplete"); assert.equal(result.evidenceMode, "native-replay");
  assert.equal(result.groups[0].error, "group-evidence-invalid"); assert.equal(treeHash(p.h.base), before);
});

test("native replay without the local bench install names it before reading any group", async (t) => {
  const p = fixture(t); p.seedAll();
  let checks = 0;
  const before = treeHash(p.h.base), result = await verifyFleet(p.input, { compiler: () => { checks++; return false; } });
  assert.deepEqual(result, { schema: "benchmark-group-fleet-inspection/v1", scope: "intrinsic-evidence", status: "incomplete",
    evidenceMode: "native-replay", nativeReadiness: false, publishableBaseline: false, comparisonScope: "within-group-host-only",
    error: localCompilerMissing, groups: [] });
  assert.match(result.error, /npm --prefix bench ci/); assert.equal(checks, 1); assert.equal(treeHash(p.h.base), before);
  // A synthetic inspection replays nothing locally, so it needs no compiler.
  const synthetic = await p.verify({ compiler: () => { checks++; return false; } });
  assert.equal(synthetic.status, "verified"); assert.equal(checks, 1);
});

test("cancelled pending inspection cannot qualify or expose late/private reports", async (t) => {
  const p = fixture(t); p.seed(groupNames[0]); let cancelled = false, entered = false, finish;
  const result = p.verify({ interrupted: () => cancelled, inspect: () => { entered = true; return new Promise((resolve) => { finish = resolve; }); } });
  while (!entered) await turn(); cancelled = true;
  const report = await result; assert.equal(report.status, "incomplete");
  assert.ok(!JSON.stringify(report).includes("PRIVATE")); finish({ private: "PRIVATE" }); await turn();
  assert.equal(report.status, "incomplete");
});

test("public errors contain no raw paths, exception content, argv or provider output", async (t) => {
  const p = fixture(t); p.seed(groupNames[0]);
  const result = await p.verify({ inspect: () => { throw new Error(`PRIVATE_ARGV_PROVIDER ${p.h.base}`); } });
  assert.ok(!JSON.stringify(result).includes("PRIVATE")); assert.ok(!JSON.stringify(result).includes(p.h.base));
  const output = [];
  assert.equal(await verifyFleetCli(["PRIVATE_ARGV_PROVIDER"], { write: (v) => output.push(v) }), 2);
  assert.deepEqual(JSON.parse(output[0]), { schema: "benchmark-group-fleet-inspection/v1", status: "incomplete", publishableBaseline: false, error: "fleet-inspection-invalid" });
});

test("physical state and archive aliases/hardlinks and foreign members refuse read-only inspection", async (t) => {
  for (const kind of ["state-hardlink", "archive-hardlink", "group-alias", "foreign"]) {
    const p = fixture(t); const j = p.seed(groupNames[0]);
    if (kind === "state-hardlink") linkSync(j.path, join(p.h.temp, "state-link"));
    if (kind === "archive-hardlink") linkSync(j.archivePath, join(p.h.temp, "archive-link"));
    if (kind === "group-alias") {
      const path = join(p.h.base, groupNames[1]); symlinkSync(join(p.h.base, groupNames[0]), path, process.platform === "win32" ? "junction" : "dir");
    }
    if (kind === "foreign") writeFileSync(join(p.h.base, "foreign.json"), "{}");
    const result = await p.verify(); assert.equal(result.status, "incomplete"); assert.equal(result.publishableBaseline, false);
  }
});

test("blocked and harness-failed campaigns remain incomplete even with confirmed deletion", async (t) => {
  for (const status of ["blocked", "failed"]) {
    const p = fixture(t); const j = p.seed(groupNames[0]);
    Object.assign(j.report, { status, controllerReady: false, qualified: false, isolation: "unverified", deletionAuthorized: false });
    j.state.validation.status = status; j.state.evidenceOutcome = status; j.state.exitCode = 1;
    writeFileSync(join(j.evidence, "exit-code"), "1\n"); j.rehash();
    const result = await p.verify(); assert.equal(result.status, "incomplete"); assert.equal(result.groups[0].outcome, status);
  }
});
