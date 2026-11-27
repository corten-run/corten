import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { hostDurableWriter, storageLimits } from "./host-durable-writer.mjs";
import { deferred, ioError, record, storageControl } from "./test-fixtures/host-durable-writer-control.mjs";
import { samplingControl } from "./test-fixtures/host-lifetime-storage.mjs";
import { beginLifetime } from "./host-lifetime.mjs";
import { supervise } from "./process.mjs";
import { fakeChild } from "./test-fixtures/process.mjs";

const isRecord = (path) => path.endsWith(".json") && path.replaceAll("\\", "/").includes("/processes/");
const isSamples = (path) => path.endsWith("samples.jsonl");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of ["cancel", "deadline", "close", "exit"]) for (const failure of [false, true]) test(`startup ${mode} owns delayed sample open through ${failure ? "failure" : "success"} without late attachment`, { timeout: 5000 }, async (t) => {
  const f = await samplingControl(t); await f.finish(); f.removed = false;
  const directory = join(f.temporary, "abandoned-startup"), abort = new AbortController();
  const pause = f.pause("open", isSamples), beforeOpen = f.before;
  f.before = async (...args) => { await beforeOpen(...args); if (failure && args[0] === "open" && isSamples(args[1])) throw ioError(); };
  let observer, setupFinished = false, setupSignal, intervals = 0, starts = 0;
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (...args) => { intervals++; return interval(...args); });
  const child = fakeChild(() => { starts++; }); child.pid = 4242;
  const send = child.send.bind(child);
  child.send = (message, callback) => {
    if (message.type === "cancel") { callback?.(null); queueMicrotask(() => child.close(0)); return; }
    return send(message, callback);
  };
  t.mock.method(childProcess, "spawn", () => child);
  let doneSetup;
  const setupDone = new Promise((resolve) => { doneSetup = resolve; });
  const deadlines = mode === "deadline" ? { readyMs: 40, runMs: 10000, stopMs: 40, killMs: 40 } : undefined;
  if (deadlines) t.mock.timers.enable({ apis: ["setTimeout"] });
  let returned = false;
  const running = supervise({ executable: "node", argv: ["synthetic-startup"], shell: false }, {
    cwd: tmpdir(), env: {}, signal: abort.signal, log() {},
    async onStart(pid, ownedSignal) {
      setupSignal = ownedSignal;
      try {
        observer = await beginLifetime({ campaign: "r21-0000000000000001",
          binding: { request: { group: "client-heavy", round: "startup-control", commit: "a".repeat(40) } },
          invocation: { executable: "node", argv: ["synthetic-startup"] }, directory, command: 1, pid,
          signal: abort.signal, startupSignal: ownedSignal });
        await observer.attach(pid);
      } catch (error) { observer?.dispose(); throw error; }
      finally { setupFinished = true; doneSetup(); }
    },
  }, deadlines)
    .then((result) => { returned = true; return result; });
  try {
    await pause.entered;
    if (mode === "cancel") abort.abort();
    if (mode === "close") child.close(0);
    if (mode === "exit") { child.emit("exit", 0, null); child.stdout.end(); child.stderr.end(); }
    if (deadlines) {
      // Expire startup with open pending, regardless of how long it took to get here.
      assert.equal(setupSignal.aborted, false);
      t.mock.timers.tick(deadlines.readyMs);
      const result = await running;
      assert.equal(result.success, false); assert.equal(result.cancelled, true);
      assert.equal(setupFinished, false, "deadline cannot pretend the outstanding open completed");
      assert.match(result.error, /host observation setup/);
    } else {
      await delay(15); assert.equal(returned, false, "child exit/cancel must not detach a setup still inside its deadline");
      assert.equal(setupFinished, false);
    }
    assert.equal(setupSignal.aborted, true); assert.equal(observer, undefined);
    assert.equal(f.members.length, 0); assert.equal(intervals, 0);
    pause.release(); await setupDone;
    if (mode === "exit") child.emit("close", 0, null);
    const result = await running;
    assert.equal(result.success, false);
    if (mode === "cancel") assert.equal(result.cancelled, true);
    // A completed fs.open is followed by FIFO cleanup, not by attachment.
    if (deadlines) t.mock.timers.reset();
    for (let i = 0; i < 100 && f.live.size; i++) await delay(1);
    assert.equal(f.live.size, 0); assert.equal(observer, undefined);
    assert.equal(starts, 0); assert.equal(intervals, 0); assert.equal(f.members.length, 0);
    assert.equal(fs.existsSync(join(directory, "terminal.json")), false); assert.equal(f.removed, false);
  } finally {
    pause.release(); await setupDone;
    if (mode === "exit") child.emit("close", 0, null);
    await running;
  }
});

