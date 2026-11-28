// Read-only fleet inventory. Receipts are diagnostics, never evidence authority.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { fleetCreateMode, roundName, selection, stagedFleet, validateFleet } from "./cloud-contract.mjs";
import { campaignOutcome, controllerState, full, providerDiagnostic } from "./cloud-options.mjs";
import { livePeerLease, requireOrphanedAuditMonitor, requireUnfinishedJournal, settledMonitor, streamRecoveryReady } from "./cloud-control-stream.mjs";
import { streamLimits } from "./isolated/control-stream.mjs";
import { digest, durable, fileHash, physical, regular, resolveStateRoot, treeHash, verifyArchiveTree } from "./cloud-local.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { localCompiler, localCompilerMissing } from "./cloud-validation-snapshot.mjs";
import { createContradiction, createErroredCustody, failedSetupRetirementFile, readRetainedInvalidLocks, retainedInvalidOwner, verifyCreateErrored, verifyFailedNativeRetirement, verifyFailedSetupRetirement,
  exitOneEvidenceFingerprint, exitOneReadLocks, failedExitOneCandidate, failedExitOneScope, verifyFailedExitOneRetirement, verifyHistoricalFailedNativeRetirement,
  verifyUnusedEvidence } from "./cloud-retirement.mjs";

export const outside = (root, path) => { const r = relative(root, path); return isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`); };
export function fleetRoot(path, repo) {
  assert.ok(typeof path === "string" && isAbsolute(path) && !/^[\\/]{2}/.test(path) && !/["$%\r\n\0]/.test(path), "fleet-path");
  const root = resolveStateRoot(path);
  assert.ok(!/["$%\r\n\0]/.test(root), "fleet-path");
  if (repo) {
    repo = realpathSync(repo);
    assert.ok(outside(repo, root) && outside(root, repo), "fleet-path");
  }
  return root;
}
export function present(path) { return lstatSync(path, { throwIfNoEntry: false }) !== undefined; }
export function fleetBatchLock(root) {
  const path = join(root, ".fleet-operation.lock");
  return present(path) ? regular(path, 1024) : null;
}
function batchLock(bytes) {
  const { pid, approvalSha256, ...rest } = JSON.parse(bytes);
  assert.deepEqual(rest, {});
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  full(approvalSha256, /[a-f0-9]{64}/, "fleet lock approval");
  return { pid, approvalSha256 };
}
// For inspection only. A dead original batch owner does not unlock the fleet.
export function fleetLockSnapshot(root) {
  try {
    const bytes = fleetBatchLock(root);
    if (!bytes) return null;
    const { pid } = batchLock(bytes);
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return digest(bytes); }
  } catch { /* Unreadable, foreign and prepare locks are not settled batch locks. */ }
  return "busy";
}

export function windowsProcessStart(pid) {
  const root = process.env.SystemRoot;
  if (process.platform !== "win32" || !root || !/^[a-z]:[\\/]/i.test(root)
      || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return;
  const result = spawnSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = 'Stop'; ([DateTimeOffset]([Diagnostics.Process]::GetProcessById(${pid}).StartTime)).ToUnixTimeMilliseconds()`],
    { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 4096 });
  if (!result.error && result.status === 0 && !result.stderr && /^[1-9]\d{0,14}$/.test(result.stdout.trim())) return Number(result.stdout.trim());
}

function lockEvidence(path, limit = 1024) {
  const meta = () => lstatSync(path, { bigint: true });
  const identity = (s) => [s.dev, s.ino, s.nlink, s.size, s.birthtimeNs, s.mtimeNs, s.ctimeNs];
  const before = meta(), bytes = regular(path, limit), stamp = identity(before);
  assert.deepEqual(identity(meta()), stamp, "lock changed during read");
  return { bytes, stamp, sha256: digest(bytes), at: Math.max(...[before.birthtimeMs, before.mtimeMs, before.ctimeMs].map(Number)),
    dated: before.birthtimeMs > 0n && before.mtimeMs > 0n && before.ctimeMs > 0n };
}

function stillSame(first, last) {
  return first.sha256 === last.sha256 && first.stamp.every((v, i) => v === last.stamp[i]);
}

// Read historical evidence only. Never acquire or release this owner's custody.
function reportOwner(pid, locks, processStart, recordedAt = 0) {
  try { process.kill(pid, 0); }
  catch (error) { return error.code === "ESRCH" ? "absent" : "busy"; }
  if (!locks.every((lock) => lock.dated)) return "busy";
  const started = processStart(pid);
  return Number.isSafeInteger(started) && started <= Date.now()
    && started > Math.max(recordedAt, ...locks.map((lock) => lock.at)) ? "reused" : "busy";
}

export function reportBatch(fleet, processStart = windowsProcessStart) {
  const path = join(fleet.root, ".fleet-operation.lock");
  try {
    if (!present(path)) return null;
    const lock = lockEvidence(path), { pid, approvalSha256 } = batchLock(lock.bytes);
    const owner = reportOwner(pid, [lock], processStart);
    if (owner === "busy") return "busy";
    // A reused PID does not make a foreign approval a historical launch.
    if (owner === "reused") {
      const launch = readLaunchIntent(fleet);
      // The legacy reader binds a specific sibling; the batch hash covers the entire intent.
      if (launch.approvalSha256 !== approvalSha256)
        assert.equal(readRemainingIntent(fleet, fleet.manifest.jobs[1]?.group).approvalSha256, approvalSha256, "foreign fleet lock approval");
    }
    return stillSame(lock, lockEvidence(path)) ? lock : "busy";
  } catch { return "busy"; }
}

export function sameReportBatch(first, last) {
  if (first === null || first === "busy" || last === null || last === "busy") return first === last;
  return stillSame(first, last);
}

function reportChild(local, state, processStart) {
  const locks = [];
  const { pid, at } = readRetainedInvalidLocks(local, state, (path) => {
    const lock = lockEvidence(path);
    locks.push({ ...lock, path });
    return lock.bytes;
  });
  const owner = reportOwner(pid, locks, processStart, Date.parse(at));
  if (owner === "busy" || owner === "reused" && !locks.every((lock) => lock.at <= Date.parse(state.destroyedAt))) return;
  return locks;
}

function sameChildLocks(local, locks) {
  try {
    return !present(join(local, "stream-recovery.lock")) && locks.every((lock) => stillSame(lock, lockEvidence(lock.path)));
  } catch { return false; }
}

// A report or a distinct new attempt can read a destroyed allocation. Neither
// may take over its locks. Return a check to repeat before using that evidence.
export function historicalChildLocks(job, processStart = windowsProcessStart) {
  const { local, state } = job;
  if (job.outcome !== "busy" || state?.status !== "retired" || !state.destroyedAt ||
      state.retirement?.kind !== "native-failed" || state.control?.monitor?.phase !== "invalid" ||
      !state.launchHostKeySha256 || present(join(local, "stream-recovery.lock"))) return;
  const locks = reportChild(local, state, processStart);
  if (locks) return () => sameChildLocks(local, locks);
}

