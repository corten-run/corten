// Offline replay of ordinary record reads during a bounded dependency delay.
import assert from "node:assert/strict";
import { records } from "../marketplace/fixtures.mjs";
import { assessRecovery, recoveryProfile, recoverySchedule, validRecord, maxRecordBytes } from "./dependency-recovery-contract.mjs";
import { verifyNativeLimits, verifyParity } from "./evidence.mjs";
import { terminalRecovery } from "./lifecycle.mjs";

const { beforeMs, duringMs, afterMs, delayMs, timeoutMs } = recoveryProfile;
const restoreMs = beforeMs + duringMs, endMs = restoreMs + afterMs;
const windows = [["before", 0, beforeMs], ["during", beforeMs, restoreMs], ["after", restoreMs, endMs]];
const phases = ["normal", "slow", "restored"];
const counters = ["reads", "responses200"];
// Allow for millisecond timer granularity, not scheduler or snapshot lag.
const timerToleranceMs = 2;
const localErrors = new Set(["EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);
const uint = (n) => Number.isSafeInteger(n) && n >= 0;

function validateReadReceipts(samples) {
  assert.ok(Array.isArray(samples) && samples.length === recoverySchedule.length, "missing or extra recovery probes");
  const expected = records().item_1, maxBytes = maxRecordBytes;
  for (const { startMs, endMs, ok, receipt } of samples) {
    assert.ok(receipt && typeof receipt.complete === "boolean", "missing recovery response receipt");
    assert.ok(receipt.status === null || Number.isInteger(receipt.status) && receipt.status >= 100 && receipt.status <= 599);
    assert.ok(receipt.contentType === null || typeof receipt.contentType === "string");
    assert.ok(receipt.error === null || typeof receipt.error === "string" && receipt.error.length > 0);
    assert.ok(!localErrors.has(receipt.error), "local recovery probe failure invalidates apparatus");
    assert.ok(typeof receipt.bodyBase64 === "string" && receipt.bodyBase64.length <= 4 * Math.ceil(maxBytes / 3));
    const body = Buffer.from(receipt.bodyBase64, "base64");
    assert.ok(body.length <= maxBytes && body.toString("base64") === receipt.bodyBase64, "invalid recovery response bytes");
    assert.equal(ok, validRecord(receipt, expected) && endMs - startMs <= timeoutMs, "recovery success contradicts its response receipt or deadline");
  }
}

function verifyApiEvidence(snapshots, samples, triggerAtMs, restoredAtMs, jitter) {
  assert.ok(snapshots[2].reads.slow > 0, "missing API upstream exposure during slow phase");
  const phaseBounds = [0, triggerAtMs, restoredAtMs, Infinity];
  // An observation may arrive late, but the private trigger cannot start
  // before baseline ends, and its full delay window must elapse before restore.
  const earliestPhaseStart = [0, beforeMs, restoreMs];
  const intervals = snapshots.slice(1).map((current, i) => ({
    start: snapshots[i].observedAtMs - jitter, end: current.observedAtMs,
    counts: phases.map((phase) => ({ reads: current.reads[phase] - snapshots[i].reads[phase],
      responses200: current.responses200[phase] - snapshots[i].responses200[phase] })),
  }));
  const choices = samples.filter((sample) => sample.ok).map(({ startMs, endMs, scheduledMs }) => {
    const pairs = [];
    for (const [phase, name] of phases.entries()) {
      const minDelay = name === "slow" ? delayMs - timerToleranceMs : 0;
      for (const [i, read] of intervals.entries()) {
        const firstRead = Math.max(startMs, read.start, earliestPhaseStart[phase], phaseBounds[phase] - jitter);
        if (!read.counts[phase].reads || firstRead > read.end || firstRead >= phaseBounds[phase + 1]) continue;
        for (const reply of intervals.slice(i)) {
          // The completion keeps the read's phase even when it crosses a transition.
          const firstReply = Math.max(firstRead + minDelay, reply.start);
          if (reply.counts[phase].responses200 && firstReply <= Math.min(endMs, reply.end)) {
            pairs.push([read.counts[phase], reply.counts[phase]]);
          }
        }
      }
    }
    assert.ok(pairs.length, `missing API upstream read/200 pair for success at ${scheduledMs} ms`);
    return pairs;
  }).sort((a, b) => a.length - b.length);
  // Only probes near a phase or snapshot boundary have multiple choices: the
  // fixed cadence and deadline bound how many probes can overlap each one.
  const assign = (i) => {
    if (i === choices.length) return true;
    for (const [read, reply] of choices[i]) {
      if (!read.reads || !reply.responses200) continue;
      read.reads--; reply.responses200--;
      if (assign(i + 1)) return true;
      read.reads++; reply.responses200++;
    }
    return false;
  };
  assert.ok(assign(0), "missing API upstream read/200 pairs for all successes without reusing counter increments");
}

function validateUpstream({ upstream, restoredAtMs, samples }, source, jitter) {
  const snapshots = [upstream.before, upstream.slow, upstream.restored, upstream.after];
  assert.deepEqual(snapshots.map((s) => s.phase), ["normal", "slow", "restored", "restored"], "upstream snapshots in wrong phase");
  assert.equal(upstream.before.observedAtMs, 0);
  assert.equal(upstream.before.elapsedSinceStartMs, null);
  assert.equal(restoredAtMs, upstream.restored.observedAtMs - upstream.restored.elapsedSinceStartMs + duringMs,
    "recovery restore timestamp differs from upstream observation");
  const triggerAtMs = restoredAtMs - duringMs;
  assert.ok(upstream.slow.elapsedSinceStartMs <= timeoutMs && upstream.restored.elapsedSinceStartMs <= duringMs + timeoutMs,
    "upstream phase snapshot missed its transition");
  for (const [i, current] of snapshots.entries()) {
    assert.equal(current.delayMs, delayMs); assert.equal(current.windowMs, duringMs);
    const previous = snapshots[i - 1];
    if (previous) {
      const { observedAtMs, elapsedSinceStartMs } = current;
      assert.ok(Number.isFinite(observedAtMs) && observedAtMs > previous.observedAtMs && uint(elapsedSinceStartMs));
      assert.ok(i === 1 ? elapsedSinceStartMs < duringMs : elapsedSinceStartMs >= duringMs && elapsedSinceStartMs >= previous.elapsedSinceStartMs,
        "upstream phase disagrees with its elapsed clock");
      assert.ok(Math.abs(observedAtMs - elapsedSinceStartMs - triggerAtMs) <= jitter, "upstream snapshots disagree on when delay began");
    }
    for (const field of counters) {
      assert.deepEqual(Object.keys(current[field]).sort(), [...phases].sort(), "invalid upstream counter phases");
      for (const [j, phase] of phases.entries()) {
        const value = current[field][phase], prior = previous?.[field][phase];
        assert.ok(uint(value) && (i === 0 || value >= prior), "invalid or decreasing upstream counter");
        if (j > Math.min(i, 2)) assert.equal(value, 0, "upstream counter advanced before its phase");
        if (i && (source === "fixture" || field === "reads" && j < i - 1)) {
          assert.equal(value, prior, "unexpected upstream counter delta");
        }
      }
    }
    for (const phase of phases) assert.ok(current.responses200[phase] <= current.reads[phase], "upstream completion without a read");
  }
  const drain = Math.max(endMs, ...samples.map((s) => s.endMs));
  assert.ok(upstream.after.observedAtMs >= drain && upstream.after.observedAtMs <= drain + timeoutMs + jitter,
    "upstream end snapshot escaped recovery probe drain");
  if (source === "api") verifyApiEvidence(snapshots, samples, triggerAtMs, restoredAtMs, jitter);
}

function clockNs(value) {
  assert.ok(typeof value === "string" && /^\d{1,20}$/.test(value), "missing native monotonic timestamp");
  return BigInt(value);
}

export function verifyLifecycle(clock, deployment, lifecycle, provenance, cleanup, completeAtMs) {
  assert.equal(cleanup.complete, true); assert.deepEqual(cleanup.containers, []); assert.deepEqual(cleanup.volumes, []);
  assert.deepEqual(cleanup.failures, []); assert.equal(cleanup.commandClients, 0);
  assert.ok(Number.isFinite(Date.parse(clock.wallAtStart)), "missing recovery wall-clock origin");
  assert.match(clock.bootId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(cleanup.nativeClock.bootId, clock.bootId, "cleanup and recovery clocks are not from the same kernel boot");
  const origin = clockNs(clock.monotonicNs), cleanupNs = clockNs(cleanup.nativeClock.monotonicNs);
  const ids = deployment.processes.map((p) => p.id).sort();
  assert.deepEqual(Object.keys(lifecycle).sort(), ids); assert.deepEqual(provenance.map((p) => p.id).sort(), ids);
  assert.equal(deployment.countAllProcesses, true);
  const earliest = origin + BigInt(Math.ceil(completeAtMs * 1e6));
  for (const p of deployment.processes) {
    const state = lifecycle[p.id], identity = provenance.find(({ id }) => id === p.id);
    assert.ok(p.id === p.role && uint(p.count) && p.count > 0, "missing native process inventory");
    assert.equal(identity.image, state.before.Image); assert.match(identity.image, /^sha256:[a-f0-9]{64}$/);
    assert.match(identity.config, /^[a-f0-9]{64}$/); assert.ok(typeof identity.source === "string" && identity.source.length > 0);
    assert.equal(identity.evidence, `${p.id}-before.json`);
    assert.equal(state.before.State.Running, true); assert.equal(state.after.Id, state.before.Id);
    assert.equal(state.after.State.StartedAt, state.before.State.StartedAt, "target restarted during recovery");
    assert.ok(!state.after.State.Error && !state.events.some((e) => ["kill", "stop", "start", "restart", "pause", "unpause", "destroy"].includes(e.Action)),
      "external lifecycle intervention invalidates recovery evidence");
    const { start, end } = state.observation;
    assert.equal(start.bootId, clock.bootId); assert.equal(end.bootId, clock.bootId);
    const startNs = clockNs(start.monotonicNs), endNs = clockNs(end.monotonicNs);
    assert.ok(startNs >= earliest && endNs >= startNs && endNs <= cleanupNs, "terminal observation escaped post-probe/pre-cleanup bounds");
    assert.ok(state.health, "missing terminal health receipt");
  }
  return { complete: true, atMs: Number(cleanupNs - origin) / 1e6, evidence: "cleanup.json" };
}

function verifyResourceSamples(rows, processes, lifecycle, clock) {
  const origin = clockNs(clock.monotonicNs), wallAtStart = Date.parse(clock.wallAtStart);
  const ids = processes.map((p) => p.id).sort();
  return Object.fromEntries(windows.map(([window, start, end], i) => {
    const { atMs, collectedAtMs, samples } = rows[i];
    assert.ok(Number.isFinite(atMs) && Number.isFinite(collectedAtMs) && atMs >= (start + end) / 2
      && collectedAtMs >= atMs && collectedAtMs <= end, "resource collection escaped recovery window");
    assert.deepEqual(Object.keys(samples).sort(), ids, "resource samples differ from deployment process inventory");
    return [window, processes.map(({ id, count }) => {
      const s = samples[id], state = lifecycle[id].after.State;
      const began = Number(clockNs(s.startedNs) - origin) / 1e6, ended = Number(clockNs(s.endedNs) - origin) / 1e6;
      assert.ok(began >= atMs && ended >= began && ended <= collectedAtMs, "resource counter timestamps escaped collection interval");
      const evidence = `raw.jsonl#resources/${window}/${id}`;
      if (s.unavailable) {
        assert.ok(typeof s.unavailable === "string" && state.Running === false && Date.parse(state.FinishedAt) <= wallAtStart + collectedAtMs,
          "unexplained missing resource evidence");
        return { id, count, atMs: collectedAtMs, running: false, oomKilled: state.OOMKilled, unavailable: s.unavailable, evidence };
      }
      const cpu = Number(/^usage_usec (\d+)$/m.exec(s.cpu)?.[1]), oom = Number(/^oom_kill (\d+)$/m.exec(s.events)?.[1]);
      assert.ok(uint(cpu) && uint(oom) && /^\d+\n?$/.test(s.memory) && uint(Number(s.memory)), "invalid raw cgroup counters");
      assert.equal(s.cpuSeconds, cpu / 1e6); assert.equal(s.memoryBytes, Number(s.memory));
      assert.ok(Array.isArray(s.procs) && s.procs.every((pid) => typeof pid === "string" && /^[1-9]\d*$/.test(pid)), "invalid native PID inventory");
      assert.equal(s.running, s.procs.length > 0); assert.equal(s.oomKilled, oom > 0);
      return { id, count, observedProcessCount: s.procs.length, atMs, running: s.running, oomKilled: s.oomKilled,
        cpuSeconds: s.cpuSeconds, memoryBytes: s.memoryBytes, evidence };
    })];
  }));
}

export function assembleRecovery({ settings, raw, parity, source, cleanup, provenance, lifecycle }) {
  assert.equal(settings.phase, "dependency-recovery"); assert.equal(settings.nativeSource, source);
  assert.ok(source === "api" || source === "fixture");
  assert.ok(settings.case === "direct" || settings.case === "deployed-edge");
  assert.equal(settings.deployment.mode, settings.case);
  assert.ok(!Object.hasOwn(settings, "emissionPlan"), "unexpected legacy probe settings in recovery evidence");
  const budget = JSON.parse(settings.effectiveBudgets);
  assert.deepEqual(budget.dependencyRecovery, recoveryProfile);
  verifyNativeLimits(settings, lifecycle); verifyParity(parity, source);
  assert.deepEqual(raw.map((r) => r.type), ["clock", "resources", "resources", "resources", "dependency-recovery"], "invalid recovery journal rows");
  const [clock, ...rows] = raw, observation = rows.pop();
  assert.deepEqual(rows.map((r) => r.window), windows.map(([name]) => name));
  validateReadReceipts(observation.samples);
  assert.ok(Number.isFinite(observation.restoredAtMs), "missing upstream restore observation");
  const assessment = assessRecovery(observation.samples, { source, restoredAtMs: observation.restoredAtMs });
  assert.ok(!["invalid", "incomplete"].includes(assessment.status), assessment.reason ?? "invalid recovery samples");
  validateUpstream(observation, source, budget.timing.maxStartLagMs);
  const cleanupProof = verifyLifecycle(clock, settings.deployment, lifecycle, provenance, cleanup, observation.upstream.after.observedAtMs);
  const resources = verifyResourceSamples(rows, settings.deployment.processes, lifecycle, clock);
  const { disposition, terminalServices } = terminalRecovery(true, settings.deployment.processes, resources.after, lifecycle, source, settings.terminalHealthPaths);
  const terminal = { healthy: disposition === "recovered", disposition, services: terminalServices };
  return { schema: "native-dependency-recovery-capture/v1", case: settings.case, phase: settings.phase, assessment, resources, terminal,
    deployment: settings.deployment, effectiveBudgets: settings.effectiveBudgets, provenance,
    parity: { status: "passed", evidence: "parity.json" }, cleanup: cleanupProof, upstream: observation.upstream };
}
