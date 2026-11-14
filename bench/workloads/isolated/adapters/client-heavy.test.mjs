// Synthetic adapter apparatus only. No native build, timing or admission claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { mock, test } from "node:test";
import { definition, selectedApps } from "../../registry.mjs";
import { createClientWorkload } from "../../client.mjs";

// The native owner lands separately. Resolve only the exact missing static seam in
// this test process; never create/copy a verifier or add a production injection API.
const seam = new URL("../../../client-heavy/verify.mjs", import.meta.url).href;
const virtual = "data:text/javascript,export async function validateSaved(){}";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (new URL(specifier, context.parentURL ?? import.meta.url).href === seam) return { url: virtual, shortCircuit: true };
  return next(specifier, context);
} });
let report, calls;
mock.module(virtual, { exports: { validateSaved: async (request) => { calls.push(request); return structuredClone(report); } } });
const { inspectSaved } = await import("./client-heavy.mjs");
hooks.deregister();
const hash = (v) => createHash("sha256").update(v).digest("hex");
const apps = selectedApps("client-heavy"), commit = "a".repeat(40), round = "w17";
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "synthetic-client-adapter-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  calls = [];
  const put = (name, value) => { mkdirSync(dirname(join(folder, name)), { recursive: true }); writeFileSync(join(folder, name), JSON.stringify(value)); };
  const settings = createClientWorkload({ seed: 7, rowCount: 14, largeRowCount: 110, appendCount: 7, dashboardCount: 24 });
  const binding = { request: { group: "client-heavy", round, commit }, selection: { apps: [...apps], definition: definition("client-heavy") },
    execution: { invocation: { executable: "node", argv: ["bench/client-heavy/run.mjs", round, "--out", `bench/client-heavy/work/${round}`] },
      effectiveOptions: { rows: 14, large: 110, append: 7, cards: 24, seed: 7, cleanupMs: 2000, observationMs: 100, timeoutMs: 30000, cargo: "cargo", out: `bench/client-heavy/work/${round}` }, settings },
    sources: { files: [] } };
  const plan = { schema: "client-heavy-plan/v1", round, commit, root: "/synthetic/repository", platform: "linux", selectedApps: [...apps], definition: definition("client-heavy"),
    invocation: { argv: binding.execution.invocation.argv.slice(1), effective: { rows: 14, large: 110, append: 7, cards: 24, seed: 7,
      "cleanup-ms": 2000, "observation-ms": 100, "timeout-ms": 30000, cargo: "cargo", out: `/synthetic/repository/bench/client-heavy/work/${round}` } },
    workload: settings, settings: { maxCleanupMs: 2000, cleanupObservationMs: 100 }, timeoutMs: 30000 };
  const output = { schema: "client-heavy-native/v2", group: "client-heavy", round, provenance: { commit }, selectedApps: [...apps], definition: definition("client-heavy"),
    effectiveWorkload: settings, settings: plan.settings, timeoutMs: 30000,
    builds: Object.fromEntries(apps.map((a) => [a, { outcome: "built" }])),
    cells: Object.fromEntries(apps.map((a) => [a, { outcome: "passed", qualification: { lifecycle: { contextCreatedAt: 1 } }, measurement: { lifecycle: { contextCreatedAt: 2 } } }])) };
  report = { schema: "client-heavy-saved-verification/v2", group: "client-heavy", round, commit, status: "verified", valid: true, diagnosticsPassed: true,
    intrinsic: { valid: true, complete: true, passed: true, cleanupPassed: true }, selectedApps: [...apps], errors: [], blockers: [],
    invocation: plan.invocation, effectiveWorkload: settings, settings: plan.settings, timeoutMs: 30000, sources: { files: [] },
    authentication: "external-required", ready: false, readyForLoad: false, rankingEligible: false,
    cells: Object.fromEntries(apps.map((a) => [a, { outcome: "passed", replayPassed: true, build: { outcome: "built" },
      qualification: { passed: true, closurePassed: true }, measurement: { passed: true, closurePassed: true } }])) };
  const entries = [];
  function source(path, text = "// Synthetic source apparatus\n", checkout = text) {
    const bytes = Buffer.from(checkout), sha256 = hash(bytes);
    binding.sources.files.push({ path, mode: "100644", sha256: hash(text) });
    entries.push({ path, bytes: bytes.length, sha256, blob: `evidence/blobs/${sha256}` });
    mkdirSync(join(folder, "evidence/blobs"), { recursive: true }); writeFileSync(join(folder, "evidence/blobs", sha256), bytes);
    report.sources.files = entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  }
  source("bench/client-heavy/run.mjs"); source("Cargo.toml", "# Synthetic Cargo input\n");
  const save = () => { put("result.json", output); put("plan.json", plan); put("native/build.json", output.builds); put("native/workload.json", settings);
    put("evidence/source-before.json", { entries }); put("evidence/source-after.json", { entries }); };
  save(); return { folder, binding, output, plan, put, save, source, entries };
}

