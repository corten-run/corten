import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controllerState, parseDropletArgs } from "./cloud-options.mjs";
import { controller } from "./droplet.mjs";
import { digest, treeHash } from "./cloud-local.mjs";
import { failedNativeRoots, mixedIntentRoot } from "./cloud-retirement.mjs";
import { mixedCancelProgram, mixedCancelScript, mixedSignalObservation, mixedWait, ownedMixedWait, verifyMixedCancellation, verifyMixedSignal } from "./cloud-cancellation.mjs";
import { controllerPaths, productionPlan } from "./cloud-production.mjs";
import { mixedState } from "./test-fixtures/mixed-cancel-state.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mixed-cancel-test-")), repo = join(root, "repo"), base = join(root, "state"), local = join(base, "groups-r21");
  mkdirSync(repo); mkdirSync(base); mkdirSync(local);
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), "mixed-cancel-test-"))); rmSync(root, { recursive: true, force: true }); });
  const state = mixedState(), original = Buffer.from(JSON.stringify(state)); writeFileSync(join(local, "state.json"), original);
  return { root, repo, base, local, state, original };
}
function arm(f) {
  const controllerCommit = "c".repeat(40), reservationSha256 = digest(f.original);
  const intent = `${JSON.stringify({ schema: "benchmark-mixed-cancel-intent/v1", wait: mixedWait, controllerCommit,
    reservationSha256, scriptSha256: digest(mixedCancelScript(f.state)) }, null, 2)}\n`;
  writeFileSync(join(f.local, "mixed-cancel-reservation.json"), f.original);
  writeFileSync(join(f.local, "mixed-cancel-intent.json"), intent);
  f.state.mixedCancellation = { controllerCommit, reservationSha256, intentSha256: digest(intent) };
  writeFileSync(join(f.local, "state.json"), JSON.stringify(f.state));
}

test("mixed wait cancellation is an exclusive, explicit action, not audit approval", () => {
  const args = ["r21", "--state-dir", process.cwd(), "--cancel-mixed-wait"];
  assert.equal(parseDropletArgs(args).cancelMixedWait, true);
  for (const extra of [["--collect"], ["--retire-failed-native"], ["--detach"], ["--commit", "a".repeat(40)],
    ["--approve-subject", "a".repeat(64)], ["--group", "mixed-production"]])
    assert.throws(() => parseDropletArgs([...args, ...extra]));
});

test("only the exact old mixed host, account, subject and wait are admitted", () => {
  const s = mixedState(); assert.equal(ownedMixedWait(controllerState(s, "r21")), mixedWait);
  assert.equal(s.fleet.schema, "benchmark-group-fleet/v1");
  assert.equal(s.host.region, "sfo2");
  for (const [key, value] of [["commit", "b".repeat(40)], ["id", "124"], ["token", "1".repeat(16)], ["ip", "192.0.2.1"],
    ["round", "r22"], ["group", "json-api"], ["auditIntent", {}], ["auditIntents", []]])
    assert.throws(() => ownedMixedWait({ ...s, [key]: value }));
  for (const provider of [{ ...s.provider, context: "other" }, { ...s.provider, accountId: "user:other" }])
    assert.throws(() => ownedMixedWait({ ...s, provider }));
  assert.throws(() => failedNativeRoots(s), "adding a mixed key alone must not admit retirement");
  assert.equal(mixedWait.deadline, "2026-11-16T23:57:08.811Z");
  assert.ok(!/guarantees-failed/.test(mixedWait.operatorReason));
});