test("an observer returned before attach is disposed when startup is cancelled", async (t) => {
  const f = await samplingControl(t); await f.finish(); f.removed = false;
  const abort = new AbortController(), directory = join(f.temporary, "pre-attach");
  const observer = await beginLifetime({ campaign: "r21-0000000000000001",
    binding: { request: { group: "client-heavy", round: "startup-control", commit: "a".repeat(40) } },
    invocation: { executable: "node", argv: ["synthetic-startup"] }, directory, command: 1, pid: 4242, startupSignal: abort.signal });
  abort.abort(); await assert.rejects(observer.attach(4242)); await observer.pendingStorage;
  assert.equal(f.live.size, 0); assert.equal(f.members.length, 0);
  assert.equal(fs.existsSync(join(directory, "terminal.json")), false); assert.equal(f.removed, false);
});

test("cancellation during initial attachment drain stops capture and retains pending fsync ownership", async (t) => {
  const f = await samplingControl(t); await f.finish(); f.removed = false;
  const abort = new AbortController(), directory = join(f.temporary, "attaching");
  const observer = await beginLifetime({ campaign: "r21-0000000000000001",
    binding: { request: { group: "client-heavy", round: "startup-control", commit: "a".repeat(40) } },
    invocation: { executable: "node", argv: ["synthetic-startup"] }, directory, command: 1, pid: 4242, startupSignal: abort.signal });
  const pause = f.pause("sync", isRecord), attaching = observer.attach(4242);
  attaching.catch(() => {});
  try {
    await pause.entered; abort.abort();
    const reads = f.procReads;
    await delay(125); assert.equal(f.procReads, reads, "abandoned startup interval is stopped");
    assert.ok(f.live.size > 0, "an outstanding fsync is still owned, not cancelled");
    assert.equal(fs.existsSync(join(directory, "terminal.json")), false);
    pause.release(); await assert.rejects(attaching); await observer.pendingStorage;
    assert.equal(f.live.size, 0); assert.equal(f.removed, false);
    await assert.rejects(observer.finish(f.result));
    assert.equal(fs.existsSync(join(directory, "terminal.json")), false);
  } finally { pause.release(); await attaching.catch(() => {}); await observer.pendingStorage; }
});

for (const step of ["write", "sync", "close", "directory-sync"]) test(`referencing samples cannot overtake a paused record ${step}`, {
  skip: process.platform === "win32" && step === "directory-sync" && "Windows does not fsync directories",
}, async (t) => {
  const f = await storageControl(t);
  const pause = f.pause(step === "directory-sync" ? "sync" : step,
    step === "directory-sync" ? (p) => p === join(f.directory, "processes") : isRecord);
  f.writer.enqueue([record(1), record(2)], "first\n");
  await pause.entered;
  const capturedAt = [];
  const timer = setInterval(() => { capturedAt.push(Date.now()); f.writer.enqueue([], "next\n"); }, 10);
  await delay(65); clearInterval(timer);
  assert.ok(capturedAt.length >= 2, "the event loop keeps capturing while storage is pending");
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), "");
  assert.ok(f.writer.state().frames >= 3); assert.equal(f.writer.state().complete, false);
  pause.release(); const stored = await f.writer.finish();
  assert.equal(stored.samples, capturedAt.length + 1);
  assert.equal(fs.readFileSync(join(f.directory, "processes", `${record(1).key}.json`), "utf8"), record(1).value);
  assert.equal(fs.readFileSync(join(f.directory, "processes", `${record(2).key}.json`), "utf8"), record(2).value);
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), `first\n${"next\n".repeat(capturedAt.length)}`);
  const append = f.trace.findIndex((s) => s.name === "write" && isSamples(s.path));
  assert.equal(f.trace.slice(0, append).filter((s) => s.name === "sync" && s.phase === "end" && isRecord(s.path)).length, 2);
  if (process.platform !== "win32") assert.equal(f.trace.slice(0, append).filter((s) => s.name === "sync" && s.phase === "end" && s.path === join(f.directory, "processes")).length, 2);
  assert.ok(f.maximumFiles <= 2); assert.equal(f.writer.state().openFiles, 0); assert.equal(f.live.size, 0);
});

