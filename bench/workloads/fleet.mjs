// Fixed dedicated-host fleet. No provider operations on import or preparation.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { fleetPlan, roundName, selection } from "./cloud-contract.mjs";
import { digest, durable, physical, regular, syncDirectory } from "./cloud-local.mjs";
import { full, providerIdentity } from "./cloud-options.mjs";
import { controllerPaths, productionPlan, productionSignals } from "./cloud-production.mjs";
import { providerFiles } from "./cloud-provider.mjs";
import { controlCheckpoint, shellTransport } from "./cloud-transport.mjs";
import { fleetRoot, present, readFleet, readGroup } from "./fleet-verify.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ownPaths = ["fleet.mjs", "fleet-verify.mjs", "fleet-worker.mjs"].map((name) => `bench/workloads/${name}`);
export const fleetWorkerPaths = [...new Set([...ownPaths, ...controllerPaths,
  ...providerFiles.map((name) => posix.normalize(`bench/workloads/${name}`)), "bench/workloads/registry.mjs", "bench/json-api/contract.mjs",
  "bench/catalog/fixtures.mjs", "bench/marketplace/fixtures.mjs", "bench/catalog/stats.mjs", "bench/load-tool.mjs"])].sort();
// Capture bytes once, before approval. Both the commit comparison and worker
// execution use this same read, not a mutable entry/dependency path later.
const installedSources = fleetWorkerPaths.map((path) => {
  const bytes = regular(join(checkout, path), 1024 * 1024);
  return { path, url: pathToFileURL(join(checkout, path)).href, sha256: digest(bytes), source: bytes.toString("utf8") };
});
const loadedSources = new Map(installedSources.map(({ path, source }) => [path, source.replaceAll("\r\n", "\n")]));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function parseFleetArgs(args) {
  const o = { round: args[0] }, seen = new Set();
  const values = { "--fleet-root": "root", "--commit": "commit", "--ssh-key": "sshKey", "--account-id": "accountId", "--context": "context", "--approve-reviewed-merged-ready": "approval" };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]; assert.ok(!seen.has(flag), "fleet-option"); seen.add(flag);
    if (["--prepare", "--detach", "--collect", "--print-approval"].includes(flag)) o[flag.slice(2)] = true;
    else {
      assert.ok(Object.hasOwn(values, flag), "fleet-option");
      const value = args[++i]; assert.ok(value && !value.startsWith("--"), "fleet-option"); o[values[flag]] = value;
    }
  }
  roundName(o.round); assert.ok(Number(o.round.slice(1)) >= 17);
  fleetRoot(o.root);
  assert.equal([o.prepare, o.detach, o.collect].filter(Boolean).length, 1, "fleet-mode");
  if (o.prepare) {
    full(o.commit, /[a-f0-9]{40}/, "fleet-source"); full(o.sshKey, /[1-9]\d*/, "fleet-key");
    providerIdentity({ accountId: o.accountId, context: o.context });
    assert.ok(!o.approval && !o["print-approval"], "fleet-prepare-local-only");
  } else assert.ok(o.commit === undefined && o.sshKey === undefined && o.accountId === undefined && o.context === undefined, "fleet-saved-identity");
  if (o.approval) full(o.approval, /[a-f0-9]{64}/, "fleet-approval");
  assert.ok(!(o.approval && o["print-approval"]), "fleet-preview-only");
  return Object.freeze(o);
}