test("durable cancellation intent binds immutable reservation, source, script and all wait fields", (t) => {
  const f = fixture(t); arm(f);
  verifyMixedCancellation(f.local, controllerState(f.state, "r21"));
  assert.deepEqual(failedNativeRoots(f.state), ["/bench/campaign", "/bench/repo/bench/mixed-production/results/w21", "/bench/mixed-cancel-intent.json"]);
  for (const key of ["mixed-cancel-intent.json", "mixed-cancel-reservation.json"]) {
    const path = join(f.local, key), before = readFileSync(path);
    writeFileSync(path, Buffer.concat([before, Buffer.from(" ")])); assert.throws(() => verifyMixedCancellation(f.local, f.state)); writeFileSync(path, before);
  }
  for (const patch of [{ createdAt: "2026-01-01T00:00:00.000Z" }, { status: "collected" }, { validation: {} }, { auditIntents: [] }])
    assert.throws(() => verifyMixedCancellation(f.local, { ...f.state, ...patch }));
  const retired = { ...f.state, status: "retired", retirement: { kind: "native-failed" }, deletionIntentAt: "retained", destroyedAt: "retained" };
  verifyMixedCancellation(f.local, retired); // Bookkeeping is not terminal proof.
});

test("source-bound preview is local only and changes with the exact reservation", async (t) => {
  const f = fixture(t), calls = [], head = "c".repeat(40), options = { round: "r21", stateDir: f.base, cancelMixedWait: true };
  const run = (binary, argv) => {
    calls.push([binary, argv]); assert.equal(binary, "git");
    const stdout = argv[0] === "rev-parse" ? argv[1] === "HEAD" ? head : f.repo
      : argv[0] === "show" ? readFileSync(argv[1].slice(41), "utf8").replaceAll("\r\n", "\n") : "";
    return { status: 0, stdout };
  };
  const plan = await productionPlan(options, { repo: f.repo, run });
  assert.equal(plan.subject.action, "cancel-mixed-wait"); assert.equal(plan.subject.reservationSha256, digest(f.original));
  assert.deepEqual(plan.subject.recovery.wait, mixedWait); assert.ok(controllerPaths.includes("bench/workloads/cloud-cancellation.mjs"));
  writeFileSync(join(f.local, "state.json"), `${f.original}\n`);
  assert.notEqual((await productionPlan(options, { repo: f.repo, run })).approvalSha256, plan.approvalSha256);
  arm(f);
  await assert.rejects(productionPlan(options, { repo: f.repo, run }));
  assert.ok(calls.every(([binary]) => binary === "git"));
});

test("missing exact approval and changed native host key refuse before any transport", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-16T01:00:00.000Z"));
  const f = fixture(t), calls = [], run = (...args) => { calls.push(args); throw new Error("unexpected transport"); };
  const options = { round: "r21", stateDir: f.base, cancelMixedWait: true };
  await assert.rejects(controller(options, { repo: f.repo, run }).cancelMixedWait(), /approval/);
  writeFileSync(join(f.local, "known_hosts"), "synthetic public host-key view, not a real key\n");
  await assert.rejects(controller(options, { repo: f.repo, run, recoveryApproval: { controllerCommit: "c".repeat(40), reservationSha256: digest(f.original) } }).cancelMixedWait());
  assert.equal(calls.length, 0); assert.ok(!existsSync(join(f.local, "mixed-cancel-intent.json")));
  assert.ok(!existsSync(join(f.local, "operation.lock")));
});

test("retirement requires the exact historical signal acknowledgement, never intent alone", (t) => {
  const f = fixture(t); arm(f); assert.throws(() => verifyMixedSignal(f.local, f.state));
  const at = Date.parse("2026-11-16T01:00:00.000Z"), observation = { schema: "benchmark-mixed-cancel-signal/v1", hostId: f.state.id, unit: f.state.unit,
    campaign: mixedWait.campaign, subjectSha256: mixedWait.subjectSha256, remoteIntentSha256: "a".repeat(64), pid: 1234, startTicks: 567,
    signaled: true, observedAtMs: at };
  const path = join(f.local, "mixed-cancel-signal.json"), bytes = Buffer.from(JSON.stringify({ observation, startedAtMs: at, finishedAtMs: at }));
  writeFileSync(path, bytes); f.state.mixedCancellation.signalSha256 = digest(bytes);
  assert.deepEqual(verifyMixedSignal(f.local, f.state), observation);
  writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")])); assert.throws(() => verifyMixedSignal(f.local, f.state)); writeFileSync(path, bytes);
  const changed = Buffer.from(JSON.stringify({ observation: { ...observation, observedAtMs: Date.parse(mixedWait.deadline) },
    startedAtMs: Date.parse(mixedWait.deadline), finishedAtMs: Date.parse(mixedWait.deadline) }));
  writeFileSync(path, changed); f.state.mixedCancellation.signalSha256 = digest(changed);
  assert.throws(() => verifyMixedSignal(f.local, f.state), /deadline/);
});

