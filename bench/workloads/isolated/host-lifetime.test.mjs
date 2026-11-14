// Synthetic retained OS records test replay only, never real host qualification.
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { test } from "node:test";
import { deploymentSha256 } from "../deployments.mjs";
import { definition } from "../registry.mjs";
import { participantSnapshot, replayExecution } from "../../fullstack-browser/native-execution.mjs";
import { composeHostProof, inspectLifetime, processIdentity, inspectBrowserParticipants, resolveParticipantExecutables } from "./host-lifetime.mjs";
import { executableIdentity, executableReference, hashExecutableDescriptor } from "./participant-executables.mjs";

const campaign = "r17-0123456789abcdef", command = 0, pid = 100;
const binding = { request: { group: "client-heavy", round: "w17", commit: "a".repeat(40) }, resources: { app: null } };
const invocation = { executable: "node", argv: ["bench/client-heavy/run.mjs", "w17"] };
const result = { terminal: true, code: 2, signal: null, cancelled: false, forced: false, error: null, success: false };
const parent = `/system.slice/corten-bench-groups-${campaign}.service`, path = `${parent}/native-0-0123456789abcdef`;
const stat = (pid, name) => `${pid} (${name}) S ${[1, ...Array(17).fill(0), pid * 10, 0].join(" ")}`;
const group = (path, ids = []) => ({ path, files: { "cgroup.procs": ids.map((id) => `${id}\n`).join(""),
  "cgroup.events": `populated ${ids.length ? 1 : 0}\n`, "cpu.stat": "usage_usec 10\n", "cpu.max": "max 100000\n",
  "cpuset.cpus.effective": "0-7\n", "memory.current": "10\n", "memory.peak": "20\n", "memory.max": "max\n", "memory.events": "oom 0\noom_kill 0\n" } });

test("deferred executable digest binds the original sampled inode and rejects mutation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "isolated-executable-"));
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true }); });
  const file = join(directory, "executable"), bytes = Buffer.from("actual descriptor bytes");
  writeFileSync(file, bytes);
  const fd = openSync(file, "r");
  try {
    const identity = executableIdentity(fd), ref = executableReference(identity);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(hashExecutableDescriptor(fd, identity), digest);
    const record = { executableRef: ref, executableIdentity: identity };
    const proof = { schema: "benchmark-participant-executables/v1", executables: [{ ref, identity, sha256: digest }] };
    assert.equal(resolveParticipantExecutables(record, proof).executableSha256, digest);
    assert.throws(() => resolveParticipantExecutables(record, { ...proof, executables: [] }));
    assert.throws(() => resolveParticipantExecutables(record, { ...proof, executables: [...proof.executables, ...proof.executables] }));
    assert.throws(() => resolveParticipantExecutables({ ...record, executableIdentity: { ...identity, ino: `${BigInt(identity.ino) + 1n}` } }, proof));
    assert.throws(() => resolveParticipantExecutables({ ...record, executableSha256: digest }, proof));
    writeFileSync(file, "mutated executable bytes");
    assert.throws(() => hashExecutableDescriptor(fd, identity));
  } finally { closeSync(fd); }
});

