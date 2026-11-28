// Synthetic offline observations only. These are not native qualification evidence.
import { createHash } from "node:crypto";
import { loadLimitsBinding, phaseEnvironment, phaseSchema, readTimedLoad, timedRawSchema, verifyTimedPhase } from "./timed.mjs";
import { aggregate, phases } from "./contract.mjs";
import { summarizeSamples } from "./stats.mjs";
import { timingPlan } from "./group.mjs";

// `classes` adds the failure-class series (`catalog_failed_<class>`) a producer since the split
// writes for each failed request; without it the summary is one with no failures classified.
export function loadSummary({ timeouts = 0, httpErrors = 0, dropped = 0, invalid = 0, httpErrorType = true, classes = {} } = {}) {
  const successes = 100 - timeouts - httpErrors - invalid, errors = timeouts + httpErrors + invalid;
  const typePasses = successes + (httpErrorType ? httpErrors : 0), checkPasses = successes + typePasses;
  return { metrics: {
    http_reqs: { count: 100, rate: 10 }, iterations: { count: 100 },
    http_req_duration: { avg: 1, "p(50)": 1, "p(95)": 2, "p(99)": 3, max: 10000 },
    http_req_failed: { passes: errors, fails: successes, value: errors / 100, thresholds: { "rate==0": errors > 0 } },
    checks: { passes: checkPasses, fails: 200 - checkPasses,
      value: checkPasses / 200, thresholds: { "rate==1": errors > 0 } },
    dropped_iterations: { count: dropped, thresholds: { "count==0": dropped > 0 } },
    catalog_successes: { count: successes }, catalog_timeouts: { count: timeouts }, catalog_http_errors: { count: httpErrors }, catalog_invalid_responses: { count: invalid },
    ...Object.fromEntries(Object.entries(classes).map(([name, value]) => [`catalog_failed_${name}`, { count: value }])),
  }, root_group: { checks: {
    "catalog status 200": { passes: successes, fails: errors },
    "catalog content type": { passes: typePasses, fails: 100 - typePasses },
  } } };
}

