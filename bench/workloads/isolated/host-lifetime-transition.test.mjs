// Issue 2052: a Docker participant observed created, then started while the
// observer samples it. Drives the real observer with synthetic Docker and
// kernel reads; this is not native host qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fixture, stat } from "./test-fixtures/host-lifetime-observer.mjs";

const id = "4f".repeat(32), other = "5e".repeat(32), image = "sha256:" + "b".repeat(64);
const scope = (container) => `/system.slice/docker-${container}.scope`;
const zero = "0001-01-01T00:00:00Z";

// Each attempt reads the root stat at open, twice in the census and at close.
async function transition(t, mode) {
  let faults = 0;
  const f = await fixture(t, [], true, () => { faults++; });
  const run = { listed: true, running: false, pid: 5000, startedAt: zero, id, inspections: 0, statReads: 0, start: null };
  f.docker = (argv) => {
    if (argv.includes("ls")) return run.listed ? id : "";
    assert.deepEqual(argv.slice(-3), ["container", "inspect", id]);
    run.inspections++;
    if (run.inspections === run.firstRunning) run.began = f.clock; // The capture starts with this query.
    f.clock += 10; // Each Docker query takes time.
    if (run.running) mode.inspect?.(run, f);
    if (run.running && run.inspections > run.firstRunning && mode.retry) mode.retry(run, f);
    return JSON.stringify([{ Id: run.id, Image: image, RestartCount: 0, State: {
      Status: run.running ? "running" : "created", Running: run.running, Pid: run.running ? run.pid : 0,
      Paused: false, Restarting: false, OOMKilled: false, Dead: false, ExitCode: 0,
      StartedAt: run.running ? run.startedAt : zero, FinishedAt: zero,
    } }]);
  };
  f.override = (path) => {
    const pid = run.pid;
    if (path === "/sys/fs/cgroup" + scope(id) + "/cgroup.procs") return pid + "\n";
    if (path === `/proc/${pid}/cgroup`) return "0::" + scope(id) + "\n";
    if (path === `/proc/${pid}/stat`) return stat(pid, mode.name(++run.statReads, f, run), run.start ?? pid * 10);
  };

  f.clock += 100; await f.tick();
  const created = f.samples().at(-1).docker;
  assert.deepEqual(created.gaps, []);
  assert.equal(created.participants[0].container.state.Status, "created");
  assert.equal(created.participants[0].kernel, null);

  // r70 shape: Docker records the start 7 ms after the sample's kernel census.
  f.clock += 100; const sampleAt = f.clock;
  run.running = true; run.firstRunning = run.inspections + 1; mode.onRunning?.(run);
  run.startedAt = mode.startedAt?.(sampleAt) ?? new Date(sampleAt + 7).toISOString().replace("Z", "123456Z");
  await f.tick();
  f.wallOffset = 0; // Restore a wall clock a mode moved inside that capture.
  const observed = f.samples().at(-1);
  assert.equal(observed.at, sampleAt);
  run.listed = false; f.clock += 100; await f.tick();
  await f.finish();
  return { f, run, faults, observed: observed.docker, elapsed: f.clock };
}

const renamed = (read) => read === 1 ? "node" : "node-MainThread";

test("a container renamed by its own startup between open and close is observed with no gap or fault", async (t) => {
  const { f, run, faults, observed } = await transition(t, { name: renamed });
  assert.deepEqual(observed.inventory, [id]); assert.deepEqual(observed.gaps, []);
  assert.equal(observed.participants.length, 1);
  const [record] = observed.participants;
  assert.equal(record.container.id, id); assert.equal(record.container.state.Pid, 5000);
  assert.match(record.kernel.stat, /^5000 \(node-MainThread\) S /);
  assert.deepEqual(record.kernel.processes.map((p) => p.stat.split(" ")[1]), ["(node-MainThread)"]);
  assert.equal(faults, 0);
  assert.equal(Object.hasOwn(f.terminal, "firstDockerGap"), false);
  assert.deepEqual(f.terminal.dockerStartupRechecks, { count: 1, first: { stage: "process-name-close", code: "ERR_ASSERTION", attempts: 2 } });
  assert.equal(f.terminal.observerFailures.count, 0);
  assert.equal(run.inspections, 4, "created, failed open, retried open and close");
});

test("a container whose entrypoint execs during the census is observed after one bounded recheck", async (t) => {
  const { f, faults, observed } = await transition(t, { name: (read, fx) => {
    if (read === 3) fx.nextPid = 5000; // The image changes after the closing stat read.
    return read <= 3 ? "docker-entrypoi" : "node";
  } });
  assert.deepEqual(observed.gaps, []); assert.equal(observed.participants.length, 1);
  assert.match(observed.participants[0].kernel.stat, /^5000 \(node\) S /);
  assert.equal(faults, 0);
  assert.equal(Object.hasOwn(f.terminal, "firstDockerGap"), false);
  assert.deepEqual(f.terminal.dockerStartupRechecks, { count: 1, first: {
    stage: "kernel-census", operation: "executable-recheck-inode", code: "ERR_ASSERTION", attempts: 2 } });
});

// Moves the wall clock to just after midnight UTC on 2026-03-01 for the first
// running capture; the retry pause, if any, moves it back.
const nearMarch = (startedAt) => ({ name: renamed, startedAt: () => startedAt, inspect: (run, f) => {
  if (run.inspections !== run.firstRunning) return;
  f.wallOffset = Date.UTC(2026, 2, 1) + 100 - f.clock;
  Atomics.wait.mock.mockImplementationOnce((_array, _index, _value, ms) => { f.wallOffset = 0; f.clock += ms; return "timed-out"; });
} });

