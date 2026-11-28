// Issue 2052: a Docker participant observed created, then started while the
// observer samples it. Drives the real observer with synthetic Docker and
// kernel reads; this is not native host qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inspectBrowserParticipants } from "./host-lifetime.mjs";
import { fixture, missing, stat } from "./test-fixtures/host-lifetime-observer.mjs";

const id = "4f".repeat(32), other = "5e".repeat(32), image = "sha256:" + "b".repeat(64);
const scope = (container) => `/system.slice/docker-${container}.scope`;
const zero = "0001-01-01T00:00:00Z";

async function exitTransition(t, { change = () => {}, path = "stat", code = "ENOENT",
  finishDelay = 0, wakeOffset = 0, inspectMs = 0, closing = false, census, censusRace = false,
  censusEvents = "populated 0\nfrozen 0\n", lostCgroup, groupReturns = false, secondLookupError = false,
  lateAncestor, lookupMs = 0, scopeLossAfter = 0 } = {}) {
  let faults = 0, phase = 0, missingAt, pinsAfterExit, censuses = 0, scopeRechecked = false, scopeReads = 0;
  const procReads = [], inspections = [], waits = [];
  const f = await fixture(t, [], true, () => { faults++; });
  Atomics.wait.mock.mockImplementation((_array, _index, _value, ms) => {
    waits.push(ms);
    f.clock += ms + wakeOffset;
    return "timed-out";
  });
  const started = new Date(Date.now() - 5000).toISOString();
  const running = { Id: id, Image: image, RestartCount: 0, State: {
    Status: "running", Running: true, Pid: 5000, Paused: false, Restarting: false,
    OOMKilled: false, Dead: false, ExitCode: 0, StartedAt: started, FinishedAt: zero,
  } };
  const stopped = structuredClone(running);
  Object.assign(stopped.State, { Running: false, Pid: 0, Status: "removing", ExitCode: 137 });
  f.docker = (argv) => {
    if (argv.includes("ls")) return phase === 3 ? "" : id;
    assert.deepEqual(argv.slice(-3), ["container", "inspect", id]);
    if (phase !== 1) return JSON.stringify([phase === 2 ? stopped : running]);
    const elapsed = f.clock - missingAt;
    const row = structuredClone(inspections.length && elapsed >= finishDelay ? stopped : running);
    inspections.push([elapsed, row.State.Status]);
    f.clock += inspectMs;
    return JSON.stringify((inspections.length > 1 ? change(row, inspections.length) : undefined) ?? [row]);
  };
  f.cgroupStat = (name, options, path) => {
    if (phase !== 1 || !lostCgroup) return;
    if (name === "/sys/fs/cgroup/system.slice" && options?.throwIfNoEntry === false) {
      if (lateAncestor === "missing" || (lateAncestor === "after-leaf" && scopeRechecked)) return null;
      if (lateAncestor === "replacement") return { isDirectory: () => true, dev: 1, ino: 2 };
    }
    if (name !== "/sys/fs/cgroup" + (lostCgroup === "parent" ? "/system.slice" : scope(id))) return;
    if (options?.throwIfNoEntry === false) {
      scopeRechecked = true;
      f.clock += lookupMs;
      if (secondLookupError) throw missing("EIO");
      return groupReturns ? undefined : null;
    }
    if (scopeReads++ < scopeLossAfter) return;
    throw Object.assign(missing(lostCgroup === "denied" ? "EACCES" : "ENOENT"), { path });
  };
  f.override = (name) => {
    const root = "/sys/fs/cgroup" + scope(id);
    if (name === root + "/cgroup.procs") {
      if (phase === 1 && censusRace && censuses++ === 0) return "5001\n";
      return phase === 1 && census !== undefined ? census : "5000\n";
    }
    if (name === root + "/cgroup.events" && phase === 1 && census !== undefined) {
      if (censusEvents === null) throw missing("ENOENT");
      return censusEvents;
    }
    if (name === root + "/cpu.max") return "100000 100000\n";
    if (name === root + "/memory.max") return "100\n";
    const pid = /^\/proc\/(500[01])\//.exec(name)?.[1];
    if (pid === undefined) return;
    if (phase === 1) {
      procReads.push(name);
      if (censusRace && name === "/proc/5001/stat") throw missing("ENOENT");
      if (!closing && census === undefined && name === "/proc/5000/" + path) throw missing(code);
    }
    if (name.endsWith("/cgroup")) return "0::" + scope(id) + "\n";
    if (name.endsWith("/stat")) return stat(Number(pid));
  };
  f.clock += 100; await f.tick();
  const live = f.samples().at(-1);
  assert.ok(live.docker.participants[0].kernel);
  phase = 1;
  if (closing) f.nextPid = 5000;
  missingAt = f.clock += 100;
  stopped.State.FinishedAt = new Date(Date.now() + finishDelay).toISOString();
  await f.tick();
  const exit = f.samples().at(-1);
  pinsAfterExit = f.held.size;
  phase = 2; f.clock = missingAt + 100; await f.tick();
  const removing = f.samples().at(-1);
  phase = 3; f.clock += 100; await f.tick();
  const absent = f.samples().at(-1);
  const replay = await f.finish();
  return { f, faults, inspections, waits, procReads, live, exit, removing, absent, stopped, replay, pinsAfterExit };
}

