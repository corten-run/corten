// Offline composition acceptance: real snapshot Worker -> productionMain -> controller.
// Only credential consumption and external Git/HTTPS/SSH/SCP responses are fake.
import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata, syntheticCatalogProvider, syntheticDelivery, syntheticInspection, syntheticPlacement, userId } from "./cloud-fixtures.mjs";
import { digest, durable, fileHash, treeHash } from "./cloud-local.mjs";
import { fleetCli, fleetMain, fleetWorkerPaths } from "./fleet.mjs";
import { bootstrapMarker, bootstrapReadScript } from "./cloud-remote.mjs";
import { providerTransport } from "./cloud-provider.mjs";
import { productionPlan } from "./cloud-production.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { bootstrapWorkspaceScript, captureSshOwner, fleetPlan, installSshIngress, preloginUserData, reservation, savedLoadLayout, savedPlacement, tags, verifySshIngress } from "./cloud-contract.mjs";
import { checkQuarantineCensus, externalFailedHostBinding, readExternalFailedHost, readFleet, readLaunchIntent, recheckCreateQuarantine, recheckSetupAttempt, unacknowledgedCreateBinding, verifyCollectedGroup } from "./fleet-verify.mjs";
import { unitQuery } from "./cloud-options.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { createErroredReceipt, createErroredRecord, offlineNeverStarted, setupEvidence, terminalSetupScript, unusedEvidence, unusedHostScript } from "./cloud-retirement.mjs";
import { continuationAdmission, continuationLock, inspectContinuation } from "./group-continuation.mjs";
import { groupNames } from "./registry.mjs";
import { syntheticDependencies } from "./fleet-production-fixture.mjs";
import { registration } from "./test-fixtures/control-stream-fixture.mjs";
import { streamLimits } from "./isolated/control-stream.mjs";
import { controller, publicError } from "./droplet.mjs";
import { deploymentSha256 } from "./deployments.mjs";

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

