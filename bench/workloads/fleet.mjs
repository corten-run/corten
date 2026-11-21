// Fixed dedicated-host fleet. No provider operations on import or preparation.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { isIPv4 } from "node:net";
import { fleetPlan, roundName, selection, validateLaunchFleet } from "./cloud-contract.mjs";
import { digest, durable, physical, regular, syncDirectory } from "./cloud-local.mjs";
import { controllerFailure, full, providerFailure, providerIdentity } from "./cloud-options.mjs";
import { controllerPaths, productionPlan, productionSignals } from "./cloud-production.mjs";
import { providerFiles } from "./cloud-provider.mjs";
import { streamRecoveryReady } from "./cloud-control-stream.mjs";
import { controlCheckpoint, shellTransport } from "./cloud-transport.mjs";
import { fleetRoot, present, readFleet, readGroup, recheckCollectedGroup, verifyCollectedGroup } from "./fleet-verify.mjs";
import { localCompiler, localCompilerMissing } from "./cloud-validation-snapshot.mjs";

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
    if (["--prepare", "--detach", "--admit-remaining", "--collect", "--print-approval"].includes(flag)) o[flag.slice(2)] = true;
    else {
      assert.ok(Object.hasOwn(values, flag), "fleet-option");
      const value = args[++i]; assert.ok(value && !value.startsWith("--"), "fleet-option"); o[values[flag]] = value;
    }
  }
  roundName(o.round); assert.ok(Number(o.round.slice(1)) >= 17);
  fleetRoot(o.root);
  assert.equal([o.prepare, o.detach, o["admit-remaining"], o.collect].filter(Boolean).length, 1, "fleet-mode");
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
  for (const name of ["launch-intent.json", "remaining-intent.json", "receipts"]) if (present(join(fleet.root, name))) {
    const path = join(fleet.root, name);
    if (name === "receipts") {
      physical(path);
      const names = readdirSync(path).sort(); assert.ok(names.length <= 10000, "fleet-receipt-limit");
      for (const file of names) {
        assert.ok(/^(?:detach|admit-remaining|collect)-[a-f0-9]{16}-[a-z-]+\.json$/.test(file), "fleet-receipt-name");
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

// readGroup already validates the owned reservation and the complete terminal
// bootstrap ledger. A running host, or a monitor registered before its seal,
// does not authorize another allocation.
function supervisedHost(saved, phase) {
  const s = saved?.state, monitor = s?.control?.monitor;
  if (s?.status !== "running" || s.deletionIntentAt || s.destroyedAt || monitor?.phase !== phase
    || !s.control.sealed.includes("bootstrap") || s.control.ledger.filter((r) => r.request.epoch === "bootstrap").at(-1)?.code !== 0) return;
  const at = (name) => join(saved.local, name);
  if (present(at("monitor-invalid.json"))) return;
  if (phase === "live") {
    if (saved.outcome !== "busy" || present(at("monitor-terminal.json")) || present(at("monitor-local-closed.json"))) return;
    for (const lock of [at("operation.lock"), join(saved.stateRoot, ".groups-launch.lock")])
      if (JSON.parse(regular(lock, 1024)).pid !== process.pid) return;
  } else {
    if (saved.outcome !== "available" || present(join(saved.stateRoot, ".groups-launch.lock"))
      || !present(at("monitor-terminal.json")) || !present(at("monitor-local-closed.json"))) return;
    streamRecoveryReady(saved.local, monitor); // Validate close/binding; collection itself enforces elapsed lease.
  }
  const reg = JSON.parse(regular(at("monitor-registration.json"), 131072));
  if (reg.id !== monitor.id || digest(JSON.stringify(reg)) !== monitor.registrationSha256
    || reg.binding?.round !== s.round || reg.binding.commit !== s.commit || reg.binding.token !== s.token || reg.binding.helperSha256 !== s.control.helperSha256) return;
  return { id: s.id, ip: s.ip, registration: monitor.registrationSha256 };
}

export function watchSupervisedHost(options, notify) {
  const fleet = readFleet(dirname(options.fleet), options.round);
  assert.notEqual(options.group, fleet.manifest.jobs[0].group);
  assert.equal(options.stateDir, join(fleet.root, options.group));
  assert.ok(!present(options.stateDir), "remaining group already reserved");
  const registration = join(options.stateDir, `groups-${options.round}`, "monitor-registration.json");
  // Read the mutable state on its writer's event loop, never concurrently
  // with a Windows rename. A missing or invalid proof cannot advance admission.
  const timer = setInterval(() => {
    try {
      if (present(registration)) {
        const proof = supervisedHost(readGroup(fleet, options.group), "live");
        if (proof) { clearInterval(timer); notify(proof); }
      }
    } catch { /* Settlement still runs and must independently pass the final check. */ }
  }, 100);
  return () => clearInterval(timer);
}

// WorkerClass is a synthetic test boundary, never an option or saved field.
// Separate event loops keep collection independent while SSH/SCP uses spawnSync.
export function productionChild(args, { cancellation, WorkerClass = Worker, sources = installedSources, onReady, onFailure } = {}) {
  return new Promise((resolve, reject) => {
    let worker, message, messages = 0, failed = false, notified = false;
    const uncertain = () => Object.assign(new Error("group-control-uncertain"), { controlTreeUncertain: true, controlUncertain: true });
    try {
      assert.ok(cancellation instanceof SharedArrayBuffer && cancellation.byteLength === 4);
      assert.deepEqual(sources.map((s) => s.path), fleetWorkerPaths);
      const entry = sources.find((s) => s.path === "bench/workloads/fleet-worker.mjs");
      const root = dirname(dirname(dirname(fileURLToPath(entry.url))));
      assert.equal(realpathSync(root), root);
      for (const source of sources) {
        assert.equal(source.url, pathToFileURL(join(root, source.path)).href, "fleet-source-url");
        assert.equal(digest(source.source), source.sha256);
      }
      const bootstrap = new URL(`data:text/javascript;base64,${Buffer.from(entry.source).toString("base64")}`);
      worker = new WorkerClass(bootstrap, { workerData: { args, cancellation, sources, entry: entry.url, ...(onReady ? { admission: true } : {}) },
        stdout: true, stderr: true, execArgv: [] });
    } catch { reject(uncertain()); return; }
    worker.stdout.resume(); worker.stderr.resume();
    worker.on("message", (value) => {
      if (value?.schema === "benchmark-group-fleet-worker-ready/v1") {
        if (!onReady || failed || notified || messages || JSON.stringify(Object.keys(value).sort()) !== '["id","ip","registration","schema"]'
          || typeof value.id !== "string" || !/^[1-9]\d{0,15}$/.test(value.id) || !isIPv4(value.ip)
          || typeof value.registration !== "string" || !/^[a-f0-9]{64}$/.test(value.registration)) { failed = true; onFailure?.(); return; }
        notified = true; onReady(value); return;
      }
      message = value; messages++;
      if (messages !== 1 || value?.schema !== "benchmark-group-fleet-worker-result/v1" || value.code !== 3
        || Object.keys(value).length !== 2) onFailure?.();
    });
    worker.on("error", () => { failed = true; onFailure?.(); });
    worker.once("exit", (code) => {
      // Never finish on a message alone or terminate a possibly mutating worker.
      // A crash cannot prove descendant/provider settlement and retains locks.
      if (failed || code !== 0 || messages !== 1 || message?.schema !== "benchmark-group-fleet-worker-result/v1") { reject(uncertain()); return; }
      const fields = Object.keys(message).sort();
      if (JSON.stringify(fields) === '["code","schema"]' && [0, 1, 3].includes(message.code)) resolve(message.code);
      else if (['["error","schema","uncertain"]', '["error","providerDiagnostic","schema","uncertain"]',
        '["controllerStage","error","schema","uncertain"]', '["controllerStage","error","providerDiagnostic","schema","uncertain"]'].includes(JSON.stringify(fields))
        && ["group-operation-failed", "group-bootstrap-invalid"].includes(message.error) && typeof message.uncertain === "boolean") {
        const diagnostic = providerFailure(message);
        const stage = controllerFailure(message);
        if (fields.includes("providerDiagnostic") && !diagnostic) { reject(uncertain()); return; }
        if (fields.includes("controllerStage") && !stage) { reject(uncertain()); return; }
        reject(Object.assign(message.uncertain ? uncertain() : new Error(message.error), diagnostic ? { providerDiagnostic: diagnostic } : {}, stage ? { controllerStage: stage } : {}));
      }
      else reject(uncertain());
    });
  });
}

function stagedIntent(fleet) {
  const bytes = regular(join(fleet.root, "launch-intent.json"), 1024 * 1024), intent = JSON.parse(bytes);
  assert.deepEqual(Object.keys(intent).sort(), ["approvalSha256", "schema", "subject"]);
  assert.equal(intent.schema, "benchmark-group-fleet-staged-launch-intent/v1", "fleet-legacy-launch-cannot-admit");
  const s = intent.subject, first = fleet.manifest.jobs[0].group;
  assert.equal(intent.approvalSha256, digest(JSON.stringify(s)), "fleet-launch-intent-changed");
  assert.equal(s.schema, "benchmark-group-fleet-staged-approval/v1");
  assert.equal(s.action, "detach"); assert.equal(s.controllerCommit, fleet.manifest.commit);
  assert.equal(s.stateRoot, fleet.root);
  // The approved spelling may be a junction; it must still name this physical
  // fleet, never a missing or retargeted alias. Keep the consumed subject intact.
  assert.equal(fleetRoot(s.requestedRoot), fleet.root, "fleet-requested-root-changed");
  assert.equal(s.round, fleet.manifest.round);
  assert.equal(s.manifestSha256, fleet.manifestSha256); assert.deepEqual(s.fleet, fleet.manifest);
  assert.deepEqual(s.records, {});
  assert.deepEqual(s.admission, { mode: "first-group-only", firstGroup: first, gate: "collected-verified-deleted", nativeReadiness: false });
  assert.deepEqual(s.jobs.map(({ group }) => group), fleet.manifest.jobs.map(({ group }) => group));
  for (const job of s.jobs) {
    if (job.group !== first) assert.deepEqual(job, { group: job.group, outcome: "deferred" });
    else {
      assert.equal(job.outcome, "planned"); assert.deepEqual(job.options, childOptions(fleet, first, "detach"));
      assert.deepEqual(job.subject.options, job.options); assert.equal(job.subject.controllerCommit, fleet.manifest.commit);
      assert.equal(job.approvalSha256, digest(JSON.stringify(job.subject))); assert.deepEqual(job.missing, []);
    }
  }
  return digest(bytes);
}

// Bind a successor's single-child collection to the consumed launch, never
// grant launch/admission authority or move a reservation to a different root.
export function stagedChildIntent(stateRoot, saved) {
  const fleet = readFleet(dirname(stateRoot), saved.round), first = fleet.manifest.jobs[0].group;
  assert.equal(stateRoot, join(fleet.root, saved.group)); assert.deepEqual(fleet.manifest, saved.fleet);
  const launch = stagedIntent(fleet);
  if (saved.group === first) return { launch };
  const bytes = regular(join(fleet.root, "remaining-intent.json"), 1024 * 1024), intent = JSON.parse(bytes), s = intent.subject;
  assert.equal(intent.schema, "benchmark-group-fleet-remaining-intent/v1"); assert.equal(intent.approvalSha256, digest(JSON.stringify(s)));
  assert.equal(s.schema, "benchmark-group-fleet-staged-approval/v1"); assert.equal(s.action, "admit-remaining");
  assert.equal(s.stateRoot, fleet.root); assert.equal(fleetRoot(s.requestedRoot), fleet.root);
  assert.deepEqual(s.fleet, fleet.manifest); assert.equal(s.manifestSha256, fleet.manifestSha256);
  assert.equal(s.controllerCommit, saved.commit); assert.equal(s.round, saved.round);
  assert.equal(s.records["launch-intent.json"], launch);
  assert.deepEqual(s.admission, { mode: "remaining-once", firstGroup: first, gate: "collected-verified-deleted", nativeReadiness: false });
  assert.equal(s.firstGroup.evidenceMode, "native-replay"); assert.equal(s.firstGroup.row.outcome, "verified");
  assert.equal(s.firstGroup.row.group, first);
  assert.deepEqual(s.jobs.map(j => j.group), fleet.manifest.jobs.map(j => j.group));
  const job = s.jobs.find(j => j.group === saved.group);
  assert.equal(job.outcome, "planned"); assert.deepEqual(job.missing, []);
  assert.deepEqual(job.options, childOptions(fleet, saved.group, "detach")); assert.deepEqual(job.options, job.subject.options);
  assert.equal(job.subject.controllerCommit, saved.commit); assert.equal(job.approvalSha256, digest(JSON.stringify(job.subject)));
  return { launch, remaining: digest(bytes) };
}

// verify and compiler are code-only synthetic TEST seams, never selected by argv/JSON.
export async function fleetOperationPlan(options, { repo = checkout, run, plan = productionPlan, verify = verifyCollectedGroup,
  inspect, interrupted = () => false, compiler = localCompiler } = {}) {
  repo = realpathSync(repo);
  const root = fleetRoot(options.root, repo), head = await exactSource(repo, run), fleet = readFleet(root, options.round);
  assert.equal(fleet.manifest.commit, head, "fleet-source-mismatch");
  const mode = options.detach ? "detach" : options["admit-remaining"] ? "admit-remaining" : "collect", records = rootRecords(fleet);
  const launching = mode !== "collect", first = fleet.manifest.jobs[0].group;
  if (launching) validateLaunchFleet(fleet.manifest);
  let deferred = false;
  if (mode === "collect" && present(join(root, "launch-intent.json")) && !present(join(root, "remaining-intent.json"))) {
    // Only a valid staged reservation explains absent future children. Legacy
    // fleets retain their existing missing-state diagnostics and collection.
    try { stagedIntent(fleet); deferred = true; } catch { /* Not staged authority. */ }
  }
  let firstGroup;
  if (mode === "detach") {
    assert.ok(!present(join(root, "launch-intent.json")), "fleet-already-attempted");
    assert.ok(!present(join(root, "remaining-intent.json")) && !present(join(root, "receipts")), "fleet-reservation-consumed");
  }
  if (mode === "admit-remaining") {
    stagedIntent(fleet);
    assert.ok(!present(join(root, "remaining-intent.json")), "fleet-remaining-already-attempted");
    // Native replay reads this checkout's bench compiler: without it, name the install instead of replaying.
    if (inspect !== undefined || compiler()) {
      firstGroup = await verify(fleet, first, { inspect, interrupted });
      assert.equal(firstGroup.evidenceMode, "native-replay", "fleet-native-first-group-replay-required");
      assert.equal(firstGroup.row.outcome, "verified", "fleet-first-group-not-verified-and-deleted");
      recheckCollectedGroup(fleet, firstGroup.snapshot);
    }
  }
  const jobs = [], ids = new Set(), ips = new Set();
  for (const { group } of fleet.manifest.jobs) {
    const child = childOptions(fleet, group, launching ? "detach" : "collect");
    if (mode === "admit-remaining" && group === first) {
      const saved = readGroup(fleet, first);
      ids.add(saved.state.id); ips.add(saved.state.ip);
      jobs.push(firstGroup ? { group, outcome: "verified", snapshot: firstGroup.snapshot }
        : { group, outcome: "replay-blocked", missing: [localCompilerMissing] }); continue;
    }
    if (launching) {
      assert.ok(!present(child.stateDir), "fleet-child-already-reserved");
      jobs.push(mode === "detach" && group !== first ? { group, outcome: "deferred" } : { group, options: child, outcome: "planned" });
    } else {
      if (deferred && group !== first && !present(child.stateDir)) {
        jobs.push({ group, outcome: "deferred" }); continue;
      }
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
      if (launching) throw settled.reason;
      jobs[i] = { group: jobs[i].group, outcome: "error", error: "group-plan-invalid", stateSha256: jobs[i].stateSha256 };
    } else Object.assign(jobs[i], { subject: settled.value.subject, approvalSha256: settled.value.approvalSha256, missing: settled.value.missing });
  }
  assert.equal(readFleet(root, options.round).manifestSha256, fleet.manifestSha256, "fleet-manifest-changed");
  if (firstGroup) recheckCollectedGroup(fleet, firstGroup.snapshot);
  const subject = { schema: launching ? "benchmark-group-fleet-staged-approval/v1" : "benchmark-group-fleet-approval/v1", action: mode, controllerCommit: head,
    stateRoot: root, requestedRoot: resolve(options.root), round: options.round, manifestSha256: fleet.manifestSha256,
    fleet: fleet.manifest, records, jobs,
    ...(launching ? { admission: { mode: mode === "detach" ? "first-group-only" : "remaining-once", firstGroup: first,
      gate: "collected-verified-deleted", nativeReadiness: false }, ...(firstGroup ? { firstGroup } : {}) } : {}),
    declaration: "operator-approved-after-merged-independent-review-and-full-native-readiness" };
  return { subject, approvalSha256: digest(JSON.stringify(subject)), fleet };
}

// plan/main injection is a synthetic TEST seam at the existing production
// boundaries. Neither the CLI nor saved JSON can select implementations.
export async function fleetMain(args, { repo = checkout, spawn, providerFactory, inspect, sleep,
  interrupted = () => false, write = console.log, plan = productionPlan, verify = verifyCollectedGroup, compiler, main, WorkerClass } = {}) {
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
  const deps = { repo, run, plan, verify, inspect, interrupted, compiler }, preview = await fleetOperationPlan(options, deps);
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
    if (options.detach) durable(join(root, "launch-intent.json"), json({ schema: "benchmark-group-fleet-staged-launch-intent/v1",
      approvalSha256: options.approval, subject: preview.subject }));
    if (options["admit-remaining"]) durable(join(root, "remaining-intent.json"), json({ schema: "benchmark-group-fleet-remaining-intent/v1",
      approvalSha256: options.approval, subject: preview.subject }));
    const receipts = join(root, "receipts");
    if (!present(receipts)) { mkdirSync(receipts, { mode: 0o700 }); syncDirectory(root); }
    physical(receipts);
    const operation = randomBytes(8).toString("hex");
    // Containment, not automatic preview approval: the explicitly approved fleet
    // subject includes every exact child subject/hash. Only those hashes may be
    // delegated, and productionMain revalidates them under its own child lock.
    const cancellation = new SharedArrayBuffer(4), cancel = new Int32Array(cancellation);
    const poll = () => { try { if (interrupted()) Atomics.store(cancel, 0, 1); } catch { Atomics.store(cancel, 0, 1); } };
    const cancelled = () => { poll(); return Atomics.load(cancel, 0) !== 0; };
    poll(); const cancellationPoll = setInterval(poll, 25);
    const persist = (job, row) => {
      physical(root); physical(receipts);
      durable(join(receipts, `${preview.subject.action}-${operation}-${job.group}.json`), json(row));
      write(JSON.stringify(row)); return row;
    };
    const launching = options.detach || options["admit-remaining"];
    const admittedIds = new Set(), admittedIps = new Set(), supervised = new Map();
    const claimHost = (group, proof) => {
      if (!proof) return false;
      const prior = supervised.get(group);
      if (supervised.has(group)) return prior?.id === proof.id && prior.ip === proof.ip && prior.registration === proof.registration;
      if (admittedIds.has(proof.id) || admittedIps.has(proof.ip)) { supervised.set(group, null); return false; }
      admittedIds.add(proof.id); admittedIps.add(proof.ip); supervised.set(group, proof); return true;
    };
    if (options["admit-remaining"]) {
      const first = readGroup(preview.fleet, preview.fleet.manifest.jobs[0].group);
      admittedIds.add(first.state.id); admittedIps.add(first.state.ip);
    }
    const operate = async (job, skipped, onReady, onFailure) => {
      if (skipped) return persist(job, { group: job.group, outcome: "not-admitted", reason: skipped });
      if (["deferred", "verified"].includes(job.outcome)) return persist(job, { group: job.group, outcome: job.outcome });
      let code, failure;
      try {
        if (job.outcome === "planned") code = main
          ? await main(childArgs(job.options, job.approvalSha256), { repo, spawn, providerFactory, inspect, sleep, interrupted: cancelled, write: () => {}, onReady })
          : await productionChild(childArgs(job.options, job.approvalSha256), { cancellation, WorkerClass, onReady, onFailure });
      }
      catch (error) { failure = error; if (error?.controlTreeUncertain || error?.controlUncertain) uncertain = true; }
      let saved, closed;
      try {
        saved = readGroup(preview.fleet, job.group);
        if (options["admit-remaining"] && !failure && code === 3) closed = supervisedHost(saved, "closed");
      } catch { /* Only validated saved identity is public. */ }
      const diagnostic = providerFailure(failure);
      const stage = controllerFailure(failure);
      const row = { group: job.group, outcome: job.outcome !== "planned" ? job.outcome : failure ? "error" : code === 0 ? "collected" : code === 1 ? "terminal-incomplete" : code === 3 ? "pending" : "error",
        ...(saved?.state?.id ? { id: saved.state.id } : {}), ...(failure || job.outcome === "planned" && ![0, 1, 3].includes(code) ? { error: "group-operation-failed" } : {}),
        ...(failure ? { uncertain: !!(failure.controlTreeUncertain || failure.controlUncertain) } : {}),
        ...(diagnostic ? { providerDiagnostic: diagnostic } : {}), ...(stage ? { controllerStage: stage } : {}) };
      // Return codes cannot substitute for validated saved host state. In
      // particular, never print completion/deletion from a worker receipt alone.
      if (!failure && job.outcome === "planned") {
        const state = saved?.state;
        const first = job.group === preview.fleet.manifest.jobs[0].group;
        const bootstrapReady = state?.bootstrapReady;
        const bootstrap = !first || bootstrapReady && /^[a-f0-9]{64}$/.test(bootstrapReady.sha256)
          && typeof bootstrapReady.observedAt === "string" && Number.isFinite(Date.parse(bootstrapReady.observedAt));
        const retired = code === 1 && state?.status === "retired" && state.destroyedAt && ["unused", "setup-failed"].includes(state.retirement?.kind)
          && /^[a-f0-9]{64}$/.test(state.retirement.evidenceSha256);
        const consistent = saved?.outcome === "available" && (launching
          ? code === 3 && state.status === "running" && state.id && state.ip && !state.deletionIntentAt && !state.destroyedAt
            && bootstrap && (options["admit-remaining"] ? claimHost(job.group, closed)
              : !admittedIds.has(state.id) && !admittedIps.has(state.ip))
          : code === 3 ? state.status === "running"
          : retired || [0, 1].includes(code) && state.status === "collected" && state.destroyedAt && state.exitCode === code
            && (code === 0 ? state.validation?.status === "verified" : ["failed", "blocked"].includes(state.validation?.status)));
        if (!consistent) Object.assign(row, { outcome: "error", error: "group-state-invalid" });
        else if (closed) row.collection = "separate-child-approval-required";
        else if (launching) { admittedIds.add(state.id); admittedIps.add(state.ip); }
        else if (retired) row.outcome = state.retirement.kind === "unused" ? "unused-retired" : "setup-failed-retired";
      }
      return persist(job, row);
    };
    let settled;
    const started = [];
    try {
      if (launching) {
        settled = [];
        let stopped;
        // Deferred groups cannot execute under the initial approval. A separate
        // consumed intent admits the remaining hosts after first-group replay.
        // Provision one at a time, but do not wait for native work to end. Each
        // worker keeps its own custody; persist its final receipt immediately so
        // an independently approved child collect need not wait for the fleet.
        const active = new Set();
        const revoked = () => [...active].some((dir) => present(join(dir, "monitor-invalid.json")));
        for (const job of preview.subject.jobs) {
          if (cancelled()) stopped = "cancelled";
          if (!stopped && preview.subject.firstGroup) {
            try { recheckCollectedGroup(preview.fleet, preview.subject.firstGroup.snapshot); }
            catch { stopped = "first-group-evidence-changed"; }
          }
          // Rehashing the first archive/tree is synchronous. Deliver pending
          // worker failures and signals from that interval before dispatch.
          if (!stopped) {
            try { await controlCheckpoint(cancelled); }
            catch { stopped = "cancelled"; }
          }
          if (!stopped && revoked()) stopped = "prior-admission-failed";
          const watch = !stopped && options["admit-remaining"] && job.outcome === "planned";
          const local = watch && join(job.options.stateDir, `groups-${options.round}`);
          if (watch) active.add(local);
          const i = started.length;
          const ready = Promise.withResolvers();
          const done = operate(job, stopped, watch ? (proof) => {
            if (!claimHost(job.group, proof)) stopped = "prior-admission-failed";
            ready.resolve();
          } : undefined, watch ? () => { stopped ??= "prior-admission-failed"; } : undefined).then((value) => {
            settled[i] = { status: "fulfilled", value };
            if (!["pending", "deferred", "verified"].includes(value.outcome)) stopped ??= "prior-admission-failed";
          }, (reason) => {
            settled[i] = { status: "rejected", reason }; stopped ??= "prior-admission-failed";
          }).finally(() => active.delete(local));
          started.push(done);
          await (watch ? Promise.race([ready.promise, done]) : done);
        }
      } else settled = await Promise.allSettled(preview.subject.jobs.map((job) => operate(job)));
    } finally { await Promise.all(started); clearInterval(cancellationPoll); }
    // productionMain settles its credential worker in finally. Await every
    // admitted child (or all collection siblings) before releasing this lock.
    const groups = settled.map((s, i) => s.status === "fulfilled" ? s.value : { group: preview.subject.jobs[i].group, outcome: "error", error: "group-receipt-failed" });
    await controlCheckpoint(cancelled);
    write(JSON.stringify({ schema: "benchmark-group-fleet-operation/v1", action: preview.subject.action, groups, fullGroupQualified: false }));
    if (groups.some((g) => ["error", "missing", "ambiguous", "busy", "not-admitted"].includes(g.outcome))) return 2;
    return groups.some((g) => ["pending", "deferred"].includes(g.outcome)) ? 3 : groups.some((g) => ["terminal-incomplete", "unused-retired", "setup-failed-retired"].includes(g.outcome)) ? 1 : 0;
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
