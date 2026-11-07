// How each app holds up against slow clients, oversized requests and connection floods, at its
// tier's settings (the defaults tier: as its framework starts it): not how many requests it
// serves, but whether it survives, what it does with the abusive connections, what a well-behaved
// client sees meanwhile, and what it costs in memory and CPU. Each phase (hardening.mjs, sent by
// harden-probe.mjs from fsw-probe on the bench network, as conform.mjs's probes are) runs against
// a freshly started app, so one phase's harm is not read as the next one's.
// Usage: node harden.mjs [apps|all] [round] [phases]   (writes results/<round>/hardening.json when
// given; phases, comma separated, runs only those and keeps the round's other results)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCpus, network, pageApps, runArgs, tier, tierApps as all } from "./apps.mjs";
import { cpuUsec } from "./cpu-time.mjs";
import { cellsOf, format, keptFrom, phases, replacing } from "./hardening.mjs";
import { roundNameError } from "./round.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [appsArg, out, phasesArg] = process.argv.slice(2);
const run = phasesArg ? phasesArg.split(",").map((key) => phases.find((p) => p.key === key) ?? (() => { throw new Error("unknown phase " + key + ": " + phases.map((p) => p.key).join(", ")); })()) : phases;
if (out && roundNameError(out, tier)) throw new Error(/** @type {string} */ (roundNameError(out, tier)));
const names = appsArg && appsArg !== "all" ? appsArg.split(",") : Object.keys(all);
for (const n of names) if (!(n in all)) throw new Error("unknown app " + n);
const docker = (/** @type {string[]} */ ...args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Starts the app, unpublished, reading items from fsw-items; the error, if any. */
const start = (/** @type {string} */ name) => {
  docker("rm", "-f", "fsw-" + name);
  const args = runArgs(name, all[/** @type {keyof typeof all} */ (name)], "api", join(here, "fixtures"));
  const publish = args.indexOf("-p");
  if (publish < 0) throw new Error("runArgs no longer publishes a port");
  args.splice(publish, 2);
  const i = args.findIndex((a) => a.startsWith("API_BASE="));
  if (i < 0) throw new Error("runArgs no longer sets API_BASE");
  args[i] = "API_BASE=http://fsw-items:8080";
  // card-market lets one client 20 writes a minute (WRITES_PER_MINUTE), and the probe sends every
  // slow body from one address: raised past the phase's 100, so each body reaches the server's
  // handling of it, not the app's limiter, as in every other app.
  if (name === "corten") args.splice(args.length - 1, 0, "-e", "WRITES_PER_MINUTE=1000");
  const run = docker(...args);
  return run.status === 0 ? null : run.stderr.trim();
};

/**
 * Runs one phase in fsw-probe; its JSON, or { error }. The probe is killed inside the container at
 * the limit (busybox's timeout), so none of its connections or its well-behaved client reach the
 * next phase's app, which has the same name.
 */
const phase = (/** @type {Record<string, unknown>} */ input, /** @type {number} */ limitMs) => new Promise((done) => {
  const child = spawn("docker", ["exec", "-i", "fsw-probe", "timeout", "-s", "KILL", String(Math.ceil(limitMs / 1000)), "node", "/b/harden-probe.mjs"]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => child.kill(), limitMs + 10_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return done({ error: "probe failed: " + (stderr || "exit " + code).trim().slice(0, 300) });
    try { done(JSON.parse(stdout)); } catch { done({ error: "probe answered no JSON: " + stdout.slice(0, 200) }); }
  });
  child.stdin.end(JSON.stringify(input));
});

/** Streams the container's memory (docker stats) until stopped; the largest sample, in MiB. */
const watchMemory = (/** @type {string} */ container) => {
  const child = spawn("docker", ["stats", "--format", "{{.MemUsage}}", container]);
  let max = 0;
  let buffer = "";
  child.stdout.on("data", (c) => {
    buffer += c.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "\n");
    for (const line of buffer.split("\n").slice(0, -1)) {
      const m = /([\d.]+)\s*([KMG]i?B)/.exec(line);
      if (m) max = Math.max(max, Number(m[1]) * ({ KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]] ?? NaN));
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  });
  return () => { child.kill(); return max ? +max.toFixed(1) : null; };
};

/** The container's memory now, in MiB, or null. */
const memoryNow = (/** @type {string} */ container) => {
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(docker("stats", "--no-stream", "--format", "{{.MemUsage}}", container).stdout ?? "");
  return m ? +(Number(m[1]) * ({ KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]] ?? NaN)).toFixed(1) : null;
};

/** Whether the container is still running or was killed for memory; when it stopped, its exit code and last log lines. */
const alive = (/** @type {string} */ container) => {
  const s = docker("inspect", "-f", "{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}", container).stdout?.trim().split(" ") ?? [];
  const running = s[0] === "true";
  if (running) return { running, oomKilled: s[1] === "true" };
  const logs = docker("logs", "--tail", "5", container);
  return { running, oomKilled: s[1] === "true", exitCode: Number(s[2]), logTail: (logs.stdout + logs.stderr).trim().split("\n").slice(-5) };
};

