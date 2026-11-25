// The convergence and soak runner (#1851) behind steady.mjs, with Docker, git, the clock and the
// stats client passed in so the tests can run it against fakes. It changes no timed phase, warmup,
// rate, droplet job or saved round.
// Resources: every container and network goes through ownedResources (alert-probe-run.mjs), keyed
// by the immutable ID its create returned and confirmed by this pass's owner label before every
// inspect, log read and removal. A create that returned no ID stays on record; teardown looks for it
// by its attempt label and calls its cleanup unconfirmed if nothing appears, so such a pass is never
// complete. Each cell's own containers are removed before the next cell starts; a cell that leaves
// one behind, or whose create was not acknowledged, ends the pass, since its app may still be using
// the host.
// Startup: each app is started the way run.mjs coldStart starts it before a timed warmup (created,
// a sidecar polls the target's path from docker start to its first 200), then the load.
// k6: its version is read from a container this pass creates and removes like any other, and each
// load's engine clock and counters are checked by load-evidence.mjs validateLoadExecution, as a
// timed round's are, before any window is read.
// Saved text: summary.json and cleanup.json keep only fixed messages or the first line this runner
// or its command runner composes. Docker's and k6's own output (stderr, a malformed answer, a JSON
// parse excerpt) is untrusted and is never quoted there; the full error goes to the raw errors.log.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cpuSettings, imageProvenance, readLoadSummary } from "./run-contract.mjs";
import { admitted, boundedFeatureProfile, boundedQualificationSettings } from "./feature-contract.mjs";
import { validateSummary } from "./report.mjs";
import { memoryMiB, summarizeSamples } from "../catalog/stats.mjs";
import { containerReceipt, imageReceipt, nodeImage } from "./raw-contract.mjs";
import { retainLoadEvidence, validateLoadExecution } from "./load-evidence.mjs";
import { k6Image, k6Provenance } from "../load-tool.mjs";
import { validateMarketplace } from "./records.mjs";
import { records } from "./fixtures.mjs";
import { locales } from "./contract.mjs";
import { ownedResources, reconcileWindow, runClock } from "./alert-probe-run.mjs";
import { checkFixture, convergenceSchema, flattenPoint, flattenRule, heldThrough, ownerLabelKey, readDropped, readWindows, soakMemoryClock, soakSchema, summarizeSoak, timedStartup, verdictText } from "./steady-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const fixtureDir = join(here, "fixtures");
const containerId = /^[a-f0-9]{64}$/;
// The first line of an error, bounded: what a saved record keeps.
export const firstLine = (error) => String(error?.message ?? error).split("\n", 1)[0].slice(0, 500);
// The metrics window-load.js and k6 itself export. A summary with any other name is refused with a
// count before a validator can quote the name.
const k6Metrics = new Set(["http_reqs", "http_req_duration", "http_req_duration{expected_response:true}", "http_req_blocked", "http_req_connecting", "http_req_tls_handshaking",
  "http_req_sending", "http_req_waiting", "http_req_receiving", "http_req_failed", "iterations", "iteration_duration", "dropped_iterations", "vus", "vus_max", "checks",
  "data_sent", "data_received", "window_tail_requests"]);
export function knownK6Metrics(summary) {
  assert.ok(summary && typeof summary.metrics === "object" && summary.metrics !== null && !Array.isArray(summary.metrics), "the k6 summary export has no metrics");
  const unknown = Object.keys(summary.metrics).filter((name) => !k6Metrics.has(name) && !/^window_(0|[1-9]\d{0,2})_(requests|failed|duration)$/.test(name)).length;
  assert.equal(unknown, 0, `the k6 summary export has ${unknown} metric${unknown === 1 ? "" : "s"} this load does not define`);
  return summary;
}

