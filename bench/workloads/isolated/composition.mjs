import assert from "node:assert/strict";
import { latestStableSchema, candidateLatestStableSchema, unsupportedSolidReason } from "../latest-stable.mjs";
import { selectedApps } from "../registry.mjs";
import { comparisonProfile } from "../../client-heavy/contract.mjs";

export const commandResult = (record) => Object.fromEntries(["terminal", "code", "signal", "cancelled", "forced", "error", "success"].map((key) => [key, record[key]]));

/** Apparatus completion is independent of which framework passed its functional gates. */
export function composePhase(binding, native, host, commands, timingAudit = true, deniedPreLoginProbes = 0) {
  const expected = binding.preparation.fixtures.length + 1, last = commands.at(-1);
  const browser = binding.request.group === "fullstack-browser";
  const hardening = binding.request.group === "hardening";
  const browserExit = typeof native.qualificationPassed === "boolean"
    && native.expectedExitCode === (native.qualificationPassed ? 0 : 1)
    && (!native.qualificationPassed || native.status === "verified" && native.outcomes.every((r) => r.outcome === "passed"))
    ? native.expectedExitCode : null;
  // Hardening exits zero when the apparatus completes, even if a replayed app failed.
  // Its current adapter reports dispositions but does not authorize any ranking.
  const hardeningExit = hardening && native.resources === "verified"
    && Array.isArray(native.blockers) && native.blockers.length === 0
    && Array.isArray(native.comparisonEligibleApps) && native.comparisonEligibleApps.length === 0
    && native.outcomes.every((r) => ["passed", "failed", "unsupported"].includes(r.outcome))
    && native.status === (native.outcomes.some((r) => r.outcome === "failed") ? "failed" : "verified")
    ? 0 : null;
  const nativeCode = browser ? browserExit : hardening ? hardeningExit : binding.request.group === "localized-marketplace" ? 0
    : native.status === "failed" ? 1 : binding.request.group === "client-heavy" ? 2 : 0;
  const lifecycle = commands.length === expected && commands.slice(0, -1).every((r) => r.success)
    && commands.every((r) => r.terminal && !r.cancelled && !r.forced && r.error === null)
    && (!hardening || commands.every((r) => r.code === 0 && r.signal === null && r.success === true))
    && Number.isInteger(nativeCode) && last.code === nativeCode;
  const complete = native.attemptComplete && native.cleanupComplete && host.cleanupComplete
    && native.resources !== "invalid" && host.resources !== "invalid"
    && (native.resources === "verified" || host.resources === "verified")
    && ["verified", "failed"].includes(native.status) && lifecycle && timingAudit;
  assert.deepEqual(native.outcomes.map((r) => r.app), binding.selection.apps);
  const policy = binding.latestStable;
  const legacyPolicyAllowsComparison = policy?.schema === latestStableSchema && policy.group === binding.request.group && policy.valid === true
    && policy.status === "not-applicable" && policy.groupComparisonEligible === null;
  const client = binding.request.group === "client-heavy";
  const candidatePolicy = client && policy?.schema === candidateLatestStableSchema && policy.group === "client-heavy" && policy.valid === true
    && policy.status === "blocked" && policy.groupComparisonEligible === false && Array.isArray(policy.candidates)
    && JSON.stringify(policy.candidates.map((row) => row.app)) === JSON.stringify(selectedApps("client-heavy"))
    && JSON.stringify(binding.selection.apps) === JSON.stringify(selectedApps("client-heavy"));
  if (candidatePolicy) for (const row of policy.candidates.filter((row) => row.status === "unsupported")) {
    assert.ok(row.app === "solid" && row.reason === unsupportedSolidReason && row.latestStableEligible === false && row.measurements === null,
      "unreviewed unsupported client disposition");
    const observed = native.outcomes.find((r) => r.app === row.app);
    assert.ok(observed.outcome !== "passed" && observed.measurement == null && observed.measurements == null,
      "unsupported client cannot carry measured success");
  }
  const policyAllowsComparison = (app) => client ? candidatePolicy
    && policy.candidates.some((row) => row.app === app && row.status === "satisfied" && row.latestStableEligible === true && row.blockers?.length === 0)
    : legacyPolicyAllowsComparison;
  const nativeAllowsComparison = (app) => hardening ? false
    : client ? binding.request.recipe === comparisonProfile && host.resources === "verified"
      && native.rankingEligible === true && Array.isArray(native.comparisonEligibleApps)
      && native.comparisonEligibleApps.includes(app) && Object.hasOwn(native.comparisons ?? {}, app)
    : !["mixed-production", "catalog-page", "json-api"].includes(binding.request.group)
    || (Array.isArray(native.comparisonEligibleApps) && native.comparisonEligibleApps.includes(app));
  const browserAllowsComparison = (app) => !browser || native.qualificationPassed === true && native.expectedExitCode === 0
    && Array.isArray(native.comparisonEligibleApps) && native.comparisonEligibleApps.includes(app);
  const timingBlockedByPreLoginProbes = complete && deniedPreLoginProbes > 0;
  return { outcome: timingBlockedByPreLoginProbes ? "blocked"
    : complete ? "native-validated" : native.status === "failed" || commands.some((r) => !r.success) ? "failed" : "blocked",
    nativeStatus: native.status,
    appOutcomes: native.outcomes.map((r) => {
      const comparisonEligible = complete && !timingBlockedByPreLoginProbes && policyAllowsComparison(r.app) && r.outcome === "passed"
        && nativeAllowsComparison(r.app) && browserAllowsComparison(r.app);
      return { ...r, comparisonEligible, ...(client && comparisonEligible ? { comparison: native.comparisons[r.app] } : {}) };
    }),
    report: { qualification: complete && !timingBlockedByPreLoginProbes ? "native-replay-passed" : "blocked", latestStable: policy ?? null,
      ...(timingBlockedByPreLoginProbes ? { timingBlockedByPreLoginProbes: true } : {}) } };
}
