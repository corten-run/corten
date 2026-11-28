// Synthetic retained OS records test replay only, never real host qualification.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { test } from "node:test";
import { deploymentSha256 } from "../deployments.mjs";
import { campaignRounds, definition, groupNames, nativeArtifactRoot, runnerFor, selectedApps } from "../registry.mjs";
import { browserCpus } from "../../fullstack-browser/contract.mjs";
import { participantSnapshot, replayExecution } from "../../fullstack-browser/native-execution.mjs";
import { composeHostProof, inspectLifetime, processIdentity, processRole, inspectBrowserParticipants, inspectLiveActors, resolveParticipantExecutables } from "./host-lifetime.mjs";
import { executableIdentity, executableReference, hashExecutableDescriptor, participantExecutables } from "./participant-executables.mjs";
import { jsonPhase, mixedPhase, productionRecipes } from "./campaign-contract.mjs";
import { clientComparisonRecipe, nativeExecution } from "./contract.mjs";
import { composePhase } from "./composition.mjs";
import { terminalClockPolicy } from "./host-observation.mjs";
import { clientActorCpus, hardeningActorCpus, hardeningCpuGate, liveActorCpus, liveApplication } from "./native-roles.mjs";
import { samplingControl } from "./test-fixtures/host-lifetime-storage.mjs";
import { budgets } from "../../hardening/plan.mjs";
import { comparisonProfile } from "../../client-heavy/contract.mjs";
import { reserveCompilerTarget, withCompilerTarget } from "../../client-heavy/compiler.mjs";

test("renderer role accepts Chromium's Linux process title without matching arbitrary embedded switches", () => {
  const exe = "/pinned chrome/chrome-headless-shell";
  let links = 0;
  const getExe = () => { links++; return exe; };
  assert.equal(processRole(`${exe}\0--type=renderer\0`, getExe), "--type=renderer");
  assert.equal(processRole(`${exe}\0--type=utility\0`, getExe), "--type=utility");
  assert.equal(links, 0);
  assert.equal(processRole(`${exe} --type=renderer --lang=en\0\0`, getExe), "--type=renderer");
  assert.equal(links, 1);
  for (const text of [
    `${exe}\0--flags=foo --type=renderer\0`,
    `${exe} --flags=foo --type=renderer\0`,
    `${exe} --type=renderer-extra\0`,
    `${exe} --type=renderer\0--lang=en\0`,
    `${exe} --type=renderer`,
    `${exe}-foreign --type=renderer\0`,
    `${exe} --type=renderer\t--lang=en\0`,
  ]) assert.equal(processRole(text, getExe), null);
  assert.equal(processRole(`${exe} --type=renderer\0`, () => `${exe} (deleted)`), null);
});

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

