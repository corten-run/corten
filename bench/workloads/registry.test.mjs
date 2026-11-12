import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { contractSha256, definition, groupNames, groups, retainedFamilies, selectedApps, validateInventory } from "./registry.mjs";
import { coverage } from "./evidence.mjs";
import { groupApps, scheduledGroup } from "../marketplace/groups.mjs";
import { parseDropletArgs, remoteFiles, nightly } from "../marketplace/droplet-contract.mjs";

test("approved membership is independent of current qualification and includes every adapter", () => {
  assert.equal(validateInventory(), true);
  assert.equal(groupNames.length, 9);
  const expected = {
    "catalog-page": ["corten", "aspnet", "express", "fastapi", "axum-maud", "drogon", "gin"],
    "json-api": ["corten", "aspnet", "fastapi", "express", "spring", "axum-maud", "drogon", "gin", "aspnet-aot"],
    "localized-marketplace": ["corten", "nextjs", "aspnet", "django", "topcoat", "leptos", "gin", "drogon"],
    "mixed-production": ["corten", "aspnet", "spring", "django", "express", "fastapi", "topcoat", "gin", "drogon"],
    "fullstack-browser": ["corten", "nextjs", "nuxt", "react-router", "rails", "laravel", "sveltekit", "astro", "tanstack-start", "leptos"],
    "client-heavy": ["corten", "react", "vue", "solid", "svelte", "remix"],
    "live-delivery": ["corten", "aspnet", "express", "phoenix", "rails", "gin", "drogon", "leptos"],
    "recoverable-live": ["corten", "phoenix", "rails", "laravel", "aspnet", "leptos", "topcoat"],
    hardening: ["corten", "aspnet", "spring", "nextjs", "django", "express", "gin", "drogon", "topcoat"],
  };
  for (const name of groupNames) {
    assert.deepEqual(selectedApps(name), expected[name]);
    assert.deepEqual(coverage(name).apps, expected[name]);
    assert.equal(coverage(name).contractSha256, contractSha256(name));
    assert.match(contractSha256(name), /^[a-f0-9]{64}$/);
    assert.equal(coverage(name).cells.length, expected[name].length * definition(name).cases.length);
    if (!["catalog-page", "json-api"].includes(name)) assert.ok(!selectedApps(name).includes("axum-maud"));
  }
  assert.throws(() => selectedApps("winners"));
  assert.throws(() => groups["catalog-page"].popular.pop());
});

test("locale/source/target work is explicit, numeric JSON is not repeated under locales", () => {
  const pages = definition("localized-marketplace").cases;
  assert.equal(pages.filter((c) => c.target === "page").length, 6);
  assert.equal(pages.filter((c) => c.target === "json").length, 2);
  assert.ok(pages.filter((c) => c.target === "json").every((c) => c.locale === null));
  const json = definition("json-api").cases;
  assert.equal(json.length, 4);
  assert.equal(new Set(json.map((c) => c.payload)).size, 2);
  assert.ok(json.every((c) => c.locale === null && c.target === "json"));
  assert.ok(!selectedApps("catalog-page").includes("aspnet-aot"));
  assert.equal(definition("fullstack-browser").cases.length, 24);
});

test("failures, unsupported and unimplemented cells remain selected, never become zero results", () => {
  const name = "catalog-page", key = definition(name).cases[0].key;
  const row = { app: "corten", case: key, implementation: "implemented", parity: "failed", measurement: "not-run", reason: "wrong fields" };
  for (const parity of ["failed", "unsupported", "not-run"]) {
    const ledger = coverage(name, [{ ...row, parity }]);
    assert.deepEqual(ledger.apps, selectedApps(name));
    assert.equal(ledger.cells[0].parity, parity);
    assert.equal(ledger.cells[0].metrics, undefined);
  }
  assert.throws(() => coverage(name, [{ ...row, measurement: "complete", artifact: "raw.json" }]));
  assert.throws(() => coverage(name, [{ ...row, metrics: { rps: 0 } }]));
  assert.throws(() => coverage(name, [row, row]));
  assert.throws(() => coverage(name, [{ ...row, app: "nextjs" }]));
  assert.throws(() => coverage(name, [{ ...row, case: "invented" }]));
  assert.throws(() => coverage(name, [{ ...row, implementation: "unknown", parity: "passed" }]));
  const complete = { ...row, parity: "passed", measurement: "complete", artifact: "raw.json" };
  for (const rps of [NaN, Infinity, -1]) assert.throws(() => coverage(name, [{ ...complete, metrics: { rps } }]), /invalid metric/);
  assert.equal(coverage(name, [{ ...complete, metrics: { rps: 1 } }]).cells[0].metrics.rps, 1);
});

test("every auxiliary family remains backed by its original entry point", () => {
  for (const family of retainedFamilies) {
    if (family.status === "not-implemented") { assert.ok(family.reason); assert.equal(family.entry, undefined); }
    else assert.ok(existsSync(new URL(`../../${family.entry}`, import.meta.url)), family.id);
  }
  assert.equal(retainedFamilies.find((f) => f.id === "test-build-disk-core-scaling").entry, "bench/fullstack/build.mjs");
  assert.equal(retainedFamilies.find((f) => f.id === "editor-diagnostics").entry, "bench/fullstack/rust-analyzer.mjs");
  assert.equal(retainedFamilies.find((f) => f.id === "save-to-reload").status, "not-implemented");
  assert.equal(retainedFamilies.find((f) => f.id === "distributed-failover").scope, "corten-only");
  assert.equal(retainedFamilies.find((f) => f.id === "distributed-reliability").scope, "corten-only");
});

test("explicit marketplace integration preserves old reservations and propagates exact approved selection", () => {
  assert.deepEqual(groupApps("production"), ["corten", "nextjs", "aspnet", "fastapi", "express", "topcoat", "leptos"]);
  assert.equal(scheduledGroup("r21"), "production", "do not change live automation through a new registry");
  const flags = ["r21", "--detach", "--ssh-key", "42", "--state-dir", "control", "--group", "localized-marketplace"];
  assert.equal(parseDropletArgs(flags).group, "localized-marketplace");
  const s = { round: "r21", workload: "marketplace-v2", name: "corten-marketplace-r21", unit: "corten-marketplace-r21.service",
    tag: "corten-marketplace-run-0123456789abcdef", commit: "a".repeat(40), options: nightly,
    group: "localized-marketplace", apps: selectedApps("localized-marketplace") };
  assert.deepEqual(groupApps(s.group), s.apps);
  assert.match(remoteFiles(s)["job.sh"], / --group localized-marketplace\n/);
});
