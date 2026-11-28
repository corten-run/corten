import assert from "node:assert/strict";
import test from "node:test";
import { finalizeLoadResourceCapture, startLoadResourceCapture } from "./load-resource-capture.mjs";
import { acquireLoadResources, LoadResourceLifetimeEnded, loadResourceCaptureSchema, replayScheduledLoadResources } from "./load-resource-proof.mjs";

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

test("a failed resource read is never waived by a clean terminal receipt", async () => {
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
    assert.equal(result.capture.rows.length, 2);
    for (const ms of [2999, 3000, 3005, 3900]) {
      assert.throws(() => finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(ms) })),
        (error) => error === fault, "exit from either side of the failed read is not a substitute for it");
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

test("a pre-read absent PID plus matching Docker exit permits only the unneeded tail", async () => {
  const { LoadProcessAbsentBeforeRead } = await import("./load-resource-proof.mjs");
  const beforeRead = new LoadProcessAbsentBeforeRead("load PID absent before opening its process directory");
  for (const [finish, proof, qualifies] of [
    [2999, info("exited"), true],
    [4000, info("exited", { FinishedAt: stamp(4000) }), false],
    [2999, info("running"), false],
    [2999, info("exited", { StartedAt: stamp(1) }), false],
    [2999, { ...info("exited"), Id: "b".repeat(64) }, false],
    [2998, info("exited"), false],
  ]) {
    const f = fixture({ observations: [info("running"), proof], collect({ sequence }) {
      if (sequence === 2) throw beforeRead;
      return { sequence, begin: { at: epoch + (sequence + 1) * 1000 }, end: { at: epoch + (sequence + 1) * 1000 } };
    } });
    await new Promise(setImmediate);
    const result = await f.capture.stop();
    const after = terminal({ finishedAt: stamp(finish) });
    assert.deepEqual(f.ids, [id, id], "only the exact container is inspected at the ambiguous edge");
    if (qualifies) assert.equal(finalizeLoadResourceCapture(result, after).rows.length, 2);
    else assert.throws(() => finalizeLoadResourceCapture(result, after));
  }
});

test("the same process already at exit can omit only an optional final acquisition", async () => {
  const participant = { pid: 42, processObject: "1:2", startTicks: "3", groupObject: "4:5",
    path: `/system.slice/docker-${id}.scope`, mount: "36 27 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup rw", populated: true };
  for (const [label, identity, ending, accepted] of [
    ["optional tail", {}, { finishedAt: stamp(3004) }, true],
    ["missing full slot", {}, { finishedAt: stamp(4000) }, false],
    ["different process object", { processObject: "1:9" }, { finishedAt: stamp(3004) }, false],
    ["different process start", { startTicks: "4" }, { finishedAt: stamp(3004) }, false],
    ["wrong container", {}, { finishedAt: stamp(3004), containerId: "b".repeat(64) }, false],
    ["unclean end", {}, { finishedAt: stamp(3004), oomKilled: true }, false],
  ]) {
    const f = fixture({ observations: [info("running")], collect(args) {
      const monotonic = (args.sequence + 1) * 1000, at = epoch + monotonic;
      const clock = { at, monotonic };
      if (args.sequence < 2) return { sequence: args.sequence, begin: clock, end: clock, before: participant, after: participant,
        usageUsec: 1000 * args.sequence, memoryCurrent: 4096, inactiveFile: 0 };
      return acquireLoadResources(args, {
        clock: () => clock,
        withProcess(pid, read) {
          assert.equal(pid, 42);
          return read({
            identity: () => identity.processObject ?? participant.processObject,
            read(file) {
              assert.equal(file, "stat", "no cgroup or counters can be read");
              return `42 (exiting k6) Z ${Array(18).fill(0).join(" ")} ${identity.startTicks ?? participant.startTicks} 0\n`;
            },
          });
        },
        withGroup() { assert.fail("the opening process read failed before any counters"); },
      });
    } });
    await new Promise(setImmediate);
    const result = await f.capture.stop(), life = terminal(ending);
    assert.deepEqual(f.ids, [id], "the already required terminal observation corroborates the exit");
    if (accepted) {
      const saved = finalizeLoadResourceCapture(result, life);
      assert.equal(replayScheduledLoadResources(saved, life, { memoryBytes: 8192, quota: 4 }).samples, 2, label);
      assert.equal(result.capture.rows.length, 2, "no synthetic row is saved");
    } else assert.throws(() => finalizeLoadResourceCapture(result, life), undefined, label);
  }
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
      (error) => error === fault);
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
  // Docker's clock can step after the failed acquisition and its unwind, too.
  assert.throws(() => finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(2990) })),
    (error) => error === fault);
});

