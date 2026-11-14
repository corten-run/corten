import assert from "node:assert/strict";
import { test } from "node:test";
import { composePhase } from "./composition.mjs";
import { latestStableSchema } from "../latest-stable.mjs";
const policy = (group, status = "not-applicable") => ({ schema: latestStableSchema, group, valid: true, status, groupComparisonEligible: status === "not-applicable" ? null : false });
const binding = { request: { group: "live-delivery" }, latestStable: policy("live-delivery"), preparation: { fixtures: [] }, selection: { apps: ["a", "b", "c"] } };
const native = { status: "failed", attemptComplete: true, cleanupComplete: true, resources: "verified",
  outcomes: [{ app: "a", outcome: "passed" }, { app: "b", outcome: "failed" }, { app: "c", outcome: "unsupported" }] };
const command = { terminal: true, code: 1, error: null, cancelled: false, forced: false, success: false };
test("complete observed failures stay selected; apparatus completion is not a successful baseline", () => {
  const result = composePhase(binding, native, { cleanupComplete: true, resources: "verified" }, [command]);
  assert.equal(result.outcome, "native-validated"); assert.deepEqual(result.appOutcomes.map((r) => r.comparisonEligible), [true, false, false]);
});

test("browser intrinsic unsupported attempts use only the replayed qualification exit and never gain comparison eligibility", () => {
  const b = { ...binding, request: { group: "fullstack-browser" }, latestStable: policy("fullstack-browser") };
  const n = { ...native, status: "verified", qualificationPassed: false, expectedExitCode: 1, comparisonEligibleApps: [],
    outcomes: native.outcomes.map((row) => ({ ...row, outcome: row.outcome === "failed" ? "unsupported" : row.outcome })) };
  const host = { cleanupComplete: true, resources: "verified" };
  const value = composePhase(b, n, host, [command]);
  assert.equal(value.outcome, "native-validated"); assert.equal(value.nativeStatus, "verified");
  assert.deepEqual(value.appOutcomes.map(({ comparisonEligible, ...row }) => row), n.outcomes);
  assert.ok(value.appOutcomes.every((row) => !row.comparisonEligible));
  for (const code of [0, 2, 137, null]) assert.notEqual(composePhase(b, n, host, [{ ...command, code }]).outcome, "native-validated");
  for (const expectedExitCode of [undefined, null, "1", 2, 137, 0])
    assert.notEqual(composePhase(b, { ...n, expectedExitCode }, host, [command]).outcome, "native-validated");
});

test("mixed complete failures retain healthy functional apps without inventing their gated timing", () => {
  const b = { ...binding, request: { group: "mixed-production" }, latestStable: policy("mixed-production") };
  for (const comparisonEligibleApps of [undefined, null, "a", { 0: "a" }, [], ["unselected"]]) {
    const result = composePhase(b, { ...native, comparisonEligibleApps }, { cleanupComplete: true, resources: "verified" }, [command]);
    assert.equal(result.outcome, "native-validated");
    assert.deepEqual(result.appOutcomes.map(({ comparisonEligible, ...row }) => row), native.outcomes);
    assert.ok(result.appOutcomes.every((row) => !row.comparisonEligible));
  }
});

test("mixed comparisons require replayed timing eligibility as well as existing policy and apparatus gates", () => {
  const b = { ...binding, request: { group: "mixed-production" }, latestStable: policy("mixed-production") };
  const n = { ...native, status: "verified", outcomes: native.outcomes.map((row) => ({ ...row, outcome: "passed" })), comparisonEligibleApps: ["a", "c"] };
  const host = { cleanupComplete: true, resources: "verified" }, commands = [{ ...command, code: 0, success: true }];
  const result = composePhase(b, n, host, commands);
  assert.equal(result.outcome, "native-validated");
  assert.deepEqual(result.appOutcomes.map((row) => row.comparisonEligible), [true, false, true]);
  for (const [input, observation, audit] of [
    [{ ...b, latestStable: policy("mixed-production", "blocked") }, host, true],
    [b, { ...host, cleanupComplete: false }, true],
    [b, host, false],
  ]) assert.ok(composePhase(input, n, observation, commands, audit).appOutcomes.every((row) => !row.comparisonEligible));
  const failed = composePhase(b, { ...native, comparisonEligibleApps: binding.selection.apps }, host, [command]);
  assert.deepEqual(failed.appOutcomes.map((row) => row.comparisonEligible), [true, false, false]);
});
test("native flags, partial commands, missing OS proof, abort or invalid audit cannot promote a failed process", () => {
  for (const [n, h, c, audit] of [
    [{ ...native, status: "blocked" }, { cleanupComplete: true, resources: "verified" }, [command], true],
    [native, { cleanupComplete: false, resources: "verified" }, [command], true],
    [{ ...native, resources: "blocked" }, { cleanupComplete: true, resources: "blocked" }, [command], true],
    [{ ...native, resources: "invalid" }, { cleanupComplete: true, resources: "verified" }, [command], true],
    [native, { cleanupComplete: true, resources: "verified" }, [{ ...command, cancelled: true }], true],
    [native, { cleanupComplete: true, resources: "verified" }, [{ ...command, code: 99 }], true],
    [native, { cleanupComplete: true, resources: "verified" }, [command], false],
  ]) assert.notEqual(composePhase(binding, n, h, c, audit).outcome, "native-validated");
});
test("client's real diagnostic exit two is not fabricated failure or exit zero", () => {
  const b = { ...binding, request: { group: "client-heavy" }, latestStable: policy("client-heavy", "blocked") }, n = { ...native, status: "verified", outcomes: native.outcomes.map((r) => ({ ...r, outcome: "passed" })) };
  assert.equal(composePhase(b, n, { cleanupComplete: true, resources: "verified" }, [{ ...command, code: 2 }]).outcome, "native-validated");
  assert.notEqual(composePhase(b, n, { cleanupComplete: true, resources: "verified" }, [{ ...command, code: 0, success: true }]).outcome, "native-validated");
});

test("latest-stable blockers preserve complete native outcomes but never qualify comparisons", () => {
  const b = { ...binding, request: { group: "client-heavy" }, latestStable: policy("client-heavy", "blocked") };
  const result = composePhase(b, native, { cleanupComplete: true, resources: "verified" }, [command]);
  assert.equal(result.outcome, "native-validated");
  assert.deepEqual(result.appOutcomes.map(({ comparisonEligible, ...row }) => row), native.outcomes);
  assert.ok(result.appOutcomes.every((row) => !row.comparisonEligible));
  assert.deepEqual(result.report.latestStable, b.latestStable);
  for (const latestStable of [undefined, null, { ...binding.latestStable, valid: false },
    { ...binding.latestStable, group: "json-api" }, { ...binding.latestStable, groupComparisonEligible: true },
    { ...binding.latestStable, schema: "untrusted" }, { ...binding.latestStable, status: "blocked" }]) {
    const invalid = composePhase({ ...binding, latestStable }, native, { cleanupComplete: true, resources: "verified" }, [command]);
    assert.ok(invalid.appOutcomes.every((row) => !row.comparisonEligible));
  }
});