test("a just-started container with a canonical start time is rechecked", async (t) => {
  const { f, faults, observed } = await transition(t, nearMarch("2026-03-01T00:00:00.000Z"));
  assert.deepEqual(observed.gaps, []); assert.equal(observed.participants.length, 1);
  assert.equal(faults, 0);
  assert.equal(f.terminal.dockerStartupRechecks.count, 1);
});

test("an impossible calendar start time is not startup evidence", async (t) => {
  // Date.parse reads 2026-02-29 as March 1, 100 ms before this wall clock.
  const { f, run, faults, observed } = await transition(t, nearMarch("2026-02-29T00:00:00.000Z"));
  assert.deepEqual(observed.gaps, [id]); assert.equal(observed.participants.length, 0);
  assert.equal(faults, 1);
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "process-name-close", code: "ERR_ASSERTION" });
  assert.equal(run.inspections, 2, "created, then one running open");
  assert.equal(Object.hasOwn(f.terminal, "dockerStartupRechecks"), false);
});

test("a retry pause that wakes past the budget starts no new attempt", async (t) => {
  const { f, run, faults, observed } = await transition(t, { name: (read, fx, state) => {
    if (read === 4) { // The first attempt's closing read fails 249 ms into the capture.
      fx.clock = state.began + 249;
      Atomics.wait.mock.mockImplementationOnce((_array, _index, _value, ms) => { fx.clock += ms + 1; return "timed-out"; });
    }
    return renamed(read);
  } });
  assert.equal(f.clock - run.began >= 251, true);
  assert.deepEqual(observed.gaps, [id]); assert.equal(observed.participants.length, 0);
  assert.equal(faults, 1);
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "process-name-close", code: "ERR_ASSERTION" });
  assert.equal(run.inspections, 2, "created, then one running open; no attempt starts at 251 ms");
  assert.equal(Object.hasOwn(f.terminal, "dockerStartupRechecks"), false);
});

test("a rejected retry pins no executable for its replacement process", async (t) => {
  const { f, faults, observed } = await transition(t, { name: renamed, retry: (run, fx) => {
    run.pid = 5001; fx.nextPid = 5001; // The replacement runs a different image.
  } });
  assert.deepEqual(observed.gaps, [id]); assert.equal(faults, 1);
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "startup-recheck", code: "ERR_ASSERTION", attempts: 2 });
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  assert.deepEqual(f.proof().executables.map((e) => e.sha256), [digest("original executable")]);
  assert.equal(f.held.size, 0);
});

const once = { noRetry: true };
for (const [label, mode, expected] of [
  // Each attempt costs one 10 ms inspection and a 1 ms pause: the 23rd starts
  // at 242 ms and fails at 252 ms, so no 24th starts.
  ["a container that never settles stays a bounded gap",
    { attempts: 23, name: (read) => "n" + Math.floor(read / 4) }, { stage: "process-name-close", code: "ERR_ASSERTION" }],
  ["a retried PID that differs is a gap",
    { attempts: 2, name: renamed, retry: (run) => { run.pid = 5001; } }, { stage: "startup-recheck", code: "ERR_ASSERTION" }],
  ["a reused PID with a new start time is a gap",
    { attempts: 2, name: renamed, retry: (run) => { run.start = 99999; } }, { stage: "startup-recheck", code: "ERR_ASSERTION" }],
  ["a restarted container with a new start time is a gap",
    { attempts: 2, name: renamed, retry: (run) => { run.startedAt = run.restartedAt ??= new Date(Date.now()).toISOString(); } }, { stage: "startup-recheck", code: "ERR_ASSERTION" }],
  ["an unknown container ID is a gap without retry",
    { ...once, name: renamed, onRunning: (run) => { run.id = other; } }, { stage: "inspect-open", code: "ERR_ASSERTION" }],
  ["a long-running container renamed during capture is a gap without retry",
    { ...once, name: renamed, startedAt: (at) => new Date(at - 5000).toISOString() }, { stage: "process-name-close", code: "ERR_ASSERTION" }],
  ["an unparseable start time is a gap without retry",
    { ...once, name: renamed, startedAt: () => "start" }, { stage: "process-name-close", code: "ERR_ASSERTION" }],
]) test(label, async (t) => {
  const { f, run, faults, observed } = await transition(t, mode);
  assert.deepEqual(observed.inventory, [id]); assert.deepEqual(observed.gaps, [id]);
  assert.equal(observed.participants.length, 0);
  assert.equal(faults, 1, "an uncorroborated startup gap still requests shutdown once");
  const { attempts, ...diagnostic } = f.terminal.firstDockerGap;
  assert.deepEqual(diagnostic, expected);
  if (mode.noRetry) { assert.equal(attempts, undefined); assert.equal(run.inspections, 2, "created, then one running open"); }
  else {
    assert.equal(attempts, mode.attempts);
    // A settled retry inspects again at close; a churning one fails before it.
    assert.equal(run.inspections, 1 + mode.attempts + (mode.attempts === 2 ? 1 : 0));
  }
  assert.equal(Object.hasOwn(f.terminal, "dockerStartupRechecks"), false);
  assert.equal(f.terminal.observerFailures.count, 0);
});
