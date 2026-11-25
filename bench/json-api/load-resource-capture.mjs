import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { timestampNs } from "./fixed-stream.mjs";
import { acquireLoadResources, loadResourceCaptureSchema, loadResourceFirstSlot, loadResourcePeriodMs } from "./load-resource-proof.mjs";

const maxRows = 360;
const msNs = (ms) => BigInt(ms) * 1_000_000n;
const delay = (ms, signal) => sleep(ms, undefined, { signal });

function stateOf(info, id) {
  const s = info?.State;
  assert.ok(info?.Id === id && info.RestartCount === 0 && s && s.OOMKilled === false && s.Dead === false
    && s.Restarting === false && s.Paused === false && s.Error === "", "invalid exact load container state during resource capture");
  return s;
}

// Only the initial and ENOENT reconciliation observations use Docker. During
// the window, the acquisition itself brackets the PID and cgroup identities.
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
      const begin = now();
      assert.ok(sequence < maxRows && begin < slot + loadResourcePeriodMs, "missing or excess scheduled load acquisition");
      let row;
      try { row = acquire({ id, pid: capture.live.pid, sequence }); }
      catch (error) {
        const end = now();
        if (error?.code !== "ENOENT") throw error;
        const terminal = stateOf(await inspect(id), id);
        if (terminal.Status !== "exited" || terminal.Running !== false || terminal.Pid !== 0 || ![0, 99].includes(terminal.ExitCode)
          || terminal.StartedAt !== capture.live.startedAt) throw error;
        const finished = timestampNs(terminal.FinishedAt);
        // ENOENT alone is not a terminal observation. Only the same load's
        // final partial slot may disappear; replay still requires all full slots.
        if (finished <= timestampNs(capture.live.startedAt)
          || finished >= msNs(slot + loadResourcePeriodMs) || finished >= msNs(end + 1)) throw error;
        break;
      }
      capture.rows.push(row);
    }
    return capture;
  }
  // A fast sampler failure belongs to stop(), which the phase always joins;
  // do not leave an unhandled rejection while the native command is active.
  const settled = collect().then((value) => ({ value }), (error) => ({ error }));
  return { async stop() {
    controller.abort();
    const result = await settled;
    if ("error" in result) throw result.error;
    return result.value;
  } };
}
