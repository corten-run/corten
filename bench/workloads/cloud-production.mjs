// Operator-gated production composition. No provider or state operations on import.
import assert from "node:assert/strict";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { benchPackagePaths, controller, publicError } from "./droplet.mjs";
import { digest, regular, resolveStateRoot } from "./cloud-local.mjs";
import { controllerState, full, parseDropletArgs, providerFailure, unsentDelete } from "./cloud-options.mjs";
import { controlCheckpoint, shellTransport } from "./cloud-transport.mjs";
import { sourceUrl } from "./cloud-remote.mjs";
import { fleetCreateMode, requireStagedFleet, stagedFleet } from "./cloud-contract.mjs";
import { providerFiles, providerTransport } from "./cloud-provider.mjs";
import { failedNativePolicy, failedNativeRoots, groupedPreplanFailure, launchHostKey, settledBootstrap, unusedBootstrap } from "./cloud-retirement.mjs";
import { mixedWait, ownedMixedWait, verifyMixedSignal } from "./cloud-cancellation.mjs";
import { localCompiler, localCompilerMissing } from "./cloud-validation-snapshot.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { ownedR21, r21Validator } from "./cloud-sealed-collection.mjs";
import { continuationIndexSha256, readFleet, readGroup, readLaunchIntent, readRemainingIntent,
  recheckContinuationPeers, recheckIndexedLaunchCustody } from "./fleet-verify.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const controllerPaths = ["droplet.mjs", "cloud-contract.mjs", "cloud-options.mjs", "cloud-local.mjs", "cloud-audit.mjs", "cloud-cancellation.mjs", "cloud-validation.mjs", "cloud-validation-worker.mjs", "cloud-validation-snapshot.mjs", "cloud-transport.mjs", "cloud-provider.mjs", "cloud-provider-engine.mjs", "cloud-provider-worker.mjs", "cloud-remote.mjs", "cloud-retirement.mjs", "cloud-production.mjs", "fleet.mjs", "fleet-verify.mjs", "fleet-worker.mjs",
  "cloud-control-runtime.mjs", "cloud-control-session.mjs", "cloud-control-stream.mjs", "cloud-sealed-collection.mjs", "isolated/control-admission.mjs",
  "isolated/control-session-source.mjs", "isolated/control-stream-source.mjs", "isolated/control-stream.mjs", "isolated/host-observation.mjs", "isolated/native-roles.mjs",
  "../hardening/plan.mjs", "../hardening/bounded-requests.mjs", "../hardening/dependency-recovery-contract.mjs",
  "deployments.mjs", "../marketplace/feature-contract.mjs", "../marketplace/run-contract.mjs", "../marketplace/groups.mjs",
  "../fullstack/conformance.mjs"].map((p) => posix.normalize(`bench/workloads/${p}`));
export const nativePaths = ["campaign-entry.mjs", "campaign-verify.mjs", "campaign-contract.mjs", "campaign-journal.mjs", "campaign.mjs", "contract.mjs", "worker.mjs", "process.mjs", "evidence.mjs", "host-observation.mjs", "json-staging.mjs", "mixed-staging.mjs", "composition.mjs", "native-replay.mjs", "host-lifetime.mjs", "bootstrap.mjs", "raw-support.mjs"].map((p) => `bench/workloads/isolated/${p}`);
const policyPaths = [...new Set([...controllerPaths, ...providerFiles.map((name) => posix.normalize(`bench/workloads/${name}`)), "bench/json-api/contract.mjs", "bench/workloads/registry.mjs"])];
const loadedSources = new Map(policyPaths.map((path) => [path, regular(join(checkout, path), 1024 * 1024).toString("utf8").replaceAll("\r\n", "\n")]));
export function parseProductionArgs(args) {
  let approval, preview = false; const core = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--approve-reviewed-merged-ready") {
      assert.equal(approval, undefined); approval = full(args[++i], /[a-f0-9]{64}/, "exact operator-approved action required");
    } else if (args[i] === "--print-approval") { assert.equal(preview, false); preview = true; }
    else core.push(args[i]);
  }
  assert.ok(!(approval && preview), "preview cannot execute");
  return { options: parseDropletArgs(core), approval, preview };
}

