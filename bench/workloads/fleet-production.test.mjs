// Offline composition acceptance: real snapshot Worker -> productionMain -> controller.
// Only credential consumption and external Git/HTTPS/SSH/SCP responses are fake.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { accountId, archive, commit, context, harness, syntheticInspection, userId } from "./cloud-fixtures.mjs";
import { digest, fileHash, treeHash } from "./cloud-local.mjs";
import { fleetMain, fleetWorkerPaths } from "./fleet.mjs";
import { bootstrapMarker } from "./cloud-remote.mjs";
import { readFleet, verifyCollectedGroup } from "./fleet-verify.mjs";
import { groupNames } from "./registry.mjs";
import { syntheticDependencies } from "./fleet-production-fixture.mjs";

const committed = new Map(fleetWorkerPaths.map((file) => [file, fs.readFileSync(path.resolve(file), "utf8").replaceAll("\r\n", "\n")]));

function fixture(t, mode = "success") {
  t.after(() => {
    const rows = events(), starts = rows.filter((row) => row.boundary === "provider-child-start");
    const exits = rows.filter((row) => row.boundary === "provider-child-exit");
    assert.deepEqual(exits.map((row) => row.pid), starts.map((row) => row.pid), "every owned child reaped");
    assert.ok(exits.every((row) => row.terminal));
    assert.ok(!rows.some((row) => row.tokenIPC || row.boundary === "forbidden-native-https"));
  });
  const h = harness(t), output = [], workers = [];
  const repo = path.join(h.temp, "captured"), trace = path.join(h.temp, "boundaries.jsonl"), hosts = path.join(h.temp, "provider.json");
  fs.mkdirSync(repo); fs.writeFileSync(trace, "");
  fs.mkdirSync(path.join(repo, "bench/workloads"), { recursive: true });
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
      const before = "spawn, providerFactory = providerTransport, repo = checkout, inspect, sleep, interrupted";
      const after = "spawn = synthetic.spawn, providerFactory = synthetic.providerFactory, repo = synthetic.repo, inspect, sleep = synthetic.sleep, interrupted";
      assert.equal(source.split(before).length, 2, "review fixture injection when production signature changes");
      source = source.replace(before, after) + `\nimport * as syntheticFs from 'node:fs';
import * as syntheticPath from 'node:path';
import { workerData as syntheticData } from 'node:worker_threads';
import { fork as syntheticFork } from 'node:child_process';
import { bootstrapMarker as syntheticMarker, bootstrapReadScript as syntheticRead } from './cloud-remote.mjs';
const syntheticArgs = syntheticData.args;
const syntheticGroup = syntheticArgs[syntheticArgs.indexOf('--group') + 1];
const synthetic = (${syntheticDependencies.toString()})({
  repo: ${JSON.stringify(repo)}, trace: ${JSON.stringify(trace)}, hosts: ${JSON.stringify(hosts)},
  stateDir: syntheticArgs[syntheticArgs.indexOf('--state-dir') + 1], group: syntheticGroup,
  commit: ${JSON.stringify(commit)}, userId: ${JSON.stringify(userId)}, mode: ${JSON.stringify(mode)}
}, { fs: syntheticFs, path: syntheticPath, fork: syntheticFork, providerTransport,
  bootstrapMarker: syntheticMarker, bootstrapReadScript: syntheticRead });\n`;
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
  const args = ["r21", "--fleet-root", h.base];
  const saved = (group = groupNames[0]) => JSON.parse(fs.readFileSync(path.join(h.base, group, "groups-r21/state.json")));
  const events = () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  async function prepare() {
    assert.equal(await fleetMain([...args, "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context], deps), 3);
    assert.equal(await fleetMain([...args, "--detach", "--print-approval"], deps), 3);
    return [...args, "--detach", "--approve-reviewed-merged-ready", output.at(-1).approvalSha256];
  }
  return { h, output, workers, saved, events, prepare, deps };
}

test("captured production composition ignores arbitrary hints, binds POST identity and propagates remote options", { timeout: 30000 }, async (t) => {
  const p = fixture(t);
  assert.equal(await fleetMain(await p.prepare(), p.deps), 3, JSON.stringify(p.output.at(-1)));
  assert.equal(p.workers.length, 1, "bootstrap must not admit any later production child");
  const fleet = readFleet(p.h.base, "r21").manifest, events = p.events();
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
    assert.equal(post.body.size, saved.host.size); assert.equal(post.body.region, saved.host.region); assert.equal(post.body.image, saved.host.image);
    assert.deepEqual(events.filter((row) => row.group === group && (row.method === "POST" || row.path?.startsWith("/v2/actions/")))
      .map((row) => [row.method, row.path]), [["POST", "/v2/droplets"], ["GET", `/v2/actions/${1101 + i}`]]);
    assert.ok(!JSON.stringify(p.output).includes("SYNTHETIC_FLEET_CREDENTIAL"));
    const uploads = events.filter((row) => row.group === group && row.boundary === "upload");
    assert.equal(uploads.length, 3);
    const script = uploads.find((row) => row.to.endsWith("/job.sh")).content;
    assert.ok(script.includes(`--group '${group}'`)); assert.ok(script.includes(`--commit '${commit}'`));
    assert.ok(script.includes("--state-dir '/bench/campaign'"));
    assert.ok(script.indexOf("/bench/bootstrap-ready.json") < script.indexOf("node 'bench/workloads/isolated/campaign-entry.mjs'"));
    const starts = events.filter((row) => row.group === group && row.boundary === "ssh" && row.options.input.includes(`systemctl start ${saved.unit}`));
    assert.equal(starts.length, 1);
    const exited = events.filter((row) => row.group === group && row.boundary === "provider-child-exit");
    assert.equal(exited.length, 1); assert.equal(exited[0].code, 0); assert.equal(exited[0].signal, null);
    assert.ok(exited[0].terminal && exited[0].fleetLock && exited[0].launchLock && exited[0].operationLock);
    assert.equal(events.filter((row) => row.group === group && row.boundary === "synthetic-credential").length, 1);
  }
  const first = p.saved(), marker = `${JSON.stringify(bootstrapMarker(first))}\n`;
  assert.equal(first.bootstrapReady.sha256, digest(marker)); assert.ok(Number.isFinite(Date.parse(first.bootstrapReady.observedAt)));
  for (const row of events.filter((row) => ["ssh", "scp"].includes(row.boundary))) {
    assert.equal(row.options.shell, false); assert.equal(row.options.windowsHide, true);
    assert.ok(row.options.timeout > 0 && row.options.timeout <= 900000);
    assert.deepEqual(row.argv.slice(row.boundary === "scp" ? 1 : 0, row.boundary === "scp" ? 5 : 4), ["-F", "none", "-o", "ForwardAgent=no"]);
    assert.ok(row.argv.includes("ClearAllForwardings=yes")); assert.ok(row.argv.includes("ControlPath=none"));
    assert.ok(row.argv.some((arg) => arg.startsWith('UserKnownHostsFile="') && arg.endsWith('/known_hosts"')));
    if (row.boundary === "ssh") { assert.equal(row.argv.at(-1), "/bin/bash -s"); assert.ok(row.options.input.startsWith("set -euo pipefail\n")); }
    else assert.equal(row.argv[0], "-B");
  }
  assert.equal(events.filter((row) => row.method === "POST").length, 1);
  for (const group of groupNames.slice(1)) assert.equal(fs.existsSync(path.join(p.h.base, group)), false);
  assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), false);
});