function fixture(t, mode = "success", fakeRoleGroup, dispatch) {
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
  const refusalLog = path.join(h.temp, "refusals.jsonl");
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
      if (dispatch?.move) {
        const beforeCheck = "for (const stillIdle of setupIdleChecks) stillIdle();";
        const pathLiteral = JSON.stringify(path.join(h.base, ...dispatch.path));
        assert.equal(source.split(beforeCheck).length, 2, "review retired state movement seam");
        source = source.replace(beforeCheck, `syntheticFs.renameSync(${pathLiteral}, ${pathLiteral} + '.moved');\n          ${beforeCheck}`);
      }
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
const nativeRoleCheck = (${roleCheckFor.toString()})(${JSON.stringify(commit)}, ${JSON.stringify(checkoutCommit)});
const syntheticRoleCheck = (subject) => subject.group === ${JSON.stringify(fakeRoleGroup)} ? [] : nativeRoleCheck(subject);
const synthetic = (${syntheticDependencies.toString()})({
  repo: ${JSON.stringify(repo)}, trace: ${JSON.stringify(trace)}, hosts: ${JSON.stringify(hosts)},
  stateDir: syntheticArgs[syntheticArgs.indexOf('--state-dir') + 1], group: syntheticGroup,
  commit: ${JSON.stringify(commit)}, userId: ${JSON.stringify(userId)}, mode: ${JSON.stringify(mode)},
  holdUntilGroup: ${mode === "overlap" ? `syntheticGroup === ${JSON.stringify(groupNames[1])} ? ${JSON.stringify(groupNames[2])} : null` : "null"}
}, { fs: syntheticFs, path: syntheticPath, fork: syntheticFork, providerTransport,
  bootstrapMarker: syntheticMarker, bootstrapReadScript: syntheticRead, bootstrapWorkspaceScript, controlRegistration,
  EventEmitter, PassThrough, Writable, registration: ${JSON.stringify(registration)} });\n`;
    }
    if (file === "bench/workloads/cloud-production.mjs") {
      // The worker passes only closed fields to its parent, never a refusal's message. Record
      // productionMain's message chain beside the trace so a test can tell which gate refused;
      // the body and its result are unchanged.
      const entry = "export async function productionMain(";
      assert.equal(source.split(entry).length, 2, "review refusal-recording seam");
      source = source.replace(entry, "async function syntheticProductionMain(") + `
export async function productionMain(...args) {
  const dispatch = ${JSON.stringify(dispatch ? { path: path.join(h.base, ...dispatch.path), cancel: dispatch.cancel } : undefined)};
  if (dispatch) {
    const previous = args[1].interrupted;
    let afterIntent = 0;
    args[1].interrupted = () => {
      const target = syntheticPath.join(syntheticArgs[syntheticArgs.indexOf('--state-dir') + 1], 'groups-r21', 'state.json');
      if (syntheticFs.existsSync(target) && JSON.parse(syntheticFs.readFileSync(target, 'utf8')).createIntentAt
          && ++afterIntent >= (dispatch.cancel || 1)) {
        if (!syntheticFs.existsSync(dispatch.path)) syntheticFs.writeFileSync(dispatch.path, '{}', { flag: 'wx' });
      }
      return previous() || dispatch.cancel && syntheticFs.existsSync(dispatch.path);
    };
  }
  try { return await syntheticProductionMain(...args); }
  catch (error) {
    const messages = [];
    for (let cause = error; cause && messages.length < 8; cause = cause.cause) messages.push(String(cause.message));
    syntheticFs.appendFileSync(${JSON.stringify(refusalLog)}, JSON.stringify(messages) + "\\n");
    throw error;
  }
}
`;
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
  // Each worker refusal's message and its causes, in order.
  const refusals = () => fs.existsSync(refusalLog) ? readTrace(refusalLog, { finished: true }) : [];
  return { h, output, workers, saved, events, refusals, prepare, prepareArgs, deps, trace, hosts };
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
    assert.equal(saved.quietBootstrap, "prelogin"); assert.equal(post.body.user_data, preloginUserData);
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
    const status = events.find((row) => row.group === group && row.options?.input === `set -euo pipefail\n${unitQuery(saved)}\n`);
    assert.equal(starts[0].quietMs, 0);
    assert.equal(status.quietMs, 135000);
    const ordered = [capture, install, starts[0], status, check, monitor];
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

test("captured production cannot observe startup a second before the SSH-free window ends", { timeout: 30000 }, async (t) => {
  const p = fixture(t, "short-clock");
  assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
  const saved = p.saved(), events = p.events();
  assert.equal(saved.status, "starting");
  const remote = events.filter((row) => ["ssh", "sftp", "monitor"].includes(row.boundary));
  const start = `set -euo pipefail\nsystemctl start ${saved.unit}\n`;
  assert.equal(remote.filter((row) => row.options.input === start).length, 1);
  assert.deepEqual(remote.slice(-2).map((row) => [row.options.input, row.quietMs]),
    [[start, 0], [`set -euo pipefail\n${unitQuery(saved)}\n`, 134000]]);
  assert.ok(!events.some((row) => row.boundary === "bootstrap-marker" || row.boundary === "monitor"));
  assert.equal(events.filter((row) => row.method === "POST").length, 1);
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

function retainCatalogFixture(p) {
  const before = new Map(), catalog = "catalog-page", json = "json-api";
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
  return { before, retained, index, history, oldFleet, saved, oldArchive, oldBytes, oldTree, collected, at };
}

test("continuation schedules around pinned catalog and retired JSON without replaying either", { timeout: 60000 }, async (t) => {
  const p = fixture(t), catalog = "catalog-page", json = "json-api", next = "localized-marketplace";
  const { before, retained, index, history, oldFleet, saved, oldArchive, oldBytes, oldTree, collected, at } = retainCatalogFixture(p);
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
  assert.deepEqual(report.groups[0].result.selection, saved.selection.groups[0]);
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

for (const [retry, change] of [
  ...["none", "cleanup lock", "late account lock", "reservation bytes", "renamed host"].map((change) => [false, change]),
  ...["none", "late account lock", "archive bytes", "renamed host"].map((change) => [true, change]),
]) test(`stopped ${retry ? "predecessor" : "sibling"}, after intent: ${change}`, { timeout: retry ? 90000 : 60000 }, async (t) => {
  const p = fixture(t, "ssh-late"), group = retry ? "recoverable-live" : "fullstack-browser", other = "hardening";
  const old = path.join(p.h.base, group), target = retry ? group : other, oldRound = retry ? "r20" : "r21", round = "r21";
  const slot = path.join(p.h.base, retry ? `${group}--${round}` : other);
  const historical = retry ? "b".repeat(40) : commit;
  const oldDeps = retry ? { ...p.deps,
    spawn: (binary, argv) => binary === "git" && argv[0] === "rev-parse" && argv[1] === "HEAD"
      ? { status: 0, stdout: historical } : p.deps.spawn(binary, argv),
    // Only seed the consumed predecessor intent at a synthetic commit. The
    // new round uses the original role preflight and production worker.
    plan: (options, deps) => productionPlan(options, { ...deps, roleCheck: () => [] }),
  } : p.deps;
  fs.writeFileSync(path.join(p.h.base, "index.json"), "[]");
  const args = (g, round) => [round, "--continuation-root", p.h.base, "--group", g];
  const prepare = (g, r, source = commit, deps = p.deps, account = accountId) => fleetMain([...args(g, r), "--prepare", "--commit", source,
    "--ssh-key", "42", "--account-id", account, "--context", context], deps);
  const approve = async (g, round, deps = p.deps) => {
    assert.equal(await fleetMain([...args(g, round), "--detach", "--print-approval"], deps), 3);
    return [...args(g, round), "--detach", "--approve-reviewed-merged-ready", p.output.at(-1).approvalSha256];
  };
  assert.equal(await prepare(group, oldRound, historical, oldDeps), 3);
  assert.equal(await fleetMain(await approve(group, oldRound, oldDeps), { ...oldDeps, main: async () => 2 }), 2);
  const fleet = readFleet(old, oldRound).manifest;
  const state = reservation({ round: oldRound, commit: historical, token: fleet.jobs[0].token, group, fleet });
  const local = path.join(old, group, `groups-${oldRound}`);
  fs.mkdirSync(local, { recursive: true });
  Object.assign(state, { status: "starting", provider: fleet.provider, fullGroupQualified: false, id: "701", ip: "192.0.2.1",
    createIntentAt: state.createdAt, control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256,
      ledger: [], sealed: [], monitor: { schema: "benchmark-supervised-control/v1", id: "1".repeat(32), phase: "pending" } } });
  for (const command of [`systemctl start ${state.unit}`, unitQuery(state)])
    state.control.ledger.push({ request: controlRequest(state, "ssh", [command], 60000, "bootstrap"), localTerminal: true, code: 0 });
  const save = () => fs.writeFileSync(path.join(local, "state.json"), JSON.stringify(state));
  save();
  await assert.rejects(prepare(other, "r22"), /unresolved custody/);
  if (retry) await assert.rejects(prepare(group, round), /unresolved custody/);
  const evidence = path.join(local, "evidence-Synthetic"), tar = path.join(local, "results.tgz");
  const exitFile = path.join(evidence, "exit-code");
  fs.mkdirSync(evidence); fs.writeFileSync(exitFile, "124\n");
  const bytes = archive([{ name: "exit-code", body: "124\n" }]);
  Object.assign(state, { preBootstrapTerminal: { hostId: state.id, ip: state.ip, monitorId: state.control.monitor.id,
    invocation: state.control.ledger.at(-1).request.invocation.id, stdout: `Id=${state.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${state.unit}\nActiveState=failed\nRestart=no\nMainPID=0\nExecMainCode=1\nExecMainStartTimestamp=Fri 2026-11-13 01:00:00 UTC\n` },
    evidence: "evidence-Synthetic", extractionAttempts: ["evidence-Synthetic"], archiveSha256: digest(bytes), evidenceSha256: treeHash(evidence) });
  save();
  await assert.rejects(prepare(other, "r22"), /ENOENT/);
  if (retry) await assert.rejects(prepare(group, round), /ENOENT/);
  fs.writeFileSync(tar, "replaced"); await assert.rejects(prepare(other, "r22"), assert.AssertionError);
  fs.writeFileSync(tar, bytes);
  const original = treeHash(old);
  if (retry) {
    await assert.rejects(prepare(group, round, historical, oldDeps), /different measured commit/);
    await assert.rejects(prepare(group, round, commit, p.deps, "user:other-account"), /same provider account/);
    await assert.rejects(prepare(group, oldRound), /higher round/);
    assert.ok(!fs.existsSync(slot));
  } else await assert.rejects(prepare(group, "r22"), /different measured commit/);
  if (retry && change === "none") {
    const zeroExit = archive([{ name: "exit-code", body: "0\n" }]);
    fs.writeFileSync(tar, zeroExit); fs.writeFileSync(exitFile, "0\n");
    state.archiveSha256 = digest(zeroExit); state.evidenceSha256 = treeHash(evidence); save();
    await assert.rejects(prepare(group, round), /nonzero setup exit/);
    assert.ok(!fs.existsSync(slot), "a zero exit must not reserve a successor");
    fs.writeFileSync(tar, bytes); fs.writeFileSync(exitFile, "124\n");
    state.archiveSha256 = digest(bytes); state.evidenceSha256 = treeHash(evidence); save();

    const campaign = path.join(evidence, "campaign"), entry = path.join(campaign, "entry");
    const originalEvidence = state.evidenceSha256;
    fs.mkdirSync(campaign); fs.writeFileSync(entry, "unexpected campaign evidence");
    state.evidenceSha256 = treeHash(evidence); save();
    await assert.rejects(prepare(group, round), /setup attempt entered the campaign/);
    fs.unlinkSync(entry); fs.rmdirSync(campaign); state.evidenceSha256 = originalEvidence; save();
    assert.equal(treeHash(old), original);
  }
  assert.equal(await prepare(target, round), 3);
  if (retry) {
    await assert.rejects(prepare(group, "r22", historical, oldDeps), /different measured commit/);
    await assert.rejects(approve(group, oldRound, oldDeps), /group round not prepared/);
    const deps = { repo: p.h.repo, inspect: syntheticInspection };
    const selected = (await continuationAdmission(p.h.base, group, deps)).rows.find((row) => row.group === group);
    const siblingView = (await continuationAdmission(p.h.base, other, deps)).rows.find((row) => row.group === group);
    const reported = (await inspectContinuation(p.h.base, deps)).report.groups.find((row) => row.group === group);
    for (const row of [selected, siblingView, reported]) {
      assert.equal(row.outcome, "prepared");
      assert.deepEqual(row.attempts.map(({ round, outcome }) => [round, outcome]), [
        [oldRound, "setup-failed-needs-census"], [round, "prepared"],
      ]);
    }
  }
  const approved = await approve(target, round);
  const census = p.output.at(-1).subject.continuation.unconfirmed;
  assert.deepEqual(census, [{ group, round: oldRound, accountId, manifestSha256: fileHash(path.join(old, `fleet-${oldRound}.json`)),
    stateSha256: fileHash(path.join(local, "state.json")), id: state.id, root: old, launch: fileHash(path.join(old, "launch-intent.json")) }]);
  const lock = path.join(local, "operation.lock");
  if (change === "late account lock") fs.writeFileSync(p.hosts + ".late-lock", lock);
  if (change === "cleanup lock") {
    const open = fs.openSync;
    const mock = t.mock.method(fs.default, "openSync", (file, ...args) => {
      const fd = open(file, ...args);
      if (file === tar) fs.writeFileSync(lock, "hash in progress", { flag: "wx" });
      return fd;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => recheckSetupAttempt(p.h.base, census[0]), /setup attempt recovery started/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    fs.unlinkSync(lock);
  }
  let reached = false;
  p.deps.WorkerClass = class extends p.deps.WorkerClass {
    constructor(entry, options) {
      assert.ok(fs.existsSync(path.join(slot, "launch-intent.json")));
      if (change === "cleanup lock") fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      if (change === "reservation bytes") fs.appendFileSync(path.join(local, "state.json"), "\n");
      if (change === "archive bytes") fs.appendFileSync(tar, "changed");
      if (change === "renamed host") fs.writeFileSync(p.hosts, JSON.stringify([{ id: 701, name: "renamed", tags: [] }]));
      reached = true;
      super(entry, options);
    }
  };
  assert.equal(await fleetMain(approved, p.deps), change === "none" ? 3 : 2);
  assert.ok(reached);
  const trace = p.events().filter(({ boundary }) => boundary === "provider");
  assert.ok(trace.some(({ method, path }) => method === "GET" && path.startsWith("/v2/droplets?")));
  if (change === "none") assert.deepEqual(trace.filter(({ method }) => method === "POST").map(({ group }) => group), [target]);
  else {
    assert.ok(trace.every(({ method }) => method === "GET"), "no provider mutation after handoff");
    const saved = JSON.parse(fs.readFileSync(path.join(slot, target, `groups-${round}`, "state.json")));
    assert.equal(saved.createIntentAt, undefined);
  }
  if (change === "cleanup lock" || change === "late account lock") fs.unlinkSync(lock);
  if (change === "reservation bytes") save();
  if (change === "archive bytes") fs.writeFileSync(tar, bytes);
  assert.equal(treeHash(old), original);
});

function externalFailureFixture(p) {
  const root = p.h.base;
  const args = (r, g) => [r, "--continuation-root", root, "--group", g];
  const prepare = (r, g) => fleetMain([...args(r, g), "--prepare", "--commit", commit, "--ssh-key", "42",
    "--account-id", accountId, "--context", context], p.deps);
  const approve = async (r, g) => {
    assert.equal(await fleetMain([...args(r, g), "--detach", "--print-approval"], p.deps), 3);
    return [...args(r, g), "--detach", "--approve-reviewed-merged-ready", p.output.at(-1).approvalSha256];
  };
  async function seed(group = "json-api", round = "r20", posted = false, orphaned = false) {
    assert.equal(await prepare(round, group), 3);
    assert.equal(await fleetMain(await approve(round, group), { ...p.deps, main: async () => {
      if (!posted) return 2;
      throw Object.assign(new Error("provider read refused"), { controlUncertain: true, controllerStage: "provider-settlement",
        providerDiagnostic: { code: "create-action-request" } });
    } }), 2);
    const old = path.join(root, group), stateRoot = path.join(old, group), local = path.join(stateRoot, `groups-${round}`);
    fs.mkdirSync(local, { recursive: true });
    const fleet = readFleet(old, round), manifest = fleet.manifest, token = manifest.jobs[0].token;
    const at = "2026-11-23T00:00:00.000Z", monitorId = "a".repeat(32), monitorBinding = { round, commit, token, helperSha256: guardianSha256 };
    const app = { ...registration, id: monitorId, binding: monitorBinding,
      ...(orphaned ? { host: { ...registration.host, hostname: manifest.jobs[0].name } } : {}) }, closedAtMs = Date.parse(at);
    const initial = { ...reservation({ round, commit, group, token, fleet: manifest }, at),
      createIntentAt: at, provider: manifest.provider, fullGroupQualified: false };
    const monitor = { schema: "benchmark-supervised-control/v1", id: monitorId };
    const state = posted ? { ...initial, skipHostChromium: true, status: "creating", createPending: { dropletId: "701", actionId: "801" },
      control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [],
        monitor: { ...monitor, phase: "pending" } } } : { ...initial, status: "running",
      id: "701", ip: "192.0.2.1",
      control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: ["bootstrap"],
        monitor: { ...monitor, phase: orphaned ? "live" : "invalid", registrationSha256: digest(JSON.stringify(app)) } } };
    if (!posted) {
      state.control.ledger.push({ request: controlRequest(state, "ssh", [`systemctl start ${state.unit}`], 60000, "bootstrap", []), localTerminal: true, code: 0 });
      for (const [name, value] of Object.entries(orphaned ? { "monitor-registration.json": app } : { "monitor-registration.json": app,
        "monitor-invalid.json": { id: monitorId, binding: monitorBinding, publicationRevoked: true },
        "monitor-local-closed.json": { id: monitorId, binding: monitorBinding, remoteDrained: false, closedAtMs, recoverAfterMs: closedAtMs + 2 * streamLimits.leaseMs } }))
        fs.writeFileSync(path.join(local, name), JSON.stringify(value));
      fs.writeFileSync(path.join(local, "monitor-journal.jsonl"), JSON.stringify({ schema: "benchmark-control-frame/v1", id: monitorId,
        kind: "registered", sequence: 1, payload: app }) + "\n");
      if (orphaned) {
        const journal = path.join(local, "monitor-journal.jsonl");
        const frame = (kind, sequence, payload) => ({ schema: "benchmark-control-frame/v1", id: monitorId, kind, sequence, payload });
        const audit = syntheticDelivery(group), identities = audit.bundle.receipts.map((r) => r.identity);
        const prefix = group === "json-api" ? "json" : "mixed";
        const subject = { schema: `benchmark-${prefix}-audit-subject/v1`, commit, campaignSha256: "f".repeat(64),
          ...(group === "json-api" ? { identities } : { requests: identities.map((identity) => ({ identity })) }) };
        const ready = { campaign: `${round}-0123456789abcdef`, group, subjectSha256: deploymentSha256(subject) };
        audit.subjectSha256 = audit.review.subjectSha256 = ready.subjectSha256;
        const queued = JSON.stringify(audit);
        const frames = [frame("progress", 4, { round, state: "active" }), frame("audit-begin", 8, ready),
          frame("audit-end", 9, { group, subjectSha256: ready.subjectSha256 }),
          frame("delivery-sealed", 10, { ...ready, bytes: Buffer.byteLength(queued), sha256: digest(queued) })];
        fs.appendFileSync(journal, [...frames, { kind: "peer-lease", id: monitorId, atMs: closedAtMs }].map((row) => JSON.stringify(row)).join("\n") + "\n");
        fs.mkdirSync(path.join(local, "monitor-audit-" + group));
        fs.writeFileSync(path.join(local, `monitor-audit-${group}`, `${prefix}-audit-subject.json`), JSON.stringify({ ...subject, subjectSha256: ready.subjectSha256 }));
        fs.writeFileSync(path.join(local, "monitor-audit-" + group + "-ready.json"), JSON.stringify(ready));
        fs.writeFileSync(path.join(local, "monitor-delivery-" + group + ".json"), queued);
      }
    }
    fs.writeFileSync(path.join(local, "state.json"), JSON.stringify(state));
    const owner = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
    assert.equal(owner.status, 0);
    const pid = owner.pid;
    fs.writeFileSync(path.join(old, ".fleet-operation.lock"), JSON.stringify({ pid, approvalSha256: readLaunchIntent(fleet).approvalSha256 }));
    fs.writeFileSync(path.join(stateRoot, ".groups-launch.lock"), JSON.stringify({ pid, round }));
    fs.writeFileSync(path.join(local, "operation.lock"), JSON.stringify({ pid, at }));
    if (posted) {
      const outer = path.join(root, continuationLock);
      assert.ok(fs.existsSync(outer), "the original outer lock is retained");
      await assert.rejects(prepare("r21", "hardening"), /EEXIST/);
      fs.unlinkSync(outer); // Synthetic operator, after independent process-tree review.
      await assert.rejects(prepare("r21", "hardening"), /unresolved custody|ESRCH/);
    }
    const binding = externalFailedHostBinding(fleet, { orphaned });
    if (orphaned) {
      assert.throws(() => externalFailedHostBinding(fleet), /invalid attempt/);
      const journal = path.join(local, "monitor-journal.jsonl"), original = fs.readFileSync(journal);
      for (const [suffix, refusal] of [
        [JSON.stringify({ kind: "peer-lease", id: monitorId, atMs: Date.now() }) + "\n", /expired peer lease/],
        [JSON.stringify({ schema: "benchmark-control-frame/v1", id: monitorId, kind: "terminal", sequence: 11, payload: {} }) + "\n", /journal requires reconciliation/],
        ["{", /incomplete monitor journal/],
      ]) {
        fs.appendFileSync(journal, suffix);
        assert.throws(() => externalFailedHostBinding(fleet, { orphaned }), refusal);
        fs.writeFileSync(journal, original);
      }
      const delivered = path.join(local, `monitor-delivery-${group}.json`);
      const delivery = fs.readFileSync(delivered);
      fs.writeFileSync(delivered, "{ }");
      assert.throws(() => externalFailedHostBinding(fleet, { orphaned }), /saved audit delivery differs/);
      fs.writeFileSync(delivered, delivery);
      const rows = original.toString("utf8").trimEnd().split("\n").map((row) => JSON.parse(row));
      const writeJournal = (entries) => fs.writeFileSync(journal, entries.map((row) => JSON.stringify(row)).join("\n") + "\n");
      for (const bad of ["", "{", "{}"]) {
        fs.writeFileSync(delivered, bad);
        writeJournal(rows.map((row) => row.kind === "delivery-sealed"
          ? { ...row, payload: { ...row.payload, bytes: Buffer.byteLength(bad), sha256: digest(bad) } } : row));
        assert.throws(() => externalFailedHostBinding(fleet, { orphaned }), /saved audit delivery differs/);
      }
      fs.writeFileSync(delivered, delivery);
      const subject = path.join(local, `monitor-audit-${group}`, "json-audit-subject.json"), subjectBytes = fs.readFileSync(subject);
      fs.writeFileSync(journal, original);
      fs.unlinkSync(subject);
      assert.throws(() => externalFailedHostBinding(fleet, { orphaned }));
      fs.writeFileSync(subject, subjectBytes);
      writeJournal([rows[0], rows.at(-1), ...rows.slice(1, -1)]);
      assert.throws(() => externalFailedHostBinding(fleet, { orphaned }), /monitor journal requires reconciliation/);
      writeJournal(rows.map((row) => row.kind === "progress" ? { ...row, extra: "x".repeat(streamLimits.frameBytes) } : row));
      assert.throws(() => externalFailedHostBinding(fleet, { orphaned }), /oversized monitor journal record/);
      fs.writeFileSync(journal, original);
      const conflicting = path.join(local, "results.tgz");
      fs.writeFileSync(conflicting, "not a replay candidate");
      assert.throws(() => externalFailedHostBinding(fleet, { orphaned }), /cannot supersede other evidence/);
      fs.unlinkSync(conflicting);
    }
    if (posted) {
      assert.equal(binding.id, state.createPending.dropletId);
      assert.equal(binding.actionId, state.createPending.actionId);
      assert.throws(() => unacknowledgedCreateBinding(fleet), /without a posted ID/);
      const statePath = path.join(local, "state.json");
      const { monitor, ...unmonitoredControl } = state.control;
      fs.writeFileSync(statePath, JSON.stringify({ ...state, control: unmonitoredControl }));
      assert.throws(() => externalFailedHostBinding(fleet), /pending unregistered monitor/);
      fs.writeFileSync(statePath, JSON.stringify(state));
      const artifact = path.join(local, "monitor-registration.json");
      fs.writeFileSync(artifact, "{}");
      assert.throws(() => externalFailedHostBinding(fleet), /child files differ/);
      fs.unlinkSync(artifact);
      const detach = path.join(old, "receipts", fs.readdirSync(path.join(old, "receipts"))[0]);
      const original = fs.readFileSync(detach);
      fs.writeFileSync(detach, JSON.stringify({ ...JSON.parse(original), providerDiagnostic: { code: "create-request" } }));
      assert.throws(() => externalFailedHostBinding(fleet), /lost create-action read/);
      fs.writeFileSync(detach, original);
    }
    const receiptFile = path.join(old, "receipts", "external-failed-host.json"), receipt = {
      schema: orphaned ? "benchmark-external-failed-host/v2" : "benchmark-external-failed-host/v1",
      binding, operatorProofSha256: "c".repeat(64), ...(orphaned ? { archiveSha256: "d".repeat(64) } : {}) };
    if (orphaned) {
      fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, archiveSha256: undefined }));
      assert.throws(() => readExternalFailedHost(fleet), /archive hash required/);
    }
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    return { old, local, state };
  }
  return { prepare, approve, seed };
}

test("retained orphan receipt survives a proved reuse of its stopped Windows owner PID", { timeout: 60000 }, async (t) => {
  const p = fixture(t, "ssh-late", "hardening"), root = p.h.base;
  p.deps.plan = (options, deps) => productionPlan(options, { ...deps, roleCheck: () => [] });
  fs.writeFileSync(path.join(root, "index.json"), "[]");
  const { old, local } = await externalFailureFixture(p).seed("json-api", "r20", false, true);
  const fleet = readFleet(old, "r20"), lock = path.join(old, ".fleet-operation.lock");
  const { pid } = JSON.parse(fs.readFileSync(lock));
  const receipt = path.join(old, "receipts", "external-failed-host.json");
  const timestamps = (file) => {
    // Replay reads integer milliseconds; floating stats can round up at the boundary.
    const s = fs.lstatSync(file, { bigint: true });
    return [s.birthtimeMs, s.mtimeMs, s.ctimeMs].map(Number);
  };
  const lastLock = Math.max(...[lock, path.join(local, "operation.lock"),
    path.join(path.dirname(local), ".groups-launch.lock")].flatMap(timestamps));
  const receiptStamp = new Date(lastLock + 1000);
  fs.utimesSync(receipt, receiptStamp, receiptStamp);
  const latest = Math.max(...timestamps(receipt));
  const beforeReceipt = lastLock + 1;
  assert.ok(beforeReceipt < latest);
  await delay(Math.max(20, latest + 20 - Date.now()));
  const started = Date.now(), stop = process.kill.bind(process);
  assert.ok(started > latest);
  const tree = treeHash(old);
  t.mock.method(process, "kill", (id, signal) => id === pid && signal === 0 ? true : stop(id, signal));
  assert.throws(() => externalFailedHostBinding(fleet, { orphaned: true }), /original stopped batch owner/);
  assert.throws(() => readExternalFailedHost(fleet, { processStart: () => undefined }), /original stopped batch owner/);
  assert.throws(() => readExternalFailedHost(fleet, { processStart: () => beforeReceipt }), /original stopped batch owner/);
  assert.throws(() => readExternalFailedHost(fleet, { processStart: () => latest }), /original stopped batch owner/);
  assert.throws(() => readExternalFailedHost(fleet, { processStart: () => Date.now() + 60000 }), /original stopped batch owner/);
  const row = readExternalFailedHost(fleet, { processStart: (id) => id === pid ? started : undefined });
  assert.equal(row.round, "r20");
  assert.equal(row.externalFailureSha256, fileHash(receipt));
  assert.equal(treeHash(old), tree);
  assert.throws(() => readExternalFailedHost(fleet, { processStart() {
    fs.appendFileSync(receipt, "\n");
    return started;
  } }), /external failure receipt changed during replay/);
});

for (const kind of ["attempt", "posted create", "orphaned supervisor"])
for (const scenario of ["absent", "renamed old ID", "old tag on a different ID", "incomplete census", "late recovery"]) {
  test(`external failed ${kind} before create: ${scenario}`, { timeout: 60000 }, async (t) => {
    const target = "hardening", next = "r21", p = fixture(t, "ssh-late", target), root = p.h.base;
    p.deps.plan = (options, deps) => productionPlan(options, { ...deps, roleCheck: () => [] });
    fs.writeFileSync(path.join(root, "index.json"), "[]");
    const { prepare, approve, seed } = externalFailureFixture(p);
    const { old, local, state } = await seed("json-api", "r20", kind === "posted create", kind === "orphaned supervisor");
    const custody = treeHash(old);
    assert.equal(await prepare(next, target), 3);
    const approved = await approve(next, target), recovery = path.join(local, "stream-recovery.lock");
    if (scenario === "renamed old ID") fs.writeFileSync(p.hosts, JSON.stringify([{ id: Number(state.id ?? state.createPending.dropletId), name: "renamed", tags: [] }]));
    if (scenario === "old tag on a different ID") fs.writeFileSync(p.hosts, JSON.stringify([{ id: 702, name: "unrelated", tags: [state.tag] }]));
    if (scenario === "incomplete census") fs.writeFileSync(p.hosts + ".census-first", JSON.stringify({ droplets: [], meta: { total: 1 } }));
    if (scenario === "late recovery") {
      p.deps.WorkerClass = class extends p.deps.WorkerClass {
        constructor(entry, options) { fs.writeFileSync(recovery, "external recovery started"); super(entry, options); }
      };
    }
    const exit = await fleetMain(approved, p.deps);
    assert.equal(exit, scenario === "absent" ? 3 : 2, JSON.stringify(p.refusals()));
    const calls = p.events().filter(({ boundary }) => boundary === "provider");
    assert.ok(calls.some(({ method, path }) => method === "GET" && path === "/v2/droplets?page=1&per_page=200"));
    assert.deepEqual(calls.filter(({ method }) => method !== "GET").map(({ method, group }) => [method, group]),
      scenario === "absent" ? [["POST", target]] : []);
    if (scenario !== "absent") {
      const current = JSON.parse(fs.readFileSync(path.join(root, target, target, `groups-${next}`, "state.json")));
      assert.equal(current.createIntentAt, undefined);
    }
    if (scenario === "late recovery") fs.unlinkSync(recovery);
    assert.equal(treeHash(old), custody);
  });
}

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
    const inventory = fs.readFileSync(p.hosts, "utf8");
    assert.equal(JSON.parse(inventory).length, 1);
    fs.writeFileSync(limit, "1");
    try { assert.equal(await fleetMain(deniedApproval, p.deps), 2); }
    finally { fs.unlinkSync(limit); }
    assert.deepEqual(p.output.at(-1).groups, [{ group: denied, outcome: "error", error: "group-operation-failed",
      uncertain: false, providerDiagnostic: { code: "account-capacity" }, controllerStage: "controller-launch" }]);
    const refused = p.saved(path.join(denied, denied));
    assert.equal(refused.status, "reserved"); assert.equal(refused.createIntentAt, undefined); assert.equal(refused.id, undefined);
    assert.deepEqual(refused.control.ledger, []);
    const refusedRoot = path.join(p.h.base, denied, denied);
    assert.ok(!fs.existsSync(path.join(refusedRoot, ".groups-launch.lock")) && !fs.existsSync(path.join(refusedRoot, "groups-r21/operation.lock")));
    assert.ok(!fs.existsSync(path.join(p.h.base, continuationLock)));
    assert.equal(fs.readFileSync(p.hosts, "utf8"), inventory);
    const deniedEvents = p.events().filter((row) => row.group === denied);
    assert.ok(deniedEvents.some((row) => row.method === "GET" && row.path.startsWith("/v2/droplets?")));
    assert.ok(deniedEvents.every((row) => row.boundary !== "provider" || row.method === "GET"));
    assert.ok(!deniedEvents.some((row) => ["ssh", "upload", "monitor"].includes(row.boundary)));
    assert.deepEqual(p.events().filter((row) => row.method === "POST").map(({ group }) => group), [first]);

    assert.equal(await prepare(second), 3);
    const secondApproval = await approve(second);
    assert.deepEqual(p.output.at(-1).subject.continuation.peers.map(({ id }) => id), ["101"]);
    fs.writeFileSync(limit, "2"); // The first host still occupies one slot.
    try {
      launch(secondApproval);
      await wait(() => active(second) && handoff());
    } finally { fs.unlinkSync(limit); }
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

for (const change of ["none", "after handoff", "after create intent", "cancel before dispatch", "cancel at provider", "new batch after intent", "state moved during replay", "external failure after intent"]) test(`a retired setup retry: ${change}`, { timeout: 60000 }, async (t) => {
  const group = "json-api", lockFile = "stream-recovery.lock", childDir = [group, group, "groups-r19"];
  const markers = { "after create intent": [...childDir, lockFile], "cancel before dispatch": [...childDir, "cancelled"],
    "cancel at provider": [...childDir, "cancelled"], "new batch after intent": [group, ".fleet-operation.lock"],
    "external failure after intent": ["hardening", "hardening", "groups-r20", lockFile] };
  const cancel = { "cancel before dispatch": 2, "cancel at provider": 3 }[change];
  const dispatch = markers[change] ? { path: markers[change], cancel } : change === "state moved during replay"
    ? { path: [...childDir, "state.json"], move: true } : undefined;
  const p = fixture(t, "ssh-late", group, dispatch), root = p.h.base, prior = path.join(root, group);
  p.deps.plan = (options, deps) => productionPlan(options, { ...deps, roleCheck: () => [] });
  fs.writeFileSync(path.join(root, "index.json"), "[]");
  const args = (r) => [r, "--continuation-root", root, "--group", group];
  const prepare = (r) => fleetMain([...args(r), "--prepare", "--commit", commit,
    "--ssh-key", "42", "--account-id", accountId, "--context", context], p.deps);
  const approve = async (r) => {
    assert.equal(await fleetMain([...args(r), "--detach", "--print-approval"], p.deps), 3);
    return [...args(r), "--detach", "--approve-reviewed-merged-ready", p.output.at(-1).approvalSha256];
  };
  assert.equal(await prepare("r19"), 3);
  assert.equal(await fleetMain(await approve("r19"), { ...p.deps, main: async () => 2 }), 2);
  const fleet = readFleet(prior, "r19").manifest, local = path.join(prior, group, "groups-r19");
  const evidence = "evidence-Synthetic", dir = path.join(local, evidence), ms = Date.now(), at = new Date(ms).toISOString();
  fs.mkdirSync(dir, { recursive: true });
  const entries = [{ name: "exit-code", body: "124\n" }], bytes = archive(entries);
  fs.writeFileSync(path.join(dir, entries[0].name), entries[0].body);
  fs.writeFileSync(path.join(local, "results.tgz"), bytes);
  const state = { ...reservation({ round: "r19", commit, token: fleet.jobs[0].token, group, fleet }),
    provider: fleet.provider, status: "retired", id: "703", ip: "192.0.2.1", createIntentAt: at, deletionIntentAt: at, destroyedAt: at,
    evidence, extractionAttempts: [evidence], archiveSha256: digest(bytes), evidenceSha256: treeHash(dir), fullGroupQualified: false,
    retirement: { kind: "setup-failed", evidenceSha256: "a".repeat(64) } };
  const observation = JSON.stringify({ schema: "benchmark-failed-setup-host/v1", hostId: state.id, unit: state.unit,
    observedAtMs: ms, setupFailed: true, exitCode: 124 });
  const receipt = JSON.stringify(setupEvidence(observation, state, terminalSetupScript(state, 124), 124, ms, ms));
  fs.writeFileSync(path.join(local, "failed-setup-host.json"), receipt);
  fs.writeFileSync(path.join(local, "state.json"), JSON.stringify({ ...state, retirement: { kind: "setup-failed", evidenceSha256: digest(receipt) } }));
  if (change === "external failure after intent") await externalFailureFixture(p).seed("hardening", "r20");

  assert.equal(await prepare("r21"), 3);
  const approved = await approve("r21"), next = path.join(root, `${group}--r21`);
  let handedOff = false;
  p.deps.WorkerClass = class extends p.deps.WorkerClass {
    constructor(entry, options) {
      assert.ok(fs.existsSync(path.join(next, "launch-intent.json")));
      if (change === "after handoff") fs.writeFileSync(path.join(local, lockFile), "{}", { flag: "wx" });
      handedOff = true;
      super(entry, options);
    }
  };
  const code = await fleetMain(approved, p.deps);
  assert.ok(handedOff);
  assert.equal(p.events().filter(({ method }) => method === "POST").length, change === "none" ? 1 : 0);
  assert.equal(code, change === "none" ? 3 : 2);
  if (change !== "none") {
    const lock = dispatch ? path.join(root, ...dispatch.path) : path.join(local, lockFile);
    if (dispatch?.move) assert.ok(!fs.existsSync(lock) && fs.existsSync(lock + ".moved"));
    else assert.ok(fs.existsSync(lock));
    const nextState = p.saved(path.join(`${group}--r21`, group));
    if (change === "external failure after intent") {
      assert.ok(p.refusals().flat().some((message) => /external failure/.test(message)));
      assert.ok(nextState.createIntentAt, "the existing external refusal retains the successor intent");
      fs.unlinkSync(lock);
      return;
    }
    assert.equal(nextState.createIntentAt, undefined); assert.equal(nextState.status, "reserved");
    if (dispatch?.move) fs.renameSync(lock + ".moved", lock);
    else fs.unlinkSync(lock);
    const admission = await continuationAdmission(root, group);
    assert.equal(admission.rows.find((row) => row.group === group).outcome, "not-created");
  }
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

for (const scenario of ["admission", "nonterminal sighting", "count-mismatch sighting", "external host sighting", "malformed name sighting", "malformed tags sighting",
  "oversized array sighting", "oversized tags sighting", "incomplete absence", "malformed absence",
  "witnessed census", "absent census", "capacity", "historical ID", "replacement absent", "replacement sighted"]) {
test(`a quarantined unacknowledged create: ${scenario}`, { timeout: 60000 }, async (t) => {
  const mixed = scenario === "historical ID";
  const external = scenario === "external host sighting";
  const replacement = scenario.startsWith("replacement ");
  const group = mixed ? "recoverable-live" : replacement ? "mixed-production" : "json-api", other = "hardening", round = "r19", next = "r21",
    p = fixture(t, "success", replacement ? group : other), slot = path.join(p.h.base, group);
  fs.writeFileSync(path.join(p.h.base, "index.json"), "[]");
  p.deps.inspect = () => { assert.fail("no collected evidence"); };
  // This control exercises the admission and approval bytes, not Linux actor
  // source replay; the failed child is a synthetic local controller below.
  p.deps.plan = (options, deps) => productionPlan(options, { ...deps, async roleCheck(subject) {
    assert.ok([group, other, "json-api"].includes(subject.group) || external && subject.group === "fullstack-browser");
    return [];
  } });
  if (mixed) {
    const earlier = await lateCreateAttempt(t, { p });
    assert.equal(await earlier.child(), 1);
    fs.unlinkSync(earlier.locks.outer);
  }
  if (scenario === "witnessed census") retainCatalogFixture(p);
  const args = (which, name) => [which, "--continuation-root", p.h.base, "--group", name];
  const prepare = (which, name, extra = []) => fleetMain([...args(which, name), "--prepare", "--commit", commit,
    "--ssh-key", "42", "--account-id", accountId, "--context", context, ...extra], p.deps);
  assert.equal(await prepare(round, group), 3);
  assert.equal(await fleetMain([...args(round, group), "--detach", "--print-approval"], p.deps), 3);
  const approval = p.output.at(-1).approvalSha256, saved = readFleet(slot, round), fleet = saved.manifest;
  const stateRoot = path.join(slot, group), local = path.join(stateRoot, "groups-r19"), at = new Date().toISOString();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const pending = { ...reservation({ round, commit, token: fleet.jobs[0].token, group, fleet }), provider: fleet.provider,
    fullGroupQualified: false, status: "creating", createIntentAt: at };
  p.deps.main = async () => {
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "state.json"), JSON.stringify(pending));
    fs.writeFileSync(path.join(stateRoot, ".groups-launch.lock"), JSON.stringify({ pid: dead, round }));
    fs.writeFileSync(path.join(local, "operation.lock"), JSON.stringify({ pid: dead, at }));
    throw Object.assign(new Error("PRIVATE_MESSAGE"), { controlUncertain: true, controllerStage: "provider-settlement",
      providerDiagnostic: { code: "create-request", detail: "request-error" } });
  };
  assert.equal(await fleetMain([...args(round, group), "--detach", "--approve-reviewed-merged-ready", approval], p.deps), 2);
  delete p.deps.main;
  const batch = path.join(slot, ".fleet-operation.lock"), outer = path.join(p.h.base, continuationLock);
  fs.writeFileSync(batch, JSON.stringify({ ...JSON.parse(fs.readFileSync(batch)), pid: dead }));
  await assert.rejects(prepare("r20", other), /EEXIST/);
  fs.unlinkSync(outer); // synthetic operator's positive custody proof and archive, not a controller action
  await assert.rejects(prepare("r20", other), (error) => error.code === "ESRCH" || error.message.includes("unresolved custody"));
  const record = path.join(slot, "receipts", "create-quarantine.json");
  const receipt = path.join(slot, "receipts", fs.readdirSync(path.join(slot, "receipts"))[0]);
  const failure = fs.readFileSync(receipt);
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(failure), SAVEDKEYCANARY: "SAVEDVALUECANARY" }));
  assert.throws(() => unacknowledgedCreateBinding(readFleet(slot, round)), (error) =>
    error.message === "create quarantine detach outcome differs" && !String(error).includes("CANARY"));
  fs.writeFileSync(receipt, failure);
  const binding = unacknowledgedCreateBinding(readFleet(slot, round));
  const proof = { schema: "benchmark-create-quarantine/v1", binding, localCustodyProofSha256: "4".repeat(64) };
  fs.writeFileSync(record, JSON.stringify(proof));
  const stopped = external ? (await externalFailureFixture(p).seed("fullstack-browser")).state : undefined;
  const sealed = treeHash(slot);
  const { report } = await inspectContinuation(p.h.base, p.deps);
  assert.ok(report.eligibleToRun.includes(other));
  assert.ok(!report.eligibleToRun.includes(group));
  assert.equal(report.groups.find((row) => row.group === group).outcome, "quarantined-create");
  await assert.rejects(prepare("r20", group), /never allocate again/);
  if (replacement) {
    const quarantineSha256 = fileHash(record), replacementSlot = `${group}--${next}`;
    const eventsBeforePrepare = p.events();
    await assert.rejects(prepare(next, group, ["--replace-quarantined-create", "0".repeat(64)]), /matching create quarantine/);
    assert.deepEqual(p.events(), eventsBeforePrepare);
    assert.ok(!fs.existsSync(path.join(p.h.base, replacementSlot)));
    assert.equal(await prepare(next, group, ["--replace-quarantined-create", quarantineSha256]), 3);
    const selected = readFleet(path.join(p.h.base, replacementSlot), next).manifest;
    assert.notEqual(selected.jobs[0].token, fleet.jobs[0].token);
    assert.equal(await fleetMain([...args(next, group), "--detach", "--print-approval"], p.deps), 3);
    const { approvalSha256, subject } = p.output.at(-1);
    assert.deepEqual(subject.continuation.quarantinedCreates.map(({ sha256 }) => sha256), [quarantineSha256]);
    if (scenario === "replacement sighted") fs.writeFileSync(p.hosts, JSON.stringify([{ id: 123, name: "renamed", tags: [pending.tag] }]));
    const code = await fleetMain([...args(next, group), "--detach", "--approve-reviewed-merged-ready", approvalSha256], p.deps);
    assert.ok(fs.existsSync(path.join(p.h.base, replacementSlot, group, "groups-r21", "state.json")), JSON.stringify(p.refusals()));
    const state = p.saved(path.join(replacementSlot, group));
    const events = p.events(), posts = events.filter((row) => row.method === "POST");
    assert.ok(!events.some((row) => row.method === "DELETE"));
    if (scenario === "replacement absent") {
      assert.equal(code, 3); assert.equal(posts.length, 1); assert.ok(state.createIntentAt);
      assert.equal(treeHash(slot), sealed);
    } else {
      assert.equal(code, 2); assert.equal(posts.length, 0); assert.equal(state.createIntentAt, undefined);
      const witness = JSON.parse(fs.readFileSync(path.join(slot, "receipts", "create-quarantine-witness.json")));
      assert.deepEqual(witness, { schema: "benchmark-create-quarantine-witness/v1", quarantineSha256, dropletId: "123" });
      assert.equal(fileHash(path.join(local, "state.json")), binding.stateSha256);
    }
    return;
  }
  assert.equal(await prepare(next, other), 3);
  const preview = await fleetMain([...args(next, other), "--detach", "--print-approval"], p.deps);
  assert.equal(preview, 3);
  const [old] = p.output.at(-1).subject.continuation.quarantinedCreates;
  assert.equal(old.sha256, fileHash(record)); assert.equal(old.group, group);
  const nextFleet = readFleet(path.join(p.h.base, other), next).manifest;
  recheckCreateQuarantine(p.h.base, old, nextFleet);
  if (scenario !== "admission") {
    const providerMatch = { id: 123, name: pending.name, tags: [] };
    if (scenario === "nonterminal sighting") fs.writeFileSync(p.hosts + ".census-next", JSON.stringify(providerMatch));
    if (scenario === "count-mismatch sighting") fs.writeFileSync(p.hosts + ".census-first", JSON.stringify({
      droplets: [{ ...providerMatch, name: "renamed", tags: [pending.tag] }, { id: 124, tags: null }], meta: { total: 3 },
    }));
    if (external) fs.writeFileSync(p.hosts + ".census-first", JSON.stringify({
      droplets: [{ id: Number(stopped.id), name: stopped.name, tags: [stopped.tag] }, providerMatch], meta: { total: 2 },
    }));
    if (scenario === "malformed name sighting" || scenario === "malformed tags sighting") {
      const match = scenario === "malformed name sighting"
        ? { ...providerMatch, name: null, tags: [pending.tag] } : { ...providerMatch, tags: null };
      fs.writeFileSync(p.hosts + ".census-first", JSON.stringify({ droplets: [match], meta: { total: 1 } }));
    }
    if (scenario === "oversized array sighting" || scenario === "oversized tags sighting") {
      const rows = scenario === "oversized array sighting"
        ? [...Array.from({ length: 200 }, (_, i) => ({ id: i + 1000, name: "other", tags: [] })), providerMatch]
        : [{ ...providerMatch, name: "renamed", tags: [...Array(256).fill("other"), pending.tag] }];
      fs.writeFileSync(p.hosts + ".census-first", JSON.stringify({ droplets: rows, meta: { total: rows.length } }));
    }
    if (scenario === "incomplete absence" || scenario === "malformed absence")
      fs.writeFileSync(p.hosts + ".census-first", JSON.stringify({
        droplets: [{ id: 123, name: "unrelated", tags: scenario === "malformed absence" ? null : [] }],
        meta: { total: scenario === "malformed absence" ? 1 : 2 },
      }));
    if (mixed) {
      assert.deepEqual(p.output.at(-1).subject.continuation.postedCreates.map(({ dropletId }) => dropletId), ["123"]);
      fs.writeFileSync(p.hosts + ".census-first", JSON.stringify({
        droplets: [{ id: 123, name: "renamed", tags: [] }], meta: { total: 1 },
      }));
    }
    if (scenario === "witnessed census") fs.writeFileSync(p.hosts, JSON.stringify([providerMatch]));
    if (["absent census", "capacity"].includes(scenario)) {
      fs.writeFileSync(p.hosts, JSON.stringify([{ id: 123, name: "unrelated", tags: [] }]));
      if (scenario === "capacity") fs.writeFileSync(p.hosts + ".limit", "1");
    }
    const approved = p.output.at(-1).approvalSha256;
    const code = await fleetMain([...args(next, other), "--detach", "--approve-reviewed-merged-ready", approved], p.deps);
    const events = p.events();
    const state = p.saved(path.join(other, other));
    const firstPost = events.findIndex((row) => row.method === "POST");
    const preCreate = firstPost === -1 ? events : events.slice(0, firstPost);
    const census = preCreate.filter((row) => row.method === "GET" && row.path.startsWith("/v2/droplets?"));
    assert.deepEqual(census.map((row) => row.path), ["/v2/droplets?page=1&per_page=200"], "no second inventory, later page or retake");
    const provider = events.filter((row) => row.boundary === "provider"), at = provider.indexOf(census[0]);
    assert.deepEqual([provider[at - 1]?.path, provider[at + 1]?.path], ["/v2/account", "/v2/account"], "the response is account-bracketed");
    if (scenario === "absent census") {
      assert.equal(code, 3);
      assert.ok(state.createIntentAt);
      assert.equal(events.filter((row) => row.method === "POST" && row.group === other).length, 1);
      assert.equal(treeHash(slot), sealed);
      return;
    }
    assert.equal(code, 2);
    assert.ok(!events.some((row) => row.method === "POST" || row.method === "DELETE"));
    assert.equal(state.createIntentAt, undefined, "no create intent");
    const witness = path.join(slot, "receipts", "create-quarantine-witness.json");
    if (!scenario.endsWith(" sighting") && scenario !== "witnessed census") {
      assert.ok(!fs.existsSync(witness));
      const refusal = mixed ? "historical host is listed" : scenario === "capacity" ? "account capacity unavailable" : "pre-create census incomplete";
      assert.ok(p.refusals().flat().some((line) => line.includes(refusal)));
    }
    else {
      assert.deepEqual(JSON.parse(fs.readFileSync(witness)), { schema: "benchmark-create-quarantine-witness/v1", quarantineSha256: old.sha256, dropletId: "123" });
      if (scenario === "nonterminal sighting") fs.unlinkSync(p.hosts + ".census-next");
      if (scenario.endsWith(" sighting") && scenario !== "nonterminal sighting") fs.unlinkSync(p.hosts + ".census-first");
      fs.writeFileSync(p.hosts, JSON.stringify([{ ...providerMatch, name: "renamed", tags: [] }]));
      await assert.rejects(prepare("r22", "recoverable-live"), /witnessed in provider inventory/);
      assert.ok(!fs.existsSync(path.join(p.h.base, "recoverable-live")));
      assert.deepEqual(p.events(), events, "the witness refuses admission before any new provider command");
      const { report: after } = await inspectContinuation(p.h.base, p.deps);
      assert.deepEqual(after.eligibleToRun, []);
      const blocked = after.groups.find((row) => row.group === group);
      assert.deepEqual([blocked.outcome, blocked.attempts.at(-1).outcome], ["blocked", "quarantined-create-witnessed"]);
      assert.deepEqual(after.groups.find((row) => row.group === "catalog-page"), report.groups.find((row) => row.group === "catalog-page"));
      if (scenario === "witnessed census") {
        const bytes = fs.readFileSync(witness);
        fs.writeFileSync(witness, JSON.stringify({ ...JSON.parse(bytes), dropletId: "WITNESSCANARY" }));
        await assert.rejects(inspectContinuation(p.h.base, p.deps), (error) =>
          error.message === "create quarantine witness differs" && !String(error).includes("CANARY"));
        await assert.rejects(prepare("r22", "recoverable-live"), /witnessed in provider inventory/);
        fs.writeFileSync(witness, bytes);
      }
      assert.equal(fileHash(path.join(local, "state.json")), binding.stateSha256);
      assert.ok(!p.events().some((row) => row.method === "POST" || row.method === "DELETE"));
    }
    return;
  }
  assert.throws(() => recheckCreateQuarantine(p.h.base, old, fleet), /only other groups/);
  assert.throws(() => recheckCreateQuarantine(p.h.base, old, { ...nextFleet, provider: { accountId: "user:elsewhere" } }), /saved account/);
  const census = (rows) => checkQuarantineCensus(p.h.base, [old], nextFleet, rows);
  census([]);
  census([{ id: 123, name: "unrelated", tags: ["production"] }]);
  assert.ok(!JSON.stringify(old).includes(pending.tag), "the next approval need not carry the old provider tag");
  census([{ id: 123, name: "unrelated" }]);
  assert.throws(() => census([{ id: 123, name: "unrelated", tags: [null] }]), /invalid create quarantine census rows/);
  assert.equal(treeHash(slot), sealed);
  assert.equal(p.events().filter((row) => row.method === "POST").length, 0);
  fs.writeFileSync(record, JSON.stringify({ ...proof, binding: { ...binding, stateSha256: "a".repeat(64) } }));
  assert.throws(() => recheckCreateQuarantine(p.h.base, old, nextFleet), /quarantine binding differs/);
  await assert.rejects(prepare("r22", other), /quarantine binding differs/);
  fs.writeFileSync(record, JSON.stringify(proof));
  assert.throws(() => census([{ id: 123, name: "renamed", tags: [pending.tag] }]), /witnessed in provider inventory/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(slot, "receipts", "create-quarantine-witness.json"))), {
    schema: "benchmark-create-quarantine-witness/v1", quarantineSha256: old.sha256, dropletId: "123",
  });
  assert.equal(fileHash(path.join(local, "state.json")), binding.stateSha256);
  // Even if later inventory is empty or has a different name and tags, a new
  // prepare and the locked gate cannot reinterpret the original as unwitnessed.
  await assert.rejects(prepare("r22", other), /witnessed in provider inventory/);
  assert.throws(() => recheckCreateQuarantine(p.h.base, old, nextFleet), /witnessed in provider inventory/);
});
}

test("continuation retries past a create that errored after its launch deadline once the operator released its custody and the child recheck settled it", { timeout: 60000 }, async (t) => {
  const p = fixture(t), group = "json-api", slot = path.join(p.h.base, group);
  fs.writeFileSync(path.join(p.h.base, "index.json"), "[]");
  p.deps.inspect = () => { assert.fail("there is no collected evidence to replay"); };
  const args = (round) => [round, "--continuation-root", p.h.base, "--group", group];
  const prepare = (round, failures) => fleetMain([...args(round), "--prepare", "--commit", commit,
    "--ssh-key", "42", "--account-id", accountId, "--context", context], p.deps, failures);
  assert.equal(await prepare("r19"), 3);
  assert.equal(await fleetMain([...args("r19"), "--detach", "--print-approval"], p.deps), 3);
  const approval = p.output.at(-1).approvalSha256, fleet = readFleet(slot, "r19").manifest;
  const stateRoot = path.join(slot, group), local = path.join(stateRoot, "groups-r19"), at = new Date().toISOString();
  const ids = { dropletId: "123", actionId: "456" }, statePath = path.join(local, "state.json"), receipt = path.join(local, createErroredReceipt);
  const launchLock = path.join(stateRoot, ".groups-launch.lock"), operationLock = path.join(local, "operation.lock");
  const pending = { ...reservation({ round: "r19", commit, token: fleet.jobs[0].token, group, fleet }), provider: fleet.provider,
    fullGroupQualified: false, status: "creating", createIntentAt: at, createPending: ids };
  // The launch reached its create deadline with the action still in progress. Its
  // process has since exited: the child locks are its exact records naming a dead owner.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  p.deps.main = async () => {
    fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(pending));
    fs.writeFileSync(launchLock, `${JSON.stringify({ pid: dead, round: "r19" })}\n`);
    fs.writeFileSync(operationLock, `${JSON.stringify({ pid: dead, at })}\n`);
    throw Object.assign(new Error("PRIVATE_MESSAGE"), { controlUncertain: true, providerDiagnostic: { code: "create-action-pending" } });
  };
  assert.equal(await fleetMain([...args("r19"), "--detach", "--approve-reviewed-merged-ready", approval], p.deps), 2);
  assert.deepEqual(p.output.at(-1).groups.map(({ outcome, uncertain }) => [outcome, uncertain]), [["error", true]]);
  delete p.deps.main;
  // The launch process has since exited: its retained batch lock names a dead owner.
  const batch = path.join(slot, ".fleet-operation.lock");
  fs.writeFileSync(batch, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(batch)), pid: dead })}\n`);
  const outer = path.join(p.h.base, continuationLock);
  assert.ok(fs.existsSync(outer)); await assert.rejects(prepare("r20"), /EEXIST/);
  // The child's own --collect, read-only on the saved account, with the real controller.
  let action = "in-progress";
  const providerReads = [];
  const child = () => controller({ round: "r19", stateDir: stateRoot, collect: true }, { repo: p.deps.repo, sleep: async () => {}, run(binary, argv) {
    assert.equal(binary, "doctl"); assert.deepEqual(argv.slice(-2), ["--context", context]);
    const command = argv.slice(0, -2); providerReads.push(command[0] === "account" ? "account" : command[1] === "action" ? "action" : command[2]);
    const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (command[0] === "account") return ok({ uuid: userId, droplet_limit: 20 });
    if (command[1] === "action") return ok([{ id: 456, type: "create", resource_type: "droplet", resource_id: action === "errored" ? 123 : null, status: action }]);
    if (command[2] === "get") return { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } };
    assert.deepEqual(command, ["compute", "droplet", "list", "--single-response", "--output", "json"]); return ok([]);
  } }).collect();
  // A dead PID in the child's lock records is not proof that the launch's process tree
  // settled: the child refuses before any provider read and leaves its locks.
  await assert.rejects(child(), /original launch custody retained/);
  assert.deepEqual(providerReads, []); assert.ok([launchLock, operationLock].every((lock) => fs.existsSync(lock)));
  // The operator's custody step for the child: its controller, provider worker and their
  // descendants are accounted for and gone; then its launch and operation locks are released.
  fs.unlinkSync(launchLock); fs.unlinkSync(operationLock);
  assert.equal(await child(), 3, "still running: nothing changes");
  assert.ok(![launchLock, operationLock].some((lock) => fs.existsSync(lock))); assert.equal(JSON.parse(fs.readFileSync(statePath)).createErrored, undefined);
  action = "errored";
  assert.equal(await child(), 1);
  assert.deepEqual(providerReads.slice(-9), ["account", "action", "account", "account", "get", "account", "account", "list", "account"]);
  const resolved = JSON.parse(fs.readFileSync(statePath)), record = fs.readFileSync(receipt, "utf8");
  assert.deepEqual(resolved.createErrored, { ...ids, evidenceSha256: digest(record) });
  assert.ok(![launchLock, operationLock, path.join(local, "create-recheck.lock")].some((lock) => fs.existsSync(lock)), "no child lock is left");
  // The child recheck settles only the child. The outer continuation lock and the dead
  // batch lock stay; continuation remains closed until the operator's custody step.
  assert.ok(fs.existsSync(outer) && fs.existsSync(batch)); await assert.rejects(prepare("r20"), /EEXIST/);
  // A lock that appears after admission's scan refuses at its final recheck.
  const admission = await continuationAdmission(p.h.base, group, { repo: p.deps.repo, inspect: p.deps.inspect });
  admission.recheck();
  for (const lock of [launchLock, operationLock, path.join(local, "create-recheck.lock")]) {
    fs.writeFileSync(lock, "SYNTHETIC");
    assert.throws(() => admission.recheck(), /custody changed/, path.basename(lock));
    fs.unlinkSync(lock);
  }
  admission.recheck();
  // The operator's documented custody step: the outer lock names this group, its
  // owner and process tree are accounted for and gone; keep its bytes, then release it.
  assert.equal(JSON.parse(fs.readFileSync(outer)).group, group);
  fs.unlinkSync(outer);
  fs.writeFileSync(receipt, record.replace('"droplets": 0', '"droplets": 4'));
  const failures = new Map();
  await assert.rejects(prepare("r20", failures), (error) => /unresolved custody: selected provider-errored create/.test(error.message)
    && failures.get(error) === "continuation-admission; custody-replay", "a changed receipt is not resolved");
  fs.writeFileSync(receipt, record);
  let { report } = await inspectContinuation(p.h.base, p.deps);
  assert.deepEqual(report.groups.find((r) => r.group === group).attempts.map((r) => [r.round, r.outcome]), [["r19", "create-errored"]]);
  assert.ok(report.eligibleToRun.includes(group));
  const tree = treeHash(slot);
  assert.equal(await prepare("r20"), 3);
  ({ report } = await inspectContinuation(p.h.base, p.deps));
  assert.deepEqual(report.groups.find((r) => r.group === group).attempts.map((r) => [r.round, r.outcome]), [["r19", "create-errored"], ["r20", "prepared"]]);
  assert.equal(treeHash(slot), tree, "the resolved attempt is never rewritten");
  assert.deepEqual(p.events().filter((row) => row.method === "POST"), []);
  // Review round 2, finding 2. The successor's real child rechecks the old attempt
  // immediately before its create. Here the old attempt takes its operation lock during
  // the create's own account check, after the new launch intent: no POST is sent.
  assert.equal(await fleetMain([...args("r20"), "--detach", "--print-approval"], p.deps), 3);
  const retryApproval = p.output.at(-1).approvalSha256;
  fs.writeFileSync(`${p.hosts}.late-lock`, operationLock);
  assert.equal(await fleetMain([...args("r20"), "--detach", "--approve-reviewed-merged-ready", retryApproval], p.deps), 2);
  assert.deepEqual(p.output.at(-1).groups.map(({ group: name, outcome }) => [name, outcome]), [[group, "error"]]);
  assert.ok(fs.existsSync(path.join(p.h.base, `${group}--r20`, "launch-intent.json")), "the refusal came after the new launch intent");
  assert.ok(fs.existsSync(operationLock), "the old attempt's lock is left alone");
  assert.deepEqual(p.events().filter((row) => row.method === "POST"), []);
  const retry = JSON.parse(fs.readFileSync(path.join(p.h.base, `${group}--r20`, group, "groups-r20", "state.json")));
  assert.equal(retry.createIntentAt, undefined); assert.notEqual(retry.status, "creating");
});

