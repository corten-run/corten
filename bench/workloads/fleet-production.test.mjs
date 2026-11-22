// Offline composition acceptance: real snapshot Worker -> productionMain -> controller.
// Only credential consumption and external Git/HTTPS/SSH/SCP responses are fake.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata, syntheticCatalogProvider, syntheticInspection, syntheticPlacement, userId } from "./cloud-fixtures.mjs";
import { digest, fileHash, treeHash } from "./cloud-local.mjs";
import { fleetMain, fleetWorkerPaths } from "./fleet.mjs";
import { bootstrapMarker, bootstrapReadScript } from "./cloud-remote.mjs";
import { providerTransport } from "./cloud-provider.mjs";
import { productionPlan } from "./cloud-production.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { bootstrapWorkspaceScript, captureSshOwner, fleetPlan, installSshIngress, reservation, savedLoadLayout, savedPlacement, verifySshIngress } from "./cloud-contract.mjs";
import { readFleet, verifyCollectedGroup } from "./fleet-verify.mjs";
import { unusedEvidence, unusedHostScript } from "./cloud-retirement.mjs";
import { inspectContinuation } from "./group-continuation.mjs";
import { groupNames } from "./registry.mjs";
import { syntheticDependencies } from "./fleet-production-fixture.mjs";
import { registration } from "./test-fixtures/control-stream-fixture.mjs";

const committed = new Map(fleetWorkerPaths.map((file) => [file, fs.readFileSync(path.resolve(file), "utf8").replaceAll("\r\n", "\n")]));
const checkout = fs.realpathSync(".");
const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();

// The synthetic trace is appended one newline-terminated row per write by workers and
// provider children that may still be running, so a read can end inside a row. While
// they run, take only newline-complete rows; once they have finished, a final row
// without its newline is a truncated trace. Every complete row, empty ones included,
// must parse.
function readTrace(file, { finished = false } = {}) {
  const text = fs.readFileSync(file, "utf8"), end = text.lastIndexOf("\n") + 1;
  if (finished && end !== text.length) throw new Error(`truncated final trace row: ${JSON.stringify(text.slice(end))}`);
  // The complete part ends in a newline (or is empty), so its last split element is not a row.
  return text.slice(0, end).split("\n").slice(0, -1).map((line) => JSON.parse(line));
}

test("trace reader takes only newline-complete rows while writers run and is strict once they finish", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "fleet-trace-")), trace = path.join(dir, "boundaries.jsonl");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(trace, "");
  assert.deepEqual(readTrace(trace), [], "an empty trace has no rows");
  assert.deepEqual(readTrace(trace, { finished: true }), []);
  const first = JSON.stringify({ group: "catalog-page", boundary: "provider-child-start", pid: 1 });
  const second = JSON.stringify({ group: "catalog-page", boundary: "remote-active", options: { input: "x".repeat(300) } });
  fs.writeFileSync(trace, `${first}\n`);
  fs.appendFileSync(trace, second.slice(0, 257));
  assert.deepEqual(readTrace(trace), [JSON.parse(first)], "a partial row is not returned while writers run");
  assert.throws(() => readTrace(trace, { finished: true }), /truncated final trace row/);
  fs.appendFileSync(trace, `${second.slice(257)}\n`);
  assert.deepEqual(readTrace(trace), [JSON.parse(first), JSON.parse(second)], "the row is returned whole once complete");
  assert.deepEqual(readTrace(trace, { finished: true }), [JSON.parse(first), JSON.parse(second)]);
  fs.appendFileSync(trace, `${second.slice(0, 257)}\n`);
  assert.throws(() => readTrace(trace), SyntaxError, "a newline-complete malformed row still fails");
  assert.throws(() => readTrace(trace, { finished: true }), SyntaxError);
  fs.writeFileSync(trace, `${first}\n\n${second}\n`);
  assert.throws(() => readTrace(trace), SyntaxError, "an empty newline-complete row fails");
  assert.throws(() => readTrace(trace, { finished: true }), SyntaxError);
});

function roleCheckFor(fixtureCommit, sourceCommit) {
  // Reuse the real result for identical inputs within this fixture/worker so
  // role replay does not consume the offline monitor's peer-overlap window.
  const checked = new Map();
  return async ({ round, commit: measured, group, mode }, interrupted) => {
    assert.equal(measured, fixtureCommit);
    assert.ok(!interrupted?.());
    const key = JSON.stringify([round, group, mode]);
    if (!checked.has(key)) {
      const report = await inspectCampaign({ action: "actor-role-preflight", round, commit: sourceCommit,
        group: group ?? null, mode: mode ?? null }, { interrupted });
      checked.set(key, report);
    }
    return checked.get(key);
  };
}