async function exactSource(repo, run) {
  assert.equal(realpathSync((await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim()), repo);
  const head = full((await run("git", ["rev-parse", "HEAD"])).stdout.trim(), /[a-f0-9]{40}/, "fleet-source");
  assert.equal((await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout, "", "fleet-source-dirty");
  for (const path of fleetWorkerPaths) assert.equal((await run("git", ["show", `${head}:${path}`])).stdout, loadedSources.get(path), "fleet-source-mismatch");
  return head;
}
function rootRecords(fleet) {
  const records = {};
  for (const name of ["launch-intent.json", "receipts"]) if (present(join(fleet.root, name))) {
    const path = join(fleet.root, name);
    if (name === "receipts") {
      physical(path);
      const names = readdirSync(path).sort(); assert.ok(names.length <= 10000, "fleet-receipt-limit");
      for (const file of names) {
        assert.ok(/^(?:detach|collect)-[a-f0-9]{16}-[a-z-]+\.json$/.test(file), "fleet-receipt-name");
        records[`receipts/${file}`] = digest(regular(join(path, file), 1024 * 1024));
      }
    } else records[name] = digest(regular(path, 1024 * 1024));
  }
  return records;
}
function childOptions(fleet, group, mode) {
  const f = fleet.manifest;
  return { round: f.round, stateDir: join(fleet.root, group), [mode]: true,
    ...(mode === "detach" ? { commit: f.commit, sshKey: f.sshKey, accountId: f.provider.accountId,
      context: f.provider.context, group, fleet: fleet.path } : {}) };
}
function childArgs(options, hash) {
  const args = [options.round, "--state-dir", options.stateDir, options.detach ? "--detach" : "--collect"];
  if (options.detach) for (const [flag, key] of [["--commit", "commit"], ["--ssh-key", "sshKey"], ["--account-id", "accountId"], ["--context", "context"], ["--group", "group"], ["--fleet", "fleet"]]) args.push(flag, options[key]);
  return [...args, "--approve-reviewed-merged-ready", hash];
}

// WorkerClass is a synthetic test boundary, never an option or saved field.
// Separate event loops are required: production SSH/SCP uses spawnSync.
export function productionChild(args, { cancellation, WorkerClass = Worker, sources = installedSources } = {}) {
  return new Promise((resolve, reject) => {
    let worker, message, messages = 0, failed = false;
    const uncertain = () => Object.assign(new Error("group-control-uncertain"), { controlTreeUncertain: true, controlUncertain: true });
    try {
      assert.ok(cancellation instanceof SharedArrayBuffer && cancellation.byteLength === 4);
      assert.deepEqual(sources.map((s) => s.path), fleetWorkerPaths);
      for (const source of sources) assert.equal(digest(source.source), source.sha256);
      const entry = sources.find((s) => s.path === "bench/workloads/fleet-worker.mjs");
      const bootstrap = new URL(`data:text/javascript;base64,${Buffer.from(entry.source).toString("base64")}`);
      worker = new WorkerClass(bootstrap, { workerData: { args, cancellation, sources, entry: entry.url }, stdout: true, stderr: true, execArgv: [] });
    } catch { reject(uncertain()); return; }
    worker.stdout.resume(); worker.stderr.resume();
    worker.on("message", (value) => { message = value; messages++; });
    worker.on("error", () => { failed = true; });
    worker.once("exit", (code) => {
      // Never finish on a message alone or terminate a possibly mutating worker.
      // A crash cannot prove descendant/provider settlement and retains locks.
      if (failed || code !== 0 || messages !== 1 || message?.schema !== "benchmark-group-fleet-worker-result/v1") { reject(uncertain()); return; }
      const fields = Object.keys(message).sort();
      if (JSON.stringify(fields) === '["code","schema"]' && [0, 1, 3].includes(message.code)) resolve(message.code);
      else if (JSON.stringify(fields) === '["error","schema","uncertain"]' && ["group-operation-failed", "group-bootstrap-invalid"].includes(message.error) && typeof message.uncertain === "boolean")
        reject(message.uncertain ? uncertain() : new Error(message.error));
      else reject(uncertain());
    });
  });
}

export async function fleetOperationPlan(options, { repo = checkout, run, plan = productionPlan } = {}) {
  repo = realpathSync(repo);
  const root = fleetRoot(options.root, repo), head = await exactSource(repo, run), fleet = readFleet(root, options.round);
  assert.equal(fleet.manifest.commit, head, "fleet-source-mismatch");
  const mode = options.detach ? "detach" : "collect", records = rootRecords(fleet);
  if (mode === "detach") assert.ok(!present(join(root, "launch-intent.json")), "fleet-already-attempted");
  const jobs = [], ids = new Set(), ips = new Set();
  for (const { group } of fleet.manifest.jobs) {
    const child = childOptions(fleet, group, mode);
    if (mode === "detach") {
      assert.ok(!present(child.stateDir), "fleet-child-already-reserved");
      jobs.push({ group, options: child, outcome: "planned" });
    } else {
      let saved;
      try { saved = readGroup(fleet, group); }
      catch { jobs.push({ group, outcome: "error", error: "group-state-invalid" }); continue; }
      if (saved.state?.id) {
        assert.ok(!ids.has(saved.state.id) && !ips.has(saved.state.ip), "fleet-host-duplicate");
        ids.add(saved.state.id); ips.add(saved.state.ip);
      }
      jobs.push({ group, outcome: saved.outcome === "available" ? "planned" : saved.outcome,
        ...(saved.stateSha256 ? { stateSha256: saved.stateSha256 } : {}), ...(saved.outcome === "available" ? { options: child } : {}) });
    }
  }
  // All preflights settle before approval, including rejected group-local plans.
  const plans = await Promise.allSettled(jobs.map(async (job) => {
    if (job.outcome !== "planned") return;
    const p = await plan(job.options, { repo, run });
    assert.equal(p.subject.controllerCommit, head); assert.equal(p.subject.stateRoot, job.options.stateDir);
    assert.equal(p.approvalSha256, digest(JSON.stringify(p.subject)));
    assert.ok(Array.isArray(p.missing));
    return p;
  }));
  for (const [i, settled] of plans.entries()) {
    if (jobs[i].outcome !== "planned") continue;
    if (settled.status === "rejected") {
      if (mode === "detach") throw settled.reason;
      jobs[i] = { group: jobs[i].group, outcome: "error", error: "group-plan-invalid", stateSha256: jobs[i].stateSha256 };
    } else Object.assign(jobs[i], { subject: settled.value.subject, approvalSha256: settled.value.approvalSha256, missing: settled.value.missing });
  }
  assert.equal(readFleet(root, options.round).manifestSha256, fleet.manifestSha256, "fleet-manifest-changed");
  const subject = { schema: "benchmark-group-fleet-approval/v1", action: mode, controllerCommit: head,
    stateRoot: root, requestedRoot: resolve(options.root), round: options.round, manifestSha256: fleet.manifestSha256,
    fleet: fleet.manifest, records, jobs,
    declaration: "operator-approved-after-merged-independent-review-and-full-native-readiness" };
  return { subject, approvalSha256: digest(JSON.stringify(subject)), fleet };
}

// plan/main injection is a synthetic TEST seam at the existing production
// boundaries. Neither the CLI nor saved JSON can select implementations.
export async function fleetMain(args, { repo = checkout, spawn, providerFactory, inspect, sleep,
  interrupted = () => false, write = console.log, plan = productionPlan, main, WorkerClass } = {}) {
  const options = parseFleetArgs(args); repo = realpathSync(repo);
  const transport = shellTransport({ repo, spawn });
  const run = async (...args) => {
    assert.equal(args[0], "git", "fleet-local-only");
    await controlCheckpoint(interrupted);
    let result, failure;
    try { result = await transport(...args); } catch (error) { failure = error; }
    try { await controlCheckpoint(interrupted); }
    catch (error) { if (!failure?.controlTreeUncertain && !failure?.controlUncertain) throw error; }
    if (failure) throw failure; return result;
  };
  const root = fleetRoot(options.root, repo);
  if (options.prepare) {
    assert.equal(await exactSource(repo, run), options.commit, "fleet-source-mismatch");
    mkdirSync(root, { recursive: true, mode: 0o700 }); physical(root);
    assert.deepEqual(readdirSync(root), [], "fleet-root-not-empty");
    const lock = join(root, ".fleet-operation.lock"); durable(lock, json({ pid: process.pid, action: "prepare" }));
    try {
      assert.deepEqual(readdirSync(root), [".fleet-operation.lock"]);
      const used = new Set(), token = () => { let v; do { v = randomBytes(8).toString("hex"); } while (used.has(v)); used.add(v); return v; };
      const manifest = fleetPlan({ round: options.round, commit: options.commit, token: token(),
        tokens: Object.fromEntries(selection().groups.map(({ group }) => [group, token()])),
        provider: { accountId: options.accountId, context: options.context }, sshKey: options.sshKey });
      durable(join(root, `fleet-${options.round}.json`), json(manifest));
      assert.deepEqual(readFleet(root, options.round).manifest, manifest);
      write(JSON.stringify({ schema: "benchmark-group-fleet-preparation/v1", round: options.round, outcome: "prepared", groups: manifest.jobs.map(({ group }) => group), fullGroupQualified: false }));
      return 3;
    } finally { physical(root); unlinkSync(lock); syncDirectory(root); }
  }
  const deps = { repo, run, plan }, preview = await fleetOperationPlan(options, deps);
  if (options["print-approval"]) {
    write(JSON.stringify({ subject: preview.subject, approvalSha256: preview.approvalSha256, fullGroupQualified: false }));
    return preview.subject.jobs.some((j) => j.missing?.length) ? 2 : 3;
  }
  assert.equal(options.approval, preview.approvalSha256, "fleet-exact-approval-required");
  assert.ok(preview.subject.jobs.every((j) => !j.missing?.length), "fleet-integration-missing");
  await controlCheckpoint(interrupted);
  const lock = join(root, ".fleet-operation.lock"), owner = json({ pid: process.pid, approvalSha256: options.approval });
  durable(lock, owner);
  let uncertain = false;
  try {
    const repeated = await fleetOperationPlan(options, deps);
    assert.equal(repeated.approvalSha256, options.approval, "fleet-action-changed");
    await controlCheckpoint(interrupted);
    if (options.detach) durable(join(root, "launch-intent.json"), json({ schema: "benchmark-group-fleet-launch-intent/v1", approvalSha256: options.approval,
      manifestSha256: preview.fleet.manifestSha256, children: preview.subject.jobs.map(({ group, approvalSha256 }) => ({ group, approvalSha256 })) }));
    const receipts = join(root, "receipts");
    if (!present(receipts)) { mkdirSync(receipts, { mode: 0o700 }); syncDirectory(root); }
    physical(receipts);
    const operation = randomBytes(8).toString("hex");
    // Containment, not automatic preview approval: the explicitly approved fleet
    // subject includes every exact child subject/hash. Only those hashes may be
    // delegated, and productionMain revalidates them under its own child lock.
    const cancellation = new SharedArrayBuffer(4), cancel = new Int32Array(cancellation);
    const poll = () => { try { if (interrupted()) Atomics.store(cancel, 0, 1); } catch { Atomics.store(cancel, 0, 1); } };
    poll(); const cancellationPoll = setInterval(poll, 25);
    let settled;
    try { settled = await Promise.allSettled(preview.subject.jobs.map(async (job) => {
      let code, failure;
      try {
        if (job.outcome === "planned") code = main
          ? await main(childArgs(job.options, job.approvalSha256), { repo, spawn, providerFactory, inspect, sleep, interrupted, write: () => {} })
          : await productionChild(childArgs(job.options, job.approvalSha256), { cancellation, WorkerClass });
      }
      catch (error) { failure = error; if (error?.controlTreeUncertain || error?.controlUncertain) uncertain = true; }
      let saved;
      try { saved = readGroup(preview.fleet, job.group); } catch { /* Only validated saved identity is public. */ }
      const row = { group: job.group, outcome: job.outcome !== "planned" ? job.outcome : failure ? "error" : code === 0 ? "collected" : code === 1 ? "terminal-incomplete" : code === 3 ? "pending" : "error",
        ...(saved?.state?.id ? { id: saved.state.id } : {}), ...(failure || job.outcome === "planned" && ![0, 1, 3].includes(code) ? { error: "group-operation-failed" } : {}) };
      // Return codes cannot substitute for validated saved host state. In
      // particular, never print completion/deletion from a worker receipt alone.
      if (!failure && job.outcome === "planned") {
        const state = saved?.state;
        const consistent = saved?.outcome === "available" && (code === 3 ? state.status === "running"
          : [0, 1].includes(code) && state.status === "collected" && state.destroyedAt && state.exitCode === code
            && (code === 0 ? state.validation?.status === "verified" : ["failed", "blocked"].includes(state.validation?.status)));
        if (!consistent) Object.assign(row, { outcome: "error", error: "group-state-invalid" });
      }
      physical(root); physical(receipts);
      durable(join(receipts, `${preview.subject.action}-${operation}-${job.group}.json`), json(row));
      write(JSON.stringify(row)); return row;
    })); } finally { clearInterval(cancellationPoll); }
    // productionMain settles its credential worker in finally. Promise.allSettled
    // keeps this lock while every child (including failed siblings) finishes it.
    const groups = settled.map((s, i) => s.status === "fulfilled" ? s.value : { group: preview.subject.jobs[i].group, outcome: "error", error: "group-receipt-failed" });
    await controlCheckpoint(interrupted);
    write(JSON.stringify({ schema: "benchmark-group-fleet-operation/v1", action: preview.subject.action, groups, fullGroupQualified: false }));
    if (groups.some((g) => ["error", "missing", "ambiguous", "busy"].includes(g.outcome))) return 2;
    return groups.some((g) => g.outcome === "pending") ? 3 : groups.some((g) => g.outcome === "terminal-incomplete") ? 1 : 0;
  } catch (error) {
    if (error?.controlTreeUncertain || error?.controlUncertain) uncertain = true;
    throw error;
  } finally {
    if (!uncertain) {
      physical(root); assert.equal(regular(lock, 1024 * 1024).toString(), owner, "fleet-lock-changed");
      unlinkSync(lock); syncDirectory(root);
    }
  }
}

export async function fleetCli(args) {
  const signals = productionSignals();
  try { return await fleetMain(args, { interrupted: signals.interrupted }); }
  catch { console.error("fleet-operation-failed"); return 2; }
  finally { signals.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  fleetCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
