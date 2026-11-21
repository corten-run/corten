import assert from "node:assert/strict";
import { maxRecordBytes, recoveryProfile, validRecord } from "./dependency-recovery-contract.mjs";

export const boundedRequestProfile = Object.freeze({
  version: "bounded-requests/v1", normalDeadlineMs: 600, clientDeadlineMs: 100, headerValueBytes: 4096,
});
export const boundedRecordPath = "/api/marketplace/item_1";
export const boundedStatusPath = "/__marketplace/dependency-recovery";
export const triggerSettleMs = 75;
export const restoreSettleMs = 25;
const scheduleSlackMs = 200;
const timerSlackMs = 2;
const { version, normalDeadlineMs, clientDeadlineMs, headerValueBytes } = boundedRequestProfile;
const { duringMs, delayMs } = recoveryProfile;
const phases = ["normal", "slow", "restored"];
const targetErrors = new Set(["deadline", "body-too-large", "incomplete-response", "invalid-http-response", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);
const uint = (n) => Number.isSafeInteger(n) && n >= 0;
const finiteMs = (n) => Number.isFinite(n) && n >= 0;
const keys = (object, names, description) => assert.deepEqual(Object.keys(object ?? {}).sort(), [...names].sort(), description);

export function assertBoundedScope({ phase, source, targetOrigin, upstreamOrigin }) {
  assert.ok(phase === "request-limit" || phase === "request-timeout", "invalid bounded request phase");
  assert.ok(source === "api" || source === "fixture", "invalid bounded request source");
  assert.ok(targetOrigin === "http://localhost:8080" || targetOrigin === "https://localhost:8080", "invalid private benchmark target");
  assert.ok(typeof upstreamOrigin === "string" && /^http:\/\/hardening-[a-f0-9]{12}-cell-upstream:8080$/.test(upstreamOrigin), "invalid private benchmark upstream");
}

function readSpec(url, deadlineMs = normalDeadlineMs, headerBytes = 0) {
  return { method: "GET", url, deadlineMs, headerValueBytes: headerBytes };
}

export function boundedReadPlan(phase, targetOrigin, upstreamOrigin) {
  const target = targetOrigin + boundedRecordPath, limit = phase === "request-limit";
  return {
    reads: [
      { step: "baseline", ...readSpec(target) },
      { step: limit ? "boundary" : "during-delay", ...readSpec(target, limit ? normalDeadlineMs : clientDeadlineMs, limit ? headerValueBytes : 0) },
      { step: "followup", ...readSpec(target) },
    ],
    statusRead: readSpec(upstreamOrigin + boundedStatusPath),
  };
}

function validateRead(row, spec) {
  keys(row, [...Object.keys(spec), "startMs", "endMs", "receipt"], "invalid bounded read fields");
  const { startMs, endMs, receipt, ...read } = row;
  assert.deepEqual(read, spec, "bounded read differs from the fixed request");
  assert.ok(finiteMs(startMs) && finiteMs(endMs) && endMs >= startMs, "invalid bounded read time");
  const elapsedMs = endMs - startMs;
  assert.ok(elapsedMs <= spec.deadlineMs + scheduleSlackMs, "bounded read escaped its deadline allowance");
  keys(receipt, ["status", "contentType", "bodyBase64", "complete", "error"], "invalid bounded response receipt fields");
  const { status, contentType, complete, error, bodyBase64 } = receipt;
  assert.ok(status === null || Number.isInteger(status) && status >= 100 && status <= 599, "invalid response status");
  assert.ok(status === null ? contentType === null : typeof contentType === "string" && contentType.length <= 8192, "invalid response content type");
  assert.ok(typeof complete === "boolean" && (complete ? (status !== null && error === null) : targetErrors.has(error)),
    "missing/inconsistent response receipt or local probe failure");
  assert.ok(typeof bodyBase64 === "string" && bodyBase64.length <= 4 * Math.ceil(maxRecordBytes / 3), "invalid response byte budget");
  const body = Buffer.from(bodyBase64, "base64");
  assert.ok(body.length <= maxRecordBytes && body.toString("base64") === bodyBase64 && (complete || body.length === 0), "invalid response bytes");
  if (error === "deadline") assert.ok(elapsedMs >= spec.deadlineMs - timerSlackMs, "client cancellation before its deadline");
  return { elapsedMs, body };
}

function readState(row, spec, phase) {
  const { body, elapsedMs } = validateRead(row, spec);
  assert.ok(row.receipt.status === 200 && row.receipt.complete && /^application\/json(?:\s*;|$)/i.test(row.receipt.contentType)
    && elapsedMs <= spec.deadlineMs, "recovery upstream status unavailable");
  const state = JSON.parse(body.toString("utf8"));
  keys(state, ["phase", "elapsedSinceStartMs", "delayMs", "windowMs", "reads", "responses200"], "invalid recovery status fields");
  assert.deepEqual([state.phase, state.delayMs, state.windowMs], [phase, delayMs, duringMs], "wrong recovery phase or profile");
  const age = state.elapsedSinceStartMs;
  assert.ok(phase === "normal" ? age === null : uint(age) && (phase === "slow" ? age < duringMs : age >= duringMs),
    "recovery phase disagrees with its elapsed clock");
  for (const field of ["reads", "responses200"]) keys(state[field], phases, "invalid recovery counter phases");
  for (const [i, name] of phases.entries()) {
    assert.ok(uint(state.reads[name]) && uint(state.responses200[name]) && state.responses200[name] <= state.reads[name], "invalid recovery counters");
    if (i > phases.indexOf(phase)) assert.equal(state.reads[name], 0, "upstream reads before their phase");
  }
  return state;
}

function ordered(previousEnd, nextStart, delay = 0) {
  assert.ok(finiteMs(previousEnd) && finiteMs(nextStart) && nextStart >= previousEnd + Math.max(0, delay - timerSlackMs)
    && nextStart - previousEnd <= delay + scheduleSlackMs, "bounded probe schedule or order differs");
}

function validateTimeout(upstream, samples, statusRead) {
  const names = ["beforeBaseline", "beforeTrigger", "slowBefore", "slowAfter", "restoredBefore", "restoredAfter"];
  keys(upstream, ["triggerAtMs", ...names], "missing or invalid recovery snapshots");
  const [baseline, during, followup] = samples;
  const { triggerAtMs, beforeBaseline, beforeTrigger, slowBefore, slowAfter, restoredBefore, restoredAfter } = upstream;
  const snapshots = names.map((name, i) => readState(upstream[name], statusRead, phases[i >> 1]));
  ordered(0, beforeBaseline.startMs);
  ordered(beforeBaseline.endMs, baseline.startMs);
  ordered(baseline.endMs, beforeTrigger.startMs);
  ordered(beforeTrigger.endMs, triggerAtMs);
  ordered(triggerAtMs, slowBefore.startMs, triggerSettleMs);
  ordered(slowBefore.endMs, during.startMs);
  ordered(during.endMs, slowAfter.startMs);
  ordered(slowBefore.endMs, restoredBefore.startMs, duringMs + restoreSettleMs);
  assert.ok(slowAfter.endMs <= restoredBefore.startMs, "recovery snapshots overlap");
  ordered(restoredBefore.endMs, followup.startMs);
  ordered(followup.endMs, restoredAfter.startMs);

  // A status snapshot occurs somewhere in its HTTP interval; all four timed
  // states must agree on a possible start time after the private trigger.
  let earliest = triggerAtMs, latest = Infinity;
  for (const [i, state] of snapshots.entries()) {
    const age = state.elapsedSinceStartMs;
    if (age !== null) {
      const row = upstream[names[i]];
      earliest = Math.max(earliest, row.startMs - age - 1);
      latest = Math.min(latest, row.endMs - age + 1);
      assert.ok(i === 2 || age >= snapshots[i - 1].elapsedSinceStartMs, "non-monotonic recovery age");
      // A slow 200 needs a read that started at least one delay earlier. Use
      // the upstream's own sampled clock; normal snapshots precede its trigger.
      for (const prior of snapshots.slice(0, i)) {
        if (age - (prior.elapsedSinceStartMs ?? 0) < delayMs - timerSlackMs) {
          assert.ok(state.responses200.slow <= prior.reads.slow, "slow response completed before the upstream delay");
        }
      }
    }
    if (i === 0) continue;
    for (const field of ["reads", "responses200"]) for (const key of phases) {
      assert.ok(state[field][key] >= snapshots[i - 1][field][key], "decreasing upstream counter");
    }
  }
  assert.ok(earliest <= latest, "recovery snapshots do not agree on trigger timing");
  const counts = (first, last, field, name) => snapshots[last][field][name] - snapshots[first][field][name];
  return {
    normalRecord: counts(0, 1, "reads", "normal") > 0 && counts(0, 1, "responses200", "normal") > 0,
    slowReads: counts(2, 3, "reads", "slow"),
    restoredRecord: counts(4, 5, "reads", "restored") > 0 && counts(4, 5, "responses200", "restored") > 0,
    fixtureIdle: phases.every(phase => snapshots[0].reads[phase] === snapshots[5].reads[phase]),
  };
}

// Throw only for missing/inconsistent evidence, not for a complete, observed
// target failure. Observing a bounded header at one size is not limit discovery.
export function assessBoundedRequests({ phase, source, raw, expected, targetOrigin, upstreamOrigin }) {
  assertBoundedScope({ phase, source, targetOrigin, upstreamOrigin });
  assert.ok(expected?.id === "item_1", "missing canonical marketplace record");
  assert.ok(Array.isArray(raw) && raw.length === 2, "invalid bounded request journal");
  const [clock, observation] = raw;
  keys(clock, ["type", "bootId", "monotonicNs", "wallAtStart"], "invalid bounded request clock");
  assert.equal(clock.type, "clock");
  assert.match(clock.bootId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(clock.monotonicNs, /^\d{1,20}$/);
  assert.ok(typeof clock.wallAtStart === "string" && Number.isFinite(Date.parse(clock.wallAtStart)), "invalid bounded request wall clock");
  keys(observation, ["type", "version", "phase", "source", "targetOrigin", "upstreamOrigin", "samples", "upstream", "completeAtMs"],
    "invalid bounded observation fields");
  assert.deepEqual([observation.type, observation.version, observation.phase, observation.source, observation.targetOrigin, observation.upstreamOrigin],
    ["bounded-requests", version, phase, source, targetOrigin, upstreamOrigin], "bounded observation identity differs");
  const { samples, upstream, completeAtMs } = observation;
  const { reads, statusRead } = boundedReadPlan(phase, targetOrigin, upstreamOrigin);
  assert.ok(Array.isArray(samples) && samples.length === reads.length, "missing/extra bounded reads");
  const limit = phase === "request-limit", [baseline, middle, followup] = samples;
  const timing = reads.map((read, i) => validateRead(samples[i], read));
  const record = i => timing[i].elapsedMs <= reads[i].deadlineMs && validRecord(samples[i].receipt, expected);
  const baselineHealthy = record(0), followupHealthy = record(2);
  const layer = targetOrigin.startsWith("https:") ? "deployed-edge-path" : "application";
  const { elapsedMs } = timing[1], { status: statusCode, error, complete } = middle.receipt;
  let reason = !baselineHealthy ? "baseline-record" : !followupHealthy ? "followup-record" : null;
  let outcome, upstreamDelayObserved = null;
  if (limit) {
    assert.equal(upstream, null, "unexpected delay apparatus in request-limit");
    ordered(0, baseline.startMs); ordered(baseline.endMs, middle.startMs); ordered(middle.endMs, followup.startMs);
    assert.equal(completeAtMs, followup.endMs, "incorrect bounded completion time");
    outcome = record(1) ? "accepted" : complete && statusCode >= 400 && statusCode < 500 && elapsedMs <= normalDeadlineMs ? "rejected" : "unexpected-response";
    if (outcome === "unexpected-response") reason ??= "boundary-response";
  } else {
    const proof = validateTimeout(upstream, samples, statusRead);
    assert.equal(completeAtMs, upstream.restoredAfter.endMs, "incorrect bounded completion time");
    if (source === "api") {
      upstreamDelayObserved = proof.slowReads > 0;
      // A late local timer cannot prove cancellation before the dependency's
      // minimum delay, even when the receipt says the local timer fired.
      assert.ok(error !== "deadline" || elapsedMs < delayMs - timerSlackMs, "client deadline capture missed the upstream delay bound");
      outcome = error === "deadline" ? "client-deadline" : "unexpected-response";
      reason ??= !proof.normalRecord ? "api-baseline-source" : !proof.restoredRecord ? "api-followup-source"
        : !upstreamDelayObserved ? "api-delay-not-observed" : outcome !== "client-deadline" ? "api-client-deadline-not-observed" : null;
    } else {
      upstreamDelayObserved = false;
      outcome = record(1) ? "fixture-control" : error === "deadline" ? "client-deadline" : "unexpected-response";
      reason ??= !proof.fixtureIdle ? "fixture-upstream-contact" : outcome !== "fixture-control" ? "fixture-control-record" : null;
    }
  }
  return { version, phase, source, completeAtMs, healthy: reason === null, status: reason === null ? outcome : "target-failure",
    reason, baselineHealthy, followupHealthy, observation: { kind: limit ? "complete-header-request" : "client-deadline", outcome,
      statusCode, error, elapsedMs, layer, upstreamDelayObserved } };
}