for (const mode of ["campaign target seals then cleans", "old cleanup order fails", "campaign rejects changed bytes with mtime restored"]) test(`real inherited executable descriptor: ${mode}`, {
  skip: process.platform !== "linux" && "requires Linux /proc executable descriptors", timeout: 15000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "isolated-inherited-executable-"));
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true }); });
  const target = join(directory, "target"), image = join(target, "image"), stamp = 1_700_000_000;
  const owned = mode !== "old cleanup order fails" ? reserveCompilerTarget(target) : null;
  if (owned) {
    const [[key, value]] = Object.entries(owned.env);
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex"), pending = participantExecutables();
  let fd, original, record;
  try {
    await withCompilerTarget(target, async () => {
      copyFileSync("/bin/cat", image); utimesSync(image, stamp, stamp);
      original = digest(readFileSync(image));
      const child = spawn(image, [], { timeout: 5000 }), closed = once(child, "close");
      try {
        await once(child, "spawn");
        record = pending.capture(child.pid); fd = openSync(`/proc/${child.pid}/exe`, "r");
        child.stdin.end(); assert.deepEqual(await closed, [0, null]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    });
    assert.equal(existsSync(image), !!owned);
    const { executableRef, executableIdentity: sampled } = record, changed = mode.startsWith("campaign rejects");
    if (changed) {
      const bytes = readFileSync(image); bytes[bytes.length - 1] ^= 1;
      writeFileSync(image, bytes); utimesSync(image, stamp, stamp);
    }
    const actual = executableIdentity(fd);
    assert.equal(digest(readFileSync(fd)) === original, !changed);
    if (owned && !changed) {
      const proof = pending.finish();
      assert.deepEqual(proof.executables, [{ ref: executableRef, identity: sampled, sha256: original }]);
      assert.equal(resolveParticipantExecutables(record, proof).executableSha256, original);
    }
    else {
      assert.notEqual(actual.ctimeNs, sampled.ctimeNs);
      assert.deepEqual({ ...actual, ctimeNs: sampled.ctimeNs }, sampled);
      assert.throws(() => pending.finish(), { operation: "executable-hash-before", code: "identity-ctime", executableRef });
    }
  } finally {
    pending.close(); if (fd !== undefined) closeSync(fd);
    await owned?.close(true);
  }
  assert.equal(existsSync(target), false);
});

test("standalone compiler target is removed when the build throws", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "standalone-compiler-target-")), target = join(directory, "target");
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true }); });
  await assert.rejects(withCompilerTarget(target, () => {
    writeFileSync(join(target, "scratch"), "generated");
    throw new Error("test build failed");
  }), { message: "test build failed" });
  assert.equal(existsSync(target), false);
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
function fixture(t, change = () => {}, bound = binding, invoke = invocation, runResult = result, phase, id = campaign) {
  const directory = mkdtempSync(join(tmpdir(), "isolated-host-replay-"));
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true }); });
  const parent = `/system.slice/corten-bench-groups-${id}.service`, path = `${parent}/native-${command}-0123456789abcdef`;
  const ancestors = []; for (let p = parent; ; p = posix.dirname(p)) { ancestors.push(group(p)); if (p === "/") break; }
  const context = { schema: "benchmark-isolated-host-lifetime/v1", campaign: id, command, leaderPid: pid, parent, path,
    ...bound.request, bindingSha256: deploymentSha256(bound), invocation: invoke, bootId: "boot", ancestors };
  const processes = [[100, "node", "a", null], [101, "rustc", "c", null], [102, "chrome", "b", "--type=renderer"]]
    .map(([pid, name, hash, type]) => ({ stat: stat(pid, name), cgroup: `0::${path}\n`, executableSha256: hash.repeat(64), type }));
  const samples = [{ at: 0, groups: [group(path)], processes: [] }, { at: 50, groups: [group(path, [100, 101, 102])], processes },
    { at: 100, groups: [group(path)], processes: [] }];
  const terminal = { terminal: true, attached: true, empty: true, samples: 3, observerError: null, command: runResult, bootId: "boot", ancestors };
  change({ context, samples, terminal });
  writeFileSync(join(directory, "binding.json"), JSON.stringify(context));
  writeFileSync(join(directory, "samples.jsonl"), samples.map((s) => JSON.stringify(s) + "\n").join(""));
  writeFileSync(join(directory, "terminal.json"), JSON.stringify(terminal));
  return { directory, observation: () => inspectLifetime(bound, invoke, directory, { campaign: id, command, pid, result: runResult, phase }) };
}

