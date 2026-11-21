// Read-only fleet inventory. Receipts are diagnostics, never evidence authority.
import assert from "node:assert/strict";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fleetCreateMode, roundName, selection, stagedFleet, validateFleet } from "./cloud-contract.mjs";
import { campaignOutcome, controllerState, full } from "./cloud-options.mjs";
import { digest, fileHash, physical, regular, resolveStateRoot, treeHash } from "./cloud-local.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { localCompiler, localCompilerMissing } from "./cloud-validation-snapshot.mjs";
import { retainedInvalidOwner, setupEvidence, terminalSetupScript, verifyFailedNativeRetirement, verifyUnusedEvidence } from "./cloud-retirement.mjs";

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
// For inspection only. A dead original batch owner does not unlock the fleet.
export function fleetLockSnapshot(root) {
  const path = join(root, ".fleet-operation.lock");
  try {
    if (!present(path)) return null;
    const bytes = regular(path, 1024), { pid, approvalSha256, ...rest } = JSON.parse(bytes);
    assert.deepEqual(rest, {});
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    full(approvalSha256, /[a-f0-9]{64}/, "fleet lock approval");
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return digest(bytes); }
  } catch { /* Unreadable, foreign and prepare locks are not settled batch locks. */ }
  return "busy";
}

export function readFleet(root, round, { priorSelection = false } = {}) {
  roundName(round); physical(root);
  const path = join(root, `fleet-${round}.json`), bytes = regular(path, 1024 * 1024), manifest = validateFleet(JSON.parse(bytes), { priorSelection });
  assert.equal(manifest.round, round);
  if (manifest.single) {
    assert.equal(root, join(dirname(root), manifest.single.group), "continuation group slot differs");
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

function evidenceSnapshot(job) {
  physical(job.local);
  const s = job.state, extracted = join(job.local, s.evidence);
  assert.equal(fileHash(join(job.local, "results.tgz")), s.archiveSha256);
  assert.equal(treeHash(extracted), s.evidenceSha256);
  assert.equal(digest(regular(join(job.local, "state.json"), 1024 * 1024)), job.stateSha256);
  return { stateSha256: job.stateSha256, archiveSha256: s.archiveSha256, evidenceSha256: s.evidenceSha256 };
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
export function recheckContinuationProofs(proofs) {
  assert.ok(Array.isArray(proofs) && proofs.length <= selection().groups.length);
  for (const { root, round, manifestSha256, ...snapshot } of proofs) {
    const fleet = readFleet(root, round, { priorSelection: true });
    assert.equal(fleet.manifestSha256, manifestSha256, "continuation manifest changed");
    assert.notEqual(fleetLockSnapshot(root), "busy", "continuation source busy");
    recheckCollectedGroup(fleet, snapshot);
  }
}
export async function verifyCollectedGroup(fleet, group, { inspect, start, details, interrupted = () => false } = {}) {
  const job = readGroup(fleet, group), { round, commit } = fleet.manifest;
  assert.equal(job.outcome, "available");
  const s = job.state;
  assert.ok(s.status === "collected" && s.collectedAt, "group-not-collected");
  assert.ok(!interrupted());
  const hashes = evidenceSnapshot(job), folder = join(job.local, s.evidence, "campaign");
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
    nativeTimingEvidence: { artifact: `${group}/groups-${round}/${s.evidence}/campaign`, archiveTreeSha256: report.archiveTreeSha256,
      scope: "saved-native-journal-and-raw-timings-not-cross-host-comparable" },
    recordedTimes: { reservationCreatedAt: s.createdAt, collectedAt: s.collectedAt, ...(s.destroyedAt ? { destroyedAt: s.destroyedAt } : {}) },
    timeScope: "reservation-and-collection-not-provider-billing-or-benchmark-elapsed", ...hashes,
    campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256,
    ...(details ? { campaignCreatedAt: reservation.createdAt, configuration: plan.bindings?.[0]?.execution?.effectiveOptions } : {}),
    ...(report.status === "verified" ? { appOutcomes: report.groups[0].appOutcomes.map(({ app, outcome, comparisonEligible }) => ({ app, outcome, comparisonEligible })) } : {}) };
  return { evidenceMode: inspect ? "synthetic-inspection" : "native-replay", row, snapshot };
}

// inspect and compiler are in-process synthetic TEST seams only. The CLI never accepts code,
// module paths, reports or commands from JSON. Default replay imports fixed code.
export async function verifyFleet({ root, round, commit }, { inspect, start, details, priorSelection, interrupted = () => false, compiler = localCompiler } = {}) {
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
  const lock = fleetLockSnapshot(fleet.root);
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
      const safelyRetained = () => !present(join(job.local, "stream-recovery.lock")) && !retainedInvalidOwner(job.local, s);
      const retained = job.outcome === "busy" && s.status === "retired" && s.retirement.kind === "native-failed"
        && s.control?.monitor?.phase === "invalid" && s.launchHostKeySha256 !== undefined && safelyRetained();
      if (job.outcome !== "available" && !retained) { add({ group, outcome: job.outcome }); continue; }
      if (s.status === "retired") {
        if (s.retirement.kind === "native-failed") {
          if (present(join(job.local, "stream-recovery.lock"))) { add({ group, outcome: "busy" }); continue; }
          verifyFailedNativeRetirement(job.local, s);
          assert.equal(digest(regular(join(job.local, "state.json"), 1024 * 1024)), job.stateSha256, "retirement changed during verification");
          if (retained) assert.ok(safelyRetained(), "retained lock owner changed during verification");
          retirements.push({ group, index: result.groups.length, stateSha256: job.stateSha256, retained });
          add({ group, outcome: s.destroyedAt ? "native-failed-retired" : "cleanup-pending", id: s.id }); continue;
        }
        const setup = s.retirement.kind === "setup-failed";
        const bytes = regular(join(job.local, setup ? "failed-setup-host.json" : "unused-host.json"), 4096), record = JSON.parse(bytes);
        assert.equal(digest(bytes), s.retirement.evidenceSha256);
        const raw = JSON.stringify(record.observation);
        if (setup) {
          const extracted = join(job.local, s.evidence); physical(extracted);
          assert.equal(fileHash(join(job.local, "results.tgz")), s.archiveSha256);
          assert.equal(treeHash(extracted), s.evidenceSha256);
          const campaign = join(extracted, "campaign");
          if (present(campaign)) { physical(campaign); assert.deepEqual(readdirSync(campaign), []); }
          const marker = regular(join(extracted, "exit-code"), 16).toString("utf8");
          full(marker, /[1-9]\d{0,2}\n/, "nonzero setup exit"); const exit = Number(marker.trim()); assert.ok(exit <= 255);
          assert.deepEqual(record, setupEvidence(raw, s, terminalSetupScript(s, exit), exit, record.startedAtMs, record.finishedAtMs));
        } else verifyUnusedEvidence(record, s);
        add({ group, outcome: s.destroyedAt ? setup ? "setup-failed-retired" : "unused-retired" : "cleanup-pending", id: s.id }); continue;
      }
      if (s.status !== "collected" || !s.collectedAt) { add({ group, outcome: "uncollected" }); continue; }
      const verified = await verifyCollectedGroup(fleet, group, { inspect, start, details, interrupted });
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
  for (const { group, index, stateSha256, retained } of retirements) {
    try {
      const job = readGroup(fleet, group);
      if (present(join(job.local, "stream-recovery.lock"))
          || (job.outcome === "busy" && (!retained || retainedInvalidOwner(job.local, job.state)))) {
        result.groups[index] = { group, outcome: "busy" }; continue;
      }
      assert.equal(job.outcome, retained ? "busy" : "available");
      assert.equal(job.stateSha256, stateSha256);
      assert.equal(digest(regular(join(job.local, "failed-native-host.json"))), job.state.retirement.evidenceSha256);
    } catch { result.groups[index] = { group, outcome: "uncertain", error: "group-retirement-changed" }; }
  }
  if (fleetLockSnapshot(fleet.root) !== lock) return { ...busy(), ...(evidenceError ? { evidenceError } : {}) };
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