function fixture(t, mode = "success") {
  // A throwing after hook skips the hooks after it, so the trace is checked before the
  // harness removes it and a failure is raised only after that removal has run.
  let traceFailure = null;
  t.after(() => {
    try {
      // Every owned child has exited by now (asserted below), so the trace is complete.
      const rows = readTrace(trace, { finished: true }), starts = rows.filter((row) => row.boundary === "provider-child-start");
      const exits = rows.filter((row) => row.boundary === "provider-child-exit");
      assert.deepEqual(exits.map((row) => row.pid).sort(), starts.map((row) => row.pid).sort(), "every owned child reaped");
      assert.ok(exits.every((row) => row.terminal));
      assert.ok(!rows.some((row) => row.tokenIPC || row.boundary === "forbidden-native-https"));
    } catch (error) {
      traceFailure = error;
    }
  });
  const h = harness(t), output = [], workers = [];
  t.after(() => { if (traceFailure) throw traceFailure; });
  const repo = path.join(h.temp, "captured"), trace = path.join(h.temp, "boundaries.jsonl"), hosts = path.join(h.temp, "provider.json");
  fs.mkdirSync(repo); fs.writeFileSync(trace, "");
  fs.mkdirSync(path.join(repo, "bench/workloads"), { recursive: true });
  // The operator's local bench install (npm --prefix bench ci), which native replay and the
  // launch and collection preflights read. Linked, never copied or altered.
  fs.mkdirSync(path.join(repo, "bench/node_modules"));
  fs.symlinkSync(fs.realpathSync("bench/node_modules/typescript"), path.join(repo, "bench/node_modules/typescript"), "junction");
  fs.copyFileSync(new URL("./fleet-provider-test-worker.mjs", import.meta.url), path.join(repo, "bench/workloads/fleet-provider-test-worker.mjs"));
  const sources = fleetWorkerPaths.map((file) => {
    const target = path.join(repo, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    let source = committed.get(file);
    if (file === "bench/workloads/cloud-validation-snapshot.mjs") {
      // The synthetic controller tree has no Git repository. Use the same real
      // validation checkout (and commit) as the parent-side role check.
      const before = 'const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));';
      assert.equal(source.split(before).length, 2, "review validation checkout seam");
      source = source.replace(before, `const checkout = ${JSON.stringify(checkout)};`);
    }
    if (file === "bench/workloads/cloud-production.mjs") {
      // Change defaults only. The actual productionMain body, approval gates,
      // transport, controller and worker protocol remain the production code.
      const before = "spawn, streamSpawn, providerFactory = providerTransport, repo = checkout, inspect, sleep, interrupted";
      const after = "spawn = synthetic.spawn, streamSpawn = synthetic.streamSpawn, providerFactory = synthetic.providerFactory, repo = synthetic.repo, inspect, sleep = synthetic.sleep, interrupted";
      const roleDefault = "compiler, roleCheck, remainingAdmission = false";
      assert.equal(source.split(before).length, 2, "review fixture injection when production signature changes");
      assert.equal(source.split(roleDefault).length, 2, "review role-check fixture default");
      source = source.replace(before, after).replace(roleDefault, "compiler, roleCheck = syntheticRoleCheck, remainingAdmission = false") + `\nimport * as syntheticFs from 'node:fs';
import * as syntheticPath from 'node:path';
import { workerData as syntheticData } from 'node:worker_threads';
import { fork as syntheticFork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { controlRegistration } from './cloud-control-runtime.mjs';
import { bootstrapMarker as syntheticMarker, bootstrapReadScript as syntheticRead } from './cloud-remote.mjs';
import { bootstrapWorkspaceScript } from './cloud-contract.mjs';
const syntheticArgs = syntheticData.args;
const syntheticGroup = syntheticArgs[syntheticArgs.indexOf('--group') + 1];
const syntheticRoleCheck = (${roleCheckFor.toString()})(${JSON.stringify(commit)}, ${JSON.stringify(checkoutCommit)});
const synthetic = (${syntheticDependencies.toString()})({
  repo: ${JSON.stringify(repo)}, trace: ${JSON.stringify(trace)}, hosts: ${JSON.stringify(hosts)},
  stateDir: syntheticArgs[syntheticArgs.indexOf('--state-dir') + 1], group: syntheticGroup,
  commit: ${JSON.stringify(commit)}, userId: ${JSON.stringify(userId)}, mode: ${JSON.stringify(mode)},
  holdUntilGroup: ${mode === "overlap" ? `syntheticGroup === ${JSON.stringify(groupNames[1])} ? ${JSON.stringify(groupNames[2])} : null` : "null"}
}, { fs: syntheticFs, path: syntheticPath, fork: syntheticFork, providerTransport,
  bootstrapMarker: syntheticMarker, bootstrapReadScript: syntheticRead, bootstrapWorkspaceScript, controlRegistration,
  EventEmitter, PassThrough, Writable, registration: ${JSON.stringify(registration)} });\n`;
    }
    fs.writeFileSync(target, source);
    return { path: file, url: pathToFileURL(target).href, source, sha256: digest(source) };
  });
  class SnapshotWorker extends Worker {
    constructor(entry, options) {
      assert.ok(entry.href.startsWith("data:text/javascript;base64,"));
      const workerEntry = sources.find((row) => row.path === "bench/workloads/fleet-worker.mjs");
      super(entry, {
        ...options, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
        workerData: { ...options.workerData, sources, entry: workerEntry.url } });
      workers.push(this);
    }
  }
  const spawn = (binary, argv) => {
    assert.equal(binary, "git", "parent has no external provider boundary");
    if (argv[0] === "show") return { status: 0, stdout: committed.get(argv[1].slice(41)) };
    return h.run(binary, argv, 60000);
  };
  const roleCheck = roleCheckFor(commit, checkoutCommit), deps = { repo: h.repo, spawn, WorkerClass: SnapshotWorker, write: (value) => output.push(JSON.parse(value)),
    plan: (options, deps) => productionPlan(options, { ...deps, roleCheck }) };
  deps.catalogProvider = syntheticCatalogProvider(syntheticPlacement([mode === "overlap" ? "sfo2" : "sfo3"]));
  const args = ["r21", "--fleet-root", h.base];
  const saved = (group = groupNames[0]) => JSON.parse(fs.readFileSync(path.join(h.base, group, "groups-r21/state.json")));
  const events = () => readTrace(trace);
  const prepareArgs = [...args, "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  async function prepare() {
    assert.equal(await fleetMain(prepareArgs, deps), 3);
    assert.equal(await fleetMain([...args, "--detach", "--print-approval"], deps), 3);
    return [...args, "--detach", "--approve-reviewed-merged-ready", output.at(-1).approvalSha256];
  }
  return { h, output, workers, saved, events, prepare, prepareArgs, deps, trace, hosts };
}

test("captured production composition ignores arbitrary hints, binds POST identity and propagates remote options", { timeout: 30000 }, async (t) => {
  const p = fixture(t, "ssh-late");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 3, JSON.stringify(p.output.at(-1)));
  assert.equal(p.workers.length, 1, "bootstrap must not admit any later production child");
  const fleet = readFleet(p.h.base, "r21").manifest, events = p.events();
  assert.equal(fleet.jobs[0].group, "catalog-page");
  assert.equal(p.output.at(-1).groups[0].outcome, "pending");
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "deferred"));
  for (const [i, group] of groupNames.slice(0, 1).entries()) {
    const saved = p.saved(group), job = fleet.jobs[i];
    assert.equal(saved.status, "running"); assert.equal(saved.token, job.token);
    assert.equal(saved.id, String(101 + i)); assert.equal(saved.ip, `192.0.2.${i + 1}`);
    assert.equal(saved.group, group); assert.deepEqual(saved.provider, fleet.provider);
    assert.equal(saved.fullGroupQualified, false); assert.equal(saved.destroyedAt, undefined);
    assert.equal(fs.existsSync(path.join(p.h.base, group, ".groups-launch.lock")), false);
    assert.equal(fs.existsSync(path.join(p.h.base, group, "groups-r21/operation.lock")), false);
    const post = events.find((row) => row.group === group && row.method === "POST");
    assert.equal(post.body.name, job.name); assert.deepEqual(post.body.ssh_keys, [42]);
    assert.equal(post.body.size, "c-16"); assert.equal(post.body.region, "sfo2");
    assert.deepEqual(saved.host, { size: post.body.size, region: post.body.region, image: post.body.image });
    assert.deepEqual(events.filter((row) => row.group === group && (row.method === "POST" || row.path?.startsWith("/v2/actions/")))
      .map((row) => [row.method, row.path]), [["POST", "/v2/droplets"], ["GET", `/v2/actions/${1101 + i}`]]);
    assert.ok(!JSON.stringify(p.output).includes("SYNTHETIC_FLEET_CREDENTIAL"));
    const uploads = events.filter((row) => row.group === group && row.boundary === "upload");
    assert.equal(uploads.length, 3);
    assert.deepEqual(saved.control.sealed, ["bootstrap"]);
    assert.equal(saved.control.monitor.phase, "closed");
    assert.equal(saved.launchHostKeySha256, fileHash(path.join(p.h.base, group, "groups-r21/known_hosts")));
    assert.equal(events.filter((row) => row.group === group && row.boundary === "monitor").length, 1);
    const firstSsh = events.filter((row) => row.group === group && row.boundary === "ssh").slice(0, 3);
    assert.ok(firstSsh.every((row) => row.options.input === "set -euo pipefail\ntrue\n"));
    assert.deepEqual(firstSsh.map((row) => row.argv.at(-1) === "/bin/bash -s"), [true, true, false]);
    assert.equal(saved.control.ledger[0].request.invocation.requestSha256, digest(firstSsh[0].options.input));
    const script = uploads.find((row) => row.to.endsWith("/job.sh")).content;
    assert.ok(script.includes(`--group '${group}'`)); assert.ok(script.includes(`--commit '${commit}'`));
    assert.ok(script.includes("--state-dir '/bench/campaign'"));
    assert.ok(script.includes("--load-layout 'c16-generator-v1'"));
    assert.ok(script.includes('test "$(nproc)" -ge 16'));
    assert.ok(script.indexOf("/bench/bootstrap-ready.json") < script.indexOf("node 'bench/workloads/isolated/campaign-entry.mjs'"));
    assert.ok(script.includes(installSshIngress) && !script.includes("SSH_CONNECTION"));
    const verify = script.indexOf(verifySshIngress);
    assert.ok(script.indexOf(installSshIngress) < verify && verify < script.indexOf("/bench/bootstrap-ready.json"));
    const starts = events.filter((row) => row.group === group && row.boundary === "ssh" && row.options.input.includes(`systemctl start ${saved.unit}`));
    assert.equal(starts.length, 1);
    const installs = events.filter((row) => row.group === group && row.boundary === "ssh" && row.options.input.includes("systemctl daemon-reload"));
    assert.equal(installs.length, 1);
    const [install] = installs;
    assert.ok(install.options.input.endsWith("systemctl daemon-reload\n"));
    const capture = events.find((row) => row.group === group && row.boundary === "ssh" && row.options.input.includes(captureSshOwner));
    assert.equal(capture.options.input, `set -euo pipefail\n${bootstrapWorkspaceScript(saved)}\n`);
    assert.equal(capture.options.timeout, 60000);
    assert.equal(capture.argv.at(-2), `root@${saved.ip}`);
    assert.notEqual(capture.argv.at(-1), "/bin/bash -s");
    assert.equal(saved.control.ledger[1].request.invocation.requestSha256, digest(capture.options.input));
    const check = events.find((row) => row.group === group && row.boundary === "ssh" &&
      row.options.input === `set -euo pipefail\n${bootstrapReadScript}\n`);
    const monitor = events.find((row) => row.group === group && row.boundary === "monitor");
    const ordered = [capture, install, starts[0], check, monitor];
    assert.ok(ordered.every((row, i) => row && (i === 0 || events.indexOf(ordered[i - 1]) < events.indexOf(row))));
    assert.ok(ordered.every((row) => row.argv.at(-2) === install.argv.at(-2)));
    assert.ok(events.indexOf(capture) < events.indexOf(uploads[0]));
    const exited = events.filter((row) => row.group === group && row.boundary === "provider-child-exit");
    assert.equal(exited.length, 1); assert.equal(exited[0].code, 0); assert.equal(exited[0].signal, null);
    assert.ok(exited[0].terminal && exited[0].fleetLock && exited[0].launchLock && exited[0].operationLock);
    assert.equal(events.filter((row) => row.group === group && row.boundary === "synthetic-credential").length, 1);
  }
  const first = p.saved(), marker = `${JSON.stringify(bootstrapMarker(first))}\n`;
  assert.equal(first.bootstrapReady.sha256, digest(marker)); assert.ok(Number.isFinite(Date.parse(first.bootstrapReady.observedAt)));
  for (const row of events.filter((row) => ["ssh", "sftp", "monitor"].includes(row.boundary))) {
    assert.equal(row.options.shell, false); assert.equal(row.options.windowsHide, true);
    if (row.boundary !== "monitor") assert.ok(row.options.timeout > 0 && row.options.timeout <= 900000);
    assert.deepEqual(row.argv.slice(0, 4), ["-F", "none", "-o", "ForwardAgent=no"]);
    assert.ok(row.argv.includes("ClearAllForwardings=yes")); assert.ok(row.argv.includes("ControlPath=none"));
    assert.ok(row.argv.some((arg) => arg.startsWith('UserKnownHostsFile="') && arg.endsWith('/known_hosts"')));
    if (row.boundary === "ssh") assert.ok(row.options.input.startsWith("set -euo pipefail\n"));
    if (row.boundary === "sftp") assert.ok(row.argv.includes("-b") && row.argv.includes("-s"));
  }
  assert.equal(events.filter((row) => row.method === "POST").length, 1);
  for (const group of groupNames.slice(1)) assert.equal(fs.existsSync(path.join(p.h.base, group)), false);
  assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), false);
});