export function readFleet(root, round, { priorSelection = false } = {}) {
  roundName(round); physical(root);
  const path = join(root, `fleet-${round}.json`), bytes = regular(path, 1024 * 1024), manifest = validateFleet(JSON.parse(bytes), { priorSelection });
  assert.equal(manifest.round, round);
  if (manifest.single) {
    assert.ok([manifest.single.group, `${manifest.single.group}--${round}`].some((name) => root === join(dirname(root), name)),
      "continuation group slot differs");
    assert.ok(!present(join(root, "remaining-intent.json")), "independent group has no remaining admission");
  }
  const allowed = new Set([`fleet-${round}.json`, ".fleet-operation.lock", "launch-intent.json", "remaining-intent.json", "receipts", ...manifest.jobs.map((j) => j.group)]);
  assert.ok(readdirSync(root).every((name) => allowed.has(name)), "fleet-root-members");
  return { root, path, bytes, manifest, manifestSha256: digest(bytes), priorSelection };
}
export const continuationIndex = (root) => regular(join(root, "index.json"), 64 * 1024);
export const continuationIndexSha256 = (root) => digest(continuationIndex(root));
export function fleetChildOptions(fleet, group, mode) {
  const f = fleet.manifest;
  return { round: f.round, stateDir: join(fleet.root, group), [mode]: true,
    ...(mode === "detach" ? { commit: f.commit, sshKey: f.sshKey, accountId: f.provider.accountId,
      context: f.provider.context, group, fleet: fleet.path } : {}) };
}
function readIntent(fleet, file, schema, action) {
  const bytes = regular(join(fleet.root, file), 1024 * 1024), intent = JSON.parse(bytes);
  assert.deepEqual(Object.keys(intent).sort(), ["approvalSha256", "schema", "subject"]);
  assert.equal(intent.schema, schema, "fleet-legacy-launch-cannot-admit");
  const s = intent.subject;
  assert.equal(intent.approvalSha256, digest(JSON.stringify(s)), "fleet-intent-changed");
  assert.equal(s.schema, "benchmark-group-fleet-staged-approval/v1");
  assert.equal(s.action, action); assert.equal(s.controllerCommit, fleet.manifest.commit);
  assert.equal(s.stateRoot, fleet.root);
  // A requested junction must still resolve to the approved physical root.
  assert.equal(fleetRoot(s.requestedRoot), fleet.root, "fleet-requested-root-changed");
  assert.equal(s.round, fleet.manifest.round);
  assert.equal(s.manifestSha256, fleet.manifestSha256); assert.deepEqual(s.fleet, fleet.manifest);
  assert.deepEqual(s.jobs.map(({ group }) => group), fleet.manifest.jobs.map(({ group }) => group));
  return { subject: s, approvalSha256: intent.approvalSha256, sha256: digest(bytes) };
}
function validateIntentJob(fleet, job, remainingPlacement) {
  assert.equal(job.outcome, "planned"); assert.deepEqual(job.missing, []);
  assert.deepEqual(job.options, fleetChildOptions(fleet, job.group, "detach"));
  assert.deepEqual(job.subject.options, job.options); assert.equal(job.subject.controllerCommit, fleet.manifest.commit);
  assert.equal(job.approvalSha256, digest(JSON.stringify(job.subject)));
  if (stagedFleet(fleet.manifest)) {
    assert.equal(job.subject.action, "detach"); assert.equal(job.subject.stateRoot, job.options.stateDir);
    assert.equal(job.subject.fleetSha256, fleet.manifestSha256);
    assert.deepEqual(job.subject.remainingPlacement, remainingPlacement);
  }
}
export function readLaunchIntent(fleet) {
  const result = readIntent(fleet, "launch-intent.json", "benchmark-group-fleet-staged-launch-intent/v1", "detach");
  const s = result.subject, first = fleet.manifest.jobs[0].group;
  assert.deepEqual(s.records, {});
  assert.deepEqual(s.admission, { mode: "first-group-only", firstGroup: first, gate: "collected-verified-deleted", nativeReadiness: false });
  assert.equal(s.remainingRegion, undefined);
  validateIntentJob(fleet, s.jobs[0]);
  for (const job of s.jobs.slice(1)) assert.deepEqual(job, { group: job.group, outcome: "deferred" });
  return result;
}
export function readRemainingIntent(fleet, legacyGroup) {
  const launch = readLaunchIntent(fleet).sha256;
  const result = readIntent(fleet, "remaining-intent.json", "benchmark-group-fleet-remaining-intent/v1", "admit-remaining");
  const s = result.subject, first = fleet.manifest.jobs[0].group;
  assert.equal(s.records["launch-intent.json"], launch);
  assert.deepEqual(s.admission, { mode: "remaining-once", firstGroup: first, gate: "collected-verified-deleted", nativeReadiness: false });
  assert.equal(s.firstGroup.evidenceMode, "native-replay"); assert.equal(s.firstGroup.row.outcome, "verified");
  assert.equal(s.firstGroup.row.group, first);
  let placement;
  if (stagedFleet(fleet.manifest)) {
    fleetCreateMode(fleet.manifest.jobs[1].group, fleet.manifest, s.remainingRegion); // Closed region list.
    assert.deepEqual(s.firstGroup.row.host, fleet.manifest.jobs[0].host);
    const snapshot = s.firstGroup.snapshot;
    assert.deepEqual(Object.keys(snapshot).sort(), ["archiveSha256", "evidenceSha256", "group", "stateSha256"]);
    assert.equal(snapshot.group, first);
    for (const key of ["archiveSha256", "evidenceSha256", "stateSha256"]) {
      full(snapshot[key], /[a-f0-9]{64}/, key);
      assert.equal(s.firstGroup.row[key], snapshot[key]);
    }
    assert.deepEqual(s.jobs[0], { group: first, outcome: "verified", snapshot });
    placement = { region: s.remainingRegion, firstGroup: snapshot };
    for (const job of s.jobs.slice(1)) validateIntentJob(fleet, job, placement);
  } else {
    assert.equal(s.remainingRegion, undefined);
    validateIntentJob(fleet, s.jobs.find((j) => j.group === legacyGroup));
  }
  return { ...result, launch, placement };
}
export function readGroup(fleet, group) {
  assert.ok(fleet.manifest.jobs.some((j) => j.group === group));
  physical(fleet.root);
  const stateRoot = join(fleet.root, group), local = join(stateRoot, `groups-${fleet.manifest.round}`);
  if (!present(stateRoot)) return { group, outcome: "missing" };
  physical(stateRoot);
  if (!present(local)) return { group, outcome: "ambiguous" };
  physical(local);
  const bytes = regular(join(local, "state.json"), 1024 * 1024), state = controllerState(JSON.parse(bytes), fleet.manifest.round,
    { priorSelection: fleet.priorSelection });
  assert.equal(state.schema, "benchmark-dedicated-group-host/v1");
  assert.equal(state.group, group); assert.deepEqual(state.fleet, fleet.manifest);
  assert.deepEqual(state.provider, fleet.manifest.provider);
  if (stagedFleet(fleet.manifest) && group !== fleet.manifest.jobs[0].group) {
    const intent = readRemainingIntent(fleet);
    assert.deepEqual(state.remainingPlacement, { region: intent.placement.region, intentSha256: intent.sha256 },
      "group-state-remaining-placement-differs");
  }
  return { group, stateRoot, local, state, stateSha256: digest(bytes), outcome: present(join(local, "operation.lock")) ? "busy"
    : ["creating", "preparing", "starting", "running", "collected", "retired"].includes(state.status) ? "available" : "ambiguous" };
}

const createQuarantineFile = "create-quarantine.json";
const quarantineWitnessFile = "create-quarantine-witness.json";
const externalFailedHostFile = "external-failed-host.json";
const quarantineWitnessed = "quarantined create witnessed in provider inventory; reconcile before allocating";
const quarantineJson = (bytes) => {
  try { return JSON.parse(bytes); } catch { throw new Error("invalid create quarantine evidence"); }
};

