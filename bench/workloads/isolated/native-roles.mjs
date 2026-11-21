import assert from "node:assert/strict";

export const clientActorCpus = Object.freeze({ client: "4-7" });
export const liveActorCpus = Object.freeze({ application: "1", browser: "4-7" });
export const liveApplication = Object.freeze({ cpu: 1, memoryBytes: 2 ** 30 });
export const liveGroup = (group) => group === "live-delivery" || group === "recoverable-live";
export const hardeningRoleBlocker = "hardening: isolated benign service/recovery actor proof unavailable; connection-flood resistance not measured";

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
  } else if (["catalog-page", "json-api", "localized-marketplace", "mixed-production"].includes(group)) {
    roles = ["app", "api", "load"];
    cpus = Object.fromEntries(Object.entries((group === "mixed-production" ? resources.measurement?.cpu : resources.expectedCpus) ?? {})
      .map(([role, value]) => [role, value.cpuset]));
  } else {
    assert.fail(group === "hardening" ? hardeningRoleBlocker : group + ": native CPU partition absent");
  }
  const size = binding.host?.size;
  if (size !== undefined) assert.ok(["c-8", "c-16"].includes(size), "unknown native CPU host size");
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
  }
}
