// Local, opt-in apparatus. Does not use the operational benchmark network or cloud controller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostname, platform, release } from "node:os";
import { budgets, validateBudget, parseArgs, schema, matrix, selected, groupReady, nativeGroup, registryDigest } from "./plan.mjs";
import { assemble, artifacts, verifyArtifacts, verifyParity, digest, targetOutcome } from "./evidence.mjs";
import { assessNative } from "./native.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { validateQualification, featureProfile, qualificationSettings } from "../marketplace/feature-contract.mjs";
import { nginxConf, edgeImage, edgeCertImage, edgeOffset } from "../fullstack/edge.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
export async function run(args) {
  const options = parseArgs(args);
  const folder = resolve(options.out), budget = validateBudget(budgets(options.profile));
  assert.ok(!folder.startsWith("\\\\"), "local results required");
  const scoped = relative(join(repo, "bench/hardening/results"), folder);
  assert.ok(scoped && !scoped.startsWith(".."), "output must be a new directory under bench/hardening/results");
  mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder);
  const runId = `hardening-${randomBytes(6).toString("hex")}`, label = "run.corten.hardening";
  const network = `${runId}-net`, active = new Set(), children = new Set();
  let interrupted = false, networkCreated = false;
  const interrupt = () => { interrupted = true; for (const child of children) child.kill(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const summary = { schema, runId, registryDigest, options, budget, startedAt: new Date().toISOString(), complete: false,
    groupReady: false, nativeControlsVersion: 1, cells: matrix(), failures: [], cleanupFailures: [], host: { hostname: hostname(), platform: platform(), release: release() },
    scope: "HTTP/1.1 hardening of native production marketplace adapters; TLS edge uses existing pinned nginx deployment config; not HTTP/2/3 or kernel-peak measurement" };
  const save = () => { summary.nativeGroup = nativeGroup(summary.cells); json(join(folder, "summary.json"), summary); };
  async function command(binary, args, { timeout, file, cleanup = false } = {}) {
    timeout ??= cleanup ? budget.cleanup.timeoutMs : 30000;
    if (interrupted && !cleanup) throw new Error("run interrupted");
    const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
    let output = "", error = "", timedOut = false;
    child.stdout.on("data", (c) => { output = (output + c).slice(-16 * 2 ** 20); if (file) appendFileSync(file, c); });
    child.stderr.on("data", (c) => { error = (error + c).slice(-65536); if (file) appendFileSync(file, c); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    try {
      const code = await new Promise((res, rej) => { child.once("error", rej); child.once("close", res); });
      assert.ok(code === 0 && !timedOut && (cleanup || !interrupted), `${binary} ${args.slice(0, 2).join(" ")}: ${timedOut ? "deadline" : code}\n${error || output}`);
      return output.trim();
    } finally { clearTimeout(timer); children.delete(child); }
  }
  const docker = (args, opts) => command("docker", args, opts);
  const inspect = async (name) => JSON.parse(await docker(["inspect", name], { cleanup: true }))[0];
  const labels = ["--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`];
  async function owned(name, args) {
    active.add(name);
    await docker([args[0], "--name", name, ...labels, ...args.slice(1)]);
    return inspect(name);
  }
  async function remove(name) {
    const ids = await docker(["ps", "-aq", "--filter", `name=^/${name}$`], { cleanup: true });
    if (ids) { const info = await inspect(name); assert.equal(info.Config.Labels?.[label], runId, "refusing unowned cleanup"); await docker(["rm", "-f", "-v", info.Id], { cleanup: true }); }
    active.delete(name);
  }
  const limits = (role) => ["--cpus", String(role.cpu), "--memory", String(role.memory), "--memory-swap", String(role.memory), "--pids-limit", "512", "--ulimit", "nofile=65536:65536"];
  const mounted = ["-v", `${repo}:/repo:ro`];
  // Mount leaves separately: a missing node_modules mountpoint cannot be created
  // beneath a read-only repository mount in an otherwise clean worktree.
  const checkMounts = ["-v", `${join(repo, "bench")}:/repo/bench:ro`, "-v", `${join(repo, "scripts")}:/repo/scripts:ro`,
    "-v", `${join(repo, "package.json")}:/repo/package.json:ro`];
  const dependencies = resolve(repo, options.nodeModules);
  assert.ok(existsSync(join(dependencies, "@playwright/test/package.json")), "--node-modules must name an installed pinned dependency tree");
  assert.equal(JSON.parse(readFileSync(join(dependencies, "@playwright/test/package.json"))).version,
    JSON.parse(readFileSync(join(repo, "package.json"))).devDependencies["@playwright/test"], "installed browser driver version mismatch");
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@playwright/test"];
  const toolRefs = { node: "node:24-bookworm-slim", checker: `mcr.microsoft.com/playwright:v${version}-noble`, edge: edgeImage, cert: edgeCertImage };
  const tools = {};
  const images = new Map();
  const fixtureDir = join(folder, "fixtures"); mkdirSync(fixtureDir); json(join(fixtureDir, "marketplace.json"), records());
  const fixture = ["-v", `${fixtureDir}:/fixtures:ro`];
  const checkout = async () => ({ commit: await command("git", ["rev-parse", "HEAD"]), dirty: await command("git", ["status", "--porcelain", "--untracked-files=all"]) });
  async function sourceHash(app) {
    const paths = app === "corten" ? ["bench/marketplace/corten", "crates", "Cargo.toml", "Cargo.lock"] : [`bench/fullstack/apps/${app}`];
    const files = (await command("git", ["ls-files", "--", ...paths])).split("\n").filter(Boolean).sort();
    return digest(JSON.stringify(files.map((p) => [p, digest(readFileSync(join(repo, p)))])));
  }
  async function appImage(app) {
    if (images.has(app)) return images.get(app);
    const source = await sourceHash(app), tag = `${runId}-${app}`;
    let image;
    if (options.build) {
      const context = app === "corten" ? repo : join(repo, "bench/fullstack/apps", app);
      const dockerfile = app === "corten" ? join(repo, "bench/marketplace/corten/Dockerfile") : join(context, "Dockerfile");
      await docker(["build", ...labels, "--label", `run.corten.marketplace.commit=${summary.commit}`, "--label", "run.corten.marketplace.dirty=false",
        "--label", `run.corten.marketplace.profile=${featureProfile}`, "--label", `run.corten.hardening.source=${source}`,
        "--build-arg", `PROFILE=${qualificationSettings.nativeProfile}`, "-t", tag, "-f", dockerfile, context], { timeout: 20 * 60 * 1000, file: join(folder, `build-${app}.log`) });
      summary.ownedImages ??= []; summary.ownedImages.push(tag);
      image = JSON.parse(await docker(["image", "inspect", tag]))[0];
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
    await owned(name, ["create", "--network", `container:${namespace}`, ...limits({ cpu: 2, memory }), "--shm-size", "1g", ...checkMounts,
      "-v", `${dependencies}:/repo/node_modules:ro`, ...fixture, "-v", `${out}:/results`,
      ...(existsSync(cert) ? ["-e", "NODE_EXTRA_CA_CERTS=/results/cert/cert.pem", "-e", "BENCH_EDGE_CERT=/results/cert/cert.pem"] : []),
      "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", tools.checker.Id, "node", ...args]);
    try { await docker(["start", "-a", name], { timeout, file: join(out, file) }); }
    finally { await remove(name); }
  }
  async function ready(namespace, out, image) {
    const name = `${runId}-ready`;
    await owned(name, ["create", "--network", `container:${namespace}`, ...limits(budget.resources.apparatus), tools.node.Id, "node", "--input-type=module", "-e",
      'const end=Date.now()+45000; while(true){try{const r=await fetch("http://127.0.0.1:8080/marketplace/en-US/item_1",{signal:AbortSignal.timeout(1000)});await r.arrayBuffer();if(r.status===200)break;}catch{}if(Date.now()>end)throw Error("native startup timeout");await new Promise(r=>setTimeout(r,100));}']);
    try { await docker(["start", "-a", name], { timeout: 50000, file: join(out, "ready.log") }); }
    finally { await remove(name); }
    assert.equal((await inspect(namespace)).Image, image, "native image changed");
  }
  async function cellRun(cell) {
    const out = join(folder, cell.key); mkdirSync(out, { recursive: true });
    const prefix = `${runId}-cell`, appName = `${prefix}-app`, upstreamName = `${prefix}-upstream`, edgeName = `${prefix}-edge`, probeName = `${prefix}-probe`;
    let startedWall, probeEndedWall, raw, settings, provenance, lifecycle, parity, processList, error, stage = "image-provenance";
    const targets = [], snapshot = {};
    try {
      const { image, source } = await appImage(cell.app);
      stage = "native-startup";
      const upstream = await owned(upstreamName, ["run", "-d", "--network", network, ...limits(budget.resources.upstream), ...mounted, ...fixture,
        tools.node.Id, "node", "/repo/bench/marketplace/upstream.mjs"]);
      targets.push({ id: "upstream", role: "upstream", name: upstreamName, info: upstream, source: summary.commit + ":bench/marketplace/upstream.mjs" });
      const app = await owned(appName, ["run", "-d", "--network", network, "--network-alias", "fsw-target", ...limits(budget.resources[cell.mode === "direct" ? "applicationDirect" : "applicationEdge"]), ...fixture,
        "-e", `MARKETPLACE_SOURCE=${cell.source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json", "-e", `API_BASE=http://${upstreamName}:8080`,
        "-e", "PORT=8080", "-e", "HOSTS=fsw-target,localhost,127.0.0.1", "-e", `PROFILE=${qualificationSettings.nativeProfile}`, "-e", `MAX_CONNECTIONS=${qualificationSettings.maxConnections}`, image.Id]);
      targets.push({ id: "application", role: "application", name: appName, info: app, source: `${summary.commit}:sha256:${source}` });
      await ready(appName, out, image.Id);
      stage = "production-qualification";
      await sidecar(`${prefix}-qualification`, appName, ["/repo/bench/marketplace/qualify.mjs", "http://127.0.0.1:8080", cell.source, `http://${upstreamName}:8080`, "/results/qualification.json"], out, "qualification.log", 8 * 60000);
      const qualification = validateQualification(JSON.parse(readFileSync(join(out, "qualification.json"), "utf8")));
      cell.nativeMissingFeatures = qualification.missing;
      stage = "native-controls";
      await sidecar(`${prefix}-native-controls`, appName, ["/repo/bench/hardening/native.mjs", "http://127.0.0.1:8080", cell.source, `http://${upstreamName}:8080`, "/results/qualification.json", "/results/native-controls.json"], out, "native-controls.log", 90000);
      cell.nativeAssessment = assessNative(JSON.parse(readFileSync(join(out, "native-controls.json"))), qualification);
      assert.notEqual(cell.nativeAssessment.sourceControl, "target-functional-failure", "native API-source controls failed; no attack qualification");
      // Missing defenses do NOT exclude an app. Functional/browser work is a separate prerequisite.
      stage = "native-parity";
      await sidecar(`${prefix}-parity`, appName, ["/repo/bench/hardening/parity.mjs", "http://127.0.0.1:8080", cell.source, `http://${upstreamName}:8080`, "/results/parity.json"], out, "parity.log", 10 * 60000);
      parity = JSON.parse(readFileSync(join(out, "parity.json"), "utf8")); verifyParity(parity, cell.source); cell.parity = "passed";
      let target = { host: "127.0.0.1", port: 8080, authority: "localhost:8080", origin: "http://localhost:8080", tls: false }, namespace = appName;
      if (cell.mode === "deployed-edge") {
        stage = "edge-deployment";
        const cert = join(out, "cert"); mkdirSync(cert);
        const certName = `${prefix}-certificate`;
        await owned(certName, ["create", "--network", "none", ...limits(budget.resources.apparatus), "-v", `${cert}:/cert`, tools.cert.Id,
          "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "/cert/key.pem", "-out", "/cert/cert.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
        try { await docker(["start", "-a", certName], { file: join(out, "certificate.log") }); } finally { await remove(certName); }
        const config = nginxConf([["target", { port: 8080 - edgeOffset }]], 1); writeFileSync(join(out, "nginx.conf"), config);
        const edge = await owned(edgeName, ["run", "-d", "--network", network, ...limits(budget.resources.proxy), "-v", `${cert}:/cert:ro`, "-v", `${join(out, "nginx.conf")}:/etc/nginx/nginx.conf:ro`, tools.edge.Id]);
        targets.push({ id: "proxy", role: "proxy", name: edgeName, info: edge, source: summary.commit + ":bench/fullstack/edge.mjs:nginxConf" });
        target = { host: "127.0.0.1", port: 8080, authority: "localhost:8080", origin: "https://localhost:8080", tls: true, caPem: readFileSync(join(cert, "cert.pem"), "utf8") }; namespace = edgeName;
        // The edge is a distinct deployment and must itself pass the complete content/browser gate.
        stage = "edge-parity";
        await sidecar(`${prefix}-edge-parity`, edgeName, ["/repo/bench/hardening/parity.mjs", "https://localhost:8080", cell.source, `http://${upstreamName}:8080`, "/results/parity.json"], out, "edge-parity.log", 10 * 60000);
        parity = JSON.parse(readFileSync(join(out, "parity.json"), "utf8")); verifyParity(parity, cell.source);
        stage = "edge-native-controls";
        await sidecar(`${prefix}-edge-controls`, edgeName, ["/repo/bench/hardening/native.mjs", "https://localhost:8080", cell.source, `http://${upstreamName}:8080`, "/results/qualification.json", "/results/edge-native-controls.json"], out, "edge-native-controls.log", 90000);
        cell.edgeAssessment = assessNative(JSON.parse(readFileSync(join(out, "edge-native-controls.json"))), qualification);
        assert.notEqual(cell.edgeAssessment.sourceControl, "target-functional-failure", "edge API-source controls failed");
      }
      // Native form metadata is discovered in the measured namespace, never supplied by an oracle.
      stage = "native-form";
      await sidecar(`${prefix}-form`, namespace, ["/repo/bench/hardening/form.mjs", JSON.stringify(target), "/results/form.json"], out, "form.log", 15000);
      const form = JSON.parse(readFileSync(join(out, "form.json"), "utf8"));
      processList = [];
      stage = "native-inventory";
      for (const t of targets) {
        const info = await inspect(t.name), top = await docker(["top", t.name, "-eo", "pid,ppid,comm,args"]);
        const count = top.split("\n").length - 1; assert.ok(count > 0); json(join(out, `${t.id}-before.json`), { info, top });
        snapshot[t.id] = { before: info }; processList.push({ id: t.id, role: t.role, count, containerId: info.Id });
      }
      const deployment = { mode: cell.mode, countAllProcesses: true, processes: processList.map(({ containerId, ...p }) => p) };
      settings = { review: options.review, case: cell.mode, phase: cell.phase, deployment, effectiveBudgets: JSON.stringify(budget) }; json(join(out, "settings.json"), settings);
      provenance = targets.map((t) => ({ id: t.id, image: t.info.Image, source: t.source, config: digest(readFileSync(join(out, `${t.id}-before.json`))), evidence: `${t.id}-before.json` }));
      const net = JSON.parse(await docker(["network", "inspect", network]))[0];
      assert.deepEqual(Object.keys(net.Containers).sort(), processList.map((p) => p.containerId).sort(), "unaccounted native process container on isolated network");
      json(join(out, "deployment.json"), { network: net, processes: processList, provenance, totalBudget: budget.resources });
      json(join(out, "probe.json"), { budget, phase: cell.phase, target, form, expected: records().item_1, processes: processList });
      await owned(probeName, ["create", "--network", `container:${namespace}`, ...limits(budget.resources.apparatus), "--cgroupns=host", "--pid=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", ...mounted, "-v", `${out}:/results`, tools.node.Id,
        "node", "/repo/bench/hardening/probe.mjs", "/results/probe.json", "/results/raw.jsonl"]);
      startedWall = new Date().toISOString();
      stage = "native-injection";
      try { await docker(["start", "-a", probeName], { timeout: budget.legitimate.after.endMs + 20000, file: join(out, "probe.log") }); }
      finally { probeEndedWall = Date.now(); await remove(probeName); }
      raw = readFileSync(join(out, "raw.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const clock = raw.find((r) => r.type === "clock"); assert.ok(clock);
      lifecycle = {};
      stage = "native-lifecycle";
      for (const t of targets) {
        const after = await inspect(t.name);
        const until = new Date().toISOString();
        const eventsText = await docker(["events", "--since", clock.wallAtStart, "--until", until, "--filter", `container=${t.info.Id}`, "--format", "{{json .}}"]);
        const events = eventsText ? eventsText.split("\n").map((line) => JSON.parse(line)) : [];
        const top = after.State.Running ? await docker(["top", t.name, "-eo", "pid,ppid,comm,args"]) : null;
        lifecycle[t.id] = { ...snapshot[t.id], after, events, top }; json(join(out, `${t.id}-lifecycle.json`), lifecycle[t.id]);
        if (t.role === "upstream" && cell.source === "fixture") assert.ok(after.State.Running && after.State.StartedAt === t.info.State.StartedAt, "idle fixture upstream apparatus stopped/restarted");
      }
    } catch (e) { error = e; }
    finally {
      for (const t of targets) {
        try { writeFileSync(join(out, `${t.id}.log`), await docker(["logs", t.name], { cleanup: true })); } catch (e) { error ??= e; }
      }
      const failures = [];
      for (const name of [...active]) { try { await remove(name); } catch (e) { failures.push(e.message); } }
      // Private ephemeral TLS/form material has no evidentiary role after its digests are saved.
      for (const file of [join(out, "cert/key.pem"), join(out, "form.json"), join(out, "probe.json")]) if (existsSync(file)) rmSync(file);
      let nativeClock = null;
      if (raw) {
        const name = `${prefix}-cleanup-clock`;
        try {
          await owned(name, ["create", "--network", "none", ...limits(budget.resources.apparatus), ...mounted, tools.node.Id, "node", "/repo/bench/hardening/clock.mjs"]);
          nativeClock = JSON.parse(await docker(["start", "-a", name], { cleanup: true }));
        } catch (e) { failures.push(e.message); }
        finally { try { await remove(name); } catch (e) { failures.push(e.message); } }
      }
      const containers = (await docker(["ps", "-aq", "--filter", `label=${label}=${runId}`], { cleanup: true })).split("\n").filter(Boolean);
      const volumes = (await docker(["volume", "ls", "-q", "--filter", `label=${label}=${runId}`], { cleanup: true })).split("\n").filter(Boolean);
      const cleanup = { complete: failures.length === 0 && containers.length === 0 && volumes.length === 0 && children.size === 0,
        containers, volumes, commandClients: children.size, failures, nativeClock, elapsedAfterProbeMs: probeEndedWall ? Date.now() - probeEndedWall : null, finishedAt: new Date().toISOString() };
      json(join(out, "cleanup.json"), cleanup);
      if (!cleanup.complete) { summary.cleanupFailures.push({ key: cell.key, cleanup }); error ??= new Error("owned cleanup failed"); stage = "owned-cleanup"; }
      if (!error) {
        try {
          stage = "evidence-validation";
          const manifest = artifacts(out); json(join(out, "manifest.json"), manifest); verifyArtifacts(out, manifest);
          const capture = assemble({ settings, raw, parity, source: cell.source, cleanup, provenance, lifecycle });
          json(join(out, "capture.json"), capture); cell.status = "observed"; cell.apparatusValid = true;
          cell.defense = capture.defense.protection; cell.recovery = capture.recovery.disposition; cell.capture = `${cell.key}/capture.json`;
          cell.targetOutcome = targetOutcome(capture, cell.nativeAssessment);
        } catch (e) { error = e; }
      }
      if (error) { cell.status = "invalid"; cell.apparatusValid = false; cell.error = error.message; cell.failedStage = stage;
        cell.failureKind = ["native-parity", "edge-parity", "native-form"].includes(stage) ? "parity-blocked" : "apparatus-invalid";
        json(join(out, "failure.json"), { error: error.stack, startedWall, stage, kind: cell.failureKind }); summary.failures.push({ key: cell.key, stage, kind: cell.failureKind, error: error.message }); }
    }
  }
  try {
    const state = await checkout(); assert.equal(state.dirty, "", "commit scoped runner and native sources before capturing exact provenance");
    summary.commit = state.commit; summary.fixtureSha256 = digest(readFileSync(join(fixtureDir, "marketplace.json")));
    for (const [key, ref] of Object.entries(toolRefs)) tools[key] = JSON.parse(await docker(["image", "inspect", ref]))[0];
    summary.tools = tools; save();
    await docker(["network", "create", ...labels, network]); networkCreated = true;
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
    if (networkCreated) try {
      const info = JSON.parse(await docker(["network", "inspect", network], { cleanup: true }))[0]; assert.equal(info.Labels?.[label], runId);
      assert.equal(Object.keys(info.Containers).length, 0); await docker(["network", "rm", info.Id], { cleanup: true });
    } catch (e) { summary.cleanupFailures.push(e.message); }
    for (const image of summary.ownedImages ?? []) try { await docker(["image", "rm", image], { cleanup: true }); } catch (e) { summary.cleanupFailures.push(e.message); }
    if (summary.cleanupFailures.length) summary.groupReady = false;
    summary.finishedAt = new Date().toISOString(); save();
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
  console.log(JSON.stringify({ output: folder, groupReady: summary.groupReady, observed: summary.cells.filter((c) => c.status === "observed").length, invalid: summary.cells.filter((c) => c.status === "invalid").length, notRun: summary.cells.filter((c) => c.status === "not-run").length, cleanupFailures: summary.cleanupFailures.length }));
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run(process.argv.slice(2));
  if (result.failures.length || result.cleanupFailures.length || (!Object.keys(result.options.verify).length && !result.groupReady)) process.exitCode = 1;
}
