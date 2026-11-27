import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { allApps } from "../fullstack/inventory.mjs";
import { locales } from "../marketplace/contract.mjs";

export const springWebflux = Object.freeze({
  recipe: "mixed-production-asgi-webflux",
  deployment: "spring-webflux",
  buildProfile: "matched-webflux",
  dockerfile: "Dockerfile.mixed",
  entrypoint: Object.freeze(["java", "-jar", "marketplace-mixed.jar"]),
  command: null,
});

export const registrySchema = "benchmark-groups/v1";
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const group = (title, popular, performant, capabilities, cases) => ({ title, popular, performant, capabilities, cases });
const sources = ["fixture", "api"];
const records = (payload, targets, pageLocales = [null]) => sources.flatMap((source) => targets.flatMap((target) =>
  (target === "page" ? pageLocales : [null]).map((locale) => ({
    key: `${payload}-${source}-${locale ?? "neutral"}-${target}`, payload, source, locale, target,
  }))));

// Reviewed challenger selection, not a ranking or an implementation-status filter.
// Keep old marketplace group identities in marketplace/groups.mjs immutable for saved rounds.
export const groups = freeze({
  "catalog-page": { ...group("Catalog page", ["aspnet", "express", "fastapi"], ["axum-maud", "drogon", "gin"],
    ["typed-record", "escaped-fields-and-links", "get-filter", "request-time-source", "no-output-cache"], records("catalog-v1", ["page"])),
    documentHeaders: "catalog-document-headers/v1" },
  "json-api": group("JSON API", ["aspnet", "fastapi", "express", "spring"], ["axum-maud", "drogon", "gin", "aspnet-aot"],
    ["typed-complete-schema", "numeric-json", "tested-errors", "fetch-parse-reserialize", "no-output-cache"],
    ["catalog-v1", "marketplace-v2"].flatMap((payload) => records(payload, ["json"]))),
  "localized-marketplace": { ...group("Localized marketplace", ["nextjs", "aspnet", "django"], ["topcoat", "leptos", "gin", "drogon"],
    ["complete-marketplace", "request-time-localization", "filter-sort", "valid-invalid-forms", "js-and-no-js", "bounded-production-http/v2"],
    records("marketplace-v2", ["page", "json"], ["rotating"])),
    parityCases: records("marketplace-v2", ["page", "json"], locales), nativeResultSchema: "marketplace-results/v6" },
  "mixed-production": group("Mixed production traffic", ["aspnet", "spring", "django", "express", "fastapi"], ["topcoat", "gin", "drogon"],
    ["localized-reads", "numeric-json", "listings", "accepted-rejected-writes", "write-readback", "slow-upstream", "bounded-production-http/v2"],
    sources.flatMap((source) => locales.map((locale) => ({ key: `${source}-${locale}-mix`, source, locale, target: "mix" })))),
  "fullstack-browser": group("Full-stack browser experience", ["nextjs", "nuxt", "react-router", "rails", "laravel"],
    ["sveltekit", "astro", "tanstack-start", "leptos"],
    ["ssr", "native-navigation", "filter-sort", "valid-invalid-forms", "js-and-no-js", "desktop-mobile", "readiness-actions-bytes"],
    sources.flatMap((source) => locales.flatMap((locale) => ["desktop", "mobile"].flatMap((device) => [true, false].map((js) =>
      ({ key: `${source}-${locale}-${device}-${js ? "js" : "no-js"}`, source, locale, device, js, target: "journey" })))))),
  "client-heavy": group("Client-heavy screens", ["react", "vue"], ["solid", "svelte", "remix"],
    ["equal-loaded-keyed-rows", "dashboard-mutations", "sort-filter-selection", "no-operation-http", "subscription-cleanup", "final-dom"],
    [{ key: "loaded-screen", target: "client" }]),
  "live-delivery": group("Live delivery", ["aspnet", "express", "phoenix", "rails"], ["gin", "drogon", "leptos"],
    ["equal-initial-state", "ordered-visible-events", "native-transport", "bounded-slow-client", "browser-correctness", "cleanup"],
    [{ key: "delivery", target: "live" }]),
  "recoverable-live": group("Recoverable live application", ["phoenix", "rails", "laravel", "aspnet"], ["leptos", "topcoat"],
    ["equal-initial-state", "disconnect", "gap-detection", "replay-or-resnapshot", "no-duplicate-effects", "final-keyed-state", "bounded-slow-client", "cleanup"],
    [{ key: "recovery", target: "live" }]),
  hardening: group("Resilience and hardening", ["aspnet", "spring", "nextjs", "django", "express"], ["gin", "drogon", "topcoat"],
    ["equal-legitimate-traffic", "declared-deployment-budget", "bounded-client-deadline", "bounded-request-limit", "dependency-recovery", "useful-service", "recovery"],
    [{ key: "direct", target: "hardening" }, { key: "deployed-edge", target: "hardening" }]),
});