function browserFixture(t, selectedApp = "app", isolated = false, workload = "fullstack-browser") {
  const bound = { ...binding, request: { ...binding.request, group: workload }, selection: { apps: [selectedApp] } };
  if (isolated) Object.assign(bound, {
    resources: workload === "fullstack-browser" ? { browserCpus }
      : { actorCpus: { application: "1", browser: "4-7" }, app: { cpu: 1, memoryBytes: 2 ** 30 } },
    execution: { effectiveOptions: { isolated: true } },
  });
  const id = "f".repeat(64), imageId = `sha256:${"e".repeat(64)}`, dockerPath = `/system.slice/docker-${id}.scope`;
  const state = { Status: "running", Pid: 300, Running: true, Paused: false, Restarting: false, OOMKilled: false,
    Dead: false, ExitCode: 0, StartedAt: new Date(10).toISOString(), FinishedAt: "0001-01-01T00:00:00Z" };
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
  const participants = [participant], records = [record];
  if (isolated) {
    participant.terminal.limits.CpusetCpus = "1"; g.files["cpuset.cpus.effective"] = "1\n";
  }
  if (isolated && workload === "fullstack-browser") {
    const upstream = "8".repeat(64), upstreamPath = `/system.slice/docker-${upstream}.scope`, upstreamGroup = group(upstreamPath, [301]);
    Object.assign(upstreamGroup.files, { "cpu.max": "100000 100000\n", "memory.max": `${256 * 2 ** 20}\n`, "cpuset.cpus.effective": "2-3\n" });
    const upstreamState = { ...state, Pid: 301 };
    participants.push({ id: upstream, role: "upstream", app: null, case: null, imageId, window: { startedAt: 15, endedAt: 80 },
      terminal: { ...participant.terminal, id: upstream, state: upstreamState, limits: { NanoCpus: 1e9, Memory: 256 * 2 ** 20, CpusetCpus: "2-3" } } });
    const upstreamStat = stat(301, "upstream"), cgroup = `0::${upstreamPath}\n`;
    records.push({ ...record, container: { id: upstream, imageId, state: upstreamState, restartCount: 0 },
      kernel: { ...record.kernel, stat: upstreamStat, cgroup, groups: [upstreamGroup],
        processes: [{ stat: upstreamStat, cgroup, executableSha256: "5".repeat(64), type: null }] } });
  }
  const f = fixture(t, ({ context, samples }) => {
    context.dockerBaseline = [];
    context.leaderIdentity = processIdentity(stat(100, "node"));
    for (const s of samples) {
      s.docker = { inventory: [], participants: [], gaps: [] };
      if (isolated) s.groups[0].files["cpuset.cpus.effective"] = "4-7\n";
    }
    samples[1].docker = { inventory: participants.map((p) => p.id), participants: records, gaps: [] };
  }, bound);
  const native = { cleanupComplete: true, qualificationPassed: false, outcomes: [{ app: "app", outcome: "unsupported" }],
    hostSubject: { schema: "native-browser-host-subject/v2", executionWindow: { startedAt: 10, endedAt: 90 },
      processWindows: [{ kind: "browser", app: "app", case: "case", startedAt: 20, endedAt: 70 }],
      toolIdentities: { node: "a".repeat(64), browser: "b".repeat(64), lockSha256: "9".repeat(64) },
      participants, subjectSha256: "d".repeat(64), filesSha256: "e".repeat(64) } };
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

test("saved browser CPU proof requires the driver/Chromium scope and both timed Docker actors", (t) => {
  const f = browserFixture(t, "app", true);
  const proof = composeHostProof(f.bound, f.native, replayBrowser(f));
  assert.equal(proof.resources, "verified"); assert.equal(proof.policy, "observed-browser-cpu-partition");
  const timed = f.observation.samples[1], control = "cpuset.cpus.effective";
  for (const sample of f.observation.samples) sample.groups[0].files[control] = "0-7\n";
  assert.deepEqual(browserResourceResults(f), ["blocked", "blocked"]);
  for (const sample of f.observation.samples) sample.groups[0].files[control] = "4-7\n";
  const upstream = timed.docker.participants[1];
  upstream.kernel.groups[0].files[control] = "0-3\n";
  assert.deepEqual(browserResourceResults(f), ["invalid", "invalid"]);
  upstream.kernel.groups[0].files[control] = null;
  assert.deepEqual(browserResourceResults(f), ["blocked", "blocked"]);
  timed.docker.participants.pop(); timed.docker.inventory.pop(); f.native.hostSubject.participants.pop();
  assert.deepEqual(browserResourceResults(f), ["blocked", "blocked"], "the upstream cannot disappear from both inventories");
});

test("saved client-heavy role requires the compiler and renderer under the pinned command", (t) => {
  const bound = { ...binding, resources: { ...binding.resources, actorCpus: { client: "4-7" } } };
  const childPath = `${path}/worker`;
  const f = fixture(t, ({ context, samples }) => {
    context.leaderIdentity = processIdentity(stat(100, "node"));
    for (const sample of samples) sample.groups[0].files["cpuset.cpus.effective"] = "4-7\n";
    const timed = samples[1], child = group(childPath, [101, 102]);
    timed.groups[0].files["cgroup.procs"] = "100\n";
    child.files["cpuset.cpus.effective"] = "5-6\n";
    timed.groups.push(child);
    for (const process of timed.processes.slice(1)) process.cgroup = `0::${childPath}\n`;
  }, bound);
  const native = { hostSubject: { executionWindow: { startedAt: 10, endedAt: 80 },
    processWindows: ["compiler", "browser"].map((kind) => ({ kind, startedAt: 20, endedAt: 70 })),
    subjectSha256: "d".repeat(64), filesSha256: "e".repeat(64),
    toolIdentities: { node: "a".repeat(64), browser: "b".repeat(64) } } };
  assert.equal(composeHostProof(bound, native, f.observation()).policy, "observed-client-cpu-partition");
  const file = join(f.directory, "samples.jsonl"), rows = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  for (const cpus of ["0,5-6\n", null]) {
    rows[1].groups[1].files["cpuset.cpus.effective"] = cpus;
    writeFileSync(file, rows.map((s) => JSON.stringify(s) + "\n").join(""));
    const observed = f.observation();
    assert.equal(observed.checks.accounting, false);
    assert.equal(composeHostProof(bound, native, observed).resources, "blocked");
  }
});

for (const workload of ["live-delivery", "recoverable-live"]) test(`saved ${workload} actor proof requires the actual app and renderer in the same window`, (t) => {
  const f = browserFixture(t, "app", true, workload);
  const [app] = f.native.hostSubject.participants, { node, browser } = f.native.hostSubject.toolIdentities;
  const window = (startedAt, endedAt, renderer = { startedAt, endedAt }) => ({ app: app.app, startedAt, endedAt, renderer });
  const windows = [window(30, 60)];
  const proof = (participants = [app], window = windows) => inspectLiveActors(f.bound, replayBrowser(f), { node, browser }, participants, window);
  assert.equal(proof(), true);
  assert.equal(proof([]), false);
  assert.equal(proof([app], [window(30, 40)]), false);
  assert.equal(proof([app], [window(50, 50), window(50, 50)]), false);
  assert.equal(proof([app], [window(30, 50), window(50, 60)]), false);
  assert.equal(proof([app], [window(30, 45, null), window(45, 60)]), false,
    "a failed scenario without a service observation cannot borrow a later success");
  assert.equal(proof([app], [window(30, 45), window(45, 60)]), false,
    "a failed scenario with a renderer cannot borrow a later success");
  const timed = f.observation.samples[1], { kernel } = timed.docker.participants[0];
  const child = group(`${kernel.groups[0].path}/worker`, [302]);
  child.files["cpuset.cpus.effective"] = "1\n";
  kernel.groups.push(child);
  kernel.processes.push({ stat: stat(302, "worker"), cgroup: `0::${child.path}\n`, executableSha256: "4".repeat(64), type: null });
  assert.equal(proof(), true);
  child.files["cpuset.cpus.effective"] = "0-1\n";
  assert.equal(proof(), false);
  child.files["cpuset.cpus.effective"] = "1\n";
  timed.processes.find((p) => p.type === "--type=renderer").executableSha256 = "0".repeat(64);
  assert.equal(proof(), false);
  assert.equal(proof([app], [window(30, 60, null)]), true, "a startup failure with no renderer still has actual service placement");
});

for (const [role, id, allowed, escaped] of [
  ["browser", 102, "4,6-7", "0,4,6-7"],
  ["upstream", 302, "3", "0,3"],
  ["application", 303, "1", "1-2"],
]) test(`saved browser CPU proof bounds the ${role} child's own effective CPU set`, (t) => {
  const f = browserFixture(t, "app", true), timed = f.observation.samples[1], control = "cpuset.cpus.effective";
  const participant = f.native.hostSubject.participants.find((p) => p.role === role);
  const scope = role === "browser" ? timed : timed.docker.participants.find((r) => r.container.id === participant.id).kernel;
  const root = scope.groups[0], child = group(`${root.path}/workers`, [id]);
  child.files[control] = `${allowed}\n`;
  scope.groups.push(child);
  const cgroup = `0::${child.path}\n`;
  if (role === "browser") {
    root.files["cgroup.procs"] = "100\n101\n";
    scope.processes.find((p) => processIdentity(p.stat).pid === id).cgroup = cgroup;
  } else {
    scope.processes.push({ stat: stat(id, "worker"), cgroup, executableSha256: "4".repeat(64), type: null });
  }
  assert.deepEqual(browserResourceResults(f), ["verified", "verified"]);
  child.files[control] = `${escaped}\n`;
  assert.deepEqual(browserResourceResults(f), ["blocked", "blocked"]);
  if (role === "browser") assert.equal(replayBrowser(f).checks.accounting, false);
});

function lifecycleBoundaryFixture(t, { created = false, exited = false, rootAbsent = true, workload = "fullstack-browser",
  finishedAt = new Date(3650).toISOString() } = {}) {
  const live = workload === "live-delivery";
  const f = browserFixture(t, "corten", live, workload), template = f.observation.samples[1], p = f.native.hostSubject.participants[0];
  f.observation.samples = Array.from({ length: 41 }, (_, i) => {
    const at = i * 100, sample = structuredClone(template); sample.at = at;
    if (i === 0 || i === 40) {
      sample.groups = [group(path)]; sample.processes = [];
      if (live) sample.groups[0].files["cpuset.cpus.effective"] = "4-7\n";
    }
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
    FinishedAt: finishedAt } : running;
  const task = "browser-abcdef", caseKey = definition("fullstack-browser").cases[0].key;
  const image = { Id: p.imageId, Config: { Entrypoint: ["node"], Cmd: ["server.mjs"] } };
  const info = { Id: p.id, Name: "/native-case", Image: p.imageId,
    Config: { ...image.Config, Env: ["MARKETPLACE_SOURCE=fixture"], Labels: { "agent.owner": "codex", "agent.task": task } },
    RestartCount: 0, State: neverStarted, HostConfig: { NanoCpus: 1e9, CpuQuota: 0, CpuPeriod: 0, CpusetCpus: live ? "1" : "",
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
    commit: f.bound.request.commit, startedAt: 100, endedAt: 3900, events }) }, null, { isolated: live });
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

function setStoppedRows(f, status, finishedAt, from = 3700) {
  const [{ terminal }] = f.native.hostSubject.participants;
  terminal.state.FinishedAt = finishedAt;
  for (const sample of f.observation.samples.filter((s) => s.at >= from)) {
    for (const r of sample.docker.participants) {
      r.kernel = null;
      r.container.state = { ...terminal.state, Status: status };
    }
  }
}

for (const workload of ["fullstack-browser", "live-delivery"]) {
  const proof = (f) => {
    const observation = replayBrowser(f), { participants, toolIdentities: { node, browser } } = f.native.hostSubject;
    return workload === "fullstack-browser" ? inspectBrowserParticipants(f.native.hostSubject, observation)
      : inspectLiveActors(f.bound, observation, { node, browser }, participants,
        [{ app: "corten", startedAt: 900, endedAt: 1100, renderer: null }]);
  };
  for (const [label, finishedAt] of [
    ["predates the last running capture", new Date(3650).toISOString()],
    ["has an impossible date", "2026-02-29T00:00:00Z"],
  ]) test(`r95 replay: ${workload} refuses an exited receipt that ${label} without a stopped sample`, (t) => {
    const f = lifecycleBoundaryFixture(t, { workload });
    const [{ terminal }] = f.native.hostSubject.participants;
    f.observation.samples = f.observation.samples.filter((s) => s.at !== 3800);
    Object.assign(terminal.state, { Status: "exited", Running: false, Pid: 0, ExitCode: 137,
      FinishedAt: new Date(3750).toISOString() });
    assert.equal(proof(f), true);
    terminal.state.FinishedAt = finishedAt;
    assert.throws(() => proof(f), { code: "ERR_ASSERTION",
      message: workload === "fullstack-browser" ? "invalid Browser Docker terminal receipt" : "invalid Live Docker terminal receipt" });
  });
  for (const [field, different] of [
    ["FinishedAt", new Date(3815).toISOString()],
    ["ExitCode", 1],
    ["OOMKilled", true],
  ]) test(`r95 replay: ${workload} binds stopped ${field} after a running receipt`, (t) => {
    const f = lifecycleBoundaryFixture(t, { workload });
    let removing;
    for (const [sampleAt, at, status] of [[3700, 3820, "exited"], [3800, 3860, "removing"]]) {
      const sample = f.observation.samples.find((s) => s.at === sampleAt);
      const [r] = sample.docker.participants;
      sample.at = at;
      Object.assign(r, { startedAt: at, endedAt: at + 3, kernel: null });
      Object.assign(r.container.state, { Status: status, Running: false, Pid: 0,
        ExitCode: 137, FinishedAt: new Date(3810).toISOString() });
      if (status === "removing") removing = r.container.state;
    }
    assert.equal(proof(f), true, "exited then removing with the same outcome is valid");
    removing[field] = different;
    assert.throws(() => proof(f), { code: "ERR_ASSERTION", message: "stopped Docker observations disagree" });
  });
  for (const [label, finishedAt, valid] of [
    ["finish during the receipt's last millisecond", new Date(3800).toISOString().replace("Z", "999999Z"), true],
    ["finish 35 ms after the receipt boundary", new Date(3835).toISOString(), workload === "live-delivery"],
  ]) test(`r95 replay: ${workload} ${label}`, (t) => {
    const f = lifecycleBoundaryFixture(t, { exited: true, workload, finishedAt });
    const later = f.observation.samples.find((s) => s.at === 3800);
    f.observation.samples = f.observation.samples.filter((s) => s.at !== 3700);
    later.at = 3820;
    const [r] = later.docker.participants;
    Object.assign(r, { startedAt: 3820, endedAt: 3840 });
    r.container.state.Status = "removing";
    if (valid) assert.equal(proof(f), true);
    else assert.throws(() => proof(f), { code: "ERR_ASSERTION", message: "invalid Browser Docker terminal receipt" });
  });
  for (const status of ["exited", "removing"]) test(`r95 replay: ${workload} validates the finish on every ${status} row`, (t) => {
    const f = lifecycleBoundaryFixture(t, { exited: true, workload });
    setStoppedRows(f, status, new Date(3650).toISOString());
    assert.equal(proof(f), true, "both stopped rows may report the same earlier finish");
    for (const [label, finish] of [
      ["zero time", "0001-01-01T00:00:00Z"],
      ["before the last running observation", new Date(3500).toISOString()],
      ["after the first stopped observation", new Date(3750).toISOString()],
    ]) {
      setStoppedRows(f, status, finish);
      assert.throws(() => proof(f), { code: "ERR_ASSERTION", message: "invalid stopped Docker observation" }, label);
    }
  });
  test(`r95 replay: ${workload} refuses kernel:false as live coverage`, (t) => {
    const f = lifecycleBoundaryFixture(t, { exited: true, workload });
    assert.equal(proof(f), true);
    f.native.hostSubject.participants[0].window.endedAt = 3803;
    f.observation.samples = f.observation.samples.filter((s) => s.at !== 2700);
    setStoppedRows(f, "exited", new Date(2650).toISOString(), 2800);
    assert.equal(proof(f), false, "the last real running record ended 1.2 s before the window ended");
    f.observation.samples.find((s) => s.at === 3800).docker.participants[0].kernel = false;
    assert.throws(() => proof(f), { code: "ERR_ASSERTION", message: "invalid Docker kernel observation" });
  });
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
  setStoppedRows(f, "exited", new Date(2800).toISOString(), 2800);
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
  Object.assign(state, { Status: "exited", Running: false, Pid: 0, OOMKilled: true, ExitCode: 137, FinishedAt: new Date(60).toISOString() });
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
    FinishedAt: new Date(98).toISOString(), ExitCode: 143 });
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
const terminalClock = { bootId: "boot", uptime: "106.00 1280.00\n", ticksPerSecond: 100, monoNs: "4000000" };
const withClock = ({ terminal }) => { terminal.terminalClock = terminalClock; };

