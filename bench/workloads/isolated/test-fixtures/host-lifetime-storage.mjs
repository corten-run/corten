// Synthetic cgroup/proc inputs, real sampling clock, timers and asynchronous disk.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { beginLifetime, inspectLifetime } from "../host-lifetime.mjs";
import { hashExecutableDescriptor } from "../participant-executables.mjs";
import { storageControl } from "./host-durable-writer-control.mjs";

export async function samplingControl(t, signal, scenario) {
  let f, observer, finished = false;
  t.after(async () => {
    if (!f) return;
    for (const release of f.releases) release(); f.before = () => {}; f.members = [];
    if (observer && !finished) { try { await observer.finish(f.result); } catch {} }
    if (observer) await observer.pendingStorage;
  });
  f = await storageControl(t); f.writer.abort(); await f.writer.settled;
  f.directory = join(f.temporary, "observed"); f.members = []; f.removed = false; f.procReads = 0;
  const original = Object.fromEntries(["openSync", "readFileSync", "writeFileSync", "mkdirSync", "rmdirSync", "lstatSync", "statSync", "readlinkSync", "readdirSync"]
    .map((name) => [name, fs[name]]));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  if (platform.value === "win32") {
    const sync = fs.fsyncSync;
    t.mock.method(fs, "fsyncSync", (fd) => { if (!fs.fstatSync(fd).isDirectory()) return sync(fd); });
  }
  const parent = "/system.slice/corten-bench-groups-r21-0123456789abcdef.service";
  const image = join(f.temporary, "synthetic-proc-executable"), isExecutable = (path) => /^\/proc\/\d+\/exe$/.test(String(path));
  let scopeCpus = "0-7";
  if (scenario) {
    original.writeFileSync(image, "synthetic executable descriptor");
    t.mock.method(fs, "openSync", (path, ...args) => original.openSync(isExecutable(path) ? image : path, ...args));
    t.mock.method(childProcess, "execFileSync", (program, args, options) => {
      if (program === "/usr/bin/getconf") { assert.deepEqual(args, ["CLK_TCK"]); return "100\n"; }
      if (program === "docker") {
        assert.deepEqual(args, ["--host", "unix:///var/run/docker.sock", "container", "ls", "-aq", "--no-trunc"]);
        scenario.onInventory?.();
        return "";
      }
      assert.equal(program, process.execPath); assert.equal(args.length, 2);
      assert.ok(args[0].endsWith("participant-executables.mjs")); assert.equal(args[1], "--hash-open-executables");
      return JSON.stringify(JSON.parse(options.input).map(({ ref, identity }, i) =>
        ({ ref, identity, sha256: hashExecutableDescriptor(options.stdio[3 + i], identity) })));
    });
  }
  const isGroup = (path) => String(path).replaceAll("\\", "/").startsWith("/sys/fs/cgroup");
  t.mock.method(fs, "mkdirSync", (path, ...args) => {
    if (isGroup(path)) { f.scope = String(path).replaceAll("\\", "/").slice("/sys/fs/cgroup".length); return; }
    return original.mkdirSync(path, ...args);
  });
  t.mock.method(fs, "rmdirSync", (path, ...args) => { if (isGroup(path)) { f.removed = true; return; } return original.rmdirSync(path, ...args); });
  t.mock.method(fs, "lstatSync", (path, ...args) => isGroup(path) ? { isSymbolicLink: () => false } : original.lstatSync(path, ...args));
  t.mock.method(fs, "readdirSync", (path, ...args) => isGroup(path) ? [] : original.readdirSync(path, ...args));
  t.mock.method(fs, "writeFileSync", (path, value, ...args) => {
    if (isGroup(path)) {
      if (String(path).endsWith("cpuset.cpus")) scopeCpus = value;
      else { assert.ok(String(path).endsWith("cgroup.procs")); f.members = [Number(value)]; }
      return;
    }
    return original.writeFileSync(path, value, ...args);
  });
  t.mock.method(fs, "statSync", (path, ...args) => isExecutable(path)
    ? scenario ? original.statSync(image, ...args) : { dev: 1, ino: 1, size: 10, mtimeMs: 1, ctimeMs: 1 } : original.statSync(path, ...args));
  t.mock.method(fs, "readlinkSync", (path, ...args) => isExecutable(path) ? "/bin/control" : original.readlinkSync(path, ...args));
  t.mock.method(fs, "readFileSync", (path, ...args) => {
    const p = String(path).replaceAll("\\", "/");
    if (p === "/proc/self/cgroup") return `0::${parent}/supervisor\n`;
    if (p === "/proc/sys/kernel/random/boot_id") return "boot\n";
    if (scenario && p === "/proc/uptime") return "106.00 1280.00\n";
    if (["/proc/cpuinfo", "/proc/meminfo"].includes(p)) return "control\n";
    const proc = /^\/proc\/(\d+)\/(stat|exe|cgroup|cmdline)$/.exec(p);
    if (proc) {
      const pid = Number(proc[1]);
      if (proc[2] === "stat") { f.procReads++; return `${pid} (control) S ${[1, ...Array(17).fill(0), pid * 10, 0].join(" ")}`; }
      if (proc[2] === "exe") return Buffer.from("executable");
      if (proc[2] === "cgroup") return `0::${f.scope}\n`;
      return Buffer.from("control\0");
    }
    if (!isGroup(p)) return original.readFileSync(path, ...args);
    const key = p.slice(p.lastIndexOf("/") + 1), here = p.slice("/sys/fs/cgroup".length, p.lastIndexOf("/"));
    const members = here === f.scope ? f.members : [];
    const value = { "cgroup.subtree_control": "cpu cpuset memory\n", "cgroup.procs": members.map((pid) => `${pid}\n`).join(""),
      "cgroup.events": `populated ${members.length ? 1 : 0}\n`, "cpu.stat": "usage_usec 587934\n", "cpu.max": "max 100000\n",
      "cpuset.cpus.effective": `${here === f.scope ? scopeCpus : "0-7"}\n`,
      "memory.current": "10\n", "memory.peak": "20\n", "memory.max": "max\n", "memory.events": "oom_kill 0\n" }[key];
    assert.notEqual(value, undefined); return value;
  });
  syncBuiltinESMExports();
  const binding = scenario?.binding ?? { request: { group: "client-heavy", round: "durability-control", commit: "a".repeat(40) } };
  const invocation = scenario?.invocation ?? { executable: "node", argv: ["control"] }, campaign = "r21-0000000000000001", pid = 4242;
  f.result = { terminal: true, code: 0, signal: null, cancelled: false, forced: false, success: true, error: null };
  observer = await beginLifetime({ campaign, binding, invocation, directory: f.directory, command: 0, pid, signal });
  await observer.attach(pid); f.observer = observer;
  f.samples = () => original.readFileSync(join(f.directory, "samples.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
  f.finish = async (result = f.result, empty = true, retainTerminalClock = false) => {
    finished = true; if (empty) f.members = [];
    const written = await observer.finish(result, retainTerminalClock);
    const replayed = inspectLifetime(binding, invocation, f.directory, { campaign, command: 0, pid, result, phase: scenario?.phase });
    assert.equal(replayed.manifestSha256, written.sha256);
    return replayed;
  };
  return f;
}

// An explicitly launched test child only, never a runtime helper or recovery API.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--loss-control") {
  assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
  assert.ok(process.execArgv.includes("--max-old-space-size=256"));
  const mode = process.argv[3]; assert.ok(["record", "sample", "terminal"].includes(mode));
  const f = await samplingControl({ mock, after() {} });
  const ready = () => fs.writeSync(1, `${JSON.stringify({ directory: f.directory, temporary: f.temporary, mode })}\n`);
  if (mode === "terminal") {
    const sync = fs.fsyncSync;
    mock.method(fs, "fsyncSync", (fd) => {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith("terminal.pending.json")) {
        ready(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
      }
      return sync(fd);
    });
    syncBuiltinESMExports(); await f.finish();
  } else {
    const pause = f.pause("sync", mode === "record" ? (p) => p.endsWith(".json") : (p) => p.endsWith("samples.jsonl"));
    if (mode === "record") f.members.push(5000);
    else f.finish().catch(() => {});
    await pause.entered; ready();
  }
}
