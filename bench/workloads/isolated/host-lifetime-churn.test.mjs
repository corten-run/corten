// Synthetic kernel reads exercise the real collector on Windows and Linux.
// They establish snapshot consistency, not native host qualification.
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess, { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { storageLimits } from "./host-durable-writer.mjs";
import { beginLifetime, captureBrowserParticipant, inspectBrowserParticipants, processIdentity } from "./host-lifetime.mjs";
import { participantExecutables } from "./participant-executables.mjs";
import { browserCpus } from "../../fullstack-browser/contract.mjs";
import { fixture, missing, parent, stat } from "./test-fixtures/host-lifetime-observer.mjs";

test("browser startup sets the owned child cpuset and rejects a narrower kernel readback before attachment", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(() => { t.mock.restoreAll(); Object.defineProperty(process, "platform", platform); syncBuiltinESMExports(); });
  const path = (value) => String(value).replaceAll("\\", "/");
  const root = `/sys/fs/cgroup${parent}`, actions = [];
  let owned;
  t.mock.method(childProcess, "execFileSync", (_file, args) => {
    assert.deepEqual(args, ["--host", "unix:///var/run/docker.sock", "container", "ls", "-aq", "--no-trunc"]); return "";
  });
  t.mock.method(fs, "readFileSync", (file) => {
    switch (path(file)) {
      case "/proc/self/cgroup": return `0::${parent}/supervisor\n`;
      case `${root}/cgroup.procs`: return "";
      case `${root}/cgroup.subtree_control`: return "cpu cpuset memory\n";
      case `${owned}/cpuset.cpus.effective`: actions.push("readback"); return "4-5\n";
      default: assert.fail("unexpected startup read");
    }
  });
  t.mock.method(fs, "mkdirSync", (file) => {
    owned = path(file); assert.match(owned, /\/native-0-[a-f0-9]{16}$/); assert.equal(owned.slice(0, owned.lastIndexOf("/")), root);
  });
  t.mock.method(fs, "lstatSync", (file) => { assert.equal(path(file), owned); return { isSymbolicLink: () => false }; });
  t.mock.method(fs, "writeFileSync", (file, value) => {
    assert.equal(path(file), `${owned}/cpuset.cpus`); assert.equal(value, "4-7"); actions.push("pin");
  });
  t.mock.method(fs, "rmdirSync", (file) => { assert.equal(path(file), owned); actions.push("removed-owned-empty-group"); });
  syncBuiltinESMExports();
  await assert.rejects(beginLifetime({ campaign: "r21-0123456789abcdef", binding: { request: { group: "fullstack-browser" },
    resources: { browserCpus }, execution: { effectiveOptions: { isolated: true } } }, command: 0, pid: 4242 }), /effective cpuset differs/);
  assert.deepEqual(actions, ["pin", "readback", "removed-owned-empty-group"]);
});

// Synthetic membership/Docker reads, real owned executable inodes/descriptors.
// Linux runs the actual inherited-descriptor digest helper; Windows emulates it.
function pendingFixture(t) {
  const original = Object.fromEntries(["readFileSync", "statSync", "lstatSync", "readdirSync", "openSync", "closeSync"]
    .map((key) => [key, fs[key]]));
  const exec = childProcess.execFileSync, platform = Object.getOwnPropertyDescriptor(process, "platform");
  const directory = fs.mkdtempSync(join(tmpdir(), "host-pending-churn-")), files = new Map(), held = new Set();
  for (const pid of [4242, ...Array.from({ length: 7 }, (_, i) => 5000 + i)]) {
    const path = join(directory, String(pid)); fs.writeFileSync(path, `executable ${pid}`); files.set(pid, path);
  }
  const id = "a".repeat(64), scope = `/system.slice/docker-${id}.scope`, pending = participantExecutables();
  const f = { pending, held, attempt: 0, census: 0, clock: 0, peak: 0, hashInputs: [], inspect() {}, read() {},
    observe: () => captureBrowserParticipant(id, new Map(), pending) };
  const proc = (path) => /^\/proc\/(\d+)\/(stat|cgroup|cmdline|exe)$/.exec(String(path).replaceAll("\\", "/"));
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(() => {
    try { pending.close(); }
    finally {
      t.mock.restoreAll(); Object.defineProperty(process, "platform", platform); syncBuiltinESMExports();
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); fs.rmSync(directory, { recursive: true });
    }
    assert.equal(held.size, 0);
  });
  t.mock.method(Date, "now", () => f.clock);
  t.mock.method(performance, "now", () => f.clock);
  t.mock.method(Atomics, "wait", (_a, _b, _c, ms) => { f.clock += ms; return "timed-out"; });
  t.mock.method(childProcess, "execFileSync", (file, argv, options) => {
    if (argv[1] === "--hash-open-executables") {
      f.hashInputs = JSON.parse(options.input);
      if (f.hashFailure) throw f.hashFailure;
      if (f.hashReply !== undefined) return f.hashReply;
      if (platform.value === "linux") return exec(file, ["--max-old-space-size=256", ...argv], options);
      return JSON.stringify(f.hashInputs.map((entry, i) => ({ ...entry,
        sha256: createHash("sha256").update(original.readFileSync(options.stdio[i + 3])).digest("hex") })));
    }
    assert.deepEqual(argv, ["--host", "unix:///var/run/docker.sock", "container", "inspect", id]);
    f.inspect();
    return JSON.stringify([{ Id: id, Image: `sha256:${"b".repeat(64)}`, RestartCount: 0,
      State: { Status: "running", Pid: 4242, Running: true, Paused: false, Restarting: false, OOMKilled: false,
        Dead: false, ExitCode: 0, StartedAt: "start", FinishedAt: "end" } }]);
  });
  t.mock.method(fs, "readFileSync", (path, ...args) => {
    const text = String(path).replaceAll("\\", "/"), match = proc(path);
    f.read(text);
    if (match) {
      const pid = Number(match[1]);
      if (match[2] === "stat") return stat(pid);
      if (match[2] === "cgroup") return `0::${scope}\n`;
      if (match[2] === "cmdline") return Buffer.from("node\0");
    }
    if (text === "/proc/sys/kernel/random/boot_id") return "boot";
    if (text.startsWith("/sys/fs/cgroup")) {
      const key = text.slice(text.lastIndexOf("/") + 1);
      if (key === "cgroup.procs") {
        if (text !== `/sys/fs/cgroup${scope}/cgroup.procs`) return "";
        if (++f.census % 2 === 0 && f.attempt < 6) f.attempt++;
        return `4242\n${5000 + f.attempt}\n`;
      }
      return { "cgroup.events": "populated 1\n", "cpu.stat": `usage_usec ${f.attempt + 1}\n`, "cpu.max": "100000 100000\n",
        "cpuset.cpus.effective": "0\n", "memory.current": "10\n", "memory.peak": "20\n", "memory.max": "1000\n", "memory.events": "oom_kill 0\n" }[key];
    }
    return original.readFileSync(path, ...args);
  });
  t.mock.method(fs, "openSync", (path, ...args) => {
    const match = proc(path);
    if (match?.[2] !== "exe") return original.openSync(path, ...args);
    const fd = original.openSync(files.get(Number(match[1])), ...args); held.add(fd); f.peak = Math.max(f.peak, held.size); return fd;
  });
  t.mock.method(fs, "closeSync", (fd) => { held.delete(fd); return original.closeSync(fd); });
  t.mock.method(fs, "statSync", (path, ...args) => {
    const match = proc(path); return original.statSync(match?.[2] === "exe" ? files.get(Number(match[1])) : path, ...args);
  });
  t.mock.method(fs, "lstatSync", (path, ...args) => String(path).replaceAll("\\", "/").startsWith("/sys/fs/cgroup")
    ? { isSymbolicLink: () => false } : original.lstatSync(path, ...args));
  t.mock.method(fs, "readdirSync", (path, ...args) => String(path).replaceAll("\\", "/").startsWith("/sys/fs/cgroup") ? [] : original.readdirSync(path, ...args));
  syncBuiltinESMExports();
  f.digest = (pid) => createHash("sha256").update(original.readFileSync(files.get(pid))).digest("hex");
  f.mutate = (pid) => fs.writeFileSync(files.get(pid), "changed executable bytes");
  return f;
}

