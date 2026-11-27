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
  assert.equal(result.drainStatus, 0);
  assert.deepEqual(result.pinned, [10, 20, 21]); assert.equal(result.auditPublished, true); assert.ok(result.seal);
  assert.equal(result.cellAccepts, 0);
  verifyApparatus(result.binding, registration, { host: registration.host, monoNs: registration.createdMonoNs, members: registration.members, listener: registration.listener });
  assert.equal(verifyStreamDrain(result.binding, registration, result.drain).remoteDrained, true);
  assert.ok(result.frames.includes("progress") && result.frames.includes("audit-end") && result.frames.includes("delivery-sealed") && result.frames.at(-1) === "terminal");
});
for (const mode of ["hardening-count", "hardening-stalled"]) {
  test("actual guardian keeps optional counts out of required state: " + mode, () => {
    const r = kernel(mode), counted = mode === "hardening-count";
    assert.deepEqual(r.cells, counted ? [{ started: 2, total: 108 }] : []);
    assert.equal(r.cellReads, counted ? 2 : 15);
    assert.equal(r.cellAccepts, r.cellCloses);
    assert.ok(r.renewal >= (counted ? 1 : 2));
    assert.equal(r.auditPublished, true);
    assert.ok(r.seal); assert.equal(r.terminal, true); assert.equal(r.invalid, false); assert.equal(r.drainStatus, 0);
  });
}
test("a failed group with no audit closes the guardian and admits a separate disappearance proof", () => {
  const r = kernel("failed-group");
  assert.deepEqual(r.frames.filter((kind) => kind !== "challenge"), ["registered", "progress", "terminal"]);
  assert.equal(r.terminal, true); assert.equal(r.invalid, false); assert.ok(r.seal);
  assert.equal(r.auditPublished, false);
  assert.equal(verifyStreamDrain(r.binding, r.registration, r.drain).remoteDrained, true);
});
for (const mode of ["early-job-exit", "already-exited", "exit-after-renewals"])
  test("an exited job without progress preserves registration but is never a result: " + mode, () => {
    const result = kernel(mode);
    assert.ok(result.registration);
    if (mode === "exit-after-renewals") assert.ok(result.renewal >= 2);
    else assert.equal(result.renewal, 1);
    assert.equal(result.reason, "benchmark job exited before first campaign state");
    assert.equal(result.invalid, true); assert.equal(result.terminal, false);
    assert.equal(result.drain, null); assert.equal(result.auditPublished, false);
  });
for (const mode of ["lost-lease", "new-child", "namespace", "affinity", "unknown-login", "replayed-renewal", "unknown-input", "native-delivery"])
  test("actual guardian intentional negative: " + mode, () => {
    const result = kernel(mode); assert.equal(result.failed, true); assert.equal(result.invalid, true); assert.equal(result.terminal, false); assert.equal(result.drain, null);
    const fault = /^CORTEN_MONITOR_FAULT ([a-f0-9]{32}) ([1-9][0-9]{0,4})\n$/.exec(result.diagnostic);
    assert.ok(fault); assert.equal(fault[1], result.registration.id);
    if (mode === "unknown-login") assert.match(guardianSource.split("\n")[Number(fault[2]) - 1], /foreign SSH\/login participant/);
  });
for (const [mode, status] of [["drain-survivor", 3], ["drain-listener", 254], ["drain-scope", 254], ["drain-unknown", 254]])
  test("actual guarded probe withholds disappearance proof: " + mode, () => {
    const result = kernel(mode);
    assert.equal(result.terminal, true); assert.equal(result.drain, null); assert.equal(result.drainStatus, status);
  });
