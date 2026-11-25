import assert from "node:assert/strict";
import test from "node:test";
import { startLoadResourceCapture } from "./load-resource-capture.mjs";
import { loadResourceCaptureSchema } from "./load-resource-proof.mjs";

const id = "a".repeat(64), epoch = Date.parse("2026-11-24T23:00:00Z"), stamp = (ms) => new Date(epoch + ms).toISOString();
function info(status, edits = {}) {
  return { Id: id, RestartCount: 0, State: { Status: status, Running: status === "running", Pid: status === "running" ? 42 : 0,
    OOMKilled: false, Dead: false, Restarting: false, Paused: false, Error: "", ExitCode: 0,
    StartedAt: stamp(0), FinishedAt: stamp(2999), ...edits } };
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
  assert.deepEqual(await f.capture.stop(), { schema: loadResourceCaptureSchema, live: { id, pid: 42, startedAt: stamp(0) },
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
  await assert.rejects(delayed.capture.stop(), /missing or excess/);
  assert.deepEqual(delayed.argumentsSeen, []);
});

test("ENOENT can reconcile only an exact, clean terminal partial slot; other failures are preserved", async () => {
  const vanished = Object.assign(new Error("synthetic process vanished"), { code: "ENOENT" });
  for (const [terminal, accepted] of [
    [info("exited"), true],
    [info("exited", { ExitCode: 99 }), true],
    [info("exited", { FinishedAt: stamp(4000) }), false],
    [info("exited", { StartedAt: stamp(1) }), false],
    [info("exited", { OOMKilled: true }), false],
    [info("exited", { FinishedAt: stamp(3050) }), false],
    [{ ...info("exited"), Id: "b".repeat(64) }, false],
    [info("running"), false],
  ]) {
    const f = fixture({ observations: [info("running"), terminal], collect(args) { if (args.sequence === 2) throw vanished; return args; } });
    await new Promise(setImmediate);
    if (accepted) assert.equal((await f.capture.stop()).rows.length, 2);
    else await assert.rejects(f.capture.stop());
    assert.deepEqual(f.ids, [id, id]);
  }
  const fault = fixture({ observations: [info("running")], collect() { throw new Error("untrusted memory counter"); } });
  await new Promise(setImmediate);
  await assert.rejects(fault.capture.stop(), /untrusted memory counter/);
  assert.deepEqual(fault.ids, [id]);
});
