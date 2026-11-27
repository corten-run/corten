// Synthetic OS/native records for the real Live readers, not a native benchmark.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { deploymentSha256 } from "../../deployments.mjs";
import { liveCaptureSchema, liveContracts } from "../../live.mjs";
import { runnerFor } from "../../registry.mjs";
import { fanoutProfile } from "../../../live/fanout.mjs";
import { rewriteArtifact, syntheticFixture, hash } from "../adapters/live-delivery.test.mjs";
import { tree } from "../evidence.mjs";
import { processIdentity } from "../host-lifetime.mjs";
import { liveActorCpus, liveApplication } from "../native-roles.mjs";
import { executableReference } from "../participant-executables.mjs";

async function isolatedBinding(t, group, round, profile) {
  const f = await syntheticFixture(t, group, { allRegistered: true, round, profile });
  const { binding, plan } = f;
  const options = binding.execution.effectiveOptions;
  Object.assign(options, { isolated: true, measure: true });
  Object.assign(plan, { isolated: true, measurement: fanoutProfile });
  binding.execution.settings.measurement = fanoutProfile;
  const { entry, selection } = runnerFor(group);
  binding.execution.invocation.argv = [entry, round, ...selection, "--build", "--isolated", "--profile", options.profile, "--measure"];
  binding.request.recipe = "native-feed-measure";
  Object.assign(binding.resources, { actorCpus: liveActorCpus, app: liveApplication, requestedCpuEnv: null });
  binding.preparation = { fixtures: [] };
  binding.coverage = f.ledger;
  await f.json("plan.json", plan);

  const tools = { node: hash("driver"), browser: hash("chromium") };
  await f.json("host-actor-tools.json", tools);
  return { ...f, tools };
}

export async function isolatedLiveCapture(t, group, round) {
  const f = await isolatedBinding(t, group, round, "native-feed"), { plan } = f;
  const start = Date.parse(plan.startedAt), records = [];
  for (const [appIndex, app] of plan.apps.entries()) {
    const id = hash(`synthetic container ${app}`), imageId = `sha256:${hash(`synthetic image ${app}`)}`;
    const pid = 3000 + appIndex, path = `/system.slice/docker-${id}.scope`;
    const appStart = start + 10 + appIndex * plan.scenarios.length * 10;
    const window = { startedAt: appStart, endedAt: appStart + plan.scenarios.length * 10 - 1 };
    const state = { Status: "running", Running: true, Pid: pid, Paused: false, Restarting: false, Dead: false,
      ExitCode: 0, OOMKilled: false, StartedAt: new Date(appStart).toISOString(), FinishedAt: "0001-01-01T00:00:00Z" };
    const container = { id, imageId, restartCount: 0, state };
    await f.json(`${app}-host-actor.json`, { id, imageId, role: "application", app, window,
      terminal: { ...container, limits: { CpusetCpus: liveActorCpus.application, NanoCpus: liveApplication.cpu * 1e9,
        Memory: liveApplication.memoryBytes }, state: { ...state, Status: "exited", Running: false, Pid: 0,
          FinishedAt: new Date(window.endedAt).toISOString() } } });
    for (const [index] of plan.scenarios.entries()) {
      const scenarioStart = appStart + index * 10;
      await rewriteArtifact(f, app, index, (artifact) => {
        const url = "http://127.0.0.1:12345/";
        Object.assign(artifact, { actorWindow: { startedAt: scenarioStart, endedAt: scenarioStart + 9,
          renderer: { startedAt: scenarioStart + 2, endedAt: scenarioStart + 8 } },
          capture: { schema: liveCaptureSchema, contract: liveContracts[group], records: [] },
          controls: [], failures: [], html: "<main>native target unavailable</main>", network: [
            { kind: "request", requestId: "http-1", method: "GET", url },
            { kind: "response", requestId: "http-1", status: 500, url },
          ] });
      });
      records.push({ at: scenarioStart + 5, container, path });
    }
  }
  return { ...f, records, start, end: records.at(-1).at + 10 };
}