const clockCampaignRound = "r21", clockCampaignId = `${clockCampaignRound}-0000000000000001`;
test("Browser observer leaves time for storage after a slow capture and cancels the next capture on finish", {
  timeout: 5000,
}, async (t) => {
  const group = "fullstack-browser", round = campaignRounds(clockCampaignRound)[group], recipe = productionRecipes[group];
  const execution = nativeExecution(group, round, recipe, "a".repeat(64));
  const binding = { request: { group, round, commit: "a".repeat(40), recipe }, resources: { browserCpus },
    selection: { apps: selectedApps(group) }, validation: { artifactRoot: nativeArtifactRoot(group, round) }, execution };
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let time = 0, inventoryMs = 0;
  const scheduled = new Map();
  t.mock.method(performance, "now", () => time);
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms > 100) return set(callback, ms, ...args);
    const handle = {};
    scheduled.set(handle, { callback, ms });
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    if (!scheduled.delete(handle)) clear(handle);
  });
  const f = await samplingControl(t, undefined, { binding, invocation: execution.invocation, phase: "timing",
    onInventory() { time += inventoryMs; } });
  function tick(expected, work) {
    assert.equal(scheduled.size, 1);
    const [handle, { callback, ms }] = scheduled.entries().next().value;
    assert.equal(ms, expected); scheduled.delete(handle); time += ms; inventoryMs = work;
    callback();
  }
  const written = new Promise((resolve) => {
    f.afterOperation = (name, path) => { if (name === "write" && path.endsWith("samples.jsonl")) resolve(); };
  });
  tick(100, 149);
  await written;
  f.afterOperation = undefined;
  assert.equal(f.samples().length, 3, "the write completed before the next capture, without a drain");
  tick(50, 10);
  tick(90, 0);
  assert.equal(scheduled.size, 1);
  assert.equal((await f.finish(f.result, true, true)).status, "verified");
  assert.equal(f.samples().length, 6);
  assert.equal(scheduled.size, 0);
});

