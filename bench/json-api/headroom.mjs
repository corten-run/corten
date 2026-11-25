// Read-only headroom calibration over saved native JSON API raw phases (warmup, fixed,
// sat64, sat256). It names which participant ran out of headroom and extrapolates the
// offered rate each one could carry. It qualifies nothing and changes no evidence:
// production.mjs alone decides whether an observation is complete.
//
//   node bench/json-api/headroom.mjs TIMING_TREE [--json]
//
// TIMING_TREE is a native timing folder holding APP/CASE/pN/PHASE.json. Windows match
// production.mjs: generator samples inside the native k6 container's lifetime, app and
// upstream samples inside the command clock, counted CPU over k6's measured duration.
// Extrapolations are linear from one observation; they are estimates for choosing a
// setup to measure, not measurements.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { summarizeSamples } from "../catalog/stats.mjs";
import { descriptor, phases } from "./contract.mjs";

// The bounds production.mjs applies; headroom.test.mjs fails if they drift apart.
export const headroomBounds = Object.freeze({ loadPctOfQuotaCore: 80, upstreamPctOfOneCore: 80 });
const phaseNames = Object.freeze(["warmup", ...phases]);
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const round = (n, d = 1) => finite(n) ? Number(n.toFixed(d)) : null;
const within = (samples, from, to) => (Array.isArray(samples) ? samples : []).filter((s) => finite(s?.t) && s.t >= from && s.t <= to);
const stats = (samples) => samples.length ? summarizeSamples(samples) : null;

// Identity strings are checked against the checkout's own matrix and printed only from it.
function identityOf(raw) {
  const group = descriptor(), id = raw?.identity;
  const app = group.apps.find((a) => a === id?.app), profile = group.cases.find((c) => c.key === id?.key);
  const phase = phaseNames.find((p) => p === raw?.phase);
  if (!app || !profile || !phase || !Number.isSafeInteger(id?.pass) || id.pass < 1 || id.pass > 5) return null;
  return { app, key: profile.key, source: profile.source, pass: id.pass, phase };
}

export function phaseHeadroom(raw) {
  const identity = identityOf(raw);
  if (!identity) return { identity: null, unavailable: "not a phase of this checkout's JSON API matrix" };
  const seconds = raw.clock?.k6DurationMs / 1000, requests = raw.k6?.metrics?.http_reqs?.count;
  const start = raw.command?.clock?.startedAt, end = raw.command?.clock?.finishedAt, life = raw.after?.liveness?.load;
  const born = Date.parse(life?.startedAt), exited = Date.parse(life?.finishedAt);
  const loadQuota = raw.identity.cpus?.load?.quota, appQuota = raw.identity.cpus?.app?.quota;
  if (!(seconds > 0) || !Number.isSafeInteger(requests) || !finite(start) || !finite(end) || !(loadQuota > 0) || !(appQuota > 0))
    return { identity, unavailable: "phase has no measured k6 clock, request count, command clock or CPU budget" };
  const rps = requests / seconds, metrics = raw.k6.metrics;
  const counted = (role) => {
    const c = raw.counters?.[role];
    return Number.isSafeInteger(c?.before) && Number.isSafeInteger(c?.after) && c.after > c.before ? c.after - c.before : null;
  };
  const appUs = counted("app"), upUs = identity.source === "api" ? counted("upstream") : null;
  const load = finite(born) && finite(exited) ? stats(within(raw.samples?.load, born, exited)) : null;
  const upstream = stats(within(raw.samples?.upstream, start, end)), app = stats(within(raw.samples?.app, start, end));
  const loadBoundPct = loadQuota * headroomBounds.loadPctOfQuotaCore, upBound = headroomBounds.upstreamPctOfOneCore;
  const appPct = appUs === null ? null : appUs / (seconds * 1e4), upPct = upUs === null ? null : upUs / (seconds * 1e4);
  const api = identity.source === "api";
  const atBound = {
    load: load ? load.cpuMaxPct >= loadBoundPct : null,
    upstreamSampled: api ? (upstream ? upstream.cpuMaxPct >= upBound : null) : false,
    upstreamCounted: api ? (upPct === null ? null : upPct >= upBound) : false,
  };
  // Share of each participant's capacity in use: generator of its quota, upstream of the
  // one core its single Node process can use, app of its quota.
  const share = { generator: load ? load.cpuAvgPct / (loadQuota * 100) : null,
    upstream: api && upPct !== null ? upPct / 100 : null, app: appPct === null ? null : appPct / (appQuota * 100) };
  const known = Object.entries(share).filter(([, v]) => v !== null);
  const nearestLimit = known.length ? known.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null;
  const scale = (pct, bound) => (pct > 0 ? rps * bound / pct : null);
  const upPeak = api && upstream ? Math.max(upstream.cpuMaxPct, upPct ?? 0) : null;
  const rateAtLoadBound = load ? scale(load.cpuMaxPct, loadBoundPct) : null, rateAtUpstreamBound = api ? scale(upPeak, upBound) : null;
  const appCapacity = appPct ? rps * appQuota * 100 / appPct : null;
  const headroomRate = [rateAtLoadBound, rateAtUpstreamBound].filter(finite);
  return {
    identity, seconds: round(seconds, 3), requests, rps: round(rps, 0),
    failed: metrics.http_req_failed?.passes ?? null, dropped: metrics.dropped_iterations?.count ?? null,
    timeouts: metrics.json_timeout?.count ?? null, captureErrors: Array.isArray(raw.captureErrors) ? raw.captureErrors.length : null,
    load: load && { quotaCores: loadQuota, boundPct: loadBoundPct, maxPct: round(load.cpuMaxPct, 2), avgPct: round(load.cpuAvgPct), samples: load.samples },
    upstream: upstream && { maxPct: round(upstream.cpuMaxPct, 2), avgPct: round(upstream.cpuAvgPct), countedPct: round(upPct), boundPct: api ? upBound : null },
    app: { quotaCores: appQuota, countedPct: round(appPct), maxPct: round(app?.cpuMaxPct) },
    atBound, nearestLimit, share: Object.fromEntries(Object.entries(share).map(([k, v]) => [k, round(v, 3)])),
    perRequestUs: { app: appUs === null ? null : round(appUs / requests), upstream: upUs === null ? null : round(upUs / requests),
      generatorEstimated: load ? round(load.cpuAvgPct / 100 * seconds * 1e6 / requests) : null },
    estimates: {
      rateAtLoadBound: round(rateAtLoadBound, 0), rateAtUpstreamBound: round(rateAtUpstreamBound, 0),
      appCapacity: round(appCapacity, 0), headroomRate: headroomRate.length ? round(Math.min(...headroomRate), 0) : null,
      generatorCoresForAppCapacity: rateAtLoadBound && appCapacity ? round(loadQuota * appCapacity / rateAtLoadBound, 2) : null,
      upstreamPeakPctAtAppCapacity: upPeak !== null && appCapacity ? round(upPeak * appCapacity / rps) : null,
    },
  };
}

