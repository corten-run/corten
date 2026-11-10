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
export { phases, readLoad, sources, targets } from "../catalog/contract.mjs";
// Saved-result schema: each app has exactly these eight runs/aggregate keys.
// Each publishable key has three passes and fixed/sat64/sat256 phases. JSON has locale:null,
// never an en-US/fr-FR/de-DE alias. Browser parity still covers all locales.
export const resultSchema = "marketplace-results/v2";
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
export function aggregate(runs) {
  return { ...catalogAggregate(runs),
    cpuAvgPct: spread(runs.map((r) => r.cpuAvgPct)),
    cpuMaxPct: spread(runs.map((r) => r.cpuMaxPct)),
    cpuPerRequestUsec: spread(runs.map((r) => r.cpuUsec / r.requests)) };
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