export const groupNames = Object.freeze(Object.keys(groups));
const runners = Object.freeze({
  "catalog-page": ["bench/catalog/run.mjs", "--group", "catalog-page"],
  "json-api": ["bench/json-api/run.mjs", "--group", "json-api"],
  "localized-marketplace": ["bench/marketplace/run.mjs", "--group", "localized-marketplace"],
  "mixed-production": ["bench/mixed-production/run.mjs"],
  "fullstack-browser": ["bench/fullstack-browser/run.mjs"],
  "client-heavy": ["bench/client-heavy/run.mjs"],
  "live-delivery": ["bench/live/run.mjs", "--group", "live-delivery"],
  "recoverable-live": ["bench/recoverable-live/run.mjs"],
  hardening: ["bench/hardening/run.mjs"],
});
export function runnerFor(group) {
  definition(group);
  const [entry, ...selection] = runners[group];
  return { entry, selection };
}

export function campaignRounds(round) {
  assert.equal(typeof round, "string"); assert.match(round, /^r[1-9]\d*$/);
  const n = Number(round.slice(1));
  assert.ok(Number.isSafeInteger(n) && n >= 17 && n <= 1000000000, "official campaign round must be r17..r1000000000");
  return Object.fromEntries(groupNames.map((group) => [group, group === "catalog-page" ? `c${n}`
    : group === "json-api" ? `j${2 * n + 1}` : group === "localized-marketplace" ? round
      : ["live-delivery", "recoverable-live"].includes(group) ? round : `w${n}`]));
}
export const jsonPreparationRound = (round) => `j${2 * Number(round.slice(1))}`;
export const jsonPreparationInvocation = (round) => ({
  executable: "node", argv: ["bench/json-api/run.mjs", jsonPreparationRound(round), "--group", "json-api", "--build", "--check-only"],
});
export const jsonTimingInvocation = (round, receiptPath) => ({
  executable: "node", argv: ["bench/json-api/run.mjs", round, "--group", "json-api", "--receipts", receiptPath],
});
export function nativeArtifactRoot(group, round) {
  const directory = group === "catalog-page" ? "catalog" : group === "localized-marketplace" ? "marketplace" : group;
  return group === "client-heavy" ? `bench/client-heavy/work/${round}`
    : group === "fullstack-browser" ? `bench/fullstack-browser/work/${round}`
      : group === "live-delivery" ? `bench/live/results/parity/${round}` : `bench/${directory}/results/${round}`;
}

export function definition(name) {
  assert.ok(Object.hasOwn(groups, name), `unknown workload group: ${name}`);
  return groups[name];
}
export function selectedApps(name) {
  const { popular, performant } = definition(name);
  return ["corten", ...new Set([...popular, ...performant])];
}
export function contractSha256(name) {
  return createHash("sha256").update(JSON.stringify({ registry: registrySchema, group: name, definition: definition(name), apps: selectedApps(name) })).digest("hex");
}

// Auxiliary evidence is retained, not silently relabeled as new-workload measurements.
export const retainedFamilies = freeze([
  { id: "cold-efficiency-latency", entry: "bench/marketplace/run.mjs" },
  { id: "html-css-js-wasm-bytes", entry: "bench/fullstack/bytes.mjs" },
  { id: "browser-readiness-actions", entry: "bench/fullstack/browser.mjs" },
  { id: "clean-incremental-dev-build", entry: "bench/fullstack/build.mjs" },
  { id: "test-build-disk-core-scaling", entry: "bench/fullstack/build.mjs" },
  { id: "editor-diagnostics", entry: "bench/fullstack/rust-analyzer.mjs" },
  { id: "docker-rebuild", entry: "bench/fullstack/docker-rebuild.mjs" },
  { id: "save-to-reload", status: "not-implemented", reason: "No save-to-browser-reload harness exists; retained implementation requirement, not measured evidence." },
  { id: "hardware-instructions", entry: "bench/fullstack/count.mjs" },
  { id: "client-runtime", entry: "bench/browser/README.md" },
  { id: "default-cost", entry: "bench/fullstack/cost-by-default.mjs", scope: "corten-only" },
  { id: "render-allocation-and-json-cost", entry: "examples/card-market/src/app.rs", scope: "corten-only", kind: "ignored-rust-tests", tests: ["render_cost", "read_cost"] },
  { id: "cost-under-load", entry: "bench/fullstack/cost-under-load.mjs", scope: "corten-only" },
  { id: "tcp-nodelay", entry: "bench/nodelay/README.md", scope: "corten-only" },
  { id: "distributed-reliability", entry: "examples/listings-feed/bench/run.mjs", scope: "corten-only" },
  { id: "distributed-failover", entry: "examples/listings-feed/bench/failover.mjs", scope: "corten-only" },
]);

export function validateInventory() {
  const allowed = new Set([...Object.keys(allApps), "react", "vue", "solid", "svelte", "remix"]);
  for (const name of groupNames) {
    const d = definition(name), selected = selectedApps(name);
    assert.ok(selected.every((app) => allowed.has(app)), `${name}: unknown adapter`);
    assert.equal(new Set(selected).size, selected.length);
    assert.ok(d.popular.length > 1 && d.performant.length > 1, `${name}: both challenger categories required`);
    assert.equal(new Set(d.cases.map((c) => c.key)).size, d.cases.length, `${name}: duplicate case`);
  }
  const represented = new Set(groupNames.flatMap(selectedApps));
  assert.ok(Object.keys(allApps).every((app) => represented.has(app)), "an existing server adapter disappeared");
  return true;
}