const passDir = /^p[1-5]$/;
export function collectHeadroom(root) {
  const rows = [], refused = { files: 0 };
  const dirs = (path) => readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const app of dirs(root)) for (const key of dirs(join(root, app))) for (const pass of dirs(join(root, app, key)).filter((p) => passDir.test(p))) {
    for (const phase of phaseNames) {
      const file = join(root, app, key, pass, `${phase}.json`);
      let raw;
      try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") continue; refused.files++; continue; }
      if (raw?.schema !== "json-api-timed-phase/v1") { refused.files++; continue; }
      const row = phaseHeadroom(raw);
      // A file must sit at the path its own identity names.
      if (!row.identity || row.identity.app !== app || row.identity.key !== key || `p${row.identity.pass}` !== pass || row.identity.phase !== phase) { refused.files++; continue; }
      rows.push(row);
    }
  }
  return { schema: "json-api-headroom/v1", bounds: headroomBounds, rows, refusedFiles: refused.files };
}

const cell = (v) => (v === null || v === undefined ? "-" : String(v));
export function renderHeadroom(result) {
  const lines = ["# JSON API Headroom", "",
    `Bounds as production.mjs applies them: generator peak below ${result.bounds.loadPctOfQuotaCore}% of each quota core; API upstream sampled peak and counted average below ${result.bounds.upstreamPctOfOneCore}% of one core.`,
    "Rates past the observation are linear estimates from one phase, not measurements. Nothing here qualifies or rejects a phase.", "",
    "| App | Case | Pass | Phase | req/s | Generator max/avg % (bound) | Upstream max/counted % | App counted % | At bound | Nearest limit | Rate at generator bound | Rate at upstream bound | App capacity | Generator cores for app capacity |",
    "|---|---|---:|---|---:|---|---|---:|---|---|---:|---:|---:|---:|"];
  for (const r of result.rows) {
    if (r.unavailable) { lines.push(`| ${r.identity.app} | ${r.identity.key} | ${r.identity.pass} | ${r.identity.phase} | ${r.unavailable} |||||||||`); continue; }
    const bound = Object.entries(r.atBound).filter(([, v]) => v).map(([k]) => k).join(", ") || "none";
    lines.push(`| ${r.identity.app} | ${r.identity.key} | ${r.identity.pass} | ${r.identity.phase} | ${r.rps} | ${r.load ? `${r.load.maxPct}/${r.load.avgPct} (${r.load.boundPct})` : "-"} | ${r.upstream ? `${r.upstream.maxPct}/${cell(r.upstream.countedPct)}` : "-"} | ${cell(r.app.countedPct)} | ${bound} | ${cell(r.nearestLimit)} | ${cell(r.estimates.rateAtLoadBound)} | ${cell(r.estimates.rateAtUpstreamBound)} | ${cell(r.estimates.appCapacity)} | ${cell(r.estimates.generatorCoresForAppCapacity)} |`);
  }
  if (result.refusedFiles) lines.push("", `${result.refusedFiles} file(s) were not phases of this checkout's matrix at their own path and were skipped.`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [root, ...args] = process.argv.slice(2);
    assert.ok(root, "timing folder required");
    assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--json"), "only --json is accepted after the timing folder");
    const result = collectHeadroom(root);
    process.stdout.write(args[0] === "--json" ? `${JSON.stringify(result, null, 2)}\n` : renderHeadroom(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
