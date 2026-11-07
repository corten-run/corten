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
// 6. Disk: what the dependency step, the production build and the development build each wrote
//    (the container's own layer; for Rust, mostly target/).
// 7. For the Rust apps, after the above is saved (a failure here costs only these): the editor's
//    loop, `cargo check --all-targets` clean, then again after the edit, `runs` times (what
//    rust-analyzer runs for its diagnostics on save), and the tests compiled without running them
//    (`cargo test --no-run`) from the dependencies, then again after the edit. For an app whose
//    recipe lists other kinds of edit (Corten's: a handler's body, a type the pages share, a
//    `messages!` entry, a route added), the development rebuild after each.
// 8. With BENCH_BUILD_SCALE (vCPU sets, as `1-2,0-7`), the clean production build again on each,
//    for the apps in BENCH_BUILD_SCALE_APPS (default corten and axum-maud, the anchor); and for
//    those that build with cargo, the development build clean and after the edit linked by mold
//    instead of the toolchain's default linker, with the linker each build used.
// 9. For Corten's card-market: cargo's per-crate timings of the clean build, and rustc's passes
//    and macro expansion statistics for the app's crate alone (-Ztime-passes and -Zmacro-stats,
//    nightly-only flags allowed on stable with RUSTC_BOOTSTRAP=1, for this diagnosis only).
// Each step runs in a container of its own, so its CPU time and memory are its own: wall time,
// CPU-seconds (the container's cgroup counter: the work, whatever the core count) and the peak of
// its processes' memory (sampled five times a second, without the page cache).
// Usage: node build.mjs <round> [apps=all] [runs=3]
// BENCH_BUILD_CPUS pins the builds to those cores (droplet.mjs: 1-4); otherwise to the host's
// first four, the vCPUs of a standard CI runner. Pinned, not a CPU quota, so `nproc` and Node's
// `availableParallelism()` see four, as on the runner; Node's `os.cpus()` still lists every core
// of the host (README, caveat 14). Each step may use 12 GiB of memory (less on a smaller host), so
// a runaway build is stopped before it takes the machine. Results merge into results/<round>/build.json, so one app can be
// measured again on its own. Run from the repository root's checkout; needs Docker with cgroup v2.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoBuilds, changeOf, contextOf, crateCost, median, oomKills, readStep, recipes, rustcPasses, sourceDockerfile, stepScript, timingUnits, touchThen } from "./builds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const [round = "r1", appsArg = Object.keys(recipes).join(","), runsArg = "3"] = process.argv.slice(2);
const runs = Number(runsArg);
if (!(runs >= 1)) throw new Error("runs must be 1 or more");
const hostCores = Number(spawnSync("docker", ["info", "--format", "{{.NCPU}}"], { encoding: "utf8" }).stdout.trim());
const cores = process.env.BENCH_BUILD_CPUS ?? `0-${Math.min(4, hostCores || 4) - 1}`;
const hostMemory = Number(spawnSync("docker", ["info", "--format", "{{.MemTotal}}"], { encoding: "utf8" }).stdout.trim());
const memoryCap = Math.min(12 * 2 ** 30, (hostMemory || 16 * 2 ** 30) - 2 * 2 ** 30);
const cpus = ["--cpuset-cpus", cores, "--memory", String(memoryCap)];
const cpusLabel = `cores ${cores}`;
// Docker's storage driver, which the disk sizes (the container's layer) come from: overlay2 on the
// classic image store, overlayfs on containerd's.
const storage = spawnSync("docker", ["info", "--format", "{{.Driver}}"], { encoding: "utf8" }).stdout.trim() || "unknown";
const scaleCores = (process.env.BENCH_BUILD_SCALE ?? "").split(",").map((c) => c.trim()).filter(Boolean);
const scaleApps = (process.env.BENCH_BUILD_SCALE_APPS ?? "corten,axum-maud").split(",");
const hour = 3_600_000;
const docker = (/** @type {string[]} */ args, /** @type {{ input?: string, timeout?: number }=} */ options = {}) =>
  spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 2 ** 20, timeout: options.timeout ?? hour, input: options.input });
