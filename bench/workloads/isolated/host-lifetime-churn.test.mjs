// Synthetic kernel reads exercise the real collector on Windows and Linux.
// They establish snapshot consistency, not native host qualification.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { beginLifetime, inspectLifetime, processIdentity } from "./host-lifetime.mjs";

const parent = "/system.slice/corten-bench-groups-r21-0123456789abcdef.service";
const stat = (pid, name = "node", start = pid * 10) => `${pid} (${name}) S ${[1, ...Array(17).fill(0), start, 0].join(" ")}`;
const missing = (code = "ENOENT") => Object.assign(new Error("PRIVATE_NOT_RETAINED"), { code });

function fixture(t, nativePids = []) {
  const original = Object.fromEntries(["readFileSync", "writeFileSync", "mkdirSync", "rmdirSync", "lstatSync", "statSync", "readlinkSync", "readdirSync", "fsyncSync"]
    .map((key) => [key, fs[key]]));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const temporary = fs.mkdtempSync(join(tmpdir(), "host-snapshot-churn-")), directory = join(temporary, "host");
  const f = { members: [], children: [], clock: 10000, wallOffset: 0, reads: [], cpu: 10, override() {}, scope: null };
  const binding = { request: { group: "client-heavy", round: "churn-control", commit: "a".repeat(40) } };
  const invocation = { executable: "node", argv: ["control"] }, campaign = "r21-0000000000000001", pid = nativePids[0] ?? 4242;
  const result = { terminal: true, code: 0, signal: null, cancelled: false, forced: false, success: true, error: null };
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(() => {
    t.mock.restoreAll(); Object.defineProperty(process, "platform", platform); syncBuiltinESMExports();
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); fs.rmSync(temporary, { recursive: true });
  });
  if (!nativePids.length) {
    t.mock.method(Date, "now", () => f.clock + f.wallOffset);
    t.mock.method(performance, "now", () => f.clock);
    t.mock.method(Atomics, "wait", (_array, _index, _value, ms) => { f.clock += ms; return "timed-out"; });
  }
  t.mock.method(globalThis, "setInterval", (callback) => { f.tick = callback; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  // Only the synthetic Linux platform needs this Windows directory-fsync shim.
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (platform.value === "win32" && fs.fstatSync(fd).isDirectory()) return;
    return original.fsyncSync(fd);
  });
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
  t.mock.method(fs, "statSync", (path, ...args) => /^\/proc\/\d+\/exe$/.test(String(path)) && !nativePids.includes(Number(String(path).split("/")[2]))
    ? { dev: 1, ino: 1, size: 10, mtimeMs: 1, ctimeMs: 1 } : original.statSync(path, ...args));
  t.mock.method(fs, "readlinkSync", (path, ...args) => {
    if (/^\/proc\/\d+\/exe$/.test(String(path))) {
      const value = f.override(String(path));
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
      if (proc[2] === "exe") return Buffer.from("executable");
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
  const observer = beginLifetime({ campaign, binding, invocation, directory, command: 0, pid }); observer.attach(pid);
  f.samples = () => original.readFileSync(join(directory, "samples.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  f.records = () => original.readdirSync(join(directory, "processes")).map((name) => JSON.parse(original.readFileSync(join(directory, "processes", name))));
  f.finish = () => {
    f.override = () => {}; f.members = []; f.children = []; observer.finish(result);
    f.terminal = JSON.parse(original.readFileSync(join(directory, "terminal.json")));
    return inspectLifetime(binding, invocation, directory, { campaign, command: 0, pid, result });
  };
  return f;
}

for (const operation of ["stat", "exe"]) test(`full snapshot recovers from six consecutive exited-PID ${operation} races`, (t) => {
  const f = fixture(t); let exits = 0;
  f.members = [4242, 5000];
  f.override = (path) => {
    if (path === `/proc/${5000 + exits}/${operation}` && exits < 6) {
      exits++; f.cpu++; f.members = [4242, 5000 + exits]; throw missing();
    }
    if (path === "/proc/4242/cmdline") return Buffer.from(`--type=${exits < 6 ? "utility" : "renderer"}\0`);
  };
  f.tick();
  assert.equal(exits, 6); assert.equal(f.samples().length, 3);
  const accepted = f.samples().at(-1);
  assert.equal(accepted.groups[0].files["cpu.stat"], "usage_usec 16\n");
  assert.deepEqual(accepted.groups[0].files["cgroup.procs"], "4242\n5006\n");
  assert.ok(!f.records().some((p) => p.type === "--type=utility"), "discarded attempt metadata must not escape");
  assert.ok(!f.records().some((p) => processIdentity(p.stat).pid >= 5000 && processIdentity(p.stat).pid < 5006));
  assert.equal(f.finish().status, "verified"); assert.equal(f.terminal.observerFailures.count, 0);
});

test("a closing recursive census rejects membership changes after local process bookends", (t) => {
  const f = fixture(t); let changed = false;
  f.override = (path) => {
    if (!changed && path === `/sys/fs/cgroup${f.scope}/cgroup.procs` && f.reads.filter((p) => p === "/proc/4242/stat").length > 2) {
      changed = true; f.members.push(5000); f.children.push("child"); f.cpu++;
    }
  };
  f.tick();
  assert.equal(changed, true); const sample = f.samples().at(-1);
  assert.equal(sample.groups.length, 2); assert.equal(sample.groups[0].files["cpu.stat"], "usage_usec 11\n");
  assert.equal(sample.processes.length, 2); assert.equal(f.finish().status, "verified");
});

test("six name-only changes require seven complete attempts, not mixed identities", (t) => {
  const f = fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === "/proc/4242/stat") return stat(4242, `name-${Math.min(6, Math.floor(++reads / 2))}`);
  };
  f.tick(); assert.equal(reads, 14);
  assert.ok(!f.records().some((p) => /^name-[0-5]$/.test(processIdentity(p.stat).comm)));
  assert.equal(f.finish().status, "verified");
});

for (const code of ["EACCES", "EPERM", "EIO", "ENOENT", "ESRCH"]) test(`persistent ${code} cannot be hidden by a later clean empty scope`, (t) => {
  const f = fixture(t); let reads = 0;
  f.override = (path) => { if (path === "/proc/4242/stat") { reads++; throw missing(code); } };
  f.tick();
  assert.equal(f.samples().length, 2);
  if (!["ENOENT", "ESRCH"].includes(code)) assert.equal(reads, 1, "permission and I/O failures are not churn");
  assert.ok(f.clock <= 11001, "retries stay within the existing sample gap, not a new retry count");
  assert.equal(f.finish().status, "blocked"); assert.equal(f.terminal.empty, true);
  assert.equal(f.terminal.observerError, "host-observation-gap"); assert.equal(f.terminal.observerFailures.count, 1);
  assert.equal(f.terminal.observerFailures.first.code, code);
});

for (const change of ["pid", "start"]) test(`${change} bookend mismatch still fails immediately`, (t) => {
  const f = fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === "/proc/4242/stat") return ++reads === 1 ? stat(4242) : stat(change === "pid" ? 4243 : 4242, "node", change === "start" ? 42421 : 42420);
  };
  f.tick(); assert.equal(reads, 2); assert.equal(f.finish().status, "blocked");
  assert.equal(f.terminal.observerFailures.first.operation, change === "pid" ? "process-pid-changed" : "process-start-changed");
});

