// Offline, read-only replay of native runner receipts. Historical summary readers stay separate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { posix } from "node:path";
import { memoryMiB, summarizeSamples } from "../catalog/stats.mjs";
import { records } from "./fixtures.mjs";
import { admitted, featureProfile, qualificationSettings, validateQualification } from "./feature-contract.mjs";
import { validateSummary } from "./report.mjs";
import { imageProvenance, inventory, loadPhases, parseArgs, passPlan, phaseEnd, readLoadSummary, readOutcome, resultSchema, roundIdentity, sources, timedProfiles, upstreamErrors } from "./run-contract.mjs";
import { validateLoadExecution } from "./load-evidence.mjs";
import { evidenceVersion, k6Image, loadEnvironment, nodeImage, sourceTree, upstreamInterpretation } from "./raw-contract.mjs";
import { savedFiles } from "./saved-files.mjs";

const time = (s) => { const n = Date.parse(s); assert.ok(Number.isFinite(n), "invalid receipt timestamp"); return n; };
const exactKeys = (v, keys) => assert.deepEqual(Object.keys(v ?? {}).sort(), [...keys].sort(), "missing/extra raw participants");
const id = (s) => assert.match(s, /^[a-f0-9]{64}$/);
const imageId = (s) => assert.match(s, /^sha256:[a-f0-9]{64}$/);

/** Returns the validated summary, or throws MARKETPLACE_EVIDENCE_INVALID (also for missing raw).
 * No Docker, HTTP, writes, or fetching: only bounded saved files and a local Git commit object.
 * A merged split summary is not a producer folder; validate each native dN folder instead.
 */