test("legitimate short writes preserve every initial byte and sample byte", async (t) => {
  const f = await storageControl(t);
  f.before = (operation, _path, args) => { if (operation === "write") args[2] = Math.min(args[2], 3); };
  f.writer.enqueue([record(1)], "a complete sample\n");
  await f.writer.finish();
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), "a complete sample\n");
  assert.equal(fs.readFileSync(join(f.directory, "processes", `${record(1).key}.json`), "utf8"), record(1).value);
});

for (const [name, operation, matches, stage] of [
  ["record open", "open", isRecord], ["record write", "write", isRecord], ["record sync", "sync", isRecord],
  ["record close", "close", isRecord, "process-record-close"], ["process directory sync", "sync", (p) => p.endsWith("processes")],
  ["process directory close", "close", (p) => p.endsWith("processes"), "process-directory-close"],
  ["sample write", "write", isSamples], ["sample sync", "sync", isSamples], ["sample close", "close", isSamples],
  ["record verification", "readFile", isRecord],
  ["sample directory sync", "sync", (p) => p.endsWith("host")],
  ["sample directory close", "close", (p) => p.endsWith("host"), "sample-directory-close"],
]) test(`${name} failure is sticky, sanitized and releases owned handles`, {
  skip: process.platform === "win32" && name.includes("directory") && "Windows does not fsync directories",
}, async (t) => {
  const f = await storageControl(t); let injected = false;
  f.before = (step, path) => { if (!injected && step === operation && matches(path)) { injected = true; throw ioError(); } };
  f.writer.enqueue([record(1)], "sample\n");
  await assert.rejects(f.writer.finish(), { message: "host observation storage incomplete", code: "EIO",
    ...(stage ? { operation: stage } : {}) });
  await f.writer.settled;
  assert.equal(injected, true); assert.equal(f.writer.state().complete, false);
  assert.equal(f.writer.state().openFiles, 0); assert.equal(f.live.size, 0);
  assert.throws(() => f.writer.enqueue([], "later\n"), { code: "EIO" });
  assert.ok(!JSON.stringify(f.writer.state()).includes("PRIVATE_STORAGE_DETAIL"));
  assert.equal(fs.existsSync(join(f.directory, "terminal.json")), false);
});

test("zero progress is not a completed record write", async (t) => {
  const f = await storageControl(t);
  f.before = (step, path) => step === "write" && isRecord(path) ? { bytesWritten: 0 } : undefined;
  f.writer.enqueue([record(1)], "sample\n");
  await assert.rejects(f.writer.finish(), { code: "ERR_ASSERTION" }); await f.writer.settled;
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), "");
  assert.equal(f.live.size, 0);
});

test("record close failure cannot replace the first fsync fault", { timeout: 5000 }, async (t) => {
  const f = await storageControl(t);
  let closeFaults = 0;
  f.before = (step, path) => {
    if (!isRecord(path)) return;
    if (step === "sync") throw ioError();
    if (step === "close" && closeFaults++ === 0) throw Object.assign(new Error("PRIVATE_CLOSE_DETAIL"), { code: "EPERM" });
  };
  f.writer.enqueue([record(1)], "sample\n");
  await assert.rejects(f.writer.finish(), { operation: "process-record-sync", code: "EIO" });
  await f.writer.settled;
  assert.equal(closeFaults, 2);
  assert.equal(f.live.size, 0);
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), "");
});

test("an exact initial record cannot be replaced by different bytes with the same filename", async (t) => {
  const f = await storageControl(t); f.writer.enqueue([record(1)], "sample\n"); await f.writer.drain();
  fs.writeFileSync(join(f.directory, "processes", `${record(1).key}.json`), record(9).value);
  await assert.rejects(f.writer.finish(), { code: "ERR_ASSERTION" }); await f.writer.settled;
  assert.equal(f.live.size, 0); assert.equal(f.writer.state().complete, false);
});

for (const kind of ["missing", "symlink", "hardlink", "truncated"]) test(`${kind} record cannot seal`, async (t) => {
  const f = await storageControl(t); f.writer.enqueue([record(1)], "sample\n"); await f.writer.drain();
  const path = join(f.directory, "processes", `${record(1).key}.json`), other = join(f.temporary, "other");
  if (kind === "truncated") fs.truncateSync(path, 1);
  else {
    fs.renameSync(path, other);
    if (kind === "symlink") fs.symlinkSync(other, path);
    if (kind === "hardlink") fs.linkSync(other, path);
  }
  await assert.rejects(f.writer.finish()); await f.writer.settled;
  assert.equal(f.live.size, 0); assert.equal(f.writer.state().complete, false);
});