test("an executable link missing for a still-listed PID is not silently treated as exit", (t) => {
  const f = fixture(t);
  f.override = (path) => { if (path === "/proc/4242/exe") throw missing(); };
  f.tick(); assert.equal(f.samples().length, 2); assert.equal(f.finish().status, "blocked");
  assert.equal(f.terminal.observerFailures.first.operation, "executable-link");
});

test("non-process ENOENT is not retried as process churn", (t) => {
  const f = fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === `/sys/fs/cgroup${f.scope}/cgroup.procs`) { reads++; throw missing(); }
  };
  f.tick(); assert.equal(reads, 1); assert.equal(f.finish().status, "blocked");
});

test("backward wall-clock movement cannot renew a retry deadline", (t) => {
  const f = fixture(t); let reads = 0;
  f.override = (path) => {
    if (path === "/proc/4242/stat") { reads++; f.wallOffset -= 100; throw missing(); }
  };
  f.tick(); assert.ok(reads <= 1001); assert.ok(f.clock <= 11000);
  f.wallOffset = 0;
  assert.equal(f.finish().status, "blocked");
});

test("a late sample gets only the remaining continuity budget and failure does not renew it", (t) => {
  const f = fixture(t); let reads = 0;
  f.clock += 950;
  f.override = (path) => { if (path === "/proc/4242/stat") { reads++; throw missing(); } };
  f.tick(); assert.equal(f.clock, 11000); assert.equal(reads, 51);
  f.tick(); assert.equal(f.clock, 11000); assert.equal(reads, 52);
  assert.equal(f.samples().length, 2); assert.equal(f.finish().status, "blocked");
  assert.equal(f.terminal.observerFailures.count, 2);
});

test("a coherent 1909ms sampling gap stays accounting-blocked without inventing an observer error", (t) => {
  const f = fixture(t); f.clock += 1909; f.tick();
  const proof = f.finish();
  assert.equal(proof.status, "blocked"); assert.equal(proof.checks.accounting, false);
  for (const key of ["terminal", "empty", "observer", "unforced", "leader"]) assert.equal(proof.checks[key], true);
  assert.equal(f.terminal.observerError, null); assert.equal(f.terminal.observerFailures.count, 0);
});

test("a retry that runs past the one-second budget cannot publish a sample", (t) => {
  const f = fixture(t); let raced = false;
  f.override = (path) => {
    if (path === "/proc/4242/stat") {
      if (!raced) { raced = true; f.clock += 600; throw missing(); }
      f.clock += 600;
    }
  };
  f.tick(); assert.equal(f.samples().length, 2); assert.equal(f.finish().status, "blocked");
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
    const f = fixture(t, [leader.pid, ...targets]); f.members = [leader.pid, ...targets];
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
    const started = now(); f.tick(); const elapsed = now() - started;
    assert.equal(exits, 6); assert.equal(f.samples().length, 3);
    assert.equal(f.samples().at(-1).processes.length, 1);
    assert.equal(f.finish().status, "verified"); assert.equal(f.terminal.observerFailures.count, 0);
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