// Read-only candidate for an operator who has accounted for the entire local
// controller tree. Dead lock owners alone do not prove that tree has settled.
export function unacknowledgedCreateBinding(fleet) {
  return unboundCreateBinding(fleet);
}

function unboundCreateBinding(fleet, { report = false, removed = false } = {}) {
  const { root, manifest, manifestSha256 } = fleet, { round, single } = manifest;
  assert.ok(single, "create quarantine requires an independent attempt");
  const { group } = single, { state, stateRoot, local, stateSha256 } = readGroup(fleet, group);
  assert.ok(state?.status === "creating" && !state.id && !state.createErrored && !state.createContradicted
    && (removed ? state.createPending : !state.createPending),
  removed ? "external failure requires an unbound posted create" : "create quarantine requires an unbound create without a posted ID");
  if (removed) {
    assert.ok(Object.keys(state).every((k) => [
      "schema", "round", "commit", "token", "name", "tag", "unit", "host", "selection", "group", "fleet", "createdAt",
      "status", "provider", "fullGroupQualified", "benchPackage", "gitSource", "trixieUpstream", "skipHostChromium", "quietBootstrap",
      "control", "createIntentAt", "createPending",
    ].includes(k)), "external posted create cannot claim setup or collection");
  }
  assert.ok(!state.control || state.control.ledger.length === 0 && state.control.sealed.length === 0
    && (!state.control.monitor || state.control.monitor.phase === "pending" && !state.control.monitor.registrationSha256),
    "create quarantine cannot hide guest control");
  assert.ok(isDeepStrictEqual(readdirSync(stateRoot).sort(), [".groups-launch.lock", `groups-${round}`])
    && isDeepStrictEqual(readdirSync(local).sort(), ["operation.lock", "state.json"]), "create quarantine child files differ");
  const intent = readLaunchIntent(fleet), batch = reportBatch(fleet);
  assert.ok(batch && batch !== "busy", "create quarantine requires the original dead batch owner");
  const { pid, approvalSha256 } = batchLock(batch.bytes);
  assert.equal(approvalSha256, intent.approvalSha256, "create quarantine requires the original batch approval");
  const launchPath = join(stateRoot, ".groups-launch.lock"), operationPath = join(local, "operation.lock");
  const launch = lockEvidence(launchPath), operation = lockEvidence(operationPath);
  assert.ok(isDeepStrictEqual(quarantineJson(launch.bytes), { pid, round }), "create quarantine launch lock differs");
  const owner = quarantineJson(operation.bytes);
  assert.ok(isDeepStrictEqual(owner, { pid, at: owner?.at }), "create quarantine operation lock differs");
  assert.ok(Number.isFinite(Date.parse(owner.at)) && new Date(owner.at).toISOString() === owner.at
    && Date.parse(owner.at) <= Date.parse(state.createIntentAt), "create quarantine requires original operation custody");
  const dir = join(root, "receipts"); physical(dir);
  if (!report) assert.ok(!present(join(dir, quarantineWitnessFile)), quarantineWitnessed);
  const entries = readdirSync(dir).filter((file) => removed ? file !== externalFailedHostFile
    : file !== createQuarantineFile && !(report && file === quarantineWitnessFile));
  assert.equal(entries.length, 1, "create quarantine requires exactly one original detach outcome");
  assert.ok(new RegExp(`^detach-[a-f0-9]{16}-${group}\\.json$`).test(entries[0]), "create quarantine detach outcome name differs");
  const failureBytes = regular(join(dir, entries[0]), 4096), failure = quarantineJson(failureBytes);
  const diagnostic = providerDiagnostic(failure?.providerDiagnostic);
  assert.equal(diagnostic?.code, removed ? "create-action-request" : "create-request",
    removed ? "external failure requires a lost create-action read" : "create quarantine requires an unacknowledged POST diagnostic");
  assert.ok(isDeepStrictEqual(failure, { group, outcome: "error", error: "group-operation-failed", uncertain: true,
    providerDiagnostic: diagnostic, controllerStage: "provider-settlement" }), "create quarantine detach outcome differs");
  assert.ok(sameReportBatch(batch, reportBatch(fleet)) && sameChildLocks(local,
    [{ ...launch, path: launchPath }, { ...operation, path: operationPath }]),
    "create quarantine custody changed");
  assert.equal(readGroup(fleet, group).stateSha256, stateSha256, "create quarantine state changed");
  return { round, group, accountId: manifest.provider.accountId, manifestSha256, stateSha256, launchSha256: intent.sha256,
    failureSha256: digest(failureBytes), batchLockSha256: batch.sha256, launchLockSha256: launch.sha256, operationLockSha256: operation.sha256 };
}

export function readCreateQuarantine(fleet, { report = false } = {}) {
  const dir = join(fleet.root, "receipts");
  if (!fleet.manifest.single || !present(dir)) return;
  physical(dir);
  const path = join(dir, createQuarantineFile), witness = join(dir, quarantineWitnessFile);
  if (!present(path)) {
    assert.ok(!present(witness), "create quarantine witness has no quarantine record");
    return;
  }
  const bytes = regular(path, 8192), record = quarantineJson(bytes), binding = unboundCreateBinding(fleet, { report });
  assert.ok(typeof record?.localCustodyProofSha256 === "string" && /^[a-f0-9]{64}$/.test(record.localCustodyProofSha256),
    "operator tree-custody proof digest required");
  assert.ok(isDeepStrictEqual(record, { schema: "benchmark-create-quarantine/v1", binding, localCustodyProofSha256: record.localCustodyProofSha256 }),
    "create quarantine binding differs");
  const { state } = readGroup(fleet, binding.group);
  assert.equal(digest(regular(join(fleet.root, binding.group, `groups-${binding.round}`, "state.json"), 1024 * 1024)), binding.stateSha256,
    "create quarantine state changed");
  const sha256 = digest(bytes);
  let witnessSha256;
  if (present(witness)) {
    assert.ok(report, quarantineWitnessed);
    const bytes = regular(witness, 4096), row = quarantineJson(bytes), id = row?.dropletId;
    assert.ok(typeof id === "string" && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))
      && isDeepStrictEqual(row, { schema: "benchmark-create-quarantine-witness/v1", quarantineSha256: sha256, dropletId: id }),
    "create quarantine witness differs");
    witnessSha256 = digest(bytes);
  }
  return { round: binding.round, group: binding.group, root: fleet.root, accountId: binding.accountId,
    sha256, nameSha256: digest(state.name), tagSha256: digest(state.tag), ...(witnessSha256 ? { witnessSha256 } : {}) };
}

export function replacementQuarantine(rows, group, sha256) {
  if (sha256 === undefined) return undefined;
  const same = rows.filter((row) => row.group === group);
  assert.ok(same.length === 1 && same[0].sha256 === sha256, "replacement requires exactly one matching create quarantine");
  return same[0];
}

export function recheckCreateQuarantine(root, row, selection) {
  const replacement = row.sha256 === selection.single.replacesQuarantineSha256
    && Number(row.round.slice(1)) < Number(selection.round.slice(1));
  assert.ok(dirname(row.root) === root && (row.group !== selection.single.group || replacement)
    && row.accountId === selection.provider.accountId, "create quarantine permits only other groups or its exact replacement in the saved account");
  assert.ok(isDeepStrictEqual(readCreateQuarantine(readFleet(row.root, row.round, { priorSelection: true })), row), "create quarantine changed");
}

