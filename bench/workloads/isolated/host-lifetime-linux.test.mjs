// Real kernel/process collector smoke, no benchmark timing or provider access.
// Run only inside an explicitly prepared owned delegated test unit. This test
// never creates/configures a unit, changes limits or adopts an existing cgroup.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { beginLifetime, captureBrowserParticipant, containerState, inspectLifetime, processIdentity } from "./host-lifetime.mjs";
import { executableIdentity } from "./participant-executables.mjs";
import { supervise } from "./process.mjs";
let unit;
if (process.platform === "linux") unit = /\/corten-bench-groups-(r[1-9]\d*)-[a-f0-9]{16}\.service\/supervisor\n?$/.exec(readFileSync("/proc/self/cgroup", "utf8"));

// Experimental and explicit: the driver supplies a second fixture to stop, not
// the container the later native participant and private-namespace checks need.
if (process.env.BROWSER_EXIT_FIXTURE_ID !== undefined) test("actual Docker exit after the exact participant cgroup disappears", {
  timeout: 15000,
}, async (t) => {
  assert.ok(unit, "Docker exit control requires a delegated Linux test unit");
  const id = process.env.BROWSER_EXIT_FIXTURE_ID, task = process.env.BROWSER_EXIT_FIXTURE_TASK;
  const gate = process.env.BROWSER_EXIT_FIXTURE_GATE;
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.match(task, /^corten-evidence-kernel-[a-f0-9]{16}-exit$/);
  assert.match(gate, /^\/tmp\/tmp\.[^/]+\/docker-exit$/);
  assert.equal(fs.realpathSync(gate), gate);
  const inspect = () => {
    const [info, ...extra] = JSON.parse(execFileSync("docker", ["--host", "unix:///var/run/docker.sock", "container", "inspect", id], {
      encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }));
    assert.equal(extra.length, 0); assert.equal(info?.Id, id);
    assert.equal(info.Config.Labels["agent.owner"], "codex");
    assert.equal(info.Config.Labels["agent.task"], task);
    assert.ok(info.Mounts.some((m) => m.Type === "bind" && m.Source === gate && m.Destination === "/corten-docker-exit"));
    return containerState(info);
  };
  const running = inspect();
  assert.equal(running.state.Status, "running");
  const { O_RDWR, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  const pipe = fs.openSync(join(gate, "exit"), O_RDWR | O_NONBLOCK | O_NOFOLLOW);
  try {
    assert.ok(fs.fstatSync(pipe).isFIFO());
    // Startup is outside the observer's budget. The container creates ready
    // only after it has opened the pipe and is about to read the exit byte.
    const readyBy = performance.now() + 5000;
    while (!fs.lstatSync(join(gate, "ready"), { throwIfNoEntry: false })?.isFile()) {
      assert.ok(performance.now() < readyBy, "Docker exit fixture did not arm its gate");
      await delay(10);
    }
    const live = captureBrowserParticipant(id);
    assert.ok(live.kernel, "the opening control must capture the actual running cgroup");
    assert.deepEqual(live.container, running);
    const pid = running.state.Pid, at = `/proc/${pid}`, scope = "/sys/fs/cgroup" + live.kernel.cgroup.trim().slice(3);
    const openingIdentity = processIdentity(live.kernel.stat);
    const budgetMs = 75, pause = new Int32Array(new SharedArrayBuffer(4)), exitByte = Buffer.from("x");
    const originalRead = fs.readFileSync, originalStat = fs.lstatSync;
    let began, releasedAt, missingAt, finishedAt, sawStat = false, sawMembership = false;
    const remaining = () => budgetMs - (performance.now() - began);
    const read = t.mock.method(fs, "readFileSync", function (file, ...args) {
      const actual = originalRead.call(this, file, ...args);
      if (file === `${at}/stat`) {
        const identity = processIdentity(actual);
        sawStat = identity.pid === pid && identity.startTicks === openingIdentity.startTicks;
      }
      if (file === `${at}/cgroup`) sawMembership = actual === live.kernel.cgroup;
      return actual;
    });
    const stat = t.mock.method(fs, "lstatSync", function (file, ...args) {
      if (file !== scope || releasedAt !== undefined) return originalStat.call(this, file, ...args);
      assert.equal(args.length, 0, "expected the opening exact leaf lookup");
      assert.ok(sawStat && sawMembership, "exit was requested before the real opening reads");
      assert.ok(originalStat.call(this, file, ...args).isDirectory(), "the original scope was not live at handoff");
      assert.ok(remaining() > 0, "75 ms budget expired before the exit gate");
      releasedAt = performance.now();
      assert.equal(fs.writeSync(pipe, exitByte), exitByte.length);
      for (;;) {
        assert.ok(remaining() > 0, "75 ms budget expired waiting for Docker to remove the cgroup");
        try { originalStat.call(this, file, ...args); }
        catch (error) {
          if (error.code === "ENOENT" && error.path === scope) missingAt = performance.now();
          throw error; // Pass through the real failing syscall, not a fabricated ENOENT.
        }
        const left = remaining();
        if (left > 0) Atomics.wait(pause, 0, 0, Math.min(1, left));
      }
    });
    syncBuiltinESMExports();
    let stopped;
    try {
      began = performance.now();
      try { stopped = captureBrowserParticipant(id); }
      catch (error) {
        if (remaining() <= 0) throw new Error("75 ms budget expired before the real exit proof completed", { cause: error });
        throw error;
      }
      finishedAt = performance.now();
      assert.ok(finishedAt - began < budgetMs, "real exit proof completed outside the 75 ms budget");
    } finally {
      finishedAt ??= performance.now();
      stat.mock.restore(); read.mock.restore(); syncBuiltinESMExports();
      const elapsed = (at) => at === undefined ? "not reached" : `${(at - began).toFixed(2)} ms`;
      t.diagnostic(`real capture: gate ${elapsed(releasedAt)}, cgroup ENOENT ${elapsed(missingAt)}, completed ${elapsed(finishedAt)}`);
    }
    assert.ok(releasedAt !== undefined && missingAt !== undefined, "no actual cgroup disappearance was observed");
    assert.equal(stopped.kernel, null);
    assert.equal(stopped.container.id, id);
    assert.equal(stopped.container.imageId, running.imageId);
    assert.equal(stopped.container.restartCount, running.restartCount);
    assert.equal(stopped.container.state.StartedAt, running.state.StartedAt);
    assert.equal(stopped.container.state.Status, "exited");
    assert.equal(stopped.container.state.Pid, 0);
    assert.equal(stopped.container.state.ExitCode, 0);
    assert.deepEqual(stopped.container, inspect());
    assert.equal(fs.lstatSync(scope, { throwIfNoEntry: false }), undefined);
  } finally { fs.closeSync(pipe); }
});

for (const change of ["exec", "exec with rename", "chmod"]) test(`catalog executable bookends around real ${change}`, {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-exec-")), directory = join(temporary, "command-host");
  const old = join(temporary, "shell"), next = fs.realpathSync("/bin/cat");
  const campaign = `${unit[1]}-0000000000000008`, binding = { request: { group: "catalog-page", round: "observer-exec", commit: "a".repeat(40) } };
  fs.copyFileSync("/bin/bash", old); fs.chmodSync(old, 0o500);
  const invocation = { executable: old, argv: ["--noprofile", "--norc", "-c", 'echo ready; read -r line || exit 0; exec "$1"', "shell", next], shell: false };
  const child = spawn(old, invocation.argv, { stdio: ["pipe", "pipe", "inherit"], timeout: 8000, killSignal: "SIGKILL" });
  const closed = once(child, "close");
  const pid = child.pid, at = `/proc/${pid}`, pause = new Int32Array(new SharedArrayBuffer(4));
  const pin = fs.openSync(old, "r"), initial = executableIdentity(pin);
  let tick, observer, finished = false;
  t.mock.method(globalThis, "setInterval", (cb) => { tick = cb; return 1; });
  try {
    const [ready] = await Promise.race([once(child.stdout, "data"), closed]); assert.equal(String(ready), "ready\n");
    const before = processIdentity(readFileSync(`${at}/stat`, "utf8"));
    observer = await beginLifetime({ campaign, binding, invocation, directory, command: 7, pid }); await observer.attach(pid);
    // Both images must be real, and the old image must already occur in an
    // admitted sample. Exec either just after the opening stat (so comm
    // changes too) or just before the closing executable stat.
    const early = change === "exec with rename", original = fs.statSync; let reads = 0, changed = false;
    const hook = t.mock.method(fs, "statSync", function (path, ...args) {
      const captured = early ? original.call(this, path, ...args) : null;
      if (path === `${at}/exe` && ++reads === (early ? 1 : 2)) {
        if (change !== "chmod") {
          child.stdin.write("go\n");
          const until = performance.now() + 500;
          while (fs.readlinkSync(path) !== next || (early && readFileSync(`${at}/comm`, "utf8").trim() === before.comm)) {
            assert.ok(performance.now() < until, "owned child did not exec before the fixture deadline");
            Atomics.wait(pause, 0, 0, 1);
          }
        } else fs.chmodSync(old, 0o700);
        changed = true;
      }
      return early ? captured : original.call(this, path, ...args); // Never substitute a stat result.
    });
    syncBuiltinESMExports();
    try { tick(); } finally { hook.mock.restore(); syncBuiltinESMExports(); }
    await observer.drain();
    assert.equal(changed, true);
    const after = processIdentity(readFileSync(`${at}/stat`, "utf8"));
    assert.equal(after.pid, before.pid); assert.equal(after.startTicks, before.startTicks);
    const pinned = executableIdentity(pin);
    if (change !== "chmod") {
      if (early) {
        assert.notEqual(after.comm, before.comm);
        assert.equal(reads, 4, "both censuses must actually read both executable bookends");
      }
      assert.deepEqual(pinned, initial);
      assert.equal(fs.readlinkSync(`${at}/exe`), next);
      tick(); await observer.drain(); // An independent stable census of the new image.
    } else {
      assert.notEqual(pinned.ctimeNs, initial.ctimeNs);
      assert.deepEqual({ ...pinned, ctimeNs: initial.ctimeNs }, initial);
    }
    child.stdin.end(); const [code, signal] = await closed;
    assert.deepEqual([code, signal], [0, null]);
    const result = { terminal: true, code, signal, cancelled: false, forced: false, success: true, error: null };
    finished = true; await observer.finish(result);
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    const detail = JSON.stringify(terminal.observerFailures);
    assert.equal(terminal.empty, true, detail);
    const inspect = () => inspectLifetime(binding, invocation, directory, { campaign, command: 7, pid, result });
    if (change !== "chmod") {
      assert.equal(terminal.observerFailures.count, 0, detail);
      const proof = inspect();
      assert.equal(proof.status, "verified"); assert.equal(proof.cleanupComplete, true);
      const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
      const oldDigest = digest(old), nextDigest = digest(next); assert.notEqual(oldDigest, nextDigest);
      assert.deepEqual(proof.samples.map((s) => s.processes.map((p) => {
        const identity = processIdentity(p.stat);
        assert.equal(identity.pid, pid); assert.equal(identity.startTicks, before.startTicks);
        return p.executableSha256;
      })), [[], [oldDigest], [nextDigest], [nextDigest], []]);
    } else {
      assert.equal(terminal.observerFailures.first.operation, "executable-recheck-ctime", detail);
      assert.equal(terminal.observerFailures.first.catalogCensus.attempts, 1);
      assert.equal(terminal.observerError, "host-executable-proof-incomplete");
      assert.equal(existsSync(join(directory, "executables.json")), false);
      assert.throws(inspect); // The earlier accepted descriptor was itself mutated.
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    if (!finished) observer?.dispose();
    fs.closeSync(pin);
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});

test("catalog retries a real fork and exec when only the parent image was previously sampled", {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async (t) => {
  const next = fs.realpathSync("/bin/cat");
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-fork-")), directory = join(temporary, "command-host");
  const old = join(temporary, "shell");
  const campaign = `${unit[1]}-0000000000000009`, binding = { request: { group: "catalog-page", round: "observer-fork", commit: "a".repeat(40) } };
  // The background subshell forks without exec. Its stdin is a separate gate
  // that also keeps cat alive after exec, while the original shell reaps it.
  const script = [
    "printf 'ready\\n'; read -r fork || exit 0",
    '(printf "child %s\\n" "$BASHPID"; read -r go || exit 0; exec "$1") <&3 3<&- &',
    'wait "$!"',
  ].join("\n");
  const invocation = { executable: old, argv: ["--noprofile", "--norc", "-c", script, "shell", next], shell: false };
  let tick, leader, closed, gate, pin, observer, scope, finishing = false;
  t.mock.method(globalThis, "setInterval", (cb) => { tick = cb; return 1; });
  try {
    fs.copyFileSync("/bin/bash", old); fs.chmodSync(old, 0o500);
    pin = fs.openSync(old, "r");
    const initial = executableIdentity(pin);
    leader = spawn(old, invocation.argv, {
      env: { LANG: "C", PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "inherit", "pipe"], timeout: 8000, killSignal: "SIGKILL",
    });
    closed = once(leader, "close"); gate = leader.stdio[3];
    const [ready] = await Promise.race([once(leader.stdout, "data"), closed]); assert.equal(String(ready), "ready\n");
    const pid = leader.pid, command = 8, parentAt = `/proc/${pid}`;
    const parentIdentity = processIdentity(readFileSync(`${parentAt}/stat`, "utf8"));
    observer = await beginLifetime({ campaign, binding, invocation, directory, command, pid });
    scope = `/sys/fs/cgroup${JSON.parse(readFileSync(join(directory, "binding.json"))).path}`;
    await observer.attach(pid);

    const announcement = Promise.race([once(leader.stdout, "data"), closed]);
    leader.stdin.end("fork\n");
    const [line] = await announcement, match = /^child (\d+)\n$/.exec(String(line));
    assert.ok(match, `forked child did not announce readiness: ${line}`);
    const childPid = Number(match[1]), at = `/proc/${childPid}`, exe = `${at}/exe`;
    assert.notEqual(childPid, pid);
    const before = readFileSync(`${at}/stat`, "utf8"), childIdentity = processIdentity(before);
    assert.match(before, new RegExp(`^${childPid} \\(.*\\) [A-Za-z] ${pid} `));
    assert.equal(fs.readlinkSync(exe), old);

    const pause = new Int32Array(new SharedArrayBuffer(4)), accounting = [], inodes = [];
    const read = fs.readFileSync, stat = fs.statSync;
    const account = t.mock.method(fs, "readFileSync", function (path, ...args) {
      const value = read.call(this, path, ...args);
      if (path === `${scope}/cpu.stat`) accounting.push(value);
      return value;
    });
    const bookend = t.mock.method(fs, "statSync", function (path, ...args) {
      const value = stat.call(this, path, ...args);
      if (path === exe) {
        inodes.push([String(value.dev), String(value.ino)]);
        if (inodes.length === 1) {
          // Return the real opening stat, but let exec complete before the
          // collector reads the child's closing process and image bookends.
          gate.write("go\n");
          const until = performance.now() + 500;
          while (fs.readlinkSync(exe) !== next || readFileSync(`${at}/comm`, "utf8").trim() === childIdentity.comm) {
            assert.ok(performance.now() < until, "forked child did not exec before the fixture deadline");
            Atomics.wait(pause, 0, 0, 1);
          }
        }
      }
      return value;
    });
    syncBuiltinESMExports();
    try { tick(); } finally { bookend.mock.restore(); account.mock.restore(); syncBuiltinESMExports(); }
    await observer.drain();
    const successor = fs.statSync(exe, { bigint: true }), after = processIdentity(readFileSync(`${at}/stat`, "utf8"));
    assert.equal(after.pid, childPid); assert.equal(after.startTicks, childIdentity.startTicks);
    assert.notEqual(after.comm, childIdentity.comm);
    assert.deepEqual(processIdentity(readFileSync(`${parentAt}/stat`, "utf8")), parentIdentity);
    assert.equal(fs.readlinkSync(`${parentAt}/exe`), old);
    assert.deepEqual(executableIdentity(pin), initial);

    gate.end(); const [code, signal] = await closed;
    assert.deepEqual([code, signal], [0, null]);
    const result = { terminal: true, code, signal, cancelled: false, forced: false, success: true, error: null };
    finishing = true; await observer.finish(result);
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    assert.equal(terminal.observerError, null, JSON.stringify(terminal.observerFailures));
    assert.equal(terminal.observerFailures.count, 0);
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command, pid, result });
    assert.equal(proof.status, "verified", JSON.stringify(proof.checks)); assert.equal(proof.cleanupComplete, true);
    assert.equal(existsSync(scope), false);
    const oldInode = [initial.dev, initial.ino], newInode = [String(successor.dev), String(successor.ino)];
    assert.notDeepEqual(oldInode, newInode);
    assert.deepEqual(inodes, [oldInode, newInode, newInode, newInode]);
    assert.equal(accounting.length, 2, "one fresh accounting census after the discarded attempt");
    assert.equal(proof.samples[2].groups[0].files["cpu.stat"], accounting[1]);
    const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const parent = { ...parentIdentity, sha256: digest(old) }, child = { ...after, sha256: digest(next) };
    assert.notEqual(parent.sha256, child.sha256);
    assert.deepEqual(proof.samples.map((sample) => sample.processes.map((p) => ({
      ...processIdentity(p.stat), sha256: p.executableSha256,
    })).sort((a, b) => a.pid - b.pid)), [[], [parent], [parent, child].sort((a, b) => a.pid - b.pid), []]);
  } finally {
    try {
      if (leader && !leader.stdin.writableEnded) leader.stdin.end();
      if (gate && !gate.writableEnded) gate.end();
      if (closed) await closed;
      if (observer && !finishing) { observer.dispose(); await observer.pendingStorage; }
      if (scope && existsSync(scope)) {
        assert.match(readFileSync(`${scope}/cgroup.events`, "utf8"), /^populated 0$/m);
        fs.rmdirSync(scope);
      }
    } finally {
      if (pin !== undefined) fs.closeSync(pin);
      assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
    }
  }
});

test("actual delegated cgroup observes the gated Node child, accounting and positive empty terminal state", {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-observer-"));
  const directory = join(temporary, "command-host"), campaign = `${unit[1]}-0000000000000001`;
  const binding = { request: { group: "client-heavy", round: "observer-smoke", commit: "a".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/dispatcher-fixtures/native.mjs", "exit", "0"], shell: false };
  let observer, pid, hashFinishedAt;
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env, log() {},
      async onStart(value) {
        pid = value; const original = fs.readFileSync;
        const delayed = t.mock.method(fs, "readFileSync", function (path, ...args) {
          if (path === `/proc/${pid}/exe` && hashFinishedAt === undefined) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
            const bytes = original.call(this, path, ...args); hashFinishedAt = Date.now(); return bytes;
          }
          return original.call(this, path, ...args);
        });
        syncBuiltinESMExports();
        try { observer = await beginLifetime({ campaign, binding, invocation, directory, command: 0, pid }); await observer.attach(pid); }
        finally { delayed.mock.restore(); syncBuiltinESMExports(); }
      } });
    assert.equal(result.success, true, JSON.stringify(result));
    const manifest = await observer.finish(result);
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 0, pid, result });
    assert.equal(proof.status, "verified", JSON.stringify({ checks: proof.checks,
      gaps: proof.samples.slice(1).map((s, i) => s.at - proof.samples[i].at), terminal: JSON.parse(readFileSync(join(directory, "terminal.json"))) }));
    assert.equal(proof.cleanupComplete, true); assert.equal(proof.manifestSha256, manifest.sha256);
    assert.ok(Number.isSafeInteger(hashFinishedAt) && proof.samples[0].at >= hashFinishedAt,
      "slow real executable hashing completes before initial sampling while native IPC stays gated");
    assert.ok(proof.identities.some((p) => p.pid === pid));
    assert.equal(existsSync(`/sys/fs/cgroup${proof.context.path}`), false, "only the owned empty command cgroup is removed");
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});