for (const prior of [false, true]) test(`rejected pending snapshots release descriptors and hash inputs; earlier accepted input ${prior}`, (t) => {
  const f = pendingFixture(t), accepted = prior ? f.pending.capture(5000) : null;
  const priorFD = prior ? [...f.held][0] : null, observed = f.observe();
  assert.equal(f.attempt, 6); assert.equal(observed.kernel.processes.length, 2);
  assert.equal(f.held.size, prior ? 3 : 2);
  assert.ok(f.peak <= (prior ? 4 : 3), "descriptor bound includes only prior proof, current attempt and one duplicate open");
  if (prior) { assert.ok(f.held.has(priorFD)); assert.ok(fs.fstatSync(priorFD).isFile()); }
  const refs = new Set(observed.kernel.processes.map((p) => p.executableRef)); if (prior) refs.add(accepted.executableRef);
  const proof = f.pending.finish();
  assert.deepEqual(new Set(proof.executables.map((p) => p.ref)), refs);
  assert.deepEqual(new Set(f.hashInputs.map((p) => p.ref)), refs);
  for (const pid of [4242, 5006, ...(prior ? [5000] : [])]) assert.ok(proof.executables.some((p) => p.sha256 === f.digest(pid)));
  assert.equal(f.held.size, 0);
});

test("rejected enclosing Docker bookend releases committed snapshot captures but preserves earlier proof", (t) => {
  const f = pendingFixture(t), accepted = f.pending.capture(5000), [fd] = f.held;
  let inspections = 0; f.inspect = () => { if (++inspections === 2) throw missing("EIO"); };
  assert.throws(f.observe, { code: "EIO" }); assert.equal(f.attempt, 6);
  assert.deepEqual([...f.held], [fd]);
  const proof = f.pending.finish(); assert.equal(proof.executables.length, 1);
  assert.equal(proof.executables[0].ref, accepted.executableRef); assert.equal(proof.executables[0].sha256, f.digest(5000));
});

test("nonretryable read failure rolls back a partially captured attempt", (t) => {
  const f = pendingFixture(t); f.read = (path) => { if (path === "/proc/5000/cmdline") throw missing("EACCES"); };
  assert.throws(f.observe, { code: "EACCES" }); assert.equal(f.held.size, 0);
  assert.deepEqual(f.pending.finish().executables, []);
});

test("a complete pending retry beyond the deadline rolls back all its captures", (t) => {
  const f = pendingFixture(t);
  f.read = (path) => { if (f.attempt === 6 && path === "/proc/5006/cmdline") f.clock += 1001; };
  assert.throws(f.observe, { code: "ERR_ASSERTION" }); assert.equal(f.held.size, 0);
  assert.deepEqual(f.pending.finish().executables, []);
});

test("nested capture rollback preserves accepted descriptors and rejects premature finish", (t) => {
  const f = pendingFixture(t), accepted = f.pending.capture(4242), [fd] = f.held;
  assert.throws(() => f.pending.transaction(() => {
    f.pending.capture(4242);
    f.pending.transaction(() => f.pending.capture(5000));
    assert.throws(() => f.pending.finish(), { code: "ERR_ASSERTION" });
    throw missing("EIO");
  }), { code: "EIO" });
  assert.deepEqual([...f.held], [fd]);
  const proof = f.pending.finish(); assert.equal(proof.executables.length, 1);
  assert.equal(proof.executables[0].ref, accepted.executableRef); assert.equal(proof.executables[0].sha256, f.digest(4242));
});

test("a catalog executable recheck rejects an inconsistent reference before stat", (t) => {
  const f = pendingFixture(t), accepted = f.pending.capture(4242), operations = [];
  const stats = fs.statSync.mock;
  assert.ok(stats.calls.some(({ arguments: [path] }) => path === "/proc/4242/exe"));
  stats.resetCalls();
  assert.throws(() => f.pending.recheck(4242, { ...accepted, executableRef: "0".repeat(64) }, (operation, action) => {
    operations.push(operation); return action();
  }), { code: "ERR_ASSERTION" });
  assert.equal(stats.callCount(), 0, "reference mismatch must not stat the executable again");
  assert.deepEqual(operations, ["executable-recheck-reference"]);
});

test("a rejected-only executable can subsequently be accepted with a live descriptor", (t) => {
  const f = pendingFixture(t); f.observe(); assert.equal(f.held.size, 2);
  const accepted = f.pending.transaction(() => f.pending.capture(5000));
  assert.equal(f.held.size, 3);
  const proof = f.pending.finish(); assert.equal(proof.executables.length, 3);
  const entry = proof.executables.find((p) => p.ref === accepted.executableRef);
  assert.equal(entry.sha256, f.digest(5000)); assert.equal(f.held.size, 0);
});