const must = (/** @type {string[]} */ args, /** @type {{ input?: string, timeout?: number }=} */ options) => {
  const r = docker(args, options);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")}: ${(r.stderr || r.error?.message || "").trim().slice(-2000)}`);
  return r.stdout;
};
const outFile = join(here, "results", round, "build.json");
/** The results so far. A file that does not parse is moved aside, kept for a person to read, so the apps after it are still measured. */
const load = () => {
  if (!existsSync(outFile)) return {};
  try { return JSON.parse(readFileSync(outFile, "utf8")); } catch (e) {
    const aside = `${outFile}.broken-${Date.now()}`;
    renameSync(outFile, aside);
    console.log(`${outFile} did not parse (${e instanceof Error ? e.message : e}); moved to ${aside}`);
    return {};
  }
};
const out = load();
// Written after every step, through a file synced and then renamed into place, so a call stopped
// partway (or a kernel panic) keeps the steps it finished and never leaves half a file.
const save = () => {
  mkdirSync(dirname(outFile), { recursive: true });
  const fd = openSync(`${outFile}.tmp`, "w");
  try { writeSync(fd, JSON.stringify(out, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${outFile}.tmp`, outFile);
  // The rename is the directory's to keep. Windows cannot fsync a directory handle (EPERM), and
  // some mounts refuse it; the results are saved either way.
  if (process.platform !== "win32") {
    const dir = openSync(dirname(outFile), "r");
    try { fsyncSync(dir); } catch (e) { if (!["EINVAL", "ENOTSUP"].includes(/** @type {NodeJS.ErrnoException} */ (e).code ?? "")) throw e; } finally { closeSync(dir); }
  }
};
const scratch = mkdtempSync(join(tmpdir(), "corten-build-"));

/**
 * Runs one measured step in a new container from `image`: writes `files` (container path to
 * contents) into it first, then copies `take` (container path to host path) out after, and
 * commits it as `commit` when given, with what the step wrote to disk (`diskBytes`, the container's
 * own layer, the same in either of Docker's image stores). `cores` pins it to other cores than
 * the steps' own.
 * @param {string} name
 * @param {string} image
 * @param {string} command
 * @param {{ files?: Record<string, string>, take?: Record<string, string>, commit?: string, cores?: string }=} options
 */
function step(name, image, command, { files = {}, take = {}, commit, cores: on } = {}) {
  const container = `bb-${name}`;
  docker(["rm", "-f", container]);
  const pinned = on ? ["--cpuset-cpus", on, "--memory", String(memoryCap)] : cpus;
  must(["create", "--name", container, ...pinned, image, "bash", "-c", stepScript(command)]);
  try {
    for (const [path, text] of Object.entries(files)) {
      const local = join(scratch, "edit");
      writeFileSync(local, text);
      must(["cp", local, `${container}:${path}`]);
    }
    const started = docker(["start", "-a", container], { timeout: 2 * hour });
    const result = readStep(started.stdout);
    if (started.status !== 0 || !result) {
      const kills = oomKills(started.stdout);
      const killed = kills ? `, its processes killed ${kills} times for passing the ${(memoryCap / 2 ** 30).toFixed(1)} GiB memory cap` : "";
      throw new Error(`${name} failed${killed}:\n${(started.stdout + started.stderr).trim().slice(-4000)}`);
    }
    for (const [path, local] of Object.entries(take)) must(["cp", `${container}:${path}`, local]);
    if (commit) {
      const written = Number(docker(["container", "inspect", "--size", "-f", "{{.SizeRw}}", container]).stdout.trim());
      if (written > 0) result.diskBytes = written;
      must(["commit", container, commit]);
    }
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
  // The copied file's time is the host's; touched in the container, it is newer than the last
  // build by the container's clock, which cargo and make compare it with.
  const again = (/** @type {string} */ command) => touchThen(editPath, command);
  /** A rebuild that compiled nothing did not see the edit, and its time would be a no-op's. */
  const rebuilt = (/** @type {ReturnType<typeof step>} */ result, /** @type {string} */ what) => {
    if (cargoBuilds(r) && !result.compiled?.length) throw new Error(`${name}: ${what} compiled nothing after the edit`);
    return result;
  };
  // An earlier call stopped partway leaves this app's images; its results are measured again.
  const images = ["src", "deps", "built", "dev", "checked", "tested", "mold", "mold-dev"];
  for (const what of images) docker(["rmi", "-f", tag(what)]);
  /** @type {Record<string, any>} */
  const entry = { cpus: cpusLabel, memoryCap, storage, measuredAt: new Date().toISOString(), complete: false };
  out[name] = entry;
  /** Records one finished step's result and saves it at once. */
  const keep = (/** @type {string} */ key, /** @type {unknown} */ value) => { entry[key] = value; save(); return value; };
  try {
    const original = readFileSync(join(context, r.edit), "utf8");
    if (original.split(change.from).length !== 2) throw new Error(`${name}: ${r.edit} does not have exactly one ${change.from}`);
    const edited = { [editPath]: original.replace(change.from, change.to) };
    if (r.stage) must(["build", "-q", "--target", "tools", "-t", r.tools, join(repo, r.stage)]);
    must(["build", "-q", "-t", tag("src"), "-f", "-", context], { input: sourceDockerfile(name) });
    const d = keep("deps", step(`${name}-deps`, tag("src"), r.deps, { commit: tag("deps") }));
    const timingsFile = join(scratch, `${name}-timings.html`);
    const b = keep("build", step(`${name}-build`, tag("deps"), r.timings ? `${r.build} --timings` : r.build, {
      commit: tag("built"),
      take: r.timings ? { [`${r.workdir}/target/cargo-timings/cargo-timing.html`]: timingsFile } : {},
    }));
    // Dependencies and build together: what a clean checkout costs, the network included.
    keep("clean", { ms: d.ms + b.ms, cpuS: +(d.cpuS + b.cpuS).toFixed(1) });
    const rebuilds = [];
    for (let i = 0; i < runs; i += 1) {
      rebuilds.push(rebuilt(step(`${name}-rebuild-${i + 1}`, tag("built"), again(r.build), { files: edited }), "the rebuild"));
      keep("rebuild", summary(rebuilds));
    }
    if (r.dev) {
      const dev = keep("dev", { clean: step(`${name}-dev`, tag("deps"), r.dev, { commit: tag("dev") }) });
      const devRebuilds = [];
      for (let i = 0; i < runs; i += 1) {
        devRebuilds.push(rebuilt(step(`${name}-dev-rebuild-${i + 1}`, tag("dev"), again(r.dev), { files: edited }), "the dev rebuild"));
        keep("dev", { ...dev, rebuild: summary(devRebuilds) });
      }
    }
    // What the dependency step, the production build and the development build each wrote.
    keep("disk", { depsBytes: d.diskBytes ?? null, buildBytes: b.diskBytes ?? null, devBytes: entry.dev?.clean.diskBytes ?? null });
    keep("complete", true);
    // The editor's and the tests' loops and the other kinds of edit, after the rest is saved, each
    // group apart, so a failure costs only its own group (`loopsFailed` says which and why).
    /** Runs one group, recording its failure without stopping the others. */
    const apart = (/** @type {string} */ group, /** @type {() => void} */ run) => {
      try { run(); } catch (e) {
        keep("loopsFailed", { ...entry.loopsFailed, [group]: e instanceof Error ? e.message.slice(0, 2000) : String(e) });
        console.log(`${name} ${group}: ${entry.loopsFailed[group]}`);
      }
    };
    // Other kinds of edit, each from the clean development build.
    if (r.dev) for (const e of r.edits ?? []) apart(e.kind, () => {
      const text = readFileSync(join(context, e.edit), "utf8");
      if (text.split(e.from).length !== 2) throw new Error(`${name}: ${e.edit} does not have exactly one ${e.from}`);
      const path = `${r.workdir}/${e.edit}`;
      const kind = e.kind.replace(/\W+/g, "-");
      const list = [];
      for (let i = 0; i < runs; i += 1) {
        list.push(rebuilt(step(`${name}-dev-${kind}-${i + 1}`, tag("dev"), touchThen(path, r.dev), { files: { [path]: text.replace(e.from, e.to) } }), `the dev rebuild after the ${e.kind} edit`));
        keep("edits", { ...entry.edits, [e.kind]: summary(list) });
      }
    });
    // The tests built from the dependencies alone, as the editor's check is: every app's the same
    // way, whatever its development build sets (cargo-leptos's debug builds use other cfgs).
    if (r.test) apart("test", () => {
      const clean = keep("test", { clean: step(`${name}-test`, tag("deps"), r.test, { commit: tag("tested") }) });
      const list = [];
      for (let i = 0; i < runs; i += 1) {
        list.push(rebuilt(step(`${name}-test-rebuild-${i + 1}`, tag("tested"), again(r.test), { files: edited }), "the test build"));
        keep("test", { ...clean, rebuild: summary(list) });
      }
    });
    if (r.check) apart("check", () => {
      const clean = keep("check", { clean: step(`${name}-check`, tag("deps"), r.check, { commit: tag("checked") }) });
      const list = [];
      for (let i = 0; i < runs; i += 1) {
        list.push(rebuilt(step(`${name}-check-again-${i + 1}`, tag("checked"), again(r.check), { files: edited }), "the check"));
        keep("check", { ...clean, again: summary(list) });
      }
    });
    if (scaleCores.length && scaleApps.includes(name)) try {
      // The clean build on other core sets, and for cargo the development loop linked by mold.
      for (const on of scaleCores) keep("scale", { ...entry.scale, [on]: step(`${name}-build-on-${on}`, tag("deps"), r.build, { cores: on }) });
      if (r.dev && cargoBuilds(r)) {
        // Installing mold is not timed: it is a step in the image, before the measured ones. Since
        // Rust 1.90 the default linker here is rust-lld, which `linker-features=-lld` turns off.
        must(["build", "-q", "-t", tag("mold"), "-"], { input: `FROM ${tag("deps")}\nRUN apt-get update -qq && apt-get install -y -qq mold > /dev/null\nENV RUSTFLAGS="-C linker-features=-lld -C link-arg=-fuse-ld=mold"\n` });
        const clean = step(`${name}-mold-dev`, tag("mold"), r.dev, { commit: tag("mold-dev") });
        // The linker each development build used, from the names linkers write into a binary's
        // .comment section (mold's "mold", LLD's "Linker: LLD"): the mold build's must be mold's,
        // and the default's is recorded, since the toolchain image follows the latest Rust.
        const linker = (/** @type {string} */ image) => {
          const out = docker(["run", "--rm", image, "bash", "-c", "for f in $(find target/debug -maxdepth 1 -type f -executable); do readelf -p .comment \"$f\"; done"]).stdout;
          return /\bmold\b/.test(out) ? "mold" : /Linker: LLD/.test(out) ? "lld" : "another";
        };
        if (linker(tag("mold-dev")) !== "mold") throw new Error(`${name}: the development build was not linked by mold`);
        keep("linkers", { dev: linker(tag("dev")), mold: "mold" });
        const list = [];
        for (let i = 0; i < runs; i += 1) {
          list.push(rebuilt(step(`${name}-mold-dev-rebuild-${i + 1}`, tag("mold-dev"), again(r.dev), { files: edited }), "the mold dev rebuild"));
          keep("mold", { clean, rebuild: summary(list) });
        }
      }
    } catch (e) {
      keep("scaleFailed", e instanceof Error ? e.message.slice(0, 2000) : String(e));
      console.log(`${name} scaling: ${entry.scaleFailed}`);
    }
    // Diagnostics, which a change to cargo's or rustc's output could break, after the rest is saved.
    if (r.timings) try {
      keep("crates", crateCost(timingUnits(readFileSync(timingsFile, "utf8")), r.timings.own));
      const log = join(scratch, `${name}-rustc.txt`);
      // The app's crate built again with its passes and macro statistics written out. cargo counts
      // RUSTC_BOOTSTRAP in every crate's fingerprint, so this compiles the dependencies again too:
      // the step's own time is not a rebuild's; only the passes (the app's crate) are read. Their
      // total is the crate's own compile time, which in r14 matched --timings' (37.8 s and 37.9 s).
      const command = touchThen(r.timings.touch, `RUSTC_BOOTSTRAP=1 cargo rustc --release -p ${r.timings.bin} --bin ${r.timings.bin} -- -Ztime-passes -Zmacro-stats > /tmp/rustc.txt 2>&1`);
      keep("rustcStep", step(`${name}-rustc`, tag("built"), command, { take: { "/tmp/rustc.txt": log } }));
      keep("rustc", rustcPasses(readFileSync(log, "utf8")));
    } catch (e) {
      keep("diagnosticsFailed", e instanceof Error ? e.message.slice(0, 2000) : String(e));
      console.log(`${name} diagnostics: ${entry.diagnosticsFailed}`);
    }
  } catch (e) {
    // The steps that finished stay; the entry says which one failed.
    keep("failed", e instanceof Error ? e.message.slice(0, 2000) : String(e));
    console.log(`${name}: ${entry.failed}`);
  } finally {
    for (const what of images) docker(["rmi", "-f", tag(what)]);
  }
  save();
}
rmSync(scratch, { recursive: true, force: true });
const s = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;
for (const [name, e] of Object.entries(out)) {
  // Entries written before `complete` was recorded have none, and finished.
  if (e.failed || e.complete === false) { console.log(`| ${name} | FAILED: ${(e.failed ?? "stopped before it finished").split("\n")[0]} |`); continue; }
  const dev = e.dev ? `dev ${s(e.dev.clean.ms)}, after the edit ${s(e.dev.rebuild.ms)}` : "";
  console.log(`| ${name} | deps ${s(e.deps.ms)} | build ${s(e.build.ms)}, ${e.build.cpuS} CPU-s, ${e.build.peakMiB} MiB | clean ${s(e.clean.ms)}, ${e.clean.cpuS} CPU-s | rebuild ${s(e.rebuild.ms)}, ${e.rebuild.cpuS} CPU-s | ${dev} |`);
}
