// Read-only planning: no builds, containers, reservations or cloud API calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { nightly } from "../marketplace/droplet-contract.mjs";
import { phases } from "../catalog/contract.mjs";
import { coverage } from "./evidence.mjs";
import { definition, groupNames, registrySchema, retainedFamilies, selectedApps, validateInventory } from "./registry.mjs";

export function plan(name, evidence = []) {
  validateInventory();
  const d = definition(name);
  return {
    registry: registrySchema, group: name, title: d.title,
    capabilities: d.capabilities, popular: d.popular, performant: d.performant,
    selected: selectedApps(name), coverage: coverage(name, evidence),
    execution: name === "localized-marketplace" ? {
      runner: "bench/marketplace/droplet.mjs", group: name,
      options: nightly, phases, placement: "bench/marketplace/droplet-contract.mjs remoteFiles; saved measurement.cpus is authoritative",
      status: "requires-exact-image-qualification-and-browser-gates",
    } : { status: "pending-group-runner-integration", reason: "Selection is approved; existing native runners and adapters must satisfy this group's contract before comparative timing." },
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