test("rollback cannot hide mutation of an earlier accepted executable", (t) => {
  const f = pendingFixture(t); f.pending.capture(5000); f.mutate(5000); f.observe();
  assert.equal(f.held.size, 3);
  assert.throws(() => f.pending.finish()); assert.equal(f.held.size, 0);
});

for (const failure of ["helper-error", "invalid-json"]) test(`failed executable finish closes every accepted descriptor: ${failure}`, (t) => {
  const f = pendingFixture(t); f.observe(); assert.equal(f.held.size, 2);
  if (failure === "helper-error") f.hashFailure = missing("EIO"); else f.hashReply = "not a proof";
  assert.throws(() => f.pending.finish()); assert.equal(f.held.size, 0);
  assert.throws(() => f.pending.finish(), { code: "ERR_ASSERTION" });
  f.pending.close(); assert.equal(f.held.size, 0);
});

test("catalog pins a newly seen executable inside the remaining continuity budget and seals its exact bytes at finish", async (t) => {
  let faults = 0, reads = 0;
  const f = await fixture(t, [], false, () => faults++, 0, true);
  f.clock += 700;
  f.members.push(5000); f.nextPid = 5000;
  f.readExecutable = (path) => {
    if (path === "/proc/5000/exe") { reads++; f.clock += 450; }
  };
  await f.tick();
  assert.equal(faults, 0, "first-sighting executable bytes must not consume the sampling deadline");
  assert.equal(reads, 0);
  assert.equal(f.held.size, 2);
  assert.throws(f.proof, { code: "ENOENT" });
  assert.equal(f.hasTerminal(), false);
  const sample = f.samples().at(-1);
  assert.equal(sample.at - f.samples().at(-2).at, 700);
  assert.equal(sample.groups[0].files["cgroup.procs"], "4242\n5000\n");
  const replay = await f.finish();
  assert.equal(replay.status, "verified"); assert.equal(f.terminal.empty, true);
  assert.ok(f.removed); assert.equal(f.held.size, 0);
  assert.deepEqual(replay.identities.map((p) => [p.pid, p.startTicks, p.executableSha256]), [
    [4242, "42420", createHash("sha256").update("original executable").digest("hex")],
    [5000, "50000", createHash("sha256").update("next executable").digest("hex")],
  ]);
});

for (const late of [true, false]) test(`catalog distinguishes ${late ? "late callback" : "slow census retries"} on a membership failure`, async (t) => {
  let faults = 0, reads = 0;
  const f = await fixture(t, [], false, () => faults++, 0, true);
  f.clock += late ? 1241 : 100;
  f.override = (path) => {
    if (path === `/sys/fs/cgroup${f.scope}/cgroup.procs` && ++reads % 2 === 0) {
      if (!late) {
        f.clock += 450;
        if (reads === 2) f.wallOffset += 5000; // Not elapsed census time.
      }
      return ""; // Closing census disagrees with the opening one.
    }
  };
  await f.tick();
  assert.equal(faults, 1); assert.equal(f.samples().length, 2);
  assert.equal((await f.finish()).status, "blocked"); assert.equal(f.terminal.empty, true);
  const { first, count } = f.terminal.observerFailures;
  assert.equal(count, 1); assert.equal(first.operation, "snapshot-membership-recheck");
  assert.equal(first.at - first.lastSampleAt, late ? 1241 : 6001);
  assert.deepEqual(first.catalogCensus, late
    ? { entryGapMs: 1241, censusMs: 0, attempts: 1 }
    : { entryGapMs: 100, censusMs: 901, attempts: 2 });
});

test("a listed catalog PID with an unreadable executable still blocks after an empty terminal", async (t) => {
  let faults = 0, attempts = 0;
  const f = await fixture(t, [], false, () => faults++, 0, true);
  f.clock += 995; f.members.push(5000);
  f.override = (path, operation) => {
    if (path === "/proc/5000/exe" && ["open", "link"].includes(operation)) { attempts++; throw missing(); }
  };
  await f.tick();
  assert.equal(faults, 1); assert.ok(attempts > 1); assert.equal(f.samples().length, 2);
  assert.equal((await f.finish()).status, "blocked"); assert.equal(f.terminal.empty, true);
  assert.equal(f.terminal.observerFailures.first.operation, "executable-capture");
  assert.equal(f.terminal.observerFailures.first.code, "ENOENT");
  assert.equal(f.held.size, 0);
});

for (const [field, operation] of [
  ["dev", "executable-recheck-inode"], ["ino", "executable-recheck-inode"],
  ["size", "executable-recheck-size-or-mtime"], ["mtimeNs", "executable-recheck-size-or-mtime"],
  ["ctimeNs", "executable-recheck-ctime"],
]) test(`catalog executable recheck distinguishes ${field} and still fails closed`, async (t) => {
  let faults = 0, reads = 0;
  const f = await fixture(t, [], false, () => faults++, 0, true), [acceptedFD] = f.held;
  f.clock += 100; f.members.push(5000); f.nextPid = 5000;
  f.executableStat = (path, info) => {
    if (path !== "/proc/5000/exe") return;
    // The first attempt loses the executable at its closing bookend. The
    // second gets a real comparison failure at the same step.
    if (++reads === 2) throw missing();
    if (reads === 4) return { ...info, [field]: info[field] + 1n };
  };
  await f.tick();
  assert.equal(reads, 4); assert.equal(faults, 1); assert.equal(f.samples().length, 2);
  assert.deepEqual([...f.held], [acceptedFD]);
  f.executableStat = undefined;
  await f.tick(); // A later complete sample cannot clear the first fault.
  assert.equal(f.samples().length, 3); assert.equal(f.held.size, 2);
  const replay = await f.finish();
  assert.equal(replay.status, "blocked"); assert.equal(replay.checks.accounting, true);
  assert.equal(replay.checks.empty, true); assert.equal(replay.checks.observer, false);
  const { first, last, count } = f.terminal.observerFailures;
  assert.equal(count, 1); assert.deepEqual(first, last);
  assert.equal(first.phase, "interval"); assert.equal(first.code, "ERR_ASSERTION");
  assert.equal(first.samples, 2);
  assert.deepEqual(first.catalogCensus, { entryGapMs: 100, censusMs: 1, attempts: 2 });
  assert.deepEqual(replay.identities.map((p) => [p.pid, p.executableSha256]), [
    [4242, createHash("sha256").update("original executable").digest("hex")],
    [5000, createHash("sha256").update("next executable").digest("hex")],
  ]);
  assert.equal(f.proof().executables.length, 2); assert.equal(f.held.size, 0);
  assert.equal(first.operation, operation);
});

