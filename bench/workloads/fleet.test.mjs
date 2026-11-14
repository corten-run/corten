// Synthetic orchestration only: no provider, credentials, SSH or native benchmark.
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { accountId, commit, context, harness } from "./cloud-fixtures.mjs";
import { fleetMain, fleetWorkerPaths, parseFleetArgs, productionChild } from "./fleet.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { parseProductionArgs, productionMain, productionPlan } from "./cloud-production.mjs";
import { readFleet } from "./fleet-verify.mjs";
import { groupNames } from "./registry.mjs";

function fixture(t, flags = {}) {
  const h = harness(t), output = [], calls = [], children = [], completions = [];
  const args = (mode) => ["r21", "--fleet-root", h.base, mode];
  const prepare = () => [...args("--prepare"), "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  const spawn = (binary, argv) => {
    calls.push([binary, argv]); assert.equal(binary, "git", "synthetic local boundary only");
    if (argv[0] === "show") return { status: 0, stdout: flags.wrongSource ? "wrong" : readFileSync(resolve(argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n") };
    if (argv[0] === "status" && flags.dirty) return { status: 0, stdout: " M synthetic" };
    if (argv[0] === "fetch" && flags.fetchError) return { status: 1, stdout: "", stderr: "PRIVATE_FETCH_ARGV" };
    return h.run(binary, argv, 60000);
  };
  const deps = { repo: h.repo, spawn, interrupted: () => !!flags.cancelled, write: (value) => output.push(JSON.parse(value)),
    main: async (argv) => {
      const { options, approval } = parseProductionArgs(argv), group = options.group ?? groupNames.find((g) => options.stateDir === join(h.base, g));
      children.push(group); assert.ok(approval);
      if (flags.child) return flags.child({ options, group, approval });
      if (options.detach) seed(group);
      completions.push(group); return 3;
    } };
  function manifest() { return readFleet(h.base, "r21").manifest; }
  function seed(group, change = () => {}) {
    const fleet = manifest(), local = join(h.base, group, "groups-r21"), i = groupNames.indexOf(group);
    mkdirSync(local, { recursive: true });
    const state = { ...reservation({ round: "r21", commit, token: fleet.jobs[i].token, group, fleet }),
      status: "running", createIntentAt: "2026-11-14T01:00:00.000Z", id: String(i + 1), ip: `192.0.2.${i + 1}`,
      provider: fleet.provider, fullGroupQualified: false };
    change(state); writeFileSync(join(local, "state.json"), JSON.stringify(state)); return state;
  }
  async function approve(mode) {
    assert.equal(await fleetMain([...args(mode), "--print-approval"], deps), 3);
    return [...args(mode), "--approve-reviewed-merged-ready", output.at(-1).approvalSha256];
  }
  return { h, flags, args, prepare, deps, output, calls, children, completions, manifest, seed, approve };
}

test("prepare reserves cryptorandom complete fleet once, using only local Git", async (t) => {
  const p = fixture(t);
  assert.equal(await fleetMain(p.prepare(), p.deps), 3);
  const f = p.manifest(); assert.deepEqual(f.jobs.map((j) => j.group), groupNames);
  assert.equal(new Set([f.token, ...f.jobs.map((j) => j.token)]).size, groupNames.length + 1);
  assert.ok(p.calls.every(([binary, argv]) => binary === "git" && argv[0] !== "fetch"));
  assert.deepEqual(p.children, []); assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
  const bytes = readFileSync(join(p.h.base, "fleet-r21.json"));
  await assert.rejects(fleetMain(p.prepare(), p.deps));
  assert.deepEqual(readFileSync(join(p.h.base, "fleet-r21.json")), bytes);
});

test("preview binds complete exact production subjects without writes or child execution", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps);
  const before = readFileSync(join(p.h.base, "fleet-r21.json"));
  await p.approve("--detach"); const preview = p.output.at(-1);
  assert.equal(preview.subject.jobs.length, groupNames.length);
  for (const job of preview.subject.jobs) {
    assert.equal(job.approvalSha256, digest(JSON.stringify(job.subject)));
    assert.equal(job.subject.stateRoot, join(p.h.base, job.group));
    assert.equal(job.subject.fleetSha256, digest(before));
  }
  assert.equal(new Set(preview.subject.jobs.map((j) => j.subject.stateRoot)).size, groupNames.length);
  assert.deepEqual(readFileSync(join(p.h.base, "fleet-r21.json")), before);
  assert.deepEqual(p.children, []); assert.ok(!existsSync(join(p.h.base, "receipts")));
});

test("every child is actually pending concurrently; one rejection never abandons siblings or permits another launch", async (t) => {
  const flags = {}, p = fixture(t, flags), pending = [];
  await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
  flags.child = ({ group, options, approval }) => new Promise((resolve, reject) => {
    assert.equal(approval, p.output.at(-1).subject.jobs.find((j) => j.group === group).approvalSha256);
    assert.equal(options.stateDir, join(p.h.base, group));
    pending.push({ group, resolve: () => { p.seed(group); p.completions.push(group); resolve(3); }, reject });
  });
  let finished = false;
  const operation = fleetMain(approved, p.deps).then((v) => { finished = true; return v; });
  while (pending.length !== groupNames.length) await turn();
  assert.equal(pending.length, groupNames.length); assert.equal(finished, false);
  assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  assert.ok(existsSync(join(p.h.base, "launch-intent.json")));
  pending[0].reject(new Error("PRIVATE_PROVIDER_ARGV")); await turn();
  assert.equal(finished, false); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  for (const child of pending.slice(1)) child.resolve();
  assert.equal(await operation, 2); assert.equal(p.completions.length, groupNames.length - 1);
  assert.ok(!JSON.stringify(p.output).includes("PRIVATE_PROVIDER_ARGV"));
  assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
  await assert.rejects(fleetMain(approved, p.deps), /already-attempted/);
  await assert.rejects(p.approve("--detach"), /already-attempted/);
  assert.equal(p.children.length, groupNames.length);
});

test("no approval, stale bytes/source/account, invalid roster or existing child refuse before dispatch", async (t) => {
  for (const kind of ["missing", "wrong", "bytes", "dirty", "source", "account", "roster", "child"]) {
    const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
    let argv = approved;
    if (kind === "missing") argv = p.args("--detach");
    if (kind === "wrong") argv = [...approved.slice(0, -1), "f".repeat(64)];
    if (kind === "bytes") writeFileSync(join(p.h.base, "fleet-r21.json"), `${JSON.stringify(p.manifest())}\n`);
    if (kind === "dirty") flags.dirty = true;
    if (kind === "source") flags.wrongSource = true;
    if (kind === "account") {
      const old = p.manifest(); const f = fleetPlan({ round: old.round, commit, token: old.token, tokens: Object.fromEntries(old.jobs.map((j) => [j.group, j.token])),
        provider: { ...old.provider, accountId: "team:other" }, sshKey: old.sshKey }, old.createdAt);
      writeFileSync(join(p.h.base, "fleet-r21.json"), JSON.stringify(f));
    }
    if (kind === "roster") { const f = p.manifest(); f.jobs.pop(); writeFileSync(join(p.h.base, "fleet-r21.json"), JSON.stringify(f)); }
    if (kind === "child") p.seed(groupNames[0]);
    await assert.rejects(fleetMain(argv, p.deps)); assert.deepEqual(p.children, []);
    assert.ok(!existsSync(join(p.h.base, "launch-intent.json")));
  }
});

test("missing native integration blocks the entire batch", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps);
  p.deps.plan = async (...args) => { const plan = await productionPlan(...args); plan.missing = ["synthetic-missing"]; return plan; };
  await fleetMain([...p.args("--detach"), "--print-approval"], p.deps);
  const hash = p.output.at(-1).approvalSha256;
  await assert.rejects(fleetMain([...p.args("--detach"), "--approve-reviewed-merged-ready", hash], p.deps), /integration-missing/);
  assert.deepEqual(p.children, []);
});