function unusedRetirement(root, fleet, group) {
  const local = path.join(root, group, `groups-${fleet.round}`), ms = Date.now(), at = new Date(ms).toISOString();
  const state = { ...reservation({ round: fleet.round, commit: fleet.commit, token: fleet.jobs[0].token, group, fleet }),
    provider: fleet.provider, fullGroupQualified: false, status: "retired", createIntentAt: at, deletionIntentAt: at, destroyedAt: at,
    id: "997", ip: "192.0.2.10", retirement: { kind: "unused", evidenceSha256: "a".repeat(64) } };
  const observation = JSON.stringify({ schema: "benchmark-unused-host/v1", hostId: state.id, unit: state.unit, observedAtMs: ms, unused: true });
  const proof = JSON.stringify(unusedEvidence(observation, state, unusedHostScript(state), ms, ms));
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "unused-host.json"), proof);
  fs.writeFileSync(path.join(local, "state.json"), JSON.stringify({ ...state, retirement: { kind: "unused", evidenceSha256: digest(proof) } }));
}

test("continuation schedules around pinned catalog and retired JSON without replaying either", { timeout: 60000 }, async (t) => {
  const p = fixture(t), before = new Map(), catalog = "catalog-page", json = "json-api", next = "localized-marketplace";
  const retained = path.join(p.h.temp, "retained"), index = path.join(p.h.base, "index.json");
  const history = fleetPlan({ round: "r20", commit: "b".repeat(40), token: "f".repeat(16), sshKey: "42", provider: { accountId, context },
    tokens: Object.fromEntries(groupNames.map((group, i) => [group, String(i + 1).repeat(16)])) });
  const { fleetSha256, ...oldBody } = structuredClone(history);
  oldBody.selection.groups.find(({ group }) => group === json).contractSha256 = "0".repeat(64);
  const oldCatalog = oldBody.selection.groups.find(({ group }) => group === catalog);
  oldCatalog.contractSha256 = "1".repeat(64);
  const oldFleet = { ...oldBody, fleetSha256: digest(JSON.stringify(oldBody)) };
  fs.mkdirSync(retained); fs.writeFileSync(path.join(retained, "fleet-r20.json"), JSON.stringify(oldFleet));
  function collected(root, fleet, group, state, date) {
    const local = path.join(root, group, `groups-${fleet.round}`), evidence = path.join(local, "evidence-Synthetic");
    const folder = path.join(evidence, "campaign"), campaign = `${fleet.round}-${state.token}`;
    fs.mkdirSync(path.join(folder, campaign), { recursive: true });
    const report = syntheticInspection("verified");
    Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", round: fleet.round, commit: fleet.commit, campaign,
      selection: state.selection, groups: report.groups.filter((entry) => entry.group === group) });
    if (savedLoadLayout(state)) report.loadLayout = savedLoadLayout(state);
    if (group === catalog) Object.assign(report.groups[0].appOutcomes.find((app) => app.app === "express"), { outcome: "failed", comparisonEligible: false });
    if (state.control?.monitor) {
      const terminal = JSON.parse(fs.readFileSync(path.join(local, "monitor-terminal.json")));
      report.supervisedTerminal = { registrationSha256: state.control.monitor.registrationSha256, sealSha256: terminal.sealSha256 };
    }
    const marker = path.join(folder, ".host-attempt.json"), file = path.join(local, "results.tgz");
    const markerBytes = JSON.stringify({ commit: fleet.commit, id: campaign, campaignSha256: report.campaignSha256, createdAt: date });
    fs.writeFileSync(marker, markerBytes);
    report.reservationSha256 = fileHash(marker);
    const plan = JSON.stringify({ round: fleet.round, commit: fleet.commit,
      campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256,
      bindings: [{ execution: { effectiveOptions: { fixture: group } } }] });
    const entries = [{ name: `campaign/${campaign}/plan.json`, body: plan }, { name: "campaign/.host-attempt.json", body: markerBytes },
      { name: "exit-code", body: "0\n" }, { name: "host.txt", body: "synthetic\n" }, { name: "run.log", body: "synthetic\n" }];
    for (const { name, body } of entries) fs.writeFileSync(path.join(evidence, name), body);
    fs.writeFileSync(file, archive(entries));
    Object.assign(state, { status: "collected", collectedAt: date, deletionIntentAt: date, destroyedAt: date,
      evidence: "evidence-Synthetic", extractionAttempts: ["evidence-Synthetic"], evidenceSha256: treeHash(evidence),
      archiveSha256: fileHash(file), evidenceOutcome: "validated", exitCode: 0,
      validation: { status: "verified", campaign, collectionIntegrity: "manifest-verified" } });
    fs.writeFileSync(path.join(local, "state.json"), JSON.stringify(state)); before.set(folder, report);
    return file;
  }
  const at = "2026-11-19T00:00:00.000Z";
  const saved = { ...reservation({ round: history.round, commit: history.commit, token: history.jobs[0].token, fleet: history, group: catalog }, at),
    fleet: oldFleet, selection: { ...history.selection, groups: [oldCatalog] },
    provider: history.provider, fullGroupQualified: false, createIntentAt: at, id: "900", ip: "192.0.2.200" };
  const oldArchive = collected(retained, oldFleet, catalog, saved, at), oldBytes = fs.readFileSync(oldArchive), oldTree = treeHash(retained);
  fs.writeFileSync(index, JSON.stringify([{ root: retained, checkout: path.join(p.h.temp, "missing-measured-checkout"), round: history.round, commit: history.commit,
    archives: { [catalog]: saved.archiveSha256 } }]));
  p.deps.inspect = async ({ folder, round, commit }) => {
    const report = before.get(folder); assert.equal(report?.round, round); assert.equal(report?.commit, commit); return report;
  };
  const args = (group) => ["r21", "--continuation-root", p.h.base, "--group", group];
  const prepare = (group) => [...args(group), "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  const preview = (group) => fleetMain([...args(group), "--detach", "--print-approval"], p.deps);
  const detached = (group, hash) => fleetMain([...args(group), "--detach", "--approve-reviewed-merged-ready", hash], p.deps);
  const initial = (await inspectContinuation(p.h.base, p.deps)).report;
  assert.equal(initial.groups.filter((row) => row.result).length, 1);
  assert.equal(initial.eligibleToRun.length, groupNames.length - 1);
  assert.ok(!initial.eligibleToRun.includes(catalog));
  const replay = p.deps.inspect;
  fs.appendFileSync(oldArchive, "changed");
  await assert.rejects(inspectContinuation(p.h.base, p.deps), /retained catalog-page/);
  let admissionReplay = 0;
  p.deps.inspect = () => { admissionReplay++; assert.fail("admission must not replay another group"); };
  await assert.rejects(fleetMain(prepare(catalog), p.deps), /already verified/);
  assert.deepEqual(p.events(), []);
  const onlyC8 = syntheticPlacement(["sfo3"]); onlyC8.sizes.pop(); onlyC8.regions[0].sizes = [];
  p.deps.catalogProvider = syntheticCatalogProvider(onlyC8);
  assert.equal(await fleetMain(prepare(json), p.deps), 3);
  await assert.rejects(fleetMain(["r21", "--fleet-root", path.join(p.h.base, json), "--detach", "--print-approval"], p.deps), /use continuation detach/);
  assert.equal(await preview(json), 3);
  const jsonApproval = p.output.at(-1).approvalSha256;
  p.deps.main = async () => 2; // Consume a real-shaped independent intent without creating anything.
  assert.equal(await detached(json, jsonApproval), 2);
  delete p.deps.main;
  const jsonRoot = path.join(p.h.base, json), jsonFleet = readFleet(jsonRoot, "r21").manifest;
  unusedRetirement(jsonRoot, jsonFleet, json);
  const reused = path.join(jsonRoot, ".fleet-operation.lock");
  fs.writeFileSync(reused, JSON.stringify({ pid: process.pid, approvalSha256: jsonApproval }));
  const retainedJson = treeHash(jsonRoot);
  const running = "mixed-production", binding = history.jobs.find(({ group }) => group === running);
  const runningPath = path.join(retained, running, "groups-r20");
  fs.mkdirSync(runningPath, { recursive: true });
  fs.writeFileSync(path.join(runningPath, "state.json"), JSON.stringify({
    ...reservation({ round: history.round, commit: history.commit, token: binding.token, fleet: history, group: running }, at),
    fleet: oldFleet, status: "running", createIntentAt: at, id: "902", ip: "192.0.2.202", provider: history.provider, fullGroupQualified: false,
  }));
  const beforePreview = p.events().length;
  assert.equal(await fleetMain(prepare(next), p.deps), 3);
  assert.equal(await preview(next), 3);
  const { approvalSha256, subject } = p.output.at(-1);
  assert.deepEqual(subject.jobs.map((job) => job.group), [next]);
  assert.deepEqual(subject.fleet.selection.groups, [history.selection.groups.find(({ group }) => group === next)]);
  assert.deepEqual(subject.continuation.verified, []);
  assert.deepEqual(subject.continuation.unconfirmed, [{ group: running, round: history.round, accountId,
    manifestSha256: fileHash(path.join(retained, "fleet-r20.json")), stateSha256: fileHash(path.join(runningPath, "state.json")), id: "902" }]);
  assert.equal(p.events().length, beforePreview, "prepare/preview have no child/provider mutation path");
  assert.ok(!fs.existsSync(path.join(p.h.base, next, "launch-intent.json")));
  delete p.deps.inspect; // There is no measured checkout to load and the old archive is still corrupt.
  assert.equal(await preview(next), 3);
  assert.equal(p.output.at(-1).approvalSha256, approvalSha256);
  assert.equal(await detached(next, approvalSha256), 3, JSON.stringify(p.output.at(-1)));
  assert.equal(admissionReplay, 0);
  assert.equal(treeHash(jsonRoot), retainedJson, "scheduler did not change the retired slot or its reused-PID lock");
  assert.deepEqual(p.events().filter((row) => row.method === "POST").map(({ group, body }) => [group, body.size]), [[next, "c-8"]]);
  await assert.rejects(detached(next, approvalSha256), /unresolved custody|already attempted/);
  fs.unlinkSync(reused); // Historical lock interpretation is a separate report-only concern.
  fs.unlinkSync(path.join(runningPath, "state.json"));
  fs.rmdirSync(runningPath); fs.rmdirSync(path.dirname(runningPath));
  fs.writeFileSync(oldArchive, oldBytes);
  p.deps.inspect = replay;
  const job = path.join(p.h.base, next), fleet = readFleet(job, "r21").manifest;
  const state = JSON.parse(fs.readFileSync(path.join(job, next, "groups-r21/state.json")));
  const at2 = "2026-11-21T00:00:00.000Z";
  collected(job, fleet, next, state, at2); fs.writeFileSync(p.hosts, "[]");
  const report = (await inspectContinuation(p.h.base, { repo: p.h.repo, inspect: p.deps.inspect })).report;
  assert.equal(report.status, "incomplete"); assert.equal(report.publishableBaseline, false);
  assert.deepEqual(report.groups.map(({ group }) => group), groupNames);
  for (const [round, measuredCommit, date, group] of [["r20", history.commit, at, catalog], ["r21", commit, at2, next]]) {
    const i = groupNames.indexOf(group);
    assert.equal(report.groups[i].outcome, "verified", JSON.stringify(report.groups[i]));
    const result = report.groups[i].result;
    assert.deepEqual([result.round, result.commit, result.campaignCreatedAt, result.baseEffectiveOptions], [round, measuredCommit, date, { fixture: group }]);
  }
  assert.equal(report.groups[0].result.matchesCurrentContract, false);
  assert.deepEqual(report.groups[0].result.selection, oldCatalog);
  assert.equal(report.groups[0].result.archiveSha256, saved.archiveSha256);
  assert.equal(report.groups[groupNames.indexOf(next)].result.matchesCurrentContract, true);
  assert.equal(report.groups[0].result.appOutcomes.find((app) => app.app === "express").comparisonEligible, false);
  await assert.rejects(fleetMain(prepare(next), p.deps), /already verified/);
  const pending = "hardening", historical = path.join(retained, catalog, "groups-r20", "state.json");
  const original = fs.readFileSync(historical), unconfirmed = { ...saved, destroyedAt: undefined };
  fs.writeFileSync(historical, JSON.stringify(unconfirmed));
  try {
    await assert.rejects(fleetMain(prepare(pending).map((part) => part === accountId ? "user:foreign" : part), p.deps), /same provider account/);
    assert.equal(await fleetMain(prepare(pending), p.deps), 3);
    assert.equal(await preview(pending), 3);
    const approval = p.output.at(-1);
    assert.deepEqual(approval.subject.continuation.unconfirmed, [{ group: catalog, round: history.round, accountId,
      manifestSha256: fileHash(path.join(retained, "fleet-r20.json")), stateSha256: fileHash(historical), id: saved.id }]);
    const beforeCensus = p.events().length;
    fs.writeFileSync(historical, JSON.stringify({ ...unconfirmed, id: "901" }));
    await assert.rejects(detached(pending, approval.approvalSha256), /exact-approval-required/);
    assert.equal(p.events().length, beforeCensus, "changed historical identity cannot reach provider");
    fs.writeFileSync(historical, JSON.stringify(unconfirmed));
    fs.writeFileSync(p.hosts, JSON.stringify([{ id: Number(saved.id), name: "renamed-unrelated-looking", tags: [] }]));
    assert.equal(await detached(pending, approval.approvalSha256), 2);
    const trace = p.events().slice(beforeCensus).filter(({ boundary }) => boundary === "provider");
    assert.deepEqual(trace.map(({ method, path }) => [method, path]), [
      ["GET", "/v2/account"], ["GET", "/v2/droplets?page=1&per_page=200"], ["GET", "/v2/account"],
    ]);
    assert.equal(p.saved(path.join(pending, pending)).createIntentAt, undefined);
  } finally { fs.writeFileSync(historical, original); fs.writeFileSync(p.hosts, "[]"); }
  const fork = path.join(p.h.temp, "incomplete-reindex"); fs.mkdirSync(fork);
  fs.writeFileSync(path.join(fork, "index.json"), JSON.stringify([{ root: job, checkout: p.h.repo, round: fleet.round, commit,
    archives: { [next]: report.groups[groupNames.indexOf(next)].result.archiveSha256 } }]));
  await assert.rejects(inspectContinuation(fork, { repo: p.h.repo, inspect: p.deps.inspect }), /stay in their original continuation root/);
  assert.equal(treeHash(retained), oldTree, "historical bytes untouched");
});