for (const [code, attempts] of [["EACCES", 1], ["ENOENT", 6]]) test(`a catalog executable recheck ${code} read still blocks`, async (t) => {
  let faults = 0, reads = 0;
  const f = await fixture(t, [], false, () => faults++, 0, true);
  f.clock += 995;
  f.executableStat = (path) => { if (path === "/proc/4242/exe" && ++reads % 2 === 0) throw missing(code); };
  await f.tick();
  assert.equal(reads, attempts * 2); assert.equal(faults, 1); assert.equal(f.samples().length, 2);
  assert.equal((await f.finish()).status, "blocked");
  const { first, count } = f.terminal.observerFailures;
  assert.equal(count, 1); assert.equal(first.operation, "executable-recheck"); assert.equal(first.code, code);
  assert.deepEqual(first.catalogCensus, { entryGapMs: 995, censusMs: attempts - 1, attempts });
});

for (const outcome of ["stable", "gone", "start-changed", "different-image", "successor-mutated", "late", "missing-read"]) {
  test(`catalog admitted executable successor: ${outcome}`, async (t) => {
    let faults = 0, switched = false, openings = 0;
    const f = await fixture(t, [], false, () => faults++, 0, true);
    f.clock += 100;
    f.override = (path, operation) => {
      if (path === `/sys/fs/cgroup${f.scope}/cpu.stat`) {
        openings++;
        if (openings === 2) {
          if (outcome === "different-image") f.nextExecutable = false;
          if (outcome === "successor-mutated") f.mutateImage("new");
          if (outcome === "late") f.clock += 1000;
        }
      }
      if (path === "/proc/4242/stat" && openings === 2 && outcome === "start-changed") return stat(4242, "node", 9999);
      if (path === "/proc/4242/exe" && operation === "open" && openings === 2 && outcome === "missing-read") throw missing();
      if (path === "/proc/4242/cmdline" && !switched) {
        switched = true; f.nextExecutable = true;
        if (outcome === "gone") f.members = [];
      }
    };
    await f.tick();
    assert.equal(openings, 2); assert.equal(faults, outcome === "stable" ? 0 : 1);
    assert.equal(f.samples().length, outcome === "stable" ? 3 : 2);
    const replay = await f.finish();
    assert.equal(replay.status, outcome === "stable" ? "verified" : "blocked");
    assert.equal(f.proof().executables.length, outcome === "stable" ? 2 : 1);
    assert.equal(f.terminal.empty, true);
    if (outcome === "stable") {
      const digests = replay.samples.flatMap((s) => s.processes.map((p) => {
        assert.deepEqual(processIdentity(p.stat), { pid: 4242, startTicks: "42420", comm: "node" });
        return p.executableSha256;
      }));
      assert.deepEqual(digests, ["original executable", "next executable"].map((s) => createHash("sha256").update(s).digest("hex")));
    } else {
      const { first, count } = f.terminal.observerFailures;
      assert.equal(count, 1); assert.equal(first.catalogCensus.attempts, 2);
      assert.equal(first.operation, outcome === "missing-read" ? "executable-capture"
        : outcome === "late" ? "executable-recheck-inode" : "executable-recheck-successor");
    }
  });
}

for (const [mode, outcome] of [["prepare", "anchored"], ["prepare", "unanchored"], ["prepare", "wrong-image"],
  ["check-only-no-build", "anchored"], ["fixture", "anchored"], ["timing", "anchored"]]) {
  test(`JSON API ${mode} executable bookends: ${outcome}`, async (t) => {
    let faults = 0, openings = 0, switched = false;
    const f = await fixture(t, [], false, () => faults++, 0, false, mode);
    const pid = outcome === "unanchored" ? 5000 : 4242;
    if (pid !== 4242) f.members.push(pid);
    f.override = (path, operation) => {
      if (path === `/proc/${pid}/exe` && operation === "open" && ++openings === 2 && outcome === "wrong-image")
        f.nextExecutable = false;
      if (path === `/proc/${pid}/cmdline` && !switched) {
        switched = true; f.nextExecutable = true;
      }
      if (path === `/proc/${pid}/exe` && operation === "link" && switched) return "/bin/successor";
    };
    f.readExecutable = () => Buffer.from(switched ? "next executable" : "original executable");
    await f.tick(); assert.equal(switched, true);
    const replay = await f.finish();
    if (mode === "prepare" && outcome === "anchored") {
      assert.equal(faults, 0); assert.equal(replay.status, "verified");
      assert.equal(openings, 2); assert.equal(f.proof().executables.length, 2);
      assert.deepEqual(replay.samples.flatMap((s) => s.processes.map((p) => p.executableSha256)),
        ["original executable", "next executable"].map((s) => createHash("sha256").update(s).digest("hex")));
    } else {
      assert.equal(faults, 1); assert.equal(replay.status, "blocked");
      assert.equal(f.terminal.observerFailures.first.operation, mode !== "prepare" ? "executable-recheck"
        : outcome === "unanchored" ? "executable-recheck-inode" : "executable-recheck-successor");
      assert.equal(f.terminal.observerFailures.first.executableRecheckReason,
        mode === "prepare" ? undefined : mode === "check-only-no-build" ? "device-or-inode" : "link");
      if (mode === "prepare") assert.equal(f.proof().executables.length, 1);
    }
  });
}

for (const prior of ["mutated", "other-process"]) test(`catalog executable successor rejects ${prior} prior evidence`, async (t) => {
  let faults = 0, openings = 0;
  const f = await fixture(t, [], false, () => faults++, 0, true);
  const pid = prior === "mutated" ? 4242 : 5000;
  if (pid === 5000) f.members.push(pid); // Only the leader has an admitted record, for the same old inode.
  f.override = (path) => {
    if (path === `/sys/fs/cgroup${f.scope}/cpu.stat`) openings++;
    if (path === `/proc/${pid}/cmdline`) {
      if (prior === "mutated") f.mutateImage("old");
      f.nextPid = pid;
    }
  };
  await f.tick(); assert.equal(faults, 1); assert.equal(openings, 1); assert.equal(f.samples().length, 2);
  if (prior === "mutated") {
    await assert.rejects(f.finish); // No digest can seal the old accepted descriptor.
    assert.equal(f.terminal.observerFailures.first.operation, "executable-recheck-pin");
    assert.equal(f.terminal.observerError, "host-executable-proof-incomplete");
  } else {
    assert.equal((await f.finish()).status, "blocked");
    assert.equal(f.terminal.observerFailures.first.operation, "executable-recheck-inode");
    assert.equal(f.proof().executables.length, 1);
  }
});

