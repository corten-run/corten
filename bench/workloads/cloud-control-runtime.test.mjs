import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { guardianSource, guardianSha256, controlRequest, guardianCommand, sftpGuardianCommand } from "./cloud-control-runtime.mjs";
import { shellTransport } from "./cloud-transport.mjs";
import { verifyControlAdmission } from "./isolated/control-admission.mjs";

function loopback(mode) {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-session-kernel.py"],
    { cwd: resolve("."), input: JSON.stringify({ source: guardianSource, mode }), encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test("actual guardian/watcher producer registers SSH and SFTP, includes the final seal, joins the watcher and preserves custody", () => {
  const result = loopback("normal"), admission = result.admission;
  for (const receipt of admission.receipts) for (let i = 1; i < receipt.samples.length; i++)
    assert.ok(BigInt(receipt.samples[i].monoNs) > BigInt(receipt.samples[i - 1].monoNs),
      JSON.stringify(receipt.samples.map((s) => s.monoNs)));
  assert.equal(verifyControlAdmission(result.binding, "bootstrap", admission).qualification, "pending-first-host-native-proof");
  assert.equal(admission.invocations.length, 3); assert.equal(admission.seal.final, admission.invocations.at(-1).id);
  assert.equal(admission.watchers.length, 3); assert.ok(result.custodyFiles >= 16);
  for (const invocation of admission.invocations) assert.ok(result.frames.includes(`CORTEN_RESULT ${invocation.id} 0`));
  for (const mutate of [
    (a) => { a.receipts.pop(); }, (a) => { a.watchers.at(-1).properties.MainPID = "200"; },
    (a) => { a.seal.ledger.pop(); }, (a) => { a.watchers.at(-1).identityAbsent = false; },
    (a) => { a.watchers.at(-1).properties.ExecMainStatus = "1"; },
    (a) => { a.receipts[0].socket.connection = "192.0.2.99 40000 192.0.2.10 22"; },
    (a) => { a.receipts[0].window.startedMonoNs = a.receipts[0].samples[0].monoNs; },
  ]) { const changed = structuredClone(admission); mutate(changed); assert.throws(() => verifyControlAdmission(result.binding, "bootstrap", changed)); }
});
test("intentional disconnect and surviving SSH ancestor never produce a successful receipt", () => {
  for (const mode of ["disconnect", "ancestor-survives", "ancestor-zombie"]) {
    const result = loopback(mode); assert.equal(result.receiptAbsent, true); assert.ok(result.observerErrors.length > 0);
  }
});
test("terminal scope is insufficient while watcher remains active or another SSH survivor exists", () => {
  for (const mode of ["watcher-alive", "unknown-survivor", "unknown-user-manager"]) assert.equal(loopback(mode).admission, null);
});
test("source-bound native window refuses control and cannot close over the retained intrusion", () => {
  assert.equal(loopback("window").intrusionBlocked, true);
});

test("custody reader permits atime changes but rejects inode changes", () => {
  assert.equal(loopback("storage-mutation").mutationRejected, true);
});

test("socket-owned shared listener may update status argv, never PID/start, executable or cgroup", () => {
  const result = loopback("listener-title");
  verifyControlAdmission(result.binding, "bootstrap", result.admission);
  for (const field of ["startTicks", "cgroup", "executable"]) {
    const changed = structuredClone(result.admission), listener = changed.receipts[0].listener;
    const row = changed.receipts[0].samples.at(-1).processes.find((p) => p.pid === listener.pid);
    row[field] = field === "executable" ? { device: "9", inode: "9" } : field === "startTicks" ? "999" : "0::/foreign\n";
    assert.throws(() => verifyControlAdmission(result.binding, "bootstrap", changed));
  }
});
test("production SSH and explicit SFTP server argv share registration and result framing without changing auth policy", () => {
  const state = { round: "r21", commit: "a".repeat(40), token: "0123456789abcdef", control: { ledger: [] } };
  const calls = [];
  const request = controlRequest(state, "ssh", ["root@192.0.2.10", ":"], 30000, "bootstrap");
  const run = shellTransport({ repo: resolve("."), spawn: (binary, args, options) => {
    calls.push({ binary, args, options });
    return { status: 0, stdout: "", stderr: `CORTEN_CONTROL ${request.invocation.id} ${"b".repeat(64)}\nCORTEN_RESULT ${request.invocation.id} 0\n` };
  } });
  assert.equal(request.helperSha256, guardianSha256);
  run("ssh", ["root@192.0.2.10", ":"], 30000, false, undefined, { request, command: guardianCommand(request) });
  assert.ok(calls[0].args.at(-1).startsWith("/usr/bin/python3 -I -c"));
  assert.equal(calls[0].options.input, "set -euo pipefail\n:\n");
  run("scp", ["-q", resolve("local with ' quotes"), "root@192.0.2.10:/bench/job.sh"], 30000, false, undefined,
    { request, command: sftpGuardianCommand(request) });
  const sftp = calls[1]; assert.equal(sftp.binary, "sftp"); assert.ok(sftp.args.includes("-b")); assert.ok(sftp.args.includes("-s"));
  assert.ok(sftp.args.includes("ForwardAgent=no") && sftp.args.includes("ControlMaster=no"));
  assert.ok(sftp.options.input.startsWith("put ")); assert.ok(sftp.options.input.endsWith('"/bench/job.sh"\n'));
  state.control.ledger.push({ request });
  const next = controlRequest(state, "ssh", ["root@192.0.2.10", ":"], 30000, "bootstrap", [request.invocation]);
  assert.equal(next.seal.length, 2); assert.equal(next.seal.at(-1).id, next.invocation.id);
  assert.ok(!guardianCommand(next).includes(" -c "), "installed helper, not a second inline installer");
});
test("missing or mismatched remote completion frames preserve transport uncertainty even after local exit zero", () => {
  const request = controlRequest({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef", control: { ledger: [] } }, "ssh", ["root@192.0.2.10", ":"], 30000, "bootstrap");
  for (const stderr of ["", `CORTEN_CONTROL ${request.invocation.id} ${"b".repeat(64)}\n`,
    `CORTEN_CONTROL ${request.invocation.id} ${"b".repeat(64)}\nCORTEN_RESULT ${request.invocation.id} 1\n`]) {
    const run = shellTransport({ repo: resolve("."), spawn: () => ({ status: 0, stdout: "", stderr }) });
    assert.throws(() => run("ssh", ["root@192.0.2.10", ":"], 30000, true, undefined,
      { request, command: guardianCommand(request) }), (e) => e.controlTreeUncertain === true);
  }
});
