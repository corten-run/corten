// Synthetic adapter apparatus, not native contender qualification or timing evidence.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mock, test } from "node:test";
import { definition, selectedApps } from "../../registry.mjs";
import { settings } from "../../../fullstack-browser/contract.mjs";

const seam = new URL("../../../fullstack-browser/verify.mjs", import.meta.url).href;
const virtual = "data:text/javascript,export function validateSaved(){}";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (new URL(specifier, context.parentURL ?? import.meta.url).href === seam) return { url: virtual, shortCircuit: true };
  return next(specifier, context);
} });
let report, calls;
mock.module(virtual, { exports: { validateSaved: (request) => { calls.push(request); return structuredClone(report); } } });
const { inspectSaved } = await import("./fullstack-browser.mjs");
hooks.deregister();
const apps = selectedApps("fullstack-browser"), cases = definition("fullstack-browser").cases;
const commit = "a".repeat(40), round = "w17";
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "synthetic-browser-adapter-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  calls = [];
  const binding = { request: { group: "fullstack-browser", round, commit }, selection: { apps: [...apps], definition: definition("fullstack-browser") },
    execution: { effectiveOptions: { round, targets: null, out: `bench/fullstack-browser/work/${round}`, apps: [...apps], cases: null, build: true }, settings: structuredClone(settings) },
    sources: { files: [{ path: "bench/fullstack-browser/run.mjs", mode: "100644", sha256: "c".repeat(64) }] } };
  const summary = { schema: "native-fullstack-browser/v1", group: "fullstack-browser", options: structuredClone(binding.execution.effectiveOptions),
    settings: structuredClone(settings), code: { commit, runnerFiles: { "run.mjs": "c".repeat(64) } },
    effectivePlan: { cases: cases.map((c) => ({ ...c, steps: [] })) }, complete: true, failures: [], cleanupFailures: [],
    cells: Object.fromEntries(apps.map((a) => [a, cases.map((c) => ({ case: c.key, outcome: "captured", qualificationPassed: true }))])) };
  report = { schema: "native-browser-saved-validation/v1", outcome: "blocked", qualificationPassed: false, readyForLoad: false,
    invalid: [], blocked: ["Synthetic reproduction of current native missing proof policy"],
    inventory: { candidates: 10, profiles: 24, cells: 240, captureFiles: 10 },
    cells: apps.flatMap((app) => cases.map((c) => ({ app, case: c.key, outcome: "captured", derived: { requestOutcome: "passed", upstreamOutcome: "passed", retirement: [], noJS: null }, blocked: [] }))) };
  const save = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(summary));
  save(); return { binding, folder, summary, save };
}

test("current native API is awaited and missing source/terminal/OS proof remains blocked", async (t) => {
  const f = fixture(t), before = readFileSync(join(f.folder, "summary.json"));
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.equal(result.cleanupComplete, false); assert.equal(result.resources, "blocked");
  assert.deepEqual(result.outcomes, apps.map((app) => ({ app, outcome: "passed" })));
  assert.deepEqual(calls, [{ folder: f.folder, round, commit }]);
  assert.deepEqual(readFileSync(join(f.folder, "summary.json")), before);
  assert.ok(result.blockers.includes("source-byte-closure-missing"));
  assert.ok(result.blockers.includes("native-terminal-receipts-missing"));
});

test("full 240-cell matrix retains failed, unsupported and unrun contenders", async (t) => {
  const f = fixture(t);
  for (const [i, outcome] of ["failed", "unsupported", "not-run"].entries()) {
    f.summary.cells[apps[i]][0].outcome = outcome; f.summary.cells[apps[i]][0].qualificationPassed = false;
    const checked = report.cells.find((c) => c.app === apps[i]); checked.outcome = outcome;
    if (outcome === "not-run") checked.derived = null;
  }
  f.save(); const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "blocked"); assert.deepEqual(result.outcomes.map((r) => r.app), apps);
  assert.deepEqual(result.outcomes.slice(0, 3).map((r) => r.outcome), ["failed", "unsupported", "not-run"]);
});

