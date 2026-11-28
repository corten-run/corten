// Small synthetic round for portable replay tests. Never native qualification.
import { createHash } from "node:crypto";
import { allApps, catalogPeers } from "../fullstack/inventory.mjs";
import { cpuSettings, expectedPageChecks, expectedDocumentHeaderPaths, parseArgs, phases, aggregate } from "./contract.mjs";
import { groupDescriptor, groupResultSchema, qualificationIdentity, timingPlan } from "./group.mjs";
import { records } from "./fixtures.mjs";
import { timedFixture } from "./timed-fixture.mjs";
import { checkerImage, upstreamImage } from "./raw.mjs";
import { stdoutReceipt } from "./check.mjs";
import { k6Image, k6Provenance } from "../load-tool.mjs";
import { apparatus, digest, sourceProof, workerCommand, workerPhaseSchema, workerRawSchema } from "./apparatus.mjs";
import { verifyTimedPhase } from "./timed.mjs";
import { preflightArtifacts, preflightBinding, preflightCases, preflightSchema, requiredRoundArtifacts } from "./preflight.mjs";

export function legacyRound(failure = null, { wideGenerator = false, historical = true } = {}) {
  const files = new Map(), put = (key, value) => files.set(key, typeof value === "string" ? value : JSON.stringify(value));
  const reader = { readText(key) { if (!files.has(key)) throw Object.assign(new Error(`missing ${key}`), { missing: true }); return files.get(key); },
    readJson: (key) => JSON.parse(reader.readText(key)) };
  const group = groupDescriptor("catalog-page", { historical }), commit = "a".repeat(40), imageId = `sha256:${"b".repeat(64)}`;
  const options = parseArgs(["c1", "--group", "catalog-page", "--passes", "1", "--duration", "3", "--warmup", "2", "--build"], { ...allApps, ...catalogPeers });
  options.apps = group.apps;
  const catalog = records(), fixture = JSON.stringify(catalog) + "\n", fixtureSha256 = digest(fixture);
  const summary = { schema: groupResultSchema, group, options, workload: "catalog-v1", round: "c1", runId: "catalog-c1-test", commit,
    commitAfter: commit, dirty: false, dirtyAfter: false, complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    startedAt: "2026-11-07T16:00:00Z", finishedAt: "2026-11-07T22:00:00Z", fixtureSha256,
    savedEvidence: { fixtureSha256 }, measurement: { encoding: "identity", fixedRate: options.rate, cpus: cpuSettings({}), appMemoryBytes: 2 ** 30 }, apps: {},
    tools: { upstream: { image: upstreamImage, imageId }, checker: { image: checkerImage, imageId },
      k6: k6Provenance({ Id: imageId, RepoDigests: [k6Image], Os: "linux", Architecture: "amd64" }, "k6 v2.4.0 (synthetic)") } };
  if (wideGenerator) {
    summary.measurement.loadLayout = "c16-generator-v1";
    summary.measurement.cpus = cpuSettings({ CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-15" }, summary.measurement.loadLayout);
  }
  put("fixture.json", fixture); put("cleanup.json", { runId: summary.runId, containers: [], networks: [] });
  const check = { jsonRecords: 500, pages: expectedPageChecks(catalog), profiles: [false, true].flatMap((javaScriptEnabled) =>
    ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].map((profile) => ({ profile, javaScriptEnabled, forms: true, related: true, styles: true }))),
    upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } };
  for (const app of group.apps) {
    const entry = summary.apps[app] = { imageId, imageBytes: 1234, checks: {}, runs: {}, phases: {} };
    put(`build-${app}.log`, "synthetic native build\n");
    for (const source of group.sources) {
      entry.checks[source] = { ...structuredClone(check), qualification: qualificationIdentity(group, app, source, imageId) };
      const prefix = `${source}/${app}`;
      put(`${prefix}/checks.json`, check); put(`${prefix}/qualification.json`, entry.checks[source]);
      put(`${prefix}/checks.log`, "synthetic checks\n"); put(`${prefix}/app.log`, "");
    }
  }
  for (const { app, pass, ...profile } of timingPlan(options, group.sources, group.targets, group.contractSha256)) {
    const raw = `${profile.source}/${app}/p${pass}-page`;
    const cold = { path: "/catalog/record_1", first200At: "2026-11-07T16:00:00.200Z", successfulRequestMs: 2, bytes: 1000, attempts: 2,
      containerStartedAt: "2026-11-07T16:00:00Z", first200MsFromContainerStart: 200, measuredBeforeReadinessOrWarmup: true,
      clock: "Docker host wall clock; container start, not process exec; polling interval 10ms" };
    summary.apps[app].runs[`${profile.source}-page`] = [{ pass, evidence: { app, ...profile, imageId }, cold, complete: true, phases: {} }];
    put(`${raw}/container.json`, { id: createHash("sha256").update(raw).digest("hex"), imageId, source: profile.source, runId: summary.runId,
      quotaNanoCpus: 1e9, cpuset: summary.measurement.cpus.app.cpuset ?? "", memoryBytes: 2 ** 30 }); put(`${raw}/app.log`, "");
  }
  return timedFixture({ files, put, reader, summary, commit }, failure);
}

