import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, linkSync, mkdtempDisposableSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { browserCpus } from "../../fullstack-browser/contract.mjs";
import { EvidenceStore, openEvidence } from "../../fullstack-browser/native-evidence.mjs";
import { ExecutionLedger, replayExecution } from "../../fullstack-browser/native-execution.mjs";
import { groupQualificationPassed, OwnedDocker, run } from "../../fullstack-browser/run.mjs";
import { nativeAttemptCells, replayPrerequisite } from "../../fullstack-browser/verify.mjs";
import { removeOwnedLiveContainer } from "../../live/parity.mjs";
import { definition } from "../registry.mjs";
import { browserDockerGateChildFd, browserDockerGateEnv, browserDockerGateIdentity, composeHostProof, inspectBrowserParticipants,
  lockBrowserDocker, reopenBrowserDockerGate } from "./host-lifetime.mjs";
import { supervise } from "./process.mjs";
import { fixture, stat } from "./test-fixtures/host-lifetime-observer.mjs";

const linux = { skip: process.platform !== "linux" };

async function externalRemoval(t, gate, group = true) {
  let faults = 0;
  const f = await fixture(t, [], group, () => { faults++; }, 0, false, null, gate);
  const id = "a".repeat(64), other = "b".repeat(64), image = "sha256:" + "c".repeat(64);
  const pid = 5000, scope = `/system.slice/docker-${id}.scope`, zero = "0001-01-01T00:00:00Z";
  const state = { Status: "created", Pid: 0, Running: false, Paused: false, Restarting: false,
    Dead: false, OOMKilled: false, ExitCode: 0, StartedAt: zero, FinishedAt: zero };
  const running = { ...state, Status: "running", Pid: pid, Running: true, StartedAt: new Date(f.clock).toISOString() };
  const row = (Id, State) => ({ Id, Image: image, RestartCount: 0, State });
  let present = true, removeAfterList = false;
  const calls = [];
  f.docker = (argv) => {
    assert.deepEqual(argv.slice(0, 3), ["--host", "unix:///var/run/docker.sock", "container"]);
    const args = argv.slice(3); calls.push(args);
    if (args[0] === "ls") {
      assert.deepEqual(args, ["ls", "-aq", "--no-trunc"]);
      const listing = present ? [id, other] : [other];
      if (removeAfterList) present = false;
      return listing.join("\n");
    }
    assert.equal(args.length, 2);
    assert.equal(args[0], "inspect");
    if (args[1] === other) return JSON.stringify([row(other, state)]);
    assert.equal(args[1], id);
    // A Docker CLI nonzero exit has status, not an allowlisted OS error code.
    if (!present) throw Object.assign(new Error("PRIVATE_DOCKER_DIAGNOSTIC"), { status: 1 });
    return JSON.stringify([row(id, running)]);
  };
  f.override = (path) => {
    if (path === `/proc/${pid}/cgroup`) return `0::${scope}\n`;
    if (path === `/proc/${pid}/stat`) return stat(pid);
    if (path === `/sys/fs/cgroup${scope}/cgroup.procs`) return `${pid}\n`;
    if (path === `/sys/fs/cgroup${scope}/cgroup.events`) return "populated 1\n";
    if (group !== true && path === `/sys/fs/cgroup${scope}/cpuset.cpus.effective`) return "1\n";
  };
  const tick = async () => { f.clock += 100; await f.tick(); };

  for (let i = 0; i < 80; i++) await tick();
  const live = f.samples().slice(2);
  assert.equal(live.length, 80);
  for (const { docker } of live) {
    assert.deepEqual(docker.inventory, [id, other]);
    assert.deepEqual(docker.gaps, []);
    assert.equal(docker.participants[0].container.id, id);
    assert.equal(docker.participants[0].kernel.stat, stat(pid));
  }
  assert.equal(faults, 0);

  calls.length = 0; removeAfterList = true;
  await tick();
  assert.deepEqual(calls, [["ls", "-aq", "--no-trunc"], ["inspect", id], ["inspect", other]]);
  assert.equal(faults, 1);
  const failed = f.samples().at(-1).docker;
  assert.deepEqual(failed.inventory, [id, other]);
  assert.deepEqual(failed.gaps, [id]);
  assert.deepEqual(failed.participants.map((r) => r.container.id), [other]);

  removeAfterList = false;
  await tick();
  const next = f.samples().at(-1).docker;
  assert.deepEqual(next.inventory, [other]);
  assert.deepEqual(next.gaps, []);
  assert.deepEqual(next.participants.map((r) => r.container.id), [other]);
  const proof = await f.finish();
  assert.equal(faults, 1);
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "inspect-open", code: "unknown" });
  assert.equal(f.terminal.observerError, null);
  assert.equal(f.terminal.observerFailures.count, 0);
  assert.doesNotMatch(JSON.stringify(f.terminal), /PRIVATE_DOCKER_DIAGNOSTIC/);
  assert.equal(proof.status, "verified", "command scope evidence is sound independently of the Docker gap");
  if (group === true) assert.equal(inspectBrowserParticipants({ schema: "native-browser-host-subject/v2",
    participants: [{ id }, { id: other }] }, proof), false);
}

