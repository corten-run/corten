// Synthetic kernel reads exercise the real collector on Windows and Linux.
// They establish snapshot consistency, not native host qualification.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess, { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { beginLifetime, captureBrowserParticipant, inspectBrowserParticipants, inspectLifetime, processIdentity } from "./host-lifetime.mjs";
import { participantExecutables } from "./participant-executables.mjs";

const parent = "/system.slice/corten-bench-groups-r21-0123456789abcdef.service";
const stat = (pid, name = "node", start = pid * 10) => `${pid} (${name}) S ${[1, ...Array(17).fill(0), start, 0].join(" ")}`;
const missing = (code = "ENOENT") => Object.assign(new Error("PRIVATE_NOT_RETAINED"), { code });

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

async function fixture(t, nativePids = [], browser = false, onFault, attachGapMs = 0, catalog = false) {
  const original = Object.fromEntries(["readFileSync", "writeFileSync", "mkdirSync", "rmdirSync", "lstatSync", "statSync", "readlinkSync", "readdirSync", "fsyncSync", "openSync", "closeSync", "writeSync"]
    .map((key) => [key, fs[key]]));
  const exec = childProcess.execFileSync;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const temporary = fs.mkdtempSync(join(tmpdir(), "host-snapshot-churn-")), directory = join(temporary, "host");
  const f = { members: [], children: [], clock: 10000, wallOffset: 0, reads: [], cpu: 10, override() {}, scope: null };
  const binding = { request: { group: browser ? "fullstack-browser" : catalog ? "catalog-page" : "client-heavy", round: "churn-control", commit: "a".repeat(40) } };
  const executable = join(temporary, "executable"), nextExecutable = join(temporary, "next-executable"), held = new Set();
  const deferred = browser || catalog, executableFor = (path) => f.nextExecutable || path === `/proc/${f.nextPid}/exe` ? nextExecutable : executable;
  if (deferred) { fs.writeFileSync(executable, "original executable"); fs.writeFileSync(nextExecutable, "next executable"); }
  const invocation = { executable: "node", argv: ["control"] }, campaign = "r21-0000000000000001", pid = nativePids[0] ?? 4242;
  const result = { terminal: true, code: 0, signal: null, cancelled: false, forced: false, success: true, error: null };
  let observer, finished = false;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(async () => {
    try {
      f.releaseWrite?.();
      if (deferred && observer && !finished) {
        f.failSampleWrite = false; f.override = () => {}; f.members = []; f.children = [];
        try { await observer.finish(result); } catch { /* Failed storage must remain unsealed. */ }
      }
      if (observer) await observer.pendingStorage;
    } finally {
      t.mock.restoreAll(); Object.defineProperty(process, "platform", platform); syncBuiltinESMExports();
      assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); fs.rmSync(temporary, { recursive: true });
    }
    assert.equal(held.size, 0);
  });
  if (!nativePids.length) {
    t.mock.method(Date, "now", () => f.clock + f.wallOffset);
    t.mock.method(performance, "now", () => f.clock);
    t.mock.method(Atomics, "wait", (_array, _index, _value, ms) => { f.clock += ms; return "timed-out"; });
  }
  t.mock.method(globalThis, "setInterval", (callback) => { f.tick = callback; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  if (deferred) {
    t.mock.method(childProcess, "execFileSync", (file, argv, options) => {
      if (argv[1] !== "--hash-open-executables") {
        assert.equal(browser, true, "catalog proof does not query the Docker daemon");
        assert.deepEqual(argv, ["--host", "unix:///var/run/docker.sock", "container", "ls", "-aq", "--no-trunc"]);
        return "";
      }
      if (f.failHash) throw missing("EIO");
      if (platform.value === "linux") return exec(file, ["--max-old-space-size=256", ...argv], options);
      return JSON.stringify(JSON.parse(options.input).map((entry, i) => ({ ...entry,
        sha256: createHash("sha256").update(original.readFileSync(options.stdio[i + 3])).digest("hex") })));
    });
    t.mock.method(fs, "openSync", (path, ...args) => {
      if (!/^\/proc\/\d+\/exe$/.test(String(path))) return original.openSync(path, ...args);
      f.override(String(path), "open");
      const fd = original.openSync(executableFor(path), ...args); held.add(fd); return fd;
    });
    t.mock.method(fs, "closeSync", (fd) => { held.delete(fd); return original.closeSync(fd); });
    f.held = held;
    f.proof = () => JSON.parse(original.readFileSync(join(directory, "executables.json")));
    f.hasTerminal = () => fs.existsSync(join(directory, "terminal.json"));
  }
  // Only the synthetic Linux platform needs this Windows directory-fsync shim.
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (platform.value === "win32" && fs.fstatSync(fd).isDirectory()) return;
    return original.fsyncSync(fd);
  });
  const open = fsp.open;
  t.mock.method(fsp, "open", async (path, ...args) => {
    if (platform.value === "win32" && fs.existsSync(path) && fs.statSync(path).isDirectory()) return {
        async sync() {}, async close() {},
    };
    const handle = await open(path, ...args);
    if (browser && String(path).endsWith("samples.jsonl")) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", async (...values) => {
        if (f.writePause) { f.writeEntered(); await f.writePause; }
        if (f.failSampleWrite) throw missing("ENOSPC");
        return write(...values);
      });
    }
    return handle;
  });
  f.pauseWrite = () => {
    const entered = new Promise((resolve) => { f.writeEntered = resolve; });
    f.writePause = new Promise((resolve) => { f.releaseWrite = resolve; });
    return entered;
  };
  t.mock.method(fs, "mkdirSync", (path, ...args) => {
    const text = String(path).replaceAll("\\", "/");
    if (text.startsWith("/sys/fs/cgroup/")) { f.scope = text.slice("/sys/fs/cgroup".length); return; }
    return original.mkdirSync(path, ...args);
  });
  t.mock.method(fs, "rmdirSync", (path, ...args) => {
    if (String(path).replaceAll("\\", "/").startsWith("/sys/fs/cgroup/")) { f.removed = true; return; }
    return original.rmdirSync(path, ...args);
  });
  t.mock.method(fs, "writeFileSync", (path, value, ...args) => {
    if (String(path).replaceAll("\\", "/") === `/sys/fs/cgroup${f.scope}/cgroup.procs`) { f.members = [Number(value)]; return; }
    return original.writeFileSync(path, value, ...args);
  });
  t.mock.method(fs, "lstatSync", (path, ...args) => String(path).replaceAll("\\", "/").startsWith("/sys/fs/cgroup")
    ? { isSymbolicLink: () => false } : original.lstatSync(path, ...args));
  t.mock.method(fs, "statSync", (path, ...args) => {
    if (!/^\/proc\/\d+\/exe$/.test(String(path)) || nativePids.includes(Number(String(path).split("/")[2]))) return original.statSync(path, ...args);
    return deferred ? original.statSync(executableFor(path), ...args)
      : { dev: 1, ino: 1, size: 10, mtimeMs: 1, ctimeMs: 1 };
  });
  t.mock.method(fs, "readlinkSync", (path, ...args) => {
    if (/^\/proc\/\d+\/exe$/.test(String(path))) {
      const value = f.override(String(path), "link");
      return value ?? (nativePids.includes(Number(String(path).split("/")[2])) ? original.readlinkSync(path, ...args) : "/bin/node");
    }
    return original.readlinkSync(path, ...args);
  });
  t.mock.method(fs, "readdirSync", (path, ...args) => {
    const text = String(path).replaceAll("\\", "/");
    if (text.startsWith("/sys/fs/cgroup")) return text === `/sys/fs/cgroup${f.scope}` ? f.children.map((name) =>
      ({ name, isDirectory: () => true, isSymbolicLink: () => false })) : [];
    return original.readdirSync(path, ...args);
  });
  t.mock.method(fs, "readFileSync", (path, ...args) => {
    const text = String(path).replaceAll("\\", "/");
    if (!text.startsWith("/sys/fs/cgroup") && !text.startsWith("/proc/")) return original.readFileSync(path, ...args);
    f.reads.push(text); const value = f.override(text); if (value !== undefined) return value;
    if (text === "/proc/self/cgroup") return `0::${parent}/supervisor\n`;
    if (text === "/proc/sys/kernel/random/boot_id") return "boot\n";
    if (["/proc/cpuinfo", "/proc/meminfo"].includes(text)) return "control\n";
    const proc = /^\/proc\/(\d+)\/(stat|exe|cgroup|cmdline)$/.exec(text);
    if (proc) {
      const member = Number(proc[1]);
      if (nativePids.includes(member) && proc[2] !== "cgroup") return original.readFileSync(path, ...args);
      if (proc[2] === "stat") return stat(member);
      if (proc[2] === "exe") return f.readExecutable?.(text) ?? Buffer.from("executable");
      if (proc[2] === "cgroup") return `0::${f.scope}\n`;
      return Buffer.from("node\0");
    }
    const key = text.slice(text.lastIndexOf("/") + 1), scope = text.slice("/sys/fs/cgroup".length, text.lastIndexOf("/"));
    const members = scope === f.scope ? f.members : [];
    return { "cgroup.subtree_control": "cpu cpuset memory\n", "cgroup.procs": members.map((p) => `${p}\n`).join(""),
      "cgroup.events": `populated ${members.length ? 1 : 0}\n`, "cpu.stat": `usage_usec ${f.cpu}\n`, "cpu.max": "max 100000\n",
      "cpuset.cpus.effective": "0-7\n", "memory.current": "10\n", "memory.peak": "20\n", "memory.max": "max\n", "memory.events": "oom_kill 0\n" }[key];
  });
  syncBuiltinESMExports();
  observer = await beginLifetime({ campaign, binding, invocation, directory, command: 0, pid, onFault });
  f.clock += attachGapMs; await observer.attach(pid);
  f.capture = f.tick; f.drain = () => observer.drain();
  f.tick = async () => { f.capture(); await f.drain(); };
  f.samples = () => original.readFileSync(join(directory, "samples.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  f.records = () => original.readdirSync(join(directory, "processes")).map((name) => JSON.parse(original.readFileSync(join(directory, "processes", name))));
  f.finish = async () => {
    f.override = () => {}; f.members = []; f.children = []; finished = true; await observer.finish(result);
    f.terminal = JSON.parse(original.readFileSync(join(directory, "terminal.json")));
    return inspectLifetime(binding, invocation, directory, { campaign, command: 0, pid, result });
  };
  return f;
}

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
      if (!late) f.clock += 450;
      return ""; // Closing census disagrees with the opening one.
    }
  };
  await f.tick();
  assert.equal(faults, 1); assert.equal(f.samples().length, 2);
  assert.equal((await f.finish()).status, "blocked"); assert.equal(f.terminal.empty, true);
  const { first, count } = f.terminal.observerFailures;
  assert.equal(count, 1); assert.equal(first.operation, "snapshot-membership-recheck");
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
  for (let i = 1; i < 64; i++) f.capture();
  f.nextExecutable = true; f.capture(); // The 65th frame is refused synchronously.
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

