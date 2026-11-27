// Local, opt-in apparatus. Does not use the operational benchmark network or cloud controller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostname, platform, release } from "node:os";
import { budgets, validateBudget, parseArgs, schema, matrix, selected, groupReady, nativeGroup, registryDigest,
  boundedRequestsVersion, deploymentQualificationVersion, connectionFloodResistance } from "./plan.mjs";
import { artifacts, verifyArtifacts, verifyParity, verifyNativeLimits, verifyHardeningCpuRoles, verifyHardeningCpuScope, digest, usesDelayUpstream, upstreamSourcePath, probeSourcePath, phaseInputs,
  savedProofVersion, committedInputs, savedFiles, snapshotDependencies, readyScript, buildNativeImage, proxyConfig, edgePublicOrigin } from "./evidence.mjs";
import { assembleRecovery } from "./dependency-recovery-capture.mjs";
import { assembleBounded, boundedProbeConfig } from "./request-capture.mjs";
import { assessNative } from "./native.mjs";
import { validateBoundedQualification } from "./qualification.mjs";
import { trackedImageBuild, trackedNetworkCreate, requireSourceControl, failureKind, terminalHealthPaths, collectTerminalHealth, ownedCleanupObservation, ownedContainerRecorder, ownedResourceCleanup } from "./lifecycle.mjs";
import { nativeBuildContext } from "../mixed-production/build-context.mjs";
import { records, writeFixture } from "../marketplace/fixtures.mjs";
import { featureProfile, qualificationSettings } from "../marketplace/feature-contract.mjs";
import { edgeImage, edgeCertImage } from "../fullstack/edge.mjs";
import { captureNativeCpuScope, requireNativeCommandCpuSet } from "../workloads/isolated/host-lifetime.mjs";
import { hardeningActorCpus, hardeningCpuGate, hardeningGateMs, hardeningRoleCpu } from "../workloads/isolated/native-roles.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

export async function prepareToolImages(docker, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "Playwright must have a pinned image-compatible version");
  const refs = { node: "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067",
    checker: `mcr.microsoft.com/playwright:v${version}-noble`, edge: edgeImage, cert: edgeCertImage };
  const tools = {};
  for (const [key, ref] of Object.entries(refs)) {
    const inspect = ["image", "inspect", ref];
    let output;
    try { output = await docker(inspect); }
    catch {
      await docker(["pull", ref], { timeout: 5 * 60_000, settleOnInterrupt: true });
      output = await docker(inspect);
    }
    const images = JSON.parse(output);
    assert.ok(Array.isArray(images) && images.length === 1 && /^sha256:[a-f0-9]{64}$/.test(images[0]?.Id),
      `invalid hardening tool image: ${key}`);
    tools[key] = images[0];
  }
  return tools;
}

export function finalizeCell(out, cell, isolated, ownedReceipts, input) {
  if (isolated) verifyHardeningCpuRoles(JSON.parse(readFileSync(join(out, "cpu-roles.json"), "utf8")),
    cell, ownedReceipts.filter((r) => r.intent.cell === cell.key), input.raw);
  const manifest = artifacts(out); json(join(out, "manifest.json"), manifest); verifyArtifacts(out, manifest);
  const recovery = cell.phase === "dependency-recovery";
  const capture = (recovery ? assembleRecovery : assembleBounded)(input);
  json(join(out, "capture.json"), capture); cell.status = "observed"; cell.apparatusValid = true;
  cell.capture = `${cell.key}/capture.json`;
  if (recovery) {
    cell.dependencyRecovery = capture.assessment;
    cell.dependencyTerminalHealthy = capture.terminal.healthy;
  } else {
    cell.boundedRequests = capture.assessment;
    cell.boundedTerminalHealthy = capture.terminal.healthy;
  }
}

