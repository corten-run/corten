import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { accountId, archive, commit, context } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { digest, extractArchive } from "./cloud-local.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { failedNativeArchive, failedNativeScript, groupedFailure, groupedPreplanFailure, verifyFailedNativeCustody,
  retainedInvalidOwner, verifyFailedNativeRetirement } from "./cloud-retirement.mjs";
import { fleetChildOptions, readFleet, verifyFleet } from "./fleet-verify.mjs";
import { continuationAdmission } from "./group-continuation.mjs";
import { registration } from "./test-fixtures/control-stream-fixture.mjs";
import { streamLimits } from "./isolated/control-stream.mjs";

const round = "r36", group = "fullstack-browser", token = "a".repeat(16), repair = "b".repeat(40);
const roots = ["/bench/campaign", "/bench/repo/bench/fullstack-browser/work/w36"];
const put = (dir, name, body) => writeFileSync(join(dir, name), body, { flag: "wx" });
const putJson = (dir, name, value) => put(dir, name, JSON.stringify(value));
async function stash(local, name, directory, entries) {
  const bytes = archive(entries), sha = digest(bytes), path = join(local, name);
  put(local, name, bytes); mkdirSync(join(local, directory));
  return { bytes, sha, tree: await extractArchive(path, join(local, directory), sha) };
}

async function setup(t, { changeLog = (line) => line, exit = "2\n", campaign = [{ name: "campaign/" }], single = true, report = false } = {}) {
  const temp = realpathSync(tmpdir()), scratch = mkdtempSync(join(temp, "groups-preplan-test-"));
  t.after(() => {
    assert.ok(scratch.startsWith(join(temp, "groups-preplan-test-")) && realpathSync(scratch) === scratch);
    rmSync(scratch, { recursive: true, force: true });
  });
  const base = report ? join(scratch, group) : scratch;
  const local = join(base, group, `groups-${round}`); mkdirSync(local, { recursive: true });
  const at = "2026-11-21T00:00:00.000Z", provider = { accountId, context };
  const fleet = fleetPlan({ round, commit, token, provider, sshKey: "42",
    tokens: single ? { [group]: "0".repeat(16) } : Object.fromEntries(reservation({ round, commit, token }).selection.groups.map(({ group }, i) =>
      [group, i.toString(16).padStart(16, "0")])) }, at, "sfo3", {
    stagedPlacement: single, ...(single ? { single: { group, indexSha256: digest("[]"), checkout: base } } : {}),
  });
  const selected = fleet.jobs.find((job) => job.group === group);
  const key = "synthetic known host\n";
  const state = { ...reservation({ round, commit, token: selected.token, group, fleet }, at), id: "123", ip: "192.0.2.10",
    provider, status: "running", fullGroupQualified: false, createIntentAt: at, launchHostKeySha256: digest(key) };
  const binding = { round, commit, token: selected.token, helperSha256: guardianSha256 };
  const reg = { ...structuredClone(registration), binding, host: { ...registration.host, hostname: state.name } };
  state.control = { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, sealed: ["bootstrap"], ledger: [],
    monitor: { schema: "benchmark-supervised-control/v1", phase: "invalid", id: reg.id, registrationSha256: digest(JSON.stringify(reg)) } };
  const start = controlRequest(state, "ssh", [`root@${state.ip}`, `systemctl start ${state.unit}`], 60000, "bootstrap");
  state.control.ledger.push({ request: start, code: 0, localTerminal: true });
  const seal = controlRequest(state, "ssh", [`root@${state.ip}`, ":"], 60000, "bootstrap", [start.invocation]);
  state.control.ledger.push({ request: seal, code: 0, localTerminal: true });
  const closedAtMs = Date.now() - 2 * streamLimits.leaseMs - 1000;
  putJson(local, "monitor-registration.json", reg);
  putJson(local, "monitor-invalid.json", { binding, id: reg.id, publicationRevoked: true, remoteTerminal: false });
  putJson(local, "monitor-local-closed.json", { binding, id: reg.id, code: 254, signal: null, remoteDrained: false,
    closedAtMs, recoverAfterMs: closedAtMs + 2 * streamLimits.leaseMs });
  const pid = 2147483647;
  putJson(local, "operation.lock", { pid, at }); putJson(dirname(local), ".groups-launch.lock", { pid, round });
  put(local, "known_hosts", key);
  const line = remoteFiles(state)["job.sh"].split("\n").findIndex((line) => line.startsWith("node 'bench/workloads/isolated/campaign-entry.mjs' ")) + 1;
  assert.ok(line > 1);
  const metadata = [{ name: "run.log", body: changeLog(`benchmark job failed: stage=native-entry line=${line} exit=2\n`) },
    { name: "host.txt", body: "synthetic host\n" }, { name: "exit-code", body: exit }];
  const wrapper = await stash(local, "results.tgz", "evidence-test", [...metadata, ...campaign]);
  Object.assign(state, { archiveSha256: wrapper.sha, evidenceSha256: wrapper.tree, evidence: "evidence-test", extractionAttempts: ["evidence-test"] });
  return { base, local, state, metadata, wrapper };
}

