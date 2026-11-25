// Opt-in c-16 placement for the JSON API group (issue 2057). Not wired into run.mjs,
// report.mjs or the fleet yet; with no layout selected every result is the default.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { cpuSettings as catalogCpus } from "../catalog/contract.mjs";
import { verifyNativePartition } from "../workloads/isolated/native-roles.mjs";
import { cpuSettings } from "./contract.mjs";

export const layoutKey = "JSON_API_LOAD_LAYOUT";
export const c16Layout = "json-c16-generator-v1";
// The catalog c16-generator-v1 pins, under JSON API's own selector. CPU 0 stays with the host.
export const c16Env = Object.freeze({ JSON_API_APP_CPUS: "1", JSON_API_API_CPUS: "2-3", JSON_API_LOAD_CPUS: "4-15", [layoutKey]: c16Layout });
export const c16Host = Object.freeze({ size: "c-16", logicalCpus: 16 });
const roles = ["app", "api", "load"];

// Without JSON_API_LOAD_LAYOUT this is exactly contract.mjs cpuSettings(env).
export function placementCpus(env) {
  const layout = env[layoutKey];
  if (layout === undefined) return cpuSettings(env);
  assert.equal(layout, c16Layout, `${layoutKey}: unknown JSON API placement`);
  for (const key of ["JSON_API_APP_CPUS", "JSON_API_API_CPUS", "JSON_API_LOAD_CPUS"]) {
    assert.equal(env[key], c16Env[key], `${c16Layout} requires ${key}=${c16Env[key]}`);
  }
  return catalogCpus(Object.fromEntries(["APP", "API", "LOAD"].map((role) => [`CATALOG_${role}_CPUS`, env[`JSON_API_${role}_CPUS`]])), "c16-generator-v1");
}

// Runner side: the opt-in refuses before any container starts on a host with too few CPUs.
export function runnerPlacement(env, logicalCpus) {
  const cpus = placementCpus(env);
  if (env[layoutKey] === undefined) return { cpus };
  assert.ok(Number.isSafeInteger(logicalCpus) && logicalCpus >= c16Host.logicalCpus,
    `${c16Layout} needs ${c16Host.logicalCpus} logical CPUs; this host has ${logicalCpus}`);
  verifyNativePartition(Object.fromEntries(roles.map((role) => [role, cpus[role].cpuset])), roles, logicalCpus);
  return { loadLayout: c16Layout, cpus };
}

// Reader side: a result says its placement by an explicit marker, never by quota alone.
export function recordedPlacement(measurement) {
  const { loadLayout, cpus } = measurement ?? {};
  const env = Object.fromEntries(roles.map((role) => [`JSON_API_${role.toUpperCase()}_CPUS`, cpus?.[role]?.cpuset]));
  if (loadLayout !== undefined) {
    assert.equal(loadLayout, c16Layout, "unknown recorded JSON API placement");
    env[layoutKey] = loadLayout;
  }
  const expected = placementCpus(env);
  assert.ok(isDeepStrictEqual(cpus, expected), "recorded CPU quotas or placement differ from the recorded layout");
  return { placement: loadLayout ?? "default", cpus: expected };
}
