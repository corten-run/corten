// Production evidence joins. Load classification alone never attributes an app failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { loadConfig, scheduledProducerSchema, sha256, timedReceiptSchema, upstreamReadDelta, verifyNativeReceipt, verifyParticipants, verifyRuntime } from "./contract.mjs";
import { deriveTimedObservation } from "./timed-outcomes.mjs";
import { streamLimits, timestampNs } from "./fixed-stream.mjs";
import { replayScheduledLoadResources } from "./load-resource-proof.mjs";
import { summarizeSamples } from "../catalog/stats.mjs";

const same = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const unsetDockerClock = (value) => typeof value === "string" && /^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(value);
export const captureLimits = Object.freeze({ ...streamLimits, stderrBytes: 4 * 2 ** 20, auxiliaryBytes: 2 * 2 ** 20 });
export const producerSources = Object.freeze(["load.js", "load-outcome.js", "timed-load.js", "fixed-prototype-load.js", "upstream-observer.mjs"]);
export const legacyProducerSchema = "json-api-producer/v2";
const scheduledSources = Object.freeze([...producerSources, "run.mjs", "phase.mjs", "process.mjs", "load-resource-capture.mjs", "load-resource-proof.mjs"]);
export function producerSourceNames(schema) {
  if (schema === scheduledProducerSchema) return scheduledSources;
  assert.ok(schema === legacyProducerSchema, "unknown timed producer schema");
  return producerSources;
}
export function producerProvenance(schema = legacyProducerSchema) {
  const names = producerSourceNames(schema);
  return { schema, fixedOutput: "full-stock-json-stdout", changedGeneratorIO: true, gzip: false,
    limits: captureLimits, sources: Object.fromEntries(names.map((name) => [name, sha256(readFileSync(new URL(name, import.meta.url)))])) };
}
export const verifyProducer = (value) => same(value, producerProvenance(value?.schema ?? null), "timed producer source/I/O/caps differ from verifier");

export function verifyLife(state, receipt, { before, load, code, at }) {
  assert.ok(typeof state?.startedAt === "string" && Number.isFinite(Date.parse(state.startedAt)), "participant start clock missing");
  const created = load && before;
  same(state, { containerId: receipt.containerId, startedAt: state.startedAt,
    finishedAt: state.finishedAt, status: created ? "created" : load ? "exited" : "running", running: !load,
    oomKilled: false, dead: false, paused: false, restarting: false, restartCount: 0, exitCode: load && !before ? code : 0, error: "" },
  "timed participant exited/restarted/OOM/error state");
  if (created) assert.ok(unsetDockerClock(state.startedAt), "created load start clock must be unset");
  else assert.ok(Date.parse(state.startedAt) <= at, "participant starts after observation");
  if (load && !before) assert.ok(typeof state.finishedAt === "string" && Number.isFinite(Date.parse(state.finishedAt)) && Date.parse(state.finishedAt) >= Date.parse(state.startedAt)
    && Date.parse(state.finishedAt) <= at, "load finish clock invalid");
  else assert.ok(unsetDockerClock(state.finishedAt), "created or running participant finish clock must be unset");
}

export function life(info) {
  return { containerId: info.Id, startedAt: info.State.StartedAt, finishedAt: info.State.FinishedAt,
    status: info.State.Status, running: info.State.Running, oomKilled: info.State.OOMKilled, dead: info.State.Dead,
    paused: info.State.Paused, restarting: info.State.Restarting, restartCount: info.RestartCount, exitCode: info.State.ExitCode, error: info.State.Error };
}

export function successfulUpstream(snapshot, requests) {
  // No pending read may lend its completion to an unfinished read in the window.
  const started = upstreamReadDelta({ before: {}, after: requests });
  return snapshot?.status === 200 && snapshot.aborted === 0 && isDeepStrictEqual(snapshot.completed, started ? { 200: started } : {});
}

