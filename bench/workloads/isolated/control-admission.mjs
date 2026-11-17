// Live fixed-path admission and immutable replay. No provider, SSH, or cleanup authority.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { guardianSource, guardianSha256 } from "../cloud-control-runtime.mjs";
import { verifyControlSession } from "../cloud-control-session.mjs";
import { regular } from "../cloud-local.mjs";

const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const equal = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b), "control binding differs");
export function controlRoot(binding) {
  assert.match(binding.token, /^[a-f0-9]{16}$/);
  return `/run/corten-bench-control-${binding.token}`;
}
export function verifyControlWatcher(invocation, receipt, terminal) {
  const unit = `corten-bench-control-${invocation.token}-${invocation.id}.service`, properties = terminal.properties;
  assert.equal(terminal.unit, unit); assert.equal(properties.Id, unit); assert.equal(properties.MainPID, "0");
  assert.ok(["inactive", "failed"].includes(properties.ActiveState));
  assert.ok(["loaded", "not-found"].includes(properties.LoadState));
  if (properties.LoadState === "loaded") { assert.equal(properties.ExecMainCode, "1"); assert.equal(properties.ExecMainStatus, "0"); }
  equal(terminal.observer, receipt.observer); assert.equal(terminal.identityAbsent, true);
  assert.ok(terminal.cgroupEvents === null || /^populated 0\n(?:frozen [01]\n)?$/.test(terminal.cgroupEvents));
}
export function verifyControlAdmission(binding, epoch, admission) {
  assert.equal(admission.schema, "benchmark-control-admission/v1");
  const seal = admission.seal;
  equal(seal.binding, binding); assert.equal(seal.epoch, epoch);
  assert.ok(["bootstrap", "audit-json-api", "audit-mixed-production"].includes(epoch));
  assert.ok(Array.isArray(admission.invocations) && admission.invocations.length > 0 && admission.invocations.length <= 4096);
  equal(seal.ledger, admission.invocations.map((v) => ({ id: v.id, sha256: hash(v) })));
  assert.equal(seal.final, admission.invocations.at(-1).id);
  assert.equal(new Set(admission.invocations.map((v) => v.id)).size, admission.invocations.length);
  assert.equal(admission.receipts.length, admission.invocations.length); assert.equal(admission.watchers.length, admission.invocations.length);
  assert.ok(admission.invocations.some((v) => v.channel === "ssh") && admission.invocations.some((v) => v.channel === "sftp"), "both actual control paths required");
  const identities = new Set();
  for (let i = 0; i < admission.invocations.length; i++) {
    const invocation = admission.invocations[i], receipt = admission.receipts[i], terminal = admission.watchers[i];
    for (const field of ["round", "commit", "token"]) assert.equal(invocation[field], binding[field]);
    assert.equal(invocation.purpose, epoch === "bootstrap" ? "bootstrap" : "audit");
    assert.equal(receipt.schema, "benchmark-control-session/v2", "legacy replay receipts cannot qualify a live session");
    verifyControlSession(invocation, receipt);
    equal(receipt.host, admission.host);
    verifyControlWatcher(invocation, receipt, terminal);
    assert.ok(BigInt(admission.closedMonoNs) >= BigInt(receipt.samples.at(-1).monoNs));
    for (const p of receipt.session.chain) {
      const key = `${p.pid}:${p.startTicks}`;
      assert.ok(!identities.has(key), "control identity reused across invocations"); identities.add(key);
    }
  }
  assert.equal(binding.helperSha256, guardianSha256, "native control source differs");
  return { epoch, sha256: hash(admission), qualification: "pending-first-host-native-proof" };
}
export function bootstrapControl(input) {
  const marker = JSON.parse(regular("/bench/bootstrap-ready.json", 1024));
  assert.equal(marker.schema, "benchmark-common-bootstrap/v2", "new native entry requires registered bootstrap");
  assert.equal(marker.round, input.round); assert.equal(marker.commit, input.commit);
  assert.equal(marker.controlHelperSha256, guardianSha256);
  return { round: input.round, commit: input.commit, token: marker.token, helperSha256: guardianSha256 };
}
export async function waitControlAdmission(binding, epoch, { signal, deadline } = {}) {
  const root = controlRoot(binding), stat = lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = spawnSync("/usr/bin/python3", ["-I", "-c", guardianSource, "inspect", binding.token, epoch],
      { cwd: "/bench", encoding: "utf8", input: "", timeout: Math.min(10000, Math.max(1, deadline - Date.now())),
        maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, windowsHide: true });
    assert.ok(!result.error && !result.signal && [0, 3].includes(result.status), "control observer failed; preserve custody");
    if (result.status === 0) {
      const admission = JSON.parse(result.stdout); verifyControlAdmission(binding, epoch, admission); return admission;
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error("control admission deadline expired; preserve custody");
}
export function beginControlWindow(binding) {
  controlOperation(binding, "window-open");
  return () => controlOperation(binding, "window-close");
}
export function controlOperation(binding, mode) {
  assert.ok(["activate", "window-open", "window-close"].includes(mode));
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", guardianSource, mode, binding.token],
    { cwd: "/bench", encoding: "utf8", input: "", timeout: 10000, maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, windowsHide: true });
  assert.ok(!result.error && !result.signal && result.status === 0, "control intrusion or window ownership uncertain");
}