test("actual SIGTERM delivery drains native finally and its real descendant; cancellation never qualifies", {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-cancel-")), directory = join(temporary, "command-host");
  const campaign = `${unit[1]}-0000000000000002`, binding = { request: { group: "client-heavy", round: "observer-cancel", commit: "b".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/dispatcher-fixtures/native.mjs", "wait"], shell: false };
  let observer, pid, output = "", timer; const abort = new AbortController();
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env,
      signal: abort.signal, log(bytes) { output += bytes; if (output.includes("READY") && !timer) timer = setTimeout(() => abort.abort(), 350); },
      async onStart(value) { pid = value; observer = await beginLifetime({ campaign, binding, invocation, directory, command: 1, pid }); await observer.attach(pid); } });
    assert.equal(result.terminal, true); assert.equal(result.cancelled, true); assert.equal(result.forced, false); assert.equal(result.success, false);
    assert.match(output, /HANDLED SIGTERM/); assert.match(output, /CLEANUP_EXECUTED/);
    await observer.finish(result);
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 1, pid, result });
    assert.equal(proof.status, "blocked"); assert.ok(proof.identities.length >= 2, "real native descendant observed");
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    assert.equal(terminal.empty, true); assert.equal(terminal.observerError, null, JSON.stringify(terminal.observerFailures));
    assert.deepEqual(proof.samples.at(-1).processes, []); assert.equal(existsSync(`/sys/fs/cgroup${proof.context.path}`), false);
    for (const p of proof.identities) assert.throws(() => process.kill(p.pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer); assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});