test("continuation child refuses a historical staged lock acquired after parent intent", { timeout: 60000 }, async (t) => {
  const p = fixture(t), retained = path.join(p.h.temp, "retained"), [first, group] = groupNames;
  const historical = ["r20", "--fleet-root", retained];
  const source = ["--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  assert.equal(await fleetMain([...historical, "--prepare", ...source], p.deps), 3);
  assert.equal(await fleetMain([...historical, "--detach", "--print-approval"], p.deps), 3);
  const oldApproval = p.output.at(-1).approvalSha256;
  assert.equal(await fleetMain([...historical, "--detach", "--approve-reviewed-merged-ready", oldApproval],
    { ...p.deps, main: async () => 2 }), 2);
  const fleet = readFleet(retained, "r20").manifest, token = fleet.jobs[0].token, at = new Date().toISOString();
  const local = path.join(retained, first, "groups-r20");
  const archiveSha256 = "a".repeat(64);
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "state.json"), JSON.stringify({
    ...reservation({ round: fleet.round, commit, token, fleet, group: first }, at),
    provider: fleet.provider, fullGroupQualified: false, status: "collected", id: "900", ip: "192.0.2.200",
    createIntentAt: at, collectedAt: at, deletionIntentAt: at, destroyedAt: at, archiveSha256, evidenceSha256: "b".repeat(64),
    evidence: "evidence-Synthetic", extractionAttempts: ["evidence-Synthetic"], evidenceOutcome: "validated", exitCode: 0,
    validation: { status: "verified", campaign: `r20-${token}`, collectionIntegrity: "manifest-verified" },
  }));
  fs.writeFileSync(path.join(p.h.base, "index.json"), JSON.stringify([{ root: retained, checkout: path.join(p.h.temp, "no-measured-checkout"),
    round: fleet.round, commit, archives: { [first]: archiveSha256 } }]));
  const independent = ["r21", "--continuation-root", p.h.base, "--group", group];
  assert.equal(await fleetMain([...independent, "--prepare", ...source], p.deps), 3);
  assert.equal(await fleetMain([...independent, "--detach", "--print-approval"], p.deps), 3);
  const { approvalSha256, subject } = p.output.at(-1), oldLock = path.join(retained, ".fleet-operation.lock");
  assert.deepEqual(subject.continuation.indexedCustody, [{ root: fs.realpathSync(retained),
    manifestSha256: fileHash(path.join(retained, "fleet-r20.json")), lock: null,
    launch: fileHash(path.join(retained, "launch-intent.json")) }]);
  assert.ok(!fs.existsSync(oldLock));
  let barrierReached = false;
  p.deps.WorkerClass = class extends p.deps.WorkerClass {
    constructor(entry, options) {
      assert.ok(fs.existsSync(path.join(p.h.base, group, "launch-intent.json")));
      assert.ok(!fs.existsSync(path.join(retained, "remaining-intent.json")));
      // Model a live remaining owner acquiring its lock before consuming intent.
      fs.writeFileSync(oldLock, JSON.stringify({ pid: process.pid, approvalSha256: digest("remaining action") }), { flag: "wx" });
      barrierReached = true;
      super(entry, options);
    }
  };
  assert.equal(await fleetMain([...independent, "--detach", "--approve-reviewed-merged-ready", approvalSha256], p.deps),
    2, JSON.stringify(p.output.at(-1)));
  assert.ok(barrierReached);
  const trace = p.events().filter(({ boundary }) => boundary === "provider");
  assert.ok(trace.some(({ method, path }) => method === "GET" && path.startsWith("/v2/droplets?")), "child reached its fresh census");
  assert.ok(trace.every(({ method }) => method === "GET"), "no provider mutation");
  assert.equal(p.saved(path.join(group, group)).createIntentAt, undefined);
});