test("queue bytes include the in-flight frame and admission is atomic", async (t) => {
  const f = await storageControl(t), pause = f.pause("write", isSamples);
  f.writer.enqueue([], "x".repeat(storageLimits.queuedBytes)); await pause.entered;
  assert.equal(f.writer.state().queuedBytes, storageLimits.queuedBytes);
  assert.throws(() => f.writer.enqueue([record(1)], "x"), { limit: "queued-bytes" });
  assert.equal(f.writer.has(record(1).key), false);
  pause.release(); await assert.rejects(f.writer.finish()); await f.writer.settled;
  assert.equal(f.writer.state().frames, 0); assert.equal(f.live.size, 0);
});

test("queued host observation samples catch up in bounded guarded appends", { timeout: 5000 }, async (t) => {
  const f = await storageControl(t), pause = f.pause("stat", isSamples);
  const frames = Array.from({ length: 201 }, (_, sequence) => `${JSON.stringify({ sequence })}\n`);
  const appends = [];
  try {
    f.writer.enqueue([], frames[0]); await pause.entered;
    for (const frame of frames.slice(1)) f.writer.enqueue([], frame);
    assert.equal(f.writer.state().frames, frames.length);
    assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), "");
  } finally { pause.release(); }
  f.before = (step, path, [data]) => { if (step === "write" && isSamples(path)) appends.push(data.toString()); };
  assert.equal((await f.writer.finish()).samples, frames.length);
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), frames.join(""));
  assert.equal(appends.length, 14, "a lone append followed by 13 batches");
  assert.deepEqual(appends.map((append) => append.split("\n").length - 1), [1, ...Array(12).fill(16), 8]);
  assert.equal(f.trace.filter((s) => s.name === "stat" && s.phase === "begin" && isSamples(s.path)).length,
    appends.length + 2, "one sample identity check per append, plus open and final sync");
  assert.equal(f.live.size, 0);
});

test("sample batches cap encoded bytes and keep each frame's encoding", async (t) => {
  const f = await storageControl(t), appends = [];
  f.before = (step, path, [data]) => { if (step === "write" && isSamples(path)) appends.push(Buffer.from(data)); };
  const large = "\u00e9".repeat(70 * 1024) + "\n";
  const frames = [large, large, "\ud83d", "\ude00\n", "x".repeat(257 * 1024) + "\n", "later\n"];
  for (const frame of frames) f.writer.enqueue([], frame);
  assert.equal((await f.writer.finish()).samples, frames.length);
  const encoded = frames.map((frame) => Buffer.from(frame));
  assert.deepEqual(appends, [encoded[0], Buffer.concat(encoded.slice(1, 4)), encoded[4], encoded[5]]);
  assert.deepEqual(fs.readFileSync(join(f.directory, "samples.jsonl")), Buffer.concat(encoded));
});

test("a record-bearing frame is an append barrier in both directions", async (t) => {
  const f = await storageControl(t), pause = f.pause("sync", isRecord), appends = [];
  const before = f.before;
  f.before = async (step, path, args) => {
    if (step === "write" && isSamples(path)) appends.push(args[0].toString());
    return before(step, path, args);
  };
  const frames = ["before 1\n", "before 2\n", "reference\n", "after 1\n", "after 2\n"];
  for (const [i, frame] of frames.entries()) f.writer.enqueue(i === 2 ? [record(1)] : [], frame);
  await pause.entered;
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), frames.slice(0, 2).join(""));
  assert.equal(f.writer.state().pendingRecords, 1);
  assert.equal(f.writer.state().frames, 3);
  pause.release();
  assert.equal((await f.writer.finish()).samples, frames.length);
  assert.deepEqual(appends, [frames.slice(0, 2).join(""), frames[2], frames.slice(3).join("")]);
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), frames.join(""));
});