async function launchRoles({ round, commit, group, mode }, interrupted) {
  return inspectCampaign({ action: "actor-role-preflight", round, commit, group: group ?? null, mode: mode ?? null }, { interrupted });
}

// compiler and roleCheck are synthetic TEST seams, never CLI options.
export async function productionPlan(options, { repo = checkout, run, compiler = localCompiler, roleCheck = launchRoles,
  interrupted, remainingPlacement } = {}) {
  // All checks here are local/read-only. Missing integration stays visible, not imported.
  repo = realpathSync(repo);
  assert.ok(!/["$%\r\n\0]/.test(options.stateDir), "SSH config expansion in state path refused");
  const physicalRequest = resolveStateRoot(options.stateDir);
  assert.ok(!/["$%\r\n\0]/.test(physicalRequest), "SSH config expansion in state path refused");
  assert.equal(realpathSync((await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim()), repo);
  const head = full((await run("git", ["rev-parse", "HEAD"])).stdout.trim(), /[a-f0-9]{40}/, "controller commit");
  assert.equal((await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout, "", "clean controller source required");
  for (const path of policyPaths) {
    // Git's committed bytes, with checkout CRLF normalized, must be this controller.
    const committed = (await run("git", ["show", `${head}:${path}`])).stdout;
    assert.equal(loadedSources.get(path), committed, "loaded controller differs from approved source");
  }
  let mode;
  const missing = [];
  for (const path of nativePaths)
    if ((await run("git", ["cat-file", "-e", `${head}:${path}`], 60000, true)).status !== 0) missing.push(path);
  // Seen before the reservation is saved: the launched job installs the bench package.
  if (options.detach) for (const path of benchPackagePaths)
    if ((await run("git", ["cat-file", "-e", `${head}:${path}`], 60000, true)).status !== 0) missing.push(path);
  // Native replay (ordinary collection, and so a launch's) reads this checkout's bench compiler.
  if ((options.detach || options.collect && options.unusedBootstrapKnownHosts === undefined && !options.r21MeasuredCheckout) && !compiler()) missing.push(localCompilerMissing);
  let reservationSha256 = null, deliverySha256 = null, fleetSha256, recovery, launchHostKeySha256;
  if (options.group !== undefined) {
    const bytes = regular(resolve(options.fleet), 1024 * 1024), fleet = requireStagedFleet(JSON.parse(bytes));
    assert.equal(fleet.round, options.round); assert.equal(fleet.commit, head); assert.equal(fleet.sshKey, options.sshKey);
    assert.deepEqual(fleet.provider, { accountId: options.accountId, context: options.context });
    fleetSha256 = digest(bytes);
    const stagedSibling = options.group !== fleet.jobs[0].group;
    assert.equal(remainingPlacement !== undefined, stagedSibling, "v5 sibling requires the staged remaining placement");
    const root = dirname(resolve(options.fleet)), current = readFleet(root, options.round);
    assert.equal(resolve(options.fleet), current.path);
    assert.equal(physicalRequest, join(root, options.group));
    assert.equal(current.manifestSha256, fleetSha256);
    mode = fleetCreateMode(options.group, fleet, remainingPlacement?.region);
  }
  if (options.detach) {
    assert.equal(options.commit, head, "launch must measure the approved controller source");
    if (!missing.length) missing.push(...await roleCheck({ round: options.round, commit: head, group: options.group, mode }, interrupted));
  }
  else {
    const bytes = regular(join(physicalRequest, `groups-${options.round}`, "state.json"), 1024 * 1024);
    const saved = controllerState(JSON.parse(bytes), options.round);
    if (stagedFleet(saved.fleet)) {
      const fleet = readFleet(dirname(physicalRequest), options.round), job = readGroup(fleet, saved.group);
      assert.equal(job.stateRoot, physicalRequest); assert.equal(job.stateSha256, digest(bytes));
    }
    if (options.r21MeasuredCheckout) {
      ownedR21(saved);
      assert.notEqual(head, saved.commit); await run("git", ["merge-base", "--is-ancestor", saved.commit, head]);
      assert.equal((await run("git", ["-C", options.r21MeasuredCheckout, "rev-parse", "HEAD"])).stdout.trim(), saved.commit);
      assert.equal((await run("git", ["-C", options.r21MeasuredCheckout, "status", "--porcelain", "--untracked-files=all"])).stdout, "");
      (await r21Validator(options.r21MeasuredCheckout)).captureValidation(saved.commit);
      const local = join(physicalRequest, "groups-r21"), key = regular(join(local, "known_hosts"), 1024 * 1024);
      assert.ok(key.length); if (saved.archiveSha256) assert.equal(saved.archiveSha256, options.exitArchiveSha256);
      const { stagedChildIntent } = await import("./fleet.mjs");
      const { sealedMonitor } = await import("./cloud-control-stream.mjs");
      const { terminal } = sealedMonitor(local, saved);
      recovery = { measuredCommit: saved.commit, group: saved.group, hostId: saved.id, ip: saved.ip, unit: saved.unit,
        fleetSha256: saved.fleet.fleetSha256, intent: stagedChildIntent(physicalRequest, saved), knownHostsSha256: digest(key),
        registrationSha256: saved.control.monitor.registrationSha256, sealSha256: terminal.sealSha256, campaign: terminal.campaign,
        archiveSha256: options.exitArchiveSha256, policy: "collect-one-sealed-exit-archive-with-measured-replay" };
    } else if (options.unusedBootstrapKnownHosts !== undefined) {
      const settled = settledBootstrap(saved, join(physicalRequest, `groups-${options.round}`));
      assert.ok(settled || unusedBootstrap(saved), "unused bootstrap requires no dispatch or only an unacknowledged first SSH no-op, unless the upload prefix is settled");
      if (settled) assert.equal(saved.commit, head, "settled uploads require the measured checkout");
      else if (saved.commit !== head) await run("git", ["merge-base", "--is-ancestor", saved.commit, head]);
      const key = regular(options.unusedBootstrapKnownHosts, 1024 * 1024);
      assert.ok(key.length, "verified host key required");
      recovery = { measuredCommit: saved.commit, hostId: saved.id, ip: saved.ip, knownHostsSha256: digest(key),
        policy: settled ? "settled-uploads-unused-only-no-qualification" : "first-ssh-unused-only-no-qualification" };
    } else if (options.cancelMixedWait) {
      ownedMixedWait(saved); assert.equal(saved.status, "running");
      for (const key of ["mixedCancellation", "archiveSha256", "evidence", "deletionIntentAt", "collectedAt"]) assert.equal(saved[key], undefined);
      for (const name of ["mixed-cancel-reservation.json", "mixed-cancel-intent.json", "mixed-cancel-signal.json"])
        assert.ok(!existsSync(join(physicalRequest, `groups-${options.round}`, name)), "prior cancellation attempt requires custody, never another signal");
      assert.notEqual(head, saved.commit); await run("git", ["merge-base", "--is-ancestor", saved.commit, head]);
      recovery = { measuredCommit: saved.commit, wait: mixedWait, policy: "one-owned-mixed-wait-cancel-no-audit-no-delete" };
    } else if (options.retireFailedNative) {
      assert.notEqual(saved.commit, head, "merged repair controller required");
      await run("git", ["merge-base", "--is-ancestor", saved.commit, head]);
      const local = join(physicalRequest, `groups-${options.round}`);
      if (stagedFleet(saved.fleet) && saved.fleet.single) {
        // A successor must use the launch's output paths and generated remote job.
        for (const path of ["bench/workloads/registry.mjs", "bench/workloads/cloud-contract.mjs", "bench/workloads/cloud-remote.mjs"])
          assert.ok((await run("git", ["show", `${saved.commit}:${path}`])).stdout === loadedSources.get(path),
            "measured group layout or remote job differs");
        assert.ok(saved.fullGroupQualified === false && !saved.collectedAt && !saved.validation && !saved.evidenceOutcome,
          "only unqualified failure evidence can retire");
        const grouped = groupedPreplanFailure(local, saved);
        // A refused custody probe can append a settled collection ledger row
        // without replacing the original reservation. Approve both byte sets.
        const original = join(local, "failed-native-reservation.json");
        const preservedReservationSha256 = digest(lstatSync(original, { throwIfNoEntry: false })
          ? regular(original, 1024 * 1024) : bytes);
        const { stagedChildIntent } = await import("./fleet.mjs");
        recovery = { policy: "grouped-preplan-failure-custody-only", measuredCommit: saved.commit, hostId: saved.id,
          preservedReservationSha256,
          group: saved.group, unit: saved.unit, archiveSha256: saved.archiveSha256, evidenceSha256: saved.evidenceSha256,
          launchHostKeySha256: saved.launchHostKeySha256, bootId: grouped.host.bootId, roots: grouped.roots,
          intent: stagedChildIntent(physicalRequest, saved), fleetSha256: saved.fleet.fleetSha256 };
      } else {
        const roots = failedNativeRoots(saved);
        if (saved.group === "mixed-production") verifyMixedSignal(local, saved);
        else assert.ok(saved.archiveSha256 && saved.evidenceSha256 && saved.evidence && saved.fullGroupQualified === false, "preserved failed evidence required");
        recovery = { measuredCommit: saved.commit, archiveSha256: saved.archiveSha256, evidenceSha256: saved.evidenceSha256, roots,
          policy: failedNativePolicy(saved) };
      }
    } else {
      assert.equal(saved.commit, head, "current native verifier needs the measured integrated checkout");
      if (options.collect && saved.launchHostKeySha256 !== undefined) {
        launchHostKey(join(physicalRequest, `groups-${options.round}`), saved);
        launchHostKeySha256 = saved.launchHostKeySha256;
      }
    }
    reservationSha256 = digest(bytes);
  }
  if (options.deliverAudit) deliverySha256 = digest(regular(resolve(options.deliverAudit), 16 * 1024 ** 2));
  assert.equal(resolveStateRoot(options.stateDir), physicalRequest, "state root changed during approval");
  const subject = { action: options.detach ? "detach" : options.collect ? "collect" : options.cancelMixedWait ? "cancel-mixed-wait" : options.retireFailedNative ? "retire-failed-native" : "deliver-audit", controllerCommit: head,
    options, stateRoot: physicalRequest, reservationSha256, deliverySha256, ...(fleetSha256 ? { fleetSha256 } : {}),
    ...(launchHostKeySha256 ? { launchHostKeySha256 } : {}),
    ...(remainingPlacement === undefined ? {} : { remainingPlacement }),
    ...(recovery ? { recovery } : {}),
    declaration: options.unusedBootstrapKnownHosts !== undefined
      ? "operator-confirmed-original-local-process-tree-gone-and-exact-host-key-verified-for-unused-bootstrap-retirement-only"
      : options.cancelMixedWait ? "operator-approved-after-merged-independent-review-for-one-owned-mixed-wait-cancellation-not-audit-or-delete"
      : options.r21MeasuredCheckout ? "operator-approved-after-merged-independent-review-for-one-sealed-child-collection"
      : recovery ? "operator-approved-after-merged-independent-review-for-failed-native-custody-and-terminal-retirement-not-a-baseline"
      : "operator-approved-after-merged-independent-review-and-full-native-readiness" };
  return { subject, approvalSha256: digest(JSON.stringify(subject)), missing };
}

export async function productionMain(args, { spawn, streamSpawn, providerFactory = providerTransport, repo = checkout, inspect, sleep, interrupted = () => false, write = console.log, compiler, roleCheck, remainingAdmission = false } = {}) {
  const { options, approval, preview } = parseProductionArgs(args);
  const processRun = shellTransport({ repo, spawn, streamSpawn });
  // Construct the legacy/recovery transport at the original boundary. It
  // starts its worker only on the first authorized provider operation.
  let providerRun = options.group === undefined
    ? providerFactory({ repo, interrupted, createMode: options.detach ? "legacy" : null }) : undefined;
  let stage = "source-plan";
  const mark = (error, value) => {
    // Keep the original internal failure and uncertainty flags. Only this closed
    // phase value may cross the worker boundary, never its message or arguments.
    if (error && typeof error === "object") {
      try { Object.defineProperty(error, "controllerStage", { value, configurable: true }); }
      catch {
        const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
        const wrapped = new Error(typeof message === "string" ? message : "controller operation failed", { cause: error });
        wrapped.controllerStage = value;
        for (const flag of ["controlTreeUncertain", "controlUncertain"])
          if (Object.getOwnPropertyDescriptor(error, flag)?.value === true) wrapped[flag] = true;
        const diagnostic = providerFailure(error);
        if (diagnostic) wrapped.providerDiagnostic = diagnostic;
        return wrapped;
      }
    }
    return error;
  };
  try {
  const run = async (...args) => {
    const fencedDelete = args[0] === "doctl" && args[1][2] === "delete" && args[3] && args[4] !== undefined;
    try { await controlCheckpoint(interrupted); } catch (error) {
      if (fencedDelete) return unsentDelete; // This invocation never reached the provider.
      throw error;
    }
    let result, failure;
    try { result = args[0] === "doctl" ? await providerRun(...args.slice(1)) : await processRun(...args); } catch (error) { failure = error; }
    // Hand custody back before cancellation: take the stream handle, record
    // the acknowledged command exit, or clear a positively unsent DELETE.
    if (args[5]?.stream && result?.monitor || args[5]?.request && result || fencedDelete && result?.deleteNotDispatched === true) return result;
    try { await controlCheckpoint(interrupted); }
    catch (error) { if (!failure?.controlTreeUncertain && !failure?.controlUncertain) throw error; }
    if (failure) throw failure;
    return result;
  };
  const manifest = options.group === undefined ? undefined
    : requireStagedFleet(JSON.parse(regular(resolve(options.fleet), 1024 * 1024)));
  const stagedSibling = manifest && options.group !== manifest.jobs[0].group;
  const readAdmission = () => {
    const fleet = readFleet(dirname(resolve(options.fleet)), options.round);
    assert.deepEqual(fleet.manifest, manifest);
    const intent = stagedSibling ? readRemainingIntent(fleet) : readLaunchIntent(fleet);
    const lock = JSON.parse(regular(join(fleet.root, ".fleet-operation.lock"), 1024));
    assert.deepEqual(lock, { pid: process.pid, approvalSha256: intent.approvalSha256 }, "fleet launch requires the active batch lock");
    if (manifest.single) {
      const root = dirname(fleet.root), { indexSha256, group } = manifest.single;
      assert.equal(intent.subject.continuation?.indexSha256, indexSha256, "continuation approval required");
      assert.equal(continuationIndexSha256(root), indexSha256, "continuation index changed");
      assert.deepEqual(JSON.parse(regular(join(root, ".continuation-operation.lock"), 1024)), { pid: process.pid, group },
        "group launch requires the active continuation lock");
    }
    if (stagedSibling) {
      const first = readGroup(fleet, intent.placement.firstGroup.group);
      assert.equal(first.outcome, "available");
      assert.equal(first.state.status, "collected"); assert.ok(first.state.destroyedAt);
      assert.equal(first.stateSha256, intent.placement.firstGroup.stateSha256, "catalog state changed after remaining admission");
    }
    return { ...intent, fleetRoot: fleet.root };
  };
  if (stagedSibling) assert.ok(remainingAdmission, "only fleet admission may launch a v5 sibling");
  const admission = manifest && !preview ? readAdmission() : undefined;
  const unconfirmed = manifest?.single ? admission?.subject.continuation.unconfirmed ?? [] : [];
  const historicalIds = new Set(unconfirmed.map(({ accountId, id }) => {
    assert.equal(accountId, manifest.provider.accountId, "historical custody requires the same provider account");
    return full(id, /[1-9]\d*/, "historical custody requires a bound host ID");
  }));
  let historicalHostsAbsent;
  const deps = { repo, run, compiler, roleCheck, interrupted, remainingPlacement: admission?.placement };
  const plan = await productionPlan(options, deps);
  if (preview) {
    write(JSON.stringify({ action: plan.subject.action, controllerCommit: plan.subject.controllerCommit, round: options.round,
      ...(plan.subject.launchHostKeySha256 ? { launchHostKeySha256: plan.subject.launchHostKeySha256 } : {}),
      ...(plan.subject.recovery ? { recovery: plan.subject.recovery, reservationSha256: plan.subject.reservationSha256 } : {}),
      ...(options.unusedBootstrapKnownHosts !== undefined ? { declaration: plan.subject.declaration } : {}),
      approvalSha256: plan.approvalSha256, missing: plan.missing, fullGroupQualified: false }));
    return plan.missing.length ? 2 : 3; // Preview is never qualified execution success.
  }
  stage = "exact-approval";
  assert.equal(approval, plan.approvalSha256, "explicit operator-approved exact action required");
  const checkFleetAdmission = admission && ((beforeCreate = false) => {
    const current = readAdmission(), job = current.subject.jobs.find(({ group }) => group === options.group);
    assert.equal(current.sha256, admission.sha256, "fleet admission changed");
    assert.equal(current.subject.manifestSha256, plan.subject.fleetSha256);
    assert.equal(job.approvalSha256, approval, "child approval differs from consumed fleet admission");
    assert.deepEqual(job.subject, plan.subject);
    if (beforeCreate && manifest.single) {
      if (historicalIds.size) assert.equal(historicalHostsAbsent, true, "unconfirmed historical host not proved absent from the account census");
      const root = dirname(current.fleetRoot), { indexSha256, indexedCustody, peers } = current.subject.continuation;
      const currentPeers = recheckContinuationPeers(root, indexSha256, manifest.provider, options.group, peers);
      if (beforeCreate === true) recheckIndexedLaunchCustody(root, indexSha256, indexedCustody);
      return currentPeers;
    }
  });
  checkFleetAdmission?.();
  assert.deepEqual(plan.missing, [], "native campaign integration missing; do not allocate");
  assert.ok(!interrupted(), "cancelled before approval");
  // Each parallel controller observes main independently, but must not race a
  // shared reference or FETCH_HEAD. Fetch only that exact advertised object.
  stage = "remote-main-advertisement";
  const advertisement = (await run("git", ["ls-remote", "--exit-code", "--refs", sourceUrl, "refs/heads/main"], 120000)).stdout;
  full(advertisement, /[a-f0-9]{40}\trefs\/heads\/main\n/, "remote main advertisement unavailable or ambiguous");
  const remoteHead = advertisement.slice(0, 40);
  stage = "remote-main-fetch";
  await run("git", ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", sourceUrl, remoteHead], 120000);
  stage = "remote-main-ancestry";
  await run("git", ["merge-base", "--is-ancestor", plan.subject.controllerCommit, remoteHead]);
  stage = "source-recheck";
  const repeated = await productionPlan(options, deps);
  assert.equal(repeated.approvalSha256, approval, "source/state/delivery changed after approval");
  assert.deepEqual(repeated.missing, []);
  if (options.group !== undefined) {
    const bytes = regular(resolve(options.fleet), 1024 * 1024);
    assert.equal(digest(bytes), plan.subject.fleetSha256, "approved fleet bytes changed");
    providerRun = providerFactory({ repo, interrupted, createMode: fleetCreateMode(options.group,
      requireStagedFleet(JSON.parse(bytes)), admission?.placement?.region) });
  }
  let entered = false;
  const authorizeLocked = async () => {
    assert.ok(!interrupted(), "cancelled before provider access");
    const locked = await productionPlan(options, deps);
    assert.equal(locked.approvalSha256, approval, "locked action changed after approval");
    // The approval hash excludes missing inputs, such as a bench install removed since the recheck.
    assert.deepEqual(locked.missing, [], "native campaign integration missing; do not allocate");
    checkFleetAdmission?.();
    return locked.subject;
  };
  const authorizedRun = async (binary, argv, timeout, allowFail, deleteProofExpiresAtMs, registration) => {
    if (binary !== "git" && !entered) {
      // The core now holds its exclusive lock. Bind approval to the state it read,
      // not a snapshot that a different collector could have changed meanwhile.
      await authorizeLocked();
      entered = true;
    }
    const result = await run(binary, argv, timeout, allowFail, deleteProofExpiresAtMs, registration);
    // Use the controller's complete, account-bracketed pre-create list, not
    // just the rows that still carry their original benchmark name or tags.
    if (historicalIds.size && historicalHostsAbsent === undefined && binary === "doctl"
        && argv[0] === "compute" && argv[1] === "droplet" && argv[2] === "list") {
      const rows = JSON.parse(result.stdout);
      assert.ok(Array.isArray(rows));
      historicalHostsAbsent = !rows.some(({ id }) => historicalIds.has(String(id)));
    }
    return result;
  };
  stage = "controller-construction";
  const task = controller({ ...options, stateDir: plan.subject.stateRoot }, { run: authorizedRun, repo, inspect, sleep, interrupted,
    mergedHead: remoteHead, settle: () => providerRun.close(), authorizeAudit: authorizeLocked, approvedFleetSha256: plan.subject.fleetSha256, remainingAdmission,
    ...(admission ? { checkFleetAdmission, ...(stagedSibling
      ? { remainingPlacement: { region: admission.placement.region, intentSha256: admission.sha256 } } : {}) } : {}),
    ...(options.unusedBootstrapKnownHosts === undefined ? {} : { unusedBootstrapApproval: {
      reservationSha256: plan.subject.reservationSha256, knownHostsSha256: plan.subject.recovery.knownHostsSha256,
    } }), ...(options.retireFailedNative || options.cancelMixedWait || options.r21MeasuredCheckout ? {
      recoveryApproval: { controllerCommit: plan.subject.controllerCommit, reservationSha256: plan.subject.reservationSha256,
        ...(options.r21MeasuredCheckout || plan.subject.recovery?.policy === "grouped-preplan-failure-custody-only" ? plan.subject.recovery : {}) },
    } : {}) });
  let result;
  stage = options.detach ? "controller-launch" : options.collect ? "controller-collect" : options.cancelMixedWait ? "controller-cancellation" : options.retireFailedNative ? "controller-retirement" : "controller-audit";
  if (options.detach) { await task.launch(); result = 3; }
  else result = options.collect ? await task.collect() : options.cancelMixedWait ? await task.cancelMixedWait() : options.retireFailedNative ? await task.retireFailedNative() : await task.deliverAudit();
  stage = "controller-checkpoint";
  await controlCheckpoint(interrupted);
  return result;
  } catch (error) { throw mark(error, stage); }
  finally {
    try { await providerRun?.close(); }
    catch (error) { throw mark(error, "provider-settlement"); }
  }
}

export function productionSignals() {
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const names = ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];
  for (const name of names) process.on(name, cancel);
  return { interrupted: () => cancelled, close() { for (const name of names) process.off(name, cancel); } };
}
export async function productionCli(args) {
  const signals = productionSignals();
  try { return await productionMain(args, { interrupted: signals.interrupted }); }
  catch (error) { console.error(publicError(error)); return 2; }
  finally { signals.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  productionCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