test("r104 exit: a stable empty census can be closed by the same Docker generation", async (t) => {
  const { f, faults, inspections, waits, live, exit, stopped, replay } =
    await exitTransition(t, { census: "", finishDelay: 60, inspectMs: 2 });
  assert.ok(live.docker.participants[0].kernel);
  assert.deepEqual(inspections, [[0, "running"], [2, "running"], [70, "removing"]]);
  assert.deepEqual(waits, [66]);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [], participants: [{
    startedAt: exit.at, endedAt: exit.at + 72, container: {
      id, imageId: image, restartCount: 0, state: stopped.State,
    }, kernel: null,
  }] });
  assert.equal(faults, 0);
  assert.equal(f.terminal.firstDockerGap, undefined);
  assert.equal(replay.status, "verified");
});

test("r110 exit: a vanished cgroup closes only on the stopped same Docker generation", async (t) => {
  const { f, faults, live, exit, stopped, inspections, waits, replay } =
    await exitTransition(t, { path: "no-failure", lostCgroup: "root", finishDelay: 50 });
  assert.ok(live.docker.participants[0].kernel);
  assert.deepEqual(inspections, [[0, "running"], [0, "running"], [70, "removing"]]);
  assert.deepEqual(waits, [70]);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [], participants: [{
    startedAt: exit.at, endedAt: exit.at + 70, container: {
      id, imageId: image, restartCount: 0, state: stopped.State,
    }, kernel: null,
  }] });
  assert.equal(faults, 0);
  assert.equal(f.terminal.firstDockerGap, undefined);
  assert.equal(replay.status, "verified");
});

for (const [reason, options, expectedInspects, operation, code] of [
  ["the cgroup returns", { groupReturns: true }, 2, "cgroup-read", "ENOENT"],
  ["the second cgroup lookup fails", { secondLookupError: true }, 2, "cgroup-read", "ENOENT"],
  ["Docker no longer has the exact container", { change: () => [] }, 2, "cgroup-read", "ENOENT"],
  ["Docker reports a different generation", { change: (row) => { row.RestartCount++; } }, 2, "cgroup-read", "ENOENT"],
  ["the first confirmation would run at the deadline", { inspectMs: 75 }, 1, "cgroup-read", "ENOENT"],
  ["the closing inspect reaches the deadline", { inspectMs: 40 }, 2, "cgroup-read", "ENOENT"],
  ["the leaf lookup reaches the deadline", { lookupMs: 75 }, 2, "cgroup-read", "ENOENT"],
  ["an opening ancestor is missing at confirmation", { lateAncestor: "missing" }, 2, "cgroup-read", "ENOENT"],
  ["an opening ancestor is replaced at confirmation", { lateAncestor: "replacement" }, 2, "cgroup-read", "ENOENT"],
  ["an opening ancestor disappears after the leaf check", { lateAncestor: "after-leaf" }, 2, "cgroup-read", "ENOENT"],
  ["a cgroup ancestor is missing", { lostCgroup: "parent" }, 1, undefined, "ENOENT"],
  ["the scope read is denied", { lostCgroup: "denied" }, 1, "cgroup-read", "EACCES"],
]) test("r110 exit: keeps the original gap when " + reason, async (t) => {
  const { f, faults, exit, inspections } =
    await exitTransition(t, { path: "no-failure", lostCgroup: "root", ...options });
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [id], participants: [] });
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "kernel-census", ...(operation && { operation }), code });
  assert.equal(inspections.length, expectedInspects);
  assert.equal(faults, 1);
});

for (const [label, options, expectedWaits] of [
  ["the closing census loses the scope after excluding the entry PID", { census: "5001\n" }, []],
  ["a retry loses the scope after a member stat failed", { census: "", censusRace: true }, [1]],
]) test(`r110 exit: keeps the census gap when ${label}`, async (t) => {
  const { f, faults, exit, inspections, procReads, waits } =
    await exitTransition(t, { lostCgroup: "root", scopeLossAfter: 1, ...options });
  assert.ok(procReads.includes("/proc/5001/stat"));
  assert.deepEqual(waits, expectedWaits);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [id], participants: [] });
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "kernel-census", operation: "cgroup-read", code: "ENOENT" });
  assert.deepEqual(inspections, [[0, "running"]]);
  assert.equal(faults, 1);
});