for (const scenario of ["stable", "wrong-parent", "reparented", "parent-exited", "parent-reused", "parent-exec", "child-exited",
  "retry-opening-reparented", "retry-closing-reparented"]) {
  test(`catalog checks a newly forked child's inherited executable: ${scenario}`, async (t) => {
    const f = await fixture(t, [], false, undefined, 0, true);
    const parent = 4242, child = 5000;
    f.members.push(child);
    let replaced = false, childReads = 0;
    f.override = (path) => {
      if (path === `/proc/${child}/stat`) {
        childReads++;
        const retryReparented = (scenario === "retry-opening-reparented" && childReads === 3)
          || (scenario === "retry-closing-reparented" && childReads === 4);
        const ppid = scenario === "wrong-parent" || (scenario === "reparented" && replaced) || retryReparented ? 1 : parent;
        return stat(child, replaced ? "docker" : "node", child * 10, ppid);
      }
      if (path === `/proc/${parent}/stat` && replaced && scenario === "parent-reused") return stat(parent, "node", 100);
      if (path === `/proc/${child}/cmdline` && !replaced) {
        f.nextPid = child;
        replaced = true;
        if (scenario === "parent-exec") f.nextExecutable = true;
        if (scenario === "parent-exited") f.members = [child];
        if (scenario === "child-exited") f.members = [parent];
      }
    };
    await f.tick();
    const replay = await f.finish();
    assert.equal(replaced, true);
    assert.equal(replay.status, scenario === "stable" ? "verified" : "blocked");
    if (scenario.startsWith("retry-")) {
      assert.equal(childReads, 4);
      assert.equal(f.terminal.observerFailures.first.operation, "executable-recheck-successor");
      assert.equal(f.terminal.observerFailures.first.catalogCensus.attempts, 2);
    }
    if (scenario === "stable") {
      assert.equal(f.terminal.observerFailures.count, 0);
      assert.equal(f.proof().executables.length, 2);
      assert.ok(replay.samples.some((s) => s.processes.some((p) => processIdentity(p.stat).pid === child &&
        p.executableSha256 === createHash("sha256").update("next executable").digest("hex"))));
    }
  });
}

for (const scenario of ["admitted", "unseen", "successor-gone", "name-only", "unreadable", "pid-changed", "start-changed"]) {
  test(`catalog simultaneous name and executable bookends: ${scenario}`, async (t) => {
    const f = await fixture(t, [], false, undefined, 0, true);
    const pid = scenario === "unseen" ? 5000 : 4242;
    if (pid === 5000) f.members.push(pid);
    let renamed = false, openings = 0, firstExeStats = 0;
    f.override = (path) => {
      if (path === `/sys/fs/cgroup${f.scope}/cpu.stat`) openings++;
      if (path === `/proc/${pid}/cmdline` && !renamed) {
        renamed = true;
        if (scenario !== "name-only") f.nextPid = pid;
        if (scenario === "successor-gone") f.members = [];
      }
      if (path === `/proc/${pid}/stat` && renamed) return stat(scenario === "pid-changed" ? pid + 1 : pid,
        "new-name", scenario === "start-changed" ? 1234 : pid * 10);
    };
    f.executableStat = (path) => {
      if (path === `/proc/${pid}/exe` && openings === 1 && ++firstExeStats === 2 && scenario === "unreadable") throw missing();
    };
    await f.tick();
    const accepted = scenario === "name-only" || scenario === "admitted", hard = ["pid-changed", "start-changed"].includes(scenario);
    const replay = await f.finish(); assert.equal(replay.status, accepted ? "verified" : "blocked");
    assert.equal(firstExeStats, hard ? 1 : 2, "check PID/start before executable; check executable before retrying a rename");
    assert.equal(openings, accepted || scenario === "successor-gone" ? 2 : 1);
    if (accepted) {
      const rows = replay.samples.flatMap((s) => s.processes);
      assert.deepEqual(rows.map((p) => processIdentity(p.stat).comm), ["node", "new-name"]);
      assert.deepEqual(rows.map((p) => p.executableSha256),
        ["original executable", scenario === "name-only" ? "original executable" : "next executable"].map((s) => createHash("sha256").update(s).digest("hex")));
    } else {
      assert.equal(f.terminal.observerFailures.first.operation, {
        unseen: "executable-recheck-inode", "successor-gone": "executable-recheck-successor",
        unreadable: "executable-recheck-renamed", "pid-changed": "process-pid-changed", "start-changed": "process-start-changed",
      }[scenario]);
      assert.equal(f.proof().executables.length, 1);
    }
  });
}

test("a rejected pre-admission sample keeps prior accepted executable proof and releases only new captures", async (t) => {
  const f = await fixture(t, [], true), [acceptedFD] = f.held;
  assert.equal(f.held.size, 1);
  const samples = f.samples().length;
  f.nextExecutable = true;
  f.override = (path) => { if (path === "/proc/4242/cmdline") throw missing("ENOSPC"); };
  await f.tick();
  assert.equal(f.samples().length, samples); assert.deepEqual([...f.held], [acceptedFD]);
  assert.equal((await f.finish()).status, "blocked"); assert.equal(f.terminal.observerFailures.first.operation, "process-cmdline");
  assert.equal(f.terminal.observerFailures.first.code, "ENOSPC");
  const proof = f.proof(); assert.equal(proof.executables.length, 1);
  assert.equal(proof.executables[0].sha256, createHash("sha256").update("original executable").digest("hex"));
  assert.equal(f.held.size, 0);
});

test("failed enqueue admission rolls back only that sample's captures and preserves prior accepted executable inputs", async (t) => {
  const f = await fixture(t, [], true), [acceptedFD] = f.held;
  assert.equal(f.held.size, 1);
  const samples = f.samples().length;
  const entered = f.pauseWrite(); f.capture(); await entered;
  for (let i = 1; i < storageLimits.frames; i++) f.capture();
  f.nextExecutable = true; f.capture(); // The next frame is refused synchronously.
  assert.equal(f.samples().length, samples); assert.deepEqual([...f.held], [acceptedFD]);
  assert.equal(createHash("sha256").update(fs.readFileSync(acceptedFD)).digest("hex"),
    createHash("sha256").update("original executable").digest("hex"));
  f.releaseWrite(); await assert.rejects(f.drain(), { code: "ERR_ASSERTION" });
  await assert.rejects(f.finish(), { code: "ERR_ASSERTION" });
  assert.throws(f.proof, { code: "ENOENT" }); assert.equal(f.hasTerminal(), false); assert.notEqual(f.removed, true);
  assert.equal(f.held.size, 0);
});

