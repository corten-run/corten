// Local native mixed-production execution. Never imports a cloud or nightly entry point.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commands } from "../json-api/process.mjs";
import { slowMs } from "../fullstack/mixed.mjs";
import { maxConnections } from "../fullstack/conformance.mjs";
import { records as fixtureRecords } from "../marketplace/fixtures.mjs";

export function parseArgs(args) {
  const options = { round: args[0], apps: null, images: null, readbacks: null, build: false, buildRef: null, seed: 42, clients: 2, repetitions: 1,
    measure: false, profile: "defaults", passes: 3, duration: 120, warmup: 15, calibration: 30, tailSeconds: 120, maxCycles: 16,
    requestTimeoutMs: 60000, completeDelayMs: 100, slowDelayMs: slowMs, cancelAfterMs: 50, cleanupMs: 500, startupTimeoutMs: 120000 };
  assert.match(options.round ?? "", /^w[1-9]\d*$/, "use a fresh local development identity wN");
  const names = { "request-timeout-ms": "requestTimeoutMs", "complete-delay-ms": "completeDelayMs", "slow-delay-ms": "slowDelayMs",
    "cancel-after-ms": "cancelAfterMs", "cleanup-ms": "cleanupMs", "startup-timeout-ms": "startupTimeoutMs", "tail-seconds": "tailSeconds", "max-cycles": "maxCycles" };
  const seen = new Set();
  for (let i = 1; i < args.length;) {
    const flag = args[i++]; assert.ok(flag?.startsWith("--") && !seen.has(flag), "missing/duplicate option"); seen.add(flag);
    if (["--build", "--measure"].includes(flag)) { options[flag.slice(2)] = true; continue; }
    assert.ok(args[i] && !args[i].startsWith("--"), "option value required");
    const key = flag === "--build-ref" ? "buildRef" : names[flag.slice(2)] ?? flag.slice(2); assert.ok(key !== "round" && Object.hasOwn(options, key), "unknown option");
    options[key] = ["apps", "images", "readbacks", "buildRef", "profile"].includes(key) ? args[i++] : Number(args[i++]);
  }
  if (options.apps) { options.apps = options.apps.split(","); assert.equal(new Set(options.apps).size, options.apps.length, "duplicate app"); }
  for (const key of ["seed", "clients", "repetitions", ...Object.values(names)]) assert.ok(Number.isSafeInteger(options[key]) && options[key] >= (key === "seed" ? 0 : 1), "positive integer settings required");
  assert.ok(options.seed <= 0xffffffff && options.clients <= 32 && options.repetitions <= 10, "bounded functional plan required");
  assert.ok(options.slowDelayMs > options.cancelAfterMs && options.completeDelayMs < options.requestTimeoutMs, "invalid fault schedule");
  assert.ok(options.slowDelayMs <= 120000 && options.requestTimeoutMs <= 120000 && options.startupTimeoutMs <= 120000 && options.cleanupMs <= 10000, "bounded timeouts required");
  assert.ok(!options.build || !options.images, "--build cannot use arbitrary image overrides");
  assert.ok(!options.buildRef || options.build && /^[a-f0-9]{7,40}$/i.test(options.buildRef), "--build-ref requires --build and a local commit hash");
  assert.ok(["defaults", "matched"].includes(options.profile), "unknown native configuration variant");
  for (const [key, min, max] of [["passes", 1, 5], ["duration", 1, 300], ["warmup", 1, 120], ["calibration", 1, 120], ["tailSeconds", 1, 120], ["maxCycles", 1, 128]]) {
    assert.ok(Number.isSafeInteger(options[key]) && options[key] >= min && options[key] <= max, "bounded load settings required");
  }
  assert.ok(!options.measure || options.build && options.clients >= 2, "measurement requires fresh native builds and at least two clients");
  return options;
}

