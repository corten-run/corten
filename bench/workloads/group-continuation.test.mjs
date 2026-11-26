import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { continuationAdmission, measuredCheckout as measured } from "./group-continuation.mjs";
import { accountId, commit, context, harness } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { digest, fileHash, treeHash } from "./cloud-local.mjs";
import { fleetChildOptions, readFleet, recheckExternalFailedHost } from "./fleet-verify.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { streamLimits } from "./isolated/control-stream.mjs";
import { registration as monitorFixture } from "./test-fixtures/control-stream-fixture.mjs";
import { fixtureGitEnv, withFixtureGitEnv } from "../../scripts/fixture-git.mjs";

// measuredCheckout runs Git on the process's environment, so it reads the fixture only without the caller's selectors.
const measuredCheckout = (/** @type {string} */ root, /** @type {string} */ saved, /** @type {string} */ commit) =>
  withFixtureGitEnv(() => measured(root, saved, commit));

test("a retained group at X finds its original checkout after the operator checkout advances to Y", (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "group-checkouts-"))), repo = join(temp, "repo"), root = join(temp, "results");
  t.after(() => { assert.equal(dirname(temp), realpathSync(tmpdir())); rmSync(temp, { recursive: true }); });
  mkdirSync(repo); mkdirSync(root); mkdirSync(`${root}-checkouts`);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv() }).trim();
  const commit = (source) => {
    writeFileSync(join(repo, "input.txt"), source); git("add", "input.txt"); git("commit", "-m", source); return git("rev-parse", "HEAD");
  };
  git("init");
  const x = commit("group B source");
  assert.equal(measuredCheckout(root, repo, x), repo);
  const y = commit("group C source");
  assert.throws(() => measuredCheckout(root, repo, x), /original measured checkout/);
  git("worktree", "add", "--detach", join(`${root}-checkouts`, x), x);
  assert.deepEqual([measuredCheckout(root, repo, x), measuredCheckout(root, repo, y)], [join(`${root}-checkouts`, x), repo]);
  git("worktree", "add", "--detach", join(`${root}-checkouts`, y), x);
  assert.throws(() => measuredCheckout(root, repo, y), /original measured checkout/, "a wrongly pinned checkout must not fall back silently");
});

