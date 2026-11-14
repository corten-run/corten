// Real kernel/process collector smoke, no benchmark timing or provider access.
// Run only inside an explicitly prepared owned delegated test unit. This test
// never creates/configures a unit, changes limits or adopts an existing cgroup.
import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { beginLifetime, inspectLifetime } from "./host-lifetime.mjs";
import { supervise } from "./process.mjs";
let unit;
if (process.platform === "linux") unit = /\/corten-bench-groups-(r[1-9]\d*)-[a-f0-9]{16}\.service\/supervisor\n?$/.exec(readFileSync("/proc/self/cgroup", "utf8"));
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
      onStart(value) {
        pid = value; const original = fs.readFileSync;
        const delayed = t.mock.method(fs, "readFileSync", function (path, ...args) {
          if (path === `/proc/${pid}/exe` && hashFinishedAt === undefined) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
            const bytes = original.call(this, path, ...args); hashFinishedAt = Date.now(); return bytes;
          }
          return original.call(this, path, ...args);
        });
        syncBuiltinESMExports();
        try { observer = beginLifetime({ campaign, binding, invocation, directory, command: 0, pid }); observer.attach(pid); }
        finally { delayed.mock.restore(); syncBuiltinESMExports(); }
      } });
    assert.equal(result.success, true, JSON.stringify(result));
    const manifest = observer.finish(result);
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
      onStart(value) { pid = value; observer = beginLifetime({ campaign, binding, invocation, directory, command: 1, pid }); observer.attach(pid); } });
    assert.equal(result.terminal, true); assert.equal(result.cancelled, true); assert.equal(result.forced, false); assert.equal(result.success, false);
    assert.match(output, /HANDLED SIGTERM/); assert.match(output, /CLEANUP_EXECUTED/);
    observer.finish(result);
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
  const originalInterval = globalThis.setInterval;
  const interval = t.mock.method(globalThis, "setInterval", (callback, ...args) => {
    tick = callback; return originalInterval(callback, ...args);
  });
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env, log() {},
      onStart(value) {
        pid = value; observer = beginLifetime({ campaign, binding, invocation, directory, command: 2, pid }); observer.attach(pid);
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
      } });
    assert.equal(result.success, true, JSON.stringify(result)); observer.finish(result);
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    assert.equal(terminal.observerError, "host-observation-gap"); assert.equal(terminal.empty, true);
    const failures = terminal.observerFailures;
    assert.equal(failures.count, 20);
    for (const entry of [failures.first, failures.last]) {
      assert.deepEqual(Object.keys(entry).sort(), ["at", "code", "lastSampleAt", "operation", "phase", "samples"]);
      assert.equal(entry.phase, "interval"); assert.equal(entry.operation, code === "ERR_ASSERTION" ? "process-name-recheck" : "process-stat");
      assert.equal(entry.code, code === "private-code" ? "unknown" : code);
      assert.equal(entry.samples, 2); assert.ok(Number.isSafeInteger(entry.at) && entry.at >= entry.lastSampleAt);
    }
    assert.equal(reads, code === "ENOENT" ? 60 : code === "ERR_ASSERTION" ? 40 : 20,
      "existing racing-exit retries are unchanged; identity assertions are not retried or relaxed");
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
      onStart(value) { pid = value; observer = beginLifetime({ campaign, binding, invocation, directory, command: 3, pid }); observer.attach(pid); } });
    assert.equal(result.success, true, JSON.stringify(result));
    const context = JSON.parse(readFileSync(join(directory, "binding.json"))), original = fs.readFileSync;
    const fault = t.mock.method(fs, "readFileSync", function (path, ...args) {
      if (path === `/sys/fs/cgroup${context.path}/cgroup.events`) throw Object.assign(new Error("PRIVATE_FINAL_ERROR"), { code: "EACCES" });
      return original.call(this, path, ...args);
    });
    syncBuiltinESMExports();
    try { observer.finish(result); }
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
      onStart(value) { pid = value; observer = beginLifetime({ campaign, binding, invocation, directory, command: 4, pid }); observer.attach(pid); } });
    assert.equal(result.success, true, JSON.stringify(result)); observer.finish(result);
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
      onStart(value) {
        pid = value; observer = beginLifetime({ campaign, binding, invocation, directory, command: 5, pid }); observer.attach(pid);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1250);
      } });
    assert.equal(result.success, true, JSON.stringify(result)); observer.finish(result);
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