for (const code of ["EIO", "ENOENT", "ERR_ASSERTION", "private-code"]) test(`interval ${code} failures retain bounded sanitized diagnostics and cannot qualify after recovery`, {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-diagnostic-")), directory = join(temporary, "command-host");
  const campaign = `${unit[1]}-0000000000000003`, binding = { request: { group: "client-heavy", round: "observer-failure", commit: "c".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/dispatcher-fixtures/native.mjs", "exit", "0"], shell: false };
  const marker = "PRIVATE_ERROR_MUST_NOT_BE_RETAINED";
  const injected = Object.assign(new Error(marker), { code, path: marker, syscall: marker, environment: marker });
  let observer, pid, tick, reads = 0;
  const interval = t.mock.method(globalThis, "setInterval", (callback) => { tick = callback; return 1; });
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env, log() {},
      async onStart(value) {
        pid = value; observer = await beginLifetime({ campaign, binding, invocation, directory, command: 2, pid }); await observer.attach(pid);
        const original = fs.readFileSync;
        const fault = t.mock.method(fs, "readFileSync", function (path, ...args) {
          if (path === `/proc/${pid}/stat`) {
            reads++;
            if (code === "ERR_ASSERTION") {
              const actual = original.call(this, path, ...args);
              return reads % 2 ? actual : actual.replace(/^\d+ \(.*\) /, `${pid} (${marker}) `);
            }
            throw injected;
          }
          return original.call(this, path, ...args);
        });
        syncBuiltinESMExports();
        try { for (let i = 0; i < 20; i++) tick(); }
        finally { fault.mock.restore(); syncBuiltinESMExports(); }
        // Recover while the attached bootstrap is still waiting for its start message.
        tick();
      } });
    assert.equal(result.success, true, JSON.stringify(result)); await observer.finish(result);
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    assert.equal(terminal.observerError, "host-observation-gap"); assert.equal(terminal.empty, true);
    const failures = terminal.observerFailures;
    assert.equal(failures.count, 20);
    assert.equal(terminal.samples, 4, "initial, attach, recovery, and final samples were recorded");
    for (const entry of [failures.first, failures.last]) {
      assert.deepEqual(Object.keys(entry).sort(), ["at", "code", "lastSampleAt", "operation", "phase", "samples"]);
      assert.equal(entry.phase, "interval"); assert.equal(entry.operation, code === "ERR_ASSERTION" ? "process-name-recheck" : "process-stat");
      assert.equal(entry.code, code === "private-code" ? "unknown" : code);
      assert.equal(entry.samples, 2); assert.ok(Number.isSafeInteger(entry.at) && entry.at >= entry.lastSampleAt);
    }
    if (code === "ENOENT" || code === "ERR_ASSERTION") assert.ok(reads >= 20,
      "retryable consistency failures exhaust the time left in the continuity window");
    else assert.equal(reads, 20, "nonretryable errors still fail on their first read");
    assert.ok(JSON.stringify(failures).length < 1000); assert.ok(!JSON.stringify(terminal).includes(marker));
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 2, pid, result });
    assert.equal(proof.status, "blocked"); assert.equal(proof.checks.observer, false);
    assert.equal(existsSync(`/sys/fs/cgroup${proof.context.path}`), false);
  } finally {
    interval.mock.restore(); assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});