// Review round 3: the same persisted continuation. A json-api launch, optionally an
// --offline-handoff one, stopped at its create deadline with the POST's IDs. The child
// state is the one the launch saves before its create; the launch's process tree has
// since been accounted for by the operator's custody step for the child locks.
async function lateCreateAttempt(t, { offline = false, p = fixture(t) } = {}) {
  const group = "json-api", slot = path.join(p.h.base, group);
  fs.writeFileSync(path.join(p.h.base, "index.json"), "[]");
  p.deps.inspect = () => { assert.fail("there is no collected evidence to replay"); };
  const args = (round) => [round, "--continuation-root", p.h.base, "--group", group];
  const prepare = (round) => fleetMain([...args(round), "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId,
    "--context", context, ...(offline && round === "r19" ? ["--offline-handoff"] : [])], p.deps);
  assert.equal(await prepare("r19"), 3);
  assert.equal(await fleetMain([...args("r19"), "--detach", "--print-approval"], p.deps), 3);
  const approval = p.output.at(-1).approvalSha256, fleet = readFleet(slot, "r19").manifest;
  assert.equal(fleet.single.offlineHandoff, offline ? true : undefined);
  const stateRoot = path.join(slot, group), local = path.join(stateRoot, "groups-r19"), statePath = path.join(local, "state.json");
  const locks = { launch: path.join(stateRoot, ".groups-launch.lock"), operation: path.join(local, "operation.lock"),
    batch: path.join(slot, ".fleet-operation.lock"), outer: path.join(p.h.base, continuationLock) };
  const pending = { ...reservation({ round: "r19", commit, token: fleet.jobs[0].token, group, fleet }), provider: fleet.provider,
    fullGroupQualified: false, benchPackage: true, gitSource: true, quietBootstrap: "prelogin",
    control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [],
      ...(offline ? {} : { monitor: { schema: "benchmark-supervised-control/v1", id: "c".repeat(32), phase: "pending" } }) },
    status: "creating", createIntentAt: new Date().toISOString(), createPending: { dropletId: "123", actionId: "456" } };
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  p.deps.main = async () => {
    fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(pending));
    fs.writeFileSync(locks.launch, `${JSON.stringify({ pid: dead, round: "r19" })}\n`);
    fs.writeFileSync(locks.operation, `${JSON.stringify({ pid: dead, at: pending.createIntentAt })}\n`);
    throw Object.assign(new Error("PRIVATE_MESSAGE"), { controlUncertain: true, providerDiagnostic: { code: "create-action-pending" } });
  };
  assert.equal(await fleetMain([...args("r19"), "--detach", "--approve-reviewed-merged-ready", approval], p.deps), 2);
  delete p.deps.main;
  fs.writeFileSync(locks.batch, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(locks.batch)), pid: dead })}\n`);
  fs.unlinkSync(locks.launch); fs.unlinkSync(locks.operation); // The custody step for the child.
  // The child's own collect with the real controller and a synthetic provider on the saved account.
  const provider = { action: "errored", droplets: [], reads: [], deletes: 0 };
  const owned = () => { const s = JSON.parse(fs.readFileSync(statePath)); return { id: 123, name: s.name, tags: [...tags, s.tag],
    size_slug: s.host.size, region: { slug: s.host.region }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } }; };
  const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  const run = (binary, argv) => {
    if (binary === "ssh") {
      provider.reads.push("ssh"); const s = JSON.parse(fs.readFileSync(statePath));
      assert.ok(argv.includes("StrictHostKeyChecking=yes") && argv.at(-1) === unusedHostScript(s, { bootstrap: true }), "only the pinned unused proof");
      return ok({ schema: "benchmark-unused-host/v1", hostId: s.id, unit: s.unit, unused: true, observedAtMs: Date.now() });
    }
    if (binary === "git") return p.h.run(binary, argv, 60000);
    assert.equal(binary, "doctl"); assert.deepEqual(argv.slice(-2), ["--context", context]);
    const command = argv.slice(0, -2);
    provider.reads.push(command[0] === "account" ? "account" : command[1] === "action" ? "action" : command[2]);
    if (command[0] === "account") return ok({ uuid: userId, droplet_limit: 20 });
    if (command[1] === "action") return ok([{ id: 456, type: "create", resource_type: "droplet", resource_id: 123, status: provider.action }]);
    if (command[2] === "get") {
      const rows = provider.droplets.filter(({ id }) => String(id) === command[3]);
      return rows.length ? ok(rows) : { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } };
    }
    if (command[2] === "list") return ok(provider.droplets);
    assert.deepEqual(command, ["compute", "droplet", "delete", "123", "--force"]);
    provider.deletes++; provider.droplets = provider.droplets.filter(({ id }) => id !== 123); return ok([]);
  };
  const child = (options = {}, deps = {}) => controller({ round: "r19", stateDir: stateRoot, collect: true, ...options },
    { repo: p.deps.repo, sleep: async () => {}, run, ...deps }).collect();
  return { p, group, slot, args, prepare, stateRoot, local, statePath, locks, provider, owned, child,
    posts: () => p.events().filter(({ boundary, method }) => boundary === "provider" && method === "POST") };
}

// Review round 3, finding 1. The previous controller refused the witnessing collect but
// left the receipt acceptable, and the successor's census fenced only setup-recovery IDs:
// its real worker sent a POST with droplet 123 still in the inventory.
for (const change of ["witnessed before approval", "witnessed with a stale approval", "renamed posted droplet in the census", "witnessed with a failed publication and a stale approval"]) {
  test(`a continuation successor sends no create when its earlier provider-errored attempt's droplet is ${change}`, { timeout: 60000 }, async (t) => {
    const a = await lateCreateAttempt(t);
    assert.equal(await a.child(), 1, "the errored action and absence settle the attempt");
    const resolved = JSON.parse(fs.readFileSync(a.statePath));
    assert.ok(resolved.createErrored && !resolved.createErrored.reappeared);
    fs.unlinkSync(a.locks.outer); // The documented custody step for the outer continuation lock.
    assert.equal(await a.prepare("r20"), 3);
    assert.equal(await fleetMain([...a.args("r20"), "--detach", "--print-approval"], a.p.deps), 3);
    const stale = a.p.output.at(-1).approvalSha256;
    assert.deepEqual(a.p.output.at(-1).subject.continuation.createFailures.map(({ dropletId, accountId: account }) => [dropletId, account]), [["123", accountId]]);
    const renamed = { ...a.owned(), name: "renamed-by-someone", tags: [] };
    if (change === "renamed posted droplet in the census") fs.writeFileSync(a.p.hosts, JSON.stringify([renamed]));
    else if (change === "witnessed with a failed publication and a stale approval") {
      // Review round 4, finding 2: the contradiction's state rename fails. Custody stays
      // with that collect; after the custody step the gone droplet does not revive the receipt.
      a.provider.droplets = [renamed];
      const createReappearedIo = { durable, rename() { throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); } };
      await assert.rejects(a.child({}, { createReappearedIo }), { controllerStage: "create-contradiction-unpublished" });
      const lock = path.join(a.stateRoot, "groups-r19", "operation.lock");
      assert.ok(fs.existsSync(lock)); assert.equal(JSON.parse(fs.readFileSync(a.statePath)).createErrored.reappeared, undefined);
      fs.unlinkSync(lock); // The custody step for that collect.
      a.provider.droplets = [];
      await assert.rejects(a.child(), /observed again/);
    } else {
      // The old attempt's collect sees ID 123 again and refuses; the droplet is gone again afterwards.
      a.provider.droplets = [renamed];
      await assert.rejects(a.child(), /observed again/);
      assert.equal(JSON.parse(fs.readFileSync(a.statePath)).createErrored.reappeared.dropletId, "123");
      a.provider.droplets = [];
      await assert.rejects(a.child(), /observed again/);
    }
    let approval = stale;
    if (change === "witnessed before approval") {
      // A fresh approval refuses to admit the contradicted attempt.
      const before = a.p.output.length;
      const printed = await fleetMain([...a.args("r20"), "--detach", "--print-approval"], a.p.deps).catch((error) => error);
      assert.ok(printed !== 3 && !a.p.output.slice(before).some((row) => row.approvalSha256), "no approval for a contradicted attempt");
    }
    const code = await fleetMain([...a.args("r20"), "--detach", "--approve-reviewed-merged-ready", approval], a.p.deps).catch((error) => error);
    assert.notEqual(code, 3);
    assert.deepEqual(a.posts(), [], "no POST from the successor");
    const retry = path.join(a.p.h.base, `${a.group}--r20`, a.group, "groups-r20", "state.json");
    if (fs.existsSync(retry)) assert.equal(JSON.parse(fs.readFileSync(retry)).createIntentAt, undefined, "no create intent");
    assert.equal(a.provider.deletes, 0);
  });
}

