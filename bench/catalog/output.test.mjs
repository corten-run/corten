import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("a client that prints an ID and then hangs fails at its deadline with its lifetime", { timeout: 15000 }, async () => {
  const { command } = commandRunner({ cwd: process.cwd() });
  const error = await failure(command(...node("console.log('4f1c0ffee');setInterval(()=>{},1000)"), { timeout: 3000 }));
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
    const error = await failure(command(...node(script), { timeout: 3000, file, capture: false }));
    assert.match(error.message, /timeout after 3000 ms\nread on closed body$/);
    const bytes = readFileSync(file), life = error.lifetime;
    assert.equal(bytes.length, 5 * 65536 + 19);
    assert.deepEqual(life.file, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    assert.equal(life.stdout.bytes, 5 * 65536); assert.equal(life.stderr.bytes, 19);
    assert.ok(life.stdout.lastMs < life.stoppedMs && life.stderr.lastMs < life.stoppedMs, "output stopped before the deadline");
    assert.ok(life.exitMs >= life.stoppedMs && life.closeMs >= life.exitMs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a successful or failing command keeps its existing result and exit shape", { timeout: 15000 }, async () => {
  const { command } = commandRunner({ cwd: process.cwd() });
  assert.equal(await command(...node("console.log(' ok ')")), "ok");
  const error = await failure(command(...node("process.stderr.write('bad');process.exit(3)")));
  assert.match(error.message, /: exit 3\nbad$/);
  assert.deepEqual(error.exit, { code: 3, signal: null, expired: false, interrupted: false });
  assert.equal(error.lifetime.stopped, null); assert.equal(error.lifetime.exitCode, 3);
  let interrupted = false;
  const runner = commandRunner({ cwd: process.cwd(), interrupted: () => interrupted });
  const pending = failure(runner.command(...node("console.log('started');setInterval(()=>{},1000)"), { timeout: 10000 }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  interrupted = true; runner.interrupt();
  const stopped = await pending;
  assert.equal(stopped.exit.interrupted, true); assert.equal(stopped.exit.expired, false);
  assert.equal(stopped.lifetime.stopped, "interrupt");
  await assert.rejects(runner.command(...node("")), /catalog run interrupted/);
});

test("receipt probes are bounded and their failures are recorded, not thrown", async () => {
  const calls = [];
  const docker = async (args, opts) => {
    calls.push([args[0], opts]);
    if (args[0] === "inspect") throw new Error("docker inspect: exit 1\nNo such container");
    return "not json";
  };
  const error = Object.assign(new Error("docker logs x: timeout after 30000 ms\ntail"), { exit: { code: null, signal: "SIGTERM", expired: true, interrupted: false } });
  const receipt = await failureReceipt(docker, { stage: "app logs", container: "x", error, owned: () => true });
  assert.deepEqual(calls, [["inspect", { cleanup: true, timeout: 10000 }], ["events", { cleanup: true, timeout: 10000 }]]);
  assert.equal(receipt.error, "docker logs x: timeout after 30000 ms");
  assert.deepEqual(receipt.exit, error.exit);
  assert.equal(receipt.lifetime, null); assert.equal(receipt.inspect, null); assert.equal(receipt.events, null);
  assert.equal(receipt.diagnosticErrors.length, 2);
  assert.match(receipt.diagnosticErrors[0], /^inspect: docker inspect: exit 1$/);
  assert.match(receipt.diagnosticErrors[1], /^events: /);
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
    assert.equal(receipt.lifetime, error.lifetime);
    assert.equal(receipt.inspect.id, started); assert.equal(receipt.inspect.name, `/${name}`);
    assert.equal(receipt.inspect.owned, true); assert.equal(receipt.inspect.state.Running, true);
    const actions = receipt.events.recent.map((event) => event.Action ?? event.status);
    assert.ok(actions.includes("create") && actions.includes("start"), JSON.stringify(actions));
    assert.ok(receipt.events.recent.every((event) => event.Actor?.Attributes?.name === name));
    const missing = await failureReceipt(docker, { stage: "app start", container: `${name}-absent`, error, owned });
    assert.equal(missing.inspect, null); assert.match(missing.diagnosticErrors[0], /^inspect: /);
    assert.equal(missing.events.total, 0);
  } finally {
    const found = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
    if (found) {
      const info = JSON.parse(await docker(["inspect", "--type", "container", name]))[0];
      assert.ok(owned(info.Config.Labels), "never remove an unrelated container");
      await docker(["rm", "-f", "-v", info.Id]);
    }
  }
});
