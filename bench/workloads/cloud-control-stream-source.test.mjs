import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { guardianSource } from "./cloud-control-runtime.mjs";
import { verifyApparatus, verifyStreamDrain } from "./isolated/control-stream.mjs";

function kernel(mode) {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-stream-kernel.py"],
    { cwd: resolve("."), input: JSON.stringify({ source: guardianSource, mode }), encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test("actual fixed guardian registers and pins exact socket ancestry, streams audit pending, seals and proves terminal disappearance", () => {
  const result = kernel("normal"), registration = result.registration;
  assert.equal(result.failed, false); assert.equal(result.terminal, true); assert.equal(result.invalid, false);
  assert.deepEqual(result.pinned, [10, 20, 21]); assert.equal(result.auditPublished, true); assert.ok(result.seal);
  verifyApparatus(result.binding, registration, { host: registration.host, monoNs: registration.createdMonoNs, members: registration.members, listener: registration.listener });
  assert.equal(verifyStreamDrain(result.binding, registration, result.drain).remoteDrained, true);
  assert.ok(result.frames.includes("progress") && result.frames.includes("audit-end") && result.frames.includes("delivery-sealed") && result.frames.at(-1) === "terminal");
});
for (const mode of ["early-job-exit", "already-exited"])
  test("an exited job without progress preserves registration but is never a result: " + mode, () => {
    const result = kernel(mode);
    assert.ok(result.registration); assert.ok(result.frames.includes("challenge"));
    assert.equal(result.reason, "benchmark job exited before first campaign state");
    assert.equal(result.invalid, true); assert.equal(result.terminal, false);
    assert.equal(result.drain, null); assert.equal(result.auditPublished, false);
  });
for (const mode of ["lost-lease", "new-child", "namespace", "affinity", "unknown-login", "replayed-renewal", "unknown-input", "native-delivery"])
  test("actual guardian intentional negative: " + mode, () => {
    const result = kernel(mode); assert.equal(result.failed, true); assert.equal(result.invalid, true); assert.equal(result.terminal, false); assert.equal(result.drain, null);
  });
for (const mode of ["drain-survivor", "drain-unknown"])
  test("actual guardian refuses disappearance proof: " + mode, () => { const result = kernel(mode); assert.equal(result.terminal, true); assert.equal(result.drain, null); });
