import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { execute, invocation } from "./run.mjs";

const fixture = "bench/workloads/dispatcher-fixtures/native.mjs";
const plan = (...args) => ({ ...invocation(["json-api", "w1"]), args: [fixture, ...args] });

function probe(t, action = () => {}) {
  let stdout = "", stderr = "";
  const pids = new Set();
  t.after(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {} });
  return {
    start(command, args, options) {
      const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      if (child.pid) pids.add(child.pid);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        for (const match of stdout.matchAll(/(?:READY|STARTING) (\d+) (\d+)/g)) for (const pid of match.slice(1)) pids.add(Number(pid));
        action(child, stdout);
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      return child;
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    assertGone() { for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); },
  };
}

test("bootstrap preserves native CLI guards, arguments and ordinary exit/failure codes", { timeout: 15000 }, async (t) => {
  for (const code of [0, 7]) {
    const child = probe(t);
    assert.deepEqual(await execute(plan("exit", String(code), "a directory"), child.start), { code, signal: null });
    assert.deepEqual(JSON.parse(child.stdout), ["exit", String(code), "a directory"]);
    child.assertGone();
  }
  const child = probe(t);
  assert.equal((await execute(plan("throw"), child.start)).code, 1);
  assert.match(child.stderr, /NATIVE_FAILURE/);
  child.assertGone();
  await assert.rejects(execute({ ...plan("exit", "0"), command: "missing-dispatcher-test-executable" }), { code: "ENOENT" });
});

test("cancellation before bootstrap readiness never starts native work", { timeout: 15000 }, async (t) => {
  const child = probe(t);
  const result = await execute(plan("wait"), (...args) => {
    process.emit("SIGINT");
    return child.start(...args);
  });
  assert.equal(result.code, 130);
  assert.equal(child.stdout, "");
  child.assertGone();
});

test("early cancellation waits for a native handler then completes its finally", { timeout: 15000 }, async (t) => {
  let sent = false;
  const child = probe(t, (_, stdout) => {
    if (!sent && stdout.includes("STARTING")) { sent = true; process.emit("SIGINT"); }
  });
  assert.equal((await execute(plan("late-handler"), child.start)).code, 130);
  assert.match(child.stdout, /HANDLED SIGINT/);
  assert.match(child.stdout, /CLEANUP_EXECUTED/);
  child.assertGone();
});

test("IPC errors wait for native cleanup before execute rejects", { timeout: 15000 }, async (t) => {
  let sent = false;
  const child = probe(t, (process, stdout) => {
    if (!sent && stdout.includes("READY")) { sent = true; process.emit("error", new Error("IPC probe failure")); }
  });
  await assert.rejects(execute(plan("wait"), child.start), /IPC probe failure/);
  assert.match(child.stdout, /HANDLED SIGTERM/);
  assert.match(child.stdout, /CLEANUP_EXECUTED/);
  child.assertGone();
});

test("a native error still runs its finally and propagates failure", { timeout: 15000 }, async (t) => {
  const child = probe(t);
  assert.equal((await execute(plan("error-after-ready"), child.start)).code, 1);
  assert.match(child.stdout, /CLEANUP_EXECUTED/);
  assert.match(child.stderr, /NATIVE_FAILURE/);
  child.assertGone();
});

test("send failure requests cleanup by disconnecting rather than terminating native ownership", { timeout: 15000 }, async (t) => {
  let sent = false;
  const child = probe(t, (child, stdout) => {
    if (!sent && stdout.includes("READY")) {
      sent = true;
      child.send = (_, callback) => callback(new Error("send failed"));
      process.emit("SIGTERM");
    }
  });
  await assert.rejects(execute(plan("wait"), child.start), /send failed/);
  assert.match(child.stdout, /HANDLED SIGTERM/);
  assert.match(child.stdout, /CLEANUP_EXECUTED/);
  child.assertGone();
});

test("uncooperative native completion is nonzero and never claims verified cleanup", { timeout: 15000 }, async (t) => {
  let sent = false;
  const child = probe(t, (_, stdout) => {
    if (!sent && stdout.includes("STARTING_NO_HANDLER")) { sent = true; process.emit("SIGTERM"); }
  });
  assert.equal((await execute(plan("no-handler"), child.start)).code, 143);
  assert.match(child.stderr, /did not handle SIGTERM; cooperative cleanup is unverified/);
  assert.doesNotMatch(child.stdout, /CLEANUP_EXECUTED/);
  child.assertGone();
});