test("only explicit grouped preplan validation admits the empty wrapper and binds the reserved roots", async (t) => {
  const { local, state } = await setup(t);
  assert.throws(() => failedNativeArchive(local, state, groupedFailure(local, state)), /one original failed campaign required/);
  const grouped = groupedPreplanFailure(local, state);
  assert.equal(grouped.preplan, true);
  assert.deepEqual(failedNativeArchive(local, state, grouped), { retirementAllowed: true, roots });
  assert.throws(() => failedNativeArchive(local, state, { ...grouped, roots: roots.slice(0, 1) }), /preplan identity differs/);
});

for (const [label, options, error] of [
  ["wrong raw exit", { exit: "1\n" }, /saved failure exit/],
  ["missing campaign", { campaign: [] }, /ENOENT/],
  ["partial campaign", { campaign: [{ name: "campaign/" }, { name: "campaign/.host-attempt.json", body: "{}" }] }, /empty archived campaign/],
  ["wrong stage", { changeLog: (line) => line.replace("native-entry", "bootstrap-marker") }, /source-bound final/],
  ["wrong source line", { changeLog: (line) => line.replace(/line=\d+/, "line=1") }, /source-bound final/],
  ["marker not final", { changeLog: (line) => line + "more output\n" }, /source-bound final/],
  ["marker not whole line", { changeLog: (line) => "prefix " + line }, /source-bound final/],
  ["not staged single group", { single: false }, /staged single-group reservation/],
]) {
  test(`preplan refuses ${label}`, async (t) => {
    const { local, state } = await setup(t, options);
    assert.throws(() => groupedPreplanFailure(local, state), error);
  });
}