export async function run(args) {
  const options = parseArgs(args);
  if (options.isolated) requireNativeCommandCpuSet(hardeningActorCpus.command);
  const folder = resolve(options.out), budget = validateBudget(budgets(options.profile));
  assert.ok(!folder.startsWith("\\\\"), "local results required");
  const scoped = relative(join(repo, "bench/hardening/results"), folder);
  assert.ok(scoped && !scoped.startsWith(".."), "output must be a new directory under bench/hardening/results");
  mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder);
  const runId = `hardening-${randomBytes(6).toString("hex")}`, label = "run.corten.hardening";
  const network = `${runId}-net`, children = new Set(), settling = new Set();
  let currentCell = null, inputFiles, sourceRoot;
  let interrupted = false;
  const interrupt = () => { interrupted = true; for (const child of children) if (!settling.has(child)) child.kill(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const summary = { schema, runId, registryDigest, options, budget, startedAt: new Date().toISOString(), complete: false,
    groupReady: false, savedProofVersion, nativeControlsVersion: 1, deploymentQualificationVersion, boundedRequestsVersion, lifecycleVersion: 4,
    cells: matrix(), failures: [], cleanupFailures: [], builds: {}, originalFolder: folder, host: { hostname: hostname(), platform: platform(), release: release() },
    connectionFloodResistance,
    scope: "Bounded HTTP/1.1 resilience observations; the TLS edge uses the pinned nginx deployment; not a stress or performance comparison" };
  const save = () => { summary.nativeGroup = nativeGroup(summary.cells); json(join(folder, "summary.json"), summary); };
  async function command(binary, args, { timeout, file, cleanup = false, settleOnInterrupt = false, input, receipt } = {}) {
    timeout ??= cleanup ? budget.cleanup.timeoutMs : 30000;
    if (interrupted && !cleanup) throw new Error("run interrupted");
    const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } }); children.add(child);
    if (input) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    if (settleOnInterrupt) settling.add(child);
    let output = "", error = "", timedOut = false;
    child.stdout.on("data", (c) => { output = (output + c).slice(-16 * 2 ** 20); if (file) appendFileSync(file, c); });
    child.stderr.on("data", (c) => { error = (error + c).slice(-65536); if (file) appendFileSync(file, c); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    try {
      const code = await new Promise((res, rej) => { child.once("error", rej); child.once("close", res); });
      if (receipt) Object.assign(receipt, { stdout: output.trim(), stderr: error.trim(), exitCode: code, timedOut, interrupted, finishedAt: new Date().toISOString() });
      if (settleOnInterrupt && (timedOut || code !== 0)) summary.daemonOutcomeUnknown = true;
      if (!(code === 0 && !timedOut && (cleanup || !interrupted))) {
        const failure = new Error(`${binary} ${args.slice(0, 2).join(" ")}: ${timedOut ? "deadline" : code}\n${error || output}`);
        if (settleOnInterrupt && (timedOut || code !== 0)) failure.daemonOutcomeUnknown = true;
        throw failure;
      }
      return output.trim();
    } finally { clearTimeout(timer); children.delete(child); settling.delete(child); }
  }
  const containers = ownedContainerRecorder({ folder, runId, command: (args, opts) => command("docker", args, opts), cell: () => currentCell, tools: () => tools });
  const { docker, owned, remove, active, records: ownedReceipts } = containers;
  const inspect = async (name) => JSON.parse(await docker(["inspect", name], { cleanup: true }))[0];
  const labels = ["--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`];
  const limits = (role, limit = budget.resources[role]) => ["--cpus", String(limit.cpu), "--memory", String(limit.memory),
    "--memory-swap", String(limit.memory), "--pids-limit", "512", "--ulimit", "nofile=65536:65536",
    ...(options.isolated ? ["--cpuset-cpus", hardeningRoleCpu(role)] : [])];
  let mounted, checkMounts;
  // Mount leaves separately: a missing node_modules mountpoint cannot be created
  // beneath a read-only repository mount in an otherwise clean worktree.
  const installedDependencies = resolve(repo, options.nodeModules), dependencies = join(folder, "dependencies");
  const tools = {};
  const images = new Map();
  const fixtureDir = join(folder, "fixtures"); mkdirSync(fixtureDir); writeFixture(join(fixtureDir, "marketplace.json"), JSON.stringify(records(), null, 2) + "\n");
  const fixture = ["-v", `${fixtureDir}:/fixtures:ro`];
  const checkout = async () => ({ commit: await command("git", ["rev-parse", "HEAD"]), dirty: await command("git", ["status", "--porcelain", "--untracked-files=all"]) });
  async function sourceHash(app) {
    const paths = app === "corten" ? ["bench/marketplace/corten", "crates", "Cargo.toml", "Cargo.lock"] : [`bench/fullstack/apps/${app}`];
    return digest(JSON.stringify(inputFiles.filter((f) => paths.some((p) => f.path === p || f.path.startsWith(p + "/")))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((f) => [f.path, f.sha256])));
  }
  async function appImage(app) {
    if (images.has(app)) return images.get(app);
    const source = await sourceHash(app), tag = `${runId}-${app}`;
    let image;
    if (options.build) {
      const expected = inputFiles.filter((f) => app === "corten" || f.path.startsWith(`bench/fullstack/apps/${app}/`));
      const context = app === "corten" ? rootContext : await nativeBuildContext({ command }, folder, summary.commit, app,
        expected.map(({ path, sha256 }) => ({ path, sha256 })));
      const build = await trackedImageBuild(summary, tag, save, () => buildNativeImage(docker, {
        context, runId, commit: summary.commit, source, tag, files: expected, log: join(folder, `build-${app}.log`),
      }));
      image = build.image; summary.builds[app] = build; save();
    } else image = JSON.parse(await docker(["image", "inspect", `cb-marketplace-production-${app}`]))[0];
    assert.equal(image.Config.Labels?.["run.corten.marketplace.commit"], summary.commit, "image source commit mismatch; build current native adapter");
    assert.equal(image.Config.Labels?.["run.corten.marketplace.dirty"], "false", "dirty source image cannot establish provenance");
    assert.equal(image.Config.Labels?.["run.corten.marketplace.profile"], featureProfile);
    assert.equal(image.Config.Labels?.["run.corten.hardening.source"], source, "native source digest missing/mismatch; rebuild");
    assert.equal(await sourceHash(app), source, "native source moved during build");
    images.set(app, { image, source }); return images.get(app);
  }
  async function sidecar(name, namespace, args, out, file, timeout, memory = budget.resources.qualification.memory) {
    const cert = join(out, "cert/cert.pem");
    await owned(name, ["create", "--network", `container:${namespace}`, ...limits("qualification", { cpu: 2, memory }), "--shm-size", "1g", ...checkMounts,
      "-v", `${dependencies}:/repo/node_modules:ro`, ...fixture, "-v", `${out}:/results`,
      ...(existsSync(cert) ? ["-e", "NODE_EXTRA_CA_CERTS=/results/cert/cert.pem", "-e", "BENCH_EDGE_CERT=/results/cert/cert.pem"] : []),
      "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", tools.checker.Id, "node", ...args]);
    try { return await docker(["start", "-a", name], { timeout, file: join(out, file) }); }
    finally { await remove(name); }
  }
  async function ready(namespace, out, image) {
    const name = `${runId}-ready`;
    await owned(name, ["create", "--network", `container:${namespace}`, ...limits("apparatus"), tools.node.Id, "node", "--input-type=module", "-e",
      readyScript]);
    try { await docker(["start", "-a", name], { timeout: 50000, file: join(out, "ready.log") }); }
    finally { await remove(name); }
    assert.equal((await inspect(namespace)).Image, image, "native image changed");
  }
  async function cellRun(cell) {
    currentCell = cell;
    const out = join(folder, cell.key); mkdirSync(out, { recursive: true });
    const prefix = `${runId}-cell`, appName = `${prefix}-app`, upstreamName = `${prefix}-upstream`, edgeName = `${prefix}-edge`, probeName = `${prefix}-probe`;
    const recovery = cell.phase === "dependency-recovery";
    const delayed = usesDelayUpstream(cell.phase), upstreamSource = upstreamSourcePath(cell.phase), probeSource = probeSourcePath(cell.phase);
    const upstreamOrigin = `http://${upstreamName}:8080`;
    let startedWall, probeEndedWall, raw, settings, provenance, lifecycle, parity, processList, recoveryDir, config, error, stage = "image-provenance";
    const targets = [], snapshot = {};
    try {
      for (const path of [...phaseInputs(cell.phase), ...(options.isolated ? [hardeningCpuGate] : [])]) {
        const input = inputFiles.find((f) => f.path === path);
        assert.ok(input && digest(readFileSync(join(sourceRoot, path))) === input.sha256, `unbound native hardening input: ${path}`);
      }
      if (delayed) {
        // Other sidecars can only write to /results, not this one-shot trigger.
        recoveryDir = mkdtempSync(join(folder, ".recovery-"));
      }
      const { image, source } = await appImage(cell.app);
      stage = "native-startup";
      const upstreamCommand = ["node", "/repo/" + upstreamSource];
      const upstream = await owned(upstreamName, ["run", "-d", "--network", network, ...limits("upstream"), ...mounted, ...fixture,
        ...(delayed ? ["-e", "RECOVERY_TRIGGER_DIR=/recovery", "-v", `${recoveryDir}:/recovery:ro`] : []), tools.node.Id, ...upstreamCommand]);
      targets.push({ id: "upstream", role: "upstream", name: upstreamName, info: upstream, source: `${summary.commit}:${upstreamSource}` });
      if (delayed) {
        assert.equal(upstream.Image, tools.node.Id, "recovery upstream image differs from the pinned tool");
        assert.deepEqual(upstream.Config.Cmd, upstreamCommand, "recovery upstream command differs from the committed entry point");
        assert.ok(upstream.Config.Env.includes("RECOVERY_TRIGGER_DIR=/recovery"), "recovery upstream trigger directory not configured");
        const trigger = upstream.Mounts.find((m) => m.Destination === "/recovery");
        assert.ok(trigger?.Type === "bind" && trigger.RW === false, "recovery upstream trigger must be read-only");
      }
      const app = await owned(appName, ["run", "-d", "--network", network, "--network-alias", "fsw-target", ...limits(cell.mode === "direct" ? "applicationDirect" : "applicationEdge"), ...fixture,
        "-e", `MARKETPLACE_SOURCE=${cell.source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json", "-e", `API_BASE=http://${upstreamName}:8080`,
        ...(cell.mode === "deployed-edge" ? ["-e", `MARKETPLACE_PUBLIC_ORIGIN=${edgePublicOrigin}`] : []),
        "-e", "PORT=8080", "-e", "HOSTS=fsw-target,localhost,127.0.0.1", "-e", `PROFILE=${qualificationSettings.nativeProfile}`, "-e", `MAX_CONNECTIONS=${qualificationSettings.maxConnections}`, image.Id]);
      targets.push({ id: "application", role: "application", name: appName, info: app, source: `${summary.commit}:sha256:${source}` });
      await ready(appName, out, image.Id);
      stage = "production-qualification";
      await sidecar(`${prefix}-qualification`, appName, ["/repo/bench/hardening/qualification.mjs", cell.source, "direct", upstreamOrigin, "/results/qualification.json"], out, "qualification.log", 2 * 60000);
      const qualification = validateBoundedQualification(JSON.parse(readFileSync(join(out, "qualification.json"), "utf8")));
      let edgeQualification;
      cell.nativeMissingFeatures = qualification.missing;
      stage = "native-controls";
      await sidecar(`${prefix}-native-controls`, appName, ["/repo/bench/hardening/native.mjs", "http://127.0.0.1:8080", cell.source, `http://${upstreamName}:8080`, "/results/qualification.json", "/results/native-controls.json"], out, "native-controls.log", 90000);
      cell.nativeAssessment = assessNative(JSON.parse(readFileSync(join(out, "native-controls.json"))), qualification);
      requireSourceControl(cell.nativeAssessment, "native");
      // Missing defenses do NOT exclude an app. Functional/browser work is a separate prerequisite.
      stage = "native-parity";
      await sidecar(`${prefix}-parity`, appName, ["/repo/bench/hardening/parity.mjs", "http://127.0.0.1:8080", cell.source, `http://${upstreamName}:8080`, "/results/parity.json"], out, "parity.log", 10 * 60000);
      parity = JSON.parse(readFileSync(join(out, "parity.json"), "utf8")); verifyParity(parity, cell.source); cell.parity = "passed";
      json(join(out, "native-parity.json"), parity);
      let target = { host: "127.0.0.1", port: 8080, authority: "localhost:8080", origin: "http://localhost:8080", tls: false }, namespace = appName;
      if (cell.mode === "deployed-edge") {
        stage = "edge-deployment";
        const cert = join(out, "cert"); mkdirSync(cert);
        const certName = `${prefix}-certificate`;
        await owned(certName, ["create", "--network", "none", ...limits("apparatus"), "-v", `${cert}:/cert`, tools.cert.Id,
          "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "/cert/key.pem", "-out", "/cert/cert.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
        try { await docker(["start", "-a", certName], { file: join(out, "certificate.log") }); } finally { await remove(certName); }
        writeFileSync(join(out, "nginx.conf"), proxyConfig());
        const edge = await owned(edgeName, ["run", "-d", "--network", network, ...limits("proxy"), "-v", `${cert}:/cert:ro`, "-v", `${join(out, "nginx.conf")}:/etc/nginx/nginx.conf:ro`, tools.edge.Id]);
        targets.push({ id: "proxy", role: "proxy", name: edgeName, info: edge, source: summary.commit + ":bench/fullstack/edge.mjs:nginxConf" });
        target = { host: "127.0.0.1", port: 8080, authority: "localhost:8080", origin: "https://localhost:8080", tls: true, caPem: readFileSync(join(cert, "cert.pem"), "utf8") }; namespace = edgeName;
        stage = "edge-production-qualification";
        await sidecar(`${prefix}-edge-qualification`, edgeName, ["/repo/bench/hardening/qualification.mjs", cell.source, "deployed-edge", upstreamOrigin, "/results/edge-qualification.json"], out, "edge-qualification.log", 2 * 60000);
        edgeQualification = validateBoundedQualification(JSON.parse(readFileSync(join(out, "edge-qualification.json"), "utf8")));
        cell.edgeMissingFeatures = edgeQualification.missing;
        // The edge is a distinct deployment and must itself pass the complete content/browser gate.
        stage = "edge-parity";
        await sidecar(`${prefix}-edge-parity`, edgeName, ["/repo/bench/hardening/parity.mjs", "https://localhost:8080", cell.source, `http://${upstreamName}:8080`, "/results/parity.json"], out, "edge-parity.log", 10 * 60000);
        parity = JSON.parse(readFileSync(join(out, "parity.json"), "utf8")); verifyParity(parity, cell.source);
        stage = "edge-native-controls";
        await sidecar(`${prefix}-edge-controls`, edgeName, ["/repo/bench/hardening/native.mjs", "https://localhost:8080", cell.source, `http://${upstreamName}:8080`, "/results/edge-qualification.json", "/results/edge-native-controls.json", "deployed-edge"], out, "edge-native-controls.log", 90000);
        cell.edgeAssessment = assessNative(JSON.parse(readFileSync(join(out, "edge-native-controls.json"))), edgeQualification, "deployed-edge");
        requireSourceControl(cell.edgeAssessment, "edge");
      }
      processList = [];
      stage = "native-inventory";
      for (const t of targets) {
        const info = await inspect(t.name), top = await docker(["top", t.name, "-eo", "pid,ppid,comm,args"]);
        const count = top.split("\n").length - 1; assert.ok(count > 0); json(join(out, `${t.id}-before.json`), { info, top });
        snapshot[t.id] = { before: info }; processList.push({ id: t.id, role: t.role, count, containerId: info.Id });
      }
      const deployment = { mode: cell.mode, countAllProcesses: true, processes: processList.map(({ containerId, ...p }) => p) };
      settings = { review: options.review, case: cell.mode, phase: cell.phase, nativeSource: cell.source, deployment,
        terminalHealthPaths: terminalHealthPaths(qualification, edgeQualification),
        effectiveBudgets: JSON.stringify(budget) }; json(join(out, "settings.json"), settings);
      verifyNativeLimits(settings, Object.fromEntries(targets.map((t) => [t.id, { before: snapshot[t.id].before, after: snapshot[t.id].before, events: [] }])));
      provenance = targets.map((t) => ({ id: t.id, image: t.info.Image, source: t.source, config: digest(readFileSync(join(out, `${t.id}-before.json`))), evidence: `${t.id}-before.json` }));
      const net = JSON.parse(await docker(["network", "inspect", network]))[0];
      assert.deepEqual(Object.keys(net.Containers).sort(), processList.map((p) => p.containerId).sort(), "unaccounted native process container on isolated network");
      json(join(out, "deployment.json"), { network: net, processes: processList, provenance, totalBudget: budget.resources });
      config = recovery ? { budget, phase: cell.phase, source: cell.source, upstream: upstreamOrigin, target, expected: records().item_1, processes: processList }
        : boundedProbeConfig(cell, budget, runId, target.caPem);
      json(join(out, "probe.json"), config);
      stage = cell.phase;
      const probe = await owned(probeName, ["create", "--network", `container:${namespace}`, ...limits("apparatus"),
        ...(recovery ? ["--cgroupns=host", "--pid=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro"] : []), ...mounted, "-v", `${out}:/results`,
        ...(delayed ? ["-e", "RECOVERY_TRIGGER_DIR=/recovery", "-v", `${recoveryDir}:/recovery:rw`] : []), tools.node.Id,
        "node", ...(options.isolated ? ["--import", "/repo/" + hardeningCpuGate] : []),
        "/repo/" + probeSource, "/results/probe.json", "/results/raw.jsonl"]);
      if (delayed) {
        const upstreamTrigger = upstream.Mounts.find((m) => m.Destination === "/recovery");
        const probeTrigger = probe.Mounts.find((m) => m.Destination === "/recovery");
        assert.ok(probeTrigger?.Type === "bind" && probeTrigger.RW === true && probeTrigger.Source === upstreamTrigger.Source,
          "recovery probe must be the writer of the upstream trigger directory");
      }
      startedWall = new Date().toISOString();
      const { beforeMs, duringMs, afterMs, timeoutMs } = budget.dependencyRecovery;
      const probeTimeout = delayed ? beforeMs + duringMs + afterMs + timeoutMs + 20000 : 10000;
      const startProbe = () => docker(["start", "-a", probeName], {
        timeout: probeTimeout + (options.isolated ? 2 * hardeningGateMs : 0), file: join(out, "probe.log"),
      });
      try {
        if (!options.isolated) await startProbe();
        else {
          const marker = (name) => join(out, ".cpu-" + name);
          let settled = false;
          const running = startProbe().catch((e) => { error ??= e; }).finally(() => { settled = true; });
          const until = async (check, description, waitMs = hardeningGateMs) => {
            const deadline = performance.now() + waitMs;
            while (!settled && !interrupted && performance.now() < deadline) {
              const result = await check();
              if (result) return result;
              await sleep(20);
            }
            throw error ?? new Error("native CPU gate: missing " + description);
          };
          const sample = async (probeInfo) => Object.fromEntries([
            ["probe", captureNativeCpuScope(probeInfo)],
            ...await Promise.all(targets.map(async (t) => [t.role, captureNativeCpuScope(await inspect(t.info.Id))])),
          ]);
          try {
            const info = await until(async () => {
              const row = await inspect(probe.Id);
              return row.State.Running && row;
            }, "running probe");
            const before = await sample(info);
            for (const [role, row] of Object.entries(before)) verifyHardeningCpuScope(row, hardeningRoleCpu(role === "probe" ? "apparatus" : role));
            writeFileSync(marker("enter"), "", { flag: "wx" });
            await until(() => existsSync(marker("drained")), "drained probe", probeTimeout + hardeningGateMs);
            const after = await sample(await inspect(probe.Id));
            json(join(out, "cpu-roles.json"), { schema: "native-hardening-cpu-roles/v1", before, after });
            writeFileSync(marker("leave"), "", { flag: "wx" });
          } catch (e) { error ??= e; }
          finally {
            await running;
            for (const name of ["enter", "drained", "leave"]) rmSync(marker(name), { force: true });
          }
        }
      }
      catch (e) { error = e; }
      finally {
        probeEndedWall = Date.now();
        // Preserve the start failure and partial raw/log output; owned cleanup retries a failed removal.
        try { await remove(probeName); } catch (e) { if (!error) throw e; }
      }
      if (error) throw error;
      assert.deepEqual(JSON.parse(readFileSync(join(out, "probe.json"), "utf8")), config, "native probe configuration changed");
      raw = readFileSync(join(out, "raw.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const clock = raw.find((r) => r.type === "clock"); assert.ok(clock);
      lifecycle = {};
      stage = "native-lifecycle";
      const terminalClock = async () => {
        const name = `${prefix}-terminal-clock`;
        await owned(name, ["create", "--network", "none", ...limits("apparatus"), ...mounted, tools.node.Id, "node", "/repo/bench/hardening/clock.mjs"]);
        try { return JSON.parse(await docker(["start", "-a", name])); }
        finally { await remove(name); }
      };
      const start = await terminalClock();
      for (const t of targets) {
        const path = settings.terminalHealthPaths[t.role];
        const base = t.role === "proxy" ? "https://localhost:8080" : "http://127.0.0.1:8080";
        const { after, health } = await collectTerminalHealth({ role: t.role, source: cell.source, path, inspect: () => inspect(t.name),
          observe: async () => JSON.parse(await sidecar(`${prefix}-${t.id}-health`, t.name,
            ["/repo/bench/hardening/lifecycle.mjs", base, path, String(budget.recovery.requestTimeoutMs)], out, `${t.id}-terminal-health.json`, 15000)) });
        const until = new Date().toISOString();
        const eventsText = await docker(["events", "--since", clock.wallAtStart, "--until", until, "--filter", `container=${t.info.Id}`, "--format", "{{json .}}"]);
        const events = eventsText ? eventsText.split("\n").map((line) => JSON.parse(line)) : [];
        const top = after.State.Running ? await docker(["top", t.name, "-eo", "pid,ppid,comm,args"]) : null;
        lifecycle[t.id] = { ...snapshot[t.id], after, events, top, health };
        if (t.role === "upstream" && cell.source === "fixture") assert.ok(after.State.Running && after.State.StartedAt === t.info.State.StartedAt, "idle fixture upstream apparatus stopped/restarted");
      }
      const end = await terminalClock();
      for (const t of targets) {
        lifecycle[t.id].observation = { start, end };
        json(join(out, `${t.id}-lifecycle.json`), lifecycle[t.id]);
      }
    } catch (e) { error = e; }
    finally {
      for (const t of targets) {
        try { writeFileSync(join(out, `${t.id}.log`), await docker(["logs", t.name], { cleanup: true })); } catch (e) { error ??= e; }
      }
      const failures = [];
      for (const name of [...active]) { try { await remove(name); } catch (e) { failures.push(e.message); } }
      if (recoveryDir) {
        try {
          assert.ok(!active.has(upstreamName) && !active.has(probeName) && !summary.daemonOutcomeUnknown,
            "recovery trigger directory retained because container cleanup is uncertain");
          rmSync(join(recoveryDir, "start"), { force: true }); rmdirSync(recoveryDir);
        } catch (e) { failures.push(e.message); }
      }
      // Retain the bounded configuration for replay, never the private TLS key.
      for (const file of [join(out, "cert/key.pem"), ...(recovery ? [join(out, "probe.json")] : [])]) if (existsSync(file)) rmSync(file);
      let nativeClock = null;
      if (raw) {
        const name = `${prefix}-cleanup-clock`;
        try {
          await owned(name, ["create", "--network", "none", ...limits("apparatus"), ...mounted, tools.node.Id, "node", "/repo/bench/hardening/clock.mjs"]);
          nativeClock = JSON.parse(await docker(["start", "-a", name], { cleanup: true }));
        } catch (e) { failures.push(e.message); }
        finally { try { await remove(name); } catch (e) { failures.push(e.message); } }
      }
      const remainingContainers = (await docker(["ps", "-aq", "--filter", `label=${label}=${runId}`], { cleanup: true })).split("\n").filter(Boolean);
      const volumes = (await docker(["volume", "ls", "-q", "--filter", `label=${label}=${runId}`], { cleanup: true })).split("\n").filter(Boolean);
      const cleanup = { complete: failures.length === 0 && remainingContainers.length === 0 && volumes.length === 0 && children.size === 0,
        containers: remainingContainers, volumes, commandClients: children.size, failures, nativeClock,
        elapsedAfterProbeMs: probeEndedWall ? Date.now() - probeEndedWall : null, finishedAt: new Date().toISOString() };
      json(join(out, "cleanup.json"), cleanup);
      if (!cleanup.complete) { summary.cleanupFailures.push({ key: cell.key, cleanup }); error ??= new Error("owned cleanup failed"); stage = "owned-cleanup"; }
      if (!error) {
        try {
          stage = "evidence-validation";
          finalizeCell(out, cell, options.isolated, ownedReceipts, { settings, raw, parity, source: cell.source, config, cleanup, provenance, lifecycle });
        } catch (e) { error = e; }
      }
      if (error) { cell.status = "invalid"; cell.apparatusValid = false; cell.error = error.message; cell.failedStage = stage;
        cell.failureKind = failureKind(stage, error);
        json(join(out, "failure.json"), { error: error.stack, startedWall, stage, kind: cell.failureKind }); summary.failures.push({ key: cell.key, stage, kind: cell.failureKind, error: error.message }); }
    }
  }
  let rootContext;
  try {
    const state = await checkout(); assert.equal(state.dirty, "", "commit scoped runner and native sources before capturing exact provenance");
    summary.commit = state.commit; summary.fixtureSha256 = digest(readFileSync(join(fixtureDir, "marketplace.json")));
    inputFiles = committedInputs(repo, summary.commit);
    rootContext = await nativeBuildContext({ command }, folder, summary.commit, "corten", inputFiles.map(({ path, sha256 }) => ({ path, sha256 })));
    sourceRoot = join(folder, "corten-build-context");
    const version = JSON.parse(readFileSync(join(sourceRoot, "package.json"))).devDependencies["@playwright/test"];
    assert.ok(existsSync(join(installedDependencies, "@playwright/test/package.json")), "--node-modules must name an installed pinned dependency tree");
    assert.equal(JSON.parse(readFileSync(join(installedDependencies, "@playwright/test/package.json"))).version, version, "installed browser driver version mismatch");
    mounted = ["-v", `${sourceRoot}:/repo:ro`];
    checkMounts = ["-v", `${join(sourceRoot, "bench")}:/repo/bench:ro`, "-v", `${join(sourceRoot, "scripts")}:/repo/scripts:ro`,
      "-v", `${join(sourceRoot, "package.json")}:/repo/package.json:ro`];
    const dependencyFiles = snapshotDependencies(installedDependencies, dependencies);
    json(join(folder, "inputs.json"), { schema: "native-hardening-inputs/v1", commit: summary.commit, files: inputFiles, dependencies: dependencyFiles });
    Object.assign(tools, await prepareToolImages(docker, version));
    summary.tools = tools; save();
    await trackedNetworkCreate(summary, network, save, () => docker(["network", "create", ...labels, network],
      { settleOnInterrupt: true, timeout: budget.cleanup.timeoutMs }));
    for (const cell of summary.cells) {
      if (!selected(cell, options)) { cell.reason = "not run by explicit apparatus-verification filter; remains in selected group"; continue; }
      if (interrupted || summary.cleanupFailures.length) break;
      console.log(`hardening ${cell.key}`); await cellRun(cell); save();
      const stateAfter = await checkout(); assert.equal(stateAfter.commit, summary.commit); assert.equal(stateAfter.dirty, "", "checkout changed during native run");
    }
    summary.complete = summary.cells.every((c) => c.status !== "not-run");
    summary.groupReady = groupReady(summary.cells) && !Object.keys(options.verify).length;
  } catch (e) { summary.failures.push({ stage: "apparatus", error: e.stack }); }
  finally {
    for (const name of [...active]) try { await remove(name); } catch (e) { summary.cleanupFailures.push(e.message); }
    const resourceCleanup = [];
    for (const [kind, names] of [["network", summary.ownedNetworks ?? []], ["image", summary.ownedImages ?? []]])
      for (const name of names) try { resourceCleanup.push(await ownedResourceCleanup(kind, name, runId, docker)); } catch (e) { summary.cleanupFailures.push(e.message); }
    json(join(folder, "resource-cleanup.json"), resourceCleanup);
    try { json(join(folder, "final-cleanup.json"), await ownedCleanupObservation(docker, runId, children.size, active.size)); }
    catch { summary.cleanupFailures.push("final owned inventory unavailable"); }
    if (summary.cleanupFailures.length) summary.groupReady = false;
    containers.seal();
    summary.finishedAt = new Date().toISOString(); save();
    try { json(join(folder, "run-manifest.json"), savedFiles(folder, ["run-manifest.json"])); }
    finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  }
  console.log(JSON.stringify({ output: folder, groupReady: summary.groupReady, observed: summary.cells.filter((c) => c.status === "observed").length, invalid: summary.cells.filter((c) => c.status === "invalid").length, notRun: summary.cells.filter((c) => c.status === "not-run").length, cleanupFailures: summary.cleanupFailures.length }));
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run(process.argv.slice(2));
  if (result.failures.length || result.cleanupFailures.length || (!Object.keys(result.options.verify).length && !result.groupReady)) process.exitCode = 1;
}