export function deriveProductionPhase(raw, expected, phase, options, tools, context, { stream, native, priorTailUnobserved = false } = {}) {
  same(raw.captureErrors, [], "timed capture recorded apparatus errors");
  assert.equal(raw.priorTailUnobserved, priorTailUnobserved, "prior server-tail observation differs");
  const observed = deriveTimedObservation(raw, phase, options, { stream });
  if (phase !== "fixed") assert.equal(raw.command.stdoutBytes, 0, "unexpected closed native stdout");
  same(raw.identity, expected, "wrong timed phase identity");
  same(raw.tools, { nodeImageId: tools.node.imageId, k6ImageId: tools.k6.imageId }, "timed tool identity differs");
  context = { ...context, timed: true, load: loadConfig(options, phase) };
  const start = raw.command.clock.startedAt, end = raw.command.clock.finishedAt;
  assert.ok(start >= Date.parse(context.runStartedAt), "timed phase precedes run");
  if (context.runFinishedAt !== undefined) assert.ok(end <= Date.parse(context.runFinishedAt), "timed phase outside terminal run clock");
  for (const key of ["before", "after"]) {
    const snapshot = raw[key];
    assert.ok(count(snapshot?.at) && (key === "before" ? snapshot.at <= start : snapshot.at >= end), "timed resource bracket missing");
    verifyRuntime(snapshot.runtime, expected, context);
    verifyParticipants(snapshot, expected, context, ["upstream", "load"]);
    same(Object.keys(snapshot.liveness ?? {}).sort(), ["app", "load", "upstream"], "missing participant lifetime");
    for (const role of ["app", "upstream", "load"]) verifyLife(snapshot.liveness[role], role === "app" ? snapshot.runtime : snapshot.participants[role],
      { before: key === "before", load: role === "load", code: raw.command.exit.code, at: snapshot.at });
  }
  same(raw.before.runtime, raw.after.runtime, "app runtime changed during phase");
  same(raw.before.participants, raw.after.participants, "apparatus changed during phase");
  for (const role of ["app", "upstream"]) same(raw.before.liveness[role], raw.after.liveness[role], "participant lifetime changed during phase");
  const loadLife = raw.after.liveness.load;
  assert.ok(Date.parse(loadLife.startedAt) >= start && Date.parse(loadLife.finishedAt) <= end, "native load outside command clock");
  const born = timestampNs(loadLife.startedAt), exited = timestampNs(loadLife.finishedAt);
  assert.ok(exited - born >= BigInt(Math.round(raw.clock.k6DurationMs * 1e6)), "native load lifetime shorter than measured k6 duration");
  if (stream) assert.ok(born <= BigInt(stream.receipt.firstNs) && BigInt(stream.receipt.lastNs) <= exited,
    "fixed event outside native load lifetime");
  same(raw.upstreamReads?.before, raw.before.upstreamReads, "before read boundary differs");
  same(raw.upstreamReads?.after, raw.after.upstreamReads, "after read boundary differs");
  same(raw.upstreamReads?.settled, raw.upstreamReads?.after, "upstream reads continued after phase boundary");
  assert.ok(count(raw.settledAt) && raw.settledAt >= raw.after.at, "settled read observation clock missing");
  const roles = expected.source === "api" ? ["app", "upstream"] : ["app"];
  same(Object.keys(raw.counters ?? {}).sort(), [...roles].sort(), "counted CPU roles differ");
  for (const role of roles) {
    const c = raw.counters[role];
    assert.ok(count(c.before) && count(c.after) && c.after > c.before, "counted CPU window incomplete");
  }
  const scheduled = context.producerSchema === scheduledProducerSchema;
  same(Object.keys(raw.samples ?? {}).sort(), scheduled ? ["app", "upstream"] : ["app", "load", "upstream"], "all apparatus resource samples required");
  assert.ok(scheduled === Object.hasOwn(raw, "loadResources"), "load resource evidence differs from producer schema");
  const stats = {};
  for (const role of Object.keys(raw.samples)) {
    const all = raw.samples[role]; assert.ok(Array.isArray(all) && all.length > 0, "missing timed resource samples");
    for (const [i, s] of all.entries()) {
      assert.ok(Number.isFinite(s.cpu) && s.cpu >= 0 && Number.isFinite(s.mem) && s.mem >= 0 && count(s.t)
        && s.t >= raw.before.at && s.t <= raw.after.at, "invalid resource sample/window");
      if (i) assert.ok(s.t > all[i - 1].t && s.t - all[i - 1].t <= 5000, "resource sample order/gap differs");
    }
    const begin = role === "load" ? Date.parse(loadLife.startedAt) : start, finish = role === "load" ? Date.parse(loadLife.finishedAt) : end;
    const samples = all.filter((s) => s.t >= begin && s.t <= finish);
    if (role === "load") assert.ok(all.every((s) => s.t >= begin && s.t <= finish || s.cpu === 0 && s.mem === 0),
      "active load resource sample outside native load lifetime");
    assert.ok(samples.length && samples[0].t - begin <= 5000 && finish - samples.at(-1).t <= 5000, "resource samples do not cover timed window");
    const budget = role === "app" ? raw.before.runtime : raw.before.participants[role];
    assert.ok(samples.every((s) => s.mem > 0 && s.mem * 2 ** 20 < budget.memoryBytes), "participant memory missing/at budget");
    stats[role] = summarizeSamples(samples);
  }
  if (scheduled) stats.load = replayScheduledLoadResources(raw.loadResources, loadLife, {
    memoryBytes: raw.before.participants.load.memoryBytes, quota: expected.cpus.load.quota,
  });
  const reasons = [...observed.incompleteReasons];
  if (priorTailUnobserved) reasons.push("prior-phase-application-tail-unobserved");
  // The single-threaded upstream must have headroom below one core, not its two-core quota.
  if (scheduled ? !stats.load.loadHasHeadroom : stats.load.cpuMaxPct >= expected.cpus.load.quota * 80)
    reasons.push("load-generator-with-added-stock-output-lacks-observed-headroom");
  if (expected.source === "api" && stats.upstream.cpuMaxPct >= 80) reasons.push("single-process-upstream-lacks-observed-headroom");
  if (expected.source === "api" && (raw.counters.upstream.after - raw.counters.upstream.before) / (raw.clock.k6DurationMs * 10) >= 80)
    reasons.push("counted-single-process-upstream-lacks-observed-headroom");
  const { pass: _pass, ...auditIdentity } = expected;
  verifyNativeReceipt(native?.receipt, auditIdentity, native?.files, { timed: true });
  const reads = upstreamReadDelta(raw.upstreamReads);
  if (!successfulUpstream(raw.before.upstreamResponses, raw.upstreamReads.before)
    || !successfulUpstream(raw.after.upstreamResponses, raw.upstreamReads.after)
    || !successfulUpstream(raw.settledResponses, raw.upstreamReads.settled))
    reasons.push("upstream-not-observed-completing-every-read-with-200");
  if (expected.source === "fixture") assert.equal(reads, 0, "fixture timing upstream reads must be zero");
  else if (!observed.failed) assert.equal(reads, observed.requests, "successful API requests require exactly one upstream read");
  else if (native.receipt.schema !== timedReceiptSchema) reasons.push("API-failure-needs-independent-transport-single-fetch-no-retry-source-audit");
  else {
    assert.ok(reads >= observed.counts.ok && reads <= observed.requests, "failed API reads outside audited zero-or-one fetch bounds");
    if (reads !== observed.requests) reasons.push("failed-API-request-without-observed-upstream-completion");
  }
  // A client timeout does not observe server handler completion. Subsequent phases
  // cannot borrow a silent interval as proof that server work has drained.
  if (observed.counts.timeout) reasons.push("client-timeout-lacks-application-request-completion-tail-observation");
  if (phase === "warmup") assert.equal(reasons.length, 0, "warmup apparatus/source observation incomplete");
  const cpuUsec = raw.counters.app.after - raw.counters.app.before;
  return { ...observed, ...stats.app, cpuUsec, perCpuSecond: observed.requests / (cpuUsec / 1e6),
    upstream: expected.source === "api" ? { ...stats.upstream, cpuUsec: raw.counters.upstream.after - raw.counters.upstream.before } : null,
    apparatus: { load: stats.load, upstream: stats.upstream }, upstreamReads: reads,
    observationComplete: reasons.length === 0, incompleteReasons: reasons,
    targetOutcome: reasons.length ? null : observed.loadOutcome, comparisonEligible: reasons.length || observed.failed ? null : true };
}
