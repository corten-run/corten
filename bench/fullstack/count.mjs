// Counters per request: each app's container (items from memory), warmed up, then exactly
// ITERATIONS requests while one `perf stat` counts its user instructions, user and kernel cycles
// and user L1 instruction-cache misses, then ITERATIONS more while another counts its kernel
// instructions alone: no perf session counts user and kernel instructions together, which stops a
// Xeon Platinum 8358 guest (#2151). All counts require a reported 100% running percentage.
// Unusable optional counts are null with a diagnostic; if user instructions are unusable with
// optional events enabled, the first load is repeated with them alone unless it had failures.
// Each load runs while its perf is watched: perf starts with its events disabled, the load starts
// only once perf has acknowledged enabling them, and perf must still be running and acknowledge
// disabling them once the load has ended, or the pass did not count the whole load (#2183).
// Before any load each event set is probed on the count's CPUs within a bound (PROBE_SETS). A perf,
// probe or count, whose end is not seen stops the step with exit HALT_EXIT and counts nothing more
// on the host: it may still be counting, or stuck in the kernel. That exit stands whatever its
// diagnostics' writes or teardown do (halt).
// Alternate one-repeat runs of the builds on a quiet host to compare cycles, which are noisier
// than instructions.
// Needs Linux with hardware counters (`perf`, root, cgroup v2): a bench host, not Docker Desktop.
// Usage: node count.mjs <round> [repeats=3] [apps=all] [targets=page,json] [fixture|api]
//   api: items fetched from the item API (BENCH_API_CONTAINER), so the count includes fetching and
//   parsing its ~55 KB response; results are keyed <app>/<target>/api.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apps as catalog, countCpus, k6Net, k6User, loadCpus, network, runArgs, tier } from "./apps.mjs";
import { ACK_FD, ACK_MS, CONTROL_FD, GRACE_MS, HALT_EXIT, measurePerfCounts, PROBE_MS, PROBE_SETS, passEvents, perfCountArgs, perfProbeArgs, probeVerdict, runBounded, UnconfirmedPerf } from "./count-perf.mjs";
import { roundNameError } from "./round.mjs";
import { k6Image, recordLoadTool } from "./load-tool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [round = "r1", repeats = "3", appsArg = Object.keys(catalog).join(","), targetsArg = "page,json", source = "fixture"] = process.argv.slice(2);
if (!["fixture", "api"].includes(source)) throw new Error("source is fixture or api");
const targets = targetsArg.split(",");
for (const target of targets) {
  if (target !== "page" && target !== "json") throw new Error(`unknown target ${JSON.stringify(target)}; expected page or json`);
}
// The matched tier's numbers never go into an r<n> round, nor the defaults' into an m<n> one.
if (roundNameError(round, tier)) throw new Error(/** @type {string} */ (roundNameError(round, tier)));
const suffix = source === "api" ? "/api" : "";
const ITERATIONS = 5000;
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = join(here, "results", round);
mkdirSync(dir, { recursive: true });
await recordLoadTool(dir);

/**
 * Exits HALT_EXIT, a perf not seen to end, after `diagnose` has written what it can: a write or
 * teardown that fails in it is reported, and the exit is still HALT_EXIT, never an ordinary failure
 * that count-pairs.mjs or run-all.mjs would go on past.
 * @param {() => void} diagnose
 * @returns {never}
 */
function halt(diagnose) {
  try {
    diagnose();
  } catch (e) {
    try { console.error(`the halt's diagnostics were not all written: ${e instanceof Error ? e.message : e}`); } catch {}
  } finally {
    process.exit(HALT_EXIT);
  }
}

/** One k6 load, run to its end without blocking, so a count's perf is watched while it runs. */
function k6(base, target, envs, summary) {
  const args = ["run", "--rm", "--network", network, ...k6Net, ...loadCpus, ...k6User, "-v", `${here}:/bench`, "-e", `BASE=${base}`, "-e", `TARGET=${target}`];
  for (const [k, v] of Object.entries(envs)) args.push("-e", `${k}=${v}`);
  args.push(k6Image, "run", "--quiet", "--summary-export", `/bench/${summary}`, "/bench/ssr-load.js");
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    child.stderr.on("data", (d) => (said += d));
    child.on("error", reject);
    child.on("close", (code, signal) => (code === 0 ? resolve(undefined) : reject(new Error(said || `the load's docker run exited ${code ?? signal}`))));
  });
}

