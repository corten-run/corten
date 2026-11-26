// Fixed API composition with explicitly synthetic substitutes, not native qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mock, test } from "node:test";
import { contractSha256, groupNames, selectedApps } from "../registry.mjs";
import { productionFixture } from "../../json-api/production-fixtures.mjs";
import { descriptor as jsonDescriptor } from "../../json-api/contract.mjs";
import { apparatusSources } from "../../catalog/apparatus.mjs";
import { cpuSettings } from "../../catalog/contract.mjs";

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
let action = "normal", calls = [], browserSubject;
for (const [path, { group, name }] of seams) mock.module(urls.get(path), { exports: { [name]: async (input, folder) => {
  calls.push({ group, input, folder });
  if (action === "throw") throw new Error("SYNTHETIC_PRIVATE_SENTINEL");
  if (group === "catalog-page") return { status: "verified", complete: true, report: { baseline: true, attemptComplete: true,
    outcomes: selectedApps(group).map((app) => ({ app, outcome: "passed" })), comparisonEligibleApps: selectedApps(group) } };
  if (group === "localized-marketplace") return JSON.parse(readFileSync(join(input.folder, "summary.json")));
  if (group === "client-api") return { schema: action === "client-v3" ? "client-heavy-saved-verification/v3"
    : action === "client-v4" ? "client-heavy-saved-verification/v4"
      : action === "client-unknown" ? "client-heavy-saved-verification/v5" : "client-heavy-saved-verification/v2" };
  if (action === "mutate") appendFileSync(join(folder, "raw.log"), "changed");
  if (action === "malformed") return { status: "SYNTHETIC_PRIVATE_SENTINEL" };
  return { status: "verified", attemptComplete: true, cleanupComplete: true, resources: "verified",
    ...(group === "fullstack-browser" ? { qualificationPassed: true, expectedExitCode: 0 } : {}),
    ...(group === "fullstack-browser" && action === "browser-subject" ? { resources: "blocked", hostSubject: structuredClone(browserSubject) } : {}),
    outcomes: input.selection.apps.map((app) => ({ app, outcome: "passed" })), blockers: [] };
} } });
const { inspectNative, executionGroups, validateNativeResult } = await import("./native-replay.mjs");
function fixture(t, group) {
  const folder = mkdtempSync(join(tmpdir(), "isolated-native-composition-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  const binding = { request: { group, round: "w17", commit: "a".repeat(40) }, selection: { apps: selectedApps(group), contractSha256: contractSha256(group) },
    execution: { effectiveOptions: {} }, resources: { expectedCpus: {}, requestedCpuEnv: {} } };
  const summary = { round: binding.request.round, commit: binding.request.commit, options: {}, measurement: { cpus: {} }, complete: true,
    apps: Object.fromEntries(binding.selection.apps.map((a) => [a, { qualification: { fixture: { eligible: true }, api: { eligible: true } }, runs: {} }])) };
  if (group === "localized-marketplace") {
    summary.schema = "marketplace-results/v6";
    summary.measurement.featureProfile = "marketplace-production/v2";
  }
  writeFileSync(join(folder, "summary.json"), JSON.stringify(summary)); writeFileSync(join(folder, "raw.log"), "synthetic\n");
  return { folder, binding, summary };
}
async function jsonFixture(t, options) {
  const f = fixture(t, "json-api"), raw = await productionFixture(f.folder, options), summary = raw.summary;
  for (const path of raw.artifacts.keys()) writeFileSync(join(f.folder, path), raw.artifacts.get(path));
  writeFileSync(join(f.folder, "summary.json"), JSON.stringify(summary));
  Object.assign(f.binding, { request: { group: "json-api", round: summary.round, commit: summary.commit },
    execution: { effectiveOptions: summary.options }, resources: { expectedCpus: summary.measurement.cpus },
    sources: { commit: summary.commit, files: Object.entries(summary.producer.sources)
      .map(([name, sha256]) => ({ path: `bench/json-api/${name}`, sha256 })) } });
  return { ...f, summary };
}

test("catalog replay requires the campaign's selected contract, not a contract chosen by saved evidence", async (t) => {
  action = "normal"; calls = [];
  const { binding, folder } = fixture(t, "catalog-page");
  assert.equal((await inspectNative(binding, folder)).status, "verified");
  assert.equal(calls[0].input.expectedContractSha256, binding.selection.contractSha256);
  delete binding.selection.contractSha256;
  assert.equal((await inspectNative(binding, folder)).status, "invalid");
  assert.equal(calls.length, 1, "missing contract must not fall back to archive-selected replay");
});
test("catalog replay requires both the bound layout name and actual CPU budget", async (t) => {
  action = "normal";
  const { binding, folder, summary } = fixture(t, "catalog-page");
  const loadLayout = "c16-generator-v1", env = { CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-15" };
  binding.resources = { expectedCpus: cpuSettings(env, loadLayout), requestedCpuEnv: { ...env, CATALOG_LOAD_LAYOUT: loadLayout } };
  const replay = async (measurement) => {
    writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...summary, measurement }));
    return (await inspectNative(binding, folder)).status;
  };
  assert.equal(await replay({ loadLayout, cpus: binding.resources.expectedCpus }), "verified");
  assert.equal(await replay({ cpus: binding.resources.expectedCpus }), "invalid");
  assert.equal(await replay({ loadLayout, cpus: cpuSettings({ ...env, CATALOG_LOAD_CPUS: "4-7" }) }), "invalid");
});
test("catalog worker source receipts must match the bound commit even after fully rehashing", async (t) => {
  const f = fixture(t, "catalog-page"), hash = (text) => createHash("sha256").update(text).digest("hex");
  const proof = { schema: "catalog-apparatus-source/v1", commit: f.binding.request.commit,
    files: Object.fromEntries(apparatusSources.map((path) => [path, hash(path)])) };
  f.binding.sources = { commit: proof.commit, files: Object.entries(proof.files).map(([path, sha256]) => ({ path, sha256 })) };
  const save = (value) => {
    const text = JSON.stringify(value);
    f.summary.savedEvidence = { schema: "catalog-saved-evidence/v4", apparatusSourceSha256: hash(text) };
    writeFileSync(join(f.folder, "apparatus-source.json"), text);
    writeFileSync(join(f.folder, "summary.json"), JSON.stringify(f.summary));
  };
  action = "normal"; save(proof);
  assert.equal((await inspectNative(f.binding, f.folder)).status, "verified");
  for (const change of [
    (p) => { p.files[apparatusSources[0]] = hash("different source"); },
    (p) => { delete p.files[apparatusSources[0]]; },
    (p) => { p.files["bench/catalog/unreviewed.mjs"] = hash("extra source"); },
    (p) => { p.commit = "b".repeat(40); },
  ]) {
    const changed = structuredClone(proof); change(changed); save(changed);
    assert.equal((await inspectNative(f.binding, f.folder)).status, "invalid");
  }
  save(proof);
  f.summary.savedEvidence.apparatusSourceSha256 = "b".repeat(64);
  writeFileSync(join(f.folder, "summary.json"), JSON.stringify(f.summary));
  assert.equal((await inspectNative(f.binding, f.folder)).status, "invalid");
  save(proof); rmSync(join(f.folder, "apparatus-source.json"));
  assert.equal((await inspectNative(f.binding, f.folder)).status, "blocked");
});

