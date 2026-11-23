import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto, { createHash, randomBytes } from "node:crypto";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandOutput, commandRunner, failureReceipt } from "./output.mjs";
import { upstreamImage } from "./raw.mjs";

test("full raw stdout and stderr survive the bounded diagnostic tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-output-"));
  try {
    const file = join(dir, "app.log"), output = commandOutput({ file, capture: false });
    const expected = createHash("sha256");
    for (let i = 0; i < 1024; i++) {
      const chunk = Buffer.alloc(16384, i % 251);
      expected.update(chunk); (i % 2 ? output.stderr : output.stdout)(chunk);
    }
    output.close(); output.close();
    const bytes = readFileSync(file);
    assert.equal(bytes.length, 16 * 1024 * 1024);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.digest("hex"));
    assert.equal(output.result(), "");
    assert.equal(Buffer.byteLength(output.diagnostic()), 65536);
    assert.throws(() => output.stdout(Buffer.from("late")), /closed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ordinary command capture and failure tails remain bounded", () => {
  const output = commandOutput();
  output.stdout(Buffer.alloc(9 * 1024 * 1024, "a"));
  output.stdout(Buffer.from("end\n"));
  assert.equal(output.result().length, 8 * 1024 * 1024 - 1);
  assert.ok(output.result().endsWith("end"));
  output.stderr(Buffer.alloc(100000, "e"));
  output.stderr(Buffer.from("failure"));
  assert.equal(output.diagnostic().length, 65536);
  assert.ok(output.diagnostic().endsWith("failure"));
  output.close();
});

test("split UTF-8 chunks are decoded only after byte capture", () => {
  const output = commandOutput();
  const bytes = Buffer.from("\u20ac\u00a3\n");
  for (const byte of bytes) output.stdout(Buffer.from([byte]));
  assert.equal(output.result(), "\u20ac\u00a3");
  output.close();
});

