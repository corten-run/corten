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
  const awaited = await delayed.capture.stop();
  assert.throws(() => finalizeLoadResourceCapture(awaited, terminal()), /missing scheduled/);
  assert.deepEqual(delayed.argumentsSeen, []);
});

test("disappearance defers to the exact terminal receipt; no required slot or other fault can be ignored", async () => {
  const vanished = Object.assign(new Error("synthetic process vanished"), { code: "ENOENT" });
  for (const fault of [vanished, new LoadResourceLifetimeEnded("cgroup unpopulated")]) {
    const f = fixture({ observations: [info("running")], nextWait: (ms) => ms + 5, collect(args) {
      if (args.sequence === 2) throw fault;
      const at = epoch + 1000 * (args.sequence + 1);
      return { ...args, begin: { at }, end: { at } };
    } });
    await new Promise(setImmediate);
    const result = await f.capture.stop();
    assert.deepEqual(f.ids, [id], "no race against an intermediate Docker status");
    assert.equal(finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(3000), exitCode: 99 })).rows.length, 2);
    for (const ms of [2999, 3000]) assert.equal(finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(ms) })).rows.length, 2);
    for (const ms of [3005, 3900]) {
      assert.throws(() => finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(ms) })),
        (error) => error === fault, "a later finish in the same slot is not evidence of disappearance");
    }
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

test("a later exit during unwind or a wall-clock step cannot excuse disappearance", async () => {
  const fault = Object.assign(new Error("synthetic process vanished"), { code: "ENOENT" });
  for (const jump of [false, true]) {
    let wall = epoch, mono = 0, ended = false;
    const f = startLoadResourceCapture({ id, now: () => wall, monotonic: () => mono,
      async wait(ms) { wall += ms; mono += ms; if (jump && mono === 3000) wall += 200; },
      async inspect() { return info("running"); },
      acquire({ sequence }) {
        if (sequence < 2) return { sequence };
        ended = true; wall += 500; mono += 500;
        throw fault;
      },
    });
    await new Promise(setImmediate);
    const result = await f.stop();
    assert.ok(ended);
    assert.equal(result.capture.rows.length, 2);
    assert.throws(() => finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(jump ? 3100 : 3400) })),
      jump ? /clock discontinuity/ : (error) => error === fault);
  }
});

test("a clock step inside the continuity tolerance cannot make a later exit precede a failed read", async () => {
  const fault = Object.assign(new Error("synthetic process vanished"), { code: "ENOENT" });
  let wall = epoch, mono = 0;
  const f = startLoadResourceCapture({ id, now: () => wall, monotonic: () => mono,
    async wait(ms) { wall += ms; mono += ms; if (mono === 3000) wall++; },
    async inspect() { return info("running"); },
    acquire({ sequence }) {
      if (sequence < 2) return { sequence };
      assert.equal(mono, 3000);
      wall += 9; mono += 10; // Restore the clock after read start.
      throw fault;
    },
  });
  await new Promise(setImmediate);
  const result = await f.stop();
  assert.equal(result.capture.rows.length, 2);
  assert.throws(() => finalizeLoadResourceCapture(result, terminal()), (error) => error === fault);
});

test("a late wake does not acquire or lose an optional slot, but cannot excuse a full slot", async () => {
  let wakes = 0;
  const f = fixture({ observations: [info("running")], nextWait: (ms) => ms + (++wakes === 3 ? 1100 : 0) });
  await new Promise(setImmediate);
  const result = await f.capture.stop();
  assert.deepEqual(f.argumentsSeen.map(({ sequence, at }) => [sequence, at]), [[0, 1000], [1, 2000]]);
  assert.equal(finalizeLoadResourceCapture(result, terminal()).rows.length, 2);
  assert.throws(() => finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(4000) })), /missing scheduled/);
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