/**
 * Why the load may not reach the container with this ID, or null. k6 reaches the app by the name
 * `answer` on the load's network, and Docker's DNS answers that name for every running container
 * there that has it as its name or an alias (a leftover one included), so this ID must be the only
 * one. Docker keys a container's endpoints by the network's name, which `network` (BENCH_NETWORK)
 * may give as an ID, so they are read by the name the network inspect gives; and its DNS answers a
 * name in any case, so `FSW-CORTEN` is that name too. A container that joins and leaves between
 * two checks is not seen (README, the count's host).
 */
function answersError(id, answer) {
  const net = docker("network", "inspect", "-f", "{{json .Name}} {{json .Containers}}", network);
  let members = null, canonical = null;
  try {
    const n = /^("[^"]*") (.*)$/.exec((net.stdout ?? "").trim());
    canonical = n && JSON.parse(n[1]);
    members = n && Object.keys(JSON.parse(n[2]) ?? {});
  } catch {}
  if (net.status !== 0 || !members || !canonical) return `cannot list the containers on ${network}, so where the load goes is not known`;
  const seen = members.length ? docker("inspect", "-f", "{{.Id}} {{json .Name}} {{json .NetworkSettings.Networks}}", ...members) : { status: 0, stdout: "" };
  if (seen.status !== 0) return `cannot inspect the containers on ${network}, so where the load goes is not known`;
  const answering = [];
  for (const line of (seen.stdout ?? "").split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) ("[^"]*") (.*)$/.exec(line);
    let names = null;
    try {
      const at = m && JSON.parse(m[3])?.[canonical];
      names = m && [JSON.parse(m[2]).replace(/^\//, ""), ...(at?.Aliases ?? []), ...(at?.DNSNames ?? [])];
    } catch {}
    if (!m || !names) return `cannot read a container on ${network}, so where the load goes is not known`;
    if (names.some((n) => typeof n === "string" && n.toLowerCase() === answer.toLowerCase())) answering.push(m[1]);
  }
  if (answering.length !== 1 || answering[0] !== id) return `${answer} on ${network} answers for ${answering.length} running containers where it must answer for the counted one alone, so the load may reach another`;
  return null;
}

/**
 * Counts events in the cgroup of the container `docker run` gave this ID over `work`, the load: by
 * its ID, since the name can be another container's by then. `name` is what the log calls it,
 * `events` what perf counts. perf starts with its events disabled, and the load starts only once
 * perf has acknowledged `enable` on its control descriptor; once the load has ended perf must not
 * have exited and must acknowledge `disable` before it is asked to stop. One that does not
 * acknowledge `enable` runs no load (`ranLoad` false); one that ends before its load did, or does
 * not acknowledge `disable`, did not count the whole load (#2183). A load is never taken as counted
 * on a wait or on a signal that was delivered.
 */
async function counted(id, name, work, events) {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`docker run gave ${JSON.stringify(id)}, not a container ID`);
  const cgroup = `system.slice/docker-${id}.scope`;
  // Timed lines in the round's log: when a step hangs the machine (#466), the log says whether
  // `perf` attached to the cgroup with no load yet or the load had started.
  console.log(new Date().toISOString(), "perf stat", countCpus.join(" "), "-e", events.join(","), "-G", id);
  const perf = spawn("perf", perfCountArgs(countCpus, cgroup, events), { env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  let text = "";
  let said = "";
  let spawnError;
  perf.stdout?.on("data", (d) => (text += d));
  perf.stderr?.on("data", (d) => (said += d));
  perf.on("error", (error) => { spawnError = error.message; });
  // perf's control descriptor, and the acknowledgments it writes back: an "ack" line a command,
  // which perf follows with a NUL byte (perf 6.1 writes "ack\n\0").
  const control = /** @type {import("node:stream").Writable} */ (perf.stdio[CONTROL_FD]);
  const acks = /** @type {import("node:stream").Readable} */ (perf.stdio[ACK_FD]);
  control.on("error", () => {});
  acks.on("error", () => {});
  let acked = 0;
  let partial = "";
  /** @type {Set<() => void>} */
  const listening = new Set();
  acks.on("data", (d) => {
    partial += d;
    for (let at; (at = partial.indexOf("\n")) >= 0; partial = partial.slice(at + 1)) if (partial.slice(0, at).replaceAll("\0", "").trim() === "ack") acked += 1;
    for (const heard of listening) heard();
  });
  // Reaped: once it is, perf is never signalled, its process ID may be another's.
  let reaped = false;
  perf.on("exit", () => { reaped = true; });
  const closed = new Promise((resolve) => perf.on("close", (code, signal) => resolve({ code, signal })));
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exit = null;
  closed.then((e) => (exit = /** @type {any} */ (e)));
  // Whether perf exits within ms; the timer is cleared when it does, so none outlives the count.
  const within = (/** @type {number} */ ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    closed.then(() => { clearTimeout(timer); resolve(true); });
  });
  // Whether perf acknowledges its nth command within ACK_MS: "ack", "closed" (it ended first) or "timeout".
  const acknowledged = (/** @type {number} */ n) => /** @type {Promise<"ack" | "closed" | "timeout">} */ (new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const settle = (/** @type {"ack" | "closed" | "timeout"} */ r) => { clearTimeout(timer); listening.delete(check); resolve(r); };
    const check = () => { if (acked >= n) settle("ack"); };
    timer = setTimeout(() => settle("timeout"), ACK_MS);
    listening.add(check);
    closed.then(() => settle(acked >= n ? "ack" : "closed"));
    check();
  }));
  control.write("enable\n");
  const enabled = await acknowledged(1);
  const ready = enabled === "ack" && !reaped && exit === null;
  /** Why perf did not count the whole load, or null. @type {string | null} */
  let why = null;
  let hung = false;
  // perf stops however the work ends, so a failed run leaves no counter on a removed cgroup. One
  // that does not exit once asked, nor once killed, is given up as no answer rather than waited
  // out, and is unconfirmed: it may still count, so the count stops and nothing more is counted.
  try {
    if (ready) {
      console.log(new Date().toISOString(), "counting", name);
      await work();
    }
  } finally {
    if (!ready) why = enabled === "ack" ? "perf ended before its load started" : enabled === "closed" ? "perf ended before it acknowledged enable, so no load ran" : `perf did not acknowledge enable within ${ACK_MS / 1000} s, so no load ran`;
    else if (reaped || exit !== null) why = "perf ended before its load did";
    else {
      control.write("disable\n");
      const disabled = await acknowledged(2);
      if (disabled !== "ack") why = disabled === "closed" ? "perf ended before it acknowledged disable at the load's end" : `perf did not acknowledge disable at the load's end within ${ACK_MS / 1000} s`;
    }
    if (!reaped) perf.kill("SIGINT");
    if (!(await within(PROBE_MS))) {
      if (!reaped) perf.kill("SIGKILL");
      if (!(await within(GRACE_MS))) {
        hung = true;
        perf.unref();
        for (const stream of perf.stdio) stream?.destroy();
      }
    }
    // However the work ended (a failed load included), a perf not seen to end stops the count and the host's counting.
    if (hung) throw new UnconfirmedPerf(`perf did not count the full load: no answer, it had not exited ${PROBE_MS / 1000} s after it was asked to stop nor ${GRACE_MS / 1000} s after it was killed; no further count runs on this host`);
  }
  const { code, signal } = exit ?? { code: null, signal: null };
  const reason = why ?? (code !== 0 && signal !== "SIGINT" ? `perf exited ${signal ?? code}` : null);
  // What perf said, less its own notes that events were enabled and disabled.
  const told = [spawnError, ...said.split("\n").map((l) => l.trim()).filter((l) => l && !/^Events (?:en|dis)abled$/.test(l))].filter(Boolean).join("; ");
  const error = reason ? `perf did not count the full load: ${reason}${told ? `; perf said: ${told}` : ""}` : null;
  return { text, error, ranLoad: ready };
}

