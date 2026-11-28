// Versioned observations for completed timed requests, not a diagnosis of their cause.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { parseStatsSample, summarizeSamples } from "./stats.mjs";
import { leanApps, leanProfile, recordedLeanApps } from "./contract.mjs";
import { workerAware, workerPhaseSchema, workerCommand, verifyWorkers, workerHeadroom } from "./apparatus.mjs";
import { observeLoadLimits, verifyLoadLimits } from "./cgroup.mjs";

export const timedRawSchema = "catalog-saved-evidence/v3";
export const phaseSchema = "catalog-timed-phase/v1";
const same = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const wideGenerator = (summary) => summary.measurement.loadLayout === "c16-generator-v1";
export const loadLimitsBinding = ({ runId }, { app, source, target, phase }, container, startedAt) => ({ runId, app, source, target, phase, container, startedAt });
export const phaseEnvironment = (name, target, phase, seconds, rate) => ({
  BASE: `http://${name}:8080`, TARGET: target, DURATION: `${seconds}s`, MODE: phase === "fixed" ? "fixed" : "closed",
  RATE: String(rate), VUS: String(phase === "sat256" ? 256 : phase === "warmup" ? 32 : 64), CATALOG_TIMED_EVIDENCE: "1",
});

export function timedContainerEvidence(info) {
  return { id: info.Id, name: info.Name, image: info.Image, restarts: info.RestartCount, path: info.Path, args: info.Args,
    state: Object.fromEntries(["Status", "Running", "OOMKilled", "Dead", "Paused", "Restarting", "ExitCode", "Error", "StartedAt", "FinishedAt"].map((k) => [k, info.State[k]])),
    budget: Object.fromEntries(["NanoCpus", "CpusetCpus", "Memory", "NetworkMode", "Sysctls"].map((k) => [k, info.HostConfig[k] ?? null])),
    entrypoint: info.Config.Entrypoint ?? null, command: info.Config.Cmd ?? null,
    env: info.Config.Env.filter((e) => ["CATALOG_SOURCE", "CATALOG_FIXTURE_PATH", "API_BASE", "PROFILE", ...Object.keys(phaseEnvironment("", "", "", 0, 0))].includes(e.split("=")[0])).sort(),
    owner: info.Config.Labels?.["run.corten.catalog"], networks: Object.keys(info.NetworkSettings.Networks).sort(),
    mounts: info.Mounts.map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination)) };
}

// The producer's failure classes (load-outcome.js, which a replay does not load). Only a failed
// request adds to its class's `catalog_failed_<class>` series, so a run without failures has none,
// and neither does a summary from the producer before the split: absence alone is not a count.
// When any series is present, the four HTTP classes must account for every HTTP error and
// `transport` and `other` for every invalid response, exactly, each present series with at least
// one request. Without any, the split is unknown (null), never zero. The `catalog_failed_` prefix
// is reserved for these classes: a series under it with any other suffix is refused, alone or
// beside known ones, so a misspelled class can neither pass for a summary without the split nor
// hide beside a counted one.
export const timedFailureClasses = Object.freeze(["http_429", "http_502", "http_503", "http_5xx", "transport", "other"]);
const httpClasses = ["http_429", "http_502", "http_503", "http_5xx"];
const failurePrefix = "catalog_failed_";

export function readFailureClasses(summary, { http_errors: httpErrors, invalid_responses: invalid }) {
  const metric = (name) => summary?.metrics?.[name]?.values ?? summary?.metrics?.[name];
  assert.ok(!Object.keys(summary?.metrics ?? {}).some((key) => key.startsWith(failurePrefix)
    && !timedFailureClasses.includes(key.slice(failurePrefix.length))), "unknown timed failure class series");
  const present = timedFailureClasses.filter((name) => metric(`catalog_failed_${name}`) !== undefined);
  if (!present.length) return null;
  const classes = Object.fromEntries(timedFailureClasses.map((name) => [name, present.includes(name) ? metric(`catalog_failed_${name}`)?.count : 0]));
  assert.ok(present.every((name) => count(classes[name]) && classes[name] > 0), "timed failure class count missing");
  assert.equal(httpClasses.reduce((sum, name) => sum + classes[name], 0), httpErrors, "timed failure classes differ from HTTP errors");
  assert.equal(classes.transport + classes.other, invalid, "timed failure classes differ from invalid responses");
  return classes;
}

