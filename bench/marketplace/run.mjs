// Marketplace-v2: official r17 onward; wN permits explicit development subsets/checks.
// node bench/marketplace/run.mjs r17 --build --passes 3
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpuSettings, imageProvenance, inventory, parseArgs, phaseEnd, phases, profileStop, readOutcome, resultSchema, sources, stageAggregate, timedProfiles, upstreamErrors } from "./run-contract.mjs";
import { workload } from "./contract.mjs";
import { validateMarketplace } from "./records.mjs";
import { sampleStats } from "../catalog/stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const rotate = (xs, offset) => xs.slice(offset % xs.length).concat(xs.slice(0, offset % xs.length));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = parseArgs(process.argv.slice(2), inventory);
const cpus = cpuSettings(process.env);
const runId = `marketplace-${options.round}-${randomBytes(5).toString("hex")}`;
const network = `${runId}-net`;
const label = "run.corten.marketplace";
const folder = join(here, "results", options.round);
mkdirSync(join(here, "results"), { recursive: true });
// Atomic reservation: another invocation or an old failed run cannot be overwritten.
mkdirSync(folder);
const summary = { schema: resultSchema, workload, round: options.round, runId, options, startedAt: new Date().toISOString(), complete: false, checksPassed: false, failures: [], cleanupFailures: [], apps: {}, host: { hostname: hostname(), platform: platform(), release: release() },
  scope: "marketplace-v2 rich localized rendering/JSON load only; fullstack bytes, build-cost, instructions and browser-timing measurements are not ported",
  measurement: { profiles: timedProfiles, cpus, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, encoding: "identity", fixedRate: options.rate,
    upstream: "single Node process, even with a two-CPU quota; high upstream CPU can limit API-mode throughput; closed-loop VUs alone do not prove app saturation",
    cpuWindow: "cgroup v2 usage_usec before/after docker start -a of k6; includes small Docker command/idle windows, not only HTTP handler CPU", coldClock: "Docker-host container StartedAt to first complete 200, not process exec" } };
const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
const log = (message) => { const line = `${new Date().toISOString()} ${message}`; console.log(line); appendFileSync(join(folder, "run.log"), `${line}\n`); };
const active = new Set();
let interrupted = false;
const children = new Set();
// This stops command clients, not browser descendants. Browsers run ONLY in
// owned containers, which finally removes even when their docker client exited.
function killCommand(child) {
  if (process.platform === "win32" && child.pid) {
    // Node's Windows kill terminates only the child; the check's browser would survive.
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", cwd: repo });
    killer.on("error", () => child.kill("SIGKILL"));
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    else child.kill("SIGKILL");
  }, 2000);
  force.unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; for (const child of children) killCommand(child); });