// The worker projects trusted sightings even from a response that cannot prove absence.
export function checkQuarantineCensus(root, quarantined, selection, rows) {
  const text = (value) => typeof value === "string" && value.length > 0;
  assert.ok(rows.every((d) => Number.isSafeInteger(d?.id) && d.id > 0 && (d.name === undefined || text(d.name))
    && (d.tags === undefined || Array.isArray(d.tags) && d.tags.every(text))), "invalid create quarantine census rows");
  for (const { id, name, tags } of rows) {
    const nameSha256 = name === undefined ? undefined : digest(name), tagSha256s = new Set(tags?.map(digest));
    const match = quarantined.find((row) => row.nameSha256 === nameSha256 || tagSha256s.has(row.tagSha256));
    if (!match) continue;
    try {
      recheckCreateQuarantine(root, match, selection);
      durable(join(match.root, "receipts", quarantineWitnessFile), `${JSON.stringify({
        schema: "benchmark-create-quarantine-witness/v1", quarantineSha256: match.sha256, dropletId: String(id),
      })}\n`);
    } catch (cause) {
      throw Object.assign(new Error("quarantined create witness not published; retain operation custody", { cause }), { controlUncertain: true });
    }
    throw new Error(quarantineWitnessed);
  }
}

// A running status without sealed bootstrap and monitor custody proves nothing.
export function supervisedHost(saved, phase, { pid = process.pid, peer = false } = {}) {
  const s = saved?.state, monitor = s?.control?.monitor;
  if (s?.status !== "running" || s.deletionIntentAt || s.destroyedAt || monitor?.phase !== phase
    || !s.control.sealed.includes("bootstrap") || s.control.ledger.filter((r) => r.request.epoch === "bootstrap").at(-1)?.code !== 0) return;
  const at = (name) => join(saved.local, name);
  if (present(at("monitor-invalid.json"))) return;
  if (phase === "live") {
    if (saved.outcome !== "busy" || present(at("monitor-terminal.json")) || present(at("monitor-local-closed.json"))) return;
    for (const lock of [at("operation.lock"), join(saved.stateRoot, ".groups-launch.lock")])
      if (JSON.parse(regular(lock, 1024)).pid !== pid) return;
    if (peer && (!s.bootstrapReady || !s.launchHostKeySha256 || present(at("stream-recovery.lock")) || !livePeerLease(saved.local, s))) return;
  } else {
    if (saved.outcome !== "available" || present(join(saved.stateRoot, ".groups-launch.lock"))
      || !present(at("monitor-terminal.json")) || !present(at("monitor-local-closed.json"))) return;
    streamRecoveryReady(saved.local, monitor); // Collection itself enforces elapsed lease.
  }
  const reg = JSON.parse(regular(at("monitor-registration.json"), 131072));
  if (reg.id !== monitor.id || digest(JSON.stringify(reg)) !== monitor.registrationSha256
    || reg.binding?.round !== s.round || reg.binding.commit !== s.commit || reg.binding.token !== s.token || reg.binding.helperSha256 !== s.control.helperSha256) return;
  return { id: s.id, ip: s.ip, registration: monitor.registrationSha256 };
}

export function continuationPeer(fleet) {
  const { root, manifest, manifestSha256 } = fleet, { single, round } = manifest;
  assert.ok(single, "only an independent group can be a continuation peer");
  const intent = readLaunchIntent(fleet), batch = join(root, ".fleet-operation.lock");
  const bytes = regular(batch, 1024), { pid, approvalSha256, ...rest } = JSON.parse(bytes);
  assert.deepEqual(rest, {});
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(approvalSha256, intent.approvalSha256, "peer batch does not own its launch intent");
  assert.equal(intent.subject.continuation?.indexSha256, single.indexSha256);
  process.kill(pid, 0); // The stream lease alone does not prove the controller still exists.
  const saved = readGroup(fleet, single.group), host = supervisedHost(saved, "live", { pid, peer: true });
  assert.ok(host, "peer supervision not confirmed");
  assert.ok(regular(batch, 1024).equals(bytes), "peer batch lock changed");
  return { proof: { root, round, manifestSha256, intentSha256: intent.sha256, ...host }, state: saved.state };
}

export function recheckContinuationPeers(root, indexSha256, provider, group, peers = []) {
  assert.ok(Array.isArray(peers) && peers.length < selection().groups.length);
  const groups = new Set([group]), ids = new Set(), ips = new Set();
  return peers.map((proof) => {
    assert.equal(dirname(proof.root), root, "peer belongs to another continuation");
    const fleet = readFleet(proof.root, proof.round, { priorSelection: true });
    const { single } = fleet.manifest;
    assert.equal(single?.indexSha256, indexSha256, "peer continuation index changed");
    assert.ok(!groups.has(single.group), "duplicate continuation group");
    groups.add(single.group);
    assert.equal(fleet.manifest.provider.accountId, provider.accountId, "peer belongs to another provider account");
    const peer = continuationPeer(fleet);
    assert.deepEqual(peer.proof, proof, "approved peer changed");
    assert.ok(!ids.has(proof.id) && !ips.has(proof.ip), "duplicate continuation peer host");
    ids.add(proof.id); ips.add(proof.ip);
    return peer.state;
  });
}

function evidenceSnapshot(job) {
  physical(job.local);
  const s = job.state, extracted = join(job.local, s.evidence);
  assert.equal(fileHash(join(job.local, "results.tgz")), s.archiveSha256);
  assert.equal(treeHash(extracted), s.evidenceSha256);
  assert.equal(digest(regular(join(job.local, "state.json"), 1024 * 1024)), job.stateSha256);
  return { stateSha256: job.stateSha256, archiveSha256: s.archiveSha256, evidenceSha256: s.evidenceSha256 };
}

function setupRetryIdle({ local, stateRoot, outcome }) {
  assert.ok(!present(join(local, "stream-recovery.lock")), "group recovery remains active");
  assert.ok(outcome === "available" && !present(join(local, "operation.lock"))
    && !present(join(stateRoot, ".groups-launch.lock")), "unresolved custody for the selected group");
}

function checkSetupRetryRecords({ local, state, stateSha256 }) {
  physical(local);
  assert.equal(digest(regular(join(local, "state.json"), 1024 * 1024)), stateSha256, "setup retirement state changed during replay");
  assert.equal(digest(regular(join(local, failedSetupRetirementFile), state.control ? 8 * 1024 * 1024 : 4096)),
    state.retirement.evidenceSha256, "setup retirement receipt changed during replay");
}

export function verifySetupRetry(saved) {
  setupRetryIdle(saved);
  verifyFailedSetupRetirement(saved.local, saved.state);
  checkSetupRetryRecords(saved);
  setupRetryIdle(saved);
}

export function recheckSetupRetirement(root, row, indexedCustody) {
  const fleet = readFleet(row.root, row.round, { priorSelection: true });
  assert.equal(fleet.manifestSha256, row.manifestSha256, "prior setup retirement manifest changed");
  if (fleet.manifest.single) {
    assert.equal(dirname(fleet.root), root, "setup retirement belongs to another continuation");
    assert.equal(fleet.manifest.single.group, row.group);
  } else assert.ok(indexedCustody.some(({ root, manifestSha256 }) => root === fleet.root && manifestSha256 === row.manifestSha256),
    "setup retirement is not in the approved index");
  assert.equal((fleet.manifest.single || stagedFleet(fleet.manifest)) && present(join(fleet.root, "launch-intent.json"))
    ? readLaunchIntent(fleet).sha256 : undefined, row.launch,
    "prior setup retirement launch changed");
  const saved = readGroup(fleet, row.group);
  assert.ok(saved.stateSha256 === row.stateSha256 && saved.state?.status === "retired" && saved.state.destroyedAt,
    "prior setup retirement reservation changed");
  verifySetupRetry(saved);
  const checkBatch = () => {
    const batch = fleetBatchLock(fleet.root);
    assert.equal(batch && digest(batch), row.batchSha256, "prior setup retirement fleet lock changed");
  };
  checkBatch();
  return () => {
    checkSetupRetryRecords(saved);
    checkBatch();
    setupRetryIdle(saved);
  };
}

