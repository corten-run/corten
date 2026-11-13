// Fixed native API substitutes exercise composition, not native benchmark qualification.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { contractSha256, selectedApps } from "../../registry.mjs";
import { cpuSettings } from "../../../catalog/contract.mjs";
import { parseArgs } from "../../../mixed-production/run.mjs";
import { createPlan } from "../../mixed.mjs";
import { records } from "../../../marketplace/fixtures.mjs";
import { composePhase } from "../composition.mjs";
import { latestStableSchema } from "../../latest-stable.mjs";

const commit = "a".repeat(40), apps = selectedApps("mixed-production"), folder = mkdtempSync(join(tmpdir(), "isolated-mixed-adapter-"));
const options = parseArgs(["w17", "--build", "--measure", "--profile", "matched", "--native-audits", "/bench/campaign/r17-0123456789abcdef/mixed-native-audits.json"]); options.apps = apps;
const cpus = cpuSettings({ CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-7" });
const plan = createPlan({ seed: options.seed, clients: options.clients, repetitions: options.repetitions, records: records() });
const sourceFiles = [{ path: "package-lock.json", sha256: "b".repeat(64) }];
const originalBinding = { request: { group: "mixed-production", round: "w17", commit, recipe: "mixed-production-measure" },
  selection: { group: "mixed-production", apps, contractSha256: contractSha256("mixed-production") }, sources: { commit, files: sourceFiles },
  execution: { invocation: { executable: "node", argv: ["bench/mixed-production/run.mjs", "w17", "--build", "--measure", "--profile", "matched", "--native-audits", options.nativeAudits], cwd: "repository-root", shell: false },
    effectiveOptions: options, settings: null }, resources: { measurement: { cpu: cpus } } };
const originalSummary = { schema: "mixed-native-run/v1", group: "mixed-production", round: "w17", options, inventory: apps,
  contractSha256: contractSha256("mixed-production"), provenance: { commit, dirty: "", nativeSource: { commit, dirty: false } },
  apps: Object.fromEntries(apps.map((a) => [a, {}])), timing: { cpus }, failures: [], cleanupFailures: [], finishedAt: "2026-11-13T00:00:00Z" };
const originalNative = { schema: "mixed-native-saved-verification/v1", verdict: "verified", round: "w17", commit,
  complete: true, attemptComplete: true, functionalPassed: true, comparisonEligible: true,
  dispositions: { functional: "passed", qualification: "passed", calibration: "passed", steady: "passed", gate: null }, issues: [],
  apps: Object.fromEntries(apps.map((app) => [app, { cells: ["fixture", "api"].flatMap((source) => plan.requests.filter((r) => r.source === source)
    .map((r) => ({ requestId: r.id, source, passed: true, outcome: "completed", reasons: [] }))), oracle: { valid: true, result: { functionalPassed: true } } }])),
  measurement: { qualified: true, calibrated: true, complete: true, comparisonEligible: true,
    cells: Object.fromEntries(apps.map((app) => [app, Object.fromEntries(["fixture", "api"].map((source) => [source,
      { qualification: { eligible: true }, calibration: { eligible: true }, passes: Array.from({ length: options.passes }, () => ({ eligible: true })) }]))])) },
  proof: { schema: "mixed-native-saved-proof/v1", resources: "verified", sources: "verified", sourceFiles, cleanupComplete: true, blockers: [] } };
let binding, summary, native, action;
const validator = mock.fn(async (request) => { assert.deepEqual(request, { folder, round: "w17", commit }); action?.(); return structuredClone(native); });
mock.module(new URL("../../../mixed-production/verify.mjs", import.meta.url), { exports: { validateSaved: validator } });
const { inspectNative } = await import("../native-replay.mjs");
const save = (name, value) => writeFileSync(join(folder, name), JSON.stringify(value));
beforeEach(() => {
  binding = structuredClone(originalBinding); summary = structuredClone(originalSummary); native = structuredClone(originalNative);
  action = null; validator.mock.resetCalls(); save("summary.json", summary); save("plan.json", plan);
});
after(() => { mock.restoreAll(); assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
const inspect = () => { save("summary.json", summary); return inspectNative(binding, folder); };

test("production mixed fixed native API has a complete positive composition path", async () => {
  const result = await inspect(); assert.equal(result.status, "verified"); assert.equal(result.attemptComplete, true);
  assert.equal(result.cleanupComplete, true); assert.equal(result.resources, "verified"); assert.equal(validator.mock.callCount(), 1);
  assert.deepEqual(result.outcomes, apps.map((app) => ({ app, outcome: "passed" })));
  assert.deepEqual(result.comparisonEligibleApps, apps);
  const composed = composePhase({ ...binding, preparation: { fixtures: [] }, latestStable: {
    schema: latestStableSchema, group: "mixed-production", valid: true, status: "not-applicable", groupComparisonEligible: null } },
  result, { resources: "verified", cleanupComplete: true }, [{ terminal: true, code: 0, signal: null, error: null, cancelled: false, forced: false, success: true }]);
  assert.equal(composed.outcome, "native-validated"); assert.ok(composed.appOutcomes.every((row) => row.comparisonEligible));
});

test("complete functional target failure retains every selected app and gated timing", async () => {
  native.functionalPassed = false; native.comparisonEligible = false; native.measurement = null; summary.timing = null;
  native.dispositions = { functional: "recorded-failed", qualification: "gated-not-run", calibration: "gated-not-run", steady: "gated-not-run", gate: "native-functional" };
  native.apps[apps[0]].cells[0].passed = false; native.apps[apps[0]].oracle.result.functionalPassed = false;
  native.issues = [{ kind: "target-failed", code: "complete-native-functional-gate-not-passed", at: "functional" }];
  const result = await inspect(); assert.equal(result.status, "failed"); assert.equal(result.attemptComplete, true);
  assert.deepEqual(result.outcomes.map((r) => r.app), apps); assert.equal(result.outcomes[0].outcome, "failed");
  assert.ok(result.outcomes.slice(1).every((r) => r.outcome === "passed"));
  assert.deepEqual(result.comparisonEligibleApps, []);
  const composed = composePhase({ ...binding, preparation: { fixtures: [] }, latestStable: {
    schema: latestStableSchema, group: "mixed-production", valid: true, status: "not-applicable", groupComparisonEligible: null } },
  result, { resources: "verified", cleanupComplete: true }, [{ terminal: true, code: 1, signal: null, error: null, cancelled: false, forced: false, success: false }]);
  assert.equal(composed.outcome, "native-validated");
  assert.ok(composed.appOutcomes.every((r) => !r.comparisonEligible), "a passed functional app has no timing when another app gated the group");
});

for (const [name, change, status] of [
  ["native replay contradiction", () => { native.verdict = "failed"; native.attemptComplete = false; native.issues = [{ kind: "failed", code: "invalid-or-missing-evidence" }]; }, "invalid"],
  ["missing native apparatus", () => { native.verdict = "blocked"; native.attemptComplete = false; native.proof.resources = "blocked"; }, "blocked"],
  ["missing cleanup", () => { native.verdict = "blocked"; native.attemptComplete = false; native.proof.cleanupComplete = false; }, "blocked"],
  ["wrong source bytes", () => { native.proof.sourceFiles[0].sha256 = "c".repeat(64); }, "invalid"],
  ["wrong CPU placement", () => { summary.timing.cpus.app.cpuset = "3"; }, "invalid"],
  ["missing functional cell", () => { native.apps[apps[0]].cells.pop(); }, "invalid"],
  ["other audit path", () => { binding.execution.effectiveOptions.nativeAudits = "/tmp/audits.json"; summary.options.nativeAudits = "/tmp/audits.json"; }, "invalid"],
  ["blocked raw proof beside failure", () => { native.verdict = "blocked"; native.attemptComplete = false; native.issues = [{ kind: "blocked", code: "native-process-limits-missing" }]; native.apps[apps[0]].cells[0].passed = false; }, "blocked"],
]) test(`mixed ${name} is not complete evidence`, async () => {
  change(); const result = await inspect(); assert.equal(result.status, status);
  assert.ok(!result.attemptComplete || result.status === "invalid");
});

test("subset binding is refused by the fixed registry result check", async () => {
  binding.selection.apps.pop(); await assert.rejects(inspect(), /native-evidence-mutated-or-invalid/);
});

test("native diagnostics and unsealed mutation cannot promote collected bytes", async () => {
  action = () => { throw new Error("SYNTHETIC_PRIVATE_SENTINEL"); };
  assert.ok(!JSON.stringify(await inspect()).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  action = () => save("summary.json", { ...summary, modified: true });
  await assert.rejects(inspect(), /native-evidence-mutated-or-invalid/);
});