for (const method of ["drain", "settled"]) test(`${method} waits for its own FIFO prefix`, { timeout: 5000 }, async (t) => {
  const f = await storageControl(t), pause = f.pause("write", isSamples);
  const before = f.before;
  f.before = (step, path, args) => {
    if (step === "write" && isSamples(path) && args[0].includes(Buffer.from("later"))) return before(step, path, args);
  };
  f.writer.enqueue([], "first\n");
  const prefix = method === "drain" ? f.writer.drain() : f.writer.settled;
  f.writer.enqueue([], "later\n");
  await pause.entered; await prefix;
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), "first\n");
  pause.release(); assert.equal((await f.writer.finish()).samples, 2);
});

for (const mode of ["finish", "error", "cancel", "timeout", "overflow"]) test(`a short sample batch write retains ownership through ${mode}`, {
  timeout: 5000,
}, async (t) => {
  const f = await storageControl(t), guard = f.pause("stat", isSamples);
  const entered = deferred(), release = deferred(), path = join(f.directory, "samples.jsonl");
  f.releases.push(release.resolve);
  const frames = ["first\n", "second\n", "third\n", "last\n"];
  const prefix = frames.slice(0, 2).join("") + frames[2][0];
  let writes = 0;
  if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
  f.writer.enqueue([], frames[0]); await guard.entered;
  for (const frame of frames.slice(1)) f.writer.enqueue([], frame);
  f.before = async (step, path, args) => {
    if (step !== "write" || !isSamples(path)) return;
    if (++writes === 2) args[2] = Buffer.byteLength(frames[1]) + 1;
    if (writes === 3) {
      entered.resolve();
      await release.promise;
      if (mode === "error") throw ioError();
      if (mode !== "finish") args[2] = 1;
    }
  };
  guard.release(); await entered.promise;
  assert.equal(fs.readFileSync(path, "utf8"), prefix);
  assert.equal(f.writer.state().frames, 3);
  assert.equal(f.writer.state().queuedBytes, Buffer.byteLength(frames.slice(1).join("")));
  const overflow = { operation: "storage-admission", code: "ERR_ASSERTION", limit: "queued-frames" };
  if (mode === "overflow") {
    for (let i = 3; i < storageLimits.frames; i++) f.writer.enqueue([], "backlogged\n");
    assert.equal(f.writer.state().frames, 300);
    assert.throws(() => f.writer.enqueue([], "overflow\n"), overflow);
    assert.equal(f.writer.state().pendingOwnership, true);
  }
  const deadline = { operation: "sample-write", code: "ETIMEDOUT" };
  if (mode === "timeout") {
    t.mock.timers.tick(30000);
    // No caller is waiting yet: only the writer's append deadline can fail it.
    assert.deepEqual(f.writer.state().error, deadline);
    assert.equal(f.writer.state().pendingOwnership, true);
    assert.equal(f.writer.state().openFiles, 1);
    assert.equal(f.writer.state().frames, 3);
  }
  const finish = f.writer.finish();
  if (mode === "cancel") {
    f.writer.abort();
    assert.equal(f.writer.state().pendingOwnership, true);
  }
  release.resolve();
  if (mode === "finish") assert.equal((await finish).samples, frames.length);
  if (mode === "error") await assert.rejects(finish, { operation: "sample-write", code: "EIO" });
  if (mode === "cancel") await assert.rejects(finish, /storage cancelled/);
  if (mode === "timeout") await assert.rejects(finish, deadline);
  if (mode === "overflow") await assert.rejects(finish, overflow);
  await f.writer.settled;
  assert.equal(writes, 3);
  assert.equal(f.writer.state().complete, mode === "finish");
  assert.equal(f.writer.state().pendingOwnership, false);
  assert.equal(f.writer.state().queuedBytes, 0);
  assert.equal(f.live.size, 0);
  assert.equal(fs.readFileSync(path, "utf8"), mode === "finish" ? frames.join("") : prefix + (mode === "error" ? "" : frames[2][1]));
});

test("the bounded frame queue includes the one in progress", { timeout: 5000 }, async (t) => {
  const f = await storageControl(t), pause = f.pause("write", isSamples);
  f.writer.enqueue([], "x"); await pause.entered;
  for (let i = 1; i < storageLimits.frames; i++) f.writer.enqueue([], "x");
  assert.equal(f.writer.state().frames, 300);
  const fault = { operation: "storage-admission", code: "ERR_ASSERTION", limit: "queued-frames" };
  assert.throws(() => f.writer.enqueue([], "x"), fault); pause.release();
  await assert.rejects(f.writer.finish(), fault); await f.writer.settled;
  assert.equal(f.writer.state().frames, 0); assert.equal(f.live.size, 0);
});

