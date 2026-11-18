import assert from "node:assert/strict";
import test from "node:test";
import { assessRecovery, recoveryProfile, recoverySchedule } from "./dependency-recovery-contract.mjs";

const api = { source: "api", restoredAtMs: 12000 };
const fixture = { source: "fixture" };
const row = (scheduledMs, { lag = 0, duration = 20, ok = true } = {}) => {
  const startMs = scheduledMs + lag;
  return { scheduledMs, startMs, endMs: startMs + duration, ok };
};
const run = (outcome = () => undefined) => recoverySchedule.map(ms => row(ms, outcome(ms)));

test("v1 fixes the bounded profile and all 50 scheduled slots", () => {
  assert.deepEqual(recoveryProfile, { version: "dependency-recovery/v1", intervalMs: 400, timeoutMs: 600,
    beforeMs: 4000, duringMs: 8000, afterMs: 8000, delayMs: 150 });
  assert.ok(Object.isFrozen(recoveryProfile) && Object.isFrozen(recoverySchedule));
  assert.deepEqual(recoverySchedule, Array.from({ length: 50 }, (_, i) => i * 400));
});

test("counts by scheduled cohort and reports successful latency by nearest rank", () => {
  const result = assessRecovery(run(ms => {
    if (ms === 3600 || ms === 19600) return { duration: 450 }; // Finish in the next window or drain.
    if (ms === 4000) return { duration: 630, ok: false }; // Timeout callback returns late.
    if (ms >= 4000 && ms < 12000) return { duration: 170 };
  }).reverse(), api);
  assert.equal(result.version, recoveryProfile.version);
  assert.equal(result.source, "api");
  assert.equal(result.status, "recovered");
  assert.deepEqual(result.windows, {
    before: { durationMs: 4000, attempts: 10, successes: 10, successfulPerSecond: 2.5, errors: 0, p95Ms: 450 },
    during: { durationMs: 8000, attempts: 20, successes: 19, successfulPerSecond: 2.375, errors: 1, p95Ms: 170 },
    after: { durationMs: 8000, attempts: 20, successes: 20, successfulPerSecond: 2.5, errors: 0, p95Ms: 20 },
  });
});

test("observes recovery at completion of the first qualifying streak begun after actual restore", () => {
  const result = assessRecovery(run(ms => ms === 12000 ? { duration: 40 } : undefined), { ...api, restoredAtMs: 12030 });
  // The 0th after request was fast enough and finished after restore, but started before it.
  assert.equal(result.restoredAtMs, 12030);
  assert.equal(result.status, "recovered");
  assert.equal(result.recoveryMs, 14020 - 12030);
});

test("a slow response breaks the streak even when it is a validated success", () => {
  const result = assessRecovery(run(ms => {
    if (ms === 13600) return { duration: 46 }; // Above the baseline's 45 ms limit; break the streak.
    if (ms === 14000) return { duration: 45 }; // The limit is inclusive.
    if (ms === 15600) return { lag: 30, duration: 22 };
  }), api);
  assert.equal(result.status, "recovered");
  assert.equal(result.recoveryMs, 15652 - 12000);
});

test("uses the relative allowance for a slower baseline and requires adjacent slots", () => {
  const result = assessRecovery(run(ms => {
    if (ms < 4000) return { duration: 160 };
    if (ms === 12800) return { duration: 20, ok: false };
    if (ms >= 12000) return { duration: 200 };
  }), api);
  assert.equal(result.status, "recovered");
  assert.equal(result.recoveryMs, 14800 + 200 - 12000);
  assert.equal(result.windows.after.errors, 1);
});

test("recovery cannot precede completion of an earlier overlapping probe in the streak", () => {
  const result = assessRecovery(run(ms => {
    if (ms < 4000) return { duration: 480 };
    if (ms === 13200) return { duration: 600 }; // Ends after the fifth probe, scheduled at 13600.
  }), api);
  assert.equal(result.status, "recovered");
  assert.equal(result.recoveryMs, 1800);
});

test("complete evidence can show no recovery without inventing a time or successful p95", () => {
  const result = assessRecovery(run(ms => ms >= 12000 ? { duration: 600, ok: false } : undefined), api);
  assert.equal(result.status, "unrecovered");
  assert.equal(result.recoveryMs, null);
  assert.deepEqual(result.windows.after,
    { durationMs: 8000, attempts: 20, successes: 0, successfulPerSecond: 0, errors: 20, p95Ms: null });
  const tooSlow = assessRecovery(run(ms => ms >= 12000 ? { duration: 46 } : undefined), api);
  assert.equal(tooSlow.windows.after.successfulPerSecond, 2.5);
  assert.equal(tooSlow.status, "unrecovered");
});

test("a fixture is a bypass control, not recovered service", () => {
  for (const options of [fixture, { ...fixture, restoredAtMs: 12000 }]) {
    const result = assessRecovery(run(), options);
    assert.equal(result.status, "fixture-control");
    assert.equal(result.recoveryMs, null);
    assert.equal(result.windows.during.successfulPerSecond, 2.5);
  }
  for (const outcome of [{ duration: 170 }, { ok: false }]) {
    const result = assessRecovery(run(ms => {
      if (ms >= 4000 && ms < 12000) return outcome;
    }), fixture);
    assert.equal(result.status, "fixture-degraded");
    assert.equal(result.recoveryMs, null);
  }
});

test("a baseline error leaves measured windows but no basis for a recovery time", () => {
  const result = assessRecovery(run(ms => ms === 0 ? { ok: false } : undefined), api);
  assert.equal(result.status, "baseline-unavailable");
  assert.equal(result.windows.before.successfulPerSecond, 2.25);
  assert.equal(result.recoveryMs, null);
});

test("a truncated run yields no metrics or recovery claim", () => {
  for (const samples of [[], run().slice(0, -1)]) {
    const result = assessRecovery(samples, api);
    assert.equal(result.status, "incomplete");
    assert.equal(result.reason, `observed ${samples.length} of 50 slots`);
    assert.equal(result.windows, null);
    assert.equal(result.recoveryMs, null);
  }
});

test("invalid input cannot masquerade as a complete schedule or a service failure", () => {
  const [first, ...rest] = run();
  for (const [candidate, options] of [
    [[first, first, ...rest.slice(1)], api],
    [[row(1), ...rest], api],
    [[row(0, { lag: -1 }), ...rest], api],
    [[row(0, { lag: 201 }), ...rest], api],
    [[row(0, { duration: -1 }), ...rest], api],
    [[row(0, { duration: 601 }), ...rest], api],
    [[row(0, { duration: 801, ok: false }), ...rest], api],
    [[{ ...first, endMs: Infinity }, ...rest], api],
    [[{ ...first, ok: null }, ...rest], api],
    [run(), { ...api, restoredAtMs: 12101 }],
    [run(), { source: "api" }],
    [run(), { source: "unknown", restoredAtMs: 12000 }],
    [null, api],
  ]) {
    const result = assessRecovery(candidate, options);
    assert.equal(result.status, "invalid");
    assert.match(result.reason, /\S/);
    assert.equal(result.windows, null);
    assert.equal(result.recoveryMs, null);
  }
});
