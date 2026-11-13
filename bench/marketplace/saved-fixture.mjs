// Synthetic saved evidence for validator tests only, never benchmark results.
import { createHash } from "node:crypto";
import { locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { cpuSettings, passPlan, resultSchema, sources, stageAggregate, timedProfiles } from "./run-contract.mjs";
import { qualification, featureProfile, qualificationSettings } from "./feature-contract.mjs";
import { qualificationProbes } from "./qualification-fixture.mjs";
import { splitApps } from "./run-contract.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evidenceVersion, k6Image, loadEnvironment, nodeImage, upstreamInterpretation } from "./raw-contract.mjs";

export function summaryFixture(commit) {
  const apps = splitApps("production-performant", 3)[0];
  const s = { schema: resultSchema, workload, round: "r17", runId: "marketplace-r17-0123456789", commit, dirty: false,
    finishedCommit: commit, finishedDirty: false, complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T02:00:00.000Z",
    options: { round: "r17", build: true, group: "production-performant", part: { index: 1, of: 3 }, apps, checkOnly: false, passes: 3, duration: 15, warmup: 10, rate: 150, startupTimeout: 120 },
    apps: {}, host: { cpu: "Synthetic, not measured", onlineCpus: "0-7" },
    tools: Object.fromEntries(["upstream", "checker", "k6"].map((k) => [k, { imageId: `sha256:${"b".repeat(64)}` }])),
    fixtureSha256: createHash("sha256").update(JSON.stringify(records())).digest("hex"),
    measurement: { profiles: timedProfiles, cpus: cpuSettings({ MARKETPLACE_APP_CPUS: "1", MARKETPLACE_API_CPUS: "2-3", MARKETPLACE_LOAD_CPUS: "4-7" }),
      encoding: "identity", fixedRate: 150, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20,
      upstream: "Synthetic", cpuWindow: "Synthetic", coldClock: "Synthetic", featureProfile, qualificationSettings } };
  for (const app of apps) {
    const a = s.apps[app] = { imageId: `sha256:${"b".repeat(64)}`, builtCommit: commit, builtDirty: false, checks: {}, runs: {}, phases: {},
      qualification: Object.fromEntries(sources.map((source) => [source, qualification(qualificationProbes(), source)])) };
    for (const source of sources) a.checks[source] = { workload, source, jsonRecords: 500, pages: 264,
      profiles: locales.flatMap((locale) => [false, true].flatMap((javaScriptEnabled) => [false, true].map((mobile) => ({ locale, javaScriptEnabled, mobile, passed: true })))),
      upstream: source === "api" ? { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } : null };
    for (const { key, source, locale, target } of timedProfiles) {
      const metric = { requests: 1500, rps: 100, p50: 1, p95: 2, p99: 3, failed: 0, failedRate: 0, dropped: 0, checksFailed: 0, appOutcome: false };
      const stats = { cpuUsec: 1000000, samples: 3, cpuAvgPct: 100, cpuMaxPct: 110, memAvgMiB: 10, memMaxMiB: 11 };
      a.runs[key] = [1, 2, 3].map((pass) => ({ pass, locale, complete: true, startedAt: "2026-01-01T00:01:00.000Z", finishedAt: "2026-01-01T00:04:00.000Z",
        cold: { containerStartedAt: "2026-01-01T00:02:00.000Z", first200At: "2026-01-01T00:02:01.000Z", first200MsFromContainerStart: 1000,
          measuredBeforeReadinessOrWarmup: true, path: target === "json" ? "/api/marketplace/item_1" : `/marketplace/${locale}/item_1`, attempts: 1, bytes: 100, successfulRequestMs: 1 },
        warmup: { ...metric, requests: 1000 }, phases: Object.fromEntries(["fixed", "sat64", "sat256"].map((p) => [p, { ...metric, ...stats, perCpuSecond: 1500,
          upstream: source === "api" ? { ...stats, highCpu: true, interpretation: "single-process upstream; a busy API may be the throughput limit, not the app" } : null }])) }));
      a.phases[key] = Object.fromEntries(["fixed", "sat64", "sat256"].map((p) => [p, stageAggregate(a.runs[key], p, 3)]));
    }
  }
  let clock = Date.parse("2026-01-01T00:01:00.000Z");
  for (const { pass, profile, app } of passPlan(s.options.passes, apps, timedProfiles, () => [])) {
    const run = s.apps[app].runs[profile.key].find((r) => r.pass === pass);
    run.startedAt = new Date(clock).toISOString(); run.finishedAt = new Date(clock + 70000).toISOString();
    run.cold.containerStartedAt = new Date(clock + 2000).toISOString(); run.cold.first200At = new Date(clock + 3000).toISOString();
    clock += 75000;
  }
  return s;
}

export function writeSavedFixture(folder, commit, tree) {
  const s = summaryFixture(commit); s.evidenceVersion = evidenceVersion;
  s.tools.upstream.image = nodeImage; s.tools.k6.image = k6Image; s.tools.k6.repoDigests = [k6Image];
  const write = (path, value) => { const full = join(folder, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value)); };
  const resources = [];
  let next = 0;
  const freshId = () => (++next).toString(16).padStart(64, "0");
  const state = (running, startedAt = "2026-01-01T00:00:01.000Z", finishedAt = "2026-01-01T00:00:02.000Z") => ({ Running: running, OOMKilled: false, ExitCode: 0, Error: "", StartedAt: startedAt, FinishedAt: running ? "0001-01-01T00:00:00Z" : finishedAt });
  const network = { id: freshId(), name: `${s.runId}-net`, owner: s.runId };
  resources.push({ kind: "network", id: network.id, name: network.name }); write("network.json", network);
  const benchRoot = "/synthetic/repo/bench";
  const mount = (destination, readOnly = true, source = ({ "/bench": benchRoot, "/repo": "/synthetic/repo", "/fixtures": `${benchRoot}/marketplace/fixtures`, "/sys/fs/cgroup": "/sys/fs/cgroup" })[destination]) => ({ type: "bind", source, destination, readOnly });
  const runtime = (name, role, memoryBytes, { quota = s.measurement.cpus[role].quota, ...extra } = {}) => {
    const c = { id: freshId(), name: `${s.runId}-${name}`, imageId: `sha256:${"b".repeat(64)}`, image: `sha256:${"b".repeat(64)}`,
      env: {}, cmd: [], entrypoint: null, owner: s.runId, state: state(true), memoryBytes, nanoCpus: quota * 1e9, cpuPeriod: 0, cpuQuota: 0,
      cpuset: s.measurement.cpus[role].cpuset ?? "", network: network.name, ulimits: [], mounts: [], ...extra };
    resources.push({ kind: "container", id: c.id, name: c.name }); return c;
  };
  const upstream = runtime("upstream", "api", 512 * 2 ** 20, { image: nodeImage, entrypoint: ["docker-entrypoint.sh"], cmd: ["node", "/bench/marketplace/upstream.mjs"], mounts: [mount("/fixtures"), mount("/bench")] });
  write("upstream-container.json", upstream);
  const images = Object.fromEntries(s.options.apps.map((app) => [app, { id: s.apps[app].imageId, cmd: ["native"], entrypoint: null,
    labels: { "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false", "run.corten.marketplace.profile": featureProfile } }]));
  write("images.json", images); write("tools.json", Object.fromEntries(Object.keys(s.tools).map((k) => [k, { id: s.tools[k].imageId, cmd: k === "upstream" ? ["node"] : k === "checker" ? ["/bin/bash"] : null,
    entrypoint: k === "k6" ? ["k6"] : k === "upstream" ? ["docker-entrypoint.sh"] : null, ...(k === "k6" ? { repoDigests: [k6Image] } : {}) }])));
  const appRuntime = (app, source, extra = {}) => runtime(app, "app", 2 ** 30, { cmd: images[app].cmd,
    env: { MARKETPLACE_SOURCE: source, MARKETPLACE_FIXTURE_PATH: "/fixtures/marketplace.json", API_BASE: `http://${upstream.name}:8080`, PORT: "8080", HOSTS: `${s.runId}-${app},localhost,127.0.0.1`,
      PROFILE: qualificationSettings.nativeProfile, MAX_CONNECTIONS: String(qualificationSettings.maxConnections) }, ulimits: [{ Name: "nofile", Soft: 65536, Hard: 65536 }], mounts: [mount("/fixtures")], ...extra });
  let gateClock = Date.parse("2026-01-01T00:00:02.000Z");
  for (const source of sources) for (const app of s.options.apps) {
    const a = s.apps[app];
    const base = `${source}/${app}`, c = appRuntime(app, source, { state: state(true, new Date(gateClock).toISOString()) }); write(`${base}/app-container.json`, c);
    for (const [script, output, memory] of [["qualify", "qualification", 512 * 2 ** 20], ["check", "checks", 2 * 2 ** 30]]) {
      const check = runtime(`${app}-${script}`, "load", memory, { state: state(false, new Date(gateClock + 1000).toISOString(), new Date(gateClock + 2000).toISOString()), network: `container:${c.id}`, mounts: [mount("/repo"), mount("/results", false, `${benchRoot}/marketplace/results/${s.round}/d1/${source}/${app}`)],
        cmd: ["node", `/repo/bench/marketplace/${script}.mjs`, "http://127.0.0.1:8080", source, `http://${upstream.name}:8080`, `/results/${output}.json`] });
      write(`${base}/${output === "checks" ? "check" : output}-container.json`, check);
      write(`${base}/${output}.json`, output === "checks" ? a.checks[source] : a.qualification[source]);
      gateClock += 3000;
    }
    gateClock += 1000;
  }
  const cpu = runtime("cpu", "load", 128 * 2 ** 20, { image: nodeImage, entrypoint: ["docker-entrypoint.sh"], cmd: ["node", "-e", "setInterval(() => {}, 1000)"], quota: 1, network: "none", state: state(true, new Date(gateClock).toISOString()), mounts: [mount("/bench"), mount("/sys/fs/cgroup")] }); write("cpu-container.json", cpu);
  for (const { pass, profile, app } of passPlan(s.options.passes, s.options.apps, timedProfiles, () => [])) {
      const run = s.apps[app].runs[profile.key].find((r) => r.pass === pass);
      const base = `${profile.source}/${app}/p${run.pass}-${profile.locale ?? "neutral"}-${profile.target}`;
      const coldApp = appRuntime(app, profile.source, { state: state(true, run.cold.containerStartedAt) }); write(`${base}/cold-container.json`, coldApp);
      const probe = runtime(`${app}-probe`, "load", 256 * 2 ** 20, { image: nodeImage, entrypoint: ["docker-entrypoint.sh"], state: state(true, new Date(Date.parse(run.startedAt) + 1000).toISOString()), mounts: [mount("/bench")],
        cmd: ["node", "/bench/catalog/cold.mjs", `http://${coldApp.name}:8080`, run.cold.path, String(s.options.startupTimeout)] }); write(`${base}/probe-container.json`, probe);
      const observed = Object.fromEntries(["first200At", "successfulRequestMs", "bytes", "attempts", "path"].map((k) => [k, run.cold[k]]));
      run.cold.clock = "Docker host wall clock; container start, not process exec; polling interval 10ms";
      write(`${base}/cold.log`, `catalog-probe-ready\n${JSON.stringify(observed)}\n`); write(`${base}/cold.json`, run.cold);
      let start = Date.parse(run.cold.first200At) + 1000;
      for (const phase of ["warmup", "fixed", "sat64", "sat256"]) {
        const seconds = phase === "warmup" ? s.options.warmup : s.options.duration, end = start + seconds * 1000 + 600;
        const elapsed = seconds * 1000 + 137.123456, rate = seconds * 100 / (elapsed / 1000);
        (phase === "warmup" ? run.warmup : run.phases[phase]).rps = rate;
        const load = runtime("k6", "load", 2 ** 30, { image: k6Image, entrypoint: ["k6"], mounts: [mount("/bench")], env: loadEnvironment(s, profile, phase, coldApp.name),
          cmd: ["run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/load.js"], state: state(false, new Date(start + 100).toISOString(), new Date(end - 100).toISOString()) });
        const names = phase === "warmup" ? [] : [coldApp.name, ...(profile.source === "api" ? [upstream.name] : [])];
        const before = Object.fromEntries(names.map((n) => [n, 1000000])), after = Object.fromEntries(names.map((n) => [n, 2000000]));
        const raw = { evidenceVersion, identity: { app, source: profile.source, locale: profile.locale, target: profile.target, pass: run.pass, phase }, app: coldApp, load, cpu, upstream: profile.source === "api" ? upstream : null,
          before, after, upstreamReads: profile.source === "api" ? { before: { answers: { 200: 1 } }, after: { answers: { 200: 1 + seconds * 100 } } } : null,
          finishedAt: new Date(end).toISOString(), seen: { pass: run.pass, phase, phaseStart: new Date(start).toISOString(), app: coldApp.state, errors: [] } };
        write(`${base}/${phase}-receipt.json`, raw);
        write(`${base}/${phase}-clock.json`, { testRunDurationMs: elapsed });
        write(`${base}/${phase}.json`, { metrics: { http_reqs: { count: seconds * 100, rate }, http_req_duration: { avg: 1, "p(50)": 1, "p(95)": 2, "p(99)": 3, max: 4 }, http_req_failed: { value: 0 }, checks: { passes: seconds * 200, fails: 0 } },
          root_group: { checks: { "marketplace status 200": { passes: seconds * 100, fails: 0 }, "marketplace content type": { passes: seconds * 100, fails: 0 } } } });
        write(`${base}/${phase}-cpu.json`, Object.fromEntries(names.map((n) => [n, { usec: 1000000 }])));
        if (phase !== "warmup") {
          const samples = Object.fromEntries(names.map((n) => [n, [0, 1, 2].map((i) => ({ t: start + (1 + i * 5) * 1000, cpu: 90 + i * 10, mem: 9 + i }))]));
          const stats = { samples: 3, cpuAvgPct: 100, cpuMaxPct: 110, memAvgMiB: 10, memMaxMiB: 11 };
          write(`${base}/${phase}-stats.log.json`, { summary: Object.fromEntries(names.map((n) => [n, stats])), samples });
          write(`${base}/${phase}-stats.log`, names.flatMap((Name) => samples[Name].map((p) => JSON.stringify({ Name, CPUPerc: `${p.cpu}%`, MemUsage: `${p.mem}MiB / 1GiB` }))).join("\n") + "\n");
          if (profile.source === "api") run.phases[phase].upstream.interpretation = upstreamInterpretation;
        }
        start = end + 1000;
      }
  }
  for (const a of Object.values(s.apps)) for (const { key } of timedProfiles) for (const phase of ["fixed", "sat64", "sat256"]) a.phases[key][phase] = stageAggregate(a.runs[key], phase, s.options.passes);
  write("source.json", { evidenceVersion, commit, tree, dirty: false, finishedCommit: commit, finishedDirty: false });
  write("host.txt", `Synthetic test kernel\nmodel name : ${s.host.cpu}\n${s.host.onlineCpus}\n`);
  write("fixture.json", JSON.stringify(records()));
  const cleanupStart = Math.max(...Object.values(s.apps).flatMap((a) => Object.values(a.runs).flatMap((runs) => runs.map((r) => Date.parse(r.finishedAt))))) + 1000;
  write("cleanup.json", { evidenceVersion, runId: s.runId, startedAt: new Date(cleanupStart).toISOString(), finishedAt: new Date(cleanupStart + 1000).toISOString(), created: resources, removed: resources, remaining: { containers: "", networks: "" } });
  write("summary.json", s);
  return s;
}
