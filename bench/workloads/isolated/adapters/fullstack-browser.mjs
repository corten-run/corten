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

/**
 * Intrinsic replay only. No human approval, load eligibility or provider ownership is inferred.
 * Producer seams still required by the current native v1 validator:
 * - replayed canonical sources.files for its complete build/runner input closure;
 * - an empty native blocked list only after full attempt replay (not a manifest flag);
 * - cleanupComplete from positive browser/container/upstream/image/network terminal receipts;
 * - actual OS browser/server/upstream quotas, cpusets and PID/start identities.
 * resources remains independently blocked until that native resource contract is implemented.
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
    return result;
  } catch (error) {
    if (error.code === "ENOENT") block("native-proof-missing");
    else { result.status = "invalid"; result.resources = "invalid"; block("saved-binding-or-proof-contradictory"); }
    result.attemptComplete = false; result.cleanupComplete = false;
    return result;
  }
}
