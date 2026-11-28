// Reviewed all-nine lifecycle. Production transport is composed only by the gated CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFleetCensus, bootstrapWorkspaceScript, canSkipHostChromium, fleetCatalogCommand, fleetRegion, installBenchmarkUnit, ownedDroplet, reservation, rootManagerCheckSeconds, rootManagerDrainSeconds, stagedFleet, tags, terminalUnit, validateLaunchFleet } from "./cloud-contract.mjs";
import { bootstrapMarker, bootstrapReadScript, remoteFiles } from "./cloud-remote.mjs";
import { archiveLimit, archiveMembers, digest, discardPublicationStage, durable, durableCopy, durableNew, evidenceFileIdentity, extractArchive, fileHash, physical, regular, resolveStateRoot, syncDirectory,
  pinEvidenceTree, treeHash, verifyArchiveTree, withVerifiedArchive } from "./cloud-local.mjs";
import { absentCollectionCandidate, absentCollectionPolicy, campaignOutcome, controllerFailure, controllerState, erroredCreate, fleetCatalogResult, full, pendingCreate, providerAccount, providerFailure, unitQuery, unsentCreate, validateOptions } from "./cloud-options.mjs";
import { auditDelivery, auditProtocol, auditScript } from "./cloud-audit.mjs";
import { collectRefusal, inspectCampaign } from "./cloud-validation.mjs";
import { captureValidation, validationTask } from "./cloud-validation-snapshot.mjs";
import { idleArchiveScript, ownedR21, r21Validator, sealedUnit } from "./cloud-sealed-collection.mjs";
import { mixedCancelScript, mixedSignalObservation, mixedWait, ownedMixedWait, verifyMixedCancellation, verifyMixedSignal } from "./cloud-cancellation.mjs";
import { failedNativeArchive, failedNativeObservation, failedNativeScript, groupedFailure, groupedFailureCandidate, groupedPreplanFailure, launchHostKey, retainedInvalidOwner, setupEvidence,
  handoffLocks, handoffRetirementPolicy, pinHandoffRetirement, verifyHandoffCustody,
  exitOneEvidenceFingerprint, failedExitOneObservation, failedExitOnePolicy, verifyFailedExitOneCustody, verifyFailedExitOneRetirement,
  interruptedFirstUpload, settledBootstrap, SetupWatcherProofMissing, setupWatcherFailures, terminalSetupScript, unusedBootstrap, unusedEvidence, unusedHostScript, verifyFailedNativeCustody, verifyFailedNativeReservation, verifyFailedNativeRetirement,
  verifyUnusedEvidence, createErroredBytes, createErroredCustody, createErroredReceipt, createErroredRecord, createRecheckLock, pendingCreateErroredReceipt,
  verifyCreateErrored, offlineNeverStarted, createContradiction, contradictionStages, createReappeared, createReappearedWitness, publicationStages } from "./cloud-retirement.mjs";
