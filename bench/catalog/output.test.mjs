import assert from "node:assert/strict";
import cp, { spawn } from "node:child_process";
import crypto, { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { commandOutput, commandRunner, failureReceipt, killCommand, ownedContainer, releaseMs } from "./output.mjs";
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

test("fileStderr: false writes the client's stdout alone to the file, byte for byte; by default both streams go there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-output-stdout-"));
  try {
    for (const [fileStderr, expected] of [[false, "ready\n{} \n\n"], [undefined, "ready\nwarning\n{} \n\n"]]) {
      const file = join(dir, `${fileStderr}.log`), output = commandOutput({ file, capture: false, ...(fileStderr === undefined ? {} : { fileStderr }) });
      output.stdout(Buffer.from("ready\n")); output.stderr(Buffer.from("warning\n")); output.stdout(Buffer.from("{} \n\n"));
      output.close();
      assert.equal(readFileSync(file, "utf8"), expected);
      assert.equal(output.diagnostic(), "warning\n");
    }
    // Through commandRunner, from a real child.
    const { command } = commandRunner({ cwd: dir });
    const file = join(dir, "child.log");
    await command(process.execPath, ["-e", "process.stdout.write('out  \\n\\n');process.stderr.write('err')"], { file, capture: false, fileStderr: false });
    assert.equal(readFileSync(file, "utf8"), "out  \n\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("a shared caller can keep its own pre-interrupt diagnostic", async () => {
  const { command } = commandRunner({ interrupted: () => true, interruptMessage: "marketplace run interrupted" });
  await assert.rejects(command("must-not-spawn", []), { message: "marketplace run interrupted" });
});

