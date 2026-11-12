// Native JSON-only runner. Explicit selection; no cloud, schedule or old-runner side effects.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commands } from "./process.mjs";

export async function run(args) {
  const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, "../..");
  // These legacy selectors cannot pre-filter the registry or its ESM dependencies.
  const saved = Object.fromEntries(["BENCH_APPS", "BENCH_TIER"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  let c, artifacts, evidence, matrix, stats, reporting;
  try {
    c = await import("./contract.mjs"); artifacts = await import("./artifacts.mjs"); evidence = await import("./evidence.mjs");
    matrix = await import("./matrix.mjs"); stats = await import("../catalog/stats.mjs"); reporting = await import("./report.mjs");
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const options = c.parseArgs(args), group = c.descriptor(), cpus = c.cpuSettings(process.env);
  const folder = join(here, "results", options.round);
  mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder); // Never overwrite old evidence.
  const runId = `json-api-${options.round}-${randomBytes(5).toString("hex")}`, network = `${runId}-net`, label = "run.corten.json-api";
  const processIO = commands(repo), command = processIO.command;
  const docker = (args, opts) => command("docker", args, opts);
  const summary = { schema: c.schema, group, options, timingPlan: c.timingPlan(options), round: options.round, runId, startedAt: new Date().toISOString(), complete: false, checksPassed: false,
    failures: [], cleanupFailures: [], fixtures: {}, tools: {}, host: { hostname: hostname(), platform: platform(), release: release(), node: process.version, checkout: repo.replaceAll("\\", "/") },
    measurement: { cpus, encoding: "identity", fixedRate: options.rate, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20,
      loadMemoryBytes: 2 ** 31, nativeProfile: group.nativeProfile, phases: ["warmup", ...c.phases] },
    apps: Object.fromEntries(options.apps.map((app) => [app, { images: {}, checks: {}, runs: Object.fromEntries(group.cases.map((p) => [p.key, []])),
      aggregates: Object.fromEntries(group.cases.map((p) => [p.key, {}])) }])) };
  const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
  const log = (line) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); appendFileSync(join(folder, "run.log"), `${text}\n`); };
  const fail = (app, key, stage, error) => { summary.failures.push({ app, key, stage, error: error.stack ?? String(error) }); log(`${app ?? "suite"} ${key ?? ""}: ${stage}: ${error.message}`); save(); };
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
    return { image: tag, imageId: image.Id };
  };
  const apiReads = async (payload) => {
    const r = await fetch(`${upstreams[payload].url}/__${c.payloads[payload].path}/control`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200); return (await r.json()).requests;
  };
  const cpuName = `${runId}-cpu`;
  const counters = async (names) => {
    const ids = await Promise.all(names.map(async (n) => (await inspect(n)).Id));
    const usage = JSON.parse(await docker(["exec", cpuName, "node", "/bench/catalog/cgroup.mjs", ...ids]));
    return Object.fromEntries(names.map((n, i) => [n, usage[ids[i]]]));
  };
  let receipts = [];
  const qualify = (expected) => {
    const found = receipts.filter((r) => r.identity?.app === expected.app && r.identity?.key === expected.key);
    assert.equal(found.length, 1, "exactly one independently audited native receipt required");
    const receipt = found[0], files = {};
    for (const f of receipt.sourceFiles ?? []) {
      assert.ok(/^(bench|crates)\//.test(f.path), "audit source must stay in bench/crates");
      files[f.path] = artifacts.readContained(repo, f.path).toString("utf8");
    }
    c.verifyNativeReceipt(receipt, expected, files);
    return { receipt, files };
  };
  const argsFor = (name, profile, imageId) => c.appArgs({ name, profile, imageId, network, upstream: `http://${upstreams[profile.payload].name}:8080`, fixtures: fixtureDirs[profile.payload], cpus });
  const participants = async (expected, profile, roles, load) => Object.fromEntries(await Promise.all(Object.entries(roles).map(async ([role, name]) =>
    [role, c.participantReceipt(await inspect(name), expected, { ...c.runtimeContext(summary, profile), ...(load ? { load } : {}) }, role)])));

  async function cold(name, profile, image, expected, path) {
    const probe = `${name}-probe`;
    const upstreamBefore = await apiReads(profile.payload);
    await own(["create", ...argsFor(name, profile, image)], name);
    try {
      await own(["run", "-d", "--network", network, ...cpus.load.args, "--memory", "256m", ...mount, summary.tools.node.imageId,
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
      const context = c.runtimeContext(summary, profile);
      const raw = { identity: expected, result, runtime: c.runtimeReceipt(info, expected, context),
        upstreamReads: { before: upstreamBefore, after: await apiReads(profile.payload) },
        participants: await participants(expected, profile, { upstream: upstreams[profile.payload].name, probe }) };
      evidence.verifyCold(raw, expected, options, context);
      return { result, raw: write(`${path}/cold.json`, raw) };
    } finally { await remove(probe); }
  }
  async function phase(name, profile, expected, stage, path) {
    const config = c.loadConfig(options, stage), k6 = `${runId}-k6`, up = upstreams[profile.payload].name;
    const names = [name, ...(profile.source === "api" ? [up] : [])], roles = ["app", ...(profile.source === "api" ? ["upstream"] : [])];
    let sampler, sampled, before, after, upstreamBefore, upstreamAfter, failure, startedAt, finishedAt;
    const output = join(folder, path, `${stage}-k6.json`), statsPath = join(folder, path, `${stage}-stats.log`);
    try {
      await own(["create", "--network", network, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount,
        "-e", `BASE=http://${name}:8080`, "-e", `PAYLOAD=${profile.payload}`, "-e", `DURATION=${config.seconds}s`, "-e", `MODE=${config.mode}`,
        "-e", `RATE=${config.rate}`, "-e", `VUS=${config.vus}`, summary.tools.k6.imageId, "run", "--quiet", "--summary-export", "/tmp/json-summary.json", "/bench/json-api/load.js"], k6);
      upstreamBefore = await apiReads(profile.payload);
      before = await counters(names); startedAt = new Date().toISOString(); sampler = stats.sampleStats(names, statsPath, config.seconds + 35);
      try { await docker(["start", "-a", k6], { timeout: (config.seconds + 25) * 1000, file: join(folder, path, `${stage}.log`) }); } catch (e) { failure = e; }
      finally { try { await sampler.stop(); sampled = JSON.parse(readFileSync(`${statsPath}.json`, "utf8")).samples; } catch (e) { failure ??= e; } finishedAt = new Date().toISOString(); }
      after = await counters(names); upstreamAfter = await apiReads(profile.payload);
      await docker(["cp", `${k6}:/tmp/json-summary.json`, output]);
      const clockOutput = join(folder, path, `${stage}-clock.json`); await docker(["cp", `${k6}:/tmp/json-clock.json`, clockOutput]);
      const context = c.runtimeContext(summary, profile);
      const raw = { identity: expected, runtime: c.runtimeReceipt(await inspect(name), expected, context),
        participants: await participants(expected, profile, { upstream: up, load: k6 }, config), clock: { startedAt, finishedAt, ...JSON.parse(readFileSync(clockOutput, "utf8")) },
        tools: { nodeImageId: summary.tools.node.imageId, k6ImageId: summary.tools.k6.imageId }, phase: stage, config, k6: JSON.parse(readFileSync(output, "utf8")),
        counters: Object.fromEntries(roles.map((role, i) => [role, { before: before[names[i]], after: after[names[i]] }])),
        samples: Object.fromEntries(roles.map((role, i) => [role, sampled?.[names[i]] ?? []])),
        upstreamReads: { before: upstreamBefore, after: upstreamAfter } };
      const reference = write(`${path}/${stage}.json`, raw);
      if (failure) throw failure;
      return { raw: reference, metrics: c.deriveLoad(raw, expected, stage, options, summary.tools, context) };
    } finally { await remove(k6); }
  }
  try {
    save(); summary.commit = await command("git", ["rev-parse", "HEAD"]); summary.dirty = Boolean(await command("git", ["status", "--porcelain"]));
    assert.ok(options.checkOnly || !summary.dirty, "JSON timing requires a clean committed checkout");
    if (options.receipts) {
      const bundle = JSON.parse(readFileSync(resolve(repo, options.receipts), "utf8"));
      assert.equal(bundle.schema, "json-api-native-audits/v1"); assert.ok(Array.isArray(bundle.receipts)); receipts = bundle.receipts;
      assert.equal(new Set(receipts.map((r) => `${r.identity?.app}:${r.identity?.key}`)).size, receipts.length, "duplicate native audit receipts");
      assert.ok(receipts.every((r) => group.apps.includes(r.identity?.app) && group.cases.some((p) => p.key === r.identity?.key)), "unexpected native receipt member/case");
    }
    for (const [payload, p] of Object.entries(c.payloads)) {
      const records = JSON.parse(readFileSync(join(repo, p.fixture), "utf8")); assert.deepEqual(records, p.records(), "stale canonical payload fixture");
      summary.fixtures[payload] = write(`${payload}-fixture.json`, records); fixtureDirs[payload] = dirname(join(repo, p.fixture));
    }
    summary.host.docker = await docker(["version", "--format", "{{.Server.Version}}"]);
    summary.tools.node = await imageTool(c.nodeImage);
    await docker(["network", "create", "--label", `${label}=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`, network]);
    for (const [payload, p] of Object.entries(c.payloads)) {
      const name = `${runId}-${p.path}-api`;
      await own(["run", "-d", "--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
        "-v", `${fixtureDirs[payload]}:/fixtures:ro`, summary.tools.node.imageId, "node", `/bench/${p.path}/upstream.mjs`], name);
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
        summary.apps[app].images[payload] = { ...build, imageId: image.Id, labels: Object.fromEntries(Object.keys(labels).map((key) => [key, image.Config.Labels?.[key] ?? null])) };
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
          try { await command(process.execPath, [join(here, "check.mjs"), join(out, "check-input.json")], { timeout: 5 * 60 * 1000, file: join(out, "check.log") }); }
          finally {
            if (existsSync(spec.rawPath)) checked.raw = write(`${path}/observations.json`, { identity: expected, runtime: c.runtimeReceipt(await inspect(name), expected, c.runtimeContext(summary, profile)),
              participants: await participants(expected, profile, { upstream: upstreams[profile.payload].name }),
              events: readFileSync(spec.rawPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) });
          }
          checked.functional = JSON.parse(readFileSync(spec.resultPath, "utf8"));
          evidence.verifyFunctional(checked.functional, loadArtifact(checked.raw).events, profile, c.payloads[profile.payload].records());
          checked.native = write(`${path}/native-audit.json`, qualify(expected)); checked.nativeSerializationVerified = true; checked.nativeSourceVerified = true;
          return true;
        } finally {
          try { writeFileSync(join(out, "app.log"), await docker(["logs", name])); } catch {}
          await remove(name); save();
        }
      },
      async gate(qualified) {
        summary.checksPassed = qualified; save();
        if (!qualified) log("Full JSON matrix unqualified: no timing runs will start; all selected rows retained.");
        else if (!options.checkOnly) {
          summary.tools.k6 = await imageTool(c.k6Image);
          await own(["run", "-d", "--network", "none", "--cpus", "1", ...(cpus.load.cpuset ? ["--cpuset-cpus", cpus.load.cpuset] : []), "--memory", "128m", "--cgroupns=host",
            "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", ...mount, summary.tools.node.imageId, "node", "-e", "setInterval(() => {}, 1000)"], cpuName);
        }
      },
      async measure({ app, pass, profile }) {
        const entry = summary.apps[app], expected = { ...c.identity(summary, app, profile), pass }, name = `${runId}-app`;
        const path = `${app}/${profile.key}/p${pass}`; mkdirSync(join(folder, path));
        const result = { pass, identity: expected, complete: false, phases: {} }; entry.runs[profile.key].push(result);
        try {
          result.cold = await cold(name, profile, expected.imageId, expected, path);
          result.warmup = await phase(name, profile, expected, "warmup", path);
          for (const stage of c.phases) { result.phases[stage] = await phase(name, profile, expected, stage, path); save(); }
          result.complete = true;
        } catch (error) { result.failed = error.message; throw error; }
        finally {
          try { writeFileSync(join(folder, path, "app.log"), await docker(["logs", name])); } catch {}
          await remove(name);
          for (const stage of c.phases) entry.aggregates[profile.key][stage] = { ...c.aggregate(entry.runs[profile.key].filter((r) => r.phases[stage]?.metrics).map((r) => r.phases[stage].metrics)), asked: options.passes };
          save();
        }
      },
      failure: fail,
    }, summary.timingPlan);
    summary.complete = summary.checksPassed && summary.failures.length === 0 && !options.checkOnly;
  } catch (error) { fail(null, null, "suite", error); }
  finally {
    for (const name of [...active].reverse()) try { await remove(name); } catch (error) { summary.cleanupFailures.push({ resource: name, error: error.message }); }
    try {
      if (await docker(["network", "ls", "--filter", `name=^${network}$`, "--format", "{{.ID}}"], { cleanup: true })) {
        const net = JSON.parse(await docker(["network", "inspect", network], { cleanup: true }))[0]; assert.equal(net.Labels?.[label], runId);
        await docker(["network", "rm", net.Id], { cleanup: true });
      }
    } catch (error) { summary.cleanupFailures.push({ resource: network, error: error.message }); }
    try {
      summary.commitAfter = await command("git", ["rev-parse", "HEAD"], { cleanup: true });
      summary.dirtyAfter = Boolean(await command("git", ["status", "--porcelain"], { cleanup: true }));
      assert.equal(summary.commitAfter, summary.commit, "HEAD changed during JSON run"); assert.equal(summary.dirtyAfter, false, "tree dirty after JSON run");
    } catch (error) { summary.complete = false; fail(null, null, "tree provenance", error); }
    summary.finishedAt = new Date().toISOString(); summary.complete &&= !processIO.interrupted && summary.cleanupFailures.length === 0;
    save(); processIO.dispose();
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