test("synthetic v2 intrinsic validity is supported without pretending external admission or OS isolation", async (t) => {
  const f = fixture(t), before = readFileSync(join(f.folder, "result.json"));
  const result = await inspectSaved(f.binding, f.folder);
  assert.deepEqual(result, { status: "verified", attemptComplete: true, cleanupComplete: true, resources: "blocked",
    outcomes: apps.map((app) => ({ app, outcome: "passed" })), blockers: ["actual-os-resource-inventory-missing"] });
  assert.deepEqual(calls, [{ folder: f.folder, round, commit }]);
  assert.deepEqual(readFileSync(join(f.folder, "result.json")), before);
});

test("tracked historical browser inputs are native source bytes, not optional result summaries", async (t) => {
  const f = fixture(t); f.source("bench/browser/results/browser-1/summary.json", '{"historical":"input"}\n'); f.save();
  assert.equal((await inspectSaved(f.binding, f.folder)).attemptComplete, true);
  const saved = f.binding.sources.files.pop();
  assert.equal((await inspectSaved(f.binding, f.folder)).attemptComplete, false);
  f.binding.sources.files.push({ ...saved, sha256: "f".repeat(64) });
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
});

test("valid complete failed/unsupported/unrun cells are retained, not forced successful or dropped", async (t) => {
  const f = fixture(t);
  for (const [i, outcome] of ["failed", "unsupported", "not-run"].entries()) {
    const app = apps[i]; f.output.cells[app] = { outcome, qualification: null, measurement: null };
    f.output.builds[app] = { outcome: i === 0 ? "failed" : "not-run" };
    Object.assign(report.cells[app], { outcome, replayPassed: false, qualification: null, measurement: null, build: f.output.builds[app] });
  }
  report.intrinsic.passed = false; report.status = "failed"; f.save();
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "failed"); assert.equal(result.attemptComplete, true); assert.equal(result.cleanupComplete, true);
  assert.deepEqual(result.outcomes.slice(0, 3).map((r) => r.outcome), ["failed", "unsupported", "not-run"]);
  assert.deepEqual(result.outcomes.map((r) => r.app), apps);
});

test("every bound identity, option, selection and cell seam rejects contradictions", async (t) => {
  const mutations = [
    (f) => { f.output.group = "fullstack-browser"; }, (f) => { f.output.round = "w18"; }, (f) => { f.output.provenance.commit = "b".repeat(40); },
    (f) => { f.plan.commit = "b".repeat(40); }, (f) => { f.plan.selectedApps.pop(); }, (f) => { f.output.selectedApps.reverse(); },
    (f) => { f.output.definition = {}; }, (f) => { f.plan.invocation.argv.push("--cargo", "injected"); },
    (f) => { f.plan.invocation.effective.seed++; }, (f) => { f.output.settings = { maxCleanupMs: 1 }; },
    (f) => { f.output.timeoutMs++; }, (f) => { f.plan.workload = {}; },
    (f) => { delete f.output.cells[apps[0]]; }, (f) => { report.cells.extra = report.cells[apps[0]]; },
    (f) => { report.cells[apps[0]].outcome = "failed"; }, (f) => { report.cells[apps[0]].build.outcome = "not-run"; },
    (f) => { report.cells[apps[0]].measurement = null; }, (f) => { report.cells[apps[0]].qualification.passed = false; },
    (f) => { f.binding.sources.files[0].sha256 = "f".repeat(64); }, (f) => { report.sources.files[0].bytes++; },
    (f) => { report.intrinsic.complete = false; }, (f) => { report.status = "failed"; },
  ];
  for (const [i, mutate] of mutations.entries()) await t.test(`contradiction ${i}`, async (t) => {
    const f = fixture(t); mutate(f); f.save();
    const result = await inspectSaved(f.binding, f.folder);
    assert.equal(result.status, "invalid"); assert.equal(result.attemptComplete, false); assert.equal(result.resources, "invalid");
    assert.deepEqual(result.outcomes.map((r) => r.app), f.binding.selection.apps);
    assert.ok(result.blockers.every((r) => !r.includes(f.folder)), "public errors never echo native/archive data");
  });
});