test("a client that cannot start fails with its spawn error unless a stop was accepted first, and carries `exit` either way", { timeout: 15000 }, async () => {
  const missing = join(tmpdir(), `catalog-missing-client-${randomBytes(6).toString("hex")}`);
  // Unopposed, the spawn error is the command's own failure.
  const alone = await failure(commandRunner({ cwd: tmpdir() }).command(missing, ["logs"], { receipt: true }));
  assert.equal(alone.code, "ENOENT");
  assert.deepEqual(alone.exit, { code: null, signal: null, expired: false, interrupted: false });
  assert.equal(alone.spawnError, undefined); assert.equal(alone.lifetime.stopped, null); assert.equal(alone.lifetime.kill, null);
  // An interrupt in the same turn is accepted before Node reports the spawn error, so the interrupt decides
  // the outcome, as the receipt says, and the spawn error is secondary.
  let interrupted = false;
  const runner = commandRunner({ cwd: tmpdir(), interrupted: () => interrupted });
  const pending = failure(runner.command(missing, ["logs"], { receipt: true }));
  interrupted = true; runner.interrupt();
  const stopped = await pending;
  assert.equal(stopped.code, undefined, "not the raw spawn error");
  assert.deepEqual(stopped.exit, { code: null, signal: null, expired: false, interrupted: true });
  assert.match(stopped.message, /: did not start \(ENOENT\); interrupted\n/);
  assert.match(stopped.spawnError, /ENOENT/);
  assert.equal(stopped.lifetime.stopped, "interrupt"); assert.equal(stopped.lifetime.kill.end, "no process");
  const receipt = await failureReceipt(() => assert.fail("a refusal queries nothing"), { stage: "app start", container: "c1-run-gin", error: stopped,
    owned: () => false, verified: { refusal: "not inspected" } });
  assert.deepEqual([receipt.exit, receipt.spawnError, receipt.lifetime.stopped], [stopped.exit, stopped.spawnError, "interrupt"]);
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

const clientExitEnd = "the client exited; its group is not signalled again";

test("on Linux the group is not signalled after the client exits: a surviving member holding the pipes is released, not killed", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-group-"));
  const pidFile = join(dir, "holder.pid");
  // SIGTERM ends the client (the group leader); the holder, in its group, ignores it and keeps
  // the pipes. Once Node has reaped the client nothing proves the group's ID is still the
  // client's, so the deliberate rule is to signal it no more: the runner releases the pipes.
  const holder = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const client = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
  try {
    const { command } = commandRunner({ cwd: tmpdir() });
    const error = await failure(command(...node(client), { timeout: 2000, receipt: true }));
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), true, "the surviving member was not signalled after the client exited");
    assert.match(error.message, /: timeout after 2000 ms; the client exited SIGTERM at \d+ ms but its output stayed open; its pipes were released at \d+ ms without end of file\n/);
    const life = error.lifetime;
    assert.equal(life.stopped, "deadline"); assert.equal(life.exitSignal, "SIGTERM"); assert.ok(life.exitMs >= life.stoppedMs);
    assert.deepEqual(life.kill, { method: "process group", term: "sent", kill: null, end: clientExitEnd, clientError: null });
    assert.equal(life.clientAtRelease, "exited"); assert.equal(life.stdout.closedMs, null, "the member still held the pipes");
    assert.ok(life.releasedMs >= life.stoppedMs + releaseMs - 50, JSON.stringify(life));
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on Linux a TERM-resistant group gets SIGKILL while its leader, the client, is unreaped", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-group-nopipe-"));
  const pidFile = join(dir, "holder.pid");
  // The client and a member of its group with no pipe both ignore SIGTERM. The unreaped client
  // keeps the group's ID its own, so the group gets SIGKILL after the grace.
  const holder = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const client = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  try {
    const { command } = commandRunner({ cwd: tmpdir() });
    const error = await failure(command(...node(client), { timeout: 2000, receipt: true }));
    const life = error.lifetime;
    assert.equal(life.stopped, "deadline"); assert.equal(life.releasedMs, null, "the pipes closed; they were not released");
    assert.deepEqual(life.kill, { method: "process group", term: "sent", kill: "sent", end: clientExitEnd, clientError: null });
    assert.equal(life.exitSignal, "SIGKILL"); assert.ok(life.exitMs >= life.stoppedMs + 1900, JSON.stringify(life));
    // Death, not reaping: an orphan killed in a container without an init stays a zombie, which `alive` counts as dead.
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    assert.equal(alive(pid), false, "the member got the group's SIGKILL");
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every signal this process sends while `run` runs, recorded and answered by `answer`.
async function signals(answer, run) {
  const real = process.kill, sent = [];
  process.kill = (pid, signal) => { sent.push([pid, signal]); return answer(pid, signal); };
  try { return { result: await run(), sent }; } finally { process.kill = real; }
}
const errno = (code) => Object.assign(new Error(code), { code });

test("on Linux the group is signalled only while the client is unreaped; a replacement group answering after the leader exits gets nothing", { timeout: 20000 }, async () => {
  const options = { platform: "linux", graceMs: 300, boundMs: 1500 }, clients = new Map();
  // A fake client: Node sets its exit state and emits `exit` when it reaps it.
  const client = (pid, { exitCode = null, exitsOn = null, diesOn = null } = {}) => {
    const c = Object.assign(new EventEmitter(), { pid, exitCode, signalCode: null, signals: [] });
    c.end = (signal) => {
      if (c.exitCode !== null || c.signalCode !== null) return;
      if (signal) c.signalCode = signal; else c.exitCode = 0;
      c.emit("exit", c.exitCode, c.signalCode);
    };
    // `exitsOn`: the client exits 0 once it has that signal; `diesOn`: it is killed by it. Exits follow
    // the signals actually recorded, as a microtask after the signal's call returns, so no timer (the
    // grace's SIGKILL among them) can run between a signal and the exit it causes, however late the
    // deferred SIGTERM runs.
    c.receive = (signal) => { if (signal === exitsOn) queueMicrotask(() => c.end(null)); else if (signal === diesOn) queueMicrotask(() => c.end(signal)); };
    c.kill = (signal) => { c.signals.push(signal); c.receive(signal); return true; };
    clients.set(pid, c); return c;
  };
  const { result, sent } = await signals((pid, signal) => {
    if (-pid === 4202 || -pid === 4205) throw errno("ESRCH");
    // A group SIGTERM reaches its leader; a group SIGKILL ends its leader, except 4206's, which outlives it.
    if (signal === "SIGTERM") clients.get(-pid)?.receive(signal);
    if (signal === "SIGKILL" && -pid !== 4206) setImmediate(() => clients.get(-pid)?.end("SIGKILL"));
    // Every other number answers, including whatever group holds 4203's ID once its leader has exited.
    return true;
  }, async () => {
    const records = await Promise.all([
      killCommand(client(4201, { exitCode: 0 }), options), // Already exited: its group's ID may be reused.
      killCommand(client(4202, { exitsOn: "SIGTERM" }), options), // The group SIGTERM fails; SIGTERM through its handle ends it.
      killCommand(client(4203, { exitsOn: "SIGTERM" }), options), // Its group's SIGTERM ends it; a replacement group then answers any signal.
      killCommand(client(4204), options), // The client and its group ignore SIGTERM while it is unreaped.
      killCommand(client(4205, { diesOn: "SIGKILL" }), options), // The group signal fails and the client ignores SIGTERM.
      killCommand(client(4206), options), // The client survives even SIGKILL until the bound.
    ]);
    // Anything still scheduled would fire within the old two-second escalation.
    await sleep(2300);
    return records;
  });
  assert.deepEqual(sent, [[-4202, "SIGTERM"], [-4203, "SIGTERM"], [-4204, "SIGTERM"], [-4205, "SIGTERM"], [-4206, "SIGTERM"],
    [-4204, "SIGKILL"], [-4206, "SIGKILL"]], "no probe, and no group signal once its client has exited");
  assert.deepEqual([...clients.values()].map((c) => c.signals), [[], ["SIGTERM"], [], [], ["SIGTERM", "SIGKILL"], []],
    "only a client whose group signal failed is signalled through its handle");
  assert.deepEqual(result.map((r) => [r.term ?? null, r.kill ?? null, r.end]), [
    [null, null, "the client had already exited; nothing signalled"], ["ESRCH", null, clientExitEnd], ["sent", null, clientExitEnd],
    ["sent", "sent", clientExitEnd], ["ESRCH", "client", clientExitEnd], ["sent", "sent", "bound reached; the client was still running"]]);
});

test("on Linux a client that exits before its deferred SIGTERM runs gets no signal at all", { timeout: 10000 }, async () => {
  const options = { platform: "linux", graceMs: 300, boundMs: 1500 };
  const client = (pid) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, signals: [],
    kill(signal) { this.signals.push(signal); return true; } });
  const { result, sent } = await signals(() => true, async () => {
    // Node reaps it and emits `exit` in the same turn the stop starts, before the deferred SIGTERM.
    const announced = client(4301), first = killCommand(announced, options);
    announced.exitCode = 0; announced.emit("exit", 0, null);
    // Reaped in the same libuv batch: its exit fields are set before the deferred SIGTERM, its `exit` not yet emitted.
    const batched = client(4302), second = killCommand(batched, options);
    batched.exitCode = 0;
    const records = await Promise.all([first, second]);
    await sleep(500);
    return { records, clients: [announced, batched] };
  });
  assert.deepEqual(sent, [], "no group signal for a client already reaped");
  assert.deepEqual(result.clients.map((c) => c.signals), [[], []], "nor through its handle");
  assert.deepEqual(result.records.map((r) => [r.term, r.kill, r.end]), [[null, null, clientExitEnd], [null, null, clientExitEnd]]);
});
// A Linux process that has exited but has not been reaped.
const zombie = (pid) => { try { return /^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test("on Linux a stop that starts inside one client's exit callback signals no client that libuv has already reaped", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  // libuv reaps every exited child in one batch and only then calls each one's exit callback, so
  // inside the first callback the other quick client is already reaped while its exit fields
  // are still null. The interrupt comes from that first callback. The quick clients are
  // single-threaded (`sh`): a multithreaded process shows as a zombie when its main thread
  // exits but cannot be reaped until its other threads have, so one batch might not reap both.
  const realKill = process.kill, children = [], sent = [];
  const { quick, live, errors } = await patched(cp, { spawn: ({ spawn }) => (...args) => { const child = spawn(...args); children.push(child); return child; } }, async () => {
    const runner = commandRunner({ cwd: tmpdir() });
    const pending = [failure(runner.command(...node("setInterval(()=>{},1000)"), { timeout: 10000 })),
      failure(runner.command("sh", ["-c", "exit 0"], { timeout: 10000 })), failure(runner.command("sh", ["-c", "exit 0"], { timeout: 10000 }))];
    const [client, ...quickClients] = children;
    let first = null;
    for (const child of quickClients) child.once("exit", () => { if (first === null) { first = child; runner.interrupt(); } });
    // The event loop is blocked until both quick clients have exited, so one SIGCHLD batch reaps both.
    for (const began = Date.now(); !quickClients.every((c) => zombie(c.pid)) && Date.now() - began < 5000;) block(10);
    assert.ok(quickClients.every((c) => zombie(c.pid)), "both quick clients exited before the event loop could reap either");
    // Only the live client's group is really signalled; anything else is recorded with whether its
    // process was already reaped (a zombie still answers signal 0), not sent.
    const reaped = (pid) => { try { realKill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } };
    process.kill = (pid, signal) => {
      if (-pid === client.pid) { sent.push([pid, signal]); return realKill(pid, signal); }
      sent.push([pid, signal, reaped(Math.abs(pid)) ? "reaped" : "unreaped"]); return true;
    };
    try { return { quick: quickClients, live: client, errors: await Promise.all(pending) }; } finally { process.kill = realKill; }
  });
  assert.ok(quick.every((c) => c.exitCode === 0), "the quick clients exited by themselves");
  // Before the fix the quick client reaped in the same batch got a group SIGTERM.
  assert.deepEqual(sent, [[-live.pid, "SIGTERM"]],
    `only the unreaped live client's group is signalled, never a reaped client's number: ${JSON.stringify({ quick: quick.map((c) => c.pid), sent })}`);
  assert.equal(live.signalCode, "SIGTERM");
  for (const error of errors) assert.equal(error.exit.interrupted, true, error.message);
});

test("an interrupt accepted before the deadline stays an interrupt while the pipes are held", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-interrupt-deadline-"));
  const pidFile = join(dir, "holder.pid");
  try {
    let client;
    const error = await patched(cp, { spawn: ({ spawn }) => (...args) => (client = spawn(...args)) }, async () => {
      let interrupted = false;
      const runner = commandRunner({ cwd: tmpdir(), interrupted: () => interrupted });
      const pending = failure(runner.command(...node(heldClient(pidFile)), { timeout: 4000, receipt: true }));
      // Ordered on the client's actual exit: its detached holder already has the pipes.
      await new Promise((resolve) => { if (client.exitCode !== null || client.signalCode !== null) resolve(); else client.once("exit", resolve); });
      interrupted = true; runner.interrupt();
      return pending;
    });
    assert.deepEqual(error.exit, { code: 0, signal: null, expired: false, interrupted: true });
    assert.doesNotMatch(error.message, /timeout/);
    assert.match(error.message, /: exit 0; interrupted; the client exited 0 at \d+ ms but its output stayed open; its pipes were released at \d+ ms without end of file/);
    const life = error.lifetime;
    assert.equal(life.stopped, "interrupt"); assert.ok(life.exitMs <= life.stoppedMs && life.stoppedMs < 4000, `the interrupt came first: ${JSON.stringify(life)}`);
    assert.ok(life.releasedMs >= life.stoppedMs + releaseMs - 50 && life.releasedMs > 4000, `the deadline passed while the pipes were held: ${JSON.stringify(life)}`);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an output error after an accepted interrupt keeps the interrupt and records the error as secondary evidence", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-late-enospc-"));
  const file = join(dir, "app.log");
  try {
    let target = null, failing = false, accepted = 0, refused = 0, interrupted = false;
    let clientPid = null, helper = null, firstWrite;
    const written = new Promise((resolve) => { firstWrite = resolve; });
    // A substituted taskkill helper that stops the client and exits only once the write after the
    // interrupt has been refused: the order is fixed by those events, not by a timer.
    const runner = commandRunner({ cwd: tmpdir(), interrupted: () => interrupted, killOptions: { platform: "win32",
      taskkill: (pid) => { clientPid = pid; return ["late-write-helper", []]; } } });
    const error = await patched(cp, { spawn: ({ spawn }) => (binary, ...rest) => {
      if (binary !== "late-write-helper") return spawn(binary, ...rest);
      helper = Object.assign(new EventEmitter(), { kill: () => true, unref() {} });
      return helper;
    } }, () => patched(fs, {
      openSync: ({ openSync }) => appendFd(file, openSync, (fd) => { target = fd; }),
      writeSync: ({ writeSync }) => (fd, ...rest) => {
        if (fd !== target) return writeSync(fd, ...rest);
        if (failing) {
          refused++;
          process.kill(clientPid, "SIGKILL"); setImmediate(() => helper.emit("exit", 0, null));
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
        }
        accepted++; firstWrite(); return writeSync(fd, ...rest);
      },
    }, async () => {
      const pending = failure(runner.command(...node("setInterval(()=>process.stdout.write('tick\\n'),20)"), { timeout: 10000, file, capture: false, receipt: true }));
      // Bounded: a client that ends before its first write ends this wait too.
      const ended = pending.then((e) => { if (accepted === 0) throw new Error(`the client ended before its first write: ${e.message}`); });
      await Promise.race([written, ended]);
      interrupted = true; runner.interrupt(); failing = true;
      return pending;
    }));
    assert.equal(refused, 1, "output arrived after the interrupt and its write failed");
    assert.deepEqual(error.lifetime.kill.helper, { exitCode: 0, signal: null, error: null, stalled: false, killError: null },
      "the helper exited after that write, inside its budget");
    assert.equal(error.code, undefined, "not the raw output error");
    assert.deepEqual({ expired: error.exit.expired, interrupted: error.exit.interrupted }, { expired: false, interrupted: true });
    assert.match(error.message, /; interrupted/);
    assert.equal(error.outputError, "ENOSPC: no space left on device, write");
    assert.equal(error.lifetime.stopped, "interrupt");
    const bytes = readFileSync(file);
    assert.deepEqual(error.lifetime.file, { offset: 0, bytes: bytes.length, sha256: sha256(bytes) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a client that survives its stop is left unreferenced at the bound, so it no longer holds the runner", { timeout: 40000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-survivor-"));
  const pidFile = join(dir, "client.pid");
  const client = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  // Every signal fails: group signals with EPERM, and the client's own handle is ignored.
  const script = `
import cp from "node:child_process";
import { commandRunner } from ${JSON.stringify(new URL("./output.mjs", import.meta.url).href)};
process.kill = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
cp.ChildProcess.prototype.kill = () => false;
const { command } = commandRunner({ cwd: ${JSON.stringify(tmpdir())}, killOptions: { platform: "linux", graceMs: 200 } });
try { await command(process.execPath, ["-e", ${JSON.stringify(client)}], { timeout: 500, receipt: true }); console.log("unexpected success"); }
catch (error) {
  console.log(JSON.stringify({ message: error.message.split("\\n")[0], life: error.lifetime,
    processWraps: process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length }));
}
`;
  try {
    const began = Date.now();
    const run = cp.spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20000, windowsHide: true });
    assert.equal(run.signal, null, `the runner process exited by itself, not at the test's timeout: ${run.stderr}`);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(Date.now() - began < 15000);
    const { message, life, processWraps } = JSON.parse(run.stdout);
    assert.match(message, /: timeout after 500 ms; its pipes were released at \d+ ms without end of file while the client was still running; it was left running$/);
    assert.equal(life.clientAtRelease, "running"); assert.equal(life.exitMs, null);
    assert.deepEqual(life.kill, { method: "process group", term: "EPERM", kill: "client", end: "bound reached; the client was still running", clientError: null });
    assert.equal(processWraps, 0, "the surviving client no longer keeps the event loop alive");
    // On Windows libuv ends a non-detached child with its parent's job; elsewhere it is still running.
    if (process.platform !== "win32") assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), true);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs one command with a 300 ms deadline in a separate Node process where every signal fails as
