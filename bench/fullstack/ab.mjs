// Before/after for one app on one CPU, items from memory: node ab.mjs <out-dir> <image-a> <image-b> ...
// For each image and Accept-Encoding (none, what a browser sends, which gets zstd, and brotli alone,
// for a client without zstd): a fixed 300 req/s (CPU use at the same work) and 64 users
// (throughput). Images run one at a time, alternating, on the same port, for AB_ROUNDS rounds (3
// unless set, AB_ENCODINGS to run only some), for the item page or, with AB_TARGETS=page,json, its
// JSON too; the summary gives each image's median and range of CPU use and throughput, and of
// requests per CPU-second in each phase, the app's CPU counted from its cgroup (cpu-time.mjs).
// On a bench host BENCH_APP_CPUS and BENCH_FIXTURE_LOAD_CPUS (else BENCH_LOAD_CPUS) pin the app and
// k6 as a round does for an app serving from memory (apps.mjs). A failed run stops with the rows so
// far in summary.partial.json, leaving an earlier summary.json as it was.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appCpus, k6User, loadCpusFor, network } from "./apps.mjs";
import { cpuUsec } from "./cpu-time.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [out = "results/ab", ...images] = process.argv.slice(2);
const dir = join(here, out);
mkdirSync(dir, { recursive: true });
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @type {Record<string, string>} */
const encodings = { identity: "identity", browser: "gzip, deflate, br, zstd", br: "br" };
// AB_ENCODINGS (names, comma-separated) runs only those.
if (process.env.AB_ENCODINGS) {
  const wanted = process.env.AB_ENCODINGS.split(",");
  for (const name of Object.keys(encodings)) if (!wanted.includes(name)) delete encodings[name];
  if (Object.keys(encodings).length !== wanted.length) throw new Error("AB_ENCODINGS names one of identity, browser, br");
}
const targets = (process.env.AB_TARGETS ?? "page").split(",");
if (!targets.length || targets.some((t) => t !== "page" && t !== "json") || new Set(targets).size !== targets.length) throw new Error("AB_TARGETS names page, json or both");
const rounds = Number(process.env.AB_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("AB_ROUNDS is a whole number above zero");
const rows = [];
let finished = false;

try {
  for (let round = 1; round <= rounds; round++) {
    // Each round starts one image later, so no image always runs first (or last) in a round.
    for (const image of images.map((_, i) => images[(i + round - 1) % images.length])) {
      docker("rm", "-f", "ab-app");
      const run = docker("run", "-d", "--name", "ab-app", "--network", network, ...appCpus, "--memory", "1g", "-v", `${join(here, "fixtures")}:/fixtures:ro`, "-e", "ITEM_SOURCE=fixture", "-e", "FIXTURE_PATH=/fixtures/items.json", "-e", "PORT=8080", "-e", "HOSTS=ab-app", image);
      if (run.status !== 0) throw new Error(run.stderr);
      await sleep(4000);
      for (const target of targets) for (const [encName, enc] of Object.entries(encodings)) {
        for (const [phase, env] of [["warmup", { MODE: "closed", VUS: "32", DURATION: "10s" }], ["fixed300", { MODE: "open", RATE: "300", DURATION: "40s" }], ["vus64", { MODE: "closed", VUS: "64", DURATION: "40s" }]]) {
          const name = `${image}-${target}-${encName}-${phase}-r${round}`;
          const stats = join(dir, `${name}-stats.json`);
          // A file left by an earlier run is never read as this one's.
          rmSync(stats, { force: true });
          rmSync(join(dir, `${name}.json`), { force: true });
          const sampler = phase === "warmup" ? null : spawn("node", [join(here, "sample-stats.mjs"), stats, "42", "ab-app"], { stdio: "ignore", windowsHide: true });
          const args = ["run", "--rm", "--network", network, ...loadCpusFor("fixture"), ...k6User, "-v", `${here}:/bench`, "-e", "BASE=http://ab-app:8080", "-e", `ENC=${enc}`, "-e", `TARGET=${target}`];
          for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
          args.push("grafana/k6:latest", "run", "--quiet", "--summary-export", `/bench/${out}/${name}.json`, "/bench/ab-load.js");
          const before = cpuUsec("ab-app");
          const load = docker(...args);
          const after = cpuUsec("ab-app");
          if (sampler) await new Promise((r) => (sampler.exitCode !== null ? r() : sampler.on("exit", r)));
          if (load.status !== 0) throw new Error(`k6 failed (${load.status}) on ${name}: ${load.stderr}`);
          if (phase === "warmup") continue;
          const k6 = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
          const d = k6.metrics.http_req_duration;
          const cpu = JSON.parse(readFileSync(stats, "utf8"))["ab-app"]?.cpuAvgPct ?? null;
          const bytes = k6.metrics.data_received.count / k6.metrics.http_reqs.count;
          // The app's CPU over the phase, counted (null when its cgroup cannot be read).
          const cpuSeconds = before === null || after === null ? null : (after - before) / 1e6;
          const requests = k6.metrics.http_reqs.count;
          const perCpuSecond = cpuSeconds ? Math.round(requests / cpuSeconds) : null;
          const row = { round, image, target, enc: encName, phase, rps: Math.round(k6.metrics.http_reqs.rate), p50: +d["p(50)"].toFixed(2), p99: +d["p(99)"].toFixed(2), failed: k6.metrics.checks?.fails ?? 0, cpu, bytesPerResponse: Math.round(bytes), requests, cpuSeconds: cpuSeconds === null ? null : +cpuSeconds.toFixed(3), perCpuSecond };
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
      docker("rm", "-f", "ab-app");
    }
  }
  finished = true;
  rmSync(join(dir, "summary.partial.json"), { force: true });
} finally {
  docker("rm", "-f", "ab-app");
  writeFileSync(join(dir, finished ? "summary.json" : "summary.partial.json"), JSON.stringify(rows, null, 1));
}
const median = (/** @type {number[]} */ xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const spread = (/** @type {number[]} */ xs) => `${median(xs)} (${Math.min(...xs)} to ${Math.max(...xs)})`;
for (const target of targets) for (const enc of Object.keys(encodings)) {
  for (const phase of ["fixed300", "vus64"]) {
    for (const image of images) {
      const mine = rows.filter((r) => r.image === image && r.target === target && r.enc === enc && r.phase === phase);
      const cpu = mine.map((r) => r.cpu ?? NaN), rps = mine.map((r) => r.rps), per = mine.map((r) => r.perCpuSecond ?? NaN);
      console.log(`${target} ${enc} ${phase} ${image}: CPU % median ${spread(cpu)}, req/s median ${spread(rps)}, req per CPU-second median ${spread(per)}`);
    }
  }
}
