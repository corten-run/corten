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
import { cellsOf, format, phases } from "./hardening.mjs";
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
  const run = docker(...args);
  return run.status === 0 ? null : run.stderr.trim();
};

/** Runs one phase in fsw-probe; its JSON, or { error }. */
const phase = (/** @type {Record<string, unknown>} */ input, /** @type {number} */ limitMs) => new Promise((done) => {
  const child = spawn("docker", ["exec", "-i", "fsw-probe", "node", "/b/harden-probe.mjs"]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => child.kill(), limitMs);
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

/** Whether the container is still running, and how often it restarted or was killed for memory. */
const alive = (/** @type {string} */ container) => {
  const s = docker("inspect", "-f", "{{.State.Running}} {{.State.OOMKilled}} {{.RestartCount}}", container).stdout?.trim().split(" ") ?? [];
  return { running: s[0] === "true", oomKilled: s[1] === "true" };
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
const commit = git("rev-parse", "HEAD");
const status = commit === null ? null : git("status", "--porcelain", "--", ".", ":!results");
const dirty = status === null ? null : status !== "";
const file = out ? join(here, "results", out, "hardening.json") : null;
/** @type {Record<string, any>} */
const results = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).results ?? {} : {};
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
    if (failed || !(await up(name))) { o[p.key] = { error: failed ?? "did not answer in 120 s" }; continue; }
    const container = "fsw-" + name;
    const memBefore = memoryNow(container);
    const cpuBefore = cpuUsec(container);
    const stopWatch = watchMemory(container);
    const input = { host: container, port: 8080, phase: p.key, ...p.input, pagePath: pages ? "/items/item_5" : "/api/items/item_5", formPath: pages ? "/items/item_5" : "/api/items/item_5" };
    const r = await phase(input, p.limitMs);
    const memMax = stopWatch();
    const cpuAfter = cpuUsec(container);
    o[p.key] = { ...r, memBeforeMiB: memBefore, memMaxMiB: memMax, cpuSeconds: cpuBefore !== null && cpuAfter !== null ? +((cpuAfter - cpuBefore) / 1e6).toFixed(2) : null, ...alive(container) };
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