export function readTimedLoad(summary) {
  const metric = (name) => summary?.metrics?.[name]?.values ?? summary?.metrics?.[name];
  const requests = metric("http_reqs"), duration = metric("http_req_duration"), failed = metric("http_req_failed"), checks = metric("checks");
  assert.ok(count(requests?.count) && requests.count > 0 && finite(requests.rate) && requests.rate > 0, "timed requests missing");
  for (const key of ["avg", "p(50)", "p(95)", "p(99)", "max"]) assert.ok(finite(duration?.[key]), "timed latency missing");
  assert.ok(duration.avg <= duration.max && duration["p(50)"] <= duration["p(95)"] && duration["p(95)"] <= duration["p(99)"] && duration["p(99)"] <= duration.max, "timed latency order differs");
  const counts = Object.fromEntries(["successes", "timeouts", "http_errors", "invalid_responses"].map((name) => [name, metric(`catalog_${name}`)?.count]));
  assert.ok(Object.values(counts).every(count), "timed request classification missing");
  const classes = readFailureClasses(summary, counts);
  assert.equal(classes?.transport ?? 0, 0, "timed request ended in a k6 transport error without an app response");
  assert.equal(counts.invalid_responses, 0, "unclassified or corrupt response");
  const errors = counts.timeouts + counts.http_errors;
  assert.equal(counts.successes + errors, requests.count, "request classifications do not cover requests");
  assert.equal(metric("iterations")?.count, requests.count, "unfinished timed iterations");
  assert.equal(failed?.passes, errors, "HTTP error count differs"); assert.equal(failed?.fails, counts.successes, "HTTP success count differs");
  assert.ok(finite(failed.value ?? failed.rate) && Math.abs((failed.value ?? failed.rate) - errors / requests.count) < 1e-12, "HTTP error rate differs");
  const typePasses = summary.root_group?.checks?.["catalog content type"]?.passes;
  assert.ok(count(typePasses) && typePasses >= counts.successes && typePasses <= counts.successes + counts.http_errors,
    "timed content checks contradict successful responses or timeouts");
  const expected = { "catalog status 200": [counts.successes, errors], "catalog content type": [typePasses, requests.count - typePasses] };
  same(Object.keys(summary.root_group?.checks ?? {}).sort(), Object.keys(expected).sort(), "timed check inventory differs");
  for (const [key, [passes, fails]] of Object.entries(expected)) {
    const check = summary.root_group.checks[key]; assert.equal(check.passes, passes, "timed check passes differ"); assert.equal(check.fails, fails, "timed check failures differ");
  }
  assert.equal(checks?.passes, counts.successes + typePasses, "total check passes differ");
  assert.equal(checks?.fails, errors + requests.count - typePasses, "total check failures differ");
  assert.ok(finite(checks.value ?? checks.rate) && Math.abs((checks.value ?? checks.rate) - checks.passes / (2 * requests.count)) < 1e-12, "total check rate differs");
  const dropped = metric("dropped_iterations")?.count;
  assert.ok(count(dropped), "dropped iteration count missing");
  const outcome = errors || dropped ? "failed" : "passed";
  for (const [key, threshold, crossed] of [["http_req_failed", "rate==0", errors > 0], ["checks", "rate==1", errors > 0], ["dropped_iterations", "count==0", dropped > 0]])
    same(summary.metrics[key]?.thresholds, { [threshold]: crossed }, "native threshold result differs");
  return { outcome, requests: requests.count, rps: requests.rate, successfulRequests: counts.successes,
    successfulRps: requests.rate * counts.successes / requests.count, timeouts: counts.timeouts, httpErrors: counts.http_errors,
    p50: duration["p(50)"], p95: duration["p(95)"], p99: duration["p(99)"], failed: errors, dropped };
}

