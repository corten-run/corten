import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { upstreamEvidence } from "./capture.mjs";
import { loadPaths } from "./load-capture.mjs";

export function upstreamPhase(phase, cycle, capture, source) {
  return { phase, cycle, rows: capture.results.filter((r) => r.request.source === source)
    .map((r) => ({ requestId: r.request.id, upstream: r.upstream })) };
}

export function upstreamManifest(plan, source, startup, phases) {
  assert.ok(startup?.id === "startup", "actual startup observation missing");
  const selected = loadPaths(plan, source), expected = [{ id: "startup", path: startup.path, mode: startup.mode,
    requests: startup.requests, cancelled: startup.cancelled, receipt: upstreamEvidence(startup) }];
  for (const { phase, cycle, rows } of phases) {
    assert.ok(["warmup", "cycle"].includes(phase) && Number.isSafeInteger(cycle) && cycle >= 0);
    assert.deepEqual(rows.map((r) => r.requestId).sort(), selected.map((r) => r.id).sort(), "upstream phase inventory differs");
    for (const request of selected) {
      const prefix = `${phase}_${cycle}_`, path = `/marketplace/records/${request.itemId}`;
      expected.push({ id: `${prefix}prep_${request.id}`, path, mode: "normal",
        requests: source === "api" && request.method === "POST" ? 1 : 0, cancelled: 0 });
      expected.push({ id: `${prefix}${request.id}`, path, mode: request.category === "slow" ? request.variant : "normal",
        requests: source === "api" ? 1 : 0, cancelled: source === "api" && request.category === "slow" && ["cancel", "deadline"].includes(request.variant) ? 1 : 0,
        receipt: rows.find((r) => r.requestId === request.id).upstream });
      if (request.method === "POST") expected.push({ id: `${prefix}state_${request.id}`, path, mode: "normal", requests: 0, cancelled: 0 });
    }
  }
  assert.equal(new Set(expected.map((r) => r.id)).size, expected.length, "duplicate upstream phase identity");
  return expected;
}

// Compare final live facts with every planned operation and its saved primary
// observation. Never repair a capture by copying newer counters into its rows.
export function reconcileLedger(ledger, manifest) {
  const issues = [], cells = [], byId = new Map();
  if (ledger?.schema !== "mixed-native-upstream-ledger/v1" || !ledger.sealed
    || !Number.isSafeInteger(ledger.sealedUnixMs) || !Number.isSafeInteger(ledger.snapshotUnixMs)
    || ledger.snapshotUnixMs < ledger.sealedUnixMs) issues.push("missing-final-sealed-upstream-ledger");
  if (!Array.isArray(ledger?.orphans) || ledger.orphans.length) issues.push("late-or-unattributed-upstream-work");
  for (const op of ledger?.operations ?? []) {
    if (byId.has(op.id)) issues.push(`duplicate-operation:${op.id}`);
    byId.set(op.id, op);
  }
  for (const expected of manifest) {
    const op = byId.get(expected.id), failed = [];
    if (!op) failed.push("missing-operation");
    else {
      if (op.path !== expected.path || op.mode !== expected.mode) failed.push("operation-binding-changed");
      if (![op.requests, op.completed, op.cancelled, op.pending].every((n) => Number.isSafeInteger(n) && n >= 0)
        || op.pending !== 0 || op.completed + op.cancelled !== op.requests) failed.push("pending-or-unaccounted-work");
      if (op.requests !== expected.requests || op.cancelled !== expected.cancelled
        || op.completed !== expected.requests - expected.cancelled) failed.push("one-read-or-cancellation-contract-changed");
      const events = op.events;
      if (!Array.isArray(events) || events.length !== op.requests
        || events.some((e) => e.method !== "GET" || e.path !== expected.path || !["completed", "cancelled"].includes(e.result))
        || events.filter((e) => e.result === "completed").length !== op.completed
        || events.filter((e) => e.result === "cancelled").length !== op.cancelled) failed.push("invalid-final-events");
      if (Object.hasOwn(expected, "receipt") && (!expected.receipt || !Array.isArray(events)
        || !isDeepStrictEqual(upstreamEvidence(op), expected.receipt))) failed.push("saved-observation-drifted");
    }
    cells.push({ id: expected.id, passed: failed.length === 0, issues: failed });
    byId.delete(expected.id);
  }
  for (const id of byId.keys()) issues.push(`unexpected-operation:${id}`);
  return { schema: "mixed-native-upstream-reconciliation/v1", valid: !issues.length && cells.every((r) => r.passed), issues, cells };
}