test("4096 pending initial records is bounded before any new dedup reservation", async (t) => {
  const f = await storageControl(t), pause = f.pause("open", isRecord);
  f.writer.enqueue(Array.from({ length: storageLimits.records }, (_, i) => record(i)), "sample\n"); await pause.entered;
  assert.equal(f.writer.state().pendingRecords, 4096);
  assert.throws(() => f.writer.enqueue([record(4096)], "sample\n"), { limit: "queued-records" });
  assert.equal(f.writer.has(record(4096).key), false); pause.release();
  await assert.rejects(f.writer.finish()); await f.writer.settled;
  assert.equal(f.writer.state().pendingRecords, 0); assert.equal(f.live.size, 0);
});

test("the 256MiB lifetime bound counts acknowledged and pending sample bytes", async (t) => {
  const f = await storageControl(t), chunk = "x".repeat(storageLimits.queuedBytes);
  f.writer.enqueue([record(1)], chunk.slice(Buffer.byteLength(record(1).value))); await f.writer.drain();
  for (let i = 1; i < 31; i++) { f.writer.enqueue([], chunk); await f.writer.drain(); }
  f.writer.enqueue([], chunk.slice(1)); await f.writer.drain();
  assert.equal(f.writer.state().bytes, storageLimits.bytes - 1);
  f.writer.enqueue([], "x"); await f.writer.drain(); assert.equal(f.writer.state().bytes, storageLimits.bytes);
  assert.throws(() => f.writer.enqueue([], "x"), { limit: "total-bytes" });
  await assert.rejects(f.writer.finish()); await f.writer.settled;
  assert.equal(fs.statSync(join(f.directory, "samples.jsonl")).size + Buffer.byteLength(record(1).value), storageLimits.bytes);
  assert.equal(f.live.size, 0);
});

test("invalid keys and duplicate initial-record reservations cannot escape the directory", async (t) => {
  const f = await storageControl(t);
  assert.throws(() => f.writer.enqueue([{ key: "../escape", value: "x" }], "sample\n"));
  assert.equal(f.writer.has("../escape"), false); await assert.rejects(f.writer.finish()); await f.writer.settled;
  assert.equal(fs.existsSync(join(f.temporary, "escape.json")), false);
});

test("a duplicate within one frame leaves no dedup reservations or record files", async (t) => {
  const f = await storageControl(t);
  assert.throws(() => f.writer.enqueue([record(1), record(1)], "sample\n"));
  assert.equal(f.writer.has(record(1).key), false); assert.equal(f.writer.state().bytes, 0);
  await assert.rejects(f.writer.finish()); await f.writer.settled;
  assert.deepEqual(fs.readdirSync(join(f.directory, "processes")), []);
});

test("exclusive sample open refuses a substituted symlink without changing its target", async (t) => {
  const f = await storageControl(t); f.writer.abort(); await f.writer.settled;
  const target = join(f.temporary, "target"), path = join(f.directory, "samples.jsonl");
  fs.writeFileSync(target, "unchanged"); fs.unlinkSync(path); fs.symlinkSync(target, path);
  f.writer = hostDurableWriter(f.directory);
  await assert.rejects(f.writer.ready(), { code: "EEXIST" });
  await assert.rejects(f.writer.finish(), { code: "EEXIST" }); await f.writer.settled;
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged"); assert.equal(f.live.size, 0);
});

test("timeout rejects proof but owns an unfinished fsync until its actual completion", async (t) => {
  const f = await storageControl(t), pause = f.pause("sync", isRecord), original = globalThis.setTimeout;
  // Scale only the existing storage deadline, not clocks, sampling or gap limits.
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => original(callback, ms === 30000 ? 40 : ms, ...args));
  f.writer.enqueue([record(1)], "sample\n"); await pause.entered;
  await assert.rejects(f.writer.finish(), { code: "ETIMEDOUT" });
  assert.equal(f.writer.state().pendingOwnership, true); assert.ok(f.writer.state().openFiles > 0);
  assert.equal(fs.readFileSync(join(f.directory, "samples.jsonl"), "utf8"), "");
  pause.release(); await f.writer.settled;
  assert.equal(f.live.size, 0); assert.equal(f.writer.state().complete, false);
  assert.deepEqual(f.writer.state().error, { operation: "process-record-sync", code: "ETIMEDOUT" });
});