test("independent continuation admits two remote-active hosts and collects a failed terminal host without waiting for its peer", { timeout: 90000 }, async (t) => {
  const p = fixture(t, "independent-overlap"), first = "json-api", second = "localized-marketplace", denied = "catalog-page";
  fs.writeFileSync(path.join(p.h.base, "index.json"), "[]");
  p.deps.inspect = () => assert.fail("no collected results yet");
  const args = (group) => ["r21", "--continuation-root", p.h.base, "--group", group];
  const prepare = (group) => fleetMain([...args(group), "--prepare", "--commit", commit,
    "--ssh-key", "42", "--account-id", accountId, "--context", context], p.deps);
  const approve = async (group) => {
    assert.equal(await fleetMain([...args(group), "--detach", "--print-approval"], p.deps), 3);
    return [...args(group), "--detach", "--approve-reviewed-merged-ready", p.output.at(-1).approvalSha256];
  };
  const wait = async (ready) => {
    const deadline = Date.now() + 30000;
    while (!ready()) { assert.ok(Date.now() < deadline, "synthetic readiness deadline"); await delay(50); }
  };
  const active = (group) => p.events().some((row) => row.group === group && row.boundary === "remote-active");
  const handoff = () => !fs.existsSync(path.join(p.h.base, ".continuation-operation.lock"));
  const finish = (group) => fs.writeFileSync(path.join(p.h.temp, "finish-" + group), "");
  const running = [];
  const launch = (approved) => {
    const promise = fleetMain(approved, p.deps); promise.catch(() => {}); running.push(promise); return promise;
  };
  try {
    assert.equal(await prepare(first), 3);
    const approved = await approve(first);
    const firstRun = launch(approved);
    await wait(() => active(first) && handoff());
    await assert.rejects(fleetMain(approved, p.deps), /already attempted/);
    const firstRoot = path.join(p.h.base, first, first), local = path.join(firstRoot, "groups-r21");
    const registrationPath = path.join(local, "monitor-registration.json"), temporarilyMissing = registrationPath + ".fixture-hold";
    fs.renameSync(registrationPath, temporarilyMissing);
    try { await assert.rejects(prepare(second), (e) => e.code === "ENOENT"); }
    finally { fs.renameSync(temporarilyMissing, registrationPath); }
    assert.equal(fs.existsSync(path.join(p.h.base, second)), false);

    assert.equal(await prepare(denied), 3);
    const deniedApproval = await approve(denied);
    const limit = p.hosts + ".limit";
    fs.writeFileSync(limit, "1");
    try { assert.equal(await fleetMain(deniedApproval, p.deps), 2); }
    finally { fs.unlinkSync(limit); }
    const refused = p.saved(path.join(denied, denied));
    assert.equal(refused.status, "reserved"); assert.equal(refused.createIntentAt, undefined);
    assert.deepEqual(p.events().filter((row) => row.method === "POST").map(({ group }) => group), [first]);

    assert.equal(await prepare(second), 3);
    const secondApproval = await approve(second);
    assert.deepEqual(p.output.at(-1).subject.continuation.peers.map(({ id }) => id), ["101"]);
    launch(secondApproval);
    await wait(() => active(second) && handoff());
    const events = p.events();
    assert.deepEqual(events.filter((row) => row.method === "POST").map(({ group }) => group), [first, second]);
    assert.deepEqual(events.filter((row) => row.boundary === "remote-active").map(({ group, id }) => [group, id]), [[first, "101"], [second, "102"]]);
    assert.ok(!events.some((row) => row.boundary === "monitor-terminal"));
    const inFlight = (await inspectContinuation(p.h.base, p.deps)).report.groups.filter((g) => g.outcome === "running");
    assert.deepEqual(inFlight.map((g) => [g.group, g.attempts[0].commit, g.attempts[0].host.size]), [[first, commit, "c-8"], [second, commit, "c-8"]]);

    finish(first);
    assert.equal(await firstRun, 3);
    // Advance only the fixture's post-close timestamp beyond the existing lease embargo.
    const closedPath = path.join(local, "monitor-local-closed.json"), closed = JSON.parse(fs.readFileSync(closedPath));
    const leaseWindow = closed.recoverAfterMs - closed.closedAtMs;
    closed.closedAtMs = Date.now() - leaseWindow - 1; closed.recoverAfterMs = closed.closedAtMs + leaseWindow;
    fs.writeFileSync(closedPath, JSON.stringify(closed));
    const s = p.saved(path.join(first, first)), terminal = JSON.parse(fs.readFileSync(path.join(local, "monitor-terminal.json")));
    const collect = harness(t, { stateRoot: firstRoot, hostId: s.id });
    const report = Object.assign(syntheticInspection("failed"), { schema: "benchmark-isolated-group-campaign-inspection/v1",
      campaign: terminal.campaign, selection: s.selection, placement: savedPlacement(s),
      supervisedTerminal: { registrationSha256: s.control.monitor.registrationSha256, sealSha256: terminal.sealSha256 } });
    collect.setArchive(archive(metadata()));
    assert.equal(await collect.task({ inspect: async () => report, run(...argv) {
      const [binary, args] = argv, droplets = JSON.parse(fs.readFileSync(p.hosts));
      collect.hosts(droplets);
      const result = collect.run(...argv);
      if (binary === "doctl" && args[2] === "delete") {
        assert.equal(args[3], "101");
        assert.ok(!p.events().some((row) => row.group === second && row.boundary === "monitor-terminal"));
        fs.writeFileSync(p.hosts, JSON.stringify(droplets.filter(({ id }) => String(id) !== args[3])));
      }
      return result;
    } }).collect(), 1);
    assert.equal(collect.deletes, 1);
    assert.ok(collect.saved().destroyedAt && fs.existsSync(path.join(local, "results.tgz")));
    assert.equal(collect.saved().validation.status, "failed");
    assert.deepEqual(JSON.parse(fs.readFileSync(p.hosts)).map(({ id }) => id), [102]);
  } finally {
    finish(first); finish(second);
    await Promise.all(running);
  }
});

