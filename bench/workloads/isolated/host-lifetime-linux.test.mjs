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
import { beginLifetime, inspectLifetime, processIdentity } from "./host-lifetime.mjs";
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
    assert.equal(reads, code === "ENOENT" ? 60 : code === "ERR_ASSERTION" ? 120 : 20,
      "comm-only failures exhaust the same three attempts; read-error retry bounds are unchanged");
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

for (const scenario of [
  { name: "permanent one-shot comm change", races: 1, attempts: 2, accepted: true },
  { name: "two comm changes", races: 2, attempts: 3, accepted: true },
  { name: "three comm changes", races: 3, attempts: 3, operation: "process-name-recheck" },
  { name: "ENOENT followed by two comm changes", races: 3, missingFirst: true, attempts: 3, operation: "process-name-recheck" },
  { name: "PID change", change: "pid", attempts: 1, operation: "process-pid-changed" },
  { name: "start-tick change", change: "start", attempts: 1, operation: "process-start-changed" },
  { name: "PID and comm change", change: "pid", races: 3, attempts: 1, operation: "process-pid-changed" },
  { name: "start-tick and comm change", change: "start", races: 3, attempts: 1, operation: "process-start-changed" },
  ...["ENOENT", "ESRCH", "EIO", "EACCES"].map((code) => ({ name: `${code} read error`, code,
    attempts: ["ENOENT", "ESRCH"].includes(code) ? 3 : 1, operation: "process-stat" })),
]) test(`whole-snapshot bookends: ${scenario.name}`, {
  skip: !unit && "requires Linux in an explicitly owned delegated benchmark test unit", timeout: 15000,
}, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-bookends-")), directory = join(temporary, "command-host"), gate = join(temporary, "finish");
  const campaign = `${unit[1]}-0000000000000007`, binding = { request: { group: "client-heavy", round: "observer-bookends", commit: "a".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/isolated/test-fixtures/host-lifetime-bookends.mjs", gate], shell: false };
  let observer, pid, tick, output = "", capture;
  const originalInterval = globalThis.setInterval;
  const interval = t.mock.method(globalThis, "setInterval", (callback, ...args) => {
    tick = callback; return originalInterval(callback, ...args);
  });
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env,
      onStart(value) { pid = value; observer = beginLifetime({ campaign, binding, invocation, directory, command: 6, pid }); observer.attach(pid); },
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
          if (path === `${scope}/cgroup.procs`) capture.attempts.push({ stats: new Map(), cmdlines: new Map() });
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
            return Buffer.from(`--type=${number === 1 ? "utility" : "renderer"}\0`);
          }
          const value = original.call(this, path, ...args);
          if (path === `${scope}/cpu.stat`) capture.cpu.push(value);
          return value;
        });
        syncBuiltinESMExports();
        try { tick(); capture.after = samples(); }
        finally { fault.mock.restore(); syncBuiltinESMExports(); fs.writeFileSync(gate, "finish"); }
      } });
    assert.equal(result.success, true, JSON.stringify({ result, output })); observer.finish(result); assert.ok(capture);
    const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
    const detail = JSON.stringify({ scenario: scenario.name, attempts: capture.attempts.length, before: capture.before,
      after: capture.after.length, failures: terminal.observerFailures });
    assert.equal(capture.after.length, capture.before + (scenario.accepted ? 1 : 0), detail);
    assert.equal(capture.attempts.length, scenario.attempts, detail); assert.equal(capture.cpu.length, scenario.attempts);
    for (const [index, attempt] of capture.attempts.entries()) {
      assert.equal(attempt.stats.get(capture.first).length, 2, "even previously completed members are reread from scratch");
      assert.equal(attempt.cmdlines.get(capture.first), 1, "earlier member metadata is reread, not carried between attempts");
      assert.equal(attempt.stats.get(capture.raced).length, scenario.code || scenario.missingFirst && index === 0 ? 1 : 2);
    }
    const records = fs.readdirSync(join(directory, "processes")).map((name) => JSON.parse(readFileSync(join(directory, "processes", name))));
    for (let i = 1; i <= (scenario.accepted ? scenario.attempts - 1 : scenario.attempts); i++)
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