test("a future sample write failure keeps admitted captures owned until sticky failed finish, never a seal", async (t) => {
  const f = await fixture(t, [], true), [acceptedFD] = f.held, samples = f.samples().length;
  assert.equal(f.held.size, 1);
  f.nextExecutable = true; f.failSampleWrite = true;
  await assert.rejects(f.tick(), { code: "ENOSPC", operation: "sample-write" });
  assert.equal(f.samples().length, samples); assert.equal(f.held.size, 2); assert.ok(f.held.has(acceptedFD));
  f.failSampleWrite = false;
  await assert.rejects(f.finish(), { code: "ENOSPC", operation: "sample-write" });
  assert.throws(f.proof, { code: "ENOENT" }); assert.equal(f.hasTerminal(), false); assert.notEqual(f.removed, true);
  assert.equal(f.held.size, 0);
});

test("an earlier sampling fault does not hide a later executable proof failure", async (t) => {
  const f = await fixture(t, [], true);
  f.override = (path) => { if (path === "/proc/4242/cmdline") throw missing("EIO"); };
  await f.tick();
  f.override = () => {}; f.failProofWrite = true;
  await assert.rejects(f.finish, { message: "host-executable-proof-incomplete: executable-proof-publish: ENOSPC" });
  assert.equal(f.terminal.observerFailures.first.operation, "process-cmdline");
  assert.equal(f.terminal.observerFailures.first.code, "EIO");
  assert.equal(f.terminal.observerFailures.last.phase, "executables");
  assert.equal(f.terminal.observerFailures.count, 2);
  assert.throws(f.proof, { code: "ENOENT" });
});

for (const [fault, operation, code] of [["failHash", "executable-hash-helper", "EIO"],
  ["failProofWrite", "executable-proof-publish", "ENOSPC"]]) test(`failed lifetime finish retains ${operation} and closes its descriptors`, async (t) => {
  const f = await fixture(t, [], true); assert.equal(f.held.size, 1); f[fault] = true;
  await assert.rejects(f.finish, { message: `host-executable-proof-incomplete: ${operation}: ${code}` });
  assert.equal(f.held.size, 0); assert.throws(f.proof, { code: "ENOENT" });
  assert.equal(f.terminal.observerError, "host-executable-proof-incomplete");
  assert.equal(f.terminal.observerFailures.count, 1);
  assert.equal(f.terminal.observerFailures.first.phase, "executables");
  assert.equal(f.terminal.observerFailures.first.operation, operation);
  assert.equal(f.terminal.observerFailures.first.code, code);
});

for (const operation of ["stat", "exe"]) test(`full snapshot recovers from six consecutive exited-PID ${operation} races`, async (t) => {
  const f = await fixture(t); let exits = 0;
  f.members = [4242, 5000];
  f.override = (path) => {
    if (path === `/proc/${5000 + exits}/${operation}` && exits < 6) {
      exits++; f.cpu++; f.members = [4242, 5000 + exits]; throw missing();
    }
    if (path === "/proc/4242/cmdline") return Buffer.from(`--type=${exits < 6 ? "utility" : "renderer"}\0`);
  };
  await f.tick();
  assert.equal(exits, 6); assert.equal(f.samples().length, 3);
  const accepted = f.samples().at(-1);
  assert.equal(accepted.groups[0].files["cpu.stat"], "usage_usec 16\n");
  assert.deepEqual(accepted.groups[0].files["cgroup.procs"], "4242\n5006\n");
  assert.ok(!f.records().some((p) => p.type === "--type=utility"), "discarded attempt metadata must not escape");
  assert.ok(!f.records().some((p) => processIdentity(p.stat).pid >= 5000 && processIdentity(p.stat).pid < 5006));
  assert.equal((await f.finish()).status, "verified"); assert.equal(f.terminal.observerFailures.count, 0);
});

test("a closing recursive census rejects membership changes after local process bookends", async (t) => {
  const f = await fixture(t); let changed = false;
  f.override = (path) => {
    if (!changed && path === `/sys/fs/cgroup${f.scope}/cgroup.procs` && f.reads.filter((p) => p === "/proc/4242/stat").length > 2) {
      changed = true; f.members.push(5000); f.children.push("child"); f.cpu++;
    }
  };
  await f.tick();
  assert.equal(changed, true); const sample = f.samples().at(-1);
  assert.equal(sample.groups.length, 2); assert.equal(sample.groups[0].files["cpu.stat"], "usage_usec 11\n");
  assert.equal(sample.processes.length, 2); assert.equal((await f.finish()).status, "verified");
});

test("six name-only changes require seven complete attempts, not mixed identities", async (t) => {
  const f = await fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === "/proc/4242/stat") return stat(4242, `name-${Math.min(6, Math.floor(++reads / 2))}`);
  };
  await f.tick(); assert.equal(reads, 14);
  assert.ok(!f.records().some((p) => /^name-[0-5]$/.test(processIdentity(p.stat).comm)));
  assert.equal((await f.finish()).status, "verified");
});

for (const code of ["EACCES", "EPERM", "EIO", "ENOENT", "ESRCH"]) test(`persistent ${code} cannot be hidden by a later clean empty scope`, async (t) => {
  const f = await fixture(t); let reads = 0;
  f.override = (path) => { if (path === "/proc/4242/stat") { reads++; throw missing(code); } };
  await f.tick();
  assert.equal(f.samples().length, 2);
  if (!["ENOENT", "ESRCH"].includes(code)) assert.equal(reads, 1, "permission and I/O failures are not churn");
  assert.ok(f.clock <= 11001, "retries stay within the existing sample gap, not a new retry count");
  assert.equal((await f.finish()).status, "blocked"); assert.equal(f.terminal.empty, true);
  assert.equal(f.terminal.observerError, "host-observation-gap"); assert.equal(f.terminal.observerFailures.count, 1);
  assert.equal(f.terminal.observerFailures.first.code, code);
  assert.equal(Object.hasOwn(f.terminal.observerFailures.first, "catalogCensus"), false);
});