test("sealed deferred executable records replay without rewriting sample timestamps", (t) => {
  const f = browserFixture(t), entries = [];
  const samples = structuredClone(f.observation.samples), timestamps = samples.map((s) => s.at);
  for (const sample of samples) for (const p of [...sample.processes,
    ...sample.docker.participants.flatMap((r) => r.kernel?.processes ?? [])]) {
    const identity = { dev: "1", ino: String(entries.length + 1), size: "10", mtimeNs: "100", ctimeNs: "100" };
    const ref = executableReference(identity); entries.push({ ref, identity, sha256: p.executableSha256 });
    delete p.executableSha256; p.executableRef = ref; p.executableIdentity = identity;
  }
  f.observation.samples = samples;
  const path = join(f.directory, "executables.json");
  writeFileSync(path, JSON.stringify({ schema: "benchmark-participant-executables/v1", executables: entries }));
  const observed = replayBrowser(f);
  assert.equal(observed.status, "verified"); assert.deepEqual(observed.samples.map((s) => s.at), timestamps);
  assert.equal(composeHostProof(f.bound, f.native, observed).resources, "verified");
  entries[0].identity.ino = "999";
  writeFileSync(path, JSON.stringify({ schema: "benchmark-participant-executables/v1", executables: entries }));
  assert.throws(f.replay);
  rmSync(path); assert.throws(f.replay, { code: "ERR_ASSERTION" });
});
function fixture(t, change = () => {}, bound = binding) {
  const directory = mkdtempSync(join(tmpdir(), "isolated-host-replay-"));
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true }); });
  const ancestors = []; for (let p = parent; ; p = posix.dirname(p)) { ancestors.push(group(p)); if (p === "/") break; }
  const context = { schema: "benchmark-isolated-host-lifetime/v1", campaign, command, leaderPid: pid, parent, path,
    ...bound.request, bindingSha256: deploymentSha256(bound), invocation, bootId: "boot", ancestors };
  const processes = [[100, "node", "a", null], [101, "rustc", "c", null], [102, "chrome", "b", "--type=renderer"]]
    .map(([pid, name, hash, type]) => ({ stat: stat(pid, name), cgroup: `0::${path}\n`, executableSha256: hash.repeat(64), type }));
  const samples = [{ at: 0, groups: [group(path)], processes: [] }, { at: 50, groups: [group(path, [100, 101, 102])], processes },
    { at: 100, groups: [group(path)], processes: [] }];
  const terminal = { terminal: true, attached: true, empty: true, samples: 3, observerError: null, command: result, bootId: "boot", ancestors };
  change({ context, samples, terminal });
  writeFileSync(join(directory, "binding.json"), JSON.stringify(context));
  writeFileSync(join(directory, "samples.jsonl"), samples.map((s) => JSON.stringify(s) + "\n").join(""));
  writeFileSync(join(directory, "terminal.json"), JSON.stringify(terminal));
  return { directory, observation: () => inspectLifetime(bound, invocation, directory, { campaign, command, pid, result }) };
}

function browserFixture(t, selectedApp = "app") {
  const bound = { ...binding, request: { ...binding.request, group: "fullstack-browser" }, selection: { apps: [selectedApp] } };
  const id = "f".repeat(64), imageId = `sha256:${"e".repeat(64)}`, dockerPath = `/system.slice/docker-${id}.scope`;
  const state = { Status: "running", Pid: 300, Running: true, Paused: false, Restarting: false, OOMKilled: false,
    Dead: false, ExitCode: 0, StartedAt: "2026-11-14T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" };
  const participant = { id, role: "application", app: "app", case: "case", imageId, window: { startedAt: 20, endedAt: 70 },
    terminal: { id, imageId, restartCount: 0, state: structuredClone(state), limits: { NanoCpus: 1e9, Memory: 2 ** 30, CpusetCpus: "" } } };
  const g = group(dockerPath, [300]); g.files["cpu.max"] = "100000 100000\n"; g.files["memory.max"] = `${2 ** 30}\n`;
  const record = { startedAt: 49, endedAt: 51, container: { id, imageId, state, restartCount: 0 }, kernel: {
    bootId: "boot", stat: stat(300, "native"), cgroup: `0::${dockerPath}\n`, at: 50,
    ancestors: [group("/system.slice"), group("/")], groups: [g], processes: [
      { stat: stat(300, "native"), cgroup: `0::${dockerPath}\n`, executableSha256: "c".repeat(64), type: null }],
  } };
  record.kernel.ancestors.at(-1).files["cpu.max"] = null;
  record.kernel.ancestors.at(-1).files["memory.max"] = null;
  const f = fixture(t, ({ context, samples }) => {
    context.dockerBaseline = [];
    context.leaderIdentity = processIdentity(stat(100, "node"));
    for (const s of samples) s.docker = { inventory: [], participants: [], gaps: [] };
    samples[1].docker = { inventory: [id], participants: [record], gaps: [] };
  }, bound);
  const native = { cleanupComplete: true, qualificationPassed: false, outcomes: [{ app: "app", outcome: "unsupported" }],
    hostSubject: { schema: "native-browser-host-subject/v2", executionWindow: { startedAt: 10, endedAt: 90 },
      processWindows: [{ kind: "browser", app: "app", case: "case", startedAt: 20, endedAt: 70 }],
      toolIdentities: { node: "a".repeat(64), browser: "b".repeat(64), lockSha256: "9".repeat(64) },
      participants: [participant], subjectSha256: "d".repeat(64), filesSha256: "e".repeat(64) } };
  return { bound, native, observation: f.observation(), directory: f.directory, replay: f.observation };
}