const fileFrame = (name, bytes) => Buffer.concat([Buffer.from(`f\0${name}\0${bytes.length}\0`), bytes]);
async function custody(t, { present = [true, true], hiddenRoot, reportedRoots = roots, campaignData = false, report = false } = {}) {
  const { base, local, state, metadata, wrapper } = await setup(t, { report });
  let intent = JSON.stringify({ subject: "synthetic original launch intent" });
  if (report) {
    put(dirname(base), "index.json", "[]");
    putJson(base, `fleet-${round}.json`, state.fleet);
    const fleet = readFleet(base, round), options = fleetChildOptions(fleet, group, "detach");
    const child = { action: "detach", options, controllerCommit: commit, stateRoot: options.stateDir, fleetSha256: fleet.manifestSha256 };
    const subject = { schema: "benchmark-group-fleet-staged-approval/v1", action: "detach", controllerCommit: commit,
      stateRoot: base, requestedRoot: base, round, manifestSha256: fleet.manifestSha256, fleet: state.fleet, records: {},
      admission: { mode: "first-group-only", firstGroup: group, gate: "collected-verified-deleted", nativeReadiness: false },
      jobs: [{ group, outcome: "planned", missing: [], options, subject: child, approvalSha256: digest(JSON.stringify(child)) }] };
    intent = JSON.stringify({ schema: "benchmark-group-fleet-staged-launch-intent/v1", subject, approvalSha256: digest(JSON.stringify(subject)) });
  }
  const intentPath = join(base, "launch-intent.json");
  put(base, "launch-intent.json", intent);
  const grouped = groupedPreplanFailure(local, state), entries = [...metadata, { name: "campaign/" }];
  const nativeRoots = reportedRoots.map((path, i) => {
    const name = `campaign/root-${i}`, bytes = Buffer.from("unqualified residual output\n");
    const payload = i !== 0 || campaignData;
    if (present[i] || hiddenRoot === i) {
      entries.push({ name: name + "/" });
      if (payload) entries.push({ name: name + "/raw.txt", body: bytes });
    }
    if (!present[i]) return { path, present: false };
    return { path, present: true, nodes: payload ? 2 : 1, bytes: payload ? bytes.length : 0,
      treeSha256: digest(Buffer.concat([Buffer.from("d\0\0"), ...(payload ? [fileFrame("/raw.txt", bytes)] : [])])) };
  });
  const rootInventory = [...nativeRoots, ...[...metadata, { name: "results.tgz", body: wrapper.bytes }].map(({ name, body }) => {
    const bytes = Buffer.from(body);
    return { path: `/bench/${name}`, present: true, nodes: 1, bytes: bytes.length, treeSha256: digest(fileFrame("", bytes)) };
  })];
  const rawMetadata = JSON.stringify(rootInventory.map((root) => root.present ? [{ key: "" }] : null));
  const metadataSha256 = digest(rawMetadata), snapshot = JSON.stringify({ roots: rootInventory, metadataSha256 });
  entries.push({ name: "campaign/custody-snapshot.json", body: snapshot }, { name: "campaign/custody-metadata.json", body: rawMetadata });
  const saved = await stash(local, "failed-native-results.tgz", "custody-test", entries);
  const prior = JSON.stringify(state); put(local, "failed-native-reservation.json", prior);
  const now = Date.now(), observation = { schema: "benchmark-failed-native-host/v1", hostId: state.id, unit: state.unit,
    custody: true, historicalAccountingQualified: false, archiveSha256: saved.sha, metadataSha256,
    snapshotSha256: digest(snapshot), roots: rootInventory, observedAtMs: now };
  const capture = { schema: "benchmark-failed-native-custody/v1", scope: "grouped-preplan", measuredCommit: commit, controllerCommit: repair,
    launchIntentSha256: digest(intent),
    reservationSha256: digest(prior), scriptSha256: digest(failedNativeScript(state, null, null, grouped)),
    observation, startedAtMs: now, finishedAtMs: now, evidence: "custody-test", evidenceSha256: saved.tree };
  return { base, local, state, grouped, capture, intentPath };
}

function recordRetirement({ local, state, grouped, capture }) {
  const { observation, startedAtMs, finishedAtMs } = capture;
  const scriptHash = (fence) => digest(failedNativeScript(state, observation.snapshotSha256, fence, grouped));
  const receipt = { schema: "benchmark-failed-native-retirement/v1", capture, confirmation: observation,
    startedAtMs, finishedAtMs, scriptSha256: scriptHash(observation),
    rehash: { observation, startedAtMs, finishedAtMs, scriptSha256: scriptHash(null) } };
  const bytes = JSON.stringify(receipt); put(local, "failed-native-host.json", bytes);
  Object.assign(state, { status: "retired", retirement: { kind: "native-failed", evidenceSha256: digest(bytes) },
    deletionIntentAt: new Date(finishedAtMs).toISOString() });
  return receipt;
}

for (const present of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`complete preplan custody and retired replay: campaign=${present[0]}, native=${present[1]}`, async (t) => {
    const fixture = await custody(t, { present }), { local, state, capture } = fixture;
    assert.equal(verifyFailedNativeCustody(local, state, capture), capture);
    const receipt = recordRetirement(fixture);
    assert.deepEqual(verifyFailedNativeRetirement(local, state), receipt);
  });
}

