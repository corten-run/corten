import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { groupNames } from "./registry.mjs";
import { digest } from "./cloud-local.mjs";
import { bootstrapMarker } from "./cloud-remote.mjs";
import { setupEvidence, terminalSetupScript, watcherDeadlineFailure } from "./cloud-retirement.mjs";

const noNative = { inspect: async () => { throw new Error("no native campaign began"); } };
function failedSetup(t, flags = {}, entries = metadata()) {
  const h = harness(t, flags); h.seed(); h.setArchive(archive(entries)); return h;
}

function firstFleet() {
  const tokens = Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")]));
  return fleetPlan({ round: "r21", commit, token: "f".repeat(16), tokens, provider: { accountId, context }, sshKey: "42" });
}

test("observed common bootstrap is retained provenance, not native entry for legacy setup retirement", async (t) => {
  const fleet = firstFleet(), { group, token } = fleet.jobs[0];
  const h = failedSetup(t, { token }, [...metadata(), { name: "campaign/" }]);
  // This saved reservation predates guarded provisioning and the monitor seal.
  h.change(s => {
    Object.assign(s, reservation({ round: s.round, commit, token, group, fleet }, s.createdAt), { status: s.status });
    s.bootstrapReady = { sha256: digest(JSON.stringify(bootstrapMarker(s)) + "\n"), observedAt: new Date().toISOString() };
  });
  const { host } = h.saved();
  h.hosts([{ ...h.host(), size_slug: host.size, region: { slug: host.region } }]);
  const bootstrap = h.saved().bootstrapReady;
  assert.equal(await h.task(noNative).collect(), 1);
  const s = h.saved(); assert.equal(s.retirement.kind, "setup-failed"); assert.equal(s.status, "retired");
  assert.deepEqual(s.bootstrapReady, bootstrap); assert.equal(s.validation, undefined); assert.equal(h.deletes, 1);
  assert.equal(await h.task(noNative).collect(), 1); assert.equal(h.deletes, 1);
});