// Before any load: the kernel and CPU this runs on, and `perf` counting an idle second on the
// count's CPUs with each event set a count gives it (PROBE_SETS), one at a time, each within a
// bound, so a `perf` that does not fit the running kernel, cannot count a set or does not answer
// stops the step here with the reason. Each set is written to count-kernel.txt before it runs, so
// a host that stops as one runs leaves its name (#2151); a stopped host cannot refuse, and is the
// watcher's to notice (droplet.mjs). r8's droplet locked up as counting started (#466); this probe
// has no `-G`, so it would not have caught that, but the round's log says how far counting got.
const kernel = spawnSync("uname", ["-r"], { encoding: "utf8" }).stdout.trim();
const cpu = existsSync("/proc/cpuinfo") ? /^model name\s*:\s*(.+)$/m.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1]?.trim() ?? "unknown" : "unknown";
const waiting = existsSync("/var/run/reboot-required.pkgs") ? readFileSync("/var/run/reboot-required.pkgs", "utf8").trim().split("\n").join(", ") : "";
const pending = waiting ? ` (installed, waiting for a reboot: ${waiting})` : "";
const kernelFile = join(dir, "count-kernel.txt");
writeFileSync(kernelFile, `${kernel}${pending}\ncounting with perf stat ${countCpus.join(" ")}\ncpu ${cpu}\n`);
console.log(`counting on kernel ${kernel}${pending}, cpu ${cpu}, perf stat ${countCpus.join(" ")}`);
for (const names of PROBE_SETS) {
  const line = `${new Date().toISOString()} probing perf stat ${countCpus.join(" ")} -e ${names.join(",")}`;
  appendFileSync(kernelFile, `${line}\n`);
  console.log(line);
  const probe = await runBounded("perf", perfProbeArgs(countCpus, names), { env: { ...process.env, LC_ALL: "C" } });
  const { refuse, note } = probeVerdict(names, probe);
  // A probe whose end was not seen stops the step before anything else is written: its record
  // is the halt's to write, and a write that fails does not turn the halt into another exit.
  if (probe.cleanup !== "confirmed") halt(() => {
    appendFileSync(kernelFile, `${new Date().toISOString()} refused: ${refuse ?? probe.error ?? "cleanup unconfirmed"}\n`);
    appendFileSync(kernelFile, `${new Date().toISOString()} stopped: the probe's perf was not seen to end, so nothing more is counted on this host\n`);
    console.error(`perf cannot count on kernel ${kernel} (${cpu}): ${refuse}; the probe's perf was not seen to end, so nothing more is counted on this host`);
  });
  appendFileSync(kernelFile, `${new Date().toISOString()} ${refuse ? `refused: ${refuse}` : note ? `not counted: ${note}` : "counted"}\n`);
  if (note) console.warn(`probe: ${note}`);
  if (refuse) throw new Error(`perf cannot count on kernel ${kernel} (${cpu}): ${refuse}`);
}