test("unbound: listed browser container removed before inspect remains a gap after a clean nonempty census", (t) => externalRemoval(t));
test("bound: removal outside the gate still fails closed and a later inventory cannot erase it", linux, (t) =>
  externalRemoval(t, anchor(t).gate));

const id = "a".repeat(64), task = "browser-abcdef";
function anchor(t) {
  const directory = mkdtempDisposableSync(join(tmpdir(), "browser-docker-gate-"));
  const path = join(directory.path, "command.log"), fd = openSync(path, "wx", 0o600);
  const gate = { fd, identity: browserDockerGateIdentity(fd) };
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeSync(fd); } };
  t.after(() => { try { close(); } finally { directory.remove(); } });
  return { gate, path, close };
}

function probe(gate, mode = "-x") {
  const fd = reopenBrowserDockerGate(gate);
  try {
    const result = spawnSync("/usr/bin/flock", [mode, "-n", "-E", "75", "0"], {
      stdio: [fd, "ignore", "ignore"], timeout: 1000, killSignal: "SIGKILL",
    });
    assert.ifError(result.error); assert.equal(result.signal, null);
    return result.status;
  } finally { closeSync(fd); }
}

for (const group of ["live-delivery", "recoverable-live"]) {
  test(`${group}: the 100 ms census fences an exact owned removal and keeps its terminal anchor`, linux, async (t) => {
    const { gate, close } = anchor(t), peer = reopenBrowserDockerGate(gate);
    t.after(() => closeSync(peer));
    const runnerGate = { ...gate, fd: peer };
    let faults = 0, present = true;
    const f = await fixture(t, [], group, () => { faults++; }, 0, false, null, gate);
    assert.equal(f.intervalMs, 100, "Live keeps the interval timer");
    const zero = "0001-01-01T00:00:00Z";
    const info = { Id: id, Image: "sha256:" + "b".repeat(64), RestartCount: 0,
      Config: { Labels: { "agent.owner": "codex", "agent.task": "bench-parity-live" } },
      State: { Status: "created", Pid: 0, Running: false, Paused: false, Restarting: false,
        Dead: false, OOMKilled: false, ExitCode: 0, StartedAt: zero, FinishedAt: zero } };
    const json = JSON.stringify([info]);
    f.docker = (argv) => {
      const [operation, target] = argv.slice(3);
      if (operation === "ls") {
        const listed = present ? id : "";
        // Attempt the competing exclusive operation after the list took its view.
        if (listed && probe(runnerGate) === 0) present = false;
        return listed;
      }
      assert.equal(target, id);
      assert.equal(probe(runnerGate), 75, "inspect still owns the census lock");
      assert.ok(present);
      return json;
    };
    f.clock += 100; await f.tick();
    assert.deepEqual(f.samples().at(-1).docker.inventory, [id]);
    assert.deepEqual(f.samples().at(-1).docker.gaps, []);
    const calls = [], docker = (args) => {
      calls.push(args);
      assert.deepEqual(args, ["inspect", id]);
      assert.equal(probe(gate), 0, "ownership inspection is outside the gate");
      return json;
    };
    removeOwnedLiveContainer(docker, id, runnerGate, (binary, args, options) => {
      calls.push(args);
      assert.equal(binary, "docker");
      assert.equal(probe(gate, "-s"), 75, "exclusive lock held through the synchronous call");
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.timeout, 180000);
      present = false;
      return { status: 0, signal: null, stdout: "" };
    });
    assert.deepEqual(calls, [["inspect", id], ["rm", "-f", "-v", id]]);
    assert.equal(probe(gate), 0, "lock released after command settlement");
    close();
    assert.equal((await f.finish()).status, "verified");
    assert.deepEqual(f.samples().at(-1).docker.inventory, []);
    assert.equal(faults, 0);
  });

  test(`${group}: removal outside the gate leaves a gap after a clean census`, linux, (t) =>
    externalRemoval(t, anchor(t).gate, group));
}

test("a gated Live removal refuses a synchronous timeout even with exit status zero", linux, (t) => {
  const { gate } = anchor(t);
  const inspect = () => JSON.stringify([{ Id: id, Config: { Labels: {
    "agent.owner": "codex", "agent.task": "bench-parity-live",
  } } }]);
  const timeout = Object.assign(new Error("synchronous removal timed out"), { code: "ETIMEDOUT" });
  assert.throws(() => removeOwnedLiveContainer(inspect, id, gate, (program, args, options) => {
    assert.equal(program, "docker");
    assert.deepEqual(args, ["rm", "-f", "-v", id]);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(probe(gate, "-s"), 75);
    return { status: 0, signal: null, error: timeout, stdout: "", stderr: "" };
  }), (error) => error.receipt?.status === 0 && error.receipt.error === timeout.message);
  assert.equal(probe(gate), 0, "failed removal released the lock after settlement");
});