const clockPhases = [...groupNames.map((group) => [group, "timing"]), ["json-api", "prepare"]];
for (const [group, phase] of clockPhases) test(`terminal clock writer: ${group}/${phase} emits the clock its lifetime reader verifies`, async (t) => {
  const round = campaignRounds(clockCampaignRound)[group], commit = "a".repeat(40);
  const recipe = group === "client-heavy" ? clientComparisonRecipe : productionRecipes[group];
  const resources = group === "fullstack-browser" ? { browserCpus }
    : group === "client-heavy" ? { actorCpus: clientActorCpus }
      : ["live-delivery", "recoverable-live"].includes(group) ? { actorCpus: liveActorCpus, app: liveApplication }
        : group === "hardening" ? { actorCpus: hardeningActorCpus, budget: budgets().resources } : {};
  const base = { request: { group, round, commit, recipe }, resources, selection: { apps: selectedApps(group) },
    validation: { artifactRoot: nativeArtifactRoot(group, round) },
    sources: { files: [{ path: hardeningCpuGate }] }, execution: nativeExecution(group, round, recipe, "a".repeat(64)) };
  const plan = { round: clockCampaignRound, bindings: [base] };
  const bound = group === "json-api" ? jsonPhase(plan, phase, `/bench/campaign/${clockCampaignId}/json-native-audits.json`)
    : group === "mixed-production" ? mixedPhase(plan, clockCampaignId) : base;
  const invocation = bound.execution.invocation;
  const f = await samplingControl(t, undefined, { binding: bound, invocation, phase });
  const retain = terminalClockPolicy(bound, invocation, clockCampaignRound, phase) !== null;
  const result = phase === "prepare" ? { ...f.result, success: false, code: 1 }
    : group === "client-heavy" ? { ...f.result, success: false, code: 2 } : f.result;
  const observed = await f.finish(result, true, retain);
  assert.equal(observed.status, "verified");
  const raw = JSON.parse(readFileSync(join(f.directory, "terminal.json"), "utf8"));
  assert.ok(raw.terminalClock, "the real lifetime writer omitted the requested terminal clock");
  const { monoNs, ...clock } = raw.terminalClock;
  assert.deepEqual(clock, { bootId: "boot", uptime: "106.00 1280.00\n", ticksPerSecond: 100 });
  assert.match(monoNs, /^[1-9]\d*$/);
  assert.deepEqual(observed.terminalClock, raw.terminalClock);
  assert.deepEqual(raw.command, result);
});

