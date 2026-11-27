// Opt-in generator placements for the JSON API group (issue 2057). An independent json-api fleet
// saved with it passes JSON_API_LOAD_LAYOUT to run.mjs, which records it; report.mjs replays
// it. Without the selector every reader and writer keeps the default placement and bytes.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { jsonFleetPlacement, jsonFleetPlacementFor } from "../workloads/cloud-contract.mjs";
import { verifyNativePartition } from "../workloads/isolated/native-roles.mjs";
import { cpuSettings } from "./contract.mjs";

export const layoutKey = "JSON_API_LOAD_LAYOUT";
const definition = (layout) => jsonFleetPlacementFor("json-api", layout);
export const placementEnv = ({ cpuEnv, loadLayout }) => ({ ...cpuEnv, [layoutKey]: loadLayout });
export const c16Layout = jsonFleetPlacement.loadLayout;
export const c16Env = Object.freeze(placementEnv(jsonFleetPlacement));
export const c16Host = Object.freeze({ size: jsonFleetPlacement.host.size, logicalCpus: jsonFleetPlacement.logicalCpus });
const roles = ["app", "api", "load"];
// Two generator-side participants, recorded beside the layout. The untimed cold probe keeps
// its default placement, CPUs 4-7 at quota 4, as catalog's c16-generator-v1 does. The load
// resource sampler accounts for every assigned generator CPU at k6's quota.
const budget = ({ quota, cpuset }) => ({ quota, cpuset });
const coldProbeBudget = Object.freeze(budget(cpuSettings({ JSON_API_LOAD_CPUS: "4-7" }).load));

// Without JSON_API_LOAD_LAYOUT this is exactly contract.mjs cpuSettings(env).
export function placementCpus(env) {
  const layout = env[layoutKey];
  if (layout === undefined) return cpuSettings(env);
  const setting = definition(layout);
  assert.ok(setting, `${layoutKey}: unknown JSON API placement`);
  for (const [key, pins] of Object.entries(setting.cpuEnv)) {
    assert.equal(env[key], pins, `${layout} requires ${key}=${pins}`);
  }
  const cpus = cpuSettings(env);
  const quota = setting.loadQuota;
  cpus.load = { ...cpus.load, quota, args: ["--cpus", String(quota), "--cpuset-cpus", cpus.load.cpuset] };
  return cpus;
}

// Runner side: the opt-in refuses before any container starts on a host with too few CPUs.
export function runnerPlacement(env, logicalCpus) {
  const cpus = placementCpus(env), loadLayout = env[layoutKey];
  if (loadLayout === undefined) return { cpus };
  const minimum = definition(loadLayout).logicalCpus;
  assert.ok(Number.isSafeInteger(logicalCpus) && logicalCpus >= minimum,
    `${loadLayout} needs ${minimum} logical CPUs; this host has ${logicalCpus}`);
  verifyNativePartition(Object.fromEntries(roles.map((role) => [role, cpus[role].cpuset])), roles, logicalCpus);
  return { loadLayout, cpus, generatorPlacement: generatorPlacement(cpus) };
}

function generatorPlacement(cpus) {
  return { coldProbe: { ...coldProbeBudget }, loadSampler: budget(cpus.load) };
}
export const c16Generator = Object.freeze(generatorPlacement(placementCpus(c16Env)));

export function describePlacement(layout) {
  const setting = definition(layout);
  if (!setting) return;
  return { logicalCpus: setting.logicalCpus, ...generatorPlacement(placementCpus(placementEnv(setting))) };
}

// Docker arguments for the cold probe: the default load set, or 4-7 under either layout.
export function coldProbeCpus(measurement) {
  const { placement, cpus } = recordedPlacement(measurement);
  return placement === "default" ? cpus.load : cpuSettings({ JSON_API_LOAD_CPUS: coldProbeBudget.cpuset }).load;
}

// The quota and CPU set the load resource sampler accounts for: all of k6's assigned CPUs.
export function loadSamplerCpus(measurement) {
  return budget(recordedPlacement(measurement).cpus.load);
}

// Reader side: a result says its placement by an explicit marker, never by quota alone.
export function recordedPlacement(measurement) {
  const { loadLayout, cpus, generatorPlacement: recorded } = measurement ?? {};
  const env = Object.fromEntries(roles.map((role) => [`JSON_API_${role.toUpperCase()}_CPUS`, cpus?.[role]?.cpuset]));
  if (loadLayout !== undefined) {
    assert.ok(definition(loadLayout), "unknown recorded JSON API placement");
    env[layoutKey] = loadLayout;
  }
  const expected = placementCpus(env);
  assert.ok(isDeepStrictEqual(cpus, expected), "recorded CPU quotas or placement differ from the recorded layout");
  // The default never records the field, so its saved bytes do not change; the layout always does.
  if (loadLayout === undefined) assert.ok(!Object.hasOwn(measurement, "generatorPlacement"), "generator placement without a load layout");
  else assert.ok(isDeepStrictEqual(recorded, generatorPlacement(expected)), "recorded cold probe or load sampler placement differs from the recorded layout");
  return { placement: loadLayout ?? "default", cpus: expected,
    ...(loadLayout === undefined ? {} : { generatorPlacement: generatorPlacement(expected) }) };
}
