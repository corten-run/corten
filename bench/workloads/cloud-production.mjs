// Operator-gated production composition. No provider or state operations on import.
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { controller, publicError } from "./droplet.mjs";
import { digest, regular, resolveStateRoot } from "./cloud-local.mjs";
import { controllerState, full, parseDropletArgs, providerFailure } from "./cloud-options.mjs";
import { controlCheckpoint, shellTransport } from "./cloud-transport.mjs";
import { sourceUrl } from "./cloud-remote.mjs";
import { fleetCreateMode, validateLaunchFleet } from "./cloud-contract.mjs";
import { providerFiles, providerTransport } from "./cloud-provider.mjs";
import { failedNativePolicy, failedNativeRoots, settledBootstrap, unusedBootstrap } from "./cloud-retirement.mjs";
import { mixedWait, ownedMixedWait, verifyMixedSignal } from "./cloud-cancellation.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const controllerPaths = ["droplet.mjs", "cloud-contract.mjs", "cloud-options.mjs", "cloud-local.mjs", "cloud-audit.mjs", "cloud-cancellation.mjs", "cloud-validation.mjs", "cloud-validation-worker.mjs", "cloud-validation-snapshot.mjs", "cloud-transport.mjs", "cloud-provider.mjs", "cloud-provider-engine.mjs", "cloud-provider-worker.mjs", "cloud-remote.mjs", "cloud-retirement.mjs", "cloud-production.mjs", "fleet.mjs", "fleet-verify.mjs", "fleet-worker.mjs",
  "cloud-control-runtime.mjs", "cloud-control-session.mjs", "cloud-control-stream.mjs", "isolated/control-admission.mjs",
  "isolated/control-session-source.mjs", "isolated/control-stream-source.mjs", "isolated/control-stream.mjs", "isolated/host-observation.mjs",
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

export async function productionPlan(options, { repo = checkout, run } = {}) {
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
  const missing = [];
  for (const path of nativePaths)
    if ((await run("git", ["cat-file", "-e", `${head}:${path}`], 60000, true)).status !== 0) missing.push(path);
  let reservationSha256 = null, deliverySha256 = null, fleetSha256, recovery;
  if (options.group !== undefined) {
    const bytes = regular(resolve(options.fleet), 1024 * 1024), fleet = validateLaunchFleet(JSON.parse(bytes));
    assert.equal(fleet.round, options.round); assert.equal(fleet.commit, head); assert.equal(fleet.sshKey, options.sshKey);
    assert.deepEqual(fleet.provider, { accountId: options.accountId, context: options.context });
    fleetSha256 = digest(bytes);
  }
  if (options.detach) assert.equal(options.commit, head, "launch must measure the approved controller source");
  else {
    const bytes = regular(join(physicalRequest, `groups-${options.round}`, "state.json"), 1024 * 1024);
    const saved = controllerState(JSON.parse(bytes), options.round);
    if (options.unusedBootstrapKnownHosts !== undefined) {
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
      const roots = failedNativeRoots(saved);
      assert.notEqual(saved.commit, head, "merged repair controller required");
      await run("git", ["merge-base", "--is-ancestor", saved.commit, head]);
      if (saved.group === "mixed-production") verifyMixedSignal(join(physicalRequest, `groups-${options.round}`), saved);
      else assert.ok(saved.archiveSha256 && saved.evidenceSha256 && saved.evidence && saved.fullGroupQualified === false, "preserved failed evidence required");
      recovery = { measuredCommit: saved.commit, archiveSha256: saved.archiveSha256, evidenceSha256: saved.evidenceSha256, roots,
        policy: failedNativePolicy(saved) };
    } else assert.equal(saved.commit, head, "current native verifier needs the measured integrated checkout");
    reservationSha256 = digest(bytes);
  }
  if (options.deliverAudit) deliverySha256 = digest(regular(resolve(options.deliverAudit), 16 * 1024 ** 2));
  assert.equal(resolveStateRoot(options.stateDir), physicalRequest, "state root changed during approval");
  const subject = { action: options.detach ? "detach" : options.collect ? "collect" : options.cancelMixedWait ? "cancel-mixed-wait" : options.retireFailedNative ? "retire-failed-native" : "deliver-audit", controllerCommit: head,
    options, stateRoot: physicalRequest, reservationSha256, deliverySha256, ...(fleetSha256 ? { fleetSha256 } : {}),
    ...(recovery ? { recovery } : {}),
    declaration: options.unusedBootstrapKnownHosts !== undefined
      ? "operator-confirmed-original-local-process-tree-gone-and-exact-host-key-verified-for-unused-bootstrap-retirement-only"
      : options.cancelMixedWait ? "operator-approved-after-merged-independent-review-for-one-owned-mixed-wait-cancellation-not-audit-or-delete"
      : recovery ? "operator-approved-after-merged-independent-review-for-failed-native-custody-and-terminal-retirement-not-a-baseline"
      : "operator-approved-after-merged-independent-review-and-full-native-readiness" };
  return { subject, approvalSha256: digest(JSON.stringify(subject)), missing };
}

