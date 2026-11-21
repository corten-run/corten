// Offline composition acceptance: real snapshot Worker -> productionMain -> controller.
// Only credential consumption and external Git/HTTPS/SSH/SCP responses are fake.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { accountId, archive, commit, context, harness, syntheticCatalogProvider, syntheticInspection, syntheticPlacement, userId } from "./cloud-fixtures.mjs";
import { digest, fileHash, treeHash } from "./cloud-local.mjs";
import { fleetMain, fleetWorkerPaths } from "./fleet.mjs";
import { bootstrapMarker, bootstrapReadScript } from "./cloud-remote.mjs";
import { providerTransport } from "./cloud-provider.mjs";
import { bootstrapWorkspaceScript, captureSshOwner, installSshIngress, savedLoadLayout, verifySshIngress } from "./cloud-contract.mjs";
import { readFleet, verifyCollectedGroup } from "./fleet-verify.mjs";
import { groupNames } from "./registry.mjs";
import { syntheticDependencies } from "./fleet-production-fixture.mjs";
import { registration } from "./test-fixtures/control-stream-fixture.mjs";

const committed = new Map(fleetWorkerPaths.map((file) => [file, fs.readFileSync(path.resolve(file), "utf8").replaceAll("\r\n", "\n")]));

function fixture(t, mode = "success") {
  t.after(() => {
    const rows = events(), starts = rows.filter((row) => row.boundary === "provider-child-start");
    const exits = rows.filter((row) => row.boundary === "provider-child-exit");
    assert.deepEqual(exits.map((row) => row.pid).sort(), starts.map((row) => row.pid).sort(), "every owned child reaped");
    assert.ok(exits.every((row) => row.terminal));
    assert.ok(!rows.some((row) => row.tokenIPC || row.boundary === "forbidden-native-https"));
  });
  const h = harness(t), output = [], workers = [];
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
      // The validator captures installed HEAD on import, even for detach. Fake
      // only that Git boundary, not the validator or its snapshot checks.
      assert.equal(source.split("readGit = spawnSync").length, 3, "review eager Git seam when validation changes");
      source = source.replaceAll("readGit = spawnSync", `readGit = () => ({ status: 0, stdout: '${commit}\\n' })`);
    }
    if (file === "bench/workloads/cloud-production.mjs") {
      // Change defaults only. The actual productionMain body, approval gates,
      // transport, controller and worker protocol remain the production code.
      const before = "spawn, streamSpawn, providerFactory = providerTransport, repo = checkout, inspect, sleep, interrupted";
      const after = "spawn = synthetic.spawn, streamSpawn = synthetic.streamSpawn, providerFactory = synthetic.providerFactory, repo = synthetic.repo, inspect, sleep = synthetic.sleep, interrupted";
      assert.equal(source.split(before).length, 2, "review fixture injection when production signature changes");
      source = source.replace(before, after) + `\nimport * as syntheticFs from 'node:fs';
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
  const deps = { repo: h.repo, spawn, WorkerClass: SnapshotWorker, write: (value) => output.push(JSON.parse(value)) };
  deps.catalogProvider = syntheticCatalogProvider(syntheticPlacement([mode === "overlap" ? "sfo2" : "sfo3"]));
  const args = ["r21", "--fleet-root", h.base];
  const saved = (group = groupNames[0]) => JSON.parse(fs.readFileSync(path.join(h.base, group, "groups-r21/state.json")));
  const events = () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

test("remaining approval moves from sfo2 to lon1 through captured workers and dispatches once", { timeout: 60000 }, async (t) => {
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