test("a reviewed external failure leaves original launch custody intact and requires a census for the next group", async (t) => {
  const { base, repo } = harness(t), root = realpathSync(base), round = "r85", group = "json-api";
  const old = join(root, group), stateRoot = join(old, group), local = join(stateRoot, `groups-${round}`), receipts = join(old, "receipts");
  const at = "2026-11-25T22:00:00.000Z", token = "0123456789abcdef", id = "701";
  const indexSha256 = digest("[]");
  writeFileSync(join(root, "index.json"), "[]");
  mkdirSync(local, { recursive: true }); mkdirSync(receipts);
  const manifest = fleetPlan({ round, commit, token: "f".repeat(16), tokens: { [group]: token }, provider: { accountId, context }, sshKey: "42" },
    at, "sfo2", { stagedPlacement: true, single: { group, indexSha256, checkout: repo } });
  writeFileSync(join(old, `fleet-${round}.json`), JSON.stringify(manifest));
  const fleet = readFleet(old, round), options = fleetChildOptions(fleet, group, "detach");
  const child = { action: "detach", options, controllerCommit: commit, stateRoot, fleetSha256: fleet.manifestSha256 };
  const subject = { schema: "benchmark-group-fleet-staged-approval/v1", action: "detach", controllerCommit: commit, stateRoot: old,
    requestedRoot: old, round, fleet: manifest, manifestSha256: fleet.manifestSha256, records: {},
    admission: { mode: "first-group-only", firstGroup: group, gate: "collected-verified-deleted", nativeReadiness: false },
    continuation: { indexSha256 }, jobs: [{ group, outcome: "planned", missing: [], options, subject: child, approvalSha256: digest(JSON.stringify(child)) }] };
  const approvalSha256 = digest(JSON.stringify(subject)), intentPath = join(old, "launch-intent.json");
  writeFileSync(intentPath, JSON.stringify({ schema: "benchmark-group-fleet-staged-launch-intent/v1", subject, approvalSha256 }));
  // Start and reap a real child so there is no dependence on an invented PID.
  const childProcess = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(childProcess.status, 0);
  const pid = childProcess.pid;
  const batch = join(old, ".fleet-operation.lock"), launch = join(stateRoot, ".groups-launch.lock"), operation = join(local, "operation.lock");
  writeFileSync(batch, JSON.stringify({ pid, approvalSha256 }));
  writeFileSync(launch, JSON.stringify({ pid, round }));
  writeFileSync(operation, JSON.stringify({ pid, at }));
  const monitorId = "b".repeat(32), monitorBinding = { round, commit, token, helperSha256: guardianSha256 };
  const registration = { ...monitorFixture, id: monitorId, binding: monitorBinding };
  const state = { ...reservation({ round, commit, group, token, fleet: manifest }, at), status: "running", createIntentAt: at,
    id, ip: "192.0.2.1", provider: manifest.provider, fullGroupQualified: false,
    control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: ["bootstrap"],
      monitor: { schema: "benchmark-supervised-control/v1", id: monitorId, phase: "invalid", registrationSha256: digest(JSON.stringify(registration)) } } };
  state.control.ledger.push({ request: controlRequest(state, "ssh", [`systemctl start ${state.unit}`], 60000, "bootstrap", []), localTerminal: true, code: 0 });
  const closedAtMs = Date.parse(at), recoverAfterMs = closedAtMs + 2 * streamLimits.leaseMs;
  const monitorPaths = ["monitor-invalid.json", "monitor-local-closed.json", "monitor-registration.json"].map((name) => join(local, name));
  const records = [{ id: monitorId, binding: monitorBinding, publicationRevoked: true },
    { id: monitorId, binding: monitorBinding, remoteDrained: false, closedAtMs, recoverAfterMs }, registration];
  for (const [i, path] of monitorPaths.entries()) writeFileSync(path, JSON.stringify(records[i]));
  const journal = join(local, "monitor-journal.jsonl");
  const frame = (kind, payload, sequence) => JSON.stringify({ schema: "benchmark-control-frame/v1", id: monitorId, kind, payload, sequence }) + "\n";
  const registered = frame("registered", registration, 1);
  writeFileSync(journal, registered);
  const statePath = join(local, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  const target = "hardening";
  await assert.rejects(continuationAdmission(root, target, { repo }), (error) => error.code === "ESRCH" || /custody|supervision/.test(error.message));
  const binding = { round, group, accountId, id, manifestSha256: fleet.manifestSha256, stateSha256: fileHash(statePath),
    launch: fileHash(intentPath), batchLockSha256: fileHash(batch), launchLockSha256: fileHash(launch), operationLockSha256: fileHash(operation),
    monitorFiles: [...monitorPaths, journal].map((path) => fileHash(path)), nameSha256: digest(state.name), tagSha256: digest(state.tag) };
  const receipt = join(receipts, "external-failed-host.json");
  const record = { schema: "benchmark-external-failed-host/v1", binding, operatorProofSha256: "d".repeat(64) };
  writeFileSync(receipt, JSON.stringify({ ...record, binding: { ...binding, accountId: "user:wrong-account" } }));
  await assert.rejects(continuationAdmission(root, target, { repo }), /external failure binding differs/);
  writeFileSync(receipt, JSON.stringify(record));
  const original = treeHash(old), admission = await continuationAdmission(root, target, { repo });
  assert.equal(admission.rows.find((row) => row.group === group).outcome, "external-failed-needs-census");
  const [pending] = admission.subject.unconfirmed;
  assert.equal(pending.id, id);
  assert.equal(pending.accountId, accountId);
  assert.equal(pending.externalFailureSha256, fileHash(receipt));
  assert.equal(treeHash(old), original);
  assert.throws(() => recheckExternalFailedHost(root, pending, { ...manifest, round: "r86" }), /different measured commit/);
  const recovery = join(local, "stream-recovery.lock");
  writeFileSync(recovery, "recovery active");
  assert.throws(() => admission.recheck(), /recovery is active/);
  unlinkSync(recovery);
  for (const name of ["results.tgz", "results.tgz.download", "results.tgz.synced", "failed-native-results.tgz", "failed-native-capture.json", "evidence-Synthetic", "Results.Tgz.Download",
    ...(process.platform === "win32" ? ["RESULTS.TGZ"] : [])]) {
    const path = join(local, name);
    writeFileSync(path, "unclassified collection artifact");
    assert.throws(() => admission.recheck(), /cannot supersede other evidence/);
    unlinkSync(path);
  }
  writeFileSync(journal, registered + frame("terminal", { id: monitorId, nativeTerminal: true, sealSha256: "f".repeat(64) }, 2)
    + JSON.stringify({ kind: "local-closed", code: 255, signal: null, remoteTerminal: false }) + "\n");
  assert.throws(() => admission.recheck(), /journal requires reconciliation/);
  await assert.rejects(continuationAdmission(root, target, { repo }), /journal requires reconciliation/);
  writeFileSync(journal, registered + '{"kind":"termi');
  assert.throws(() => admission.recheck(), /incomplete monitor journal/);
  writeFileSync(journal, registered);
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  assert.throws(() => admission.recheck(), /external failure binding differs/);
});