test("missing native proof and incomplete source closure stay blocked, not fabricated", async (t) => {
  for (const mode of ["plan", "sources", "source-file", "native-blocker"]) await t.test(mode, async (t) => {
    const f = fixture(t);
    if (mode === "plan") rmSync(join(f.folder, "plan.json"));
    if (mode === "sources") report.sources = null;
    if (mode === "source-file") f.binding.sources.files.push({ path: "crates/corten/src/lib.rs", mode: "100644", sha256: "f".repeat(64) });
    if (mode === "native-blocker") { report.blockers.push("synthetic missing proof"); report.intrinsic.complete = false; report.status = "blocked"; }
    const result = await inspectSaved(f.binding, f.folder);
    assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false); assert.equal(result.resources, "blocked");
  });
});

test("canonical Git text permits only actual CRLF checkout bytes, not a claimed source digest", async (t) => {
  const f = fixture(t); f.source("crates/synthetic.rs", "// Synthetic\n", "// Synthetic\r\n");
  f.source("crates/committed-crlf.rs", "// Synthetic committed CRLF\r\n"); f.save();
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "verified");
  writeFileSync(join(f.folder, "evidence/blobs", f.entries.at(-1).sha256), "different bytes");
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
});

test("client requested limits and saved executable names cannot clear the resource gate", async (t) => {
  const f = fixture(t); f.output.provenance.resources = { cpus: 8, memoryBytes: 2 ** 30 };
  f.output.validator = "saved-verifier.mjs";
  writeFileSync(join(f.folder, "saved-verifier.mjs"), "throw new Error('Synthetic saved code must not execute');");
  f.save(); const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "verified"); assert.equal(result.resources, "blocked");
});

test("positive global close cannot hide an unclosed journey context", async (t) => {
  const f = fixture(t); report.cells[apps[0]].qualification.closurePassed = false;
  report.cells[apps[0]].qualification.passed = false; report.cells[apps[0]].replayPassed = false;
  report.cells[apps[0]].measurement = null; report.cells[apps[0]].outcome = "failed";
  f.output.cells[apps[0]].measurement = null; f.output.cells[apps[0]].outcome = "failed";
  report.intrinsic.passed = false; report.status = "failed"; f.save();
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "failed"); assert.equal(result.cleanupComplete, false);
});

test("native contradictions are bounded; legacy v1 diagnostics cannot become v2 proof", async (t) => {
  const f = fixture(t);
  report.errors.push({ reason: "source-bytes-differ-from-exact-commit" });
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
  report.errors = [];
  report.schema = "client-heavy-saved-verification/v1";
  report.cells[apps[0]].outcome = "failed";
  const legacy = await inspectSaved(f.binding, f.folder);
  assert.equal(legacy.status, "blocked"); assert.equal(legacy.outcomes[0].outcome, "failed");
});

test("native malformed diagnostics cannot be relabeled missing; explicit missing files stay blocked", async (t) => {
  const f = fixture(t);
  report.errors = [{ at: "result.json", reason: "missing-unreadable-or-malformed-evidence" }];
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
  report.errors = [{ at: "plan.json", reason: "missing-required-file" }];
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "blocked");
});
