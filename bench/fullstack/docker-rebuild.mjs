// Each app's own `docker build` (its Dockerfile, cache mounts and all) after the item page's edit,
// with BuildKit's cache warm, as CI with a cache builds it:
//   node docker-rebuild.mjs <round> [apps=all] [runs=3]
// Each app gets a builder of its own (`docker buildx create --driver docker-container`), pinned
// to BENCH_BUILD_CPUS (otherwise the host's first four, as build.mjs) with build.mjs's memory cap,
// since BuildKit takes no core pinning itself. On it:
// 1. Cold: the image built once with nothing cached, base images pulled included (so the network
//    is in it), exporting its layer cache (`--cache-to type=local,mode=max`, its export and
//    compression in the time too).
// 2. Kept: `runs` builds on that builder, each after the edit (the button's title, with the run's
//    number, so each changes the file from what the one before it built): its layers and its
//    cache mounts (cargo's target/, npm's cache) are there, as on a CI runner that keeps its
//    builder or a developer's machine.
// 3. Imported: `runs` builds after the same edits, each on a new builder given only the layer
//    cache step 1 exported (`--cache-from`), as a hosted runner restoring a cache gets: BuildKit
//    exports no cache mount, so a step after the source's COPY starts with an empty one, and the
//    new builder may pull the base images again.
// Every build resolves the Dockerfile's syntax image and base tags over the network. Each writes
// only to BuildKit's cache (`--output type=cacheonly`), so no image export or load is in its
// time. Wall time, the builder container's CPU time (its cgroup's usage_usec before and after),
// and for cargo the crates it compiled. A build after the edit that ran no step fails, since its
// time would be a cache hit's. The source is a copy of the app's build context from this
// checkout's working tree, with the edit made in the copy; each entry records the commit and
// whether the tree had changes. Results merge into results/<round>/docker-rebuild.json.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compiledIn, contextOf, dockerfileOf, median, ranSteps, recipes, runChange } from "./builds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const [round = "r1", appsArg = Object.keys(recipes).join(","), runsArg = "3"] = process.argv.slice(2);
const runs = Number(runsArg);
if (!Number.isInteger(runs) || runs < 1) throw new Error("runs is a whole number, 1 or more");
const apps = appsArg.split(",");
for (const name of apps) if (!recipes[name]) throw new Error(`no build recipe for ${name}`);
const minute = 60_000;
// Every command ends well inside build.mjs's call limit (90 minutes), so a hang fails this
// script's app, not the call: a build may take 20 minutes, anything else 10.
const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, timeout = 10 * minute) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 2 ** 20, timeout });
const must = (/** @type {string[]} */ args, timeout = 10 * minute) => {
  const r = run("docker", args, timeout);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")}: ${(r.stdout + r.stderr || r.error?.message || "").trim().slice(-3000)}`);
  return r.stdout + r.stderr;
};
const hostCores = Number(run("docker", ["info", "--format", "{{.NCPU}}"]).stdout.trim());
const cores = process.env.BENCH_BUILD_CPUS ?? `0-${Math.min(4, hostCores || 4) - 1}`;
const hostMemory = Number(run("docker", ["info", "--format", "{{.MemTotal}}"]).stdout.trim());
const memoryCap = Math.min(12 * 2 ** 30, (hostMemory || 16 * 2 ** 30) - 2 * 2 ** 30);
const outFile = join(here, "results", round, "docker-rebuild.json");
/** @type {Record<string, any>} */
const out = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
/** The commit the working tree is at, and whether it has changes, since the copy is the tree's. */
const source = {
  commit: run("git", ["-C", repo, "rev-parse", "--short=8", "HEAD"]).stdout.trim(),
  // The results this and the other scripts write are left out.
  dirty: run("git", ["-C", repo, "status", "--porcelain", "--", ".", ":!bench/fullstack/results"]).stdout.trim() !== "",
};
const save = () => { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, JSON.stringify(out, null, 1)); };
const scratch = mkdtempSync(join(tmpdir(), "corten-docker-rebuild-"));
// What the root's .dockerignore leaves out anyway, and what is large and never in a context.
const skip = new Set([".git", "node_modules", "target", "tmp", "results"]);

