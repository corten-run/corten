import assert from "node:assert/strict";
import { test } from "node:test";
import { composePhase } from "./composition.mjs";
const binding = { request: { group: "live-delivery" }, preparation: { fixtures: [] }, selection: { apps: ["a", "b", "c"] } };
const native = { status: "failed", attemptComplete: true, cleanupComplete: true, resources: "verified",
  outcomes: [{ app: "a", outcome: "passed" }, { app: "b", outcome: "failed" }, { app: "c", outcome: "unsupported" }] };
const command = { terminal: true, code: 1, error: null, cancelled: false, forced: false, success: false };
test("complete observed failures stay selected; apparatus completion is not a successful baseline", () => {
  const result = composePhase(binding, native, { cleanupComplete: true, resources: "verified" }, [command]);
  assert.equal(result.outcome, "native-validated"); assert.deepEqual(result.appOutcomes.map((r) => r.comparisonEligible), [true, false, false]);
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
  const b = { ...binding, request: { group: "client-heavy" } }, n = { ...native, status: "verified", outcomes: native.outcomes.map((r) => ({ ...r, outcome: "passed" })) };
  assert.equal(composePhase(b, n, { cleanupComplete: true, resources: "verified" }, [{ ...command, code: 2 }]).outcome, "native-validated");
  assert.notEqual(composePhase(b, n, { cleanupComplete: true, resources: "verified" }, [{ ...command, code: 0, success: true }]).outcome, "native-validated");
});