// Review round 3, findings 2 and 3, on an actual --offline-handoff child. The previous
// controller refused the errored-but-present allocation before binding, and refused the
// bound never-started child at the regular offline gate with no other admitted route.
for (const action of ["completed", "errored"]) {
  test(`an offline-handoff child whose late ${action} create left its exact droplet binds it, then retires only by the approved pinned unused proof`, { timeout: 60000 }, async (t) => {
    const a = await lateCreateAttempt(t, { offline: true });
    const reserved = JSON.parse(fs.readFileSync(a.statePath));
    assert.equal(reserved.fleet.single.offlineHandoff, true); assert.equal(reserved.control.monitor, undefined);
    a.provider.action = action; a.provider.droplets = [a.owned()];
    assert.equal(await a.child(), 3);
    const bound = JSON.parse(fs.readFileSync(a.statePath));
    assert.equal(bound.status, "preparing"); assert.equal(bound.id, "123"); assert.deepEqual(bound.control.ledger, []);
    assert.ok(!a.provider.reads.includes("ssh") && !a.provider.reads.includes("delete"));
    // Regular collection keeps the offline handoff gate and names the approved route, also
    // through the CLI formatter, which prints only allowlisted stages (review round 4, finding 4).
    await assert.rejects(a.child(), (error) => {
      assert.match(error.message, /offline handoff never started: .*--unused-bootstrap-known-hosts/);
      assert.equal(error.controllerStage, "offline-never-started");
      assert.match(publicError(error), /--collect --unused-bootstrap-known-hosts/); return true;
    });
    const key = path.join(a.p.h.temp, "operator-verified-host-key"), keyBytes = "synthetic operator-verified host key\n";
    fs.writeFileSync(key, keyBytes);
    const gitRun = (binary, argv, timeout = 60000, allowFail) => {
      assert.equal(binary, "git");
      return argv[0] === "show" ? { status: 0, stdout: fs.readFileSync(path.resolve(argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n") }
        : a.p.h.run(binary, argv, timeout, allowFail);
    };
    const plan = await productionPlan({ round: "r19", stateDir: a.stateRoot, collect: true, unusedBootstrapKnownHosts: key }, { repo: a.p.deps.repo, run: gitRun });
    assert.deepEqual(plan.missing, []);
    assert.deepEqual(plan.subject.recovery, { measuredCommit: commit, hostId: "123", ip: "192.0.2.10", knownHostsSha256: digest(keyBytes),
      policy: "offline-never-started-posted-create-unused-only-no-qualification" });
    const pinned = () => a.child({ unusedBootstrapKnownHosts: key }, { unusedBootstrapApproval: { reservationSha256: plan.subject.reservationSha256,
      knownHostsSha256: plan.subject.recovery.knownHostsSha256 } });
    // The launch's retained batch and outer continuation locks are custody too.
    await assert.rejects(pinned(), /original launch custody remains/);
    fs.unlinkSync(a.locks.batch);
    await assert.rejects(pinned(), /continuation custody remains/);
    fs.unlinkSync(a.locks.outer);
    assert.equal(a.provider.deletes, 0);
    assert.equal(await pinned(), 1);
    const retired = JSON.parse(fs.readFileSync(a.statePath));
    assert.equal(retired.status, "retired"); assert.equal(retired.retirement.kind, "unused"); assert.ok(retired.destroyedAt);
    assert.deepEqual(retired.control.ledger, []); assert.equal(a.provider.deletes, 1);
    assert.equal(a.provider.reads.filter((read) => read === "ssh").length, 1, "one fresh pinned unused proof");
    assert.deepEqual(a.posts(), []);
  });
}

test("the offline never-started route needs the exact bound posted create and an empty ledger", { timeout: 60000 }, async (t) => {
  const a = await lateCreateAttempt(t, { offline: true });
  a.provider.action = "completed"; a.provider.droplets = [a.owned()];
  assert.equal(await a.child(), 3);
  const original = fs.readFileSync(a.statePath, "utf8"), bound = JSON.parse(original);
  assert.ok(offlineNeverStarted(bound));
  const ledgerRow = { request: controlRequest(bound, "ssh", ["true"], 30000, "bootstrap", []), localTerminal: false };
  for (const change of [(s) => { delete s.createPending; }, (s) => { s.control.ledger.push(ledgerRow); },
    (s) => { s.launchHostKeySha256 = "a".repeat(64); }, (s) => { delete s.fleet.single.offlineHandoff; s.control.monitor = { schema: "benchmark-supervised-control/v1", id: "c".repeat(32), phase: "pending" }; }]) {
    const s = JSON.parse(original); change(s);
    assert.equal(offlineNeverStarted(s), false);
  }
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

test("prepare CLI distinguishes provider startup, catalog validation and disconnect during the catalog read", { timeout: 15000 }, async (t) => {
  for (const [mode, diagnostic] of [
    ["startup-refusal", "first-account-read-or-worker-start; transport-close-failed; custody-uncertain"],
    ["catalog-shape", "catalog-validation; catalog-response"],
    ["catalog-disconnect", "catalog-read; transport-close-failed; custody-uncertain"],
  ]) await t.test(mode, async (t) => {
    const p = fixture(t), exitCode = realCatalog(p, mode), errors = [];
    const disconnected = mode !== "catalog-shape";
    assert.equal(await fleetCli(p.prepareArgs, { ...p.deps, writeError: (line) => errors.push(line) }), 2);
    assert.deepEqual(errors, [`fleet-placement-preflight-failed: ${diagnostic}`]);
    assert.equal(exitCode(), disconnected ? 2 : 0);
    assert.deepEqual(fs.readdirSync(p.h.base), disconnected ? [".fleet-operation.lock"] : []);
    assert.deepEqual(p.events().filter((row) => row.boundary === "provider").map((row) => [row.method, row.path]),
      mode === "startup-refusal" ? [] : [["GET", "/v2/account"], ["GET", "/v2/sizes?page=1&per_page=200"]]);
    if (mode === "startup-refusal") {
      assert.ok(p.events().some((row) => row.boundary === "before-provider-boot"));
      assert.ok(!p.events().some((row) => row.boundary === "synthetic-credential"));
    }
    assert.equal(p.workers.length, 0);
  });
});

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

// Review round 4, finding 5 (benchmark lane). Only the selected group's earlier
// provider-errored attempts were fenced: another group's launch sent a POST with
// json-api's posted droplet 123 still in the census, renamed and untagged.
for (const listed of [true, false]) {
  test(`another group's launch ${listed ? "sends no create while" : "proceeds when"} an earlier provider-errored attempt's posted ID is ${listed ? "listed, renamed and untagged" : "absent"}`, { timeout: 60000 }, async (t) => {
    const a = await lateCreateAttempt(t);
    assert.equal(await a.child(), 1, "the errored action and absence settle the attempt");
    fs.unlinkSync(a.locks.outer); // The documented custody step for the outer continuation lock.
    const other = groupNames.find((group) => group !== a.group);
    const args = (round) => [round, "--continuation-root", a.p.h.base, "--group", other];
    assert.equal(await fleetMain([...args("r20"), "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context], a.p.deps), 3);
    assert.equal(await fleetMain([...args("r20"), "--detach", "--print-approval"], a.p.deps), 3);
    const approval = a.p.output.at(-1).approvalSha256;
    // Each earlier posted create is snapshotted for the final pre-POST recheck (review round 6, finding 3).
    assert.deepEqual(a.p.output.at(-1).subject.continuation.postedCreates, [{ root: a.slot, round: "r19", group: a.group,
      manifestSha256: fileHash(path.join(a.slot, "fleet-r19.json")), stateSha256: fileHash(a.statePath), outcome: "available", contradicted: false,
      accountId, dropletId: "123" }]);
    if (listed) fs.writeFileSync(a.p.hosts, JSON.stringify([{ ...a.owned(), name: "renamed-by-someone", tags: [] }]));
    const code = await fleetMain([...args("r20"), "--detach", "--approve-reviewed-merged-ready", approval], a.p.deps).catch((error) => error);
    if (listed) {
      assert.notEqual(code, 3);
      assert.deepEqual(a.posts(), [], "no POST from the other group");
      const state = path.join(a.p.h.base, other, other, "groups-r20", "state.json");
      if (fs.existsSync(state)) assert.equal(JSON.parse(fs.readFileSync(state)).createIntentAt, undefined, "no create intent");
    } else assert.equal(a.posts().length, 1, "the other group creates its own host");
    assert.equal(a.provider.deletes, 0);
  });
}

// Review round 6, finding 3. Only the selected group's earlier attempts were rechecked at the
// final gate: a contradiction of json-api's settled attempt recorded after the other group's
// census (here during the account read that opens its create) still let it record create intent and POST.
// Review round 7, finding 1: a create-recheck or launch lock taken in that attempt at the same
// point also still let it POST; the gate saw only its operation lock.
const postedRefusal = /an earlier provider-errored create on this account changed, took custody or was contradicted before this create/;
for (const late of ["provider-create-reappeared", "create-recheck.lock", ".groups-launch.lock", null]) {
  test(`another group's create ${late ? `is refused when ${late} is written in` : "proceeds beside"} an earlier provider-errored attempt after its census`, { timeout: 60000 }, async (t) => {
    const a = await lateCreateAttempt(t);
    assert.equal(await a.child(), 1, "the errored action and absence settle the attempt");
    fs.unlinkSync(a.locks.outer); // The documented custody step for the outer continuation lock.
    const other = groupNames.find((group) => group !== a.group);
    const args = (round) => [round, "--continuation-root", a.p.h.base, "--group", other];
    assert.equal(await fleetMain([...args("r20"), "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context], a.p.deps), 3);
    assert.equal(await fleetMain([...args("r20"), "--detach", "--print-approval"], a.p.deps), 3);
    const approval = a.p.output.at(-1).approvalSha256;
    const marker = late && path.join(late === ".groups-launch.lock" ? a.stateRoot : a.local, late);
    if (late) fs.writeFileSync(a.p.hosts + ".late-lock", marker);
    const code = await fleetMain([...args("r20"), "--detach", "--approve-reviewed-merged-ready", approval], a.p.deps).catch((error) => error);
    if (late) {
      assert.ok(fs.existsSync(marker), "the marker was written during the create's account read");
      assert.notEqual(code, 3);
      assert.deepEqual(a.posts(), [], "no POST from the other group");
      const state = path.join(a.p.h.base, other, other, "groups-r20", "state.json");
      if (fs.existsSync(state)) assert.equal(JSON.parse(fs.readFileSync(state)).createIntentAt, undefined, "no create intent");
      // Refused by the cross-group final gate, not by an unrelated failure.
      assert.deepEqual(a.p.output.at(-1).groups.map(({ group, outcome, controllerStage }) => [group, outcome, controllerStage]),
        [[other, "error", "controller-launch"]]);
      const refusals = a.p.refusals();
      assert.equal(refusals.length, 1, JSON.stringify(refusals));
      assert.match(refusals[0][0], postedRefusal);
      if (late !== "provider-create-reappeared") assert.match(refusals[0][1], /provider-errored create still holds custody/);
    } else {
      assert.equal(a.posts().length, 1, "the other group creates its own host");
      // What happens after the POST is outside this test; the cross-group gate did not refuse.
      assert.ok(!a.p.refusals().flat().some((message) => postedRefusal.test(message)), JSON.stringify(a.p.refusals()));
    }
    assert.equal(a.provider.deletes, 0);
  });
}

// Review round 6, finding 4. A contradicted attempt retired by the pinned route lost its
// createErrored record, and with it its place in the posted-ID census fence.
async function retiredContradictedAttempt(t) {
  const a = await lateCreateAttempt(t, { offline: true });
  assert.equal(await a.child(), 1, "the errored action and absence settle the attempt");
  a.provider.droplets = [a.owned()];
  assert.equal(await a.child(), 3, "the reappeared posted droplet is bound as contradicted");
  assert.ok(JSON.parse(fs.readFileSync(a.statePath)).createContradicted);
  const key = path.join(a.p.h.temp, "operator-verified-host-key"), keyBytes = "synthetic operator-verified host key\n";
  fs.writeFileSync(key, keyBytes);
  const gitRun = (binary, argv, timeout = 60000, allowFail) => {
    assert.equal(binary, "git");
    return argv[0] === "show" ? { status: 0, stdout: fs.readFileSync(path.resolve(argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n") }
      : a.p.h.run(binary, argv, timeout, allowFail);
  };
  const plan = await productionPlan({ round: "r19", stateDir: a.stateRoot, collect: true, unusedBootstrapKnownHosts: key }, { repo: a.p.deps.repo, run: gitRun });
  assert.equal(plan.subject.recovery.policy, "contradicted-create-posted-droplet-unused-only-no-qualification");
  fs.unlinkSync(a.locks.batch); fs.unlinkSync(a.locks.outer); // The custody steps for the launch's retained locks.
  assert.equal(await a.child({ unusedBootstrapKnownHosts: key }, { unusedBootstrapApproval: { reservationSha256: plan.subject.reservationSha256,
    knownHostsSha256: plan.subject.recovery.knownHostsSha256 } }), 1);
  const retired = JSON.parse(fs.readFileSync(a.statePath));
  assert.ok(retired.destroyedAt && retired.createContradicted && !retired.createErrored); assert.equal(a.provider.deletes, 1);
  return a;
}
for (const listed of [true, false]) {
  test(`another group's launch ${listed ? "still fences" : "proceeds beside"} a retired contradicted attempt's posted ID ${listed ? "listed, renamed and untagged" : "that is absent"}`, { timeout: 90000 }, async (t) => {
    const a = await retiredContradictedAttempt(t);
    const other = groupNames.find((group) => group !== a.group);
    const args = (round) => [round, "--continuation-root", a.p.h.base, "--group", other];
    assert.equal(await fleetMain([...args("r20"), "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context], a.p.deps), 3);
    assert.equal(await fleetMain([...args("r20"), "--detach", "--print-approval"], a.p.deps), 3);
    const approval = a.p.output.at(-1).approvalSha256;
    assert.deepEqual(a.p.output.at(-1).subject.continuation.postedCreates.map(({ accountId: account, dropletId, contradicted }) => [account, dropletId, contradicted]),
      [[accountId, "123", true]]);
    if (listed) fs.writeFileSync(a.p.hosts, JSON.stringify([{ ...a.owned(), name: "renamed-by-someone", tags: [] }]));
    const code = await fleetMain([...args("r20"), "--detach", "--approve-reviewed-merged-ready", approval], a.p.deps).catch((error) => error);
    if (listed) {
      assert.notEqual(code, 3);
      assert.deepEqual(a.posts(), [], "no POST from the other group");
      const state = path.join(a.p.h.base, other, other, "groups-r20", "state.json");
      if (fs.existsSync(state)) assert.equal(JSON.parse(fs.readFileSync(state)).createIntentAt, undefined, "no create intent");
    } else assert.equal(a.posts().length, 1, "the other group creates its own host");
    assert.equal(a.provider.deletes, 1);
  });
}

// Issue #2019. The final gate refuses a create beside an earlier posted attempt that holds a
// launch, operation or recheck lock, retired or not, but admission accepted a retired one: the
// operator approved a launch the gate was certain to refuse. Admission now applies the gate's
// custody check to every posted attempt, so the refusal comes before the approval prompt.
for (const lock of ["launch", "operation", "recheck", null]) {
  test(`another group's admission ${lock ? `refuses before approval while a retired posted attempt holds its ${lock} lock` : "admits a retired posted attempt that holds no lock"}`, { timeout: 90000 }, async (t) => {
    const a = await retiredContradictedAttempt(t);
    const other = groupNames.find((group) => group !== a.group), otherSlot = path.join(a.p.h.base, other);
    const args = (round) => [round, "--continuation-root", a.p.h.base, "--group", other];
    const prepare = (failures) => fleetMain([...args("r20"), "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId,
      "--context", context], a.p.deps, failures);
    const preview = (failures) => fleetMain([...args("r20"), "--detach", "--print-approval"], a.p.deps, failures);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const held = lock && { launch: a.locks.launch, operation: a.locks.operation, recheck: path.join(a.local, "create-recheck.lock") }[lock];
    const take = () => fs.writeFileSync(held, `${JSON.stringify({ pid: dead, round: "r19" })}\n`);
    const refused = async (action) => {
      const failures = new Map(), before = a.p.output.length;
      await assert.rejects(action(failures), (error) => /unresolved custody: an earlier provider-errored create still holds a lock/.test(error.message)
        && /provider-errored create still holds custody/.test(error.cause?.message)
        && failures.get(error) === "continuation-admission; posted-custody");
      assert.ok(!a.p.output.slice(before).some((row) => row?.approvalSha256), "no approval prompt");
      assert.ok(fs.existsSync(held), "the lock is left alone");
      assert.ok(!fs.existsSync(path.join(otherSlot, "launch-intent.json")), "no launch intent");
      assert.ok(!fs.existsSync(path.join(otherSlot, other, "groups-r20", "state.json")), "no create intent");
      assert.ok(!fs.existsSync(path.join(a.p.h.base, continuationLock)), "admission releases the continuation lock");
      assert.deepEqual(a.posts(), [], "no POST");
    };
    if (lock) {
      // Present at prepare: no reservation is made for the other group.
      take();
      await refused(prepare);
      assert.ok(!fs.existsSync(otherSlot), "no reservation");
      // Taken after prepare: the approval prompt itself refuses.
      fs.unlinkSync(held); // Only the test's own synthetic lock; the controller never clears it.
      assert.equal(await prepare(), 3);
      take();
      await refused(preview);
    } else {
      assert.equal(await prepare(), 3);
      assert.equal(await preview(), 3);
      const approval = a.p.output.at(-1).approvalSha256;
      assert.deepEqual(a.p.output.at(-1).subject.continuation.postedCreates.map(({ dropletId, contradicted }) => [dropletId, contradicted]), [["123", true]]);
      await fleetMain([...args("r20"), "--detach", "--approve-reviewed-merged-ready", approval], a.p.deps).catch((error) => error);
      assert.equal(a.posts().length, 1, "the other group creates its own host");
    }
    assert.equal(a.provider.deletes, 1);
  });
}
