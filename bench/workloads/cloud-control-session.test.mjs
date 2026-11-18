import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { validateControlInvocation, verifyControlDrainBoundary, verifyControlSession } from "./cloud-control-session.mjs";
import { reservation } from "./cloud-contract.mjs";
import { shellTransport } from "./cloud-transport.mjs";
import { controlSessionPreflight, replayControlSessionPreflight } from "./isolated/control-session-qualification.mjs";
import { verifyHostBoundary } from "./isolated/host-observation.mjs";

const host = { hostname: "synthetic-host", bootId: "01234567-89ab-cdef-0123-456789abcdef" };
const state = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
const scope = "/user.slice/user-0.slice/session-7.scope";
function processRow(pid, parentPid, cgroup, startTicks = "100", comm = "arbitrary", flags = "0") {
  const fields = Array(49).fill("0"); fields[0] = String(parentPid); fields[5] = flags; fields[18] = startTicks;
  return { pid, startTicks, cgroup: `0::${cgroup}\n`, stat: `${pid} (${comm}) S ${fields.join(" ")}\n`,
    executable: { device: "1", inode: String(pid) }, commandSha256: "d".repeat(64) };
}
const listener = processRow(10, 1, "/system.slice/ssh.service");
const observer = processRow(20, 1, `/system.slice/${state.unit}/supervisor`);
const identity = ({ pid, startTicks, cgroup, executable, commandSha256 }) => ({ pid, startTicks, cgroup, executable, commandSha256 });
const hostSample = (monoNs, processes) => ({ ...host, monoNs: String(monoNs), containers: [], networks: [], processes: structuredClone(processes) });
function fixture(offset = 0, channel = "ssh", purpose = "bootstrap") {
  const invocation = { schema: "benchmark-control-invocation/v1", round: state.round, commit: state.commit, token: state.token,
    id: (offset + 1).toString(16).padStart(32, "0"), channel, purpose, requestSha256: "b".repeat(64), deadlineMs: 60000 };
  const sessionScope = `/user.slice/user-0.slice/session-${7 + offset}.scope`;
  const chain = [processRow(100 + offset, 10, "/system.slice/ssh.service"), processRow(101 + offset, 100 + offset, sessionScope)];
  const base = [processRow(1, 0, "/init.scope"), listener, observer,
    processRow(2, 0, "/", "10", "not-an-exemption", "2097152")];
  const sample = (monoNs, processes, exists = true) => ({ ...host, monoNs: String(monoNs), processes: structuredClone(processes),
    scope: { path: sessionScope, exists, events: exists ? `populated ${processes.some((p) => p.cgroup === `0::${sessionScope}\n`) ? 1 : 0}\nfrozen 0\n` : null,
      members: processes.filter((p) => p.cgroup === `0::${sessionScope}\n`).map((p) => p.pid).sort((a, b) => a - b) } });
  const receipt = { schema: "benchmark-control-session/v1", invocation: structuredClone(invocation), host,
    listener: identity(listener), observer: identity(observer), session: { scope: sessionScope, chain: chain.map(identity) },
    samples: [sample(200, [...base, ...chain]), sample(400, base)],
    result: { transport: "exited", code: 0, releasedMonoNs: "250", completedMonoNs: "300" } };
  return { invocation, receipt, chain, base, sample,
    boundary: { before: hostSample(100, base), originalAfter: hostSample(350, [...base, ...chain]), settledAfter: hostSample(500, base),
      invocations: [invocation], receipts: [receipt] } };
}

test("local SSH and SFTP client exit explicitly leaves remote drainage unproved", () => {
  const run = shellTransport({ repo: resolve("."), spawn: () => ({ status: 0, stdout: "synthetic" }) });
  for (const [binary, args] of [["ssh", ["root@192.0.2.10", "true"]], ["scp", [resolve("synthetic"), "root@192.0.2.10:/bench/job.sh"]]]) {
    const result = run(binary, args); assert.equal(result.status, 0); assert.equal(result.remoteDrained, false);
  }
  assert.equal(run("git", ["status"]).remoteDrained, undefined);
});