test("lock spans cancellation and every pending settlement; uncertainty leaves durable lock", async (t) => {
  for (const uncertain of [false, true]) {
    const flags = {}, p = fixture(t, flags), pending = []; await fleetMain(p.prepare(), p.deps);
    const approved = await p.approve("--detach");
    flags.child = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const result = fleetMain(approved, p.deps); const rejection = assert.rejects(result, /cancelled/);
    while (pending.length < groupNames.length) await turn();
    flags.cancelled = true; await turn(); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
    if (uncertain) pending[0].reject(Object.assign(new Error("private"), { controlTreeUncertain: true }));
    else pending[0].resolve(3);
    for (const child of pending.slice(1)) child.resolve(3);
    await rejection;
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), uncertain);
    flags.cancelled = false;
    if (uncertain) await assert.rejects(fleetMain(await p.approve("--collect"), p.deps), /EEXIST/);
  }
});

test("partial collection launches no missing/ambiguous/busy job, and does not wait for a live sibling", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  p.seed(groupNames[0]); p.seed(groupNames[1]);
  p.seed(groupNames[2], (s) => { s.status = "reserved"; delete s.createIntentAt; delete s.id; delete s.ip; });
  p.seed(groupNames[3]); writeFileSync(join(p.h.base, groupNames[3], "groups-r21", "operation.lock"), "synthetic-live");
  flags.child = async ({ group, options }) => { assert.equal(options.collect, true); assert.equal(options.detach, undefined); return group === groupNames[0] ? 3 : 1; };
  const approved = await p.approve("--collect");
  assert.equal(await fleetMain(approved, p.deps), 2);
  assert.deepEqual(p.children, groupNames.slice(0, 2));
  const summary = p.output.at(-1); assert.equal(summary.groups[0].outcome, "pending");
  assert.equal(summary.groups[1].outcome, "error", "an injected terminal return alone cannot prove deletion"); assert.equal(summary.groups[2].outcome, "ambiguous");
  assert.equal(summary.groups[3].outcome, "busy"); assert.ok(summary.groups.slice(4).every((g) => g.outcome === "missing"));
  assert.ok(!existsSync(join(p.h.base, "launch-intent.json")));
});

