import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectSaved } from "../workloads/isolated/adapters/hardening.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { featureProfile, qualificationSettings } from "../marketplace/feature-contract.mjs";
import { boundedQualification } from "./qualification.mjs";
import { livePaths } from "../fullstack/conformance.mjs";
import { assembleRecovery } from "./dependency-recovery-capture.mjs";
import { assembleBounded, boundedProbeConfig } from "./request-capture.mjs";
import { boundedReadPlan } from "./bounded-requests.mjs";
import { recoverySchedule } from "./dependency-recovery-contract.mjs";
import { artifacts, digest, savedFiles, savedProofVersion, phaseInputs, verifyArtifacts } from "./evidence.mjs";
import { ownedContainerRecorder, terminalHealthPaths } from "./lifecycle.mjs";
import { assessNative } from "./native.mjs";
import { apps, budgets, matrix, nativeGroup, parseArgs, registryDigest, schema, boundedRequestsVersion, deploymentQualificationVersion, phases } from "./plan.mjs";
import { verify } from "./verify.mjs";
import { finalizeCell } from "./run.mjs";

const budget = budgets(), phase = "dependency-recovery", commit = "a".repeat(40), subjectSha256 = "b".repeat(64);
const origin = 1_000_000_000_000n, bootId = "01234567-89ab-cdef-0123-456789abcdef";
const ns = (ms) => String(origin + BigInt(ms) * 1_000_000n);
const clock = (ms) => ({ bootId, monotonicNs: ns(ms) });
const expected = records().item_1;
const receipt = { status: 200, contentType: "application/json", complete: true, error: null, bodyBase64: Buffer.from(JSON.stringify(expected)).toString("base64") };
const response = (status, body = "{}") => ({ status, body, bytes: Buffer.byteLength(body), sha256: digest(body), complete: true, ms: 3 });
const healthPath = livePaths[0];

function fixture(source = "api") {
  const processes = ["application", "upstream"].map((id) => ({ id, role: id, count: 1 }));
  const settings = { phase, case: "direct", review: subjectSha256, nativeSource: source, effectiveBudgets: JSON.stringify(budget),
    terminalHealthPaths: { application: healthPath, upstream: "/health" }, deployment: { mode: "direct", countAllProcesses: true, processes } };
  const parity = { workload: "marketplace-v2", source, jsonRecords: 500, pages: 264,
    profiles: ["en-US", "fr-FR", "de-DE"].flatMap((locale) => [true, false].flatMap((javaScriptEnabled) => [true, false].map((mobile) =>
      ({ locale, javaScriptEnabled, mobile, passed: true })))),
    ...(source === "api" ? { upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } } : {}) };
  const lifecycle = {}, provenance = [];
  for (const { id } of processes) {
    const limit = budget.resources[id === "application" ? "applicationDirect" : id], path = settings.terminalHealthPaths[id], host = "127.0.0.1:8080";
    const before = { Id: digest(id), Image: "sha256:" + digest("image " + id), Config: {}, HostConfig: { NanoCpus: limit.cpu * 1e9,
      Memory: limit.memory, MemorySwap: limit.memory, PidsLimit: 512, Ulimits: [{ Name: "nofile", Hard: 65536, Soft: 65536 }],
      RestartPolicy: { Name: "no" }, Privileged: false, PortBindings: {} }, State: { Running: true, StartedAt: "2026-11-18T00:00:00.000Z",
      FinishedAt: "0001-01-01T00:00:00Z", ExitCode: 0, OOMKilled: false } };
    provenance.push({ id, image: before.Image, config: digest(id), source: commit, evidence: id + "-before.json" });
    lifecycle[id] = { before, after: structuredClone(before), events: [], observation: { start: clock(20100), end: clock(20150) },
      health: { path, bootId, response: { ...response(200), startedNs: ns(20101), endedNs: ns(20105), url: "http://" + host + path, method: "GET", host } } };
  }
  const [normal, slow, restored] = source === "api" ? [10, 20, 20] : [0, 0, 0];
  const snapshot = (phase, observedAtMs, elapsedSinceStartMs, n, s, r) => ({ phase, observedAtMs, elapsedSinceStartMs, delayMs: 150, windowMs: 8000,
    reads: { normal: n, slow: s, restored: r }, responses200: { normal: n, slow: s, restored: r } });
  const upstream = { before: snapshot("normal", 0, null, 3, 0, 0), slow: snapshot("slow", 4010, 10, 3 + normal, 0, 0),
    restored: snapshot("restored", 12010, 8010, 3 + normal, slow, 0), after: snapshot("restored", 20010, 16010, 3 + normal, slow, restored) };
  const samples = recoverySchedule.map((scheduledMs) => ({ scheduledMs, startMs: scheduledMs,
    endMs: scheduledMs + (source === "api" && scheduledMs >= 4000 && scheduledMs < 12000 ? 170 : 20), ok: true, receipt: { ...receipt } }));
  const resource = (window, atMs) => ({ type: "resources", window, atMs, collectedAtMs: atMs + 10,
    samples: Object.fromEntries(processes.map(({ id }) => [id, { cpu: "usage_usec 1234\n", memory: "8388608\n", events: "oom_kill 0\n",
      procs: ["42"], cpuSeconds: 0.001234, memoryBytes: 8388608, running: true, oomKilled: false, startedNs: ns(atMs + 1), endedNs: ns(atMs + 9) }])) });
  return { source, settings, lifecycle, provenance, parity, raw: [{ type: "clock", ...clock(0), wallAtStart: "2026-11-18T00:00:01.000Z" },
    resource("before", 2000), resource("during", 8000), resource("after", 16000), { type: phase, samples, restoredAtMs: 12000, upstream }],
  cleanup: { complete: true, commandClients: 0, failures: [], volumes: [], containers: [], nativeClock: clock(20200) } };
}