function execution(info, image, command = image?.Cmd) {
  assert.ok(image && [image.Entrypoint, image.Cmd, command].every((v) => v === null || Array.isArray(v) && v.every((s) => typeof s === "string" && !s.includes("\0"))), "timed image command missing");
  same(info.entrypoint, image.Entrypoint, "timed entrypoint differs"); same(info.command, command, "timed command differs");
  const argv = [...(image.Entrypoint ?? []), ...(command ?? [])];
  assert.ok(argv.length && argv[0].length, "timed executable missing");
  assert.equal(info.path, argv[0]); same(info.args, argv.slice(1), "timed executable arguments differ");
}
function healthy(info, summary, name, image, role, memory, status) {
  assert.match(info.id, /^[a-f0-9]{64}$/); assert.equal(info.name, `/${name}`); assert.equal(info.image, image);
  assert.equal(info.owner, summary.runId); assert.equal(info.restarts, 0);
  assert.equal(info.budget.NanoCpus, summary.measurement.cpus[role].quota * 1e9);
  assert.equal(info.budget.CpusetCpus, summary.measurement.cpus[role].cpuset ?? ""); assert.equal(info.budget.Memory, memory);
  assert.equal(info.budget.NetworkMode, `${summary.runId}-net`); same(info.networks, [`${summary.runId}-net`], "timed network differs");
  assert.equal(info.state.Status, status); assert.equal(info.state.Running, status === "running");
  for (const key of ["OOMKilled", "Dead", "Paused", "Restarting"]) assert.equal(info.state[key], false, "timed participant unhealthy");
  assert.equal(info.state.Error, "");
  if (status !== "exited") assert.equal(info.state.ExitCode, 0);
  if (status !== "exited") assert.ok(Date.parse(info.state.FinishedAt) <= 0, "participant has an unknown prior termination");
  if (status === "created") assert.ok(Date.parse(info.state.StartedAt) <= 0, "load container was already started");
}

