import assert from "node:assert/strict";
import { cpuSettings as catalogCpuSettings, parseArgs as catalogArgs } from "../catalog/contract.mjs";
import { allApps } from "../fullstack/apps.mjs";
const labels = {
  nextjs: "Next.js 16.4 (Pages Router, React SSR)",
  phoenix: "Phoenix 1.8 (Elixir, controller + HEEx)",
  laravel: "Laravel 13 (PHP, Octane on FrankenPHP, Blade)",
};
export const inventory = Object.fromEntries(Object.entries(allApps).filter(([, app]) => app.pages !== false)
  .map(([name, app]) => [name, { ...app, label: labels[name] ?? app.label }]));
export { aggregate, phases, readLoad, sources, targets } from "../catalog/contract.mjs";
export function parseArgs(args, inventory) {
  assert.match(args[0] ?? "", /^w[1-9]\d*$/, "marketplace-v2 rounds must be wN, never rN or cN");
  const options = catalogArgs([args[0].replace(/^w/, "c"), ...args.slice(1)], inventory);
  return { ...options, round: args[0] };
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
