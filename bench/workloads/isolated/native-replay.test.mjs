// Fixed API composition with explicitly synthetic substitutes, not native qualification.
import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mock, test } from "node:test";
import { groupNames, selectedApps } from "../registry.mjs";
import { result as jsonResult } from "../../json-api/test-fixtures.mjs";

const seams = new Map();
for (const group of groupNames.filter((g) => !["catalog-page", "json-api", "localized-marketplace"].includes(g)))
  seams.set(new URL(`./adapters/${group}.mjs`, import.meta.url).href, { group, name: "inspectSaved" });
seams.set(new URL("../../catalog/verify.mjs", import.meta.url).href, { group: "catalog-page", name: "validateSaved" });
seams.set(new URL("../../marketplace/validate.mjs", import.meta.url).href, { group: "localized-marketplace", name: "validateSaved" });
seams.set(new URL("../../client-heavy/verify.mjs", import.meta.url).href, { group: "client-api", name: "validateSaved" });
const urls = new Map([...seams].map(([path, { group, name }]) => [path, `data:text/javascript,export async function ${name}(){}//${group}`]));
const hooks = registerHooks({ resolve(specifier, context, next) {
  const url = new URL(specifier, context.parentURL ?? import.meta.url).href;
  return urls.has(url) ? { url: urls.get(url), shortCircuit: true } : next(specifier, context);
} });
let action = "normal", calls = [];
for (const [path, { group, name }] of seams) mock.module(urls.get(path), { exports: { [name]: async (input, folder) => {
  calls.push({ group, input, folder });
  if (action === "throw") throw new Error("SYNTHETIC_PRIVATE_SENTINEL");
  if (group === "catalog-page") return { status: "verified", complete: true, report: { baseline: true } };
  if (group === "localized-marketplace") return JSON.parse(readFileSync(join(input.folder, "summary.json")));
  if (group === "client-api") return { schema: "client-heavy-saved-verification/v2" };
  if (action === "mutate") appendFileSync(join(folder, "raw.log"), "changed");
  if (action === "malformed") return { status: "SYNTHETIC_PRIVATE_SENTINEL" };
  return { status: "verified", attemptComplete: true, cleanupComplete: true, resources: "verified",
    ...(group === "fullstack-browser" ? { qualificationPassed: true, expectedExitCode: 0 } : {}),
    outcomes: input.selection.apps.map((app) => ({ app, outcome: "passed" })), blockers: [] };
} } });
const { inspectNative, executionGroups, validateNativeResult } = await import("./native-replay.mjs");
function fixture(t, group) {
  const folder = mkdtempSync(join(tmpdir(), "isolated-native-composition-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  const binding = { request: { group, round: "w17", commit: "a".repeat(40) }, selection: { apps: selectedApps(group) },
    execution: { effectiveOptions: {} }, resources: { expectedCpus: {} } };
  const summary = { round: binding.request.round, commit: binding.request.commit, options: {}, measurement: { cpus: {} }, complete: true,
    apps: Object.fromEntries(binding.selection.apps.map((a) => [a, { qualification: { fixture: { eligible: true }, api: { eligible: true } }, runs: {} }])) };
  writeFileSync(join(folder, "summary.json"), JSON.stringify(summary)); writeFileSync(join(folder, "raw.log"), "synthetic\n");
  return { folder, binding, summary };
}

test("browser qualification exit is exact and separate from intrinsic completion and cleanup", () => {
  const binding = { request: { group: "fullstack-browser" }, selection: { apps: ["a", "b"] } };
  const result = { status: "verified", attemptComplete: true, cleanupComplete: true, resources: "blocked",
    qualificationPassed: false, expectedExitCode: 1, outcomes: [{ app: "a", outcome: "passed" }, { app: "b", outcome: "unsupported" }], blockers: [] };
  assert.equal(validateNativeResult(binding, result), result);
  for (const expectedExitCode of [undefined, null, "1", 0, 2, 137])
    assert.throws(() => validateNativeResult(binding, { ...result, expectedExitCode }));
  assert.throws(() => validateNativeResult(binding, { ...result, qualificationPassed: true, expectedExitCode: 0 }));
  const qualified = { ...result, qualificationPassed: true, expectedExitCode: 0,
    outcomes: binding.selection.apps.map((app) => ({ app, outcome: "passed" })) };
  assert.equal(validateNativeResult(binding, qualified), qualified);
  assert.doesNotThrow(() => validateNativeResult(binding, { ...qualified, cleanupComplete: false }));
  assert.throws(() => validateNativeResult(binding, { ...qualified, status: "failed" }));
});
test("all registry groups have fixed awaited native APIs, with the real strict JSON report retained", async (t) => {
  assert.deepEqual(executionGroups, groupNames);
  for (const group of groupNames.filter((g) => g !== "json-api")) {
    action = "normal"; calls = []; const { binding, folder } = fixture(t, group);
    const report = await inspectNative(binding, folder); assert.equal(report.status, "verified", group);
    assert.deepEqual(report.outcomes.map((r) => r.app), selectedApps(group)); assert.equal(calls[0].group, group);
  }
  const f = fixture(t, "json-api"), raw = jsonResult(), summary = raw.summary;
  for (const [path, bytes] of raw.artifacts) writeFileSync(join(f.folder, path), bytes);
  writeFileSync(join(f.folder, "summary.json"), JSON.stringify(summary));
  Object.assign(f.binding, { request: { group: "json-api", round: summary.round, commit: summary.commit },
    execution: { effectiveOptions: summary.options }, resources: { expectedCpus: summary.measurement.cpus } });
  assert.equal((await inspectNative(f.binding, f.folder)).status, "verified");
  summary.apps[summary.group.apps[0]].checks = {}; writeFileSync(join(f.folder, "summary.json"), JSON.stringify(summary));
  assert.equal((await inspectNative(f.binding, f.folder)).status, "invalid", "missing raw functional evidence is not success");
});
test("marketplace replay's actual summary return preserves observed exclusions as selected failures", async (t) => {
  action = "normal"; const f = fixture(t, "localized-marketplace"), first = f.binding.selection.apps[0];
  f.summary.apps[first].qualification.fixture.eligible = false; writeFileSync(join(f.folder, "summary.json"), JSON.stringify(f.summary));
  const report = await inspectNative(f.binding, f.folder);
  assert.equal(report.status, "failed"); assert.equal(report.attemptComplete, true); assert.equal(report.outcomes[0].outcome, "failed");
});
test("awaited mutation, unsafe evidence and private native errors fail closed", async (t) => {
  const f = fixture(t, "live-delivery");
  action = "mutate"; await assert.rejects(inspectNative(f.binding, f.folder), { message: "native-evidence-mutated-or-invalid" });
  action = "malformed"; await assert.rejects(inspectNative(f.binding, f.folder), { message: "native-evidence-mutated-or-invalid" });
  action = "throw"; assert.ok(!JSON.stringify(await inspectNative(f.binding, f.folder)).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  linkSync(join(f.folder, "raw.log"), join(f.folder, "alias.log")); calls = [];
  await assert.rejects(inspectNative(f.binding, f.folder)); assert.deepEqual(calls, []);
});
test.after(() => hooks.deregister());
