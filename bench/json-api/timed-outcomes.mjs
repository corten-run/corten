// Timed load observations are not apparatus/source/headroom or target qualification.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { joinFixedPrototype, verifyPrototypeLogs } from "./fixed-prototype.mjs";
import { loadConfig, phases } from "./contract.mjs";

export const timedPhaseSchema = "json-api-timed-phase/v1";
export const timedSummarySchema = "json-api-results/v2";
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const finite = (value) => Number.isFinite(value) && value >= 0;
const metric = (summary, key) => summary?.metrics?.[key]?.values ?? summary?.metrics?.[key];
const same = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);
const close = (a, b, message) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9), message);

function readMetrics(summary, clock, { fixed = false } = {}) {
  const duration = clock.k6DurationMs;
  assert.ok(Number.isFinite(duration) && duration > 0, "missing timed k6 duration");
  const counter = (name) => {
    const value = metric(summary, name);
    assert.ok(count(value?.count), `missing/invalid timed ${name}`);
    close(value.rate, value.count * 1000 / duration, `${name} count/rate/clock differs`);
    return value.count;
  };
  const requests = counter("http_reqs"), iterations = counter("iterations"), started = counter("json_started");
  assert.ok(requests > 0 && Number.isSafeInteger(requests * 2), "timed request/check count missing or overflowing");
  assert.equal(iterations, requests, "unfinished timed iterations");
  assert.equal(started, requests, "unfinished timed starts");
  const counts = Object.fromEntries(["ok", "timeout", "http_error", "invalid"].map((name) => [name, counter(`json_${name}`)]));
  assert.equal(counts.invalid, 0, "unclassified/corrupt timed response");
  const failed = counts.timeout + counts.http_error;
  assert.equal(counts.ok + failed, requests, "timed classification coverage differs");
  if (!fixed) {
    counts.rateLimited = counter("json_rate_limited"); counts.serverErrors = counter("json_server_error");
    assert.equal(counts.rateLimited + counts.serverErrors, counts.http_error, "429/5xx classification coverage differs");
  }
  const errors = metric(summary, "http_req_failed");
  assert.equal(errors?.passes, failed, "timed HTTP failures differ"); assert.equal(errors?.fails, counts.ok, "timed HTTP successes differ");
  close(errors.rate ?? errors.value, failed / requests, "timed HTTP failure rate differs");
  const checks = summary.root_group?.checks;
  same(Object.keys(checks ?? {}).sort(), ["JSON content type", "JSON status 200"], "timed named checks differ");
  const types = checks["JSON content type"].passes;
  assert.ok(count(types) && types >= counts.ok && types <= counts.ok + counts.http_error, "timed content checks contradict outcomes");
  const expected = { "JSON status 200": [counts.ok, failed], "JSON content type": [types, requests - types] };
  for (const [name, [passes, fails]] of Object.entries(expected)) {
    assert.equal(checks[name].passes, passes, "named check passes differ"); assert.equal(checks[name].fails, fails, "named check failures differ");
  }
  const total = metric(summary, "checks"), passes = counts.ok + types;
  assert.equal(total?.passes, passes, "total timed check passes differ"); assert.equal(total?.fails, 2 * requests - passes, "total timed check failures differ");
  close(total.rate ?? total.value, passes / (2 * requests), "total timed check rate differs");
  const dropped = counter("dropped_iterations");
  for (const [name, rule, crossed] of [["http_req_failed", "rate==0", failed > 0], ["checks", "rate==1", failed > 0], ["dropped_iterations", "count==0", dropped > 0]])
    same(summary.metrics[name]?.thresholds, { [rule]: crossed }, "timed native thresholds differ");
  const latency = metric(summary, "http_req_duration");
  assert.ok(["avg", "p(50)", "p(95)", "p(99)", "max"].every((key) => finite(latency?.[key])), "timed latency missing/invalid");
  assert.ok(latency.avg <= latency.max && latency["p(50)"] <= latency["p(95)"] && latency["p(95)"] <= latency["p(99)"] && latency["p(99)"] <= latency.max, "timed latency order differs");
  // The independent clock artifact must agree with every custom counter, not select
  // a less strict parser through arbitrary raw fields or a different schema.
  for (const name of ["started", "ok", "timeout", "http_error", "invalid", ...(!fixed ? ["rate_limited", "server_error"] : [])]) {
    const observed = metric(clock, `json_${name}`), saved = metric(summary, `json_${name}`);
    assert.equal(observed?.count, saved.count, "custom timed clock/counter differs");
    close(observed?.rate, saved.rate, "custom timed clock/rate differs");
  }
  return { requests, iterations, started, dropped, counts, failed, rps: requests * 1000 / duration,
    successfulRps: counts.ok * 1000 / duration, p50: latency["p(50)"], p95: latency["p(95)"], p99: latency["p(99)"] };
}