export function validateSaved({ folder, round, commit }) {
  try { return replay({ folder, round, commit }); }
  catch (cause) { throw Object.assign(new Error(`invalid marketplace saved evidence: ${cause.message}`, { cause }), { code: "MARKETPLACE_EVIDENCE_INVALID" }); }
}
function replay({ folder, round, commit }) {
  roundIdentity(round); assert.match(commit, /^[a-f0-9]{40}$/);
  const files = savedFiles(folder), s = files.json("summary.json");
  assert.equal(s.round, round, "wrong saved round"); assert.equal(s.commit, commit, "wrong saved commit");
  assert.equal(s.schema, resultSchema, "saved replay requires the current native result format");
  assert.equal(s.evidenceVersion, evidenceVersion, "raw receipts absent or unsupported; summary-only evidence is not validated");
  assert.equal(s.split, undefined, "validate each native split part, not its merged summary");
  validateSummary(s);
  const args = [round, ...(s.options.build === true ? ["--build"] : []), ...(s.options.group ? ["--group", s.options.group] : []),
    ...(s.options.part ? ["--part", `${s.options.part.index}/${s.options.part.of}`] : [])];
  for (const [key, flag] of [["passes", "--passes"], ["duration", "--duration"], ["warmup", "--warmup"], ["rate", "--rate"], ["startupTimeout", "--startup-timeout"]]) args.push(flag, String(s.options[key]));
  assert.deepEqual(s.options, parseArgs(args, inventory), "saved settings differ from the native runner's allowed options");
  const firstLoad = Math.min(...Object.values(s.apps).flatMap((a) => Object.values(a.runs).flatMap((rs) => rs.map((r) => time(r.startedAt)))));
  const completed = new Map();
  const measuredApps = s.options.apps.filter((app) => !s.options.group || admitted(s.apps[app]));
  const runsOf = (app, key) => completed.get(`${app}/${key}`) ?? [];
  let lastRun = time(s.startedAt);
  for (const { pass, profile, app, skip } of passPlan(s.options.passes, measuredApps, timedProfiles, runsOf)) {
    if (skip) continue;
    const run = s.apps[app].runs[profile.key].find((r) => r.pass === pass);
    assert.ok(run, "missing serial-plan run");
    assert.ok(time(run.startedAt) >= lastRun && time(run.finishedAt) >= time(run.startedAt) && time(run.finishedAt) <= time(s.finishedAt), "run windows overlap or differ from native serial pass plan");
    lastRun = time(run.finishedAt);
    completed.set(`${app}/${profile.key}`, [...runsOf(app, profile.key), run]);
  }
  for (const app of measuredApps) for (const profile of timedProfiles) assert.equal(runsOf(app, profile.key).length, s.apps[app].runs[profile.key].length, "extra run outside serial plan");
  assert.match(s.runId, new RegExp(`^marketplace-${round}-[a-f0-9]{10}$`));
  const source = files.json("source.json");
  assert.deepEqual(source, { evidenceVersion, commit, tree: sourceTree(commit), dirty: false, finishedCommit: commit, finishedDirty: false });
  const fixture = files.text("fixture.json");
  assert.equal(createHash("sha256").update(fixture).digest("hex"), s.fixtureSha256, "wrong saved fixture bytes");
  assert.deepEqual(JSON.parse(fixture), records(), "saved fixture differs from the workload");
  const host = files.text("host.txt").trim().split("\n");
  assert.equal(host.find((line) => line.startsWith("model name"))?.split(":").slice(1).join(":").trim(), s.host.cpu, "host CPU differs from raw probe");
  assert.equal(host.at(-1).trim(), s.host.onlineCpus, "host CPU inventory differs from raw probe");
  const used = new Map(), configurations = new Map(), probeIds = new Set(), loadIds = new Set();
  const cpuObservations = [], upstreamObservations = [], containerStarts = new Map();
  function covers(c, observation) {
    assert.ok(time(c.state.StartedAt) <= observation, "container lifetime starts after its observation");
  }
  function runtime(c, expectedImage, role, memory, { running = false, quota = s.measurement.cpus[role].quota } = {}) {
    id(c.id); imageId(c.imageId); assert.equal(c.imageId, expectedImage, "raw runtime image differs");
    assert.match(c.name, new RegExp(`^${s.runId}-[a-z0-9-]+$`));
    assert.equal(c.owner, s.runId, "raw runtime is not owned by this run");
    assert.equal(c.memoryBytes, memory, "raw runtime memory limit differs");
    assert.equal(c.cpuset, s.measurement.cpus[role].cpuset ?? "", "raw runtime CPU placement differs");
    assert.ok(c.nanoCpus === quota * 1e9 && c.cpuQuota === 0 || c.nanoCpus === 0 && Number.isSafeInteger(c.cpuPeriod) && c.cpuPeriod > 0 && Number.isSafeInteger(c.cpuQuota) && c.cpuQuota / c.cpuPeriod === quota, "raw runtime CPU quota differs");
    assert.equal(typeof c.state?.Running, "boolean"); assert.equal(typeof c.state.OOMKilled, "boolean");
    assert.ok(!c.state.Error, "Docker runtime error");
    assert.notEqual(c.state.Restarting, true, "container is restarting");
    const began = time(c.state.StartedAt);
    assert.ok(began >= time(s.startedAt) && began <= time(s.finishedAt), "container lifetime outside round");
    if (containerStarts.has(c.id)) assert.equal(began, containerStarts.get(c.id), "container restarted between observations");
    containerStarts.set(c.id, began);
    if (!c.state.Running) assert.ok(time(c.state.FinishedAt) >= began && time(c.state.FinishedAt) <= time(s.finishedAt), "container finish outside lifetime/round");
    else assert.ok(time(c.state.FinishedAt) <= began, "running container finish contradicts current lifetime");
    if (running) {
      assert.equal(c.state.Running, true); assert.equal(c.state.OOMKilled, false); assert.equal(c.state.ExitCode, 0);
      assert.ok(c.state.Restarting === undefined || c.state.Restarting === false, "running container is restarting"); time(c.state.StartedAt);
    }
    const identity = { kind: "container", id: c.id, name: c.name };
    if (used.has(c.id)) assert.deepEqual(used.get(c.id), identity, "container identity changed");
    used.set(c.id, identity);
    const { state: ignored, ...config } = c;
    if (configurations.has(c.id)) assert.deepEqual(configurations.get(c.id), config, "container configuration changed");
    configurations.set(c.id, config);
    for (const m of c.mounts.filter((m) => m.type === "volume")) {
      id(m.name);
      const volume = { kind: "volume", id: m.name, name: m.name };
      if (used.has(m.name)) assert.deepEqual(used.get(m.name), volume, "volume/container identity collision");
      used.set(m.name, volume);
    }
    return c;
  }
  function mount(c, destination, readOnly) {
    const matches = c.mounts.filter((m) => m.destination === destination);
    assert.equal(matches.length, 1, `missing/duplicate ${destination} mount`);
    const m = matches[0]; assert.equal(m.type, "bind"); assert.equal(m.readOnly, readOnly);
    assert.ok(typeof m.source === "string" && m.source.length > 0);
    return m.source;
  }
  function mounts(c, expected, { volumes = false } = {}) {
    for (const [destination, source, readOnly = true] of expected) assert.equal(mount(c, destination, readOnly), source, "mount source differs from native checkout/output");
    for (const m of c.mounts) {
      assert.ok(typeof m.destination === "string" && m.destination.startsWith("/") && posix.normalize(m.destination) === m.destination && !m.destination.includes("\\"), "noncanonical mount destination");
      if (expected.some(([d]) => d === m.destination)) continue;
      assert.ok(volumes && m.type === "volume" && !expected.some(([d]) => d.startsWith(`${m.destination}/`) || m.destination.startsWith(`${d}/`) || m.destination === "/"), "unexpected/overlay source mount");
    }
  }
  const network = files.json("network.json");
  id(network.id); assert.equal(network.name, `${s.runId}-net`); assert.equal(network.owner, s.runId);
  const upstream = runtime(files.json("upstream-container.json"), s.tools.upstream.imageId, "api", 512 * 2 ** 20, { running: true });
  assert.equal(upstream.name, `${s.runId}-upstream`); assert.equal(upstream.network, network.name);
  assert.equal(upstream.image, nodeImage); assert.equal(s.tools.upstream.image, nodeImage);
  assert.deepEqual(upstream.cmd, ["node", "/bench/marketplace/upstream.mjs"]);
  const fixtureMount = mount(upstream, "/fixtures", true), benchMount = mount(upstream, "/bench", true);
  assert.ok(benchMount.startsWith("/") && posix.normalize(benchMount) === benchMount && !benchMount.includes("\\") && posix.basename(benchMount) === "bench", "invalid native source root");
  const repoMount = posix.dirname(benchMount);
  assert.equal(fixtureMount, posix.join(benchMount, "marketplace/fixtures"), "fixture is not from the source checkout");
  mounts(upstream, [["/fixtures", fixtureMount], ["/bench", benchMount]]);
  const cpu = runtime(files.json("cpu-container.json"), s.tools.upstream.imageId, "load", 128 * 2 ** 20, { quota: 1, running: true });
  covers(cpu, firstLoad);
  assert.equal(cpu.name, `${s.runId}-cpu`); assert.equal(cpu.network, "none");
  assert.equal(cpu.image, nodeImage);
  mounts(cpu, [["/bench", benchMount], ["/sys/fs/cgroup", "/sys/fs/cgroup"]]);
  assert.deepEqual(cpu.cmd, ["node", "-e", "setInterval(() => {}, 1000)"]);
  const toolImages = files.json("tools.json"); exactKeys(toolImages, ["upstream", "checker", "k6"]);
  for (const tool of Object.keys(toolImages)) {
    imageId(toolImages[tool].id); assert.equal(toolImages[tool].id, s.tools[tool].imageId, "tool image receipt differs");
  }
  assert.equal(s.tools.k6.image, k6Image); assert.deepEqual(toolImages.k6.repoDigests, s.tools.k6.repoDigests);
  assert.ok(toolImages.k6.repoDigests.includes(k6Image), "k6 image does not carry the pinned digest");
  assert.deepEqual(toolImages.k6.entrypoint, ["k6"]);
  assert.deepEqual(toolImages.upstream.entrypoint, ["docker-entrypoint.sh"]);
  assert.equal(toolImages.checker.entrypoint, null);
  assert.deepEqual(upstream.entrypoint, toolImages.upstream.entrypoint); assert.deepEqual(cpu.entrypoint, toolImages.upstream.entrypoint);
  function appRuntime(c, app, source, { running = true } = {}) {
    const a = s.apps[app], rawImage = images[app];
    runtime(c, a.imageId, "app", 2 ** 30, { running });
    assert.equal(c.name, `${s.runId}-${app}`); assert.equal(c.image, a.imageId); assert.equal(c.network, network.name);
    assert.deepEqual(c.cmd, rawImage.cmd); assert.deepEqual(c.entrypoint, rawImage.entrypoint);
    const env = { MARKETPLACE_SOURCE: source, MARKETPLACE_FIXTURE_PATH: "/fixtures/marketplace.json", API_BASE: `http://${upstream.name}:8080`,
      PORT: "8080", HOSTS: `${c.name},localhost,127.0.0.1`, ...(s.options.group ? { PROFILE: qualificationSettings.nativeProfile, MAX_CONNECTIONS: String(qualificationSettings.maxConnections) } : {}) };
    for (const [k, v] of Object.entries(env)) assert.equal(c.env[k], v, `wrong app ${k}`);
    if (s.options.group) assert.ok(c.ulimits?.some((u) => u.Name === "nofile" && u.Soft === 65536 && u.Hard === 65536), "missing native capacity setting");
    mounts(c, [["/fixtures", fixtureMount]], { volumes: true });
    return c;
  }
  function checker(c, appContainer, source, script, output, memory) {
    runtime(c, s.tools.checker.imageId, "load", memory);
    assert.equal(c.image, s.tools.checker.imageId);
    assert.deepEqual(c.entrypoint, toolImages.checker.entrypoint);
    assert.ok([`container:${appContainer.id}`, `container:${appContainer.name}`].includes(c.network), "checker did not use the checked app's network namespace");
    assert.deepEqual(c.cmd, ["node", `/repo/bench/marketplace/${script}.mjs`, "http://127.0.0.1:8080", source, `http://${upstream.name}:8080`, `/results/${output}.json`]);
    assert.equal(c.state.Running, false); assert.equal(c.state.OOMKilled, false); assert.equal(c.state.ExitCode, 0);
    assert.ok(time(c.state.StartedAt) >= time(s.startedAt) && time(c.state.FinishedAt) >= time(c.state.StartedAt) && time(c.state.FinishedAt) <= firstLoad, "gate did not finish before load");
    assert.ok(time(appContainer.state.StartedAt) >= time(s.startedAt) && time(c.state.StartedAt) >= time(appContainer.state.StartedAt), "gate precedes the checked app's lifetime");
    covers(upstream, time(appContainer.state.StartedAt));
    const outputRoot = posix.join(benchMount, "marketplace/results", round, ...(s.options.part ? [`d${s.options.part.index}`] : []), source, appContainer.name.slice(s.runId.length + 1));
    mounts(c, [["/repo", repoMount], ["/results", outputRoot, false]]);
  }
  const images = files.json("images.json"); exactKeys(images, s.options.apps);
  for (const app of s.options.apps) {
    const a = s.apps[app], i = images[app]; imageId(i.id); assert.equal(i.id, a.imageId, "raw app image differs");
    assert.deepEqual(imageProvenance(i.labels, commit, false), { builtCommit: a.builtCommit, builtDirty: a.builtDirty });
    if (s.options.group) assert.equal(i.labels["run.corten.marketplace.profile"], featureProfile);
    for (const source of sources) {
      const base = `${source}/${app}`;
      const checkedApp = appRuntime(files.json(`${base}/app-container.json`), app, source);
      if (s.options.group) {
        const q = validateQualification(files.json(`${base}/qualification.json`));
        assert.deepEqual(q, a.qualification[source], "saved qualification differs from raw probes");
        checker(files.json(`${base}/qualification-container.json`), checkedApp, source, "qualify", "qualification", 512 * 2 ** 20);
        if (!q.eligible) continue;
      }
      assert.deepEqual(files.json(`${base}/checks.json`), a.checks[source], "saved browser/content gate differs from raw check result");
      checker(files.json(`${base}/check-container.json`), checkedApp, source, "check", "checks", 2 * 2 ** 30);
    }
    if (s.options.group && !admitted(a)) continue;
    for (const profile of timedProfiles) for (const run of a.runs[profile.key]) {
      const base = `${profile.source}/${app}/p${run.pass}-${profile.locale ?? "neutral"}-${profile.target}`;
      const coldReceipt = files.json(`${base}/cold-container.json`);
      assert.ok(!used.has(coldReceipt.id), "cold start reused an app container");
      const coldApp = appRuntime(coldReceipt, app, profile.source);
      assert.ok(time(coldApp.state.StartedAt) >= time(run.startedAt), "cold start precedes its run");
      const probe = runtime(files.json(`${base}/probe-container.json`), s.tools.upstream.imageId, "load", 256 * 2 ** 20, { running: true });
      assert.ok(!probeIds.has(probe.id), "cold start reused a probe container"); probeIds.add(probe.id);
      assert.equal(probe.image, nodeImage);
      assert.deepEqual(probe.entrypoint, toolImages.upstream.entrypoint);
      assert.equal(probe.name, `${coldApp.name}-probe`);
      assert.ok(time(probe.state.StartedAt) >= time(run.startedAt) && time(probe.state.StartedAt) <= time(coldApp.state.StartedAt), "cold probe outside run/before app start");
      assert.equal(probe.network, network.name); mounts(probe, [["/bench", benchMount]]);
      assert.deepEqual(probe.cmd, ["node", "/bench/catalog/cold.mjs", `http://${coldApp.name}:8080`, run.cold.path, String(s.options.startupTimeout)]);
      const lines = files.text(`${base}/cold.log`).trim().split("\n");
      assert.equal(lines[0], "catalog-probe-ready"); assert.equal(lines.length, 2, "incomplete/extra cold probe observations");
      const observed = JSON.parse(lines[1]);
      const cold = { ...observed, first200MsFromContainerStart: time(observed.first200At) - time(coldApp.state.StartedAt), containerStartedAt: coldApp.state.StartedAt,
        clock: "Docker host wall clock; container start, not process exec; polling interval 10ms", measuredBeforeReadinessOrWarmup: true };
      assert.deepEqual(files.json(`${base}/cold.json`), cold); assert.deepEqual(run.cold, cold, "cold summary differs from raw probe/clock");
      let previous = time(observed.first200At);
      assert.ok(previous >= time(coldApp.state.StartedAt) && previous <= time(run.finishedAt), "cold observation outside run window");
      for (const phase of loadPhases) {
        if (run.stopped && loadPhases.indexOf(phase) > loadPhases.indexOf(run.stopped.phase)) break;
        const raw = files.json(`${base}/${phase}-receipt.json`);
        assert.deepEqual(raw.identity, { app, source: profile.source, locale: profile.locale, target: profile.target, pass: run.pass, phase });
        assert.equal(raw.evidenceVersion, evidenceVersion);
        const start = time(raw.seen.phaseStart), end = time(raw.finishedAt);
        assert.ok(start >= previous && end >= start && end <= time(run.finishedAt), "raw phase clock/order differs"); previous = end;
        assert.equal(raw.seen.pass, run.pass); assert.equal(raw.seen.phase, phase);
        appRuntime(raw.app, app, profile.source, { running: !run.stopped || run.stopped.phase !== phase });
        assert.equal(raw.app.id, coldApp.id, "app restarted between cold and load");
        assert.equal(raw.app.state.StartedAt, coldApp.state.StartedAt); assert.deepEqual(raw.seen.app, raw.app.state);
        covers(raw.app, start);
        runtime(raw.cpu, cpu.imageId, "load", 128 * 2 ** 20, { quota: 1, running: true });
        assert.equal(raw.cpu.id, cpu.id); assert.equal(raw.cpu.state.StartedAt, cpu.state.StartedAt);
        covers(raw.cpu, start);
        if (profile.source === "api") {
          runtime(raw.upstream, upstream.imageId, "api", 512 * 2 ** 20, { running: true });
          assert.equal(raw.upstream.id, upstream.id); assert.equal(raw.upstream.state.StartedAt, upstream.state.StartedAt);
          covers(raw.upstream, time(run.startedAt));
        } else assert.equal(raw.upstream, null);
        const k6 = runtime(raw.load, s.tools.k6.imageId, "load", 2 ** 30);
        assert.equal(k6.image, k6Image);
        assert.deepEqual(k6.entrypoint, toolImages.k6.entrypoint);
        assert.equal(k6.name, `${s.runId}-k6`); assert.ok(!loadIds.has(k6.id), "load phase reused a k6 container"); loadIds.add(k6.id);
        assert.equal(k6.network, network.name); mounts(k6, [["/bench", benchMount]]);
        assert.deepEqual(k6.env, loadEnvironment(s, profile, phase, coldApp.name));
        assert.deepEqual(k6.cmd, ["run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/load.js"]);
        const k6Summary = files.json(`${base}/${phase}.json`);
        validateLoadExecution({ load: k6, summary: k6Summary, clock: files.json(`${base}/${phase}-clock.json`), start, end, seconds: phase === "warmup" ? s.options.warmup : s.options.duration });
        const traffic = readLoadSummary(k6Summary);
        const rawCounters = files.json(`${base}/${phase}-cpu.json`);
        const counted = Object.fromEntries(Object.keys(raw.before).filter((n) => raw.after[n] !== undefined).map((n) => [n, { usec: raw.after[n] - raw.before[n] }]));
        assert.deepEqual(rawCounters, counted, "saved CPU deltas differ from before/after counters");
        if (profile.source === "api") {
          assert.equal(raw.upstreamReads.before.status, 200); assert.equal(raw.upstreamReads.after.status, 200);
          assert.equal(upstreamErrors(raw.upstreamReads.before, raw.upstreamReads.after), 0);
          upstreamObservations.push({ id: upstream.id, start, end, ...raw.upstreamReads });
          const reads = (raw.upstreamReads.after.answers[200] ?? 0) - (raw.upstreamReads.before.answers[200] ?? 0);
          // A completed 200 requires its own record read. Failed/time-out requests
          // may also have read upstream, so do not equate reads to successful traffic.
          assert.ok(reads >= traffic.requests - traffic.failed, "API reads do not cover successful requests");
        }
        else assert.equal(raw.upstreamReads, null);
        const participants = phase === "warmup" ? [] : [coldApp.name, ...(profile.source === "api" ? [upstream.name] : [])];
        const appStopped = !raw.app.state.Running || raw.app.state.OOMKilled;
        exactKeys(raw.before, participants); exactKeys(raw.after, appStopped ? [] : participants);
        for (const name of participants) {
          assert.ok(Number.isSafeInteger(raw.before[name]) && raw.before[name] >= 0, "invalid CPU counter before load");
          if (!appStopped) assert.ok(Number.isSafeInteger(raw.after[name]) && raw.after[name] > raw.before[name], "invalid CPU counter after load");
          cpuObservations.push({ id: name === coldApp.name ? coldApp.id : upstream.id, start, end, before: raw.before[name], after: raw.after[name] });
        }
        const stop = phaseEnd({ ...raw.seen, errors: raw.seen.errors.map((e) => ({ ...e, error: new Error(e.error) })), summary: k6Summary });
        if (stop) {
          assert.deepEqual(stop, run.stopped, "raw stop differs");
          const loadStart = time(k6.state.StartedAt), loadEnd = time(k6.state.FinishedAt);
          if (!raw.app.state.Running) assert.ok(time(raw.app.state.FinishedAt) >= loadStart && time(raw.app.state.FinishedAt) <= loadEnd, "app stop is outside generator execution");
          else assert.ok(raw.seen.events.some((e) => e.action === "oom" && e.ms >= loadStart && e.ms <= loadEnd), "app OOM is outside generator execution");
          assert.ok(raw.seen.events.every((e) => Number.isFinite(e.ms) && e.ms >= start && e.ms <= end), "Docker stop events are outside the phase window");
          const sidecars = [raw.cpu, ...(profile.source === "api" ? [raw.upstream] : [])];
          assert.deepEqual(raw.seen.sidecars, sidecars.map((c) => ({ name: c.name, startedAt: c.state.StartedAt, state: c.state })), "stop sidecar identities/state differ from runtime receipts");
          break;
        }
        const metrics = readOutcome(k6Summary);
        if (phase !== "warmup") {
          const counters = rawCounters; exactKeys(counters, participants);
          const sampled = files.json(`${base}/${phase}-stats.log.json`); exactKeys(sampled.samples, participants); exactKeys(sampled.summary, participants);
          const history = Object.fromEntries(participants.map((n) => [n, []]));
          const statsText = files.text(`${base}/${phase}-stats.log`);
          assert.ok(statsText.endsWith("\n"), "truncated stats log");
          for (const line of statsText.split("\n").map((s) => s.trim()).filter(Boolean)) {
            const p = JSON.parse(line); assert.ok(Object.hasOwn(history, p.Name), "unexpected stats participant");
            assert.match(p.CPUPerc, /^\d+(?:\.\d+)?%$/);
            assert.ok(history[p.Name].length < 1000, "stats log exceeds sample bound");
            history[p.Name].push({ cpu: parseFloat(p.CPUPerc), mem: memoryMiB(p.MemUsage.split("/")[0]) });
          }
          const stats = {};
          for (const name of participants) {
            const samples = sampled.samples[name];
            assert.ok(Array.isArray(samples) && samples.length > 0 && samples.length <= 1000, "invalid/bounded stats history required");
            assert.deepEqual(samples.map(({ cpu, mem }) => ({ cpu, mem })), history[name], "stats history differs from raw Docker samples");
            let last = start;
            for (const p of samples) { assert.ok(Number.isSafeInteger(p.t) && p.t >= last && p.t <= end && p.cpu >= 0 && p.mem > 0, "invalid stats clock/value"); last = p.t; }
            assert.ok(samples.at(-1).t - samples[0].t >= Math.max(0, s.options.duration - 5) * 1000, "truncated stats coverage");
            stats[name] = summarizeSamples(samples); assert.deepEqual(sampled.summary[name], stats[name], "stats aggregate differs from raw history");
            const usec = raw.after[name] - raw.before[name]; assert.deepEqual(counters[name], { usec }, "CPU delta differs from raw counters");
            stats[name].cpuUsec = usec;
          }
          const up = profile.source === "api" ? { ...stats[upstream.name], highCpu: stats[upstream.name].cpuAvgPct >= 80, interpretation: upstreamInterpretation } : null;
          Object.assign(metrics, stats[coldApp.name], { perCpuSecond: metrics.requests / (stats[coldApp.name].cpuUsec / 1e6), upstream: up });
        }
        assert.deepEqual(phase === "warmup" ? run.warmup : run.phases[phase], metrics, "summary metrics differ from raw k6/counters/history");
      }
    }
  }
  const lastUpstream = new Map();
  for (const observation of upstreamObservations.sort((a, b) => a.start - b.start)) {
    const prior = lastUpstream.get(observation.id);
    if (prior) {
      assert.ok(observation.start >= prior.end, "overlapping shared upstream observations");
      assert.equal(upstreamErrors(prior.after, observation.before), 0, "upstream failed between serial observations");
    }
    lastUpstream.set(observation.id, observation);
  }
  const lastCpu = new Map();
  for (const observation of cpuObservations.sort((a, b) => a.start - b.start)) {
    const prior = lastCpu.get(observation.id);
    // A stopped phase has only its pre-load lower bound, never an invented after sample.
    assert.ok(!prior || observation.start >= prior.end && observation.before >= (prior.after ?? prior.before), "cumulative CPU counter rewound across serial observations");
    lastCpu.set(observation.id, observation);
  }
  const cleanup = files.json("cleanup.json");
  assert.equal(cleanup.evidenceVersion, evidenceVersion); assert.equal(cleanup.runId, s.runId);
  assert.ok(time(cleanup.finishedAt) >= time(cleanup.startedAt) && time(cleanup.startedAt) >= Math.max(...Object.values(s.apps).flatMap((a) => Object.values(a.runs).flatMap((rs) => rs.map((r) => time(r.finishedAt))))));
  assert.ok(time(cleanup.finishedAt) <= time(s.finishedAt));
  assert.deepEqual(cleanup.remaining, { containers: "", networks: "" }, "owned resources survived cleanup");
  const created = new Map();
  for (const resource of cleanup.created) {
    id(resource.id); assert.ok(["container", "network", "volume"].includes(resource.kind)); assert.ok(!created.has(resource.id), "duplicate created resource"); created.set(resource.id, resource);
    if (resource.kind === "volume") assert.equal(resource.name, resource.id);
    else assert.match(resource.name, new RegExp(`^${s.runId}-[a-z0-9-]+$`), "foreign cleanup resource");
    if (resource.kind === "network") assert.deepEqual(resource, { kind: "network", id: network.id, name: network.name });
  }
  for (const [key, value] of used) assert.deepEqual(created.get(key), value, "runtime missing from actual cleanup inventory");
  assert.deepEqual(created.get(network.id), { kind: "network", id: network.id, name: network.name });
  assert.equal(cleanup.removed.length, created.size, "cleanup did not remove every created resource");
  for (const resource of cleanup.removed) { assert.deepEqual(created.get(resource.id), resource, "unexpected/duplicate cleanup receipt"); created.delete(resource.id); }
  return s;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 5, "usage: node bench/marketplace/validate.mjs <folder> <round> <commit>");
    const [folder, round, commit] = process.argv.slice(2);
    const s = validateSaved({ folder, round, commit });
    console.log(`${s.workload} ${s.round}: raw saved evidence valid (${s.commit})`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
