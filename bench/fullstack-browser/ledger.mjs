import assert from "node:assert/strict";

// Recompute from raw rows, never from an earlier positive qualification flag.
export function reconcileRequests(evidence) {
  const result = { outcome: "unknown", reasons: [], assignments: [] };
  try {
    assert.ok(Array.isArray(evidence.requestLedger), "Final native request ledger unavailable");
    const final = new Map();
    for (const row of evidence.requestLedger) {
      assert.ok(typeof row?.id === "string" && row.id && !final.has(row.id), "Missing/duplicate final request ID");
      assert.ok(row.completed === true && !row.failure && !row.captureError && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599, `Failed/unfinished final request ${row.id}`);
      final.set(row.id, row);
    }
    const assigned = new Set();
    const include = (rows, phase) => {
      assert.ok(Array.isArray(rows), `Native request ledger unavailable for ${phase}`);
      for (const row of rows) {
        assert.ok(row?.id && final.has(row.id) && !assigned.has(row.id), `Unmatched/duplicate assigned request ${row?.id}`);
        // This classification is local to the step snapshot, not an outcome waiver.
        const { intentionallyDisabledPreload, ...native } = row;
        const { intentionallyDisabledPreload: finalClassification, ...terminal } = final.get(row.id);
        assert.deepEqual(native, terminal, `Stale request outcome/evidence ${row.id}`);
        assigned.add(row.id); result.assignments.push({ request: row.id, phase });
      }
    };
    assert.ok(Array.isArray(evidence.steps), "Native step request assignments unavailable");
    for (const row of evidence.steps) include(row.requests, row.action.id);
    include(evidence.nativeCleanup?.requests, "cleanup-navigation");
    include(evidence.nativeCleanup?.probe?.requests, "retired-event-probe");
    for (const id of final.keys()) assert.ok(assigned.has(id), `Unassigned final native request ${id}`);
    assert.deepEqual(evidence.networkFailures, [], "Final network observer errors remain or were not retained");
    assert.deepEqual(evidence.runtimeErrors, [], "Final browser errors remain or were not retained");
    result.outcome = "reconciled";
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
