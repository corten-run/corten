// The whole comparison, in order, on a quiet machine: cold start, the item page and the item as
// JSON without a database and against the item API, instructions per request, the feature matrix
// (conform.mjs, each app on its own against a probe), then all apps up
// together for parity, byte counts and browser timing, and last each app's build (build.mjs).
// Usage: node run-all.mjs <round> [browserRuns=10] [from=cold-start|fixture|api|count|conform|browser|build] [until=build] [--unattended]
//   from: start at that step and keep the results already in results/<round> from earlier ones.
//   until: the last step to run (droplet.mjs's browser suite stops after the browser step).
//   --unattended: how droplet.mjs runs a round on a droplet, under a systemd unit that starts it
//     again when the droplet restarts. Each call has a time limit (round.mjs) and may not go an
//     hour without printing anything; one that does is stopped and the rest of its step skipped
//     (a build call is one app's, so a stopped one, or one that exits with an error, skips that
//     app alone).
//     Progress goes to results-<round>.progress: started again after a restart (a lockup panics
//     the kernel, which reboots), the round skips the step that was running and goes on from the
//     next; in the build step it skips the app that was building and goes on with the next app.
//     In the count step it goes on only where it started in another boot, by the boot's ID on the
//     step's start line: a start again in the same boot, which cannot tell its perf is gone, ends
//     the round (round.mjs, countRestartError), as does a progress file whose last line was cut
//     short, checked before the start writes anything; a cut file is left as it is, so every start
//     refuses on it again. Each line is written whole and synced before its step starts (appendLine).
//     A skipped step is written to the log and to results/<round>/skipped.txt
//     ("<time> step <name> skipped: <why>", the app named in the why for a build), which
//     summarize.mjs copies into summary.json. Before that, the kernel's log of the boot that
//     ended (`journalctl -k -b -1`) goes to results/<round>/kernel-before-start-<n>.txt
//     (keepKernelLog).
// On a bench host set BENCH_APP_CPUS, BENCH_LOAD_CPUS and BENCH_API_CONTAINER (droplet.mjs does).
// BENCH_TIER=matched (droplet.mjs --tier matched) runs the matched tier's apps with the production
// profile (apps.mjs; README, "The matched tier"), in a round named m<n>.
// BENCH_PASSES (1 unless set, droplet.mjs --passes) runs each load phase that many times, the apps
// taking turns, and summarize.mjs reports their median and range (passes.mjs).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiContainer, apps, network, pageApps, pageOnly, runArgs, tier, viaEdge } from "./apps.mjs";
import { edgeBase, reachApp, startEdge, stopEdge } from "./edge.mjs";
import { passesOf } from "./passes.mjs";
import { appendLine, buildStep, calls, countRestartError, idleMinutes, mayStart, resumeAt, roundNameError, runSteps, startMinutes, steps, stepsUntil, superviseCall } from "./round.mjs";
import { EVERY_EVENT } from "./count-perf.mjs";
import { k6Image } from "./load-tool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const unattended = process.argv.includes("--unattended");
const [round = "r1", browserRuns = "10", from = steps[0], until = steps.at(-1)] = process.argv.slice(2).filter((a) => a !== "--unattended");
if (!steps.includes(from)) throw new Error(`from must be one of ${steps.join(", ")}`);
const untilError = stepsUntil(from, until).error;
if (untilError) throw new Error(untilError);
// A matched-tier round (BENCH_TIER=matched) is m<n>, and only it: the trend reads r<n> alone.
if (roundNameError(round, tier, { full: true })) throw new Error(/** @type {string} */ (roundNameError(round, tier, { full: true })));
// It removes every container on the host, so only where droplet.mjs runs it.
if (unattended && (process.platform !== "linux" || !process.env.BENCH_APP_CPUS)) throw new Error("--unattended is for a bench droplet (droplet.mjs runs it there)");
const minute = 60_000;
const now = () => new Date().toISOString();
const docker = (/** @type {string[]} */ ...args) => spawnSync("docker", args, { encoding: "utf8", timeout: 5 * minute });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const progressFile = join(here, `results-${round}.progress`);
/** This boot's ID, or null where it cannot be read. */
const bootId = () => { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; } catch { return null; } };
// Written whole or not at all (appendLine throws, and the step is not started), then synced to disk
// (the file and, when it is new, its directory), so a line written just before a kernel panic is
// still there after the reboot. The count step's start names the boot it started in, so a start
// again in that boot does not go on past it (countRestartError).
const progress = (/** @type {string} */ what) => {
  if (!unattended) return;
  const created = !existsSync(progressFile);
  const fd = openSync(progressFile, "a+");
  const line = what === "start count" ? `${what} ${bootId() ?? ""}`.trimEnd() : what;
  try { appendLine(fd, `${now()} ${line}`); fsyncSync(fd); } finally { closeSync(fd); }
  if (created) { const dir = openSync(here, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
};
const skippedFile = join(here, "results", round, "skipped.txt");
const skip = (/** @type {string} */ step, /** @type {string} */ why) => {
  const line = `${now()} step ${step} skipped: ${why}`;
  console.log(line);
  mkdirSync(dirname(skippedFile), { recursive: true });
  appendFileSync(skippedFile, `${line}\n`);
};

// Runs one call and resolves to its exit code and, unattended, why it was stopped: past its
// limit or quiet for too long, it is stopped with everything it started (its process group: perf,
// the docker clients; the containers they started go in reset()), and an output something it
// started holds open after it exits is released (round.mjs, superviseCall).
const call = async (/** @type {number} */ limit, /** @type {string[]} */ args) => {
  console.log(now(), "node", args.join(" "));
  // Only count-pairs.mjs sets this mode. A round never passes it to count.mjs.
  const env = args[0] === "count.mjs" ? { ...process.env } : undefined;
  if (env) delete env[EVERY_EVENT];
  // Unattended, its output passes through here so a quiet call can be told from a busy one.
  const child = spawn("node", args, { cwd: here, env, stdio: unattended ? ["ignore", "pipe", "pipe"] : "inherit", detached: unattended });
  const result = await superviseCall(child, {
    label: args[0],
    limitMs: unattended ? limit * minute : Infinity,
    idleMs: unattended ? idleMinutes * minute : Infinity,
    signalGroup: (pid, signal) => process.kill(-pid, signal),
    write: (chunk) => process.stdout.write(chunk),
  });
  if (!result.stopped && result.code !== 0) console.log(`step failed with ${result.code}`);
  return result;
};

// Unattended only: a clean slate after a stopped call, a build that exited with an error, or a
// restart. The benchmark's containers go
// (a stopped k6 client leaves its container running; a restart leaves them all stopped): the apps,
// build.mjs's steps (and the images they commit, several GB for a Rust app), docker-rebuild.mjs's
// builders, cold start's, the item API, and k6's and cpu-time.mjs's by image, and the build scripts' scratch
// directories. Then the item API starts again
// on its cores.
const reset = () => {
  // docker-rebuild.mjs's builders first, with their state volumes: their containers match bb- too,
  // and buildx rm on a builder whose container is gone leaves its volume.
  for (const builder of docker("buildx", "ls", "--format", "{{.Name}}").stdout?.split("\n").filter((n) => n.startsWith("bb-dr-")) ?? []) docker("buildx", "rm", "-f", builder);
  const ids = [["name=fsw-", "name=bb-", "name=cs-", "name=item-api"], [`ancestor=${k6Image}`, "ancestor=alpine"]]
    .flatMap((filters) => docker("ps", "-aq", ...filters.flatMap((f) => ["--filter", f])).stdout?.split("\n").filter(Boolean) ?? []);
  if (ids.length) docker("rm", "-f", ...new Set(ids));
  // A state volume buildx rm left (its builder's container already gone), now no container uses
  // it.
  const states = docker("volume", "ls", "-q", "--filter", "name=buildx_buildkit_bb-dr-").stdout?.split("\n").filter(Boolean) ?? [];
  if (states.length) docker("volume", "rm", "-f", ...states);
  const images = docker("images", "-q", "--filter", "reference=bb-*").stdout?.split("\n").filter(Boolean) ?? [];
  if (images.length) docker("rmi", "-f", ...new Set(images));
  // The scratch directories a stopped build.mjs or docker-rebuild.mjs left (a copy of the
  // repository and an exported layer cache, for Corten); each removes its own when it ends.
  for (const dir of readdirSync(tmpdir()).filter((d) => d.startsWith("corten-build-") || d.startsWith("corten-docker-rebuild-"))) {
    rmSync(join(tmpdir(), dir), { recursive: true, force: true });
  }
  if (apiContainer !== "item-api") return;
  const r = docker("run", "-d", "--name", "item-api", "--network", network, "--cpuset-cpus", "2-3", "-v", `${here}:/b:ro`,
    "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067", "node", "/b/item-api/server.mjs", "/b/fixtures/items.json");
  if (r.status !== 0) throw new Error(`could not start the item API: ${r.stderr || r.error?.message}`);
};

// Every app that renders the pages up at once, for the browser step's calls.
const startEveryApp = async () => {
  console.log(now(), "starting every app for parity, bytes and browser timing");
  for (const [name, app] of Object.entries(pageApps)) {
    docker("rm", "-f", `fsw-${name}`);
    docker(...runArgs(name, app, "api", join(here, "fixtures")));
  }
  // Every app shares the app core here, so slow starters (the JVM) take a while: wait up to two
  // minutes for each, however its port behaves.
  /** The apps that answered, which the edge must reach. @type {[string, { port: number }][]} */
  const answered = [];
  for (const [name, app] of Object.entries(pageApps)) {
    const deadline = Date.now() + startMinutes * minute;
    let up = false;
    while (!up && Date.now() < deadline) {
      const left = Math.max(1, Math.min(5000, deadline - Date.now()));
      try { up = (await fetch(`http://localhost:${app.port}/items/item_1`, { signal: AbortSignal.timeout(left) })).ok; } catch {}
      if (!up) await sleep(500);
    }
    if (!up) console.log(`${name} did not answer within two minutes`);
    else answered.push([name, app]);
  }
  if (!viaEdge) return null;
  const failed = await startEdge(Object.entries(pageApps), network);
  if (failed) return failed;
  // As in run-ssr.mjs: each app that is up must answer through the edge before it is timed there.
  for (const [name, app] of answered) {
    const unreachable = await reachApp(app, "/items/item_1");
    if (unreachable) { stopEdge(); return `${name}: ${unreachable}`; }
  }
  return null;
};
const stopEveryApp = () => { for (const name of Object.keys(pageApps)) docker("rm", "-f", `fsw-${name}`); if (viaEdge) stopEdge(); };

/**
 * Saves the kernel's log of the boot that ended (`journalctl -k -b -1`, streamed to the file, since
 * a long round's log can outgrow a pipe's buffer) to results/<round>/kernel-before-start-<n>.txt.
 * A panic's own report rarely reaches the journal before the machine goes down (droplet.mjs has a
 * lockup panic at once, and a droplet boots BIOS, without the EFI store pstore usually keeps a
 * panic in), so finding none is not evidence there was none: what the log can show is what came
 * before. Never fails the round: this is a diagnostic.
 * @param {number} start
 */
function keepKernelLog(start) {
  try {
    const saved = join(here, "results", round, `kernel-before-start-${start}.txt`);
    mkdirSync(dirname(saved), { recursive: true });
    const fd = openSync(saved, "w");
    const log = spawnSync("journalctl", ["-k", "-b", "-1", "--no-pager", "-o", "short-precise"], { stdio: ["ignore", fd, "pipe"], encoding: "utf8", timeout: minute });
    closeSync(fd);
    const text = readFileSync(saved, "utf8");
    const failed = log.status !== 0 ? ` (journalctl ${log.status ?? log.signal}: ${log.error?.message ?? log.stderr?.trim()})` : "";
    if (!text) {
      console.log(now(), `the journal of the boot that ended is unreadable${failed}`);
      return;
    }
    const why = text.split("\n").filter((l) => /soft lockup|rcu.*stall|Kernel panic|watchdog|hung_task|BUG:|Oops/i.test(l));
    const said = why.length ? `logged ${why.slice(0, 3).join(" | ")}` : "has no lockup, stall or panic in its saved journal (a panic's own report rarely reaches it)";
    console.log(now(), `the boot that ended ${said}${failed ? `, cut short${failed}` : ""} (${saved})`);
  } catch (e) {
    console.log(now(), `the kernel log of the boot that ended was not saved: ${e instanceof Error ? e.message : e}`);
  }
}

/** Whether a failed round may record "failed" in its progress file: not when that would end a line cut short (below). */
let recordFailure = true;
try {
  /** @type {string | null} */
  let first = from;
  /** The apps whose builds have started, before a restart or in this start: none is built again. @type {string[]} */
  let built = [];
  if (unattended) {
    const text = existsSync(progressFile) ? readFileSync(progressFile, "utf8") : "";
    const state = resumeAt(text, from);
    if (state.ended) process.exit(0);
    // Before anything is written or cleaned: a count step whose perf may still run ends the round,
    // as a halt does. A progress file whose last line was cut short is left as it is: appending
    // ends that line first, and a start stopped part way through the append would leave the next
    // one no cut line to read, so every start refuses on it again instead. Otherwise the refusal
    // is recorded as the round's failure, which no later start goes on past.
    const halted = countRestartError(text, bootId());
    if (halted) {
      if (text.length && !text.endsWith("\n")) recordFailure = false;
      skip("count", halted);
      throw new Error(halted);
    }
    // Written before anything else, so every start counts, even one cut short in reset().
    progress("boot");
    if (state.boots) {
      console.log(now(), "the round starts again after the droplet restarted");
      // First, before anything else runs: what the boot that ended left of its kernel log.
      keepKernelLog(state.boots + 1);
      // A restart skips the step it was in (in the build step, the app), and a round that keeps
      // restarting is broken: it stops after a few (round.mjs).
      if (!mayStart(state.boots)) throw new Error(`the round has started ${state.boots + 1} times`);
      if (state.skip === "build" && state.app) skip("build", `the droplet restarted while ${state.app} built; the other apps' builds go on`);
      else if (state.skip) skip(state.skip, "the droplet restarted while it ran");
    }
    reset();
    first = state.next;
    built = state.built;
  }
  const jsonOnly = Object.keys(apps).filter((name) => !(name in pageApps));
  // The browser step reaches each app as the round's load phases do: the matched tier's through the edge.
  const urls = Object.values(pageApps).map((a) => (viaEdge ? edgeBase(a, "outside") : `http://localhost:${a.port}`));
  const all = calls(round, browserRuns, Object.keys(pageApps), urls, jsonOnly, passesOf(process.env.BENCH_PASSES), pageOnly);
  // A count call that exits 4 or is stopped (round.mjs, countHalt), or any call left running after
  // its stop or whose output was released after its exit, ends the round there: no later step,
  // call, clean slate or summary, and the round is recorded failed.
  await runSteps(first ? stepsUntil(first, until).steps : [], all, {
    call,
    progress,
    skip,
    reset: () => { if (unattended) reset(); },
    // Each build is one app's: one stopped skips that app alone, and none starts past the budget.
    build: async (stepStarted) => { await buildStep(all, built, { minutes: () => (Date.now() - stepStarted) / minute, call, progress, skip, reset: () => { if (unattended) reset(); } }); },
    open: async (step) => (step === "browser" ? startEveryApp() : null),
    close: (step) => { if (step === "browser") stopEveryApp(); },
    linux: process.platform === "linux",
    clock: () => Date.now(),
    summary: ["summarize.mjs", round],
    done: () => console.log(now(), "all done"),
  });
} catch (e) {
  console.log(now(), `round failed: ${e instanceof Error ? e.message : e}`);
  if (recordFailure) progress("failed");
  process.exit(1);
}
