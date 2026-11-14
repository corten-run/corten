import assert from "node:assert/strict";
import { join } from "node:path";
import { groupNames } from "../registry.mjs";
import { inspectEvidence, readRegular, tree } from "./evidence.mjs";
import { admitted } from "../../marketplace/feature-contract.mjs";

// Fixed code imports only. Saved evidence cannot select a module or a validator.
const adapters = Object.freeze({
  "mixed-production": () => import("./adapters/mixed-production.mjs"),
  "fullstack-browser": () => import("./adapters/fullstack-browser.mjs"),
  "client-heavy": () => import("./adapters/client-heavy.mjs"),
  "live-delivery": () => import("./adapters/live-delivery.mjs"),
  "recoverable-live": () => import("./adapters/recoverable-live.mjs"),
  hardening: () => import("./adapters/hardening.mjs"),
});
export const executionGroups = Object.freeze([...groupNames]);
const states = ["verified", "failed", "blocked", "invalid"];
function httpAttempt(binding, report) {
  assert.equal(report.attemptComplete, true, "native HTTP attempt incomplete");
  assert.deepEqual(report.outcomes.map((r) => r.app), binding.selection.apps);
  assert.ok(report.outcomes.every((r) => ["passed", "failed"].includes(r.outcome)));
  return { status: report.outcomes.some((r) => r.outcome === "failed") ? "failed" : "verified",
    attemptComplete: true, cleanupComplete: true, resources: "verified", outcomes: report.outcomes,
    comparisonEligibleApps: report.comparisonEligibleApps, blockers: ["external-os-proof-required"] };
}
function missing(binding) {
  return { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
    outcomes: binding.selection.apps.map((app) => ({ app, outcome: "not-run" })), blockers: ["fixed-native-replay-not-available"] };
}
export function validateNativeResult(binding, result) {
  assert.ok(result && states.includes(result.status));
  for (const key of ["attemptComplete", "cleanupComplete"]) assert.equal(typeof result[key], "boolean");
  assert.ok(["verified", "blocked", "invalid"].includes(result.resources));
  assert.ok(Array.isArray(result.blockers) && result.blockers.every((b) => typeof b === "string"));
  assert.deepEqual(result.outcomes.map((r) => r.app), binding.selection.apps);
  for (const row of result.outcomes) {
    assert.deepEqual(Object.keys(row).sort(), ["app", "outcome"]);
    assert.ok(["passed", "failed", "unsupported", "not-run"].includes(row.outcome));
  }
  if (["verified", "failed"].includes(result.status)) {
    assert.equal(result.attemptComplete, true);
    assert.notEqual(result.resources, "invalid");
    assert.ok(result.outcomes.every((r) => r.outcome !== "not-run"));
  }
  if (result.status === "verified") assert.ok(result.outcomes.every((r) => ["passed", "unsupported"].includes(r.outcome)));
  if (binding.request.group === "fullstack-browser" && result.attemptComplete) {
    assert.equal(typeof result.qualificationPassed, "boolean");
    assert.ok([0, 1].includes(result.expectedExitCode));
    assert.equal(result.expectedExitCode, result.qualificationPassed ? 0 : 1);
    if (result.qualificationPassed) {
      assert.equal(result.status, "verified"); assert.ok(result.outcomes.every((r) => r.outcome === "passed"));
    }
  }
  if (result.comparisonEligibleApps !== undefined) {
    assert.ok(Array.isArray(result.comparisonEligibleApps));
    assert.equal(new Set(result.comparisonEligibleApps).size, result.comparisonEligibleApps.length);
    assert.ok(result.comparisonEligibleApps.every((app) => result.outcomes.some((r) => r.app === app && r.outcome === "passed")));
  }
  return result;
}

/** Read-only, awaitable, intrinsic native replay. OS proof is composed separately. */
export async function inspectNative(binding, folder) {
  const before = tree(folder), { group, round, commit } = binding.request;
  assert.ok(executionGroups.includes(group));
  let result;
  try {
    if (adapters[group]) {
      result = await (await adapters[group]()).inspectSaved(binding, folder);
      if (group === "client-heavy" && result.attemptComplete) {
        const native = await (await import("../../client-heavy/verify.mjs")).validateSaved({ folder, round, commit });
        assert.equal(native.schema, "client-heavy-saved-verification/v2");
        result = { ...result, hostSubject: { executionWindow: native.executionWindow, processWindows: native.processWindows,
          toolIdentities: native.toolIdentities, subjectSha256: native.subjectSha256, filesSha256: tree(folder).sha256 } };
      }
    }
    else if (group === "json-api") {
      const report = inspectEvidence(binding, folder);
      result = httpAttempt(binding, report);
    } else {
      const api = group === "catalog-page" ? await import("../../catalog/verify.mjs") : await import("../../marketplace/validate.mjs");
      const saved = await api.validateSaved({ folder, round, commit });
      // Bind actual effective invocation even if the saved API accepts only identity.
      const summary = JSON.parse(readRegular(join(folder, "summary.json")));
      assert.equal(summary.round, round); assert.equal(summary.commit, commit);
      assert.deepEqual(summary.options, binding.execution.effectiveOptions);
      assert.deepEqual(summary.measurement?.cpus, binding.resources.expectedCpus);
      result = missing(binding); result.blockers = ["native-replay-incomplete"];
      if (group === "localized-marketplace") {
        // This fixed native API returns its fully replayed summary, not a status
        // envelope. It includes observed excluded/stopped targets, not just winners.
        assert.deepEqual(saved, summary); assert.equal(saved.complete, true);
        assert.deepEqual(Object.keys(saved.apps).sort(), [...binding.selection.apps].sort());
        const outcomes = binding.selection.apps.map((app) => ({ app,
          outcome: !admitted(saved.apps[app]) || Object.values(saved.apps[app].runs).flat().some((r) => r.stopped) ? "failed" : "passed" }));
        result = { status: outcomes.some((r) => r.outcome === "failed") ? "failed" : "verified", attemptComplete: true,
          cleanupComplete: true, resources: "verified", outcomes, blockers: [] };
      } else if (saved.status === "invalid") { result.status = "invalid"; result.resources = "invalid"; }
      else if (saved.status === "verified" && saved.complete === true) {
        if (group === "catalog-page") {
          result = httpAttempt(binding, saved.report);
        }
      }
    }
  } catch (error) {
    result = missing(binding);
    if (!["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ENOENT"].includes(error.code)) {
      result.status = "invalid"; result.resources = "invalid"; result.blockers = ["native-replay-invalid-or-contradictory"];
    }
  }
  try {
    assert.deepEqual(tree(folder), before);
    validateNativeResult(binding, result);
  } catch { throw new Error("native-evidence-mutated-or-invalid"); }
  // Raw native diagnostics are archive-controlled. Never forward their strings.
  return { ...result, blockers: result.blockers.length ? ["native-proof-or-external-observation-required"] : [] };
}