export function verifyTimedPhase(summary, subject, { readJson, readText }, previous = {}) {
  const { app, source, target, phase, seconds, instance } = subject;
  const metrics = readTimedLoad(readJson(`${phase}.json`)), proof = readJson(`${phase}-cpu-counters.json`), receipt = readJson(`${phase}-boundary.json`);
  const appName = `${summary.runId}-${app}`, upstreamName = `${summary.runId}-upstream`, loadName = `${summary.runId}-k6`;
  const workers = workerAware(summary);
  const names = [appName, ...(source === "api" || workers ? [upstreamName] : [])], sampled = [...names, loadName];
  const wide = wideGenerator(summary);
  same(Object.keys(receipt).sort(), ["schema", "exit", "errors", "before", "after", "observedAt", ...(wide ? ["loadLimits"] : [])].sort(), "timed boundary fields differ");
  assert.equal(receipt.schema, workers ? workerPhaseSchema : phaseSchema); same(receipt.errors, [], "timed apparatus errors retained");
  same(receipt.exit, { code: metrics.outcome === "failed" ? 99 : 0, signal: null, expired: false, interrupted: false }, "timed native exit is not a normal matching threshold exit");
  assert.ok(Number.isSafeInteger(proof.startedAt) && Number.isSafeInteger(proof.finishedAt) && proof.startedAt >= Date.parse(summary.startedAt)
    && proof.startedAt >= (previous.finishedAt ?? Date.parse(instance.startedAt)) && proof.finishedAt > proof.startedAt, "invalid timed clock");
  assert.ok(Number.isSafeInteger(receipt.observedAt) && receipt.observedAt >= proof.finishedAt
    && (summary.finishedAt === undefined || receipt.observedAt <= Date.parse(summary.finishedAt)), "timed observation outside run");
  const checkout = summary.host?.checkout;
  assert.ok(typeof checkout === "string" && checkout.startsWith("/") && !checkout.endsWith("/") && !checkout.includes(".."), "timed source checkout missing");
  const mount = (Source, Destination) => ({ Type: "bind", Source, Destination, RW: false });
  for (const edge of ["before", "after"]) {
    same(Object.keys(receipt[edge]).sort(), ["runtime", "upstream", "load"].sort(), "timed participant inventory differs");
    const { runtime, upstream, load } = receipt[edge];
    healthy(runtime, summary, appName, summary.apps[app].imageId, "app", 2 ** 30, "running");
    execution(runtime, summary.apps[app].imageExecution);
    const profile = summary.measurement.leanProfile;
    if (profile !== undefined) same(profile, { name: leanProfile, apps: recordedLeanApps(summary) }, "catalog lean configuration differs");
    same(runtime.env, [`CATALOG_SOURCE=${source}`, "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", `API_BASE=http://${upstreamName}:8080`,
      ...(profile !== undefined && leanApps.includes(app) ? [`PROFILE=${leanProfile}`] : [])].sort(), "timed source environment differs");
    same(runtime.mounts, [mount(`${checkout}/bench/catalog/fixtures`, "/fixtures")], "timed app mounts differ");
    assert.equal(runtime.id, instance.id); assert.equal(runtime.state.StartedAt, instance.startedAt);
    healthy(upstream, summary, upstreamName, summary.tools.upstream.imageId, "api", 512 * 2 ** 20, "running");
    execution(upstream, summary.tools.upstream.execution, workers ? workerCommand : ["node", "/bench/catalog/upstream.mjs"]);
    same(upstream.env, [], "timed upstream environment differs");
    same(upstream.mounts, [mount(`${checkout}/bench`, "/bench"), mount(`${checkout}/bench/catalog/fixtures`, "/fixtures")], "timed upstream mounts differ");
    for (const info of [runtime, upstream]) assert.ok(Number.isFinite(Date.parse(info.state.StartedAt)) && Date.parse(info.state.StartedAt) >= Date.parse(summary.startedAt)
      && Date.parse(info.state.StartedAt) <= proof.startedAt, "timed participant started late");
    healthy(load, summary, loadName, summary.tools.k6.imageId, "load", 2 ** 31, edge === "before" ? "created" : "exited");
    execution(load, summary.tools.k6Execution, ["run", "--quiet", "--summary-export", "/tmp/catalog-summary.json", "/bench/catalog/load.js"]);
    same(load.env, Object.entries(phaseEnvironment(appName, target, phase, seconds, summary.options.rate)).map(([k, v]) => `${k}=${v}`).sort(), "timed load environment differs");
    same(load.mounts, [mount(`${checkout}/bench`, "/bench")], "timed load mounts differ");
    same(load.budget.Sysctls, { "net.ipv4.ip_local_port_range": "1024 65535", "net.ipv4.tcp_tw_reuse": "1" }, "timed load socket settings differ");
    assert.equal(new Set([runtime.id, upstream.id, load.id]).size, 3, "timed participant identities overlap");
  }
  for (const role of ["runtime", "upstream", "load"]) {
    const { state: beforeState, ...before } = receipt.before[role], { state: afterState, ...after } = receipt.after[role];
    same(before, after, "timed participant identity/configuration changed");
    if (role !== "load") same(beforeState, afterState, "timed participant lifetime changed");
  }
  const load = receipt.after.load, start = Date.parse(load.state.StartedAt), end = Date.parse(load.state.FinishedAt);
  assert.equal(load.state.ExitCode, receipt.exit.code);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start >= proof.startedAt && end <= proof.finishedAt
    && end - start >= seconds * 1000 && end - start <= (seconds + 25) * 1000, "timed native duration incomplete");
  if (wide) {
    same(receipt.loadLimits?.binding, loadLimitsBinding(summary, subject, load.id, load.state.StartedAt), "load cgroup phase binding differs");
    const { observations, pid } = receipt.loadLimits;
    assert.ok(Array.isArray(observations) && observations.length >= 2 && observations.length <= (seconds + 25) * 4, "load cgroup sample count differs");
    let last = start;
    for (const sample of observations) {
      verifyLoadLimits(sample, load.id, { start, end, pid, ...summary.measurement.cpus.load });
      assert.ok(sample.startedAt >= last && sample.finishedAt - last <= 2000, "load cgroup sampling gap");
      last = sample.finishedAt;
    }
    assert.ok(end - last <= 2000, "load cgroup sampling stopped early");
  }
  for (const key of ["ids", "before", "after"]) same(Object.keys(proof[key]).sort(), [...names].sort(), "timed CPU inventory differs");
  const deltas = readJson(`${phase}-cpu.json`), stats = readJson(`${phase}-stats.log.json`);
  same(Object.keys(deltas).sort(), [...names].sort(), "timed CPU delta inventory differs");
  same(Object.keys(stats.samples).sort(), [...sampled].sort(), "timed sample inventory differs");
  const raw = readText(`${phase}-stats.log`), parsed = Object.fromEntries(sampled.map((name) => [name, []]));
  assert.ok(raw.endsWith("\n"), "timed stats framing incomplete");
  for (const line of raw.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const { name, cpu, mem } = parseStatsSample(line);
    assert.ok(Object.hasOwn(parsed, name), "unknown timed sample");
    parsed[name].push({ cpu, mem });
  }
  const derived = {};
  for (const name of sampled) {
    const samples = stats.samples[name], memory = name === loadName ? 2048 : name === upstreamName ? 512 : 1024;
    assert.ok(samples.length >= 2 && samples.length <= seconds * 10 + 40 && samples.some((s) => s.cpu > 0), "timed resource observations incomplete");
    assert.ok(samples.every((s, i) => finite(s.cpu) && finite(s.mem) && s.mem < memory && Number.isSafeInteger(s.t)
      && s.t >= proof.startedAt && s.t <= proof.finishedAt && (!i || s.t >= samples[i - 1].t && s.t - samples[i - 1].t <= 2000)), "invalid timed sample");
    assert.ok(samples[0].t <= start + 2000 && samples.at(-1).t >= end - 2000, "timed resource window incomplete");
    same(samples.map(({ cpu, mem }) => ({ cpu, mem })), parsed[name], "timed samples differ from raw");
    derived[name] = summarizeSamples(samples);
  }
  same(stats.summary, derived, "timed sample aggregates differ");
  for (const name of names) {
    assert.equal(proof.ids[name], name === appName ? instance.id : receipt.after.upstream.id);
    assert.ok(count(proof.before[name]) && count(proof.after[name]) && proof.after[name] > proof.before[name]
      && proof.before[name] >= (previous.counters?.[name] ?? 0), "timed CPU counter invalid");
    same(deltas[name], { usec: proof.after[name] - proof.before[name] }, "timed CPU delta differs");
  }
  if (phase === "warmup") assert.equal(metrics.outcome, "passed", "failed warmup is not a completed timed target outcome");
  if (phase !== "fixed") assert.equal(metrics.dropped, 0, "closed-loop dropped iterations contradict the executor");
  const workerEvidence = workers ? readJson(`${phase}-workers.json`) : null;
  const workerPeaks = workers ? verifyWorkers(summary, { app, source, target, phase }, workerEvidence,
    { start, end, container: receipt.after.upstream }) : null;
  if (metrics.outcome === "failed" || wide) {
    assert.ok(derived[loadName].cpuMaxPct < summary.measurement.cpus.load.quota * 80, "load generator has no demonstrated CPU headroom");
  }
  if (metrics.outcome === "failed") {
    if (source === "api") {
      if (workers) workerHeadroom(workerPeaks, derived[upstreamName].cpuMaxPct);
      else assert.ok(derived[upstreamName].cpuMaxPct < 80, "busy upstream cannot establish an app request outcome");
    }
    if (metrics.dropped) assert.ok(derived[appName].cpuAvgPct >= summary.measurement.cpus.app.quota * 95, "dropped work lacks observed target pressure");
  }
  Object.assign(metrics, derived[appName], { cpuUsec: deltas[appName].usec, perCpuSecond: metrics.requests / (deltas[appName].usec / 1e6),
    upstream: source === "api" ? { ...derived[upstreamName], cpuUsec: deltas[upstreamName].usec,
      ...(workers ? { workerPeaks, highCpu: derived[upstreamName].cpuMaxPct >= 160 || Object.values(workerPeaks).some((p) => p >= 80),
        interpretation: "two fixed request workers; per-process skew and container headroom both matter" }
        : { highCpu: derived[upstreamName].cpuAvgPct >= 80,
          interpretation: "single-process upstream; a busy API may be the throughput limit, not the app" }) } : null });
  readText(`${phase}.log`);
  const participants = [receipt.after.runtime, receipt.after.upstream].map((info) => {
    const name = info.name.slice(1);
    return { id: info.id, lifetime: { restarts: info.restarts, state: info.state }, ...(Object.hasOwn(proof.ids, name) ? {
      cpu: { startedAt: proof.startedAt, finishedAt: proof.finishedAt, before: proof.before[name], after: proof.after[name] },
    } : {}) };
  });
  participants.push({ id: load.id, lifetime: { restarts: load.restarts, state: load.state }, load: { startedAt: start, finishedAt: end } });
  return { metrics, counters: proof.after, finishedAt: receipt.observedAt, upstreamId: receipt.after.upstream.id, loadId: load.id, participants,
    ...(workers ? { workerEvidence, workerPeaks, workerWindow: { start, end }, resources: derived } : {}) };
}

