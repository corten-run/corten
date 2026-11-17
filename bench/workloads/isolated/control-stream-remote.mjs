// Campaign-owned lease consumer, independent of the SSH guardian. No reconnect.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digest, durable, readRegular, syncDirectory } from "./evidence.mjs";
import { guardianSource } from "../cloud-control-runtime.mjs";
import { apparatusProof, readApparatus, streamHash, streamLimits, verifyApparatus, verifyStreamDrain, verifyStreamSeal } from "./control-stream.mjs";

// A lease slot is atomically replaced by its sole source-bound writer. A reader
// may hold the previous unlinked inode, never a partially written replacement.
function leaseJSON(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd); assert.ok(before.isFile() && before.nlink <= 1 && before.size <= 65536);
    if (process.getuid) assert.ok(before.uid === process.getuid() && (before.mode & 0o077) === 0);
    const bytes = readFileSync(fd), after = fstatSync(fd);
    for (const key of ["dev", "ino", "size", "mtimeMs", "uid", "mode"]) assert.equal(before[key], after[key]);
    assert.equal(bytes.length, before.size); return JSON.parse(bytes);
  } finally { closeSync(fd); }
}

// Injection is local test support, never selected from reservation or wire data.
export function superviseControlStream(binding, admission, abort, runtime = {}) {
  const root = runtime.root ?? "/run/corten-bench-control-" + binding.token, registration = admission.apparatus;
  assert.ok(registration, "supervised entry requires presealed apparatus");
  const now = runtime.now ?? (() => process.hrtime.bigint()), sample = runtime.sample ?? readApparatus;
  const sleep = runtime.sleep ?? delay, probe = runtime.probe ?? (() => spawnSync("/usr/bin/python3", ["-I", "-c", guardianSource, "stream-drain", binding.token],
    { cwd: "/bench", encoding: "utf8", timeout: 1000, maxBuffer: 65536, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, windowsHide: true }));
  const read = (name) => name === "stream-lease.json" ? leaseJSON(join(root, name)) : JSON.parse(readRegular(join(root, name)));
  assert.equal(streamHash(read("stream-registration.json")), streamHash(registration));
  let revoked = false, timer, ended = false, sealed = false, draining = false, windowStart, renewal = 0;
  const invalidate = () => {
    revoked = true;
    try {
      if (!existsSync(join(root, "stream-invalid.json"))) durable(join(root, "stream-invalid.json"), JSON.stringify({ id: registration.id,
        host: registration.host, monoNs: String(now()), reason: "independent campaign lease watchdog failed" }));
    } finally { abort.abort(); }
  };
  const check = () => {
    try {
      assert.ok(!revoked && !existsSync(join(root, "stream-invalid.json")), "control lease revoked");
      const lease = read("stream-lease.json"), at = now();
      assert.equal(lease.id, registration.id); assert.deepEqual(lease.host, registration.host);
      assert.ok(Number.isSafeInteger(lease.renewal) && lease.renewal >= renewal); renewal = lease.renewal;
      assert.ok(at < BigInt(lease.expiresMonoNs) && BigInt(lease.expiresMonoNs) - at <= BigInt(streamLimits.leaseMs) * 1000000n);
      assert.ok(at >= BigInt(lease.observedMonoNs) && at - BigInt(lease.observedMonoNs) <= BigInt(streamLimits.sampleGapMs) * 1000000n);
      const observed = sample(registration); verifyApparatus(binding, registration, observed); return observed;
    } catch (error) { invalidate(); throw error; }
  };
  const publish = (kind, payload) => {
    check();
    const path = join(root, "stream-state.json"), stage = path + ".pending";
    durable(stage, JSON.stringify({ kind, payload })); renameSync(stage, path); syncDirectory(root);
  };
  check();
  timer = setInterval(() => { try { check(); } catch { clearInterval(timer); } }, 250);
  return {
    registration, check,
    open(cpus) { assert.ok(!sealed && !draining && !windowStart); const observed = check(); apparatusProof(binding, registration, observed, cpus); windowStart = observed.monoNs; return observed; },
    close() { const observed = check(); assert.ok(windowStart && BigInt(observed.monoNs) >= BigInt(windowStart)); windowStart = undefined; return observed; },
    progress(status) {
      assert.ok(!sealed && !draining);
      if (status.state === "blocked-review-needed") publish("audit-ready", { campaign: status.campaign, group: status.auditGroup,
        subjectSha256: status.auditGroup === "mixed-production" ? status.mixedAuditSubjectSha256 : status.auditSubjectSha256 });
      else publish("progress", status);
    },
    audit(group, bytes) {
      check(); assert.ok(!sealed && !draining); const proof = read("stream-audit-" + group + ".json");
      assert.deepEqual(proof.binding, binding); assert.equal(proof.id, registration.id);
      assert.equal(proof.registrationSha256, streamHash(registration)); assert.equal(proof.intent.sha256, digest(bytes));
      assert.equal(proof.intent.bytes, bytes.length); assert.equal(proof.intent.group, group); return proof;
    },
    async seal() {
      check(); assert.ok(!sealed && !draining && windowStart === undefined); publish("seal", {});
      const deadline = now() + 10000000000n;
      for (let attempts = 0; !existsSync(join(root, "stream-sealed.json")); attempts++) {
        check(); assert.ok(attempts < 100 && now() < deadline, "stream seal deadline expired"); await sleep(100);
      }
      check(); const commitment = read("stream-sealed.json"), bytes = readRegular(join(root, "stream-observations.jsonl"));
      assert.ok(bytes.length <= streamLimits.journalBytes && bytes.at(-1) === 10); assert.equal(digest(bytes), commitment.observationsSha256);
      const proof = { schema: "benchmark-control-stream-seal/v1", registration, observations: bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse),
        sealedMonoNs: commitment.monoNs, lease: commitment.lease };
      verifyStreamSeal(binding, proof); sealed = true; return proof;
    },
    async finish(payload) {
      assert.ok(sealed && !draining && !windowStart); publish("terminal", payload); draining = true; clearInterval(timer);
      // Only the independently owned campaign process may observe the SSH tree
      // disappear. Local EOF is not an input to this proof.
      const deadline = now() + 10000000000n;
      try {
        for (let attempts = 0; attempts < 100 && now() < deadline; attempts++) {
          assert.ok(!abort.signal.aborted && !existsSync(join(root, "stream-invalid.json")));
          const result = probe();
          assert.ok(!result.error && !result.signal && [0, 3].includes(result.status), "apparatus drain uncertain");
          if (result.status === 0) {
            const proof = JSON.parse(result.stdout); verifyStreamDrain(binding, registration, proof); ended = true; return proof;
          }
          await sleep(100);
        }
        assert.fail("apparatus disappearance deadline expired");
      } catch (error) { invalidate(); throw error; }
    },
    dispose() { clearInterval(timer); if (!ended && !revoked) invalidate(); },
  };
}
