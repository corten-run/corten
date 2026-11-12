// Pure native-runner selection/provenance. No readiness or inventory filtering.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { contractSha256, definition, registrySchema, selectedApps } from "../workloads/registry.mjs";

export const groupResultSchema = "catalog-group-results/v1";
export function groupDescriptor(name) {
  assert.equal(name, "catalog-page", "catalog runner supports only --group catalog-page");
  const cases = structuredClone(definition(name).cases);
  assert.ok(cases.every((c) => c.payload === "catalog-v1" && c.target === "page" && c.locale === null), "not a native catalog-page contract");
  return { schema: "catalog-group/v1", registrySchema, group: name, contractSha256: contractSha256(name),
    apps: selectedApps(name), cases, sources: [...new Set(cases.map((c) => c.source))],
    targets: [...new Set(cases.map((c) => c.target))], correctnessTargets: ["page", "json"] };
}

// The runner consumes this plan for cold probes, warmup AND every load phase.
// Legacy callers retain their original source/app/target order and both targets.
export function timingPlan(options, sources, targets) {
  const group = options.group === undefined ? null : groupDescriptor(options.group);
  if (group) assert.deepEqual(options.apps, group.apps, "group requires the exact registry apps");
  const cases = group?.cases ?? sources.flatMap((source) => targets.map((target) => ({ source, target })));
  const plan = [];
  for (let pass = 1; pass <= options.passes; pass++) for (const source of group?.sources ?? sources) for (const app of options.apps) {
    for (const profile of cases.filter((c) => c.source === source)) plan.push({ app, pass, ...profile });
  }
  return plan;
}

export function qualificationIdentity(group, app, source, imageId) {
  return { app, source, payload: group.cases[0].payload, targets: group.correctnessTargets, imageId };
}

const nonnegative = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
function successfulLoad(phase, measured) {
  return phase && Number.isSafeInteger(phase.requests) && phase.requests > 0 && nonnegative(phase.rps) && phase.rps > 0
    && ["p50", "p95", "p99"].every((key) => nonnegative(phase[key])) && phase.failed === 0 && phase.dropped === 0
    && (!measured || (["perCpuSecond", "memMaxMiB", "cpuUsec"].every((key) => nonnegative(phase[key]) && phase[key] > 0)
      && nonnegative(phase.cpuAvgPct)));
}

// Missing evidence remains reportable, but can never be a complete comparison.
// Contradictory/extra evidence is malformed, rather than silently ignored.
export function inspectGroupEvidence(summary, phases, aggregate) {
  if (summary.group === undefined && summary.options?.group === undefined && summary.schema !== groupResultSchema) return null;
  assert.equal(summary.schema, groupResultSchema, "missing or unsupported catalog group result schema");
  const group = groupDescriptor(summary.options?.group);
  assert.deepEqual(summary.group, group, "catalog group descriptor/contract differs");
  assert.deepEqual(summary.options.apps, group.apps, "group requires the exact registry apps");
  const warnings = [];
  const missing = (message) => warnings.push(message);
  if (!/^[0-9a-f]{40}$/.test(summary.commitAfter ?? "") || summary.commitAfter !== summary.commit
    || summary.dirtyAfter !== false) missing("After-run commit/tree provenance is missing, dirty or differs from the measured HEAD.");
  assert.ok(Object.keys(summary.apps).every((app) => group.apps.includes(app)), "unexpected group app evidence");
  for (const app of group.apps) {
    const entry = summary.apps[app];
    if (!entry) { missing(`${app}: missing group app evidence.`); continue; }
    const imageValid = /^sha256:[0-9a-f]{64}$/.test(entry.imageId ?? "");
    if (!imageValid) missing(`${app}: missing immutable image identity.`);
    assert.ok(Object.keys(entry.checks ?? {}).every((source) => group.sources.includes(source)), `${app}: unexpected correctness source`);
    for (const source of group.sources) {
      const check = entry.checks?.[source];
      if (!check?.qualification) missing(`${app} ${source}: missing qualification identity.`);
      else assert.deepEqual(check.qualification, qualificationIdentity(group, app, source, entry.imageId), `${app} ${source}: wrong qualification identity`);
    }
    const keys = group.cases.map((c) => `${c.source}-${c.target}`);
    assert.ok(Object.keys(entry.runs ?? {}).every((key) => keys.includes(key)), `${app}: unexpected timing source/target`);
    assert.ok(Object.keys(entry.phases ?? {}).every((key) => keys.includes(key)), `${app}: unexpected aggregate source/target`);
    for (const profile of group.cases) {
      const key = `${profile.source}-${profile.target}`;
      const runs = entry.runs?.[key] ?? [];
      assert.ok(Array.isArray(runs), `${app} ${key}: runs must be an array`);
      const saved = entry.phases?.[key] ?? {};
      assert.ok(Object.keys(saved).every((phase) => phases.includes(phase)), `${app} ${key}: unexpected aggregate phase`);
      for (const phase of phases) {
        const measured = runs.filter((r) => r.phases?.[phase]).map((r) => r.phases[phase]);
        const derived = { ...aggregate(measured), asked: summary.options.passes };
        if (!isDeepStrictEqual(saved[phase], derived)) missing(`${app} ${key} ${phase}: aggregate missing or differs from individual runs/requested passes.`);
      }
      if (!runs.length) { missing(`${app} ${key}: missing group timing evidence.`); continue; }
      for (const run of runs) {
        if (!run.evidence) missing(`${app} ${key} pass ${run.pass}: missing timing identity.`);
        else assert.deepEqual(run.evidence, { app, ...profile, imageId: entry.imageId }, `${app} ${key}: wrong timing identity`);
        const measured = Object.keys(run.phases ?? {});
        assert.ok(measured.every((phase) => phases.includes(phase)), `${app} ${key}: unexpected timing phase`);
        if (!phases.every((phase) => successfulLoad(run.phases?.[phase], true)) || !successfulLoad(run.warmup, false)) missing(`${app} ${key} pass ${run.pass}: missing or unsuccessful warmup/load phases.`);
        const cold = run.cold;
        if (cold) assert.equal(cold.path, "/catalog/record_1", `${app} ${key}: wrong cold timing target`);
        const elapsed = Date.parse(cold?.first200At) - Date.parse(cold?.containerStartedAt);
        if (!cold || !nonnegative(elapsed) || !Number.isSafeInteger(summary.options.startupTimeout) || summary.options.startupTimeout <= 0
          || elapsed > summary.options.startupTimeout * 1000 || cold.first200MsFromContainerStart !== elapsed || cold.measuredBeforeReadinessOrWarmup !== true
          || !Number.isSafeInteger(cold.attempts) || cold.attempts <= 0 || !Number.isSafeInteger(cold.bytes) || cold.bytes <= 0
          || !nonnegative(cold.successfulRequestMs)) missing(`${app} ${key} pass ${run.pass}: missing or invalid cold timing evidence.`);
      }
    }
  }
  return { descriptor: group, keys: group.cases.map((c) => `${c.source}-${c.target}`), complete: warnings.length === 0, warnings };
}