/** Waits until the app answers the item as JSON, up to two minutes. */
const up = async (/** @type {string} */ name) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const r = docker("exec", "fsw-probe", "node", "-e", `fetch("http://fsw-${name}:8080/api/items/item_5",{headers:{host:"localhost"}}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))`);
    if (r.status === 0) return true;
    await sleep(250);
  }
  return false;
};

const started = new Set(["items", "probe"]);
process.on("exit", () => { for (const n of started) docker("rm", "-f", "fsw-" + n); });
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(/** @type {NodeJS.Signals} */ (signal), () => process.exit(/** @type {number} */ (code)));
docker("network", "create", network);
docker("rm", "-f", "fsw-items");
const items = docker("run", "-d", "--name", "fsw-items", "--network", network, ...loadCpus, "-v", here + ":/b:ro", "node:24-bookworm-slim", "node", "/b/conform-items.mjs", "/b/fixtures/items.json");
if (items.status !== 0) throw new Error("fsw-items: " + items.stderr);
docker("rm", "-f", "fsw-probe");
// The probe holds thousands of connections; the apps keep the file limit their image and Docker give them.
const prober = docker("run", "-d", "--name", "fsw-probe", "--network", network, ...loadCpus, "--ulimit", "nofile=65536:65536", "-v", here + ":/b:ro", "node:24-alpine", "sleep", "infinity");
if (prober.status !== 0) throw new Error("fsw-probe: " + prober.stderr);

const git = (/** @type {string[]} */ ...args) => {
  const run = spawnSync("git", args, { cwd: here, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : null;
};
// On a droplet the upload has no .git: the commit the images were built from stands in, as
// droplet.mjs passes it (CONFORM_IMAGES_FROM, "<commit>" or "<commit>-dirty").
const head = git("rev-parse", "HEAD");
const built = /^([0-9a-f]+)(-dirty)?$/.exec(process.env.CONFORM_IMAGES_FROM ?? "");
const commit = head ?? built?.[1] ?? null;
// The whole repository, as droplet.mjs checks it: the images are built from more than this folder.
const status = head === null ? null : git("status", "--porcelain", "--", ":(top)", ":(top,exclude)bench/fullstack/results");
const dirty = status !== null ? status !== "" : built ? built[2] !== undefined : null;
const file = out ? join(here, "results", out, "hardening.json") : null;
const previous = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
/** @type {Record<string, any>} */
const results = previous ? keptFrom(previous.results ?? {}, previous) : {};
const save = () => {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ format, tier, commit, dirty, imagesFrom: process.env.CONFORM_IMAGES_FROM ?? null, date: new Date().toISOString(), results }, null, 2) + "\n");
};

for (const name of names) {
  const pages = name in pageApps;
  /** @type {Record<string, any>} */
  const o = { ...results[name]?.probes };
  started.add(name);
  for (const p of run) {
    const failed = start(name);
    if (failed || !(await up(name))) { o[p.key] = replacing(o[p.key], { error: failed ?? "did not answer in 120 s", taken: { commit, dirty, date: new Date().toISOString() } }); continue; }
    const container = "fsw-" + name;
    const memBefore = memoryNow(container);
    const cpuBefore = cpuUsec(container);
    const stopWatch = watchMemory(container);
    const input = { host: container, port: 8080, phase: p.key, ...p.input, pagePath: pages ? "/items/item_5" : "/api/items/item_5", formPath: pages ? "/items/item_5" : "/api/items/item_5" };
    const from = Date.now();
    const r = await phase(input, p.limitMs);
    const wallMs = Date.now() - from;
    const memMax = stopWatch();
    const cpuAfter = cpuUsec(container);
    // Each phase keeps the commit and time it was taken at (a rerun of some phases rewrites the
    // file's own), and a phase run again keeps the result it replaces in `earlier`.
    o[p.key] = replacing(o[p.key], { ...r, taken: { commit, dirty, date: new Date().toISOString() }, wallMs, memBeforeMiB: memBefore, memMaxMiB: memMax, cpuSeconds: cpuBefore !== null && cpuAfter !== null ? +((cpuAfter - cpuBefore) / 1e6).toFixed(2) : null, ...alive(container) });
    console.error(`${name} ${p.key}: ${JSON.stringify(cellsOf({ [p.key]: o[p.key] })[p.key])}`);
  }
  docker("rm", "-f", "fsw-" + name);
  started.delete(name);
  results[name] = { probes: o, cells: cellsOf(o) };
  save();
}

const header = ["app", ...phases.map((p) => p.label)];
const lines = ["| " + header.join(" | ") + " |", "|" + header.map(() => "---").join("|") + "|"];
for (const name of names) lines.push("| " + [name, ...phases.map((p) => results[name]?.cells?.[p.key] ?? "?")].join(" | ") + " |");
console.log(lines.join("\n"));
// A run where a phase failed to run, or that wrote nothing it was asked to, is not a finished one.
const failed = names.flatMap((n) => run.filter((p) => results[n]?.probes?.[p.key]?.error).map((p) => `${n} ${p.key}`));
if (failed.length) console.error("phases that did not run: " + failed.join(", "));
if (failed.length || (file && !existsSync(file))) process.exitCode = 1;
