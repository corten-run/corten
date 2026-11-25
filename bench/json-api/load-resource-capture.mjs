import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { timestampNs } from "./fixed-stream.mjs";
import { acquireLoadResources, clockDelta, LoadResourceLifetimeEnded, loadResourceCaptureSchema, loadResourceClockToleranceMs, loadResourceFirstSlot, loadResourcePeriodMs } from "./load-resource-proof.mjs";

const maxRows = 360;
const msNs = (ms) => BigInt(ms) * 1_000_000n;
const delay = (ms, signal) => sleep(ms, undefined, { signal });

function stateOf(info, id) {
  const s = info?.State;
  assert.ok(info?.Id === id && info.RestartCount === 0 && s && s.OOMKilled === false && s.Dead === false
    && s.Restarting === false && s.Paused === false && s.Error === "", "invalid exact load container state during resource capture");
  return s;
}

// Only the initial observation uses Docker. During the window, acquisition
// brackets the PID and cgroup identities; exact terminal replay settles the edge.
export function startLoadResourceCapture({ id, inspect, acquire = acquireLoadResources,
  now = Date.now, monotonic = () => performance.now(), wait = delay }) {
  assert.ok(typeof id === "string" && /^[a-f0-9]{64}$/.test(id), "load resource capture requires an exact container ID");
  const controller = new AbortController(), { signal } = controller;
  const capture = { schema: loadResourceCaptureSchema, live: null, rows: [] };
  const clock = () => ({ at: now(), monotonic: monotonic() });
  async function waitUnlessStopped(ms) {
    try { await wait(ms, signal); }
    catch (error) { if (!signal.aborted || error?.name !== "AbortError") throw error; }
  }
  async function collect() {
    const initial = clock(), deadline = initial.monotonic + 25_000;
    while (!signal.aborted && monotonic() < deadline) {
      const state = stateOf(await inspect(id), id);
      if (state.Status === "running" && state.Running === true && state.ExitCode === 0 && Number.isSafeInteger(state.Pid) && state.Pid > 0) {
        capture.live = { id, startedAt: state.StartedAt, pid: state.Pid };
        break;
      }
      assert.ok(state.Status === "created" && state.Running === false && state.Pid === 0, "load container did not reach an observable running state");
      await waitUnlessStopped(100);
    }
    assert.ok(capture.live, "load resources lack a live Docker observation");
    const firstAt = loadResourceFirstSlot(capture.live.startedAt);
    while (!signal.aborted) {
      const sequence = capture.rows.length, slot = firstAt + sequence * loadResourcePeriodMs;
      let remaining;
      while (!signal.aborted && (remaining = slot - now()) > 0) await waitUnlessStopped(remaining);
      if (signal.aborted) break;
      const begin = clock();
      assert.ok(sequence < maxRows, "excess scheduled load acquisition");
      if (begin.at >= slot + loadResourcePeriodMs)
        return { capture, missed: { sequence, error: new Error("missing scheduled load acquisition") } };
      let row;
      try { row = acquire({ id, pid: capture.live.pid, sequence }); }
      catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof LoadResourceLifetimeEnded)) throw error;
        clockDelta(initial, begin);
        clockDelta(begin, clock());
        return { capture, ending: { sequence, begin: begin.at, error } };
      }
      capture.rows.push(row);
    }
    return { capture };
  }
  // A fast sampler failure belongs to stop(), which the phase always joins;
  // do not leave an unhandled rejection while the native command is active.
  const settled = collect().catch((error) => ({ capture, error }));
  return { async stop() {
    controller.abort();
    return settled;
  } };
}

export function finalizeLoadResourceCapture({ capture, ending, missed, error }, terminal) {
  if (error) throw error;
  assert.ok(terminal && capture?.live && terminal.containerId === capture.live.id
    && terminal.startedAt === capture.live.startedAt && terminal.status === "exited" && terminal.running === false
    && terminal.oomKilled === false && terminal.dead === false && terminal.paused === false && terminal.restarting === false
    && terminal.restartCount === 0 && terminal.error === "" && [0, 99].includes(terminal.exitCode),
  "load capture lacks the exact clean terminal lifetime");
  const firstAt = loadResourceFirstSlot(capture.live.startedAt), finished = timestampNs(terminal.finishedAt);
  const span = finished - msNs(firstAt), period = msNs(loadResourcePeriodMs);
  const stopped = ending ?? missed;
  if (span < 0n) {
    if (stopped) throw stopped.error;
    return capture;
  }
  const full = Number(span / period), partial = span % period !== 0n;
  const slot = firstAt + full * loadResourcePeriodMs;
  // A scheduling miss acquired nothing. Only slots that were never required may be absent.
  if (stopped && (stopped.sequence < full || stopped.sequence > full + Number(partial) || capture.rows.length !== stopped.sequence))
    throw stopped.error;
  if (ending) {
    const attemptedSlot = firstAt + ending.sequence * loadResourcePeriodMs;
    // A disappearance while reading is not an exit observation. Allow for the
    // checked wall/monotonic discrepancy at read start and Date.now rounding.
    const earliest = ending.begin - loadResourceClockToleranceMs - 1;
    if (ending.begin < attemptedSlot || ending.begin >= attemptedSlot + loadResourcePeriodMs
      || finished > msNs(earliest)) throw ending.error;
  }
  const tail = capture.rows.at(-1);
  // A genuine read in the terminal partial slot can round past the recorded
  // exit. Do not publish that optional read or remove any earlier/full slot.
  if (partial && capture.rows.length === full + 1 && tail?.sequence === full
    && tail.begin.at >= slot && tail.end.at < slot + loadResourcePeriodMs && msNs(tail.end.at + 1) > finished)
    return { ...capture, rows: capture.rows.slice(0, -1) };
  return capture;
}