function fakeDocker(t, reply) {
  t.mock.method(childProcess, "spawn", (binary, args) => {
    assert.equal(binary, "docker");
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    const response = reply(args, child);
    if (response) {
      const [output, code = 0] = response;
      setImmediate(() => { child.stdout.end(output); child.stderr.end(); child.emit("close", code, null); });
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("the Browser census fences exact removal across list and inspect; terminal census keeps its own anchor", linux, async (t) => {
  const { gate, close } = anchor(t), peer = reopenBrowserDockerGate(gate);
  t.after(() => closeSync(peer));
  const runnerGate = { ...gate, fd: peer };
  const zero = "0001-01-01T00:00:00Z";
  const info = { Id: id, Image: "sha256:" + "b".repeat(64), RestartCount: 0,
    Config: { Labels: { "agent.task": task, "agent.owner": "codex" } },
    State: { Status: "created", Pid: 0, Running: false, Paused: false, Restarting: false,
      Dead: false, OOMKilled: false, ExitCode: 0, StartedAt: zero, FinishedAt: zero } };
  let faults = 0, present = true, race = false;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  const events = [], calls = [];
  f.docker = (argv) => {
    const [command, target] = argv.slice(3);
    calls.push(command);
    if (command === "ls") {
      const listed = present ? id : "";
      if (race && listed) {
        // Emulate the competing remove exactly after the list took its view.
        // Without the observer gate this changes the ID before inspect.
        if (probe(runnerGate) === 0) present = false;
        assert.equal(probe(runnerGate, "-s"), 0);
      }
      return listed;
    }
    assert.equal(target, id);
    if (!present) throw Object.assign(new Error("PRIVATE_DOCKER_DIAGNOSTIC"), { status: 1 });
    assert.equal(probe(runnerGate), 75, "inspect must still have the shared lock");
    return JSON.stringify([info]);
  };
  fakeDocker(t, (args) => {
    if (args[0] === "inspect") {
      assert.deepEqual(args, ["inspect", id]);
      assert.equal(probe(runnerGate), 0, "the runner must not lock its ownership inspect");
      return [JSON.stringify([info])];
    }
    assert.deepEqual(args, ["rm", "-f", "-v", id]);
    assert.equal(probe(runnerGate, "-s"), 75, "the exact remove must have the exclusive lock");
    setImmediate(() => assert.equal(probe(runnerGate, "-s"), 75, "the lock must survive until command close"));
    present = false;
    return [""];
  });
  race = true; f.clock += 100; await f.tick();
  assert.equal(faults, 0);
  assert.deepEqual(calls, ["ls", "inspect"]);
  assert.deepEqual(f.samples().at(-1).docker.gaps, []);
  assert.deepEqual(f.samples().at(-1).docker.inventory, [id]);
  const owned = new OwnedDocker(task, null, true, runnerGate);
  owned.record = (event) => events.push(event);
  owned.containers.add(id);
  await owned.remove(id);
  assert.deepEqual(events, [{ event: "remove", kind: "container", id, code: 0 }]);
  assert.equal(owned.containers.size, 0);
  assert.equal(probe(runnerGate), 0);
  close(); // The real supervisor closes the writer before taking the final sample.
  const proof = await f.finish();
  assert.equal(proof.status, "verified");
  assert.deepEqual(f.samples().at(-1).docker.inventory, []);
  assert.equal(f.terminal.firstDockerGap, undefined);
  assert.equal(faults, 0);
});

test("strict Browser replay accepts an inventory captured after the exact removal", linux, async (t) => {
  const { gate } = anchor(t);
  let faults = 0, present = true;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  const base = f.clock, pid = 5000, scope = `/system.slice/docker-${id}.scope`, imageId = "sha256:" + "b".repeat(64);
  const state = { Status: "running", Pid: pid, Running: true, Paused: false, Restarting: false,
    Dead: false, OOMKilled: false, ExitCode: 0, StartedAt: new Date(base + 50).toISOString(), FinishedAt: "0001-01-01T00:00:00Z" };
  f.docker = (argv) => {
    if (argv[3] === "ls") return present ? id : "";
    assert.deepEqual(argv.slice(3), ["inspect", id]); assert.equal(present, true);
    return JSON.stringify([{ Id: id, Image: imageId, RestartCount: 0, State: state }]);
  };
  f.override = (path) => {
    if (path === `/proc/${pid}/cgroup`) return `0::${scope}\n`;
    if (path === `/sys/fs/cgroup${scope}/cgroup.procs`) return `${pid}\n`;
    if (path === `/sys/fs/cgroup${scope}/cgroup.events`) return "populated 1\n";
    if (path === `/sys/fs/cgroup${scope}/cpu.max`) return "100000 100000\n";
    if (path === `/sys/fs/cgroup${scope}/memory.max`) return "1073741824\n";
  };
  f.clock = base + 100; await f.tick();
  let unlock = lockBrowserDocker(gate, true), terminalAt;
  f.flock = (_args, options, acquire) => {
    assert.equal(probe(gate, "-s"), 75);
    assert.ok(options.timeout > 100);
    f.clock = base + 850; terminalAt = f.clock;
    f.clock = base + 900; present = false; unlock(); unlock = undefined;
    return acquire();
  };
  try { f.clock = base + 800; await f.tick(); }
  finally { unlock?.(); delete f.flock; }
  f.clock = base + 950;
  const proof = await f.finish();
  const subject = { schema: "native-browser-host-subject/v2", executionWindow: { startedAt: base, endedAt: f.clock },
    participants: [{ id, imageId, role: "application", window: { startedAt: base + 50, endedAt: terminalAt },
      terminal: { id, imageId, restartCount: 0, state, limits: { NanoCpus: 1e9, Memory: 2 ** 30, CpusetCpus: "" } } }] };
  assert.equal(proof.status, "verified");
  assert.equal(inspectBrowserParticipants(subject, proof), true, "post-removal absence must not be backdated into the running window");
  const absent = proof.samples.at(-2);
  assert.equal(absent.at, base + 900); assert.deepEqual(absent.docker.inventory, []);
  absent.at = base + 800;
  assert.equal(inspectBrowserParticipants(subject, proof), false, "the reader still refuses absence before the terminal receipt");
  assert.equal(faults, 0);
});

test("a Browser sample waits past 200 ms within its budget and stamps the actual capture", linux, async (t) => {
  const { gate } = anchor(t);
  let faults = 0;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  const previous = f.samples().at(-1).at, listedAt = [];
  f.docker = () => { listedAt.push(f.clock); return ""; };
  let unlock = lockBrowserDocker(gate, true);
  try {
    f.clock += 100;
    f.override = () => {
      assert.equal(probe(gate), 75, "the cgroup census must already hold the shared gate");
      f.clock += 25; f.override = () => {};
    };
    f.flock = (args, options, acquire) => {
      const wait = 350;
      assert.equal(probe(gate, "-s"), 75);
      assert.deepEqual(args, ["-s", "-E", "75", "-w", "0.8", "0"]);
      assert.equal(options.timeout, 800);
      assert.ok(wait < options.timeout);
      f.clock += wait; unlock(); unlock = undefined;
      return acquire();
    };
    await f.tick();
  } finally { unlock?.(); delete f.flock; }
  assert.deepEqual(listedAt, [previous + 475]);
  assert.equal(f.samples().at(-1).at, previous + 475);
  assert.equal(faults, 0);
  const following = f.clock + 50;
  f.clock = following; await f.tick();
  assert.equal(f.samples().at(-1).at, following);
  assert.equal((await f.finish()).status, "verified");
  assert.equal(faults, 0);
});

for (const group of [true, "live-delivery", "recoverable-live"]) test(`${group === true ? "Browser" : group}: contention exhausts the remaining 250 ms; a fresh terminal capture proves drain but keeps the gap`, linux, async (t) => {
  const { gate } = anchor(t);
  let faults = 0, lists = 0;
  const f = await fixture(t, [], group, () => { faults++; }, 0, false, null, gate);
  const previous = f.samples().at(-1).at;
  f.docker = () => { lists++; return ""; };
  const unlock = lockBrowserDocker(gate, true);
  let attempt;
  f.flock = (args, options, acquire) => {
    attempt = [args, options.timeout];
    try { return acquire(); } finally { f.clock += options.timeout; }
  };
  try { f.clock += 650; await f.tick(); }
  finally { unlock(); delete f.flock; }
  assert.deepEqual(attempt, [["-s", "-E", "75", "-w", "0.25", "0"], 250]);
  assert.equal(f.clock, previous + 900);
  assert.equal(lists, 0); assert.equal(faults, 1);
  f.clock += 200; // Command close is outside the old periodic continuity window.
  f.flock = (args, options, acquire) => {
    assert.deepEqual(args, ["-s", "-E", "75", "-w", "1", "0"]);
    assert.equal(options.timeout, 1000);
    return acquire();
  };
  const proof = await f.finish();
  delete f.flock;
  assert.equal(lists, 1);
  assert.equal(f.samples().at(-1).at, previous + 1100);
  assert.equal(f.terminal.empty, true); assert.equal(f.terminal.terminal, true);
  assert.equal(f.removed, true);
  assert.equal(proof.status, "blocked");
  assert.equal(proof.cleanupComplete, false);
  assert.equal(proof.checks.empty, true); assert.equal(proof.checks.terminal, true);
  assert.equal(proof.checks.accounting, false); assert.equal(proof.checks.observer, false);
  assert.equal(faults, 1);
  assert.equal(f.terminal.observerError, "host-observation-gap");
  assert.equal(f.terminal.observerFailures.count, 1);
  assert.deepEqual(f.terminal.observerFailures.first, {
    phase: "interval", operation: "docker-gate", code: "unknown", at: previous + 900, samples: 2, lastSampleAt: previous,
  });
});

for (const mode of ["healthy", "late", "contended", "exhausted"]) {
  test(`Browser terminal gate: ${mode}`, linux, async (t) => {
    const { gate } = anchor(t), stop = new AbortController();
    let faults = 0, lists = 0, settled = 0;
    const f = await fixture(t, [], true, () => { faults++; stop.abort(); }, 0, false, null, gate, stop.signal);
    f.clock += 100; await f.tick();
    const previous = f.samples().at(-1).at;
    const healthy = mode === "healthy", contended = mode === "contended", exhausted = mode === "exhausted";
    f.clock += healthy ? 100 : contended ? 650 : 1001; // No interval fires before finish.
    const attempts = [];
    let unlock = (contended || exhausted) ? lockBrowserDocker(gate, true) : undefined;
    f.docker = () => { lists++; return ""; };
    f.flock = (args, options, acquire) => {
      attempts.push([args, options.timeout]);
      try { return acquire(); }
      finally {
        if (unlock) f.clock += options.timeout;
        if (contended && unlock) { unlock(); unlock = undefined; }
      }
    };
    let proof;
    try { proof = await f.finish(!healthy, () => { settled++; }); }
    finally { unlock?.(); delete f.flock; }
    const attempt = (ms) => [["-s", "-E", "75", "-w", String(ms / 1000), "0"], ms];
    assert.deepEqual(attempts, healthy ? [attempt(800)] : contended ? [attempt(250), attempt(1000)] : [attempt(1000)]);
    assert.equal(lists, exhausted ? 0 : 1);
    assert.equal(f.terminal.empty, !exhausted); assert.equal(f.terminal.terminal, !exhausted);
    assert.equal(Boolean(f.removed), !exhausted); assert.equal(settled, exhausted ? 0 : 1);
    assert.equal(f.terminal.command.success, true);
    assert.equal(faults, 0); assert.equal(stop.signal.aborted, false);
    assert.equal(proof.status, healthy ? "verified" : "blocked");
    if (healthy) { assert.equal(f.terminal.observerFailures.count, 0); return; }
    assert.equal(f.terminal.observerError, "host-observation-gap");
    assert.equal(f.terminal.observerFailures.count, exhausted ? 2 : 1);
    assert.deepEqual(f.terminal.observerFailures.first, {
      phase: "finish", operation: "docker-gate", code: "unknown", at: previous + (contended ? 900 : 1001),
      samples: 3, lastSampleAt: previous,
    });
    if (exhausted) assert.equal(f.terminal.observerFailures.last.at, previous + 2001);
    assert.equal(f.samples().at(-1).at, exhausted ? previous : f.clock);
    assert.equal(Object.hasOwn(f.terminal, "terminalClock"), false);
    assert.equal(proof.checks.observer, false);
    assert.equal(proof.checks.terminal, !exhausted); assert.equal(proof.checks.empty, !exhausted);
    assert.equal(proof.checks.accounting, mode !== "late");
    assert.equal(proof.cleanupComplete, false);
    assert.deepEqual(composeHostProof({}, {}, proof), { resources: "blocked", cleanupComplete: false,
      blockers: ["actual-host-subject-proof-incomplete"] });
  });
}

test("Browser terminal gate: an independent abort still fences drain publication", linux, async (t) => {
  const { gate } = anchor(t), stop = new AbortController();
  let faults = 0, settled = 0;
  const f = await fixture(t, [], true, () => { faults++; stop.abort(); }, 0, false, null, gate, stop.signal);
  f.clock += 100; await f.tick();
  f.clock += 1001;
  f.docker = () => { stop.abort(); return ""; };
  await assert.rejects(f.finish(true, () => { settled++; }), /host observation cancelled during storage drain/);
  assert.equal(faults, 0); assert.equal(stop.signal.aborted, true);
  assert.equal(f.hasTerminal(), false); assert.equal(f.removed, undefined); assert.equal(settled, 0);
});

test("a free gate at 950 ms uses nonblocking flock without spending the optional reserve", linux, async (t) => {
  const { gate } = anchor(t);
  let faults = 0, lists = 0;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  const previous = f.samples().at(-1).at;
  f.docker = () => { lists++; return ""; };
  f.flock = (args, options, acquire) => {
    assert.deepEqual(args, ["-s", "-E", "75", "-n", "0"]);
    assert.equal(options.timeout, 50);
    // Prove the real nonblocking lock without making this fake-clock control depend on host scheduling.
    options.timeout = 1000;
    return acquire();
  };
  f.clock += 950; await f.tick();
  delete f.flock;
  assert.equal(lists, 1); assert.equal(faults, 0);
  assert.equal(f.samples().at(-1).at, previous + 950);
  assert.equal((await f.finish()).status, "verified");
});

test("an expired gate budget cannot be renewed by moving the wall clock backwards", linux, async (t) => {
  const { gate } = anchor(t);
  let faults = 0, lists = 0, attempts = 0;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  f.clock += 100; await f.tick();
  f.docker = () => { lists++; return ""; };
  f.flock = (_args, _options, acquire) => { attempts++; return acquire(); };
  f.clock += 1000; f.wallOffset = -900;
  await f.tick();
  assert.equal(attempts, 0);
  assert.equal(lists, 0);
  assert.equal(faults, 1);
  assert.notEqual((await f.finish()).status, "verified");
  assert.equal(f.terminal.observerFailures.first.operation, "docker-gate");
});

test("cgroup capture cannot spend past the deadline after acquiring a free gate", linux, async (t) => {
  const { gate } = anchor(t);
  let faults = 0, lists = 0;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  f.clock += 100; await f.tick();
  const previous = f.samples().at(-1).at;
  f.docker = () => { lists++; return ""; };
  f.flock = (args, options, acquire) => {
    assert.equal(args.includes("-n"), true); assert.equal(options.timeout, 50);
    options.timeout = 1000; // The fake clock drives the budget, not host scheduling.
    return acquire();
  };
  f.override = () => { f.clock += 51; f.override = () => {}; };
  f.clock += 950; await f.tick();
  delete f.flock;
  assert.equal(lists, 0); assert.equal(faults, 1); assert.equal(probe(gate), 0);
  assert.equal(f.samples().at(-1).at, previous);
  const proof = await f.finish();
  assert.equal(proof.status, "blocked"); assert.equal(proof.checks.empty, true);
  assert.equal(f.terminal.observerFailures.first.operation, "snapshot");
});

test("a lock returned at the monotonic deadline is released without listing", linux, async (t) => {
  const { gate } = anchor(t);
  let faults = 0, lists = 0;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  f.clock += 100; await f.tick();
  f.docker = () => { lists++; return ""; };
  f.flock = (_args, options, acquire) => {
    const result = acquire();
    f.clock += options.timeout;
    return result;
  };
  f.clock += 100; await f.tick();
  delete f.flock;
  assert.equal(probe(gate), 0);
  assert.equal(lists, 0);
  assert.equal(faults, 1);
  assert.notEqual((await f.finish()).status, "verified");
  assert.equal(f.terminal.observerFailures.first.operation, "docker-gate");
});

test("the isolated bootstrap passes the pinned descriptor to the runner without changing stdin", linux, async (t) => {
  const { gate, path } = anchor(t), entry = join(path, "..", "entry.mjs");
  const source = new URL("./host-lifetime.mjs", import.meta.url).href;
  writeFileSync(entry, `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { readFileSync, writeSync } from "node:fs";
    import { lockBrowserDocker } from ${JSON.stringify(source)};
    assert.equal(readFileSync(0, "utf8"), "");
    const gate = { fd: ${browserDockerGateChildFd}, identity: process.env[${JSON.stringify(browserDockerGateEnv)}] };
    assert.throws(() => writeSync(gate.fd, "must not reach the command log"), { code: "EBADF" });
    assert.throws(() => lockBrowserDocker(gate, false, performance.now() + 250), /acquisition timed out/);
    assert.equal(spawnSync("/usr/bin/readlink", ["/proc/self/fd/" + gate.fd]).status, 1, "ordinary children must not inherit the anchor");
    console.log("contended");
  `);
  const readOnly = reopenBrowserDockerGate(gate), unlock = lockBrowserDocker(gate, true);
  let output = "";
  try {
    const result = await supervise({ executable: "node", argv: [entry], shell: false }, {
      cwd: process.cwd(), env: { [browserDockerGateEnv]: gate.identity }, browserDockerFd: readOnly,
      log(bytes) { output += bytes; },
    }, { readyMs: 15000, runMs: 15000, stopMs: 2000, killMs: 1000 });
    assert.equal(result.success, true, `${JSON.stringify(result)}\n${output}`);
    assert.equal(output.trim(), "contended");
  } finally { unlock(); closeSync(readOnly); }
});

test("missing, substituted, writable-by-others and unlinked gate anchors refuse", linux, (t) => {
  const { gate, path, close } = anchor(t);
  const other = anchor(t);
  for (const invalid of [{ ...gate, fd: 0 }, { ...gate, fd: other.gate.fd }, { ...gate, identity: undefined }])
    assert.throws(() => lockBrowserDocker(invalid), { message: "Browser Docker gate anchor unavailable" });
  chmodSync(path, 0o622);
  assert.throws(() => lockBrowserDocker(gate), /anchor unavailable/);
  chmodSync(path, 0o600);
  const alias = path + ".alias"; linkSync(path, alias);
  assert.throws(() => lockBrowserDocker(gate), /anchor unavailable/);
  unlinkSync(alias); unlinkSync(path);
  assert.throws(() => lockBrowserDocker(gate), /anchor unavailable/);
  close();
  assert.throws(() => lockBrowserDocker(gate), /anchor unavailable/);
});

test("the runner refuses a malformed or nonisolated binding before native work", async (t) => {
  const old = process.env[browserDockerGateEnv];
  t.after(() => { if (old === undefined) delete process.env[browserDockerGateEnv]; else process.env[browserDockerGateEnv] = old; });
  process.env[browserDockerGateEnv] = "";
  await assert.rejects(run({ round: "w1", isolated: false }), /anchor unavailable/);
  await assert.rejects(run({ round: "w1", isolated: true }), /anchor unavailable/);
});

test("runner lock refusals never run or acknowledge rm, and keep ownership for cleanup", linux, async (t) => {
  const { gate } = anchor(t), calls = [], records = [];
  const owned = new OwnedDocker(task, null, true, gate);
  owned.containers.add(id); owned.record = (r) => records.push(r);
  let labels = { "agent.task": task, "agent.owner": "codex" };
  fakeDocker(t, (args) => {
    calls.push(args);
    assert.deepEqual(args, ["inspect", id]);
    return [JSON.stringify([{ Config: { Labels: labels } }])];
  });
  const exec = childProcess.execFileSync;
  let error, attempted = 0, fd;
  t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    if (file !== "/usr/bin/flock") return exec(file, args, options);
    attempted++;
    assert.deepEqual(args, ["-x", "-E", "75", "-w", "2", "0"]);
    assert.equal(options.timeout, 2250); assert.equal(options.killSignal, "SIGKILL");
    fd = options.stdio[0];
    throw Object.assign(new Error("PRIVATE_FLOCK_DIAGNOSTIC"), error);
  });
  syncBuiltinESMExports();
  await assert.rejects(owned.remove("foreign"), /unowned container/);
  labels = { ...labels, "agent.task": "foreign" };
  await assert.rejects(owned.remove(id));
  assert.equal(attempted, 0);
  labels["agent.task"] = task;
  for (const [cause, message] of [[{ code: "ENOENT" }, "failed"], [{ status: 1 }, "failed"], [{ signal: "SIGKILL" }, "failed"],
    [{ code: "ETIMEDOUT" }, "timed out"], [{ status: 75 }, "timed out"]]) {
    error = cause;
    await assert.rejects(owned.remove(id), { message: `Browser Docker gate acquisition ${message}` });
    assert.equal(owned.containers.has(id), true);
    assert.throws(() => browserDockerGateIdentity(fd), /anchor unavailable/);
  }
  assert.equal(attempted, 5); assert.equal(calls.length, 6); assert.deepEqual(records, []);
});

test("a bound runner releases after an unsuccessful rm and keeps the existing lost-inspect cleanup", linux, async (t) => {
  const { gate } = anchor(t), records = [];
  const owned = new OwnedDocker(task, null, true, gate);
  owned.containers.add(id); owned.record = (event) => records.push(event);
  let retry = false;
  fakeDocker(t, (args) => {
    if (args[0] === "inspect") return retry ? ["", 1]
      : [JSON.stringify([{ Config: { Labels: { "agent.task": task, "agent.owner": "codex" } } }])];
    assert.deepEqual(args, ["rm", "-f", "-v", id]); assert.equal(probe(gate, "-s"), 75);
    return ["", retry ? 0 : 1];
  });
  await assert.rejects(owned.remove(id), /Owned Docker removal not acknowledged/);
  assert.equal(owned.containers.has(id), true); assert.equal(probe(gate), 0);
  retry = true;
  await assert.rejects(owned.remove(id), /docker inspect: exit 1/);
  assert.equal(owned.containers.has(id), false); assert.equal(probe(gate), 0);
  assert.deepEqual(records.map(({ code }) => code), [1, 0]);
});

test("a refused removal gate leaves no duplicate terminal receipt after exact cleanup retry", linux, async (t) => {
  const { gate } = anchor(t), calls = [], cleanupFailures = [];
  const folder = mkdtempDisposableSync(join(tmpdir(), "browser-removal-ledger-"));
  t.after(() => folder.remove());
  const store = new EvidenceStore(folder.path), commit = "d".repeat(40), app = "nextjs";
  const { key, source } = definition("fullstack-browser").cases[0];
  const ledger = new ExecutionLedger(store, { task, commit, startedAt: Date.now() });
  const owned = new OwnedDocker(task, ledger, true, gate);
  const image = { Id: "sha256:" + "b".repeat(64), Config: { Entrypoint: ["node"], Cmd: ["server.mjs"] } };
  const info = { Id: id, Name: "/synthetic-source", Image: image.Id, RestartCount: 0, Mounts: [],
    Config: { ...image.Config, Env: [`MARKETPLACE_SOURCE=${source}`], Labels: { "agent.owner": "codex", "agent.task": task } },
    State: { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false,
      Dead: false, Pid: 0, ExitCode: 0, StartedAt: "", FinishedAt: "" },
    HostConfig: { NanoCpus: 1e9, CpuQuota: 0, CpuPeriod: 0, CpusetCpus: browserCpus.application,
      Memory: 1024 ** 3, MemorySwap: 2 * 1024 ** 3, ShmSize: 64 * 1024 ** 2, PidsLimit: null, NetworkMode: "bridge" } };
  let present = true;
  fakeDocker(t, (args) => {
    calls.push(args);
    if (args[0] === "create") return [id];
    if (args[0] === "start") return ["", 1];
    if (args[0] === "inspect") return [JSON.stringify([info])];
    if (args[1] === "inspect") { assert.deepEqual(args, ["image", "inspect", image.Id]); return [JSON.stringify([image])]; }
    if (args[0] === "rm") {
      assert.deepEqual(args, ["rm", "-f", "-v", id]);
      assert.equal(probe(gate, "-s"), 75); assert.equal(present, true);
      present = false; return [""];
    }
    assert.ok(args[0] === "ps" || ["network", "image", "volume"].includes(args[0]) && args[1] === "ls");
    return [args[0] === "ps" && present ? id : ""];
  });
  await assert.rejects(owned.start(task, [], image.Id, [], { role: "application", app, case: key }), /docker start: exit 1/);
  const unlock = lockBrowserDocker(gate, true);
  const exec = childProcess.execFileSync;
  const contender = t.mock.method(childProcess, "execFileSync", (file, args, options) =>
    exec(file, file === "/usr/bin/flock" ? ["-x", "-n", "-E", "75", "0"] : args, options));
  syncBuiltinESMExports();
  try { await owned.remove(id); } catch (e) { cleanupFailures.push(e.message); }
  finally { contender.mock.restore(); syncBuiltinESMExports(); unlock(); }
  assert.deepEqual(cleanupFailures, ["Browser Docker gate acquisition timed out"]);
  assert.equal(owned.containers.has(id), true);
  assert.equal(calls.some(([command]) => command === "rm"), false);
  cleanupFailures.push(...await owned.cleanup());
  assert.deepEqual(calls.filter(([command]) => command === "rm"), [["rm", "-f", "-v", id]]);
  assert.equal(owned.containers.has(id), false);

  const ref = ledger.finish({ endedAt: Date.now() }); store.seal();
  const reader = openEvidence(folder.path);
  const execution = replayExecution(reader, ref, { isolated: true });
  const events = reader.json(ref).events;
  assert.equal(events.filter(({ phase }) => phase === "terminal").length, 1);
  assert.equal(events.filter(({ event }) => event === "remove").length, 1);
  assert.equal(execution.cleanupComplete, true); assert.deepEqual(execution.blocked, []);
  reader.finish();
  const cell = { case: key, outcome: "failed", qualificationPassed: false, evidence: null };
  const summary = { complete: true, code: { dirty: false }, failures: [], cleanupFailures,
    options: { apps: [app], cases: [key], build: false }, cells: { [app]: [cell] }, images: { [app]: { id: image.Id } } };
  const derived = replayPrerequisite(cell, app, summary, execution, new Set());
  const [disposition] = nativeAttemptCells([{ app, case: key, outcome: cell.outcome, derived, blocked: execution.blocked }], summary);
  assert.equal(disposition.disposition, "observed-prerequisite-failure");
  assert.equal(disposition.qualificationPassed, false);
  assert.equal(groupQualificationPassed(summary), false);
});

test("a timed-out exact rm holds through CLI close; a late daemon removal still leaves a gap", linux, async (t) => {
  const { gate } = anchor(t), records = [], signals = [];
  const owned = new OwnedDocker(task, null, true, gate);
  owned.containers.add(id); owned.record = (event) => records.push(event);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { promise: entered, resolve: enter } = Promise.withResolvers();
  fakeDocker(t, (args, child) => {
    if (args[0] === "inspect") return [JSON.stringify([{ Config: { Labels: { "agent.task": task, "agent.owner": "codex" } } }])];
    assert.deepEqual(args, ["rm", "-f", "-v", id]);
    assert.equal(probe(gate, "-s"), 75);
    child.kill = (signal) => { signals.push(signal); return true; };
    enter(child);
  });
  const rejected = assert.rejects(owned.remove(id), /Owned Docker removal not acknowledged/);
  const child = await entered;
  try {
    t.mock.timers.tick(29999);
    assert.deepEqual(signals, []);
    t.mock.timers.tick(1);
    assert.deepEqual(signals, ["SIGKILL"]);
    assert.equal(probe(gate, "-s"), 75);
    child.emit("exit", null, "SIGKILL");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probe(gate, "-s"), 75);
  } finally {
    child.stdout.end(); child.stderr.end(); child.emit("close", null, "SIGKILL");
    await rejected;
  }
  assert.equal(probe(gate, "-s"), 0);
  assert.deepEqual(records, []);
  assert.equal(owned.containers.has(id), true);

  t.mock.timers.reset();
  let faults = 0, present = true;
  const f = await fixture(t, [], true, () => { faults++; }, 0, false, null, gate);
  f.docker = (args) => {
    if (args[3] === "ls") {
      if (!present) return "";
      present = false; // The daemon finishes the remove after CLI close, just after list.
      return id;
    }
    assert.deepEqual(args.slice(3), ["inspect", id]);
    throw Object.assign(new Error("PRIVATE_LATE_DAEMON_DIAGNOSTIC"), { status: 1 });
  };
  f.clock += 100; await f.tick();
  assert.deepEqual(f.samples().at(-1).docker.gaps, [id]);
  const proof = await f.finish();
  assert.equal(faults, 1);
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "inspect-open", code: "unknown" });
  assert.equal(inspectBrowserParticipants({ schema: "native-browser-host-subject/v2", participants: [{ id }] }, proof), false);
});