// Summary traversal groups passes by app, not by their native observation clock.
export function verifyTimedContinuity(observations) {
  const participants = new Map(), loads = [];
  for (const { id, lifetime, cpu, load } of observations) {
    const participant = participants.get(id) ?? { lifetime, windows: [] };
    same(lifetime, participant.lifetime, "timed participant lifetime changed across attempt");
    if (cpu) participant.windows.push(cpu);
    if (load) loads.push(load);
    participants.set(id, participant);
  }
  loads.sort((a, b) => a.startedAt - b.startedAt);
  for (let i = 1; i < loads.length; i++)
    assert.ok(loads[i].startedAt >= loads[i - 1].finishedAt, "timed load lifetimes overlap across attempt");
  for (const { windows } of participants.values()) {
    windows.sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < windows.length; i++) {
      assert.ok(windows[i].startedAt >= windows[i - 1].finishedAt, "timed CPU windows overlap across attempt");
      assert.ok(windows[i].before >= windows[i - 1].after, "timed CPU counter moved backwards across attempt");
    }
  }
}

export async function collectLoadLimits(docker, summary, subject, id, readLimits = observeLoadLimits) {
  const deadline = performance.now() + (subject.seconds + 25) * 1000;
  const observations = [];
  let binding, pid;
  do {
    const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", id], { timeout: 2000 }));
    if (state.Running && state.Status === "running") {
      binding ??= loadLimitsBinding(summary, subject, id, state.StartedAt);
      pid ??= state.Pid;
      assert.ok(state.Pid === pid && state.StartedAt === binding.startedAt, "live generator changed");
      try { observations.push(readLimits(id, pid)); }
      catch (e) {
        // Procfs/cgroupfs can disappear before Docker publishes its exit. The
        // final inspect after start -a establishes exit; replay checks that
        // the retained samples reach that exit, not this observer's clock.
        if (!observations.length || !["ENOENT", "ESRCH"].includes(e.code)) throw e;
        break;
      }
      await sleep(500);
      continue;
    }
    if (state.Status === "exited") break;
    assert.ok(!binding && state.Status === "created", "unexpected load state during cgroup observation");
    await sleep(50);
  } while (performance.now() < deadline);
  return { binding, pid, observations };
}

