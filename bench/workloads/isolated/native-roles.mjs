import assert from "node:assert/strict";
import { budgets } from "../../hardening/plan.mjs";
import { jsonFleetPlacementFor } from "../cloud-contract.mjs";

export const clientActorCpus = Object.freeze({ client: "4-7" });
export const liveActorCpus = Object.freeze({ application: "1", browser: "4-7" });
export const liveApplication = Object.freeze({ cpu: 1, memoryBytes: 2 ** 30 });
export const liveGroup = (group) => group === "live-delivery" || group === "recoverable-live";
export const hardeningActorCpus = Object.freeze({ application: "1", upstream: "2", proxy: "3", apparatus: "4-5", command: "6-7" });
export const hardeningCpuGate = "bench/hardening/cpu-gate.mjs";
export const hardeningGateMs = 6000;
export const hardeningRoleCpu = (role) => hardeningActorCpus[
  ["applicationDirect", "applicationEdge"].includes(role) ? "application" : role === "qualification" ? "apparatus" : role];

export function cpuRanges(cpus) {
  assert.match(cpus, /^(0|[1-9]\d*)(?:-(0|[1-9]\d*))?(?:,(0|[1-9]\d*)(?:-(0|[1-9]\d*))?)*\n?$/);
  const ranges = [];
  for (const range of cpus.trim().split(",")) {
    const [start, end = start] = range.split("-").map(Number), previous = ranges.at(-1);
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > (previous?.[1] ?? -1) && end >= start);
    if (previous && start - previous[1] === 1) previous[1] = end;
    else ranges.push([start, end]);
  }
  return ranges;
}

export function cpuSetWithin(actual, cpuset) {
  const allowed = cpuRanges(cpuset);
  return cpuRanges(actual).every(([start, end]) => allowed.some(([first, last]) => start >= first && end <= last));
}

export function verifyNativePartition(cpus, roles, cpuCount = 4096) {
  assert.ok(cpus && roles.every((role) => typeof cpus[role] === "string" && cpus[role]), "native CPU partition absent");
  assert.deepEqual(Object.keys(cpus).sort(), [...roles].sort(), "unexpected native CPU role");
  const used = new Set();
  for (const role of roles) {
    assert.match(cpus[role], /^(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?(?:,(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?)*$/);
    let previous = -1;
    for (const part of cpus[role].split(",")) {
      const [first, last = first] = part.split("-").map(Number);
      assert.ok(Number.isSafeInteger(first) && first > previous && last >= first && last < cpuCount, "invalid native CPU range for the host");
      assert.ok(first > 0, "control CPU0 overlaps native CPUs");
      for (let cpu = first; cpu <= last; cpu++) {
        assert.ok(!used.has(cpu), "native CPU roles overlap"); used.add(cpu);
      }
      previous = last;
    }
  }
}

// Mixed has a throughput partition for its measured stage, not functional capture.
export function nativeControlPartition(binding) {
  const { resources, request: { group } } = binding;
  let cpus, roles, fixed;
  if (group === "fullstack-browser") {
    cpus = resources.browserCpus; roles = ["application", "upstream", "browser"];
  } else if (group === "client-heavy" || liveGroup(group)) {
    fixed = group === "client-heavy" ? clientActorCpus : liveActorCpus;
    cpus = resources.actorCpus; roles = Object.keys(fixed);
  } else if (group === "hardening") {
    fixed = hardeningActorCpus;
    cpus = resources.actorCpus; roles = Object.keys(fixed);
    assert.equal(binding.execution.effectiveOptions.isolated, true, "native hardening isolation must be enabled");
    assert.equal(binding.execution.effectiveOptions.profile, "bounded", "native hardening must use the bounded profile");
    assert.deepEqual(resources.budget, budgets().resources, "native hardening budgets differ from the runner");
    assert.ok(binding.sources?.files.some((f) => f.path === hardeningCpuGate), "native hardening CPU gate absent from bound sources");
  } else if (["catalog-page", "json-api", "localized-marketplace", "mixed-production"].includes(group)) {
    roles = ["app", "api", "load"];
    cpus = Object.fromEntries(Object.entries((group === "mixed-production" ? resources.measurement?.cpu : resources.expectedCpus) ?? {})
      .map(([role, value]) => [role, value.cpuset]));
  } else {
    assert.fail(group + ": native CPU partition absent");
  }
  const size = binding.host?.size;
  const json = jsonFleetPlacementFor("json-api", binding.campaignMode);
  if (size === "c-32" || json?.host.size === "c-32") {
    assert.ok(group === "json-api" && size === "c-32" && json?.host.size === size
      && resources.requestedCpuEnv?.JSON_API_LOAD_LAYOUT === json.loadLayout, "c-32 host requires the JSON API c-32 placement");
    for (const role of roles) assert.equal(cpus[role], json.cpuEnv[`JSON_API_${role.toUpperCase()}_CPUS`], "native CPU partition differs from the JSON API c-32 layout");
  } else if (size !== undefined) assert.ok(["c-8", "c-16"].includes(size), "unknown native CPU host size");
  verifyNativePartition(cpus, roles, size === undefined ? undefined : Number(size.slice(2)));
  if (fixed) assert.deepEqual(cpus, fixed, "native CPU partition differs from the runner");
  if (liveGroup(group)) {
    assert.equal(binding.execution.effectiveOptions.isolated, true, "native live isolation must be enabled");
    assert.deepEqual(resources.app, liveApplication, "native live application budget differs from the runner");
  }
  return { cpus, roles };
}

// Missing actor fields are tolerated only for historical (non-isolated) inspection.
export function commandCpuSet(binding) {
  const group = binding.request.group;
  if (group === "fullstack-browser") {
    if (binding.resources?.browserCpus || binding.execution?.effectiveOptions?.isolated) {
      assert.ok(binding.resources?.browserCpus, "native browser CPU partition absent");
      return nativeControlPartition(binding).cpus.browser;
    }
  } else if (group === "client-heavy" || liveGroup(group)) {
    if (binding.resources?.actorCpus || binding.execution?.effectiveOptions?.isolated) {
      const { cpus } = nativeControlPartition(binding);
      return group === "client-heavy" ? cpus.client : cpus.browser;
    }
  } else if (group === "hardening" && (binding.resources?.actorCpus || binding.execution?.effectiveOptions?.isolated)) {
    return nativeControlPartition(binding).cpus.command;
  }
}