test("a settled continuation placement refusal leaves the unallocated slot available", async (t) => {
  const p = fixture(t), group = "json-api";
  fs.writeFileSync(path.join(p.h.base, "index.json"), "[]");
  const args = ["r21", "--continuation-root", p.h.base, "--group", group, "--prepare", "--commit", commit,
    "--ssh-key", "42", "--account-id", accountId, "--context", context];
  const available = p.deps.catalogProvider;
  p.deps.catalogProvider = syntheticCatalogProvider(syntheticPlacement([]));
  await assert.rejects(fleetMain(args, p.deps), /no supported c-8/);
  assert.deepEqual(fs.readdirSync(path.join(p.h.base, group)), []);
  p.deps.catalogProvider = available;
  assert.equal(await fleetMain(args, p.deps), 3);
  assert.deepEqual(p.events(), []);
});

test("continuation appends authorized retries after no-create and retirement while keeping a prepared sibling", { timeout: 60000 }, async (t) => {
  const p = fixture(t), group = "json-api", other = "localized-marketplace";
  const index = path.join(p.h.base, "index.json"), oldSlot = path.join(p.h.base, group), sibling = path.join(p.h.base, other);
  fs.writeFileSync(index, "[]");
  p.deps.inspect = () => { assert.fail("there is no collected evidence to replay"); };
  p.deps.main = async () => 2; // A settled child refusal before its state directory exists.
  const args = (round, group) => [round, "--continuation-root", p.h.base, "--group", group];
  const prepare = (round, group) => fleetMain([...args(round, group), "--prepare", "--commit", commit,
    "--ssh-key", "42", "--account-id", accountId, "--context", context], p.deps);
  const preview = async (round, group) => {
    assert.equal(await fleetMain([...args(round, group), "--detach", "--print-approval"], p.deps), 3);
    return p.output.at(-1).approvalSha256;
  };
  const detach = (round, group, hash) => fleetMain([...args(round, group), "--detach", "--approve-reviewed-merged-ready", hash], p.deps);
  assert.equal(await prepare("r19", group), 3);
  assert.equal(await prepare("r21", other), 3);
  const siblingTree = treeHash(sibling), siblingApproval = await preview("r21", other);
  const oldApproval = await preview("r19", group);
  assert.equal(await detach("r19", group, oldApproval), 2);
  await assert.rejects(detach("r19", group, oldApproval), /already attempted/);
  let { report } = await inspectContinuation(p.h.base, p.deps);
  assert.equal(report.groups.find((r) => r.group === group).outcome, "not-created");
  assert.ok(report.eligibleToRun.includes(other) && report.eligibleToRun.includes(group));
  await assert.rejects(prepare("r19", group), /higher round/);

  const local = path.join(oldSlot, group, "groups-r19"), statePath = path.join(local, "state.json"), fleet = readFleet(oldSlot, "r19").manifest;
  fs.mkdirSync(local, { recursive: true });
  const saved = (fleet) => ({ ...reservation({ round: fleet.round, commit, token: fleet.jobs[0].token, group, fleet }),
    provider: fleet.provider, fullGroupQualified: false });
  for (const status of ["creating", "reserved"]) {
    fs.writeFileSync(statePath, JSON.stringify({ ...saved(fleet), status, createIntentAt: new Date().toISOString() }));
    await assert.rejects(prepare("r20", group), status === "creating" ? /unresolved custody/ : /reserved host already has create intent/);
  }
  fs.writeFileSync(statePath, JSON.stringify(saved(fleet)));
  const oldTree = treeHash(oldSlot);
  assert.equal(await prepare("r20", group), 3);
  const retrySlot = path.join(p.h.base, `${group}--r20`), retryFleet = readFleet(retrySlot, "r20").manifest;
  assert.notEqual(retryFleet.jobs[0].token, fleet.jobs[0].token);
  await assert.rejects(prepare("r21", group), /already reserved/);
  await assert.rejects(detach("r19", group, oldApproval), /already attempted/);
  const retryApproval = await preview("r20", group);
  await assert.rejects(detach("r20", group, oldApproval), /exact-approval-required/);

  const proofDir = path.join(retrySlot, group, "groups-r20"), proofPath = path.join(proofDir, "unused-host.json");
  const ms = Date.now(), at = new Date(ms).toISOString();
  const retired = { ...saved(retryFleet), status: "retired", createIntentAt: at, deletionIntentAt: at, destroyedAt: at,
    id: "997", ip: "192.0.2.10", retirement: { kind: "unused", evidenceSha256: "a".repeat(64) } };
  const observation = JSON.stringify({ schema: "benchmark-unused-host/v1", hostId: retired.id, unit: retired.unit, observedAtMs: ms, unused: true });
  const proof = JSON.stringify(unusedEvidence(observation, retired, unusedHostScript(retired), ms, ms));
  p.deps.main = async () => {
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(proofPath, "false proof");
    fs.writeFileSync(path.join(proofDir, "state.json"), JSON.stringify({ ...retired,
      retirement: { kind: "unused", evidenceSha256: digest(proof) } }));
    return 2;
  };
  assert.equal(await detach("r20", group, retryApproval), 2);
  await assert.rejects(prepare("r21", group), /unresolved custody/);
  fs.writeFileSync(proofPath, proof);
  const retiredTree = treeHash(retrySlot);
  assert.equal(await prepare("r21", group), 3);
  ({ report } = await inspectContinuation(p.h.base, p.deps));
  assert.deepEqual(report.groups.find((r) => r.group === group).attempts.map((r) => [r.round, r.outcome, r.attemptRoot]),
    [["r19", "not-created", oldSlot], ["r20", "unused-retired", retrySlot], ["r21", "prepared", path.join(p.h.base, `${group}--r21`)]]);
  assert.equal(await preview("r21", other), siblingApproval, "prepared sibling's original exact approval is still usable");
  assert.equal(treeHash(sibling), siblingTree);
  assert.deepEqual(p.events(), []);
  delete p.deps.main;
  const newApproval = await preview("r21", group);
  assert.equal(await detach("r21", group, newApproval), 3, JSON.stringify(p.output.at(-1)));
  await assert.rejects(detach("r21", group, newApproval), /unresolved custody|already attempted/);
  assert.deepEqual(p.events().filter((row) => row.method === "POST").map(({ group }) => group), ["json-api"]);
  assert.equal(treeHash(oldSlot), oldTree);
  assert.equal(treeHash(retrySlot), retiredTree);
  assert.equal(fs.readFileSync(index, "utf8"), "[]");
});