test("client registered replay uses the same saved verifier for v2, v3 and v4, never unknown schemas", async (t) => {
  const f = fixture(t, "client-heavy");
  for (const [mode, valid] of [["normal", true], ["client-v3", true], ["client-v4", true], ["client-unknown", false]]) {
    action = mode; calls = [];
    const result = await inspectNative(f.binding, f.folder);
    assert.equal(result.status, valid ? "verified" : "invalid", JSON.stringify(result));
    const replay = calls.filter((c) => c.group === "client-api");
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0].input, { folder: f.folder, round: f.binding.request.round, commit: f.binding.request.commit });
    if (valid) assert.ok(result.hostSubject);
  }
  action = "normal";
});

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

test("browser replay forwards the single fixed adapter's subject only when its byte seal matches the safe native snapshot", async (t) => {
  const f = fixture(t, "fullstack-browser");
  const files = ["raw.log", "summary.json"].map((path) => ({ path,
    sha256: createHash("sha256").update(readFileSync(join(f.folder, path))).digest("hex") }));
  browserSubject = { schema: "native-browser-host-subject/v2", executionWindow: { startedAt: 1000, endedAt: 2000 }, processWindows: [],
    toolIdentities: { node: "a".repeat(64), browser: "b".repeat(64), lockSha256: "c".repeat(64) }, participants: [],
    subjectSha256: "d".repeat(64), filesSha256: createHash("sha256").update(JSON.stringify(files) + "\n").digest("hex") };
  action = "browser-subject"; calls = [];
  const result = await inspectNative(f.binding, f.folder);
  assert.equal(result.status, "verified"); assert.equal(result.resources, "blocked");
  assert.deepEqual(result.hostSubject, browserSubject); assert.equal(calls.length, 1);
  assert.equal(calls[0].group, "fullstack-browser");
  const original = browserSubject.filesSha256;
  for (const seal of ["f".repeat(64), undefined, "SYNTHETIC_PRIVATE_SENTINEL"]) {
    browserSubject.filesSha256 = seal;
    const invalid = await inspectNative(f.binding, f.folder);
    assert.equal(invalid.status, "invalid"); assert.equal(invalid.hostSubject, undefined);
    assert.equal(invalid.attemptComplete, false); assert.ok(!JSON.stringify(invalid).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  }
  browserSubject.filesSha256 = original;
  appendFileSync(join(f.folder, "raw.log"), "replaced native evidence");
  assert.equal((await inspectNative(f.binding, f.folder)).status, "invalid");
  action = "normal";
});
test("all registry groups have fixed awaited native APIs, with the real strict JSON report retained", async (t) => {
  assert.deepEqual(executionGroups, groupNames);
  for (const group of groupNames.filter((g) => g !== "json-api")) {
    action = "normal"; calls = []; const { binding, folder } = fixture(t, group);
    const report = await inspectNative(binding, folder); assert.equal(report.status, "verified", group);
    assert.deepEqual(report.outcomes.map((r) => r.app), selectedApps(group)); assert.equal(calls[0].group, group);
  }
  const f = await jsonFixture(t), summary = f.summary;
  assert.equal((await inspectNative(f.binding, f.folder)).status, "verified");
  summary.apps[summary.group.apps[0]].checks = {}; writeFileSync(join(f.folder, "summary.json"), JSON.stringify(summary));
  assert.equal((await inspectNative(f.binding, f.folder)).status, "invalid", "missing raw functional evidence is not success");
});
test("marketplace replay binds old and rotating native results only to their own selected contract", async (t) => {
  action = "normal";
  const { binding, folder, summary } = fixture(t, "localized-marketplace");
  const current = binding.selection.contractSha256, previous = "e7196bc53d5d9a48543dacdfa245c672d5dda68c514f43339779de58f022c9eb";
  for (const [hash, schema, status] of [[current, "marketplace-results/v6", "verified"], [previous, "marketplace-results/v5", "verified"],
    [previous, "marketplace-results/v6", "invalid"], [current, "marketplace-results/v5", "invalid"], [undefined, "marketplace-results/v6", "invalid"]]) {
    binding.selection.contractSha256 = hash;
    writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...summary, schema }));
    assert.equal((await inspectNative(binding, folder)).status, status);
  }
});

