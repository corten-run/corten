// Build cost: what it takes to get each app from a clean checkout to its production build, and to
// build it again after a one-line change to its item page's view, run in containers on a fixed
// number of cores. For each app:
// 1. Its toolchain image with its source copied in (the app's own build context and .dockerignore,
//    as its image's build has).
// 2. Dependencies: its Dockerfile's dependency layer (npm install, dotnet restore, mix deps.get
//    and deps.compile, Drogon's own build, ...; for Rust, `cargo fetch`, since its Dockerfiles
//    fetch and compile in one step), which downloads them, so its time depends on the network.
// 3. Clean build: its Dockerfile's build step on that tree (for Rust, this compiles every
//    dependency too, which the other ecosystems mostly install built).
// 4. Rebuild: the same build again after the edit in builds.mjs, on the tree the clean build left,
//    so with whatever cache the tool keeps (cargo's target/, .next/cache, _build, obj); `runs`
//    times, each from the same clean-built tree. A cargo rebuild that compiled nothing fails.
// Only Corten's clean build runs with cargo's --timings, which records when each crate starts and
// ends.
// 5. For an app whose development loop compiles the whole program after each save (`dev` in
//    builds.mjs: the Rust, Go and C++ apps; Corten's `corten dev` runs `cargo build`): its
//    development build clean, then again after the same edit, `runs` times.
// 6. For Corten's card-market: cargo's per-crate timings of the clean build, and rustc's passes
//    and macro expansion statistics for the app's crate alone (-Ztime-passes and -Zmacro-stats,
//    nightly-only flags allowed on stable with RUSTC_BOOTSTRAP=1, for this diagnosis only).
// Each step runs in a container of its own, so its CPU time and memory are its own: wall time,
// CPU-seconds (the container's cgroup counter: the work, whatever the core count) and the peak of
// its processes' memory (sampled five times a second, without the page cache).
// Usage: node build.mjs <round> [apps=all] [runs=3]
// BENCH_BUILD_CPUS pins the builds to those cores (droplet.mjs: 1-4); otherwise to the host's
// first four, the vCPUs of a standard CI runner. Pinned, not a CPU quota, so `nproc` and a tool's
// own count of cores see four, as on the runner. Results merge into results/<round>/build.json, so one app can be
// measured again on its own. Run from the repository root's checkout; needs Docker with cgroup v2.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoBuilds, changeOf, contextOf, crateCost, median, readStep, recipes, rustcPasses, sourceDockerfile, stepScript, timingUnits } from "./builds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const [round = "r1", appsArg = Object.keys(recipes).join(","), runsArg = "3"] = process.argv.slice(2);
const runs = Number(runsArg);
if (!(runs >= 1)) throw new Error("runs must be 1 or more");
const hostCores = Number(spawnSync("docker", ["info", "--format", "{{.NCPU}}"], { encoding: "utf8" }).stdout.trim());
const cores = process.env.BENCH_BUILD_CPUS ?? `0-${Math.min(4, hostCores || 4) - 1}`;
const cpus = ["--cpuset-cpus", cores];
const cpusLabel = `cores ${cores}`;
const hour = 3_600_000;
const docker = (/** @type {string[]} */ args, /** @type {{ input?: string, timeout?: number }=} */ options = {}) =>
  spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 2 ** 20, timeout: options.timeout ?? hour, input: options.input });
const must = (/** @type {string[]} */ args, /** @type {{ input?: string, timeout?: number }=} */ options) => {
  const r = docker(args, options);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")}: ${(r.stderr || r.error?.message || "").trim().slice(-2000)}`);
  return r.stdout;
};
const outFile = join(here, "results", round, "build.json");
const out = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const scratch = mkdtempSync(join(tmpdir(), "corten-build-"));

/**
 * Runs one measured step in a new container from `image`: writes `files` (container path to
 * contents) into it first, then copies `take` (container path to host path) out after, and
 * commits it as `commit` when given.
 * @param {string} name
 * @param {string} image
 * @param {string} command
 * @param {{ files?: Record<string, string>, take?: Record<string, string>, commit?: string }=} options
 */
function step(name, image, command, { files = {}, take = {}, commit } = {}) {
  const container = `bb-${name}`;
  docker(["rm", "-f", container]);
  must(["create", "--name", container, ...cpus, image, "bash", "-c", stepScript(command)]);
  try {
    for (const [path, text] of Object.entries(files)) {
      const local = join(scratch, "edit");
      writeFileSync(local, text);
      must(["cp", local, `${container}:${path}`]);
    }
    const started = docker(["start", "-a", container], { timeout: 2 * hour });
    const result = readStep(started.stdout);
    if (started.status !== 0 || !result) throw new Error(`${name} failed:\n${(started.stdout + started.stderr).trim().slice(-4000)}`);
    for (const [path, local] of Object.entries(take)) must(["cp", `${container}:${path}`, local]);
    if (commit) must(["commit", container, commit]);
    console.log(name, `${(result.ms / 1000).toFixed(1)} s, ${result.cpuS} CPU-s, ${result.peakMiB} MiB`);
    return result;
  } finally {
    docker(["rm", "-f", container]);
  }
}

/** The runs' median wall time, CPU-seconds and peak memory, and each run. */
const summary = (/** @type {{ ms: number, cpuS: number, peakMiB: number }[]} */ list) => ({
  ms: median(list.map((r) => r.ms)),
  cpuS: median(list.map((r) => r.cpuS)),
  peakMiB: median(list.map((r) => r.peakMiB)),
  runs: list,
});