async function command(binary, args, { timeout = 30000, file, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error("marketplace run interrupted");
  const child = spawn(binary, args, { cwd: repo, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  let error = "";
  let killed = false;
  const keep = (chunk, stderr) => {
    const value = chunk.toString();
    if (file) appendFileSync(file, value);
    if (stderr) error = (error + value).slice(-65536); else output = (output + value).slice(-8 * 1024 * 1024);
  };
  child.stdout.on("data", (c) => keep(c, false));
  child.stderr.on("data", (c) => keep(c, true));
  const timer = setTimeout(() => { killed = true; killCommand(child); }, timeout);
  try {
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    if (code !== 0 || killed || (interrupted && !cleanup)) throw new Error(`${binary} ${args.slice(0, 3).join(" ")}: ${killed ? `timeout after ${timeout} ms` : `exit ${code}`}\n${error || output}`);
    return output.trim();
  } finally { clearTimeout(timer); children.delete(child); }
}
const docker = (args, opts) => command("docker", args, opts);
const inspect = async (name, cleanup = false) => JSON.parse(await docker(["inspect", name], { cleanup }))[0];
// The app's container stopped during a load phase: its outcome under the profile, not a failure.
class AppStopped extends Error {
  constructor(stop) {
    super(`app container ${stop.oomKilled ? "OOM-killed" : "exited"} during ${stop.phase} (exit ${stop.exitCode}, OOMKilled ${stop.oomKilled})`);
    this.stop = stop;
  }
}
const fail = (app, source, stage, error) => {
  const failure = { app, source, stage, error: error.stack ?? String(error) };
  summary.failures.push(failure);
  if (app && summary.apps[app]) (summary.apps[app].failures ??= []).push(failure);
  log(`${app ?? "suite"} ${source ?? ""} ${stage} FAILED: ${error.message ?? error}`);
  save();
};
const owned = async (args, name) => {
  active.add(name);
  await docker([args[0], "--name", name, "--label", `${label}=${runId}`, ...args.slice(1)]);
  return name;
};
async function remove(name) {
  // A failed create might not have created anything. A collision is never ours to stop.
  const list = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], { cleanup: true });
  if (list) {
    const info = await inspect(name, true);
    assert.equal(info.Config.Labels?.[label], runId, `refusing cleanup of unowned ${name}`);
    await docker(["rm", "-f", info.Id], { cleanup: true });
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
const nodeImage = "node:24-bookworm-slim";
const k6Image = "grafana/k6@sha256:3e4186aea62e11a45560bfc51e19eeafe82fc07ce069c78aff44b7ff893d9a5e";
const mount = ["-v", `${join(repo, "bench")}:/bench:ro`];
const upstreamName = `${runId}-upstream`;
const cpuName = `${runId}-cpu`;
const apiBase = `http://${upstreamName}:8080`;
// StartedAt of the containers a load phase depends on, from when each was created: a stop of the
// app is its outcome only while they are still the same running containers (phaseEnd).
const startedAt = {};
let upstreamUrl = null;
async function upstreamCounters() {
  const response = await fetch(`${upstreamUrl}/__marketplace/control`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, "upstream counters unavailable");
  return response.json();
}
function appArgs(name, source, image) {
  return ["--network", network, ...cpus.app.args, "--memory", "1g", "-p", "127.0.0.1::8080",
    "-v", `${fixtureDir}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
    "-e", `API_BASE=${apiBase}`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`, image];
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
async function coldStart(name, source, target, image, raw) {
  await owned(["create", ...appArgs(name, source, image)], name);
  const probe = `${name}-probe`;
  const path = target === "json" ? "/api/marketplace/item_1" : `/marketplace/${summary.currentLocale}/item_1`;
  try {
    await owned(["run", "-d", "--network", network, ...cpus.load.args, "--memory", "256m", ...mount, nodeImage, "node", "/bench/catalog/cold.mjs", `http://${name}:8080`, path, String(options.startupTimeout)], probe);
    const deadline = Date.now() + 10000;
    while (!(await docker(["logs", probe])).includes("catalog-probe-ready")) {
      if (Date.now() > deadline) throw new Error("cold sidecar did not become ready");
      await sleep(50);
    }
    await docker(["start", name]);
    const exit = await docker(["wait", probe], { timeout: (options.startupTimeout + 5) * 1000 });
    const output = await docker(["logs", probe]);
    writeFileSync(join(raw, "cold.log"), output);
    assert.equal(exit, "0", `cold probe: ${output}`);
    const result = JSON.parse(output.split("\n").findLast((line) => line.startsWith("{")));
    const info = await inspect(name);
    const ms = Date.parse(result.first200At) - Date.parse(info.State.StartedAt);
    assert.ok(ms >= 0 && ms <= options.startupTimeout * 1000, "invalid Docker-host cold clock");
    const cold = { ...result, first200MsFromContainerStart: ms, containerStartedAt: info.State.StartedAt, clock: "Docker host wall clock; container start, not process exec; polling interval 10ms", measuredBeforeReadinessOrWarmup: true };
    writeFileSync(join(raw, "cold.json"), JSON.stringify(cold, null, 2));
    return cold;
  } finally { await remove(probe); }
}
async function cpu(containers) {
  const ids = await Promise.all(containers.map(async (name) => [name, (await inspect(name)).Id]));
  const usage = JSON.parse(await docker(["exec", cpuName, "node", "/bench/catalog/cgroup.mjs", ...ids.map(([, id]) => id)], { timeout: 15000 }));
  return Object.fromEntries(ids.map(([name, id]) => { assert.ok(Number.isSafeInteger(usage[id]), "missing CPU counter"); return [name, usage[id]]; }));
}
async function load(name, target, phase, seconds, raw, pass) {
  const container = `${runId}-k6`;
  const output = join(raw, `${phase}.json`);
  const env = [...(target === "page" ? ["-e", `LOCALE=${summary.currentLocale}`] : []), "-e", `BASE=http://${name}:8080`, "-e", `TARGET=${target}`, "-e", `DURATION=${seconds}s`, "-e", `MODE=${phase === "fixed" ? "fixed" : "closed"}`,
    "-e", `RATE=${options.rate}`, "-e", `VUS=${phase === "sat256" ? 256 : phase === "warmup" ? 32 : 64}`];
  const samples = phase === "warmup" ? [] : [name, ...(summary.currentSource === "api" ? [upstreamName] : [])];
  const reads = summary.currentSource === "api" ? await upstreamCounters() : null;
  const phaseStartMs = Date.now();
  let before = {};
  let after = {};
  let sampler;
  let stats;
  // What failed during the phase, at which step and when: phaseEnd decides what the app's stop explains.
  const errors = [];
  const failed = (step, error) => errors.push({ step, error, at: new Date().toISOString() });
  let step = "k6";
  try {
    await owned(["create", "--network", network, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount, ...env,
      k6Image, "run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/load.js"], container);
    step = "cpu";
    before = samples.length ? await cpu(samples) : {};
    step = "stats";
    sampler = samples.length ? sampleStats(samples, join(raw, `${phase}-stats.log`), seconds + 35) : null;
    step = "k6";
    await docker(["start", "-a", container], { timeout: (seconds + 25) * 1000, file: join(raw, `${phase}.log`) });
  } catch (e) { failed(step, e); }
  finally {
    try { if (sampler) stats = await sampler.stop(); } catch (e) { failed("stats", e); }
  }
  // Whether the app stopped is read first: its CPU counter and stats go with its container (#1128).
  let app = null;
  try { app = (await inspect(name)).State; } catch (e) { failed("inspect", e); }
  const stopped = app && (!app.Running || app.OOMKilled);
  try { if (!stopped && samples.length && Object.keys(before).length) after = await cpu(samples); }
  catch (e) { failed("counters", e); }
  try {
    // Preserve failed k6 summaries as well as stderr. An absent summary never passes.
    try { await docker(["cp", `${container}:/tmp/marketplace-summary.json`, output]); }
    catch (e) { failed("summary", e); }
    const counters = Object.fromEntries(samples.filter((n) => before[n] !== undefined && after[n] !== undefined).map((n) => { assert.ok(after[n] >= before[n], "CPU counter moved backwards"); return [n, { usec: after[n] - before[n] }]; }));
    writeFileSync(join(raw, `${phase}-cpu.json`), JSON.stringify(counters, null, 2));
    const seen = { pass, phase, app, errors };
    if (stopped) {
      // Only when the app stopped: is everything else the phase depends on the same, still running?
      seen.sidecars = await Promise.all([cpuName, ...(reads ? [upstreamName] : [])].map(async (n) => ({ name: n, startedAt: startedAt[n], state: await inspect(n).then((i) => i.State, () => null) })));
      try {
        const lines = await docker(["events", "--since", String(phaseStartMs / 1000), "--until", String(Date.now() / 1000), "--filter", "type=container", "--filter", `container=${name}`, "--format", "{{.Action}}|{{.TimeNano}}"]);
        seen.events = lines.split("\n").filter(Boolean).map((line) => ({ action: line.slice(0, line.lastIndexOf("|")), ms: Number(line.slice(line.lastIndexOf("|") + 1)) / 1e6 })).filter((e) => e.ms >= phaseStartMs);
      } catch (e) { failed("events", e); }
      try { seen.summary = JSON.parse(readFileSync(output, "utf8")); } catch { seen.summary = null; }
      for (const e of errors) log(`${name} ${phase}: ${e.step} failed as the app stopped: ${String(e.error?.message ?? e.error).split("\n")[0]}`);
    }
    // Throws for a harness or parity failure, including one the app's stop does not explain.
    const stop = phaseEnd(seen);
    if (stop) {
      // An upstream error answer may be what stopped the app: that stays the harness's failure.
      if (reads) {
        const upstream = upstreamErrors(reads, await upstreamCounters());
        assert.equal(upstream, 0, `the upstream answered ${upstream} record reads with an error during ${phase}, and the app stopped: a harness failure, not the app's outcome`);
      }
      throw new AppStopped(stop);
    }
    const metrics = readOutcome(JSON.parse(readFileSync(output, "utf8")));
    if (reads) {
      const errors = upstreamErrors(reads, await upstreamCounters());
      assert.equal(errors, 0, `the upstream answered ${errors} record reads with an error during ${phase}: a harness failure, not the app's outcome`);
    }
    if (metrics.appOutcome) log(`${name} ${phase}: app outcome, ${metrics.failed} of ${metrics.requests} requests failed, ${metrics.dropped} iterations dropped, ${metrics.checksFailed} checks failed`);
    if (samples.length) {
      assert.ok(counters[name].usec > 0, "phase used no CPU");
      Object.assign(metrics, stats[name], { cpuUsec: counters[name].usec, perCpuSecond: metrics.requests / (counters[name].usec / 1e6), upstream: counters[upstreamName] ? { ...stats[upstreamName], cpuUsec: counters[upstreamName].usec,
        highCpu: stats[upstreamName].cpuAvgPct >= 80, interpretation: "single-process upstream; a busy API may be the throughput limit, not the app" } : null });
    }
    return metrics;
  } finally { await remove(container); }
}

try {
  save();
  summary.commit = await command("git", ["rev-parse", "HEAD"]);
  summary.dirty = (await command("git", ["status", "--porcelain", "--untracked-files=normal"])).length > 0;
  assert.ok(options.checkOnly || !summary.dirty, "load runs require a clean committed checkout");
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
  const fixture = readFileSync(join(fixtureDir, "marketplace.json"));
  const marketplace = validateMarketplace(JSON.parse(fixture));
  const generated = (await import("./fixtures.mjs")).records();
  assert.deepEqual(marketplace, generated, "generated fixture is stale: run node bench/marketplace/fixtures.mjs");
  summary.fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
  for (const app of options.apps) {
    const entry = summary.apps[app] = { label: inventory[app].label, image: `cb-marketplace-${app}`, checks: {}, runs: {}, phases: {} };
    try {
      if (options.build) {
        log(`building ${app}`);
        const context = app === "corten" ? repo : join(repo, "bench/fullstack/apps", app);
        const dockerfile = app === "corten" ? join(here, "corten/Dockerfile") : join(context, app === "sveltekit" ? "Dockerfile.marketplace" : "Dockerfile");
        const buildCommit = await command("git", ["rev-parse", "HEAD"]);
        const buildDirty = (await command("git", ["status", "--porcelain"])).length > 0;
        await docker(["build", "--label", `run.corten.marketplace.commit=${buildCommit}`, "--label", `run.corten.marketplace.dirty=${buildDirty}`, "-t", entry.image, "-f", dockerfile, context], { timeout: 60 * 60 * 1000, file: join(folder, `build-${app}.log`) });
        assert.equal(await command("git", ["rev-parse", "HEAD"]), buildCommit, "HEAD changed during image build");
        assert.ok(buildDirty || !(await command("git", ["status", "--porcelain"])).length, "checkout became dirty during image build");
      }
      const image = JSON.parse(await docker(["image", "inspect", entry.image]))[0];
      Object.assign(entry, imageProvenance(image.Config.Labels, summary.commit, options.checkOnly));
      entry.imageId = image.Id;
      entry.imageBytes = image.Size;
    } catch (e) { fail(app, null, "build/image", e); }
    save();
  }
  await docker(["network", "create", "--label", `${label}=${runId}`, network]);
  summary.networkCreated = true;
  await owned(["run", "-d", "--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
    "-v", `${fixtureDir}:/fixtures:ro`, nodeImage, "node", "/bench/marketplace/upstream.mjs"], upstreamName);
  const upstreamInfo = await inspect(upstreamName);
  startedAt[upstreamName] = upstreamInfo.State.StartedAt;
  summary.tools = { upstream: { image: nodeImage, imageId: upstreamInfo.Image } };
  const upstream = upstreamUrl = await portOf(upstreamName);
  const upstreamDeadline = Date.now() + 20000;
  while (true) {
    try { const response = await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(1000) }); await response.text(); if (response.ok) break; } catch {}
    if (Date.now() > upstreamDeadline) throw new Error("marketplace upstream did not start");
    await sleep(100);
  }
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@playwright/test"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "Playwright must have a pinned image-compatible version");
  const checkerImage = `mcr.microsoft.com/playwright:v${version}-noble`;
  let checker;
  try { checker = JSON.parse(await docker(["image", "inspect", checkerImage]))[0]; }
  catch {
    await docker(["pull", checkerImage], { timeout: 10 * 60 * 1000, file: join(folder, "pull-checker.log") });
    checker = JSON.parse(await docker(["image", "inspect", checkerImage]))[0];
  }
  summary.tools.checker = { image: checkerImage, imageId: checker.Id, isolation: "owned PID namespace/cgroup; force-removed in finally, independent of Node/browser process groups" };
    for (const source of sources) for (const app of options.apps) {
      const entry = summary.apps[app];
      if (!entry.imageId) continue;
      const name = `${runId}-${app}`;
      const out = join(folder, source, app);
      const checkContainer = `${name}-check`;
      mkdirSync(out, { recursive: true });
      try {
        log(`checking ${app} ${source}`);
        await owned(["run", "-d", ...appArgs(name, source, entry.imageId)], name);
        const base = await portOf(name);
        await ready(base);
        // Chromium starts a separate process group. A host Node/group kill cannot
        // reliably reap it, so timeout cleanup removes its entire owned PID namespace.
        // Share ONLY the app's network namespace, not its PID namespace: loopback
        // stays a trustworthy browser origin without disabling security features.
        await owned(["create", "--network", `container:${name}`, ...cpus.load.args, "--memory", "2g", "--shm-size", "1g", "-v", `${repo}:/repo:ro`, "-v", `${out}:/results`,
          "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", checker.Id, "node", "/repo/bench/marketplace/check.mjs", "http://127.0.0.1:8080", source, apiBase, "/results/checks.json"], checkContainer);
        try { await docker(["start", "-a", checkContainer], { timeout: 15 * 60 * 1000, file: join(out, "checks.log") }); }
        finally { await remove(checkContainer); }
        const checked = JSON.parse(readFileSync(join(out, "checks.json"), "utf8"));
        entry.checks[source] = checked;
        assert.equal(checked.jsonRecords, 500, "incomplete JSON checks");
        assert.equal(checked.workload, workload);
        assert.equal(checked.source, source);
        assert.equal(checked.pages, 264);
        assert.ok(checked.profiles.every((p) => p.passed));
        if (source === "api") assert.deepEqual(checked.upstream, { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true });
        assert.equal(checked.profiles.length, 12, "incomplete browser profiles");
      } catch (e) { fail(app, source, "checks", e); }
      finally {
        if (active.has(checkContainer)) await remove(checkContainer);
        try { writeFileSync(join(out, "app.log"), await docker(["logs", name])); } catch (e) { fail(app, source, "app logs", e); }
        await remove(name);
      }
      save();
    }
  summary.checksPassed = summary.failures.length === 0;
  save();
  if (!summary.checksPassed) throw new Error("parity failed; no app will be load-tested");
  if (!options.checkOnly) {
    assert.equal(await command("git", ["rev-parse", "HEAD"]), summary.commit, "checkout moved during builds/checks");
    assert.equal(await command("git", ["status", "--porcelain"]), "", "checkout changed during builds/checks");
    const k6 = JSON.parse(await docker(["image", "inspect", k6Image]).catch(async () => { await docker(["pull", k6Image], { timeout: 5 * 60 * 1000, file: join(folder, "pull-k6.log") }); return docker(["image", "inspect", k6Image]); }))[0];
    summary.tools.k6 = { image: k6Image, imageId: k6.Id, repoDigests: k6.RepoDigests };
    await owned(["run", "-d", "--network", "none", "--cpus", "1", ...(cpus.load.cpuset ? ["--cpuset-cpus", cpus.load.cpuset] : []), "--memory", "128m", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", ...mount,
      nodeImage, "node", "-e", "setInterval(() => {}, 1000)"], cpuName);
    startedAt[cpuName] = (await inspect(cpuName)).State.StartedAt;
    for (let pass = 1; pass <= options.passes; pass++) for (const { key, source, locale, target } of timedProfiles) for (const app of rotate(options.apps, Math.floor((pass - 1) * options.apps.length / options.passes))) {
      const entry = summary.apps[app];
      // A profile in which the app's container stopped runs no later pass (#1128).
      const stopped = profileStop(entry.runs[key] ?? []);
      if (stopped) { log(`skipping ${app} ${source} ${target} pass ${pass}: its container stopped in pass ${stopped.pass} during ${stopped.phase}`); continue; }
      const name = `${runId}-${app}`;
      const raw = join(folder, source, app, `p${pass}-${locale ?? "neutral"}-${target}`);
      mkdirSync(raw);
      const run = { pass, locale, startedAt: new Date().toISOString(), complete: false, phases: {} };
      (entry.runs[key] ??= []).push(run);
      summary.currentSource = source;
      summary.currentLocale = locale;
      try {
        log(`cold ${app} ${source} ${target} pass ${pass}`);
        run.cold = await coldStart(name, source, target, entry.imageId, raw);
        log(`warmup ${app} ${source} ${target} pass ${pass}`);
        run.warmup = await load(name, target, "warmup", options.warmup, raw, pass);
        for (const phase of phases) {
          log(`${app} ${source} ${target} ${phase} pass ${pass}`);
          run.phases[phase] = await load(name, target, phase, options.duration, raw, pass);
          save();
        }
        run.complete = true;
      } catch (e) {
        // The app's outcome, recorded with why; its later phases and passes of this profile do not run.
        if (e instanceof AppStopped) { run.stopped = e.stop; log(`${app} ${source} ${target} pass ${pass}: app outcome, ${e.message}; later phases and passes of this profile skipped`); }
        else { run.failed = e.message; fail(app, source, `load ${target} pass ${pass}`, e); }
      }
      finally {
        try { writeFileSync(join(raw, "app.log"), await docker(["logs", name])); } catch (e) { fail(app, source, "app logs", e); }
        await remove(name);
      }
      run.finishedAt = new Date().toISOString();
      for (const phase of phases) (entry.phases[key] ??= {})[phase] = stageAggregate(entry.runs[key], phase, options.passes);
      save();
    }
  }
  summary.finishedCommit = await command("git", ["rev-parse", "HEAD"]);
  summary.finishedDirty = (await command("git", ["status", "--porcelain"])).length > 0;
  if (!options.checkOnly) {
    assert.equal(summary.finishedCommit, summary.commit, "checkout moved during measurement");
    assert.equal(summary.finishedDirty, false, "checkout changed during measurement");
  }
  summary.complete = summary.failures.length === 0;
} catch (e) { fail(null, null, "suite", e); }
finally {
  for (const name of [...active].reverse()) {
    try { await remove(name); } catch (e) { summary.cleanupFailures.push({ resource: name, error: e.message }); }
  }
  try {
    const found = await docker(["network", "ls", "--filter", `name=^${network}$`, "--format", "{{.ID}}"], { cleanup: true });
    if (found) {
      const info = JSON.parse(await docker(["network", "inspect", network], { cleanup: true }))[0];
      assert.equal(info.Labels?.[label], runId, "refusing unowned network cleanup");
      await docker(["network", "rm", info.Id], { cleanup: true });
    }
  } catch (e) { summary.cleanupFailures.push({ resource: network, error: e.message }); }
  delete summary.currentSource;
  delete summary.currentLocale;
  summary.finishedAt = new Date().toISOString();
  summary.complete &&= !interrupted && summary.cleanupFailures.length === 0;
  save();
}
log(`${workload} ${options.round}: ${summary.complete ? "PASS" : "FAIL"}; ${join(folder, "summary.json")}`);
if (!summary.complete) process.exitCode = 1;
