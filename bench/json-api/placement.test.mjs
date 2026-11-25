import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cpuSettings } from "./contract.mjs";
import { c16Env, c16Host, c16Layout, layoutKey, placementCpus, recordedPlacement, runnerPlacement } from "./placement.mjs";
import { fleetPlan, reservation } from "../workloads/cloud-contract.mjs";
import { remoteFiles } from "../workloads/cloud-remote.mjs";
import { groupNames } from "../workloads/registry.mjs";

const pinned = { JSON_API_APP_CPUS: "1", JSON_API_API_CPUS: "2-3", JSON_API_LOAD_CPUS: "4-7" };
const without = (key) => Object.fromEntries(Object.entries(c16Env).filter(([name]) => name !== key));

test("without the selector the placement is byte-for-byte the default contract", () => {
  for (const env of [{}, pinned, { ...pinned, CATALOG_LOAD_LAYOUT: "c16-generator-v1", CATALOG_LOAD_CPUS: "4-15" }]) {
    assert.equal(JSON.stringify(placementCpus(env)), JSON.stringify(cpuSettings(env)));
    assert.deepEqual(runnerPlacement(env, 8), { cpus: cpuSettings(env) });
  }
  assert.equal(cpuSettings(pinned).load.quota, 4);
});

test("the c-16 selector gives k6 CPUs 4-15 and leaves the app and upstream budgets unchanged", () => {
  const wide = placementCpus(c16Env), base = cpuSettings(pinned);
  assert.deepEqual(wide.load, { quota: 12, cpuset: "4-15", placement: "explicit logical CPU pinning plus quota",
    args: ["--cpus", "12", "--cpuset-cpus", "4-15"] });
  assert.deepEqual(wide.app, base.app);
  assert.deepEqual(wide.api, base.api);
  assert.deepEqual(runnerPlacement(c16Env, c16Host.logicalCpus), { loadLayout: c16Layout, cpus: wide });
  assert.deepEqual(runnerPlacement(c16Env, 32).cpus, wide);
});

test("the selector refuses another name, an empty value or any other pin", () => {
  for (const env of [{ ...c16Env, [layoutKey]: "" }, { ...c16Env, [layoutKey]: "c16-generator-v1" },
    { ...pinned, [layoutKey]: c16Layout }, { ...c16Env, JSON_API_LOAD_CPUS: "4-13" }, { ...c16Env, JSON_API_API_CPUS: "2-4" },
    { ...c16Env, JSON_API_APP_CPUS: "0" }, without("JSON_API_APP_CPUS"), without("JSON_API_API_CPUS"), without("JSON_API_LOAD_CPUS")]) {
    assert.throws(() => placementCpus(env));
    assert.throws(() => runnerPlacement(env, 16));
  }
});

test("the c-16 selector refuses a host with fewer than 16 logical CPUs before any container starts", () => {
  for (const cpus of [4, 8, 12, 15, 0, Number.NaN, undefined]) {
    assert.throws(() => runnerPlacement(c16Env, cpus), /needs 16 logical CPUs/);
  }
  assert.deepEqual(runnerPlacement(pinned, 8), { cpus: cpuSettings(pinned) });
});

test("a result names its placement with an explicit marker that must agree with its recorded CPUs", () => {
  assert.deepEqual(recordedPlacement({ cpus: cpuSettings(pinned) }), { placement: "default", cpus: cpuSettings(pinned) });
  assert.deepEqual(recordedPlacement({ cpus: cpuSettings({}) }), { placement: "default", cpus: cpuSettings({}) });
  const wide = placementCpus(c16Env);
  assert.deepEqual(recordedPlacement({ loadLayout: c16Layout, cpus: wide }), { placement: c16Layout, cpus: wide });
  for (const measurement of [{ cpus: wide }, { loadLayout: c16Layout, cpus: cpuSettings(pinned) },
    { loadLayout: "c16-generator-v1", cpus: wide }, { loadLayout: c16Layout, cpus: { ...wide, load: { ...wide.load, quota: 4 } } },
    { cpus: { ...cpuSettings(pinned), load: { ...cpuSettings(pinned).load, quota: 12 } } }, {}, undefined]) {
    assert.throws(() => recordedPlacement(measurement));
  }
});

test("the c-16 placement relies on the load bound scaling with the k6 quota and keeps the one-core upstream bound", () => {
  // Pins the existing fences this placement depends on; it changes none of them.
  const source = readFileSync(new URL("./production.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("expected.cpus.load.quota * 80"), "load headroom bound no longer scales with the k6 quota");
  assert.ok(source.includes("stats.upstream.cpuMaxPct >= 80"), "single-process upstream bound changed");
  assert.equal(placementCpus(c16Env).load.quota * 80, 960);
  assert.equal(cpuSettings(pinned).load.quota * 80, 320);
});

test("the selector in the controller's environment cannot change a generated JSON API job", () => {
  const commit = "a".repeat(40), tokens = Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")]));
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16), tokens,
    provider: { accountId: "user:synthetic-fixture", context: "synthetic-fixture" }, sshKey: "42" });
  const state = reservation({ round: "r21", commit, token: tokens["json-api"], group: "json-api", fleet });
  const before = remoteFiles(state), saved = Object.fromEntries(Object.keys(c16Env).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, c16Env);
    assert.deepEqual(remoteFiles(state), before);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  for (const bytes of Object.values(before)) assert.ok(!bytes.includes(c16Layout) && !bytes.includes(layoutKey));
  assert.ok(!before["job.sh"].includes("--load-layout"));
});