test("SSH and SFTP receipts bind pre-release ancestry, host observer and terminal disappearance", () => {
  for (const channel of ["ssh", "sftp"]) {
    const { invocation, receipt } = fixture(0, channel), original = structuredClone(receipt);
    assert.equal(validateControlInvocation(invocation), invocation);
    const proof = verifyControlSession(invocation, receipt);
    assert.equal(proof.remoteDrained, true); assert.equal(proof.authority, "none");
    assert.equal(proof.identities.length, 2); assert.match(proof.receiptSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(receipt, original);
    receipt.samples.at(-1).scope = { path: scope, exists: false, events: null, members: [] };
    assert.equal(verifyControlSession(invocation, receipt).status, "replayed");
  }
});

test("receipt fields cannot substitute another invocation, source, channel or remote result", () => {
  const mutations = [
    (r) => { r.invocation.id = "f".repeat(32); }, (r) => { r.invocation.commit = "c".repeat(40); },
    (r) => { r.invocation.channel = "sftp"; }, (r) => { r.invocation.requestSha256 = "c".repeat(64); },
    (r) => { r.invocation.token = "f".repeat(16); }, (r) => { r.extra = true; },
    (r) => { r.result.transport = "timeout"; }, (r) => { r.result.transport = "cancelled"; },
    (r) => { r.result.transport = "disconnected"; }, (r) => { r.result.code = null; },
    (r) => { r.result.releasedMonoNs = "100"; }, (r) => { r.result.completedMonoNs = "401"; },
    (r) => { r.samples[1].bootId = "ffffffff-89ab-cdef-0123-456789abcdef"; },
    (r) => { r.samples[1].hostname = "other-host"; }, (r) => { r.samples[1].monoNs = "200"; },
    (r) => { r.samples[1].monoNs = "1000000201"; },
  ];
  for (const mutate of mutations) { const { invocation, receipt } = fixture(); mutate(receipt); assert.throws(() => verifyControlSession(invocation, receipt)); }
});

test("scope, PID-start and ancestry mistakes cannot claim ownership or empty remote state", () => {
  const mutations = [
    (r) => { r.session.scope = "/system.slice/ssh.service"; },
    (r) => { r.session.chain[0].startTicks = "101"; },
    (r) => { r.session.chain[0] = r.listener; }, (r) => { r.observer = r.session.chain[1]; },
    (r) => { r.session.chain[1].cgroup = "0::/other.scope\n"; },
    (r) => { r.samples[0].processes.find((p) => p.pid === 101).stat = processRow(101, 1, scope).stat; },
    (r) => { r.samples[0].processes.push(processRow(999, 1, scope)); r.samples[0].scope.members.push(999); },
    (r) => { r.samples[1].processes.push(r.samples[0].processes.find((p) => p.pid === 100)); },
    (r) => { r.samples[1].scope.events = "populated 1\nfrozen 0\n"; },
    (r) => { r.samples[1].processes = r.samples[1].processes.filter((p) => p.pid !== 20); },
  ];
  for (const mutate of mutations) { const { invocation, receipt } = fixture(); mutate(receipt); assert.throws(() => verifyControlSession(invocation, receipt)); }
});

test("a payload descendant must disappear even after leaving the registered session scope", () => {
  const { invocation, receipt, base, chain, sample } = fixture();
  const descendant = processRow(102, 101, scope);
  receipt.samples.splice(1, 0, sample(300, [...base, ...chain, descendant]));
  assert.equal(verifyControlSession(invocation, receipt).remoteDrained, true);
  receipt.samples.at(-1).processes.push({ ...descendant, cgroup: "0::/elsewhere.scope\n" });
  assert.throws(() => verifyControlSession(invocation, receipt), /descendant remains/);
});

test("normal nonzero command results remain distinct from uncertain cancellation/timeout", () => {
  const { invocation, receipt } = fixture(); receipt.result.code = 3;
  assert.equal(verifyControlSession(invocation, receipt).remoteDrained, true);
  invocation.deadlineMs = 1; receipt.invocation.deadlineMs = 1;
  receipt.samples[1].monoNs = "1000201";
  assert.throws(() => verifyControlSession(invocation, receipt), /drainage deadline/);
});

test("settle proof preserves raw first bookend and the unchanged whole-host boundary", () => {
  const { boundary } = fixture(), original = structuredClone(boundary);
  assert.throws(() => verifyHostBoundary(boundary.before, boundary.originalAfter), /persistent host processes/);
  const proof = verifyControlDrainBoundary(boundary);
  assert.equal(proof.status, "replayed"); assert.equal(proof.authority, "none");
  assert.notEqual(proof.originalAfterSha256, proof.settledAfterSha256);
  assert.deepEqual(boundary, original, "no raw bookend is rewritten");
});

test("late clean snapshots cannot hide original native/unknown processes, containers or networks", () => {
  for (const comm of ["node", "sshd", "sshd-session", "sftp-server", "anything"]) {
    const { boundary } = fixture(); boundary.originalAfter.processes.push(processRow(999, 1, "/other", "999", comm));
    assert.throws(() => verifyControlDrainBoundary(boundary), /persistent host processes/);
  }
  for (const field of ["containers", "networks"]) {
    const { boundary } = fixture(); boundary.originalAfter[field].push("native-leftover");
    assert.throws(() => verifyControlDrainBoundary(boundary), /native/);
  }
  const { boundary, chain } = fixture(); boundary.settledAfter.processes.push(chain[0]);
  assert.throws(() => verifyControlDrainBoundary(boundary), /persistent host processes/);
});

test("native payload descendants are never reclassified as pre-registered control identities", () => {
  const { boundary, receipt, base, chain, sample } = fixture();
  const worker = processRow(102, 101, scope, "101", "native-worker");
  receipt.samples.splice(1, 0, sample(300, [...base, ...chain, worker]));
  boundary.originalAfter.processes.push(worker);
  assert.throws(() => verifyControlDrainBoundary(boundary), /persistent host processes/);
});

test("clean direct-command observer metadata does not clear thirteen unexplained userspace survivors", () => {
  // A synthetic reproduction of the rejected inference, not recovered historical attribution.
  const { boundary } = fixture();
  const directCommand = { observerError: null, terminal: true, attached: true, empty: true };
  assert.equal(directCommand.observerError, null);
  for (let i = 0; i < 13; i++) boundary.originalAfter.processes.push(processRow(700 + i, 1, "/unattributed", "999", "synthetic-ssh-associated"));
  assert.equal(verifyHostBoundary(boundary.before, boundary.settledAfter).cleanup, "observed-boundary-matched");
  assert.throws(() => verifyControlDrainBoundary(boundary), /new persistent host processes remain: 13/);
});

test("baseline absorption, replayed identities, future receipts and missing ledgers reject", () => {
  for (const mutate of [
    (b) => { b.before.processes.push(b.originalAfter.processes.at(-1)); },
    (b) => { b.invocations.push(b.invocations[0]); b.receipts.push(b.receipts[0]); },
    (b) => { b.receipts = []; }, (b) => { b.before.monoNs = "250"; },
    (b) => { b.originalAfter.monoNs = "299"; }, (b) => { b.settledAfter.monoNs = "399"; },
    (b) => { b.originalAfter.processes.at(-1).cgroup = "0::/container\n"; },
    (b) => { b.originalAfter.processes.at(-1).executable.inode = "9999"; },
    (b) => { b.originalAfter.processes.at(-1).commandSha256 = "e".repeat(64); },
    (b) => { b.before.processes.push(processRow(777, 1, "/system.slice/ssh.service")); },
    (b) => { b.before.processes.push(processRow(777, 10, "/unknown")); },
    (b) => { b.before.processes.push(processRow(777, 1, "/user.slice/user-0.slice/session-90.scope")); },
  ]) { const { boundary } = fixture(); mutate(boundary); assert.throws(() => verifyControlDrainBoundary(boundary)); }
  const { boundary, chain } = fixture();
  boundary.settledAfter.processes.push({ ...chain[0], startTicks: "999", stat: processRow(100, 1, "/other", "999").stat });
  assert.throws(() => verifyControlDrainBoundary(boundary), /persistent host processes/);
});

test("source-bound first-host qualification requires SSH and SFTP and stays pending native proof", () => {
  const plan = controlSessionPreflight(state);
  assert.equal(plan.commit, state.commit); assert.equal(plan.unit, state.unit);
  assert.deepEqual(plan.required, ["ssh", "sftp"].map((channel) => ({ purpose: "bootstrap", channel })));
  assert.deepEqual(controlSessionPreflight(state, "audit").required,
    ["ssh", "sftp"].map((channel) => ({ purpose: "audit", channel })));
  const f = fixture(); assert.throws(() => replayControlSessionPreflight(state, f.boundary), /path qualification missing/);
  const fixtures = plan.required.map((v, i) => fixture(i * 10, v.channel, v.purpose));
  const boundary = { ...f.boundary, invocations: fixtures.map((v) => v.invocation), receipts: fixtures.map((v) => v.receipt),
    originalAfter: hostSample(350, [...f.base, ...fixtures.flatMap((v) => v.chain)]) };
  const proof = replayControlSessionPreflight(state, boundary);
  assert.equal(proof.qualification, "pending-native-proof"); assert.equal(proof.authority, "none");
  assert.throws(() => replayControlSessionPreflight({ ...state, commit: "c".repeat(40) }, boundary), /source\/ownership/);
  assert.throws(() => replayControlSessionPreflight(state, boundary, "audit"), /path qualification missing/);
  assert.throws(() => controlSessionPreflight(state, "timing"), /unknown control preflight/);
});

test("receipt work and error output remain bounded", () => {
  for (const mutate of [
    (r) => { r.samples = Array(129).fill(r.samples[0]); },
    (r) => { r.session.chain = Array(33).fill(r.session.chain[0]); },
    (r) => { r.samples[0].processes = Array(8193).fill(r.samples[0].processes[0]); },
    (r) => { r.samples[0].processes[0].stat = "x".repeat(4097); },
    (r) => { r.invocation.commit += "\n"; },
  ]) {
    const { invocation, receipt } = fixture(); mutate(receipt);
    assert.throws(() => verifyControlSession(invocation, receipt), (error) => error.message.length < 16384);
  }
  const { invocation, boundary } = fixture(); invocation.commit += "\n";
  assert.throws(() => validateControlInvocation(invocation), /invalid control source/);
  boundary.invocations = Array(65).fill(invocation); boundary.receipts = Array(65).fill(boundary.receipts[0]);
  assert.throws(() => verifyControlDrainBoundary(boundary), /bounded control ledger/);
});