test("attached client exit stops reads before the pipe join", async () => {
  let at = epoch, signal, wake;
  const reads = [];
  const observer = startLoadResourceCapture({ id, now: () => at, monotonic: () => at - epoch,
    async inspect() { return info("running"); },
    async wait(ms, current) {
      if (at < epoch + 2000) { at += ms; return; }
      signal = current; await new Promise((resolve) => { wake = resolve; });
    },
    acquire({ sequence }) { reads.push(sequence); return { sequence }; },
  });
  await new Promise(setImmediate);
  assert.deepEqual(reads, [0, 1]);
  observer.requestStop();
  assert.equal(signal.aborted, true);
  at += 1000; wake();
  assert.equal(finalizeLoadResourceCapture(await observer.stop(), terminal()).rows.length, 2);
  assert.deepEqual(reads, [0, 1]);
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
  const participant = { pid: 42, processObject: "1:2", startTicks: "3", groupObject: "4:5",
    path: `/system.slice/docker-${id}.scope`, mount: "36 27 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup rw", populated: true };
  const f = fixture({ observations: [info("running")], collect({ sequence }, stop) {
    if (sequence === 2) void stop();
    const monotonic = 1000 * (sequence + 1), at = epoch + monotonic;
    return { sequence, begin: { at, monotonic }, end: { at, monotonic }, before: participant, after: participant,
      usageUsec: 1000 * sequence, memoryCurrent: 4096, inactiveFile: 0 };
  } });
  await new Promise(setImmediate);
  const result = await f.capture.stop();
  assert.equal(result.capture.rows.length, 3);
  assert.equal(finalizeLoadResourceCapture(result, terminal()).rows.length, 2);
  assert.equal(finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(3001) })).rows.length, 3);
  assert.equal(finalizeLoadResourceCapture(result, terminal({ finishedAt: stamp(4000) })).rows.length, 3, "never trim a full slot");
  assert.equal(result.capture.rows.length, 3, "original candidate is not changed");
  const atExit = structuredClone(result), edge = atExit.capture.rows.at(-1);
  edge.begin.at += 100; edge.end.at += 100; edge.begin.monotonic += 100; edge.end.monotonic += 100;
  assert.throws(() => finalizeLoadResourceCapture(atExit, terminal({ finishedAt: stamp(3100) })), /began after container exit/);
  for (const [fault, edit, message] of [
    ["wholly after exit", (tail) => { tail.begin.at++; tail.end.at++; tail.begin.monotonic++; tail.end.monotonic++; }, /began after container exit/],
    ["new cgroup", (tail) => { tail.before.groupObject = "4:6"; }, /identity changed between acquisitions/],
    ["counter reset", (tail) => { tail.usageUsec = 0; }, /reset CPU counter/],
    ["clock jump", (tail) => { tail.begin.monotonic += 20; tail.end.monotonic += 20; }, /clock discontinuity/],
  ]) {
    const invalid = structuredClone(result), tail = invalid.capture.rows.at(-1);
    // Separate this sample's identities from earlier rows, keeping its own bracket intact.
    tail.before = tail.after = { ...tail.before };
    edit(tail);
    assert.throws(() => finalizeLoadResourceCapture(invalid, terminal()), message, fault);
  }
});
