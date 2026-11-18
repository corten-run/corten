export const recoveryProfile = Object.freeze({
  version: "dependency-recovery/v1", intervalMs: 400, timeoutMs: 600,
  beforeMs: 4000, duringMs: 8000, afterMs: 8000, delayMs: 150,
});

const { version, intervalMs, timeoutMs, beforeMs, duringMs, afterMs } = recoveryProfile;
const scheduledRestoreMs = beforeMs + duringMs;
const totalMs = scheduledRestoreMs + afterMs;
export const recoverySchedule = Object.freeze(Array.from({ length: totalMs / intervalMs }, (_, i) => i * intervalMs));

const maxStartLagMs = 200;
const maxRestoreDriftMs = 100;
const sustainedSamples = 5;
const latency = ({ startMs, endMs }) => endMs - startMs;

function summarize(rows, durationMs) {
  const successful = rows.filter(({ ok }) => ok).map(latency).sort((a, b) => a - b);
  return { durationMs, attempts: rows.length, successes: successful.length,
    successfulPerSecond: successful.length * 1000 / durationMs, errors: rows.length - successful.length,
    p95Ms: successful.length ? successful[Math.ceil(successful.length * 0.95) - 1] : null };
}

// The runner supplies one terminal row per slot, with ok meaning validated success before
// the request deadline. Rows may arrive in completion order. Slot cohorts include requests
// that finish across a window boundary or during the bounded drain after the last slot.
// API restore is observed on the same monotonic clock as the requests, not inferred from
// the schedule. The runner must independently establish that it exercised the dependency.
export function assessRecovery(samples, options) {
  const { source, restoredAtMs } = options ?? {};
  const result = { version, source: null, restoredAtMs: null, status: "invalid", reason: null, windows: null, recoveryMs: null };
  const invalid = (reason) => ({ ...result, reason });
  if (source !== "api" && source !== "fixture") return invalid("source must be api or fixture");
  result.source = source;
  if (source !== "fixture" || restoredAtMs != null) {
    if (!Number.isFinite(restoredAtMs) || Math.abs(restoredAtMs - scheduledRestoreMs) > maxRestoreDriftMs) {
      return invalid("restore timestamp must be within 100 ms of the scheduled restore");
    }
    result.restoredAtMs = restoredAtMs;
  }
  if (!Array.isArray(samples) || samples.length > recoverySchedule.length) return invalid("invalid sample list");

  const bySlot = new Array(recoverySchedule.length);
  for (const sample of samples) {
    const { scheduledMs, startMs, endMs, ok } = sample ?? {};
    if (!Number.isInteger(scheduledMs)) return invalid("sample is off the fixed schedule");
    const slot = scheduledMs / intervalMs;
    if (recoverySchedule[slot] !== scheduledMs) return invalid("sample is off the fixed schedule");
    if (bySlot[slot]) return invalid(`duplicate sample at ${scheduledMs} ms`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || typeof ok !== "boolean"
        || startMs < scheduledMs || startMs - scheduledMs > maxStartLagMs || endMs < startMs) {
      return invalid(`invalid outcome or timing at ${scheduledMs} ms`);
    }
    // A timeout callback may be recorded late, but no successful response may exceed the deadline.
    if (latency(sample) > timeoutMs + (ok ? 0 : maxStartLagMs)) return invalid(`request deadline exceeded at ${scheduledMs} ms`);
    bySlot[slot] = sample;
  }
  if (samples.length !== recoverySchedule.length) {
    return { ...result, status: "incomplete", reason: `observed ${samples.length} of ${recoverySchedule.length} slots` };
  }

  const beforeEnd = beforeMs / intervalMs, duringEnd = scheduledRestoreMs / intervalMs;
  const after = bySlot.slice(duringEnd);
  const windows = {
    before: summarize(bySlot.slice(0, beforeEnd), beforeMs),
    during: summarize(bySlot.slice(beforeEnd, duringEnd), duringMs),
    after: summarize(after, afterMs),
  };
  result.windows = windows;
  if (windows.before.errors) return { ...result, status: "baseline-unavailable", reason: "baseline requires all scheduled probes to succeed" };

  // v1 permits 25% or 25 ms above baseline p95, whichever allows more room for jitter.
  // Five adjacent successful slots restore baseline throughput at the same offered rate.
  // This reports the first sustained observation, not a guarantee about later requests.
  const limitMs = Math.max(windows.before.p95Ms * 1.25, windows.before.p95Ms + 25);
  if (source === "fixture") {
    const degraded = [windows.during, windows.after].some(window => window.errors > 0 || window.p95Ms > limitMs);
    return { ...result, status: degraded ? "fixture-degraded" : "fixture-control" };
  }

  let consecutive = 0, lastEndMs = restoredAtMs;
  for (const row of after) {
    if (row.startMs < restoredAtMs || !row.ok || latency(row) > limitMs) {
      consecutive = 0;
      lastEndMs = restoredAtMs;
      continue;
    }
    lastEndMs = Math.max(lastEndMs, row.endMs);
    if (++consecutive === sustainedSamples) return { ...result, status: "recovered", recoveryMs: lastEndMs - restoredAtMs };
  }
  return { ...result, status: "unrecovered" };
}