// EPERM: a group signal throws it, and each child's own handle returns it, so Node's kill() emits
// `error` on that child exactly as it does for a real EPERM. The client and any helper write
// their PIDs to `dir`. Returns what the command's failure carried and the referenced ProcessWraps.
const pidOf = (file) => `require('fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000)`;
function failedSignals(dir, killOptions) {
  const script = `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import util from "node:util";
const EPERM = [...util.getSystemErrorMap()].find(([, [name]]) => name === "EPERM")[0];
const spawn = cp.spawn;
cp.spawn = (...args) => { const child = spawn(...args); if (child._handle) child._handle.kill = () => EPERM; return child; };
syncBuiltinESMExports();
process.kill = () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }); };
const { commandRunner } = await import(${JSON.stringify(new URL("./output.mjs", import.meta.url).href)});
const { command } = commandRunner({ cwd: ${JSON.stringify(tmpdir())}, killOptions: ${killOptions} });
try { await command(process.execPath, ["-e", ${JSON.stringify(pidOf(join(dir, "client.pid")))}], { timeout: 300, receipt: true }); console.log("unexpected success"); }
catch (error) {
  console.log(JSON.stringify({ message: error.message.split("\\n")[0], code: error.code ?? null, exit: error.exit ?? null, signalError: error.signalError ?? null,
    life: error.lifetime ?? null, processWraps: process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length }));
}
`;
  const began = Date.now();
  const result = cp.spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.signal, null, `the runner process exited by itself, not at the test's timeout: ${result.stdout}${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - began < 12000);
  const { message, code, exit, signalError, life, processWraps } = JSON.parse(result.stdout);
  assert.match(message, /: timeout after 300 ms; its pipes were released at \d+ ms without end of file while the client was still running; it was left running$/);
  assert.equal(code, null, "not the raw kill error");
  assert.deepEqual(exit, { code: null, signal: null, expired: true, interrupted: false });
  assert.equal(signalError, "kill EPERM", "the client's failed signal is kept as secondary evidence");
  assert.equal(life.stopped, "deadline"); assert.equal(life.clientAtRelease, "running");
  assert.ok(life.releasedMs >= life.stoppedMs + releaseMs - 50, JSON.stringify(life));
  assert.equal(processWraps, 0, "neither the client nor a helper keeps the event loop alive");
  return life.kill;
}
const killPid = (file) => { try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch {} };

test("an EPERM on the group and on the client's own handle is secondary: the deadline decides and the pipes are released", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-eperm-"));
  try {
    assert.deepEqual(failedSignals(dir, `{ platform: "linux", graceMs: 200 }`), { method: "process group", term: "EPERM", kill: "client",
      end: "bound reached; the client was still running", clientError: "EPERM" });
    if (process.platform !== "win32") assert.equal(alive(Number(readFileSync(join(dir, "client.pid"), "utf8"))), true);
  } finally {
    killPid(join(dir, "client.pid"));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Windows helper whose stop fails is abandoned at the bound, and an EPERM on the client's handle is secondary", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-eperm-helper-"));
  const helperPid = join(dir, "helper.pid");
  try {
    assert.deepEqual(failedSignals(dir, `{ platform: "win32", helperMs: 200, boundMs: 1500, taskkill: () => [process.execPath, ["-e", ${JSON.stringify(pidOf(helperPid))}]] }`),
      { method: "taskkill", helper: { exitCode: null, signal: null, error: "did not exit", stalled: true, killError: "EPERM" }, kill: "client", clientError: "EPERM" });
    if (process.platform !== "win32") assert.equal(alive(Number(readFileSync(helperPid, "utf8"))), true, "the helper was abandoned, not stopped");
  } finally {
    killPid(join(dir, "client.pid")); killPid(helperPid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Windows taskkill helper is bounded, never run for an exited client, and a failure is recorded and falls back to the client", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-taskkill-"));
  // The substituted helper receives the client's PID as taskkill would.
  const options = (script) => ({ platform: "win32", helperMs: 500, boundMs: 2000, taskkill: (pid) => [process.execPath, ["-e", script, String(pid)]] });
  const live = () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const ended = (child) => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", resolve); });
  const helperPid = join(dir, "helper.pid"), marker = join(dir, "helper.ran");
  const clients = [], helpers = [];
  try {
    // Any process.kill would mean the Windows path was not taken.
    const { sent } = await signals(() => { throw errno("ESRCH"); }, async () => {
      const exitedClient = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
      await ended(exitedClient);
      const record = await killCommand(exitedClient, options(`require('fs').writeFileSync(${JSON.stringify(marker)},'')`));
      await sleep(500);
      assert.equal(existsSync(marker), false, "no helper for a client that already exited");
      assert.deepEqual(record, { method: "taskkill", end: "the client had already exited; nothing signalled" });

      const stalledClient = live(); clients.push(stalledClient);
      const began = Date.now();
      const stalled = await killCommand(stalledClient, options(`require('fs').writeFileSync(${JSON.stringify(helperPid)},String(process.pid));setInterval(()=>{},1000)`));
      assert.ok(Date.now() - began < 2000, "settled within the helper's bound");
      assert.equal(stalled.helper.stalled, true); assert.equal(stalled.helper.exitCode, null); assert.equal(stalled.kill, "client");
      helpers.push(Number(readFileSync(helperPid, "utf8")));
      await ended(stalledClient);

      const failedClient = live(); clients.push(failedClient);
      const failed = await killCommand(failedClient, options("process.exit(128)"));
      assert.deepEqual(failed, { method: "taskkill", helper: { exitCode: 128, signal: null, error: null, stalled: false, killError: null }, kill: "client", clientError: null });
      await ended(failedClient);

      // A helper that exits 0 only after crossing its budget: the stall decides, not the exit code.
      const lateClient = live(); clients.push(lateClient);
      const late = await patched(cp, { spawn: ({ spawn }) => (binary, ...rest) => {
        if (binary !== "late-helper") return spawn(binary, ...rest);
        const helper = Object.assign(new EventEmitter(), { unref() {} });
        helper.kill = () => { setImmediate(() => helper.emit("exit", 0, null)); return true; };
        return helper;
      } }, () => killCommand(lateClient, { ...options(""), taskkill: () => ["late-helper", []] }));
      assert.deepEqual(late, { method: "taskkill", helper: { exitCode: 0, signal: null, error: null, stalled: true, killError: null }, kill: "client", clientError: null });
      await ended(lateClient);

      const stoppedClient = live(); clients.push(stoppedClient);
      const stopped = await killCommand(stoppedClient, options("process.kill(Number(process.argv[1]),'SIGKILL')"));
      assert.deepEqual(stopped, { method: "taskkill", helper: { exitCode: 0, signal: null, error: null, stalled: false, killError: null }, kill: null, clientError: null });
      await ended(stoppedClient);
    });
    assert.deepEqual(sent, []);
    assert.equal(alive(helpers[0]), false, "the stalled helper was stopped");
    // Through the runner the command settles only after the helper's bound, with the helper gone.
    rmSync(helperPid, { force: true });
    const { command } = commandRunner({ cwd: tmpdir(), killOptions: options(`require('fs').writeFileSync(${JSON.stringify(helperPid)},String(process.pid));setInterval(()=>{},1000)`) });
    const error = await failure(command(...node("setInterval(()=>{},1000)"), { timeout: 500, receipt: true }));
    const life = error.lifetime;
    assert.equal(life.kill.helper.stalled, true); assert.equal(life.kill.kill, "client");
    assert.ok(life.settledMs >= life.stoppedMs + 500 && life.settledMs < life.stoppedMs + releaseMs, JSON.stringify(life));
    assert.equal(alive(Number(readFileSync(helperPid, "utf8"))), false);
  } finally {
    for (const child of clients) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the output descriptor is closed when fstat or spawn fails, and a close-only failure keeps its receipt", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-fd-"));
  const file = join(dir, "app.log");
  try {
    let target = null;
    const closed = [];
    const tracking = {
      openSync: ({ openSync }) => appendFd(file, openSync, (fd) => { target = fd; }),
      closeSync: ({ closeSync }) => (fd) => { if (fd === target) closed.push(fd); return closeSync(fd); },
    };
    await patched(fs, { ...tracking, fstatSync: ({ fstatSync }) => (fd, ...rest) => {
      if (fd === target) throw Object.assign(new Error("EIO: i/o error, fstat"), { code: "EIO" });
      return fstatSync(fd, ...rest);
    } }, async () => {
      assert.throws(() => commandOutput({ file, receipt: true }), { code: "EIO" });
      assert.deepEqual(closed, [target], "fstat failure closes the descriptor");
      closed.length = 0;
      await assert.rejects(commandRunner({ cwd: dir }).command(...node(""), { file, receipt: true }), { code: "EIO" });
      assert.deepEqual(closed, [target]);
    });
    closed.length = 0;
    await patched(fs, tracking, () => patched(cp, { spawn: ({ spawn }) => (binary, ...rest) => {
      if (binary === "unspawnable") throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
      return spawn(binary, ...rest);
    } }, async () => {
      await assert.rejects(commandRunner({ cwd: dir }).command("unspawnable", [], { file, receipt: true }), { code: "EAGAIN" });
      assert.deepEqual(closed, [target], "spawn failure closes the descriptor");
    }));
    target = null; // That descriptor is closed; its number may be reused by any later open.
    await patched(fs, {
      openSync: tracking.openSync,
      closeSync: ({ closeSync }) => (fd) => {
        closeSync(fd);
        if (fd === target) { target = null; throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO", syscall: "close" }); }
      },
    }, async () => {
      const before = readFileSync(file).length;
      const error = await failure(commandRunner({ cwd: dir }).command(...node("console.log('logs')"), { file, capture: false, receipt: true }));
      assert.equal(error.code, "EIO");
      const bytes = readFileSync(file).subarray(before), life = error.lifetime;
      assert.equal(life.exitCode, 0); assert.equal(life.stopped, null); assert.ok(life.closeMs !== null && life.settledMs >= life.closeMs);
      assert.deepEqual(life.file, { offset: before, bytes: bytes.length, sha256: sha256(bytes) });
      assert.equal(bytes.toString().trim(), "logs");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a command without a receipt keeps no lifetime and adds no listener beyond its output and its close", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-command-timed-"));
  const count = (c) => ({ exit: c.listenerCount("exit"), close: c.listenerCount("close"), error: c.listenerCount("error"),
    stdoutClose: c.stdout.listenerCount("close"), stderrClose: c.stderr.listenerCount("close"), stdoutData: c.stdout.listenerCount("data"), stderrData: c.stderr.listenerCount("data") });
  try {
    const seen = [];
    let base;
    await patched(cp, { spawn: ({ spawn }) => (...args) => {
      const child = spawn(...args);
      queueMicrotask(() => seen.push(count(child)));
      return child;
    } }, async () => {
      const bare = cp.spawn(process.execPath, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      // Polled, so no listener of the test's own is counted.
      while (bare.exitCode === null) await sleep(20);
      base = seen.pop();
      const realNow = performance.now;
      let nows = 0;
      performance.now = function () { nows++; return realNow.call(this); };
      try {
        const { command } = commandRunner({ cwd: dir });
        // The timed k6 phase's shapes (timed.mjs): `start -a` with a file and a deadline, no receipt.
        assert.equal(await command(...node("console.log('k6 progress')"), { timeout: 10000, file: join(dir, "fixed.log") }), "k6 progress");
        const threshold = await failure(command(...node("process.exit(99)"), { timeout: 10000, file: join(dir, "sat256.log") }));
        assert.equal(threshold.exit.code, 99); assert.equal(threshold.lifetime, undefined);
        assert.equal(nows, 0, "no receipt clock");
      } finally { performance.now = realNow; }
      const output = { ...base, close: base.close + 1, error: base.error + 1, stdoutData: base.stdoutData + 1, stderrData: base.stderrData + 1 };
      assert.deepEqual(seen.splice(0), [output, output], "only output, error and close listeners");
      const { command } = commandRunner({ cwd: dir });
      await command(...node("console.log('logs')"), { file: join(dir, "app.log"), capture: false, receipt: true });
      assert.deepEqual(seen.splice(0), [{ ...output, exit: base.exit + 1, stdoutClose: base.stdoutClose + 1, stderrClose: base.stderrClose + 1 }],
        "a receipt command adds its exit and pipe-close timing");
    });
    // The runner passes its `receipt` flag to its output: without it, no byte count is kept for a receipt.
    const timed = commandOutput({ file: join(dir, "count.log") });
    timed.stdout(Buffer.from("k6 progress\n")); timed.stderr(Buffer.from("warn\n"));
    assert.equal(timed.receiptBytes(), null, "no receipt byte count"); assert.equal(timed.segment(), null); timed.close();
    const counted = commandOutput({ file: join(dir, "count.log"), receipt: true });
    counted.stdout(Buffer.from("logs\n")); counted.close();
    assert.equal(counted.receiptBytes(), 5); assert.equal(counted.segment().bytes, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
const ownedByRun = (labels) => labels?.[label] === runId;
// The command's one ownership check by name, then its receipt bound to that result.
const receiptOf = async (docker) => failureReceipt(docker, { stage: "app logs", container: "c1-run-gin", error: commandError(), owned: ownedByRun,
  verified: await ownedContainer((args) => docker(args, { cleanup: true, timeout: 10000 }), "c1-run-gin", ownedByRun) });
const leaks = (receipt) => secrets.filter((secret) => JSON.stringify(receipt).includes(secret));

test("a receipt keeps only allowlisted state and events of the owned container, by its verified immutable ID", async () => {
  const lines = [event(ownedId, "create", 1795000000), event(ownedId, "start", 1795000001), event(ownedId, "health_status: unhealthy", 1795000002),
    event(ownedId, "exec_start: sh -c SECRET-EXEC-COMMAND", 1795000003), event(foreignId, "destroy", 1795000004), "SECRET-RAW-LINE {"].join("\n");
  const { docker, calls } = fakeDocker(container(ownedId, { [label]: runId }), lines);
  const receipt = await receiptOf(docker);
  const bounded = { cleanup: true, timeout: 10000 };
  assert.deepEqual(calls.map(({ args, opts }) => [args[0], opts]), [["inspect", bounded], ["inspect", bounded], ["events", bounded]]);
  assert.deepEqual(calls[0].args, ["inspect", "--type", "container", "c1-run-gin"]);
  assert.deepEqual(calls[1].args, ["inspect", "--type", "container", ownedId], "the receipt inspects the verified ID, not the name");
  assert.equal(calls[2].args[calls[2].args.indexOf("--filter") + 1], `container=${ownedId}`, "events are bound to the verified ID, not the name");
  assert.equal(receipt.refusal, null); assert.equal(receipt.id, ownedId);
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
    assert.equal(receipt.refusal, "not owned by this run"); assert.equal(receipt.id, null);
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
  assert.deepEqual(calls.map(({ opts }) => opts), [{ cleanup: true, timeout: 10000 }, { cleanup: true, timeout: 10000 }, { cleanup: true, timeout: 10000 }]);
  assert.equal(receipt.inspect.id, ownedId); assert.equal(receipt.events, null);
  assert.deepEqual(receipt.diagnosticErrors, ["events: docker events --since 1: timeout after 10000 ms"]);
  assert.deepEqual(leaks(receipt), []);
});

test("a receipt never re-resolves the name: a refusal queries nothing, and a verified ID that disappeared is recorded alone", async () => {
  const refused = fakeDocker(container(ownedId, { [label]: runId }), event(ownedId, "start", 1795000001));
  const refusal = await failureReceipt(refused.docker, { stage: "upstream logs", container: "c1-run-gin", error: commandError(), owned: ownedByRun,
    verified: { refusal: "not inspected", problem: "inspect: docker inspect --type container: exit 1" } });
  assert.deepEqual(refused.calls, [], "the original refusal stands; nothing is inspected again");
  assert.equal(refusal.refusal, "not inspected"); assert.deepEqual(refusal.diagnosticErrors, ["inspect: docker inspect --type container: exit 1"]);
  // The logs were read from A; before the receipt, A was removed and B took its name and this run's label.
  const missing = (key) => Object.assign(new Error(`docker inspect --type container: exit 1\nError: No such container: ${key}`), { exit: { code: 1 } });
  const { calls } = fakeDocker(null);
  const docker = async (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === "inspect" && args.at(-1) === "c1-run-gin") return JSON.stringify([container(foreignId, { [label]: runId })]);
    if (args[0] === "inspect") throw missing(args.at(-1));
    return event(foreignId, "start", 1795000001);
  };
  const receipt = await failureReceipt(docker, { stage: "app logs", container: "c1-run-gin", error: commandError(), owned: ownedByRun, verified: { id: ownedId } });
  assert.deepEqual(calls.map(({ args }) => args), [["inspect", "--type", "container", ownedId]], "only the verified ID; never the name, never events");
  assert.equal(receipt.id, ownedId); assert.equal(receipt.refusal, "verified container gone");
  assert.equal(receipt.inspect, null); assert.equal(receipt.events, null);
  assert.deepEqual(receipt.diagnosticErrors, ["inspect: docker inspect --type container: exit 1"]);
  assert.deepEqual(leaks(receipt), [], "nothing of the replacement");
});

test("a detached start's receipt reuses the snapshot of its own ownership check instead of inspecting again", async () => {
  const { docker, calls } = fakeDocker(container(ownedId, { [label]: runId }), event(ownedId, "start", 1795000001));
  const verified = await ownedContainer((args) => docker(args, { cleanup: true, timeout: 10000 }), "c1-run-gin", ownedByRun);
  const receipt = await failureReceipt(docker, { stage: "app start", container: "c1-run-gin", error: commandError(), owned: ownedByRun, verified, fresh: true });
  assert.deepEqual(calls.map(({ args }) => args[0]), ["inspect", "events"], "one inspect: the check itself");
  assert.equal(calls[1].args[calls[1].args.indexOf("--filter") + 1], `container=${ownedId}`);
  assert.deepEqual(receipt.inspect, { id: ownedId, restartCount: 2, state: { status: "running", running: true, exitCode: 0, oomKilled: false,
    startedAt: "2026-11-23T10:00:00.000000001Z", finishedAt: "0001-01-01T00:00:00Z" } });
  assert.equal(receipt.events.total, 1); assert.deepEqual(leaks(receipt), []);
  // A fresh refusal is still recorded alone.
  const refused = fakeDocker(container(foreignId, {}));
  const refusal = await failureReceipt(refused.docker, { stage: "app start", container: "c1-run-gin", error: commandError(), owned: ownedByRun,
    verified: { refusal: "not owned by this run" }, fresh: true });
  assert.deepEqual(refused.calls, []); assert.equal(refusal.refusal, "not owned by this run");
});

test("a failure receipt reads a real container's state and recent events", { skip: process.env.CATALOG_DOCKER_TESTS !== "1", timeout: 360000 }, async () => {
  const { command } = commandRunner({ cwd: process.cwd() });
  const docker = (args, opts) => command("docker", args, opts);
  const probe = (args) => docker(args, { cleanup: true, timeout: 10000 });
  const id = randomBytes(6).toString("hex"), name = `catalog-receipt-${id}`, label = "run.corten.catalog.receipt-test";
  const owned = (labels) => labels?.[label] === id;
  try {
    try { await docker(["image", "inspect", upstreamImage]); }
    catch { await docker(["pull", upstreamImage], { timeout: 300000 }); }
    const started = await docker(["run", "-d", "--name", name, "--label", `${label}=${id}`, "--network", "none", "--cpus", "1", "--memory", "128m",
      upstreamImage, "node", "-e", "setInterval(()=>{},1000)"], { timeout: 60000 });
    const error = await failure(command(...node("console.log('partial');setInterval(()=>{},1000)"), { timeout: 1000 }));
    const verified = await ownedContainer(probe, name, owned);
    const receipt = await failureReceipt(docker, { stage: "app logs", container: name, error, owned, verified });
    assert.deepEqual(receipt.diagnosticErrors, []);
    assert.equal(receipt.refusal, null);
    assert.equal(receipt.inspect.id, started); assert.equal(receipt.inspect.state.running, true);
    assert.equal(receipt.inspect.state.status, "running");
    const actions = receipt.events.recent.map((event) => event.action);
    assert.ok(actions.includes("create") && actions.includes("start"), JSON.stringify(actions));
    assert.ok(receipt.events.recent.every((event) => Object.keys(event).join() === "action,time"));
    const missing = await failureReceipt(docker, { stage: "app start", container: `${name}-absent`, error, owned,
      verified: await ownedContainer(probe, `${name}-absent`, owned) });
    assert.equal(missing.refusal, "not inspected"); assert.equal(missing.inspect, null); assert.equal(missing.events, null);
    assert.match(missing.diagnosticErrors[0], /^inspect: docker inspect --type container: exit 1$/);
    // A verified ID that is gone by the time of the receipt is recorded as gone.
    await docker(["rm", "-f", "-v", started]);
    const gone = await failureReceipt(docker, { stage: "app logs", container: name, error, owned, verified });
    assert.equal(gone.refusal, "verified container gone"); assert.equal(gone.id, started); assert.equal(gone.events, null);
  } finally {
    const found = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
    if (found) {
      const info = JSON.parse(await docker(["inspect", "--type", "container", name]))[0];
      assert.ok(owned(info.Config.Labels), "never remove an unrelated container");
      await docker(["rm", "-f", "-v", info.Id]);
    }
  }
});