test("terminal clock: r75-shaped client-heavy lifetime replays exit 2 pending parent qualification", (t) => {
  const group = "client-heavy", round = "w75", id = "r75-0123456789abcdef", apps = selectedApps(group);
  const execute = { executable: "node", argv: [runnerFor(group).entry, round, "--out", nativeArtifactRoot(group, round),
    "--profile", comparisonProfile], cwd: "repository-root", shell: false };
  const bound = { request: { group, round, commit: "8d5160be2abe9c76cde0f25266b356a477ae0e61", recipe: comparisonProfile },
    execution: { invocation: execute }, resources: { actorCpus: { client: "4-7" } },
    preparation: { fixtures: [] }, selection: { apps } };
  const observed = fixture(t, (f) => {
    withClock(f);
    for (const sample of f.samples) sample.groups[0].files["cpuset.cpus.effective"] = "4-7\n";
  }, bound, execute, result, "timing", id).observation();
  assert.equal(observed.cleanupComplete, true);
  assert.deepEqual(observed.terminalClock, terminalClock);
  // A synthetic missing-proof control, not a statement about r75's native captures.
  const native = { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
    outcomes: apps.map((app) => ({ app, outcome: "not-run" })) };
  const composed = composePhase(bound, native, observed, [result]);
  assert.equal(composed.outcome, "failed");
  assert.equal(composed.report.qualification, "blocked");
  assert.ok(composed.appOutcomes.every((row) => !row.comparisonEligible));
});