test("final sample close timeout identifies close and keeps the fd owned until it settles", { timeout: 5000 }, async (t) => {
  const f = await storageControl(t);
  f.writer.enqueue([], "complete sample\n"); await f.writer.drain();
  const pause = f.pause("close", isSamples);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finish = f.writer.finish();
  const failure = assert.rejects(finish, { operation: "sample-close", code: "ETIMEDOUT" });
  failure.catch(() => {}); // Join the rejection after the held operation is observed.
  try {
    await pause.entered;
    assert.ok(f.trace.some(({ name, phase, path }) => name === "sync" && phase === "end" && isSamples(path)));
    t.mock.timers.tick(30000);
    await failure;
    assert.equal(f.writer.state().pendingOwnership, true);
    assert.equal(f.writer.state().openFiles, 1);
    assert.equal(f.live.size, 1);
  } finally {
    pause.release(); await f.writer.settled;
  }
  assert.equal(f.live.size, 0);
  assert.equal(f.writer.state().complete, false);
  assert.deepEqual(f.writer.state().error, { operation: "sample-close", code: "ETIMEDOUT" });
});

test("startup timeout retains ownership before an outstanding open returns a FileHandle", async (t) => {
  const f = await storageControl(t); f.writer.abort(); await f.writer.settled;
  f.directory = join(f.temporary, "startup"); fs.mkdirSync(f.directory); fs.mkdirSync(join(f.directory, "processes"));
  const pause = f.pause("open", isSamples), original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => original(callback, ms === 30000 ? 40 : ms, ...args));
  f.writer = hostDurableWriter(f.directory);
  const ready = f.writer.ready(); ready.catch(() => {}); await pause.entered;
  await assert.rejects(ready, { code: "ETIMEDOUT" });
  assert.equal(f.writer.state().openFiles, 0); assert.equal(f.writer.state().frames, 0);
  assert.equal(f.writer.state().pendingOwnership, true, "unreturned open is still owned I/O");
  pause.release(); await f.writer.settled;
  assert.equal(f.live.size, 0); assert.equal(f.writer.state().pendingOwnership, false);
  assert.equal(f.writer.state().complete, false);
});

test("many distinct records retain at most two actual writer file descriptors", async (t) => {
  const f = await storageControl(t); let maximum = 0;
  f.before = () => {
    if (process.platform !== "linux") return;
    const owned = fs.readdirSync("/proc/self/fd").filter((fd) => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(f.temporary); } catch { return false; }
    });
    maximum = Math.max(maximum, owned.length);
  };
  for (let i = 0; i < 64; i++) { f.writer.enqueue([record(i)], "sample\n"); await f.writer.drain(); }
  const final = await f.writer.finish(); assert.equal(final.samples, 64);
  assert.ok(f.maximumFiles <= 2); assert.ok(maximum <= 2); assert.equal(f.live.size, 0);
  assert.equal(f.writer.state().pendingOwnership, false);
});

test("real sampler timestamps stay continuous during a 1500ms asynchronous record-sync completion delay", async (t) => {
  const f = await samplingControl(t), pause = f.pause("sync", isRecord);
  f.members.push(5000); await pause.entered;
  const before = f.procReads; await delay(1500);
  assert.ok(f.procReads >= before + 4, "real sampling continues off the storage chain");
  assert.equal(f.samples().length, 2, "no reference is appended ahead of its record fsync");
  let completed = false; const finish = f.finish().then((value) => { completed = true; return value; });
  await delay(25); assert.equal(completed, false); assert.equal(fs.existsSync(join(f.directory, "terminal.json")), false);
  pause.release(); const proof = await finish;
  assert.equal(proof.status, "verified"); assert.equal(proof.checks.accounting, true);
  assert.ok(proof.samples.length > 5); assert.equal(f.removed, true); assert.equal(f.live.size, 0);
  assert.ok(Math.max(...proof.samples.slice(1).map((s, i) => s.at - proof.samples[i].at)) <= 1000);
});

test("actual event-loop stall still fails the unchanged one-second accounting gate", async (t) => {
  const f = await samplingControl(t);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1250);
  const proof = await f.finish(); assert.equal(proof.status, "blocked"); assert.equal(proof.checks.accounting, false);
  assert.equal(proof.checks.observer, true);
});