// Merged into the round's earlier counts, so one app can be counted again on its own.
const file = join(dir, "instructions.json");
const results = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
// The image each counted container was started from, by ID, read before its warmup: which build
// was counted, whatever its tag names now (count-pairs.mjs checks it against the side's).
const imagesFile = join(dir, "count-images.json");
const images = existsSync(imagesFile) ? JSON.parse(readFileSync(imagesFile, "utf8")) : {};
for (const name of appsArg.split(",")) {
  if (!catalog[name]) throw new Error(`unknown app ${name}`);
  for (const target of targets) {
    // A JSON-only app has no page to count.
    if (target === "page" && catalog[name].pages === false) continue;
    docker("rm", "-f", `fsw-${name}`);
    const run = docker(...runArgs(name, catalog[name], source, join(here, "fixtures")));
    if (run.status !== 0) {
      const why = `docker run failed (${run.status}): ${(run.stderr ?? run.error?.message ?? "").trim().split("\n")[0]}`;
      console.log(name, target, why);
      docker("rm", "-f", `fsw-${name}`);
      results[`${name}/${target}${suffix}`] = { failed: why };
      writeFileSync(file, JSON.stringify(results, null, 1));
      continue;
    }
    const container = run.stdout.trim();
    images[`${name}/${target}${suffix}`] = { container, image: docker("inspect", "-f", "{{.Image}}", container).stdout?.trim() ?? "" };
    writeFileSync(imagesFile, JSON.stringify(images, null, 1));
    const path = target === "json" ? "/api/items/item_1" : "/items/item_1";
    let up = false;
    for (let i = 0; i < 2400 && !up; i += 1) {
      try { up = (await fetch(`http://localhost:${catalog[name].port}${path}`)).ok; } catch {}
      if (!up) await sleep(25);
    }
    // Not tuned to fit: an app that does not start with its usual settings is recorded as failed.
    if (!up) {
      console.log(name, target, "failed: never answered");
      results[`${name}/${target}${suffix}`] = { failed: `never answered ${path} within a minute` };
      docker("rm", "-f", container);
      continue;
    }
    const base = `http://fsw-${name}:8080`;
    // One app that cannot be counted is recorded as failed, and the others are still counted.
    try {
      // Warm up: JIT compilers, connection pools and lazily created threads settle first.
      await k6(base, target, { MODE: "closed", VUS: "16", DURATION: "30s" }, `results/${round}/count-warmup.json`);
      const runs = [];
      for (let r = 0; r < Number(repeats); r += 1) {
        const stem = `results/${round}/count-${name}-${target}${suffix.replace("/", "-")}-${r}`;
        const row = await measurePerfCounts(
          async (pass, instructionsOnly) => {
            const summary = `${stem}${pass === "kernel" ? "-kernel" : ""}${instructionsOnly ? "-instructions-only" : ""}.json`;
            const summaryFile = join(here, summary);
            rmSync(summaryFile, { force: true });
            // k6 reaches the app by its name, so the load is the counted container's only if that
            // name answers for it alone on the network, before perf attaches and once it stops.
            const before = answersError(container, `fsw-${name}`);
            if (before) throw new Error(`before the load: ${before}`);
            const perf = await counted(container, `fsw-${name}`, () => k6(base, target, { MODE: "iterations", VUS: "4", ITERATIONS: String(ITERATIONS) }, summary), passEvents(pass, instructionsOnly));
            const after = answersError(container, `fsw-${name}`);
            if (after) throw new Error(`after the load: ${after}`);
            return { ...perf, summary: perf.ranLoad ? JSON.parse(readFileSync(summaryFile, "utf8")) : undefined };
          },
          (message) => console.warn(name, target + suffix, message),
          { requests: ITERATIONS },
        );
        runs.push(row);
        console.log(name, target + suffix, JSON.stringify(row));
      }
      results[`${name}/${target}${suffix}`] = runs;
    } catch (e) {
      // A perf not seen to end may still count, or be stuck in the kernel: no further load or count
      // on this host. The halt comes first, so nothing written here can change its exit.
      if (e instanceof UnconfirmedPerf) halt(() => {
        const why = e.message.trim().split("\n")[0] || "perf was not seen to end";
        results[`${name}/${target}${suffix}`] = { failed: why };
        console.error(`${name} ${target}${suffix}: ${why}`);
        docker("rm", "-f", container);
        writeFileSync(file, JSON.stringify(results, null, 1));
      });
      // One line, never empty: summarize.mjs prints it in a table and reads an empty one as a count.
      const why = (e instanceof Error ? e.message : String(e)).trim().split("\n")[0] || "the count failed with no message";
      console.log(name, target + suffix, "failed:", why);
      results[`${name}/${target}${suffix}`] = { failed: why };
    }
    docker("rm", "-f", container);
    // Written after each app, so a restart partway through the step keeps the apps already counted.
    writeFileSync(file, JSON.stringify(results, null, 1));
  }
}
writeFileSync(file, JSON.stringify(results, null, 1));
console.log("done");