// Absence of an old ID in the provider account is necessary but not sufficient:
// the terminal attempt named in the approval must still be idle and unchanged.
export function recheckSetupAttempt(root, row, successor) {
  assert.equal(dirname(row.root), root, "setup attempt belongs to another continuation");
  const idleAttempt = () => {
    const fleet = readFleet(row.root, row.round, { priorSelection: true });
    assert.equal(fleet.manifest.single?.group, row.group);
    if (successor?.single?.group === row.group) {
      assert.ok(Number(successor.round.slice(1)) > Number(row.round.slice(1)), "failed setup requires a higher round");
      assert.notEqual(successor.commit, fleet.manifest.commit, "retry after failed setup requires a different measured commit");
    }
    assert.equal(fleet.manifest.provider.accountId, row.accountId);
    assert.equal(fleet.manifestSha256, row.manifestSha256);
    assert.equal(readLaunchIntent(fleet).sha256, row.launch);
    const saved = readGroup(fleet, row.group);
    assert.equal(saved.stateSha256, row.stateSha256, "setup attempt reservation changed");
    assert.ok(saved.state?.preBootstrapTerminal && saved.state.status === "starting" && saved.state.id === row.id);
    assert.ok(saved.outcome === "available" && !present(join(fleet.root, ".fleet-operation.lock"))
      && !present(join(saved.stateRoot, ".groups-launch.lock")) && !present(join(saved.local, "stream-recovery.lock")),
    "setup attempt recovery started");
    return saved;
  };
  const saved = idleAttempt();
  evidenceSnapshot(saved);
  const extracted = join(saved.local, saved.state.evidence), campaign = join(extracted, "campaign");
  const marker = full(regular(join(extracted, "exit-code"), 16).toString("utf8"), /[1-9]\d{0,2}\n/, "nonzero setup exit");
  assert.ok(Number(marker.trim()) <= 255, "invalid setup exit");
  if (present(campaign)) { physical(campaign); assert.deepEqual(readdirSync(campaign), [], "setup attempt entered the campaign"); }
  idleAttempt(); // Hashing the archive/tree may overlap the start of collection.
  return idleAttempt;
}

// An operator-reviewed external cleanup never changes the old launch's state
// or grants result or deletion authority. The next create must prove absence.
export function externalFailedHostBinding(fleet, { orphaned = false } = {}) {
  return externalFailureBinding(fleet, orphaned);
}

function externalFailureBinding(fleet, orphaned, historical) {
  const { root, manifest, manifestSha256 } = fleet, { round, provider, single } = manifest;
  assert.ok(single && !single.offlineHandoff, "external failure requires a monitored independent attempt");
  const { group, local, state, stateSha256, outcome } = readGroup(fleet, single.group);
  if (!orphaned && state?.status === "creating" && state.createPending) {
    const monitor = state.control?.monitor;
    assert.ok(monitor?.phase === "pending" && monitor.registrationSha256 === undefined,
      "external posted create requires a pending unregistered monitor");
    const { launchSha256: launch, ...proof } = unboundCreateBinding(fleet, { removed: true });
    assert.equal(proof.stateSha256, stateSha256, "external failure state changed");
    const { dropletId: id, actionId } = state.createPending;
    return { ...proof, launch, id, actionId, nameSha256: digest(state.name), tagSha256: digest(state.tag) };
  }
  assert.ok(outcome === "busy" && state?.status === "running" && state.control?.monitor?.phase === (orphaned ? "live" : "invalid")
    && !state.archiveSha256 && !state.evidence && !state.validation && !state.collectedAt && !state.deletionIntentAt && !state.destroyedAt,
    orphaned ? "external failure requires an uncollected live attempt" : "external failure requires an uncollected invalid attempt");
  const auditDir = `monitor-audit-${group}`, ready = `${auditDir}-ready.json`, delivery = `monitor-delivery-${group}.json`;
  const conflicts = ["results.tgz", "monitor-terminal.json", "audit-delivery.lock", "state.json.tmp"];
  if (orphaned) {
    assert.ok(["json-api", "mixed-production"].includes(group) && state.id, "orphaned failure requires a bound audit group");
    conflicts.push("monitor-invalid.json", "monitor-local-closed.json", "stream-recovery.lock");
  }
  const hasConflict = () => conflicts.some((name) => present(join(local, name)))
    || readdirSync(local).some((name) => /^(?:failed-native-|failed-setup-|evidence-|results\.tgz\.)/i.test(name)
      || (/^monitor-audit-/i.test(name) || orphaned && /^monitor-delivery-/i.test(name))
        && !(orphaned && [auditDir, ready, delivery].includes(name)))
    || [createQuarantineFile, quarantineWitnessFile].some((name) => present(join(root, "receipts", name)));
  assert.ok(!hasConflict(), "external failure cannot supersede other evidence or custody");
  const capture = (name, max) => digest(regular(join(local, name), max));
  const journal = join(local, "monitor-journal.jsonl");
  const monitor = () => {
    if (orphaned) physical(join(local, auditDir));
    const subject = join(auditDir, (group === "json-api" ? "json" : "mixed") + "-audit-subject.json");
    return [...(orphaned ? [capture(ready, 8192), fileHash(join(local, delivery), streamLimits.deliveryBytes), capture(subject, streamLimits.deliveryBytes)]
      : [capture("monitor-invalid.json", 8192), capture("monitor-local-closed.json", 8192)]),
    capture("monitor-registration.json", 131072), fileHash(journal, streamLimits.journalBytes)];
  };
  const monitorFiles = monitor();
  if (orphaned) requireOrphanedAuditMonitor(local, state);
  else {
    settledMonitor(local, state);
    requireUnfinishedJournal(journal, state.control.monitor.id);
  }
  const batchPath = join(root, ".fleet-operation.lock");
  const readBatch = () => {
    if (!historical) return reportBatch(fleet, () => undefined);
    return present(batchPath) ? lockEvidence(batchPath) : null;
  };
  const intent = readLaunchIntent(fleet), batch = readBatch();
  assert.ok(batch && batch !== "busy", "external failure requires the original stopped batch owner");
  const { pid, approvalSha256 } = batchLock(batch.bytes);
  const locks = [];
  const owner = readRetainedInvalidLocks(local, state, (path) => {
    const lock = lockEvidence(path);
    locks.push({ ...lock, path });
    return lock.bytes;
  });
  assert.ok(owner.pid === pid && approvalSha256 === intent.approvalSha256 && Date.parse(owner.at) <= Date.parse(state.createIntentAt),
    "external failure requires original launch custody");
  // Only replay of an existing external receipt may recognize a reused PID.
  // The process must be newer than the receipt and every original lock.
  const stopped = historical ? reportOwner(pid, [batch, ...locks, historical.receipt], historical.processStart, Date.parse(owner.at)) !== "busy"
    : !retainedInvalidOwner(local, state);
  if (historical) assert.ok(stopped, "external failure requires the original stopped batch owner");
  assert.ok(stopped && sameChildLocks(local, locks) && sameReportBatch(batch, readBatch())
    && isDeepStrictEqual(monitorFiles, monitor()) && stateSha256 === readGroup(fleet, group).stateSha256 && !hasConflict(),
    "external failure custody changed or recovery is active");
  return { round, group, accountId: provider.accountId, id: state.id, manifestSha256, stateSha256, launch: intent.sha256,
    batchLockSha256: batch.sha256, operationLockSha256: locks[0].sha256, launchLockSha256: locks[1].sha256, monitorFiles,
    nameSha256: digest(state.name), tagSha256: digest(state.tag) };
}

