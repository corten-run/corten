import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { invocation, execute } from "./run.mjs";
import { contractSha256, groupNames, selectedApps } from "./registry.mjs";
import { allApps } from "../fullstack/inventory.mjs";
import { parseOptions as browserOptions } from "../fullstack-browser/contract.mjs";

test("explicit dispatch preserves every approved contender and native settings", () => {
  for (const group of groupNames) {
    const plan = invocation([group, "verify-1", "--out", "a directory"]);
    assert.deepEqual(plan.selectedApps, selectedApps(group));
    assert.equal(plan.contractSha256, contractSha256(group));
    assert.equal(plan.args[1], "verify-1");
    assert.deepEqual(plan.args.slice(-2), ["--out", "a directory"]);
    assert.equal(plan.qualification, "native-runner-evidence-required");
    assert.deepEqual(plan.deploymentIntent.selected, selectedApps(group));
    assert.ok(plan.deploymentIntent.apps.every((row) => row.deployments.every((d) => d.qualification === "pending")));
    assert.ok(!plan.args.includes("--apps"));
  }
  assert.deepEqual(invocation(["live-delivery", "w1"]).args, ["bench/live/run.mjs", "w1", "--group", "live-delivery"]);
  assert.deepEqual(invocation(["localized-marketplace", "r99"]).args, ["bench/marketplace/run.mjs", "r99", "--group", "localized-marketplace"]);
});

test("partial selection, implicit groups and cloud operations are refused", () => {
  for (const argv of [[], ["all", "w1"], ["catalog-page"], ["catalog-page", "../w1"]]) assert.throws(() => invocation(argv));
  for (const flag of ["--apps", "--cases", "--group", "--source", "--locales", "--only", "--skip", "--verify-app", "--verify-source", "--verify-case", "--verify-phase", "--detach", "--collect", "--state-dir"]) {
    assert.throws(() => invocation(["catalog-page", "w1", flag, "x"]));
    assert.throws(() => invocation(["catalog-page", "w1", `${flag}=x`]));
  }
});

test("a group cannot be split into a native marketplace part", () => {
  for (const args of [["--part", "1/2"], ["--part=1/2"]]) {
    assert.throws(() => invocation(["localized-marketplace", "w1", ...args]), /cannot filter/);
    const result = spawnSync(process.execPath, ["bench/workloads/run.mjs", "--plan", "localized-marketplace", "w1", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot filter/);
  }
});

test("legacy selection environment cannot break or shrink an exact group plan", () => {
  for (const env of [{ BENCH_APPS: "nextjs" }, { BENCH_TIER: "invalid" }, { BENCH_EDGE: "invalid" }]) {
    const result = spawnSync(process.execPath, ["bench/workloads/run.mjs", "--plan", "client-heavy", "local-client"], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), invocation(["client-heavy", "local-client"]));
  }
});

test("documented browser execution passes the real native option parser", () => {
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const example = readme.split(/\r?\n/).find((line) => line.startsWith("node bench/workloads/run.mjs fullstack-browser "));
  assert.ok(example, "browser execution example required");
  const native = invocation(example.split(/\s+/).slice(2));
  const parsed = browserOptions(native.args.slice(1));
  assert.equal(parsed.build, true);
  assert.ok(parsed.out);
  assert.deepEqual(parsed.apps, selectedApps("fullstack-browser"));
});

test("execution explicitly refuses inherited legacy selection overrides", async () => {
  for (const key of ["BENCH_APPS", "BENCH_TIER", "BENCH_EDGE"]) {
    const saved = process.env[key];
    try {
      process.env[key] = "nextjs";
      await assert.rejects(execute(invocation(["json-api", "w1"]), () => assert.fail("must not spawn")), /unset legacy selection overrides/);
    } finally { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; }
  }
});

test("pure inventory is immutable and legacy selection validation is unchanged", () => {
  assert.ok(Object.isFrozen(allApps));
  assert.ok(Object.values(allApps).every(Object.isFrozen));
  const entry = "import { apps } from './bench/fullstack/apps.mjs'; console.log(JSON.stringify(Object.keys(apps)))";
  const base = { ...process.env };
  for (const key of ["BENCH_APPS", "BENCH_TIER", "BENCH_EDGE"]) delete base[key];
  for (const [env, expected] of [
    [{ BENCH_APPS: "nextjs" }, /must include corten/],
    [{ BENCH_APPS: "corten,missing" }, /not an app/],
    [{ BENCH_TIER: "invalid" }, /BENCH_TIER is defaults or matched/],
    [{ BENCH_EDGE: "invalid" }, /BENCH_EDGE is off or unset/],
    [{ BENCH_TIER: "matched", BENCH_APPS: "corten,django" }, /not in the matched tier/],
  ]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", entry], { encoding: "utf8", env: { ...base, ...env } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", entry], { encoding: "utf8", env: { ...base, BENCH_APPS: "nextjs,corten" } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["corten", "nextjs"]);
});

test("real native cancellation runs its handler and finally without orphaning its child", { timeout: 15000 }, async (t) => {
  const pids = [];
  t.after(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {} });
  let stdout = "", stderr = "", sent = false;
  const plan = { ...invocation(["json-api", "w1"]), args: ["bench/workloads/dispatcher-fixtures/native.mjs", "wait"] };
  const result = await execute(plan, (command, args, options) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe", ...(Array.isArray(options.stdio) && options.stdio.includes("ipc") ? ["ipc"] : [])] });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const ready = stdout.match(/READY (\d+) (\d+)/);
      if (ready && !sent) { sent = true; pids.push(...ready.slice(1).map(Number)); process.emit("SIGTERM"); process.emit("SIGTERM"); }
    });
    return child;
  });
  assert.ok(sent, stdout + stderr);
  assert.deepEqual(result, { code: 143, signal: null });
  assert.equal(stdout.match(/HANDLED SIGTERM/g)?.length, 1);
  assert.match(stdout, /CLEANUP_EXECUTED/);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("native failure, signal and spawn errors cannot become success", async () => {
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  for (const [code, signal, expected] of [[0, null, 0], [1, null, 1], [3, null, 3], [null, "SIGINT", 130], [null, "SIGTERM", 143], [null, "SIGKILL", 1]]) {
    const result = await execute(invocation(["json-api", "w1"]), (command, args, options) => {
      assert.equal(command, process.execPath); assert.equal(options.shell, false); assert.deepEqual(options.stdio, ["inherit", "inherit", "inherit", "ipc"]);
      const child = new EventEmitter(); queueMicrotask(() => child.emit("close", code, signal)); return child;
    });
    assert.deepEqual(result, { code: expected, signal });
  }
  await assert.rejects(execute(invocation(["json-api", "w1"]), () => { const child = new EventEmitter(); queueMicrotask(() => { child.emit("error", new Error("no process")); child.emit("close", -1, null); }); return child; }), /no process/);
  await assert.rejects(execute(invocation(["json-api", "w1"]), () => { throw new Error("synchronous spawn failure"); }), /synchronous spawn failure/);
  assert.equal(process.listenerCount("SIGINT"), before.int); assert.equal(process.listenerCount("SIGTERM"), before.term);
});

test("plan mode is a real read-only CLI and cannot execute an injected command", () => {
  const result = spawnSync(process.execPath, ["bench/workloads/run.mjs", "--plan", "catalog-page", "w1", "--out", "folder;echo nope"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.args.at(-1), "folder;echo nope");
  assert.equal(plan.group, "catalog-page");
});
