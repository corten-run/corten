// Native JSON-only runner. Explicit selection; no cloud, schedule or old-runner side effects.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commands } from "./process.mjs";
import { startLoadResourceCapture } from "./load-resource-capture.mjs";
import { describeK6 } from "../load-tool.mjs";

export async function settleJsonRun({ observeTail, cleanup, checkProvenance, recordFailure, publish, dispose }) {
  try {
    try { await observeTail(); }
    catch (error) { recordFailure("terminal upstream observation", error); }
    finally { await cleanup(); }
    try { await checkProvenance(); }
    catch (error) { recordFailure("tree provenance", error); }
    publish();
  } finally { dispose(); }
}

export async function run(args) {
  const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, "../..");
  // These legacy selectors cannot pre-filter the registry or its ESM dependencies.
  const saved = Object.fromEntries(["BENCH_APPS", "BENCH_TIER"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  let c, artifacts, evidence, matrix, stats, reporting, production, phaseCapture, outcomes, readUpstreamSnapshot, placement;
  try {
    c = await import("./contract.mjs"); artifacts = await import("./artifacts.mjs"); evidence = await import("./evidence.mjs");
    matrix = await import("./matrix.mjs"); stats = await import("../catalog/stats.mjs"); reporting = await import("./report.mjs");
    production = await import("./production.mjs"); phaseCapture = await import("./phase.mjs"); outcomes = await import("./timed-outcomes.mjs");
    ({ readUpstreamSnapshot } = await import("./check.mjs")); placement = await import("./placement.mjs");
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const options = c.parseArgs(args), group = c.descriptor();
  // Without JSON_API_LOAD_LAYOUT this is exactly c.cpuSettings(process.env). An opt-in layout
  // refuses here, before any result folder or container, if the host has too few CPUs.
  const layout = placement.runnerPlacement(process.env, availableParallelism()), cpus = layout.cpus;
  const folder = join(here, "results", options.round);
  mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder); // Never overwrite old evidence.
  const runId = `json-api-${options.round}-${randomBytes(5).toString("hex")}`, network = `${runId}-net`, label = "run.corten.json-api";
  const processIO = commands(repo), command = processIO.command;
  const docker = (args, opts) => command("docker", args, opts);
  const summary = { schema: c.timedSchema, producer: production.producerProvenance(c.scheduledProducerSchema), group, options, timingPlan: c.timingPlan(options), round: options.round, runId, startedAt: new Date().toISOString(), complete: false, attemptComplete: false, checksPassed: false,
    failures: [], cleanupFailures: [], fixtures: {}, tools: {}, host: { hostname: hostname(), platform: platform(), release: release(), node: process.version, checkout: repo.replaceAll("\\", "/") },
    measurement: { cpus, ...(layout.loadLayout === undefined ? {} : { loadLayout: layout.loadLayout, generatorPlacement: layout.generatorPlacement }), encoding: "identity", fixedRate: options.rate, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20,
      loadMemoryBytes: 2 ** 31, nativeProfile: group.nativeProfile, phases: ["warmup", ...c.phases] },
    apps: Object.fromEntries(options.apps.map((app) => [app, { images: {}, checks: {}, runs: Object.fromEntries(group.cases.map((p) => [p.key, []])),
      aggregates: Object.fromEntries(group.cases.map((p) => [p.key, {}])), projections: Object.fromEntries(group.cases.map((p) => [p.key, outcomes.timedCaseProjection([], options.passes)])) }])) };
  // The untimed cold probe and CPU counter reader stay on 4-7 under either opt-in layout.
  const probeCpus = placement.coldProbeCpus(summary.measurement);
  const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
  const log = (line) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); appendFileSync(join(folder, "run.log"), `${text}\n`); };
  const recordFailure = (app, key, stage, error) => summary.failures.push({ app, key, stage, error: error.stack ?? String(error) });
  const fail = (app, key, stage, error) => { recordFailure(app, key, stage, error); log(`${app ?? "suite"} ${key ?? ""}: ${stage}: ${error.message}`); save(); };
  const cleanupFailure = (resource) => (error) => { summary.cleanupFailures.push({ resource, error: error.message }); };
  const active = new Set(), upstreams = {}, fixtureDirs = {}, mount = ["-v", `${join(repo, "bench")}:/bench:ro`];
  const write = artifacts.writer(folder), loadArtifact = artifacts.reader(folder);
  const inspect = async (name, cleanup = false) => JSON.parse(await docker(["inspect", name], { cleanup }))[0];
  const own = async (args, name) => {
    active.add(name);
    await docker([args[0], "--name", name, "--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`, ...args.slice(1)]);
  };
  const remove = async (name) => {
    if (await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], { cleanup: true })) {
      const info = await inspect(name, true); assert.equal(info.Config.Labels?.[label], runId, "refusing unowned cleanup");
      await docker(["rm", "-f", "-v", info.Id], { cleanup: true });
    }
    active.delete(name);
  };
  const port = async (name) => { const info = await inspect(name); const p = info.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort; assert.ok(p, "missing private port"); return `http://127.0.0.1:${p}`; };
  const ready = async (base, path) => {
    const deadline = Date.now() + options.startupTimeout * 1000;
    while (Date.now() < deadline) {
      if (processIO.interrupted) throw new Error("interrupted");
      try { const r = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(1000) }); await r.arrayBuffer(); if (r.status === 200) return; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`JSON endpoint not ready within ${options.startupTimeout}s`);
  };
  const imageTool = async (tag) => {
    let image;
    try { image = JSON.parse(await docker(["image", "inspect", tag]))[0]; }
    catch { await docker(["pull", tag], { timeout: 10 * 60 * 1000, file: join(folder, "pull.log") }); image = JSON.parse(await docker(["image", "inspect", tag]))[0]; }
    return { image: tag, imageId: image.Id, execution: c.imageCommandEvidence(image) };
  };
  const upstreamSnapshot = (payload) => readUpstreamSnapshot(`${upstreams[payload].url}/__${c.payloads[payload].path}/control`);
  const apiReads = async (payload) => (await upstreamSnapshot(payload)).upstreamReads;
  const cpuName = `${runId}-cpu`;
  const counters = async (names) => {
    const ids = await Promise.all(names.map(async (n) => (await inspect(n)).Id));
    const usage = JSON.parse(await docker(["exec", cpuName, "node", "/bench/catalog/cgroup.mjs", ...ids]));
    return Object.fromEntries(names.map((n, i) => [n, usage[ids[i]]]));
  };
  let receipts = [], verifiedFunctionalFailure = false;
  const qualify = (expected) => {
    const found = receipts.filter((r) => r.identity?.app === expected.app && r.identity?.key === expected.key);
    assert.equal(found.length, 1, "exactly one independently audited native receipt required");
    const receipt = found[0], files = {};
    for (const f of receipt.sourceFiles ?? []) {
      assert.ok(/^(bench|crates)\//.test(f.path), "audit source must stay in bench/crates");
      files[f.path] = artifacts.readContained(repo, f.path).toString("utf8");
    }
    c.verifyNativeReceipt(receipt, expected, files, { timed: true });
    return { receipt, files };
  };
  const argsFor = (name, profile, imageId) => c.appArgs({ name, profile, imageId, network, upstream: `http://${upstreams[profile.payload].name}:8080`, fixtures: fixtureDirs[profile.payload], cpus });

  async function cold(name, profile, image, expected, path) {
    const probe = `${name}-probe`;
    const upstreamBefore = await apiReads(profile.payload);
    await own(["create", ...argsFor(name, profile, image)], name);
    try {
      await own(["run", "-d", "--network", network, ...probeCpus.args, "--memory", "256m", ...mount, summary.tools.node.imageId,
        "node", "/bench/json-api/cold.mjs", `http://${name}:8080`, c.route(profile), String(options.startupTimeout)], probe);
      const deadline = Date.now() + 10000;
      while (!(await docker(["logs", probe])).includes("json-probe-ready")) {
        assert.ok(Date.now() < deadline, "cold sidecar not ready"); await new Promise((r) => setTimeout(r, 50));
      }
      await docker(["start", name]); assert.equal(await docker(["wait", probe], { timeout: (options.startupTimeout + 5) * 1000 }), "0");
      const output = await docker(["logs", probe]); writeFileSync(join(folder, path, "cold.log"), output);
      const result = JSON.parse(output.split("\n").findLast((line) => line.startsWith("{")));
      const info = await inspect(name); result.containerStartedAt = info.State.StartedAt;
      result.first200MsFromContainerStart = Date.parse(result.first200At) - Date.parse(result.containerStartedAt); result.measuredBeforeReadinessOrWarmup = true;
      const context = { ...c.runtimeContext(summary, profile), cold: true };
      const upstream = await inspect(upstreams[profile.payload].name);
      const raw = { identity: expected, result, runtime: c.runtimeReceipt(info, expected, context), upstreamLife: production.life(upstream),
        upstreamReads: { before: upstreamBefore, after: await apiReads(profile.payload) },
        participants: { upstream: c.participantReceipt(upstream, expected, context, "upstream"),
          probe: c.participantReceipt(await inspect(probe), expected, context, "probe") } };
      evidence.verifyCold(raw, expected, options, context);
      return { result, raw: write(`${path}/cold.json`, raw) };
    } finally { await remove(probe); }
  }
  async function phase(name, profile, expected, stage, path, priorTailUnobserved = false) {
    const config = c.loadConfig(options, stage), k6 = `${runId}-k6`, up = upstreams[profile.payload].name;
    const names = [name, ...(profile.source === "api" ? [up] : [])], roles = ["app", ...(profile.source === "api" ? ["upstream"] : [])];
    const statsPath = join(folder, path, `${stage}-stats.log`), context = c.runtimeContext(summary, profile);
    return phaseCapture.withPhaseCleanup(async () => {
      await own(["create", "--network", network, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount,
        "-e", `BASE=http://${name}:8080`, "-e", `PAYLOAD=${profile.payload}`, "-e", `DURATION=${config.seconds}s`, "-e", `MODE=${config.mode}`,
        "-e", `RATE=${config.rate}`, "-e", `VUS=${config.vus}`, ...(config.mode === "fixed" ? ["-e", "JSON_PROTOTYPE_OUTPUT=/tmp"] : []),
        summary.tools.k6.imageId, ...c.timedLoadCommand(config)], k6);
      return phaseCapture.capturePhase({ folder, path, stage, config, expected, options, tools: summary.tools, context, priorTailUnobserved,
        native: loadArtifact(summary.apps[expected.app].checks[profile.key].native), io: {
          write, reads: () => upstreamSnapshot(profile.payload),
          execute: (opts) => docker(["start", "-a", k6], opts),
          copy: (source, target) => docker(["cp", `${k6}:${source}`, target]),
          async counters() { const values = await counters(names); return Object.fromEntries(roles.map((r, i) => [r, values[names[i]]])); },
          async observe() {
            const app = await inspect(name), upstream = await inspect(up), load = await inspect(k6), ctx = { ...context, load: config };
            return { at: Date.now(), runtime: c.runtimeReceipt(app, expected, ctx),
              participants: { upstream: c.participantReceipt(upstream, expected, ctx, "upstream"), load: c.participantReceipt(load, expected, ctx, "load") },
              liveness: { app: production.life(app), upstream: production.life(upstream), load: production.life(load) }, ...await upstreamSnapshot(profile.payload) };
          },
          sample() {
            const all = { app: name, upstream: up }, sampler = stats.sampleStats(Object.values(all), statsPath, config.seconds + 35);
            return { async stop() { await sampler.stop(); const samples = JSON.parse(readFileSync(`${statsPath}.json`, "utf8")).samples;
              return Object.fromEntries(Object.entries(all).map(([role, id]) => [role, samples[id]])); } };
          },
          sampleLoad: (id) => startLoadResourceCapture({ id, async inspect(exactId) {
            const rows = JSON.parse(await docker(["container", "inspect", exactId], { timeout: 2000 }));
            assert.ok(rows.length === 1, "expected one exact load container");
            return rows[0];
          } }),
        } });
    }, () => remove(k6), cleanupFailure(k6));
  }
  try {
    save(); summary.commit = await command("git", ["rev-parse", "HEAD"]); summary.dirty = Boolean(await command("git", ["status", "--porcelain"]));
    assert.ok(options.checkOnly || !summary.dirty, "JSON timing requires a clean committed checkout");
    if (options.receipts) {
      const bundle = JSON.parse(readFileSync(resolve(repo, options.receipts), "utf8"));
      assert.ok(c.auditBundleSchemas.includes(bundle.schema)); assert.ok(Array.isArray(bundle.receipts)); receipts = bundle.receipts;
      assert.equal(new Set(receipts.map((r) => `${r.identity?.app}:${r.identity?.key}`)).size, receipts.length, "duplicate native audit receipts");
      assert.ok(receipts.every((r) => group.apps.includes(r.identity?.app) && group.cases.some((p) => p.key === r.identity?.key)), "unexpected native receipt member/case");
    }
    for (const [payload, p] of Object.entries(c.payloads)) {
      const records = JSON.parse(readFileSync(join(repo, p.fixture), "utf8")); assert.deepEqual(records, p.records(), "stale canonical payload fixture");
      summary.fixtures[payload] = write(`${payload}-fixture.json`, records); fixtureDirs[payload] = dirname(join(repo, p.fixture));
    }
    summary.host.docker = await docker(["version", "--format", "{{.Server.Version}}"]);
    const { execution, ...node } = await imageTool(c.nodeImage);
    summary.tools.node = node; summary.toolExecutions = { node: execution };
    summary.tools.k6 = await describeK6(docker, ["--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`],
      { pullLog: join(folder, "pull-k6.log") });
    const k6 = JSON.parse(await docker(["image", "inspect", summary.tools.k6.imageId]))[0];
    assert.equal(k6.Id, summary.tools.k6.imageId);
    summary.toolExecutions.k6 = c.imageCommandEvidence(k6); save();
    await docker(["network", "create", "--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`, network]);
    for (const [payload, p] of Object.entries(c.payloads)) {
      const name = `${runId}-${p.path}-api`;
      await own(["run", "-d", "--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
        "-v", `${fixtureDirs[payload]}:/fixtures:ro`, "-e", "NODE_OPTIONS=--import=/bench/json-api/upstream-observer.mjs",
        summary.tools.node.imageId, "node", `/bench/${p.path}/upstream.mjs`], name);
      upstreams[payload] = { name, url: await port(name) }; await ready(upstreams[payload].url, "/health");
    }
    await matrix.executeMatrix(options, {
      async prepare(app, payload) {
        const build = c.buildPlan(app, payload), labels = c.imageLabels(summary.commit, summary.dirty, app, payload);
        if (options.build) {
          const flags = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
          await docker(["build", ...flags, "-t", build.image, "-f", join(repo, build.dockerfile), resolve(repo, build.context)],
            { timeout: 60 * 60 * 1000, file: join(folder, `build-${app}-${payload}.log`) });
          assert.equal(await command("git", ["rev-parse", "HEAD"]), summary.commit, "HEAD changed during build");
          assert.equal(Boolean(await command("git", ["status", "--porcelain"])), summary.dirty, "tree cleanliness changed during build");
        }
        const image = JSON.parse(await docker(["image", "inspect", build.image]))[0];
        summary.apps[app].images[payload] = { ...build, imageId: image.Id, execution: c.imageCommandEvidence(image),
          labels: Object.fromEntries(Object.keys(labels).map((key) => [key, image.Config.Labels?.[key] ?? null])) };
        c.verifyImage(summary.apps[app].images[payload], summary.commit, app, payload); save();
      },
      async check(app, profile) {
        const entry = summary.apps[app], expected = c.identity(summary, app, profile), checked = entry.checks[profile.key] = { identity: expected, nativeSerializationVerified: false, nativeSourceVerified: false };
        const path = `${app}/${profile.key}`, out = join(folder, path), name = `${runId}-app`; mkdirSync(out, { recursive: true });
        try {
          c.verifyImage(entry.images[profile.payload], summary.commit, app, profile.payload);
          await own(["run", "-d", ...argsFor(name, profile, expected.imageId)], name);
          const base = await port(name); await ready(base, c.route(profile));
          const spec = { identity: expected, base, upstream: upstreams[profile.payload].url, recordsPath: join(repo, c.payloads[profile.payload].fixture),
            rawPath: join(out, "responses.jsonl"), resultPath: join(out, "functional.json") };
          writeFileSync(join(out, "check-input.json"), JSON.stringify(spec, null, 2));
          let checkerFailure;
          try { await command(process.execPath, [join(here, "check.mjs"), join(out, "check-input.json")], { timeout: 5 * 60 * 1000, file: join(out, "check.log") }); }
          catch (error) { checkerFailure = error; }
          finally {
            if (existsSync(spec.rawPath)) {
              const context = c.runtimeContext(summary, profile), app = await inspect(name), upstream = await inspect(upstreams[profile.payload].name);
              checked.raw = write(`${path}/observations.json`, { identity: expected, runtime: c.runtimeReceipt(app, expected, context),
                participants: { upstream: c.participantReceipt(upstream, expected, context, "upstream") }, liveness: evidence.functionalLiveness({ app, upstream }),
                events: readFileSync(spec.rawPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) });
            }
          }
          if (checkerFailure) {
            // Only the fixed checker's retained record sweep and actual normal
            // exit can identify a target failure. Other errors remain harness failures.
            const negative = { ...JSON.parse(readFileSync(`${spec.resultPath}.failure.json`, "utf8")), exit: checkerFailure.exit, clock: checkerFailure.clock };
            checked.failure = write(`${path}/functional-failure.json`, negative);
            evidence.verifyFunctionalFailure(negative, loadArtifact(checked.raw).events, expected, c.payloads[profile.payload].records());
            evidence.verifyFunctionalLiveness(loadArtifact(checked.raw), negative);
            verifiedFunctionalFailure = true;
          } else {
            checked.functional = JSON.parse(readFileSync(spec.resultPath, "utf8"));
            evidence.verifyFunctional(checked.functional, loadArtifact(checked.raw).events, profile, c.payloads[profile.payload].records());
          }
          checked.native = write(`${path}/native-audit.json`, qualify(expected)); checked.nativeSerializationVerified = true; checked.nativeSourceVerified = true;
          return !checkerFailure;
        } finally {
          try { writeFileSync(join(out, "app.log"), await docker(["logs", name])); } catch {}
          await remove(name); save();
        }
      },
      async gate(qualified) {
        if (!qualified && verifiedFunctionalFailure)
          summary.timingDisposition = "gated-functional";
        summary.checksPassed = qualified; save();
        if (!qualified) log("Full JSON matrix unqualified: no timing runs will start; all selected rows retained.");
        else if (!options.checkOnly) {
          await own(["run", "-d", "--network", "none", "--cpus", "1", ...(probeCpus.cpuset ? ["--cpuset-cpus", probeCpus.cpuset] : []), "--memory", "128m", "--cgroupns=host",
            "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", ...mount, summary.tools.node.imageId, "node", "-e", "setInterval(() => {}, 1000)"], cpuName);
        }
      },
      async measure({ app, pass, profile }) {
        const entry = summary.apps[app], expected = { ...c.identity(summary, app, profile), pass }, name = `${runId}-app`;
        const path = `${app}/${profile.key}/p${pass}`; mkdirSync(join(folder, path));
        const result = { pass, identity: expected, complete: false, phases: {} }; entry.runs[profile.key].push(result);
        try {
          await phaseCapture.withPhaseCleanup(async () => {
            result.cold = await cold(name, profile, expected.imageId, expected, path);
            try { result.warmup = await phase(name, profile, expected, "warmup", path); }
            catch (error) { if (error.phase) result.warmup = error.phase; throw error; }
            let priorTailUnobserved = false;
            for (const stage of c.phases) {
              try { result.phases[stage] = await phase(name, profile, expected, stage, path, priorTailUnobserved); }
              catch (error) { if (error.phase) result.phases[stage] = error.phase; throw error; }
              priorTailUnobserved ||= result.phases[stage].metrics.counts.timeout > 0;
              save();
            }
          }, async () => {
            try { writeFileSync(join(folder, path, "app.log"), await docker(["logs", name])); } catch {}
            let readsBeforeStop, beforeStopAt;
            await phaseCapture.withPhaseCleanup(async () => {
              readsBeforeStop = await apiReads(profile.payload); beforeStopAt = Date.now();
            }, () => remove(name), cleanupFailure(`${name} removal`));
            result.tail = write(`${path}/tail.json`, { beforeStopAt, before: readsBeforeStop, after: await apiReads(profile.payload), afterStopAt: Date.now() });
          }, cleanupFailure(name));
          result.complete = true;
        } catch (error) { result.failed = error.message; throw error; }
        finally {
          for (const stage of c.phases) entry.aggregates[profile.key][stage] = { ...c.aggregate(entry.runs[profile.key].filter((r) => r.phases[stage]?.metrics).map((r) => r.phases[stage].metrics)), asked: options.passes };
          entry.projections[profile.key] = outcomes.timedCaseProjection(entry.runs[profile.key].map((r) => ({ pass: r.pass,
            phases: Object.fromEntries(c.phases.filter((p) => r.phases[p]?.metrics).map((p) => [p, r.phases[p].metrics])) })), options.passes);
          save();
        }
      },
      failure: fail,
    }, summary.timingPlan);
    summary.attemptComplete = summary.failures.length === 0 && !options.checkOnly && (summary.timingDisposition === "gated-functional"
      || Object.values(summary.apps).every((a) => group.cases.every((p) => a.runs[p.key].length === options.passes
        && a.runs[p.key].every((r) => r.complete && c.phases.every((s) => r.phases[s]?.metrics?.observationComplete)))));
    summary.complete = summary.attemptComplete && summary.checksPassed && Object.values(summary.apps).every((a) => group.cases.every((p) => a.runs[p.key].every((r) => c.phases.every((s) => r.phases[s]?.metrics?.targetOutcome === "passed"))));
  } catch (error) { recordFailure(null, null, "suite", error); }
  finally {
    await settleJsonRun({
      async observeTail() {
        if (Object.keys(upstreams).length === group.payloads.length)
          summary.readTail = write("read-tail.json", { at: Date.now(), reads: Object.fromEntries(await Promise.all(group.payloads.map(async (p) => [p, await apiReads(p)]))) });
      },
      async cleanup() {
        for (const name of [...active].reverse()) try { await remove(name); } catch (error) { summary.cleanupFailures.push({ resource: name, error: error.message }); }
        try {
          if (await docker(["network", "ls", "--filter", `name=^${network}$`, "--format", "{{.ID}}"], { cleanup: true })) {
            const net = JSON.parse(await docker(["network", "inspect", network], { cleanup: true }))[0]; assert.equal(net.Labels?.[label], runId);
            await docker(["network", "rm", net.Id], { cleanup: true });
          }
        } catch (error) { summary.cleanupFailures.push({ resource: network, error: error.message }); }
        try {
          const containers = (await docker(["ps", "-a", "--filter", `label=${label}=${runId}`, "--format", "{{.ID}}"], { cleanup: true })).split("\n").filter(Boolean);
          const networks = (await docker(["network", "ls", "--filter", `label=${label}=${runId}`, "--format", "{{.ID}}"], { cleanup: true })).split("\n").filter(Boolean);
          summary.cleanup = write("cleanup.json", { runId, containers, networks });
          assert.deepEqual(containers, [], "owned containers remain"); assert.deepEqual(networks, [], "owned networks remain");
        } catch (error) { summary.cleanupFailures.push({ resource: runId, error: error.message }); }
      },
      async checkProvenance() {
        summary.commitAfter = await command("git", ["rev-parse", "HEAD"], { cleanup: true });
        summary.dirtyAfter = Boolean(await command("git", ["status", "--porcelain"], { cleanup: true }));
        assert.equal(summary.commitAfter, summary.commit, "HEAD changed during JSON run"); assert.equal(summary.dirtyAfter, false, "tree dirty after JSON run");
      },
      recordFailure: (stage, error) => recordFailure(null, null, stage, error),
      publish() {
        summary.finishedAt = new Date().toISOString();
        summary.attemptComplete &&= !processIO.interrupted && summary.failures.length === 0 && summary.cleanupFailures.length === 0;
        summary.complete &&= summary.attemptComplete;
        save();
      },
      dispose: processIO.dispose,
    });
  }
  const report = reporting.inspectJson(summary, { load: loadArtifact });
  writeFileSync(join(folder, "report.md"), reporting.renderJson(report));
  log(`${options.round}: ${report.status}; ${join(folder, "summary.json")}`);
  return report.baseline;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { if (!(await run(process.argv.slice(2)))) process.exitCode = 1; }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