for (const change of ["pid", "start"]) test(`${change} bookend mismatch still fails immediately`, async (t) => {
  const f = await fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === "/proc/4242/stat") return ++reads === 1 ? stat(4242) : stat(change === "pid" ? 4243 : 4242, "node", change === "start" ? 42421 : 42420);
  };
  await f.tick(); assert.equal(reads, 2); assert.equal((await f.finish()).status, "blocked");
  assert.equal(f.terminal.observerFailures.first.operation, change === "pid" ? "process-pid-changed" : "process-start-changed");
});

test("an executable link missing for a still-listed PID is not silently treated as exit", async (t) => {
  const f = await fixture(t);
  f.override = (path) => { if (path === "/proc/4242/exe") throw missing(); };
  await f.tick(); assert.equal(f.samples().length, 2); assert.equal((await f.finish()).status, "blocked");
  assert.equal(f.terminal.observerFailures.first.operation, "executable-link");
});

test("non-process ENOENT is not retried as process churn", async (t) => {
  const f = await fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === `/sys/fs/cgroup${f.scope}/cgroup.procs`) { reads++; throw missing(); }
  };
  await f.tick(); assert.equal(reads, 1); assert.equal((await f.finish()).status, "blocked");
});

test("backward wall-clock movement cannot renew a retry deadline", async (t) => {
  const f = await fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === "/proc/4242/stat") { reads++; f.wallOffset -= 100; throw missing(); }
  };
  await f.tick(); assert.ok(reads <= 1001); assert.ok(f.clock <= 11000);
  f.wallOffset = 0;
  assert.equal((await f.finish()).status, "blocked");
});

test("a late sample gets only the remaining continuity budget and failure does not renew it", async (t) => {
  const f = await fixture(t); let reads = 0;
  f.clock += 950;
  f.override = (path) => { if (path === "/proc/4242/stat") { reads++; throw missing(); } };
  await f.tick(); assert.equal(f.clock, 11000); assert.equal(reads, 51);
  await f.tick(); assert.equal(f.clock, 11000); assert.equal(reads, 52);
  assert.equal(f.samples().length, 2); assert.equal((await f.finish()).status, "blocked");
  assert.equal(f.terminal.observerFailures.count, 2);
});

test("a coherent 1909ms sampling gap stays accounting-blocked without inventing an observer error", async (t) => {
  let faults = 0;
  const f = await fixture(t, [], false, () => { faults++; }); f.clock += 1909; await f.tick();
  assert.equal(faults, 1); await f.tick(); assert.equal(faults, 1);
  const proof = await f.finish();
  assert.equal(proof.status, "blocked"); assert.equal(proof.checks.accounting, false);
  for (const key of ["terminal", "empty", "observer", "unforced", "leader"]) assert.equal(proof.checks[key], true);
  assert.equal(f.terminal.observerError, null); assert.equal(f.terminal.observerFailures.count, 0);
});

test("fault notification is one-shot and a throwing callback cannot escape the sampler", async (t) => {
  let faults = 0;
  const f = await fixture(t, [], false, () => { faults++; throw new Error("PRIVATE_CALLBACK_FAILURE"); });
  f.override = (path) => { if (path === "/proc/4242/stat") throw missing("EIO"); };
  await f.tick(); await f.tick(); assert.equal(faults, 1);
  f.override = () => {};
  const proof = await f.finish();
  assert.equal(proof.status, "blocked"); assert.equal(proof.checks.observer, false);
  assert.equal(f.terminal.observerFailures.count, 2);
  assert.equal(f.terminal.observerFailures.first.code, "EIO");
  assert.equal(f.terminal.observerFailures.last.code, "EIO");
  assert.ok(!JSON.stringify(f.terminal).includes("PRIVATE_CALLBACK_FAILURE"));
});

test("healthy observation never notifies and retains verified lifetime proof", async (t) => {
  let faults = 0;
  const f = await fixture(t, [], false, () => { faults++; });
  f.clock += 100; await f.tick();
  assert.equal((await f.finish()).status, "verified"); assert.equal(faults, 0);
});

for (const code of ["EIO", "PRIVATE_VENDOR_CODE"]) test("browser gaps retain only the first sanitized diagnostic: " +
  (code === "EIO" ? "allowlisted" : "unknown"), async (t) => {
  let faults = 0;
  const f = await fixture(t, [], true, () => { faults++; });
  const id = "c".repeat(64);
  let inspections = 0;
  f.docker = (argv) => {
    if (argv.includes("ls")) return id;
    assert.ok(argv.includes("inspect"));
    throw Object.assign(missing(inspections++ ? "ENOENT" : code), {
      stage: "PRIVATE_STAGE", stderr: "PRIVATE_DAEMON", stdout: "PRIVATE_STDOUT",
      argv: ["PRIVATE_ARGV"], path: "PRIVATE_PATH", env: { SAMPLE: "PRIVATE_ENV" },
    });
  };
  await f.tick(); const afterGap = faults;
  await f.tick(); const sample = f.samples().at(-1);
  const proof = await f.finish();
  assert.equal(afterGap, 1); assert.equal(faults, 1);
  assert.equal(sample.docker.gaps.length, 1); assert.equal(sample.docker.gaps[0], id);
  assert.equal(sample.docker.participants.length, 0);
  assert.equal(inspectBrowserParticipants({ schema: "native-browser-host-subject/v2", participants: [{ id }] }, proof), false);
  assert.equal(f.terminal.observerError, null); assert.equal(f.terminal.observerFailures.count, 0);
  assert.deepEqual(f.terminal.firstDockerGap, { stage: "inspect-open", code: code === "EIO" ? "EIO" : "unknown" });
  assert.ok(!JSON.stringify(f.terminal).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(f.samples()).includes("PRIVATE_"));
  assert.equal(f.held.size, 0);
});