export async function run(args) {
  const options = parseArgs(args);
  // registry imports legacy inventory; legacy environment filters must not change this group.
  const saved = Object.fromEntries(["BENCH_APPS", "BENCH_TIER", "BENCH_EDGE"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  let registry, mixed, capturesAPI;
  try { registry = await import("../workloads/registry.mjs"); mixed = await import("../workloads/mixed.mjs"); capturesAPI = await import("./capture.mjs"); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const inventory = registry.selectedApps("mixed-production");
  const { createPlan } = mixed;
  const { afterFunctionalGate, combine, emptyCapture, oracle, sha256, sleep } = capturesAPI;
  options.apps ??= [...inventory];
  assert.ok(options.apps.every((app) => inventory.includes(app)), "app outside selected mixed-production inventory");
  assert.ok(!options.measure || options.apps.length === inventory.length && inventory.every((app) => options.apps.includes(app)), "measurement requires the full retained inventory");
  const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, "../..");
  const images = options.images ? JSON.parse(readFileSync(resolve(options.images), "utf8")) : {};
  const readbacks = options.readbacks ? JSON.parse(readFileSync(resolve(options.readbacks), "utf8")) : {};
  for (const mapping of [images, readbacks]) assert.ok(mapping && !Array.isArray(mapping) && Object.keys(mapping).every((app) => inventory.includes(app)), "mapping outside inventory");
  for (const path of Object.values(readbacks)) assert.ok(typeof path === "string" && /^\/(?!\/)[^?#\\\s]+$/.test(path), "readback must be a public local path without tokens");
  const folder = join(here, "results", options.round);
  mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder);
  const runId = `mixed-${options.round}-${randomBytes(4).toString("hex")}`, network = `${runId}-net`;
  const io = commands(repo), docker = (args, opts) => io.command("docker", args, opts);
  const active = new Set(), builtImages = new Set(); let networkCreated = false;
  const label = "run.corten.mixed-production", token = randomBytes(32).toString("hex");
  const records = fixtureRecords(), plan = createPlan({ seed: options.seed, clients: options.clients, repetitions: options.repetitions, records });
  const summary = { schema: "mixed-native-run/v1", group: "mixed-production", inventory, definition: registry.definition("mixed-production"),
    contractSha256: registry.contractSha256("mixed-production"), retainedFamilies: registry.retainedFamilies, round: options.round, runId, options,
    startedAt: new Date().toISOString(), complete: false, functionalPassed: false, readyForLoad: false, timing: null, timingBlocked: true,
    scope: options.measure
      ? "Native full-inventory functional/production gates followed by real calibrated equal-plan windows when eligible; no saturation/capacity or concurrent-workstation comparison claim."
      : "Native deterministic functional captures only; no production qualification, load, CPU, browser readiness or performance baseline claim.",
    host: { hostname: hostname(), platform: platform(), release: release(), node: process.version }, provenance: {}, tools: {}, failures: [], cleanupFailures: [],
    apps: Object.fromEntries(inventory.map((app) => [app, { selected: options.apps.includes(app), sources: {}, cells: plan.requests.map((request) => ({ requestId: request.id,
      category: request.category, source: request.source, locale: request.locale, variant: request.variant, outcome: "not-run", status: 0, passed: false,
      error: null, gaps: [options.apps.includes(app) ? "execution-not-reached" : "development-subset-not-selected"] })) }])) };
  const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
  writeFileSync(join(folder, "plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(folder, "marketplace.json"), JSON.stringify(records));
  summary.provenance.fixtureSha256 = sha256(readFileSync(join(folder, "marketplace.json")));
  summary.provenance.harnessFiles = Object.fromEntries(["capture.mjs", "native.mjs", "upstream.mjs", "worker.mjs", "run.mjs"].map((file) => [file, sha256(readFileSync(join(here, file)))]));
  const inspect = async (name) => JSON.parse(await docker(["inspect", name], { cleanup: true }))[0];
  const own = async (args, name) => {
    active.add(name);
    await docker([args[0], "--name", name, "--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`, ...args.slice(1)]);
  };
  const remove = async (name) => {
    if (await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], { cleanup: true })) {
      const info = await inspect(name); assert.equal(info.Config.Labels?.[label], runId, "refusing unowned cleanup");
      await docker(["rm", "-f", "-v", info.Id], { cleanup: true });
    }
    active.delete(name);
  };
  const fail = (app, source, stage) => { summary.failures.push({ app, source, stage }); save(); };
  const ready = async (name, path, probes, role) => {
    const info = await inspect(name), port = info.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
    assert.ok(port, "private readiness port missing");
    const until = Date.now() + options.startupTimeoutMs;
    do {
      if (io.interrupted) throw new Error("interrupted");
      try {
        const timeout = Math.max(1, Math.min(10000, until - Date.now()));
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeout), redirect: "manual" });
        const body = Buffer.from(await r.arrayBuffer());
        probes.push({ role, path, status: r.status, contentType: r.headers.get("content-type"), decodedBodyBytes: body.length, decodedBodySha256: sha256(body) });
        if (r.status === 200) return;
      } catch { probes.push({ role, path, status: 0, error: "readiness-timeout-or-network-error" }); }
      await sleep(100);
    } while (Date.now() < until);
    throw new Error("readiness failed");
  };
  const toolImage = async (tag) => {
    try { return JSON.parse(await docker(["image", "inspect", tag]))[0]; }
    catch {
      await docker(["pull", tag], { timeout: 5 * 60 * 1000, file: join(folder, "tools-pull.log") });
      return JSON.parse(await docker(["image", "inspect", tag]))[0];
    }
  };
  save();
  try {
    summary.provenance.commit = await io.command("git", ["rev-parse", "HEAD"]);
    summary.provenance.dirty = await io.command("git", ["status", "--porcelain"]);
    summary.provenance.sharedFiles = Object.fromEntries(["bench/workloads/mixed.mjs", "bench/workloads/registry.mjs", "bench/marketplace/check.mjs", "bench/marketplace/records.mjs", "bench/marketplace/labels.json"].map((file) => [file, sha256(readFileSync(join(repo, file)))]));
    let buildRoot = repo;
    const nativeSource = summary.provenance.nativeSource = { kind: "checkout", commit: summary.provenance.commit,
      dirty: summary.provenance.dirty.length > 0 };
    if (options.buildRef) {
      nativeSource.kind = "git-archive";
      nativeSource.commit = await io.command("git", ["rev-parse", "--verify", `${options.buildRef}^{commit}`]);
      nativeSource.tree = await io.command("git", ["rev-parse", `${nativeSource.commit}^{tree}`]);
      nativeSource.dirty = false;
      buildRoot = join(folder, "build-source"); mkdirSync(buildRoot);
      const archive = join(folder, "build-source.tar");
      await io.command("git", ["archive", "--format=tar", "--output", archive, nativeSource.commit], { timeout: 60000 });
      nativeSource.archiveSha256 = sha256(readFileSync(archive));
      await io.command("tar", ["-xf", archive, "-C", buildRoot], { timeout: 60000 });
    }
    summary.tools.docker = await io.command("docker", ["version", "--format", "{{.Server.Version}}"]);
    const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@playwright/test"];
    const nodeImage = await toolImage("node:24-bookworm-slim");
    const browserImage = await toolImage(`mcr.microsoft.com/playwright:v${version}-noble`);
    summary.tools.nodeImage = nodeImage.Id; summary.tools.browserImage = browserImage.Id; summary.tools.playwright = version;
    assert.ok(existsSync(join(repo, "node_modules", "@playwright", "test")), "install tooling dependencies or link main checkout dependencies");
    await docker(["network", "create", "--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`, network]); networkCreated = true;
    const parts = Object.fromEntries(inventory.map((app) => [app, []]));
    for (const app of options.apps) {
      if (io.interrupted) throw new Error("run interrupted");
      const entry = summary.apps[app];
      try {
        const tag = options.build ? `${runId}-${app}` : images[app] ?? `cb-marketplace-${app}`;
        if (options.build) {
          const context = app === "corten" ? buildRoot : join(buildRoot, "bench/fullstack/apps", app);
          const dockerfile = app === "corten" ? join(buildRoot, "bench/marketplace/corten/Dockerfile") : join(context, "Dockerfile");
          builtImages.add(tag);
          // Benchmark apps are excluded from the Rust workspace and require their existing
          // ecosystem Dockerfiles, not a replacement Cargo build or ad hoc target volume.
          await docker(["build", "--label", "agent.owner=codex", "--label", `agent.task=${runId}`,
            "--label", `run.corten.marketplace.commit=${nativeSource.commit}`, "--label", `run.corten.marketplace.dirty=${nativeSource.dirty}`,
            "--label", `run.corten.marketplace.profile=${options.profile}`, "--build-arg", `PROFILE=${options.profile}`,
            "-t", tag, "-f", dockerfile, context], { timeout: 20 * 60 * 1000, file: join(folder, `${app}-build.log`) });
          if (!options.buildRef) {
            assert.equal(await io.command("git", ["rev-parse", "HEAD"]), summary.provenance.commit, "checkout changed during build");
            assert.equal(await io.command("git", ["status", "--porcelain"]), summary.provenance.dirty, "working tree changed during build");
          }
        }
        const image = JSON.parse(await docker(["image", "inspect", tag]))[0];
        entry.image = { tag, id: image.Id, repoDigests: image.RepoDigests, bytes: image.Size,
          buildCommit: image.Config.Labels?.["run.corten.marketplace.commit"] ?? null,
          buildDirty: image.Config.Labels?.["run.corten.marketplace.dirty"] ?? null,
          profile: image.Config.Labels?.["run.corten.marketplace.profile"] ?? null };
      } catch { fail(app, null, "native-image-unavailable"); entry.cells.forEach((cell) => cell.gaps = ["native-image-unavailable"]); continue; }
      for (const source of ["fixture", "api"]) {
        if (io.interrupted) throw new Error("run interrupted");
        const appName = `${runId}-${app}-${source}`, upstreamName = `${appName}-upstream`, workerName = `${appName}-capture`;
        const raw = join(folder, app, source); mkdirSync(raw, { recursive: true });
        const mount = ["-v", `${repo}:/src:ro`, "-v", `${realpathSync(join(repo, "node_modules"))}:/src/node_modules:ro`, "-v", `${folder}:/out`, "-w", "/src"];
        const sourceEntry = entry.sources[source] = { complete: false, readiness: [] };
        let stage = "upstream-create";
        console.log(`${app} ${source}: capturing ${plan.requests.filter((r) => r.source === source).length} planned native operations`);
        try {
          await own(["run", "-d", "--network", network, "--cpus", "2", "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
            "-e", `MIXED_CONTROL_TOKEN=${token}`, "-e", "MARKETPLACE_FIXTURE_PATH=/out/marketplace.json", nodeImage.Id, "node", "bench/mixed-production/upstream.mjs"], upstreamName);
          stage = "upstream-readiness";
          await ready(upstreamName, "/health", sourceEntry.readiness, "upstream");
          // Readiness may fetch the record; put that in a distinct injector operation.
          const upInfo = await inspect(upstreamName), upPort = upInfo.NetworkSettings.Ports["8080/tcp"][0].HostPort;
          const { control } = await import("./capture.mjs");
          stage = "upstream-startup-control";
          await control(`http://127.0.0.1:${upPort}`, token, "startup", { mode: "normal", delayMs: 0 });
          stage = "app-create";
          await own(["run", "-d", "--network", network, "--cpus", "1", "--memory", "1g", "-p", "127.0.0.1::8080", "-v", `${folder}:/fixtures:ro`,
            "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json", "-e", `API_BASE=http://${upstreamName}:8080`,
            "-e", "PORT=8080", "-e", `HOSTS=${appName},localhost,127.0.0.1`,
            ...(options.profile === "matched" ? ["-e", "PROFILE=matched", "-e", `MAX_CONNECTIONS=${maxConnections}`] : ["-e", "PROFILE="]), entry.image.id], appName);
          stage = "app-readiness";
          await ready(appName, "/marketplace/en-US/item_1", sourceEntry.readiness, "app");
          const config = { plan, records, app, source, base: `http://${appName}:8080`, upstream: `http://${upstreamName}:8080`, settings: options,
            folder: `/out/${app}/${source}`, readbackPath: readbacks[app] ?? "/api/alerts" };
          config.base = "http://127.0.0.1:8080";
          writeFileSync(join(raw, "settings.json"), JSON.stringify(config, null, 2));
          stage = "worker-create";
          await own(["create", "--network", `container:${appName}`, "--cpus", "2", "--memory", "1g", "--shm-size", "512m", ...mount,
            "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "-e", `MIXED_CONTROL_TOKEN=${token}`, browserImage.Id, "node", "bench/mixed-production/worker.mjs", `/out/${app}/${source}/settings.json`], workerName);
          const operationCount = plan.requests.filter((r) => r.source === source).length;
          stage = "worker-capture";
          await docker(["start", "-a", workerName], { timeout: Math.min(20 * 60 * 1000, operationCount * (options.requestTimeoutMs * 5 + options.cleanupMs + 1000) + 20000) });
          stage = "worker-artifacts";
          const result = JSON.parse(readFileSync(join(raw, "capture.json"), "utf8"));
          assert.equal(result.cells.length, operationCount, "partial worker capture");
          parts[app].push({ ...result, source }); Object.assign(sourceEntry, { complete: true, capture: `${app}/${source}/capture.json` });
          for (const cell of result.cells) Object.assign(entry.cells.find((c) => c.requestId === cell.requestId), cell);
        } catch {
          fail(app, source, `native-source-${stage}-failed`);
          sourceEntry.failedStage = stage;
          for (const cell of entry.cells.filter((c) => c.source === source)) cell.gaps = [`native-source-${stage}-failed-or-missing-capture`];
          // Recover every incrementally saved attempted row after worker timeout/crash.
          const capture = emptyCapture(plan, app);
          for (const request of plan.requests.filter((r) => r.source === source)) {
            const path = join(raw, `${request.id}.json`);
            if (!existsSync(path)) continue;
            const saved = JSON.parse(readFileSync(path, "utf8")); capture.results[request.index] = saved.row;
            Object.assign(entry.cells.find((c) => c.requestId === request.id), { outcome: saved.row.outcome, status: saved.row.status, passed: false,
              gaps: [...saved.evidence.gaps, "source-capture-incomplete"] });
          }
          parts[app].push({ capture, source });
        } finally {
          try {
            const info = await inspect(appName);
            entry.sources[source] ??= { complete: false };
            entry.sources[source].container = { imageId: info.Image, startedAt: info.State.StartedAt, running: info.State.Running, exitCode: info.State.ExitCode, oomKilled: info.State.OOMKilled };
          } catch { /* Failed creates have no container state. */ }
          for (const name of [workerName, appName, upstreamName]) try { await remove(name); } catch { summary.cleanupFailures.push({ name }); }
          save();
        }
      }
    }
    const captures = {};
    for (const app of inventory) {
      const capture = combine(plan, app, parts[app]); captures[app] = capture;
      const checked = oracle(plan, capture, records); summary.apps[app].oracle = checked;
      writeFileSync(join(folder, `${app}-capture.json`), JSON.stringify(capture, null, 2));
    }
    try {
      await afterFunctionalGate({ apps: options.apps, inventory, plan, captures, records }, async () => {
        summary.functionalPassed = true;
        if (!options.measure) {
          summary.timingBlockReason = "functional-only run: request --measure for real production qualification/calibration/windows";
          return;
        }
        const { measureNativeGroup } = await import("./measure.mjs");
        summary.timing = await measureNativeGroup({ summary, options, folder, repo, runId, network, nodeImage, browserImage, plan, records, token, readbacks,
          docker, io, own, remove, inspect, ready, save, captures });
        summary.readyForLoad = summary.timing.qualified && summary.timing.calibrated;
        summary.timingBlocked = summary.timing.timingBlocked;
        summary.timingBlockReason = summary.timing.complete ? null : "native production qualification, calibration or steady window failed; retain all cells";
      });
    } catch {
      summary.timingBlockReason = summary.functionalPassed ? "native measurement setup/execution failed" : "complete selected inventory must pass the existing mixed oracle on real native captures";
      if (summary.functionalPassed && options.measure) fail(null, null, "native-measurement-setup-or-execution-failed");
    }
    summary.complete = inventory.every((app) => summary.apps[app].sources.fixture?.complete && summary.apps[app].sources.api?.complete);
  } catch { fail(null, null, "suite-setup-or-execution-failed"); }
  finally {
    for (const name of [...active]) try { await remove(name); } catch { summary.cleanupFailures.push({ name }); }
    if (networkCreated) try {
      const info = JSON.parse(await docker(["network", "inspect", network], { cleanup: true }))[0];
      assert.equal(info.Labels?.[label], runId); await docker(["network", "rm", network], { cleanup: true });
    } catch { summary.cleanupFailures.push({ network }); }
    for (const tag of builtImages) try {
      const existing = await docker(["image", "ls", "--filter", `reference=${tag}`, "--format", "{{.ID}}"], { cleanup: true });
      if (!existing) continue;
      const info = JSON.parse(await docker(["image", "inspect", tag], { cleanup: true }))[0];
      assert.equal(info.Config.Labels?.["agent.task"], runId, "refusing unowned image cleanup");
      await docker(["image", "rm", tag], { cleanup: true });
    } catch { summary.cleanupFailures.push({ image: tag }); }
    summary.finishedAt = new Date().toISOString(); save(); io.dispose();
  }
  console.log(`saved ${folder}; functionalPassed=${summary.functionalPassed}; timingBlocked=${summary.timingBlocked}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await run(process.argv.slice(2)); if (!result.functionalPassed || result.options.measure && result.timingBlocked || result.failures.length || result.cleanupFailures.length) process.exitCode = 1; }
  catch { console.error("mixed native runner: invalid configuration or unavailable local output"); process.exitCode = 1; }
}