export function readExternalFailedHost(fleet, { processStart = windowsProcessStart } = {}) {
  const dir = join(fleet.root, "receipts"), path = join(dir, externalFailedHostFile);
  if (!present(path)) return;
  physical(dir);
  const receipt = lockEvidence(path, 8192), { bytes } = receipt, record = quarantineJson(bytes);
  const orphaned = record?.schema === "benchmark-external-failed-host/v2";
  const schema = orphaned ? "benchmark-external-failed-host/v2" : "benchmark-external-failed-host/v1";
  assert.ok(record?.schema === schema, "external failure schema differs");
  const binding = externalFailureBinding(fleet, orphaned, { processStart, receipt });
  const operatorProofSha256 = record?.operatorProofSha256;
  assert.ok(typeof operatorProofSha256 === "string" && /^[a-f0-9]{64}$/.test(operatorProofSha256), "external failure operator proof required");
  const archiveSha256 = record.archiveSha256;
  if (orphaned) assert.ok(typeof archiveSha256 === "string" && /^[a-f0-9]{64}$/.test(archiveSha256), "external failure archive hash required");
  assert.ok(isDeepStrictEqual(record, { schema, binding, operatorProofSha256, ...(orphaned ? { archiveSha256 } : {}) }),
    "external failure binding differs");
  assert.ok(stillSame(receipt, lockEvidence(path, 8192)), "external failure receipt changed during replay");
  const { round, group, accountId, id, manifestSha256, stateSha256, launch, nameSha256, tagSha256 } = binding;
  return { round, group, accountId, id, manifestSha256, stateSha256, launch, nameSha256, tagSha256,
    root: fleet.root, externalFailureSha256: digest(bytes) };
}

export function recheckExternalFailedHost(root, row, successor) {
  assert.equal(dirname(row.root), root, "external failure belongs to another continuation");
  const fleet = readFleet(row.root, row.round, { priorSelection: true });
  assert.ok(isDeepStrictEqual(readExternalFailedHost(fleet), row), "external failure custody changed");
  if (successor?.single?.group === row.group) {
    assert.ok(Number(successor.round.slice(1)) > Number(row.round.slice(1)), "external failure requires a higher round");
    assert.notEqual(successor.commit, fleet.manifest.commit, "retry after external failure requires a different measured commit");
  }
}

// Read-only per-group replay, shared by final inspection and staged admission.
// It does not inspect/ignore a root operation lock: its caller owns that policy.
export function recheckCollectedGroup(fleet, snapshot) {
  const job = readGroup(fleet, snapshot.group);
  assert.equal(job.outcome, "available");
  assert.ok(!present(join(job.stateRoot, ".groups-launch.lock")), "group-launch-active");
  const { group, ...hashes } = snapshot;
  assert.deepEqual(evidenceSnapshot(job), hashes, "group-evidence-changed");
}
// A prior provider-errored attempt of the admitted group, rechecked at the successor's
// final create gate: the same manifest and state bytes, its receipt, and no launch,
// operation or recheck lock. An old attempt that regained custody refuses the create.
export function recheckCreateErroredAttempt(root, row) {
  assert.equal(dirname(row.root), root, "create failure belongs to another continuation");
  const fleet = readFleet(row.root, row.round, { priorSelection: true });
  assert.ok(fleet.manifestSha256 === row.manifestSha256 && fleet.manifest.single?.group === row.group, "prior create failure changed");
  const saved = readGroup(fleet, row.group);
  assert.ok(saved.outcome === "available" && saved.stateSha256 === row.stateSha256, "prior create failure changed or holds custody");
  createErroredCustody(saved.local);
  verifyCreateErrored(saved.local, saved.state);
  assert.equal(saved.state.createErrored.evidenceSha256, row.receiptSha256, "prior create failure receipt changed");
  assert.ok(saved.state.createErrored.dropletId === row.dropletId && saved.state.provider.accountId === row.accountId, "prior create failure changed");
}

// Admission already replayed the archive. At dispatch only recheck the exact
// retirement custody that the approval consumed, without replaying native data.
export function recheckExitOneRetirement(root, row) {
  try {
    assert.equal(dirname(row.root), root);
    const fleet = readFleet(row.root, row.round, { priorSelection: true });
    assert.equal(fleet.manifestSha256, row.manifestSha256);
    assert.equal(readLaunchIntent(fleet).sha256, row.launch);
    const saved = readGroup(fleet, row.group), { state, local } = saved;
    assert.ok(saved.outcome === "available" && saved.stateSha256 === row.stateSha256
      && failedExitOneScope(state) && state.status === "retired" && state.destroyedAt && state.retirement.kind === "native-failed");
    assert.equal(state.provider.accountId, row.accountId);
    assert.equal(state.id, row.id);
    assert.equal(state.retirement.evidenceSha256, row.receiptSha256);
    const receipt = regular(join(local, "failed-native-host.json"), 65536);
    assert.equal(digest(receipt), row.receiptSha256);
    assert.equal(digest(regular(join(local, "failed-native-reservation.json"), 1024 * 1024)), row.reservationSha256);
    const { evidenceFingerprint } = JSON.parse(receipt);
    assert.ok(typeof evidenceFingerprint === "string" && /^[a-f0-9]{64}$/.test(evidenceFingerprint)
      && evidenceFingerprint === exitOneEvidenceFingerprint(local, state));
    exitOneReadLocks(local);
  } catch (cause) {
    throw new Error("prior exit-one retirement changed or holds custody; do not create", { cause });
  }
}
// A posted create is contradicted by a recorded reappearance, a witness or reappearance stage
// beside it, or a contradicted bind (retired or not).
export const postedContradiction = (saved) => !!saved.state?.createErrored?.reappeared || !!saved.state?.createContradicted
  || createContradiction(saved.local);