export function deriveTimedObservation(raw, phase, options, { stream } = {}) {
  assert.ok(raw?.schema === timedPhaseSchema, "versioned timed JSON phase required");
  assert.ok(["warmup", ...phases].includes(phase), "unknown timed JSON phase");
  for (const [key, max] of [["duration", 300], ["warmup", 120], ["rate", 10000]])
    assert.ok(Number.isSafeInteger(options?.[key]) && options[key] >= 1 && options[key] <= max, "invalid configured timed duration/rate");
  assert.ok(raw.phase === phase, "timed phase differs");
  const config = loadConfig(options, phase);
  same(raw.config, config, "timed native configuration differs");
  const { clock, command } = raw;
  same(command?.ioErrors, [], "timed command I/O fault");
  assert.ok(command.exit?.code === 0 || command.exit?.code === 99, "normal native threshold exit required");
  same(command.exit, { code: command.exit.code, signal: null, expired: false, interrupted: false }, "abnormal timed native exit");
  const { startedAt: start, finishedAt: end } = command.clock ?? {};
  assert.ok(count(start) && start > 0 && count(end) && end > start, "invalid timed host command clock");
  const duration = clock?.k6DurationMs;
  assert.ok(Number.isFinite(duration) && duration >= config.seconds * 1000 && duration <= (config.seconds + 10) * 1000,
    "incomplete timed interval/drain");
  assert.ok(end - start + 1 >= duration && end - start <= duration + 10000, "timed host/k6 clock differs");
  const fixed = phase === "fixed", metrics = readMetrics(raw.k6, clock, { fixed });
  const loadOutcome = metrics.failed || metrics.dropped ? "failed" : "passed";
  assert.equal(command.exit.code, loadOutcome === "failed" ? 99 : 0, "native timed exit/threshold mismatch");
  assert.equal(typeof raw.logs, "string", "complete timed native logs required");
  assert.ok(count(command.stderrBytes) && command.stderrBytes === Buffer.byteLength(raw.logs, "utf8"), "timed stderr UTF8 bytes differ");
  verifyPrototypeLogs(raw.logs, command.exit.code, { timeouts: metrics.counts.timeout, dropped: metrics.dropped });
  let scheduling = null;
  if (fixed) {
    assert.ok(stream, "full fixed raw stream replay required");
    same(stream.receipt, raw.events, "fixed full raw stream hash/length/event receipt differs");
    assert.equal(command.stdoutBytes, stream.receipt.bytes, "fixed raw stdout byte count differs");
    const observed = joinFixedPrototype({ summary: raw.k6, clock, command, config: { phase, seconds: config.seconds, rate: config.rate }, logs: raw.logs }, stream);
    metrics.counts.rateLimited = stream.statusCounts["429"] ?? 0;
    metrics.counts.serverErrors = Object.entries(stream.statusCounts).filter(([status]) => Number(status) >= 500 && Number(status) <= 599).reduce((sum, [, count]) => sum + count, 0);
    assert.equal(metrics.counts.rateLimited + metrics.counts.serverErrors, metrics.counts.http_error, "raw 429/5xx counts differ");
    scheduling = { ...observed.scheduling, requestedSeconds: config.seconds, nominalArrivals: config.seconds * config.rate,
      observedOffers: metrics.requests + metrics.dropped, evidence: "recorded-stock-native-starts-and-wall-drop-events",
      monotonicSchedulerStopObserved: false, endpointEligible: null };
  } else {
    assert.ok(clock?.schema === "json-api-closed-clock/v1", "closed timed native clock schema differs");
    assert.equal(stream, undefined, "unexpected fixed event stream on closed phase");
    assert.equal(raw.events, undefined, "unexpected fixed event reference on closed phase");
    assert.equal(metrics.dropped, 0, "closed timed phases cannot drop arrivals");
  }
  if (phase === "warmup") assert.equal(loadOutcome, "passed", "warmup threshold failures are not target outcomes");
  const incomplete = metrics.dropped > 0;
  return { ...metrics, loadOutcome, observationComplete: !incomplete,
    incompleteReasons: incomplete ? ["fixed-drops-lack-monotonic-last-offer-or-stop-observation"] : [], scheduling,
    // Source/runtime/all-resource/cleanup evidence is checked separately. Never
    // mistake this parser's coherent load counters for an app-attribution gate.
    targetOutcome: null, comparisonEligible: null };
}

