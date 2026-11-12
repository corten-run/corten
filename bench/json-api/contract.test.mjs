import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { definition, selectedApps } from "../workloads/registry.mjs";
import { appArgs, buildPlan, cpuSettings, descriptor, loadConfig, parseArgs, route, runtimeContext, runtimeReceipt, timingPlan, verifyNativeReceipt } from "./contract.mjs";
import { result, runtimeInfo } from "./test-fixtures.mjs";
import { executeMatrix } from "./matrix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
test("explicit registry JSON selection includes nine native apps, four cases and both distinct ASP.NET rows", () => {
  const group = descriptor(), options = parseArgs(["j1", "--group", "json-api"]);
  assert.deepEqual(options.apps, ["corten", "aspnet", "fastapi", "express", "spring", "axum-maud", "drogon", "gin", "aspnet-aot"]);
  assert.deepEqual(options.apps, selectedApps("json-api")); assert.deepEqual(group.cases, definition("json-api").cases);
  assert.equal(group.cases.length, 4); assert.ok(group.cases.every((p) => p.target === "json" && p.locale === null));
  for (const args of [["j1"], ["c1", "--group", "json-api"], ["j01", "--group", "json-api"],
    ["j1", "--group", "catalog-page"], ["j1", "--group", "json-api", "--apps", "corten"],
    ["j1", "--group", "json-api", "--group", "json-api"], ["j1", "--group", "json-api", "--passes", "2"],
    ["j1", "--group", "json-api", "--duration", "301"], ["j1", "--group", "json-api", "--receipts"]]) assert.throws(() => parseArgs(args));
  const child = spawnSync(process.execPath, [join(here, "run.mjs"), "j1"], { encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, BENCH_APPS: "corten", BENCH_TIER: "matched" } });
  assert.equal(child.status, 1); assert.match(child.stderr, /explicit --group/);
});

test("observed runtime and audited native snapshots bind source, payload, image and CPU independently of functional checks", () => {
  const evidence = result(), profile = descriptor().cases[0], checked = evidence.summary.apps.corten.checks[profile.key], expected = checked.identity;
  const context = runtimeContext(evidence.summary, profile), info = runtimeInfo(expected, context);
  assert.equal(runtimeReceipt(info, expected, context).quota, 1);
  for (const mutate of [
    (i) => { i.Config.Env[0] = "CATALOG_SOURCE=api"; }, (i) => { i.Image = "another image"; },
    (i) => { i.HostConfig.NanoCpus = 2e9; }, (i) => { i.HostConfig.Memory = 2 ** 31; },
  ]) { const bad = structuredClone(info); mutate(bad); assert.throws(() => runtimeReceipt(bad, expected, context)); }
  const native = evidence.load(checked.native); assert.equal(verifyNativeReceipt(native.receipt, expected, native.files), true);
  for (const mutate of [
    (n) => { n.receipt.verified.noJsonPassthrough = false; }, (n) => { n.receipt.findings = ["not audited"]; },
    (n) => { n.receipt.sourceFiles.push(n.receipt.sourceFiles[0]); },
    (n) => { n.receipt.auditor = ""; }, (n) => { n.receipt.identity.app = "aspnet-aot"; },
    (n) => { n.receipt.sourceFiles[0].path = "bench/../secret"; },
  ]) { const bad = structuredClone(native); mutate(bad); assert.throws(() => verifyNativeReceipt(bad.receipt, expected, bad.files)); }
});

test("timing plan covers every native app, payload and source without any HTML timing", () => {
  const options = parseArgs(["j1", "--group", "json-api"]), plan = timingPlan(options);
  assert.equal(plan.length, 9 * 4 * 3);
  assert.equal(new Set(plan.map((p) => `${p.app}:${p.profile.key}:${p.pass}`)).size, 108);
  for (const item of plan) {
    assert.deepEqual(item.stages, ["cold", "warmup", "fixed", "sat64", "sat256"]);
    assert.ok(route(item.profile).startsWith("/api/"));
    const args = appArgs({ name: "test", profile: item.profile, imageId: "immutable", network: "owned", upstream: "http://owned-api:8080", fixtures: "/test", cpus: cpuSettings({}) });
    assert.ok(args.includes(`${item.profile.payload === "catalog-v1" ? "CATALOG" : "MARKETPLACE"}_SOURCE=${item.profile.source}`));
    assert.equal(args.at(-1), "immutable"); assert.ok(!args.includes("PROFILE=matched"));
  }
  assert.notEqual(buildPlan("aspnet", "catalog-v1").context, buildPlan("aspnet-aot", "catalog-v1").context);
  assert.match(buildPlan("corten", "catalog-v1").dockerfile, /bench\/catalog\/corten/);
  assert.match(buildPlan("corten", "marketplace-v2").dockerfile, /bench\/marketplace\/corten/);
  assert.deepEqual(["warmup", "fixed", "sat64", "sat256"].map((p) => loadConfig(options, p).vus), [32, 64, 64, 256]);
  assert.throws(() => timingPlan({ ...options, apps: ["corten"] }));
  const cpus = cpuSettings({ CATALOG_APP_CPUS: "7", BENCH_APP_CPUS: "8" }); assert.equal(cpus.app.cpuset, null);
  assert.throws(() => cpuSettings({ JSON_API_APP_CPUS: "0", JSON_API_LOAD_CPUS: "0" }));
  const load = readFileSync(join(here, "load.js"), "utf8");
  assert.ok(load.includes('"/api/catalog/record_"') && load.includes('"/api/marketplace/item_"'));
  assert.ok(!/browser|text\/html|FormData/.test(load));
});