for (const name of appsArg.split(",")) {
  const r = recipes[name];
  if (!r) throw new Error(`no build recipe for ${name}`);
  const tag = (/** @type {string} */ what) => `bb-${name}:${what}`;
  const context = join(repo, contextOf(name));
  const editPath = `${r.workdir}/${r.edit}`;
  const change = changeOf(name);
  const original = readFileSync(join(context, r.edit), "utf8");
  if (original.split(change.from).length !== 2) throw new Error(`${name}: ${r.edit} does not have exactly one ${change.from}`);
  const edited = { [editPath]: original.replace(change.from, change.to) };
  // The copied file's time is the host's; touched in the container, it is newer than the last
  // build by the container's clock, which cargo and make compare it with.
  const again = (/** @type {string} */ command) => `touch ${editPath} && ${command}`;
  /** A rebuild that compiled nothing did not see the edit, and its time would be a no-op's. */
  const rebuilt = (/** @type {ReturnType<typeof step>} */ result, /** @type {string} */ what) => {
    if (cargoBuilds(r) && !result.compiled?.length) throw new Error(`${name}: ${what} compiled nothing after the edit`);
    return result;
  };
  try {
    if (r.stage) must(["build", "-q", "--target", "tools", "-t", r.tools, join(repo, r.stage)]);
    must(["build", "-q", "-t", tag("src"), "-f", "-", context], { input: sourceDockerfile(name) });
    /** @type {Record<string, unknown>} */
    const entry = { cpus: cpusLabel, measuredAt: new Date().toISOString() };
    entry.deps = step(`${name}-deps`, tag("src"), r.deps, { commit: tag("deps") });
    const deps = tag("deps");
    const timingsFile = join(scratch, `${name}-timings.html`);
    entry.build = step(`${name}-build`, deps, r.timings ? `${r.build} --timings` : r.build, {
      commit: tag("built"),
      take: r.timings ? { [`${r.workdir}/target/cargo-timings/cargo-timing.html`]: timingsFile } : {},
    });
    const d = /** @type {{ ms: number, cpuS: number }} */ (entry.deps);
    const b = /** @type {{ ms: number, cpuS: number, peakMiB: number }} */ (entry.build);
    // Dependencies and build together: what a clean checkout costs, the network included.
    entry.clean = { ms: d.ms + b.ms, cpuS: +(d.cpuS + b.cpuS).toFixed(1) };
    entry.rebuild = summary(Array.from({ length: runs }, (_, i) => rebuilt(step(`${name}-rebuild-${i + 1}`, tag("built"), again(r.build), { files: edited }), "the rebuild")));
    if (r.dev) {
      const clean = step(`${name}-dev`, deps, r.dev, { commit: tag("dev") });
      entry.dev = { clean, rebuild: summary(Array.from({ length: runs }, (_, i) => rebuilt(step(`${name}-dev-rebuild-${i + 1}`, tag("dev"), again(r.dev), { files: edited }), "the dev rebuild"))) };
    }
    // Saved before the diagnostics, which a change to cargo's or rustc's output could break.
    out[name] = entry;
    if (r.timings) try {
      entry.crates = crateCost(timingUnits(readFileSync(timingsFile, "utf8")), r.timings.own);
      const log = join(scratch, `${name}-rustc.txt`);
      // The app's crate built again with its passes and macro statistics written out. cargo counts
      // RUSTC_BOOTSTRAP in every crate's fingerprint, so this compiles the dependencies again too:
      // the step's own time is not a rebuild's; only the passes (the app's crate) are read.
      const command = `touch ${r.timings.touch} && RUSTC_BOOTSTRAP=1 cargo rustc --release -p ${r.timings.bin} --bin ${r.timings.bin} -- -Ztime-passes -Zmacro-stats > /tmp/rustc.txt 2>&1`;
      entry.rustcStep = step(`${name}-rustc`, tag("built"), command, { take: { "/tmp/rustc.txt": log } });
      entry.rustc = rustcPasses(readFileSync(log, "utf8"));
    } catch (e) {
      entry.diagnosticsFailed = e instanceof Error ? e.message.slice(0, 2000) : String(e);
      console.log(`${name} diagnostics: ${entry.diagnosticsFailed}`);
    }
  } catch (e) {
    out[name] = { failed: e instanceof Error ? e.message.slice(0, 2000) : String(e), cpus: cpusLabel, measuredAt: new Date().toISOString() };
    console.log(`${name}: ${out[name].failed}`);
  } finally {
    for (const what of ["src", "deps", "built", "dev"]) docker(["rmi", "-f", tag(what)]);
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 1));
}
rmSync(scratch, { recursive: true, force: true });
const s = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;
for (const [name, e] of Object.entries(out)) {
  if (e.failed) { console.log(`| ${name} | FAILED: ${e.failed.split("\n")[0]} |`); continue; }
  const dev = e.dev ? `dev ${s(e.dev.clean.ms)}, after the edit ${s(e.dev.rebuild.ms)}` : "";
  console.log(`| ${name} | deps ${s(e.deps.ms)} | build ${s(e.build.ms)}, ${e.build.cpuS} CPU-s, ${e.build.peakMiB} MiB | clean ${s(e.clean.ms)}, ${e.clean.cpuS} CPU-s | rebuild ${s(e.rebuild.ms)}, ${e.rebuild.cpuS} CPU-s | ${dev} |`);
}