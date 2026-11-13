import assert from "node:assert/strict";
import { latestStableSchema } from "../latest-stable.mjs";

export const commandResult = (record) => Object.fromEntries(["terminal", "code", "signal", "cancelled", "forced", "error", "success"].map((key) => [key, record[key]]));

/** Apparatus completion is independent of which framework passed its functional gates. */
export function composePhase(binding, native, host, commands, timingAudit = true) {
  const expected = binding.preparation.fixtures.length + 1, last = commands.at(-1);
  const nativeCode = binding.request.group === "localized-marketplace" ? 0
    : native.status === "failed" ? 1 : binding.request.group === "client-heavy" ? 2 : 0;
  const lifecycle = commands.length === expected && commands.slice(0, -1).every((r) => r.success)
    && commands.every((r) => r.terminal && !r.cancelled && !r.forced && r.error === null) && last.code === nativeCode;
  const complete = native.attemptComplete && native.cleanupComplete && host.cleanupComplete
    && native.resources !== "invalid" && host.resources !== "invalid"
    && (native.resources === "verified" || host.resources === "verified")
    && ["verified", "failed"].includes(native.status) && lifecycle && timingAudit;
  assert.deepEqual(native.outcomes.map((r) => r.app), binding.selection.apps);
  const policy = binding.latestStable;
  const policyAllowsComparison = policy?.schema === latestStableSchema && policy.group === binding.request.group && policy.valid === true
    && policy.status === "not-applicable" && policy.groupComparisonEligible === null;
  return { outcome: complete ? "native-validated" : native.status === "failed" || commands.some((r) => !r.success) ? "failed" : "blocked",
    nativeStatus: native.status,
    appOutcomes: native.outcomes.map((r) => ({ ...r, comparisonEligible: complete && policyAllowsComparison && r.outcome === "passed" })),
    report: { qualification: complete ? "native-replay-passed" : "blocked", latestStable: policy ?? null } };
}
