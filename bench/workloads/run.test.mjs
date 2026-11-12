import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { invocation, execute } from "./run.mjs";
import { contractSha256, groupNames, selectedApps } from "./registry.mjs";

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

test("native failure, signal and spawn errors cannot become success", async () => {
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  for (const [code, signal, expected] of [[0, null, 0], [1, null, 1], [3, null, 3], [null, "SIGINT", 130], [null, "SIGTERM", 143], [null, "SIGKILL", 1]]) {
    const result = await execute(invocation(["json-api", "w1"]), (command, args, options) => {
      assert.equal(command, process.execPath); assert.equal(options.shell, false); assert.equal(options.stdio, "inherit");
      const child = new EventEmitter(); queueMicrotask(() => child.emit("close", code, signal)); return child;
    });
    assert.deepEqual(result, { code: expected, signal });
  }
  await assert.rejects(execute(invocation(["json-api", "w1"]), () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("no process"))); return child; }), /no process/);
  assert.equal(process.listenerCount("SIGINT"), before.int); assert.equal(process.listenerCount("SIGTERM"), before.term);
});

test("plan mode is a real read-only CLI and cannot execute an injected command", () => {
  const result = spawnSync(process.execPath, ["bench/workloads/run.mjs", "--plan", "catalog-page", "w1", "--out", "folder;echo nope"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.args.at(-1), "folder;echo nope");
  assert.equal(plan.group, "catalog-page");
});
