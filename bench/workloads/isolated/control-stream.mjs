// Fixed supervised-control contract. Invalidation is deliberately not terminal proof.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { processStat } from "./host-observation.mjs";
import { socketProof } from "../cloud-control-session.mjs";
import { verifyNativePartition } from "./native-roles.mjs";

export { nativeControlPartition } from "./native-roles.mjs";

export const streamLimits = Object.freeze({ leaseMs: 15000, challengeMs: 1000, maximumMs: 48 * 60 * 60 * 1000,
  frameBytes: 65536, journalBytes: 64 * 1024 * 1024, auditBytes: 256 * 1024 * 1024, auditFileBytes: 128 * 1024 * 1024,
  auditFiles: 8192, auditChunkBytes: 32768, deliveryBytes: 16 * 1024 * 1024,
  frames: 100000, sampleGapMs: 2000 });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const streamHash = (value) => hash(JSON.stringify(value));
const same = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);

export function verifyApparatus(binding, registration, sample) {
  assert.equal(registration.schema, "benchmark-control-apparatus/v1");
  same(registration.binding, binding, "apparatus source/reservation changed");
  assert.match(registration.id, /^[a-f0-9]{32}$/);
  assert.match(registration.host.hostname, /^[A-Za-z0-9.-]{1,253}$/);
  assert.match(registration.host.bootId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  socketProof(registration.socket, registration.members);
  assert.ok(registration.members.length > 0 && registration.members.length <= 32);
  assert.ok(BigInt(registration.deadlineMonoNs) - BigInt(registration.createdMonoNs) === BigInt(streamLimits.maximumMs) * 1000000n);
  same(sample.host, registration.host, "apparatus host/boot changed");
  same(sample.members, registration.members, "apparatus identity/membership/affinity changed");
  same(sample.listener, registration.listener, "apparatus listener identity/affinity changed");
  assert.ok(BigInt(sample.monoNs) >= BigInt(registration.createdMonoNs) && BigInt(sample.monoNs) < BigInt(registration.deadlineMonoNs));
  const pids = new Set();
  const tids = new Set();
  for (const p of [...registration.members, registration.listener]) {
    assert.ok(Number.isSafeInteger(p.pid) && p.pid > 1 && !pids.has(p.pid)); pids.add(p.pid);
    assert.match(p.startTicks, /^[1-9]\d*$/);
    if (p !== registration.listener) assert.match(p.commandSha256, /^[a-f0-9]{64}$/);
    assert.ok(p.executable && /^\d+$/.test(p.executable.device) && /^\d+$/.test(p.executable.inode));
    assert.match(p.cgroup, /^0::\/[^\r\n\0]*\n$/); assert.equal(p.cpus, "0");
    same(Object.keys(p.namespaces).sort(), ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"], "namespace proof missing");
    assert.ok(Object.values(p.namespaces).every((v) => /^\d+$/.test(v)));
    assert.ok(p.threads.length > 0 && p.threads.length <= 32);
    assert.ok(p.threads.some((t) => t.pid === p.pid && t.startTicks === p.startTicks));
    for (const t of p.threads) {
      assert.ok(Number.isSafeInteger(t.pid) && t.pid > 1 && !tids.has(t.pid)); tids.add(t.pid);
      assert.match(t.startTicks, /^[1-9]\d*$/); assert.equal(t.cpus, "0");
    }
  }
  for (const [i, p] of registration.members.entries()) assert.equal(p.parentPid, i ? registration.members[i - 1].pid : registration.listener.pid);
  return { cpu: 0, registrationSha256: streamHash(registration), qualification: "pending-first-host-native-proof" };
}

export function apparatusProof(binding, registration, sample, cpus, roles = ["app", "api", "load"]) {
  const proof = verifyApparatus(binding, registration, sample);
  verifyNativePartition(cpus, roles);
  return proof;
}

export function leaseState({ now, leaseMs = streamLimits.leaseMs }) {
  assert.ok(typeof now === "bigint" && Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= streamLimits.leaseMs);
  let expires = now + BigInt(leaseMs) * 1000000n, last = now, revoked = false, pending, sequence = 0;
  const valid = (at) => {
    if (at < last || at >= expires) revoked = true;
    last = at; return !revoked;
  };
  return {
    valid,
    challenge(at) { assert.ok(valid(at), "lease irrevocably expired"); pending = { sequence: ++sequence, nonce: randomBytes(16).toString("hex") }; return { ...pending }; },
    renew(value, at) {
      assert.ok(valid(at), "lease irrevocably expired"); same(value, pending, "stale or replayed challenge"); assert.ok(pending, "missing challenge");
      pending = undefined; expires = at + BigInt(leaseMs) * 1000000n;
    },
    snapshot() { return { revoked, expiresMonoNs: String(expires), sequence, terminal: false }; },
  };
}

// No subprocesses or namespace entry. This is also used by the campaign's independent
// watchdog, so a frozen/dead SSH guardian cannot keep native publication authorized.
export function readApparatus(registration) {
  const readMember = (expected) => {
    const root = `/proc/${expected.pid}`, raw = readFileSync(`${root}/stat`, "utf8"), parsed = processStat(raw);
    assert.ok(parsed && !parsed.kernelThread);
    const executable = statSync(`${root}/exe`, { bigint: true });
    const cpus = (path) => { const match = /^Cpus_allowed_list:\s*([^\r\n]+)$/m.exec(readFileSync(path, "utf8")); assert.ok(match); return match[1]; };
    const threads = readdirSync(`${root}/task`).map(Number).sort((a, b) => a - b).map((pid) => {
      const t = processStat(readFileSync(`${root}/task/${pid}/stat`, "utf8")); assert.ok(t && t.pid === pid);
      return { pid, startTicks: t.startTicks, cpus: cpus(`${root}/task/${pid}/status`) };
    });
    const namespaces = Object.fromEntries(["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"].map((key) => {
      const link = readlinkSync(`${root}/ns/${key}`), match = /^\w+:\[(\d+)\]$/.exec(link); assert.ok(match); return [key, match[1]];
    }));
    return { pid: parsed.pid, startTicks: parsed.startTicks, parentPid: parsed.parentPid,
      cgroup: readFileSync(`${root}/cgroup`, "utf8"), executable: { device: String(executable.dev), inode: String(executable.ino) },
      commandSha256: hash(readFileSync(`${root}/cmdline`)), cpus: cpus(`${root}/status`), namespaces, threads };
  };
  const members = registration.members.map(readMember), listener = readMember(registration.listener);
  delete listener.commandSha256;
  const pids = new Set(members.map((p) => p.pid)), scopes = new Set(members.filter((p) => /\/session-[^/]+\.scope\n$/.test(p.cgroup)).map((p) => p.cgroup));
  for (const name of readdirSync("/proc").filter((s) => /^\d+$/.test(s))) {
    try {
      const raw = readFileSync(`/proc/${name}/stat`, "utf8"), p = processStat(raw); assert.ok(p);
      const group = readFileSync(`/proc/${name}/cgroup`, "utf8");
      assert.ok(pids.has(p.pid) || (!pids.has(p.parentPid) && !scopes.has(group)), "new control child/scope member");
      assert.ok(p.pid === registration.listener.pid || pids.has(p.pid)
        || (p.parentPid !== registration.listener.pid && group !== registration.listener.cgroup
          && !group.startsWith("0::/user.slice/") && !/\/session-[^/]+\.scope(?:\/|\n)/.test(group)), "new SSH/login participant");
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  return { host: { hostname: readFileSync("/proc/sys/kernel/hostname", "utf8").trim(), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() },
    monoNs: String(process.hrtime.bigint()), members, listener };
}

export function verifyStreamSeal(binding, proof) {
  assert.equal(proof.schema, "benchmark-control-stream-seal/v1");
  const r = proof.registration;
  verifyApparatus(binding, r, { host: r.host, monoNs: proof.sealedMonoNs, members: r.members, listener: r.listener });
  assert.equal(proof.lease.id, r.id); same(proof.lease.host, r.host, "lease boot changed");
  assert.ok(BigInt(proof.lease.expiresMonoNs) > BigInt(proof.sealedMonoNs));
  assert.ok(proof.observations.length > 0 && proof.observations.length <= 350000);
  const registrationSha256 = streamHash(r);
  let previous = BigInt(r.createdMonoNs);
  for (const [i, row] of proof.observations.entries()) {
    assert.equal(row.sequence, i + 1); assert.equal(row.registrationSha256, registrationSha256);
    const at = BigInt(row.monoNs); assert.ok(at >= previous && at - previous <= BigInt(streamLimits.sampleGapMs) * 1000000n);
    previous = at;
  }
  assert.ok(BigInt(proof.sealedMonoNs) >= previous && BigInt(proof.sealedMonoNs) - previous <= BigInt(streamLimits.sampleGapMs) * 1000000n);
  return { registrationSha256: streamHash(r), sealedMonoNs: proof.sealedMonoNs };
}

export function verifyStreamAudit(binding, registration, proof, group, subjectSha256) {
  same(proof.binding, binding, "audit stream belongs to another source/reservation");
  assert.equal(proof.id, registration.id); assert.equal(proof.registrationSha256, streamHash(registration));
  assert.equal(proof.intent.group, group); assert.equal(proof.intent.subjectSha256, subjectSha256);
  assert.match(proof.intent.campaign, new RegExp(`^${binding.round}-[a-f0-9]{16}$`));
  assert.match(proof.intent.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(proof.intent.bytes) && proof.intent.bytes > 0 && proof.intent.bytes <= streamLimits.deliveryBytes);
  assert.ok(Number.isSafeInteger(proof.renewal) && proof.renewal > 0);
  assert.ok(BigInt(proof.monoNs) >= BigInt(registration.createdMonoNs) && BigInt(proof.monoNs) < BigInt(registration.deadlineMonoNs));
}

export function verifyStreamDrain(binding, registration, proof) {
  same(registration.binding, binding, "drain source changed");
  assert.equal(proof.schema, "benchmark-control-stream-drain/v1");
  assert.equal(proof.id, registration.id); assert.equal(proof.registrationSha256, streamHash(registration));
  same(proof.host, registration.host, "drain boot changed"); assert.equal(proof.identitiesAbsent, true);
  assert.ok(BigInt(proof.monoNs) >= BigInt(registration.createdMonoNs) && BigInt(proof.monoNs) < BigInt(registration.deadlineMonoNs));
  for (const key of ["pid", "startTicks", "cgroup", "executable"]) same(proof.listener[key], registration.listener[key], "listener changed");
  const scopes = [...new Set(registration.members.map((p) => p.cgroup.slice(3, -1)).filter((p) => /\/session-[^/]+\.scope$/.test(p)))].sort();
  assert.ok(scopes.length > 0); same(proof.scopes.map((s) => s.path), scopes, "drain scope membership differs");
  for (const scope of proof.scopes) {
    assert.equal(typeof scope.exists, "boolean"); same(scope.members, [], "apparatus scope populated");
    if (scope.exists) assert.match(scope.events, /^populated 0\n(?:frozen [01]\n)?$/);
    else assert.equal(scope.events, null);
  }
  return { remoteDrained: true, authority: "none" };
}
