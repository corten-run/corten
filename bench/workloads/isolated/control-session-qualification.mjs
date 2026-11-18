// A source-bound first-host qualification contract, not a receipt-based launch policy.
import assert from "node:assert/strict";
import { validateState } from "../cloud-contract.mjs";
import { verifyControlDrainBoundary } from "../cloud-control-session.mjs";

export function controlSessionPreflight(state, purpose = "bootstrap") {
  validateState(state, state.round);
  assert.ok(["bootstrap", "audit"].includes(purpose), "unknown control preflight boundary");
  if (purpose === "audit")
    assert.ok(state.group === undefined || ["json-api", "mixed-production"].includes(state.group), "group has no audit delivery boundary");
  return { schema: "benchmark-control-session-preflight/v1", round: state.round, commit: state.commit,
    token: state.token, unit: state.unit, group: state.group ?? "all", purpose,
    required: ["ssh", "sftp"].map((channel) => ({ purpose, channel })),
    qualification: "pending-native-proof", authority: "none" };
}

// The transport's complete expected ledger is a trusted argument, never derived from
// whatever receipts happen to be present. Missing real SSH/SFTP evidence stays blocked.
export function replayControlSessionPreflight(state, boundary, purpose = "bootstrap") {
  const plan = controlSessionPreflight(state, purpose);
  assert.ok(Array.isArray(boundary.invocations) && boundary.invocations.length <= 64, "bounded expected transport ledger required");
  for (const invocation of boundary.invocations) {
    for (const field of ["round", "commit", "token"]) assert.equal(invocation[field], plan[field], "preflight source/ownership differs");
  }
  for (const required of plan.required)
    assert.ok(boundary.invocations.some((v) => v.channel === required.channel && v.purpose === required.purpose), "native SSH/SFTP path qualification missing");
  const proof = verifyControlDrainBoundary(boundary);
  return { ...plan, replay: proof, qualification: "pending-native-proof" };
}
