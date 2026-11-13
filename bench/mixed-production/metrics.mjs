import assert from "node:assert/strict";
import { expectedOutcome, oracle } from "./capture.mjs";
import { loadPaths } from "./load-capture.mjs";
import { summarizeSamples } from "../catalog/stats.mjs";

export const calibrationPolicy = Object.freeze({ minimumSteadyCycles: 3, maximumDrainFraction: 0.25,
  maximumGeneratorCpuFraction: 0.7, maximumUpstreamCpuFraction: 0.7, maximumEventLoopLagP99Ms: 20 });
const percentile = (values, p) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
};
const latency = (rows, key) => ({ samples: rows.length, p50Ms: percentile(rows.map((r) => r[key]), 0.5),
  p95Ms: percentile(rows.map((r) => r[key]), 0.95), p99Ms: percentile(rows.map((r) => r[key]), 0.99) });

export function deriveWindow({ window, captures, warmups, plan, records, source, counters, samples, quotas, stage }) {
  assert.equal(window.schema, "mixed-native-window/v1"); assert.equal(window.source, source);
  assert.equal(window.complete, true, "native window incomplete"); assert.equal(window.failure, null);
  assert.ok(window.warmup?.passed && window.warmup.cycles > 0, "native warmup missing/failed");
  assert.ok(Array.isArray(window.orphans) && window.orphans.length === 0, "unattributed native upstream work");
  const selected = loadPaths(plan, source), cycles = window.cycles;
  assert.equal(warmups?.length, window.warmup.cycles, "actual warmup captures missing");
  for (const warmup of warmups) {
    assert.ok(oracle(plan, warmup.capture, records).valid && selected.every((r) => warmup.capture.results[r.index].outcome === expectedOutcome(r)), "native warmup oracle failed");
  }
  assert.ok(cycles.length > 0 && cycles.length === captures.length);
  assert.ok(Number.isFinite(window.elapsedMs) && window.elapsedMs >= window.seconds * 1000);
  const operations = [];
  for (const [index, cycle] of cycles.entries()) {
    assert.equal(cycle.cycle, index); assert.equal(cycle.passed, true);
    const checked = oracle(plan, captures[index].capture, records);
    assert.equal(checked.valid, true, "loaded native evidence must pass the unchanged oracle");
    assert.equal(cycle.operations.length, selected.length);
    assert.deepEqual(new Set(cycle.operations.map((r) => r.requestId)), new Set(selected.map((r) => r.id)), "loaded request mix changed");
    for (const row of cycle.operations) {
      const request = selected.find((r) => r.id === row.requestId), actual = captures[index].capture.results[request.index];
      assert.ok(row.passed && actual.outcome === expectedOutcome(request) && row.outcome === actual.outcome && row.status === actual.status);
      const observed = captures[index].observations?.find((r) => r.row.request.id === row.requestId);
      assert.ok(observed && !observed.incomplete, "raw native operation observation missing");
      assert.deepEqual(observed.row, actual, "normalized capture differs from actual native observation");
      assert.deepEqual({ ...observed.operation, passed: row.passed }, row, "window timing differs from the actual operation receipt");
      assert.equal(observed.evidence.stages.find((s) => s.stage === "primary")?.elapsedMs, row.primaryMs, "latency differs from actual native receipt");
      assert.deepEqual([row.category, row.locale, row.variant, row.client], [request.category, request.locale, request.variant, request.client]);
      assert.ok([row.startedMs, row.primaryStartedMs, row.finishedMs, row.primaryMs, row.journeyMs].every((v) => Number.isFinite(v) && v >= 0));
      assert.ok(row.primaryStartedMs >= row.startedMs && row.finishedMs >= row.primaryStartedMs && row.finishedMs <= window.elapsedMs);
      assert.ok(row.primaryMs <= row.journeyMs && Math.abs(row.finishedMs - row.startedMs - row.journeyMs) < 0.01);
      assert.ok(Number.isSafeInteger(row.nativeHttpResponses) && row.nativeHttpResponses >= (row.status > 0 ? 1 : 0));
      operations.push(row);
    }
  }
  const resources = {};
  for (const role of ["app", "upstream", "load"]) {
    const c = counters[role];
    assert.ok(c && [c.before, c.after].every(Number.isSafeInteger) && c.before >= 0 && c.after >= c.before, "missing/backwards cgroup CPU counter");
    const observed = samples[role];
    // The shared sampler timestamps receipt, so a buffered chunk can contain several
    // real Docker samples at one clock tick. Keep them, but never invent spacing.
    assert.ok(observed?.length >= 2 && observed.at(-1).t > observed[0].t
      && observed.every((s, i) => Number.isFinite(s.t) && (!i || s.t >= observed[i - 1].t)), "missing/unordered resource samples");
    const summary = summarizeSamples(observed), cpuUsec = c.after - c.before;
    assert.ok(Number.isFinite(quotas[role]) && quotas[role] > 0);
    resources[role] = { ...summary, cpuUsec, sampleReceiptSpanMs: observed.at(-1).t - observed[0].t,
      sampleReceiptCollisions: observed.filter((s, i) => i && s.t === observed[i - 1].t).length,
      cpuPctOfQuota: 100 * cpuUsec / (window.elapsedMs * 1000 * quotas[role]),
      cpuUsecPerPrimaryOperation: cpuUsec / operations.length };
  }
  assert.ok(resources.app.cpuUsec > 0, "native app CPU was not observed");
  assert.ok(Number.isFinite(window.eventLoopLagP99Ms) && window.eventLoopLagP99Ms >= 0);
  const headroom = resources.load.cpuPctOfQuota < 100 * calibrationPolicy.maximumGeneratorCpuFraction
    && resources.upstream.cpuPctOfQuota < 100 * calibrationPolicy.maximumUpstreamCpuFraction
    && window.eventLoopLagP99Ms <= calibrationPolicy.maximumEventLoopLagP99Ms;
  const drainFraction = (window.elapsedMs - window.seconds * 1000) / (window.seconds * 1000);
  const eligible = headroom && (stage !== "steady" || cycles.length >= calibrationPolicy.minimumSteadyCycles && drainFraction <= calibrationPolicy.maximumDrainFraction);
  const byKind = {};
  for (const row of operations) (byKind[`${row.category}/${row.locale ?? "neutral"}/${row.variant ?? "default"}`] ??= []).push(row);
  return { schema: "mixed-native-metrics/v1", stage, eligible, headroom, cycles: cycles.length,
    plannedWindowSeconds: window.seconds, actualObservationSeconds: window.elapsedMs / 1000, drainFraction,
    primaryAttempts: operations.length, nativeHttpResponses: operations.reduce((n, r) => n + r.nativeHttpResponses, 0),
    achievedPrimaryOperationsPerSecond: operations.length / (window.elapsedMs / 1000),
    usefulCompletionsPerSecond: operations.filter((r) => ["completed", "rejected"].includes(r.outcome)).length / (window.elapsedMs / 1000),
    primaryHttpLatency: latency(operations, "primaryMs"), journeyLatency: latency(operations, "journeyMs"), resources,
    eventLoopLagP99Ms: window.eventLoopLagP99Ms,
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, rows]) => [kind, { attempts: rows.length,
      primaryHttpLatency: latency(rows, "primaryMs"), journeyLatency: latency(rows, "journeyMs") }])),
    interpretation: "Observed closed-loop native operations, including preparation/readback and exact complete-cycle mix; not saturation or capacity. CPU counters include small host orchestration/idle boundaries." };
}