for (const kind of ["cancelled", "forced"]) test(`fully flushed ${kind} evidence retains its old nonqualifying contract`, async (t) => {
  const abort = new AbortController(), f = await samplingControl(t, abort.signal);
  abort.abort(); const result = { ...f.result, [kind]: true, success: false };
  const proof = await f.finish(result);
  assert.equal(proof.status, "blocked"); assert.equal(proof.checks.unforced, false);
  for (const key of ["accounting", "terminal", "empty", "observer", "leader"]) assert.equal(proof.checks[key], true);
  assert.equal(f.removed, true); assert.equal(f.live.size, 0);
});

test("writer failure cannot publish a terminal or claim positive-empty cleanup", async (t) => {
  const f = await samplingControl(t); let failed = false;
  f.before = (step, path) => { if (step === "sync" && isRecord(path)) { failed = true; throw ioError(); } };
  f.members.push(5000); await delay(175);
  await assert.rejects(f.finish(), { code: "EIO" }); await f.observer.pendingStorage;
  assert.equal(failed, true); assert.equal(fs.existsSync(join(f.directory, "terminal.json")), false);
  assert.equal(f.removed, false); assert.equal(f.live.size, 0);
});

test("a new abort during finish cannot publish an earlier clean command result", async (t) => {
  const abort = new AbortController(), f = await samplingControl(t, abort.signal), pause = f.pause("sync", isSamples);
  const finish = f.finish(); await pause.entered; abort.abort(); pause.release();
  await assert.rejects(finish, /cancelled during storage drain/);
  assert.equal(fs.existsSync(join(f.directory, "terminal.json")), false); assert.equal(f.removed, false); assert.equal(f.live.size, 0);
});

test("a terminal namespace-sync failure withdraws only its own publication and claims no cleanup", async (t) => {
  const f = await samplingControl(t), original = fs.fsyncSync; let injected = false;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (!injected && fs.existsSync(join(f.directory, "terminal.json"))) { injected = true; throw ioError(); }
    return original(fd);
  });
  // The runtime's synchronous terminal helper uses named builtin exports.
  const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports();
  await assert.rejects(f.finish(), /terminal storage incomplete/);
  assert.equal(injected, true); assert.equal(fs.existsSync(join(f.directory, "terminal.json")), false);
  assert.equal(fs.existsSync(join(f.directory, "terminal.pending.json")), true); assert.equal(f.removed, false);
  assert.equal(f.live.size, 0);
});

for (const step of ["sync", "close", "directory-sync", "verify"]) test(`terminal waits for actual final ${step} completion`, async (t) => {
  const f = await samplingControl(t), pause = f.pause(step === "directory-sync" ? "sync" : step === "verify" ? "readFile" : step,
    step === "directory-sync" ? (p) => p === f.directory : step === "verify" ? isRecord : isSamples);
  let done = false; const finish = f.finish().then((value) => { done = true; return value; });
  await pause.entered; await delay(20);
  assert.equal(done, false); assert.equal(fs.existsSync(join(f.directory, "terminal.json")), false);
  pause.release(); assert.equal((await finish).status, "verified"); assert.equal(f.live.size, 0);
});

for (const mode of ["record", "sample", "terminal"]) test(`observer process loss during ${mode} completion cannot leave an unfinished seal`, {
  skip: process.platform !== "linux" && "actual SIGKILL and proc descriptor control requires Linux", timeout: 10000,
}, async () => {
  const temporary = fs.mkdtempSync(join(tmpdir(), "host-storage-loss-"));
  const child = spawn(process.execPath, ["--max-old-space-size=256", fileURLToPath(new URL("./test-fixtures/host-lifetime-storage.mjs", import.meta.url)), "--loss-control", mode], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: temporary }, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close"); let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  try {
    const [bytes] = await Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error(`loss fixture exited early: ${stderr}`); })]);
    const receipt = JSON.parse(bytes.toString());
    assert.ok(resolve(receipt.temporary).startsWith(resolve(temporary) + sep));
    assert.equal(fs.existsSync(join(receipt.directory, "terminal.json")), false);
    child.kill("SIGKILL"); const [code, signal] = await closed;
    assert.equal(code, null); assert.equal(signal, "SIGKILL");
    assert.equal(fs.existsSync(join(receipt.directory, "terminal.json")), false);
    assert.ok(fs.readdirSync(join(receipt.directory, "processes")).length >= 1, "already durable initial records are retained");
    if (mode === "terminal") assert.equal(fs.existsSync(join(receipt.directory, "terminal.pending.json")), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed;
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); fs.rmSync(temporary, { recursive: true });
  }
});