test("marketplace replay's actual summary return preserves observed exclusions as selected failures", async (t) => {
  action = "normal"; const f = fixture(t, "localized-marketplace"), first = f.binding.selection.apps[0];
  f.summary.apps[first].qualification.fixture.eligible = false; writeFileSync(join(f.folder, "summary.json"), JSON.stringify(f.summary));
  const report = await inspectNative(f.binding, f.folder);
  assert.equal(report.status, "failed"); assert.equal(report.attemptComplete, true); assert.equal(report.outcomes[0].outcome, "failed");
});

test("real JSON raw replay composes a complete failed target without treating arbitrary invalid evidence as failure", async (t) => {
  const f = await jsonFixture(t, { failure: { app: "corten", key: jsonDescriptor().cases[0].key, pass: 1,
    phase: "fixed", responses: ["ok", "http429", "http503"] } }), summary = f.summary;
  const save = () => writeFileSync(join(f.folder, "summary.json"), JSON.stringify(summary)); save();
  const report = await inspectNative(f.binding, f.folder);
  assert.equal(report.status, "failed"); assert.equal(report.attemptComplete, true); assert.equal(report.cleanupComplete, true);
  assert.deepEqual(report.outcomes, selectedApps("json-api").map((app) => ({ app, outcome: app === "corten" ? "failed" : "passed" })));
  assert.deepEqual(report.comparisonEligibleApps, selectedApps("json-api").filter((app) => app !== "corten"));
  delete summary.apps.corten.checks[summary.group.cases[0].key].native; save();
  const invalid = await inspectNative(f.binding, f.folder);
  assert.equal(invalid.status, "invalid"); assert.equal(invalid.attemptComplete, false);
  assert.ok(invalid.outcomes.every((r) => r.outcome === "not-run"));
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
