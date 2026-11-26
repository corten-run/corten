import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cpuSettings } from "./contract.mjs";
import { c16Env, c16Host, c16Layout, coldProbeCpus, layoutKey, loadSamplerCpus, placementCpus, recordedPlacement, runnerPlacement } from "./placement.mjs";
import { fleetPlan, jsonFleetPlacement, providerCreateHost, reservation } from "../workloads/cloud-contract.mjs";
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
  assert.deepEqual(runnerPlacement(c16Env, c16Host.logicalCpus), { loadLayout: c16Layout, cpus: wide, generatorPlacement: generator });
  assert.deepEqual(runnerPlacement(c16Env, 32).cpus, wide);
});

const generator = { coldProbe: { quota: 4, cpuset: "4-7" }, loadSampler: { quota: 12, cpuset: "4-15" } };
test("the c-32 selector requires the exact pins and a 32-CPU host, and records a quota of 20 for k6 alone", () => {
  const marker = "json-c32-generator-v1";
  const env = { ...pinned, [layoutKey]: marker, JSON_API_LOAD_CPUS: "4-23" };
  const cpus = cpuSettings(pinned);
  cpus.load = { ...cpus.load, quota: 20, cpuset: "4-23", args: ["--cpus", "20", "--cpuset-cpus", "4-23"] };
  const generatorPlacement = { coldProbe: generator.coldProbe, loadSampler: { quota: 20, cpuset: "4-23" } };
  const setting = runnerPlacement(env, 32);
  assert.deepEqual(setting, { loadLayout: marker, cpus, generatorPlacement });
  assert.deepEqual(coldProbeCpus(setting), cpuSettings(pinned).load);
  assert.deepEqual(loadSamplerCpus(setting), generatorPlacement.loadSampler);
  assert.deepEqual(recordedPlacement(setting), { placement: marker, cpus, generatorPlacement });
  for (const count of [16, 24, 31]) assert.throws(() => runnerPlacement(env, count), /needs 32 logical CPUs/);
  for (const vars of [{ JSON_API_LOAD_CPUS: "4-15" }, { JSON_API_APP_CPUS: "0" }, { JSON_API_API_CPUS: undefined }])
    assert.throws(() => runnerPlacement({ ...env, ...vars }, 32), /requires JSON_API_/);
  for (const wrong of [{ cpus }, { ...setting, loadLayout: c16Layout }, { loadLayout: marker, cpus },
    { ...setting, generatorPlacement: generator }, { ...setting, cpus: runnerPlacement(c16Env, 16).cpus }])
    assert.throws(() => recordedPlacement(wrong));
});

test("the fleet's saved c-16 placement is this layout's pins and host", () => {
  assert.deepEqual({ ...jsonFleetPlacement.cpuEnv, [layoutKey]: jsonFleetPlacement.loadLayout }, c16Env);
  assert.equal(jsonFleetPlacement.host.size, c16Host.size);
  assert.deepEqual(providerCreateHost(c16Layout), jsonFleetPlacement.host);
});

test("the cold probe stays on CPUs 4-7 while the load sampler accounts for all of k6's CPUs 4-15", () => {
  const wide = placementCpus(c16Env), measurement = { loadLayout: c16Layout, cpus: wide, generatorPlacement: generator };
  assert.deepEqual(coldProbeCpus(measurement), { quota: 4, cpuset: "4-7", placement: "explicit logical CPU pinning plus quota",
    args: ["--cpus", "4", "--cpuset-cpus", "4-7"] });
  assert.deepEqual(coldProbeCpus(measurement), cpuSettings(pinned).load);
  assert.deepEqual(loadSamplerCpus(measurement), { quota: 12, cpuset: "4-15" });
  assert.equal(loadSamplerCpus(measurement).quota * 80, 960);
  // The default keeps today's single load set for the probe, k6 and the sampler.
  for (const cpus of [cpuSettings(pinned), cpuSettings({})]) {
    assert.deepEqual(coldProbeCpus({ cpus }), cpus.load);
    assert.deepEqual(loadSamplerCpus({ cpus }), { quota: cpus.load.quota, cpuset: cpus.load.cpuset });
  }
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
  assert.deepEqual(recordedPlacement({ loadLayout: c16Layout, cpus: wide, generatorPlacement: generator }),
    { placement: c16Layout, cpus: wide, generatorPlacement: generator });
  const probe = (coldProbe) => ({ loadLayout: c16Layout, cpus: wide, generatorPlacement: { ...generator, coldProbe } });
  const sampler = (loadSampler) => ({ loadLayout: c16Layout, cpus: wide, generatorPlacement: { ...generator, loadSampler } });
  for (const measurement of [{ cpus: wide }, { loadLayout: c16Layout, cpus: cpuSettings(pinned) }, { loadLayout: c16Layout, cpus: wide },
    { loadLayout: c16Layout, cpus: wide, generatorPlacement: {} }, { cpus: cpuSettings(pinned), generatorPlacement: generator },
    { cpus: cpuSettings(pinned), generatorPlacement: undefined }, probe({ quota: 12, cpuset: "4-15" }), probe({ quota: 4, cpuset: "4-15" }),
    probe(undefined), sampler({ quota: 4, cpuset: "4-7" }), sampler({ quota: 12, cpuset: "4-7" }), sampler({ quota: 1, cpuset: "4-15" }),
    { loadLayout: c16Layout, cpus: wide, generatorPlacement: { ...generator, extra: true } },
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
