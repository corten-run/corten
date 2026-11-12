// Read-only comparison. No historical fullstack/catalog measures are imported.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { aggregateCold, coldStop, phases, resultSchema, roundIdentity, stopsEarlier, timedProfiles } from "./run-contract.mjs";
import { validateSummary } from "./report.mjs";
import { admitted } from "./feature-contract.mjs";

const hostFields = ["cpu", "onlineCpus", "platform", "release", "node", "docker"];
const measurementOptions = ({ round, build, group = "full", ...options }) => ({ ...options, group });
const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
// A round split across droplets (#816) measured each app on its own droplet's machine: it
// compares only with a round split the same way, droplet by droplet. Null for a whole round.
// Each droplet's candidates and which of them it admitted are part of that shape.
const splitShape = (s) => s.split ? s.split.parts.map((p) => ({ apps: p.apps, admitted: p.apps.filter((a) => admitted(a === "corten" ? p.corten : s.apps[a])),
  host: Object.fromEntries(hostFields.map((k) => [k, p.host[k] ?? null])), tools: Object.fromEntries(["upstream", "k6"].map((tool) => [tool, p.tools[tool].imageId])) })) : null;

/** SHA-256 regression key, independent of round/build/commit and JSON property order.
 * Includes all measurement options (including future keys), full measurement metadata,
 * schema/workload/fixture, CPU hardware/topology/pinning, host software and tool images.
 * The schema in the key is the one a summary is read as: a v3 summary is read as v4 with no
 * stop records, so a v3 round and a v4 round with the same measurement share a key.
 * An equal key is necessary, not sufficient: compare also requires earlier official
 * identity and full validated evidence. Reference adapters require caller attestation.
 * A split round's key also has each droplet's apps, host and tool images; a whole round's is
 * unchanged.
 */
