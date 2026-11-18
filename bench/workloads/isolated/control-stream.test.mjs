import assert from "node:assert/strict";
import test from "node:test";
import { apparatusProof, verifyApparatus, leaseState, streamLimits } from "./control-stream.mjs";

import { binding, registration, members, participant } from "../test-fixtures/control-stream-fixture.mjs";

test("presealed apparatus rejects identity, namespace, membership, thread and affinity changes", () => {
  const sample = { host: registration.host, monoNs: "2000000", members: structuredClone(members), listener: structuredClone(registration.listener) };
  assert.equal(verifyApparatus(binding, registration, sample).cpu, 0);
  for (const change of [
    (s) => { s.members[0].startTicks = "999"; }, (s) => { s.members[0].executable.inode = "999"; },
    (s) => { s.members[0].commandSha256 = "f".repeat(64); }, (s) => { s.members[0].cgroup = "0::/foreign\n"; },
    (s) => { s.members[0].cpus = "0-1"; }, (s) => { s.members[0].namespaces.net = "99"; },
    (s) => { s.members[0].threads.push({ pid: 99, startTicks: "100", cpus: "0" }); },
    (s) => { s.members.push(participant(30, 21, members[1].cgroup)); }, (s) => { s.members.pop(); },
    (s) => { s.host.bootId = "foreign"; },
    (s) => { s.listener.cpus = "0-1"; }, (s) => { s.listener.namespaces.mnt = "99"; },
    (s) => { s.listener.threads.push({ pid: 98, startTicks: "100", cpus: "0" }); },
  ]) { const altered = structuredClone(sample); change(altered); assert.throws(() => verifyApparatus(binding, registration, altered)); }
  assert.throws(() => apparatusProof(binding, registration, sample, { app: "0-1", api: "2-3", load: "4-7" }));
  assert.throws(() => apparatusProof(binding, registration, sample, null));
  assert.doesNotThrow(() => apparatusProof(binding, registration, sample, { app: "1", api: "2-3", load: "4-7" }));
});

test("lease expiry is irrevocable publication failure, never terminal or drainage proof", () => {
  const lease = leaseState({ now: 0n, leaseMs: 1000 });
  const challenge = lease.challenge(0n);
  lease.renew(challenge, 1n);
  assert.throws(() => lease.renew(challenge, 2n), /challenge/);
  assert.equal(lease.valid(999000000n), true);
  assert.equal(lease.valid(1000000001n), false);
  assert.equal(lease.valid(1n), false);
  assert.throws(() => lease.renew(lease.challenge(1000000002n), 1000000003n));
  assert.equal(lease.snapshot().terminal, false);
});