test("actual productionMain close uncertainty retains the fleet lock after all child worker settlements", async (t) => {
  const flags = {}, p = fixture(t, flags), pending = [];
  await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
  flags.fetchError = true; p.deps.main = productionMain;
  p.deps.providerFactory = () => Object.assign(async () => { assert.fail("no synthetic provider call expected"); }, {
    close: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
  });
  let finished = false;
  const result = fleetMain(approved, p.deps).then((v) => { finished = true; return v; });
  while (pending.length < groupNames.length) await turn();
  assert.equal(pending.length, groupNames.length); assert.equal(finished, false);
  assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  pending[0].reject(Object.assign(new Error("PRIVATE_WORKER_CLOSE"), { controlUncertain: true, controlTreeUncertain: true }));
  await turn(); assert.equal(finished, false);
  for (const child of pending.slice(1)) child.resolve();
  assert.equal(await result, 2); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  assert.ok(!JSON.stringify(p.output).includes("PRIVATE"));
  assert.equal(p.calls.filter(([binary]) => binary !== "git").length, 0);
});

test("real isolated worker event loops overlap synchronous blocking tasks and drain before unlocking", async (t) => {
  for (const cancel of [false, true]) {
    const flags = {}, p = fixture(t, flags);
    await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
    const controls = new SharedArrayBuffer((3 + groupNames.length) * 4), shared = new Int32Array(controls);
    let spawned = 0;
    class SyntheticWorker extends Worker {
      constructor(url, options) {
        assert.ok(url.href.startsWith("data:text/javascript;base64,"));
        const slot = spawned++;
        super(new URL("./fleet-worker-fixture.mjs", import.meta.url), { ...options,
          workerData: { ...options.workerData, controls, slot, uncertain: cancel && slot === 0, holdExit: !cancel } });
      }
    }
    delete p.deps.main; p.deps.WorkerClass = SyntheticWorker;
    let finished = false;
    const operation = fleetMain(approved, p.deps).then((code) => { finished = true; return code; });
    const result = cancel ? assert.rejects(operation, /cancelled/) : operation;
    const deadline = Date.now() + 15000;
    while (Atomics.load(shared, 0) < groupNames.length && Date.now() < deadline) await turn();
    assert.equal(Atomics.load(shared, 0), groupNames.length, "every real worker entered before any blocking task was released");
    assert.equal(Atomics.load(shared, 1), 0); assert.equal(finished, false);
    assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
    if (cancel) flags.cancelled = true;
    else {
      Atomics.store(shared, 1, 1); Atomics.notify(shared, 1);
      while (!groupNames.every((_, i) => Atomics.load(shared, 3 + i) === 2)) await turn();
      assert.equal(finished, false, "a result message is not worker settlement");
      assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
      Atomics.store(shared, 1, 2); Atomics.notify(shared, 1);
    }
    if (cancel) await result;
    else assert.equal(await result, 3);
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), cancel);
    if (cancel) assert.equal(Atomics.load(shared, 2), groupNames.length, "shared cancellation reached every isolated worker");
  }
});

test("saved state changes invalidate collection approval before any child", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps); p.seed(groupNames[0]);
  const approved = await p.approve("--collect"); p.seed(groupNames[0], (s) => { s.id = "999"; });
  await assert.rejects(fleetMain(approved, p.deps)); assert.deepEqual(p.children, []);
});

test("physical aliases, links, hardlinks and overlap fail closed", async (t) => {
  for (const kind of ["manifest-hardlink", "child-alias", "root-retarget", "inside-repo", "live-lock"]) {
    const p = fixture(t); await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
    if (kind === "manifest-hardlink") linkSync(join(p.h.base, "fleet-r21.json"), join(p.h.temp, "linked"));
    if (kind === "child-alias") symlinkSync(p.h.repo, join(p.h.base, groupNames[0]), process.platform === "win32" ? "junction" : "dir");
    if (kind === "root-retarget") { renameSync(p.h.base, `${p.h.base}-old`); symlinkSync(p.h.repo, p.h.base, process.platform === "win32" ? "junction" : "dir"); }
    if (kind === "inside-repo") approved[approved.indexOf("--fleet-root") + 1] = join(p.h.repo, "nested");
    if (kind === "live-lock") writeFileSync(join(p.h.base, ".fleet-operation.lock"), "synthetic-live");
    await assert.rejects(fleetMain(approved, p.deps)); assert.deepEqual(p.children, []);
  }
});

