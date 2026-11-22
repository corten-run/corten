import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accountId, archive, commit, context } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { digest, extractArchive } from "./cloud-local.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { failedNativeArchive, failedNativeScript, groupedFailure, groupedPreplanFailure, verifyFailedNativeCustody,
  verifyFailedNativeRetirement } from "./cloud-retirement.mjs";
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

async function setup(t, { changeLog = (line) => line, exit = "2\n", campaign = [{ name: "campaign/" }], single = true } = {}) {
  const temp = realpathSync(tmpdir()), base = mkdtempSync(join(temp, "groups-preplan-test-"));
  t.after(() => {
    assert.ok(base.startsWith(join(temp, "groups-preplan-test-")) && realpathSync(base) === base);
    rmSync(base, { recursive: true, force: true });
  });
  const local = join(base, `groups-${round}`); mkdirSync(local);
  const at = "2026-11-21T00:00:00.000Z", provider = { accountId, context };
  const fleet = fleetPlan({ round, commit, token, provider, sshKey: "42",
    tokens: single ? { [group]: "0".repeat(16) } : Object.fromEntries(reservation({ round, commit, token }).selection.groups.map(({ group }, i) =>
      [group, i.toString(16).padStart(16, "0")])) }, at, "sfo3", {
    stagedPlacement: single, ...(single ? { single: { group, indexSha256: "c".repeat(64), checkout: base } } : {}),
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
  putJson(local, "operation.lock", { pid, at }); putJson(base, ".groups-launch.lock", { pid, round });
  put(local, "known_hosts", key);
  const line = remoteFiles(state)["job.sh"].split("\n").findIndex((line) => line.startsWith("node 'bench/workloads/isolated/campaign-entry.mjs' ")) + 1;
  assert.ok(line > 1);
  const metadata = [{ name: "run.log", body: changeLog(`benchmark job failed: stage=native-entry line=${line} exit=2\n`) },
    { name: "host.txt", body: "synthetic host\n" }, { name: "exit-code", body: exit }];
  const wrapper = await stash(local, "results.tgz", "evidence-test", [...metadata, ...campaign]);
  Object.assign(state, { archiveSha256: wrapper.sha, evidenceSha256: wrapper.tree, evidence: "evidence-test", extractionAttempts: ["evidence-test"] });
  return { local, state, metadata, wrapper };
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
async function custody(t, { present = [true, true], hiddenRoot, reportedRoots = roots, campaignData = false } = {}) {
  const { local, state, metadata, wrapper } = await setup(t);
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
    reservationSha256: digest(prior), scriptSha256: digest(failedNativeScript(state, null, null, grouped)),
    observation, startedAtMs: now, finishedAtMs: now, evidence: "custody-test", evidenceSha256: saved.tree };
  return { local, state, grouped, capture };
}

for (const present of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`complete preplan custody and retired replay: campaign=${present[0]}, native=${present[1]}`, async (t) => {
    const { local, state, grouped, capture } = await custody(t, { present });
    assert.equal(verifyFailedNativeCustody(local, state, capture), capture);
    const { observation, startedAtMs, finishedAtMs } = capture;
    const scriptHash = (fence) => digest(failedNativeScript(state, observation.snapshotSha256, fence, grouped));
    const receipt = { schema: "benchmark-failed-native-retirement/v1", capture, confirmation: observation,
      startedAtMs, finishedAtMs, scriptSha256: scriptHash(observation),
      rehash: { observation, startedAtMs, finishedAtMs, scriptSha256: scriptHash(null) } };
    const bytes = JSON.stringify(receipt); put(local, "failed-native-host.json", bytes);
    Object.assign(state, { status: "retired", retirement: { kind: "native-failed", evidenceSha256: digest(bytes) },
      deletionIntentAt: new Date(finishedAtMs).toISOString() });
    assert.deepEqual(verifyFailedNativeRetirement(local, state), receipt);
  });
}

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
