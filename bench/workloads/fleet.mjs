// Fixed dedicated-host fleet. Preparation can read, but never mutate, the provider.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { isIPv4 } from "node:net";
import { fleetCatalogCommand, fleetPlan, fleetRegion, jsonFleetPlacementFor, requireStagedFleet, roundName } from "./cloud-contract.mjs";
import { digest, durable, physical, regular, syncDirectory } from "./cloud-local.mjs";
import { controllerFailure, fleetCatalogResult, full, providerAccount, providerFailure, providerIdentity } from "./cloud-options.mjs";
import { controllerPaths, productionPlan, productionSignals } from "./cloud-production.mjs";
import { providerFiles, providerTransport } from "./cloud-provider.mjs";
import { controlCheckpoint, shellTransport } from "./cloud-transport.mjs";
import { continuationPeer, fleetChildOptions as childOptions, fleetRoot, present, readFleet, readGroup, readLaunchIntent, readRemainingIntent,
  recheckCollectedGroup, replacementQuarantine, supervisedHost, verifyCollectedGroup } from "./fleet-verify.mjs";
import { localCompiler, localCompilerMissing } from "./cloud-validation-snapshot.mjs";
import { groupNames } from "./registry.mjs";
import { acknowledgedBootstrapSeal } from "./cloud-control-runtime.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ownPaths = ["fleet.mjs", "fleet-verify.mjs", "fleet-worker.mjs", "group-continuation.mjs"].map((name) => `bench/workloads/${name}`);
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
  const values = { "--fleet-root": "root", "--continuation-root": "continuationRoot", "--group": "group", "--commit": "commit",
    "--ssh-key": "sshKey", "--account-id": "accountId", "--context": "context", "--approve-reviewed-merged-ready": "approval",
    "--load-layout": "loadLayout", "--replace-quarantined-create": "replacesQuarantineSha256" };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]; assert.ok(!seen.has(flag), "fleet-option"); seen.add(flag);
    if (["--prepare", "--detach", "--admit-remaining", "--collect", "--print-approval", "--offline-handoff"].includes(flag)) o[flag.slice(2)] = true;
    else {
      assert.ok(Object.hasOwn(values, flag), "fleet-option");
      const value = args[++i]; assert.ok(value && !value.startsWith("--"), "fleet-option"); o[values[flag]] = value;
    }
  }
  roundName(o.round); assert.ok(Number(o.round.slice(1)) >= 17);
  assert.equal([o.prepare, o.detach, o["admit-remaining"], o.collect].filter(Boolean).length, 1, "fleet-mode");
  if (o.continuationRoot) {
    assert.ok(!o.root && groupNames.includes(o.group) && (o.prepare || o.detach), "continuation requires one group and prepare or detach");
    o.continuationRoot = fleetRoot(o.continuationRoot);
    o.root = join(o.continuationRoot, o.group);
  } else assert.equal(o.group, undefined, "group requires a continuation root");
  fleetRoot(o.root);
  if (o["offline-handoff"]) assert.ok(o.prepare && o.continuationRoot, "offline handoff must be selected at single-group preparation");
  // The opted-in layout is saved in the fleet at preparation; nothing later selects it.
  if (o.loadLayout !== undefined) assert.ok(o.prepare && o.continuationRoot
    && jsonFleetPlacementFor(o.group, o.loadLayout), "fleet-load-layout");
  if (o.replacesQuarantineSha256 !== undefined) {
    assert.ok(o.prepare && o.continuationRoot, "create quarantine replacement must be selected at single-group preparation");
    full(o.replacesQuarantineSha256, /[a-f0-9]{64}/, "create quarantine replacement digest");
  }
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

