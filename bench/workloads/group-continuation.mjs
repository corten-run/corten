// A read-only index of original group attempts, not a fleet or launch intent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { roundName, selection, stagedFleet } from "./cloud-contract.mjs";
import { digest, physical, regular } from "./cloud-local.mjs";
import { full } from "./cloud-options.mjs";
import { createContradiction, createErroredCustody, createErroredReceipt, createRecheckLock, failedSetupRetirementFile, verifyCreateErrored,
  exitOneReadLocks, failedExitOneCandidate, failedExitOneScope, verifyFailedExitOneRetirement, verifyFailedNativeRetirement, verifyHistoricalFailedNativeRetirement,
  verifyUnusedEvidence } from "./cloud-retirement.mjs";
import { continuationIndex, continuationIndexSha256, continuationPeer, fleetBatchLock, fleetLockSnapshot, fleetRoot, historicalChildLocks, outside, present, readCreateQuarantine, readFleet, readGroup,
  postedContradiction, readExternalFailedHost, readLaunchIntent, readRemainingIntent, recheckCollectedGroup, recheckExternalFailedHost, recheckIndexedLaunchCustody, recheckSetupAttempt, reportBatch, sameReportBatch,
  replacementQuarantine, verifyCollectedGroup, verifyFleet, verifySetupRetry } from "./fleet-verify.mjs";

export const continuationLock = ".continuation-operation.lock";
const groups = selection(), names = groups.groups.map(({ group }) => group);
const adapter = "bench/workloads/cloud-validation-snapshot.mjs";
const keys = (object, expected) => assert.deepEqual(Object.keys(object).sort(), expected, "continuation index fields differ");

