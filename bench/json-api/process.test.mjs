import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { commands } from "./process.mjs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

test("normal child99 is observable only by the explicit receipt path; legacy commands remain strict", async () => {
  const io = commands(process.cwd());
  try {
    for (const code of [0, 99]) {
      const observed = await io.command(process.execPath, ["--max-old-space-size=256", "-e", `process.exitCode=${code}`], { observeExit: true });
      assert.deepEqual(observed.exit, { code, signal: null, expired: false, interrupted: false });
      assert.deepEqual(observed.ioErrors, []); assert.ok(observed.clock.finishedAt >= observed.clock.startedAt);
    }
    await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.exitCode=99"]), /exit 99/);
    await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.exitCode=2"], { observeExit: true }), /exit 2/);
  } finally { io.dispose(); }
});

test("full stdout bytes are preserved; timeout, cap and file I/O faults never become normal99 observations", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "json-command-proof-")), io = commands(process.cwd());
  t.after(() => { io.dispose(); assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const file = join(folder, "events");
  const observed = await io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.stdout.write(Buffer.from([0,10,13,255]));process.exitCode=99"],
    { observeExit: true, stdoutFile: file, maxStdoutBytes: 4 });
  assert.equal(observed.stdoutBytes, 4); assert.equal(readFileSync(file).toString("hex"), "000a0dff");
  await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "setInterval(()=>{},1000)"], { observeExit: true, timeout: 500 }),
    (e) => e.exit?.expired === true);
  await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.stdout.write('too many bytes');process.exitCode=99"],
    { observeExit: true, stdoutFile: join(folder, "capped"), maxStdoutBytes: 1 }), (e) => e.ioErrors?.some((s) => s.includes("cap exceeded")));
  await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.stdout.write('bytes');process.exitCode=99"],
    { observeExit: true, stdoutFile: join(folder, "absent", "events") }), (e) => e.ioErrors?.length > 0);
});

test("a timed-out command reaps its owned termination helper and permits natural worker exit", () => {
  const code = `import {commands} from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
    const io=commands(process.cwd());
    try {await io.command(process.execPath,['--max-old-space-size=256','-e','setInterval(()=>{},1000)'],{timeout:500,observeExit:true});process.exitCode=2;}
    catch(e){if(e.exit?.expired!==true)throw e;console.log('owned timeout terminal');}
    finally{io.dispose();}`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e", code], {
    cwd: process.cwd(), windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 65536,
  });
  assert.equal(result.error, undefined, "owned timeout worker did not terminate naturally");
  assert.equal(result.status, 0, "owned timeout worker failed");
  assert.match(result.stdout, /owned timeout terminal/);
});

test("command exit stops the sampler before pipes close; held pipes fail and release at the deadline", async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref() { this.unreferenced = true; } });
  const io = commands(process.cwd(), { spawnClient: () => child, pipeGrace: 20 });
  let notified = false;
  try {
    const result = io.command("synthetic-inspect", [], { timeout: 20, observeExit: true, onExit: () => { notified = true; } });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    assert.equal(notified, true);
    await assert.rejects(result, (error) => error.exit?.expired === true
      && error.ioErrors.includes("command did not close within the stop grace; output incomplete"));
    assert.ok(child.unreferenced && child.stdout.destroyed && child.stderr.destroyed);
  } finally { io.dispose(); }
});

test("an owned child signal error after the deadline does not replace timeout or disarm pipe release", async (t) => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref() { this.unreferenced = true; } });
  const io = commands(process.cwd(), { spawnClient: () => child, pipeGrace: 80 });
  t.after(() => { io.dispose(); child.stdout.destroy(); child.stderr.destroy(); });
  const result = io.command("synthetic-inspect", [], { timeout: 5, observeExit: true });
  const signalError = setTimeout(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })), 25);
  try {
    await assert.rejects(result, (error) => error.exit?.expired === true && /: timeout\n/.test(error.message)
      && error.ioErrors.includes("kill EPERM")
      && error.ioErrors.includes("command did not close within the stop grace; output incomplete"));
    assert.ok(child.unreferenced && child.stdout.destroyed && child.stderr.destroyed);
  } finally { clearTimeout(signalError); }
});
