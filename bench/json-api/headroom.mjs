// Read-only headroom calibration over saved native JSON API raw phases (warmup, fixed,
// sat64, sat256). It names which participant reached production.mjs's headroom bounds
// and extrapolates the offered rate each bounded participant could carry. It qualifies
// nothing and changes no evidence: production.mjs alone decides whether an observation
// is complete.
//
// Usage, from the repository root (Markdown table, or the rows as JSON):
//
//   node bench/json-api/headroom.mjs TIMING_TREE [--json]
//
// TIMING_TREE is a native timing folder holding APP/CASE/pN/PHASE.json. Windows match
// production.mjs: generator samples inside the native k6 container's lifetime, app and
// upstream samples inside the command clock, counted CPU over k6's measured duration.
// Bounds use the CPU quota each phase recorded it ran with; production.mjs asserts that
// quota equals the checkout's matrix, so this reads the phase rather than the matrix.
// Only the generator and the API upstream have bounds; the app has none, and its
// counted CPU and capacity are context. Extrapolations are linear from one observation;
// they are estimates for choosing a setup to measure, not measurements. A saved value
// of the wrong type makes its row unavailable and is never printed.
//
// It reads only the r67-era raw shape, whose generator samples are raw.samples.load.
// A phase that carries raw.loadResources (scheduled load resources, judged in
// production.mjs by a replay this tool does not perform) is reported unavailable,
// never as at or under a bound, whether or not that field is well formed.
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
const positive = (n) => finite(n) && n > 0;
const count = (n) => Number.isSafeInteger(n) && n >= 0;
// An RFC3339 timestamp string with a real calendar date, as a millisecond clock; else null.
const rfc3339 = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
function timestampMs(value) {
  const match = typeof value === "string" ? rfc3339.exec(value) : null;
  const calendar = match ? Date.parse(`${match[1]}Z`) : NaN;
  if (!finite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== match[1]) return null;
  const ms = Date.parse(value);
  return finite(ms) ? ms : null;
}
const round = (n, d = 1) => finite(n) ? Number(n.toFixed(d)) : null;
const within = (samples, from, to) => (Array.isArray(samples) ? samples : []).filter((s) => finite(s?.t) && s.t >= from && s.t <= to);
// summarizeSamples throws on a non-finite sample; the caller turns that into a fixed reason.
const malformedSample = Symbol("malformed sample");
const stats = (samples) => {
  if (!samples.length) return null;
  if (!samples.every((s) => finite(s.cpu) && finite(s.mem))) throw malformedSample;
  return summarizeSamples(samples);
};

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
  if (Object.hasOwn(raw, "loadResources")) return { identity, unavailable: "scheduled load resources: not read by this tool" };
  try { return measured(raw, identity); } catch (error) {
    if (error === malformedSample) return { identity, unavailable: "phase has a malformed resource sample in its window" };
    throw error;
  }
}

