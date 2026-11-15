// Offline composition acceptance: real snapshot Worker -> productionMain -> controller.
// No native success evidence, real credentials, provider/network calls or containers.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { accountId, commit, context, harness, userId } from "./cloud-fixtures.mjs";
import { digest } from "./cloud-local.mjs";
import { fleetMain, fleetWorkerPaths } from "./fleet.mjs";
import { bootstrapMarker } from "./cloud-remote.mjs";
import { readFleet } from "./fleet-verify.mjs";
import { groupNames } from "./registry.mjs";
import { syntheticDependencies } from "./fleet-production-fixture.mjs";

const committed = new Map(fleetWorkerPaths.map((file) => [file, fs.readFileSync(path.resolve(file), "utf8").replaceAll("\r\n", "\n")]));

function fixture(t, mode = "success") {
  const h = harness(t), output = [], workers = [];
  const repo = path.join(h.temp, "captured"), trace = path.join(h.temp, "boundaries.jsonl"), hosts = path.join(h.temp, "provider.json");
  fs.mkdirSync(repo); fs.writeFileSync(trace, "");
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
import { createProviderEngine as syntheticEngine } from './cloud-provider-engine.mjs';
import { bootstrapMarker as syntheticMarker, bootstrapReadScript as syntheticRead } from './cloud-remote.mjs';
const syntheticArgs = syntheticData.args;
const syntheticGroup = syntheticArgs[syntheticArgs.indexOf('--group') + 1];
const synthetic = (${syntheticDependencies.toString()})({
  repo: ${JSON.stringify(repo)}, trace: ${JSON.stringify(trace)}, hosts: ${JSON.stringify(hosts)},
  stateDir: syntheticArgs[syntheticArgs.indexOf('--state-dir') + 1], group: syntheticGroup,
  commit: ${JSON.stringify(commit)}, userId: ${JSON.stringify(userId)}, mode: ${JSON.stringify(mode)}
}, { fs: syntheticFs, path: syntheticPath, createProviderEngine: syntheticEngine,
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

test("captured production composition reaches bound running hosts and propagates remote options", { timeout: 30000 }, async (t) => {
  const p = fixture(t);
  assert.equal(await fleetMain(await p.prepare(), p.deps), 3, JSON.stringify(p.output.at(-1)));
  assert.equal(p.workers.length, groupNames.length);
  const fleet = readFleet(p.h.base, "r21").manifest, events = p.events();
  assert.ok(p.output.at(-1).groups.every((row) => row.outcome === "pending"));
  for (const [i, group] of groupNames.entries()) {
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
    const uploads = events.filter((row) => row.group === group && row.boundary === "upload");
    assert.equal(uploads.length, 3);
    const script = uploads.find((row) => row.to.endsWith("/job.sh")).content;
    assert.ok(script.includes(`--group '${group}'`)); assert.ok(script.includes(`--commit '${commit}'`));
    assert.ok(script.includes("--state-dir '/bench/campaign'"));
    assert.ok(script.indexOf("/bench/bootstrap-ready.json") < script.indexOf("node 'bench/workloads/isolated/campaign-entry.mjs'"));
    const starts = events.filter((row) => row.group === group && row.boundary === "ssh" && row.options.input.includes(`systemctl start ${saved.unit}`));
    assert.equal(starts.length, 1);
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
  for (const group of groupNames.slice(1)) assert.ok(events.findIndex((row) => row.group === group && row.method === "POST")
    > events.findIndex((row) => row.group === groupNames[0] && row.boundary === "settlement-complete"));
  assert.equal(fs.existsSync(path.join(p.h.base, ".fleet-operation.lock")), false);
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

test("first real provider refusal stops later admissions and settlement uncertainty preserves locks", { timeout: 30000 }, async (t) => {
  for (const uncertain of [false, true]) {
    const p = fixture(t, uncertain ? "provider-failure-unsettled" : "provider-failure");
    assert.equal(await fleetMain(await p.prepare(), p.deps), 2);
    assert.equal(p.workers.length, 1); assert.equal(p.saved().status, "reserved");
    const requests = p.events().filter((row) => row.boundary === "provider");
    assert.deepEqual(requests.map((row) => [row.method, row.path]), [["GET", "/v2/account"]]);
    const rows = p.output.at(-1).groups;
    assert.equal(rows[0].outcome, "error"); assert.equal(rows[0].uncertain, uncertain);
    assert.equal(rows[0].controllerStage, uncertain ? "provider-settlement" : "controller-launch");
    if (!uncertain) assert.deepEqual(rows[0].providerDiagnostic, { code: "account-http", httpStatus: 403 });
    assert.ok(rows.slice(1).every((row) => row.outcome === "not-admitted" && row.reason === "prior-admission-failed"));
    for (const group of groupNames.slice(1)) assert.equal(fs.existsSync(path.join(p.h.base, group)), false);
    for (const lock of [path.join(p.h.base, ".fleet-operation.lock"), path.join(p.h.base, groupNames[0], ".groups-launch.lock"),
      path.join(p.h.base, groupNames[0], "groups-r21/operation.lock")]) assert.equal(fs.existsSync(lock), uncertain, lock);
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