export async function productionMain(args, { spawn, streamSpawn, providerFactory = providerTransport, repo = checkout, inspect, sleep, interrupted = () => false, write = console.log } = {}) {
  const { options, approval, preview } = parseProductionArgs(args);
  const processRun = shellTransport({ repo, spawn, streamSpawn });
  const createMode = options.detach ? options.group === undefined ? "legacy" : fleetCreateMode(options.group) : null;
  const providerRun = providerFactory({ repo, interrupted, createMode });
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
    await controlCheckpoint(interrupted);
    let result, failure;
    try { result = args[0] === "doctl" ? await providerRun(...args.slice(1)) : await processRun(...args); } catch (error) { failure = error; }
    // The controller performs this post-command checkpoint after taking the
    // registered handle. Throwing here would orphan a live SSH stream.
    if (args[5]?.stream && result?.monitor) return result;
    try { await controlCheckpoint(interrupted); }
    catch (error) { if (!failure?.controlTreeUncertain && !failure?.controlUncertain) throw error; }
    if (failure) throw failure;
    return result;
  };
  const plan = await productionPlan(options, { repo, run });
  if (preview) {
    write(JSON.stringify({ action: plan.subject.action, controllerCommit: plan.subject.controllerCommit, round: options.round,
      ...(plan.subject.recovery ? { recovery: plan.subject.recovery, reservationSha256: plan.subject.reservationSha256 } : {}),
      ...(options.unusedBootstrapKnownHosts !== undefined ? { declaration: plan.subject.declaration } : {}),
      approvalSha256: plan.approvalSha256, missing: plan.missing, fullGroupQualified: false }));
    return plan.missing.length ? 2 : 3; // Preview is never qualified execution success.
  }
  stage = "exact-approval";
  assert.equal(approval, plan.approvalSha256, "explicit operator-approved exact action required");
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
  const repeated = await productionPlan(options, { repo, run });
  assert.equal(repeated.approvalSha256, approval, "source/state/delivery changed after approval");
  assert.deepEqual(repeated.missing, []);
  let entered = false;
  const authorizeLocked = async () => {
    assert.ok(!interrupted(), "cancelled before provider access");
    const locked = await productionPlan(options, { repo, run });
    assert.equal(locked.approvalSha256, approval, "locked action changed after approval");
    return locked.subject;
  };
  const authorizedRun = async (binary, argv, timeout, allowFail, deleteProofExpiresAtMs, registration) => {
    if (binary !== "git" && !entered) {
      // The core now holds its exclusive lock. Bind approval to the state it read,
      // not a snapshot that a different collector could have changed meanwhile.
      await authorizeLocked();
      entered = true;
    }
    return run(binary, argv, timeout, allowFail, deleteProofExpiresAtMs, registration);
  };
  stage = "controller-construction";
  const task = controller({ ...options, stateDir: plan.subject.stateRoot }, { run: authorizedRun, repo, inspect, sleep, interrupted,
    mergedHead: remoteHead, settle: () => providerRun.close(), authorizeAudit: authorizeLocked, approvedFleetSha256: plan.subject.fleetSha256,
    ...(options.unusedBootstrapKnownHosts === undefined ? {} : { unusedBootstrapApproval: {
      reservationSha256: plan.subject.reservationSha256, knownHostsSha256: plan.subject.recovery.knownHostsSha256,
    } }), ...(options.retireFailedNative || options.cancelMixedWait ? {
      recoveryApproval: { controllerCommit: plan.subject.controllerCommit, reservationSha256: plan.subject.reservationSha256 },
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
    try { await providerRun.close(); }
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