test("replays API recovery and fixture bypass without attack or defense results", () => {
  for (const [source, status] of [["api", "recovered"], ["fixture", "fixture-control"]]) {
    const capture = assembleRecovery(fixture(source));
    assert.equal(capture.assessment.status, status);
    assert.equal(capture.terminal.healthy, true);
    assert.deepEqual(Object.keys(capture.resources), ["before", "during", "after"]);
    for (const field of ["attack", "defense", "targetOutcome", "sourceObservation"]) assert.ok(!Object.hasOwn(capture, field));
  }
});

test("bounded capture keeps a complete target failure and rejects a mixed legacy journal", () => {
  const input = fixture("fixture");
  const phase = input.settings.phase = "request-limit";
  const config = boundedProbeConfig({ phase, source: input.source, mode: "direct" }, budget, "hardening-123456789abc");
  const targetOrigin = config.target.origin, upstreamOrigin = config.upstream;
  const { reads } = boundedReadPlan(phase, targetOrigin, upstreamOrigin);
  const samples = reads.map((request, i) => ({ ...request, startMs: i * 20, endMs: i * 20 + 5,
    receipt: i === 1 ? { ...receipt, status: 503, bodyBase64: "" } : receipt }));
  const row = { type: "bounded-requests", version: boundedRequestsVersion, phase, source: input.source,
    targetOrigin, upstreamOrigin, samples, upstream: null, completeAtMs: samples.at(-1).endMs };
  const raw = [input.raw[0], row];
  const capture = assembleBounded({ ...input, raw, config });
  assert.equal(capture.schema, "native-bounded-requests-capture/v1");
  assert.equal(capture.assessment.status, "target-failure"); assert.equal(capture.assessment.healthy, false);
  assert.equal(capture.terminal.healthy, true);
  assert.throws(() => assembleBounded({ ...input, raw: [...raw, { type: "attack" }], config }));
  input.settings.terminalHealthPaths.application = null;
  input.lifecycle.application.health = { path: null, response: null };
  const missing = assembleBounded({ ...input, raw, config });
  assert.equal(missing.assessment.status, "target-failure");
  assert.equal(missing.terminal.disposition, "missing-liveness");
});

