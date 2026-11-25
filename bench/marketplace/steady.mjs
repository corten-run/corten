// Convergence and soak passes for marketplace v2 (#1851), separate from the timed rounds: this
// runner changes no timed phase, warmup, rate, droplet job or saved round. Each adapter, source and
// target gets a fresh container, started as run.mjs starts it, a readiness request and then one
// long k6 pass (window-load.js) whose answers are counted per window.
//   convergence: a closed loop (64 users, 5 minutes in 15 s windows by default); the flatten rule
//                in steady-contract.mjs names the window each adapter stopped getting faster in.
//                A pass with a failed request, or whose app stopped, gets no verdict.
//   soak:        a fixed rate (150 requests/second, 30 minutes in 60 s intervals by default), with
//                memory at the start and end, p99 per interval and any restart.
// node bench/marketplace/steady.mjs convergence w3 --group production --build
// node bench/marketplace/steady.mjs soak w4 --group production --admitted-from bench/marketplace/results/w2/summary.json
// Results: bench/marketplace/results/<convergence|soak>/<name>/summary.json; read them with steady-report.mjs.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cpuSettings, imageProvenance, inventory, readLoadSummary } from "./run-contract.mjs";
import { admitted, boundedFeatureProfile, boundedQualificationSettings } from "./feature-contract.mjs";
import { groupApps } from "./groups.mjs";
import { validateSummary } from "./report.mjs";
import { commandRunner } from "../catalog/output.mjs";
import { sampleStats } from "../catalog/stats.mjs";
import { containerReceipt, imageReceipt, nodeImage } from "./raw-contract.mjs";
import { retainLoadEvidence } from "./load-evidence.mjs";
import { describeK6, k6Image } from "../load-tool.mjs";
import { convergenceSchema, flattenPoint, flattenRule, parseSteadyArgs, readWindows, soakSchema, summarizeSoak } from "./steady-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = parseSteadyArgs(process.argv.slice(2), Object.keys(inventory), groupApps);
const convergence = options.kind === "convergence";
const seconds = options.minutes * 60;
const cpus = cpuSettings(process.env);
const runId = `marketplace-${options.kind}-${options.name}-${randomBytes(5).toString("hex")}`;
const network = `${runId}-net`;
const label = "run.corten.marketplace";
const folder = join(here, "results", options.kind, options.name);
mkdirSync(dirname(folder), { recursive: true });
// Atomic reservation: an earlier pass of the same name is never overwritten.
mkdirSync(folder);
const summary = { schema: convergence ? convergenceSchema : soakSchema, name: options.name, runId, options, ...(convergence ? { rule: flattenRule } : {}),
  startedAt: new Date().toISOString(), complete: false, failures: [], cleanupFailures: [], cells: [], admission: null,
  host: { hostname: hostname(), platform: platform(), release: release() },
  scope: convergence ? "marketplace-v2 convergence: one closed-loop pass per adapter, source and target, throughput and latency per window; not a timed round or a comparison"
    : "marketplace-v2 soak: one fixed-rate pass per adapter, source and target, memory at start and end, p99 per interval and restarts; not a timed round or a comparison",
  measurement: { cpus, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, encoding: "identity",
    clock: "windows are the k6 engine's clock from the start of the test; a request counts in the window its answer completed in",
    ...(convergence ? {} : { memoryClock: "docker stats sample times from the load container's StartedAt; start and end memory are medians of the samples in the first and last interval" }) } };