const range = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor((sorted.length - 1) / 2)], max: sorted.at(-1) };
};

// This is a report projection over DERIVED observations, not a verifier for saved
// summaries. A future report must compare saved projections to this derivation.
export function timedCaseProjection(runs, asked) {
  assert.ok([1, 3, 5].includes(asked) && Array.isArray(runs), "invalid requested timed passes");
  const used = new Set();
  for (const run of runs) {
    assert.ok(count(run.pass) && run.pass >= 1 && run.pass <= asked && !used.has(run.pass), "duplicate/foreign timed pass"); used.add(run.pass);
  }
  const cells = Array.from({ length: asked }, (_, i) => {
    const pass = i + 1, run = runs.find((r) => r.pass === pass);
    return { pass, phases: Object.fromEntries(phases.map((phase) => {
      const observation = run?.phases?.[phase];
      return [phase, observation ? { state: observation.observationComplete ? observation.loadOutcome : "incomplete",
        requests: observation.requests, failed: observation.failed, dropped: observation.dropped, counts: observation.counts,
        rps: observation.rps, successfulRps: observation.successfulRps, scheduling: observation.scheduling }
        : { state: "missing", requests: null, failed: null, dropped: null, counts: null, rps: null, successfulRps: null, scheduling: null }];
    })) };
  });
  const byPhase = Object.fromEntries(phases.map((phase) => {
    const observations = cells.map((c) => c.phases[phase]), present = observations.filter((o) => o.state !== "missing");
    return [phase, { asked, present: present.length, failedPasses: cells.filter((c) => c.phases[phase].state === "failed").map((c) => c.pass),
      incompletePasses: cells.filter((c) => ["incomplete", "missing"].includes(c.phases[phase].state)).map((c) => c.pass),
      ranges: Object.fromEntries(["requests", "failed", "dropped", "rps", "successfulRps"].map((key) => [key, range(present.map((o) => o[key]))])),
      countRanges: Object.fromEntries(["ok", "timeout", "http_error", "invalid", "rateLimited", "serverErrors"].map((key) => [key, range(present.map((o) => o.counts[key]))])) }];
  }));
  const incomplete = cells.some((c) => Object.values(c.phases).some((p) => ["incomplete", "missing"].includes(p.state)));
  const failed = cells.some((c) => Object.values(c.phases).some((p) => p.state === "failed"));
  return { asked, cells, byPhase, loadOutcome: incomplete ? "incomplete" : failed ? "failed" : "passed",
    targetOutcome: null, comparisonEligible: null };
}