function replayBrowser(f) {
  writeFileSync(join(f.directory, "samples.jsonl"), f.observation.samples.map((s) => JSON.stringify(s) + "\n").join(""));
  const terminal = JSON.parse(readFileSync(join(f.directory, "terminal.json")));
  terminal.samples = f.observation.samples.length;
  writeFileSync(join(f.directory, "terminal.json"), JSON.stringify(terminal));
  return f.replay();
}
function browserResourceResults(f) {
  return [f.observation, replayBrowser(f)].map((observation) => {
    try { return composeHostProof(f.bound, f.native, observation).resources; }
    catch (error) { assert.equal(error.code, "ERR_ASSERTION"); return "invalid"; }
  });
}

function lifecycleBoundaryFixture(t, { created = false, exited = false, rootAbsent = true } = {}) {
  const f = browserFixture(t, "corten"), template = f.observation.samples[1], p = f.native.hostSubject.participants[0];
  f.observation.samples = Array.from({ length: 41 }, (_, i) => {
    const at = i * 100, sample = structuredClone(template); sample.at = at;
    if (i === 0 || i === 40) { sample.groups = [group(path)]; sample.processes = []; }
    if (i < 2 || i > 38) sample.docker = { inventory: [], participants: [], gaps: [] };
    else {
      const r = sample.docker.participants[0]; r.startedAt = at + 1; r.endedAt = at + 3; r.kernel.at = at + 2;
      if (!rootAbsent) { r.kernel.ancestors.at(-1).files["cpu.max"] = "max 100000\n"; r.kernel.ancestors.at(-1).files["memory.max"] = "max\n"; }
    }
    return sample;
  });
  const running = structuredClone(p.terminal.state), neverStarted = { ...running, Status: "created", Running: false, Pid: 0,
    StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" };
  const terminal = exited ? { ...running, Status: "exited", Running: false, Pid: 0, ExitCode: 1,
    FinishedAt: "2026-11-14T00:00:04Z" } : running;
  const task = "browser-abcdef", caseKey = definition("fullstack-browser").cases[0].key;
  const image = { Id: p.imageId, Config: { Entrypoint: ["node"], Cmd: ["server.mjs"] } };
  const info = { Id: p.id, Name: "/native-case", Image: p.imageId,
    Config: { ...image.Config, Env: ["MARKETPLACE_SOURCE=fixture"], Labels: { "agent.owner": "codex", "agent.task": task } },
    RestartCount: 0, State: neverStarted, HostConfig: { NanoCpus: 1e9, CpuQuota: 0, CpuPeriod: 0, CpusetCpus: "",
      Memory: 2 ** 30, MemorySwap: 2 ** 31, ShmSize: 64 * 2 ** 20, PidsLimit: null, NetworkMode: "bridge" }, Mounts: [] };
  const snapshot = (state) => participantSnapshot({ ...info, State: state }, image);
  const identity = { event: "participant", role: "application", app: "corten", case: caseKey };
  const events = [
    { ...identity, phase: "created", at: 200, snapshot: snapshot(neverStarted) },
    { event: "command", operation: "start", role: identity.role, app: identity.app, case: caseKey, id: p.id, code: 0, at: 250 },
    { ...identity, phase: "running", at: 300, snapshot: snapshot(running) },
    { event: "browser-window", app: identity.app, case: caseKey, startedAt: 300, endedAt: 3600, at: 3600 },
    { ...identity, phase: "terminal", at: 3800, snapshot: snapshot(terminal) },
    { event: "remove", at: 3850, kind: "container", id: p.id, code: 0 },
    { event: "inventory", at: 3860, kind: "container", scope: "all", code: 0, ids: [] },
    ...["container", "network", "image", "volume"].map((kind) => ({ event: "inventory", at: 3870, kind, scope: "owned", code: 0, ids: [] })),
  ].map((e, seq) => ({ ...e, seq }));
  const replay = replayExecution({ json: () => ({ schema: "native-browser-execution/v2", task,
    commit: f.bound.request.commit, startedAt: 100, endedAt: 3900, events }) }, null);
  assert.deepEqual(replay.blocked, []); assert.equal(replay.cleanupComplete, true);
  assert.deepEqual(replay.participants[0].window, { startedAt: 200, endedAt: 3800 });
  Object.assign(f.native.hostSubject, { participants: replay.participants, processWindows: replay.processWindows,
    executionWindow: replay.executionWindow, subjectSha256: replay.subjectSha256 });
  f.native.outcomes = [{ app: "corten", outcome: exited ? "failed" : "passed" }];
  f.native.qualificationPassed = !exited;
  if (created) { const r = f.observation.samples[2].docker.participants[0]; r.kernel = null; r.container.state = structuredClone(neverStarted); }
  if (exited) for (const sample of f.observation.samples.filter((s) => s.at >= 3700 && s.at <= 3800)) {
    const r = sample.docker.participants[0]; r.kernel = null; r.container.state = structuredClone(terminal);
  }
  return f;
}

for (const [name, options] of [
  ["ordinary running", {}], ["created prefix inside native window", { created: true }],
  ["failed exited suffix inside native window", { exited: true }],
  ["both boundaries inside native window", { created: true, exited: true }],
  ["created prefix with observed root limit files", { created: true, rootAbsent: false }],
  ["exited suffix with observed root limit files", { exited: true, rootAbsent: false }],
]) test(`native lifecycle replay retains ${name}`, (t) => {
  const f = lifecycleBoundaryFixture(t, options);
  assert.deepEqual(browserResourceResults(f), ["verified", "verified"]);
});

for (const [name, mutate] of [
  ["created state reappears after live execution", (f) => { const d = f.observation.samples[10].docker;
    d.participants[0] = structuredClone(f.observation.samples[2].docker.participants[0]);
    Object.assign(d.participants[0], { startedAt: 1001, endedAt: 1003 }); }],
  ["live execution reappears after exit", (f) => { const d = f.observation.samples[38].docker;
    d.participants[0] = structuredClone(f.observation.samples[36].docker.participants[0]);
    Object.assign(d.participants[0], { startedAt: 3801, endedAt: 3803 }); d.participants[0].kernel.at = 3802; }],
  ["exited record disagrees with native terminal exit", (f) => { f.observation.samples[37].docker.participants[0].container.state.ExitCode = 137; }],
  ["created prefix retains a nonzero exit", (f) => { f.observation.samples[2].docker.participants[0].container.state.ExitCode = 1; }],
  ["missing record inside the native window", (f) => { f.observation.samples[10].docker = { inventory: [], participants: [], gaps: [] }; }],
  ["missing kernel in a declared running observation", (f) => { f.observation.samples[10].docker.participants[0].kernel = null; }],
  ["actual exited suffix contradicts still-running terminal", (f) => { Object.assign(f.native.hostSubject.participants[0].terminal.state,
    f.observation.samples[36].docker.participants[0].container.state); }],
]) test(`native boundary proof rejects ${name}`, (t) => {
  const f = lifecycleBoundaryFixture(t, { created: true, exited: true }); mutate(f);
  assert.ok(browserResourceResults(f).every((value) => value !== "verified"));
});

for (const delay of [1000, 1001]) test(`created prefix keeps the exact ${delay}ms continuity boundary`, (t) => {
  const f = lifecycleBoundaryFixture(t, { created: true });
  const created = f.observation.samples[2].docker.participants[0];
  for (const sample of f.observation.samples.filter((s) => s.at >= 300 && s.at < 1200)) {
    sample.docker.participants[0] = structuredClone(created);
    Object.assign(sample.docker.participants[0], { startedAt: sample.at + 1, endedAt: sample.at + 3 });
  }
  const first = f.observation.samples[12].docker.participants[0];
  first.startedAt = 200 + delay; first.kernel.at = first.startedAt + 1; first.endedAt = first.startedAt + 2;
  assert.deepEqual(browserResourceResults(f), delay === 1000 ? ["verified", "verified"] : ["blocked", "blocked"]);
});

for (const delay of [1000, 1001]) test(`exited suffix keeps the exact ${delay}ms continuity boundary`, (t) => {
  const f = lifecycleBoundaryFixture(t, { exited: true });
  const terminal = f.observation.samples[38].docker.participants[0];
  for (const sample of f.observation.samples.filter((s) => s.at >= 2800 && s.at < 3700)) {
    sample.docker.participants[0] = structuredClone(terminal);
    Object.assign(sample.docker.participants[0], { startedAt: sample.at + 1, endedAt: sample.at + 3 });
  }
  const last = f.observation.samples[27].docker.participants[0];
  last.endedAt = 3800 - delay; last.kernel.at = last.endedAt - 1;
  assert.deepEqual(browserResourceResults(f), delay === 1000 ? ["verified", "verified"] : ["blocked", "blocked"]);
});

for (const [name, change] of [
  ["omitted declared population", (f, d) => { f.native.hostSubject.participants = []; }],
  ["undeclared inventory", (f, d) => { d.inventory.push("4".repeat(64)); }],
  ["undeclared actual scope", (f, d) => { const record = structuredClone(d.participants[0]); record.container.id = "4".repeat(64);
    d.inventory.push(record.container.id); d.participants.push(record); }],
  ["unexplained identity gap", (f, d) => { d.inventory.push("4".repeat(64)); d.gaps.push("4".repeat(64)); }],
  ["snapshot absent from inventory", (f, d) => { d.inventory = []; }],
  ["inventory without its snapshot", (f, d) => { d.participants = []; }],
  ["crossed running terminal PID", (f) => { f.native.hostSubject.participants[0].terminal.state.Pid = 999; }],
  ["crossed terminal restart identity", (f) => { f.native.hostSubject.participants[0].terminal.restartCount = 1; }],
  ["contradictory terminal running state", (f) => { f.native.hostSubject.participants[0].terminal.state.Running = false; }],
]) test(`browser ${name} cannot survive actual disk-backed lifetime replay`, (t) => {
  const f = browserFixture(t); change(f, f.observation.samples[1].docker);
  const actual = browserResourceResults(f);
  assert.ok(actual.every((status) => status !== "verified"), JSON.stringify(actual));
});

test("actual participant observations cannot hide a 3.2 second internal hole behind host samples", (t) => {
  const f = browserFixture(t), [first, live, last] = f.observation.samples;
  const samples = [first];
  for (let at = 50; at <= 3850; at += 100) {
    const sample = structuredClone(live), record = sample.docker.participants[0];
    sample.at = at; record.startedAt = at; record.endedAt = at + 1; record.kernel.at = at;
    samples.push(sample);
  }
  last.at = 3900; samples.push(last); f.observation.samples = samples;
  Object.assign(f.native.hostSubject.executionWindow, { endedAt: 3890 });
  Object.assign(f.native.hostSubject.processWindows[0], { startedAt: 50, endedAt: 3850 });
  Object.assign(f.native.hostSubject.participants[0].window, { startedAt: 50, endedAt: 3850 });
  assert.deepEqual(browserResourceResults(f), ["verified", "verified"]);
  for (const sample of samples) if (sample.at > 50 && sample.at < 3250) sample.docker.participants = [];
  const actual = browserResourceResults(f);
  assert.ok(actual.every((status) => status !== "verified"), JSON.stringify(actual));
});

test("a valid exited failed participant does not need a still-running terminal PID", (t) => {
  const f = browserFixture(t), state = f.native.hostSubject.participants[0].terminal.state;
  Object.assign(state, { Status: "exited", Running: false, Pid: 0, OOMKilled: true, ExitCode: 137, FinishedAt: "2026-11-14T00:00:01Z" });
  f.native.outcomes[0].outcome = "failed";
  assert.deepEqual(browserResourceResults(f), ["verified", "verified"]);
});

test("browser OS composition requires actual external Docker scopes as well as the supervised leader/renderer", (t) => {
  const f = browserFixture(t);
  assert.equal(inspectBrowserParticipants(f.native.hostSubject, f.observation), true);
  assert.equal(composeHostProof(f.bound, f.native, f.observation).resources, "verified");
  assert.equal(f.native.qualificationPassed, false);
  f.observation.samples[1].processes[0].stat = stat(999, "node");
  assert.equal(composeHostProof(f.bound, f.native, f.observation).resources, "blocked", "another same-binary Node PID cannot stand in for the leader");
});

test("cgroup v2 root absence is not an invented inherited cap", (t) => {
  const f = browserFixture(t), record = f.observation.samples[1].docker.participants[0];
  const root = record.kernel.ancestors.at(-1);
  assert.equal(root.path, "/");
  root.files["cpu.max"] = null; root.files["memory.max"] = null;
  assert.equal(inspectBrowserParticipants(f.native.hostSubject, f.observation), true);
  root.files["cpu.max"] = "invalid\n";
  assert.throws(() => inspectBrowserParticipants(f.native.hostSubject, f.observation));
  root.files["cpu.max"] = null; root.files["memory.max"] = "invalid\n";
  assert.throws(() => inspectBrowserParticipants(f.native.hostSubject, f.observation));
  root.files["memory.max"] = null;
  root.files["cpuset.cpus.effective"] = null;
  assert.equal(inspectBrowserParticipants(f.native.hostSubject, f.observation), false);
});

test("created-before-start and stopped-after-window boundaries are not live OS claims", (t) => {
  const f = browserFixture(t), samples = f.observation.samples, p = f.native.hostSubject.participants[0];
  const before = structuredClone(samples[1].docker.participants[0]);
  Object.assign(before, { startedAt: 0, endedAt: 1, kernel: null });
  Object.assign(before.container.state, { Status: "created", Pid: 0, Running: false,
    StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" });
  samples[0].docker = { inventory: [p.id], participants: [before], gaps: [] };
  const after = structuredClone(before); after.startedAt = 99; after.endedAt = 101;
  Object.assign(after.container.state, { Status: "exited", StartedAt: p.terminal.state.StartedAt,
    FinishedAt: "2026-11-14T00:00:01Z", ExitCode: 143 });
  samples[2].docker = { inventory: [p.id], participants: [after], gaps: [] };
  assert.deepEqual(browserResourceResults(f), ["verified", "verified"]);
});

test("a never-started artifact has no running OS claim, but cannot conceal actual execution", (t) => {
  const f = browserFixture(t), p = f.native.hostSubject.participants[0];
  p.role = "artifact"; p.window = null; p.terminal.restartCount = 0;
  p.terminal.state = { ...p.terminal.state, Status: "created", Running: false, Pid: 0,
    StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" };
  assert.throws(() => inspectBrowserParticipants(f.native.hostSubject, f.observation), "actual running snapshot contradicts never-started declaration");
  const d = f.observation.samples[1].docker;
  d.participants[0].kernel = null; d.participants[0].container.state = structuredClone(p.terminal.state);
  assert.equal(inspectBrowserParticipants(f.native.hostSubject, f.observation), true);
  d.participants = []; d.inventory = [];
  assert.equal(inspectBrowserParticipants(f.native.hostSubject, f.observation), true);
  for (const [key, value] of [["StartedAt", "2026-11-14T00:00:00Z"], ["FinishedAt", "2026-11-14T00:00:01Z"],
    ["Status", "exited"], ["Pid", 300], ["Running", true], ["Paused", true], ["Restarting", true], ["OOMKilled", true]]) {
    const before = p.terminal.state[key]; p.terminal.state[key] = value;
    assert.throws(() => inspectBrowserParticipants(f.native.hostSubject, f.observation), key); p.terminal.state[key] = before;
  }
  p.terminal.restartCount = 1; assert.throws(() => inspectBrowserParticipants(f.native.hostSubject, f.observation));
  p.terminal.restartCount = 0; f.observation.context.dockerBaseline.push(p.id);
  assert.throws(() => inspectBrowserParticipants(f.native.hostSubject, f.observation), "baseline resources cannot be adopted");
});

for (const [name, change, invalid] of [
  ["Docker namespace mismatch", (f, r) => { r.kernel.cgroup = "0::/unrelated\n"; }, true],
  ["Docker PID reuse", (f, r) => { r.kernel.stat = stat(301, "native"); }, true],
  ["wrong Docker image", (f, r) => { r.container.imageId = `sha256:${"0".repeat(64)}`; }, true],
  ["wrong boot", (f, r) => { r.kernel.bootId = "foreign"; }, true],
  ["missing participant", (f) => { f.observation.samples[1].docker.participants = []; }, false],
  ["observed collection gap", (f) => { f.observation.samples[1].docker.gaps = [f.native.hostSubject.participants[0].id]; }, false],
  ["HostConfig without OS proof", (f, r) => { r.kernel = null; r.container.state.Running = false; r.container.state.Pid = 0; }, false],
  ["missing effective controls", (f, r) => { r.kernel.groups[0].files["cpu.max"] = null; }, false],
  ["different actual quota", (f, r) => { r.kernel.groups[0].files["cpu.max"] = "200000 100000\n"; }, true],
  ["different actual memory", (f, r) => { r.kernel.groups[0].files["memory.max"] = "max\n"; }, true],
  ["omitted member", (f, r) => { r.kernel.processes = []; }, true],
  ["paused participant", (f, r) => { r.container.state.Paused = true; }, true],
  ["restarted participant", (f, r) => { r.container.restartCount = 1; }, true],
  ["missing actual ancestor control", (f, r) => { r.kernel.ancestors[0].files["memory.max"] = null; }, false],
]) test(`browser ${name} cannot qualify resource proof`, (t) => {
  const f = browserFixture(t), record = f.observation.samples[1].docker.participants[0]; change(f, record);
  if (invalid) assert.throws(() => composeHostProof(f.bound, f.native, f.observation));
  else assert.equal(composeHostProof(f.bound, f.native, f.observation).resources, "blocked");
});
test("PID identity uses kernel start ticks, including names containing parentheses", () => {
  assert.deepEqual(processIdentity(stat(100, "a (b) c")), { pid: 100, startTicks: "1000", comm: "a (b) c" });
  assert.throws(() => processIdentity("100 malformed"));
});
test("actual inherited controls need no invented cap; terminal observations compose exact native windows", (t) => {
  const f = fixture(t), observed = f.observation(); assert.equal(observed.status, "verified");
  const native = { hostSubject: { executionWindow: { startedAt: 10, endedAt: 90 },
    processWindows: [{ kind: "compiler", startedAt: 20, endedAt: 70 }, { kind: "browser", startedAt: 20, endedAt: 70 }],
    toolIdentities: { node: "a".repeat(64), browser: "b".repeat(64) }, subjectSha256: "d".repeat(64), filesSha256: "e".repeat(64) } };
  assert.equal(composeHostProof(binding, native, observed).resources, "verified");
  native.hostSubject.processWindows[0].endedAt = 40;
  assert.equal(composeHostProof(binding, native, observed).resources, "blocked");
});
test("missing effective command controls cannot verify a client lifetime", (t) => {
  const f = fixture(t, ({ samples }) => {
    for (const sample of samples) for (const group of sample.groups)
      for (const key of ["cpu.max", "cpuset.cpus.effective", "memory.max"]) group.files[key] = null;
  });
  const observed = f.observation(); assert.equal(observed.status, "blocked");
  assert.equal(composeHostProof(binding, {}, observed).resources, "blocked");
});
for (const [name, controls] of [
  ["unlimited", { "cpu.max": "max 100000\n", "memory.max": "max\n", "cpuset.cpus.effective": "0-3,5,7-9\n" }],
  ["finite", { "cpu.max": "100000 100000\n", "memory.max": "1073741824\n", "cpuset.cpus.effective": "1\n" }],
]) test(`${name} effective controls remain parseable without imposing a new budget`, (t) => {
  const f = fixture(t, ({ samples }) => { for (const sample of samples) Object.assign(sample.groups[0].files, controls); });
  assert.equal(f.observation().status, "verified");
});
for (const [key, value] of [
  ["cpu.max", "max 0\n"], ["cpu.max", "0 100000\n"], ["cpu.max", "unlimited\n"],
  ["memory.max", "-1\n"], ["memory.max", "max trailing\n"],
  ["cpuset.cpus.effective", "\n"], ["cpuset.cpus.effective", "3-1\n"],
  ["cpuset.cpus.effective", "0-3,2\n"], ["cpuset.cpus.effective", "0,0\n"],
]) test(`malformed ${key} ${JSON.stringify(value)} cannot verify`, (t) => {
  const f = fixture(t, ({ samples }) => { for (const sample of samples) sample.groups[0].files[key] = value; });
  assert.throws(f.observation);
});
for (const key of ["cpu.max", "memory.max", "cpuset.cpus.effective"]) test(`missing ${key} remains blocked`, (t) => {
  const f = fixture(t, ({ samples }) => { for (const sample of samples) sample.groups[0].files[key] = null; });
  assert.equal(f.observation().status, "blocked");
});
for (const [name, change] of [
  ["other command", (f) => { f.context.command++; }],
  ["other binding", (f) => { f.context.bindingSha256 = "f".repeat(64); }],
  ["other commit", (f) => { f.context.commit = "f".repeat(40); }],
  ["other boot", (f) => { f.terminal.bootId = "other"; }],
  ["changed exit", (f) => { f.terminal.command = { ...result, code: 0 }; }],
  ["escaped process", (f) => { f.samples[1].processes[0].cgroup = "0::/other\n"; }],
  ["omitted process", (f) => { f.samples[1].processes.pop(); }],
  ["duplicate identity", (f) => { f.samples[1].processes.push(f.samples[1].processes[0]); }],
  ["backward clock", (f) => { f.samples[2].at = 1; }],
  ["false peak", (f) => { f.samples[1].groups[0].files["memory.peak"] = "1\n"; }],
  ["changed controls", (f) => { f.samples[1].groups[0].files["cpu.max"] = "100000 100000\n"; }],
]) test(`${name} cannot pass host replay`, (t) => { const f = fixture(t, change); assert.throws(f.observation); });
for (const [name, change] of [
  ["observer gap", (f) => { f.terminal.observerError = "host-observation-gap"; }],
  ["leak", (f) => { f.terminal.empty = false; f.terminal.terminal = false; }],
  ["missing accounting", (f) => { f.samples[1].groups[0].files["memory.peak"] = null; }],
  ["OOM", (f) => { f.samples[2].groups[0].files["memory.events"] = "oom_kill 1\n"; }],
  ["raw populated terminal contradicts empty flag", (f) => { f.samples[2].groups[0].files["cgroup.events"] = "populated 1\n"; }],
  ["raw terminal population missing", (f) => { f.samples[2].groups[0].files["cgroup.events"] = null; }],
  ["sampling stalled", (f) => { f.samples[2].at = 2000; }],
]) test(`${name} remains blocked, not a zero observation`, (t) => { const f = fixture(t, change); assert.equal(f.observation().status, "blocked"); });

test("a self-consistent foreign unit is not an owned campaign lifetime", (t) => {
  const foreign = parent.replace("r17-", "r18-");
  const f = fixture(t, (value) => {
    value.context.parent = foreign; value.context.path = path.replace(parent, foreign);
    for (const ancestors of [value.context.ancestors, value.terminal.ancestors]) for (const g of ancestors) g.path = g.path.replace(parent, foreign);
    for (const s of value.samples) {
      for (const g of s.groups) g.path = g.path.replace(parent, foreign);
      for (const p of s.processes) p.cgroup = p.cgroup.replace(parent, foreign);
    }
  });
  assert.throws(f.observation);
});