export function timedFixture(f, failure = { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 6 }) {
  const s = f.summary, checkout = "/synthetic/checkout", stamp = (t) => new Date(t).toISOString();
  s.savedEvidence.schema = timedRawSchema; s.host = { checkout }; s.attemptComplete = true; s.targetFailures = [];
  s.tools.upstream.execution = { Entrypoint: ["docker-entrypoint.sh"], Cmd: ["node"] };
  s.tools.checker.execution = { Entrypoint: null, Cmd: ["/bin/bash"] };
  s.tools.k6Execution = { Entrypoint: ["k6"], Cmd: null };
  f.put("tools.json", s.tools);
  const id = (label) => createHash("sha256").update(label).digest("hex");
  const upstreamName = `${s.runId}-upstream`, loadName = `${s.runId}-k6`, initial = Date.parse(s.startedAt);
  const mount = (Source, Destination) => ({ Type: "bind", Source, Destination, RW: false });
  const info = (name, image, role, memory, startedAt, command, entrypoint, env, mounts, status = "running") => ({
    id: id(name), name: `/${name}`, image, restarts: 0, path: [...(entrypoint ?? []), ...command][0], args: [...(entrypoint ?? []), ...command].slice(1),
    state: { Status: status, Running: status === "running", OOMKilled: false, Dead: false, Paused: false, Restarting: false,
      ExitCode: 0, Error: "", StartedAt: stamp(startedAt), FinishedAt: "0001-01-01T00:00:00Z" },
    budget: { NanoCpus: s.measurement.cpus[role].quota * 1e9, CpusetCpus: s.measurement.cpus[role].cpuset ?? "", Memory: memory, NetworkMode: `${s.runId}-net`, Sysctls: null },
    entrypoint, command, env: env.sort(), owner: s.runId, networks: [`${s.runId}-net`], mounts,
  });
  const upstreamInfo = () => info(upstreamName, s.tools.upstream.imageId, "api", 512 * 2 ** 20, initial,
    ["node", "/bench/catalog/upstream.mjs"], ["docker-entrypoint.sh"], [],
    [mount(`${checkout}/bench`, "/bench"), mount(`${checkout}/bench/catalog/fixtures`, "/fixtures")]);
  const checkInfo = (v) => ({ Id: v.id, Image: v.image, RestartCount: v.restarts, Path: v.path, Args: v.args,
    State: v.state, HostConfig: v.budget, networks: v.networks, mounts: v.mounts,
    Config: { Entrypoint: v.entrypoint, Cmd: v.command, Env: v.env, Labels: { "run.corten.catalog": v.owner } } });
  let tick = initial + 1000, upstreamCounter = 100;
  for (const [app, entry] of Object.entries(s.apps)) {
    entry.imageExecution = { Entrypoint: ["/synthetic-app"], Cmd: [] };
    f.put(`image-${app}.json`, { imageId: entry.imageId, imageBytes: entry.imageBytes, commit: s.commit, built: true, execution: entry.imageExecution });
  }
  for (const source of s.group.sources) for (const app of s.group.apps) {
    const entry = s.apps[app], appName = `${s.runId}-${app}`;
    const runtime = info(appName, entry.imageId, "app", 2 ** 30, tick, [], ["/synthetic-app"],
      [`CATALOG_SOURCE=${source}`, "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", `API_BASE=http://${upstreamName}:8080`],
      [mount(`${checkout}/bench/catalog/fixtures`, "/fixtures")]);
    runtime.id = id(`${source}/${app}/check-app`);
    const checker = info(`${appName}-check`, s.tools.checker.imageId, "load", 2 ** 31, tick + 10,
      ["node", "/repo/bench/catalog/check.mjs", "http://127.0.0.1:8080", source, `http://${upstreamName}:8080`, "/results/checks.json"], null, [],
      [mount(checkout, "/repo"), { ...mount(`${checkout}/bench/catalog/results/${s.round}/${source}/${app}`, "/results"), RW: true }], "exited");
    checker.id = id(`${source}/${app}/checker`); checker.budget.NetworkMode = `container:${runtime.id}`;
    if (s.measurement.loadLayout === "c16-generator-v1") {
      checker.budget.NanoCpus = 4e9; checker.budget.CpusetCpus = "4-7";
    }
    checker.state.FinishedAt = stamp(tick + 100);
    f.put(`${source}/${app}/checker.json`, { runtime: checkInfo(runtime), upstream: checkInfo(upstreamInfo()), checker: checkInfo(checker),
      exit: { code: 0, signal: null, expired: false, interrupted: false } });
    tick += 1000;
  }
  for (const { app, source, pass } of timingPlan(s.options, s.group.sources, s.group.targets, s.group.contractSha256)) {
    const entry = s.apps[app], run = entry.runs[`${source}-page`].find((r) => r.pass === pass);
    const raw = `${source}/${app}/p${run.pass}-page`, appName = `${s.runId}-${app}`;
    const runStartedAt = tick, cold = { ...run.cold, containerStartedAt: stamp(tick), first200At: stamp(tick + 200) };
    run.cold = cold; const { first200MsFromContainerStart, containerStartedAt, clock, measuredBeforeReadinessOrWarmup, ...probe } = cold;
    f.put(`${raw}/cold.json`, cold); f.put(`${raw}/cold.log`, `catalog-probe-ready\n${JSON.stringify(probe)}\n`);
    const instance = { ...f.reader.readJson(`${raw}/container.json`), id: id(raw), startedAt: cold.containerStartedAt };
    f.put(`${raw}/container.json`, instance);
    let appCounter = 100;
    for (const phase of ["warmup", ...phases]) {
      const seconds = phase === "warmup" ? s.options.warmup : s.options.duration;
      const startedAt = tick + 1000, nativeStart = startedAt + 20, nativeEnd = nativeStart + seconds * 1000 + 100, finishedAt = nativeEnd + 10;
      const negative = app === failure?.app && source === failure.source && run.pass === failure.pass && phase === failure.phase;
      const native = loadSummary(negative ? failure : {}), basic = readTimedLoad(native);
      const runtime = info(appName, entry.imageId, "app", 2 ** 30, runStartedAt, [], ["/synthetic-app"],
        [`CATALOG_SOURCE=${source}`, "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", `API_BASE=http://${upstreamName}:8080`], [mount(`${checkout}/bench/catalog/fixtures`, "/fixtures")]);
      runtime.id = instance.id;
      const upstream = upstreamInfo();
      const load = info(loadName, s.tools.k6.imageId, "load", 2 ** 31, initial, ["run", "--quiet", "--summary-export", "/tmp/catalog-summary.json", "/bench/catalog/load.js"], ["k6"],
        Object.entries(phaseEnvironment(appName, "page", phase, seconds, s.options.rate)).map(([k, v]) => `${k}=${v}`), [mount(`${checkout}/bench`, "/bench")], "created");
      load.id = id(`${raw}/${phase}`); load.budget.Sysctls = { "net.ipv4.ip_local_port_range": "1024 65535", "net.ipv4.tcp_tw_reuse": "1" };
      load.state.StartedAt = "0001-01-01T00:00:00Z";
      const afterLoad = structuredClone(load);
      Object.assign(afterLoad.state, { Status: "exited", Running: false, ExitCode: basic.outcome === "failed" ? 99 : 0, StartedAt: stamp(nativeStart), FinishedAt: stamp(nativeEnd) });
      const receipt = { schema: phaseSchema, exit: { code: afterLoad.state.ExitCode, signal: null, expired: false, interrupted: false }, errors: [],
        before: { runtime, upstream, load }, after: { runtime, upstream, load: afterLoad }, observedAt: finishedAt + 10 };
      if (s.measurement.loadLayout === "c16-generator-v1") {
        const path = `/system.slice/docker-${load.id}.scope`, events = "populated 1\nfrozen 0\n";
        receipt.loadLimits = { binding: loadLimitsBinding(s, { app, source, target: "page", phase }, load.id, afterLoad.state.StartedAt),
          pid: 42, observations: Array.from({ length: seconds + 1 }, (_, i) => ({
            startedAt: nativeStart + i * 1000 + 10, finishedAt: nativeStart + i * 1000 + 11, path,
            pid: 42, membershipBefore: `0::${path}\n`, membershipAfter: `0::${path}\n`,
            mount: "35 24 0:31 / /sys/fs/cgroup ro - cgroup2 cgroup rw",
            eventsBefore: events, eventsAfter: events, effectiveCpus: "4-15\n",
            quotas: [{ path, cpuMax: "1200000 100000\n" }, { path: "/system.slice", cpuMax: "max 100000\n" }, { path: "/", cpuMax: null }] })) };
      }
      const names = [appName, ...(source === "api" ? [upstreamName] : [])], sampled = [...names, loadName];
      const samples = Object.fromEntries(sampled.map((name) => [name, Array.from({ length: seconds + 1 }, (_, i) => ({ t: nativeStart + i * 1000,
        cpu: name === appName ? 99 : name === loadName ? (s.measurement.loadLayout ? 391.36 : 50) : 4, mem: 8 }))]));
      const stats = Object.fromEntries(sampled.map((name) => [name, summarizeSamples(samples[name])]));
      const before = { [appName]: appCounter, ...(source === "api" ? { [upstreamName]: upstreamCounter } : {}) };
      const after = Object.fromEntries(names.map((name) => [name, before[name] + seconds * (name === appName ? 900000 : 40000)]));
      f.put(`${raw}/${phase}.json`, native); f.put(`${raw}/${phase}.log`, "synthetic threshold observation\n");
      f.put(`${raw}/${phase}-boundary.json`, receipt);
      f.put(`${raw}/${phase}-cpu-counters.json`, { ids: { [appName]: runtime.id, ...(source === "api" ? { [upstreamName]: upstream.id } : {}) }, before, after, startedAt, finishedAt });
      f.put(`${raw}/${phase}-cpu.json`, Object.fromEntries(names.map((name) => [name, { usec: after[name] - before[name] }])));
      f.put(`${raw}/${phase}-stats.log.json`, { summary: stats, samples });
      f.put(`${raw}/${phase}-stats.log`, sampled.flatMap((Name) => samples[Name].map((v) => JSON.stringify({ Name, CPUPerc: `${v.cpu}%`, MemUsage: "8MiB / 1GiB" }))).join("\n") + "\n");
      const metrics = verifyTimedPhase(s, { app, source, target: "page", phase, seconds, instance }, {
        readJson: (key) => f.reader.readJson(`${raw}/${key}`), readText: (key) => f.reader.readText(`${raw}/${key}`),
      }).metrics;
      if (phase === "warmup") run.warmup = metrics; else run.phases[phase] = metrics;
      if (negative) s.targetFailures.push({ app, source, target: "page", pass: run.pass, phase, failed: metrics.failed, timeouts: metrics.timeouts, httpErrors: metrics.httpErrors, dropped: metrics.dropped });
      appCounter = after[appName]; if (source === "api") upstreamCounter = after[upstreamName]; tick = finishedAt + 1000;
    }
    run.outcome = phases.some((p) => run.phases[p].outcome === "failed") ? "failed" : "passed";
  }
  s.complete = !s.targetFailures.length;
  for (const entry of Object.values(s.apps)) for (const [key, runs] of Object.entries(entry.runs))
    entry.phases[key] = Object.fromEntries(phases.map((p) => [p, { ...aggregate(runs.map((r) => r.phases[p])), asked: s.options.passes }]));
  f.put("summary.json", s); return f;
}
