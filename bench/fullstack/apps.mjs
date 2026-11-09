import { maxConnections } from "./conformance.mjs";

// The apps under test: one image each, same page, same data, same port inside the container. An
// app with `pages: false` serves only the item as JSON, so it takes part in the JSON steps alone.
// `matched: true`: one of the matched tier's apps (README, "The matched tier"), set once the app
// starts with the production profile under PROFILE=matched. The tier's membership (README, "The
// matched tier") also names nextjs, django, aspnet (with aspnet-aot for the JSON), spring and
// topcoat; each joins with its profile.
const catalog = {
  corten: { image: "cb-corten", port: 18410, label: "Corten 0.1 (Rust, axum, html! views)", matched: true },
  nextjs: { image: "cb-nextjs", port: 18411, label: "Next.js 16.4 (App Router, RSC)" },
  "tanstack-start": { image: "cb-tanstack-start", port: 18412, label: "TanStack Start 1.169 (React 19, Nitro)" },
  sveltekit: { image: "cb-sveltekit", port: 18413, label: "SvelteKit 3.1 (Svelte 5, adapter-node)" },
  "react-router": { image: "cb-react-router", port: 18414, label: "React Router 7.18 + Express" },
  leptos: { image: "cb-leptos", port: 18415, label: "Leptos 0.8 (Rust, SSR + WASM hydration)", matched: true },
  django: { image: "cb-django", port: 18416, label: "Django 6.1 (Python, gunicorn, htmx)" },
  rails: { image: "cb-rails", port: 18417, label: "Rails 8.1 (Ruby, Puma, YJIT, Turbo)" },
  laravel: { image: "cb-laravel", port: 18418, label: "Laravel 13 (PHP, Octane on FrankenPHP, Livewire)" },
  aspnet: { image: "cb-aspnet", port: 18419, label: "ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx)" },
  spring: { image: "cb-spring", port: 18420, label: "Spring Boot 4.1 (Java 25, Thymeleaf, htmx)" },
  phoenix: { image: "cb-phoenix", port: 18421, label: "Phoenix 1.8 LiveView (Elixir)" },
  astro: { image: "cb-astro", port: 18422, label: "Astro 7 (Node adapter, client router)" },
  nuxt: { image: "cb-nuxt", port: 18423, label: "Nuxt 4 (Vue 3, Nitro)" },
  topcoat: { image: "cb-topcoat", port: 18424, label: "Topcoat 0.11 (Rust, view! components, shards)" },
  "axum-maud": { image: "cb-axum-maud", port: 18427, label: "axum 0.8 + Maud 0.27 (Rust, htmx)", matched: true },
  gin: { image: "cb-gin", port: 18425, label: "Gin 1.12 (Go, templ, htmx)" },
  drogon: { image: "cb-drogon", port: 18426, label: "Drogon 1.9 (C++, CSP views, htmx)" },
  "aspnet-aot": { image: "cb-aspnet-aot", port: 18428, label: "ASP.NET Core 10 minimal API, native AOT (C#, JSON only)", pages: false },
};

/**
 * Which tier a round runs (BENCH_TIER; droplet.mjs --tier sets it on the droplet): "defaults",
 * each app as its framework starts it, or "matched", the matched tier's apps, each started with
 * PROFILE=matched so it adds the production profile its defaults lack (README, "The matched tier").
 */
export const tier = process.env.BENCH_TIER || "defaults";
if (tier !== "defaults" && tier !== "matched") throw new Error(`BENCH_TIER is defaults or matched, not ${tier}`);
/**
 * Whether the tier's load phases and browser pass reach each app through the edge (edge.mjs): the
 * matched tier's do, as a deployed app is reached; the defaults tier's reach it directly.
 * BENCH_EDGE=off runs the matched tier without it, to measure what the edge adds to the same app.
 */
if (process.env.BENCH_EDGE && process.env.BENCH_EDGE !== "off") throw new Error(`BENCH_EDGE is off or unset, not ${process.env.BENCH_EDGE}`);
// The hardening step (harden.mjs) reaches every app directly and does not read this.
export const viaEdge = tier === "matched" && process.env.BENCH_EDGE !== "off";
/** What every app container of the tier is started with (runArgs, cold-start.mjs): the profile in the matched tier. */
export const tierEnv = tier === "matched" ? ["-e", "PROFILE=matched", "-e", `MAX_CONNECTIONS=${maxConnections}`] : [];
/**
 * The apps a run measures: every one (the matched tier's, in that tier), or those BENCH_APPS
 * names (comma separated; droplet.mjs --apps sets it on the droplet), in the catalog's order.
 */