// Use real successful Express traces with synthetic phase identity, actor
// windows and OS samples. Only the test process narrows the registry.
export async function isolatedLiveSuccess(t, round, clockAt) {
  const group = "live-delivery", app = "express", f = await isolatedBinding(t, group, round, "bounded");
  const { plan, ledger } = f;
  assert.deepEqual(plan.apps, [app]);
  const sample = (name) => JSON.parse(gunzipSync(readFileSync(new URL(
    `../../../live/evidence/review-v3-express/${name}`, import.meta.url))));
  const measurement = fanoutProfile.clients.map((n) => sample(`express-fanout-${n}.json.gz`));
  const native = JSON.parse(measurement[0].kernel.before.receipt.instance.stdout);
  const appStart = Date.parse(native.startedAt), start = appStart - 500;
  plan.startedAt = new Date(start).toISOString();
  await f.json("plan.json", plan);
  const original = JSON.parse(gunzipSync(readFileSync(join(f.folder, "express-normal.json.gz"))));
  const provenance = { ...original.provenance, containerId: native.id, imageId: native.image,
    processInventory: measurement[0].provenance.processInventory };
  const files = [], measured = [], samples = new Set();
  for (const [i, scenario] of plan.scenarios.entries()) {
    const name = `express-${scenario}.json.gz`, artifact = sample(name);
    const timeOrigin = appStart + 100 + i * 1500, capturedAt = Math.ceil(artifact.capture.records.at(-1).at) + 1;
    artifact.costs = { ...artifact.costs, timeOrigin, capturedAt };
    const endedAt = timeOrigin + capturedAt;
    artifact.actorWindow = { startedAt: timeOrigin, endedAt, renderer: { startedAt: timeOrigin, endedAt } };
    artifact.provenance = provenance;
    files.push(await f.compressed(name, artifact));
    samples.add(timeOrigin + 5);
  }
  let last;
  for (const artifact of measurement) {
    const startedAt = Math.floor(artifact.host.timeOrigin + artifact.interval.startedAt);
    const endedAt = Math.ceil(artifact.host.timeOrigin + artifact.interval.finishedAt) + 1;
    artifact.actorWindow = { startedAt, endedAt, renderer: { startedAt, endedAt }, endedClock: clockAt(endedAt - start) };
    Object.assign(artifact, { provenance, qualification: files });
    measured.push(await f.compressed(`express-fanout-${artifact.clients}.json.gz`, artifact));
    samples.add(startedAt + 10); last = endedAt;
  }
  await f.json("express-artifacts.json", { app, group, files });
  await f.json("express-measurements.json", { app, group, profile: fanoutProfile, files: measured });
  Object.assign(ledger.cells[0], { parity: "passed", measurement: "complete", measurementArtifact: "express-measurements.json",
    reason: `${files.length}/${files.length} bounded native browser journeys passed; no load qualification` });
  ledger.readyForLoad = true;
  await f.json("coverage.json", ledger);
  const window = { startedAt: appStart, endedAt: last + 10 };
  const state = { Status: "running", Running: true, Pid: native.pid, Paused: false, Restarting: false, Dead: false,
    ExitCode: 0, OOMKilled: false, StartedAt: native.startedAt, FinishedAt: "0001-01-01T00:00:00Z" };
  const container = { id: native.id, imageId: native.image, restartCount: 0, state };
  await f.json("express-host-actor.json", { id: native.id, imageId: native.image, role: "application", app, window,
    terminal: { ...container, limits: { CpusetCpus: liveActorCpus.application, NanoCpus: liveApplication.cpu * 1e9,
      Memory: liveApplication.memoryBytes }, state: { ...state, Status: "exited", Running: false, Pid: 0,
        FinishedAt: new Date(window.endedAt).toISOString() } } });
  for (let at = appStart; at <= window.endedAt; at += 800) samples.add(at);
  const path = `/system.slice/docker-${native.id}.scope`;
  return { ...f, start, end: window.endedAt + 10, records: [...samples].sort((a, b) => a - b).map((at) => ({ at, path, container })) };
}