// Every earlier provider-errored attempt on this account, in any group, is rechecked at the
// successor's final gate against its admission snapshot, separately from the selected group's
// retry eligibility: the same manifest, state bytes and custody, no contradiction recorded
// since, and none still unretired. A retired contradicted attempt stays fenced by its ID in the
// census; it does not block a create. This cannot make the check atomic with the provider.
export function recheckPostedCreate(row) {
  const changed = "an earlier provider-errored create on this account changed, took custody or was contradicted before this create;"
    + " never create beside it; preserve reservation";
  const fleet = readFleet(row.root, row.round, { priorSelection: true });
  assert.ok(fleet.manifestSha256 === row.manifestSha256 && fleet.manifest.provider.accountId === row.accountId, changed);
  const saved = readGroup(fleet, row.group);
  assert.ok(saved.outcome === row.outcome && saved.stateSha256 === row.stateSha256, changed);
  // A launch, operation or recheck lock beside the attempt is custody, as for the selected group's own attempt.
  try { createErroredCustody(saved.local); } catch (cause) { throw new Error(changed, { cause }); }
  assert.equal((saved.state.createErrored ?? saved.state.createContradicted)?.dropletId, row.dropletId, changed);
  const contradicted = postedContradiction(saved);
  assert.equal(contradicted, row.contradicted, changed);
  assert.ok(!contradicted || saved.state.status === "retired" && !!saved.state.destroyedAt,
    "an earlier provider-errored create on this account is contradicted and not retired; never create beside it; preserve reservation");
}
// Launch custody is ordered by the exact index, separate from replay evidence.
// In particular the worker must see a newly acquired staged batch lock even
// after the independent parent has consumed its own launch intent.
export function recheckIndexedLaunchCustody(root, indexSha256, custody) {
  const bytes = continuationIndex(root);
  assert.equal(digest(bytes), indexSha256, "continuation index changed");
  const entries = JSON.parse(bytes);
  assert.ok(Array.isArray(entries) && entries.length <= 64 && Array.isArray(custody) && entries.length === custody.length,
    "indexed launch custody must cover the continuation index");
  for (const [i, entry] of entries.entries()) {
    const { root: saved, manifestSha256, lock, launch, remaining, requireDeadOwner } = custody[i];
    const fleet = readFleet(fleetRoot(entry.root), entry.round, { priorSelection: true });
    assert.equal(fleet.root, saved, "continuation source root changed");
    assert.ok(!fleet.manifest.single && fleet.manifest.commit === entry.commit);
    assert.equal(fleet.manifestSha256, manifestSha256, "continuation manifest changed");
    if (lock !== null) full(lock, /[a-f0-9]{64}/, "indexed fleet lock digest");
    const batch = requireDeadOwner ? undefined : fleetBatchLock(saved);
    assert.equal(requireDeadOwner ? fleetLockSnapshot(saved) : batch && digest(batch), lock, "continuation source lock changed");
    const intent = (file, read) => stagedFleet(fleet.manifest) && present(join(saved, file)) ? read(fleet).sha256 : undefined;
    assert.equal(intent("launch-intent.json", readLaunchIntent), launch, "historical launch intent changed");
    assert.equal(intent("remaining-intent.json", readRemainingIntent), remaining, "historical remaining intent changed");
  }
}
export async function verifyCollectedGroup(fleet, group, { inspect, start, details, bindArchive, interrupted = () => false } = {}) {
  const job = readGroup(fleet, group), { round, commit } = fleet.manifest;
  assert.equal(job.outcome, "available");
  const s = job.state;
  assert.ok(s.status === "collected" && s.collectedAt, "group-not-collected");
  assert.ok(!interrupted());
  const hashes = evidenceSnapshot(job), folder = join(job.local, s.evidence, "campaign");
  if (bindArchive) await verifyArchiveTree(join(job.local, "results.tgz"), dirname(folder), s.archiveSha256);
  const report = await inspectCampaign(Object.freeze({ folder, round, commit }), { inspect, start, interrupted });
  assert.ok(!interrupted());
  campaignOutcome(report, s, s.exitCode);
  assert.deepEqual(report.selection, s.selection);
  assert.equal(report.campaign, s.validation.campaign); assert.equal(report.status, s.validation.status);
  assert.equal(s.evidenceOutcome, report.status === "verified" ? "validated" : report.status);
  const reservationBytes = regular(join(folder, ".host-attempt.json"), 1024 * 1024);
  const reservation = JSON.parse(reservationBytes);
  const plan = JSON.parse(regular(join(folder, report.campaign, "plan.json"), 16 * 1024 ** 2));
  assert.equal(reservation.commit, commit); assert.equal(reservation.id, report.campaign);
  assert.equal(reservation.campaignSha256, report.campaignSha256);
  assert.equal(digest(reservationBytes), report.reservationSha256);
  assert.equal(plan.commit, commit); assert.equal(plan.round, round);
  assert.equal(plan.campaignSha256, report.campaignSha256); assert.equal(plan.sourceSha256, report.sourceSha256);
  assert.equal(regular(join(job.local, s.evidence, "exit-code"), 16).toString("ascii"), `${s.exitCode}\n`);
  const snapshot = { group, ...hashes };
  recheckCollectedGroup(fleet, snapshot);
  const outcome = !s.destroyedAt || !s.deletionIntentAt ? "cleanup-pending" : report.status === "verified" ? "verified" : report.status;
  const row = { group, outcome, id: s.id, host: s.host,
    hardwareEvidence: { artifact: `${group}/groups-${round}/${s.evidence}/host.txt`, sha256: fileHash(join(job.local, s.evidence, "host.txt")) },
    ...(report.offlineAuditExpired ? { offlineAuditExpired: report.offlineAuditExpired,
      nativeFailureEvidence: { artifact: `${group}/groups-${round}/${s.evidence}/campaign`, archiveTreeSha256: report.archiveTreeSha256,
        scope: "audit-expired-before-timing" } } : {
      nativeTimingEvidence: { artifact: `${group}/groups-${round}/${s.evidence}/campaign`, archiveTreeSha256: report.archiveTreeSha256,
        scope: "saved-native-journal-and-raw-timings-not-cross-host-comparable" } }),
    ...(report.offlineIngress ? { offlineIngress: report.offlineIngress } : {}),
    recordedTimes: { reservationCreatedAt: s.createdAt, collectedAt: s.collectedAt, ...(s.destroyedAt ? { destroyedAt: s.destroyedAt } : {}) },
    timeScope: "reservation-and-collection-not-provider-billing-or-benchmark-elapsed", ...hashes,
    campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256,
    ...(details ? { campaignCreatedAt: reservation.createdAt, baseEffectiveOptions: plan.bindings?.[0]?.execution?.effectiveOptions } : {}),
    ...(report.status === "verified" ? { appOutcomes: report.groups[0].appOutcomes.map(({ app, outcome, comparisonEligible, comparison }) =>
      ({ app, outcome, comparisonEligible, ...(comparisonEligible && comparison ? { comparison } : {}) })) } : {}) };
  return { evidenceMode: inspect ? "synthetic-inspection" : "native-replay", row, snapshot };
}

