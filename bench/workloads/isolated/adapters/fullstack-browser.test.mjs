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

function v2Fixture(t) {
  const f = fixture(t);
  f.binding.sources.files.push({ path: "package-lock.json", mode: "100644", sha256: "d".repeat(64) });
  f.summary.native = { schema: "native-browser-run/v2", execution: { sha256: "e".repeat(64) } }; f.summary.qualificationPassed = true;
  f.summary.startedAt = new Date(1000).toISOString(); f.summary.finishedAt = new Date(2000).toISOString();
  f.summary.browser = { executableSha256: "b".repeat(64) };
  report = { ...report, schema: "native-browser-saved-validation/v2", status: "verified", invalid: [], blocked: [],
    attemptComplete: true, selectedComplete: true, qualificationPassed: true, cleanupComplete: true, expectedExitCode: 0,
    intrinsic: { valid: true, complete: true, passed: true, cleanupPassed: true },
    sources: { commit, files: structuredClone(f.binding.sources.files) },
    hostSubject: { schema: "native-browser-host-subject/v2", executionWindow: { startedAt: 1000, endedAt: 2000 },
      processWindows: apps.flatMap((app) => cases.map((c) => ({ kind: "browser", app, case: c.key, startedAt: 1100, endedAt: 1900 }))),
      toolIdentities: { node: "a".repeat(64), browser: "b".repeat(64), lockSha256: "d".repeat(64) },
      participants: [{ id: "1".repeat(64), role: "upstream", app: null, case: null, imageId: `sha256:${"2".repeat(64)}`,
        window: { startedAt: 1000, endedAt: 2000 }, terminal: { id: "1".repeat(64), imageId: `sha256:${"2".repeat(64)}` } }],
      subjectSha256: "e".repeat(64), filesSha256: "f".repeat(64) } };
  delete report.outcome;
  for (const c of report.cells) Object.assign(c, { selected: true, attemptComplete: true, qualificationPassed: true,
    disposition: "qualified", derived: { ...c.derived, completeActions: true } });
  f.save(); return f;
}

test("v2 binds the full replayed matrix and forwards its host subject without asserting OS proof", async (t) => {
  const f = v2Fixture(t), subject = structuredClone(report.hostSubject);
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "verified"); assert.equal(result.attemptComplete, true); assert.equal(result.cleanupComplete, true);
  assert.equal(result.resources, "blocked"); assert.equal(result.qualificationPassed, true); assert.equal(result.expectedExitCode, 0);
  assert.deepEqual(result.hostSubject, subject); assert.deepEqual(result.comparisonEligibleApps, apps);
  assert.deepEqual(calls, [{ folder: f.folder, round, commit }]);
});

test("v2 observed prerequisite and target failures retain every app, exact exit one and no comparisons", async (t) => {
  const f = v2Fixture(t);
  for (const c of report.cells.filter((c) => c.app === apps[0])) {
    Object.assign(c, { outcome: "failed", qualificationPassed: false, disposition: "observed-prerequisite-failure",
      derived: { prerequisite: "native-build-rejected", command: 0 } });
    Object.assign(f.summary.cells[c.app].find((r) => r.case === c.case), { outcome: "failed", qualificationPassed: false });
  }
  const c = report.cells.find((c) => c.app === apps[1]);
  Object.assign(c, { outcome: "unsupported", qualificationPassed: false, disposition: "observed-target-failure" });
  Object.assign(f.summary.cells[c.app].find((r) => r.case === c.case), { outcome: "unsupported", qualificationPassed: false });
  report.hostSubject.processWindows = report.hostSubject.processWindows.filter((w) => w.app !== apps[0]);
  report.status = "failed"; report.qualificationPassed = false; report.expectedExitCode = 1; report.intrinsic.passed = false;
  f.summary.qualificationPassed = false; f.save();
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "failed"); assert.equal(result.attemptComplete, true); assert.equal(result.cleanupComplete, true);
  assert.equal(result.expectedExitCode, 1); assert.equal(result.qualificationPassed, false);
  assert.deepEqual(result.outcomes.slice(0, 2), [{ app: apps[0], outcome: "failed" }, { app: apps[1], outcome: "unsupported" }]);
  assert.deepEqual(result.outcomes.map((r) => r.app), apps); assert.deepEqual(result.comparisonEligibleApps, []);
});

test("v2 complete acknowledged build failures need no invented browser process windows", async (t) => {
  const f = v2Fixture(t);
  for (const c of report.cells) {
    Object.assign(c, { outcome: "failed", qualificationPassed: false, disposition: "observed-prerequisite-failure",
      derived: { prerequisite: "native-build-rejected", command: 0 } });
    Object.assign(f.summary.cells[c.app].find((r) => r.case === c.case), { outcome: "failed", qualificationPassed: false });
  }
  report.hostSubject.processWindows = [];
  report.status = "failed"; report.qualificationPassed = false; report.expectedExitCode = 1; report.intrinsic.passed = false;
  f.summary.qualificationPassed = false; f.save();
  const result = await inspectSaved(f.binding, f.folder);
  assert.equal(result.status, "failed"); assert.equal(result.attemptComplete, true); assert.equal(result.cleanupComplete, true);
  assert.deepEqual(result.outcomes, apps.map((app) => ({ app, outcome: "failed" })));
  assert.deepEqual(result.hostSubject.processWindows, []); assert.deepEqual(result.comparisonEligibleApps, []);
});