for (const mode of ["startup transition", "stable startup", "persistent wrong PID"]) test("browser participant " + mode, async (t) => {
  let faults = 0;
  const f = await fixture(t, [], true, () => { faults++; });
  const id = "c".repeat(64), pid = 5000, scope = "/system.slice/docker-" + id + ".scope";
  let listed = true, running = false, statReads = 0, inspections = 0;
  f.docker = (argv) => {
    if (argv.includes("ls")) return listed ? id : "";
    assert.deepEqual(argv.slice(-2), ["inspect", id]); inspections++;
    return JSON.stringify([{ Id: id, Image: "sha256:" + "b".repeat(64), RestartCount: 0, State: {
      Status: running ? "running" : "created", Running: running, Pid: running ? pid : 0,
      StartedAt: running ? "start" : "zero", FinishedAt: "zero", OOMKilled: false, ExitCode: 0,
    } }]);
  };
  f.override = (path) => {
    if (path === "/sys/fs/cgroup" + scope + "/cgroup.procs") return pid + "\n";
    if (path === "/proc/5000/cgroup") return "0::" + scope + "\n";
    if (path === "/proc/5000/stat") {
      statReads++;
      if (mode === "persistent wrong PID") return stat(pid + 1);
      return stat(pid, statReads === 1 && mode === "startup transition" ? "PRIVATE_STARTUP_NAME" : "node");
    }
  };
  f.clock += 100; await f.tick();
  const created = f.samples().at(-1).docker;
  assert.deepEqual(created.gaps, []);
  assert.equal(created.participants[0].container.state.Status, "created");
  assert.equal(created.participants[0].kernel, null);
  running = true; f.clock += 100; await f.tick();
  const stable = mode === "stable startup", observed = f.samples().at(-1).docker;
  assert.deepEqual(observed.inventory, [id]); assert.deepEqual(observed.gaps, stable ? [] : [id]);
  assert.equal(observed.participants.length, stable ? 1 : 0);
  assert.equal(statReads, mode === "persistent wrong PID" ? 1 : 4);
  assert.equal(inspections, stable ? 3 : 2);
  assert.equal(faults, stable ? 0 : 1);
  if (!stable) assert.equal(f.held.size, 1, "only the command executable stays pinned after the rejected snapshot");
  f.clock += 100; await f.tick();
  const next = f.samples().at(-1).docker;
  if (mode === "persistent wrong PID") assert.deepEqual(next.gaps, [id]);
  else {
    assert.deepEqual(next.gaps, []);
    assert.equal(next.participants[0].kernel.processes.length, 1);
  }
  assert.equal(faults, stable ? 0 : 1, "a later sample neither clears nor repeats a fault");
  listed = false; await f.finish();
  if (stable) assert.equal(Object.hasOwn(f.terminal, "firstDockerGap"), false);
  else assert.deepEqual(f.terminal.firstDockerGap, {
    // "start" is not a Docker start time, so the name change is not rechecked.
    stage: mode === "startup transition" ? "process-name-close" : "process-identity-open", code: "ERR_ASSERTION",
  });
  assert.ok(!JSON.stringify(f.terminal).includes("PRIVATE_STARTUP_NAME"));
  assert.equal(f.terminal.observerFailures.count, 0);
  assert.equal(f.held.size, 0);
});

test("initial-to-attachment continuity loss notifies before startup release and remains accounting-invalid", async (t) => {
  let faults = 0;
  const f = await fixture(t, [], false, () => { faults++; }, 1909);
  const afterAttachment = faults;
  f.clock += 100; await f.tick();
  const proof = await f.finish();
  assert.equal(afterAttachment, 1); assert.equal(faults, 1);
  assert.equal(proof.samples[0].at, 10000); assert.equal(proof.samples[1].at, 11909);
  assert.equal(proof.status, "blocked"); assert.equal(proof.checks.accounting, false);
  for (const key of ["terminal", "empty", "observer", "unforced", "leader"]) assert.equal(proof.checks[key], true);
  assert.equal(f.terminal.observerError, null); assert.equal(f.terminal.observerFailures.count, 0);
});

test("a retry that runs past the one-second budget cannot publish a sample", async (t) => {
  const f = await fixture(t); let raced = false;
  f.override = (path) => {
    if (path === "/proc/4242/stat") {
      if (!raced) { raced = true; f.clock += 600; throw missing(); }
      f.clock += 600;
    }
  };
  await f.tick(); assert.equal(f.samples().length, 2); assert.equal((await f.finish()).status, "blocked");
});

for (const operation of ["stat", "exe"]) test(`native proc ${operation}: six real exits between census and process capture`, {
  skip: process.platform !== "linux" && "native proc control requires Linux", timeout: 10000,
}, async (t) => {
  // Only the cgroup files are synthetic. /proc identities, executable links and
  // ENOENTs below come from actual bounded children, reaped by their own shells.
  const children = [], targets = [], liveTargets = new Map();
  const wait = Atomics.wait, now = performance.now.bind(performance), exists = fs.existsSync, read = fs.readFileSync;
  const create = (file, argv) => {
    const child = spawn(file, argv, { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(child, "close"); children.push({ child, closed }); return child;
  };
  try {
    const leader = create("/bin/sleep", ["8"]); await once(leader, "spawn");
    for (let i = 0; i < 6; i++) {
      const shell = create("/bin/sh", ["-c", "sleep 8 & p=$!; echo $p; wait $p"]);
      const [bytes] = await once(shell.stdout, "data"); const pid = Number(bytes.toString().trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0); targets.push(pid);
      liveTargets.set(pid, processIdentity(read(`/proc/${pid}/stat`, "utf8")).startTicks);
    }
    const f = await fixture(t, [leader.pid, ...targets]); f.members = [leader.pid, ...targets];
    let exits = 0;
    f.override = (path) => {
      const pid = Number(path.split("/")[2]);
      if (targets.includes(pid) && path === `/proc/${pid}/${operation}` && f.members.includes(pid)) {
        process.kill(pid, "SIGKILL"); const deadline = now() + 250;
        while (exists(`/proc/${pid}`) && now() < deadline) wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        assert.equal(exists(`/proc/${pid}`), false, "shell must reap the exited PID inside the bound");
        liveTargets.delete(pid);
        f.members = f.members.filter((p) => p !== pid); exits++;
        // The original proc read now throws the real kernel ENOENT.
      }
    };
    const started = now(); await f.tick(); const elapsed = now() - started;
    assert.equal(exits, 6); assert.equal(f.samples().length, 3);
    assert.equal(f.samples().at(-1).processes.length, 1);
    assert.equal((await f.finish()).status, "verified"); assert.equal(f.terminal.observerFailures.count, 0);
    assert.ok(elapsed < 1000, `bounded native churn capture took ${elapsed}ms`);
    console.log(JSON.stringify({ control: "real-proc-synthetic-cgroup", operation, exits, elapsedMs: elapsed }));
  } finally {
    for (const [pid, start] of liveTargets) if (exists(`/proc/${pid}`)) {
      assert.equal(processIdentity(read(`/proc/${pid}/stat`, "utf8")).startTicks, start);
      process.kill(pid, "SIGKILL");
    }
    // Let each shell reap its own child before closing the helper itself.
    await Promise.all(children.slice(1).map(({ closed }) => closed));
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ closed }) => closed));
  }
});