for (const [label, options, n] of [
  ["cgroup.events still reports populated 1", { censusEvents: "populated 1\nfrozen 0\n" }, 1],
  ["cgroup.events is missing", { censusEvents: null }, 1],
  ["cgroup.events has conflicting populated rows", { censusEvents: "populated 0\npopulated 1\n" }, 1],
  ["another process is in the census", { census: "5001\n" }, 1],
  ["a failed nonempty census retries to empty", { censusRace: true }, 1],
  ["the closing inspect reports a different generation", { finishDelay: 0, change: (c) => { c.RestartCount++; } }, 2],
  ["the confirmation would start at its deadline", { inspectMs: 75 }, 1],
]) test(`r104 exit: preserves the census gap when ${label}`, async (t) => {
  const { f, faults, inspections, exit, procReads, waits } = await exitTransition(t, { census: "", ...options });
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [id], participants: [] });
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "kernel-census", code: "ERR_ASSERTION" });
  assert.equal(faults, 1);
  assert.equal(inspections.length, n);
  if (options.censusRace) {
    assert.ok(procReads.includes("/proc/5001/stat"));
    assert.deepEqual(waits, [1]);
  }
});

test("closing inspect can prove an exit of the same Docker generation without retaining its partial kernel census", async (t) => {
  const { f, faults, live, exit, stopped, inspections, waits, pinsAfterExit } = await exitTransition(t, { closing: true });
  assert.ok(live.docker.participants[0].kernel);
  assert.deepEqual(inspections, [[0, "running"], [0, "removing"]]);
  assert.deepEqual(waits, []);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [], participants: [{
    startedAt: exit.at, endedAt: exit.at, container: { id, imageId: image, restartCount: 0, state: stopped.State }, kernel: null,
  }] });
  assert.equal(pinsAfterExit, 1, "the executable only seen in the abandoned census was not pinned");
  assert.equal(faults, 0);
  assert.equal(f.terminal.firstDockerGap, undefined);
});

for (const [label, change] of [
  ["is absent", () => []],
  ["has a different generation", (row) => { row.RestartCount++; }],
  ["has no valid finish", (row) => { row.State.FinishedAt = zero; }],
]) test(`closing inspect stays a gap if the Docker participant ${label}`, async (t) => {
  const { f, faults, exit, pinsAfterExit } = await exitTransition(t, { closing: true, change });
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [id], participants: [] });
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "inspect-close", code: "ERR_ASSERTION" });
  assert.equal(pinsAfterExit, 1);
  assert.equal(faults, 1);
});

test("r95 exit: a missing opening stat followed by the same removing container is a stopped sample", async (t) => {
  const { f, faults, inspections, waits, procReads, exit, stopped } = await exitTransition(t);
  assert.deepEqual(f.terminal.firstDockerGap, undefined, "the exit does not create a sticky Docker gap");
  assert.equal(faults, 0);
  assert.deepEqual(inspections, [[0, "running"], [0, "removing"]]);
  assert.deepEqual(waits, []);
  assert.deepEqual(procReads, ["/proc/5000/stat"]);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [], participants: [{
    startedAt: exit.at, endedAt: exit.at, container: {
      id, imageId: image, restartCount: 0, state: stopped.State,
    }, kernel: null,
  }] });
});

test("r95 exit: a +60 ms finish replays in the original sample after one bounded pause", async (t) => {
  const { f, faults, inspections, waits, procReads, live, exit, removing, absent, stopped, replay } =
    await exitTransition(t, { finishDelay: 60, inspectMs: 2 });
  assert.deepEqual(inspections, [[0, "running"], [2, "running"], [70, "removing"]]);
  assert.deepEqual(waits, [66]);
  assert.deepEqual(procReads, ["/proc/5000/stat"]);
  assert.equal(faults, 0);
  assert.equal(f.terminal.firstDockerGap, undefined);
  assert.equal(Object.hasOwn(f.terminal, "dockerStartupRechecks"), false);
  assert.equal(removing.at - exit.at, 100);
  assert.equal(absent.at - exit.at, 200);
  assert.equal(Date.parse(stopped.State.FinishedAt) - exit.at, 60);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [], participants: [{
    startedAt: exit.at, endedAt: exit.at + 72, container: {
      id, imageId: image, restartCount: 0, state: stopped.State,
    }, kernel: null,
  }] });
  assert.deepEqual(removing.docker.participants[0].container, exit.docker.participants[0].container);
  assert.deepEqual(absent.docker, { inventory: [], participants: [], gaps: [] });
  const sampleWindow = { startedAt: live.at, endedAt: exit.docker.participants[0].endedAt };
  const subject = { schema: "native-browser-host-subject/v2", executionWindow: sampleWindow, participants: [{
    id, imageId: image, role: "application", window: sampleWindow, terminal: {
      ...exit.docker.participants[0].container, state: { ...stopped.State, Status: "exited" },
      limits: { NanoCpus: 1e9, Memory: 100 },
    },
  }] };
  assert.equal(replay.status, "verified");
  assert.equal(inspectBrowserParticipants(subject, replay), true);
  replay.samples.find((s) => s.at === removing.at).docker.participants[0].container.state.FinishedAt = zero;
  subject.participants[0].terminal.state.FinishedAt = zero;
  assert.throws(() => inspectBrowserParticipants(subject, replay));
});