test("second exact approval dispatches all remaining captured production workers once, with overlapping remote groups", { timeout: 60000 }, async (t) => {
  const p = fixture(t);
  assert.equal(await fleetMain(await p.prepare(), p.deps), 3);
  const state = p.saved(), group = groupNames[0], campaign = `r21-${state.token}`;
  const local = path.join(p.h.base, group, "groups-r21"), evidence = path.join(local, "evidence-Synthetic");
  const folder = path.join(evidence, "campaign"), report = syntheticInspection("verified");
  Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", campaign,
    selection: state.selection, groups: report.groups.filter((row) => row.group === group) });
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
  // Only this code-only stand-in substitutes the native replay result. Child
  // admission still uses actual captured production/controller/provider workers.
  // The synthetic archive cannot establish native readiness or paid authority.
  p.deps.verify = async (fleet, group, { interrupted }) => ({
    ...await verifyCollectedGroup(fleet, group, { inspect: async () => report, interrupted }), evidenceMode: "native-replay" });
  const args = ["r21", "--fleet-root", p.h.base, "--admit-remaining"];
  assert.equal(await fleetMain([...args, "--print-approval"], p.deps), 3);
  const preview = p.output.at(-1), approval = preview.approvalSha256;
  assert.equal(preview.subject.jobs[0].outcome, "verified");
  for (const job of preview.subject.jobs.slice(1)) assert.equal(job.subject.options.group, job.group);
  const approved = [...args, "--approve-reviewed-merged-ready", approval];
  assert.equal(await fleetMain(approved, p.deps), 3);
  assert.equal(p.workers.length, groupNames.length);
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "pending"));
  const events = p.events(), posts = events.filter((row) => row.method === "POST");
  assert.deepEqual(posts.map((row) => row.group), groupNames);
  const ids = new Set(), ips = new Set();
  for (const group of groupNames) {
    const saved = p.saved(group); ids.add(saved.id); ips.add(saved.ip);
    assert.equal(saved.group, group); assert.equal(saved.status, group === groupNames[0] ? "collected" : "running");
    const start = events.findIndex((row) => row.group === group && row.boundary === "provider-child-start");
    const exit = events.findIndex((row) => row.group === group && row.boundary === "provider-child-exit");
    assert.ok(start >= 0 && exit > start);
    const next = groupNames[groupNames.indexOf(group) + 1];
    if (next) assert.ok(exit < events.findIndex((row) => row.group === next && row.boundary === "provider-child-start"));
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
  assert.ok(!events.some((row) => ["ssh", "scp", "upload"].includes(row.boundary)));
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
  assert.ok(!events.some((row) => ["ssh", "scp", "upload"].includes(row.boundary)));
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
