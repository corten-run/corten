import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { timestampNs } from "./fixed-stream.mjs";
import { acquireLoadResources, LoadProcessAbsentBeforeRead, LoadProcessExitedBeforeCounters, loadResourceCaptureSchema, loadResourceFirstSlot, loadResourceInterval, loadResourcePeriodMs } from "./load-resource-proof.mjs";

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
  async function waitUnlessStopped(ms) {
    try { await wait(ms, signal); }
    catch (error) { if (!signal.aborted || error?.name !== "AbortError") throw error; }
  }
  async function collect() {
    const deadline = monotonic() + 25_000;
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
      assert.ok(sequence < maxRows, "excess scheduled load acquisition");
      if (now() >= slot + loadResourcePeriodMs)
        return { capture, missed: { sequence, error: new Error("missing scheduled load acquisition") } };
      try { capture.rows.push(acquire({ id, pid: capture.live.pid, sequence })); }
      catch (error) {
        if (error instanceof LoadProcessExitedBeforeCounters) {
          const prior = capture.rows.at(-1)?.after;
          if (!prior || prior.processObject !== error.processObject || prior.startTicks !== error.startTicks) throw error;
          // No counters were read. The ordinary exact terminal receipt decides
          // if this was an optional tail; every full slot is still required.
          return { capture, missed: { sequence, error } };
        }
        if (!(error instanceof LoadProcessAbsentBeforeRead)) throw error;
        // No resource read began. An exact clean exit corroborates the missing
        // PID independently of the relative wall-clock readings. Replay still
        // requires every full slot and the later terminal receipt must agree.
        const state = stateOf(await inspect(id), id);
        if (state.Status !== "exited" || state.Running !== false || state.Pid !== 0
          || state.StartedAt !== capture.live.startedAt || ![0, 99].includes(state.ExitCode)) throw error;
        timestampNs(state.FinishedAt);
        return { capture, missed: { sequence, error, exit: { finishedAt: state.FinishedAt, exitCode: state.ExitCode } } };
      }
    }
    return { capture };
  }
  // A fast sampler failure belongs to stop(), which the phase always joins;
  // do not leave an unhandled rejection while the native command is active.
  const settled = collect().catch((error) => ({ capture, error }));
  return { requestStop() { controller.abort(); }, async stop() {
    controller.abort();
    return settled;
  } };
}

export function finalizeLoadResourceCapture({ capture, missed, error }, terminal) {
  if (error) throw error;
  assert.ok(terminal && capture?.live && terminal.containerId === capture.live.id
    && terminal.startedAt === capture.live.startedAt && terminal.status === "exited" && terminal.running === false
    && terminal.oomKilled === false && terminal.dead === false && terminal.paused === false && terminal.restarting === false
    && terminal.restartCount === 0 && terminal.error === "" && [0, 99].includes(terminal.exitCode),
  "load capture lacks the exact clean terminal lifetime");
  if (missed?.exit && (terminal.finishedAt !== missed.exit.finishedAt || terminal.exitCode !== missed.exit.exitCode)) throw missed.error;
  const firstAt = loadResourceFirstSlot(capture.live.startedAt), finished = timestampNs(terminal.finishedAt);
  const span = finished - msNs(firstAt), period = msNs(loadResourcePeriodMs);
  if (span < 0n) {
    if (missed) throw missed.error;
    return capture;
  }
  const full = Number(span / period), partial = span % period !== 0n;
  const slot = firstAt + full * loadResourcePeriodMs;
  // A scheduling miss acquired nothing. Only slots that were never required may be absent.
  if (missed && (missed.sequence < full || missed.sequence > full + Number(partial) || capture.rows.length !== missed.sequence))
    throw missed.error;
  const tail = capture.rows.at(-1);
  // Only a read that could have begun before exit can be omitted. Its
  // continuity still matters even when its CPU and memory cannot be used.
  if (partial && capture.rows.length === full + 1 && tail?.sequence === full
    && tail.begin.at >= slot && tail.end.at < slot + loadResourcePeriodMs && msNs(tail.end.at + 1) > finished) {
    assert.ok(msNs(tail.begin.at) < finished, "load acquisition began after container exit");
    const previous = capture.rows.at(-2);
    if (previous) loadResourceInterval(previous, tail);
    return { ...capture, rows: capture.rows.slice(0, -1) };
  }
  return capture;
}