test("observed common bootstrap with a lost monitor honors the close embargo and cannot retire as pre-entry after seal", async (t) => {
  const h = harness(t, { active: true, monitorHold: true }), fleet = firstFleet();
  const path = join(h.temp, "fleet.json"); writeFileSync(path, JSON.stringify(fleet));
  const task = h.task({ run(...args) {
    const result = h.run(...args);
    if (args[5]?.request?.seal) h.flags.completeMonitor(false);
    return result;
  } }, { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group: fleet.jobs[0].group, fleet: path });
  await assert.rejects(task.launch(), error => error.controlTreeUncertain === true);
  const { bootstrapReady, control } = h.saved();
  assert.ok(bootstrapReady); assert.equal(control.monitor.phase, "invalid"); assert.deepEqual(control.sealed, ["bootstrap"]);
  h.flags.active = false; h.setArchive(archive([...metadata(), { name: "campaign/" }]));
  const close = JSON.parse(readFileSync(join(h.local, "monitor-local-closed.json")));
  const calls = h.calls.length;
  t.mock.timers.enable({ apis: ["Date"], now: close.recoverAfterMs - 1 });
  assert.equal(await h.task(noNative).collect(), 3);
  assert.equal(h.calls.length, calls); assert.ok(!existsSync(join(h.local, "results.tgz")));
  t.mock.timers.setTime(close.recoverAfterMs);
  await assert.rejects(h.task(noNative).collect(), /original monitor owner is still live or uncertain/);
  assert.equal(h.calls.length, calls);
  // The test process stood in for the launcher. Model its exit without removing either lock.
  const pid = 2147483647, operation = join(h.local, "operation.lock"), launch = join(h.base, ".groups-launch.lock");
  const operationBytes = JSON.stringify({ ...JSON.parse(readFileSync(operation)), pid });
  const launchBytes = JSON.stringify({ ...JSON.parse(readFileSync(launch)), pid });
  writeFileSync(operation, operationBytes); writeFileSync(launch, launchBytes);
  await assert.rejects(h.task(noNative).collect(), /sealed\/native entry cannot use pre-entry retirement/);
  const s = h.saved();
  assert.deepEqual(s.bootstrapReady, bootstrapReady); assert.equal(s.validation, undefined);
  assert.ok(s.archiveSha256 && s.evidenceSha256); assert.equal(s.retirement, undefined); assert.equal(s.deletionIntentAt, undefined);
  assert.equal(readFileSync(operation, "utf8"), operationBytes); assert.equal(readFileSync(launch, "utf8"), launchBytes);
  assert.equal(h.deletes, 0);
});
// The drain proof is only for a pre-registration bootstrap. After registration the unsealed
// fallback still refuses an archived watcher failure, with a stage and before any setup query.
test("after registration an archived watcher deadline failure refuses before any setup query", async (t) => {
  const h = harness(t, { active: true, monitorHold: true }), fleet = firstFleet();
  const path = join(h.temp, "fleet.json"); writeFileSync(path, JSON.stringify(fleet));
  const task = h.task({ run(...args) {
    const result = h.run(...args);
    if (args[5]?.request?.seal) h.flags.completeMonitor(false);
    return result;
  } }, { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group: fleet.jobs[0].group, fleet: path });
  await assert.rejects(task.launch(), error => error.controlTreeUncertain === true);
  const { control, preBootstrapTerminal } = h.saved();
  assert.equal(preBootstrapTerminal, undefined); assert.equal(control.monitor.phase, "invalid");
  const first = control.ledger[0].request.invocation.id;
  h.flags.active = false;
  h.setArchive(archive([...metadata(), { name: "campaign/" }, { name: "control/" }, { name: `control/watch-failure-${first}.json`, body: watcherDeadlineFailure }]));
  const close = JSON.parse(readFileSync(join(h.local, "monitor-local-closed.json")));
  t.mock.timers.enable({ apis: ["Date"], now: close.recoverAfterMs });
  await assert.rejects(h.task(noNative).collect(), /original monitor owner is still live or uncertain/);
  const pid = 2147483647, operation = join(h.local, "operation.lock"), launch = join(h.base, ".groups-launch.lock");
  writeFileSync(operation, JSON.stringify({ ...JSON.parse(readFileSync(operation)), pid }));
  writeFileSync(launch, JSON.stringify({ ...JSON.parse(readFileSync(launch)), pid }));
  const queries = () => h.calls.filter(([bin, ...a]) => bin === "ssh" && String(a.at(-1)).includes("CORTEN_FAILED_SETUP_HOST")).length;
  await assert.rejects(h.task(noNative).collect(), { controllerStage: "setup-watcher-proof-missing" });
  const s = h.saved();
  assert.equal(queries(), 0); assert.equal(h.deletes, 0); assert.ok(s.archiveSha256 && s.evidenceSha256);
  assert.equal(s.retirement, undefined); assert.equal(s.deletionIntentAt, undefined);
  assert.equal(readFileSync(join(h.local, s.evidence, "control", `watch-failure-${first}.json`), "utf8"), watcherDeadlineFailure);
});
test("ordinary collect preserves failed-setup archive and retires only after separate terminal no-entry proof", async (t) => {
  const h = failedSetup(t);
  assert.equal(await h.task(noNative).collect(), 1);
  const s = h.saved(); assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "setup-failed");
  assert.ok(s.archiveSha256 && s.evidenceSha256 && s.destroyedAt && s.deletionIntentAt);
  assert.equal(s.validation, undefined); assert.equal(s.collectedAt, undefined); assert.equal(s.exitCode, undefined);
  const record = JSON.parse(readFileSync(join(h.local, "failed-setup-host.json")));
  assert.equal(record.archiveSha256, s.archiveSha256); assert.equal(record.evidenceSha256, s.evidenceSha256);
  assert.equal(record.observation.exitCode, 1); assert.equal(h.deletes, 1);
  assert.equal(await h.task(noNative).collect(), 1); assert.equal(h.deletes, 1);
  writeFileSync(join(h.local, s.evidence, "run.log"), "changed");
  await assert.rejects(h.task(noNative).collect()); assert.equal(h.deletes, 1);
});
test("failed setup cleanup refuses live, entered, invalid or unverifiable work without discarding the archive", async (t) => {
  for (const mode of ["active", "native-data", "zero-exit", "bad-exit", "bad-proof", "marked-entry", "uncertain-validator"]) {
    const entries = metadata();
    if (mode === "native-data") entries.push({ name: "campaign/" }, { name: "campaign/.host-attempt.json", body: "{}" });
    if (mode === "zero-exit") entries[2].body = "0\n";
    if (mode === "bad-exit") entries[2].body = "257\n";
    const h = failedSetup(t, { active: mode === "active", ...(mode === "bad-proof" ? { setupProof: { setupFailed: true } } : {}) }, entries);
    if (mode === "marked-entry") h.flags.setupProof = { setupFailed: false };
    let outcome;
    try { outcome = await h.task(mode === "uncertain-validator" ? { inspect: () => {
      setTimeout(() => { h.flags.cancelled = true; }, 20); return new Promise(() => {});
    } } : noNative).collect(); }
    catch { outcome = "refused"; }
    assert.ok(mode === "active" ? outcome === 3 : outcome === "refused", mode);
    assert.equal(h.deletes, 0); assert.equal(h.saved().retirement, undefined); assert.equal(h.saved().deletionIntentAt, undefined);
    if (!["active", "uncertain-validator"].includes(mode)) assert.ok(existsSync(join(h.local, "results.tgz")));
    if (mode === "uncertain-validator") assert.ok(existsSync(join(h.local, "operation.lock")));
  }
});
test("failed-setup retirement confirms delayed exact-ID absence without qualifying results", async (t) => {
  const h = failedSetup(t, { deleteUnconfirmed: true }); let observations = 0;
  h.flags.hook = (binary, args) => {
    if (binary === "doctl" && args[2] === "get" && h.deletes && ++observations === 3) h.hosts([]);
  };
  assert.equal(await h.task(noNative).collect(), 1); assert.equal(h.deletes, 1); assert.equal(observations, 3);
  assert.ok(h.saved().destroyedAt); assert.equal(h.saved().fullGroupQualified, false);
});
test("failed-setup lost delete acknowledgement never permits another DELETE", async (t) => {
  const h = failedSetup(t, { deleteUnconfirmed: true });
  await assert.rejects(h.task(noNative).collect()); assert.equal(h.deletes, 1);
  await assert.rejects(h.task(noNative).collect()); assert.equal(h.deletes, 1);
  h.hosts([]); assert.equal(await h.task(noNative).collect(), 1); assert.equal(h.deletes, 1);
});

test("interrupted failed-setup receipt is archived before a freshly proved deletion intent", async (t) => {
  const h = failedSetup(t); let prior;
  h.flags.hook = (binary, args) => {
    if (prior || binary !== "ssh" || !args.at(-1).includes("benchmark-failed-setup-host/v1")) return;
    const state = h.saved(), raw = JSON.stringify({ schema: "benchmark-failed-setup-host/v1", hostId: state.id, unit: state.unit,
      setupFailed: true, exitCode: 1, observedAtMs: 1000 });
    prior = JSON.stringify(setupEvidence(raw, state, terminalSetupScript(state, 1), 1, 1000, 1000));
    writeFileSync(join(h.local, "failed-setup-host.json"), prior);
  };
  assert.equal(await h.task(noNative).collect(), 1); assert.equal(h.deletes, 1);
  assert.equal(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(prior)}.json`), "utf8"), prior);
  assert.notEqual(readFileSync(join(h.local, "failed-setup-host.json"), "utf8"), prior);
  assert.equal(await h.task(noNative).collect(), 1); assert.equal(h.deletes, 1);
});
