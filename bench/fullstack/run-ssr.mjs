// Server rendering under load, one app at a time on one CPU and 1 GiB.
// Usage: node run-ssr.mjs <round> <api|fixture> [fixedRate=150] [apps=all] [page|json] [passes=1]
//   api:     every request fetches the item from the item API, like production.
//   fixture: items come from memory (fixtures/items.json), so only the web framework is measured.
//   page:    the item page (default); json: the same item from the app's GET /api/items/{id}.
//            JSON results are named <app>-json-<phase>.
//   passes:  each app's phases this many times, the apps taking turns (every app's first pass,
//            then every app's second), so a slow drift of the machine falls on every app alike.
//            Pass 1's files are named as a one-pass round's; pass 2 on add -p<pass> (passes.mjs).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allApps, apiContainer, apps as catalog, k6Net, k6User, loadCpusFor, network, runArgs } from "./apps.mjs";
import { cpuUsec } from "./cpu-time.mjs";
import { passFile, passesOf } from "./passes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [round = "r1", source = "api", fixedRate = "150", appsArg = Object.keys(catalog).join(","), target = "page", passesArg] = process.argv.slice(2);
const passes = passesOf(passesArg);
const results = join(here, "results", round, source);
mkdirSync(results, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const log = (msg) => console.log(new Date().toISOString(), msg);

function k6(name, base, envs) {
  const args = ["run", "--rm", "--network", network, ...k6Net, ...loadCpusFor(source), ...k6User, "-v", `${here}:/bench`, "-e", `BASE=${base}`, "-e", `TARGET=${target}`];
  for (const [k, v] of Object.entries(envs)) args.push("-e", `${k}=${v}`);
  args.push("grafana/k6:latest", "run", "--quiet", "--summary-export", `/bench/results/${round}/${source}/${name}.json`, "/bench/ssr-load.js");
  const r = docker(...args);
  writeFileSync(join(results, `${name}.log`), (r.stdout ?? "") + (r.stderr ?? ""));
  // One failed phase is reported and the run goes on to the next, so it does not cost the apps after it.
  if (!existsSync(join(results, `${name}.json`))) log(`k6 wrote no summary for ${name}; see ${name}.log`);
}

const names = appsArg.split(",");
for (const name of names) if (!catalog[name]) throw new Error(`unknown app ${name}`);
// The passes asked for, which summarize.mjs reads each one of (a pass with no files shows as
// missing). An earlier attempt's files for these apps go first, so a pass this one does not reach
// is missing rather than another boot's.
// The count is the folder's, every app's: a run of some apps with another count (a rerun by hand
// that forgot it) would change what every other app's numbers are read from, so it stops.
const earlierPasses = existsSync(join(results, "passes.json")) ? JSON.parse(readFileSync(join(results, "passes.json"), "utf8")).passes : null;
if (earlierPasses !== null && earlierPasses !== passes) throw new Error(`${results} was run with ${earlierPasses} passes, not ${passes}: pass ${earlierPasses} as the last argument, or start the round again`);
writeFileSync(join(results, "passes.json"), JSON.stringify({ passes }));
const earlier = new RegExp(`^(${names.join("|")})${target === "json" ? "-json" : ""}-(startup|warmup|fixed|sat64|sat256)(-p\\d+)?(-stats|-cpu)?\\.(json|log)$`);
for (const file of readdirSync(results)) if (earlier.test(file)) rmSync(join(results, file));
for (let pass = 1; pass <= passes; pass += 1) for (const name of names) {
  const app = catalog[name];
  // A JSON-only app has no page to measure.
  if (target === "page" && app.pages === false) continue;
  const file = target === "json" ? `${name}-json` : name;
  /** A file of this pass: pass 1's as a one-pass round names it. @param {string} what */
  const named = (what) => passFile(`${file}-${what}`, pass);
  if (passes > 1) log(`pass ${pass} of ${passes}`);
  // Every app's, not only those BENCH_APPS names: a container left from another run shares the CPUs.
  for (const other of Object.keys(allApps)) docker("rm", "-f", `fsw-${other}`);
  await sleep(3000);
  const started = Date.now();
  const run = docker(...runArgs(name, app, source, join(here, "fixtures")));
  if (run.status !== 0) throw new Error(`${name}: ${run.stderr}`);
  const path = target === "json" ? "/api/items/item_1" : "/items/item_1";
  let ready = null;
  for (let i = 0; i < 2400 && ready === null; i += 1) {
    try {
      const r = await fetch(`http://localhost:${app.port}${path}`);
      if (r.ok) ready = Date.now() - started;
    } catch {}
    if (ready === null) await sleep(25);
  }
  // An app that cannot serve in one CPU and 1 GiB with its usual settings fails the run; it is
  // reported, not tuned, and the next app goes on.
  if (ready === null) {
    const logs = docker("logs", "--tail", "20", `fsw-${name}`);
    const failed = `never answered ${path} within a minute`;
    writeFileSync(join(results, `${named("startup")}.json`), JSON.stringify({ failed, logs: (logs.stdout + logs.stderr).trim().split("\n") }, null, 1));
    log(`${file} ${source} failed: ${failed}`);
    docker("rm", "-f", `fsw-${name}`);
    continue;
  }
  await sleep(5000);
  const idle = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", `fsw-${name}`).stdout.trim();
  writeFileSync(join(results, `${named("startup")}.json`), JSON.stringify({ firstOkMsFromDockerRun: ready, idleMem: idle }, null, 1));
  const base = `http://fsw-${name}:8080`;
  log(`${file} ${source} warmup`);
  // 30 s: long enough for the JVM's and .NET's tiered JITs to settle, the same for every app.
  k6(named("warmup"), base, { MODE: "closed", VUS: "32", DURATION: "30s" });
  for (const [phase, envs] of [
    ["fixed", { MODE: "open", RATE: fixedRate, DURATION: "60s" }],
    ["sat64", { MODE: "closed", VUS: "64", DURATION: "60s" }],
    ["sat256", { MODE: "closed", VUS: "256", DURATION: "60s" }],
  ]) {
    log(`${file} ${source} ${phase}`);
    const sampled = [`fsw-${name}`, ...(source === "api" ? [apiContainer] : [])];
    // CPU time each container used during the phase, from its cgroup's counter: what requests per
    // CPU-second divides by. Null where the counter could not be read. Read before the sampler
    // starts, since under Docker Desktop a read takes a few seconds.
    const before = sampled.map(cpuUsec);
    const s = spawn("node", [join(here, "sample-stats.mjs"), join(results, `${named(phase)}-stats.json`), "62", ...sampled], { stdio: "ignore", windowsHide: true });
    k6(named(phase), base, envs);
    const after = sampled.map(cpuUsec);
    writeFileSync(join(results, `${named(phase)}-cpu.json`), JSON.stringify(Object.fromEntries(sampled.map((c, i) => [c, before[i] !== null && after[i] !== null ? { usec: after[i] - before[i] } : null])), null, 1));
    await new Promise((r) => (s.exitCode !== null ? r() : s.on("exit", r)));
  }
  docker("rm", "-f", `fsw-${name}`);
}
log("done");