test("qualification flags and an intact manifest cannot supply raw replay", async (t) => {
  const f = fixture(t);
  report.cells.forEach((c) => { c.derived = null; c.blocked = ["synthetic missing observations"]; });
  mkdirSync(join(f.folder, "captures"));
  writeFileSync(join(f.folder, "captures/manifest.json"), JSON.stringify({ qualificationPassed: true, integrity: "synthetic intact manifest" }));
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.attemptComplete, false); assert.equal(result.status, "blocked");
  assert.ok(result.outcomes.every((r) => r.outcome === "not-run"));
});

test("exact identity/options/settings/profile/source and matrix contradictions are invalid", async (t) => {
  const mutations = [
    (f) => { f.summary.group = "client-heavy"; }, (f) => { f.summary.options.round = "w18"; }, (f) => { f.summary.code.commit = "b".repeat(40); },
    (f) => { f.summary.options.apps.pop(); }, (f) => { f.summary.options.cases = [cases[0].key]; },
    (f) => { f.summary.options.build = false; }, (f) => { f.summary.options.targets = "external.json"; }, (f) => { f.summary.options.out += "-other"; },
    (f) => { f.summary.settings.observationMs++; }, (f) => { f.summary.effectivePlan.cases.pop(); },
    (f) => { f.summary.effectivePlan.cases.reverse(); }, (f) => { f.summary.effectivePlan.cases[0].js = false; },
    (f) => { delete f.summary.cells[apps[0]]; }, (f) => { f.summary.cells.extra = []; },
    (f) => { f.summary.cells[apps[0]].pop(); }, (f) => { f.summary.cells[apps[0]][0].case = cases[1].key; },
    (f) => { report.cells.pop(); }, (f) => { report.cells[0] = report.cells[1]; }, (f) => { report.cells[0].outcome = "failed"; },
    (f) => { report.inventory.cells--; }, (f) => { f.summary.code.runnerFiles["run.mjs"] = "d".repeat(64); },
    (f) => { report.sources = { files: [{ path: "bench/fullstack-browser/run.mjs", sha256: "d".repeat(64) }] }; },
  ];
  for (const [i, mutate] of mutations.entries()) await t.test(`contradiction ${i}`, async (t) => {
    const f = fixture(t); mutate(f); f.save();
    const result = await inspectSaved(f.binding, f.folder);
    assert.equal(result.status, "invalid"); assert.equal(result.resources, "invalid"); assert.equal(result.attemptComplete, false);
    assert.deepEqual(result.outcomes.map((r) => r.app), apps);
    assert.ok(result.blockers.every((r) => !r.includes(f.folder)));
  });
});

test("native invalid proof stays invalid without echoing untrusted diagnostics", async (t) => {
  const f = fixture(t); report.outcome = "invalid"; report.invalid.push("Archive diagnostic must not be public");
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "invalid"); assert.ok(!JSON.stringify(result).includes("Archive diagnostic"));
});

test("canonical sources alone do not erase native missing readback, isolation or terminal proof", async (t) => {
  const f = fixture(t); report.sources = { files: structuredClone(f.binding.sources.files) };
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.equal(result.cleanupComplete, false); assert.equal(result.resources, "blocked");
});

test("requested budgets, empty cleanup failures and archive executable paths supply no observations", async (t) => {
  const f = fixture(t);
  f.summary.limits = [{ cpus: 1, memoryBytes: 2 ** 30 }]; f.summary.cleanupFailures = [];
  f.summary.validator = "./saved-verifier.mjs";
  writeFileSync(join(f.folder, "saved-verifier.mjs"), "throw new Error('Synthetic archive code must never execute');");
  f.save(); const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "blocked"); assert.equal(result.cleanupComplete, false); assert.equal(result.resources, "blocked");
});

test("missing native files and source inventory are blockers, malformed files are invalid", async (t) => {
  const f = fixture(t);
  report.outcome = "invalid"; report.invalid = ["Missing regular evidence file captures/manifest.json"];
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "blocked");
  report.invalid.push("Noncanonical/malformed saved JSON summary.json");
  assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
  report.outcome = "blocked"; report.invalid = []; delete f.summary.code.runnerFiles["run.mjs"]; f.save();
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "blocked"); assert.ok(result.blockers.includes("runner-source-inventory-incomplete"));
});