test("v2 missing proof and the current missing tool lock handoff cannot invent OS qualification", async (t) => {
  for (const missing of ["source", "cleanup", "cell", "subject", "tool-lock"]) await t.test(missing, async (t) => {
    const f = v2Fixture(t);
    if (missing === "source") report.sources = null;
    if (missing === "cleanup") {
      report.cleanupComplete = false; report.intrinsic.cleanupPassed = false;
      report.hostSubject = null;
    }
    if (missing === "cell") {
      const c = report.cells[0]; c.derived = null; c.attemptComplete = false; c.qualificationPassed = false;
      c.disposition = "proof-missing"; c.blocked.push("SYNTHETIC_PRIVATE_SENTINEL");
    }
    if (["source", "cleanup", "cell"].includes(missing)) {
      report.status = "blocked"; report.blocked.push("SYNTHETIC_PRIVATE_SENTINEL");
      report.attemptComplete = false; report.selectedComplete = false; report.intrinsic.complete = false;
      report.qualificationPassed = false; report.expectedExitCode = 1; report.intrinsic.passed = false;
    }
    if (missing === "subject") report.hostSubject = null;
    if (missing === "tool-lock") delete report.hostSubject.toolIdentities.lockSha256;
    const result = await inspectSaved(f.binding, f.folder);
    assert.equal(result.resources, "blocked"); assert.ok(result.blockers.length);
    if (["source", "cleanup", "cell"].includes(missing)) {
      assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
    } else assert.equal(result.hostSubject, undefined);
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  });
});

test("v2 contradictory source, selection, dispositions, completion, cleanup, exit and host output is invalid", async (t) => {
  const mutations = [
    () => { report.sources.commit = "b".repeat(40); },
    () => { report.sources.files[0].sha256 = "b".repeat(64); },
    () => { report.sources.files[0].mode = "100755"; },
    () => { report.sources.files.push(report.sources.files[0]); },
    () => { report.sources.files.push({ path: "external", mode: "100644", sha256: "a".repeat(64) }); },
    () => { report.cells[0].selected = false; },
    () => { report.cells[0].attemptComplete = false; },
    () => { report.cells[0].derived = null; },
    () => { report.cells[0].derived.completeActions = false; },
    () => { report.cells[0].disposition = "observed-target-failure"; },
    () => { report.cells[0].derived.prerequisite = "assertion string"; },
    () => { report.cells[0].outcome = "failed"; },
    () => { report.selectedComplete = false; },
    () => { report.intrinsic.complete = false; },
    () => { report.intrinsic.cleanupPassed = false; },
    () => { report.intrinsic.passed = false; },
    () => { report.expectedExitCode = 1; },
    () => { report.status = "failed"; },
    () => { report.blocked.push("SYNTHETIC_PRIVATE_SENTINEL"); },
    () => { report.hostSubject.toolIdentities.lockSha256 = "a".repeat(64); },
    () => { report.hostSubject.processWindows[0].app = "foreign"; },
    () => { report.hostSubject.processWindows[0].case = "foreign"; },
    () => { report.hostSubject.processWindows[0].endedAt = 2001; },
    () => { report.hostSubject.processWindows.pop(); },
    () => { report.hostSubject.participants.push({ id: "foreign" }); },
    () => { report.hostSubject.subjectSha256 = "0".repeat(64); },
    () => { report.hostSubject.toolIdentities.browser = "0".repeat(64); },
    () => { report.hostSubject.executionWindow.startedAt = 999; },
    () => { report.hostSubject.participants[0].app = apps[0]; },
  ];
  for (const [i, mutate] of mutations.entries()) await t.test(`v2 contradiction ${i}`, async (t) => {
    const f = v2Fixture(t); mutate(); const result = await inspectSaved(f.binding, f.folder);
    assert.equal(result.status, "invalid"); assert.equal(result.attemptComplete, false); assert.equal(result.resources, "invalid");
    assert.ok(result.outcomes.every((r) => r.outcome === "not-run"));
    assert.equal(result.hostSubject, undefined); assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  });
});

test("v2 cannot rebind actual replay to other options, workload, source inventory or a self-approved summary", async (t) => {
  const mutations = [
    (f) => { f.summary.options.round = "w18"; }, (f) => { f.summary.code.commit = "b".repeat(40); },
    (f) => { f.summary.group = "client-heavy"; }, (f) => { f.summary.options.apps.pop(); },
    (f) => { f.summary.options.cases = [cases[0].key]; }, (f) => { f.summary.options.build = false; },
    (f) => { f.summary.options.targets = "external.json"; }, (f) => { f.summary.options.out += "-other"; },
    (f) => { f.summary.settings.observationMs++; }, (f) => { f.summary.effectivePlan.cases.reverse(); },
    (f) => { f.summary.effectivePlan.cases[0].source = "other"; },
    (f) => { f.summary.code.runnerFiles["run.mjs"] = "0".repeat(64); },
    (f) => { delete f.summary.code.runnerFiles["run.mjs"]; },
    (f) => { f.summary.complete = false; }, (f) => { f.summary.cleanupFailures.push("SYNTHETIC_PRIVATE_SENTINEL"); },
    (f) => { f.summary.cells[apps[0]].pop(); },
    () => { report.sources.files.pop(); }, () => { report.cells[0] = report.cells[1]; },
    () => { report.inventory.cells--; }, () => { report.invalid.push("SYNTHETIC_PRIVATE_SENTINEL"); },
  ];
  for (const [i, mutate] of mutations.entries()) await t.test(`v2 binding ${i}`, async (t) => {
    const f = v2Fixture(t); mutate(f); f.save(); const result = await inspectSaved(f.binding, f.folder);
    assert.equal(result.status, "invalid"); assert.equal(result.attemptComplete, false);
    assert.equal(result.hostSubject, undefined); assert.deepEqual(result.comparisonEligibleApps ?? [], []);
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  });
});

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