test("signal acknowledgement is bounded, closed and not terminal or deletion authority", () => {
  const s = mixedState(), at = Date.now(), value = { schema: "benchmark-mixed-cancel-signal/v1", hostId: s.id, unit: s.unit,
    campaign: mixedWait.campaign, subjectSha256: mixedWait.subjectSha256, remoteIntentSha256: "a".repeat(64), pid: 1234, startTicks: 567,
    signaled: true, observedAtMs: at };
  assert.deepEqual(mixedSignalObservation(JSON.stringify(value), s, at, at), value);
  for (const patch of [{ signaled: false }, { hostId: "123" }, { unit: "other.service" }, { campaign: "other" }, { startTicks: 0 },
    { pid: mixedWait.wrapperPid }, { subjectSha256: "b".repeat(64) }, { observedAtMs: at - 5001 }, { qualified: true }])
    assert.throws(() => mixedSignalObservation(JSON.stringify({ ...value, ...patch }), s, at, at));
  assert.throws(() => mixedSignalObservation(JSON.stringify(value), s, at, at + 50001));
  const program = mixedCancelProgram(s);
  assert.equal((program.match(/pidfd_send_signal\(/g) ?? []).length, 1);
  assert.ok(program.indexOf("os.fsync(fd)") < program.indexOf("pidfd_send_signal("));
  assert.ok(!/os\.kill\(|killpg|systemctl.*(?:stop|kill)|SIGKILL/.test(program));
});

test("regular cancellation root uses remote framing, never directory hashing or raw file SHA", (t) => {
  const f = fixture(t), path = join(f.local, "root-2"), bytes = Buffer.from('{"signal":"SIGTERM","synthetic":true}\n');
  writeFileSync(path, bytes, { mode: 0o600 });
  const root = { path: "/bench/mixed-cancel-intent.json", present: true, nodes: 1, bytes: bytes.length,
    treeSha256: digest(Buffer.concat([Buffer.from(`f\0\0${bytes.length}\0`), bytes])) };
  assert.throws(() => treeHash(path), /directory/); // Reproduce the early-review defect.
  assert.deepEqual(mixedIntentRoot(path, root), { signal: "SIGTERM", synthetic: true });
  for (const patch of [{ treeSha256: digest(bytes) }, { nodes: 2 }, { present: false }, { bytes: bytes.length + 1 }, { path: "/bench/other" }])
    assert.throws(() => mixedIntentRoot(path, { ...root, ...patch }));
  writeFileSync(path, Buffer.from(bytes.toString().replace("true", "null")));
  assert.throws(() => mixedIntentRoot(path, root)); writeFileSync(path, bytes);
  linkSync(path, join(f.local, "hardlink")); assert.throws(() => mixedIntentRoot(path, root)); unlinkSync(join(f.local, "hardlink"));
  if (process.platform === "linux") {
    symlinkSync(path, join(f.local, "symlink")); assert.throws(() => mixedIntentRoot(join(f.local, "symlink"), root));
  }
  assert.throws(() => mixedIntentRoot(f.local, root));
  writeFileSync(path, "x".repeat(4097)); assert.throws(() => mixedIntentRoot(path, root));
});