const timingBinding = (group) => {
  const round = campaignRounds("r17")[group], { entry, selection } = runnerFor(group);
  const bound = { ...binding, request: { ...binding.request, group, round },
    execution: { invocation: { executable: "node", argv: [entry, round, ...selection], cwd: "repository-root", shell: false } } };
  return group === "json-api" ? jsonPhase({ round: "r17", bindings: [bound] }, "timing", `/bench/campaign/${campaign}/json-native-audits.json`) : bound;
};
for (const group of groupNames) test(`terminal clock: ${group} timing replays its exact invocation, with or without a clock`, (t) => {
  const bound = timingBinding(group), execute = bound.execution.invocation;
  const clean = fixture(t, withClock, bound, structuredClone(execute), result, "timing").observation();
  assert.equal(clean.status, "verified");
  assert.deepEqual(clean.terminalClock, terminalClock);
  assert.equal(clean.context.round, bound.request.round);
  const legacy = fixture(t, () => {}, bound, execute, result, "timing").observation();
  assert.equal(legacy.status, "verified");
  assert.equal(legacy.terminalClock, undefined);
});

test("terminal clock: only the exact JSON preparation invocation can carry its clock", (t) => {
  const timing = timingBinding("json-api");
  const prepare = jsonPhase({ round: "r17", bindings: [timing] }, "prepare");
  const execute = prepare.execution.invocation, prepareExit = { ...result, code: 1 };
  const inspect = (bound, invoke, change = withClock) => fixture(t, change, bound, invoke, prepareExit, "prepare").observation();

  const clean = inspect(prepare, execute);
  assert.equal(clean.status, "verified");
  assert.deepEqual(clean.terminalClock, terminalClock);
  assert.equal(inspect(prepare, execute, ({ terminal }) => {
    withClock({ terminal }); terminal.empty = false;
  }).terminalClock, undefined);
  assert.equal(inspect(prepare, execute, () => {}).status, "verified", "old preparations never needed a clock");
  const refused = /terminal clock not allowed for this invocation/;
  assert.throws(() => inspect(timing, timing.execution.invocation), refused);
  for (const generator of ["catalog", "marketplace"])
    assert.throws(() => inspect(prepare, { executable: "node", argv: [`bench/${generator}/fixtures.mjs`] }), refused);
  assert.throws(() => inspect(prepare, { ...execute, argv: [...execute.argv, "--check-only"] }), refused);
  assert.throws(() => inspect({ ...prepare, execution: timing.execution }, execute), refused);
  assert.throws(() => inspect(timing, { ...execute, argv: execute.argv.map((arg) => arg === "j34" ? "j35" : arg) }), refused);
  assert.throws(() => inspect(prepare, execute, ({ terminal }) => { terminal.terminalClock = { ...terminalClock, bootId: "other" }; }));
  const relabeled = { ...timing, request: { ...timing.request, round: "j34" } };
  assert.throws(() => inspect(relabeled, timing.execution.invocation), refused);
});