test("a final sample failure retains its operation without claiming an empty terminal", {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-final-diagnostic-")), directory = join(temporary, "command-host");
  const campaign = `${unit[1]}-0000000000000004`, binding = { request: { group: "client-heavy", round: "observer-final-failure", commit: "d".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/dispatcher-fixtures/native.mjs", "exit", "0"], shell: false };
  let observer, pid;
  const originalInterval = globalThis.setInterval;
  const interval = t.mock.method(globalThis, "setInterval", (callback, ...args) => {
    callback(); return originalInterval(callback, ...args);
  });
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env, log() {},
      async onStart(value) { pid = value; observer = await beginLifetime({ campaign, binding, invocation, directory, command: 3, pid }); await observer.attach(pid); } });
    assert.equal(result.success, true, JSON.stringify(result));
    const context = JSON.parse(readFileSync(join(directory, "binding.json"))), original = fs.readFileSync;
    const fault = t.mock.method(fs, "readFileSync", function (path, ...args) {
      if (path === `/sys/fs/cgroup${context.path}/cgroup.events`) throw Object.assign(new Error("PRIVATE_FINAL_ERROR"), { code: "EACCES" });
      return original.call(this, path, ...args);
    });
    syncBuiltinESMExports();
    try { await observer.finish(result); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    assert.equal(terminal.terminal, false); assert.equal(terminal.empty, false);
    assert.equal(terminal.observerError, "host-observation-gap"); assert.equal(terminal.observerFailures.count, 1);
    assert.equal(terminal.observerFailures.first.phase, "finish");
    assert.equal(terminal.observerFailures.first.operation, "cgroup-read"); assert.equal(terminal.observerFailures.first.code, "EACCES");
    assert.equal(existsSync(`/sys/fs/cgroup${context.path}`), true, "unproven child is retained by production finish");
    assert.equal(inspectLifetime(binding, invocation, directory, { campaign, command: 3, pid, result }).status, "blocked");
    // The fixture alone owns this fresh child; independently establish empty
    // membership after the injected read recovers before removing it.
    assert.equal(readFileSync(`/sys/fs/cgroup${context.path}/cgroup.procs`, "utf8"), "");
    assert.match(readFileSync(`/sys/fs/cgroup${context.path}/cgroup.events`, "utf8"), /^populated 0$/m);
    fs.rmdirSync(`/sys/fs/cgroup${context.path}`);
  } finally {
    interval.mock.restore(); assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});

test("actual short-lived descendant churn retains native identities and a positive empty terminal", {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-churn-")), directory = join(temporary, "command-host");
  const campaign = `${unit[1]}-0000000000000005`, binding = { request: { group: "client-heavy", round: "observer-churn", commit: "e".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/isolated/test-fixtures/host-lifetime-churn.mjs"], shell: false };
  let observer, pid, output = "";
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env,
      log(bytes) { output += bytes; },
      async onStart(value) { pid = value; observer = await beginLifetime({ campaign, binding, invocation, directory, command: 4, pid }); await observer.attach(pid); } });
    assert.equal(result.success, true, JSON.stringify(result)); await observer.finish(result);
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 4, pid, result });
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    assert.equal(proof.status, "verified", JSON.stringify({ checks: proof.checks, failures: terminal.observerFailures }));
    const children = [...output.matchAll(/^CHURN (\d+)$/gm)].map((m) => Number(m[1]));
    assert.equal(children.length, 8); assert.equal(new Set(children).size, 8);
    for (const child of children) assert.ok(proof.identities.some((p) => p.pid === child), `actual child ${child} was not observed`);
    assert.equal(terminal.observerFailures.count, 0); assert.equal(terminal.empty, true);
    assert.equal(existsSync(`/sys/fs/cgroup${proof.context.path}`), false);
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});

