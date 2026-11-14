// Synthetic retained OS records test replay only, never real host qualification.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { test } from "node:test";
import { deploymentSha256 } from "../deployments.mjs";
import { composeHostProof, inspectLifetime, processIdentity, inspectBrowserParticipants } from "./host-lifetime.mjs";

const campaign = "r17-0123456789abcdef", command = 0, pid = 100;
const binding = { request: { group: "client-heavy", round: "w17", commit: "a".repeat(40) }, resources: { app: null } };
const invocation = { executable: "node", argv: ["bench/client-heavy/run.mjs", "w17"] };
const result = { terminal: true, code: 2, signal: null, cancelled: false, forced: false, error: null, success: false };
const parent = `/system.slice/corten-bench-groups-${campaign}.service`, path = `${parent}/native-0-0123456789abcdef`;
const stat = (pid, name) => `${pid} (${name}) S ${[1, ...Array(17).fill(0), pid * 10, 0].join(" ")}`;
const group = (path, ids = []) => ({ path, files: { "cgroup.procs": ids.map((id) => `${id}\n`).join(""),
  "cgroup.events": `populated ${ids.length ? 1 : 0}\n`, "cpu.stat": "usage_usec 10\n", "cpu.max": "max 100000\n",
  "cpuset.cpus.effective": "0-7\n", "memory.current": "10\n", "memory.peak": "20\n", "memory.max": "max\n", "memory.events": "oom 0\noom_kill 0\n" } });
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

function browserFixture(t) {
  const bound = { ...binding, request: { ...binding.request, group: "fullstack-browser" }, selection: { apps: ["app"] } };
  const id = "f".repeat(64), imageId = `sha256:${"e".repeat(64)}`, dockerPath = `/system.slice/docker-${id}.scope`;
  const state = { Status: "running", Pid: 300, Running: true, Paused: false, Restarting: false, OOMKilled: false,
    Dead: false, ExitCode: 0, StartedAt: "2026-11-14T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" };
  const participant = { id, role: "application", app: "app", case: "case", imageId, window: { startedAt: 20, endedAt: 70 },
    terminal: { id, imageId, state, limits: { NanoCpus: 1e9, Memory: 2 ** 30, CpusetCpus: "" } } };
  const g = group(dockerPath, [300]); g.files["cpu.max"] = "100000 100000\n"; g.files["memory.max"] = `${2 ** 30}\n`;
  const record = { startedAt: 49, endedAt: 51, container: { id, imageId, state, restartCount: 0 }, kernel: {
    bootId: "boot", stat: stat(300, "native"), cgroup: `0::${dockerPath}\n`, at: 50,
    ancestors: [group("/system.slice"), group("/")], groups: [g], processes: [
      { stat: stat(300, "native"), cgroup: `0::${dockerPath}\n`, executableSha256: "c".repeat(64), type: null }],
  } };
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
  return { bound, native, observation: f.observation() };
}

test("browser OS composition requires actual external Docker scopes as well as the supervised leader/renderer", (t) => {
  const f = browserFixture(t);
  assert.equal(inspectBrowserParticipants(f.native.hostSubject, f.observation), true);
  assert.equal(composeHostProof(f.bound, f.native, f.observation).resources, "verified");
  assert.equal(f.native.qualificationPassed, false);
  f.observation.samples[1].processes[0].stat = stat(999, "node");
  assert.equal(composeHostProof(f.bound, f.native, f.observation).resources, "blocked", "another same-binary Node PID cannot stand in for the leader");
});

test("a never-started artifact has no running OS claim, but cannot conceal actual execution", (t) => {
  const f = browserFixture(t), p = f.native.hostSubject.participants[0];
  p.role = "artifact"; p.window = null; p.terminal.restartCount = 0;
  p.terminal.state = { ...p.terminal.state, Status: "created", Running: false, Pid: 0,
    StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" };
  assert.throws(() => inspectBrowserParticipants(f.native.hostSubject, f.observation), "actual running snapshot contradicts never-started declaration");
  f.observation.samples[1].docker.participants = [];
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