test("isolated runner finalizes a bounded cell using owned receipts, not the empty cleanup inventory", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "hardening-finalize-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const out = join(folder, "cell"); mkdirSync(out);
  const input = fixture("fixture");
  const cell = { key: "corten/fixture/direct/request-limit", mode: "direct", source: input.source, phase: "request-limit", status: "not-run" };
  const runId = "hardening-123456789abc";
  input.settings.phase = cell.phase;
  input.config = boundedProbeConfig(cell, budget, runId);
  const targetOrigin = input.config.target.origin, upstreamOrigin = input.config.upstream;
  const samples = boundedReadPlan(cell.phase, targetOrigin, upstreamOrigin).reads.map((spec, i) =>
    ({ ...spec, startMs: i * 20, endMs: i * 20 + 5, receipt }));
  input.raw = [input.raw[0], { type: "bounded-requests", version: boundedRequestsVersion, phase: cell.phase, source: cell.source,
    targetOrigin, upstreamOrigin, samples, upstream: null, completeAtMs: samples.at(-1).endMs }];

  const recorder = ownedContainerRecorder({ folder, runId, command: () => assert.fail("offline finalization must not invoke Docker") });
  const wall = Date.parse(input.raw[0].wallAtStart);
  const before = {}, after = {};
  for (const [i, [step, role, cpus]] of [["application", "applicationDirect", "1"], ["upstream", "upstream", "2"], ["probe", "apparatus", "4-5"]].entries()) {
    const pid = 100 + i, service = input.lifecycle[step]?.before;
    const created = service ? { ...service, State: { ...service.State, Pid: pid } }
      : { Id: digest(step), Image: "sha256:" + digest("image " + step), State: { Pid: 0 } };
    const startedAt = service?.State.StartedAt ?? new Date(wall - 10).toISOString();
    const terminal = { State: { StartedAt: startedAt, FinishedAt: new Date(wall + 60).toISOString() } };
    recorder.records.push({ intent: { cell: cell.key, step, role }, created, terminal });
    const path = `/system.slice/docker-${created.Id}.scope`;
    before[step] = { id: created.Id, imageId: created.Image, startedAt, pid, startTicks: "12345", path, atMs: wall - 5,
      groups: [{ path, files: { "cgroup.procs": `${pid}\n`, "cpuset.cpus.effective": `${cpus}\n` } }] };
    after[step] = { ...before[step], atMs: wall + 50 };
  }
  // A preceding cell's launch must not substitute for this cell's receipt.
  recorder.records.unshift({ intent: { ...recorder.records[0].intent, cell: "previous-cell" } });
  assert.deepEqual(input.cleanup.containers, []);
  const cpuFile = join(out, "cpu-roles.json");
  const cpuRoles = { schema: "native-hardening-cpu-roles/v1", before, after };
  writeFileSync(cpuFile, JSON.stringify(cpuRoles));
  assert.throws(() => finalizeCell(out, cell, true, input.cleanup.containers, input));
  assert.equal(cell.status, "not-run");
  finalizeCell(out, cell, true, recorder.records, input);
  const capture = JSON.parse(readFileSync(join(out, "capture.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  verifyArtifacts(out, manifest);
  assert.ok(manifest.some((row) => row.path === "cpu-roles.json"));
  assert.equal(cell.status, "observed");
  assert.equal(cell.apparatusValid, true);
  assert.equal(cell.capture, cell.key + "/capture.json");
  assert.equal(capture.assessment.status, "accepted");
  assert.deepEqual(cell.boundedRequests, capture.assessment);
  assert.equal(cell.boundedTerminalHealthy, true);
});

function openCircuit(source = "api", boundarySuccess = false) {
  const input = fixture(source), { samples, restoredAtMs, upstream } = input.raw.at(-1);
  for (const sample of samples) {
    if (sample.startMs < restoredAtMs || boundarySuccess && sample.startMs === restoredAtMs) continue;
    sample.ok = false;
    sample.receipt = { ...sample.receipt, status: 503, bodyBase64: Buffer.from("{}").toString("base64") };
  }
  upstream.after.reads.restored = upstream.after.responses200.restored = 0;
  return input;
}

test("a circuit that stays open after the upstream restores is unrecovered, not invalid evidence", () => {
  const capture = assembleRecovery(openCircuit());
  assert.equal(capture.assessment.status, "unrecovered");
  assert.equal(capture.assessment.windows.after.successes, 0);
  assert.equal(capture.assessment.windows.after.errors, 20);
  assert.equal(capture.assessment.recoveryMs, null);
  assert.equal(capture.upstream.restored.phase, "restored");
  assert.equal(capture.terminal.healthy, true);
  assert.equal(assembleRecovery(openCircuit("fixture")).assessment.status, "fixture-degraded");
});

test("a failed recovery still requires slow-phase exposure and a recorded restore", () => {
  const input = openCircuit(), { samples, upstream } = input.raw.at(-1);
  for (const sample of samples.filter((s) => s.startMs >= 4000 && s.startMs < 12000)) {
    sample.ok = false;
    sample.receipt.status = 503;
  }
  for (const snapshot of [upstream.restored, upstream.after]) snapshot.reads.slow = snapshot.responses200.slow = 0;
  assert.throws(() => assembleRecovery(input), /missing API upstream exposure/);
  upstream.restored.reads.slow = upstream.after.reads.slow = 1;
  assert.equal(assembleRecovery(input).assessment.status, "unrecovered", "a delayed read proves exposure without a successful reply");
  upstream.restored.phase = "slow";
  assert.throws(() => assembleRecovery(input), /wrong phase/);
});

test("a success at the restore boundary requires an attributable upstream read and completion", () => {
  const input = openCircuit("api", true), { samples, upstream } = input.raw.at(-1);
  assert.throws(() => assembleRecovery(input), /missing API upstream read\/200 pair for success at 12000 ms/);
  upstream.restored.observedAtMs = 12030;
  upstream.restored.elapsedSinceStartMs = 8030;
  upstream.restored.reads.restored = upstream.after.reads.restored = 1;
  assert.throws(() => assembleRecovery(input), /missing API upstream read\/200 pair for success at 12000 ms/);
  upstream.restored.responses200.restored = upstream.after.responses200.restored = 1;
  const capture = assembleRecovery(input);
  assert.equal(capture.assessment.windows.after.successes, 1);
  assert.equal(capture.assessment.status, "unrecovered");
  const next = samples.find((sample) => sample.scheduledMs === 12400);
  Object.assign(next, { ok: true, receipt: { ...receipt } });
  assert.throws(() => assembleRecovery(input), /missing API upstream read\/200 pair for success at 12400 ms/);
});

test("a fast interior success cannot use delayed background reads as evidence", () => {
  const input = fixture(), { samples } = input.raw.at(-1);
  const interior = samples.find(({ scheduledMs }) => scheduledMs === 8000);
  interior.endMs = interior.startMs + 20;
  assert.throws(() => assembleRecovery(input), /missing API upstream read\/200 pair for success at 8000 ms/);
  interior.endMs = interior.startMs + 149;
  assert.equal(assembleRecovery(input).assessment.status, "recovered");
});

test("a boundary-spanning success cannot combine a restored read with a slow completion", () => {
  const input = openCircuit(), { samples, upstream } = input.raw.at(-1);
  const firstSlow = samples.find(({ scheduledMs }) => scheduledMs === 4000);
  Object.assign(firstSlow, { startMs: 4020, endMs: 4190 });
  const crossing = samples.find(({ scheduledMs }) => scheduledMs === 11600);
  Object.assign(crossing, { startMs: 11790, endMs: 12040 });
  upstream.slow.reads.slow = 1; // Too early for any successful slow probe.
  upstream.restored.reads.restored = upstream.after.reads.restored = 1;
  assert.throws(() => assembleRecovery(input), /missing API upstream read\/200 pair/);
  upstream.restored.responses200.restored = upstream.after.responses200.restored = 1;
  assert.equal(assembleRecovery(input).assessment.status, "unrecovered");

  crossing.endMs = 11840;
  assert.throws(() => assembleRecovery(input), /missing API upstream read\/200 pair/);
  crossing.endMs = 12040;

  // Alternatively, a slow read can finish after restore and keep its read phase.
  upstream.slow.reads.slow = 0;
  upstream.restored.reads.restored = upstream.after.reads.restored = 0;
  upstream.restored.responses200.restored = upstream.after.responses200.restored = 0;
  upstream.restored.responses200.slow--;
  assert.equal(assembleRecovery(input).assessment.status, "unrecovered");
});

test("rejects forged success, missing dependency evidence, and invalid native receipts", () => {
  for (const [mutate, error] of [
    [(i) => i.raw.at(-1).samples[0].receipt.bodyBase64 = Buffer.from("{}").toString("base64"), /success contradicts/],
    [(i) => i.raw.at(-1).samples[0].endMs = 601, /success contradicts/],
    [(i) => i.raw.at(-1).samples.pop(), /missing or extra recovery probes/],
    [(i) => i.raw.at(-1).upstream.slow.phase = "normal", /wrong phase/],
    [(i) => i.raw.at(-1).upstream.slow.windowMs = 5000, /5000/],
    [(i) => i.raw.at(-1).upstream.restored.responses200.slow = 1, /missing API upstream read\/200 pair/],
    [(i) => i.raw.at(-1).restoredAtMs++, /timestamp differs/],
    [(i) => i.raw[2].samples.application.endedNs = ns(8011), /counter timestamps/],
    [(i) => i.raw[2].samples.application.memoryBytes++, /8388608/],
    [(i) => i.lifecycle.application.observation.start = clock(20000), /post-probe/],
    [(i) => i.lifecycle.application.events.push({ Action: "restart" }), /lifecycle intervention/],
    [(i) => i.cleanup.commandClients++, /strictly equal/],
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => assembleRecovery(input), error);
  }
  const input = fixture("fixture");
  input.raw.at(-1).upstream.after.reads.restored++;
  assert.throws(() => assembleRecovery(input), /unexpected upstream counter delta/);
});

function apiQualification(missingLive) {
  const base = { ms: 5, status: 200, headers: {}, bodyLength: 0 };
  const page = Buffer.from("<p>marketplace</p>");
  const probes = Object.fromEntries(["page", "json", "pageBr", "jsonBr", "jsonGzip", "page404", "json404", "json405", "head", "badHost",
    "page500", "json500", "afterUpstream"].map((key) => [key, base]));
  const live = { ...base, path: healthPath };
  return boundedQualification({ ...probes, page: { ...base, body: page.toString("base64"), bodyLength: page.length }, form: "no native POST form",
    ...(missingLive ? { liveness: livePaths.map((path) => ({ ...base, path, status: 404 })) } : { live, liveness: [live] }) }, "api");
}

function apiControls(missingLive) {
  const nonce = "a".repeat(24), changed = { ...expected, title: nonce };
  const controllers = ["reset-before", "mutate", "count-json", "reset-count", "count-page", "fault-503", "fault-302", "reset-after", "verify-reset"]
    .map((step) => ({ step, response: response(200, JSON.stringify(step.startsWith("count-") ? { status: 200, answers: { 200: 1 }, requests: { item_1: 1 } } : { status: 200, answers: {}, requests: {} })) }));
  const responses = [["mutated-json", 200, JSON.stringify(changed)], ["mutated-page", 200, nonce], ["fault-json-503", 503], ["fault-page-503", 503],
    ...(missingLive ? [] : [["live-503", 200]]), ["fault-json-302", 502], ["fault-page-302", 502], ["restored-json", 200, JSON.stringify(expected)]]
    .map(([step, status, body]) => ({ step, response: response(status, body) }));
  return { schema: "native-hardening-controls/v1", source: "api", host: { allowed: response(200), denied: response(400) },
    liveness: { path: missingLive ? null : healthPath, baseline: missingLive ? null : response(200), negative: response(404) },
    api: { nonce, expected: changed, original: expected, controllers, responses } };
}

test("malformed controller counts are not an app failure; valid empty counters still are", () => {
  const q = apiQualification(true), raw = apiControls(true);
  const set = (step, data) => { raw.api.controllers.find(r => r.step === step).response = response(200, JSON.stringify(data)); };
  set("count-json", { requests: {}, answers: {}, status: 200 });
  assert.equal(assessNative(raw, q).sourceControl, "target-functional-failure");
  for (const malformed of [{}, { requests: [], answers: {}, status: 200 }, { requests: { item_1: -1 }, answers: {}, status: 200 }]) {
    set("count-page", malformed);
    assert.throws(() => assessNative(raw, q), /controller counter/);
  }
});

test("a server error during health discovery is not an absent endpoint", () => {
  const q = apiQualification(true), raw = apiControls(true);
  assert.equal(assessNative(raw, q).liveness, "missing");
  q.probes.liveness[0].status = 503;
  const assessment = assessNative(raw, boundedQualification(q.probes, "api"));
  assert.deepEqual(assessment.targetFunctionalFailures, [{ control: "liveness-discovery", path: livePaths[0], status: 503 }]);
  assert.notEqual(assessment.liveness, "missing");
});

test("real offline replay distinguishes an undiscovered endpoint from a terminal HTTP failure", async (t) => {
  const prefix = join(tmpdir(), "dependency-recovery-replay-"), folder = mkdtempSync(prefix);
  t.after(() => { assert.ok(folder.startsWith(prefix)); rmSync(folder, { recursive: true }); });
  const input = fixture(), cells = matrix(), cell = cells.find((c) => c.app === "corten" && c.phase === phase && c.mode === "direct" && c.source === "api");
  const options = parseArgs(["w17", "--build", "--review", subjectSha256]);
  const runId = "recovery-replay-fixture", tools = Object.fromEntries(["node", "checker", "edge", "cert"].map((name) => [name, { Id: "sha256:" + digest(name) }]));
  const files = [...new Set(["Cargo.lock", "Cargo.toml", "package.json", "package-lock.json", "bench/hardening/run.mjs", "bench/hardening/verify.mjs",
    "bench/hardening/evidence.mjs", ...phases.flatMap(phaseInputs),
    "bench/hardening/dependency-recovery-capture.mjs", "bench/hardening/dependency-recovery-contract.mjs", "bench/hardening/dependency-recovery-probe.mjs",
    "bench/hardening/dependency-recovery-upstream.mjs", "bench/hardening/resource-sample.mjs", "bench/marketplace/corten/Dockerfile"])]
    .map((path) => ({ path, sha256: digest(path) }));
  const sourceHash = digest(JSON.stringify(files.filter((f) => /^(Cargo\.|bench\/marketplace\/corten\/)/.test(f.path)).map((f) => [f.path, f.sha256])));
  const out = join(folder, cell.key); mkdirSync(out, { recursive: true }); mkdirSync(join(folder, "fixtures"));
  const put = (name, value) => writeFileSync(join(out, name), JSON.stringify(value));
  const writeSummary = (capture, q, controls, terminalHealthy = capture.terminal.healthy) => {
    Object.assign(cell, { status: "observed", parity: "passed", apparatusValid: true, nativeMissingFeatures: q.missing, nativeAssessment: assessNative(controls, q),
      dependencyRecovery: capture.assessment, dependencyTerminalHealthy: terminalHealthy });
    writeFileSync(join(folder, "summary.json"), JSON.stringify({ schema, options, budget, cells, runId, tools, commit, registryDigest, complete: false,
      groupReady: false, failures: [], cleanupFailures: [], nativeGroup: nativeGroup(cells), fixtureSha256: digest(readFileSync(join(folder, "fixtures/marketplace.json"))),
      savedProofVersion, boundedRequestsVersion, lifecycleVersion: 4, nativeControlsVersion: 1, deploymentQualificationVersion }));
    writeFileSync(join(folder, "run-manifest.json"), JSON.stringify(savedFiles(folder).filter((f) => f.path !== "run-manifest.json")));
  };
  writeFileSync(join(folder, "fixtures/marketplace.json"), JSON.stringify(records()));
  const deployment = { processes: [], provenance: input.provenance, totalBudget: budget.resources, network: { Name: runId + "-net", Id: digest(runId), Containers: {} } };
  for (const p of input.settings.deployment.processes) {
    const life = input.lifecycle[p.id], origin = input.provenance.find(({ id }) => id === p.id), before = life.before;
    deployment.processes.push({ ...p, containerId: before.Id }); deployment.network.Containers[before.Id] = {};
    if (p.id === "application") {
      before.Config = { Labels: { "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false", "run.corten.marketplace.profile": featureProfile,
        "run.corten.hardening.source": sourceHash }, Env: [`PROFILE=${qualificationSettings.nativeProfile}`, `MAX_CONNECTIONS=${qualificationSettings.maxConnections}`, "MARKETPLACE_SOURCE=api"] };
      origin.source = `${commit}:sha256:${sourceHash}`;
    } else {
      before.Image = tools.node.Id; origin.image = before.Image; origin.source = `${commit}:bench/hardening/dependency-recovery-upstream.mjs`;
    }
    life.after = structuredClone(before);
    put(p.id + "-before.json", { info: before, top: "PID COMMAND\n42 fixture\n" });
    origin.config = digest(readFileSync(join(out, p.id + "-before.json")));
  }
  put("deployment.json", deployment);
  put("native-parity.json", input.parity); put("parity.json", input.parity); put("cleanup.json", input.cleanup);
  writeFileSync(join(out, "raw.jsonl"), input.raw.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const binding = { request: { group: "hardening", round: "w17", commit, recipe: "native-defaults" }, subjectSha256,
    selection: { group: "hardening", apps, contractSha256: registryDigest }, sources: { commit, files },
    execution: { invocation: { executable: "node", argv: ["bench/hardening/run.mjs", "w17", "--build", "--review", subjectSha256],
      cwd: "repository-root", shell: false }, effectiveOptions: options, settings: budget }, resources: { budget: budget.resources } };
  const applicationHealth = structuredClone(input.lifecycle.application.health);
  for (const [missingLive, status, terminalDisposition, expectedOutcome] of [
    [false, 200, "recovered", "not-run"], [false, 503, "not-recovered", "failed"],
    [true, 200, "missing-liveness", "not-run"], [true, 503, "not-recovered", "failed"],
  ]) {
    const q = apiQualification(missingLive), controls = apiControls(missingLive);
    const terminalHealthy = terminalDisposition === "recovered";
    input.settings.terminalHealthPaths = terminalHealthPaths(q);
    input.lifecycle.application.health = missingLive ? { path: null, response: null } : structuredClone(applicationHealth);
    input.lifecycle[missingLive ? "upstream" : "application"].health.response.status = status;
    put("settings.json", input.settings); put("qualification.json", q); put("native-controls.json", controls);
    for (const [id, life] of Object.entries(input.lifecycle)) put(id + "-lifecycle.json", life);
    const capture = assembleRecovery(input); put("capture.json", capture); put("manifest.json", artifacts(out)); writeSummary(capture, q, controls);
    assert.equal(capture.assessment.status, "recovered");
    const verified = verify(folder);
    assert.equal(verified.connectionFloodResistance, "Connection-flood resistance: not measured.");
    assert.deepEqual(verified.dependencyRecovery, [{ key: cell.key, assessment: capture.assessment, terminalHealthy, terminalDisposition }]);
    const result = await inspectSaved(binding, folder);
    assert.equal(result.status, "blocked", "one synthetic cell cannot qualify the native run");
    assert.deepEqual(result.outcomes.find((o) => o.app === cell.app), { app: cell.app, outcome: expectedOutcome });
    if (missingLive && status === 503) {
      put("capture.json", { ...capture, terminal: { ...capture.terminal, disposition: "missing-liveness" } });
      put("manifest.json", artifacts(out)); writeSummary(capture, q, controls);
      assert.throws(() => verify(folder), /saved capture differs from raw observations/);
      assert.equal((await inspectSaved(binding, folder)).status, "invalid");
    } else if (!terminalHealthy) {
      writeSummary(capture, q, controls, true);
      assert.throws(() => verify(folder), /saved dependency terminal health differs from replay/);
      assert.equal((await inspectSaved(binding, folder)).status, "invalid");
    }
  }

  // No timing took place. Only the saved preflight responses establish a
  // target failure; retaining or inventing a failure label is insufficient.
  const partial = matrix(), stopped = partial.find(c => c.app === cell.app && c.phase === "request-limit" && c.source === "api" && c.mode === "deployed-edge");
  const dir = join(folder, stopped.key); mkdirSync(dir, { recursive: true });
  const persist = (path, value) => writeFileSync(join(dir, path), JSON.stringify(value));
  const q = apiQualification(false), controls = apiControls(false);
  controls.host.allowed = response(503);
  Object.assign(stopped, { status: "invalid", failedStage: "edge-native-controls", failureKind: "target-functional-failure",
    apparatusValid: false, edgeAssessment: assessNative(controls, q, "deployed-edge") });
  persist("edge-qualification.json", q); persist("edge-native-controls.json", controls);
  const failure = { kind: stopped.failureKind, stage: stopped.failedStage };
  persist("failure.json", failure);
  const summary = JSON.parse(readFileSync(join(folder, "summary.json")));
  Object.assign(summary, { cells: partial, nativeGroup: nativeGroup(partial), failures: [{ key: stopped.key, ...failure }] });
  writeFileSync(join(folder, "summary.json"), JSON.stringify(summary));
  const seal = () => writeFileSync(join(folder, "run-manifest.json"), JSON.stringify(savedFiles(folder).filter(f => f.path !== "run-manifest.json")));
  seal();
  const result = await inspectSaved(binding, folder);
  assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.equal(result.outcomes.find(o => o.app === stopped.app).outcome, "not-run", "unbound failure stays diagnostic");
  for (const wrong of [{ url: "http://127.0.0.1:8080/marketplace/en-US/item_1" }, { method: "POST" }, { host: "127.0.0.1:8080" }]) {
    controls.host.allowed = { ...response(503), url: "https://localhost:8080/marketplace/en-US/item_1", method: "GET", host: "localhost:8080", ...wrong };
    persist("edge-native-controls.json", controls); seal();
    assert.equal((await inspectSaved(binding, folder)).status, "invalid");
  }
  controls.host.allowed = response(200); persist("edge-native-controls.json", controls); seal();
  assert.equal((await inspectSaved(binding, folder)).status, "invalid");
});