test("remaining approval moves from sfo2 to lon1 through captured workers and dispatches once", { timeout: 120000 }, async (t) => {
  const p = fixture(t, "overlap");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 3);
  const state = p.saved(), group = groupNames[0], campaign = `r21-${state.token}`;
  const local = path.join(p.h.base, group, "groups-r21"), evidence = path.join(local, "evidence-Synthetic");
  const folder = path.join(evidence, "campaign"), report = syntheticInspection("verified");
  const terminal = JSON.parse(fs.readFileSync(path.join(local, "monitor-terminal.json")));
  assert.equal(terminal.campaign, campaign); assert.equal(terminal.id, state.control.monitor.id);
  report.supervisedTerminal = { registrationSha256: state.control.monitor.registrationSha256, sealSha256: terminal.sealSha256 };
  Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", campaign,
    selection: state.selection, groups: report.groups.filter((row) => row.group === group), loadLayout: savedLoadLayout(state) });
  fs.mkdirSync(path.join(folder, campaign), { recursive: true });
  fs.writeFileSync(path.join(folder, ".host-attempt.json"), JSON.stringify({ id: campaign, commit, campaignSha256: report.campaignSha256 }));
  report.reservationSha256 = fileHash(path.join(folder, ".host-attempt.json"));
  fs.writeFileSync(path.join(folder, campaign, "plan.json"), JSON.stringify({ round: "r21", commit,
    campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256 }));
  fs.writeFileSync(path.join(evidence, "exit-code"), "0\n"); fs.writeFileSync(path.join(evidence, "host.txt"), "SYNTHETIC not measured\n");
  fs.writeFileSync(path.join(local, "results.tgz"), archive([{ name: "campaign/" }]));
  const at = new Date().toISOString();
  Object.assign(state, { status: "collected", collectedAt: at, deletionIntentAt: at, destroyedAt: at,
    evidence: "evidence-Synthetic", extractionAttempts: ["evidence-Synthetic"], evidenceSha256: treeHash(evidence),
    archiveSha256: fileHash(path.join(local, "results.tgz")), evidenceOutcome: "validated", exitCode: 0,
    validation: { status: "verified", campaign, collectionIntegrity: "manifest-verified" } });
  fs.writeFileSync(path.join(local, "state.json"), JSON.stringify(state));
  fs.writeFileSync(p.hosts, "[]"); // The synthetic provider no longer has the catalog host.
  // Only this code-only stand-in substitutes the native replay result. Child
  // admission still uses actual captured production/controller/provider workers.
  // The synthetic archive cannot establish native readiness or paid authority.
  p.deps.verify = async (fleet, group, { interrupted }) => ({
    ...await verifyCollectedGroup(fleet, group, { inspect: async () => report, interrupted }), evidenceMode: "native-replay" });
  const args = ["r21", "--fleet-root", p.h.base, "--admit-remaining"];
  const remainingCatalog = (regions) => {
    const catalog = syntheticPlacement(regions);
    catalog.sizes.pop();
    catalog.regions[0].sizes = catalog.regions[0].sizes.filter((size) => size !== "c-16");
    return syntheticCatalogProvider(catalog);
  };
  p.deps.catalogProvider = remainingCatalog(["lon1", "blr1"]);
  assert.equal(await fleetMain([...args, "--print-approval"], p.deps), 3);
  const preview = p.output.at(-1), approval = preview.approvalSha256;
  assert.equal(preview.subject.jobs[0].outcome, "verified");
  assert.equal(preview.subject.remainingRegion, "lon1");
  for (const job of preview.subject.jobs.slice(1)) assert.equal(job.subject.options.group, job.group);
  const approved = [...args, "--approve-reviewed-merged-ready", approval];
  p.deps.catalogProvider = remainingCatalog(["blr1"]);
  await assert.rejects(fleetMain(approved, p.deps), /fleet-exact-approval-required/);
  assert.equal(fs.existsSync(path.join(p.h.base, "remaining-intent.json")), false);
  assert.equal(p.workers.length, 1);
  assert.equal(p.events().filter((row) => row.method === "POST").length, 1);
  p.deps.catalogProvider = remainingCatalog(["lon1"]);
  assert.equal(await fleetMain(approved, p.deps), 3, JSON.stringify(p.output.at(-1)));
  assert.equal(p.workers.length, groupNames.length);
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "pending"));
  const events = p.events(), posts = events.filter((row) => row.method === "POST");
  assert.deepEqual(posts.map((row) => row.group), groupNames);
  assert.deepEqual(posts.map(({ body }) => [body.size, body.region]),
    [["c-16", "sfo2"], ...groupNames.slice(1).map(() => ["c-8", "lon1"])]);
  const ids = new Set(), ips = new Set();
  for (const group of groupNames) {
    const saved = p.saved(group); ids.add(saved.id); ips.add(saved.ip);
    assert.equal(saved.group, group); assert.equal(saved.status, group === groupNames[0] ? "collected" : "running");
    assert.equal(saved.host.region, group === groupNames[0] ? "sfo2" : "lon1");
    const job = events.find((row) => row.group === group && row.boundary === "upload" && row.to === "/bench/job.sh");
    assert.equal(job.content.includes("--placement 'dedicated-lon1'"), group !== groupNames[0]);
    const start = events.findIndex((row) => row.group === group && row.boundary === "provider-child-start");
    const exit = events.findIndex((row) => row.group === group && row.boundary === "provider-child-exit");
    assert.ok(start >= 0 && exit > start);
    if (group === groupNames[1]) {
      const peer = events.findIndex((row) => row.group === groupNames[2] && row.boundary === "monitor-registered");
      const terminal = events.findIndex((row) => row.group === group && row.boundary === "monitor-terminal");
      assert.ok(start < peer && peer < terminal && terminal < exit, "peer registered while this monitor and provider worker were live");
    }
  }
  assert.equal(ids.size, groupNames.length); assert.equal(ips.size, groupNames.length);
  assert.ok(!events.some((row) => row.method === "DELETE"));
  await assert.rejects(fleetMain(approved, p.deps), /remaining-already-attempted/);
  assert.equal(p.events().filter((row) => row.method === "POST").length, groupNames.length);
  assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), false);
});

test("completed POST host A cannot provision otherwise owned host B or admit the next group", { timeout: 30000 }, async (t) => {
  const p = fixture(t, "host-id-mismatch");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
  assert.equal(p.workers.length, 1);
  const events = p.events(), saved = p.saved();
  assert.equal(saved.id, "201", "fresh owned identity retained for recovery");
  assert.equal(saved.status, "preparing");
  assert.ok(!events.some((row) => ["ssh", "sftp", "monitor", "upload"].includes(row.boundary)));
  assert.equal(events.filter((row) => row.method === "POST").length, 1);
  assert.deepEqual(events.filter((row) => row.path?.startsWith("/v2/actions/")).map((row) => [row.method, row.path]), [["GET", "/v2/actions/1101"]]);
  assert.ok(!events.some((row) => row.method === "DELETE"));
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
});

test("late completed create preserves uncertainty and locks without provisioning or later admission", { timeout: 30000 }, async (t) => {
  const p = fixture(t, "late-create");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
  assert.equal(p.workers.length, 1);
  const events = p.events(), saved = p.saved();
  assert.equal(saved.status, "creating"); assert.equal(saved.id, undefined);
  assert.ok(!events.some((row) => ["ssh", "sftp", "monitor", "upload"].includes(row.boundary)));
  assert.equal(events.filter((row) => row.method === "POST").length, 1);
  assert.equal(events.filter((row) => row.path?.startsWith("/v2/actions/")).length, 1);
  assert.ok(!events.some((row) => row.method === "DELETE"));
  const first = p.output.at(-1).groups[0];
  assert.equal(first.uncertain, true);
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
  assert.ok(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")));
  assert.ok(fs.existsSync(path.join(p.h.base, groupNames[0], ".groups-launch.lock")));
  assert.ok(fs.existsSync(path.join(p.h.base, groupNames[0], "groups-r21/operation.lock")));
});

test("captured production rejects Git advertisement before reservation or provider access", { timeout: 15000 }, async (t) => {
  const p = fixture(t, "advertisement");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
  assert.equal(p.workers.length, 1);
  assert.equal(p.events().filter((row) => row.boundary === "provider" || row.boundary === "synthetic-credential").length, 0);
  assert.ok(p.events().some((row) => row.boundary === "git" && row.argv[0] === "ls-remote"));
  for (const group of groupNames) assert.equal(fs.existsSync(path.join(p.h.base, group)), false);
  assert.equal(p.output.at(-1).groups[0].outcome, "error");
  assert.equal(p.output.at(-1).groups[0].controllerStage, "remote-main-advertisement");
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
  assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), false);
});