test("r95 exit: an exited inspect can also corroborate the missing opening stat", async (t) => {
  const { f, faults, inspections, waits, exit } = await exitTransition(t, {
    change: (c) => { c.State.Status = "exited"; },
  });
  assert.equal(faults, 0);
  assert.equal(inspections.length, 2);
  assert.deepEqual(waits, []);
  assert.equal(f.terminal.firstDockerGap, undefined);
  assert.equal(exit.docker.participants[0].container.state.Status, "exited");
  assert.equal(exit.docker.participants[0].kernel, null);
});

for (const [label, options, expectedInspections, stage = "process-identity-open"] of [
  ["disappears", { change: () => [] }, 2],
  ["inspect errors", { change: () => { throw missing("EIO"); } }, 2],
  ["has a different ID", { change: (c) => { c.Id = other; } }, 2],
  ["has a different image", { change: (c) => { c.Image = "sha256:" + "c".repeat(64); } }, 2],
  ["has a different start", { change: (c) => { c.State.StartedAt = c.State.FinishedAt; } }, 2],
  ["has a different restart count", { change: (c) => { c.RestartCount++; } }, 2],
  ["is running", { change: (c) => { Object.assign(c.State, { Running: true, Status: "running", Pid: 5000 }); } }, 2],
  ["is restarting", { change: (c) => { c.State.Restarting = true; } }, 2],
  ["still has a PID", { change: (c) => { c.State.Pid = 5000; } }, 2],
  ["has a nonterminal status", { change: (c) => { c.State.Status = "created"; } }, 2],
  ["has a zero finish", { change: (c) => { c.State.FinishedAt = zero; } }, 2],
  ["has an impossible date", { change: (c) => { c.State.FinishedAt = "2026-02-29T00:00:00Z"; } }, 2],
  ["has a finish before the sample", { change: (c) => { c.State.FinishedAt = c.State.StartedAt; } }, 2],
  ["has a future finish", { change: (c) => { c.State.FinishedAt = "2026-11-26T01:00:00Z"; } }, 2],
  ["has an inaccessible stat", { code: "EACCES" }, 1],
  ["loses a later proc read", { path: "cgroup" }, 1, "process-cgroup-open"],
]) test(`r95 exit: ${label} remains a gap`, async (t) => {
  const { f, faults, inspections, waits, exit } = await exitTransition(t, options);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [id], participants: [] });
  assert.deepEqual(f.terminal.firstDockerGap, { stage, code: options.code ?? "ENOENT" });
  assert.equal(faults, 1);
  assert.equal(inspections.length, expectedInspections);
  assert.deepEqual(waits, []);
});

for (const [label, options, expectedInspections, expectedWaits] of [
  ["the pause oversleeps the deadline", { finishDelay: 60, wakeOffset: 6 }, 2, [70]],
  ["the pause wakes too early", { finishDelay: 60, wakeOffset: -20 }, 2, [70]],
  ["the first reinspection spends the deadline", { finishDelay: 74, inspectMs: 40 }, 2, []],
  ["the first reinspection shows a different running PID", { finishDelay: 60,
    change: (c) => { c.State.Pid++; } }, 2, []],
  ["the first reinspection has malformed running state", { finishDelay: 60,
    change: (c) => { delete c.State.OOMKilled; } }, 2, []],
  ["the final inspect is still running", { finishDelay: 95 }, 3, [70]],
  ["the final inspect shows a different generation", { finishDelay: 60,
    change: (c, attempt) => { if (attempt === 3) c.RestartCount++; } }, 3, [70]],
]) test(`r95 exit: preserves the gap when ${label}`, async (t) => {
  const { f, faults, inspections, waits, exit } = await exitTransition(t, options);
  assert.deepEqual(exit.docker, { inventory: [id], gaps: [id], participants: [] });
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "process-identity-open", code: "ENOENT" });
  assert.equal(faults, 1);
  assert.equal(inspections.length, expectedInspections);
  assert.deepEqual(waits, expectedWaits);
});

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