test("historical child PID reuse preserves strict retired replay and never settles paid custody", async (t) => {
  const fixture = await custody(t, { report: true }), { base, local, state } = fixture;
  recordRetirement(fixture);
  const operation = join(local, "operation.lock"), launch = join(dirname(local), ".groups-launch.lock");
  const save = () => writeFileSync(join(local, "state.json"), JSON.stringify(state));
  const verify = (deps) => verifyFleet({ root: base, round, commit },
    { inspect: () => assert.fail("failed retirement is not timing evidence"), ...deps });
  const admit = (deps) => continuationAdmission(dirname(base), group, deps);
  state.destroyedAt = new Date().toISOString(); save();
  const dead = await verify({ processStart: () => assert.fail("absent PID") });
  assert.equal(dead.groups[0].outcome, "native-failed-retired");

  const at = JSON.parse(readFileSync(operation)).at;
  writeFileSync(operation, JSON.stringify({ at, pid: process.pid }));
  writeFileSync(launch, JSON.stringify({ round, pid: process.pid }));
  await wait(20);
  state.destroyedAt = new Date().toISOString(); save();
  assert.equal((await verify()).groups[0].outcome, "busy", "actual original owner is still live");
  assert.equal((await verify({ processStart: () => undefined })).groups[0].outcome, "busy", "missing process time");
  const deps = { processStart: () => Date.now() };
  const before = [operation, launch, join(local, "failed-native-host.json")].map((path) => digest(readFileSync(path)));
  const checks = [];
  assert.deepEqual(await verify({ ...deps, retainCheck: (check) => checks.push(check) }), dead);
  assert.equal(checks.length, 1); checks[0]();
  await assert.rejects(admit({ processStart: () => undefined }), /unresolved custody/);
  const successor = await admit(deps);
  assert.equal(successor.rows.find((r) => r.group === group).retryable, true);
  successor.recheck();
  assert.deepEqual([operation, launch, join(local, "failed-native-host.json")].map((path) => digest(readFileSync(path))), before);
  assert.ok(retainedInvalidOwner(local, state));
  assert.throws(() => verifyFailedNativeRetirement(local, state), /original monitor owner/);

  const destroyedAt = state.destroyedAt;
  delete state.destroyedAt; save();
  assert.equal((await verify(deps)).groups[0].outcome, "busy", "pending cleanup cannot use the reporting exception");
  state.destroyedAt = destroyedAt; save();
  const recovery = join(local, "stream-recovery.lock");
  writeFileSync(recovery, JSON.stringify({ pid: process.pid }));
  assert.throws(() => successor.recheck(), /historical child locks changed/);
  await assert.rejects(admit(deps), /unresolved custody/);
  assert.equal((await verify(deps)).groups[0].outcome, "busy", "a recovery collector still blocks replay");
  unlinkSync(recovery);
  await wait(20);
  appendFileSync(launch, "\n");
  await wait(20);
  assert.throws(() => checks[0](), /historical child locks changed/);
  assert.throws(() => successor.recheck(), /historical child locks changed/);
  assert.equal((await verify(deps)).groups[0].outcome, "busy", "a child lock written after confirmed retirement is not historical");
  state.destroyedAt = new Date().toISOString(); save();
  appendFileSync(join(local, "failed-native-host.json"), "\n");
  assert.equal((await verify(deps)).groups[0].outcome, "error", "reuse is not evidence authority");
  writeFileSync(launch, JSON.stringify({ round: "r35", pid: process.pid }));
  assert.equal((await verify(deps)).groups[0].outcome, "error", "foreign launch lock");
});

test("preplan custody refuses a capture without the launch-intent digest", async (t) => {
  const { local, state, capture } = await custody(t);
  const { launchIntentSha256, ...unpinned } = capture;
  assert.throws(() => verifyFailedNativeCustody(local, state, unpinned), /preplan launch intent digest required/);
});

test("preplan retirement replay refuses a byte-only change to the launch intent", async (t) => {
  const fixture = await custody(t), { local, state, intentPath } = fixture;
  const receipt = recordRetirement(fixture);
  assert.deepEqual(verifyFailedNativeRetirement(local, state), receipt);
  appendFileSync(intentPath, "\n");
  assert.throws(() => verifyFailedNativeRetirement(local, state), /preplan launch intent changed/);
});

test("preplan scope cannot be omitted, forged, or used at the measured commit", async (t) => {
  const { local, state, grouped, capture } = await custody(t);
  const { scope, ...unscoped } = capture;
  assert.throws(() => verifyFailedNativeCustody(local, state, unscoped, grouped), /preplan scope differs/);
  assert.throws(() => verifyFailedNativeCustody(local, state, { ...capture, scope: "other" }), /unknown custody scope/);
  assert.throws(() => verifyFailedNativeCustody(local, state, { ...capture, controllerCommit: commit }), /controller scope differs/);
});

for (const [label, options, error] of [
  ["omitted reserved root", { reportedRoots: roots.slice(0, 1) }, /Expected values to be strictly deep-equal/],
  ["root claimed absent but still in custody", { present: [false, true], hiddenRoot: 0 }, /absent native root was invented/],
  ["campaign differs from wrapper", { campaignData: true }, /original campaign changed before custody/],
]) {
  test(`preplan custody refuses ${label}`, async (t) => {
    const { local, state, capture } = await custody(t, options);
    assert.throws(() => verifyFailedNativeCustody(local, state, capture), error);
  });
}
