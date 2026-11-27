// Synthetic kernel, Docker and storage reads around the real host observer.
// Shared by the portable host-lifetime controls; not native host qualification.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { beginLifetime, inspectLifetime } from "../host-lifetime.mjs";
import { jsonPreparationInvocation, jsonPreparationRound, jsonTimingInvocation } from "../../registry.mjs";

export const parent = "/system.slice/corten-bench-groups-r21-0123456789abcdef.service";
export const stat = (pid, name = "node", start = pid * 10, ppid = 1) => `${pid} (${name}) S ${[ppid, ...Array(17).fill(0), start, 0].join(" ")}`;
export const missing = (code = "ENOENT") => Object.assign(new Error("PRIVATE_NOT_RETAINED"), { code });

export async function fixture(t, nativePids = [], browser = false, onFault, attachGapMs = 0, catalog = false, json = null) {
  const original = Object.fromEntries(["readFileSync", "writeFileSync", "mkdirSync", "rmdirSync", "lstatSync", "statSync", "readlinkSync", "readdirSync", "fsyncSync", "openSync", "closeSync", "writeSync"]
    .map((key) => [key, fs[key]]));
  const exec = childProcess.execFileSync;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const temporary = fs.mkdtempSync(join(tmpdir(), "host-snapshot-churn-")), directory = join(temporary, "host");
  const f = { members: [], children: [], clock: 10000, wallOffset: 0, reads: [], cpu: 10, override() {}, scope: null };
  const campaign = "r21-0000000000000001", campaignRound = "r21", pid = nativePids[0] ?? 4242;
  const round = json === "timing" ? "j43" : json ? jsonPreparationRound(campaignRound) : "churn-control";
  const jsonInvocation = json === "timing" ? jsonTimingInvocation(round, "/bench/audits.json") : jsonPreparationInvocation(campaignRound);
  if (json === "check-only-no-build") jsonInvocation.argv = jsonInvocation.argv.filter((arg) => arg !== "--build");
  const binding = { request: { group: json ? "json-api" : browser ? "fullstack-browser" : catalog ? "catalog-page" : "client-heavy",
    round, commit: "a".repeat(40) }, ...(json ? { execution: { invocation: jsonInvocation } } : {}) };
  const executable = join(temporary, "executable"), nextExecutable = join(temporary, "next-executable"), held = new Set();
  const deferred = browser || catalog || json === "prepare" || json === "check-only-no-build";
  const executableFor = (path) => f.nextExecutable || path === `/proc/${f.nextPid}/exe` ? nextExecutable : executable;
  if (deferred) { fs.writeFileSync(executable, "original executable"); fs.writeFileSync(nextExecutable, "next executable"); }
  const invocation = json === "fixture" ? { executable: "node", argv: ["bench/catalog/fixtures.mjs", "c21"] }
    : json ? jsonInvocation : { executable: "node", argv: ["control"] };
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
        assert.equal(file, "docker");
        if (f.docker) return f.docker(argv);
        assert.deepEqual(argv, ["--host", "unix:///var/run/docker.sock", "container", "ls", "-aq", "--no-trunc"]);
        return "";
      }
      if (f.failHash) throw missing("EIO");
      if (platform.value === "linux") return exec(file, ["--max-old-space-size=256", ...argv], options);
      return JSON.stringify(JSON.parse(options.input).map((entry, i) => ({ ...entry,
        sha256: createHash("sha256").update(original.readFileSync(options.stdio[i + 3])).digest("hex") })));
    });
    t.mock.method(fs, "openSync", (path, ...args) => {
      if (f.failProofWrite && path === join(directory, "executables.json") && args[0] === "wx") throw missing("ENOSPC");
      if (!/^\/proc\/\d+\/exe$/.test(String(path))) return original.openSync(path, ...args);
      f.override(String(path), "open");
      const fd = original.openSync(executableFor(path), ...args); held.add(fd); return fd;
    });
    t.mock.method(fs, "closeSync", (fd) => { held.delete(fd); return original.closeSync(fd); });
    f.held = held;
    f.proof = () => JSON.parse(original.readFileSync(join(directory, "executables.json")));
    f.mutateImage = (which) => original.writeFileSync(which === "old" ? executable : nextExecutable, "modified executable");
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
    if (!deferred) return { dev: 1, ino: 1, size: 10, mtimeMs: 1, ctimeMs: 1 };
    const info = original.statSync(executableFor(path), ...args);
    return f.executableStat?.(path, info) ?? info;
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