export function comparisonKey(s) {
  validateSummary(s);
  for (const key of hostFields) if (typeof s.host[key] !== "string" || !s.host[key]) throw new Error(`Missing host ${key}; no comparison key.`);
  const input = { schema: resultSchema, workload: s.workload, fixtureSha256: s.fixtureSha256,
    options: measurementOptions(s.options), measurement: s.measurement,
    host: Object.fromEntries(hostFields.map((k) => [k, s.host[k]])),
    tools: Object.fromEntries(["upstream", "k6"].map((tool) => [tool, s.tools[tool].imageId])),
    ...(s.split ? { split: splitShape(s) } : {}) };
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
 * Each row also has appOutcomes {baseline, current}: passes in which the app did not serve the
 * whole stage (#1128). newOutcomes lists the stages, Corten's and the references', that fail more
 * than in the baseline: more such passes, any failed request or dropped iteration where the
 * baseline had none in any pass, or a failure or drop range wholly above the baseline's. A
 * reference stage with an outcome in either round is left out of the cohort and named in that
 * cohort group's outcomeApps. Incompatible evidence has an empty newOutcomes.
 * Each row and cold row also has stopped {baseline, current}: the stop record (pass, phase,
 * exitCode, oomKilled) when the app's container stopped during a load phase and that stage, or
 * that profile's cold starts, lost passes to it, else null (#1128). A cold start is measured before
 * its pass's load, so cold rows lose passes only when a later pass did not run. A stopped stage or
 * cold row is an outcome, not a number, for Corten and the references alike: it has metrics null,
 * and a reference app's is left out of the cohort and named in outcomeApps. A stopped stage is in
 * newOutcomes when the baseline's stage had no stop, or when the current stop is earlier than the
 * baseline's: the stage has fewer measured passes, or the stop came in an earlier pass, or an
 * earlier phase of the same pass.
 * Equal measurement options, fixture, CPU model/topology/placement, host software and
 * load/upstream images are required, and both summaries in a schema the reporter reads (v3 or
 * v4: a v3 round, which failed on any stopped app, compares as a v4 round with no stop). Build
 * flags are not measures. A round split across droplets (#816) compares only with one split the
 * same way, each droplet's host and images equal to the baseline's same droplet; Corten is d1's.
 * Each row and cold row of a split round also has droplet: the number of the droplet its app was
 * measured on (Corten's is 1), the same in both rounds. A whole round's rows have no droplet.
 */
export function compare(current, baseline, { unchangedApps = [] } = {}) {
  const result = { schema: "marketplace-comparison/v1", current: current?.round ?? null,
    baseline: baseline?.round ?? null, compatible: false, comparisonKeys: null, subject: "corten",
    unchangedApps: [], rows: [], cold: [], cohort: { apps: [], rows: [], cold: [] }, newOutcomes: [], qualificationLosses: [], warnings: [] };
  const warn = (message) => result.warnings.push(message);
  for (const [name, summary] of [["current", current], ["baseline", baseline]]) {
    try { validateSummary(summary); }
    catch (error) { warn(`${name} rejected: ${error.message}`); }
  }
  if (result.warnings.length) return result;
  // One droplet's part of a split round has only its share of the apps: compare the merged round.
  for (const [name, summary] of [["current", current], ["baseline", baseline]]) if (summary.options.part) warn(`${name} is one droplet's part of a split round, not a round; compare the merged round; no deltas.`);
  if (result.warnings.length) return result;
  try { result.comparisonKeys = { current: comparisonKey(current), baseline: comparisonKey(baseline) }; }
  catch (error) { warn(error.message); }
  const now = roundIdentity(current.round), old = roundIdentity(baseline.round);
  // A lost capability is an observed investigation even when the changed admitted set
  // forbids performance deltas. It is not a claim about cause or statistical regression.
  if (now.kind === "official" && old.kind === "official" && old.number < now.number && current.options.group &&
    isDeepStrictEqual(measurementOptions(current.options), measurementOptions(baseline.options)) &&
    isDeepStrictEqual(current.measurement, baseline.measurement) && current.fixtureSha256 === baseline.fixtureSha256) {
    for (const app of current.options.apps) if (admitted(baseline.apps[app]) && !admitted(current.apps[app])) {
      result.qualificationLosses.push({ app, missing: Object.fromEntries(["fixture", "api"].map((source) => [source, current.apps[app].qualification[source].missing])) });
    }
  }
  if (now.kind !== "official" || old.kind !== "official" || old.number >= now.number) warn("Comparison requires an earlier official marketplace-v2 r17+ baseline; development, legacy r16 and catalog rounds have no deltas.");
  const same = (label, a, b) => { if (!isDeepStrictEqual(a, b)) warn(`Incompatible ${label}; no deltas.`); };
  // Both schemas passed validateSummary, so both are read as v4 (v3 with no stop records).
  for (const key of ["workload", "fixtureSha256", "measurement"]) same(key, current[key], baseline[key]);
  same("measurement options", measurementOptions(current.options), measurementOptions(baseline.options));
  same("qualified adapter set", Object.keys(current.apps).filter((a) => !current.options.group || admitted(current.apps[a])).sort(),
    Object.keys(baseline.apps).filter((a) => !baseline.options.group || admitted(baseline.apps[a])).sort());
  for (const key of hostFields) {
    if (typeof current.host[key] !== "string" || !current.host[key] || typeof baseline.host[key] !== "string" || !baseline.host[key]) warn(`Missing host ${key}; no deltas.`);
    else same(`host ${key}`, current.host[key], baseline.host[key]);
  }
  for (const tool of ["upstream", "k6"]) same(`${tool} image`, current.tools[tool].imageId, baseline.tools[tool].imageId);
  same("droplet split (candidates, admitted adapters, host and images per droplet)", splitShape(current), splitShape(baseline));
  if (!Array.isArray(unchangedApps) || new Set(unchangedApps).size !== unchangedApps.length || unchangedApps.some((app) => !current.options.apps.includes(app) || !baseline.options.apps.includes(app) || !current.apps[app]?.runs[timedProfiles[0].key] || !baseline.apps[app]?.runs[timedProfiles[0].key])) warn("unchangedApps must be distinct measured adapter names supplied by the caller; no deltas.");
  if (result.warnings.length) return result;
  result.compatible = true;
  result.unchangedApps = unchangedApps.filter((app) => app !== "corten");
  result.cohort.apps = [...result.unchangedApps];
  const comparedApps = ["corten", ...result.unchangedApps];
  warn("New marketplace-v2 baseline only: no r16 or catalog cross-workload delta. Caller-attested unchanged adapters are not independently verified. Median deltas are observations, not significance or maximum-capacity claims; overlapping pass ranges do not establish a difference.");
  warn("Corten is always compared as the regression subject, not an unchanged reference. Cohort median percentage changes provide context only; they do not normalize Corten or establish causation.");
  const excluded = current.options.apps.filter((app) => !comparedApps.includes(app));
  if (excluded.length) warn(`No reference deltas for adapters not declared unchanged: ${excluded.join(", ")}.`);
  if (!result.unchangedApps.length) warn("No non-Corten unchanged reference cohort supplied; Corten deltas have no cohort context.");
  if (Object.values(current.measurement.cpus).some((c) => !c.cpuset)) warn("CPU quota-only placement does not prove isolation in either round.");
  // The split shapes are equal, so an app is on the same droplet in both rounds.
  const droplet = current.split ? (app) => ({ droplet: app === "corten" ? 1 : current.split.parts.find((p) => p.apps.includes(app)).index }) : () => ({});
  // The cohort context mixes droplets only when an unchanged reference is not on Corten's d1.
  if (current.split) warn(`Split across ${current.split.droplets} droplets: Corten's rows are d1's, and each reference adapter's rows are from its own droplet (each row's droplet)${result.unchangedApps.some((app) => droplet(app).droplet !== 1) ? ", so the cohort context mixes droplets and their machines" : ""}.`);
  const delta = (a, b) => ({ baseline: { ...a }, current: { ...b }, percentChange: a.median === 0 ? null : (b.median / a.median - 1) * 100,
    rangesOverlap: a.min <= b.max && b.min <= a.max });
  // A stage that fails more than in the baseline is reported whatever the percentages say (a 0%
  // baseline has no percent change). Above a nonzero baseline, only a range wholly above it counts.
  const worse = (was, now) => (was.max === 0 && now.max > 0) || now.min > was.max;
  for (const app of comparedApps) for (const { key } of timedProfiles) for (const phase of phases) {
    const was = baseline.apps[app].phases[key][phase], now = current.apps[app].phases[key][phase];
    const row = { app, ...droplet(app), profile: key, phase, metrics: {}, warnings: [] };
    row.stopped = { baseline: was.stopped ?? null, current: now.stopped ?? null };
    row.appOutcomes = { baseline: was.appOutcomes, current: now.appOutcomes };
    const outcome = { app, profile: key, phase, appOutcomes: row.appOutcomes, failedRate: { baseline: was.failedRate, current: now.failedRate }, dropped: { baseline: was.dropped, current: now.dropped }, stopped: row.stopped };
    if (was.stopped || now.stopped) {
      // A stage the app stopped in has fewer passes, or none: an outcome, not a comparable number.
      row.metrics = null;
      if (now.stopped && (!was.stopped || now.passes < was.passes || stopsEarlier(now.stopped, was.stopped))) result.newOutcomes.push(outcome);
    } else {
      for (const metric of ["rps", "p50", "p95", "p99", "cpuAvgPct", "cpuPerRequestUsec", "memAvgMiB", "memMaxMiB", "perCpuSecond", "failedRate"]) row.metrics[metric] = delta(was[metric], now[metric]);
      if (now.appOutcomes > was.appOutcomes || worse(was.failedRate, now.failedRate) || worse(was.dropped, now.dropped)) result.newOutcomes.push(outcome);
    }
    for (const [name, summary] of [["baseline", baseline], ["current", current]]) for (const run of summary.apps[app].runs[key]) {
      if (run.stopped && row.stopped[name]) row.warnings.push(`${name} pass ${run.pass}: app container ${run.stopped.oomKilled ? "OOM-killed" : `exited (code ${run.stopped.exitCode})`} during ${run.stopped.phase}; the profile's later phases and passes were not run.`);
      const p = run.phases[phase];
      if (!p) continue;
      if (p.appOutcome) row.warnings.push(`${name} pass ${run.pass}: app outcome, ${p.failed} of ${p.requests} requests failed and ${p.dropped} iterations dropped; its numbers include them.`);
      if (p.upstream?.highCpu) row.warnings.push(`${name} pass ${run.pass}: busy upstream may limit throughput.`);
      if (phase !== "fixed" && p.cpuAvgPct < 95) row.warnings.push(`${name} pass ${run.pass}: app saturation not demonstrated.`);
    }
    result.rows.push(row);
  }
  for (const app of comparedApps) for (const { key } of timedProfiles) {
    const was = baseline.apps[app].runs[key], now = current.apps[app].runs[key];
    // Cold starts are measured in every pass that ran: a stop loses them only when a later pass did
    // not run, and then they are not three passes, so no delta.
    const stopped = { baseline: coldStop(was, 3), current: coldStop(now, 3) };
    const a = aggregateCold(was), b = aggregateCold(now);
    result.cold.push({ app, ...droplet(app), profile: key, stopped,
      metrics: stopped.baseline || stopped.current ? null : Object.fromEntries(Object.keys(a).map((metric) => [metric, delta(a[metric], b[metric])])) });
  }
  const summarizeCohort = (rows) => {
    const groups = new Map();
    // A reference app's stage with an app outcome or a stop in either round is left out of the cohort and named.
    const outcomeRows = rows.filter((r) => r.app !== "corten" && (r.appOutcomes?.baseline || r.appOutcomes?.current || r.stopped.baseline || r.stopped.current));
    for (const row of rows.filter((r) => r.app !== "corten" && !outcomeRows.includes(r))) {
      const groupKey = `${row.profile}/${row.phase ?? "cold"}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { profile: row.profile, ...(row.phase ? { phase: row.phase } : {}), metrics: {} });
      const group = groups.get(groupKey);
      for (const [metric, value] of Object.entries(row.metrics)) {
        const entries = group.metrics[metric] ??= [];
        entries.push({ app: row.app, percentChange: value.percentChange });
      }
    }
    for (const row of outcomeRows) {
      const groupKey = `${row.profile}/${row.phase ?? "cold"}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { profile: row.profile, ...(row.phase ? { phase: row.phase } : {}), metrics: {} });
      (groups.get(groupKey).outcomeApps ??= []).push(row.app);
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