// Dependencies are the native runner's existing bounded commands, never saved code.
export async function collectTimedPhase(context, subject) {
  const { summary, raw, docker, owned, inspect, remove, cpu, sampleStats, cpus, mount, k6Image, upstreamControl } = context;
  const { app, source, target, phase, seconds } = subject, name = `${summary.runId}-${app}`, container = `${summary.runId}-k6`;
  const workers = workerAware(summary);
  const wide = wideGenerator(summary);
  const names = [name, ...(source === "api" || workers ? [`${summary.runId}-upstream`] : [])];
  const receipt = { schema: workers ? workerPhaseSchema : phaseSchema, exit: null, errors: [], before: {}, after: {}, observedAt: null };
  const error = (stage, e) => receipt.errors.push({ stage, message: e.message ?? String(e) });
  const attempt = async (stage, fn) => { try { return await fn(); } catch (e) { error(stage, e); } };
  const participants = async () => Object.fromEntries(await Promise.all([["runtime", name], ["upstream", `${summary.runId}-upstream`], ["load", container]]
    .map(async ([role, id]) => [role, timedContainerEvidence(await inspect(id))])));
  let before, after, sampler, startedAt, finishedAt, workerBefore, workerAfter, observation, loadLimits, observing = false;
  try {
    await attempt("create", () => owned(["create", "--network", `${summary.runId}-net`, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount,
      ...Object.entries(phaseEnvironment(name, target, phase, seconds, summary.options.rate)).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      k6Image, "run", "--quiet", "--summary-export", "/tmp/catalog-summary.json", "/bench/catalog/load.js"], container));
    receipt.before = await attempt("before participants", participants) ?? {};
    if (workers) {
      workerBefore = await attempt("worker epoch reset", () => upstreamControl({}));
      observing = true;
      await attempt("worker sampler start", () => upstreamControl({ observation: "begin", seconds }));
    }
    startedAt = Date.now(); before = await attempt("before CPU", () => cpu(names));
    if (!receipt.errors.length) {
      sampler = await attempt("sampler start", () => sampleStats([...names, container], join(raw, `${phase}-stats.log`), seconds + 35));
      if (!receipt.errors.length) try {
        const load = wide ? receipt.before.load.id : container;
        const loadCommand = docker(["start", "-a", load], { timeout: (seconds + 25) * 1000, file: join(raw, `${phase}.log`) });
        if (wide) loadLimits = attempt("live load cgroup", () => collectLoadLimits(docker, summary, subject, load));
        await loadCommand;
        receipt.exit = { code: 0, signal: null, expired: false, interrupted: false };
      } catch (e) { receipt.exit = e.exit ?? null; if (!e.exit || e.exit.code !== 99 || e.exit.signal !== null || e.exit.expired || e.exit.interrupted) error("load command", e); }
    }
  } finally {
    if (wide) receipt.loadLimits = await loadLimits ?? null;
    if (sampler) await attempt("sampler stop", () => sampler.stop());
    if (observing) {
      observation = await attempt("worker sampler stop", () => upstreamControl({ observation: "end" }));
      workerAfter = await attempt("worker epoch acknowledgement", () => upstreamControl());
    }
    after = await attempt("after CPU", () => cpu(names)); finishedAt = Date.now();
    receipt.after = await attempt("after participants", participants) ?? {};
    if (workers) await attempt("worker artifacts", () => {
      const container = receipt.after.upstream;
      writeFileSync(join(raw, `${phase}-workers.json`), JSON.stringify({ schema: "catalog-worker-observations/v1",
        binding: { commit: summary.commit, sourceSha256: summary.savedEvidence.apparatusSourceSha256, container: container.id,
          image: container.image, startedAt: container.state.StartedAt, budget: container.budget, app, source, target, phase },
        before: workerBefore, after: workerAfter, processes: observation?.processes }, null, 2));
    });
    await attempt("summary copy", () => docker(["cp", `${container}:/tmp/catalog-summary.json`, join(raw, `${phase}.json`)]));
    await attempt("CPU artifacts", () => {
      assert.ok(before && after, "phase CPU observations missing"); same(before.ids, after.ids, "phase CPU identity changed");
      const deltas = Object.fromEntries(names.map((n) => { assert.ok(after.values[n] >= before.values[n], "phase CPU counter reversed"); return [n, { usec: after.values[n] - before.values[n] }]; }));
      writeFileSync(join(raw, `${phase}-cpu.json`), JSON.stringify(deltas, null, 2));
      writeFileSync(join(raw, `${phase}-cpu-counters.json`), JSON.stringify({ ids: before.ids, before: before.values, after: after.values, startedAt, finishedAt }, null, 2));
    });
    await attempt("load cleanup", () => remove(container));
    receipt.observedAt = Date.now();
    writeFileSync(join(raw, `${phase}-boundary.json`), JSON.stringify(receipt, null, 2));
  }
  if (receipt.errors.length) throw new AggregateError(receipt.errors.map((e) => new Error(`${e.stage}: ${e.message}`)), "timed phase apparatus failed");
  const reader = { readJson: (key) => JSON.parse(readFileSync(join(raw, key), "utf8")), readText: (key) => readFileSync(join(raw, key), "utf8") };
  return verifyTimedPhase(summary, subject, reader).metrics;
}
