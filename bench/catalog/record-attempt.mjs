// A narrow failed functional attempt: every started request has a retained response.
// Network errors, cancellation and later browser assertions are not target evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const recordAttemptSchema = "record-json-attempt/v1";
const hash = (records) => createHash("sha256").update(JSON.stringify(records)).digest("hex");
export function recordViolation(response, expected) {
  if (response.status !== 200) return "status";
  if (response.type?.split(";")[0].trim().toLowerCase() !== "application/json") return "content-type";
  let actual;
  try { actual = JSON.parse(response.body); } catch { return "json"; }
  return isDeepStrictEqual(actual, expected) ? null : "record";
}

export function recordAttempt(records, path) {
  const requests = [];
  let order = 0;
  return {
    start(id) {
      const row = { index: requests.length, id, path: `${path}/${encodeURIComponent(id)}`, startedAt: Date.now(), startedOrder: order++ };
      requests.push(row); return row;
    },
    finish(row, response) { Object.assign(row, { finishedAt: Date.now(), finishedOrder: order++, response }); },
    snapshot() { return { schema: recordAttemptSchema, recordsSha256: hash(records), requests }; },
  };
}

export function verifyRecordAttempt(attempt, records, path) {
  assert.equal(attempt?.schema, recordAttemptSchema, "missing record attempt version");
  assert.equal(attempt.recordsSha256, hash(records), "record attempt fixture differs");
  const ids = Object.keys(records), requests = attempt.requests;
  const initial = Math.min(8, ids.length);
  assert.ok(Array.isArray(requests) && requests.length >= initial && requests.length <= ids.length, "missing request prefix");
  let firstViolation = Infinity, failed = 0;
  const boundaries = [];
  for (const [index, row] of requests.entries()) {
    assert.equal(row.index, index); assert.equal(row.id, ids[index], "non-prefix request intent");
    assert.equal(row.path, `${path}/${encodeURIComponent(row.id)}`);
    assert.ok(Number.isSafeInteger(row.startedAt) && Number.isSafeInteger(row.finishedAt)
      && row.finishedAt >= row.startedAt, "missing/invalid request boundary");
    if (index) assert.ok(row.startedAt >= requests[index - 1].startedAt, "request intents out of order");
    assert.ok(Number.isSafeInteger(row.startedOrder) && Number.isSafeInteger(row.finishedOrder) && row.finishedOrder > row.startedOrder);
    if (index) assert.ok(row.startedOrder > requests[index - 1].startedOrder);
    const response = row.response;
    assert.ok(response && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      && (response.type === null || typeof response.type === "string") && typeof response.body === "string", "missing response bytes");
    const violation = !!recordViolation(response, records[row.id]);
    boundaries.push({ order: row.startedOrder, time: row.startedAt, delta: 1 },
      { order: row.finishedOrder, time: row.finishedAt, delta: -1, violation });
    if (violation) { failed++; firstViolation = Math.min(firstViolation, row.finishedOrder); }
  }
  assert.ok(failed > 0, "no observed target violation");
  let active = 0;
  boundaries.sort((a, b) => a.order - b.order);
  for (const [index, boundary] of boundaries.entries()) {
    assert.equal(boundary.order, index, "missing/duplicate request boundary");
    if (index) assert.ok(boundary.time >= boundaries[index - 1].time, "request clock moved backwards");
    active += boundary.delta;
    assert.ok(active >= 0 && active <= 8, "sweep concurrency differs");
    if (index < initial) assert.equal(boundary.delta, 1, "initial parallel request batch incomplete");
    else if (boundary.delta === 1) assert.ok(boundaries[index - 1].delta === -1 && !boundaries[index - 1].violation, "request did not follow a successful worker response");
  }
  for (const row of requests) assert.ok(row.startedOrder < firstViolation, "request started after the failed sweep stopped");
  return { outcome: "failed", failed, requests: requests.length };
}

export function verifyCheckerExit(exit) {
  assert.deepEqual(exit, { code: 1, signal: null, expired: false, interrupted: false }, "checker did not exit normally with an observed functional violation");
}

export function verifyAttemptWindow(attempt, clock) {
  assert.ok(Number.isSafeInteger(clock?.startedAt) && Number.isSafeInteger(clock?.finishedAt) && clock.finishedAt >= clock.startedAt, "checker clock missing");
  for (const row of attempt.requests) assert.ok(row.startedAt >= clock.startedAt && row.finishedAt <= clock.finishedAt, "request outside checker lifetime");
}