test("real child output is fully drained to the artifact, including stderr", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-output-child-"));
  const file = join(dir, "app.log"), output = commandOutput({ file, capture: false });
  const child = spawn(process.execPath, ["-e", "const b=Buffer.alloc(65536,120);for(let i=0;i<384;i++)process.stdout.write(b);process.stderr.write('stderr-end');"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    child.stdout.on("data", output.stdout); child.stderr.on("data", output.stderr);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    output.close();
    assert.equal(code, 0);
    const raw = readFileSync(file);
    assert.equal(raw.length, 24 * 1024 * 1024 + 10);
    assert.equal(raw.indexOf("stderr-end"), raw.lastIndexOf("stderr-end"));
    assert.ok(raw.includes(Buffer.from("stderr-end")));
    assert.equal(output.result(), "");
  } finally { child.kill(); output.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Real local clients that stall at the two catalog boundaries: a detached start that
// printed its container ID, and a log stream that stops after partial output.
const node = (script) => [process.execPath, ["-e", script]];
async function failure(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail("the command was expected to fail");
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Replace builtin functions for one test; output.mjs sees them through its named imports.
// Each replacement is built from the saved originals.
async function patched(module, replacements, run) {
  const saved = Object.fromEntries(Object.keys(replacements).map((key) => [key, module[key]]));
  Object.assign(module, Object.fromEntries(Object.entries(replacements).map(([key, make]) => [key, make(saved)]))); syncBuiltinESMExports();
  try { return await run(); } finally { Object.assign(module, saved); syncBuiltinESMExports(); }
}
// The fd the command helper opens for appending to `file`, so a patch touches only that.
const appendFd = (file, real, found) => (path, flags, ...rest) => {
  const fd = real(path, flags, ...rest);
  if (path === file && flags === "a") found(fd);
  return fd;
};
// A client that prints, exits 0 at once, and leaves a detached holder with its pipes.
const heldClient = (pidFile, line = "4f1c0ffee") => {
  const holder = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},30000)`;
  return `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{detached:true,stdio:['ignore','inherit','inherit']});c.unref();console.log(${JSON.stringify(line)})`;
};
function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code !== "ESRCH"; }
  if (process.platform !== "linux") return true;
  // An orphan killed in a container without an init stays a zombie until something reaps it.
  try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}

test("a client that prints an ID and then hangs fails at its deadline with its lifetime", { timeout: 15000 }, async () => {
  const { command } = commandRunner({ cwd: process.cwd() });
  const error = await failure(command(...node("console.log('4f1c0ffee');setInterval(()=>{},1000)"), { timeout: 3000, receipt: true }));
  assert.match(error.message, /: timeout after 3000 ms\n4f1c0ffee/);
  assert.equal(error.exit.expired, true); assert.equal(error.exit.interrupted, false);
  const life = error.lifetime;
  assert.equal(life.timeoutMs, 3000); assert.equal(life.stopped, "deadline");
  assert.equal(life.stdout.bytes, Buffer.byteLength("4f1c0ffee\n"));
  assert.ok(life.stdout.firstMs !== null && life.stdout.firstMs < life.stoppedMs, "the ID preceded the deadline");
  assert.equal(life.stderr.bytes, 0); assert.equal(life.stderr.firstMs, null);
  assert.ok(life.stoppedMs >= 2900, "stopped at, not before, the deadline");
  assert.ok(life.exitMs >= life.stoppedMs, "the client itself was still running at the deadline");
  // Windows can report the pipes closed a few milliseconds before the exit itself.
  assert.ok(life.stdout.closedMs >= life.stoppedMs && life.closeMs >= Math.max(life.exitMs, life.stdout.closedMs) && life.settledMs >= life.closeMs);
  assert.equal(life.file, null);
  assert.ok(Date.parse(life.spawnedAt) <= Date.now());
});

test("a log stream that stalls after partial output keeps the bytes and their hash", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-stall-"));
  try {
    const file = join(dir, "app.log"), { command } = commandRunner({ cwd: dir });
    const script = "const b=Buffer.alloc(65536,103);for(let i=0;i<5;i++)process.stdout.write(b);process.stderr.write('read on closed body');setInterval(()=>{},1000)";
    const error = await failure(command(...node(script), { timeout: 3000, file, capture: false, receipt: true }));
    assert.match(error.message, /timeout after 3000 ms\nread on closed body$/);
    const bytes = readFileSync(file), life = error.lifetime;
    assert.equal(bytes.length, 5 * 65536 + 19);
    assert.deepEqual(life.file, { offset: 0, bytes: bytes.length, sha256: sha256(bytes) });
    assert.equal(life.stdout.bytes, 5 * 65536); assert.equal(life.stderr.bytes, 19);
    assert.ok(life.stdout.lastMs < life.stoppedMs && life.stderr.lastMs < life.stoppedMs, "output stopped before the deadline");
    assert.ok(life.exitMs >= life.stoppedMs && life.closeMs >= life.exitMs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a successful or failing command keeps its existing result and exit shape", { timeout: 15000 }, async () => {
  const { command } = commandRunner({ cwd: process.cwd() });
  assert.equal(await command(...node("console.log(' ok ')")), "ok");
  const error = await failure(command(...node("process.stderr.write('bad');process.exit(3)"), { receipt: true }));
  assert.match(error.message, /: exit 3\nbad$/);
  assert.deepEqual(error.exit, { code: 3, signal: null, expired: false, interrupted: false });
  assert.equal(error.lifetime.stopped, null); assert.equal(error.lifetime.exitCode, 3);
  let interrupted = false;
  const runner = commandRunner({ cwd: process.cwd(), interrupted: () => interrupted });
  const pending = failure(runner.command(...node("console.log('started');setInterval(()=>{},1000)"), { timeout: 10000, receipt: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  interrupted = true; runner.interrupt();
  const stopped = await pending;
  assert.equal(stopped.exit.interrupted, true); assert.equal(stopped.exit.expired, false);
  assert.equal(stopped.lifetime.stopped, "interrupt");
  await assert.rejects(runner.command(...node("")), /catalog run interrupted/);
});

test("a client that exits while another process holds its output open still settles at its deadline", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-held-"));
  const pidFile = join(dir, "holder.pid");
  // The holder inherits the client's pipes and is detached (its own session on Linux,
  // outside the taskkill tree once its parent exits on Windows), so stopping the
  // client's process group cannot close them. Stopping such an escaped process is out of
  // scope: the runner only stops reading, and the test kills the holder itself.
  const client = heldClient(pidFile);
  try {
    // Not cwd: dir, so Windows can delete the folder while the holder is still exiting.
    const { command } = commandRunner({ cwd: tmpdir() });
    const began = Date.now();
    const error = await failure(command(...node(client), { timeout: 3000, receipt: true }));
    assert.ok(Date.now() - began < 3000 + 7000, "settled within the deadline plus the stop grace");
    assert.match(error.message, /: timeout after 3000 ms; the client exited 0 at \d+ ms but its output stayed open; its pipes were released at \d+ ms without end of file\n4f1c0ffee/);
    assert.deepEqual(error.exit, { code: 0, signal: null, expired: true, interrupted: false });
    const life = error.lifetime;
    assert.equal(life.exitCode, 0); assert.ok(life.exitMs < life.stoppedMs, "the client exited before the deadline");
    assert.equal(life.stdout.bytes, Buffer.byteLength("4f1c0ffee\n")); assert.ok(life.stdout.firstMs <= life.exitMs);
    assert.equal(life.stopped, "deadline"); assert.ok(life.releasedMs >= life.stoppedMs, "the runner stopped reading the held pipes");
    assert.equal(life.stdout.closedMs, null, "a released pipe is not recorded as closed"); assert.equal(life.closeMs, null);
    assert.ok(life.settledMs >= life.releasedMs);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stopped command is never a success, whatever its cleanup flag or exit code", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-stopped-"));
  const pidFile = join(dir, "holder.pid");
  try {
    let interrupted = false;
    const runner = commandRunner({ cwd: tmpdir(), interrupted: () => interrupted });
    // A cleanup command that exits 0 on the stop, holding nothing.
    const graceful = failure(runner.command(...node("process.on('SIGTERM',()=>process.exit(0));console.log('cleanup');setInterval(()=>{},1000)"),
      { timeout: 20000, cleanup: true, receipt: true }));
    // A cleanup command whose client exited 0 while a detached holder keeps its output open.
    const held = failure(runner.command(...node(heldClient(pidFile)), { timeout: 20000, cleanup: true, receipt: true }));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
    await sleep(500);
    interrupted = true; runner.interrupt(); runner.interrupt(); // A second signal is harmless.
    const [stopped, released] = await Promise.all([graceful, held]);
    assert.equal(stopped.exit.interrupted, true); assert.equal(stopped.exit.expired, false);
    assert.equal(stopped.lifetime.stopped, "interrupt"); assert.match(stopped.message, /; interrupted/);
    assert.deepEqual(released.exit, { code: 0, signal: null, expired: false, interrupted: true });
    assert.match(released.message, /: exit 0; interrupted; the client exited 0 at \d+ ms but its output stayed open; its pipes were released at \d+ ms without end of file\n4f1c0ffee/);
    const life = released.lifetime;
    assert.ok(life.exitMs < life.stoppedMs && life.releasedMs >= life.stoppedMs, JSON.stringify(life));
    // Cleanup may still start after the signal, and succeeds when nothing stops it.
    assert.equal(await runner.command(...node("console.log('removed')"), { cleanup: true }), "removed");
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pipe that receives a final write after the client exits still completes successfully", { timeout: 15000 }, async () => {
  // Detached, so the writer outlives the client on Windows too (libuv kills a non-detached
  // child with its parent there). Nothing stops either process: success waits for the close.
  const writer = "setTimeout(()=>process.stdout.write('final\\n'),700)";
  const client = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{detached:true,stdio:['ignore','inherit','inherit']}).unref();console.log('first')`;
  const { command } = commandRunner({ cwd: tmpdir() });
  const began = Date.now();
  assert.equal(await command(...node(client), { timeout: 10000, receipt: true }), "first\nfinal");
  assert.ok(Date.now() - began >= 600, "the result waited for the late write");
});