test("an actual observer stall beyond one second remains blocked after clean native exit", {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-gap-")), directory = join(temporary, "command-host");
  const campaign = `${unit[1]}-0000000000000006`, binding = { request: { group: "client-heavy", round: "observer-gap", commit: "f".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/dispatcher-fixtures/native.mjs", "exit", "0"], shell: false };
  let observer, pid;
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env, log() {},
      async onStart(value) {
        pid = value; observer = await beginLifetime({ campaign, binding, invocation, directory, command: 5, pid }); await observer.attach(pid);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1250);
      } });
    assert.equal(result.success, true, JSON.stringify(result)); await observer.finish(result);
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 5, pid, result });
    const maxGap = Math.max(...proof.samples.slice(1).map((s, i) => s.at - proof.samples[i].at));
    assert.ok(maxGap >= 1250, `actual maximum sample gap was ${maxGap}ms`);
    assert.equal(proof.checks.accounting, false); assert.equal(proof.status, "blocked");
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    assert.equal(terminal.empty, true); assert.equal(terminal.terminal, true);
    assert.equal(existsSync(`/sys/fs/cgroup${proof.context.path}`), false);
    console.log(JSON.stringify({ actualGapMs: maxGap, continuityLimitMs: 1000, status: proof.status }));
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});

for (const scenario of [
  { name: "permanent one-shot comm change", races: 1, attempts: 2, accepted: true },
  { name: "two comm changes", races: 2, attempts: 3, accepted: true },
  { name: "six comm changes", races: 6, attempts: 7, accepted: true },
  { name: "ENOENT followed by two comm changes", races: 3, missingFirst: true, attempts: 4, accepted: true },
  { name: "PID change", change: "pid", attempts: 1, operation: "process-pid-changed" },
  { name: "start-tick change", change: "start", attempts: 1, operation: "process-start-changed" },
  { name: "PID and comm change", change: "pid", races: 3, attempts: 1, operation: "process-pid-changed" },
  { name: "start-tick and comm change", change: "start", races: 3, attempts: 1, operation: "process-start-changed" },
  ...["ENOENT", "ESRCH", "EIO", "EACCES"].map((code) => ({ name: `${code} read error`, code,
    attempts: ["ENOENT", "ESRCH"].includes(code) ? null : 1, operation: "process-stat" })),
]) test(`whole-snapshot bookends: ${scenario.name}`, {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-bookends-")), directory = join(temporary, "command-host"), gate = join(temporary, "finish");
  const campaign = `${unit[1]}-0000000000000007`, binding = { request: { group: "client-heavy", round: "observer-bookends", commit: "a".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/isolated/test-fixtures/host-lifetime-bookends.mjs", gate], shell: false };
  let observer, pid, tick, output = "", capture;
  // Isolate this manual census while awaiting its append; periodic cadence and
  // actual descendant churn are exercised separately above.
  const interval = t.mock.method(globalThis, "setInterval", (callback) => {
    tick = callback; return 1;
  });
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env,
      async onStart(value) { pid = value; observer = await beginLifetime({ campaign, binding, invocation, directory, command: 6, pid }); await observer.attach(pid); },
      log(bytes) {
        output += bytes;
        const ready = /^BOOKENDS_READY (\d+) (\d+)$/m.exec(output);
        if (!ready || capture) return;
        capture = { attempts: [], cpu: [] };
        const context = JSON.parse(readFileSync(join(directory, "binding.json"))), scope = `/sys/fs/cgroup${context.path}`;
        const members = readFileSync(`${scope}/cgroup.procs`, "utf8").trim().split("\n").map(Number);
        assert.deepEqual([...members].sort((a, b) => a - b), ready.slice(1).map(Number).sort((a, b) => a - b));
        const [first, raced] = members; Object.assign(capture, { first, raced });
        const samples = () => readFileSync(join(directory, "samples.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        capture.before = samples().length;
        const original = fs.readFileSync;
        const fault = t.mock.method(fs, "readFileSync", function (path, ...args) {
          // Accounting is read once per opening census, never by the closing
          // membership-only census. Keep the native read order/values intact.
          if (path === `${scope}/cpu.stat`) capture.attempts.push({ stats: new Map(), cmdlines: new Map() });
          const attempt = capture.attempts.at(-1), number = capture.attempts.length;
          const member = [first, raced].find((p) => path === `/proc/${p}/stat`);
          if (member) {
            const seen = attempt.stats.get(member) ?? []; attempt.stats.set(member, seen);
            if (member === raced && (scenario.code || scenario.missingFirst && number === 1)) {
              seen.push(null); throw Object.assign(new Error("PRIVATE_BOOKEND_READ_ERROR"), { code: scenario.code ?? "ENOENT" });
            }
            let raw = original.call(this, path, ...args);
            const version = number <= (scenario.races ?? 0) ? number - (seen.length === 0 ? 1 : 0) : (scenario.races ?? 0);
            raw = raw.replace(/^\d+ \(.*\) /, `${member} (${member === first ? `snap-${number}` : `name-v${version}`}) `);
            if (member === raced && seen.length === 1) {
              if (scenario.change === "pid") raw = raw.replace(/^\d+/, String(member + 1));
              if (scenario.change === "start") raw = raw.replace(/^(\d+ \(.*\) [A-Za-z] )(.*)$/s, (_, prefix, rest) => {
                const fields = rest.split(" "); fields[18] = String(BigInt(fields[18]) + 1n); return prefix + fields.join(" ");
              });
            }
            seen.push(raw); return raw;
          }
          if (path === `/proc/${first}/cmdline`) {
            attempt.cmdlines.set(first, (attempt.cmdlines.get(first) ?? 0) + 1);
            if (number === 1) return Buffer.from("--type=utility\0");
            // Chromium's renderer rewrites argv as one title followed by NUL padding.
            return Buffer.from(`${fs.readlinkSync(`/proc/${first}/exe`)} --type=renderer --lang=en-US\0\0`);
          }
          const value = original.call(this, path, ...args);
          if (path === `${scope}/cpu.stat`) capture.cpu.push(value);
          return value;
        });
        syncBuiltinESMExports();
        capture.completed = (async () => {
          try { tick(); await observer.drain(); capture.after = samples(); }
          finally { fault.mock.restore(); syncBuiltinESMExports(); fs.writeFileSync(gate, "finish"); }
        })();
        capture.completed.catch(() => {});
      } });
    assert.equal(result.success, true, JSON.stringify({ result, output })); await capture?.completed; await observer.finish(result); assert.ok(capture);
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    const detail = JSON.stringify({ scenario: scenario.name, attempts: capture.attempts.length, before: capture.before,
      after: capture.after.length, failures: terminal.observerFailures });
    assert.equal(capture.after.length, capture.before + (scenario.accepted ? 1 : 0), detail);
    if (scenario.attempts === null) assert.ok(capture.attempts.length >= 1, detail);
    else assert.equal(capture.attempts.length, scenario.attempts, detail);
    assert.equal(capture.cpu.length, capture.attempts.length);
    for (const [index, attempt] of capture.attempts.entries()) {
      assert.equal(attempt.stats.get(capture.first).length, 2, "even previously completed members are reread from scratch");
      assert.equal(attempt.cmdlines.get(capture.first), 1, "earlier member metadata is reread, not carried between attempts");
      assert.equal(attempt.stats.get(capture.raced).length, scenario.code || scenario.missingFirst && index === 0 ? 1 : 2);
    }
    const records = fs.readdirSync(join(directory, "processes")).map((name) => JSON.parse(readFileSync(join(directory, "processes", name))));
    for (let i = 1; i <= capture.attempts.length - (scenario.accepted ? 1 : 0); i++)
      assert.ok(!records.some((p) => processIdentity(p.stat).comm === `snap-${i}`), "failed attempt records must not be saved");
    assert.ok(!records.some((p) => processIdentity(p.stat).comm === "name-v0"), "pre-change identity must not escape a failed snapshot");
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 6, pid, result });
    assert.equal(terminal.empty, true); assert.equal(existsSync(`/sys/fs/cgroup${proof.context.path}`), false);
    if (scenario.accepted) {
      const sample = capture.after.at(-1), attempt = capture.attempts.at(-1);
      const accepted = sample.processes.map((key) => JSON.parse(readFileSync(join(directory, "processes", `${key}.json`))));
      assert.equal(accepted.length, 2); assert.equal(sample.groups[0].files["cpu.stat"], capture.cpu.at(-1));
      for (const p of accepted) {
        const identity = processIdentity(p.stat), pair = attempt.stats.get(identity.pid);
        assert.equal(p.stat, pair[0]); assert.deepEqual(processIdentity(pair[1]), identity);
        assert.equal(identity.comm, identity.pid === capture.first ? `snap-${scenario.attempts}` : `name-v${scenario.races}`);
      }
      assert.equal(accepted.find((p) => processIdentity(p.stat).pid === capture.first).type, "--type=renderer");
      assert.equal(proof.status, "verified", detail); assert.equal(terminal.observerFailures.count, 0);
    } else {
      assert.equal(proof.status, "blocked"); assert.equal(proof.checks.observer, false);
      assert.equal(terminal.observerFailures.count, 1, detail); assert.equal(terminal.observerFailures.first.operation, scenario.operation);
      assert.equal(terminal.observerFailures.first.code, scenario.code ?? "ERR_ASSERTION");
    }
  } finally {
    interval.mock.restore(); assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});
