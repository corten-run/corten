import assert from "node:assert/strict";
import test from "node:test";
import { finalizeLoadResourceCapture, startLoadResourceCapture } from "./load-resource-capture.mjs";
import { LoadResourceLifetimeEnded, loadResourceCaptureSchema } from "./load-resource-proof.mjs";

const id = "a".repeat(64), epoch = Date.parse("2026-11-24T23:00:00Z"), stamp = (ms) => new Date(epoch + ms).toISOString();
function info(status, edits = {}) {
  return { Id: id, RestartCount: 0, State: { Status: status, Running: status === "running", Pid: status === "running" ? 42 : 0,
    OOMKilled: false, Dead: false, Restarting: false, Paused: false, Error: "", ExitCode: 0,
    StartedAt: stamp(0), FinishedAt: stamp(2999), ...edits } };
}
function terminal(edits = {}) {
  return { containerId: id, status: "exited", running: false, startedAt: stamp(0), finishedAt: "2026-11-24T23:00:03.000500Z",
    oomKilled: false, dead: false, paused: false, restarting: false, restartCount: 0, exitCode: 0, error: "", ...edits };
}

function fixture({ observations = [info("created"), info("running")], collect, nextWait = (ms) => ms } = {}) {
  let now = epoch, capture;
  const argumentsSeen = [], ids = [];
  capture = startLoadResourceCapture({ id, now: () => now, monotonic: () => now - epoch,
    async wait(ms) { now += nextWait(ms); },
    async inspect(exact) { ids.push(exact); return observations.shift(); },
    acquire(args) {
      argumentsSeen.push({ ...args, at: now - epoch });
      return collect ? collect(args, () => capture.stop()) : args;
    },
  });
  return { capture, argumentsSeen, ids };
}

test("created to running obtains the exact PID and samples anchored slots; stop cancels the next wait", async () => {
  const f = fixture({ collect({ sequence }, stop) { if (sequence === 1) void stop(); return { sequence }; } });
  await new Promise(setImmediate);
  assert.deepEqual((await f.capture.stop()).capture, { schema: loadResourceCaptureSchema, live: { id, pid: 42, startedAt: stamp(0) },
    rows: [{ sequence: 0 }, { sequence: 1 }] });
  assert.deepEqual(f.ids, [id, id]);
  assert.deepEqual(f.argumentsSeen, [{ id, pid: 42, sequence: 0, at: 1000 }, { id, pid: 42, sequence: 1, at: 2000 }]);
});

test("early scheduler wake cannot advance acquisition and a missed slot cannot be skipped", async () => {
  const f = fixture({ observations: [info("running")], nextWait: (ms) => Math.min(ms, 128),
    collect(args, stop) { void stop(); return args; } });
  await new Promise(setImmediate);
  await f.capture.stop();
  assert.equal(f.argumentsSeen[0].at, 1000);
  const delayed = fixture({ observations: [info("running")], nextWait: (ms) => ms + 1000 });
  await new Promise(setImmediate);
  assert.match((await delayed.capture.stop()).error.message, /missing or excess/);
  assert.deepEqual(delayed.argumentsSeen, []);
});

test("disappearance defers to the exact terminal receipt; no required slot or other fault can be ignored", async () => {
  const vanished = Object.assign(new Error("synthetic process vanished"), { code: "ENOENT" });
  for (const fault of [vanished, new LoadResourceLifetimeEnded("cgroup unpopulated")]) {
    const f = fixture({ observations: [info("running")], collect(args) {
      if (args.sequence === 2) throw fault;
      const at = epoch + 1000 * (args.sequence + 1);
      return { ...args, begin: { at }, end: { at } };
    } });
    await new Promise(setImmediate);
    const result = await f.capture.stop();
    assert.deepEqual(f.ids, [id], "no race against an intermediate Docker status");
    assert.equal(finalizeLoadResourceCapture(result, terminal()).rows.length, 2);
    assert.equal(finalizeLoadResourceCapture(result, terminal({ exitCode: 99 })).rows.length, 2);
    for (const ms of [2999, 3000]) assert.equal(finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(ms) })).rows.length, 2);
    for (const edits of [{ finishedAt: stamp(4000) }, { startedAt: stamp(1) }, { oomKilled: true },
      { finishedAt: stamp(1999) }, { containerId: "b".repeat(64) }, { running: true }]) {
      assert.throws(() => finalizeLoadResourceCapture(result, terminal(edits)));
    }
  }
  const fault = fixture({ observations: [info("running")], collect() { throw new Error("untrusted memory counter"); } });
  await new Promise(setImmediate);
  const result = await fault.capture.stop();
  assert.throws(() => finalizeLoadResourceCapture(result, terminal()), /untrusted memory counter/);
  assert.deepEqual(fault.ids, [id]);
});

test("a successfully read partial slot with a bracket crossing the exact finish is omitted only from that slot", async () => {
  const f = fixture({ observations: [info("running")], collect({ sequence }, stop) {
    if (sequence === 2) void stop();
    const at = epoch + 1000 * (sequence + 1);
    return { sequence, begin: { at }, end: { at } };
  } });
  await new Promise(setImmediate);
  const result = await f.capture.stop();
  assert.equal(result.capture.rows.length, 3);
  assert.equal(finalizeLoadResourceCapture(result, terminal()).rows.length, 2);
  assert.equal(finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(3001) })).rows.length, 3);
  assert.equal(finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(4000) })).rows.length, 3, "never trim a full slot");
  assert.equal(result.capture.rows.length, 3, "original candidate is not changed");
});