test("failed lifetime finish retains executable-proof failure evidence and closes its pending descriptors", async (t) => {
  const f = await fixture(t, [], true); assert.equal(f.held.size, 1); f.failHash = true;
  await assert.rejects(f.finish); // No executable proof may be fabricated to make replay pass.
  assert.equal(f.held.size, 0); assert.throws(f.proof, { code: "ENOENT" });
  assert.equal(f.terminal.observerError, "host-executable-proof-incomplete");
  assert.equal(f.terminal.observerFailures.count, 1);
  assert.equal(f.terminal.observerFailures.first.phase, "executables");
  assert.equal(f.terminal.observerFailures.first.operation, "executable-proof");
  assert.equal(f.terminal.observerFailures.first.code, "EIO");
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

test("recorded browser participant gaps notify once without clearing failed validation", async (t) => {
  let faults = 0;
  const f = await fixture(t, [], true, () => { faults++; });
  const id = "c".repeat(64), exec = childProcess.execFileSync;
  t.mock.method(childProcess, "execFileSync", (file, argv, options) => {
    if (file !== "docker") return exec(file, argv, options);
    if (argv.includes("ls")) return id;
    assert.ok(argv.includes("inspect")); throw missing("EIO");
  });
  syncBuiltinESMExports();
  await f.tick(); const afterGap = faults;
  await f.tick(); const sample = f.samples().at(-1);
  const proof = await f.finish();
  assert.equal(afterGap, 1); assert.equal(faults, 1);
  assert.equal(sample.docker.gaps.length, 1); assert.equal(sample.docker.gaps[0], id);
  assert.equal(sample.docker.participants.length, 0);
  assert.equal(inspectBrowserParticipants({ schema: "native-browser-host-subject/v2", participants: [{ id }] }, proof), false);
  assert.equal(f.terminal.observerError, null); assert.equal(f.terminal.observerFailures.count, 0);
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
