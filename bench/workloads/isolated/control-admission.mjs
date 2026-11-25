// Live fixed-path admission and immutable replay. No provider, SSH, or cleanup authority.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { guardianSource, guardianSha256 } from "../cloud-control-runtime.mjs";
import { verifyControlSession } from "../cloud-control-session.mjs";
import { regular } from "../cloud-local.mjs";
import { verifyApparatus } from "./control-stream.mjs";

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
  if (admission.apparatus) verifyApparatus(binding, admission.apparatus, admission.apparatusSample);
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
  assert.equal(marker.group, input.group ?? "all");
  if (marker.offlineHandoff !== undefined) {
    assert.equal(marker.offlineHandoff, true);
    assert.equal(marker.monitorId, undefined);
    assert.ok(input.group);
  }
  return { round: input.round, commit: input.commit, token: marker.token, helperSha256: guardianSha256,
    ...(marker.offlineHandoff ? { offlineHandoff: true } : {}) };
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
      const admission = JSON.parse(result.stdout); verifyControlAdmission(binding, epoch, admission);
      if (epoch === "bootstrap") {
        const marker = JSON.parse(regular("/bench/bootstrap-ready.json", 1024));
        assert.equal(admission.apparatus?.id, marker.monitorId, "controller monitor identity differs");
      }
      return admission;
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error("control admission deadline expired; preserve custody");
}
export function beginControlWindow(binding) {
  controlOperation(binding, "window-open");
  return () => controlOperation(binding, "window-close");
}

const fenceTable = "corten_bench_native";
export const offlineFenceRules = `create table inet ${fenceTable}
add chain inet ${fenceTable} input { type filter hook input priority 10; policy accept; }
add rule inet ${fenceTable} input tcp dport 22 tcp flags & (fin | syn | rst | ack) == syn limit rate 8/minute burst 8 packets counter drop
add rule inet ${fenceTable} input tcp dport 22 counter drop
`;
// A refusal names only a fixed fence step and outcome class, never nft's output.
export function fenceOutcome(result) {
  if (result.error) return `error=${/^E[A-Z0-9]{1,31}$/.test(result.error.code) ? result.error.code : "unknown"}`;
  if (result.signal) return `signal=${/^SIG[A-Z0-9]{1,15}$/.test(result.signal) ? result.signal : "unknown"}`;
  return `exit=${Number.isSafeInteger(result.status) ? result.status : "unknown"}`;
}
const nft = (operation, args) => {
  // No stdin input and no working directory dependency: Node gives a child a
  // socket for piped stdin, and nft refuses `-f -` on a socket.
  const result = spawnSync("/usr/bin/taskset", ["-c", "0", "/usr/sbin/nft", ...args],
    { cwd: "/", encoding: "utf8", input: "", timeout: 10000, maxBuffer: 8192,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  assert.ok(!result.error && !result.signal && result.status === 0, `native SSH fence unavailable: ${operation} ${fenceOutcome(result)}`);
  return result.stdout;
};
// A readback that does not parse or verify refuses with its step and class
// only: parse and assertion messages can quote host output.
function fenceChecked(step, verify, value) {
  let checked;
  try { checked = verify(value); } catch { assert.fail(`native SSH fence unavailable: ${step}`); }
  return checked;
}
const fenceRead = (step) => fenceChecked(`${step} readback invalid`, JSON.parse,
  nft(`${step} readback`, ["-j", "-a", "list", "table", "inet", fenceTable]));
export function verifyOfflineFence(sample) {
  assert.deepEqual(Object.keys(sample), ["nftables"]);
  const [meta, ...rules] = sample.nftables;
  assert.equal(meta?.metainfo?.json_schema_version, 1);
  // Only fresh SYNs denied here, before sshd, can grow the first counter.
  // Excess probes and everything else on port 22 are still interference.
  const probeCounter = rules[2]?.rule?.expr?.[3]?.counter;
  const { packets, bytes } = probeCounter ?? {};
  assert.deepEqual(probeCounter, { packets, bytes });
  assert.ok([packets, bytes].every((n) => Number.isSafeInteger(n) && n >= 0)
    && (packets === 0 ? bytes === 0 : bytes >= packets), "invalid pre-login probe counters");
  const handles = [];
  const policy = rules.map((row, i) => {
    const [[kind, { handle, ...body }], ...rest] = Object.entries(row);
    assert.equal(rest.length, 0);
    assert.ok(Number.isSafeInteger(handle) && handle > 0);
    handles.push(handle);
    if (i === 2) body.expr = body.expr.map((expr, j) => j === 3 ? { ...expr, counter: { packets: 0, bytes: 0 } } : expr);
    return { [kind]: body };
  });
  const tcpMatch = { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 22 } };
  const zeroCounter = { counter: { packets: 0, bytes: 0 } };
  assert.deepEqual(policy, [
    { table: { family: "inet", name: fenceTable } },
    { chain: { family: "inet", table: fenceTable, name: "input", type: "filter", hook: "input", prio: 10, policy: "accept" } },
    { rule: { family: "inet", table: fenceTable, chain: "input",
      expr: [tcpMatch, { match: { op: "==", left: { "&": [{ payload: { protocol: "tcp", field: "flags" } }, ["fin", "syn", "rst", "ack"]] },
        right: "syn" } }, { limit: { rate: 8, burst: 8, per: "minute" } }, zeroCounter, { drop: null }] } },
    { rule: { family: "inet", table: fenceTable, chain: "input", expr: [tcpMatch, zeroCounter, { drop: null }] } },
  ]);
  return { policy: { meta, rules: policy, handles }, packets, bytes };
}
export function verifyOfflineWindow(proof) {
  assert.deepEqual(Object.keys(proof).sort(), ["after", "before"]);
  const before = verifyOfflineFence(proof.before), after = verifyOfflineFence(proof.after);
  assert.deepEqual(before.policy, after.policy, "native SSH fence changed during phase");
  assert.ok(after.packets >= before.packets && after.bytes >= before.bytes
    && (after.packets === before.packets ? after.bytes === before.bytes : after.bytes - before.bytes >= after.packets - before.packets),
  "pre-login probe counters regressed or diverged");
  return { packets: after.packets - before.packets, bytes: after.bytes - before.bytes };
}
/** Install the fence as one atomic argv batch and return its verified readback. */
export function installOfflineFence() {
  nft("install", [offlineFenceRules]);
  const before = fenceRead("install");
  fenceChecked("install readback policy mismatch", verifyOfflineFence, before);
  return before;
}
export function beginOfflineWindow(binding) {
  // Block new SSH input before checking that the preceding guarded epoch
  // drained. On uncertainty leave the fence to systemd's terminal stop hook.
  const before = installOfflineFence();
  const close = beginControlWindow(binding);
  return () => {
    close();
    const proof = { before, after: fenceRead("close") };
    const ingress = fenceChecked("close readback policy mismatch", verifyOfflineWindow, proof);
    nft("remove", ["delete", "table", "inet", fenceTable]);
    return { proof, ingress };
  };
}
export function controlOperation(binding, mode) {
  assert.ok(["activate", "window-open", "window-close"].includes(mode));
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", guardianSource, mode, binding.token],
    { cwd: "/bench", encoding: "utf8", input: "", timeout: 10000, maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, windowsHide: true });
  assert.ok(!result.error && !result.signal && result.status === 0, "control intrusion or window ownership uncertain");
}
