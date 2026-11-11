import assert from "node:assert/strict";
import { aggregate as catalogAggregate, cpuSettings as catalogCpuSettings, parseArgs as catalogArgs, sources } from "../catalog/contract.mjs";
import { allApps } from "../fullstack/apps.mjs";
import { spread } from "../fullstack/passes.mjs";
import { apps, locales } from "./contract.mjs";
const labels = {
  nextjs: "Next.js 16.4 (Pages Router, React SSR)",
  phoenix: "Phoenix 1.8 (Elixir, controller + HEEx)",
  laravel: "Laravel 13 (PHP, Octane on FrankenPHP, Blade)",
};
export const inventory = Object.fromEntries(Object.entries(allApps).filter(([, app]) => app.pages !== false)
  .map(([name, app]) => [name, { ...app, label: labels[name] ?? app.label }]));
export { phases, sources, targets } from "../catalog/contract.mjs";
// Saved-result schema: each app has exactly these eight runs/aggregate keys.
// Each publishable key has three passes and fixed/sat64/sat256 phases. JSON has locale:null,
// never an en-US/fr-FR/de-DE alias. Browser parity still covers all locales.
// v3: a phase records what the app failed to serve (readOutcome) instead of failing the run.
export const resultSchema = "marketplace-results/v3";
export const timedProfiles = sources.flatMap((source) => [
  ...locales.map((locale) => ({ key: `${source}-${locale}-page`, source, locale, target: "page" })),
  { key: `${source}-neutral-json`, source, locale: null, target: "json" },
]);
export function roundIdentity(round) {
  assert.match(round ?? "", /^[rw][1-9]\d*$/, "round must be rN (N >= 17), or wN for development");
  const number = Number(round.slice(1));
  assert.ok(Number.isSafeInteger(number) && (round[0] === "w" || number >= 17), "official marketplace-v2 rounds start at r17");
  assert.equal(round, `${round[0]}${number}`, "round identity must be canonical, with no whitespace or padding");
  return { kind: round[0] === "r" ? "official" : "development", number };
}
export function parseArgs(args, inventory) {
  const identity = roundIdentity(args[0]);
  const options = catalogArgs([args[0].replace(/^[rw]/, "c"), ...args.slice(1)], inventory);
  if (identity.kind === "official") {
    assert.deepEqual([...options.apps].sort(), [...apps].sort(), "official rounds require all twenty apps; use wN for development");
    assert.equal(options.passes, 3, "official rounds require three passes");
    assert.equal(options.checkOnly, false, "use wN for check-only development");
  }
  return { ...options, round: args[0] };
}
// A phase as measured, with what the app could not serve under its profile (#1128): requests
// that failed (any answer but a 200) or timed out, and fixed-rate iterations k6 could not start,
// are the app's result, kept and marked (appOutcome), not a failed run. A summary that is
// missing or malformed, that sent nothing, in which no request succeeded, or in which a 200 had
// the wrong content type (a parity failure) is not a measurement.
export function readOutcome(summary) {
  const m = summary?.metrics;
  const metric = (name) => m?.[name]?.values ?? m?.[name];
  const requests = metric("http_reqs");
  const duration = metric("http_req_duration");
  const failures = metric("http_req_failed");
  const checks = metric("checks");
  assert.ok(Number.isSafeInteger(requests?.count) && requests.count > 0 && requests.rate > 0 && Number.isFinite(requests.rate), "load sent no requests");
  for (const k of ["avg", "p(50)", "p(95)", "p(99)", "max"]) assert.ok(Number.isFinite(duration?.[k]) && duration[k] >= 0, `load missing duration ${k}`);
  const failedRate = failures?.value ?? failures?.rate;
  assert.ok(Number.isFinite(failedRate) && failedRate >= 0 && failedRate <= 1, "load missing failure rate");
  assert.ok(Number.isSafeInteger(checks?.passes) && Number.isSafeInteger(checks?.fails) && checks.passes >= 0 && checks.fails >= 0 && checks.passes + checks.fails > 0, "load checks missing");
  const named = summary.root_group?.checks ?? {};
  const status = named["marketplace status 200"], kind = named["marketplace content type"];
  assert.ok([status, kind].every((c) => Number.isSafeInteger(c?.passes) && Number.isSafeInteger(c?.fails)), "load checks missing by name");
  assert.equal(kind.fails, 0, "a 200 had the wrong content type under load: a parity failure, not an outcome");
  const dropped = metric("dropped_iterations")?.count ?? 0;
  assert.ok(Number.isSafeInteger(dropped) && dropped >= 0, "load dropped iterations malformed");
  const failed = Math.round(failedRate * requests.count);
  // A request's metrics are recorded before its check, so one cut off at the phase's end can
  // have its failure and not its check; nothing else makes the two differ.
  assert.ok(status.fails <= failed && failed - status.fails <= Math.max(1, requests.count / 100), "status check and failed requests disagree");
  assert.ok(failed < requests.count && status.passes > 0, "no request succeeded: not a measurement");
  return { requests: requests.count, rps: requests.rate, p50: duration["p(50)"], p95: duration["p(95)"], p99: duration["p(99)"],
    failed, failedRate, dropped, checksFailed: status.fails, appOutcome: failed > 0 || dropped > 0 || status.fails > 0 };
}
export function aggregate(runs) {
  return { ...catalogAggregate(runs),
    cpuAvgPct: spread(runs.map((r) => r.cpuAvgPct)),
    cpuMaxPct: spread(runs.map((r) => r.cpuMaxPct)),
    cpuPerRequestUsec: spread(runs.map((r) => r.cpuUsec / r.requests)),
    failedRate: spread(runs.map((r) => r.failedRate)),
    dropped: spread(runs.map((r) => r.dropped)),
    appOutcomes: runs.filter((r) => r.appOutcome).length };
}
// The single upstream's answers to record reads in a phase, from its counters before and after.
// Any but a 200 is the harness failing the app, not the app's outcome, so the run fails on it.
// A slow upstream answers 200s late; the report names it beside an outcome (busy upstream).
export function upstreamErrors(before, after) {
  for (const c of [before, after]) {
    assert.ok(c && c.answers && typeof c.answers === "object", "upstream counters missing");
    for (const n of Object.values(c.answers)) assert.ok(Number.isSafeInteger(n) && n >= 0, "bad upstream counter");
  }
  const statuses = new Set([...Object.keys(before.answers), ...Object.keys(after.answers)]);
  const moved = Object.fromEntries([...statuses].map((s) => [s, (after.answers[s] ?? 0) - (before.answers[s] ?? 0)]));
  assert.ok(Object.values(moved).every((n) => n >= 0), "upstream counters moved backwards");
  return Object.entries(moved).filter(([s]) => s !== "200").reduce((sum, [, n]) => sum + n, 0);
}
export function aggregateCold(runs) {
  return Object.fromEntries(["first200MsFromContainerStart", "successfulRequestMs"].map((key) => [key, spread(runs.map((r) => r.cold[key]))]));
}
export function cpuSettings(env) {
  return catalogCpuSettings(Object.fromEntries(["APP", "LOAD", "API"].map((role) => [`CATALOG_${role}_CPUS`, env[`MARKETPLACE_${role}_CPUS`]])));
}
export function imageProvenance(labels, commit, checkOnly) {
  const builtCommit = labels?.["run.corten.marketplace.commit"] ?? null;
  const builtDirty = labels?.["run.corten.marketplace.dirty"] !== "false";
  assert.ok(checkOnly || (builtCommit === commit && !builtDirty), "image was not built from a clean measured commit; use --build");
  return { builtCommit, builtDirty };
}
