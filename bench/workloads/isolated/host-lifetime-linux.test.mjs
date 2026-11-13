// Real kernel/process collector smoke, no benchmark timing or provider access.
// Run only inside an explicitly prepared owned delegated test unit. This test
// never creates/configures a unit, changes limits or adopts an existing cgroup.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-kernel-observer-"));
  const directory = join(temporary, "command-host"), campaign = `${unit[1]}-0000000000000001`;
  const binding = { request: { group: "client-heavy", round: "observer-smoke", commit: "a".repeat(40) } };
  const invocation = { executable: "node", argv: ["bench/workloads/dispatcher-fixtures/native.mjs", "exit", "0"], shell: false };
  let observer, pid;
  try {
    const result = await supervise(invocation, { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: process.env, log() {},
      onStart(value) { pid = value; observer = beginLifetime({ campaign, binding, invocation, directory, command: 0, pid }); observer.attach(pid); } });
    assert.equal(result.success, true, JSON.stringify(result));
    const manifest = observer.finish(result);
    const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 0, pid, result });
    assert.equal(proof.status, "verified", JSON.stringify({ checks: proof.checks,
      gaps: proof.samples.slice(1).map((s, i) => s.at - proof.samples[i].at), terminal: JSON.parse(readFileSync(join(directory, "terminal.json"))) }));
    assert.equal(proof.cleanupComplete, true); assert.equal(proof.manifestSha256, manifest.sha256);
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
    assert.equal(terminal.empty, true); assert.equal(terminal.observerError, null);
    assert.deepEqual(proof.samples.at(-1).processes, []); assert.equal(existsSync(`/sys/fs/cgroup${proof.context.path}`), false);
    for (const p of proof.identities) assert.throws(() => process.kill(p.pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer); assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); rmSync(temporary, { recursive: true });
  }
});