const only = process.env.BENCH_APPS?.split(",").map((n) => n.trim()).filter(Boolean);
for (const name of only ?? []) if (!(name in catalog)) throw new Error(`BENCH_APPS names ${name}, which is not an app`);
for (const name of only ?? []) if (tier === "matched" && !(/** @type {{ matched?: boolean }} */ (catalog[/** @type {keyof typeof catalog} */ (name)]).matched)) throw new Error(`BENCH_APPS names ${name}, which is not in the matched tier`);
// Corten is the reference every comparison (parity, look, check-app) is made against.
if (only && !only.includes("corten")) throw new Error("BENCH_APPS must include corten, the reference");
/** Every app, whatever BENCH_APPS names (the tests check the catalog as a whole). */
export const allApps = catalog;
/** The apps of the tier a round runs. */
export const tierApps = tier === "matched" ? Object.fromEntries(Object.entries(catalog).filter(([, app]) => /** @type {{ matched?: boolean }} */ (app).matched)) : catalog;
export const apps = only ? Object.fromEntries(Object.entries(tierApps).filter(([name]) => only.includes(name))) : tierApps;
/** The apps that render the pages: every step that loads one (parity, look, bytes, browser, cold start's probe, the page phases). */
export const pageApps = Object.fromEntries(Object.entries(apps).filter(([, app]) => app.pages !== false));
/** The path that shows an app is up: its item page, or for a JSON-only app the item as JSON. */
export const readyPath = (/** @type {{ pages?: boolean }} */ app) => (app.pages === false ? "/api/items/item_1" : "/items/item_1");

export const network = process.env.BENCH_NETWORK ?? "rustbench";
/** The item API's container: the Rust API locally, `item-api/` (the fixture over HTTP) on a bench host. */
export const apiContainer = process.env.BENCH_API_CONTAINER ?? "rb-rust";
export const apiBase = `http://${apiContainer}:8080`;
/**
 * CPU limits. By default each app gets one CPU's worth of time (`--cpus 1`). On a dedicated bench
 * host, BENCH_APP_CPUS pins the app to those cores (`--cpuset-cpus`) and BENCH_LOAD_CPUS pins the
 * load generator elsewhere, so the two never share a core.
 */
export const appCpus = process.env.BENCH_APP_CPUS ? ["--cpuset-cpus", process.env.BENCH_APP_CPUS] : ["--cpus", "1"];
export const loadCpus = process.env.BENCH_LOAD_CPUS ? ["--cpuset-cpus", process.env.BENCH_LOAD_CPUS] : ["--cpus", "4"];
/**
 * The CPUs `count.mjs` has `perf` watch: an app pinned to its cores (BENCH_APP_CPUS) runs only
 * there, so its cgroup's instructions should all be counted on them, with one counter per core
 * rather than one on each of the host's (`-a`), whose counters on the load generator's cores are
 * switched at its every context switch (a suspect in the restarts of #812).
 */
export const countCpus = process.env.BENCH_APP_CPUS ? ["-C", process.env.BENCH_APP_CPUS] : ["-a"];
/**
 * The load generator's cores for one run-ssr source. With items in memory the item API sits idle,
 * so BENCH_FIXTURE_LOAD_CPUS can give k6 its cores as well: four were not enough to keep Corten's
 * core busy (93% for the page and 88% for the JSON in r6), and an app whose core is not busy
 * shows fewer requests a second than it can serve.
 */
export const loadCpusFor = (source) =>
  source === "fixture" && process.env.BENCH_FIXTURE_LOAD_CPUS ? ["--cpuset-cpus", process.env.BENCH_FIXTURE_LOAD_CPUS] : loadCpus;
/** How many CPUs k6 has for one source: the cores its cpuset lists ("8-15", "2-3,10-15"), or four. */
export const loadCores = (/** @type {string} */ source) => {
  const [flag, set] = loadCpusFor(source);
  return flag === "--cpuset-cpus" ? set.split(",").reduce((n, part) => { const [a, b = a] = part.split("-").map(Number); return n + b - a + 1; }, 0) : Number(set);
};
/**
 * The load generator's network namespace: every local port, and TIME_WAIT ports reused for new
 * connections. A server that closes each connection (gunicorn's sync workers) would otherwise use
 * up k6's ports within a minute at a few thousand requests a second.
 */
export const k6Net = ["--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1"];
/** k6 runs as our user, so it can write its summary into results/ on a Linux host. */
export const k6User = process.getuid ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];

/** `docker run` arguments for one app. `source` is "api" or "fixture". */
export function runArgs(name, app, source, fixturesDir) {
  const args = ["run", "-d", "--name", `fsw-${name}`, "--network", network, ...appCpus, "--memory", "1g", "-p", `${app.port}:8080`];
  // The load generator calls the app by its container name, which Corten answers only when listed.
  args.push("-e", `API_BASE=${apiBase}`, "-e", "PORT=8080", "-e", `HOSTS=fsw-${name}`);
  args.push(...tierEnv);
  if (source === "fixture") args.push("-v", `${fixturesDir}:/fixtures:ro`, "-e", "ITEM_SOURCE=fixture", "-e", "FIXTURE_PATH=/fixtures/items.json");
  args.push(app.image);
  return args;
}