test("on Linux a descendant in the client's process group that ignores SIGTERM is killed, not left holding the pipe", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-group-"));
  const pidFile = join(dir, "holder.pid");
  // SIGTERM ends the client (the group leader); the holder ignores it and keeps the pipes.
  const holder = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const client = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
  try {
    const { command } = commandRunner({ cwd: tmpdir() });
    const error = await failure(command(...node(client), { timeout: 2000, receipt: true }));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), false, "the holder in the client's group is gone once the command settles");
    const life = error.lifetime;
    assert.equal(life.stopped, "deadline"); assert.equal(life.releasedMs, null, "the pipes closed; they were not released");
    assert.ok(life.closeMs !== null && life.closeMs < life.stoppedMs + 5000, JSON.stringify(life));
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only a failed receipt command hashes its log, after it ends; timed-phase commands never do", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-hash-"));
  try {
    let hashes = 0;
    await patched(crypto, { createHash: ({ createHash }) => (...args) => { hashes++; return createHash(...args); } }, async () => {
      const { command } = commandRunner({ cwd: dir });
      // The timed k6 phase's shape (timed.mjs): `start -a` with a file and a deadline, no receipt.
      assert.equal(await command(...node("console.log('k6 progress')"), { timeout: 10000, file: join(dir, "fixed.log") }), "k6 progress");
      const threshold = await failure(command(...node("console.log('thresholds');process.exit(99)"), { timeout: 10000, file: join(dir, "sat256.log") }));
      assert.equal(threshold.exit.code, 99); assert.equal(threshold.lifetime, undefined, "no receipt, no lifetime");
      const log = join(dir, "app.log");
      await command(...node("console.log('logs')"), { file: log, capture: false, receipt: true });
      assert.equal(hashes, 0, "nothing hashed while a command ran or after it succeeded");
      const failed = await failure(command(...node("console.log('partial');process.exit(1)"), { file: log, capture: false, receipt: true }));
      assert.equal(hashes, 1, "the failed receipt command hashed its closed segment once");
      const bytes = readFileSync(log), offset = Buffer.byteLength("logs\n");
      assert.deepEqual(failed.lifetime.file, { offset, bytes: bytes.length - offset, sha256: sha256(bytes.subarray(offset)) });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The timed k6 phase and the legacy load still opt into no receipt.
  for (const [path, call] of [["timed.mjs", 'docker(["start", "-a", load], { timeout: (seconds + 25) * 1000, file: join(raw, `${phase}.log`) })'],
    ["run.mjs", 'docker(["start", "-a", container], { timeout: (seconds + 25) * 1000, file: join(raw, `${phase}.log`) })']]) {
    assert.ok(readFileSync(new URL(path, import.meta.url), "utf8").includes(call), `${path}: timed load command changed`);
  }
});

test("a short write and then ENOSPC leave a receipt whose bytes and hash match the file", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-enospc-"));
  const file = join(dir, "app.log");
  try {
    let target = null, writes = 0;
    const error = await patched(fs, {
      openSync: ({ openSync }) => appendFd(file, openSync, (fd) => { target = fd; }),
      writeSync: ({ writeSync }) => (fd, buffer, offset, length, ...rest) => {
        if (fd !== target) return writeSync(fd, buffer, offset, length, ...rest);
        if (++writes === 1) return writeSync(fd, buffer, offset, 3);
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
      },
    // Not cwd: dir; the stop's taskkill.exe can outlive the command on Windows.
    }, () => failure(commandRunner({ cwd: tmpdir() }).command(...node("process.stdout.write('abcdefgh');setInterval(()=>{},1000)"),
      { timeout: 10000, file, capture: false, receipt: true })));
    assert.equal(error.code, "ENOSPC"); assert.equal(error.lifetime.stopped, "output error");
    const bytes = readFileSync(file);
    assert.equal(bytes.toString(), "abc");
    assert.deepEqual(error.lifetime.file, { offset: 0, bytes: 3, sha256: sha256(bytes) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an output close failure never replaces the command's error, and fails a command that succeeded", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-close-"));
  const file = join(dir, "app.log");
  try {
    let target = null;
    await patched(fs, {
      openSync: ({ openSync }) => appendFd(file, openSync, (fd) => { target = fd; }),
      closeSync: ({ closeSync }) => (fd) => {
        closeSync(fd);
        if (fd === target) { target = null; throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO", syscall: "close" }); }
      },
    }, async () => {
      const { command } = commandRunner({ cwd: dir });
      const error = await failure(command(...node("process.stderr.write('bad');process.exit(3)"), { file, receipt: true }));
      assert.match(error.message, /: exit 3\nbad$/); assert.equal(error.exit.code, 3);
      assert.equal(error.outputCloseError, "EIO: i/o error, close");
      assert.equal(error.lifetime.file.bytes, 3);
      const closing = await failure(command(...node("console.log('ok')"), { file }));
      assert.equal(closing.code, "EIO");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A fake Docker client for receipt probes: `inspect` and `events` answers by container ID.
const ownedId = "a".repeat(64), foreignId = "b".repeat(64), label = "run.corten.catalog", runId = "c1-run";
const secrets = ["SECRET-HEALTH-OUTPUT", "SECRET-FOREIGN-LABEL", "SECRET-EXEC-COMMAND", "SECRET-RAW-LINE", foreignId];
const state = { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, Pid: 4242, ExitCode: 0,
  Error: "", StartedAt: "2026-11-23T10:00:00.000000001Z", FinishedAt: "0001-01-01T00:00:00Z",
  Health: { Status: "unhealthy", FailingStreak: 3, Log: [{ ExitCode: 1, Output: "SECRET-HEALTH-OUTPUT" }] } };
const container = (id, labels, name = "/c1-run-gin") => ({ Id: id, Name: name, Created: "2026-11-23T09:59:59Z", RestartCount: 2, State: state,
  Config: { Labels: { ...labels, "com.example.note": "SECRET-FOREIGN-LABEL" } } });
const event = (id, action, seconds) => JSON.stringify({ Type: "container", Action: action, Actor: { ID: id, Attributes: { name: "c1-run-gin",
  "com.example.note": "SECRET-FOREIGN-LABEL", [label]: runId } }, scope: "local", time: seconds, timeNano: seconds * 1e9 });
function fakeDocker(inspected, events = "") {
  const calls = [];
  const docker = async (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === "inspect") {
      if (inspected instanceof Error) throw inspected;
      return typeof inspected === "string" ? inspected : JSON.stringify([inspected]);
    }
    if (args[0] === "events") return events;
    throw new Error(`unexpected docker ${args[0]}`);
  };
  return { docker, calls };
}
const commandError = () => Object.assign(new Error("docker logs c1-run-gin: timeout after 30000 ms\nSECRET-RAW-LINE tail"),
  { exit: { code: null, signal: "SIGTERM", expired: true, interrupted: false } });
const receiptOf = (docker) => failureReceipt(docker, { stage: "app logs", container: "c1-run-gin", error: commandError(), owned: (labels) => labels?.[label] === runId });
const leaks = (receipt) => secrets.filter((secret) => JSON.stringify(receipt).includes(secret));

test("a receipt keeps only allowlisted state and events of the owned container, by its immutable ID", async () => {
  const lines = [event(ownedId, "create", 1795000000), event(ownedId, "start", 1795000001), event(ownedId, "health_status: unhealthy", 1795000002),
    event(ownedId, "exec_start: sh -c SECRET-EXEC-COMMAND", 1795000003), event(foreignId, "destroy", 1795000004), "SECRET-RAW-LINE {"].join("\n");
  const { docker, calls } = fakeDocker(container(ownedId, { [label]: runId }), lines);
  const receipt = await receiptOf(docker);
  assert.deepEqual(calls.map(({ args, opts }) => [args[0], opts]), [["inspect", { cleanup: true, timeout: 10000 }], ["events", { cleanup: true, timeout: 10000 }]]);
  assert.deepEqual(calls[0].args, ["inspect", "--type", "container", "c1-run-gin"]);
  assert.equal(calls[1].args[calls[1].args.indexOf("--filter") + 1], `container=${ownedId}`, "events are bound to the inspected ID, not the name");
  assert.equal(receipt.refusal, null);
  assert.deepEqual(receipt.inspect, { id: ownedId, restartCount: 2, state: { status: "running", running: true, exitCode: 0, oomKilled: false,
    startedAt: "2026-11-23T10:00:00.000000001Z", finishedAt: "0001-01-01T00:00:00Z" } });
  assert.deepEqual(receipt.events.recent, [["create", 0], ["start", 1], ["health_status", 2], ["exec_start", 3]]
    .map(([action, s]) => ({ action, time: new Date((1795000000 + s) * 1000).toISOString() })));
  assert.equal(receipt.events.total, 4); assert.equal(receipt.events.excluded, 1); assert.equal(receipt.events.unreadable, 1);
  assert.equal(receipt.error, "docker logs c1-run-gin: timeout after 30000 ms");
  assert.deepEqual(leaks(receipt), []);
});

test("a receipt for a foreign container of the same name keeps the command evidence and the refusal only", async () => {
  for (const foreign of [container(foreignId, { [label]: "another-run" }), container(foreignId, {}), container(foreignId, { [label]: runId }, "/elsewhere")]) {
    const { docker, calls } = fakeDocker(foreign, event(foreignId, "start", 1795000001));
    const receipt = await receiptOf(docker);
    assert.deepEqual(calls.map(({ args }) => args[0]), ["inspect"], "a foreign container's events are never queried");
    assert.equal(receipt.refusal, "not owned by this run");
    assert.equal(receipt.inspect, null); assert.equal(receipt.events, null); assert.deepEqual(receipt.diagnosticErrors, []);
    assert.deepEqual(receipt.exit, commandError().exit);
    assert.deepEqual(leaks(receipt), []);
  }
});

test("a receipt for a missing or unreadable container never queries events by its reusable name", async () => {
  const missing = Object.assign(new Error("docker inspect --type container: exit 1\nError: No such container: c1-run-gin SECRET-RAW-LINE"), { exit: { code: 1 } });
  for (const [inspected, problem] of [[missing, "inspect: docker inspect --type container: exit 1"], ["SECRET-RAW-LINE not json", "inspect: unparseable output"],
    [new TypeError("SECRET-RAW-LINE"), "inspect: TypeError"]]) {
    const { docker, calls } = fakeDocker(inspected);
    const receipt = await receiptOf(docker);
    assert.deepEqual(calls.map(({ args }) => args[0]), ["inspect"]);
    assert.equal(receipt.refusal, "not inspected"); assert.equal(receipt.inspect, null); assert.equal(receipt.events, null);
    assert.deepEqual(receipt.diagnosticErrors, [problem]);
    assert.deepEqual(leaks(receipt), []);
  }
});

test("receipt probes are bounded and an events failure is recorded, not thrown", async () => {
  const { calls } = fakeDocker(null);
  const docker = async (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === "inspect") return JSON.stringify([container(ownedId, { [label]: runId })]);
    throw Object.assign(new Error("docker events --since 1: timeout after 10000 ms\nSECRET-RAW-LINE"), { exit: { expired: true } });
  };
  const receipt = await receiptOf(docker);
  assert.deepEqual(calls.map(({ opts }) => opts), [{ cleanup: true, timeout: 10000 }, { cleanup: true, timeout: 10000 }]);
  assert.equal(receipt.inspect.id, ownedId); assert.equal(receipt.events, null);
  assert.deepEqual(receipt.diagnosticErrors, ["events: docker events --since 1: timeout after 10000 ms"]);
  assert.deepEqual(leaks(receipt), []);
});

test("a failure receipt reads a real container's state and recent events", { skip: process.env.CATALOG_DOCKER_TESTS !== "1", timeout: 360000 }, async () => {
  const { command } = commandRunner({ cwd: process.cwd() });
  const docker = (args, opts) => command("docker", args, opts);
  const id = randomBytes(6).toString("hex"), name = `catalog-receipt-${id}`, label = "run.corten.catalog.receipt-test";
  const owned = (labels) => labels?.[label] === id;
  try {
    try { await docker(["image", "inspect", upstreamImage]); }
    catch { await docker(["pull", upstreamImage], { timeout: 300000 }); }
    const started = await docker(["run", "-d", "--name", name, "--label", `${label}=${id}`, "--network", "none", "--cpus", "1", "--memory", "128m",
      upstreamImage, "node", "-e", "setInterval(()=>{},1000)"], { timeout: 60000 });
    const error = await failure(command(...node("console.log('partial');setInterval(()=>{},1000)"), { timeout: 1000 }));
    const receipt = await failureReceipt(docker, { stage: "app logs", container: name, error, owned });
    assert.deepEqual(receipt.diagnosticErrors, []);
    assert.equal(receipt.refusal, null);
    assert.equal(receipt.inspect.id, started); assert.equal(receipt.inspect.state.running, true);
    assert.equal(receipt.inspect.state.status, "running");
    const actions = receipt.events.recent.map((event) => event.action);
    assert.ok(actions.includes("create") && actions.includes("start"), JSON.stringify(actions));
    assert.ok(receipt.events.recent.every((event) => Object.keys(event).join() === "action,time"));
    const missing = await failureReceipt(docker, { stage: "app start", container: `${name}-absent`, error, owned });
    assert.equal(missing.refusal, "not inspected"); assert.equal(missing.inspect, null); assert.equal(missing.events, null);
    assert.match(missing.diagnosticErrors[0], /^inspect: docker inspect --type container: exit 1$/);
  } finally {
    const found = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
    if (found) {
      const info = JSON.parse(await docker(["inspect", "--type", "container", name]))[0];
      assert.ok(owned(info.Config.Labels), "never remove an unrelated container");
      await docker(["rm", "-f", "-v", info.Id]);
    }
  }
});