test("CLI cannot select groups, apps, commands, delivery, timing, tokens or child adapters", () => {
  const args = ["r21", "--fleet-root", resolve("outside"), "--collect"];
  for (const extra of [["--group", "json-api"], ["--apps", "corten"], ["--main", "evil"], ["--duration", "1"], ["--token", "f".repeat(16)],
    ["--deliver-audit", resolve("evil")], ["--detach"], ["--collect"], ["--commit", commit]]) assert.throws(() => parseFleetArgs([...args, ...extra]));
});

test("fixed worker rejects malformed messages/startup uncertainty without exposing raw errors", async () => {
  // This invokes only the fixed worker's argument guard, before productionMain.
  await assert.rejects(productionChild(["PRIVATE_ARGV_PROVIDER"], { cancellation: new SharedArrayBuffer(4) }), (error) => {
    assert.equal(error.message, "group-operation-failed"); assert.equal(error.controlUncertain, undefined); return true;
  });
  class BrokenWorker { constructor() { throw new Error("PRIVATE_ARGV_PROVIDER"); } }
  await assert.rejects(productionChild([], { cancellation: new SharedArrayBuffer(4), WorkerClass: BrokenWorker }), (error) => {
    assert.equal(error.message, "group-control-uncertain"); assert.equal(error.controlUncertain, true); return true;
  });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fleet.mjs", import.meta.url)), "PRIVATE_ARGV_PROVIDER"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.equal(result.stderr.trim(), "fleet-operation-failed");
});

test("production snapshot bootstrap executes captured entry/closure bytes and denies unlisted imports before evaluation", async (t) => {
  for (const change of ["positive", "entry", "production-dependency", "unlisted", "url-mismatch"]) {
    const p = fixture(t); await fleetMain(p.prepare(), p.deps);
    const root = join(p.h.temp, "snapshot"), marker = join(p.h.temp, "PRIVATE_MARKER");
    const module = `import {parseDropletArgs} from './cloud-options.mjs';
      export function parseProductionArgs(args) { const at=args.indexOf('--approve-reviewed-merged-ready');
        return {options:parseDropletArgs(args.slice(0,at)),approval:args[at+1],preview:false}; }
      export async function productionMain() { return 3; }`;
    const sources = fleetWorkerPaths.map((path) => {
      const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
      const source = path === "bench/workloads/cloud-production.mjs" ? module : readFileSync(resolve(path), "utf8");
      writeFileSync(target, source);
      return { path, url: pathToFileURL(target).href, sha256: digest(source), source };
    });
    if (change === "unlisted") {
      const dependency = sources.find((s) => s.path === "bench/workloads/cloud-production.mjs");
      dependency.source = `import './unlisted.mjs';\n${dependency.source}`; dependency.sha256 = digest(dependency.source);
      writeFileSync(join(root, "bench/workloads/unlisted.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe');`);
    }
    if (change === "url-mismatch") sources.find((s) => s.path === "bench/workloads/cloud-production.mjs").url = pathToFileURL(join(root, "foreign.mjs")).href;
    class ReplaceAfterCapture extends Worker {
      constructor(bootstrap, options) {
        assert.ok(bootstrap.href.startsWith("data:text/javascript;base64,"));
        if (["entry", "production-dependency"].includes(change)) {
          const path = join(root, "bench/workloads", change === "entry" ? "fleet-worker.mjs" : "cloud-production.mjs");
          writeFileSync(path, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe'); throw new Error('PRIVATE');`);
        }
        super(bootstrap, options);
      }
    }
    const group = groupNames[0], args = ["r21", "--state-dir", join(p.h.base, group), "--detach", "--commit", commit, "--ssh-key", "42",
      "--account-id", accountId, "--context", context, "--group", group, "--fleet", join(p.h.base, "fleet-r21.json"), "--approve-reviewed-merged-ready", "f".repeat(64)];
    const operation = productionChild(args, { cancellation: new SharedArrayBuffer(4), sources, WorkerClass: ReplaceAfterCapture });
    if (change === "unlisted") await assert.rejects(operation, /group-bootstrap-invalid/);
    else if (change === "url-mismatch") await assert.rejects(operation, /group-control-uncertain/);
    else assert.equal(await operation, 3);
    assert.ok(!existsSync(marker), `${change}: mutable source must never evaluate`);
  }
});