/**
 * Samples memory of containers by their immutable IDs with docker stats (--no-trunc, so each row's
 * ID is the full one). bench/catalog/stats.mjs sampleStats does the same by name for the timed
 * rounds; it is left as it is, since it is on Catalog's and Marketplace's timed path. Here stop()
 * settles within boundMs whatever the client does: TERM, KILL after graceMs, and at boundMs its
 * pipes are released and the sampler fails, so a process still holding them cannot keep the pass
 * from cleaning up. A second stop() returns the first one's result. `now` stamps each sample.
 * @returns {{ stop(): Promise<{summary: object, samples: object}> }}
 */
export function memorySampler({ ids, file, seconds, spawn: run = spawn, graceMs = 2000, boundMs = 5000, now = Date.now }) {
  assert.ok(ids.length > 0 && ids.every((id) => containerId.test(id)), "memory is sampled by immutable container IDs");
  const child = run("docker", ["stats", "--no-trunc", "--format", "{{json .}}", ...ids], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const samples = Object.fromEntries(ids.map((id) => [id, []]));
  const errors = [];
  const failed = (message) => errors.push(message);
  // Rows that are not readable or name another container are counted, not quoted; stderr is kept
  // in its own raw file.
  let buffer = "", raw = "", stderr = "", unreadable = 0, foreign = 0, stopping = false, closed = false, settled;
  child.stdout.on("data", (chunk) => {
    const data = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    raw += data; buffer += data;
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        if (!Object.hasOwn(samples, s?.ID)) { foreign++; continue; }
        samples[s.ID].push({ t: now(), cpu: parseFloat(s.CPUPerc), mem: memoryMiB(s.MemUsage.split("/")[0]) });
      } catch { unreadable++; }
    }
  });
  child.stderr.on("data", (chunk) => { if (!stopping) stderr += chunk.toString(); });
  child.on("error", (error) => failed(`docker stats could not run (${typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "error"})`));
  const done = new Promise((resolve) => child.on("close", (code) => { closed = true; if (!stopping) failed(`docker stats stopped early: ${code}`); resolve(true); }));
  const signal = (name) => { try { child.kill(name); } catch {} };
  const timer = setTimeout(() => { failed("stats sampler exceeded its deadline"); signal("SIGTERM"); }, seconds * 1000);
  return {
    stop() {
      return settled ??= (async () => {
        stopping = true;
        clearTimeout(timer);
        if (!closed) signal("SIGTERM");
        let kill, bound;
        const ended = await Promise.race([done, new Promise((resolve) => {
          kill = setTimeout(() => signal("SIGKILL"), graceMs);
          bound = setTimeout(() => resolve(false), boundMs);
        })]);
        clearTimeout(kill); clearTimeout(bound);
        if (!ended) {
          // Something still holds the client's pipes after TERM and KILL: release them and fail.
          failed(`docker stats did not settle within ${boundMs} ms of stop; its pipes were released`);
          child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
        }
        writeFileSync(file, raw);
        if (stderr) { writeFileSync(`${file}.stderr`, stderr); failed(`docker stats wrote to stderr (kept in ${basename(file)}.stderr)`); }
        if (unreadable) failed(`${unreadable} docker stats row${unreadable === 1 ? " was" : "s were"} not readable`);
        if (foreign) failed(`${foreign} docker stats row${foreign === 1 ? "" : "s"} named a container this pass does not sample`);
        if (buffer.trim().length) failed("stats ended with an incomplete JSON record");
        if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });
        const summary = Object.fromEntries(ids.map((id) => [id, summarizeSamples(samples[id])]));
        writeFileSync(`${file}.json`, JSON.stringify({ summary, samples }, null, 2));
        return { summary, samples };
      })();
    },
  };
}

