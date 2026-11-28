// Independent catalog-v1 baseline. Never invokes fullstack runners, trend, nightly, or cleanup.
// node bench/catalog/run.mjs c1 [--apps corten,nextjs] [--build] [--check-only] [--passes 3]
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPeers } from "../fullstack/inventory.mjs";
import { sampleStats } from "./stats.mjs";
import { commandRunner, failureReceipt, ownedContainer } from "./output.mjs";
import { readFailedCheck } from "./check-result.mjs";
import { describeK6, k6Image } from "../load-tool.mjs";
import { collectTimedPhase, verifyTimedPhase } from "./timed.mjs";
import { apparatus, digest, sourceProof, workerCommand, workerRawSchema } from "./apparatus.mjs";
import { admission, preflightArtifacts, preflightBinding, preflightCases, preflightSchema, requiredRoundArtifacts } from "./preflight.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The shared registry's pageApps is the inventory, not its BENCH_APPS/BENCH_TIER
// selection. Restore the caller's environment immediately after importing it.
const saved = Object.fromEntries(["BENCH_APPS", "BENCH_TIER"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(saved)) delete process.env[key];
let inventory, contract, grouping, observations;
try {
  // Group contracts also import the registry: load them inside the same environment
  // boundary so ESM caching cannot capture a historical tier/subset inventory.
  contract = await import("./contract.mjs");
  grouping = await import("./group.mjs");
  inventory = (await import("../fullstack/apps.mjs")).pageApps;
  if (process.argv.includes("--group")) inventory = { ...inventory, ...catalogPeers };
  observations = await import("./raw.mjs");
}
finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
const { aggregate, cpuSettings, imageBuildTimeoutMs, probeCpu, leanApps, leanProfile, parseArgs, phases, readLoad, sources, targets,
  validateCatalog, verifyDocumentHeaderChecks, workload } = contract;
const { groupDescriptor, groupResultSchema, qualificationIdentity, timingPlan } = grouping;
const { containerEvidence, rawSchema, verifyFailedCheck, verifyCheckBoundary, checkBoundaryEvidence, imageCommandEvidence } = observations;
const options = parseArgs(process.argv.slice(2), inventory);
const group = options.group === undefined ? null : groupDescriptor(options.group);
const effectiveLeanApps = contract.recordedLeanApps({ group });
const plan = timingPlan(options, sources, targets);
const loadLayout = process.env.CATALOG_LOAD_LAYOUT;
if (loadLayout !== undefined) assert.equal(options.group, "catalog-page", "generator qualification requires the catalog-page group");
const cpus = cpuSettings(process.env, loadLayout);
const probeCpus = probeCpu({ cpus, loadLayout });
const runId = `catalog-${options.round}-${randomBytes(5).toString("hex")}`;
const network = `${runId}-net`;
const label = "run.corten.catalog";
const folder = join(here, "results", options.round);
mkdirSync(join(here, "results"), { recursive: true });
// Atomic reservation: another invocation or an old failed run cannot be overwritten.
mkdirSync(folder);
const summary = { workload, round: options.round, runId, options, startedAt: new Date().toISOString(), complete: false, checksPassed: false, failures: [], cleanupFailures: [], apps: {}, host: { hostname: hostname(), platform: platform(), release: release() },
  scope: "catalog rendering/JSON load only; fullstack bytes, build-cost, instructions and browser-timing measurements are not ported",
  measurement: { cpus, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, encoding: "identity", fixedRate: options.rate,
    upstream: "single Node process, even with a two-CPU quota; high upstream CPU can limit API-mode throughput; closed-loop VUs alone do not prove app saturation",
    cpuWindow: "cgroup v2 usage_usec before/after docker start -a of k6; includes small Docker command/idle windows, not only HTTP handler CPU", coldClock: "Docker-host container StartedAt to first complete 200, not process exec",
    leanProfile: { name: leanProfile, apps: effectiveLeanApps } } };
summary.host.checkout = repo.replaceAll("\\", "/").replace(/\/$/, "");
if (loadLayout !== undefined) summary.measurement.loadLayout = loadLayout;
// Ungrouped runs header-check only the lean contenders (check.mjs); record that scope so
// reports never present the mixed run as a feature-parity comparison.
if (!group) summary.measurement.documentHeaders = { contract: groupDescriptor("catalog-page").documentHeaders, apps: [...effectiveLeanApps] };
if (group) Object.assign(summary, { schema: groupResultSchema, group,
  scope: "catalog-page group: page-only cold/warmup/load timing in both sources; native page AND JSON correctness gates retained; no browser timing, build-cost, bytes or instruction measurements" });
if (group) Object.assign(summary.measurement, { apparatus,
  upstream: "two fixed request workers plus coordinator in the unchanged two-CPU/512-MiB budget; no respawn; skew and aggregate headroom independently checked" });
const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
const log = (message) => { const line = `${new Date().toISOString()} ${message}`; console.log(line); appendFileSync(join(folder, "run.log"), `${line}\n`); };
const active = new Set();
let interrupted = false;
const runner = commandRunner({ cwd: repo, interrupted: () => interrupted });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; runner.interrupt(); });
const command = runner.command;
const docker = (args, opts) => command("docker", args, opts);
const inspect = async (name, cleanup = false) => JSON.parse(await docker(["inspect", name], { cleanup }))[0];
const fail = (app, source, stage, error) => {
  const failure = { app, source, stage, error: error.stack ?? String(error) };
  summary.failures.push(failure);
  if (app && summary.apps[app]) (summary.apps[app].failures ??= []).push(failure);
  log(`${app ?? "suite"} ${source ?? ""} ${stage} FAILED: ${error.message ?? error}`);
  save();
};
const owned = async (args, name, opts) => {
  active.add(name);
  await docker([args[0], "--name", name, "--label", `${label}=${runId}`, ...args.slice(1)], opts);
  return name;
};
const ownedByRun = (labels) => labels?.[label] === runId;
// A failed bounded command saves its receipt BEFORE owned cleanup removes the container.
// `verified` is the one ownership check that command relied on; the receipt never re-resolves the name.
// Saving and reporting it are best effort: they never replace or clear the failure itself.
async function saveReceipt(path, stage, name, error, verified, fresh = false) {
  try {
    if (typeof verified === "function") verified = await verified();
    writeFileSync(path, JSON.stringify(await failureReceipt(docker, { stage, container: name, error, verified, owned: ownedByRun, fresh }), null, 2));
    log(`${stage} failure receipt: ${path}`);
  } catch (e) { try { log(`${stage} failure receipt not saved: ${e?.message ?? e}`); } catch {} }
}
// Receipts cover these detached parity and preflight starts and the log collections below,
// not the measured cold-start create and start.
async function startApp(args, name, receipt) {
  try { return await owned(["run", "-d", ...args], name, { receipt: true }); }
  catch (e) {
    // Nothing checked this container before its start failed, so the receipt's check is the only
    // one, and its inspect snapshot is the receipt's state (`fresh`): nothing is inspected twice.
    await saveReceipt(receipt, "app start", name, e, () => ownedContainer((args) => docker(args, { cleanup: true, timeout: 10000 }), name, ownedByRun), true);
    throw e;
  }
}
// Logs come only from the container this run owns, by its immutable ID, never by a name
// another container could hold. Its one ownership check also binds the failure receipt, and a
// missing or foreign container gets a receipt with the refusal.
async function collectLogs(name, file, stage, opts = {}) {
  let found = { refusal: "not inspected" };
  try {
    found = await ownedContainer((args) => docker(args, { cleanup: opts.cleanup }), name, ownedByRun);
    if (!found.id) throw new Error(`refusing ${stage} from ${name}: ${found.refusal}${found.problem ? ` (${found.problem})` : ""}`);
    await docker(["logs", found.id], { file, capture: false, receipt: true, ...opts });
  } catch (e) { await saveReceipt(`${file}.failure.json`, stage, name, e, found); throw e; }
}
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
// One startup log per failed start, so each receipt's bytes and hash describe its own file.
const startupAttempts = new Map();
async function portOf(name) {
  const info = await inspect(name);
  const port = info.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
  if (!info.State.Running || !port) {
    const attempt = (startupAttempts.get(name) ?? 0) + 1;
    startupAttempts.set(name, attempt);
    const file = join(folder, `${name}-startup-${attempt}.log`);
    await collectLogs(name, file, "startup logs");
    throw new Error(`${name}: native startup failed; state=${JSON.stringify(info.State)}\n${readFileSync(file, "utf8")}`);
  }
  return `http://127.0.0.1:${port}`;
}
const fixtureDir = join(here, "fixtures");
const nodeImage = observations.upstreamImage;
const mount = ["-v", `${join(repo, "bench")}:/bench:ro`];
const upstreamName = `${runId}-upstream`;
const cpuName = `${runId}-cpu`;
const apiBase = `http://${upstreamName}:8080`;
let upstreamBase;
async function upstreamControl(value) {
  const response = await fetch(`${upstreamBase}/__catalog/${value?.observation ? "observe" : "control"}`, { method: value === undefined ? "GET" : "POST",
    ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, "upstream worker administration failed");
  return response.json();
}
function appArgs(name, source, image) {
  const app = name.slice(`${runId}-`.length);
  return ["--network", network, ...cpus.app.args, "--memory", "1g", "-p", "127.0.0.1::8080",
    "-v", `${fixtureDir}:/fixtures:ro`, "-e", `CATALOG_SOURCE=${source}`, "-e", "CATALOG_FIXTURE_PATH=/fixtures/catalog.json",
    "-e", `API_BASE=${apiBase}`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`,
    ...(leanApps.includes(app) ? ["-e", `PROFILE=${leanProfile}`] : []), image];
}
async function ready(base) {
  const deadline = Date.now() + options.startupTimeout * 1000;
  let last = "no response";
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("interrupted");
    try {
      const response = await fetch(`${base}/catalog/record_1`, { redirect: "manual", signal: AbortSignal.timeout(1000) });
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
  const path = `${target === "json" ? "/api" : ""}/catalog/record_1`;
  try {
    await owned(["run", "-d", "--network", network, ...probeCpus.args, "--memory", "256m", ...mount, nodeImage, "node", "/bench/catalog/cold.mjs", `http://${name}:8080`, path, String(options.startupTimeout)], probe);
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
    if (loadLayout === "c16-generator-v1") {
      const observed = await inspect(probe);
      writeFileSync(join(raw, "cold-probe.json"), JSON.stringify({ ...containerEvidence(observed),
        name: observed.Name, command: observed.Config.Cmd, finishedAt: observed.State.FinishedAt }, null, 2));
    }
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
  return { ids: Object.fromEntries(ids), values: Object.fromEntries(ids.map(([name, id]) => { assert.ok(Number.isSafeInteger(usage[id]), "missing CPU counter"); return [name, usage[id]]; })) };
}
async function load(name, target, phase, seconds, raw) {
  if (group) return collectTimedPhase({ summary, raw, docker, owned, inspect, remove, cpu, sampleStats, cpus, mount, k6Image, upstreamControl }, {
    app: name.slice(`${runId}-`.length), source: summary.currentSource, target, phase, seconds,
    instance: JSON.parse(readFileSync(join(raw, "container.json"), "utf8")),
  });
  const container = `${runId}-k6`;
  const output = join(raw, `${phase}.json`);
  const env = ["-e", `BASE=http://${name}:8080`, "-e", `TARGET=${target}`, "-e", `DURATION=${seconds}s`, "-e", `MODE=${phase === "fixed" ? "fixed" : "closed"}`,
    "-e", `RATE=${options.rate}`, "-e", `VUS=${phase === "sat256" ? 256 : phase === "warmup" ? 32 : 64}`];
  const samples = phase === "warmup" ? [] : [name, ...(summary.currentSource === "api" ? [upstreamName] : [])];
  let before = {};
  let after = {};
  let sampler;
  let runError;
  let stats;
  let identities = {};
  let startedAt, finishedAt;
  try {
    await owned(["create", "--network", network, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount, ...env,
      k6Image, "run", "--quiet", "--summary-export", "/tmp/catalog-summary.json", "/bench/catalog/load.js"], container);
    if (samples.length) { startedAt = Date.now(); const observed = await cpu(samples); before = observed.values; identities = observed.ids; }
    sampler = samples.length ? sampleStats(samples, join(raw, `${phase}-stats.log`), seconds + 35) : null;
    await docker(["start", "-a", container], { timeout: (seconds + 25) * 1000, file: join(raw, `${phase}.log`) });
  } catch (e) { runError = e; }
  finally {
    try { if (sampler) stats = await sampler.stop(); } catch (e) { runError ??= e; }
  }
  try { if (samples.length && Object.keys(before).length) {
    const observed = await cpu(samples);
    assert.deepEqual(observed.ids, identities, "CPU counter container identity changed");
    after = observed.values;
    finishedAt = Date.now();
  } }
  catch (e) { runError ??= e; }
  try {
    // Preserve failed k6 summaries as well as stderr. An absent summary never passes.
    try { await docker(["cp", `${container}:/tmp/catalog-summary.json`, output]); }
    catch (e) { runError ??= e; }
    const counters = Object.fromEntries(samples.filter((n) => before[n] !== undefined && after[n] !== undefined).map((n) => { assert.ok(after[n] >= before[n], "CPU counter moved backwards"); return [n, { usec: after[n] - before[n] }]; }));
    writeFileSync(join(raw, `${phase}-cpu.json`), JSON.stringify(counters, null, 2));
    if (samples.length) writeFileSync(join(raw, `${phase}-cpu-counters.json`), JSON.stringify({ ids: identities, before, after, startedAt, finishedAt }, null, 2));
    if (runError) throw runError;
    const metrics = readLoad(JSON.parse(readFileSync(output, "utf8")));
    if (samples.length) {
      assert.ok(counters[name].usec > 0, "phase used no CPU");
      Object.assign(metrics, stats[name], { cpuUsec: counters[name].usec, perCpuSecond: metrics.requests / (counters[name].usec / 1e6), upstream: counters[upstreamName] ? { ...stats[upstreamName], cpuUsec: counters[upstreamName].usec,
        highCpu: stats[upstreamName].cpuAvgPct >= 80, interpretation: "single-process upstream; a busy API may be the throughput limit, not the app" } : null });
    }
    return metrics;
  } finally { await remove(container); }
}

let suiteStage = "suite";
try {
  save();
  summary.commit = await command("git", ["rev-parse", "HEAD"]);
  summary.dirty = (await command("git", ["status", "--porcelain"])).length > 0;
  summary.host.docker = await docker(["version", "--format", "{{.Server.Version}}"]);
  summary.host.node = process.version;
  const fixture = readFileSync(join(fixtureDir, "catalog.json"));
  const catalog = validateCatalog(JSON.parse(fixture));
  const generated = (await import("./fixtures.mjs")).records();
  assert.deepEqual(catalog, generated, "generated fixture is stale: run node bench/catalog/fixtures.mjs");
  summary.fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
  summary.savedEvidence = { schema: group ? workerRawSchema : rawSchema, fixtureSha256: summary.fixtureSha256 };
  if (group) {
    const proof = JSON.stringify(sourceProof(summary.commit), null, 2);
    writeFileSync(join(folder, "apparatus-source.json"), proof);
    summary.savedEvidence.apparatusSourceSha256 = digest(proof);
  }
  if (group) summary.targetFailures = [];
  writeFileSync(join(folder, "fixture.json"), fixture);
  for (const app of options.apps) {
    const entry = summary.apps[app] = { label: inventory[app].label, image: `cb-catalog-${app}`, checks: {}, runs: {}, phases: {} };
    try {
      if (options.build) {
        log(`building ${app}`);
        const context = app === "corten" ? repo : join(repo, "bench/fullstack/apps", app);
        const dockerfile = app === "corten" ? join(here, "corten/Dockerfile") : join(context, "Dockerfile");
        await docker(["build", "-t", entry.image, "-f", dockerfile, ...(app === "corten" ? ["--build-arg", "CATALOG_LEAN=1"] : []), context], { timeout: imageBuildTimeoutMs, file: join(folder, `build-${app}.log`) });
      }
      const image = JSON.parse(await docker(["image", "inspect", entry.image]))[0];
      entry.imageId = image.Id;
      entry.imageBytes = image.Size;
      entry.imageExecution = imageCommandEvidence(image);
      writeFileSync(join(folder, `image-${app}.json`), JSON.stringify({ imageId: image.Id, imageBytes: image.Size,
        commit: summary.commit, built: options.build, execution: entry.imageExecution }, null, 2));
    } catch (e) { fail(app, null, "build/image", e); }
    save();
  }
  await docker(["network", "create", "--label", `${label}=${runId}`, network]);
  summary.networkCreated = true;
  suiteStage = "upstream preparation";
  await owned(["create", "--pull=missing", "--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
    "-v", `${fixtureDir}:/fixtures:ro`, nodeImage, ...(group ? workerCommand : ["node", "/bench/catalog/upstream.mjs"])], upstreamName,
    { timeout: 10 * 60 * 1000, file: join(folder, "prepare-upstream.log"), capture: false });
  suiteStage = "upstream startup";
  await docker(["start", upstreamName]);
  const upstreamImageId = (await inspect(upstreamName)).Image;
  const upstreamImageInfo = JSON.parse(await docker(["image", "inspect", upstreamImageId]))[0];
  assert.equal(upstreamImageInfo.Id, upstreamImageId);
  summary.tools = { upstream: { image: nodeImage, imageId: upstreamImageId, execution: imageCommandEvidence(upstreamImageInfo) } };
  const upstream = await portOf(upstreamName);
  upstreamBase = upstream;
  const upstreamDeadline = Date.now() + 20000;
  while (true) {
    try { const response = await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(1000) }); await response.text(); if (response.ok) break; } catch {}
    if (Date.now() > upstreamDeadline) throw new Error("catalog upstream did not start");
    await sleep(100);
  }
  suiteStage = "suite";
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@playwright/test"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "Playwright must have a pinned image-compatible version");
  const checkerImage = `mcr.microsoft.com/playwright:v${version}-noble`;
  let checker;
  try { checker = JSON.parse(await docker(["image", "inspect", checkerImage]))[0]; }
  catch {
    await docker(["pull", checkerImage], { timeout: 10 * 60 * 1000, file: join(folder, "pull-checker.log") });
    checker = JSON.parse(await docker(["image", "inspect", checkerImage]))[0];
  }
  summary.tools.checker = { image: checkerImage, imageId: checker.Id, execution: imageCommandEvidence(checker), isolation: "owned PID namespace/cgroup; force-removed in finally, independent of Node/browser process groups" };
  writeFileSync(join(folder, "tools.json"), JSON.stringify(summary.tools, null, 2));
    for (const source of sources) for (const app of options.apps) {
      const entry = summary.apps[app];
      if (!entry.imageId) continue;
      const name = `${runId}-${app}`;
      const out = join(folder, source, app);
      const checkContainer = `${name}-check`;
      mkdirSync(out, { recursive: true });
      try {
        log(`checking ${app} ${source}`);
        await startApp(appArgs(name, source, entry.imageId), name, join(out, "app-start.failure.json"));
        const base = await portOf(name);
        await ready(base);
        // Chromium starts a separate process group. A host Node/group kill cannot
        // reliably reap it, so timeout cleanup removes its entire owned PID namespace.
        // Share ONLY the app's network namespace, not its PID namespace: loopback
        // stays a trustworthy browser origin without disabling security features.
        const workerBefore = group ? await upstreamControl() : undefined;
        await owned(["create", "--network", `container:${name}`, ...probeCpus.args, "--memory", "2g", "--shm-size", "1g", "-v", `${repo}:/repo:ro`, "-v", `${out}:/results`,
          "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", checker.Id, "node", "/repo/bench/catalog/check.mjs", "http://127.0.0.1:8080", source, apiBase,
          "/results/checks.json", ...(leanApps.includes(app) ? [app] : [])], checkContainer);
        let checkerFailure, boundary;
        try { await docker(["start", "-a", checkContainer], { timeout: 15 * 60 * 1000, file: join(out, "checks.log") }); }
        catch (error) { checkerFailure = error; }
        finally {
          try {
            boundary = { checker: checkBoundaryEvidence(await inspect(checkContainer)), runtime: checkBoundaryEvidence(await inspect(name)), upstream: checkBoundaryEvidence(await inspect(upstreamName)),
              exit: checkerFailure ? checkerFailure.exit : { code: 0, signal: null, expired: false, interrupted: false },
              ...(group ? { workerBefore, workerAfter: await upstreamControl() } : {}) };
            writeFileSync(join(out, "checker.json"), JSON.stringify(boundary, null, 2));
          } finally { await remove(checkContainer); }
        }
        let checked;
        if (checkerFailure) {
          checked = readFailedCheck(join(out, "checks.json.failure.json"), checkerFailure, (failure) => {
            verifyFailedCheck(failure, source); verifyCheckBoundary(boundary, summary, app, source, true);
          });
          writeFileSync(join(out, "checks.json"), JSON.stringify(checked, null, 2));
        } else checked = JSON.parse(readFileSync(join(out, "checks.json"), "utf8"));
        if (!checked.failure && leanApps.includes(app)) verifyDocumentHeaderChecks(checked.documentHeaders, catalog, source);
        if (group) {
          checked.qualification = qualificationIdentity(group, app, source, entry.imageId);
          writeFileSync(join(out, "qualification.json"), JSON.stringify(checked, null, 2));
        }
        entry.checks[source] = checked;
        if (!checked.failure) {
          assert.equal(checked.jsonRecords, 500, "incomplete JSON checks");
          assert.equal(checked.profiles.length, 8, "incomplete browser profiles");
        }
      } catch (e) { fail(app, source, "checks", e); }
      finally {
        if (active.has(checkContainer)) await remove(checkContainer);
        try { await collectLogs(name, join(out, "app.log"), "app logs"); } catch (e) { fail(app, source, "app logs", e); }
        await remove(name);
      }
      save();
    }
  const targetFailed = Object.values(summary.apps).some((entry) => Object.values(entry.checks).some((check) => check.failure));
  summary.checksPassed = summary.failures.length === 0 && !targetFailed;
  if (targetFailed) summary.timingDisposition = "gated-functional";
  save();
  if (summary.failures.length) throw new Error("parity failed; no app will be load-tested");
  if (summary.checksPassed && !options.checkOnly) {
    summary.tools.k6 = await describeK6(docker, ["--label", `${label}=${runId}`], { pullLog: join(folder, "pull-k6.log") });
    if (group) summary.tools.k6Execution = imageCommandEvidence(JSON.parse(await docker(["image", "inspect", summary.tools.k6.imageId]))[0]);
    writeFileSync(join(folder, "tools.json"), JSON.stringify(summary.tools, null, 2));
    await owned(["run", "-d", "--network", "none", "--cpus", "1", ...(probeCpus.cpuset ? ["--cpuset-cpus", probeCpus.cpuset] : []), "--memory", "128m", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", ...mount,
      nodeImage, "node", "-e", "setInterval(() => {}, 1000)"], cpuName);
    if (group) {
      const receipt = { schema: preflightSchema, binding: preflightBinding(summary), passed: false, hashes: {}, cleanup: null };
      try {
        for (const subject of preflightCases) {
          const name = `${runId}-corten`, raw = join(folder, "preflight", subject.source);
          mkdirSync(raw, { recursive: true });
          try {
            await startApp(appArgs(name, subject.source, summary.apps.corten.imageId), name, join(raw, "app-start.failure.json"));
            await ready(await portOf(name));
            const instance = containerEvidence(await inspect(name));
            writeFileSync(join(raw, "container.json"), JSON.stringify(instance, null, 2));
            for (const phase of ["warmup", "sat256"]) {
              const timedSubject = { ...subject, phase, seconds: phase === "warmup" ? options.warmup : options.duration, instance };
              log(`apparatus preflight corten ${subject.source} ${phase}`);
              await collectTimedPhase({ summary, raw, docker, owned, inspect, remove, cpu, sampleStats, cpus, mount, k6Image, upstreamControl }, timedSubject);
              admission(summary, verifyTimedPhase(summary, timedSubject, {
                readJson: (key) => JSON.parse(readFileSync(join(raw, key), "utf8")), readText: (key) => readFileSync(join(raw, key), "utf8"),
              }));
            }
          } finally { await remove(name); }
        }
        const containers = (await docker(["ps", "-a", "--filter", `name=^/${runId}-corten$`, "--format", "{{.ID}}"])).split("\n").filter(Boolean);
        receipt.cleanup = { containers }; assert.equal(containers.length, 0, "preflight app remains");
        for (const key of preflightArtifacts()) receipt.hashes[key] = digest(readFileSync(join(folder, key)));
        receipt.passed = true;
      } catch (e) { receipt.error = e.message; throw e; }
      finally { writeFileSync(join(folder, "preflight.json"), JSON.stringify(receipt, null, 2)); }
    }
    for (const { app, pass, source, target, ...profile } of plan) {
      const entry = summary.apps[app];
      const name = `${runId}-${app}`;
      const key = `${source}-${target}`;
      const raw = join(folder, source, app, `p${pass}-${target}`);
      mkdirSync(raw);
      const run = { pass, complete: false, phases: {} };
      if (group) run.evidence = { app, ...profile, source, target, imageId: entry.imageId };
      (entry.runs[key] ??= []).push(run);
      summary.currentSource = source;
      try {
        log(`cold ${app} ${source} ${target} pass ${pass}`);
        run.cold = await coldStart(name, source, target, entry.imageId, raw);
        writeFileSync(join(raw, "container.json"), JSON.stringify(containerEvidence(await inspect(name)), null, 2));
        log(`warmup ${app} ${source} ${target} pass ${pass}`);
        run.warmup = await load(name, target, "warmup", options.warmup, raw);
        for (const phase of phases) {
          log(`${app} ${source} ${target} ${phase} pass ${pass}`);
          run.phases[phase] = await load(name, target, phase, options.duration, raw);
          if (group && run.phases[phase].outcome === "failed") summary.targetFailures.push({ app, source, target, pass, phase,
            failed: run.phases[phase].failed, timeouts: run.phases[phase].timeouts, httpErrors: run.phases[phase].httpErrors, dropped: run.phases[phase].dropped });
          save();
        }
        run.complete = true;
        if (group) run.outcome = phases.some((phase) => run.phases[phase].outcome === "failed") ? "failed" : "passed";
      } catch (e) { run.failed = e.message; fail(app, source, `load ${target} pass ${pass}`, e); }
      finally {
        try { await collectLogs(name, join(raw, "app.log"), "app logs"); } catch (e) { fail(app, source, "app logs", e); }
        await remove(name);
      }
      for (const phase of phases) {
        const runs = entry.runs[key].filter((r) => r.phases[phase]).map((r) => r.phases[phase]);
        (entry.phases[key] ??= {})[phase] = { ...aggregate(runs), asked: options.passes };
      }
      save();
    }
  }
  summary.complete = summary.checksPassed && summary.failures.length === 0 && !(summary.targetFailures?.length);
  if (group && summary.checksPassed && !options.checkOnly) summary.attemptComplete = summary.failures.length === 0
    && Object.values(summary.apps).every((entry) => Object.values(entry.runs).every((runs) => runs.length === options.passes && runs.every((r) => r.complete)));
} catch (e) { fail(null, null, suiteStage, e); }
finally {
  if (group && summary.tools?.upstream) {
    try { await collectLogs(upstreamName, join(folder, "upstream.log"), "upstream logs", { cleanup: true }); }
    catch (e) { fail(null, null, "upstream logs", e); summary.complete = false; summary.attemptComplete = false; }
  }
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
  try {
    const containers = (await docker(["ps", "-a", "--filter", `label=${label}=${runId}`, "--format", "{{.ID}}"], { cleanup: true })).split("\n").filter(Boolean);
    const networks = (await docker(["network", "ls", "--filter", `label=${label}=${runId}`, "--format", "{{.ID}}"], { cleanup: true })).split("\n").filter(Boolean);
    writeFileSync(join(folder, "cleanup.json"), JSON.stringify({ runId, containers, networks }, null, 2));
    assert.deepEqual(containers, [], "owned containers remain");
    assert.deepEqual(networks, [], "owned networks remain");
  } catch (e) { summary.cleanupFailures.push({ resource: runId, error: e.message }); }
  if (group) {
    try {
      summary.commitAfter = await command("git", ["rev-parse", "HEAD"], { cleanup: true });
      summary.dirtyAfter = (await command("git", ["status", "--porcelain"], { cleanup: true })).length > 0;
      assert.equal(summary.commitAfter, summary.commit, "HEAD changed during catalog group run");
      assert.equal(summary.dirtyAfter, false, "tree dirty after catalog group run");
      assert.equal(summary.dirty, false, "tree dirty before catalog group run");
    } catch (e) { summary.complete = false; fail(null, null, "tree provenance", e); }
  }
  delete summary.currentSource;
  summary.finishedAt = new Date().toISOString();
  summary.complete &&= !interrupted && summary.cleanupFailures.length === 0;
  if (summary.attemptComplete !== undefined) summary.attemptComplete &&= !interrupted && summary.cleanupFailures.length === 0 && summary.failures.length === 0;
  if (group && summary.failures.length === 0 && !options.checkOnly) {
    try {
      const index = JSON.stringify({ schema: "catalog-artifact-index/v1", commit: summary.commit, sourceSha256: summary.savedEvidence.apparatusSourceSha256,
        hashes: Object.fromEntries(requiredRoundArtifacts(summary).map((key) => [key, digest(readFileSync(join(folder, key)))])) }, null, 2);
      writeFileSync(join(folder, "evidence-index.json"), index); summary.savedEvidence.artifactsSha256 = digest(index);
    } catch (e) { summary.complete = false; summary.attemptComplete = false; fail(null, null, "artifact index", e); }
  }
  save();
}
log(`${workload} ${options.round}: ${summary.complete ? "PASS" : "FAIL"}; ${join(folder, "summary.json")}`);
if (!summary.complete) process.exitCode = 1;