function cgroup(path, pids = [], cpus = "0-7", quota = "max", memory = "max") {
  return { path, files: { "cgroup.procs": pids.join("\n"), "cgroup.events": `populated ${Number(pids.length > 0)}\n`,
    "cpu.stat": "usage_usec 10\n", "cpu.max": `${quota} 100000\n`, "cpuset.cpus.effective": `${cpus}\n`,
    "memory.current": "10\n", "memory.peak": "20\n", "memory.max": `${memory}\n`, "memory.events": "oom 0\noom_kill 0\n" } };
}

export function isolatedLiveLifetime(capture, { campaign, binding, invocation, directory, command, pid }, clock) {
  const parent = `/system.slice/corten-bench-groups-${campaign}.service`, path = `${parent}/native-${command}-0123456789abcdef`;
  const ancestors = [];
  for (let at = parent;; at = posix.dirname(at)) { ancestors.push(cgroup(at)); if (at === "/") break; }
  const stat = (id, name) => `${id} (${name}) S ${[1, ...Array(17).fill(0), id * 10, 0].join(" ")}`;
  const executables = new Map();
  function process(scope, id, name, sha256, type = null) {
    if (!executables.has(sha256)) {
      const identity = { dev: "1", ino: String(executables.size + 1), size: "10", mtimeNs: "100", ctimeNs: "100" };
      executables.set(sha256, { identity, ref: executableReference(identity), sha256 });
    }
    const { identity, ref } = executables.get(sha256);
    return { stat: stat(id, name), cgroup: `0::${scope}\n`, executableRef: ref, executableIdentity: identity, type };
  }
  const leader = process(path, pid, "node", capture.tools.node);
  const sample = (at, processes = [], pids = [], participant) => ({ at, processes, groups: [cgroup(path, pids, liveActorCpus.browser)],
    docker: { inventory: participant ? [participant.container.id] : [], participants: participant ? [participant] : [], gaps: [] } });
  const samples = [sample(capture.start - 5)];
  for (const [index, row] of capture.records.entries()) {
    const app = process(row.path, row.container.state.Pid, "native", hash("application"));
    const rendererPid = 6000 + index;
    const renderer = process(path, rendererPid, "chrome", capture.tools.browser, "--type=renderer");
    const participant = { startedAt: row.at, endedAt: row.at, container: row.container, kernel: {
      at: row.at, bootId: clock.bootId, stat: app.stat, cgroup: app.cgroup, ancestors: [cgroup("/system.slice"), cgroup("/")],
      groups: [cgroup(row.path, [row.container.state.Pid], liveActorCpus.application, "100000", liveApplication.memoryBytes)], processes: [app],
    } };
    samples.push(sample(row.at, [leader, renderer], [pid, rendererPid], participant));
  }
  samples.push(sample(capture.end));
  mkdirSync(directory); mkdirSync(join(directory, "processes"));
  const serial = (value) => `${JSON.stringify(value)}\n`;
  const save = (name, value) => writeFileSync(join(directory, name), serial(value));
  save("binding.json", { schema: "benchmark-isolated-host-lifetime/v1", ...binding.request, campaign, command, leaderPid: pid,
    leaderIdentity: processIdentity(leader.stat), parent, path, bindingSha256: deploymentSha256(binding), invocation,
    bootId: clock.bootId, ancestors, dockerBaseline: [] });
  save("executables.json", { schema: "benchmark-participant-executables/v1", executables: [...executables.values()] });
  const written = new Set();
  for (const sample of samples) sample.processes = sample.processes.map((p) => {
    const { cgroup, executableRef, executableIdentity, type } = p;
    const key = hash(serial({ ...processIdentity(p.stat), cgroup, executableRef, executableIdentity, type }));
    if (!written.has(key)) { save(`processes/${key}.json`, p); written.add(key); }
    return key;
  });
  writeFileSync(join(directory, "samples.jsonl"), samples.map(serial).join(""));
  return { attach(value) { assert.equal(value, pid); }, dispose() {}, finish(result, retainClock) {
    assert.equal(retainClock, true, "official isolated timing must ask for a terminal clock");
    save("terminal.json", { terminal: true, attached: true, empty: true, samples: samples.length, observerError: null,
      observerFailures: { count: 0, first: null, last: null },
      command: result, bootId: clock.bootId, ancestors, terminalClock: clock });
    return tree(directory);
  } };
}