function measured(raw, identity) {
  const durationMs = raw.clock?.k6DurationMs, requests = raw.k6?.metrics?.http_reqs?.count, metrics = raw.k6?.metrics;
  const seconds = positive(durationMs) ? durationMs / 1000 : null;
  const start = raw.command?.clock?.startedAt, end = raw.command?.clock?.finishedAt, life = raw.after?.liveness?.load;
  const born = timestampMs(life?.startedAt), exited = timestampMs(life?.finishedAt);
  const loadQuota = raw.identity.cpus?.load?.quota, appQuota = raw.identity.cpus?.app?.quota;
  if (seconds === null || !count(requests) || !finite(start) || !finite(end) || !positive(loadQuota) || !positive(appQuota))
    return { identity, unavailable: "phase has no measured k6 clock, request count, command clock or CPU budget" };
  if (born === null || exited === null) return { identity, unavailable: "phase has no timestamped native load lifetime" };
  const failed = metrics.http_req_failed?.passes, dropped = metrics.dropped_iterations?.count, timeouts = metrics.json_timeout?.count;
  if (![failed, dropped, timeouts].every(count)) return { identity, unavailable: "phase has no whole failed, dropped or timeout count" };
  const rps = requests / seconds;
  const counted = (role) => {
    const c = raw.counters?.[role];
    return Number.isSafeInteger(c?.before) && Number.isSafeInteger(c?.after) && c.after > c.before ? c.after - c.before : null;
  };
  const appUs = counted("app"), upUs = identity.source === "api" ? counted("upstream") : null;
  const load = stats(within(raw.samples?.load, born, exited));
  const upstream = stats(within(raw.samples?.upstream, start, end)), app = stats(within(raw.samples?.app, start, end));
  const loadBoundPct = loadQuota * headroomBounds.loadPctOfQuotaCore, upBound = headroomBounds.upstreamPctOfOneCore;
  const appPct = appUs === null ? null : appUs / (seconds * 1e4), upPct = upUs === null ? null : upUs / (seconds * 1e4);
  const api = identity.source === "api";
  const atBound = {
    load: load ? load.cpuMaxPct >= loadBoundPct : null,
    upstreamSampled: api ? (upstream ? upstream.cpuMaxPct >= upBound : null) : false,
    upstreamCounted: api ? (upPct === null ? null : upPct >= upBound) : false,
  };
  const scale = (pct, bound) => (pct > 0 ? rps * bound / pct : null);
  const upPeak = api && upstream ? Math.max(upstream.cpuMaxPct, upPct ?? 0) : null;
  const rateAtLoadBound = load ? scale(load.cpuMaxPct, loadBoundPct) : null, rateAtUpstreamBound = api ? scale(upPeak, upBound) : null;
  const appCapacity = appPct ? rps * appQuota * 100 / appPct : null;
  const headroomRate = [rateAtLoadBound, rateAtUpstreamBound].filter(finite);
  return {
    identity, seconds: round(seconds, 3), requests, rps: round(rps, 0),
    failed, dropped, timeouts, captureErrors: Array.isArray(raw.captureErrors) ? raw.captureErrors.length : null,
    load: load && { quotaCores: loadQuota, boundPct: loadBoundPct, maxPct: round(load.cpuMaxPct, 2), avgPct: round(load.cpuAvgPct), samples: load.samples },
    upstream: upstream && { maxPct: round(upstream.cpuMaxPct, 2), avgPct: round(upstream.cpuAvgPct), countedPct: round(upPct), boundPct: api ? upBound : null },
    app: { quotaCores: appQuota, countedPct: round(appPct), maxPct: round(app?.cpuMaxPct) },
    atBound,
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
      const identity = identityOf(raw);
      // A file must sit at the path its own identity names.
      if (!identity || identity.app !== app || identity.key !== key || `p${identity.pass}` !== pass || identity.phase !== phase) { refused.files++; continue; }
      // One unreadable phase is reported as unavailable; it does not stop the others.
      let row;
      try { row = phaseHeadroom(raw); } catch { row = { identity, unavailable: "phase could not be summarized" }; }
      rows.push(row);
    }
  }
  return { schema: "json-api-headroom/v1", bounds: headroomBounds, rows, refusedFiles: refused.files,
    unavailableRows: rows.filter((r) => r.unavailable).length };
}

const cell = (v) => (v === null || v === undefined ? "-" : String(v));
export function renderHeadroom(result) {
  const lines = ["# JSON API Headroom", "",
    `Bounds as production.mjs applies them: generator peak below ${result.bounds.loadPctOfQuotaCore}% of each quota core; API upstream sampled peak and counted average below ${result.bounds.upstreamPctOfOneCore}% of one core.`,
    "Bounds use the CPU quota the phase recorded it ran with. The app has no bound; its counted CPU and capacity are context.",
    "At bound lists each participant at or past its bound; unknown means a measure was missing. Rates past the observation are linear estimates from one phase, not measurements. Nothing here qualifies or rejects a phase.", "",
    "| App | Case | Pass | Phase | req/s | Generator max/avg % (bound) | Upstream max/counted % | App counted % | At bound | Rate at generator bound | Rate at upstream bound | App capacity | Generator cores for app capacity |",
    "|---|---|---:|---|---:|---|---|---:|---|---:|---:|---:|---:|"];
  for (const r of result.rows) {
    if (r.unavailable) { lines.push(`| ${r.identity.app} | ${r.identity.key} | ${r.identity.pass} | ${r.identity.phase} | ${r.unavailable} ||||||||`); continue; }
    const named = (value) => Object.entries(r.atBound).filter(([, v]) => v === value).map(([k]) => k);
    const unknown = named(null);
    const bound = [...named(true), ...(unknown.length ? [`unknown: ${unknown.join(", ")}`] : [])].join("; ") || "none";
    lines.push(`| ${r.identity.app} | ${r.identity.key} | ${r.identity.pass} | ${r.identity.phase} | ${r.rps} | ${r.load ? `${r.load.maxPct}/${r.load.avgPct} (${r.load.boundPct})` : "-"} | ${r.upstream ? `${r.upstream.maxPct}/${cell(r.upstream.countedPct)}` : "-"} | ${cell(r.app.countedPct)} | ${bound} | ${cell(r.estimates.rateAtLoadBound)} | ${cell(r.estimates.rateAtUpstreamBound)} | ${cell(r.estimates.appCapacity)} | ${cell(r.estimates.generatorCoresForAppCapacity)} |`);
  }
  if (result.unavailableRows) lines.push("", `${result.unavailableRows} phase(s) were unavailable; their saved values are not shown.`);
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