test("terminal clock: timing refuses fixtures, changed bindings, foreign rounds and phases", (t) => {
  const bound = timingBinding("localized-marketplace"), execute = bound.execution.invocation;
  const inspect = (b, invoke, phase = "timing", change = withClock) => fixture(t, change, b, invoke, result, phase).observation();
  const refused = /terminal clock not allowed for this invocation/;
  const helper = { executable: "node", argv: ["bench/marketplace/fixtures.mjs"] };
  assert.throws(() => inspect(bound, helper), refused);
  assert.throws(() => inspect({ ...bound, execution: { invocation: helper } }, helper), refused);
  assert.throws(() => inspect(bound, { ...execute, argv: [...execute.argv, "--check-only"] }), refused);
  assert.throws(() => inspect(bound, execute, "prepare"), refused);
  assert.throws(() => inspect(bound, execute, "other"), refused);
  assert.throws(() => inspect(bound, execute, null), refused);
  const otherRound = { ...execute, argv: [execute.argv[0], "r18", ...execute.argv.slice(2)] };
  assert.throws(() => inspect({ ...bound, request: { ...bound.request, round: "r18" }, execution: { invocation: otherRound } }, otherRound), refused);
  assert.throws(() => inspect({ ...bound, request: { ...bound.request, group: "foreign" } }, execute), refused);
  assert.throws(() => inspect(bound, execute, "timing", (f) => {
    withClock(f); f.context.bindingSha256 = "0".repeat(64);
  }));
  assert.throws(() => inspect(bound, execute, "timing", ({ terminal }) => {
    terminal.terminalClock = { ...terminalClock, bootId: "foreign" };
  }));
  const prep = jsonPhase({ round: "r17", bindings: [timingBinding("json-api")] }, "prepare");
  assert.throws(() => inspect(prep, prep.execution.invocation), refused);
  const json = timingBinding("json-api"), checkOnly = { executable: "node",
    argv: prep.execution.invocation.argv.map((arg) => arg === prep.request.round ? json.request.round : arg) };
  assert.throws(() => inspect({ ...json, execution: { invocation: checkOnly } }, checkOnly), refused);
});

test("terminal clock: accounting, cleanup, observer and unforced proof still gate exposure", (t) => {
  const bound = timingBinding("localized-marketplace"), execute = bound.execution.invocation;
  for (const [check, resultChange, mutate] of [
    ["accounting", {}, ({ samples }) => { samples[1].at = 2000; samples[2].at = 2001; }],
    ["empty", {}, ({ terminal }) => { terminal.empty = false; }],
    ["observer", {}, ({ terminal }) => { terminal.observerError = "host-observation-gap"; }],
    ["unforced", { cancelled: true }, () => {}],
    ["unforced", { forced: true }, () => {}],
  ]) {
    const observed = fixture(t, (f) => { withClock(f); mutate(f); }, bound, execute,
      { ...result, ...resultChange }, "timing").observation();
    assert.equal(observed.status, "blocked", check);
    assert.equal(observed.checks[check], false);
    assert.equal(observed.cleanupComplete, false);
    assert.equal(observed.terminalClock, undefined);
  }
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
  ["diagnosed observer failure despite a cleared error flag", (f) => { f.terminal.observerFailures = { count: 1, first: {}, last: {} }; }],
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