const placementFailures = new WeakMap();
async function readPlacement(provider, { repo, interrupted, catalogProvider }, reservedRegion, scope) {
  let stage = "transport-setup", primary, closeFailed = false;
  try {
    const run = catalogProvider({ repo, interrupted }); // No create mode.
    const read = async (args, allowFail = false) => {
      await controlCheckpoint(interrupted);
      return run([...args, "--context", provider.context], 60000, allowFail);
    };
    const account = async (position) => {
      stage = position === "first" ? "first-account-read-or-worker-start" : "second-account-read";
      const result = await read(["account", "get", "--output", "json"]);
      assert.equal(result.status, 0, "fleet catalog account read failed");
      stage = `${position}-account-identity`;
      assert.equal(providerAccount(JSON.parse(result.stdout)), provider.accountId, "fleet catalog account differs");
    };
    try {
      await account("first");
      stage = "catalog-read";
      const result = await read(fleetCatalogCommand, true);
      if (result.status === 0 && !result.error || result.status === 1 && providerFailure(result)?.code === "catalog-response")
        stage = "catalog-validation";
      const catalog = fleetCatalogResult(result);
      await account("second");
      stage = "placement-checkpoint";
      await controlCheckpoint(interrupted);
      stage = "region-selection";
      return fleetRegion(catalog, reservedRegion, scope);
    } catch (error) {
      primary = { stage, refusal: providerFailure(error) };
      throw error;
    } finally {
      try { await run.close(); }
      catch (error) { stage = "transport-close"; closeFailed = true; throw error; }
    }
  } catch (error) {
    // Preserve the exception from the existing try/finally for lock custody, but do not lose the primary stage.
    if (error && typeof error === "object") placementFailures.set(error, {
      ...(primary ?? { stage, refusal: providerFailure(error) }),
      closeFailed: !!primary && closeFailed,
      uncertain: !!(error.controlUncertain || error.controlTreeUncertain),
    });
    throw error;
  }
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
function childArgs(options, hash) {
  const args = [options.round, "--state-dir", options.stateDir, options.detach ? "--detach" : "--collect"];
  if (options.detach) for (const [flag, key] of [["--commit", "commit"], ["--ssh-key", "sshKey"], ["--account-id", "accountId"], ["--context", "context"], ["--group", "group"], ["--fleet", "fleet"]]) args.push(flag, options[key]);
  return [...args, "--approve-reviewed-merged-ready", hash];
}

export function watchSupervisedHost(options, notify) {
  const fleet = readFleet(dirname(options.fleet), options.round);
  const independent = !!fleet.manifest.single;
  if (independent) assert.equal(options.group, fleet.manifest.single.group);
  else assert.notEqual(options.group, fleet.manifest.jobs[0].group);
  assert.equal(options.stateDir, join(fleet.root, options.group));
  assert.ok(!present(options.stateDir), "remaining group already reserved");
  const registration = join(options.stateDir, `groups-${options.round}`, "monitor-registration.json");
  // Read the mutable state on its writer's event loop, never concurrently
  // with a Windows rename. A missing or invalid proof cannot advance admission.
  const timer = setInterval(() => {
    try {
      if (present(registration)) {
        const saved = independent ? continuationPeer(fleet).proof : supervisedHost(readGroup(fleet, options.group), "live");
        const proof = saved && { id: saved.id, ip: saved.ip, registration: saved.registration };
        if (proof) { clearInterval(timer); notify(proof); }
      }
    } catch { /* Settlement still runs and must independently pass the final check. */ }
  }, 100);
  return () => clearInterval(timer);
}

// WorkerClass is a synthetic test boundary, never an option or saved field.
// Separate event loops keep collection independent while SSH/SCP uses spawnSync.
export function productionChild(args, { cancellation, WorkerClass = Worker, sources = installedSources, onReady, onFailure, independent = false } = {}) {
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
      worker = new WorkerClass(bootstrap, { workerData: { args, cancellation, sources, entry: entry.url,
        ...(onReady ? { admission: independent ? "continuation" : true } : {}) },
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

// Bind a successor's single-child collection to the consumed launch, never
// grant launch/admission authority or move a reservation to a different root.
export function stagedChildIntent(stateRoot, saved) {
  const fleet = readFleet(dirname(stateRoot), saved.round), first = fleet.manifest.jobs[0].group;
  assert.equal(stateRoot, join(fleet.root, saved.group)); assert.deepEqual(fleet.manifest, saved.fleet);
  assert.equal(saved.commit, fleet.manifest.commit);
  if (saved.group === first) return { launch: readLaunchIntent(fleet).sha256 };
  const intent = readRemainingIntent(fleet, saved.group);
  if (intent.placement) assert.deepEqual(saved.remainingPlacement, { region: intent.placement.region, intentSha256: intent.sha256 });
  return { launch: intent.launch, remaining: intent.sha256 };
}

// verify and compiler are code-only synthetic TEST seams, never selected by argv/JSON.
export async function fleetOperationPlan(options, { repo = checkout, run, plan = productionPlan, verify = verifyCollectedGroup,
  inspect, interrupted = () => false, compiler = localCompiler, catalogProvider = providerTransport, reservedRegion, continuation } = {}) {
  repo = realpathSync(repo);
  const root = fleetRoot(options.root, repo), head = await exactSource(repo, run), fleet = readFleet(root, options.round);
  assert.equal(fleet.manifest.commit, head, "fleet-source-mismatch");
  const mode = options.detach ? "detach" : options["admit-remaining"] ? "admit-remaining" : "collect", records = rootRecords(fleet);
  const launching = mode !== "collect", first = fleet.manifest.jobs[0].group;
  if (launching) {
    requireStagedFleet(fleet.manifest);
    if (fleet.manifest.single) assert.ok(continuation && mode === "detach", "use continuation detach for an independent group");
    if (fleet.manifest.single?.offlineHandoff) assert.ok(!continuation.subject.peers?.length, "offline handoff requires no live peer");
  }
  let deferred = false;
  if (mode === "collect" && present(join(root, "launch-intent.json")) && !present(join(root, "remaining-intent.json"))) {
    // Only a valid staged reservation explains absent future children. Legacy
    // fleets retain their existing missing-state diagnostics and collection.
    try { readLaunchIntent(fleet); deferred = true; } catch { /* Not staged authority. */ }
  }
  let firstGroup, remainingRegion;
  if (mode === "detach") {
    assert.ok(!present(join(root, "launch-intent.json")), "fleet-already-attempted");
    assert.ok(!present(join(root, "remaining-intent.json")) && !present(join(root, "receipts")), "fleet-reservation-consumed");
  }
  if (mode === "admit-remaining") {
    readLaunchIntent(fleet);
    assert.ok(!present(join(root, "remaining-intent.json")), "fleet-remaining-already-attempted");
    // Native replay reads this checkout's bench compiler: without it, name the install instead of replaying.
    if (inspect !== undefined || compiler()) {
      firstGroup = await verify(fleet, first, { inspect, interrupted });
      assert.equal(firstGroup.evidenceMode, "native-replay", "fleet-native-first-group-replay-required");
      assert.equal(firstGroup.row.outcome, "verified", "fleet-first-group-not-verified-and-deleted");
      recheckCollectedGroup(fleet, firstGroup.snapshot);
      remainingRegion = await readPlacement(fleet.manifest.provider,
        { repo, interrupted, catalogProvider }, reservedRegion, { remainingOnly: true, staged: true });
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
      jobs.push(mode === "detach" && group !== first || mode === "admit-remaining" && !firstGroup
        ? { group, outcome: "deferred" } : { group, options: child, outcome: "planned" });
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
  const remainingPlacement = remainingRegion === undefined ? undefined : { region: remainingRegion, firstGroup: firstGroup.snapshot };
  // All preflights settle before approval, including rejected group-local plans.
  const plans = await Promise.allSettled(jobs.map(async (job) => {
    if (job.outcome !== "planned") return;
    const p = await plan(job.options, { repo, run, remainingPlacement });
    assert.equal(p.subject.controllerCommit, head); assert.equal(p.subject.stateRoot, job.options.stateDir);
    if (remainingPlacement) assert.deepEqual(p.subject.remainingPlacement, remainingPlacement);
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
    fleet: fleet.manifest, records, jobs, ...(remainingRegion === undefined ? {} : { remainingRegion }),
    ...(continuation ? { continuation: continuation.subject } : {}),
    ...(launching ? { admission: { mode: mode === "detach" ? "first-group-only" : "remaining-once", firstGroup: first,
      gate: "collected-verified-deleted", nativeReadiness: false }, ...(firstGroup ? { firstGroup } : {}) } : {}),
    declaration: "operator-approved-after-merged-independent-review-and-full-native-readiness" };
  return { subject, approvalSha256: digest(JSON.stringify(subject)), fleet };
}

// plan/main injection is a synthetic TEST seam at the existing production
// boundaries. Neither the CLI nor saved JSON can select implementations.
export async function fleetMain(args, deps = {}, preIntentFailures) {
  const options = parseFleetArgs(args), repo = realpathSync(deps.repo ?? checkout);
  if (!options.continuationRoot) return runFleet(options, deps);
  const { continuationLock, continuationAdmission, requireSetupRetryCommit } = await import("./group-continuation.mjs");
  const root = fleetRoot(options.continuationRoot, repo), lock = join(root, continuationLock);
  const owner = json({ pid: process.pid, group: options.group });
  const locked = options.prepare || !!options.approval;
  let uncertain = false, attemptRoot = options.root, ownsLock = false, attemptLockOwned = false;
  let preIntentStage = "continuation-admission; lock-check";
  const release = () => {
    assert.equal(regular(lock, 1024).toString(), owner); unlinkSync(lock); ownsLock = false; syncDirectory(root);
  };
  try {
    if (locked) {
      physical(root);
      try { durable(lock, owner); }
      catch (error) {
        if (error?.code === "EEXIST") preIntentStage = "continuation-admission; lock-busy";
        throw error;
      }
      ownsLock = true;
    } else {
      const busy = present(lock);
      if (busy) preIntentStage = "continuation-admission; lock-busy";
      assert.ok(!busy, "continuation operation busy");
    }
    preIntentStage = "continuation-admission; custody-read";
    const continuation = await continuationAdmission(root, options.group, { repo, interrupted: deps.interrupted, inspect: deps.inspect,
      admissionFailure(error, check) { preIntentFailures?.set(error, `continuation-admission; ${check}`); } });
    const row = continuation.rows.find(({ group }) => group === options.group);
    preIntentStage = "continuation-admission; group-selection";
    assert.ok(!row.knownResult, "group already verified or pinned; never allocate again");
    preIntentStage = "continuation-admission; custody-unresolved";
    assert.ok(!continuation.rows.some((r) => r.unresolved), "continuation has unresolved custody or invalid evidence");
    preIntentStage = "continuation-admission; group-selection";
    const slot = continuation.slots.get(options.group);
    if (options.prepare) {
      if (options["offline-handoff"]) assert.ok(!continuation.subject.peers?.length, "offline handoff requires no live peer");
      const superseding = continuation.unlaunched.has(slot?.root) && options.commit !== slot.manifest.commit;
      const quarantined = continuation.subject.quarantinedCreates ?? [];
      const replacement = replacementQuarantine(quarantined, options.group, options.replacesQuarantineSha256);
      const replacesLatest = replacement && slot?.root === replacement.root && row.outcome === "quarantined-create";
      assert.ok(row.outcome === "missing" || row.retryable || superseding || replacesLatest, "group already reserved; never allocate again");
      assert.ok(replacement || quarantined.every((earlier) => earlier.group !== options.group), "the group's create quarantine must be pinned");
      requireSetupRetryCommit(row.attempts, options.commit);
      if (slot) {
        assert.ok(Number(options.round.slice(1)) > Number(slot.manifest.round.slice(1)), "use a new, higher round for this group");
        attemptRoot = join(root, `${options.group}--${options.round}`);
      }
    } else {
      assert.ok(row.outcome === "prepared" && slot.manifest.round === options.round, "group round not prepared or already attempted");
      attemptRoot = slot.root;
    }
    const accountId = options.prepare ? options.accountId : slot.manifest.provider.accountId;
    preIntentStage = "continuation-admission; custody-account";
    assert.ok([...continuation.needsCensus].every((account) => account === accountId), "continuation custody requires the same provider account");
    preIntentStage = "continuation-admission; custody-recheck";
    continuation.recheck();
    preIntentStage = options.prepare ? "prepare-reservation" : undefined;
    return await runFleet({ ...options, root: attemptRoot }, deps, {
      ...continuation, onAttemptLock() { attemptLockOwned = true; },
      onReady() {
        // The worker verified custody on its writing event loop. Every later
        // admission independently rechecks the peer; this only releases the gate.
        try { if (ownsLock) release(); }
        catch { /* No lock takeover. Wait for the original child. */ }
      },
    }, preIntentFailures);
  } catch (error) {
    uncertain = error?.controlUncertain === true || error?.controlTreeUncertain === true;
    if (preIntentStage && !preIntentFailures?.has(error)) preIntentFailures?.set(error, preIntentStage);
    throw error;
  } finally {
    // A contained worker may leave its fleet lock even when the batch returns
    // a diagnostic status instead of throwing. Keep the continuation locked too.
    if (ownsLock && !uncertain && (!attemptLockOwned || !present(join(attemptRoot, ".fleet-operation.lock")))) release();
  }
}

async function runFleet(options, { repo = checkout, spawn, providerFactory, inspect, sleep,
  interrupted = () => false, write = console.log, plan = productionPlan, verify = verifyCollectedGroup, compiler, main, WorkerClass,
  catalogProvider = providerTransport } = {}, continuation, preIntentFailures) {
  repo = realpathSync(repo);
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
  const placement = { repo, interrupted, catalogProvider };
  const takeLock = (path, owner) => {
    try { durable(path, owner); }
    catch (error) {
      // Only an exclusive-create refusal proves the existing lock is not ours.
      if (error.code !== "EEXIST" && present(path)) continuation?.onAttemptLock();
      throw error;
    }
    continuation?.onAttemptLock();
  };
  if (options.prepare) {
    assert.equal(await exactSource(repo, run), options.commit, "fleet-source-mismatch");
    mkdirSync(root, { recursive: true, mode: 0o700 }); physical(root);
    assert.deepEqual(readdirSync(root), [], "fleet-root-not-empty");
    const lock = join(root, ".fleet-operation.lock"), owner = json({ pid: process.pid, action: "prepare" });
    takeLock(lock, owner);
    let uncertain = false;
    try {
      assert.deepEqual(readdirSync(root), [".fleet-operation.lock"]);
      const provider = { accountId: options.accountId, context: options.context };
      const single = continuation && { group: options.group, indexSha256: continuation.indexSha256, checkout: repo,
        ...(options["offline-handoff"] ? { offlineHandoff: true } : {}), ...(options.loadLayout ? { loadLayout: options.loadLayout } : {}),
        ...(options.replacesQuarantineSha256 ? { replacesQuarantineSha256: options.replacesQuarantineSha256 } : {}) };
      const region = await readPlacement(provider, placement, undefined, { staged: true, group: single?.group,
        ...(single?.loadLayout ? { loadLayout: single.loadLayout } : {}) });
      const used = new Set(), token = () => { let v; do { v = randomBytes(8).toString("hex"); } while (used.has(v)); used.add(v); return v; };
      const manifest = fleetPlan({ round: options.round, commit: options.commit, token: token(),
        tokens: Object.fromEntries((single ? [single.group] : groupNames).map((group) => [group, token()])),
        provider, sshKey: options.sshKey }, undefined, region, { stagedPlacement: true, single });
      await controlCheckpoint(interrupted); // Provider close is asynchronous.
      physical(root); assert.equal(regular(lock, 1024).toString(), owner, "fleet-lock-changed");
      assert.deepEqual(readdirSync(root), [".fleet-operation.lock"]);
      if (single) {
        continuation.recheck(root, true);
      }
      durable(join(root, `fleet-${options.round}.json`), json(manifest));
      assert.deepEqual(readFleet(root, options.round).manifest, manifest);
      write(JSON.stringify({ schema: "benchmark-group-fleet-preparation/v1", round: options.round, outcome: "prepared", groups: manifest.jobs.map(({ group }) => group), fullGroupQualified: false }));
      return 3;
    } catch (error) {
      uncertain = !!(error?.controlTreeUncertain || error?.controlUncertain);
      throw error;
    } finally {
      if (!uncertain) {
        physical(root); assert.equal(regular(lock, 1024).toString(), owner, "fleet-lock-changed");
        unlinkSync(lock); syncDirectory(root);
      }
    }
  }
  const deps = { repo, run, plan, verify, inspect, interrupted, compiler, catalogProvider, continuation };
  const lock = join(root, ".fleet-operation.lock"), owner = json({ pid: process.pid, approvalSha256: options.approval });
  let uncertain = false, ownsLock = false;
  let preIntentStage = continuation ? "initial-plan" : undefined;
  try {
    const preview = await fleetOperationPlan(options, deps);
    if (options.detach && options["print-approval"]) {
      const { manifest } = preview.fleet;
      const layout = jsonFleetPlacementFor(manifest.single?.group, manifest.single?.loadLayout);
      if (layout?.host.size === "c-32") {
        await readPlacement(manifest.provider, placement, manifest.host.region,
          { staged: true, group: manifest.single.group, loadLayout: layout.loadLayout });
        assert.equal(readFleet(root, options.round).manifestSha256, preview.fleet.manifestSha256, "fleet-manifest-changed");
        assert.deepEqual(rootRecords(preview.fleet), preview.subject.records, "fleet-records-changed");
      }
    }
    continuation?.recheck();
    if (options["print-approval"]) {
      preIntentStage = undefined;
      write(JSON.stringify({ subject: preview.subject, approvalSha256: preview.approvalSha256, fullGroupQualified: false }));
      return preview.subject.jobs.some((j) => j.missing?.length) ? 2 : 3;
    }
    assert.equal(options.approval, preview.approvalSha256, "fleet-exact-approval-required");
    assert.ok(preview.subject.jobs.every((j) => !j.missing?.length), "fleet-integration-missing");
    await controlCheckpoint(interrupted);
    preIntentStage = undefined;
    takeLock(lock, owner);
    ownsLock = true;
    if (continuation) preIntentStage = "locked-plan";
    const repeated = await fleetOperationPlan(options, { ...deps, reservedRegion: preview.subject.remainingRegion });
    assert.equal(repeated.approvalSha256, options.approval, "fleet-action-changed");
    if (continuation) preIntentStage = "final-pre-intent-recheck";
    if (options.detach || options["admit-remaining"]) {
      const { manifest } = repeated.fleet;
      await readPlacement(manifest.provider, placement, repeated.subject.remainingRegion ?? manifest.host.region,
        { remainingOnly: repeated.subject.action === "admit-remaining", staged: true, group: manifest.single?.group,
          ...(manifest.single?.loadLayout ? { loadLayout: manifest.single.loadLayout } : {}) });
      assert.equal(readFleet(root, options.round).manifestSha256, repeated.fleet.manifestSha256, "fleet-manifest-changed");
      assert.deepEqual(rootRecords(repeated.fleet), repeated.subject.records, "fleet-records-changed");
      assert.equal(regular(lock, 1024 * 1024).toString(), owner, "fleet-lock-changed");
      if (repeated.subject.firstGroup) recheckCollectedGroup(repeated.fleet, repeated.subject.firstGroup.snapshot);
    }
    await controlCheckpoint(interrupted);
    continuation?.recheck(root);
    preIntentStage = undefined; // The intent write can partially succeed; do not label it a pre-intent refusal.
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
    const offline = repeated.fleet.manifest.single?.offlineHandoff === true;
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
          : await productionChild(childArgs(job.options, job.approvalSha256), { cancellation, WorkerClass, onReady, onFailure, independent: !!continuation });
      }
      catch (error) { failure = error; if (error?.controlTreeUncertain || error?.controlUncertain) uncertain = true; }
      let saved, closed;
      try {
        saved = readGroup(preview.fleet, job.group);
        if (options["admit-remaining"] && !failure && code === 3) closed = supervisedHost(saved, "closed");
      } catch { /* Only validated saved identity is public. */ }
      const diagnostic = providerFailure(failure);
      const stage = controllerFailure(failure);
      // The child saved its terminal provider-errored create; the provider sent no host.
      const createErrored = (failure ? !failure.controlTreeUncertain && !failure.controlUncertain && diagnostic?.code === "create-errored-absent" : !launching && code === 1)
        && job.outcome === "planned" && saved?.outcome === "available" && saved.state.status === "creating" && !!saved.state.createErrored
        && !saved.state.createErrored.reappeared;
      const row = { group: job.group, outcome: job.outcome !== "planned" ? job.outcome : createErrored ? "create-errored" : failure ? "error" : code === 0 ? "collected" : code === 1 ? "terminal-incomplete" : code === 3 ? "pending" : "error",
        ...(saved?.state?.id ? { id: saved.state.id } : {}), ...(!createErrored && (failure || job.outcome === "planned" && ![0, 1, 3].includes(code)) ? { error: "group-operation-failed" } : {}),
        ...(failure ? { uncertain: !!(failure.controlTreeUncertain || failure.controlUncertain) } : {}),
        ...(diagnostic ? { providerDiagnostic: diagnostic } : {}), ...(stage ? { controllerStage: stage } : {}) };
      // Return codes cannot substitute for validated saved host state. In
      // particular, never print completion/deletion from a worker receipt alone.
      if (!failure && job.outcome === "planned" && !createErrored) {
        const state = saved?.state;
        const first = job.group === preview.fleet.manifest.jobs[0].group;
        const bootstrapReady = state?.bootstrapReady;
        const bootstrap = !first || bootstrapReady && /^[a-f0-9]{64}$/.test(bootstrapReady.sha256)
          && typeof bootstrapReady.observedAt === "string" && Number.isFinite(Date.parse(bootstrapReady.observedAt));
        const retired = code === 1 && state?.status === "retired" && state.destroyedAt && ["unused", "setup-failed", "native-failed"].includes(state.retirement?.kind)
          && /^[a-f0-9]{64}$/.test(state.retirement.evidenceSha256);
        const consistent = saved?.outcome === "available" && (launching
          ? code === 3 && state.status === "running" && state.id && state.ip && !state.deletionIntentAt && !state.destroyedAt
            && bootstrap && (!offline || state.control.sealed.includes("bootstrap") && acknowledgedBootstrapSeal(state.control.ledger))
            && (options["admit-remaining"] ? claimHost(job.group, closed)
              : !admittedIds.has(state.id) && !admittedIps.has(state.ip))
          : code === 3 ? state.status === "running"
          : retired || [0, 1].includes(code) && state.status === "collected" && state.destroyedAt
            && (state.exitCode === code || offline && code === 1 && state.exitCode === 2 && state.validation?.status === "blocked")
            && (code === 0 ? state.validation?.status === "verified" : ["failed", "blocked"].includes(state.validation?.status)));
        if (!consistent) Object.assign(row, { outcome: "error", error: "group-state-invalid" });
        else if (closed) row.collection = "separate-child-approval-required";
        else if (launching && offline) {
          row.handoff = "acknowledged"; row.collection = "separate-child-approval-required";
          admittedIds.add(state.id); admittedIps.add(state.ip);
        }
        else if (launching) { admittedIds.add(state.id); admittedIps.add(state.ip); }
        else if (retired) row.outcome = `${state.retirement.kind}-retired`;
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
          } : offline ? undefined : continuation?.onReady,
          watch ? () => { stopped ??= "prior-admission-failed"; } : undefined).then((value) => {
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
    return groups.some((g) => ["pending", "deferred"].includes(g.outcome)) ? 3 : groups.some((g) => ["terminal-incomplete", "unused-retired", "setup-failed-retired", "native-failed-retired", "create-errored"].includes(g.outcome)) ? 1 : 0;
  } catch (error) {
    if (error?.controlTreeUncertain || error?.controlUncertain) uncertain = true;
    if (preIntentStage) preIntentFailures?.set(error, preIntentStage);
    throw error;
  } finally {
    if (ownsLock && !uncertain) {
      physical(root); assert.equal(regular(lock, 1024 * 1024).toString(), owner, "fleet-lock-changed");
      unlinkSync(lock); syncDirectory(root);
    }
  }
}

export async function fleetCli(args, { writeError = console.error, ...deps } = {}) {
  const signals = productionSignals();
  // Keep the original exception for uncertainty and cleanup. A replacement
  // error from cleanup must not inherit the failed check's label.
  const preIntentFailures = new Map();
  try { return await fleetMain(args, { ...deps, interrupted: signals.interrupted }, preIntentFailures); }
  catch (error) {
    const placement = placementFailures.get(error);
    if (placement) {
      const { stage, refusal, closeFailed, uncertain } = placement;
      writeError(`fleet-placement-preflight-failed: ${stage}` +
        (refusal ? `; ${refusal.code}${refusal.httpStatus ? ` (HTTP ${refusal.httpStatus})` : ""}` : "") +
        (closeFailed ? "; transport-close-failed" : "") + (uncertain ? "; custody-uncertain" : ""));
    } else {
      const stage = preIntentFailures.get(error);
      writeError(stage ? `fleet-operation-failed: ${stage}` : "fleet-operation-failed");
    }
    return 2;
  }
  finally { signals.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  fleetCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