const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
const log = (message) => { const line = `${new Date().toISOString()} ${message}`; console.log(line); appendFileSync(join(folder, "run.log"), `${line}\n`); };
const retain = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const active = new Set();
const created = [], removed = [];
let interrupted = false;
const { command, interrupt } = commandRunner({ cwd: repo, interrupted: () => interrupted, interruptMessage: `marketplace ${options.kind} pass interrupted` });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; interrupt(); });
const docker = (args, opts) => command("docker", args, opts);
const inspect = async (name, cleanup = false) => JSON.parse(await docker(["inspect", name], { cleanup }))[0];
const owned = async (args, name) => {
  active.add(name);
  await docker([args[0], "--name", name, "--label", `${label}=${runId}`, ...args.slice(1)]);
  const info = await inspect(name);
  created.push({ kind: "container", id: info.Id, name });
  for (const m of info.Mounts.filter((m) => m.Type === "volume")) {
    assert.match(m.Name, /^[a-f0-9]{64}$/);
    created.push({ kind: "volume", id: m.Name, name: m.Name });
  }
  return name;
};
async function remove(name) {
  const list = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], { cleanup: true });
  if (list) {
    const info = await inspect(name, true);
    assert.equal(info.Config.Labels?.[label], runId, `refusing cleanup of unowned ${name}`);
    assert.equal(await docker(["rm", "-f", "-v", info.Id], { cleanup: true }), info.Id);
    removed.push({ kind: "container", id: info.Id, name });
    for (const m of info.Mounts.filter((m) => m.Type === "volume")) {
      assert.equal(await docker(["volume", "ls", "--filter", `name=^${m.Name}$`, "--format", "{{.Name}}"], { cleanup: true }), "", "anonymous volume survived container cleanup");
      removed.push({ kind: "volume", id: m.Name, name: m.Name });
    }
  }
  active.delete(name);
}
async function portOf(name) {
  const info = await inspect(name);
  const port = info.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
  assert.ok(port, `${name}: no private host port`);
  return `http://127.0.0.1:${port}`;
}
const fixtureDir = join(here, "fixtures");
const mount = ["-v", `${join(repo, "bench")}:/bench:ro`];
const upstreamName = `${runId}-upstream`;
const apiBase = `http://${upstreamName}:8080`;
// The container run.mjs starts for a timed round (appArgs there), so a pass measures the same app.
function appArgs(name, source, image) {
  return ["--network", network, ...cpus.app.args, "--memory", "1g", "-p", "127.0.0.1::8080",
    "-v", `${fixtureDir}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
    "-e", `API_BASE=${apiBase}`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`,
    ...(options.group ? ["--ulimit", "nofile=65536:65536", "-e", `PROFILE=${boundedQualificationSettings.nativeProfile}`, "-e", `MAX_CONNECTIONS=${boundedQualificationSettings.maxConnections}`] : []), image];
}
async function ready(base) {
  const deadline = Date.now() + options.startupTimeout * 1000;
  let last = "no response";
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("interrupted");
    try {
      const response = await fetch(`${base}/marketplace/en-US/item_1`, { redirect: "manual", signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(`not ready in ${options.startupTimeout}s: ${last}`);
}
const state = (info) => ({ restartCount: info.RestartCount, running: info.State.Running, oomKilled: info.State.OOMKilled, exitCode: info.State.ExitCode });
// One adapter, source and target: a fresh container, readiness, one long k6 pass.
async function pass(cell, imageId, raw) {
  const name = `${runId}-${cell.app}`, k6 = `${runId}-k6`;
  let sampler;
  try {
    await owned(["run", "-d", ...appArgs(name, cell.source, imageId)], name);
    await ready(await portOf(name));
    const before = await inspect(name);
    retain(join(raw, "app-container.json"), containerReceipt(before));
    const env = ["-e", `BASE=http://${name}:8080`, "-e", `TARGET=${cell.target}`, ...(cell.target === "page" ? ["-e", "LOCALE=rotating"] : []),
      "-e", `MODE=${convergence ? "closed" : "fixed"}`, "-e", `WINDOWS=${options.windows}`, "-e", `WINDOW_SECONDS=${options.windowSeconds}`,
      ...(convergence ? ["-e", `VUS=${options.vus}`] : ["-e", `RATE=${options.rate}`])];
    await owned(["create", "--network", network, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount, ...env,
      k6Image, "run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/window-load.js"], k6);
    const phaseStartMs = Date.now();
    if (!convergence) sampler = sampleStats([name], join(raw, "stats.log"), seconds + 120);
    await docker(["start", "-a", k6], { timeout: (seconds + 60) * 1000, file: join(raw, "load.log") });
    const stats = sampler; sampler = undefined;
    let statsError;
    if (stats) { try { await stats.stop(); } catch (e) { statsError = e; } }
    const loadInfo = await inspect(k6);
    retain(join(raw, "load-container.json"), containerReceipt(loadInfo));
    assert.equal(loadInfo.State.ExitCode, 0, "k6 exited with an error");
    const k6Summary = await retainLoadEvidence(docker, k6, raw, "load");
    readLoadSummary(k6Summary);
    const { windows, tail, unrecorded } = readWindows(k6Summary, options);
    const after = await inspect(name);
    retain(join(raw, "app-container-after.json"), containerReceipt(after));
    if (convergence) {
      // A failed answer can be faster than a served one, so throughput with failures says nothing about
      // warming: such a cell gets no verdict. Its windows stay in load.json.
      assert.ok(after.State.Running && after.RestartCount === before.RestartCount, `app container stopped or restarted during the pass: ${JSON.stringify(state(after))}`);
      const failed = windows.reduce((sum, w) => sum + w.failed, 0);
      assert.equal(failed, 0, `${failed} requests failed during the pass; no verdict`);
      return Object.assign(cell, { windows, tail, unrecorded, verdict: flattenPoint(windows) });
    }
    if (statsError) throw new Error(`memory samples failed: ${statsError.message}; container ${JSON.stringify(state(after))}`);
    const startedMs = Date.parse(loadInfo.State.StartedAt);
    const samples = JSON.parse(readFileSync(join(raw, "stats.log.json"), "utf8")).samples[name].map((s) => ({ atSeconds: (s.t - startedMs) / 1000, mib: s.mem }));
    const lines = await docker(["events", "--since", String(phaseStartMs / 1000), "--until", String(Date.now() / 1000), "--filter", "type=container", "--filter", `container=${name}`, "--format", "{{.Action}}|{{.TimeNano}}"]);
    const events = lines.split("\n").filter(Boolean).map((line) => ({ action: line.slice(0, line.lastIndexOf("|")), atSeconds: (Number(line.slice(line.lastIndexOf("|") + 1)) / 1e6 - startedMs) / 1000 }));
    retain(join(raw, "events.json"), events);
    return Object.assign(cell, summarizeSoak({ windows, tail, unrecorded, memory: samples, before: state(before), after: state(after), events }));
  } finally {
    if (sampler) { try { await sampler.stop(); } catch {} }
    try { writeFileSync(join(raw, "app.log"), await docker(["logs", name])); } catch (e) { log(`${cell.app} ${cell.source} ${cell.target}: app log unavailable: ${e.message}`); }
    await remove(k6);
    await remove(name);
  }
}

try {
  save();
  summary.commit = await command("git", ["rev-parse", "HEAD"]);
  summary.dirty = (await command("git", ["status", "--porcelain", "--untracked-files=normal"])).length > 0;
  assert.ok(!summary.dirty, "a convergence or soak pass requires a clean committed checkout");
  summary.host.docker = await docker(["version", "--format", "{{.Server.Version}}"]);
  summary.host.node = process.version;
  const hostProbe = `${runId}-host`;
  let hostText;
  try {
    await owned(["create", "--network", "none", nodeImage, "sh", "-c", "uname -a; grep -m1 'model name' /proc/cpuinfo; cat /sys/devices/system/cpu/online"], hostProbe);
    hostText = await docker(["start", "-a", hostProbe]);
  } finally { await remove(hostProbe); }
  writeFileSync(join(folder, "host.txt"), hostText + "\n");
  summary.host.cpu = hostText.split("\n").find((line) => line.startsWith("model name"))?.split(":").slice(1).join(":").trim() ?? null;
  summary.host.onlineCpus = hostText.trim().split("\n").at(-1).trim();
  if (options.admittedFrom) {
    // Only the adapters a saved timed round admitted: its feature qualification decides, not this pass.
    const bytes = readFileSync(options.admittedFrom);
    const round = validateSummary(JSON.parse(bytes));
    const admittedApps = Object.keys(round.apps).filter((a) => !round.options.group || admitted(round.apps[a]));
    summary.admission = { round: round.round, commit: round.commit, summarySha256: createHash("sha256").update(bytes).digest("hex"), path: relative(repo, options.admittedFrom).replaceAll("\\", "/"), selected: options.apps, admitted: admittedApps };
    options.apps = options.apps.filter((a) => admittedApps.includes(a));
    assert.ok(options.apps.length > 0, "no selected adapter was admitted by that round");
  }
  const images = {};
  for (const app of options.apps) {
    const image = `cb-marketplace-${options.group ? "production-" : ""}${app}`;
    if (options.build) {
      log(`building ${app}`);
      const context = app === "corten" ? repo : join(repo, "bench/fullstack/apps", app);
      const dockerfile = app === "corten" ? join(here, "corten/Dockerfile") : join(context, app === "sveltekit" ? "Dockerfile.marketplace" : "Dockerfile");
      await docker(["build", "--label", `run.corten.marketplace.commit=${summary.commit}`, "--label", "run.corten.marketplace.dirty=false",
        ...(options.group ? ["--label", `run.corten.marketplace.profile=${boundedFeatureProfile}`, "--build-arg", `PROFILE=${boundedQualificationSettings.nativeProfile}`] : []),
        "-t", image, "-f", dockerfile, context], { timeout: 60 * 60 * 1000, file: join(folder, `build-${app}.log`) });
      assert.equal(await command("git", ["rev-parse", "HEAD"]), summary.commit, "HEAD changed during image build");
      assert.equal(await command("git", ["status", "--porcelain"]), "", "checkout changed during image build");
    }
    const info = JSON.parse(await docker(["image", "inspect", image]))[0];
    imageProvenance(info.Config.Labels, summary.commit, false);
    if (options.group) assert.equal(info.Config.Labels["run.corten.marketplace.profile"], boundedFeatureProfile, "image lacks the required feature profile; rebuild with --build");
    images[app] = imageReceipt(info);
  }
  retain(join(folder, "images.json"), images);
  save();
  summary.tools = { k6: await describeK6(docker, ["--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`], { pullLog: join(folder, "pull-k6.log") }) };
  await docker(["network", "create", "--label", `${label}=${runId}`, network]);
  const networkInfo = JSON.parse(await docker(["network", "inspect", network]))[0];
  created.push({ kind: "network", id: networkInfo.Id, name: network });
  await owned(["run", "-d", "--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
    "-v", `${fixtureDir}:/fixtures:ro`, nodeImage, "node", "/bench/marketplace/upstream.mjs"], upstreamName);
  const upstreamInfo = await inspect(upstreamName);
  retain(join(folder, "upstream-container.json"), containerReceipt(upstreamInfo));
  summary.tools.upstream = { image: nodeImage, imageId: upstreamInfo.Image };
  const upstream = await portOf(upstreamName);
  const upstreamDeadline = Date.now() + 20000;
  while (true) {
    try { const response = await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(1000) }); await response.text(); if (response.ok) break; } catch {}
    if (Date.now() > upstreamDeadline) throw new Error("marketplace upstream did not start");
    await sleep(100);
  }
  save();
  for (const source of options.sources) for (const app of options.apps) for (const target of options.targets) {
    const cell = { app, source, target };
    summary.cells.push(cell);
    const raw = join(folder, source, app, target);
    mkdirSync(raw, { recursive: true });
    log(`${options.kind} ${app} ${source} ${target}: ${options.minutes} min in ${options.windowSeconds}s windows`);
    try {
      if (interrupted) throw new Error("interrupted");
      await pass(cell, images[app].id, raw);
      if (convergence) log(`${app} ${source} ${target}: ${cell.verdict.flattened ? `flattened at window ${cell.verdict.window}` : `never flattened (${cell.verdict.reason})`}`);
    } catch (e) {
      // This cell has no verdict; the pass goes on to the next one.
      for (const key of Object.keys(cell)) if (!["app", "source", "target"].includes(key)) delete cell[key];
      cell.failure = e.message ?? String(e);
      if (convergence) cell.verdict = null;
      log(`${app} ${source} ${target} FAILED: ${cell.failure}`);
    }
    save();
  }
  summary.finishedCommit = await command("git", ["rev-parse", "HEAD"]);
  assert.equal(summary.finishedCommit, summary.commit, "checkout moved during the pass");
  assert.equal(await command("git", ["status", "--porcelain"]), "", "checkout changed during the pass");
  summary.complete = !interrupted;
} catch (e) {
  summary.failures.push({ stage: "suite", error: e.stack ?? String(e) });
  log(`suite FAILED: ${e.message ?? e}`);
} finally {
  for (const name of [...active].reverse()) {
    try { await remove(name); } catch (e) { summary.cleanupFailures.push({ resource: name, error: e.message }); }
  }
  try {
    const found = await docker(["network", "ls", "--filter", `name=^${network}$`, "--format", "{{.ID}}"], { cleanup: true });
    if (found) {
      const info = JSON.parse(await docker(["network", "inspect", network], { cleanup: true }))[0];
      assert.equal(info.Labels?.[label], runId, "refusing unowned network cleanup");
      assert.equal(await docker(["network", "rm", info.Id], { cleanup: true }), info.Id);
      removed.push({ kind: "network", id: info.Id, name: network });
    }
  } catch (e) { summary.cleanupFailures.push({ resource: network, error: e.message }); }
  try {
    const remaining = { containers: await docker(["ps", "-a", "--filter", `label=${label}=${runId}`, "--format", "{{.ID}}"], { cleanup: true }),
      networks: await docker(["network", "ls", "--filter", `label=${label}=${runId}`, "--format", "{{.ID}}"], { cleanup: true }) };
    retain(join(folder, "cleanup.json"), { runId, created, removed, remaining });
    assert.deepEqual(remaining, { containers: "", networks: "" }, "owned resources survived cleanup");
  } catch (e) { summary.cleanupFailures.push({ resource: runId, error: e.message }); }
  summary.finishedAt = new Date().toISOString();
  summary.complete &&= !interrupted && summary.failures.length === 0 && summary.cleanupFailures.length === 0;
  save();
}
log(`marketplace ${options.kind} ${options.name}: ${summary.complete ? "COMPLETE" : "INCOMPLETE"}; ${join(folder, "summary.json")}`);
if (!summary.complete) process.exitCode = 1;