const ids = ["coordinator", "worker-1", "worker-2"].map((role, i) => ({ role, pid: i + 1, start: String(i + 1),
  boot: "12345678-1234-1234-1234-123456789abc", cgroup: "0::/", native: true }));
function control(epoch) {
  const configuration = digest(JSON.stringify({ status: 200, override: null }));
  return { epoch, requests: {}, status: 200, configuration, coordinator: ids[0],
    workers: ids.slice(1).map((identity) => ({ identity, epoch, requests: {}, status: 200, configuration })) };
}
export function syntheticDocumentHeaders(catalog, source) {
  return expectedDocumentHeaderPaths(catalog, source).map((path) => ({ path, status: 200,
    headers: Object.entries({ "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff", "referrer-policy": "origin, no-referrer",
      "cross-origin-opener-policy": "same-origin", "permissions-policy": "geolocation=()", "cache-control": "no-store" })
      .map(([name, value]) => ({ name, value })) }));
}
export function workerRound(failure = null, { historical = false, wideGenerator = false } = {}) {
  const f = legacyRound(failure, { wideGenerator, historical }), s = f.summary, initial = Date.parse(s.startedAt);
  if (!historical) s.group = groupDescriptor("catalog-page");
  const catalog = records();
  s.savedEvidence.schema = workerRawSchema; s.measurement.apparatus = apparatus; s.measurement.upstreamMemoryBytes = 512 * 2 ** 20;
  f.put("upstream.log", "");
  const proof = JSON.stringify(sourceProof(s.commit)); f.put("apparatus-source.json", proof); s.savedEvidence.apparatusSourceSha256 = digest(proof);
  function command(info) {
    info.command = workerCommand; info.path = "docker-entrypoint.sh"; info.args = workerCommand;
  }
  for (const source of s.group.sources) for (const app of s.group.apps) {
    const key = `${source}/${app}/checker.json`, boundary = f.reader.readJson(key);
    if (!historical) {
      const check = s.apps[app].checks[source];
      check.documentHeaders = syntheticDocumentHeaders(catalog, source);
      check.qualification = qualificationIdentity(s.group, app, source, s.apps[app].imageId);
      const { qualification, ...native } = check;
      f.put(`${source}/${app}/checks.json`, native);
      f.put(`${source}/${app}/checks.log`, `${stdoutReceipt(native)}\n`);
      f.put(`${source}/${app}/qualification.json`, check);
      boundary.checker.Args.push(app);
      boundary.checker.Config.Cmd.push(app);
    }
    boundary.upstream.Config.Cmd = workerCommand; boundary.upstream.Args = workerCommand;
    boundary.workerBefore = control(0); boundary.workerAfter = control(0); f.put(key, boundary);
  }
  function convert(prefix, subject, epochOffset = 0) {
    const boundary = f.reader.readJson(`${prefix}/${subject.phase}-boundary.json`), { phase } = subject;
    boundary.schema = workerPhaseSchema;
    command(boundary.before.upstream); command(boundary.after.upstream);
    if (s.measurement.loadLayout === "c16-generator-v1") {
      const { id } = boundary.after.load, { binding, observations } = boundary.loadLimits;
      for (const observation of observations) {
        observation.path = observation.path.replace(binding.container, id);
        observation.membershipBefore = observation.membershipAfter = `0::${observation.path}\n`;
        observation.quotas[0].path = observation.path;
      }
      binding.container = id;
    }
    f.put(`${prefix}/${phase}-boundary.json`, boundary);
    const start = Date.parse(boundary.after.load.state.StartedAt), end = Date.parse(boundary.after.load.state.FinishedAt);
    const epoch = start - initial + epochOffset, before = control(epoch), after = control(epoch);
    const upstream = boundary.after.upstream, name = `${s.runId}-upstream`;
    const cpu = f.reader.readJson(`${prefix}/${phase}-cpu-counters.json`);
    cpu.ids[name] = upstream.id; cpu.before[name] = (cpu.startedAt - initial) * 40; cpu.after[name] = (cpu.finishedAt - initial) * 40;
    f.put(`${prefix}/${phase}-cpu-counters.json`, cpu);
    const delta = f.reader.readJson(`${prefix}/${phase}-cpu.json`); delta[name] = { usec: cpu.after[name] - cpu.before[name] }; f.put(`${prefix}/${phase}-cpu.json`, delta);
    const stats = f.reader.readJson(`${prefix}/${phase}-stats.log.json`), appName = `${s.runId}-${subject.app}`;
    if (!stats.samples[name]) {
      stats.samples[name] = stats.samples[appName].map((r) => ({ ...r, cpu: 4 }));
      stats.summary[name] = { ...stats.summary[appName], cpuAvgPct: 4, cpuMaxPct: 4 };
    }
    f.put(`${prefix}/${phase}-stats.log.json`, stats);
    f.put(`${prefix}/${phase}-stats.log`, Object.entries(stats.samples).flatMap(([Name, rows]) => rows.map((v) => JSON.stringify({ Name, CPUPerc: `${v.cpu}%`, MemUsage: "8MiB / 1GiB" }))).join("\n") + "\n");
    const times = []; for (let t = start - 10; t < end + 10; t += 500) times.push(t); times.push(end + 10);
    f.put(`${prefix}/${phase}-workers.json`, { schema: "catalog-worker-observations/v1",
      binding: { commit: s.commit, sourceSha256: s.savedEvidence.apparatusSourceSha256, container: upstream.id, image: upstream.image,
        startedAt: upstream.state.StartedAt, budget: upstream.budget, ...subject }, before, after,
      processes: ids.map((identity, i) => ({ identity, samples: times.map((time) => {
        const t = time + i * 2;
        return { wallMs: t, beginNs: String(BigInt(t - initial) * 1000000n),
          endNs: String(BigInt(t - initial) * 1000000n + 1000n), cpuUsec: (t - initial) * 10 };
      }) })) });
    return verifyTimedPhase(s, { ...subject, seconds: phase === "warmup" ? s.options.warmup : s.options.duration,
      instance: f.reader.readJson(`${prefix}/container.json`) }, {
      readJson: (key) => f.reader.readJson(`${prefix}/${key}`), readText: (key) => f.reader.readText(`${prefix}/${key}`),
    }).metrics;
  }
  // Place the four admission phases in the existing gap after all checkers and before the first cold start.
  // Shift official observations by 30 seconds to leave room for fixed preflight observations.
  const shift = (v) => {
    if (typeof v === "number" && v >= initial && v < initial + 10000000) return v + 30000;
    if (typeof v === "string" && /^2026-11-07T/.test(v) && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v) + 30000).toISOString();
    if (Array.isArray(v)) return v.map(shift);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, shift(value)]));
    return v;
  };
  for (const [key, value] of f.files) if (/\/p1-page\//.test(key) && key.endsWith(".json")) {
    const v = shift(JSON.parse(value));
    if (key.endsWith("-boundary.json")) for (const edge of ["before", "after"]) v[edge].upstream.state.StartedAt = new Date(initial).toISOString();
    f.put(key, v);
  }
  for (const entry of Object.values(s.apps)) for (const runs of Object.values(entry.runs)) for (const run of runs) {
    run.cold = shift(run.cold);
    const prefix = `${run.evidence.source}/${run.evidence.app}/p1-page`;
    const { first200MsFromContainerStart, containerStartedAt, clock, measuredBeforeReadinessOrWarmup, ...probe } = run.cold;
    f.put(`${prefix}/cold.log`, `catalog-probe-ready\n${JSON.stringify(probe)}\n`);
    for (const phase of ["warmup", ...phases]) {
      const metrics = convert(prefix, { app: run.evidence.app, source: run.evidence.source, target: "page", phase });
      if (phase === "warmup") run.warmup = metrics; else run.phases[phase] = metrics;
    }
  }
  let preflightStart = initial + s.group.apps.length * s.group.sources.length * 1000 + 2000;
  for (const subject of preflightCases) {
    const prefix = `preflight/${subject.source}`, seed = `${subject.source}/corten/p1-page`;
    const instance = f.reader.readJson(`${seed}/container.json`);
    instance.id = digest(prefix); instance.startedAt = new Date(preflightStart - 100).toISOString(); f.put(`${prefix}/container.json`, instance);
    for (const phase of ["warmup", "sat256"]) {
      const seedClock = f.reader.readJson(`${seed}/${phase}-cpu-counters.json`).startedAt, offset = preflightStart - seedClock;
      const move = (v) => {
        if (typeof v === "number" && v >= initial && v < initial + 10000000) return v + offset;
        if (typeof v === "string" && /^2026-11-07T/.test(v) && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v) + offset).toISOString();
        if (Array.isArray(v)) return v.map(move);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, move(value)]));
        return v;
      };
      for (const suffix of [".json", ".log", "-boundary.json", "-cpu-counters.json", "-cpu.json", "-stats.log.json", "-stats.log"])
        f.put(`${prefix}/${phase}${suffix}`, suffix.endsWith(".json") ? move(f.reader.readJson(`${seed}/${phase}${suffix}`)) : f.reader.readText(`${seed}/${phase}${suffix}`));
      const b = f.reader.readJson(`${prefix}/${phase}-boundary.json`);
      for (const edge of ["before", "after"]) {
        b[edge].upstream.state.StartedAt = new Date(initial).toISOString();
        b[edge].runtime.id = instance.id; b[edge].runtime.state.StartedAt = instance.startedAt;
        b[edge].load.id = digest(`${prefix}/${phase}`);
      }
      f.put(`${prefix}/${phase}-boundary.json`, b);
      const cpu = f.reader.readJson(`${prefix}/${phase}-cpu-counters.json`); cpu.ids[`${s.runId}-corten`] = instance.id;
      cpu.before[`${s.runId}-corten`] = (preflightStart - initial) * 900; cpu.after[`${s.runId}-corten`] = cpu.before[`${s.runId}-corten`] + 900000;
      f.put(`${prefix}/${phase}-cpu-counters.json`, cpu);
      const delta = f.reader.readJson(`${prefix}/${phase}-cpu.json`); delta[`${s.runId}-corten`] = { usec: 900000 }; f.put(`${prefix}/${phase}-cpu.json`, delta);
      convert(prefix, { ...subject, phase });
      preflightStart = cpu.finishedAt + 1000;
    }
  }
  const observations = [...f.files.keys()].filter((key) => key.endsWith("-workers.json")).map((key) => ({ key, e: f.reader.readJson(key) }));
  observations.sort((a, b) => a.e.processes[0].samples[0].wallMs - b.e.processes[0].samples[0].wallMs);
  for (const [i, { key, e }] of observations.entries()) {
    for (const edge of ["before", "after"]) { e[edge].epoch = i + 1; for (const w of e[edge].workers) w.epoch = i + 1; }
    f.put(key, e);
  }
  f.put("preflight.json", { schema: preflightSchema, binding: preflightBinding(s), passed: true, cleanup: { containers: [] },
    hashes: Object.fromEntries(preflightArtifacts().map((key) => [key, digest(f.reader.readText(key))])) });
  for (const entry of Object.values(s.apps)) for (const [key, runs] of Object.entries(entry.runs))
    entry.phases[key] = Object.fromEntries(phases.map((p) => [p, { ...aggregate(runs.map((r) => r.phases[p])), asked: s.options.passes }]));
  if (wideGenerator) for (const [app, entry] of Object.entries(s.apps)) {
    for (const runs of Object.values(entry.runs)) for (const run of runs) {
      const raw = `${run.evidence.source}/${app}/p${run.pass}-page`, appName = `${s.runId}-${app}`;
      f.put(`${raw}/cold-probe.json`, { id: digest(`${raw}/cold-probe`), name: `/${appName}-probe`,
        imageId: s.tools.upstream.imageId, runId: s.runId, startedAt: run.cold.containerStartedAt,
        finishedAt: run.cold.first200At, quotaNanoCpus: 4e9, cpuset: "4-7", memoryBytes: 256 * 2 ** 20,
        command: ["node", "/bench/catalog/cold.mjs", `http://${appName}:8080`, "/catalog/record_1", String(s.options.startupTimeout)] });
    }
  }
  indexRound(f); return f;
}

export function indexRound(f) {
  f.put("evidence-index.json", { schema: "catalog-artifact-index/v1", commit: f.commit, sourceSha256: f.summary.savedEvidence.apparatusSourceSha256,
    hashes: Object.fromEntries(requiredRoundArtifacts(f.summary).map((key) => [key, digest(f.reader.readText(key))])) });
  f.summary.savedEvidence.artifactsSha256 = digest(f.reader.readText("evidence-index.json")); f.put("summary.json", f.summary);
}
