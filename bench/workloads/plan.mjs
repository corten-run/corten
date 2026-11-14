// Read-only planning: no builds, containers, reservations or cloud API calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { nightly } from "../marketplace/droplet-contract.mjs";
import { phases } from "../catalog/contract.mjs";
import { groupDescriptor } from "../catalog/group.mjs";
import { descriptor as jsonDescriptor } from "../json-api/contract.mjs";
import { coverage } from "./evidence.mjs";
import { definition, groupNames, registrySchema, retainedFamilies, selectedApps, validateInventory } from "./registry.mjs";
import { deploymentPlan } from "./deployments.mjs";
import { runnerFor } from "./run.mjs";

const nativeScope = {
  "mixed-production": "Native functional captures; complete production qualification and reviewed mixed-load measurement are still required.",
  "fullstack-browser": "Native browser journeys; complete native ports, page cleanup and isolated measurement qualification are still required.",
  "client-heavy": "Native production bundles and browser observations; bounded local verification is not an isolated performance ranking.",
  "live-delivery": "Native live captures; complete native inventory and reviewed fanout measurement are still required.",
  "recoverable-live": "Native replay/resnapshot captures; complete native inventory and reviewed recovery load measurement are still required.",
  hardening: "Native attack apparatus; full parity, controls and complete direct/edge evidence are still required.",
};

export function plan(name, evidence = []) {
  validateInventory();
  const d = definition(name);
  return {
    registry: registrySchema, group: name, title: d.title,
    capabilities: d.capabilities, popular: d.popular, performant: d.performant,
    selected: selectedApps(name), coverage: coverage(name, evidence),
    deploymentIntent: deploymentPlan(name),
    execution: name === "localized-marketplace" ? {
      runner: "bench/marketplace/droplet.mjs", group: name,
      options: nightly, phases, placement: "bench/marketplace/droplet-contract.mjs remoteFiles; saved measurement.cpus is authoritative",
      status: "requires-exact-image-qualification-and-browser-gates",
    } : name === "catalog-page" ? {
      runner: "bench/catalog/run.mjs", group: name, descriptor: groupDescriptor(name),
      phases, settings: "bench/catalog/contract.mjs parseArgs defaults; saved options and measurement.cpus are authoritative",
      status: "requires-exact-image-page-and-json-browser-gates",
      cloud: {
        runner: "bench/catalog/droplet.mjs", group: name,
        settings: "bench/catalog/droplet-contract.mjs measurements, host and cpuEnv; durable reservation is authoritative",
        status: "explicit-merged-commit-independent-state-root-native-gates-required",
      },
    } : name === "json-api" ? {
      runner: "bench/json-api/run.mjs", group: name, descriptor: jsonDescriptor(), phases,
      settings: "bench/json-api/contract.mjs parseArgs defaults; saved options, timingPlan and measurement.cpus are authoritative",
      status: "requires-exact-image-json-gates-and-independent-native-source-audits",
      cloud: "not-integrated; this native runner does not launch or collect droplets",
    } : { runner: runnerFor(name).entry, dispatcher: "bench/workloads/run.mjs", group: name,
      status: "native-apparatus-requires-complete-qualification", scope: nativeScope[name],
      settings: "Discover the native runner's effective options and save them with raw evidence; no settings or passing results are inferred here.",
      cloud: "not-integrated; this native runner does not launch or collect droplets" },
    retainedFamilies,
  };
}
export function markdown() {
  const names = { corten: "Corten", aspnet: "ASP.NET Core", "aspnet-aot": "ASP.NET Core Native AOT (JSON only)",
    nextjs: "Next.js (Pages Router)", express: "Express", fastapi: "FastAPI", spring: "Spring Boot", django: "Django",
    "axum-maud": "axum + Maud", drogon: "Drogon", gin: "Gin + templ", leptos: "Leptos", topcoat: "Topcoat",
    "react-router": "React Router", rails: "Rails + Hotwire", laravel: "Laravel + Livewire", nuxt: "Nuxt", sveltekit: "SvelteKit",
    astro: "Astro", "tanstack-start": "TanStack Start", phoenix: "Phoenix", react: "React", vue: "Vue", solid: "Solid", svelte: "Svelte", remix: "Remix" };
  return ["| Group | Popular challengers | Performance-oriented challengers | Required work |", "|---|---|---|---|",
    ...groupNames.map((name) => {
      const d = definition(name);
      return `| ${d.title} (\`${name}\`) | ${d.popular.map((app) => names[app]).join(", ")} | ${d.performant.map((app) => names[app]).join(", ")} | ${d.capabilities.join(", ")} |`;
    })].join("\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--markdown") console.log(markdown());
  else {
    assert.ok(args.length === 1 || args.length === 3 && args[1] === "--evidence", "usage: node bench/workloads/plan.mjs <group> [--evidence cells.json], or --markdown");
    const evidence = args.length === 3 ? JSON.parse(readFileSync(args[2], "utf8")) : [];
    console.log(JSON.stringify(plan(args[0], evidence), null, 2));
  }
}