function realCatalog(p, mode) {
  let child;
  p.deps.catalogProvider = (deps) => providerTransport({ ...deps, launch(_binary, _args, options) {
    child = fork(new URL("./fleet-provider-test-worker.mjs", import.meta.url),
      [mode, p.trace, p.hosts, p.h.base, "parent", userId],
      { ...options, execArgv: [], env: { ...options.env, NODE_OPTIONS: "--max-old-space-size=64 --max-semi-space-size=4" } });
    return child;
  } });
  return () => child.exitCode;
}

const refusedCatalog = { code: "catalog-response" };
const deniedCatalog = { code: "catalog-http", httpStatus: 403 };
const catalogFailure = (diagnostic) => (error) => {
  assert.equal(!!error.controlTreeUncertain, diagnostic === null);
  if (diagnostic) assert.deepEqual(error.providerDiagnostic, diagnostic);
  return true;
};

test("prepare can retry a settled invalid listing, but retains the lock on disconnect", { timeout: 15000 }, async (t) => {
  for (const [mode, diagnostic] of [["catalog-shape", refusedCatalog], ["catalog-disconnect", null]]) await t.test(mode, async (t) => {
    const p = fixture(t), exitCode = realCatalog(p, mode);
    await assert.rejects(fleetMain(p.prepareArgs, p.deps), catalogFailure(diagnostic));
    assert.equal(exitCode(), diagnostic ? 0 : 2);
    assert.deepEqual(fs.readdirSync(p.h.base), diagnostic ? [] : [".fleet-operation.lock"]);
    assert.equal(p.workers.length, 0);
    assert.ok(p.events().filter((row) => row.boundary === "provider").every((row) => row.method === "GET"));
    if (diagnostic) {
      const retryExitCode = realCatalog(p, "success");
      assert.equal(await fleetMain(p.prepareArgs, p.deps), 3);
      assert.equal(retryExitCode(), 0);
      assert.equal(readFleet(p.h.base, "r21").manifest.host.region, "sfo3");
      assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), false);
    }
  });
});

test("settled catalog refusals retry before fleet intent; disconnect retains the lock", { timeout: 20000 }, async (t) => {
  for (const [mode, diagnostic] of [["catalog-denial", deniedCatalog], ["catalog-count", refusedCatalog],
    ["catalog-pagination", refusedCatalog], ["catalog-disconnect", null]]) await t.test(mode, async (t) => {
    const p = fixture(t);
    p.deps.catalogProvider = syntheticCatalogProvider(syntheticPlacement(["sfo2"]));
    const approved = await p.prepare(), exitCode = realCatalog(p, mode);
    await assert.rejects(fleetMain(approved, p.deps), catalogFailure(diagnostic));
    assert.equal(exitCode(), diagnostic ? 0 : 2);
    assert.equal(p.workers.length, 0);
    assert.deepEqual(p.events().filter((row) => row.boundary === "provider").map((row) => [row.method, row.path]),
      [["GET", "/v2/account"], ["GET", "/v2/sizes?page=1&per_page=200"],
        ...(mode === "catalog-pagination" ? [["GET", "/v2/sizes?page=2&per_page=200"]] : [])]);
    assert.equal(fs.existsSync(path.join(p.h.base, "launch-intent.json")), false);
    assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), diagnostic === null);
    if (diagnostic?.code === "catalog-response") {
      const retryExitCode = realCatalog(p, "success");
      assert.equal(await fleetMain(approved, p.deps), 3);
      assert.equal(retryExitCode(), 0);
      assert.equal(p.events().filter((row) => row.boundary === "provider" && row.method === "POST").length, 1);
      assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), false);
    }
  });
});

test("settled child catalog refusals release locks without a create; disconnect preserves custody", { timeout: 20000 }, async (t) => {
  for (const [mode, diagnostic] of [["catalog-denial", deniedCatalog], ["catalog-shape", refusedCatalog], ["catalog-disconnect", null]]) await t.test(mode, async (t) => {
    const p = fixture(t, mode), uncertain = diagnostic === null;
    assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
    assert.equal(p.workers.length, 1);
    const state = p.saved(), [row] = p.output.at(-1).groups;
    assert.equal(state.status, "reserved"); assert.equal(state.createIntentAt, undefined);
    assert.equal(row.uncertain, uncertain);
    assert.equal(row.controllerStage, uncertain ? "provider-settlement" : "controller-launch");
    if (diagnostic) assert.deepEqual(row.providerDiagnostic, diagnostic);
    assert.ok(p.events().some((row) => row.path === "/v2/sizes?page=1&per_page=200"));
    assert.ok(p.events().filter((row) => row.boundary === "provider").every((row) => row.method === "GET"));
    for (const lock of [".fleet-operation.lock", "catalog-page/.groups-launch.lock", "catalog-page/groups-r21/operation.lock"])
      assert.equal(fs.existsSync(path.join(p.h.base, lock)), uncertain, lock);
  });
});

test("real provider refusal and withheld close retain locks and stop later admissions", { timeout: 30000 }, async (t) => {
  for (const mode of ["provider-failure", "withhold-close"]) {
    const p = fixture(t, mode);
    assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
    assert.equal(p.workers.length, 1); assert.equal(p.saved().status, mode === "provider-failure" ? "reserved" : "running");
    const requests = p.events().filter((row) => row.boundary === "provider");
    if (mode === "provider-failure") assert.deepEqual(requests.map((row) => [row.method, row.path]), [["GET", "/v2/account"]]);
    else { assert.equal(requests.filter((row) => row.method === "POST").length, 1); assert.ok(p.events().some((row) => row.boundary === "withheld-close")); }
    const rows = p.output.at(-1).groups;
    assert.equal(rows[0].outcome, "error"); assert.equal(rows[0].uncertain, true);
    assert.equal(rows[0].controllerStage, "provider-settlement");
    if (mode === "provider-failure") assert.deepEqual(rows[0].providerDiagnostic, { code: "account-http", httpStatus: 403 });
    else assert.equal(p.events().find((row) => row.boundary === "provider-child-exit").signal, "SIGKILL");
    assert.equal(requests.filter((row) => row.method === "DELETE").length, 0);
    assert.ok(rows.slice(1).every((row) => row.outcome === "not-admitted" && row.reason === "prior-admission-failed"));
    for (const group of groupNames.slice(1)) assert.equal(fs.existsSync(path.join(p.h.base, group)), false);
    for (const lock of [path.join(p.h.base, ".fleet-operation.lock"), path.join(p.h.base, groupNames[0], ".groups-launch.lock"),
      path.join(p.h.base, groupNames[0], "groups-r21/operation.lock")]) assert.equal(fs.existsSync(lock), true, lock);
  }
});

test("source-mismatched common bootstrap marker preserves first running host and stops admission", { timeout: 15000 }, async (t) => {
  const p = fixture(t, "marker");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
  assert.equal(p.workers.length, 1); assert.equal(p.saved().status, "running");
  assert.equal(p.saved().bootstrapReady, undefined);
  assert.equal(p.output.at(-1).groups[0].controllerStage, "controller-launch");
  assert.equal(p.events().filter((row) => row.method === "POST").length, 1);
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
});

test("refused authenticated peer capture preserves the host without uploading or starting a unit", { timeout: 15000 }, async (t) => {
  const p = fixture(t, "owner-capture-fail");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
  const saved = p.saved(), events = p.events(), request = saved.control.ledger.at(-1).request;
  assert.equal(saved.status, "preparing");
  assert.equal(saved.bootstrapReady, undefined);
  assert.equal(p.workers.length, 1);
  assert.equal(events.filter((row) => row.method === "POST").length, 1);
  assert.ok(!events.some((row) => row.method === "DELETE" || ["monitor", "upload"].includes(row.boundary)
    || row.boundary === "ssh" && row.options.input.includes(`systemctl start ${saved.unit}`)));
  const [capture] = events.filter((row) => row.boundary === "ssh" && row.options.input.includes(captureSshOwner));
  assert.equal(request.invocation.requestSha256, digest(capture.options.input));
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
});
