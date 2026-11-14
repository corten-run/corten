// The caller validates the binding and the whole physical folder before this read.
// Saved imports, commands, custom target paths and external verifier paths are never followed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSaved } from "../../../fullstack-browser/verify.mjs";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (value, names) => {
  assert.ok(object(value)); assert.deepEqual(Object.keys(value).sort(), [...names].sort());
};
const sourceRoots = ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "crates", "bench/fullstack-browser",
  "bench/fullstack", "bench/marketplace", "bench/workloads"];
const aggregate = (rows) => rows.includes("failed") ? "failed" : rows.includes("not-run") ? "not-run"
  : rows.includes("unsupported") ? "unsupported" : "passed";
const hash = /^[a-f0-9]{64}$/;
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const window = (v, outer) => {
  keys(v, ["startedAt", "endedAt"]);
  assert.ok(Number.isSafeInteger(v.startedAt) && v.startedAt >= 0 && Number.isSafeInteger(v.endedAt) && v.endedAt >= v.startedAt);
  if (outer) assert.ok(v.startedAt >= outer.startedAt && v.endedAt <= outer.endedAt);
};

function hostSubject(binding, summary, native, block) {
  const subject = native.hostSubject;
  if (subject === null) { block("native-host-subject-missing"); return; }
  keys(subject, ["schema", "executionWindow", "processWindows", "toolIdentities", "participants", "subjectSha256", "filesSha256"]);
  assert.equal(subject.schema, "native-browser-host-subject/v2");
  assert.equal(native.cleanupComplete, true);
  window(subject.executionWindow);
  assert.match(subject.subjectSha256, hash); assert.match(subject.filesSha256, hash);
  assert.equal(subject.subjectSha256, summary.native.execution.sha256);
  assert.ok(Date.parse(summary.startedAt) <= subject.executionWindow.startedAt
    && subject.executionWindow.endedAt <= Date.parse(summary.finishedAt));
  const apps = binding.selection.apps, cases = binding.selection.definition.cases.map((c) => c.key);
  assert.ok(Array.isArray(subject.processWindows) && Array.isArray(subject.participants));
  const seen = new Set();
  for (const w of subject.processWindows) {
    keys(w, ["kind", "app", "case", "startedAt", "endedAt"]);
    assert.equal(w.kind, "browser"); assert.ok(apps.includes(w.app) && cases.includes(w.case));
    const key = `${w.app}/${w.case}`; assert.ok(!seen.has(key)); seen.add(key);
    window({ startedAt: w.startedAt, endedAt: w.endedAt }, subject.executionWindow);
  }
  if (native.attemptComplete) assert.deepEqual([...seen].sort(), native.cells.filter((c) => !c.derived.prerequisite)
    .map((c) => `${c.app}/${c.case}`).sort());
  const ids = new Set();
  for (const p of subject.participants) {
    keys(p, ["id", "role", "app", "case", "imageId", "window", "terminal"]);
    assert.match(p.id, hash); assert.ok(!ids.has(p.id)); ids.add(p.id);
    assert.ok(["application", "upstream", "artifact"].includes(p.role));
    assert.ok(p.role === "upstream" ? p.app === null && p.case === null
      : apps.includes(p.app) && (p.role === "artifact" ? p.case === null : cases.includes(p.case)));
    assert.match(p.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.ok(object(p.terminal)); assert.equal(p.terminal.id, p.id); assert.equal(p.terminal.imageId, p.imageId);
    if (p.window !== null) window(p.window, subject.executionWindow);
  }
  // The caller currently forwards node/browser but not the independently replayed
  // lock identity. Do not reconstruct that missing handoff from saved summaries.
  const tools = subject.toolIdentities;
  assert.ok(object(tools));
  keys(tools, Object.hasOwn(tools, "lockSha256") ? ["node", "browser", "lockSha256"] : ["node", "browser"]);
  assert.match(tools.node, hash); assert.match(tools.browser, hash);
  assert.equal(tools.browser, summary.browser.executableSha256);
  if (!Object.hasOwn(tools, "lockSha256")) { block("native-tool-lock-handoff-missing"); return; }
  assert.match(tools.lockSha256, hash);
  assert.equal(tools.lockSha256, binding.sources.files.find((f) => f.path === "package-lock.json")?.sha256);
  return subject;
}

function inspectV2(binding, folder, native, result, block) {
  assert.ok(["verified", "failed", "blocked", "invalid"].includes(native.status));
  assert.ok(strings(native.invalid) && strings(native.blocked));
  if (native.status === "invalid" || native.invalid.length) {
    if (native.invalid.length && native.invalid.every((s) => /^Missing regular evidence file [A-Za-z0-9/_.-]+$/.test(s))) {
      block("native-proof-missing"); return result;
    }
    result.status = "invalid"; result.resources = "invalid"; block("native-proof-contradictory"); return result;
  }
  for (const key of ["attemptComplete", "selectedComplete", "qualificationPassed", "cleanupComplete", "readyForLoad"])
    assert.equal(typeof native[key], "boolean");
  keys(native.intrinsic, ["valid", "complete", "passed", "cleanupPassed"]);
  assert.equal(native.intrinsic.valid, true);
  assert.equal(native.intrinsic.complete, native.attemptComplete && !native.blocked.length);
  assert.equal(native.intrinsic.passed, native.qualificationPassed);
  assert.equal(native.intrinsic.cleanupPassed, native.cleanupComplete);
  assert.equal(native.expectedExitCode, native.qualificationPassed ? 0 : 1);
  assert.equal(native.status, native.blocked.length ? "blocked" : native.qualificationPassed ? "verified" : "failed");
  const { group, round, commit } = binding.request, apps = binding.selection.apps, cases = binding.selection.definition.cases;
  const summary = JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"));
  assert.equal(summary.schema, "native-fullstack-browser/v1"); assert.equal(summary.native?.schema, "native-browser-run/v2");
  assert.equal(summary.group, group); assert.equal(summary.code.commit, commit); assert.equal(summary.options.round, round);
  assert.deepEqual(summary.options, binding.execution.effectiveOptions); assert.deepEqual(summary.options.apps, apps);
  assert.deepEqual(summary.settings, binding.execution.settings);
  assert.deepEqual(summary.effectivePlan.cases.map(({ steps, ...profile }) => profile), cases);
  assert.equal(typeof summary.complete, "boolean"); assert.equal(typeof summary.qualificationPassed, "boolean");
  assert.ok(Array.isArray(summary.failures) && Array.isArray(summary.cleanupFailures));
  keys(summary.cells, apps);
  const bound = new Map(binding.sources.files.map((f) => [f.path, f]));
  let sourcesComplete = true;
  assert.ok(object(summary.code.runnerFiles));
  for (const [name, digest] of Object.entries(summary.code.runnerFiles)) {
    assert.ok(bound.has(`bench/fullstack-browser/${name}`)); assert.equal(digest, bound.get(`bench/fullstack-browser/${name}`).sha256);
  }
  for (const f of binding.sources.files.filter((f) => /^bench\/fullstack-browser\/[^/]+\.mjs$/.test(f.path)))
    if (!Object.hasOwn(summary.code.runnerFiles, f.path.slice("bench/fullstack-browser/".length))) sourcesComplete = false;
  if (native.sources === null) sourcesComplete = false;
  else {
    keys(native.sources, ["commit", "files"]); assert.equal(native.sources.commit, commit); assert.ok(Array.isArray(native.sources.files));
    const seen = new Set();
    for (const file of native.sources.files) {
      keys(file, ["path", "mode", "sha256"]); assert.ok(!seen.has(file.path)); seen.add(file.path);
      assert.deepEqual(file, bound.get(file.path));
    }
    if (seen.size !== bound.size) sourcesComplete = false;
  }
  if (!sourcesComplete) block("source-byte-closure-incomplete");
  assert.deepEqual(native.inventory, { candidates: apps.length, profiles: cases.length, cells: apps.length * cases.length, captureFiles: apps.length });
  assert.ok(Array.isArray(native.cells)); assert.equal(native.cells.length, apps.length * cases.length);
  const replayed = new Map();
  for (const cell of native.cells) {
    assert.ok(apps.includes(cell.app) && cases.some((c) => c.key === cell.case));
    const key = `${cell.app}/${cell.case}`; assert.ok(!replayed.has(key)); replayed.set(key, cell);
    assert.ok(strings(cell.blocked)); assert.equal(cell.selected, true);
    const derived = cell.derived;
    if (derived !== null) assert.ok(object(derived));
    if (derived?.prerequisite !== undefined) {
      assert.ok(["native-build-rejected", "native-create-rejected", "native-start-rejected"].includes(derived.prerequisite));
      assert.ok(Number.isSafeInteger(derived.command) && derived.command >= 0); assert.equal(cell.outcome, "failed");
    }
    const complete = !cell.blocked.length && Boolean(derived?.prerequisite || derived?.completeActions === true);
    assert.equal(cell.attemptComplete, complete); assert.equal(typeof cell.qualificationPassed, "boolean");
    const raw = summary.cells[cell.app]; assert.ok(Array.isArray(raw));
    assert.deepEqual(raw.map((c) => c.case), cases.map((c) => c.key));
    const saved = raw.find((c) => c.case === cell.case);
    assert.ok(["not-run", "failed", "unsupported", "captured"].includes(saved.outcome)); assert.equal(cell.outcome, saved.outcome);
    assert.equal(cell.qualificationPassed, complete && !derived.prerequisite && saved.qualificationPassed === true);
    assert.equal(cell.disposition, !complete ? "proof-missing" : derived.prerequisite ? "observed-prerequisite-failure"
      : cell.qualificationPassed ? "qualified" : "observed-target-failure");
    if (complete) assert.notEqual(cell.outcome, "not-run");
    if (cell.qualificationPassed) assert.equal(cell.outcome, "captured");
  }
  const complete = !native.blocked.length && native.cells.every((c) => c.attemptComplete);
  assert.equal(native.selectedComplete, complete); assert.equal(native.attemptComplete, complete);
  assert.equal(native.qualificationPassed, complete && summary.qualificationPassed);
  if (complete) { assert.ok(sourcesComplete && summary.complete && !summary.failures.length); assert.equal(native.cleanupComplete, true); }
  if (native.qualificationPassed) assert.ok(native.cells.every((c) => c.qualificationPassed));
  if (native.cleanupComplete) assert.equal(summary.cleanupFailures.length, 0);
  for (const row of result.outcomes) row.outcome = aggregate(native.cells.filter((c) => c.app === row.app).map((c) =>
    !c.attemptComplete ? "not-run" : c.qualificationPassed ? "passed" : c.outcome === "unsupported" ? "unsupported" : "failed"));
  result.status = complete && sourcesComplete ? native.status : "blocked";
  result.attemptComplete = complete && sourcesComplete;
  result.cleanupComplete = native.cleanupComplete;
  result.qualificationPassed = native.qualificationPassed;
  result.expectedExitCode = native.expectedExitCode;
  result.comparisonEligibleApps = result.qualificationPassed ? [...apps] : [];
  if (native.blocked.length) block("native-proof-incomplete");
  const subject = hostSubject(binding, summary, native, block);
  if (subject && sourcesComplete) result.hostSubject = subject;
  block("external-os-observation-required");
  return result;
}

/**
 * Intrinsic replay only. No human approval, load eligibility or provider ownership is inferred.
 * v1 remains diagnostic only. v2 binds the fixed native replay's complete source
 * closure, selected matrix, per-cell dispositions, cleanup and qualification exit.
 * A replayed host subject is forwarded unchanged for independent kernel composition;
 * Docker declarations and intrinsic qualification never assert actual OS resources.
 */
export async function inspectSaved(binding, folder) {
  const apps = binding.selection.apps, cases = binding.selection.definition.cases;
  const result = { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
    outcomes: apps.map((app) => ({ app, outcome: "not-run" })), blockers: [] };
  const block = (code) => { if (!result.blockers.includes(code)) result.blockers.push(code); };
  try {
    const { group, round, commit } = binding.request;
    assert.equal(group, "fullstack-browser");
    const native = await validateSaved({ folder, round, commit });
    if (native.schema === "native-browser-saved-validation/v2") return inspectV2(binding, folder, native, result, block);
    assert.equal(native.schema, "native-browser-saved-validation/v1");
    assert.ok(["invalid", "blocked"].includes(native.outcome));
    assert.ok(Array.isArray(native.invalid) && Array.isArray(native.blocked) && Array.isArray(native.cells));
    if (native.outcome === "invalid" || native.invalid.length) {
      // The fixed native reader names absent regular files explicitly. A malformed,
      // unsafe or contradictory file must not be downgraded to missing proof.
      if (native.invalid.length && native.invalid.every((reason) => /^Missing regular evidence file [A-Za-z0-9/_.-]+$/.test(reason))) {
        block("native-proof-missing"); return result;
      }
      result.status = "invalid"; result.resources = "invalid"; block("native-proof-contradictory"); return result;
    }
    const summary = JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"));
    assert.equal(summary.schema, "native-fullstack-browser/v1"); assert.equal(summary.group, group);
    assert.equal(summary.options.round, round); assert.equal(summary.code.commit, commit);
    assert.deepEqual(summary.options, binding.execution.effectiveOptions);
    assert.deepEqual(summary.options.apps, apps);
    assert.deepEqual(summary.settings, binding.execution.settings);
    assert.deepEqual(summary.effectivePlan.cases.map(({ steps, ...profile }) => profile), cases);
    keys(summary.cells, apps);
    assert.equal(native.cells.length, apps.length * cases.length);
    assert.deepEqual(native.inventory, { candidates: apps.length, profiles: cases.length, cells: apps.length * cases.length, captureFiles: apps.length });
    const replayed = new Map();
    for (const cell of native.cells) {
      assert.ok(apps.includes(cell.app) && cases.some((c) => c.key === cell.case));
      const key = `${cell.app}/${cell.case}`; assert.ok(!replayed.has(key)); replayed.set(key, cell);
      assert.ok(Array.isArray(cell.blocked));
    }
    let cellsComplete = true;
    for (const row of result.outcomes) {
      const raw = summary.cells[row.app];
      assert.ok(Array.isArray(raw)); assert.deepEqual(raw.map((c) => c.case), cases.map((c) => c.key));
      const outcomes = [];
      for (const cell of raw) {
        const checked = replayed.get(`${row.app}/${cell.case}`);
        assert.ok(["not-run", "failed", "unsupported", "captured"].includes(cell.outcome));
        assert.equal(checked.outcome, cell.outcome);
        if (cell.outcome === "captured") {
          // Qualification flags alone and strict-export manifest integrity are not a gate.
          outcomes.push(cell.qualificationPassed && checked.derived && !checked.blocked.length ? "passed" : "not-run");
        } else outcomes.push(cell.outcome);
        if (checked.blocked.length || !checked.derived || cell.outcome === "not-run") cellsComplete = false;
      }
      row.outcome = aggregate(outcomes);
    }
    let sourceComplete = true;
    const bound = new Map(binding.sources.files.map((f) => [f.path, f]));
    // runnerFiles alone cannot prove the image/build/dependency closure.
    const runnerFiles = binding.sources.files.filter((f) => f.path.startsWith("bench/fullstack-browser/")
      && !f.path.slice("bench/fullstack-browser/".length).includes("/") && f.path.endsWith(".mjs"));
    assert.ok(object(summary.code.runnerFiles));
    for (const name of Object.keys(summary.code.runnerFiles)) {
      const file = bound.get(`bench/fullstack-browser/${name}`);
      assert.ok(file); assert.equal(summary.code.runnerFiles[name], file.sha256);
    }
    if (runnerFiles.some((f) => !Object.hasOwn(summary.code.runnerFiles, f.path.slice("bench/fullstack-browser/".length)))) {
      sourceComplete = false; block("runner-source-inventory-incomplete");
    }
    if (!native.sources) { sourceComplete = false; block("source-byte-closure-missing"); }
    else {
      assert.ok(Array.isArray(native.sources.files));
      const seen = new Set();
      for (const file of native.sources.files) {
        assert.ok(!seen.has(file.path)); seen.add(file.path);
        assert.ok(bound.has(file.path)); assert.equal(file.sha256, bound.get(file.path).sha256);
        if (file.mode !== undefined) assert.equal(file.mode, bound.get(file.path).mode);
      }
      for (const file of binding.sources.files.filter((f) => sourceRoots.some((r) => f.path === r || f.path.startsWith(`${r}/`)))) {
        if (!seen.has(file.path)) { sourceComplete = false; block("source-byte-closure-incomplete"); }
      }
    }
    assert.equal(typeof summary.complete, "boolean");
    assert.ok(Array.isArray(summary.failures) && Array.isArray(summary.cleanupFailures));
    if (native.blocked.length) block("native-proof-incomplete");
    if (!cellsComplete) block("native-cell-proof-incomplete");
    result.attemptComplete = sourceComplete && cellsComplete && summary.complete
      && native.blocked.length === 0;
    // Current contextClosed/empty cleanupFailures flags are not whole-run terminal receipts.
    if (native.cleanupComplete !== undefined) assert.equal(typeof native.cleanupComplete, "boolean");
    result.cleanupComplete = native.cleanupComplete === true && summary.cleanupFailures.length === 0;
    if (!result.cleanupComplete) block("native-terminal-receipts-missing");
    if (result.attemptComplete) {
      const failed = result.outcomes.some((r) => r.outcome === "failed") || summary.failures.length > 0;
      result.status = failed ? "failed" : result.cleanupComplete ? "verified" : "blocked";
    }
    block("actual-os-resource-inventory-missing");
    // Legacy diagnostics do not supply the v2 qualification/terminal contract.
    result.status = "blocked"; result.attemptComplete = false;
    block("native-v2-proof-required");
    return result;
  } catch (error) {
    if (error.code === "ENOENT") block("native-proof-missing");
    else { result.status = "invalid"; result.resources = "invalid"; block("saved-binding-or-proof-contradictory"); }
    result.attemptComplete = false; result.cleanupComplete = false;
    result.outcomes = apps.map((app) => ({ app, outcome: "not-run" }));
    delete result.hostSubject; result.comparisonEligibleApps = [];
    if (result.qualificationPassed !== undefined) { result.qualificationPassed = false; result.expectedExitCode = 1; }
    return result;
  }
}