// inspect, compiler and processStart are in-process TEST seams only. The CLI never accepts code,
// module paths, reports or commands from JSON. Default replay imports fixed code.
export async function verifyFleet({ root, round, commit }, { inspect, start, details, bindArchive, priorSelection, interrupted = () => false,
  compiler = localCompiler, processStart = windowsProcessStart, retainCheck } = {}) {
  const base = { schema: "benchmark-group-fleet-inspection/v1", scope: "intrinsic-evidence", status: "incomplete",
    evidenceMode: inspect ? "synthetic-inspection" : "native-replay", nativeReadiness: false,
    publishableBaseline: false, comparisonScope: "within-group-host-only" };
  // Native replay needs this checkout's bench install; say so before reading any group.
  if (inspect === undefined && !compiler()) return { ...base, error: localCompilerMissing, groups: [] };
  let fleet;
  try {
    full(commit, /[a-f0-9]{40}/, "fleet-source");
    fleet = readFleet(fleetRoot(root), round, { priorSelection }); assert.equal(fleet.manifest.commit, commit);
  } catch { return { ...base, error: "fleet-invalid", groups: [] }; }
  const result = { ...base, round, commit, fleetSha256: fleet.manifest.fleetSha256,
    manifestSha256: fleet.manifestSha256, selection: fleet.manifest.selection, groups: [] };
  const lock = reportBatch(fleet, processStart);
  const busy = () => ({ ...result, fleetLock: "busy", error: "fleet-operation-busy", groups: [] });
  if (lock === "busy") return busy();
  if (lock !== null) result.fleetLock = "retained";
  const snapshots = [], retirements = [], identities = new Set();
  let remaining;
  if (stagedFleet(fleet.manifest) && present(join(fleet.root, "remaining-intent.json"))) {
    try { remaining = readRemainingIntent(fleet); }
    catch { return { ...result, error: "fleet-remaining-intent-invalid" }; }
  }
  let duplicate = false;
  for (const { group } of fleet.manifest.jobs) {
    let job;
    const add = (row) => {
      const s = job?.state;
      result.groups.push(details && s ? { ...row, id: s.id, host: s.host, reservationCreatedAt: s.createdAt,
        destroyedAt: s.destroyedAt, stateSha256: job.stateSha256, archiveSha256: s.archiveSha256,
        evidenceOutcome: s.evidenceOutcome, exitCode: s.exitCode, monitorPhase: s.control?.monitor?.phase,
        ...(s.retirement ? { retirement: s.retirement } : {}) } : row);
    };
    try {
      job = readGroup(fleet, group);
      if (job.state?.id) {
        for (const key of [`id:${job.state.id}`, `ip:${job.state.ip}`]) {
          if (identities.has(key)) duplicate = true;
          identities.add(key);
        }
      }
      const s = job.state;
      // Read-only exception: a fully verified retirement may keep the original
      // invalid monitor locks. Do not make that child available for fleet work.
      const noRecovery = () => !present(join(job.local, "stream-recovery.lock"));
      const retainedCandidate = job.outcome === "busy" && s.status === "retired" && s.retirement.kind === "native-failed"
        && s.control?.monitor?.phase === "invalid" && s.launchHostKeySha256 !== undefined && noRecovery();
      const historicalLocks = historicalChildLocks(job, processStart);
      const retained = retainedCandidate && (s.destroyedAt ? !!historicalLocks : !retainedInvalidOwner(job.local, s));
      if (job.outcome !== "available" && !retained) { add({ group, outcome: job.outcome }); continue; }
      if (s.createErrored) {
        // Resolved only with its receipt and with no launch, operation or recheck lock left.
        createErroredCustody(job.local);
        verifyCreateErrored(job.local, s);
        assert.equal(digest(regular(join(job.local, "state.json"), 1024 * 1024)), job.stateSha256, "create failure changed during verification");
        add({ group, outcome: "create-errored" }); continue;
      }
      if (s.status === "retired") {
        if (s.retirement.kind === "native-failed") {
          if (present(join(job.local, "stream-recovery.lock"))) { add({ group, outcome: "busy" }); continue; }
          const historicalCheck = historicalLocks && (() => {
            assert.ok(historicalLocks(), "historical child locks changed");
          });
          let exitOneCheck;
          if (failedExitOneCandidate(job.local, s)) {
            exitOneReadLocks(job.local);
            const { record, assertCustody } = verifyFailedExitOneRetirement(job.local, s, s.retirement.evidenceSha256, true);
            assert.equal(record.launchIntentSha256, readLaunchIntent(fleet).sha256, "exit-one launch intent differs");
            exitOneCheck = () => { exitOneReadLocks(job.local); assertCustody(); };
          } else if (historicalCheck) verifyHistoricalFailedNativeRetirement(job.local, s, historicalCheck);
          else verifyFailedNativeRetirement(job.local, s);
          assert.equal(digest(regular(join(job.local, "state.json"), 1024 * 1024)), job.stateSha256, "retirement changed during verification");
          if (historicalCheck) historicalCheck();
          else if (retained) assert.ok(noRecovery() && !retainedInvalidOwner(job.local, s), "retained lock owner changed during verification");
          retirements.push({ group, index: result.groups.length, stateSha256: job.stateSha256, retained, historicalLocks, historicalCheck, exitOneCheck });
          add({ group, outcome: s.destroyedAt ? "native-failed-retired" : "cleanup-pending", id: s.id }); continue;
        }
        const setup = s.retirement.kind === "setup-failed";
        if (setup) {
          verifySetupRetry(job);
          retirements.push({ group, index: result.groups.length, stateSha256: job.stateSha256, setup });
        }
        else {
          const bytes = regular(join(job.local, "unused-host.json"), 4096);
          assert.equal(digest(bytes), s.retirement.evidenceSha256);
          verifyUnusedEvidence(JSON.parse(bytes), s);
        }
        add({ group, outcome: s.destroyedAt ? setup ? "setup-failed-retired" : "unused-retired" : "cleanup-pending", id: s.id }); continue;
      }
      if (s.status !== "collected" || !s.collectedAt) { add({ group, outcome: "uncollected" }); continue; }
      const verified = await verifyCollectedGroup(fleet, group, { inspect, start, details, bindArchive, interrupted });
      snapshots.push(verified.snapshot); add(verified.row);
    } catch { add({ group, outcome: "error", error: "group-evidence-invalid" }); }
  }
  let evidenceError;
  try {
    assert.ok(!interrupted());
    assert.equal(readFleet(fleet.root, round, { priorSelection }).manifestSha256, fleet.manifestSha256);
    if (remaining) {
      assert.equal(readRemainingIntent(fleet).sha256, remaining.sha256);
      assert.deepEqual(snapshots.find(({ group }) => group === fleet.manifest.jobs[0].group), remaining.placement.firstGroup);
    }
    for (const snapshot of snapshots) recheckCollectedGroup(fleet, snapshot);
    assert.ok(!duplicate);
  } catch { evidenceError = "fleet-evidence-changed-or-duplicated"; }
  // A later sibling's replay may have overlapped failed-host recovery. Rebind
  // the status to the verified state and receipt, not the earlier display row.
  for (const { group, index, stateSha256, setup, retained, historicalLocks, historicalCheck, exitOneCheck } of retirements) {
    try {
      const job = readGroup(fleet, group);
      if (present(join(job.local, "stream-recovery.lock"))
          || (job.outcome === "busy" && (!retained || (historicalLocks
            ? !historicalLocks() : retainedInvalidOwner(job.local, job.state))))) {
        result.groups[index] = { group, outcome: "busy" }; continue;
      }
      assert.equal(job.outcome, retained ? "busy" : "available");
      assert.equal(job.stateSha256, stateSha256);
      if (setup) { verifySetupRetry(job); continue; }
      assert.equal(digest(regular(join(job.local, "failed-native-host.json"))), job.state.retirement.evidenceSha256);
      exitOneCheck?.();
      if (exitOneCheck) retainCheck?.(exitOneCheck);
      if (historicalCheck) retainCheck?.(historicalCheck);
    } catch { result.groups[index] = { group, outcome: "uncertain", error: "group-retirement-changed" }; }
  }
  if (!sameReportBatch(lock, reportBatch(fleet, processStart))) return { ...busy(), ...(evidenceError ? { evidenceError } : {}) };
  if (evidenceError) return { ...result, error: evidenceError };
  if (!fleet.manifest.single && lock === null && result.groups.every((g) => g.outcome === "verified")) result.status = "verified";
  return result;
}

export async function verifyFleetCli(args, { write = console.log } = {}) {
  try {
    assert.equal(args.length, 5); assert.equal(args[1], "--fleet-root"); assert.equal(args[3], "--commit");
    const report = await verifyFleet({ root: args[2], round: args[0], commit: args[4] });
    write(JSON.stringify(report)); return report.status === "verified" ? 0 : 1;
  } catch { write(JSON.stringify({ schema: "benchmark-group-fleet-inspection/v1", status: "incomplete", publishableBaseline: false, error: "fleet-inspection-invalid" })); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  verifyFleetCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