function git(repo, ...args) {
  const r = spawnSync("git", ["--no-replace-objects", "-C", repo, ...args], { encoding: "utf8", timeout: 5000,
    maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
  assert.ok(!r.error && r.status === 0, "continuation measured source unavailable or not an ancestor");
  return r.stdout;
}

export function measuredCheckout(root, saved, commit) {
  full(commit, /[a-f0-9]{40}/, "measured commit");
  const pinned = join(`${root}-checkouts`, commit);
  const checkout = fleetRoot(present(pinned) ? pinned : saved);
  physical(checkout);
  assert.equal(git(checkout, "rev-parse", "--verify", "HEAD^{commit}").trim(), commit, "use the original measured checkout");
  return checkout;
}

async function measuredReplay(repo, checkout, commit) {
  git(repo, "merge-base", "--is-ancestor", commit, "HEAD");
  // Read the measured adapter from a trusted Git object, not from evidence or the
  // mutable checkout. Like r21 recovery it imports only builtins and captures its
  // own pinned dependencies and deny-unlisted validator worker from that checkout.
  const source = git(repo, "cat-file", "blob", `${commit}:${adapter}`);
  const url = pathToFileURL(join(checkout, adapter)).href + `?continuation=${commit}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === url) return { url, shortCircuit: true };
      if (context.parentURL === url) assert.ok(isBuiltin(specifier), "measured adapter imports only builtins");
      return next(specifier, context);
    },
    load(specifier, context, next) { return specifier === url ? { format: "module", source, shortCircuit: true } : next(specifier, context); },
  });
  try {
    const measured = await import(url);
    return { compiler: () => measured.localCompiler(checkout),
      start: (input) => measured.validationTask(input, { snapshot: measured.captureValidation(commit) }) };
  } finally { hook.deregister(); }
}

const setupCensusOutcome = "setup-failed-needs-census";
const externalFailureOutcome = "external-failed-needs-census";
const retryable = (row) => ["not-created", "native-failed-retired", "setup-failed-retired", "unused-retired", "create-errored", setupCensusOutcome, externalFailureOutcome].includes(row.outcome)
  || ["failed", "blocked"].includes(row.outcome) && !!row.destroyedAt;
export function requireSetupRetryCommit(attempts, commit) {
  assert.ok(!attempts.some((row) => row.outcome === setupCensusOutcome && row.commit === commit),
    "retry after failed setup requires a different measured commit");
  assert.ok(!attempts.some((row) => row.outcome === externalFailureOutcome && row.commit === commit),
    "retry after external failure requires a different measured commit");
}
const acceptable = (row) => ["missing", "prepared", "verified", "running", "quarantined-create"].includes(row.outcome) || retryable(row);
const unresolved = (row) => row.custodyUnresolved || row.outcome !== "known-result" && !acceptable(row) && !row.cleanupUnconfirmed;
const manifestOnly = (fleet, entries = readdirSync(fleet.root)) =>
  entries.length === 1 && entries[0] === `fleet-${fleet.manifest.round}.json`;
const terminal = ({ state }) => state?.id && state.destroyedAt && ["collected", "retired"].includes(state.status);
// A provider-errored create never had a host. It is settled once its child holds no
// launch, operation ("available") or recheck lock, unless a later read saw its posted
// droplet again: that recorded contradiction never settles.
const createErrored = (saved) => saved.outcome === "available" && !!saved.state?.createErrored && !saved.state.createErrored.reappeared
  && !present(join(saved.stateRoot, ".groups-launch.lock")) && !present(join(saved.local, createRecheckLock)) && !createContradiction(saved.local);
const settled = (saved) => terminal(saved) || createErrored(saved);
function verifyCreateErroredAttempt(saved) {
  assert.ok(createErrored(saved), "unresolved custody for the selected group");
  verifyCreateErrored(saved.local, saved.state);
}
const receiptSha256 = (state, file) => file === createErroredReceipt ? state.createErrored?.evidenceSha256 : state.retirement?.evidenceSha256;
const known = ({ state }) => state?.id && state.status === "collected" && state.validation?.status === "verified";
const retirementFile = (kind) => ({ "native-failed": "failed-native-host.json", "setup-failed": failedSetupRetirementFile, unused: "unused-host.json" })[kind];
const lockBytes = (root) => { const bytes = fleetBatchLock(root); return bytes && digest(bytes); };

function verifyRetryRetirement(saved, processStart, retainedLocks, exitOne) {
  const { local, state, stateRoot } = saved, { kind, evidenceSha256 } = state.retirement;
  if (kind === "setup-failed") return verifySetupRetry(saved);
  assert.ok(!present(join(local, "stream-recovery.lock")), "group recovery remains active");
  if (kind === "native-failed") {
    if (exitOne) {
      assert.equal(saved.outcome, "available", "exit-one retirement still holds custody");
      exitOneReadLocks(local);
      const { record, assertCustody } = verifyFailedExitOneRetirement(local, state, evidenceSha256, true);
      retainedLocks.push(() => { exitOneReadLocks(local); assertCustody(); });
      return { receiptSha256: evidenceSha256, reservationSha256: record.reservationSha256 };
    } else if (saved.outcome === "available") verifyFailedNativeRetirement(local, state);
    else {
      const sameLocks = historicalChildLocks(saved, processStart);
      assert.ok(sameLocks, "unresolved custody for the selected group");
      const check = () => assert.ok(sameLocks(), "historical child locks changed");
      verifyHistoricalFailedNativeRetirement(local, state, check);
      check();
      retainedLocks.push(check);
    }
  } else {
    assert.ok(saved.outcome === "available" && !present(join(stateRoot, ".groups-launch.lock")), "unresolved custody for the selected group");
    const bytes = regular(join(local, retirementFile(kind)), 4096);
    assert.equal(digest(bytes), evidenceSha256, "unresolved custody: retirement receipt changed");
    verifyUnusedEvidence(JSON.parse(bytes), state);
  }
}

function notCreated(fleet, saved, lock) {
  if (!fleet.manifest.single || lock !== null || !present(join(fleet.root, "launch-intent.json"))) return false;
  if (saved.outcome !== "missing" && (saved.state?.status !== "reserved" || saved.outcome !== "ambiguous"
      || present(join(saved.stateRoot, ".groups-launch.lock")) || present(join(saved.local, "stream-recovery.lock")))) return false;
  readLaunchIntent(fleet);
  // Create requires a durable binding before any provider dispatch. A settled
  // launch with no child directory, or a reservation still before that binding,
  // cannot have sent create. Never accept "creating" or missing state in a child.
  return true;
}

// inspect is a synthetic in-process test seam. On the CLI every accepted result
// comes from the measured native replay; index entries are references, not verdicts.
export async function inspectContinuation(root, deps) {
  return scanContinuation(root, deps);
}

export async function continuationAdmission(root, group, deps) {
  assert.ok(names.includes(group));
  return scanContinuation(root, deps, group);
}

async function scanContinuation(root, { repo, interrupted, inspect, processStart, admissionFailure } = {}, admittedGroup) {
  root = fleetRoot(root, repo);
  const bytes = continuationIndex(root), indexSha256 = digest(bytes), index = JSON.parse(bytes);
  assert.ok(Array.isArray(index) && index.length <= 64, "invalid continuation index");
  const indexed = new Map(index.map((entry) => {
    keys(entry, ["archives", "checkout", "commit", "root", "round"]);
    return [fleetRoot(entry.root, repo), entry];
  }));
  assert.equal(indexed.size, index.length, "retained fleet roots must be unique");
  const members = () => readdirSync(root).filter((name) => name !== continuationLock).sort();
  const paths = members();
  const directories = paths.filter((name) => name !== "index.json").map((name) => {
    const [group, round, ...rest] = name.split("--");
    assert.ok(names.includes(group) && !rest.length && (round === undefined || /^r[1-9]\d{0,8}$/.test(round)),
      "continuation root members differ");
    return { name, group, round };
  });
  const attempts = new Map(names.map((group) => [group, []])), slots = new Map(), unlaunched = new Map(), ids = new Set();
  const indexedCustody = [];
  const proofs = [], retryEvidence = [], manifests = [], states = [], peers = [], unconfirmed = [], needsCensus = new Set(), liveIps = new Set();
  // createFailures binds the selected group's own retry to its exact receipt and state.
  // postedCreates is the census fence and the final-gate snapshot: every earlier
  // provider-errored attempt's posted droplet in any group, settled or contradicted
  // (also after its retirement), refuses a create on its account while it is listed.
  const createFailures = [], postedCreates = [], setupRetirements = [], exitOneRetirements = [], quarantinedCreates = [];
  const retainedLocks = [];
  const setupCensus = (fleet, saved, lock, launch) => {
    const { group, state, stateSha256 } = saved, { round, provider, single } = fleet.manifest;
    if (!(single && lock === null && launch && saved.outcome === "available"
        && state?.status === "starting" && state.preBootstrapTerminal && state.evidence)) return;
    const row = { group, round, accountId: provider.accountId, manifestSha256: fleet.manifestSha256,
      stateSha256, id: state.id, root: fleet.root, launch };
    retainedLocks.push(() => recheckSetupAttempt(root, row));
    return row;
  };
  const claim = (id) => { assert.ok(!ids.has(id), "duplicate continuation host identity"); ids.add(id); };
  const matchesCurrentContract = (selected) => groups.groups.some((s) => s.group === selected.group
    && s.contractSha256 === selected.contractSha256 && JSON.stringify(s.apps) === JSON.stringify(selected.apps));
  const addPeer = (fleet) => {
    const { proof, state } = continuationPeer(fleet), { round, commit } = fleet.manifest;
    assert.ok(!liveIps.has(proof.ip), "duplicate continuation peer address"); liveIps.add(proof.ip);
    claim(proof.id); peers.push({ fleet, proof });
    const selected = fleet.manifest.selection.groups[0];
    attempts.get(state.group).push({ group: state.group, outcome: "running", round, commit, id: state.id, host: state.host,
      reservationCreatedAt: state.createdAt, manifestSha256: fleet.manifestSha256, selection: selected,
      matchesCurrentContract: matchesCurrentContract(selected), attemptRoot: fleet.root });
  };
  const refuseAdmission = (check, error) => { admissionFailure?.(error, check); throw error; };
  const readAdmission = async (fleet, checkout, archives) => {
    assert.ok(!interrupted?.(), "continuation admission cancelled");
    const { manifest, manifestSha256 } = fleet, { round, commit, single } = manifest;
    const bytes = fleetBatchLock(fleet.root), lock = bytes && digest(bytes);
    const children = manifest.jobs.map(({ group }) => readGroup(fleet, group));
    if (lock !== null && single && !settled(children[0])) { addPeer(fleet); return; }
    const launchIntent = (single || stagedFleet(manifest)) && present(join(fleet.root, "launch-intent.json"))
      ? readLaunchIntent(fleet) : undefined;
    const remainingIntent = !single && stagedFleet(manifest) && present(join(fleet.root, "remaining-intent.json"))
      ? readRemainingIntent(fleet) : undefined;
    const launch = launchIntent?.sha256, remaining = remainingIntent?.sha256;
    let requireDeadOwner = false;
    if (bytes && !single) {
      const { pid, approvalSha256, ...extra } = JSON.parse(bytes);
      assert.deepEqual(extra, {}, "continuation source has an active batch");
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "continuation source has an active batch");
      // A retained lock is spent only for its exact consumed action. A first
      // launch intent says nothing about a live remaining owner before intent.
      const consumed = [launchIntent, remainingIntent].find((it) => it && it.approvalSha256 === approvalSha256);
      requireDeadOwner = !consumed || !consumed.subject.jobs.every((job, i) => job.outcome !== "planned" || settled(children[i]));
      if (requireDeadOwner) {
        try { assert.equal(fleetLockSnapshot(fleet.root), lock, "continuation source has an active batch"); }
        catch (error) { refuseAdmission("batch-owner", error); }
      }
    }
    if (single) manifests.push({ ...fleet, lock, launch });
    else indexedCustody.push({ root: fleet.root, manifestSha256, lock, launch, remaining, ...(requireDeadOwner ? { requireDeadOwner } : {}) });
    for (const saved of children) {
      const { group, state, stateSha256 } = saved, selected = group === admittedGroup;
      const pinned = archives && Object.hasOwn(archives, group);
      const exitOne = failedExitOneCandidate(saved.local, state);
      if (failedExitOneScope(state) && state.archiveSha256 && !terminal(saved))
        assert.fail("unresolved custody: the bound Client Heavy attempt requires confirmed absence");
      if (exitOne) assert.ok(!pinned, "failed exit one is not a retained result");
      // Only bound historical allocations past create/bootstrap (or with a
      // recorded terminal setup) can have cleanup settled by an account census.
      const setup = setupCensus(fleet, saved, lock, launch);
      const censusRequired = !!setup || !!(archives && state?.id && !terminal(saved)
        && (["running", "collected", "retired"].includes(state.status) || state.preBootstrapTerminal));
      assert.ok(!pinned || terminal(saved) || censusRequired, "unresolved custody: archive pin lacks a bound historical allocation");
      const noCreate = notCreated(fleet, saved, lock);
      let outcome = noCreate ? "not-created" : setup ? setupCensusOutcome : saved.outcome === "available" ? "uncollected" : saved.outcome;
      let receipt;
      // Settled, contradicted or retired after its contradiction: the posted ID stays fenced.
      // The snapshot is what the successor's child rechecks immediately before its create.
      const postedId = (state?.createErrored ?? state?.createContradicted)?.dropletId;
      if (postedId) {
        // The final gate's custody check (recheckPostedCreate), applied to every posted attempt,
        // retired or not, so a lock the gate would refuse refuses here, before approval.
        try { createErroredCustody(saved.local); }
        catch (cause) { refuseAdmission("posted-custody", new Error("unresolved custody: an earlier provider-errored create still holds a lock", { cause })); }
        postedCreates.push({ root: fleet.root, round, group, manifestSha256, stateSha256, outcome: saved.outcome,
          contradicted: postedContradiction(saved), accountId: manifest.provider.accountId, dropletId: postedId });
      }
      if (pinned || known(saved)) outcome = "known-result";
      else if (createErrored(saved)) {
        if (selected) {
          try { verifyCreateErroredAttempt(saved); }
          catch (cause) { refuseAdmission("custody-replay", new Error("unresolved custody: selected provider-errored create is not verified", { cause })); }
          receipt = createErroredReceipt;
          // The successor's child rechecks this attempt again immediately before its create,
          // and its pre-create census refuses any droplet with the posted ID, whatever its name or tags.
          createFailures.push({ root: fleet.root, round, group, manifestSha256, stateSha256, receiptSha256: state.createErrored.evidenceSha256,
            accountId: manifest.provider.accountId, dropletId: state.createErrored.dropletId });
        }
        outcome = "create-errored";
      } else if (terminal(saved)) {
        if (state.status === "retired") {
          if (selected || failedExitOneScope(state)) {
            try {
              const retirement = verifyRetryRetirement(saved, processStart, retainedLocks, exitOne);
              if (retirement) {
                assert.equal(dirname(fleet.root), root, "exit-one retirement must stay in its original continuation slot");
                assert.ok(launch, "no original exit-one launch intent");
                exitOneRetirements.push({ root: fleet.root, round, group, manifestSha256, stateSha256, launch,
                  accountId: manifest.provider.accountId, id: state.id, ...retirement });
              }
            }
            catch (cause) { refuseAdmission("custody-replay", new Error("unresolved custody: selected group retirement is not verified", { cause })); }
            receipt = retirementFile(state.retirement.kind);
            if (receipt === failedSetupRetirementFile) setupRetirements.push({ root: fleet.root, round, group, manifestSha256, stateSha256, launch, batchSha256: lock });
          }
          outcome = `${state.retirement.kind}-retired`;
        } else {
          if (selected) {
            try {
              const replay = inspect ? { inspect } : await measuredReplay(repo, measuredCheckout(root, checkout, commit), commit);
              const { row, snapshot } = await verifyCollectedGroup(fleet, group, { ...replay, interrupted, bindArchive: true });
              assert.equal(row.outcome, state.validation.status, "selected retry evidence differs");
              retryEvidence.push({ fleet, snapshot });
            } catch (error) { refuseAdmission("custody-replay", error); }
          }
          outcome = state.validation.status;
        }
      }
      if (single && (retryable({ outcome, destroyedAt: state?.destroyedAt }) || outcome === "known-result"))
        assert.ok(launch, "no original group launch intent");
      if (state?.id) claim(state.id);
      // Historical allocations without deletion confirmation cannot grant a
      // peer exception. Only a fresh census in their account may exclude them.
      if (censusRequired) {
        const { accountId } = manifest.provider;
        needsCensus.add(accountId);
        unconfirmed.push(setup ?? { group, round, accountId, manifestSha256, stateSha256, id: state.id });
      }
      states.push({ fleet, group, stateSha256, outcome: saved.outcome, noCreate, retirementFile: receipt });
      const attempt = { group, outcome, round, commit, manifestSha256, stateSha256, launch,
        destroyedAt: state?.destroyedAt, ...(single ? { attemptRoot: fleet.root } : {}),
        ...(single && known(saved) && !terminal(saved) ? { custodyUnresolved: true } : {}),
        ...(censusRequired ? { cleanupUnconfirmed: true } : {}) };
      assert.ok(attempts.has(group) || !unresolved(attempt), "unresolved custody for a historical group");
      attempts.get(group)?.push(attempt);
    }
  };
  const read = async (fleet, checkout, archives) => {
    const external = readExternalFailedHost(fleet);
    if (external) {
      const { group, round, id, accountId, manifestSha256, stateSha256, launch } = external;
      assert.ok(!archives && attempts.has(group), "external failure is not a retained result");
      claim(id);
      needsCensus.add(accountId); unconfirmed.push(external);
      retainedLocks.push(() => recheckExternalFailedHost(root, external));
      attempts.get(group).push({ group, round, commit: fleet.manifest.commit, id, manifestSha256, stateSha256, launch,
        outcome: externalFailureOutcome, attemptRoot: fleet.root, cleanupUnconfirmed: true });
      return;
    }
    const quarantineOptions = { report: !admittedGroup };
    const quarantine = readCreateQuarantine(fleet, quarantineOptions);
    if (quarantine) {
      const { group, round, accountId } = quarantine, { manifest, manifestSha256 } = fleet;
      assert.ok(!archives && attempts.has(group), "create quarantine is not a retained result");
      needsCensus.add(accountId); quarantinedCreates.push(quarantine);
      retainedLocks.push(() => assert.deepEqual(readCreateQuarantine(readFleet(fleet.root, round, { priorSelection: true }),
        quarantineOptions), quarantine, "create quarantine changed"));
      attempts.get(group).push({ group, round, commit: manifest.commit, manifestSha256,
        outcome: quarantine.witnessSha256 ? "quarantined-create-witnessed" : "quarantined-create", attemptRoot: fleet.root });
      return;
    }
    if (admittedGroup) return readAdmission(fleet, checkout, archives);
    const { manifest, manifestSha256 } = fleet, { round, commit } = manifest;
    const lock = reportBatch(fleet, processStart);
    if (lock === "busy" && manifest.single) { addPeer(fleet); return; }
    assert.notEqual(lock, "busy", "continuation source has an active batch");
    const launch = manifest.single && present(join(fleet.root, "launch-intent.json")) ? readLaunchIntent(fleet).sha256 : undefined;
    manifests.push({ ...fleet, lock, launch });
    const replay = inspect ? { inspect } : await measuredReplay(repo, measuredCheckout(root, checkout, commit), commit);
    const report = await verifyFleet({ root: fleet.root, round, commit }, { ...replay, interrupted, details: true, bindArchive: true,
      priorSelection: true, processStart, retainCheck: (check) => retainedLocks.push(check) });
    assert.ok(!report.error, report.error);
    assert.equal(report.manifestSha256, manifestSha256, "continuation manifest changed");
    for (const row of report.groups) {
      const { group } = row;
      const saved = readGroup(fleet, group);
      assert.equal(saved.stateSha256, row.stateSha256, "continuation state changed");
      if (failedExitOneScope(saved.state) && saved.state.archiveSha256 && !terminal(saved))
        assert.fail("unresolved custody: the bound Client Heavy attempt requires confirmed absence");
      if (failedExitOneCandidate(saved.local, saved.state))
        assert.equal(row.outcome, "native-failed-retired", "unresolved custody: failed exit one needs confirmed retirement");
      const setup = row.outcome === "uncollected" && setupCensus(fleet, saved, lock, launch);
      const noCreate = notCreated(fleet, saved, lock), outcome = noCreate ? "not-created" : setup ? setupCensusOutcome : row.outcome;
      if (manifest.single && (retryable({ ...row, outcome }) || outcome === "verified"))
        assert.ok(launch, "no original group launch intent");
      states.push({ fleet, group, stateSha256: saved.stateSha256, outcome: saved.outcome, noCreate,
        retirementFile: outcome === "create-errored" ? createErroredReceipt : outcome.endsWith("-retired") && retirementFile(outcome.slice(0, -8)) });
      const selected = manifest.selection.groups.find((s) => s.group === group);
      const verified = outcome === "verified";
      if (archives) {
        const pinned = Object.hasOwn(archives, group);
        assert.equal(verified, pinned, `retained ${group} must have a replayed archive pin`);
        if (pinned) assert.equal(row.archiveSha256, archives[group], `retained ${group} archive changed`);
      }
      if (row.id) claim(row.id);
      if (verified || manifest.single && ["failed", "blocked"].includes(outcome) && row.destroyedAt) {
        const { stateSha256, archiveSha256, evidenceSha256 } = row;
        (verified ? proofs : retryEvidence).push({ fleet, snapshot: { group, stateSha256, archiveSha256, evidenceSha256 } });
      }
      // A historic host can have preserved failure bytes behind an invalid
      // monitor, without deletion confirmation. A bound host cannot be created
      // again by its old controller. The new launch still has to prove that no
      // foreign benchmark host is present in that same account's create census.
      const censusRequired = !!setup || !!(archives && row.id && ["busy", "uncollected", "cleanup-pending"].includes(outcome)
        && saved.state.validation?.status !== "verified");
      if (censusRequired) needsCensus.add(manifest.provider.accountId);
      assert.ok(attempts.has(group) || censusRequired || acceptable(row), "unresolved custody for a historical group");
      attempts.get(group)?.push({ ...row, outcome, round, commit, manifestSha256, selection: selected, matchesCurrentContract: matchesCurrentContract(selected),
        ...(manifest.single ? { attemptRoot: fleet.root } : {}),
        ...(censusRequired ? { cleanupUnconfirmed: true } : {}),
        ...(row.archiveSha256 ? { archive: `${group}/groups-${round}/results.tgz` } : {}) });
    }
  };
  for (const [saved, entry] of indexed) {
    assert.ok(outside(root, saved) && outside(saved, root), "retained fleet root must be separate");
    full(entry.commit, /[a-f0-9]{40}/, "retained commit"); roundName(entry.round);
    assert.equal(Object.getPrototypeOf(entry.archives), Object.prototype, "archive pins required");
    const fleet = readFleet(saved, entry.round, { priorSelection: true });
    assert.equal(fleet.manifest.commit, entry.commit, "retained fleet source differs");
    assert.ok(!fleet.manifest.single, "independent attempts stay in their original continuation root");
    for (const [group, hash] of Object.entries(entry.archives)) {
      assert.ok(fleet.manifest.jobs.some((job) => job.group === group), "unknown retained group");
      full(hash, /[a-f0-9]{64}/, "retained archive pin");
    }
    await read(fleet, entry.checkout, entry.archives);
  }
  directories.sort((a, b) => Number(a.round?.slice(1) ?? 0) - Number(b.round?.slice(1) ?? 0));
  for (const { name, group, round } of directories) {
    const slot = join(root, name);
    physical(slot);
    const entries = readdirSync(slot);
    if (!entries.length) continue; // A settled placement refusal has not made a reservation.
    const files = entries.filter((name) => /^fleet-r[1-9]\d{0,8}\.json$/.test(name));
    assert.equal(files.length, 1, `ambiguous continuation slot: ${group}`);
    const fleet = readFleet(slot, files[0].slice(6, -5), { priorSelection: true });
    assert.equal(fleet.manifest.single?.group, group, "independent reservation required");
    assert.equal(fleet.manifest.single.indexSha256, indexSha256, "continuation index changed");
    const replacement = replacementQuarantine(quarantinedCreates, group, fleet.manifest.single.replacesQuarantineSha256);
    if (replacement) assert.ok(round && replacement.accountId === fleet.manifest.provider.accountId, "replacement requires the original continuation and provider account");
    if (round) {
      assert.equal(fleet.manifest.round, round, "attempt directory round differs");
      const previous = slots.get(group);
      const replacesUnlaunched = unlaunched.has(previous?.root) && previous.manifest.commit !== fleet.manifest.commit;
      const earlier = attempts.get(group).at(-1);
      const replacesLatest = replacement && replacement.root === previous?.root
        && ["quarantined-create", "quarantined-create-witnessed"].includes(earlier?.outcome);
      assert.ok(previous && Number(previous.manifest.round.slice(1)) < Number(round.slice(1))
        && (retryable(earlier) || replacesUnlaunched || replacesLatest), "earlier group attempt is not settled; never retry");
      assert.ok(replacement || quarantinedCreates.every((row) => row.group !== group), "the group's create quarantine must be pinned");
      requireSetupRetryCommit(attempts.get(group), fleet.manifest.commit);
    }
    slots.set(group, fleet);
    await read(fleet, fleet.manifest.single.checkout);
    const row = attempts.get(group).at(-1);
    if (row.outcome === "missing") row.outcome = present(join(slot, "launch-intent.json")) ? "attempt-consumed" : "prepared";
    if (row.outcome === "prepared" && manifestOnly(fleet, entries)) unlaunched.set(slot, fleet);
  }
  const rows = names.map((group) => {
    const history = attempts.get(group), verified = history.filter((row) => row.outcome === (admittedGroup ? "known-result" : "verified"));
    assert.ok(verified.length < 2, `duplicate verified group: ${group}`);
    const blocked = history.some(unresolved);
    const canRetry = !blocked && !verified.length && slots.has(group) && retryable(history.at(-1));
    return { group, outcome: blocked ? "blocked" : verified.length ? verified[0].outcome : slots.has(group) ? history.at(-1).outcome : "missing",
      ...(blocked ? { unresolved: true } : {}), ...(verified.length ? admittedGroup ? { knownResult: true } : { result: verified[0] } : {}),
      ...(canRetry ? { retryable: true } : {}), attempts: history };
  });
  const recheck = (operatingRoot, preparing = false) => {
    assert.ok(!interrupted?.());
    if (admittedGroup) recheckIndexedLaunchCustody(root, indexSha256, indexedCustody);
    else assert.equal(continuationIndexSha256(root), indexSha256, "continuation index changed");
    const prior = (entries) => preparing ? entries.filter((name) => name !== basename(operatingRoot)) : entries;
    assert.deepEqual(prior(members()), prior(paths), "continuation slots changed");
    for (const { fleet, proof } of peers) {
      const current = readFleet(fleet.root, fleet.manifest.round, { priorSelection: true });
      assert.deepEqual(continuationPeer(current).proof, proof, "continuation peer changed");
    }
    for (const { root, manifest, manifestSha256, lock, launch } of manifests) {
      const current = readFleet(root, manifest.round, { priorSelection: true });
      assert.equal(current.manifestSha256, manifestSha256);
      if (root !== operatingRoot) {
        if (admittedGroup) assert.equal(lockBytes(root), lock, "continuation source lock changed");
        else assert.ok(sameReportBatch(lock, reportBatch(current, processStart)), "continuation source lock changed");
        if (unlaunched.has(root)) assert.ok(manifestOnly(current), "unlaunched attempt changed");
      }
      if (admittedGroup)
        assert.equal(present(join(root, "launch-intent.json")) ? readLaunchIntent(current).sha256 : undefined, launch, "group launch intent changed");
      else if (launch) assert.equal(readLaunchIntent(current).sha256, launch, "group launch intent changed");
    }
    for (const { fleet, group, stateSha256, outcome, noCreate, retirementFile } of states) {
      const current = readGroup(fleet, group);
      assert.equal(current.stateSha256, stateSha256, "continuation state changed");
      assert.equal(current.outcome, outcome, "continuation custody changed");
      if (noCreate) assert.ok(notCreated(fleet, current, admittedGroup ? lockBytes(fleet.root) : reportBatch(fleet, processStart)),
        "no-create custody changed");
      // The same custody predicates as the scan: a lock that appeared since refuses.
      if (retirementFile === createErroredReceipt) assert.ok(createErrored(current), "continuation create failure custody changed");
      if (retirementFile === failedSetupRetirementFile) verifySetupRetry(current);
      else if (retirementFile) assert.equal(digest(regular(join(current.local, retirementFile),
        retirementFile === "failed-native-host.json" ? undefined : retirementFile === createErroredReceipt ? 64 * 1024 : 4096)),
        receiptSha256(current.state, retirementFile), "continuation retirement changed");
    }
    for (const { fleet, snapshot } of proofs) recheckCollectedGroup(fleet, snapshot);
    for (const { fleet, snapshot } of retryEvidence) recheckCollectedGroup(fleet, snapshot);
    for (const check of retainedLocks) check();
  };
  const recheckUnlaunched = (group) => {
    for (const fleet of unlaunched.values()) if (fleet.manifest.single.group === group) {
      const current = readFleet(fleet.root, fleet.manifest.round, { priorSelection: true });
      assert.ok(current.manifestSha256 === fleet.manifestSha256 && manifestOnly(current), "unlaunched attempt changed");
    }
  };
  recheck();
  for (const { fleet } of peers) needsCensus.add(fleet.manifest.provider.accountId);
  if (admittedGroup) return { root, indexSha256, slots, unlaunched, needsCensus, recheck, rows,
    subject: { indexSha256, indexedCustody, verified: [], // Launch compatibility field: no publication proofs travel through admission.
      priorAttempts: attempts.get(admittedGroup).filter((row) => retryable(row)).map(({ round, commit, manifestSha256, stateSha256, launch }) =>
        ({ round, commit, manifestSha256, stateSha256, launch })),
      ...(unconfirmed.length ? { unconfirmed } : {}),
      ...(createFailures.length ? { createFailures } : {}),
      ...(postedCreates.length ? { postedCreates } : {}),
      ...(quarantinedCreates.length ? { quarantinedCreates } : {}),
      ...(setupRetirements.length ? { setupRetirements } : {}),
      ...(exitOneRetirements.length ? { exitOneRetirements } : {}),
      ...(peers.length ? { peers: peers.map(({ proof }) => proof) } : {}) } };
  const subject = { indexSha256, verified: proofs.map(({ fleet, snapshot }) => ({ root: fleet.root, round: fleet.manifest.round,
    manifestSha256: fleet.manifestSha256, ...snapshot })),
  ...(peers.length ? { peers: peers.map(({ proof }) => proof) } : {}) };
  const eligibleToRun = rows.some((row) => row.unresolved) ? []
    : rows.filter((row) => ["missing", "prepared"].includes(row.outcome) || row.retryable).map((row) => row.group);
  return { root, indexSha256, slots, unlaunched, needsCensus, recheck, recheckUnlaunched, subject,
    report: { status: rows.every((row) => row.outcome === "verified") ? "complete" : "incomplete",
      evidenceMode: inspect ? "synthetic-inspection" : "native-replay", comparisonScope: "within-group-host-only",
      publishableBaseline: false, eligibleToRun, groups: rows } };
}

export async function continuationCli(args, { write = console.log, repo = resolve(import.meta.dirname, "../..") } = {}) {
  try {
    assert.equal(args.length, 2); assert.equal(args[0], "--continuation-root");
    const { report } = await inspectContinuation(args[1], { repo });
    write(JSON.stringify(report)); return report.status === "complete" ? 0 : 1;
  } catch { write(JSON.stringify({ status: "incomplete", error: "continuation-evidence-invalid", publishableBaseline: false })); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  continuationCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
