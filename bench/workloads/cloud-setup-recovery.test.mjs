import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata } from "./cloud-fixtures.mjs";
import { fleetPlan } from "./cloud-contract.mjs";
import { groupNames } from "./registry.mjs";
import { digest } from "./cloud-local.mjs";
import { setupEvidence, terminalSetupScript } from "./cloud-retirement.mjs";

const noNative = { inspect: async () => { throw new Error("no native campaign began"); } };
function failedSetup(t, flags = {}, entries = metadata()) {
  const h = harness(t, flags); h.seed(); h.setArchive(archive(entries)); return h;
}

test("observed common bootstrap is retained provenance, not native entry or a cleanup dead end", async (t) => {
  const h = harness(t, { active: true });
  const tokens = Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")]));
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16), tokens, provider: { accountId, context }, sshKey: "42" });
  const path = join(h.temp, "fleet.json"); writeFileSync(path, JSON.stringify(fleet));
  await h.task({}, { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group: groupNames[0], fleet: path }).launch();
  const bootstrap = h.saved().bootstrapReady; assert.ok(bootstrap);
  h.flags.active = false; h.setArchive(archive([...metadata(), { name: "campaign/" }]));
  assert.equal(await h.task(noNative).collect(), 1);
  const s = h.saved(); assert.equal(s.retirement.kind, "setup-failed"); assert.equal(s.status, "retired");
  assert.deepEqual(s.bootstrapReady, bootstrap); assert.equal(s.validation, undefined); assert.equal(h.deletes, 1);
  assert.equal(await h.task(noNative).collect(), 1); assert.equal(h.deletes, 1);
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