/** A new builder pinned to the build cores; its container is `buildx_buildkit_<name>0`. */
const builder = (/** @type {string} */ name) => {
  run("docker", ["buildx", "rm", "-f", name]);
  must(["buildx", "create", "--name", name, "--driver", "docker-container", "--driver-opt", `cpuset-cpus=${cores}`, "--driver-opt", `memory=${memoryCap}`, "--bootstrap"]);
  return name;
};
const usec = (/** @type {string} */ name) => {
  const stat = must(["exec", `buildx_buildkit_${name}0`, "cat", "/sys/fs/cgroup/cpu.stat"]);
  const m = /^usage_usec (\d+)$/m.exec(stat);
  if (!m) throw new Error(`no usage_usec in the builder's cpu.stat: ${stat}`);
  return Number(m[1]);
};
/** One measured build of `dockerfile` in `context` on `name`, with extra buildx arguments. */
const build = (/** @type {string} */ name, /** @type {string} */ context, /** @type {string} */ dockerfile, /** @type {string[]} */ extra, /** @type {boolean} */ mustRun) => {
  const c = usec(name);
  const s = Date.now();
  const output = must(["buildx", "build", "--builder", name, "--progress", "plain", "--output", "type=cacheonly", "-f", dockerfile, ...extra, context], 20 * minute);
  const ms = Date.now() - s;
  const cpuS = +((usec(name) - c) / 1e6).toFixed(1);
  const ran = ranSteps(output);
  if (mustRun && !ran.some((step) => / RUN /.test(step))) throw new Error(`a build after the edit ran no RUN step (it ran: ${ran.join("; ") || "nothing"})`);
  const compiled = compiledIn(output);
  return { ms, cpuS, ran: ran.length, ...(compiled.length ? { compiled } : {}) };
};
const summary = (/** @type {{ ms: number, cpuS: number, ran: number, compiled?: string[] }[]} */ list) => ({ ms: median(list.map((r) => r.ms)), cpuS: median(list.map((r) => r.cpuS)), runs: list });

const buildx = run("docker", ["buildx", "version"]).stdout.trim();
for (const name of apps) {
  const r = recipes[name];
  const kept = `bb-dr-${name}`;
  const fresh = `bb-dr-${name}-fresh`;
  const ctx = join(scratch, name);
  const cache = join(scratch, `${name}-cache`);
  const relContext = contextOf(name);
  const context = join(ctx, relContext);
  const dockerfile = join(ctx, dockerfileOf(name));
  const editFile = join(context, r.edit);
  /** @type {Record<string, any>} */
  const entry = { cores, memoryCap, hostCores, buildx, ...source, measuredAt: new Date().toISOString(), complete: false };
  out[name] = entry;
  const keep = (/** @type {string} */ key, /** @type {unknown} */ value) => { entry[key] = value; save(); return value; };
  try {
    // The context as it is on disk, with its Dockerfile when that is outside it (card-market's is
    // inside the repository root, its context).
    const left = relContext === "." ? new Set([...skip, "bench"]) : skip;
    cpSync(join(repo, relContext), context, { recursive: true, filter: (src) => !left.has(basename(src)) });
    if (!existsSync(dockerfile)) cpSync(join(repo, dockerfileOf(name)), dockerfile);
    const original = readFileSync(editFile, "utf8");
    const at = (/** @type {number} */ i) => {
      const { from, to } = runChange(name, i);
      if (original.split(from).length !== 2) throw new Error(`${name}: ${r.edit} does not have exactly one ${from}`);
      writeFileSync(editFile, original.replace(from, to));
    };
    builder(kept);
    keep("cold", build(kept, context, dockerfile, ["--cache-to", `type=local,dest=${cache},mode=max`], false));
    console.log(name, "cold", JSON.stringify(entry.cold));
    const keptRuns = [];
    for (let i = 1; i <= runs; i += 1) {
      at(i);
      keptRuns.push(build(kept, context, dockerfile, [], true));
      console.log(name, `kept ${i}`, JSON.stringify(keptRuns.at(-1)));
      keep("kept", summary(keptRuns));
    }
    run("docker", ["buildx", "rm", "-f", kept]);
    const importedRuns = [];
    for (let i = 1; i <= runs; i += 1) {
      at(runs + i);
      builder(fresh);
      importedRuns.push(build(fresh, context, dockerfile, ["--cache-from", `type=local,src=${cache}`], true));
      console.log(name, `imported ${i}`, JSON.stringify(importedRuns.at(-1)));
      keep("imported", summary(importedRuns));
      run("docker", ["buildx", "rm", "-f", fresh]);
    }
    keep("complete", true);
  } catch (e) {
    keep("error", e instanceof Error ? e.message : String(e));
    console.log(`${name} failed: ${entry.error}`);
  } finally {
    run("docker", ["buildx", "rm", "-f", kept]);
    run("docker", ["buildx", "rm", "-f", fresh]);
    rmSync(ctx, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
}
rmSync(scratch, { recursive: true, force: true });
