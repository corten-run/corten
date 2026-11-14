import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hash, rewriteArtifact, syntheticFixture } from "./live-delivery.test.mjs";
import { verifyRound } from "../../../live/verify.mjs";
import { inspectSaved } from "./recoverable-live.mjs";
import { fanoutProfile } from "../../../live/fanout.mjs";

test("real native verifier replays all six synthetic failed recovery scenarios without timing them", async (t) => {
  const f = await syntheticFixture(t, "recoverable-live"), native = await verifyRound(f.folder), r = await inspectSaved(f.binding, f.folder);
  assert.deepEqual(f.plan.scenarios, ["normal", "disconnect", "missed-updates", "expired-cursor", "gap", "slow-reader"]);
  assert.deepEqual(native.passed, []); assert.deepEqual(native.measured, []); assert.deepEqual(native.unqualified, []);
  assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true); assert.equal(r.cleanupComplete, false); assert.equal(r.resources, "blocked");
  assert.deepEqual(r.outcomes.map((o) => o.app), f.binding.selection.apps);
  assert.ok(r.outcomes.some((o) => o.outcome === "failed")); assert.ok(r.outcomes.some((o) => o.outcome === "unsupported"));
});
test("requested measurement is correctly not run after complete failed parity", async (t) => {
  const f = await syntheticFixture(t, "recoverable-live");
  f.binding.execution.effectiveOptions.measure = true; f.binding.execution.settings.measurement = fanoutProfile;
  f.plan.measurement = fanoutProfile; await f.json("plan.json", f.plan);
  const native = await verifyRound(f.folder), r = await inspectSaved(f.binding, f.folder);
  assert.deepEqual(native.measured, []); assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true);
  assert.ok(r.outcomes.every((o) => o.outcome === "failed" || o.outcome === "unsupported"));
});
for (const scenario of ["normal", "disconnect", "missed-updates", "expired-cursor", "gap", "slow-reader"]) {
  test(`recovery requires exact ${scenario} scenario settings even in retained failures`, async (t) => {
    const f = await syntheticFixture(t, "recoverable-live");
    await rewriteArtifact(f, "aspnet", f.plan.scenarios.indexOf(scenario), (a) => { a.settings.scenario = "another"; });
    assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
  });
}
test("failed parity cannot retain a measurement manifest", async (t) => {
  const f = await syntheticFixture(t, "recoverable-live");
  await f.json("aspnet-measurements.json", { app: "aspnet", group: "recoverable-live", files: [] });
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
});
test("unbound native startup failure stays failed and proof-blocked, not not-run", async (t) => {
  const f = await syntheticFixture(t, "recoverable-live");
  await rm(join(f.folder, "aspnet-artifacts.json"));
  for (const scenario of f.plan.scenarios) await rm(join(f.folder, `aspnet-${scenario}.json.gz`));
  const cell = f.ledger.cells.find((c) => c.app === "aspnet"); delete cell.artifact; cell.reason = "synthetic startup failure";
  await f.json("coverage.json", f.ledger); await f.json("aspnet-failure.json", { app: "aspnet", error: "synthetic startup failure" });
  const r = await inspectSaved(f.binding, f.folder); assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false);
  assert.equal(r.outcomes.find((o) => o.app === "aspnet").outcome, "failed");
  assert.ok(r.blockers.includes("startup-source-proof-missing:aspnet"));
});
test("actual six-scenario recovery fixtures remain read-only diagnostic evidence", async () => {
  const folder = fileURLToPath(new URL("../../../recoverable-live/evidence/native-recovery/", import.meta.url));
  const before = await Promise.all((await readdir(folder)).sort().map(async (file) => [file, hash(await readFile(join(folder, file)))]));
  const native = await verifyRound(folder); assert.equal(native.inspected.length, 6); assert.equal(native.readyForLoad, false);
  const plan = JSON.parse(await readFile(join(folder, "plan.json"), "utf8"));
  const binding = { request: { group: plan.group, round: plan.round, commit: plan.commit }, selection: { apps: plan.apps },
    execution: { effectiveOptions: { apps: plan.apps, profile: "bounded", measure: false }, settings: { measurement: null } } };
  const r = await inspectSaved(binding, folder); assert.equal(r.status, "invalid"); assert.deepEqual(r.outcomes.map((o) => o.app), plan.apps);
  assert.deepEqual(await Promise.all(before.map(async ([file]) => [file, hash(await readFile(join(folder, file)))])), before);
});
