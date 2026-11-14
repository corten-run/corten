import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { limits, supervise } from "./process.mjs";
import { fakeChild } from "./test-fixtures/process.mjs";

const cwd = fileURLToPath(new URL("../../../", import.meta.url));
const plan = (...args) => ({ executable: "node", argv: ["bench/workloads/dispatcher-fixtures/native.mjs", ...args], shell: false });
test("existing IPC bootstrap preserves native arguments and actual failure codes", { timeout: 15000 }, async () => {
  for (const code of [0, 7]) {
    let output = "";
    const r = await supervise(plan("exit", String(code), "a directory"), { cwd, env: process.env, log(b) { output += b; } });
    assert.equal(r.terminal, true); assert.equal(r.code, code); assert.equal(r.success, code === 0);
    assert.deepEqual(JSON.parse(output), ["exit", String(code), "a directory"]);
  }
});
test("IPC cancellation waits for native finally and does not promote zero after cancellation", { timeout: 15000 }, async (t) => {
  const abort = new AbortController(), pids = new Set(); let output = "";
  t.after(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {} });
  const r = await supervise(plan("wait"), { cwd, env: process.env, signal: abort.signal, log(b) {
    output += b;
    for (const m of output.matchAll(/READY (\d+) (\d+)/g)) for (const pid of m.slice(1)) pids.add(Number(pid));
    if (output.includes("READY")) abort.abort();
  } });
  assert.equal(r.terminal, true); assert.equal(r.cancelled, true); assert.equal(r.success, false);
  assert.equal(r.forced, false); assert.match(output, /HANDLED SIGTERM/); assert.match(output, /CLEANUP_EXECUTED/);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a real bootstrap waits for asynchronous host observation before executing native code", { timeout: 15000 }, async () => {
  let output = "", release, observed = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = supervise(plan("exit", "0"), { cwd, env: process.env, log(b) { assert.equal(observed, true); output += b; },
    async onStart(pid) { assert.ok(pid > 0); await gate; observed = true; } });
  await new Promise((resolve) => setTimeout(resolve, 200)); assert.equal(output, ""); release();
  assert.equal((await running).success, true); assert.match(output, /exit/);
});

test("a real observer setup failure cancels the gated bootstrap without native execution", { timeout: 15000 }, async () => {
  let output = "";
  const result = await supervise(plan("exit", "0"), { cwd, env: process.env, log(b) { output += b; },
    onStart() { throw new Error("SYNTHETIC_PRIVATE_SENTINEL"); } });
  assert.equal(result.success, false); assert.equal(result.cancelled, true); assert.equal(result.forced, false);
  assert.equal(output, ""); assert.equal(result.error, "native host observation setup failed");
});

test("ready IPC cannot extend a hung observation setup to the native runtime deadline", { timeout: 3000 }, async (t) => {
  let starts = 0;
  const child = fakeChild(() => { starts++; });
  t.mock.method(childProcess, "spawn", () => child);
  const result = await supervise(plan("never"), { cwd, env: {}, log() {}, onStart: () => new Promise(() => {}) },
    { readyMs: 10, runMs: 10000, stopMs: 10, killMs: 10 });
  assert.equal(starts, 0); assert.equal(result.cancelled, true); assert.equal(result.success, false);
});

test("handshake/runtime/forced shutdown are bounded and never success", { timeout: 3000 }, async (t) => {
  assert.equal(limits.stopMs, 120000);
  const short = { readyMs: 10, runMs: 10, stopMs: 10, killMs: 10 };
  for (const mode of ["no-ready", "hung", "no-kill-exit"]) {
    const child = fakeChild(() => {}, { ready: mode !== "no-ready", killCloses: mode !== "no-kill-exit" });
    const mock = t.mock.method(childProcess, "spawn", () => child);
    try {
      const r = await supervise(plan("never"), { cwd, env: {}, log() {} }, short);
      assert.equal(r.success, false); assert.equal(r.cancelled, true); assert.equal(r.forced, true);
      assert.equal(r.terminal, mode !== "no-kill-exit");
    } finally { mock.mock.restore(); }
  }
});
test("IPC and output errors cannot hide behind an exit zero", async (t) => {
  const child = fakeChild((c) => { c.stdout.write("evidence"); c.close(0); });
  t.mock.method(childProcess, "spawn", () => child);
  const r = await supervise(plan("exit", "0"), { cwd, env: {}, log() { throw new Error("disk full"); } });
  assert.equal(r.code, 0); assert.equal(r.success, false); assert.match(r.error, /disk full/);
});
test("disconnect failure at the final shutdown bound still returns uncertainty", { timeout: 3000 }, async (t) => {
  const child = fakeChild(() => {}, { killCloses: false });
  child.disconnect = () => { throw new Error("disconnect raced"); };
  t.mock.method(childProcess, "spawn", () => child);
  const r = await supervise(plan("never"), { cwd, env: {}, log() {} }, { readyMs: 10, runMs: 10, stopMs: 10, killMs: 10 });
  assert.equal(r.terminal, false); assert.equal(r.success, false); assert.match(r.error, /disconnect raced/);
});
test("an exited leader's stale pid/group cannot authorize killing or terminal collection", { timeout: 3000 }, async (t) => {
  const child = fakeChild((c) => { c.emit("exit", 0, null); });
  let kills = 0; child.kill = () => { kills++; };
  t.mock.method(childProcess, "spawn", () => child);
  const r = await supervise(plan("never"), { cwd, env: {}, log() {} }, { readyMs: 10, runMs: 10, stopMs: 10, killMs: 10 });
  assert.equal(kills, 0); assert.equal(r.terminal, false); assert.equal(r.success, false);
  assert.match(r.error, /leader exited.*ownership unverified/);
});