import { acknowledgedBootstrapSeal, controlRequest, controlRegistration, guardianSha256 } from "./cloud-control-runtime.mjs";
import { controlCheckpoint, controlResultFailure, pinnedHostOptions } from "./cloud-transport.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function command(binary, args, timeout = 60000, allowFail = false) {
  assert.equal(binary, "git", "provisional controller: real cloud transport disabled until full readiness/review");
  const r = spawnSync(binary, args, { cwd: checkout, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 ** 2,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } });
  if (!allowFail && (r.error || r.status !== 0)) throw new Error(`${binary}: ${r.error?.code ?? r.status}`);
  return r;
}
const outside = (root, path) => { const r = relative(root, path); return isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`); };

function acquireHandoffLock(path, bytes, message = "handoff operation lock changed; preserve custody") {
  const fd = openSync(path, "wx", 0o600);
  let owned;
  try {
    writeFileSync(fd, bytes); fsyncSync(fd);
    owned = fstatSync(fd, { bigint: true });
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
  const matches = () => {
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return current?.isFile() && ["dev", "ino", "birthtimeNs", "ctimeNs", "nlink"].every(key => current[key] === owned[key]);
  };
  return () => assert.ok(matches() && regular(path, 1024).equals(bytes) && matches(), message);
}

const sameStateFile = (a, b) => ["dev", "ino", "birthtimeNs"].every(key => a[key] === b[key]);
const sameStateVersion = (a, b) => sameStateFile(a, b)
  && ["mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);
function handoffStateSnapshot(path) {
  const stat = lstatSync(path, { bigint: true }), bytes = regular(path, 1024 * 1024);
  assert.ok(sameStateVersion(stat, lstatSync(path, { bigint: true })), "handoff state changed during read");
  return { stat, bytes };
}

const createErroredStop = () => Object.assign(new Error("provider create errored; exact allocation verified absent; no DELETE or replacement create"),
  { providerDiagnostic: { code: "create-errored-absent" } });
export function controller(input, { run = command, repo = checkout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  inspect, interrupted = () => false, settle = async () => {}, mergedHead = "origin/main", now = () => Date.now(), recoveryApproval, authorizeAudit,
  authorizeRecovery = authorizeAudit, unusedBootstrapApproval, approvedFleetSha256, remainingAdmission = false, remainingPlacement, checkFleetAdmission,
  inspectPreCreateInventory, preCreateCensusTargets = [],
  renameBootstrapSeal = process.platform === "win32" ? renameSync : undefined, monotonicNow = () => performance.now(),
  createReappearedIo = { durable, rename: renameSync } } = {}) {
  const options = validateOptions(input); repo = realpathSync(repo);
  if (mergedHead !== "origin/main") full(mergedHead, /[a-f0-9]{40}/, "exact observed main commit required");
  const fleetBytes = options.group === undefined ? undefined : regular(options.fleet, 1024 * 1024);
  if (approvedFleetSha256 !== undefined) assert.equal(digest(fleetBytes), approvedFleetSha256, "approved fleet bytes changed");
  const fleet = fleetBytes && validateLaunchFleet(JSON.parse(fleetBytes));
  if (fleet) {
    assert.equal(fleet.round, options.round); assert.equal(fleet.commit, options.commit); assert.equal(fleet.sshKey, options.sshKey);
    assert.deepEqual(fleet.provider, { accountId: options.accountId, context: options.context });
  }
  if (remainingAdmission) assert.ok(options.detach && fleet && options.group !== fleet.jobs[0].group, "remaining admission requires a sibling launch");
  if (stagedFleet(fleet)) {
    assert.equal(typeof checkFleetAdmission, "function", "v5 launch requires a consumed fleet approval");
    assert.equal(remainingPlacement !== undefined, remainingAdmission);
  } else assert.equal(remainingPlacement, undefined);
  const requested = resolve(options.stateDir), physicalRequest = resolveStateRoot(requested);
  assert.ok(outside(repo, physicalRequest) && outside(physicalRequest, repo), "state and checkout must be disjoint");
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const base = realpathSync(requested); physical(base);
  const local = join(base, `groups-${options.round}`), statePath = join(local, "state.json"), archive = join(local, "results.tgz");
  const recoveryLock = "stream-recovery.lock", recheckLock = createRecheckLock, groupedPreplan = recoveryApproval?.policy === "grouped-preplan-failure-custody-only";
  const groupedHandoff = recoveryApproval?.policy === handoffRetirementPolicy;
  const groupedExitOne = recoveryApproval?.policy === failedExitOnePolicy, pinnedRetirement = groupedHandoff || groupedExitOne;
  const absenceOnly = recoveryApproval?.policy === absentCollectionPolicy;
  assert.equal(options.absentMeasuredCheckout !== undefined, absenceOnly, "production absence approval required");
  let state, preserveOperationLock = false, controlEpoch = "collection", sealing, monitor, verifyBootstrapPublication;
  let assertHandoffLock, assertHandoffCustody, handoffReceiptSha256, expectedHandoffState, afterSettle;
  // The lock this process's current locked() operation holds, while it holds it: its name
  // and a check that it is still the file this process created, unchanged. An ordinary
  // operation holds operation.lock; an invalid-monitor recovery holds stream-recovery.lock
  // and never takes the original operation.lock it finds.
  let heldLock;
  let exitOneFenceFinishedAtMs;
  const boundary = (path = local) => { physical(base); physical(path); assert.equal(dirname(path), base, "reservation left root"); };
  const check = () => { assert.ok(!interrupted(), "controller cancelled; preserve reservation/host"); boundary(); };
  const assertHandoffState = () => {
    try {
      const current = handoffStateSnapshot(statePath);
      assert.ok(current.bytes.equals(expectedHandoffState.bytes)
        && sameStateVersion(current.stat, expectedHandoffState.stat));
    } catch (cause) {
      preserveOperationLock = true;
      throw new Error("handoff reservation changed or unreadable; preserve custody", { cause });
    }
    handoffLocks(local, true);
    assertHandoffLock();
  };
  const checkHandoffDelete = (includeTrees = true) => {
    assertHandoffCustody(includeTrees);
    if (handoffReceiptSha256 !== undefined)
      assert.equal(digest(regular(join(local, "failed-native-host.json"))), handoffReceiptSha256, "failed-native retirement receipt changed");
    assertHandoffState();
  };
  const read = (path = local, round = options.round) => { boundary(path); return controllerState(JSON.parse(regular(join(path, "state.json"), 1024 * 1024)), round); };
  const stateStage = (kind, suffix) => kind ? `${statePath}.${kind}-${suffix ?? randomBytes(16).toString("hex")}.tmp` : `${statePath}.tmp`;
  const stateBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const writeState = (value, replace = renameSync, kind = value.control?.monitor?.phase === "invalid" ? "revoked" : undefined) => {
    controllerState(value, options.round);
    // An interrupted ordinary save can leave its exclusive staging file behind.
    // Never consume it or let it prevent a failure-only write under retained custody.
    const staging = stateStage(kind);
    const bytes = stateBytes(value);
    if (!pinnedRetirement) {
      durable(staging, bytes);
      replace(staging, statePath); syncDirectory(local);
      return;
    }
    // A terminal SSH acknowledgement still owns only the exact pending state
    // we wrote, not whatever appeared at the same path while SSH was in flight.
    try {
      assertHandoffState();
      const authored = Buffer.from(bytes);
      durable(staging, authored);
      const staged = handoffStateSnapshot(staging);
      assert.ok(staged.bytes.equals(authored), "handoff state stage changed");
      assertHandoffState();
      assert.ok(sameStateVersion(staged.stat, lstatSync(staging, { bigint: true })), "handoff state stage changed");
      replace(staging, statePath); syncDirectory(local);
      const published = handoffStateSnapshot(statePath);
      // Rename can advance ctime; the published file must still be our stage.
      assert.ok(sameStateFile(staged.stat, published.stat) && published.bytes.equals(authored), "handoff state publication changed");
      expectedHandoffState = { stat: published.stat, bytes: authored };
    } catch (error) {
      preserveOperationLock = true;
      throw error;
    }
  };
  // A deletion intent and destroyedAt each go through their own fresh exclusive stage
  // (save("deletion-intent"), save("destroyed")), like the checkpoints below: a save torn
  // there leaves an unread stage and the previous state.json, never a fixed-name
  // state.json.tmp that would refuse every later collect with EEXIST.
  const save = (kind) => { check(); writeState(state, renameSync, kind); };
  // The provider-errored outcome is published through its own fresh exclusive stage,
  // like the monitor-ending publications: a fixed-name state.json.tmp left by an
  // interrupted save is never read, promoted, removed or allowed to block it.
  const publishCreateErrored = (posted, bytes) => {
    check(); state.createErrored = { ...posted, evidenceSha256: digest(bytes) }; writeState(state, renameSync, "create-errored");
  };
  const offlineBootstrapAck = () => state.control.sealed.includes("bootstrap")
    && acknowledgedBootstrapSeal(state.control.ledger.filter(({ request }) => request.epoch === "bootstrap"));
  let launchPeers, recheckPriorRounds;
  // Cancellation forbids further work, not recording how the owned monitor ended.
  // Record only the ending and, if cancellation beat the live-state write,
  // the registration already received from this stream. Never adopt a file alone.
  const recordMonitorEnd = (phase, publish = writeState) => {
    const alreadyUncertain = preserveOperationLock;
    preserveOperationLock = true;
    const saved = read();
    assert.equal(saved.token, state.token);
    assert.equal(saved.control.monitor.id, state.control.monitor.id);
    if (saved.control.monitor.phase === "pending") {
      assert.equal(phase, "invalid");
      assert.equal(saved.control.monitor.registrationSha256, undefined);
      const registered = JSON.parse(regular(join(local, "monitor-registration.json")));
      assert.deepEqual(registered, monitor.registration);
      assert.equal(registered.id, saved.control.monitor.id);
      assert.deepEqual(registered.binding, { round: saved.round, commit: saved.commit, token: saved.token, helperSha256: saved.control.helperSha256 });
      saved.control.monitor.registrationSha256 = digest(JSON.stringify(registered));
    } else {
      assert.equal(saved.control.monitor.registrationSha256, state.control.monitor.registrationSha256);
      assert.equal(saved.control.monitor.phase, "live");
    }
    if (!saved.control.sealed.length && acknowledgedBootstrapSeal(saved.control.ledger)) {
      saved.control.sealed.push("bootstrap");
    }
    if (phase === "closed") assert.ok(saved.control.sealed.includes("bootstrap"), "closed monitoring requires an acknowledged bootstrap seal");
    saved.control.monitor.phase = phase; publish(saved); state = saved;
    if (phase === "closed") preserveOperationLock = alreadyUncertain;
  };
  async function execute(binary, args, timeout = 60000, allowFail = false, deleteProofExpiresAtMs, remaining, registration, beforeDelete) {
    const creating = binary === "doctl" && args[0] === "compute" && args[1] === "droplet" && args[2] === "create";
    const prepareDelete = typeof deleteProofExpiresAtMs === "object" ? deleteProofExpiresAtMs : undefined;
    if (deleteProofExpiresAtMs !== undefined) {
      assert.equal(binary, "doctl"); assert.equal(args[2], "delete");
      assert.ok(prepareDelete || Number.isSafeInteger(deleteProofExpiresAtMs));
    }
    if (beforeDelete !== undefined) assert.ok(binary === "doctl" && args[2] === "delete" && typeof beforeDelete === "function");
    const settleUnsentCreate = () => {
      try {
        boundary();
        assert.ok(creating && state.status === "creating" && state.createIntentAt && !state.id && !state.createPending);
        assert.ok(regular(statePath, 1024 * 1024).equals(Buffer.from(stateBytes(state))), "unsent create intent state changed");
        state.status = "reserved"; delete state.createIntentAt;
        writeState(state, renameSync, "create-unsent");
      } catch (cause) { preserveOperationLock = true; throw cause; }
    };
    const invoke = async (argv, permittedFailure = false, expiry, beforeDispatch) => {
      try { check(); }
      catch (error) {
        if (creating && argv[2] === "create") settleUnsentCreate();
        throw error;
      }
      const fresh = () => {
        const current = Date.now();
        assert.ok(current < expiry && expiry - current <= 60000, "current retirement proof expired");
        if (groupedExitOne) assert.ok(current >= exitOneFenceFinishedAtMs, "current retirement proof clock reversed");
      };
      const pinnedGuard = pinnedRetirement && expiry !== undefined ? () => {
        checkHandoffDelete();
        if (prepareDelete?.onUnsent) {
          const now = Date.now();
          return now >= exitOneFenceFinishedAtMs && now < expiry;
        }
        fresh();
      } : undefined;
      // A transport may await between run() and the request (production crosses a
      // cancellation checkpoint), so the caller's last check runs again in the guard
      // it calls after that await, refusing by throwing before any pinned outcome.
      const guardDispatch = beforeDispatch === undefined ? pinnedGuard
        : () => { beforeDispatch(); return pinnedGuard?.(); };
      if (expiry !== undefined) {
        if (pinnedGuard && !prepareDelete?.publishIntent) checkHandoffDelete(false);
        fresh();
      }
      let r;
      const limit = remaining ? Math.min(timeout, remaining()) : timeout;
      if (prepareDelete && expiry !== undefined) {
        assert.ok(!state.deletionIntentAt);
        if (prepareDelete.publishIntent) prepareDelete.publishIntent();
        else {
          prepareDelete.unchanged();
          state.deletionIntentAt = new Date().toISOString(); save("deletion-intent");
        }
      }
      // After the account preflight and the proof's deadline, the last local check before run().
      beforeDispatch?.();
      try { r = await run(binary, argv, limit, permittedFailure, expiry, registration, guardDispatch); }
      catch (error) { if (error.controlTreeUncertain || error.controlUncertain) preserveOperationLock = true; throw error; }
      if (r === unsentCreate) {
        assert.equal(argv[2], "create");
        settleUnsentCreate();
        assert.fail("local custody or cancellation refused create before dispatch");
      }
      if (registration?.stream && r.monitor) {
        monitor = r.monitor;
        assert.equal(monitor.registration.id, registration.expected.id);
        assert.deepEqual(monitor.registration.binding, registration.expected.binding);
        await controlCheckpoint(interrupted);
      }
      if (r.controlTreeUncertain || r.controlUncertain) { preserveOperationLock = true; throw new Error("control uncertain; preserve locks"); }
      if (registration?.request) {
        // Cancellation stops the next command, not the receipt for this one.
        const row = state.control.ledger.at(-1);
        try {
          boundary(); assert.equal(row.request, registration.request);
          row.localTerminal = true; row.code = r.status; writeState(state);
        } catch (error) { preserveOperationLock = true; throw error; }
        await controlCheckpoint(interrupted);
      }
      if (prepareDelete && expiry !== undefined && r.status === 1 && r.deleteNotDispatched === true) {
        // The worker positively acknowledged that its request was never sent.
        // A missing result, timeout, HTTP error or lost acknowledgement cannot clear intent.
        // The withdrawal goes through its own fresh exclusive stage, like the intent it removes.
        if (prepareDelete.onUnsent) prepareDelete.onUnsent();
        else { boundary(); delete state.deletionIntentAt; writeState(state, renameSync, "delete-unsent"); }
        assert.fail("DELETE not dispatched; fresh collection approval required");
      }
      check();
      if (remaining) remaining();
      if (!permittedFailure) assert.ok(!r.error && r.status === 0, "control process failed; host preserved");
      return r;
    };
    if (binary !== "doctl") return invoke(args, allowFail);
    const scoped = (argv) => [...argv, "--context", state.provider.context];
    const account = async () => {
      const value = JSON.parse((await invoke(scoped(["account", "get", "--output", "json"]))).stdout);
      assert.equal(providerAccount(value), state.provider.accountId, "provider account identity changed; preserve uncertainty");
    };
    await account();
    if (creating) {
      // Check after the final account read, before recording or dispatching a create.
      launchPeers = checkFleetAdmission?.(true);
      recheckPriorRounds?.();
      state.status = "creating"; state.createIntentAt = new Date().toISOString(); save();
    }
    const expiry = prepareDelete ? await prepareDelete.expiresAt() : deleteProofExpiresAtMs;
    const result = await invoke(scoped(args), allowFail, expiry, beforeDelete);
    if (prepareDelete) assert.ok(result.status === 0 && !result.error, "delete outcome uncertain; preserve intent");
    await account(); // A changed context cannot supply absence/deletion authority.
    return result;
  }
  const list = async () => {
    const d = JSON.parse((await execute("doctl", ["compute", "droplet", "list", "--output", "json"])).stdout);
    assert.ok(Array.isArray(d)); return d;
  };
  // A provider-errored create retires only on positive absence: exact-ID 404, then a
  // single-response census (the whole inventory in one provider response) whose every
  // row has an inspectable ID, name and tags, none of them this create's. execute()
  // brackets each command with the saved account. The result is { droplets } (absent),
  // { witnessed } when the provider positively shows this create again (the exact GET
  // returns the posted ID, or a census row carries its ID, name or tag), or undefined
  // when the reads settle nothing. Only absence can record or keep a failure receipt.
  const providerAbsence = async ({ dropletId }) => {
    const exact = await execute("doctl", ["compute", "droplet", "get", dropletId, "--output", "json"], 60000, true);
    const diagnostic = providerFailure(exact);
    if (exact.status === 0 && !exact.error) {
      let rows;
      try { rows = JSON.parse(exact.stdout); } catch { return undefined; }
      return Array.isArray(rows) && rows.length === 1 && String(rows[0]?.id) === dropletId ? { witnessed: { via: "exact-get", droplet: rows[0] } } : undefined;
    }
    if (!(exact.status === 1 && !exact.error && diagnostic?.code === "get-http" && diagnostic.httpStatus === 404)) return undefined;
    const rows = JSON.parse((await execute("doctl", ["compute", "droplet", "list", "--single-response", "--output", "json"])).stdout);
    const text = (value) => typeof value === "string" && value.length > 0;
    assert.ok(Array.isArray(rows) && rows.every((d) => Number.isSafeInteger(d?.id) && d.id > 0 && text(d.name) && Array.isArray(d.tags) && d.tags.every(text)),
      "inventory row cannot be checked for this create; preserve reservation");
    const match = rows.find((d) => String(d.id) === dropletId || d.name === state.name || d.tags.includes(state.tag));
    return match ? { witnessed: { via: "inventory", droplet: match } } : { droplets: rows.length };
  };
  // A recorded failure whose posted droplet the provider shows again is contradicted.
  // Record that durably (cancellation does not skip it): the receipt can then never
  // be accepted again, so no later collect, fleet verification, launch or continuation
  // successor treats the attempt as settled. The witness file goes first; then the
  // state through its own stage. If either write fails, this collect keeps its
  // operation lock and every later reader sees the contradiction (createContradiction).
  const witness = join(local, createReappearedWitness);
  const unpublishedContradiction = (cause) => {
    preserveOperationLock = true;
    return Object.assign(new Error("provider-errored create contradiction not published; operation lock kept; preserve reservation", { cause }),
      { controllerStage: "create-contradiction-unpublished" });
  };
  const writeWitness = (reappeared) => {
    try {
      boundary();
      if (!lstatSync(witness, { throwIfNoEntry: false })) createReappearedIo.durable(witness, `${JSON.stringify(reappeared)}\n`);
    } catch (error) { throw unpublishedContradiction(error); }
  };
  const recordReappeared = ({ via, droplet }) => {
    const reappeared = { at: new Date().toISOString(), via, dropletId: String(droplet.id) };
    writeWitness(reappeared);
    try {
      boundary();
      const value = { ...state, createErrored: { ...state.createErrored, reappeared } };
      controllerState(value, options.round);
      const staging = stateStage("create-reappeared");
      createReappearedIo.durable(staging, `${JSON.stringify(value, null, 2)}\n`);
      createReappearedIo.rename(staging, statePath); syncDirectory(local);
      state = value;
    } catch (error) { throw unpublishedContradiction(error); }
    return reappeared;
  };
  const contradicted = () => Object.assign(new Error(createReappeared), { controllerStage: "create-errored-contradicted" });
  // The only route for a contradicted receipt (published, unpublished or witnessed):
  // its exact posted droplet, read by exact GET, carrying its saved name, ownership tags,
  // size and region and exactly one public IPv4. That droplet is bound, never provisioned,
  // and retires only by the pinned unused-host collection, under the never-started and
  // fresh-deletion fences. Anything else refuses and names that route.
  const ownedPosted = (droplet, posted) => {
    try {
      assert.equal(String(droplet?.id), posted.dropletId);
      const d = ownedDroplet([droplet], state);
      assert.equal(d.networks?.v4?.filter((n) => n.type === "public").length, 1);
      return d;
    } catch { return undefined; }
  };
  // The bind records its own exact read of the posted droplet. The first observation (an
  // exact GET or a census alias with another ID) stays in the witness file, which is
  // written first, so a later read failure cannot lose it, and bound by hash. A receipt
  // that is not the published hash or the canonical unpublished record is kept as an
  // unverified artifact, never as verified evidence. A reappearance stage left by a
  // failed publication is bound by name and bytes, so the pinned retirement can admit it.
  // So is a create-errored stage left by an interrupted receipt publication, but only if
  // its bytes are this reservation's publication of this receipt (or a prefix of it, a
  // write cut short): it is never read as state. Other bytes bind nothing.
  const bindContradicted = (d, posted) => {
    const reappeared = { at: new Date().toISOString(), via: "exact-get", dropletId: posted.dropletId };
    writeWitness(reappeared);
    const witnessed = regular(witness, 64 * 1024), receipt = regular(join(local, createErroredReceipt), 64 * 1024);
    let receiptVerified = true;
    if (state.createErrored) assert.equal(digest(receipt), state.createErrored.evidenceSha256, "create failure receipt changed; preserve reservation");
    else try { pendingCreateErroredReceipt(receipt, state, posted); } catch { receiptVerified = false; }
    const { createErrored: _published, ...unpublished } = state;
    const publication = Buffer.from(`${JSON.stringify({ ...unpublished,
      createErrored: { dropletId: posted.dropletId, actionId: posted.actionId, evidenceSha256: digest(receipt) } }, null, 2)}\n`);
    const published = publicationStages(local).map((name) => {
      const bytes = regular(join(local, name), 1024 * 1024);
      assert.ok(bytes.length <= publication.length && publication.subarray(0, bytes.length).equals(bytes),
        "a create-errored stage beside the contradicted receipt is not this reservation's publication; nothing bound;"
        + " account for it by the custody step (CLOUD.md); preserve reservation");
      return { name, sha256: digest(bytes) };
    });
    const stages = [...contradictionStages(local).map((name) => ({ name, sha256: digest(regular(join(local, name), 1024 * 1024)) })), ...published]
      .sort((a, b) => a.name < b.name ? -1 : 1);
    state.createContradicted = { dropletId: posted.dropletId, actionId: posted.actionId, evidenceSha256: digest(receipt), receiptVerified, reappeared,
      witnessSha256: digest(witnessed), ...(stages.length ? { stages } : {}) };
    delete state.createErrored;
    bind(d);
    return 3;
  };
  // The one read that can bind a posted create: the account-bracketed exact GET of its
  // posted droplet ID, positively owned. Undefined for anything else. A census row never
  // binds; it can only record a contradiction.
  const exactPosted = async (posted) => {
    const exact = await execute("doctl", ["compute", "droplet", "get", posted.dropletId, "--output", "json"], 60000, true);
    let rows;
    try { rows = exact.status === 0 && !exact.error ? JSON.parse(exact.stdout) : undefined; } catch { rows = undefined; }
    return Array.isArray(rows) && rows.length === 1 ? ownedPosted(rows[0], posted) : undefined;
  };
  // The same rule for a providerAbsence result that did not prove absence.
  const witnessedPosted = (census) => {
    assert.ok(census?.witnessed?.via === "exact-get", census?.witnessed
      ? "provider-errored allocation not verified absent and not the exact posted droplet; preserve reservation without binding"
      : "provider-errored allocation not verified absent; preserve reservation without binding");
    const d = ownedDroplet([census.witnessed.droplet], state);
    assert.equal(d.networks?.v4?.filter((n) => n.type === "public").length, 1, "ambiguous public host address");
    return d;
  };
  const contradictedCreate = async (posted) => {
    assert.ok(lstatSync(join(local, createErroredReceipt), { throwIfNoEntry: false }), "contradiction without its receipt; preserve reservation");
    const d = await exactPosted(posted);
    if (!d) throw contradicted();
    return bindContradicted(d, posted);
  };
  // A launch that stopped while its accepted create was unsettled kept the POST's IDs
  // and, normally, its own locks. Those locks stay until the operator's custody step:
  // a dead PID in a lock record does not prove that the original controller, provider
  // worker and their descendants are gone (see CLOUD.md, retained locks), so this
  // recheck never runs while either remains and never removes one. Afterwards it reads
  // that exact action under the ordinary operation lock. Only a terminal errored action
  // bound to the posted droplet, with the droplet proved absent on the saved account,
  // records the provider-errored outcome. A completed create bound to the posted droplet
  // is bound to that exact allocation and stops there (3): a fresh collection then
  // applies the unused-host and deletion fences with its own provider. An errored action
  // whose posted droplet the exact GET still returns, under its saved name, tags and
  // placement, is the same real allocation and takes the same bind-only checkpoint, as
  // the in-deadline launch does. Any other answer preserves the reservation.
  const launchCustody = "original launch custody retained: account for the original controller, provider worker and their descendants,"
    + " then release its launch and operation locks by the custody step and collect again; preserve reservation";
  const partialCustody = "partial launch custody (a lock left by an interrupted launch or collect): account for its owner by the custody step"
    + " before collecting; preserve reservation";
  async function settlePendingCreate(observed) {
    const m = observed.control?.monitor;
    assert.ok(!observed.deletionIntentAt && (!observed.control || !observed.control.ledger.length && !observed.control.sealed.length
      && (!m || m.phase === "pending" && !m.registrationSha256)), "pending create has guest control; preserve reservation");
    assert.ok(!readdirSync(local).some((name) => name.startsWith("monitor-") || name === "known_hosts" || name === recheckLock),
      "pending create has guest or recheck artifacts; preserve reservation");
    const launchLock = join(base, ".groups-launch.lock"), held = [join(local, "operation.lock"), launchLock].map((path) => existsSync(path));
    assert.ok(!held[0] && !held[1], held[0] && held[1] ? launchCustody : partialCustody);
    return locked(async () => {
      assert.deepEqual(state, observed, "pending create reservation changed; preserve reservation");
      assert.ok(!existsSync(launchLock), partialCustody);
      const posted = state.createPending;
      // Read-only: never a second create, a DELETE or a guest command.
      const rows = JSON.parse((await execute("doctl", ["compute", "action", "get", posted.actionId, "--output", "json"])).stdout);
      assert.ok(Array.isArray(rows) && rows.length === 1, "create action observation unavailable; preserve reservation");
      const [action] = rows;
      assert.ok(action?.id === Number(posted.actionId) && action.type === "create" && action.resource_type === "droplet",
        "create action identity differs; preserve reservation");
      // Still running: nothing has settled. Report pending without changing custody.
      if (action.status === "in-progress" && [null, 0, Number(posted.dropletId)].includes(action.resource_id)) return 3;
      // A receipt left by a stop between its write and the state publication claims
      // absence; a witness left by a failed contradiction publication denies it.
      const path = join(local, createErroredReceipt);
      const unpublished = !!lstatSync(path, { throwIfNoEntry: false }), witnessed = createContradiction(local);
      if (action.status === "completed" && action.resource_id === Number(posted.dropletId)) {
        // A completed create contradicts an unpublished absence receipt: only the
        // exact owned posted droplet is bound, keeping that receipt as evidence.
        if (unpublished || witnessed) return contradictedCreate(posted);
        // A real allocation is not this path's to settle. Bind it, only by the positive
        // exact GET of the posted ID (never a census), and stop: this operation's provider
        // closes when it returns, so the unused-allocation path runs in a fresh, separately
        // approved collection.
        const d = await exactPosted(posted);
        assert.ok(d, "completed create's posted droplet is not a positive owned exact read; nothing bound; preserve reservation");
        bind(d);
        return 3;
      }
      assert.ok(action.status === "errored" && action.resource_id === Number(posted.dropletId),
        "create action is not an errored create of the posted droplet; preserve reservation");
      // A witnessed contradiction is never settled by a later absence.
      if (witnessed) return contradictedCreate(posted);
      const census = await providerAbsence(posted);
      // An unpublished receipt is adopted only after this fresh action and absence
      // proof, and only if its bytes are exactly the canonical record for this state.
      if (census?.witnessed && unpublished) {
        // Any reappearance that would contradict a published receipt (the exact GET, or a
        // census row with its ID, name or tag after a 404) contradicts the unpublished one:
        // the witness is written first, so a later absence can never adopt that receipt.
        // Only the exact posted droplet, positively owned, is bound; anything else refuses.
        const { via, droplet } = census.witnessed;
        writeWitness({ at: new Date().toISOString(), via, dropletId: String(droplet.id) });
        const d = via === "exact-get" && ownedPosted(droplet, posted);
        if (d) return bindContradicted(d, posted);
        throw contradicted();
      }
      if (census?.witnessed) {
        // Only the exact GET of the posted ID, positively owned, can bind; a census
        // match after a 404 or another ID stays unresolved.
        bind(witnessedPosted(census));
        return 3;
      }
      assert.ok(census?.droplets !== undefined, "provider-errored allocation not verified absent; preserve reservation");
      check();
      let bytes;
      if (unpublished) bytes = pendingCreateErroredReceipt(regular(path, 64 * 1024), state, posted);
      else { bytes = createErroredBytes(createErroredRecord(state, posted, census.droplets, new Date().toISOString())); durable(path, bytes); }
      publishCreateErrored(posted, bytes);
      return 1;
    });
  }
  const exactHost = async (remaining) => {
    const result = await execute("doctl", ["compute", "droplet", "get", state.id, "--output", "json"], 60000, true, undefined, remaining);
    if (result.status === 1 && providerFailure(result)?.code === "get-http" && providerFailure(result)?.httpStatus === 404) return undefined;
    assert.equal(result.status, 0, "exact host observation failed; preserve state");
    const rows = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows) && rows.length === 1 && String(rows[0]?.id) === state.id, "exact host identity differs");
    return rows[0];
  };
  const confirmDeleted = async (poll = true) => {
    assert.ok(state.deletionIntentAt, "deletion intent required before absence confirmation");
    let previous = now(); const deadline = previous + 120000;
    const uncertain = "deletion not confirmed; outcome uncertain; no automatic repeated deletion; preserve intent without another DELETE";
    const remaining = () => {
      check(); const current = now();
      assert.ok(Number.isFinite(current) && Number.isFinite(deadline) && current >= previous && current < deadline, uncertain);
      previous = current; return Math.max(1, Math.floor(deadline - current));
    };
    // The attempt cap also bounds synthetic/stalled clocks. Every account/GET/account
    // call shares the same deadline; an accepted DELETE is never repeated.
    for (let attempt = 0; attempt < 121; attempt++) {
      remaining();
      if (await exactHost(remaining) === undefined) return;
      assert.ok(poll, "host still present; absence not confirmed");
      await sleep(Math.min(1000, remaining()));
    }
    assert.fail(uncertain);
  };
  const own = async (remaining) => {
    const found = state.id ? await exactHost(remaining) : undefined;
    const d = ownedDroplet(state.id ? found ? [found] : [] : await list(), state), ips = d.networks?.v4?.filter((n) => n.type === "public");
    assert.equal(ips?.length, 1, "ambiguous public host address");
    if (state.ip) assert.equal(ips[0].ip_address, state.ip);
    return d;
  };
  const bind = (d) => {
    assert.ok(!state.id || state.id === String(d.id), "host ID changed");
    // A create whose accepted POST named its droplet binds only that droplet, never
    // another allocation that happens to carry the same name or tags.
    assert.ok(!state.createPending || state.createPending.dropletId === String(d.id),
      "found allocation differs from the posted create; preserve reservation without binding");
    state.id = String(d.id); state.ip = d.networks.v4.find((n) => n.type === "public").ip_address;
    state.status = state.status === "creating" ? "preparing" : state.status; save();
  };
  const sshLimits = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
  const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(local, "known_hosts").replaceAll("\\", "/")}`, ...sshLimits];
  const launchSshOptions = [...sshOptions, "-o", "GlobalKnownHostsFile=none", "-o", "UpdateHostKeys=no"];
  async function withHostKeySnapshot(key, prefix, fn, deferCleanup) {
    const sha256 = digest(key), dir = mkdtempSync(join(base, prefix)), path = join(dir, "known_hosts");
    const identity = lstatSync(dir, { bigint: true });
    let fileIdentity;
    const removeSnapshot = () => {
      physical(dir);
      const current = lstatSync(dir, { bigint: true });
      assert.ok(current.dev === identity.dev && current.ino === identity.ino, "private host-key directory changed");
      const files = readdirSync(dir);
      if (files.length) {
        assert.deepEqual(files, ["known_hosts"], "unexpected private host-key artifacts; preserve");
        const file = lstatSync(path, { bigint: true });
        assert.ok(fileIdentity && file.dev === fileIdentity.dev && file.ino === fileIdentity.ino
          && digest(regular(path, 1024 * 1024)) === sha256, "private host-key snapshot changed; preserve");
        unlinkSync(path);
      }
      rmdirSync(dir);
    };
    try {
      durable(path, key);
      fileIdentity = lstatSync(path, { bigint: true });
      const result = await fn([...pinnedHostOptions(path), ...sshLimits]);
      assert.equal(digest(regular(path, 1024 * 1024)), sha256, "private host-key snapshot changed");
      return result;
    } finally {
      if (!preserveOperationLock) removeSnapshot();
      else deferCleanup?.(removeSnapshot);
    }
  }
  async function usingLaunchHostKey(fn, deferCleanup) {
    const result = await withHostKeySnapshot(launchHostKey(local, state), ".launch-host-key-", fn, deferCleanup);
    launchHostKey(local, state);
    return result;
  }
  const transport = async (binary, args, timeout, allowFail, deferCleanup) => {
    await own(); assert.ok(state.id && state.ip, "bound host required");
    const mixedRecovery = state.group === "mixed-production" && (options.cancelMixedWait || options.retireFailedNative && !groupedPreplan);
    const pinnedKey = mixedRecovery ? mixedWait.knownHostsSha256 : options.r21MeasuredCheckout ? recoveryApproval.knownHostsSha256 : undefined;
    if (pinnedKey) assert.equal(fileHash(join(local, "known_hosts")), pinnedKey, "native host keys changed");
    if (existsSync(join(local, "known_hosts"))) regular(join(local, "known_hosts"), 1024 * 1024);
    let startedAtMs;
    const invoke = (hostOptions) => {
      let registration;
      if (state.control) {
        assert.equal(state.control.helperSha256, guardianSha256, "control source changed; preserve host");
        assert.ok(!state.control.sealed.includes(controlEpoch), "control epoch already sealed");
        const intent = controlRequest(state, binary, args, timeout ?? 60000, controlEpoch, sealing);
        state.control.ledger.push({ request: intent, localTerminal: false }); save();
        registration = controlRegistration(intent);
      }
      startedAtMs = Date.now();
      return execute(binary, [...hostOptions, ...args], timeout, allowFail, undefined, undefined, registration);
    };
    const result = !pinnedKey && state.launchHostKeySha256 ? await usingLaunchHostKey(invoke, deferCleanup)
      : await invoke(pinnedKey ? [...pinnedHostOptions(join(local, "known_hosts")), ...sshLimits] : sshOptions);
    if (pinnedKey) assert.equal(fileHash(join(local, "known_hosts")), pinnedKey, "native host keys changed during transport");
    return { ...result, startedAtMs };
  };
  const ssh = (script, timeout = 60000, allowFail = false, deferCleanup) => transport("ssh", [`root@${state.ip}`, script], timeout, allowFail, deferCleanup);
  const scp = (from, to) => transport("scp", ["-q", from, to], 15 * 60000);
  async function waitForSsh() {
    const windowMs = 120000, spacingMs = 5000, attempts = windowMs / spacingMs;
    let previous = now(); const deadline = previous + windowMs;
    const remaining = () => {
      check(); const current = now();
      assert.ok(Number.isFinite(current) && Number.isFinite(deadline) && current >= previous && current < deadline, "SSH unavailable within readiness budget");
      previous = current; return Math.max(1, Math.floor(deadline - current));
    };
    const known = join(local, "known_hosts");
    if (fleet) assert.ok(!lstatSync(known, { throwIfNoEntry: false }), "unexpected host key before first launch SSH");
    for (let attempt = 0; attempt < attempts; attempt++) {
      await own(remaining);
      if (lstatSync(known, { throwIfNoEntry: false })) regular(known, 1024 * 1024);
      // No guardian or other remote write is dispatched by this probe. Only a
      // settled SSH client failure can advance to another identical no-op.
      const result = await execute("ssh", [...(fleet ? launchSshOptions : sshOptions), `root@${state.ip}`, "true"], 20000, true, undefined, remaining);
      if (result.status === 0 && !result.error && !result.signal) {
        if (fleet) {
          const key = regular(known, 1024 * 1024);
          assert.ok(key.length, "launch SSH did not establish a host key");
          state.launchHostKeySha256 = digest(key); save();
        }
        return;
      }
      assert.equal(result.status, 255, "SSH unavailable; readiness did not return an SSH transport status");
      if (attempt + 1 < attempts) await sleep(Math.min(spacingMs, remaining()));
    }
    assert.fail("SSH unavailable within readiness budget");
  }
  const unit = async () => terminalUnit((await ssh(unitQuery(state))).stdout, state);
  const requireActiveStartup = async (message) => {
    const { stdout } = await ssh(unitQuery(state));
    if (!terminalUnit(stdout, state)) return;
    if (state.fleet?.single?.offlineHandoff) assert.fail(message);
    // An acknowledged start and positive terminal observation, not an SSH
    // failure or missing monitor. Keep the original output and its ledger row.
    state.preBootstrapTerminal = { hostId: state.id, ip: state.ip, monitorId: state.control.monitor.id,
      invocation: state.control.ledger.at(-1).request.invocation.id, stdout };
    state.status = "starting"; save(); assert.fail(message);
  };
  async function publishBootstrapSeal(remaining) {
    remaining();
    assert.ok(state.control.monitor.phase === "live" && acknowledgedBootstrapSeal(state.control.ledger), "live acknowledged bootstrap seal required");
    const snapshot = (path, limit) => {
      const stat = () => lstatSync(path, { bigint: true });
      const before = stat(), bytes = regular(path, limit);
      const verify = (expected = bytes) => {
        const actual = regular(path, limit), after = stat();
        assert.ok(actual.equals(expected) && ["dev", "ino", "size", "nlink", "mtimeNs", "ctimeNs"].every((k) => before[k] === after[k]),
          "bootstrap seal publication input changed; preserve custody");
      };
      return { bytes, verify };
    };
    const encode = () => Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
    const saved = snapshot(statePath, 1024 * 1024);
    saved.verify(encode());
    const operation = snapshot(join(local, "operation.lock"), 1024), launch = snapshot(join(base, ".groups-launch.lock"), 1024);
    assert.ok(JSON.parse(operation.bytes).pid === process.pid && JSON.parse(launch.bytes).pid === process.pid
      && JSON.parse(launch.bytes).round === options.round, "bootstrap seal owner changed");
    state.control.sealed.push("bootstrap");
    controllerState(state, options.round);
    const noOrdinaryStage = () => assert.ok(!lstatSync(stateStage(), { throwIfNoEntry: false }), "unfinished reservation write; preserve staging");
    noOrdinaryStage();
    // A failed seal must not occupy the ordinary state writer's staging name.
    const staging = stateStage("bootstrap"), bytes = encode();
    durable(staging, bytes);
    const staged = snapshot(staging, 1024 * 1024);
    verifyBootstrapPublication = () => {
      boundary(); noOrdinaryStage();
      assert.ok(!lstatSync(join(local, "monitor-invalid.json"), { throwIfNoEntry: false }), "bootstrap seal monitor revoked");
      operation.verify(); launch.verify(); saved.verify(); staged.verify(bytes);
    };
    let retryUntil;
    const delays = [25, 50, 100];
    for (let attempt = 0; ; attempt++) {
      remaining();
      verifyBootstrapPublication();
      remaining();
      assert.ok(retryUntil === undefined || monotonicNow() < retryUntil, "bootstrap seal rename retry expired");
      try { renameBootstrapSeal(staging, statePath); verifyBootstrapPublication = undefined; break; }
      catch (error) {
        // Windows can report a delete-sharing denial as EPERM, also used for permanent denials.
        const delay = delays[attempt];
        if (error.code !== "EPERM" || error.syscall !== "rename" || delay === undefined) throw error;
        retryUntil ??= monotonicNow() + 250;
        if (delay >= remaining() || monotonicNow() + delay >= retryUntil) throw error;
        await sleep(delay);
      }
    }
  }
  async function sealControl(epoch, remaining) {
    if (!state.control) return;
    assert.equal(controlEpoch, epoch);
    const rows = state.control.ledger.filter((r) => r.request.epoch === epoch);
    assert.ok(rows.length > 0 && rows.every((r) => r.localTerminal), "unsettled local control ledger");
    const offlineBootstrap = epoch === "bootstrap" && state.fleet?.single?.offlineHandoff;
    const previous = preserveOperationLock;
    let removeSealSnapshot;
    if (offlineBootstrap) preserveOperationLock = true;
    sealing = rows.map((r) => r.request.invocation);
    try { await ssh(":", undefined, false, offlineBootstrap ? (remove) => { removeSealSnapshot = remove; } : undefined); }
    catch (error) {
      if (offlineBootstrap) throw Object.assign(new Error("offline bootstrap seal unacknowledged; preserve host and custody", { cause: error }),
        { controlTreeUncertain: true });
      throw error;
    } finally { sealing = undefined; }
    if (offlineBootstrap) {
      // There is no foreground monitor that could resolve a publication gap.
      // A host may already be progressing; do not release custody until the
      // exact successful final request and the published local seal agree.
      try {
        assert.ok(acknowledgedBootstrapSeal(state.control.ledger), "explicit successful bootstrap seal required");
        state.control.sealed.push(epoch); save();
        if (!previous) removeSealSnapshot();
      } catch (error) {
        throw Object.assign(new Error("offline bootstrap seal publication uncertain; preserve host and custody", { cause: error }),
          { controlTreeUncertain: true });
      }
      preserveOperationLock = previous;
    } else if (epoch === "bootstrap" && renameBootstrapSeal) await publishBootstrapSeal(remaining);
    else { state.control.sealed.push(epoch); save(); }
    controlEpoch = "collection";
  }
  async function commonBootstrap() {
    const markerFailure = (error, detail) => Object.assign(error, { providerDiagnostic: { code: "bootstrap-marker", detail } });
    const deadline = now() + 45 * 60000; let previous = deadline - 45 * 60000;
    const remaining = () => {
      const current = now();
      assert.ok(Number.isFinite(current) && Number.isFinite(deadline) && current >= previous && current < deadline, "common bootstrap observation expired; preserve running host");
      previous = current; check(); return deadline - current;
    };
    for (;;) {
      remaining();
      await requireActiveStartup("first group ended before common bootstrap admission; collect its evidence");
      const offline = state.fleet?.single?.offlineHandoff;
      const observation = offline ? bootstrapReadScript + "\ncat /proc/sys/kernel/random/boot_id" : bootstrapReadScript;
      let result;
      try { result = await ssh(observation, Math.min(30000, remaining()), true); }
      catch (error) {
        const detail = controlResultFailure(error);
        throw detail ? markerFailure(error, detail) : error;
      }
      remaining();
      if (result.status === 0 && !result.error) {
        let marker = result.stdout, bootId;
        try {
          assert.ok(Buffer.byteLength(marker) <= 1024, "bounded bootstrap marker required");
          if (offline) {
            const parts = /^(.*\n)([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\n$/.exec(marker);
            assert.ok(parts, "bootstrap marker and host boot identity required");
            [, marker, bootId] = parts;
          }
          assert.deepEqual(JSON.parse(marker), bootstrapMarker(state), "common bootstrap identity differs");
        } catch (error) { throw markerFailure(error, "marker-invalid"); }
        if (state.group !== undefined && state.group === state.fleet.jobs[0].group) {
          state.bootstrapReady = { sha256: digest(marker), observedAt: new Date().toISOString(), ...(offline ? { bootId } : {}) }; save();
        }
        if (state.control?.monitor) {
          assert.equal(state.control.monitor.phase, "pending");
          const expected = { id: state.control.monitor.id, binding: { round: state.round, commit: state.commit,
            token: state.token, helperSha256: state.control.helperSha256 } };
          const connect = (opts) => execute("ssh", [...opts, 'root@' + state.ip], 30000, false, undefined, undefined,
            { stream: true, expected, local, interrupted, peerLease: !!fleet?.single });
          if (state.launchHostKeySha256) await usingLaunchHostKey(connect);
          else await connect(sshOptions);
          assert.ok(monitor);
          state.control.monitor.registrationSha256 = digest(JSON.stringify(monitor.registration));
          state.control.monitor.phase = "live"; save();
        }
        await sealControl("bootstrap", remaining); return;
      }
      try { assert.equal(result.status, 3, "common bootstrap marker observation failed"); }
      catch (error) { throw markerFailure(error, "acknowledged-exit-refused"); }
      await sleep(Math.min(30000, remaining()));
    }
  }
  async function locked(fn, recovery = false, name = recovery ? recoveryLock : "operation.lock") {
    boundary(); const lock = join(local, name);
    if (recovery) assert.ok(existsSync(join(local, "operation.lock")), "original uncertain monitor custody required");
    const lockBytes = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
    // Every lock keeps the identity of the file this process created, so neither a dispatch
    // guard nor teardown can mistake a replacement for it.
    const handoff = pinnedRetirement || absenceOnly;
    physical(local);
    const ownLock = acquireHandoffLock(lock, Buffer.from(lockBytes), handoff ? undefined : `${name} changed; preserve custody`);
    if (handoff) assertHandoffLock = ownLock;
    const outerLock = heldLock;
    heldLock = { name, own: ownLock };
    preserveOperationLock = false;
    let failure;
    try {
      assertHandoffLock?.();
      state = read(); check();
      // A closed reservation can have no retained launch owner. Competing
      // ordinary operations must still exclude its explicit stream recovery.
      if (name === "operation.lock" && state.fleet?.single)
        assert.ok(!lstatSync(join(local, recoveryLock), { throwIfNoEntry: false }), "stream recovery already holds custody");
      if (recovery) assert.equal(state.control?.monitor?.phase, "invalid", "only irrevocably failed monitoring can recover");
      return await fn();
    }
    catch (error) { failure = error; throw error; }
    finally {
      try { await settle(); }
      catch (error) {
        preserveOperationLock = true;
        const diagnostic = providerFailure(error);
        throw Object.assign(new Error("control teardown uncertain; preserve locks/state/evidence/host"), { controlTreeUncertain: true, controlUncertain: true },
          diagnostic ? { providerDiagnostic: diagnostic } : {});
      }
      finally {
        heldLock = outerLock;
        if (!preserveOperationLock) {
          if (afterSettle) afterSettle();
          else if (expectedHandoffState !== undefined) assertHandoffState();
          else assertHandoffLock?.();
          // Never remove a lock this process no longer owns: a replacement stays for its owner.
          try { ownLock(); }
          catch (cause) {
            preserveOperationLock = true;
            // Report the replacement; an earlier refusal stays as the cause.
            throw new Error(`${name} was replaced during this operation; the replacement is kept; preserve custody`, { cause: failure ?? cause });
          }
          unlinkSync(lock); syncDirectory(local);
        }
      }
    }
  }
  const verifyArchive = () => {
    assert.equal(fileHash(archive), state.archiveSha256, "archive changed; preserve host");
  };
  const recordVerifiedAbsence = (report, sealedMonitor, original) =>
    withVerifiedArchive(archive, state.archiveSha256, (archiveUnchanged) => {
      const treeUnchanged = pinEvidenceTree(join(local, state.evidence), state.evidenceSha256, "evidence changed after replay");
      treeUnchanged();
      const { terminal } = sealedMonitor(local, state);
      assert.ok(terminal.campaign === report.campaign, "monitor campaign changed after replay");
      assert.ok(terminal.sealSha256 === report.supervisedTerminal.sealSha256, "monitor seal changed after replay");
      original(); archiveUnchanged();
      state.destroyedAt = new Date().toISOString(); save("destroyed"); return 0;
    });
  async function validateEvidence(confirmedAbsent = false, start) {
    state.fullGroupQualified = false;
    let extracted, exitCode;
    try {
      extracted = join(local, state.evidence); physical(extracted);
      assert.equal(treeHash(extracted), state.evidenceSha256, "evidence changed; preserve host");
      const markerBytes = regular(join(extracted, "exit-code"), 16);
      assert.ok(markerBytes.every((b) => b < 128), "invalid exit marker bytes");
      const marker = markerBytes.toString("ascii");
      full(marker, /(?:0|[1-9]\d{0,2})\n/, "invalid exit marker");
      exitCode = Number(marker.trim()); assert.ok(exitCode <= 255);
    } catch (error) {
      // Keep the local error for in-process callers; the public boundary only emits the stage.
      throw Object.assign(error, { controllerStage: "collect-native-evidence-refused" });
    }
    let report;
    let outcome;
    try {
      if (state.fleet?.single?.offlineHandoff) assert.ok(offlineBootstrapAck(), "offline bootstrap acknowledgement missing");
    } catch { throw collectRefusal("collect-native-report-refused"); }
    let replay;
    try {
      replay = options.r21MeasuredCheckout ? { start: (await r21Validator(options.r21MeasuredCheckout)).validationTask } : { inspect, start };
    } catch { throw collectRefusal("collect-native-replay-start"); }
    report = await inspectCampaign(Object.freeze({ folder: join(extracted, "campaign"), round: state.round, commit: state.commit }), {
      ...replay, interrupted, confirmedAbsent, preserveLock: () => { preserveOperationLock = true; },
    });
    try {
      check();
      assert.ok(state.control?.monitor?.phase !== "invalid" || report.status !== "verified", "lost monitor cannot qualify");
      outcome = campaignOutcome(report, state, exitCode);
      if (state.control?.monitor?.phase === "closed") {
        const terminal = JSON.parse(regular(join(local, "monitor-terminal.json")));
        assert.equal(terminal.id, state.control.monitor.id);
        assert.equal(terminal.nativeTerminal, true); assert.equal(terminal.campaign, report.campaign);
        assert.equal(terminal.sealSha256, report.supervisedTerminal.sealSha256);
      }
    } catch { throw collectRefusal("collect-native-report-refused"); }
    // Never retain/print native assertion messages: they may contain private raw values.
    try {
      assert.equal(treeHash(extracted), state.evidenceSha256, "validator mutated evidence"); verifyArchive();
    } catch (error) {
      throw Object.assign(error, { controllerStage: "collect-native-evidence-refused" });
    }
    Object.assign(state, outcome, { exitCode, validation: { status: report.status, campaign: report.campaign, collectionIntegrity: report.collectionIntegrity } });
    return report;
  }
  const deletedCode = () => state.validation.status === "verified" && state.exitCode === 0 ? 0 : 1; // Intrinsic evidence only, never readiness.
  // With `pins`, also adds a cheap recheck of what this verified, for the DELETE's dispatch
  // guard: the archive's file identity, recorded around its hash, and the extracted tree's
  // metadata, recorded by the same walk that hashes it. Neither rereads the payload.
  const setupExit = (pins) => {
    const archiveIdentity = evidenceFileIdentity(archive);
    verifyArchive();
    assert.ok(evidenceFileIdentity(archive) === archiveIdentity, "archive changed; preserve host");
    const extracted = join(local, state.evidence); physical(extracted);
    const treeUnchanged = pinEvidenceTree(extracted, state.evidenceSha256, "failed setup archive extraction changed");
    const campaign = join(extracted, "campaign");
    if (existsSync(campaign)) { physical(campaign); assert.deepEqual(readdirSync(campaign), [], "native data cannot use setup retirement"); }
    const marker = regular(join(extracted, "exit-code"), 16).toString("utf8");
    full(marker, /[1-9]\d{0,2}\n/, "nonzero setup exit required");
    const exit = Number(marker.trim()); assert.ok(exit <= 255);
    // The tree walk is the slow part, so the archive's identity is checked on both sides of
    // it: a change made to results.tgz while the tree is walked is still seen.
    const archiveUnchanged = () => {
      try { assert.ok(evidenceFileIdentity(archive) === archiveIdentity); }
      catch (cause) { throw new Error("setup archive changed; preserve host", { cause }); }
    };
    pins?.push(() => {
      archiveUnchanged();
      try { treeUnchanged(); }
      catch (cause) { throw new Error("setup evidence changed; preserve host", { cause }); }
      archiveUnchanged();
    });
    return exit;
  };
  const retirementFile = (kind) => kind === "setup-failed" ? "failed-setup-host.json" : "unused-host.json";
  // `interrupted` verifies a receipt left without its intent for archival only: a retry
  // has since appended controls, so it is checked against the ledger prefix it was
  // written for. Only a receipt for the final control can authorize a DELETE.
  const verifyRetirementRecord = (bytes, kind, interrupted = false, pins) => {
    const setup = kind === "setup-failed";
    const record = JSON.parse(bytes), raw = JSON.stringify(record.observation);
    if (!setup) return verifyUnusedEvidence(record, state);
    let bound = state;
    if (interrupted && state.control) {
      const length = record.observation?.control?.requests?.length;
      assert.ok(Number.isSafeInteger(length) && length > 0 && length <= state.control.ledger.length, "interrupted receipt outside the saved ledger");
      bound = { ...state, control: { ...state.control, ledger: state.control.ledger.slice(0, length) } };
    }
    // The preserved archive selects the schema: v3 only beside an archived watcher failure.
    const exit = setupExit(pins), failures = bound.control && bound.preBootstrapTerminal ? setupWatcherFailures(bound, local) : [];
    const expected = setupEvidence(raw, bound, terminalSetupScript(bound, exit, bound.control ? record.observation.control.requests.length - 1 : undefined, failures), exit, record.startedAtMs, record.finishedAtMs, local);
    assert.deepEqual(record, expected, "retirement evidence differs");
  };
  const verifyRetirement = (pins) => {
    if (state.retirement.kind === "native-failed") return verifyFailedNativeRetirement(local, state);
    const bytes = regular(join(local, retirementFile(state.retirement.kind)), state.control && state.retirement.kind === "setup-failed" ? 8 * 1024 * 1024 : 4096);
    assert.equal(digest(bytes), state.retirement.evidenceSha256, "retirement evidence changed");
    verifyRetirementRecord(bytes, state.retirement.kind, false, pins);
  };
  // Only the positive not-dispatched acknowledgement creates this stage. The digest
  // binds the exact retired state, both in the filename and in the stage: the same
  // pre-intent state can yield a different intent, and copying the stage cannot rebind it.
  const drainWithdrawal = (intentBytes, restore) => {
    const intentSha256 = digest(intentBytes);
    return { path: stateStage("delete-unsent", intentSha256), bytes: Buffer.from(stateBytes({ intentSha256, restore })) };
  };
  const matchesWithdrawal = ({ path, bytes }) => {
    try { return regular(path, bytes.length).equals(bytes); } catch { return false; }
  };
  const publishWithdrawal = (proof, restore, fence) => {
    const restoredBytes = Buffer.from(stateBytes(restore));
    // The proof itself cannot be renamed over state.json. Save the canonical
    // restoration durably; if that save fails, keep the proof for the next collect.
    writeState(restore, (stage, target) => {
      assert.ok(matchesWithdrawal(proof), "drain withdrawal proof changed; preserve deletion intent");
      fence();
      assert.ok(regular(stage, restoredBytes.length).equals(restoredBytes) && matchesWithdrawal(proof),
        "drain withdrawal stage changed; preserve deletion intent");
      renameSync(stage, target);
    }, "delete-unsent-restore");
    state = restore;
    if (matchesWithdrawal(proof)) { unlinkSync(proof.path); syncDirectory(local); }
  };
  const resumeDrainWithdrawal = async () => {
    if (state.status !== "retired" || state.retirement.kind !== "setup-failed" || state.destroyedAt) return;
    const intent = regular(statePath, 1024 * 1024);
    if (!intent.equals(Buffer.from(stateBytes(state)))) return;
    // The pre-registration drain path can only have retired a starting state.
    // Reconstruct it, rather than loading any state from the stage.
    const restore = { ...state, status: "starting", pendingRetirement: state.retirement };
    delete restore.retirement; delete restore.deletionIntentAt;
    const proof = drainWithdrawal(intent, restore);
    if (!matchesWithdrawal(proof)) return;
    const path = join(local, retirementFile("setup-failed")), limit = 8 * 1024 * 1024;
    const receipt = regular(path, limit);
    if (digest(receipt) !== state.retirement.evidenceSha256 || JSON.parse(receipt).schema !== "benchmark-failed-setup-retirement/v3") return;
    // Keep the intent if the operator already removed this host. The retired path
    // can then confirm absence; an inconclusive read throws without changing state.
    if (await exactHost() === undefined) return;
    verifyRetirementRecord(receipt, "setup-failed");
    const fence = () => {
      check();
      assert.ok(regular(path, limit).equals(receipt), "retirement evidence changed during drain withdrawal");
      heldLock.own();
      assert.ok(regular(statePath, 1024 * 1024).equals(intent), "saved retirement reservation changed; preserve host");
    };
    fence(); publishWithdrawal(proof, restore, fence);
  };
  const requireUnusedBootstrapCustody = () => {
    const interrupted = interruptedFirstUpload(state, local), uploads = interrupted || settledBootstrap(state, local);
    assert.ok(unusedBootstrapApproval && (uploads || unusedBootstrap(state)), "exact approved unused bootstrap required");
    assert.equal(digest(regular(statePath, 1024 * 1024)), unusedBootstrapApproval.reservationSha256, "locked unused bootstrap reservation changed");
    const present = (path) => lstatSync(path, { throwIfNoEntry: false });
    assert.ok(!present(join(base, ".groups-launch.lock")) && (!state.group || !present(join(dirname(base), ".fleet-operation.lock"))),
      "original launch custody remains; preserve locks and host");
    if ((interrupted || offlineNeverStarted(state)) && state.fleet?.single) assert.ok(!present(join(dirname(dirname(base)), ".continuation-operation.lock")),
      "continuation custody remains; preserve locks and host");
    const names = ["state.json", "operation.lock", "known_hosts", "unused-host.json"];
    if (state.createContradicted) {
      // The contradicted receipt and its witness stay as evidence; nothing else is admitted.
      assert.ok(!uploads, "a contradicted create has no bootstrap uploads; preserve host");
      assert.equal(digest(regular(join(local, createErroredReceipt), 64 * 1024)), state.createContradicted.evidenceSha256,
        "contradicted create receipt changed; preserve host");
      assert.ok(lstatSync(join(local, createReappearedWitness), { throwIfNoEntry: false }), "contradiction witness missing; preserve host");
      assert.equal(digest(regular(join(local, createReappearedWitness), 64 * 1024)), state.createContradicted.witnessSha256,
        "contradiction witness changed; preserve host");
      names.push(createErroredReceipt, createReappearedWitness);
      // Only the reappearance stages bound at the bind, with their recorded bytes.
      for (const { name, sha256 } of state.createContradicted.stages ?? []) {
        assert.equal(digest(regular(join(local, name), 1024 * 1024)), sha256, "contradiction stage changed; preserve host");
        names.push(name);
      }
    }
    if (uploads) {
      if (interrupted) assert.equal(state.launchHostKeySha256, unusedBootstrapApproval.knownHostsSha256, "verified key differs from launch");
      assert.equal(fileHash(join(local, "known_hosts"), 1024 * 1024), unusedBootstrapApproval.knownHostsSha256, "saved host key changed");
      const uploaded = Math.ceil((state.control.ledger.length - 2) / 2), entries = Object.entries(remoteFiles(state));
      // The launcher saves the next file before its provider read and SFTP dispatch.
      const staged = state.control.ledger.length % 2 === 0 ? uploaded + 1 : uploaded;
      for (const [i, [name, content]] of entries.slice(0, staged).entries()) {
        const path = join(local, name);
        if (i < uploaded || present(path)) assert.equal(fileHash(path, 1024 * 1024), digest(content), "local bootstrap upload changed");
        names.push(name);
      }
    }
    assert.ok(readdirSync(local).every((name) => names.includes(name)
      || /^unused-host\.interrupted-[a-f0-9]{64}\.json$/.test(name)), "unexpected local bootstrap custody; preserve host");
    return uploads;
  };
  const retire = async (kind, evidence, finishedAtMs) => {
    // A retirement runs only under the exclusive lock this operation took, and refuses
    // before it writes a receipt, a digest or an intent if that lock is gone or replaced.
    const held = heldLock;
    assert.ok(held && ["operation.lock", recoveryLock].includes(held.name), "retirement requires this process's operation lock");
    held.own();
    const pinned = options.unusedBootstrapKnownHosts !== undefined;
    // A drain proof shows a host state that can change, so like the pinned unused proof
    // its 60-second deadline from the query's start goes with the DELETE itself.
    const drained = kind === "setup-failed" && evidence.schema === "benchmark-failed-setup-retirement/v3", bounded = pinned || drained;
    const deleteProofExpiresAtMs = bounded ? evidence.startedAtMs + 60000 : undefined;
    const requireFreshProof = () => {
      const current = Date.now();
      assert.ok(current >= finishedAtMs && (bounded ? current < deleteProofExpiresAtMs : current - finishedAtMs <= 60000),
        "retirement proof expired before deletion");
    };
    // The saved reservation as this process last loaded or saved it, read before the first
    // await and required to hold exactly the state this process has: every retirement write
    // is made only over these bytes, so a change made during the host read, an evidence
    // verification or a provider read refuses and is kept as made, never overwritten. Each
    // save below replaces them with the bytes it wrote.
    const changedReservation = "saved reservation changed before the deletion intent; preserve host";
    let trusted = regular(statePath, 1024 * 1024), intentSaved = false;
    try { assert.equal(stateBytes(JSON.parse(trusted)), stateBytes(state)); }
    catch { throw new assert.AssertionError({ message: changedReservation }); }
    const path = join(local, retirementFile(kind));
    // A v2 or v3 setup receipt left without its intent is recovered against the ledger
    // prefix it names, using its own timestamps, so its bytes must also be the ones whose
    // digest was saved before it was published. v1, unused and pinned unused receipts are
    // still recovered only by full verification against the current state.
    const recorded = kind === "setup-failed" && !!state.control;
    const limit = state.control && kind === "setup-failed" ? 8 * 1024 * 1024 : 4096;
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`, written = digest(bytes);
    // The bytes this process wrote, not the file, are the authority: once published, the
    // receipt must still be them at every later check until the DELETE is sent.
    const requirePublished = () => assert.equal(digest(regular(path, limit)), written,
      "published retirement receipt differs from the bytes written; preserve host");
    // What the intent's verification pinned: for a v2 or v3 receipt the archived control
    // custody its proof was built from (including any watcher failure) and, for a setup
    // retirement, the archive and the extracted tree its replay verifier hashes.
    const pins = [], custody = recorded ? evidence.observation.control.custody : undefined;
    const requireEvidence = () => {
      if (custody) {
        try {
          const directory = join(local, state.evidence, "control"); physical(directory);
          assert.deepEqual(readdirSync(directory).sort(), custody.map((entry) => entry.name).sort());
          for (const entry of custody) {
            const bytes = regular(join(directory, entry.name), 8 * 1024 * 1024);
            assert.ok(bytes.length === entry.bytes && digest(bytes) === entry.sha256);
          }
        } catch (cause) { throw new Error("archived control custody changed; preserve host", { cause }); }
      }
      for (const pin of pins) pin();
    };
    let published = false, verified = false, dispatched = false;
    // The one custody every write and the DELETE rest on, checked after each await or slow
    // step and immediately before each write, including inside each state save and receipt
    // or history publication between its synced stage and the rename or link. In order: the
    // evidence the intent's verification pinned (once verified), which is the slowest part,
    // then the receipt this process published (once published), the lock this operation
    // holds, the saved reservation byte for byte and, until the intent, a bounded proof's
    // deadline, so the fast checks always follow the slow ones and a change made while the
    // evidence is walked is still seen. After the intent the deadline goes with the DELETE
    // itself, and once the DELETE has been sent only the lock and the reservation remain:
    // the absence read and destroyedAt must not be refused for a deadline the DELETE already
    // met, and the receipt and evidence are verified again by any later collect.
    const requireCustody = () => {
      if (verified && !dispatched) requireEvidence();
      if (published && !dispatched) requirePublished();
      held.own();
      assert.ok(regular(statePath, 1024 * 1024).equals(trusted), intentSaved
        ? "saved retirement reservation changed; preserve host" : changedReservation);
      if (bounded && !intentSaved) requireFreshProof();
    };
    // A state save writes and syncs its stage before the rename that replaces state.json, so
    // custody is checked again between the two: a change made while the stage was written
    // refuses before the rename, and the stage this call created is removed unread.
    const saveState = (kind) => {
      check();
      writeState(state, (stage, target) => {
        try { requireCustody(); } catch (error) { unlinkSync(stage); throw error; }
        renameSync(stage, target);
      }, kind);
    };
    // The provider read awaits, so custody is checked again after it and before each
    // publication below: a lock or reservation changed during the read refuses with
    // nothing saved.
    await own(); check(); requireCustody();
    if (pinned) requireUnusedBootstrapCustody();
    requireFreshProof();
    assert.ok(Buffer.byteLength(bytes) <= limit, "bounded retirement record required");
    // A staged publication (durableNew) runs the same custody check between its synced stage
    // and the link that publishes it; a refusal there removes that stage, so nothing is
    // published over a change made while it was written.
    const publish = recorded ? (target, content) => durableNew(target, content, requireCustody) : durable;
    // Such a receipt and its history copy are published whole (durableNew), so a write
    // interrupted before publication leaves only an untrusted stage, removed here unread.
    if (recorded) { requireCustody(); discardPublicationStage(path); }
    if (existsSync(path)) {
      // A crash between receipt and state writes is recoverable. Preserve the
      // exact old record, but only this operation's fresh probe authorizes intent.
      assert.ok(!state.deletionIntentAt && !state.retirement, "existing retirement intent cannot be repeated");
      const prior = regular(path, limit), hash = digest(prior);
      if (recorded) {
        assert.ok(state.pendingRetirement, "interrupted retirement receipt has no recorded digest; preserve host");
        assert.ok(state.pendingRetirement.kind === kind && state.pendingRetirement.evidenceSha256 === hash,
          "interrupted retirement receipt differs from its recorded digest; preserve host");
      }
      // Verifying a setup receipt hashes the archive and its extraction, a slow step, so
      // custody is checked again after it and before each of the writes that follow.
      verifyRetirementRecord(prior, kind, true);
      const retained = join(local, `${retirementFile(kind).slice(0, -5)}.interrupted-${hash}.json`);
      if (recorded) { requireCustody(); discardPublicationStage(retained); }
      if (existsSync(retained)) assert.equal(digest(regular(retained, limit)), hash, "interrupted retirement history differs");
      else { requireCustody(); publish(retained, prior); }
      assert.equal(digest(regular(path, limit)), hash, "interrupted retirement receipt changed");
      requireCustody(); unlinkSync(path); syncDirectory(local);
    }
    // Supersedes any earlier digest; the retirement state below clears it. The digest is
    // saved before the receipt is published, so a published receipt always has one. Like
    // publishCreateErrored, it goes through its own fresh exclusive stage, so a save torn
    // here leaves an unread stage rather than a state.json.tmp that blocks the next collect.
    if (recorded) {
      check(); requireCustody(); state.pendingRetirement = { kind, evidenceSha256: written }; saveState("pending-retirement");
      trusted = Buffer.from(stateBytes(state));
    }
    requireCustody(); publish(path, bytes);
    published = true; requireCustody();
    const publishIntent = () => {
      // A drain proof's intent follows the DELETE's account preflight, which awaits, so
      // custody (including the receipt) is checked first; the intent save would otherwise
      // overwrite a change made during that read and then guard against itself.
      requireCustody();
      // The retirement is verified, and its archive and extraction pinned, before the intent
      // is saved, so evidence that changed leaves the receipt and its digest with no intent,
      // which the next collect recovers on a fresh proof. From then on custody includes the
      // pinned evidence, so the check after this verification and the one between the intent
      // stage's sync and its rename cover the evidence, the receipt, the lock, the
      // reservation and a bounded proof's deadline.
      const prior = state, intended = { ...prior, status: "retired", retirement: { kind, evidenceSha256: written }, deletionIntentAt: new Date().toISOString() };
      delete intended.pendingRetirement;
      state = intended;
      try { verifyRetirement(pins); verified = true; requireCustody(); }
      catch (error) { state = prior; verified = false; pins.length = 0; throw error; }
      saveState("deletion-intent");
      trusted = Buffer.from(stateBytes(state)); intentSaved = true; beforeIntent = prior;
    };
    let beforeIntent;
    // A drain proof's DELETE is sent with allowFail, so the provider worker, the in-process
    // engine or the production checkpoint can positively acknowledge that it never sent the
    // request (its deadline or cancellation refused before dispatch; the acknowledgement does
    // not say which, so the refusal names neither). Only then is the intent
    // withdrawn. Record the exact intent and its restoration even under cancellation.
    // A missing, failed or lost acknowledgement never creates that proof and keeps the
    // intent, whose recovery is exact absence alone.
    const withdrawUnsentIntent = () => {
      assert.ok(intentSaved && beforeIntent && !dispatched, "no unsent deletion intent to withdraw; preserve host");
      const fence = () => { boundary(); requireCustody(); };
      const proof = drainWithdrawal(trusted, beforeIntent);
      fence(); durable(proof.path, proof.bytes);
      publishWithdrawal(proof, beforeIntent, fence);
      throw new Error("DELETE was not dispatched; the next collect retires on a fresh proof");
    };
    // Everything the DELETE relies on, as this process left it, through the same custody
    // check: the pinned evidence first, then the receipt, the lock and the saved reservation
    // that names its digest, so the last step before dispatch follows the slow ones. The
    // transport calls this again after its last local await before the request.
    const requireRetirementCustody = () => {
      assert.ok(intentSaved, "deletion intent required before the DELETE; preserve host");
      requireCustody();
    };
    const deletion = ["compute", "droplet", "delete", state.id, "--force"];
    if (drained) {
      // A drain proof's intent is saved only after the DELETE's own account preflight and
      // the deadline check that follows it, so a proof that expires during that read leaves
      // the receipt and its digest with no intent, which the next collect recovers on a
      // fresh proof. The deadline still goes with the DELETE itself.
      await execute("doctl", deletion, 120000, true, { expiresAt: () => deleteProofExpiresAtMs, publishIntent, onUnsent: withdrawUnsentIntent },
        undefined, undefined, requireRetirementCustody);
    } else {
      publishIntent();
      requireRetirementCustody();
      await execute("doctl", deletion, 120000, false, deleteProofExpiresAtMs, undefined, undefined, requireRetirementCustody);
    }
    dispatched = true;
    await confirmDeleted();
    // The absence read awaits too: destroyedAt is published only while this operation still
    // holds its lock and the saved reservation is still the intent it wrote.
    requireCustody();
    state.destroyedAt = new Date().toISOString(); saveState("destroyed"); return 1;
  };
  const retireUnused = async () => {
    assert.equal(state.status, "preparing", "only a never-started allocation can be retired as unused");
    const bootstrap = options.unusedBootstrapKnownHosts !== undefined, script = unusedHostScript(state, { bootstrap });
    let raw, startedAtMs, knownHostsSha256;
    if (!bootstrap) {
      assert.ok(!state.control?.monitor || state.control.ledger.length > 0, "unused bootstrap requires an approved pinned observation");
      startedAtMs = Date.now(); raw = (await ssh(script, 30000)).stdout;
    } else {
      await own();
      const key = regular(options.unusedBootstrapKnownHosts, 1024 * 1024);
      knownHostsSha256 = digest(key);
      assert.equal(knownHostsSha256, unusedBootstrapApproval.knownHostsSha256, "approved host-key file changed");
      // Stay under the private state root, but outside the durable reservation.
      raw = await withHostKeySnapshot(key, ".unused-host-key-", async (hostOptions) => {
        // Do not install a guardian or turn a missing acknowledgement into a receipt.
        startedAtMs = Date.now();
        return (await execute("ssh", [...hostOptions, `root@${state.ip}`, script], 30000)).stdout;
      });
    }
    const finishedAtMs = Date.now();
    const evidence = unusedEvidence(raw, state, script, startedAtMs, finishedAtMs, knownHostsSha256);
    return retire("unused", evidence, finishedAtMs);
  };
  const refuseSetup = (stage) => { throw Object.assign(new Error(stage), { controllerStage: stage }); };
  const checkSetupCustody = (exit) => {
    // An archived watcher failure is never a receipt. It selects the separate drain
    // proof only when every failure names a settled bootstrap row without a receipt.
    // A custody read failure is not a missing proof: it keeps its own error, which the
    // production wrapper reports as controller-collect, and still stops before any query.
    let failures;
    try { failures = setupWatcherFailures(state, local); }
    catch (error) { if (error instanceof SetupWatcherProofMissing) refuseSetup("setup-watcher-proof-missing"); throw error; }
    // An acknowledged refusal is not a missing result. Do not append more
    // controls on restart or treat the refusal as permission to retire.
    const rows = state.control.ledger, last = rows.at(-1);
    if (last?.setupProofRejected) refuseSetup("setup-host-proof-refused");
    if (last?.localTerminal && last.code > 0 && last.code < 255 && last.request.epoch === "collection"
      && last.request.invocation.channel === "ssh"
      && last.request.invocation.requestSha256 === digest(`set -euo pipefail\n${terminalSetupScript(state, exit, rows.length - 1, failures)}\n`))
      refuseSetup("setup-host-proof-refused");
    return failures;
  };
  // After registration a watcher failure still refuses before any query. The drain proof
  // is only for the pre-registration bootstrap, where no stream state can exist yet.
  const refuseRegisteredWatcher = () => {
    const custody = join(local, state.evidence, "control");
    if (state.control && existsSync(custody) && readdirSync(custody).some((name) => /^watch-failure-[a-f0-9]{32}\.json$/.test(name)))
      refuseSetup("setup-watcher-proof-missing");
  };
  const retireFailedSetup = async () => {
    assert.ok(["starting", "running"].includes(state.status) && !preserveOperationLock, "uncertain work cannot use setup retirement");
    const exit = setupExit(), beforeEntry = !!state.preBootstrapTerminal;
    if (!beforeEntry) refuseRegisteredWatcher();
    const failures = beforeEntry ? checkSetupCustody(exit) : [];
    const script = terminalSetupScript(state, exit, undefined, failures), startedAtMs = Date.now();
    const sequence = state.control?.ledger.length;
    const result = await ssh(script, 30000, beforeEntry).catch((error) => {
      // The SSH checkpoint may abort after saving the exit but before handing
      // back the proof. Leave the lock: the reply was neither accepted nor rejected.
      const row = beforeEntry && state.control.ledger[sequence];
      if (row?.localTerminal && row.code === 0) preserveOperationLock = true;
      throw error;
    }), finishedAtMs = Date.now();
    if (result.status !== 0 || result.error) refuseSetup("setup-host-proof-refused");
    let evidence;
    try { evidence = setupEvidence(result.stdout, state, script, exit, startedAtMs, finishedAtMs, local); }
    catch (error) {
      if (!beforeEntry) throw error;
      // The command exited zero; its response did not prove safe retirement.
      state.control.ledger.at(-1).setupProofRejected = true;
      try { save(); } catch (writeError) { preserveOperationLock = true; throw writeError; }
      refuseSetup("setup-host-proof-refused");
    }
    return retire("setup-failed", evidence, finishedAtMs);
  };
  async function captureNativeFailure(controllerCommit, grouped) {
    const originalPath = join(local, "failed-native-reservation.json"), capturePath = join(local, "failed-native-capture.json"),
      custodyArchive = join(local, "failed-native-results.tgz");
    const present = grouped?.preplan ? (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined : existsSync;
    const preserved = present(originalPath), captured = present(capturePath), original = regular(preserved ? originalPath : statePath, 1024 * 1024);
    if (grouped?.preplan) {
      if (captured) assert.ok(preserved, "captured preimage missing; preserve custody");
      assert.equal(digest(original), recoveryApproval.preservedReservationSha256, "approved preserved reservation changed before custody");
    }
    const parsed = JSON.parse(original), prior = grouped?.preplan ? controllerState(parsed, options.round) : parsed;
    verifyFailedNativeReservation(state, prior, grouped);
    const probeTimeout = 11 * 60000;
    let capture;
    if (captured) {
      if (!preserved) durable(originalPath, original);
      capture = verifyFailedNativeCustody(local, state, JSON.parse(regular(capturePath)), grouped);
      assert.equal(capture.controllerCommit, controllerCommit, "custody controller source changed");
    } else {
      assert.ok(!present(custodyArchive) && !present(`${custodyArchive}.download`) && (!grouped?.preplan
        || !present(`${custodyArchive}.synced`) && !present(join(local, "failed-native-host.json"))
          && !readdirSync(local).some((name) => name.startsWith("custody-"))), "unrecorded custody retained; no automatic adoption");
      const script = failedNativeScript(state, null, null, grouped);
      if (grouped?.preplan) {
        const appended = state.control.ledger.slice(prior.control.ledger.length), requestSha256 = digest(`set -euo pipefail\n${script}\n`);
        // The preserved prefix is exact. Before a capture exists, only a
        // positively settled refusal of this very probe permits another try.
        assert.ok((appended.length || recoveryApproval.preservedReservationSha256 === recoveryApproval.reservationSha256)
          && appended.every(({ request, localTerminal, code }) => localTerminal && code > 0 && code < 255
            && request.epoch === "collection" && request.invocation.channel === "ssh"
            && request.invocation.deadlineMs === probeTimeout && request.invocation.requestSha256 === requestSha256),
        "only a settled first custody probe refusal may extend the preserved reservation");
      }
      if (!preserved) durable(originalPath, original);
      const startedAtMs = Date.now(), result = await ssh(script, probeTimeout, grouped?.preplan === true), finishedAtMs = Date.now();
      if (grouped?.preplan) assert.ok(result.status === 0 && !result.error, "preplan custody probe refused; preserve host and evidence");
      const observation = failedNativeObservation(result.stdout, state, startedAtMs, finishedAtMs, grouped);
      const download = `${custodyArchive}.download`; durable(download, "");
      await scp(`root@${state.ip}:/bench/failed-native-custody.tgz`, download);
      durableCopy(download, `${custodyArchive}.synced`, observation.archiveSha256);
      renameSync(`${custodyArchive}.synced`, custodyArchive); syncDirectory(local);
      const extracted = mkdtempSync(join(local, "custody-"));
      const hash = await extractArchive(custodyArchive, extracted, observation.archiveSha256); check();
      capture = { schema: "benchmark-failed-native-custody/v1", measuredCommit: state.commit, controllerCommit,
        ...(grouped?.preplan ? { scope: "grouped-preplan", launchIntentSha256: recoveryApproval.intent.launch } : {}),
        reservationSha256: digest(original), scriptSha256: digest(script), observation, startedAtMs, finishedAtMs,
        evidence: basename(extracted), evidenceSha256: hash };
      verifyFailedNativeCustody(local, state, capture, grouped); durable(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
    }
    verifyFailedNativeCustody(local, state, capture, grouped); check();
    return capture;
  }
  async function retireNativeFailure(controllerCommit, grouped, handoff) {
    let capture;
    if (handoff) ({ capture, grouped } = verifyHandoffCustody(local, state, handoff));
    else {
      const { retirementAllowed } = failedNativeArchive(local, state, grouped);
      capture = await captureNativeFailure(controllerCommit, grouped);
      if (!retirementAllowed) return 3; // Ambiguous native outcome: retain both the data and the host.
    }
    // Local custody verification precedes a fresh, full remote rehash and
    // current-quiescence proof. Neither is historical native qualification.
    check();
    if (handoff) { handoffLocks(local, true); assertHandoffLock(); }
    const rehashScript = failedNativeScript(state, capture.observation.snapshotSha256, null, grouped), rehashStarted = Date.now();
    const rehashRaw = (await ssh(rehashScript, 11 * 60000)).stdout, rehashFinished = Date.now();
    const rehashObservation = failedNativeObservation(rehashRaw, state, rehashStarted, rehashFinished, grouped);
    const withoutTime = ({ observedAtMs, ...rest }) => rest;
    assert.deepEqual(withoutTime(rehashObservation), withoutTime(capture.observation), "predelete custody differs");
    if (handoff) {
      ({ assertCustody: assertHandoffCustody } = verifyHandoffCustody(local, state, handoff, true));
      handoffLocks(local, true);
      assertHandoffLock();
    } else verifyFailedNativeCustody(local, state, capture, grouped);
    const receiptPath = join(local, "failed-native-host.json");
    let interruptedReceipt;
    if (existsSync(receiptPath)) {
      const prior = regular(receiptPath), hash = digest(prior);
      // Verify against the actual measured state, without adopting an intent.
      verifyFailedNativeRetirement(local, state, hash);
      const history = join(local, `failed-native-host.interrupted-${hash}.json`);
      if (existsSync(history)) assert.equal(digest(regular(history)), hash); else durable(history, prior);
      interruptedReceipt = hash;
    }
    // Full local verification can be expensive. Renew only the current host
    // proof afterwards, while checking all remote metadata is still exactly
    // the previously hashed inventory and the custody archive is unchanged.
    const script = failedNativeScript(state, capture.observation.snapshotSha256, capture.observation, grouped), startedAtMs = Date.now();
    const raw = (await ssh(script, 11 * 60000)).stdout, finishedAtMs = Date.now();
    const confirmation = failedNativeObservation(raw, state, startedAtMs, finishedAtMs, grouped);
    assert.deepEqual(withoutTime(confirmation), withoutTime(capture.observation), "final custody fence differs");
    await own(); check();
    if (handoff) checkHandoffDelete();
    // Bound the whole local fence operation, including SSH response delivery.
    // Its start precedes the observation without relying on remote clock skew.
    const deleteProofExpiresAtMs = startedAtMs + 60000;
    assert.ok(Date.now() >= finishedAtMs && Date.now() < deleteProofExpiresAtMs, "current retirement proof expired");
    const receipt = { schema: `benchmark-failed-native-retirement/${handoff ? "v2" : "v1"}`,
      ...(handoff ? { handoff } : {}), capture, confirmation, scriptSha256: digest(script), startedAtMs, finishedAtMs,
      rehash: { observation: rehashObservation, scriptSha256: digest(rehashScript), startedAtMs: rehashStarted, finishedAtMs: rehashFinished } };
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    if (interruptedReceipt !== undefined) {
      // Only this invocation's fresh proof can replace an interrupted receipt.
      assert.equal(digest(regular(receiptPath)), interruptedReceipt); unlinkSync(receiptPath); syncDirectory(local);
    }
    durable(receiptPath, bytes);
    if (handoff) {
      handoffReceiptSha256 = digest(bytes);
      checkHandoffDelete(false);
      assert.ok(Date.now() < deleteProofExpiresAtMs, "current retirement proof expired");
    }
    Object.assign(state, { status: "retired", retirement: { kind: "native-failed", evidenceSha256: digest(bytes) }, deletionIntentAt: new Date().toISOString() }); save("deletion-intent");
    await execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000, false, deleteProofExpiresAtMs);
    await confirmDeleted();
    if (handoff) checkHandoffDelete();
    state.destroyedAt = new Date().toISOString(); save("destroyed"); return 1;
  }
  async function retireFailedExitOne(controllerCommit, reservationSha256, original, recovery) {
    const assertLaunch = ({ launchIntentSha256, fleetManifestSha256 }) => {
      assert.equal(launchIntentSha256, recovery.intent.launch, "approved exit-one launch changed");
      assert.equal(fleetManifestSha256, recovery.fleetManifestSha256, "approved exit-one fleet changed");
    };
    let absenceConfirmedAt;
    const pin = (assertCustody, receiptSha256) => {
      assertHandoffCustody = assertCustody;
      handoffReceiptSha256 = receiptSha256;
      afterSettle = () => {
        checkHandoffDelete();
        if (absenceConfirmedAt !== undefined && !state.destroyedAt) {
          state.destroyedAt = absenceConfirmedAt;
          save("destroyed");
        }
      };
    };
    const settleAbsence = async (dispatch) => {
      if (dispatch) await dispatch();
      checkHandoffDelete();
      await confirmDeleted();
      checkHandoffDelete();
      absenceConfirmedAt = new Date().toISOString();
      return 1;
    };
    if (state.status === "retired") {
      const { record, assertCustody } = verifyFailedExitOneRetirement(local, state, state.retirement.evidenceSha256, true);
      assert.equal(record.controllerCommit, controllerCommit, "original exit-one retirement controller required");
      assertLaunch(record);
      pin(assertCustody, state.retirement.evidenceSha256);
      return settleAbsence();
    }
    assert.notEqual(controllerCommit, state.commit, "repair source must be distinct from measured source");
    const custody = verifyFailedExitOneCustody(local, state, { pin: true });
    pin(custody.assertCustody);
    assertLaunch(custody);
    const { grouped, launchIntentSha256, fleetManifestSha256 } = custody;
    const evidenceFingerprint = exitOneEvidenceFingerprint(local, state);
    await verifyArchiveTree(archive, join(local, state.evidence), state.archiveSha256);
    check(); checkHandoffDelete();
    const probe = async (first) => {
      const script = failedNativeScript(state, first?.snapshotSha256 ?? null, first ?? null, grouped);
      const response = await ssh(script, first ? 60000 : 11 * 60000);
      const startedAtMs = response.startedAtMs, finishedAtMs = Date.now();
      return { startedAtMs, finishedAtMs, scriptSha256: digest(script),
        proof: failedExitOneObservation(response.stdout, state, startedAtMs, finishedAtMs, custody) };
    };
    const observation = await probe();
    checkHandoffDelete();
    const fence = await probe(observation.proof);
    const withoutTime = ({ observedAtMs, ...rest }) => rest;
    assert.deepEqual(withoutTime(fence.proof), withoutTime(observation.proof), "exit-one proof changed before deletion");
    await own(); check(); checkHandoffDelete();
    const expiry = fence.startedAtMs + 60000;
    exitOneFenceFinishedAtMs = fence.finishedAtMs;
    const fresh = () => {
      const current = Date.now();
      assert.ok(current >= fence.finishedAtMs && current < expiry, "current exit-one retirement proof expired");
      return new Date(current).toISOString();
    };
    fresh();
    const originalPath = join(local, "failed-native-reservation.json");
    const record = { schema: "benchmark-failed-native-retirement/v3", controllerCommit, reservationSha256, launchIntentSha256,
      fleetManifestSha256, evidenceFingerprint, observation, fence };
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    assert.ok(Buffer.byteLength(bytes) <= 65536, "bounded exit-one retirement receipt required");
    const receiptPath = join(local, "failed-native-host.json");
    const pendingDeleteSha256 = digest(bytes);
    const deletion = {
      expiresAt: () => expiry,
      publishIntent() {
        // execute has finished the account preflight. Until here a failed
        // read or an expired fence leaves neither intent nor retirement files.
        checkHandoffDelete();
        const deletionIntentAt = fresh();
        durable(originalPath, original);
        durable(receiptPath, bytes);
        const originalSnapshot = handoffStateSnapshot(originalPath), receiptSnapshot = handoffStateSnapshot(receiptPath);
        assert.ok(originalSnapshot.bytes.equals(original), "exit-one reservation copy changed");
        pin((includeTree) => {
          custody.assertCustody(includeTree, true);
          const current = handoffStateSnapshot(originalPath);
          assert.ok(current.bytes.equals(original) && sameStateVersion(current.stat, originalSnapshot.stat), "exit-one reservation copy changed");
          assert.ok(sameStateVersion(lstatSync(receiptPath, { bigint: true }), receiptSnapshot.stat), "exit-one receipt replaced");
        }, pendingDeleteSha256);
        checkHandoffDelete(false);
        Object.assign(state, { status: "retired", retirement: { kind: "native-failed", evidenceSha256: handoffReceiptSha256 }, deletionIntentAt });
        writeState(state, renameSync, "deletion-intent");
      },
      onUnsent() {
        const alreadyUncertain = preserveOperationLock;
        preserveOperationLock = true;
        checkHandoffDelete();
        // Keep the exact tentative files under their receipt hash. Restore the
        // running state with its acknowledged collection ledger intact. An
        // interruption partway through still leaves a lock or blocked custody.
        durable(join(local, "failed-native-unsent-" + pendingDeleteSha256 + ".json"), bytes);
        durable(join(local, "failed-native-unsent-reservation-" + pendingDeleteSha256 + ".json"), original);
        state.status = "running"; delete state.retirement; delete state.deletionIntentAt;
        writeState(state, renameSync, "delete-unsent");
        checkHandoffDelete(false);
        unlinkSync(receiptPath); unlinkSync(originalPath); syncDirectory(local);
        pin(custody.assertCustody);
        preserveOperationLock = alreadyUncertain;
      },
    };
    return settleAbsence(() => execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000, true, deletion));
  }
  return {
    get state() { return state ? structuredClone(state) : undefined; }, local,
    async cancelMixedWait() {
      assert.equal(options.cancelMixedWait, true, "explicit mixed cancellation required");
      return locked(async () => {
        ownedMixedWait(state);
        assert.ok(recoveryApproval, "exact merged-source cancellation approval required");
        full(recoveryApproval.controllerCommit, /[a-f0-9]{40}/, "merged cancellation controller source required");
        assert.notEqual(recoveryApproval.controllerCommit, state.commit);
        assert.equal(digest(regular(statePath)), recoveryApproval.reservationSha256, "locked cancellation reservation changed");
        assert.equal(state.status, "running");
        for (const key of ["mixedCancellation", "archiveSha256", "evidence", "deletionIntentAt", "collectedAt"]) assert.equal(state[key], undefined);
        assert.ok(Date.now() < Date.parse(mixedWait.deadline), "original mixed wait deadline expired");
        assert.equal(fileHash(join(local, "known_hosts")), mixedWait.knownHostsSha256, "saved native host key view changed");
        for (const name of ["mixed-cancel-reservation.json", "mixed-cancel-intent.json", "mixed-cancel-signal.json"])
          assert.ok(!existsSync(join(local, name)), "single cancellation attempt already reserved; never signal again");
        await own(); // Fresh saved-context account/exact-ID/account before intent.
        const script = mixedCancelScript(state), original = regular(statePath);
        assert.equal(digest(original), recoveryApproval.reservationSha256, "reservation changed during ownership proof");
        const bytes = `${JSON.stringify({ schema: "benchmark-mixed-cancel-intent/v1", wait: mixedWait,
          controllerCommit: recoveryApproval.controllerCommit, reservationSha256: digest(original), scriptSha256: digest(script) }, null, 2)}\n`;
        durable(join(local, "mixed-cancel-reservation.json"), original);
        durable(join(local, "mixed-cancel-intent.json"), bytes);
        // From here even a refusal or lost response retains the operation lock.
        preserveOperationLock = true;
        state.mixedCancellation = { controllerCommit: recoveryApproval.controllerCommit,
          reservationSha256: digest(original), intentSha256: digest(bytes) }; save();
        verifyMixedCancellation(local, state);
        assert.equal(digest(regular(statePath)), digest(`${JSON.stringify(state, null, 2)}\n`), "cancellation state changed before dispatch");
        const startedAtMs = Date.now(), raw = (await ssh(script, 50000)).stdout, finishedAtMs = Date.now();
        const observation = mixedSignalObservation(raw, state, startedAtMs, finishedAtMs);
        const signalBytes = `${JSON.stringify({ observation, startedAtMs, finishedAtMs }, null, 2)}\n`;
        durable(join(local, "mixed-cancel-signal.json"), signalBytes);
        verifyMixedCancellation(local, state);
        assert.equal(digest(regular(statePath)), digest(`${JSON.stringify(state, null, 2)}\n`), "cancellation state changed during dispatch");
        state.mixedCancellation.signalSha256 = digest(signalBytes); save();
        verifyMixedSignal(local, state);
        preserveOperationLock = false;
        return 3; // Signal acknowledgement is neither terminal proof nor deletion.
      });
    },
    async launch() {
      assert.ok(options.detach, "detach options required");
      const launchLock = join(base, ".groups-launch.lock");
      durable(launchLock, `${JSON.stringify({ pid: process.pid, round: options.round })}\n`);
      try {
        assert.ok(!existsSync(local), "round already reserved; never relaunch");
        // Every earlier provider-errored round's posted droplet is fenced by ID alone in
        // this launch's pre-create census, whatever its name or tags now are.
        // That includes a contradicted create retired by the pinned route: retirement
        // removed the droplet it bound, not the record that the ID was posted and seen again.
        const postedIds = new Set(), priors = [];
        const admitPrior = (path, round) => {
          const prior = read(path, round);
          assert.ok(prior.destroyedAt || prior.createErrored && verifyCreateErrored(path, prior)
            && !existsSync(join(path, "operation.lock")) && !existsSync(join(path, recheckLock)), "unresolved reservation blocks launch");
          return prior;
        };
        for (const entry of readdirSync(base)) if (entry.startsWith("groups-")) {
          const match = /^groups-(r[1-9]\d{0,8})$/.exec(entry); assert.ok(match, "unknown reservation");
          const path = join(base, entry), prior = admitPrior(path, match[1]);
          priors.push({ path, round: match[1], sha256: digest(regular(join(path, "state.json"), 1024 * 1024)) });
          const posted = prior.createErrored ?? prior.createContradicted;
          if (posted) {
            assert.equal(prior.provider.accountId, options.accountId,
              "an earlier provider-errored create is on another provider account; this census cannot fence its posted droplet; preserve reservation");
            postedIds.add(posted.dropletId);
          }
        }
        // Again after the census, immediately before create intent: an earlier round that
        // has since changed, taken custody or been contradicted refuses the create.
        recheckPriorRounds = () => {
          for (const { path, round, sha256 } of priors) {
            try { admitPrior(path, round); assert.equal(digest(regular(join(path, "state.json"), 1024 * 1024)), sha256); }
            catch (cause) { throw new Error("an earlier reservation in this root changed before this create; preserve reservation", { cause }); }
          }
        };
        checkFleetAdmission?.();
        mkdirSync(local, { mode: 0o700 }); syncDirectory(base);
        state = { ...reservation({ round: options.round, commit: options.commit,
          token: fleet ? fleet.jobs.find((row) => row.group === options.group).token : randomBytes(8).toString("hex"),
          ...(fleet ? { group: options.group, fleet } : {}),
          ...(remainingPlacement ? { remainingPlacement } : {}) }),
          provider: { accountId: options.accountId, context: options.context }, fullGroupQualified: false, benchPackage: true, gitSource: true, trixieUpstream: true,
          ...(fleet && canSkipHostChromium(options.group) ? { skipHostChromium: true } : {}),
          ...(fleet ? { quietBootstrap: "prelogin" } : {}),
          control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [],
            ...(fleet?.single?.offlineHandoff ? {} :
              { monitor: { schema: "benchmark-supervised-control/v1", id: randomBytes(16).toString("hex"), phase: "pending" } }) } };
        controlEpoch = "bootstrap";
        durable(statePath, `${JSON.stringify(state, null, 2)}\n`);
        return await locked(async () => {
          assert.equal(realpathSync((await execute("git", ["rev-parse", "--show-toplevel"])).stdout.trim()), repo);
          assert.equal((await execute("git", ["rev-parse", "HEAD"])).stdout.trim(), state.commit, "measured HEAD differs");
          assert.equal((await execute("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim(), "", "clean committed source required");
          await execute("git", ["merge-base", "--is-ancestor", state.commit, mergedHead]);
          for (const path of ["bench/workloads/droplet.mjs", "bench/workloads/cloud-contract.mjs", "bench/workloads/isolated/campaign-entry.mjs", "bench/workloads/isolated/campaign-verify.mjs", ...benchPackagePaths])
            await execute("git", ["cat-file", "-e", `${state.commit}:${path}`]);
          // With historical custody, sightings and ordinary pre-create predicates
          // use the same account-bracketed response. Only completeness proves absence.
          const strictCensus = preCreateCensusTargets.length > 0;
          const { rows: existing, complete } = strictCensus
            ? JSON.parse((await execute("doctl", ["compute", "droplet", "list", "--pre-create-census", ...preCreateCensusTargets, "--output", "json"])).stdout)
            : { rows: await list(), complete: true };
          assert.ok(Array.isArray(existing) && (!strictCensus
            || existing.every((d) => Number.isSafeInteger(d?.id) && d.id > 0)), "invalid pre-create census");
          const completeInventory = complete === true && (!strictCensus || existing.length <= 200
            && existing.every((d) => typeof d.name === "string" && Array.isArray(d.tags) && d.tags.length <= 256)
            && new Set(existing.map(({ id }) => id)).size === existing.length);
          try { inspectPreCreateInventory?.(existing, completeInventory); }
          catch (error) { if (error.controlUncertain) preserveOperationLock = true; throw error; }
          assert.ok(!existing.some((d) => postedIds.has(String(d.id))),
            "an earlier provider-errored create's posted droplet is listed; never create beside it; preserve reservation");
          assert.ok(completeInventory, "pre-create census incomplete; preserve reservation");
          if (fleet) assertFleetCensus(existing, fleet, remainingPlacement?.region, fleet.single ? checkFleetAdmission("census") : []);
          else assert.ok(!existing.some((d) => d.name?.startsWith("corten-bench-groups-") || d.tags?.includes(tags[0])), "benchmark host already exists");
          assert.ok(!existing.some((d) => d.name === state.name || d.tags?.includes(state.tag)), "this host already exists; never adopt/relaunch");
          const account = JSON.parse((await execute("doctl", ["account", "get", "--output", "json"])).stdout);
          assert.equal(providerAccount(account), state.provider.accountId, "provider account identity changed; preserve uncertainty");
          const limit = (Array.isArray(account) ? account[0] : account)?.droplet_limit;
          assert.ok(Number.isSafeInteger(limit) && limit >= 0, "account capacity unavailable");
          if (existing.length >= limit) throw Object.assign(new Error("account capacity unavailable"),
            { providerDiagnostic: { code: "account-capacity" } });
          if (fleet) {
            const present = existing.filter((d) => fleet.jobs.some((row) => row.name === d.name)).length;
            assert.ok(existing.length + fleet.jobs.length - present <= limit, "account capacity cannot cover the reserved fleet");
            const catalog = fleetCatalogResult(await execute("doctl", fleetCatalogCommand, 60000, true));
            fleetRegion(catalog, remainingPlacement?.region ?? fleet.host.region,
              { remainingOnly: remainingAdmission, staged: stagedFleet(fleet), group: fleet.single?.group,
                ...(fleet.single?.loadLayout ? { loadLayout: fleet.single.loadLayout } : {}) });
          }
          let created;
          try {
            created = await execute("doctl", ["compute", "droplet", "create", state.name, "--size", state.host.size, "--region", state.host.region, "--image", state.host.image,
              "--ssh-keys", options.sshKey, "--tag-names", [...tags, state.tag].join(","), "--wait", "--output", "json"], 10 * 60000, true);
          } catch (error) {
            // An accepted create still unsettled at its deadline keeps the POST's droplet and
            // action IDs beside the preserved locks, so a later read can settle that exact action.
            const posted = pendingCreate(error?.pendingCreate);
            if (posted && (error.controlUncertain || error.controlTreeUncertain) && state.status === "creating" && !state.id) {
              try { boundary(); state.createPending = posted; writeState(state); } catch { /* Preserve without the IDs. */ }
            }
            throw error;
          }
          // A provider-terminal create failure retires this attempt only with all four
          // proofs: exact action/droplet identity and errored status (worker), the saved
          // account and exact absence (providerAbsent). Otherwise preserve as before.
          const errored = erroredCreate(created);
          let census;
          if (errored) {
            // Save the posted IDs before any absence read: from here only that droplet can
            // be bound, and a stop at any later point leaves a reservation whose exact
            // action a later collect can recheck, not an orphan receipt.
            check(); state.createPending = errored; save();
            census = await providerAbsence(errored);
            if (census?.droplets !== undefined) {
              check();
              const bytes = createErroredBytes(createErroredRecord(state, errored, census.droplets, new Date().toISOString()));
              durable(join(local, createErroredReceipt), bytes);
              publishCreateErrored(errored, bytes);
              throw createErroredStop();
            }
          }
          // Lost acknowledgement permits only identity reconciliation, never another create.
          // An errored create named its droplet: only that ID's positive exact GET binds it.
          try { bind(errored ? witnessedPosted(census) : await own()); }
          catch (error) {
            const diagnostic = providerFailure(created);
            if (diagnostic && !providerFailure(error)) error.providerDiagnostic = diagnostic;
            throw error;
          }
          if (created.error || created.status !== 0) {
            const diagnostic = providerFailure(created);
            throw Object.assign(new Error("create completion was not proved; allocation retained for recovery"), diagnostic ? { providerDiagnostic: diagnostic } : {});
          }
          assert.ok(!fleet?.single || !launchPeers?.some((peer) => peer.id === state.id || peer.ip === state.ip),
            "newly bound host duplicates a supervised peer; retain custody without provisioning");
          const completed = JSON.parse(created.stdout);
          assert.ok(Array.isArray(completed) && completed.length === 1 && Number.isSafeInteger(completed[0]?.id)
            && completed[0].id > 0 && String(completed[0].id) === state.id,
          "completed create and owned host differ; preserve reservation without provisioning");
          await waitForSsh();
          assert.equal((await ssh("true", 30000, true)).status, 0, "SSH unavailable; never retry or relaunch");
          await ssh(bootstrapWorkspaceScript(state, { launch: true }));
          for (const [name, content] of Object.entries(remoteFiles(state))) {
            durable(join(local, name), content); await scp(join(local, name), `root@${state.ip}:/bench/${name}`);
            await ssh(`printf '%s  %s\\n' '${digest(content)}' '/bench/${name}' | sha256sum --check --status`);
          }
          await ssh(installBenchmarkUnit(state));
          state.status = "starting"; save(); await ssh(`systemctl start ${state.unit}`);
          // The start itself is a root login. Do not open the first status SSH
          // while the service drains that login and checks the manager.
          if (state.quietBootstrap) {
            for (let second = 0; second < rootManagerDrainSeconds + rootManagerCheckSeconds; second++) {
              check();
              await sleep(1000);
            }
          }
          await requireActiveStartup("group ended before running admission; collect its evidence");
          state.status = "running"; save();
          try { await commonBootstrap(); }
          catch (error) {
            if (!monitor) throw error;
            const alreadyUncertain = preserveOperationLock;
            preserveOperationLock = true; monitor.cancel();
            const ending = await monitor.done.catch(() => undefined);
            try {
              if (!ending?.terminal) recordMonitorEnd("invalid", (saved) => writeState(saved, renameBootstrapSeal));
              else if (verifyBootstrapPublication) {
                // This is a new closed snapshot from the canonical ledger, not promotion of the failed stage.
                verifyBootstrapPublication();
                recordMonitorEnd("closed", (saved) => writeState(saved, renameBootstrapSeal, "closed"));
                preserveOperationLock = alreadyUncertain;
              }
            } catch { /* Unsettled publication retains the original locks and staged evidence. */ }
            if (!preserveOperationLock) throw new Error("bootstrap seal publication failed; terminal monitor recorded");
            throw Object.assign(new Error("bootstrap seal failed after monitor registration; preserve host and custody"), { controlTreeUncertain: true });
          }
          if (monitor) {
            let result;
            try { result = await monitor.done; }
            catch (error) { recordMonitorEnd("invalid"); throw error; }
            recordMonitorEnd(result.terminal ? "closed" : "invalid");
            if (!result.terminal) {
              throw Object.assign(new Error("supervised monitor lost before terminal proof; retain host and custody"), { controlTreeUncertain: true });
            }
            check();
          }
          return structuredClone(state);
        });
      } finally { if (!preserveOperationLock) { unlinkSync(launchLock); syncDirectory(base); } }
    },
    async collect() {
      assert.ok(options.collect, "collect options required");
      if (absenceOnly) return locked(async () => {
        const original = () => {
          assertHandoffLock();
          assert.equal(digest(regular(statePath)), recoveryApproval.reservationSha256, "locked absence reservation changed");
          assert.ok(!existsSync(join(base, ".groups-launch.lock")), "child launch custody still held");
        };
        original();
        assert.ok(absentCollectionCandidate(options, state), "verified absence reconciliation required");
        assert.equal(state.commit, recoveryApproval.measuredCommit);
        assert.equal(state.id, recoveryApproval.hostId);
        const { sealedMonitor } = await import("./cloud-control-stream.mjs");
        sealedMonitor(local, state);
        await confirmDeleted(false);
        verifyArchive();
        const beforeReplay = JSON.stringify(state);
        const report = await validateEvidence(true, (input) => {
          const root = realpathSync(options.absentMeasuredCheckout);
          assert.equal(root, recoveryApproval.measuredRoot, "measured checkout changed");
          return validationTask(input, { snapshot: captureValidation(input.commit, { root }) });
        });
        assert.ok(JSON.stringify(state) === beforeReplay, "replay disagrees with saved verification");
        await confirmDeleted(false);
        return recordVerifiedAbsence(report, sealedMonitor, original);
      });
      if (options.unusedBootstrapKnownHosts !== undefined) return locked(async () => {
        if (requireUnusedBootstrapCustody())
          assert.equal((await execute("git", ["rev-parse", "HEAD"])).stdout.trim(), state.commit, "bootstrap uploads require the measured checkout");
        if (state.status === "preparing") return retireUnused();
        verifyRetirement(); await confirmDeleted();
        state.destroyedAt ??= new Date().toISOString(); save("destroyed"); return 1;
      });
      const observed = read();
      if (observed.createPending && observed.status === "creating" && !observed.id && !observed.createErrored) return settlePendingCreate(observed);
      // Any lock left beside a recorded failure keeps it unresolved (createErroredCustody).
      // A recorded, witnessed or staged reappearance of its posted droplet contradicts
      // the receipt for good: its only route is the exact owned posted droplet's bind.
      if (observed.createErrored) {
        createErroredCustody(local);
        const custody = "provider-errored create still holds custody; account for the lock's owner by the custody step; preserve reservation";
        if (observed.createErrored.reappeared || createContradiction(local)) return locked(async () => {
          assert.ok(state.createErrored, "create failure record changed; preserve reservation");
          assert.ok(!existsSync(join(local, recheckLock)) && !existsSync(join(base, ".groups-launch.lock")), custody);
          return contradictedCreate(state.createErrored);
        });
        verifyCreateErrored(local, observed);
        return locked(async () => {
          // Read-only recheck of the receipt and absence. Never DELETE or create; only a
          // contradicting exact owned posted droplet is bound (as above), never provisioned.
          assert.ok(state.createErrored, "create failure record changed; preserve reservation");
          assert.ok(!existsSync(join(local, recheckLock)) && !existsSync(join(base, ".groups-launch.lock")), custody);
          verifyCreateErrored(local, state);
          const posted = state.createErrored, census = await providerAbsence(posted);
          if (census?.witnessed) {
            recordReappeared(census.witnessed);
            const d = census.witnessed.via === "exact-get" && ownedPosted(census.witnessed.droplet, posted);
            if (d) return bindContradicted(d, posted);
            throw contradicted();
          }
          assert.ok(census?.droplets !== undefined, "provider-errored allocation no longer verified absent; preserve reservation");
          return 1;
        });
      }
      let failedMonitorRecovery = false;
      const neverProvisioned = (s) => s.control?.monitor?.phase === "pending" && !s.control.monitor.registrationSha256
        && s.id && s.ip && s.createIntentAt && !s.control.sealed.length
        && s.control.ledger.every((row) => row.request.epoch === "collection" && row.localTerminal)
        && (s.status === "preparing" || s.status === "retired" && s.retirement?.kind === "unused")
        && !readdirSync(local).some((name) => name.startsWith("monitor-"));
      // A settled create can leave an identified host before the first SSH operation.
      // No monitor exists then. The ordinary exclusive lock and fresh unused-host
      // proof still apply; neither a pending registration nor local state permits deletion.
      const unusedCandidate = neverProvisioned(observed);
      const beforeRegistration = (s) => s.preBootstrapTerminal && s.control.ledger.every((row) => row.localTerminal)
        && !existsSync(join(base, ".groups-launch.lock")) && !readdirSync(local).some((name) => name.startsWith("monitor-"));
      const setupCandidate = !!observed.preBootstrapTerminal;
      if (setupCandidate) assert.ok(beforeRegistration(observed), "ambiguous pre-bootstrap custody; preserve host");
      if (observed.control?.monitor && !unusedCandidate && !setupCandidate) {
        const { localStreamStatus, streamRecoveryReady } = await import("./cloud-control-stream.mjs");
        const status = localStreamStatus(local);
        if (["pending", "progress"].includes(status.kind)) {
          if (status.kind === "pending") assert.equal(observed.status, "running", "monitor not registered; preserve pending reservation");
          assert.ok(existsSync(join(local, "operation.lock")), "monitor absent or orphaned; preserve host"); return 3;
        }
        if (!streamRecoveryReady(local, observed.control.monitor)) return 3;
        failedMonitorRecovery = status.kind === "invalid";
        if (failedMonitorRecovery) assert.equal(observed.control.monitor.phase, "invalid", "foreground monitor has not settled");
      }
      return locked(async () => {
        if (options.r21MeasuredCheckout) {
          ownedR21(state);
          full(recoveryApproval?.controllerCommit, /[a-f0-9]{40}/, "approved successor required");
          assert.notEqual(recoveryApproval.controllerCommit, state.commit);
          full(recoveryApproval.knownHostsSha256, /[a-f0-9]{64}/, "approved host key required");
          assert.equal(options.exitArchiveSha256, recoveryApproval.archiveSha256);
          if (state.archiveSha256) assert.equal(state.archiveSha256, options.exitArchiveSha256);
          assert.equal(digest(regular(statePath)), recoveryApproval.reservationSha256, "locked r21 reservation changed");
        }
        const offline = state.fleet?.single?.offlineHandoff;
        const offlineAck = offline && offlineBootstrapAck();
        // Regular collection keeps this gate. A bound posted create that never started
        // has its own separately approved route, named in the refusal.
        if (offline && !offlineAck) {
          if (offlineNeverStarted(state)) throw Object.assign(new Error("offline handoff never started: retire the bound posted create only by the approved"
            + " pinned unused-host collection (--collect --unused-bootstrap-known-hosts); preserve host"), { controllerStage: "offline-never-started" });
          assert.fail("offline handoff not acknowledged; preserve host");
        }
        const sealed = state.control?.monitor?.phase === "closed" || offlineAck;
        const groupedCandidate = !options.r21MeasuredCheckout && state.status === "running" && groupedFailureCandidate(state);
        if (groupedCandidate && failedMonitorRecovery) assert.ok(state.launchHostKeySha256, "no launch-established host key; preserve host");
        const grouped = groupedCandidate && state.launchHostKeySha256
          ? groupedFailure(local, state) : undefined;
        let inspectUnit = unit, idleScript, unitState;
        const query = unitQuery(state) + " --all --property=Job --property=SubState --property=ControlPID";
        if (sealed || grouped) {
          if (sealed) assert.ok(!existsSync(join(base, ".groups-launch.lock")), "child launch custody still held");
          const { terminal, registration } = offline ? {} :
            grouped ?? (await import("./cloud-control-stream.mjs")).sealedMonitor(local, state);
          if (options.r21MeasuredCheckout) {
            assert.equal(terminal.campaign, recoveryApproval.campaign); assert.equal(terminal.sealSha256, recoveryApproval.sealSha256);
          }
          const unitSha256 = digest(remoteFiles(state)[state.unit]);
          idleScript = (pack, stamp) => idleArchiveScript(state, offline ? state.bootstrapReady.bootId : registration.host.bootId,
            unitSha256, { pack, stamp, completedOnly: !!groupedCandidate || !!offline });
          inspectUnit = async () => {
            if (offline) {
              // An audit-wait unit permits logins but its guardian rejects
              // collection while native ownership is live. Make one read-only,
              // pinned precheck before creating any collection ledger row.
              const probe = await usingLaunchHostKey((opts) =>
                execute("ssh", [...opts, `root@${state.ip}`, query], 20000, true));
              if (probe.status === 255 && !probe.error && !probe.signal) return false;
              assert.ok(probe.status === 0 && !probe.error && !probe.signal, "unit query refused");
              if (!sealedUnit(probe.stdout, state)) return false;
            }
            const result = await ssh(query, 60000, true);
            assert.ok(result.status === 0 && !result.error, "unit query refused");
            return sealedUnit(result.stdout, state);
          };
        }
        const remoteHash = async (pack = false) => {
          // A settled refusal (e.g. a queued job) is not a lost SSH command.
          const result = await ssh(idleScript?.(pack) ?? "sha256sum /bench/results.tgz", idleScript ? 15 * 60000 : 60000, !!idleScript);
          assert.ok(result.status === 0 && !result.error, "terminal archive or idle-host proof unavailable");
          const line = result.stdout;
          full(line, idleScript ? /[a-f0-9]{64}  \/bench\/results\.tgz\n[a-f0-9]{64}  -\n/ : /[a-f0-9]{64}  \/bench\/results\.tgz\n/, "invalid remote archive hash");
          const hash = line.slice(0, 64);
          if (options.r21MeasuredCheckout) assert.equal(hash, options.exitArchiveSha256, "not the reviewed exit archive");
          return { hash, stamp: idleScript ? line.split("\n")[1].slice(0, 64) : undefined };
        };
        if (unusedCandidate) assert.ok(neverProvisioned(state), "unused allocation changed; preserve host");
        assert.ok(!(state.status === "preparing" && state.control?.monitor?.phase === "pending"
          && state.control.ledger.length === 0), "unused bootstrap requires an approved pinned observation");
        assert.equal(!!state.preBootstrapTerminal, setupCandidate, "pre-bootstrap reservation changed; preserve host");
        if (setupCandidate) assert.ok(beforeRegistration(state), "ambiguous pre-bootstrap custody; preserve host");
        // ownedR21 above already excludes retired and pre-bootstrap reservations; the r21
        // test stays so the resume never runs for a measured checkout if that changes.
        if (setupCandidate && !options.r21MeasuredCheckout) await resumeDrainWithdrawal();
        if (state.status === "retired") {
          verifyRetirement();
          await confirmDeleted();
          state.destroyedAt ??= new Date().toISOString(); save("destroyed"); return 1;
        }
        if (state.deletionIntentAt) {
          // A prior verified, monitored collection may have timed out after DELETE.
          // No longer replay budget until this exact host is proved absent.
          if (absentCollectionCandidate(options, state)) {
            const before = regular(statePath), beforeReplay = JSON.stringify(state);
            const { sealedMonitor } = await import("./cloud-control-stream.mjs");
            await confirmDeleted();
            verifyArchive(); const report = await validateEvidence(true);
            assert.ok(JSON.stringify(state) === beforeReplay, "replay disagrees with saved verification");
            await confirmDeleted();
            return recordVerifiedAbsence(report, sealedMonitor, () => {
              assert.ok(regular(statePath).equals(before), "locked absence reservation changed");
            });
          }
          verifyArchive(); await validateEvidence();
          await confirmDeleted();
          state.destroyedAt ??= new Date().toISOString(); save("destroyed"); return deletedCode();
        }
        if (setupCandidate && state.evidence) checkSetupCustody(setupExit());
        assert.ok(offlineAck || state.control?.monitor || !state.control?.sealed.includes("bootstrap"),
          "terminal status unavailable without SSH intrusion; preserve host; registered native collection needs an approved observation protocol");
        assert.ok(state.createIntentAt, "no create intent; reservation requires operator inspection");
        bind(await own());
        if (state.status === "preparing") return retireUnused();
        if (setupCandidate) {
          const { stdout } = await ssh(unitQuery(state) + `\njob=$(systemctl show ${state.unit} --all --property=Job); test "$job" = 'Job='`);
          assert.ok(terminalUnit(stdout, state) && stdout === state.preBootstrapTerminal.stdout, "startup unit no longer identically terminal");
        } else {
          unitState = await inspectUnit(); if (!unitState) return 3; // Exactly one look; never wait for a live campaign.
        }
        if (!state.archiveSha256) {
          assert.ok(!existsSync(archive) && !existsSync(`${archive}.download`), "unrecorded download/archive retained; inspect before retry");
          // pack.sh copies current control custody before its archive-exists
          // check. Never change the snapshot beside a pre-existing exit archive.
          const pack = "timeout 600 /bin/bash /bench/pack.sh";
          if (!idleScript) await ssh(setupCandidate ? `if test -e /bench/results.tgz || test -L /bench/results.tgz; then
test -f /bench/results.tgz && test ! -L /bench/results.tgz && test "$(stat -c '%s' -- /bench/results.tgz)" -le ${archiveLimit}
else ${pack}; fi` : pack, 11 * 60000);
          const { hash } = await remoteHash(sealed && unitState === "terminal" && !options.r21MeasuredCheckout), download = `${archive}.download`;
          // Reserve the destination before SCP, so a crash cannot make it look retryable.
          durable(download, ""); await scp(`root@${state.ip}:/bench/results.tgz`, download);
          // Re-write through a synced exclusive file; never replace unexplained evidence.
          durableCopy(download, `${archive}.synced`, hash); renameSync(`${archive}.synced`, archive); syncDirectory(local);
          state.archiveSha256 = hash; save();
        }
        verifyArchive(); await archiveMembers(archive, state.archiveSha256); check();
        if (!state.evidence) {
          const extracted = mkdtempSync(join(local, "evidence-"));
          (state.extractionAttempts ??= []).push(basename(extracted)); save();
          const hash = await extractArchive(archive, extracted, state.archiveSha256); check();
          state.evidence = basename(extracted); state.evidenceSha256 = hash; save();
        }
        if (setupCandidate) return retireFailedSetup(); // Never inspect/publish native evidence without supervision.
        if (groupedCandidate && regular(join(local, state.evidence, "exit-code"), 16).equals(Buffer.from("2\n"))) {
          assert.ok(grouped, "no launch-established host key; preserve host");
          assert.equal((await execute("git", ["rev-parse", "HEAD"])).stdout.trim(), state.commit, "failed custody requires the measured checkout");
          return retireNativeFailure(state.commit, grouped);
        }
        try { await validateEvidence(); }
        catch (error) {
          if (sealed) throw error;
          // No native report can exist before entry. Only a separate fresh,
          // terminal pre-entry proof permits failed-setup cleanup, never success.
          try { setupExit(); } catch { throw error; }
          return retireFailedSetup();
        }
        if (failedMonitorRecovery) {
          save(); return 1; // Failed evidence custody only; keep original lock and require the existing explicit retirement gates.
        }
        state.collectedAt ??= new Date().toISOString(); state.status = "collected"; save();
        await withVerifiedArchive(archive, state.archiveSha256, async unchanged => {
          await validateEvidence();
          const deletion = ["compute", "droplet", "delete", state.id, "--force"];
          if (sealed) {
            const { hash, stamp } = await remoteHash(); assert.equal(hash, state.archiveSha256, "exit archive changed");
            // Account check, then transport's exact ownership check, then one short
            // SSH fence. The hashes and provider reads are outside its freshness budget.
            await execute("doctl", deletion, 120000, true, { unchanged, async expiresAt() {
              const proof = await ssh(idleScript(false, stamp) + "\n" + query, 60000, true);
              assert.ok(proof.status === 0 && !proof.error && sealedUnit(proof.stdout, state), "idle archive or terminal unit changed");
              return proof.startedAtMs + 60000;
            } });
          } else {
            assert.ok(await inspectUnit(), "unit became active; preserve host"); await own(); check(); unchanged();
            state.deletionIntentAt = new Date().toISOString(); save("deletion-intent"); await execute("doctl", deletion, 120000);
          }
        });
        await confirmDeleted();
        verifyArchive(); await validateEvidence(); state.destroyedAt = new Date().toISOString(); save("destroyed"); return deletedCode();
      }, failedMonitorRecovery);
    },
    async retireFailedNative() {
      assert.equal(options.retireFailedNative, true, "explicit failed-native action required");
      return locked(async () => {
        assert.ok(recoveryApproval, "source-bound production recovery approval required");
        full(recoveryApproval.controllerCommit, /[a-f0-9]{40}/, "merged repair source required");
        let grouped;
        if (groupedPreplan || pinnedRetirement) {
          assert.equal(typeof authorizeRecovery, "function", "locked production recovery approval required");
          const lockedApproval = await authorizeRecovery(); check();
          const { controllerCommit, reservationSha256, ...recovery } = recoveryApproval;
          assert.deepEqual({ controllerCommit: lockedApproval.controllerCommit, reservationSha256: lockedApproval.reservationSha256,
            recovery: lockedApproval.recovery }, { controllerCommit, reservationSha256, recovery }, "locked recovery approval changed");
          const snapshot = pinnedRetirement ? handoffStateSnapshot(statePath) : undefined;
          const bytes = snapshot?.bytes ?? regular(statePath, 1024 * 1024);
          assert.equal(digest(bytes), reservationSha256, "locked recovery reservation changed");
          state = controllerState(JSON.parse(bytes), options.round);
          assert.ok(stagedFleet(state.fleet) && state.fleet.single?.group === state.group, "staged single-group recovery required");
          if (pinnedRetirement) {
            expectedHandoffState = snapshot;
            assertHandoffState();
            if (groupedExitOne) return retireFailedExitOne(controllerCommit, reservationSha256, bytes, recovery);
            const handoff = { controllerCommit, captureSha256: recovery.captureSha256, launchIntentSha256: recovery.intent.launch };
            if (state.status !== "retired") return retireNativeFailure(controllerCommit, undefined, handoff);
            assertHandoffCustody = pinHandoffRetirement(local, state, handoff);
            handoffReceiptSha256 = state.retirement.evidenceSha256;
            checkHandoffDelete(false);
            await confirmDeleted();
            checkHandoffDelete();
            if (!state.destroyedAt) { state.destroyedAt = new Date().toISOString(); save("destroyed"); }
            return 1;
          }
          grouped = groupedPreplanFailure(local, state);
          assert.equal(grouped.preplan, true);
          if (state.control.monitor.phase === "closed" && [join(local, "operation.lock"), join(base, ".groups-launch.lock")]
            .some((path) => lstatSync(path, { throwIfNoEntry: false }))) {
            assert.ok(!retainedInvalidOwner(local, state), "original monitor owner is still live or uncertain");
          }
          assert.deepEqual({ ...recovery, measuredCommit: state.commit, hostId: state.id, group: state.group, unit: state.unit,
            archiveSha256: state.archiveSha256, evidenceSha256: state.evidenceSha256, launchHostKeySha256: state.launchHostKeySha256,
            bootId: grouped.host.bootId, roots: grouped.roots, fleetSha256: state.fleet.fleetSha256 }, recovery, "approved preplan custody binding changed");
        } else {
          assert.ok(!state.fleet?.single, "single-group recovery requires the explicit preplan policy");
          assert.equal(digest(regular(statePath, 1024 * 1024)), recoveryApproval.reservationSha256, "locked recovery reservation changed");
        }
        assert.notEqual(recoveryApproval.controllerCommit, state.commit, "repair source must be distinct from measured source");
        if (state.status === "retired") {
          assert.equal(state.retirement.kind, "native-failed");
          const record = verifyFailedNativeRetirement(local, state);
          assert.equal(record.capture.scope === "grouped-preplan", groupedPreplan, "retired recovery scope differs");
          if (groupedPreplan) assert.equal(record.capture.reservationSha256, recoveryApproval.preservedReservationSha256,
            "approved preserved reservation differs from retirement");
          await confirmDeleted();
          state.destroyedAt ??= new Date().toISOString(); save("destroyed"); return 1;
        }
        assert.ok(["starting", "running"].includes(state.status) && !state.deletionIntentAt && !state.collectedAt
          && !state.validation && !state.evidenceOutcome && state.createIntentAt, "only an unqualified failed native reservation can recover");
        if (!groupedPreplan && state.group === "mixed-production") {
          verifyMixedSignal(local, state);
          assert.equal(fileHash(join(local, "known_hosts")), mixedWait.knownHostsSha256, "saved native host key view changed");
          if (!await unit()) return 3; // Observe once, never stop or repack the unit.
          if (!state.archiveSha256) {
            assert.ok(!existsSync(archive) && !existsSync(`${archive}.download`), "unrecorded wrapper archive retained");
            const line = (await ssh("sha256sum /bench/results.tgz")).stdout;
            full(line, /[a-f0-9]{64}  \/bench\/results\.tgz\n/, "wrapper archive hash required");
            const hash = line.slice(0, 64), download = `${archive}.download`;
            durable(download, ""); await scp(`root@${state.ip}:/bench/results.tgz`, download);
            durableCopy(download, `${archive}.synced`, hash); renameSync(`${archive}.synced`, archive); syncDirectory(local);
            state.archiveSha256 = hash; save();
          }
          verifyArchive(); await archiveMembers(archive, state.archiveSha256); check();
          if (!state.evidence) {
            const extracted = mkdtempSync(join(local, "evidence-"));
            (state.extractionAttempts ??= []).push(basename(extracted)); save();
            const hash = await extractArchive(archive, extracted, state.archiveSha256); check();
            state.evidence = basename(extracted); state.evidenceSha256 = hash; save();
          }
        }
        return retireNativeFailure(recoveryApproval.controllerCommit, grouped);
      }, false, groupedPreplan ? recoveryLock : undefined);
    },
    async deliverAudit() {
      assert.ok(options.deliverAudit, "audit delivery options required");
      const observed = read();
      if (observed.control?.monitor) {
        assert.equal(typeof authorizeAudit, "function", "supervised audit publication requires the locked approval checkpoint");
        return locked(async () => {
          const { queueStreamAudit } = await import("./cloud-control-stream.mjs");
          const approved = await authorizeAudit(); check();
          const bytes = regular(statePath, 1024 * 1024);
          assert.equal(digest(bytes), approved.reservationSha256, "locked audit reservation changed");
          state = controllerState(JSON.parse(bytes), options.round);
          assert.ok(state.id && state.ip && !state.deletionIntentAt && !state.collectedAt && ["starting", "running"].includes(state.status), "live owned campaign required");
          queueStreamAudit(local, state, options, approved.deliverySha256);
          return 3; // Pending publication only; remote sealed admission is observed on the existing stream.
        }, false, "audit-delivery.lock");
      }
      return locked(async () => {
        assert.ok(state.id && state.ip && !state.deletionIntentAt && !state.collectedAt && ["starting", "running"].includes(state.status), "live owned campaign required");
        const offline = state.fleet?.single?.offlineHandoff;
        let expectedDelivery;
        if (offline) {
          assert.ok(offlineBootstrapAck());
          assert.equal(typeof authorizeAudit, "function", "offline audit publication requires locked approval");
          const approved = await authorizeAudit(); check();
          assert.equal(digest(regular(statePath, 1024 * 1024)), approved.reservationSha256, "locked audit reservation changed");
          expectedDelivery = approved.deliverySha256;
        }
        const { group, prefix } = auditProtocol(options.auditGroup);
        controlEpoch = `audit-${group}`;
        if (state.group !== undefined) assert.equal(group, state.group, "audit delivery belongs to a different group host");
        assert.ok(!state.auditIntents?.[group] && !(group === "json-api" && state.auditIntent), "audit delivery already attempted; inspect, never repeat");
        const bytes = regular(resolve(options.deliverAudit), 16 * 1024 ** 2), intent = auditDelivery(bytes, options);
        if (offline) assert.equal(intent.sha256, expectedDelivery, "locked audit delivery changed");
        assert.equal(await unit(), false, "terminal campaign cannot accept delivery");
        assert.equal((await ssh(auditScript(state, intent))).stdout.trim(), intent.subjectSha256);
        durable(join(local, `${prefix}-audit-delivery.json`), bytes);
        (state.auditIntents ??= {})[group] = intent; save();
        const stage = `/bench/cloud-${prefix}-audit-${state.token}.json`;
        await ssh(`test ! -e ${stage} && test ! -L ${stage} && install -m 600 /dev/null ${stage}`);
        await scp(join(local, `${prefix}-audit-delivery.json`), `root@${state.ip}:${stage}`);
        assert.equal(await unit(), false, "campaign ended during audit transfer");
        assert.equal((await ssh(auditScript(state, intent, true))).stdout.trim(), intent.subjectSha256);
        await sealControl(controlEpoch);
        return 3;
      });
    },
  };
}

// A launch's job runs `npm --prefix bench ci` (benchPackage), so the measured commit must have both.
export const benchPackagePaths = ["bench/package.json", "bench/package-lock.json"];

// Never print exception messages/stacks or provider output: assertions may echo raw evidence.
export function publicError(error) {
  const diagnostic = providerFailure(error), stage = controllerFailure(error);
  const detail = diagnostic?.httpStatus !== undefined ? ` (HTTP ${diagnostic.httpStatus})`
    : diagnostic?.detail !== undefined ? ` (${diagnostic.detail})` : "";
  // Fixed text for each allowlisted refusal that has a supported operator route.
  const route = stage === "offline-never-started"
    ? " Recovery: retire the bound posted create only by the separately approved pinned unused-host collection, --collect --unused-bootstrap-known-hosts <operator-verified host key> (CLOUD.md)."
    : stage === "create-errored-contradicted"
      ? " Recovery: the provider-errored receipt is contradicted. Collect binds only its exact posted droplet with the saved name, tags, size, region and one public IPv4;"
        + " then retire it only by --collect --unused-bootstrap-known-hosts <operator-verified host key>. Otherwise account for that droplet with the provider (CLOUD.md)."
      : stage === "create-contradiction-unpublished"
        ? " Recovery: the contradiction was not published and the operation lock is kept. Account for that collect by the custody step; if provider-create-reappeared"
          + " is absent, write it beside the reservation before removing operation.lock, then collect again (CLOUD.md)."
        : "";
  if (diagnostic?.code === "create-errored-absent") return "Provider create errored before guest startup; the exact allocation was verified absent on the verified account."
    + " No DELETE or replacement create was sent. Not a benchmark result; never relaunch this round."
    + (stage ? ` Controller stage: ${stage}.` : "") + ` Provider failure: ${diagnostic.code}.`;
  return "Controller stopped; retained state/evidence requires inspection. Host/deletion state may be uncertain. Never relaunch."
    + (stage ? ` Controller stage: ${stage}.` : "") + route
    + (diagnostic?.code === "bootstrap-marker" ? ` Bootstrap marker: ${diagnostic.detail}.`
      : diagnostic ? ` Provider failure: ${diagnostic.code}${detail}.` : "");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  import("./cloud-production.mjs").then((native) => native.productionCli(process.argv.slice(2)))
    .then((code) => { process.exitCode = code; }, (error) => { console.error(publicError(error)); process.exitCode = 2; });
}
