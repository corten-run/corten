// Read-only comparison. No historical fullstack/catalog measures are imported.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { apps } from "./contract.mjs";
import { aggregateCold, phases, roundIdentity, timedProfiles } from "./run-contract.mjs";
import { validateSummary } from "./report.mjs";

const hostFields = ["cpu", "onlineCpus", "platform", "release", "node", "docker"];
const measurementOptions = ({ round, build, ...options }) => options;
const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;

/** SHA-256 regression key, independent of round/build/commit and JSON property order.
 * Includes all measurement options (including future keys), full measurement metadata,
 * schema/workload/fixture, CPU hardware/topology/pinning, host software and tool images.
 * An equal key is necessary, not sufficient: compare also requires earlier official
 * identity and full validated evidence. Reference adapters require caller attestation.
 */
export function comparisonKey(s) {
  validateSummary(s);
  for (const key of hostFields) if (typeof s.host[key] !== "string" || !s.host[key]) throw new Error(`Missing host ${key}; no comparison key.`);
  const input = { schema: s.schema, workload: s.workload, fixtureSha256: s.fixtureSha256,
    options: measurementOptions(s.options), measurement: s.measurement,
    host: Object.fromEntries(hostFields.map((k) => [k, s.host[k]])),
    tools: Object.fromEntries(["upstream", "k6"].map((tool) => [tool, s.tools[tool].imageId])) };
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

/**
 * Comparison schema marketplace-comparison/v1: rows contain app/profile/phase and
 * metrics {baseline:{median,min,max}, current:{median,min,max}, percentChange,
 * rangesOverlap}. Percent change is current/baseline - 1, not a speedup claim;
 * a zero baseline produces null. cold contains app/profile rows for the two cold
 * metrics with the same delta shape. Missing/incompatible evidence produces neither.
 * Corten is always the regression subject, including when its implementation changes.
 * unchangedApps attests only to non-Corten reference adapters; it is not inferred from
 * image IDs, commits, or output. cohort.rows/cohort.cold summarize those adapters'
 * individual median percentage changes: conventional median plus min/max across apps,
 * not a ratio of cohort medians or a correction applied to Corten. Zero baselines are
 * excluded with names/counts; an empty cohort has no summaries, not invented zeroes.
 * Equal measurement options, fixture, result schema, CPU model/topology/placement,
 * host software and load/upstream images are required. Build flags are not measures.
 */
export function compare(current, baseline, { unchangedApps = [] } = {}) {
  const result = { schema: "marketplace-comparison/v1", current: current?.round ?? null,
    baseline: baseline?.round ?? null, compatible: false, comparisonKeys: null, subject: "corten",
    unchangedApps: [], rows: [], cold: [], cohort: { apps: [], rows: [], cold: [] }, warnings: [] };
  const warn = (message) => result.warnings.push(message);
  for (const [name, summary] of [["current", current], ["baseline", baseline]]) {
    try { validateSummary(summary); }
    catch (error) { warn(`${name} rejected: ${error.message}`); }
  }
  if (result.warnings.length) return result;
  try { result.comparisonKeys = { current: comparisonKey(current), baseline: comparisonKey(baseline) }; }
  catch (error) { warn(error.message); }
  const now = roundIdentity(current.round), old = roundIdentity(baseline.round);
  if (now.kind !== "official" || old.kind !== "official" || old.number >= now.number) warn("Comparison requires an earlier official marketplace-v2 r17+ baseline; development, legacy r16 and catalog rounds have no deltas.");
  const same = (label, a, b) => { if (!isDeepStrictEqual(a, b)) warn(`Incompatible ${label}; no deltas.`); };
  for (const key of ["schema", "workload", "fixtureSha256", "measurement"]) same(key, current[key], baseline[key]);
  same("measurement options", measurementOptions(current.options), measurementOptions(baseline.options));
  for (const key of hostFields) {
    if (typeof current.host[key] !== "string" || !current.host[key] || typeof baseline.host[key] !== "string" || !baseline.host[key]) warn(`Missing host ${key}; no deltas.`);
    else same(`host ${key}`, current.host[key], baseline.host[key]);
  }
  for (const tool of ["upstream", "k6"]) same(`${tool} image`, current.tools[tool].imageId, baseline.tools[tool].imageId);
  if (!Array.isArray(unchangedApps) || new Set(unchangedApps).size !== unchangedApps.length || unchangedApps.some((app) => !apps.includes(app))) warn("unchangedApps must be distinct known adapter names supplied by the caller; no deltas.");
  if (result.warnings.length) return result;
  result.compatible = true;
  result.unchangedApps = unchangedApps.filter((app) => app !== "corten");
  result.cohort.apps = [...result.unchangedApps];
  const comparedApps = ["corten", ...result.unchangedApps];
  warn("New marketplace-v2 baseline only: no r16 or catalog cross-workload delta. Caller-attested unchanged adapters are not independently verified. Median deltas are observations, not significance or maximum-capacity claims; overlapping pass ranges do not establish a difference.");
  warn("Corten is always compared as the regression subject, not an unchanged reference. Cohort median percentage changes provide context only; they do not normalize Corten or establish causation.");
  const excluded = apps.filter((app) => !comparedApps.includes(app));
  if (excluded.length) warn(`No reference deltas for adapters not declared unchanged: ${excluded.join(", ")}.`);
  if (!result.unchangedApps.length) warn("No non-Corten unchanged reference cohort supplied; Corten deltas have no cohort context.");
  if (Object.values(current.measurement.cpus).some((c) => !c.cpuset)) warn("CPU quota-only placement does not prove isolation in either round.");
  const delta = (a, b) => ({ baseline: { ...a }, current: { ...b }, percentChange: a.median === 0 ? null : (b.median / a.median - 1) * 100,
    rangesOverlap: a.min <= b.max && b.min <= a.max });
  for (const app of comparedApps) for (const { key } of timedProfiles) for (const phase of phases) {
    const row = { app, profile: key, phase, metrics: {}, warnings: [] };
    for (const metric of ["rps", "p50", "p95", "p99", "cpuAvgPct", "cpuPerRequestUsec", "memAvgMiB", "memMaxMiB", "perCpuSecond"]) {
      const a = baseline.apps[app].phases[key][phase][metric], b = current.apps[app].phases[key][phase][metric];
      row.metrics[metric] = delta(a, b);
    }
    for (const [name, summary] of [["baseline", baseline], ["current", current]]) for (const run of summary.apps[app].runs[key]) {
      const p = run.phases[phase];
      if (p.upstream?.highCpu) row.warnings.push(`${name} pass ${run.pass}: busy upstream may limit throughput.`);
      if (phase !== "fixed" && p.cpuAvgPct < 95) row.warnings.push(`${name} pass ${run.pass}: app saturation not demonstrated.`);
    }
    result.rows.push(row);
  }
  for (const app of comparedApps) for (const { key } of timedProfiles) {
    const a = aggregateCold(baseline.apps[app].runs[key]), b = aggregateCold(current.apps[app].runs[key]);
    result.cold.push({ app, profile: key, metrics: Object.fromEntries(Object.keys(a).map((metric) => [metric, delta(a[metric], b[metric])])) });
  }
  const summarizeCohort = (rows) => {
    const groups = new Map();
    for (const row of rows.filter((r) => r.app !== "corten")) {
      const groupKey = `${row.profile}/${row.phase ?? "cold"}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { profile: row.profile, ...(row.phase ? { phase: row.phase } : {}), metrics: {} });
      const group = groups.get(groupKey);
      for (const [metric, value] of Object.entries(row.metrics)) {
        const entries = group.metrics[metric] ??= [];
        entries.push({ app: row.app, percentChange: value.percentChange });
      }
    }
    return [...groups.values()].map((group) => ({ ...group, metrics: Object.fromEntries(Object.entries(group.metrics).map(([metric, entries]) => {
      const values = entries.filter((e) => e.percentChange !== null).map((e) => e.percentChange).sort((a, b) => a - b);
      const n = values.length;
      return [metric, { apps: n, excludedApps: entries.filter((e) => e.percentChange === null).map((e) => e.app),
        medianPercentChange: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
        minPercentChange: n ? values[0] : null, maxPercentChange: n ? values[n - 1] : null }];
    })) }));
  };
  result.cohort.rows = summarizeCohort(result.rows);
  result.cohort.cold = summarizeCohort(result.cold);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [current, baseline, flag, names] = process.argv.slice(2);
  if (!current || !baseline || (flag && (flag !== "--unchanged-apps" || !names)) || process.argv.length > 6) throw new Error("usage: node bench/marketplace/compare.mjs current.json baseline.json [--unchanged-apps nextjs,rails]");
  const result = compare(JSON.parse(readFileSync(current, "utf8")), JSON.parse(readFileSync(baseline, "utf8")), { unchangedApps: names?.split(",") ?? [] });
  console.log(JSON.stringify(result, null, 2));
  if (!result.compatible) process.exitCode = 1;
}