async function waitHealth(url, { timeout = 20_000, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  for (const deadline = now() + timeout; now() < deadline; await sleep(100)) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.text(); if (response.ok) return; } catch {}
  }
  throw new Error("marketplace upstream did not start");
}
const currentFixture = () => {
  let bytes = null;
  try { bytes = readFileSync(join(fixtureDir, "marketplace.json")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return checkFixture(bytes, records(), validateMarketplace);
};

/**
 * Runs one convergence or soak pass and returns its summary, also saved as summary.json in folder
 * (which must not exist yet: an earlier pass is never overwritten).
 * @param {object} p
 * @param {object} p.options parseSteadyArgs output
 * @param {(args: string[], options?: object) => Promise<string>} p.docker bounded docker runner (commandRunner)
 * @param {(args: string[]) => Promise<string>} p.git
 */
export async function runSteady({ options, folder, runId, docker, git, interrupted = () => false, env = process.env, clock = runClock(), window = reconcileWindow,
  fixture = currentFixture, upstreamReady = waitHealth, spawnStats = spawn, statsBounds = {}, print = console.log }) {
  const convergence = options.kind === "convergence";
  const seconds = options.minutes * 60;
  const cpus = cpuSettings(env);
  mkdirSync(dirname(folder), { recursive: true });
  mkdirSync(folder);
  const summary = { schema: convergence ? convergenceSchema : soakSchema, name: options.name, runId, options, ...(convergence ? { rule: flattenRule } : {}),
    startedAt: new Date().toISOString(), complete: false, failures: [], cleanupFailures: [], cells: [], admission: null, startup: timedStartup,
    host: { hostname: hostname(), platform: platform(), release: release() },
    scope: convergence ? "marketplace-v2 convergence: one closed-loop pass per adapter, source and target, throughput and latency per window; not a timed round or a comparison"
      : "marketplace-v2 soak: one fixed-rate pass per adapter, source and target, memory at start and end, p99 per interval and restarts; not a timed round or a comparison",
    measurement: { cpus, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, encoding: "identity",
      clock: "windows are the k6 engine's clock from the start of the test; a request counts in the window its answer completed in",
      ...(convergence ? {} : { memoryClock: soakMemoryClock }) } };
  const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
  const log = (message) => { const line = `${new Date().toISOString()} ${message}`; print(line); appendFileSync(join(folder, "run.log"), `${line}\n`); };
  const retain = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
  // The full text of an error (a command's stderr, a validator's detail) goes here, raw, never to
  // summary.json or cleanup.json.
  const keep = (where, error) => appendFileSync(join(folder, "errors.log"), `${new Date().toISOString()} ${where}: ${error?.stack ?? error}\n`);
  // Every Docker command's error is reduced to its first line, which the command runner composes
  // from this pass's own arguments and the exit; the rest (Docker's own output) stays in errors.log.
  const ownDocker = async (args, opts) => {
    try { return await docker(args, opts); } catch (error) {
      if (error && typeof error === "object") {
        keep(`docker ${args.slice(0, 2).join(" ")}`, error);
        try { error.message = firstLine(error); error.stack = `${error.name ?? "Error"}: ${error.message}`; } catch {}
      }
      throw error;
    }
  };
  // Parsing an answer: a JSON.parse message quotes the input, so it and the answer (bounded) are
  // kept in errors.log only.
  const parsed = (text, what) => {
    try { return JSON.parse(text); } catch (error) { keep(what, `${error.message}\n${String(text).slice(0, 4096)}`); throw new Error(`${what} is not JSON`); }
  };
  const callerLabels = options.labels.flatMap((l) => ["--label", l]);
  const owned = ownedResources({ docker: ownDocker, runId, labels: callerLabels, clock, window, owner: ownerLabelKey, describe: firstLine });
  const mount = ["-v", `${join(repo, "bench")}:/bench:ro`];
  const upstreamName = `${runId}-upstream`;
  let network;
  const port = async (id) => {
    const hostPort = (await owned.inspect(id)).NetworkSettings?.Ports?.["8080/tcp"]?.[0]?.HostPort;
    assert.ok(hostPort, `${id}: no private host port`);
    return `http://127.0.0.1:${hostPort}`;
  };
  // The container run.mjs starts for a timed round (appArgs there), so a pass measures the same app.
  const appArgs = (name, source, image) => ["--network", network, ...cpus.app.args, "--memory", "1g", "-p", "127.0.0.1::8080",
    "-v", `${fixtureDir}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
    "-e", `API_BASE=http://${upstreamName}:8080`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`,
    ...(options.group ? ["--ulimit", "nofile=65536:65536", "-e", `PROFILE=${boundedQualificationSettings.nativeProfile}`, "-e", `MAX_CONNECTIONS=${boundedQualificationSettings.maxConnections}`] : []), image];
  // Removes each of a cell's containers, every one attempted; one not removed is kept in `left`.
  const settle = async (ids, left) => { for (const id of ids) if (id && !(await owned.remove(id))) left.push(id); };
  const state = (info) => ({ id: info.Id, startedAt: info.State.StartedAt, restartCount: info.RestartCount, running: info.State.Running, oomKilled: info.State.OOMKilled, exitCode: info.State.ExitCode });
  // run.mjs coldStart: the app is created, a sidecar waits for it, then the app starts and the
  // sidecar polls the target's own path until its first 200.
  async function coldStart(app, name, target, raw, left) {
    const path = target === "json" ? "/api/marketplace/item_1" : `/marketplace/${locales[0]}/item_1`;
    let probe;
    try {
      probe = await owned.container(["--network", network, ...cpus.load.args, "--memory", "256m", ...mount, nodeImage, "node", "/bench/catalog/cold.mjs", `http://${name}:8080`, path, String(options.startupTimeout)], `${name}-probe`);
      await owned.start(probe);
      retain(join(raw, "probe-container.json"), containerReceipt(await owned.inspect(probe)));
      const deadline = clock.now() + 10_000;
      while (!(await owned.logs(probe)).includes("catalog-probe-ready")) {
        if (interrupted()) throw new Error("interrupted");
        if (clock.now() > deadline) throw new Error("cold sidecar did not become ready");
        await clock.sleep(50);
      }
      await owned.start(app);
      const exit = await owned.docker(["wait", probe], { timeout: (options.startupTimeout + 5) * 1000 });
      const output = await owned.logs(probe);
      writeFileSync(join(raw, "cold.log"), output);
      // The probe's output is in cold.log; the record says only whether it exited 0.
      assert.ok(exit === "0", `cold probe ${/^\d{1,3}$/.test(exit) ? `exited ${exit}` : "returned no exit status"}; its output is in cold.log`);
      const result = parsed(output.split("\n").findLast((line) => line.startsWith("{")) ?? "", "the cold probe's result line");
      const info = await owned.inspect(app);
      const ms = Date.parse(result.first200At) - Date.parse(info.State.StartedAt);
      assert.ok(ms >= 0 && ms <= options.startupTimeout * 1000, "invalid Docker-host cold clock");
      retain(join(raw, "cold.json"), { ...result, path, first200MsFromContainerStart: ms, containerStartedAt: info.State.StartedAt });
    } finally { await settle([probe], left); }
  }
  // One adapter, source and target: a fresh container, the cold start, one long k6 pass. Before it
  // returns or throws, every container it made has been removed or is listed in `left`.
  async function pass(cell, imageId, raw, left) {
    const name = `${runId}-${cell.app}`;
    let sampler, app, k6;
    try {
      app = await owned.container(appArgs(name, cell.source, imageId), name);
      await coldStart(app, name, cell.target, raw, left);
      assert.equal(left.length, 0, "the cold sidecar was not removed");
      const before = await owned.inspect(app);
      retain(join(raw, "app-container.json"), containerReceipt(before));
      const k6Env = ["-e", `BASE=http://${name}:8080`, "-e", `TARGET=${cell.target}`, ...(cell.target === "page" ? ["-e", "LOCALE=rotating"] : []),
        "-e", `MODE=${convergence ? "closed" : "fixed"}`, "-e", `WINDOWS=${options.windows}`, "-e", `WINDOW_SECONDS=${options.windowSeconds}`,
        ...(convergence ? ["-e", `VUS=${options.vus}`] : ["-e", `RATE=${options.rate}`])];
      k6 = await owned.container(["--network", network, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount, ...k6Env,
        k6Image, "run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/window-load.js"], `${runId}-k6`);
      const phaseStartMs = clock.now();
      if (!convergence) sampler = memorySampler({ ids: [app], file: join(raw, "stats.log"), seconds: seconds + 120, spawn: spawnStats, now: clock.now, ...statsBounds });
      await owned.inspect(k6);
      // The memory samples' origin, on the same workstation clock as their own stamps (soakMemoryClock).
      const memoryOriginMs = clock.now();
      await owned.docker(["start", "-a", k6], { timeout: (seconds + 60) * 1000, file: join(raw, "load.log") });
      let stats, statsError;
      if (sampler) { try { stats = await sampler.stop(); } catch (e) { statsError = e; } }
      const loadInfo = await owned.inspect(k6);
      retain(join(raw, "load-container.json"), containerReceipt(loadInfo));
      assert.equal(loadInfo.State.ExitCode, 0, "k6 exited with an error");
      let k6Summary;
      try { k6Summary = await retainLoadEvidence(owned.docker, k6, raw, "load"); } catch (error) {
        keep("retaining the k6 summary export", error); throw new Error("the k6 summary export could not be retained or is not JSON");
      }
      // Only names window-load.js and k6 define, before any validator can quote one.
      knownK6Metrics(k6Summary);
      // The engine clock must cover the pass inside the container's own run, and every counter's
      // rate must be its count over that clock, as validate.mjs requires of a timed phase.
      validateLoadExecution({ load: containerReceipt(loadInfo), summary: k6Summary, clock: parsed(readFileSync(join(raw, "load-clock.json"), "utf8"), "the k6 engine clock export"), start: phaseStartMs, end: clock.now(), seconds });
      // k6's aggregate: every request, including those answered during the graceful stop.
      const load = readLoadSummary(k6Summary);
      const { windows, tail, unrecorded, requests, iterations } = readWindows(k6Summary, options);
      const after = await owned.inspect(app);
      retain(join(raw, "app-container-after.json"), containerReceipt(after));
      if (convergence) {
        // A failed answer can be faster than a served one, so throughput with failures says nothing
        // about warming: a failure anywhere, in a window or in the graceful stop, means no verdict.
        heldThrough(before, after);
        const inWindows = windows.reduce((sum, w) => sum + w.failed, 0);
        assert.equal(inWindows, 0, `${inWindows} requests failed in the pass's windows; no verdict`);
        assert.equal(load.failed, 0, `${load.failed} requests failed in k6's aggregate, which includes the graceful stop; no verdict`);
        return Object.assign(cell, { windows, tail, unrecorded, requests, iterations, failedRequests: load.failed, verdict: flattenPoint(windows) });
      }
      if (statsError) { keep("memory samples", statsError); throw new Error(`memory samples failed: ${firstLine(statsError)}`); }
      const startedMs = Date.parse(loadInfo.State.StartedAt);
      const samples = stats.samples[app].map((s) => ({ atSeconds: (s.t - memoryOriginMs) / 1000, mib: s.mem }));
      // Docker's event times and StartedAt are both the daemon's clock.
      const lines = await owned.docker(["events", "--since", String(phaseStartMs / 1000), "--until", String(Date.now() / 1000), "--filter", "type=container", "--filter", `container=${app}`, "--format", "{{.Action}}|{{.TimeNano}}"]);
      const events = lines.split("\n").filter(Boolean).map((line) => ({ action: line.slice(0, line.lastIndexOf("|")), atSeconds: (Number(line.slice(line.lastIndexOf("|") + 1)) / 1e6 - startedMs) / 1000 }));
      retain(join(raw, "events.json"), events);
      return Object.assign(cell, summarizeSoak({ windows, tail, unrecorded, requests, iterations, memory: samples, before: state(before), after: state(after), events, rate: options.rate,
        droppedIterations: readDropped(k6Summary), failedRequests: load.failed }));
    } finally {
      if (sampler) { try { await sampler.stop(); } catch {} }
      if (app) { try { writeFileSync(join(raw, "app.log"), await owned.logs(app)); } catch (e) { log(`${cell.app} ${cell.source} ${cell.target}: app log unavailable: ${e.message}`); } }
      await settle([k6, app], left);
    }
  }
  // The pinned k6 image's provenance (load-tool.mjs k6Provenance): its version is read from a
  // container created, attached and removed through ownedResources, so it is owned and accounted
  // for like every other.
  async function k6Tool() {
    let image;
    try { image = parsed(await owned.docker(["image", "inspect", k6Image]), "docker image inspect of k6")[0]; } catch {
      await owned.docker(["pull", k6Image], { timeout: 5 * 60 * 1000, file: join(folder, "pull-k6.log") });
      image = parsed(await owned.docker(["image", "inspect", k6Image]), "docker image inspect of k6")[0];
    }
    assert.match(image?.Id ?? "", /^sha256:[a-f0-9]{64}$/, "missing k6 image ID");
    let probe, output;
    try {
      probe = await owned.container(["--network", "none", image.Id, "version"], `${runId}-k6-version`);
      output = await owned.attach(probe, 60_000);
    } finally { if (probe) assert.ok(await owned.remove(probe), "the k6 version probe was not removed"); }
    return k6Provenance(image, output);
  }

  try {
    save();
    summary.commit = await git(["rev-parse", "HEAD"]);
    summary.dirty = (await git(["status", "--porcelain", "--untracked-files=normal"])).length > 0;
    assert.ok(!summary.dirty, "a convergence or soak pass requires a clean committed checkout");
    // The fixture every app container mounts, checked as run.mjs checks it before a timed round.
    summary.fixtureSha256 = fixture();
    summary.host.docker = await owned.docker(["version", "--format", "{{.Server.Version}}"]);
    summary.host.node = process.version;
    let hostText, hostProbe;
    try {
      hostProbe = await owned.container(["--network", "none", nodeImage, "sh", "-c", "uname -r; grep -m1 'model name' /proc/cpuinfo; cat /sys/devices/system/cpu/online"], `${runId}-host`);
      hostText = await owned.attach(hostProbe, 60_000);
    } finally { if (hostProbe) assert.ok(await owned.remove(hostProbe), "the host probe was not removed"); }
    writeFileSync(join(folder, "host.txt"), hostText + "\n");
    const hostLines = hostText.trim().split("\n").map((line) => line.trim());
    // The kernel the containers run on: run.mjs records the droplet's os.release(), the same kernel.
    summary.host.kernel = hostLines[0] || null;
    summary.host.cpu = hostLines.find((line) => line.startsWith("model name"))?.split(":").slice(1).join(":").trim() ?? null;
    summary.host.onlineCpus = hostLines.at(-1) || null;
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
        await owned.docker(["build", "--label", `run.corten.marketplace.commit=${summary.commit}`, "--label", "run.corten.marketplace.dirty=false",
          ...(options.group ? ["--label", `run.corten.marketplace.profile=${boundedFeatureProfile}`, "--build-arg", `PROFILE=${boundedQualificationSettings.nativeProfile}`] : []),
          "-t", image, "-f", dockerfile, context], { timeout: 60 * 60 * 1000, file: join(folder, `build-${app}.log`) });
        assert.equal(await git(["rev-parse", "HEAD"]), summary.commit, "HEAD changed during image build");
        assert.equal(await git(["status", "--porcelain"]), "", "checkout changed during image build");
      }
      const info = parsed(await owned.docker(["image", "inspect", image]), `docker image inspect of ${image}`)[0];
      imageProvenance(info.Config.Labels, summary.commit, false);
      if (options.group) assert.equal(info.Config.Labels["run.corten.marketplace.profile"], boundedFeatureProfile, "image lacks the required feature profile; rebuild with --build");
      images[app] = imageReceipt(info);
    }
    retain(join(folder, "images.json"), images);
    // The image IDs a timed round records too (summary.apps[app].imageId): report.mjs compares them.
    summary.images = Object.fromEntries(options.apps.map((app) => [app, images[app].id]));
    save();
    summary.tools = { k6: await k6Tool() };
    network = await owned.network(`${runId}-net`);
    const upstreamId = await owned.container(["--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
      "-v", `${fixtureDir}:/fixtures:ro`, nodeImage, "node", "/bench/marketplace/upstream.mjs"], upstreamName);
    await owned.start(upstreamId);
    const upstreamInfo = await owned.inspect(upstreamId);
    retain(join(folder, "upstream-container.json"), containerReceipt(upstreamInfo));
    summary.tools.upstream = { image: nodeImage, imageId: upstreamInfo.Image };
    await upstreamReady(`${await port(upstreamId)}/health`);
    save();
    for (const source of options.sources) for (const app of options.apps) for (const target of options.targets) {
      const cell = { app, source, target };
      summary.cells.push(cell);
      const raw = join(folder, source, app, target);
      mkdirSync(raw, { recursive: true });
      log(`${options.kind} ${app} ${source} ${target}: cold start, then ${options.minutes} min in ${options.windowSeconds}s windows`);
      const left = [], unacknowledged = owned.record.unacknowledged.length;
      try {
        if (interrupted()) throw new Error("interrupted");
        await pass(cell, images[app].id, raw, left);
        if (convergence) log(`${app} ${source} ${target}: ${verdictText(cell.verdict)}`);
      } catch (e) {
        // This cell has no verdict; the pass goes on to the next one if its containers are gone.
        for (const key of Object.keys(cell)) if (!["app", "source", "target"].includes(key)) delete cell[key];
        keep(`${app} ${source} ${target}`, e);
        cell.failure = firstLine(e);
        if (convergence) cell.verdict = null;
        log(`${app} ${source} ${target} FAILED: ${cell.failure}`);
      }
      save();
      const unsettled = [...left.map((id) => `container ${id} was not removed`),
        ...owned.record.unacknowledged.slice(unacknowledged).map((a) => `the create of ${a.name} was not acknowledged`)];
      if (unsettled.length) throw new Error(`${app} ${source} ${target} did not settle (${unsettled.join("; ")}), so no further cell is measured`);
    }
    summary.finishedCommit = await git(["rev-parse", "HEAD"]);
    assert.equal(summary.finishedCommit, summary.commit, "checkout moved during the pass");
    assert.equal(await git(["status", "--porcelain"]), "", "checkout changed during the pass");
    summary.complete = !interrupted();
  } catch (e) {
    keep("suite", e);
    summary.failures.push({ stage: "suite", error: firstLine(e) });
    log(`suite FAILED: ${firstLine(e)} (detail in errors.log)`);
  } finally {
    let cleanup;
    try { cleanup = await owned.teardown(); } catch (e) { keep("teardown", e); cleanup = { ...owned.record, complete: false, failures: [...owned.record.failures, { resource: runId, error: firstLine(e) }] }; }
    retain(join(folder, "cleanup.json"), cleanup);
    summary.cleanupFailures = cleanup.failures;
    // What a saved reader checks before it counts the pass (steady-contract.mjs passEvidence).
    summary.cleanup = { complete: cleanup.complete === true, remaining: cleanup.remaining ?? null, created: cleanup.created.length, removed: cleanup.removed.length, recovered: cleanup.recovered.length,
      unacknowledged: cleanup.unacknowledged.map((a) => ({ name: a.name, label: a.label, outcome: a.outcome ?? "unconfirmed" })) };
    summary.finishedAt = new Date().toISOString();
    summary.complete &&= !interrupted() && summary.failures.length === 0 && cleanup.complete === true;
    save();
  }
  log(`marketplace ${options.kind} ${options.name}: ${summary.complete ? "COMPLETE" : "INCOMPLETE"}${summary.cleanupFailures.length ? `; cleanup not confirmed: ${summary.cleanupFailures.map((f) => f.resource).join(", ")}` : ""}; ${join(folder, "summary.json")}`);
  return summary;
}
