// Semantic replay of real client receipts, not qualification fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const finite = (n) => Number.isFinite(n) && n >= 0;
const localErrors = new Set(["EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);

export function responseOk(row, expected, body) {
  if (row.status !== 200 || row.bodyComplete !== true || row.error || row.timedOut) return false;
  if (row.path.startsWith("/api/")) {
    try { return isDeepStrictEqual(JSON.parse(body), expected); } catch { return false; }
  }
  return body.includes("marketplace__listings") && body.includes(expected.title) && body.includes("marketplace__offers");
}

export function validateLegitimate(row, expected) {
  assert.ok(typeof row.bodyBase64 === "string", "legacy receipt has no replayable response bytes; it cannot establish current semantic qualification");
  assert.equal(typeof row.ok, "boolean"); assert.equal(typeof row.bodyComplete, "boolean");
  const body = Buffer.from(row.bodyBase64, "base64");
  assert.equal(body.toString("base64"), row.bodyBase64); assert.equal(body.length, row.bodyBytes);
  assert.equal(hash(body), row.bodySha256, "response hash differs from raw bytes");
  assert.ok(row.status === undefined || Number.isInteger(row.status) && row.status >= 100 && row.status <= 599);
  assert.ok(row.error === undefined || typeof row.error === "string" && row.error.length > 0);
  assert.ok(row.timedOut === undefined || row.timedOut === true);
  assert.ok(finite(row.startedAtMs) && finite(row.endedAtMs) && row.endedAtMs >= row.startedAtMs);
  assert.equal(row.latencyMs, row.endedAtMs - row.startedAtMs);
  assert.equal(row.ok, responseOk(row, expected, body), "success contradicts HTTP status, completion, error, timeout or response semantics");
  assert.ok(!localErrors.has(row.error), "local legitimate-client failure invalidates apparatus");
  return row;
}

export function validateAttack(row, plan, budget) {
  assert.ok(plan, "missing exact native emission plan");
  assert.match(plan.firstSha256, /^[a-f0-9]{64}$/); assert.ok(count(plan.firstBytes));
  assert.ok(finite(row.startedAtMs) && finite(row.endedAtMs) && row.endedAtMs >= row.startedAtMs);
  assert.ok(typeof row.responsePrefix === "string" && row.responsePrefix.length <= 512);
  assert.ok(row.error === undefined || typeof row.error === "string" && row.error.length > 0);
  assert.equal(row.variant, plan.variant); assert.equal(row.firstBytes, plan.firstBytes); assert.equal(row.firstSha256, plan.firstSha256);
  for (const key of ["bytesQueued", "writes", "drips", "backpressure"]) assert.ok(count(row[key]), `invalid emitted ${key}`);
  assert.ok(row.backpressure <= row.writes);
  assert.equal(typeof row.established, "boolean");
  assert.ok(!localErrors.has(row.error), "local attack-client failure invalidates apparatus");
  assert.equal([row.targetClosedAtMs, row.releasedAtMs].filter((n) => n !== null).length, 1, "missing/contradictory attack terminal receipt");
  const terminal = row.targetClosedAtMs ?? row.releasedAtMs;
  assert.ok(finite(terminal) && terminal >= row.startedAtMs && terminal <= row.endedAtMs);
  if (!row.established) {
    assert.equal(row.bytesQueued, 0); assert.equal(row.writes, 0); assert.equal(row.drips, 0);
    assert.ok(row.targetClosedAtMs !== null && (row.error || row.connectTimedOut), "failed connection lacks refusal/timeout evidence");
    return;
  }
  assert.ok(finite(row.connectedAtMs) && row.connectedAtMs >= row.startedAtMs && row.connectedAtMs <= terminal);
  assert.equal(row.connectTimedOut, undefined, "established connection contradicts connect timeout");
  if (row.emission === "target-refused-before-write") {
    assert.equal(row.targetClosedAtMs, terminal); assert.equal(row.writes, 0); assert.equal(row.bytesQueued, 0); assert.equal(row.drips, 0);
    assert.ok(row.error === "ECONNRESET" || row.targetClosedAtMs - row.connectedAtMs <= budget.timing.maxStartLagMs);
    return;
  }
  assert.equal(row.emission, "emitted");
  assert.ok(row.writes >= 1 && row.bytesQueued >= row.firstBytes, "established attack did not emit its native request");
  if (plan.repeat) {
    assert.equal(row.bytesQueued, row.firstBytes + row.drips * plan.dripBytes); assert.equal(row.writes, 1 + row.drips);
    assert.ok(Array.isArray(row.dripAtMs) && row.dripAtMs.length === row.drips, "missing actual trickle timestamps");
    assert.ok(row.dripAtMs.every((n, i, all) => finite(n) && n >= row.connectedAtMs && n <= terminal && (i === 0 || n > all[i - 1])));
    if (terminal - row.connectedAtMs >= budget.attack.everyMs + budget.timing.maxStartLagMs) assert.ok(row.drips > 0, "retained slow connection emitted no trickles");
  } else if (plan.bodyBytes !== undefined) {
    assert.equal(row.bodyPrefixBytes, plan.bodyPrefixBytes); assert.equal(row.declaredBodyBytes, plan.declaredBodyBytes);
    assert.ok(count(row.bodyBytesQueued) && row.bodyBytesQueued <= plan.bodyBytes);
    assert.equal(row.bytesQueued, row.firstBytes + row.bodyBytesQueued); assert.equal(row.writes, 1 + Math.ceil(row.bodyBytesQueued / 16384));
    assert.equal(row.drips, 0);
  } else {
    assert.equal(row.bytesQueued, row.firstBytes); assert.equal(row.writes, 1); assert.equal(row.drips, 0);
  }
}

export const emissionIdentity = (p, phase) => ({ variant: p.variant ?? phase, firstBytes: Buffer.byteLength(p.first), firstSha256: hash(p.first),
  repeat: !!p.repeat, ...(p.repeat ? { dripBytes: Buffer.byteLength(p.drip) } : {}),
  ...(p.body ? { bodyBytes: p.body, bodyPrefixBytes: Buffer.byteLength(p.first.split("\r\n\r\n")[1]), declaredBodyBytes: p.body + Buffer.byteLength(p.first.split("\r\n\r\n")[1]) } : {}) });