test("app order rotates deterministically across passes while every explicit profile keeps a complete matrix", async () => {
  for (const passes of [1, 3, 5]) {
    const options = parseArgs(["j1", "--group", "json-api", "--passes", String(passes)]), before = structuredClone(options);
    const plan = timingPlan(options), group = descriptor();
    assert.deepEqual(timingPlan(options), plan); assert.deepEqual(options, before);
    assert.equal(plan.length, group.apps.length * group.cases.length * passes);
    assert.equal(new Set(plan.map((p) => `${p.app}:${p.profile.key}:${p.pass}`)).size, plan.length);
    for (let pass = 1; pass <= passes; pass++) {
      const offset = Math.floor((pass - 1) * group.apps.length / passes);
      const expected = group.apps.slice(offset).concat(group.apps.slice(0, offset));
      assert.deepEqual(plan.filter((item) => item.pass === pass).map((item) => item.profile.key),
        group.cases.flatMap((profile) => group.apps.map(() => profile.key)));
      for (const profile of group.cases) {
        const items = plan.filter((item) => item.pass === pass && item.profile.key === profile.key);
        assert.deepEqual(items.map((item) => item.app), expected);
        assert.ok(items.every((item) => JSON.stringify(item.profile) === JSON.stringify(profile)));
      }
    }
    const measured = [];
    await executeMatrix(options, { prepare: async () => {}, check: async () => true, gate: async () => {},
      measure: async (item) => measured.push(item), failure: async (...args) => assert.fail(JSON.stringify(args)) }, plan);
    assert.deepEqual(measured, plan, "native execution consumes exactly the rotated plan");
    const wrong = structuredClone(plan); [wrong[0], wrong[1]] = [wrong[1], wrong[0]];
    await assert.rejects(executeMatrix(options, {}, wrong), /effective timing plan differs/);
  }
  const runner = readFileSync(join(here, "run.mjs"), "utf8");
  assert.match(runner, /timingPlan: c\.timingPlan\(options\)/);
  assert.match(runner, /\}, summary\.timingPlan\)/, "runner consumes the plan recorded in its summary");
});

test("fake native operations execute the full matrix, and any missing implementation/audit blocks all timing", async () => {
  const options = parseArgs(["j1", "--group", "json-api", "--passes", "1"]);
  for (const fault of [null, "missing-aot", "build-failed", "missing-audit", "check-only"]) {
    const seen = [], failures = [];
    const io = {
      prepare: async (app, payload) => { seen.push(["prepare", app, payload]); if ((fault === "missing-aot" && app === "aspnet-aot") || (fault === "build-failed" && app === "spring")) throw Error("implementation absent"); },
      check: async (app, profile) => { seen.push(["check", app, profile.key]); if (fault === "missing-audit" && app === "gin") return false;
        if (fault === "missing-aot" && app === "aspnet-aot") throw Error("endpoint absent"); return true; },
      gate: async (qualified) => seen.push(["gate", qualified]), measure: async (item) => seen.push(["measure", item]),
      failure: async (...args) => failures.push(args),
    };
    await executeMatrix({ ...options, checkOnly: fault === "check-only" }, io);
    assert.equal(seen.filter(([op]) => op === "prepare").length, 18);
    assert.equal(seen.filter(([op]) => op === "check").length, 36, "failures do not filter selected rows");
    assert.equal(seen.filter(([op]) => op === "measure").length, fault === null ? 36 : 0);
    if (fault === null) assert.ok(seen.findIndex(([op]) => op === "measure") > seen.findIndex(([op]) => op === "gate"));
    if (fault === "missing-aot") assert.equal(failures.length, 6);
  }
});
