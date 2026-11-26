// Retirement evidence is separate from benchmark qualification. No operations on import.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest, evidenceEnvelope, evidenceFileIdentity, fileHash, physical, pinEvidenceTree, regular, treeHash, verifiedEvidenceTree } from "./cloud-local.mjs";
import { bootstrapMarker, remoteFiles } from "./cloud-remote.mjs";
import { bootstrapWorkspaceScript, portableEvidenceSegment, preloginUserData, savedLoadLayout, savedPlacement, stagedFleet } from "./cloud-contract.mjs";
import { sealedMonitor, settledMonitor } from "./cloud-control-stream.mjs";
import { quote } from "./cloud-transport.mjs";
import { acknowledgedBootstrapSeal, guardianSha256, guardianSource } from "./cloud-control-runtime.mjs";
import { verifyControlSetupQuery } from "./cloud-control-session.mjs";
import { verifyControlWatcher } from "./isolated/control-admission.mjs";
import setupDrainSource from "./cloud-setup-drain-source.mjs";
import { verifyStreamDrain, verifyStreamSeal } from "./isolated/control-stream.mjs";
import { hostObservationBytes, processIdentity, processRecordKey } from "./isolated/host-observation.mjs";
import { campaignRounds, jsonPreparationRound, nativeArtifactRoot } from "./registry.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { cancellationState, mixedDigest, mixedWait, originalMixedControls, ownedMixedWait, verifyMixedCancellation, verifyMixedSignal } from "./cloud-cancellation.mjs";

// A provider-errored create: one accepted POST whose exact action ended errored and
// whose droplet was proved absent on the saved account. Never a host or a deletion.
export const createErroredReceipt = "provider-create-errored.json";
export const createRecheckLock = "create-recheck.lock";
export const createErroredBytes = (record) => `${JSON.stringify(record, null, 2)}\n`;
export function createErroredRecord(s, { dropletId, actionId }, droplets, observedAt) {
  return { schema: "benchmark-provider-create-errored/v1", round: s.round, commit: s.commit, ...(s.group === undefined ? {} : { group: s.group }),
    name: s.name, tag: s.tag, host: s.host, createIntentAt: s.createIntentAt,
    action: { id: Number(actionId), type: "create", resourceType: "droplet", resourceId: Number(dropletId), status: "errored" },
    account: { id: s.provider.accountId, verified: "before-and-after-each-provider-call" },
    absence: { exactGet: { id: Number(dropletId), httpStatus: 404 },
      inventory: { complete: true, droplets, matchingId: 0, matchingName: 0, matchingTag: 0 } },
    observedAt, dispatched: { create: 1, replacementCreate: 0, delete: 0, guest: false }, measurements: 0 };
}
// Rebuild the receipt from the saved state; only the census size and time come from the file.
// A recorded reappearance of the posted droplet contradicts the receipt for good.
export const createReappeared = "provider-errored create contradicted: its posted droplet was observed again on the saved account;"
  + " this attempt never resolves or admits a retry; collect binds only that exact posted droplet under its saved name, tags, region"
  + " and one public IPv4, then retire it by --collect --unused-bootstrap-known-hosts; otherwise account for it with the provider and preserve reservation";
// A contradiction is made durable before its state publication: this witness first,
// then the state through its own create-reappeared stage. Either one left behind (a
// failed or interrupted publication) contradicts the receipt exactly as a published
// reappearance does, so no later collect, launch, fleet check or successor accepts it.
export const createReappearedWitness = "provider-create-reappeared";
const reappearedStage = /^state\.json\.create-reappeared-[a-f0-9]{32}\.tmp$/;
// The stages a failed contradiction publication left, by name (never read here).
export const contradictionStages = (local) => readdirSync(local).filter((name) => reappearedStage.test(name)).sort();
// The stages an interrupted createErrored publication left (written before its rename), by name.
// They claim absence; beside a contradiction the bind checks their bytes and records them.
const erroredStage = /^state\.json\.create-errored-[a-f0-9]{32}\.tmp$/;
export const publicationStages = (local) => readdirSync(local).filter((name) => erroredStage.test(name)).sort();
export function createContradiction(local) {
  return !!lstatSync(join(local, createReappearedWitness), { throwIfNoEntry: false })
    || readdirSync(local).some((name) => reappearedStage.test(name));
}
export function verifyCreateErrored(local, s) {
  assert.ok(s.createErrored, "no provider-errored create record");
  assert.ok(!s.createErrored.reappeared && !createContradiction(local), createReappeared);
  const bytes = regular(join(local, createErroredReceipt), 64 * 1024), record = JSON.parse(bytes);
  assert.equal(digest(bytes), s.createErrored.evidenceSha256, "create failure receipt changed; preserve reservation");
  assert.ok(Number.isSafeInteger(record.absence?.inventory?.droplets) && record.absence.inventory.droplets >= 0
    && typeof record.observedAt === "string" && new Date(record.observedAt).toISOString() === record.observedAt, "create failure receipt changed; preserve reservation");
  assert.deepEqual(record, createErroredRecord(s, s.createErrored, record.absence.inventory.droplets, record.observedAt),
    "create failure receipt changed; preserve reservation");
  return true;
}
// A resolved provider-errored create leaves no custody behind: no launch or operation
// lock, and no recheck lock (no controller writes one now; a stray one still refuses).
// Any of them is unresolved until the operator's custody step accounts for its owner.
export function createErroredCustody(local) {
  for (const path of [join(dirname(local), ".groups-launch.lock"), join(local, "operation.lock"), join(local, createRecheckLock)])
    assert.ok(!lstatSync(path, { throwIfNoEntry: false }),
      "provider-errored create still holds custody; account for the lock's owner by the custody step; preserve reservation");
  return true;
}
// A receipt written before its state publication (a crash between the two) is
// adopted only if its bytes are exactly the canonical record for this saved state.
export function pendingCreateErroredReceipt(bytes, s, posted) {
  const record = JSON.parse(bytes);
  assert.ok(Number.isSafeInteger(record?.absence?.inventory?.droplets) && record.absence.inventory.droplets >= 0
    && typeof record.observedAt === "string" && new Date(record.observedAt).toISOString() === record.observedAt, "unpublished create failure receipt differs; preserve reservation");
  assert.ok(Buffer.from(createErroredBytes(createErroredRecord(s, posted, record.absence.inventory.droplets, record.observedAt))).equals(bytes),
    "unpublished create failure receipt differs; preserve reservation");
  return bytes;
}

// This migration is not a general old-source collection or validation override.
export const failedNativeCommit = "9f3d35884c67d90524f978d173fabeb3a17bc970";
const failedNativeCases = [
  { identity: { commit: failedNativeCommit, round: "r21" }, policy: "r21-9f-failed-native-custody-only-no-qualification" },
  { identity: { commit: "dbe1a34c753ee8ef4ac9927484dc3930d36f6e37", round: "r21", group: "catalog-page",
    id: "620052965", token: "39fa09440f45df00", name: "corten-bench-groups-r21-39fa09440f45df00",
    tag: "corten-bench-groups-run-39fa09440f45df00", unit: "corten-bench-groups-r21-39fa09440f45df00.service" },
    policy: "r21-dbe-exact-catalog-attempt-custody-only-no-qualification" },
  { identity: { commit: "2a4ceb043747b92c753becc2bbcc5def655fc53d", round: "r21", group: "catalog-page",
    id: "620157651", token: "e38164eb06fc2043", name: "corten-bench-groups-r21-e38164eb06fc2043",
    tag: "corten-bench-groups-run-e38164eb06fc2043", unit: "corten-bench-groups-r21-e38164eb06fc2043.service" },
    policy: "r21-2a-exact-lean-catalog-custody-only-no-qualification" },
];
// Eligibility only; original custody, current terminal proof and exact approval still apply.
export function failedNativePolicy(state) {
  const found = failedNativeCases.find(({ identity }) => Object.entries(identity).every(([key, value]) => state[key] === value));
  assert.ok(found, "unsupported failed-native migration identity");
  return found.policy;
}
export function failedNativeRoots(state) {
  failedNativePolicy(state);
  if (state.group === "mixed-production") {
    ownedMixedWait(state); cancellationState(state.mixedCancellation);
    return ["/bench/campaign", "/bench/repo/bench/mixed-production/results/w21", "/bench/mixed-cancel-intent.json"];
  }
  const roots = { "catalog-page": ["bench/catalog/results/c21"], "json-api": ["bench/json-api/results/j42", "bench/json-api/results/j43"],
    "localized-marketplace": ["bench/marketplace/results/r21"], "fullstack-browser": ["bench/fullstack-browser/work/w21"],
    "client-heavy": ["bench/client-heavy/work/w21"], "live-delivery": ["bench/live/results/parity/r21"],
    "recoverable-live": ["bench/recoverable-live/results/r21"], hardening: ["bench/hardening/results/w21"] };
  assert.ok(Object.hasOwn(roots, state.group), "unsupported failed-native group");
  return ["/bench/campaign", ...roots[state.group].map((path) => `/bench/repo/${path}`)];
}
export function mixedIntentRoot(path, root) {
  assert.equal(root.path, "/bench/mixed-cancel-intent.json"); assert.equal(root.present, true);
  const bytes = regular(path, 4096);
  assert.equal(root.nodes, 1); assert.equal(root.bytes, bytes.length);
  assert.equal(root.treeSha256, digest(Buffer.concat([Buffer.from(`f\0\0${bytes.length}\0`), bytes])), "framed cancellation intent root changed");
  return JSON.parse(bytes);
}
// The caller authenticates the original plan and subject first. Hash the saved
// payloads, not a rebuilt Git context or an executable native validator.
function mixedCancelledCustody(directory, subject, binding) {
  const { sourcesManifest: manifest } = subject, { sha256, ...body } = manifest;
  assert.equal(mixedDigest(body), sha256, "mixed source manifest changed");
  const { entries } = manifest.snapshot;
  assert.ok(Array.isArray(entries) && entries.length <= evidenceEnvelope.nodes, "mixed source snapshot bound");
  assert.equal(mixedDigest(entries), manifest.snapshot.sha256, "mixed source snapshot changed");
  physical(directory);
  assert.ok(isDeepStrictEqual(readdirSync(directory).sort(), ["blobs", "contexts"]), "mixed source root differs");
  const saved = new Map(); let total = 0;
  for (const entry of entries) {
    assert.ok(!saved.has(entry.path), "duplicate mixed source snapshot path"); saved.set(entry.path, entry);
    if (entry.type === "directory") {
      assert.ok(["", "blobs", "contexts"].includes(entry.path), "unknown mixed source directory");
      physical(entry.path ? join(directory, entry.path) : directory);
    } else {
      assert.equal(entry.type, "file");
      assert.match(entry.path, /^(?:blobs\/[a-f0-9]{64}|contexts\/[a-z][a-z0-9-]*\.tar)$/);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= evidenceEnvelope.memberBytes, "mixed source file bound");
      total += entry.bytes; assert.ok(total <= evidenceEnvelope.content, "mixed source content bound");
      const path = join(directory, entry.path);
      assert.equal(lstatSync(path).size, entry.bytes, "mixed source file size changed");
      assert.equal(fileHash(path, entry.bytes), entry.sha256, "mixed source payload changed");
    }
  }
  for (const name of ["", "blobs", "contexts"]) assert.equal(saved.get(name)?.type, "directory", "missing mixed source directory");
  for (const name of ["blobs", "contexts"]) {
    const names = entries.filter((e) => e.type === "file" && e.path.startsWith(`${name}/`)).map((e) => e.path.slice(name.length + 1)).sort();
    assert.ok(isDeepStrictEqual(readdirSync(join(directory, name)).sort(), names), "mixed source inventory differs");
  }
  const blobs = new Set();
  for (const file of manifest.files) {
    assert.equal(file.storedAs, `blobs/${file.sha256}`);
    const entry = saved.get(file.storedAs); assert.equal(entry?.type, "file", "mixed source blob missing from snapshot");
    assert.equal(entry.sha256, file.sha256); assert.equal(entry.bytes, file.bytes); blobs.add(file.storedAs);
  }
  assert.equal(blobs.size, entries.filter((e) => e.path.startsWith("blobs/")).length, "unreferenced mixed source blob");
  assert.ok(isDeepStrictEqual(subject.requests.map((r) => r.identity.app), binding.selection.apps), "mixed context contenders differ");
  assert.equal(subject.bindingSha256, mixedDigest(binding), "mixed subject binding differs");
  for (const request of subject.requests) {
    const entry = saved.get(`contexts/${request.identity.app}.tar`);
    assert.equal(entry?.type, "file", "mixed build context missing from snapshot");
    assert.equal(entry.sha256, request.identity.contextArchiveSha256, "mixed build context differs");
  }
  assert.equal(subject.requests.length, entries.filter((e) => e.path.startsWith("contexts/")).length, "unreferenced mixed build context");
}
export const groupedFailureCandidate = (state) => (stagedFleet(state.fleet) || state.fleet?.schema === "benchmark-group-fleet/v4")
  && ["closed", "invalid"].includes(state.control?.monitor?.phase);

export function launchHostKey(local, state) {
  assert.match(state.launchHostKeySha256 ?? "", /^[a-f0-9]{64}$/, "no launch-established host key; preserve host");
  const key = regular(join(local, "known_hosts"), 1024 * 1024);
  assert.ok(key.length && digest(key) === state.launchHostKeySha256, "saved host key differs from launch");
  return key;
}

export function readRetainedInvalidLocks(local, state, read = regular) {
  const lock = JSON.parse(read(join(local, "operation.lock"), 1024)), { pid } = lock;
  assert.deepEqual(Object.keys(lock).sort(), ["at", "pid"], "not an original operation lock");
  assert.equal(new Date(lock.at).toISOString(), lock.at, "invalid original operation lock time");
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "invalid original operation lock");
  assert.deepEqual(JSON.parse(read(join(dirname(local), ".groups-launch.lock"), 1024)),
    { pid, round: state.round }, "retained launch lock differs");
  return lock;
}

export function retainedInvalidOwner(local, state) {
  // A reused PID is still busy for any operation with paid authority.
  const { pid } = readRetainedInvalidLocks(local, state);
  try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return false; }
  return true;
}

export function groupedFailure(local, state) {
  return groupedFailureEvidence(local, state, () => assert.ok(!retainedInvalidOwner(local, state), "original monitor owner is still live or uncertain"));
}

function groupedFailureEvidence(local, state, settledOwner) {
  assert.ok(groupedFailureCandidate(state), "official dedicated reservation required");
  launchHostKey(local, state);
  const { registration, terminal } = state.control?.monitor?.phase === "closed" ? sealedMonitor(local, state) : settledMonitor(local, state);
  assert.equal(state.control.ledger.findLast(r => r.request.epoch === "bootstrap")?.code, 0, "bootstrap seal was not acknowledged");
  assert.equal(registration.host.hostname, state.name, "registered host differs");
  if (terminal.kind === "invalid") {
    assert.ok(terminal.publicationRevoked === true && terminal.remoteTerminal === false, "invalid monitor publication not revoked");
    settledOwner();
  }
  const round = campaignRounds(state.round)[state.group];
  assert.ok(round, "unknown reserved group");
  const phases = { ...(state.group === "json-api" ? { prepare: nativeArtifactRoot(state.group, jsonPreparationRound(state.round)) } : {}),
    timing: nativeArtifactRoot(state.group, round) };
  return { registration, terminal, round, phases, host: { bootId: registration.host.bootId, name: state.name,
    knownHostsSha256: state.launchHostKeySha256 },
    roots: ["/bench/campaign", ...Object.values(phases).map(path => `/bench/repo/${path}`)] };
}

function preplanGroup(local, state, readGrouped = groupedFailure) {
  const grouped = readGrouped(local, state);
  assert.ok(stagedFleet(state.fleet) && state.fleet.single?.group === state.group, "staged single-group reservation required");
  assert.equal(grouped.terminal.kind, "invalid", "an archived campaign is required for a sealed result");
  return { ...grouped, preplan: true };
}

function originalFailedWrapper(local, state, verifyTree = verifyEvidenceTree, exit = 2) {
  assert.equal(fileHash(join(local, "results.tgz")), state.archiveSha256, "original failed archive changed");
  const extracted = join(local, state.evidence); physical(extracted);
  const subtrees = verifyTree(extracted, state.evidenceSha256, "original failed extraction changed");
  assert.ok(regular(join(extracted, "exit-code"), 16).equals(Buffer.from(`${exit}\n`)), "custody requires the saved failure exit, not a successful report");
  const folder = join(extracted, "campaign"); physical(folder);
  return { extracted, folder, subtrees };
}

function verifyNativeEntryLog(extracted, state, exit) {
  const job = remoteFiles(state)["job.sh"].split("\n");
  const stage = job.lastIndexOf("bootstrap_stage=native-entry");
  assert.ok(stage >= 0 && job[stage + 1]?.startsWith("node 'bench/workloads/isolated/campaign-entry.mjs' "), "native-entry source differs");
  const line = Buffer.from(`benchmark job failed: stage=native-entry line=${stage + 2} exit=${exit}\n`);
  const log = regular(join(extracted, "run.log"));
  const start = log.length - line.length;
  assert.ok(start >= 0 && (start === 0 || log[start - 1] === 10) && log.subarray(start).equals(line), "source-bound final native-entry failure required");
}

function verifyPreplanArchive({ extracted, folder }, state) {
  const dir = opendirSync(folder);
  try { assert.ok(dir.readSync() === null, "preplan failure requires an empty archived campaign"); }
  finally { dir.closeSync(); }
  verifyNativeEntryLog(extracted, state, 2);
}

export function groupedPreplanFailure(local, state) {
  const grouped = preplanGroup(local, state);
  verifyPreplanArchive(originalFailedWrapper(local, state), state);
  return grouped;
}

export const handoffRetirementPolicy = "grouped-handoff-failure-existing-custody-only";
export const failedExitOnePolicy = "r78-client-heavy-sealed-exit-one-retirement-only";
export const failedExitOneScope = (s) => s?.round === "r78" && s.commit === "7c13920f87b6baa6c7f967027d2eff9358201e4c"
  && s.group === "client-heavy" && stagedFleet(s.fleet) && s.fleet.single?.group === s.group && !s.fleet.single.offlineHandoff
  && s.control?.monitor?.phase === "closed";
export const failedExitOneCandidate = (local, s) => failedExitOneScope(s) && s.evidence !== undefined
  && regular(join(local, s.evidence, "exit-code"), 16).equals(Buffer.from("1\n"));

function verifyExitOneManifest(directory, entries) {
  let index = 0;
  function visit(file, path) {
    const stat = lstatSync(file);
    const record = stat.isDirectory() ? { path, type: "directory" }
      : { path, type: "file", bytes: stat.size, sha256: fileHash(file, stat.size) };
    assert.ok(isDeepStrictEqual(entries[index++], record), "archived collection member differs");
    if (stat.isDirectory()) {
      physical(file);
      for (const name of readdirSync(file).sort()) {
        if (!path && name === "collection-manifest.json") continue;
        visit(join(file, name), path ? `${path}/${name}` : name);
      }
    }
  }
  visit(directory, "");
  assert.equal(index, entries.length, "archived collection inventory differs");
}

// Replay only command identity, membership and terminal emptiness. Do not
// interpret participant executables, renderer proof or resource counters.
function exitOneLifetime(directory, state, grouped, campaign, binding, pid, command) {
  try {
    const read = name => JSON.parse(regular(join(directory, name), 1024 * 1024));
    const context = read("binding.json"), terminal = read("terminal.json");
    assert.ok(context.schema === "benchmark-isolated-host-lifetime/v1" && context.campaign === campaign
      && context.command === 0 && context.group === state.group && context.round === binding.request.round
      && context.commit === state.commit && context.bindingSha256 === deploymentSha256(binding)
      && isDeepStrictEqual(context.invocation, binding.execution.invocation) && context.leaderPid === pid);
    const { bootId, parent, path, leaderIdentity } = context;
    assert.ok(bootId === grouped.registration.host.bootId && terminal.bootId === bootId
      && (!terminal.terminalClock || terminal.terminalClock.bootId === bootId));
    assert.ok(posix.isAbsolute(parent) && posix.normalize(parent) === parent && posix.basename(parent) === state.unit
      && typeof path === "string" && path.startsWith(parent + "/") && /^native-0-[a-f0-9]{16}$/.test(path.slice(parent.length + 1)));
    assert.ok(leaderIdentity?.pid === pid && typeof leaderIdentity.startTicks === "string" && /^\d+$/.test(leaderIdentity.startTicks));
    const ancestors = [];
    for (let p = parent; ; p = posix.dirname(p)) { ancestors.push(p); if (p === "/") break; }
    for (const row of [context, terminal]) assert.ok(isDeepStrictEqual(row.ancestors.map(a => a.path), ancestors));
    assert.ok(terminal.terminal === true && terminal.attached === true && terminal.empty === true);
    for (const key of ["terminal", "code", "signal", "success", "cancelled", "forced", "error"])
      assert.ok(terminal.command[key] === command[key]);

    const samples = regular(join(directory, "samples.jsonl")), records = new Map();
    assert.ok(samples.at(-1) === 10 && Number.isSafeInteger(terminal.samples) && terminal.samples >= 3);
    // The writer's lifetime budget counts samples and each process record once.
    let remaining = hostObservationBytes - samples.length;
    function processRecord(key) {
      assert.ok(typeof key === "string" && key.length === 64 && /^[a-f0-9]{64}$/.test(key));
      if (!records.has(key)) {
        const bytes = regular(join(directory, "processes", key + ".json"), Math.min(1024 * 1024, remaining));
        remaining -= bytes.length;
        const record = JSON.parse(bytes);
        assert.ok(processRecordKey(record) === key);
        const { stat, cgroup } = record;
        const { pid, startTicks } = processIdentity(stat);
        assert.ok(Number.isSafeInteger(pid) && pid > 0 && typeof cgroup === "string");
        records.set(key, { pid, startTicks, cgroup });
      }
      return records.get(key);
    }
    let observed = false, last = -1, count = 0;
    for (let start = 0; start < samples.length;) {
      const end = samples.indexOf(10, start);
      assert.ok(++count <= terminal.samples);
      const { at, groups, processes } = JSON.parse(samples.subarray(start, end));
      start = end + 1;
      assert.ok(Number.isSafeInteger(at) && at >= last && Array.isArray(groups) && Array.isArray(processes));
      last = at;
      const boundary = count === 1 || start === samples.length, paths = new Set(), members = new Map();
      if (boundary) assert.ok(processes.length === 0);
      for (const group of groups) {
        const name = group.path, files = group.files;
        assert.ok(typeof name === "string" && (name === path || name.startsWith(path + "/"))
          && posix.normalize(name) === name && !paths.has(name));
        paths.add(name);
        const pids = files["cgroup.procs"].trim().split("\n").filter(Boolean);
        if (boundary) assert.ok(!pids.length
          && files["cgroup.events"].split("\n").filter(row => row.startsWith("populated ")).join("\n") === "populated 0");
        for (const value of pids) {
          const member = Number(value);
          assert.ok(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(member) && !members.has(member));
          members.set(member, name);
        }
      }
      assert.ok(paths.has(path));
      for (const key of processes) {
        const process = processRecord(key), member = members.get(process.pid);
        assert.ok(member !== undefined && (process.cgroup === `0::${member}\n` || process.cgroup === `0::${member}`));
        members.delete(process.pid);
        if (process.pid === pid) {
          assert.equal(process.startTicks, leaderIdentity.startTicks);
          observed ||= member === path;
        }
      }
      assert.ok(members.size === 0);
    }
    assert.ok(count === terminal.samples && observed);
  } catch {
    throw new Error("sealed command lifetime identity or terminal membership differs");
  }
}

const exitOnePhase = "00-client-heavy-timing";

function exitOneCampaign(state, grouped, { extracted, folder, subtrees }, campaign, plan, result) {
  verifyNativeEntryLog(extracted, state, 1);
  const { status } = result, dir = join(folder, campaign);
  assert.equal(status.state, "finished");
  assert.equal(status.nextGroup, null);
  assert.deepEqual(status.uncollectedNativeRoots, [], "failed exit has pending native output");
  assert.equal(status.outcomes[0].outcome, "failed", "only an intrinsically failed group may retire as exit one");
  const read = (name) => regular(join(dir, name)), seal = JSON.parse(read("control-stream-seal.json"));
  assert.deepEqual(seal.registration, grouped.registration, "archived stream registration differs");
  verifyStreamSeal(grouped.registration.binding, seal);
  const drain = JSON.parse(read("control-stream-drain.json"));
  verifyStreamDrain(grouped.registration.binding, grouped.registration, drain);
  assert.ok(BigInt(drain.monoNs) >= BigInt(seal.sealedMonoNs), "stream drain predates seal");
  const collection = JSON.parse(read("collection-manifest.json"));
  assert.deepEqual(collection.status, status, "terminal collection status differs");
  assert.equal(collection.wholeHostTerminal, "parent-must-observe");
  assert.equal(collection.deletionAuthorized, false);
  const { entries, sha256 } = collection.manifest;
  assert.ok(Array.isArray(entries) && entries.length <= evidenceEnvelope.nodes && deploymentSha256(entries) === sha256,
    "archived collection manifest differs");
  verifyExitOneManifest(dir, entries);
  const phase = exitOnePhase;
  const subtree = (root) => entries.filter(({ path }) => path === root || path.startsWith(root + "/"))
    .map(({ path, ...record }) => ({ path: path.slice(root.length + 1), ...record }));
  const native = `${phase}/native`, nativeManifest = JSON.parse(read(`${phase}/native-manifest.json`));
  const nativeEntries = subtree(native);
  assert.ok(isDeepStrictEqual(nativeEntries, nativeManifest.entries) && deploymentSha256(nativeEntries) === nativeManifest.sha256
    && nativeManifest.sha256 === status.outcomes[0].nativeManifestSha256, "archived native manifest differs");
  // r78 has one supervised Client Heavy invocation. Replay its lifecycle,
  // not its renderer proof or other native qualification evidence.
  try {
    const kinds = ["authorized", "control-admitted", "started", "native-output-reserved", "command-intent", "command-started",
      "command-exited", "phase-sealed", "group-finished", "stream-sealed", "finished"];
    const names = kinds.map((kind, sequence) => `${String(sequence).padStart(5, "0")}-${kind}.json`);
    assert.deepEqual(entries.filter(({ path }) => /^\d{5}-[a-z-]+\.json$/.test(path)).map(({ path }) => path), names);
    const phaseBinding = { group: state.group, phase: "timing", artifactRoot: grouped.phases.timing };
    const events = names.map((name, sequence) => {
      const event = JSON.parse(regular(join(dir, name), 1024 * 1024));
      assert.equal(event.schema, "benchmark-isolated-campaign-event/v1");
      assert.equal(event.kind, kinds[sequence]); assert.equal(event.sequence, sequence);
      assert.equal(event.campaign, campaign); assert.equal(event.round, state.round); assert.equal(event.campaignSha256, plan.campaignSha256);
      const embedded = sequence === 10 ? status : { ...status, state: "active",
        nextGroup: sequence < 8 ? state.group : null, outcomes: sequence < 8 ? [] : status.outcomes,
        uncollectedNativeRoots: sequence >= 3 && sequence <= 7 ? [phaseBinding] : [] };
      assert.deepEqual(event.status, embedded, "embedded status differs");
      return event;
    });
    const [, admission, , reserved, intent, started, command, sealed, finishedGroup, stream] = events;
    const { preparation, execution } = plan.bindings[0];
    assert.deepEqual(preparation.fixtures, [], "only the timed invocation was reserved");
    const invocation = execution.invocation;
    assert.ok(invocation.executable === "node" && Array.isArray(invocation.argv) && invocation.argv.length > 0
      && invocation.cwd === "repository-root" && invocation.shell === false, "timed invocation missing");
    assert.deepEqual(intent.invocation, invocation);
    assert.equal(intent.group, state.group);
    assert.ok(Number.isSafeInteger(started.pid) && started.pid > 0);
    assert.ok(command.terminal === true && command.cancelled === false && command.forced === false
      && Number.isInteger(command.code) && command.code >= 0 && command.code <= 255
      && command.signal === null && command.error === null, "normal observed command exit required");
    assert.equal(command.success, command.code === 0, "command success contradicts exit code");
    for (const event of [reserved, sealed]) {
      for (const [key, value] of Object.entries(phaseBinding)) assert.equal(event[key], value);
      assert.equal(event.transferDestination, undefined);
    }
    assert.equal(sealed.nativeManifestSha256, nativeManifest.sha256);
    assert.equal(sealed.phaseManifestSha256, deploymentSha256(subtree(phase)));
    for (const [key, value] of Object.entries(status.outcomes[0])) assert.deepEqual(finishedGroup[key], value);
    assert.ok(entries.some(({ path, type }) => path === phase + "/command-0.log" && type === "file"), "command log missing");
    const hostRoot = phase + "/command-0-host", host = subtree(hostRoot);
    assert.ok(host.length > 1 && command.hostManifestSha256 === deploymentSha256(host), "command observations differ from journal");
    exitOneLifetime(join(dir, hostRoot), state, grouped, campaign, plan.bindings[0], started.pid, command);
    assert.equal(stream.path, "control-stream-seal.json");
    assert.equal(stream.sha256, grouped.terminal.sealSha256);
    assert.deepEqual(stream.binding, grouped.registration.binding);
    assert.equal(admission.epoch, "bootstrap");
    assert.equal(admission.path, "control-bootstrap.json");
    assert.deepEqual(admission.binding, grouped.registration.binding);
    const bootstrap = read("control-bootstrap.json");
    assert.equal(digest(bootstrap), admission.sha256);
    assert.deepEqual(JSON.parse(bootstrap).apparatus, grouped.registration);
  } catch (cause) {
    throw new Error("exit-one command journal is missing or contradictory", { cause });
  }
  assert.deepEqual(readdirSync(extracted).sort(), ["campaign", "control", "exit-code", "host.txt", "run.log"],
    "unexpected original archive root");
  const archivedNative = subtrees[`campaign/${campaign}/${native}`];
  const empty = archivedNative === digest("d\0\0");
  return { campaign: subtrees.campaign, native: archivedNative, empty,
    control: subtrees.control,
    wrapper: { runLog: fileHash(join(extracted, "run.log")), host: fileHash(join(extracted, "host.txt")) } };
}

export function verifyFailedExitOneCustody(local, state, { pin = false } = {}) {
  assert.ok(failedExitOneScope(state), "only the source-bound monitored Client Heavy attempt can use exit-one retirement");
  assert.equal(state.control.helperSha256, guardianSha256, "original control source changed");
  assert.deepEqual(state.control.sealed, ["bootstrap"], "collection epoch is foreclosed");
  assert.ok(acknowledgedBootstrapSeal(state.control.ledger.filter(({ request }) => request.epoch === "bootstrap")),
    "original bootstrap seal was not acknowledged");
  assert.ok(state.bootstrapReady && state.id && state.ip && state.createIntentAt && state.fullGroupQualified === false
    && ["collectedAt", "validation", "evidenceOutcome", "exitCode", "preBootstrapTerminal", "mixedCancellation",
      "auditIntent", "auditIntents", "createErrored", "createContradicted"].every(key => state[key] === undefined),
  "only an unqualified bound failed campaign may retire");
  assert.ok(state.status === "running" && !state.deletionIntentAt && !state.retirement && !state.destroyedAt
    || state.status === "retired" && state.retirement?.kind === "native-failed" && state.deletionIntentAt, "exit-one retirement state differs");
  const publications = (authored) => {
    handoffPublications(local);
    assert.ok(!readdirSync(local).some(name => /^failed-native-(?:results|capture)|^custody-/.test(name)), "unaccounted failed native custody");
    if (!authored && state.status !== "retired")
      for (const name of ["failed-native-reservation.json", "failed-native-host.json"])
        assert.ok(!lstatSync(join(local, name), { throwIfNoEntry: false }), "prior exit-one retirement publication requires inspection");
  };
  publications();
  const fleetRoot = dirname(dirname(local)), launch = join(fleetRoot, "launch-intent.json"), fleet = join(fleetRoot, `fleet-${state.round}.json`);
  const files = [launch, fleet, ...["known_hosts", "results.tgz", "monitor-registration.json", "monitor-local-closed.json", "monitor-terminal.json"]
    .map(name => join(local, name))];
  const inputs = files.map(path => [path, evidenceFileIdentity(path)]);
  const grouped = { ...groupedFailure(local, state), exitOne: true };
  assert.deepEqual(grouped.roots, ["/bench/campaign", `/bench/repo/${grouped.phases.timing}`]);
  grouped.roots.push("/bench/control");
  let tree;
  const paths = ["campaign", `campaign/${grouped.terminal.campaign}/${exitOnePhase}/native`, "control"];
  const inspected = failedNativeArchiveEvidence(local, state, grouped, groupedFailure, (...args) => {
    tree = verifiedEvidenceTree(...args, paths);
    return tree.hashes;
  });
  tree.unchanged();
  const launchIntentSha256 = fileHash(launch, 1024 * 1024), fleetManifestSha256 = fileHash(fleet, 1024 * 1024);
  const assertCustody = (includeTree = true, authored = false) => {
    if (includeTree && pin) tree.unchanged();
    publications(authored);
    for (const [path, before] of inputs)
      assert.ok(evidenceFileIdentity(path) === before, "local exit-one custody changed");
  };
  assertCustody(false);
  return { grouped, hashes: inspected.exitOneHashes, launchIntentSha256, fleetManifestSha256, assertCustody };
}
export function handoffLocks(local, holdingOperationLock = false, continuation = false) {
  const base = dirname(local), fleet = dirname(base);
  const paths = [join(local, "stream-recovery.lock"), join(local, "audit-delivery.lock"), join(local, createRecheckLock),
    join(base, ".groups-launch.lock"), join(fleet, ".fleet-operation.lock")];
  if (!continuation) paths.push(join(dirname(fleet), ".continuation-operation.lock"));
  if (!holdingOperationLock) paths.push(join(local, "operation.lock"));
  assert.ok(paths.every(path => !lstatSync(path, { throwIfNoEntry: false })), "handoff recovery has competing or retained custody");
}

export const exitOneReadLocks = (local) => handoffLocks(local, false, true);

// The receipt anchors this checkout-local fingerprint while the original bytes
// are pinned. The child can then rescan metadata without reopening payloads.
export function exitOneEvidenceFingerprint(local, state) {
  const archive = join(local, "results.tgz"), root = join(local, state.evidence);
  physical(root);
  const archiveIdentity = evidenceFileIdentity(archive), tree = createHash("sha256");
  let nodes = 1, nameBytes = 0, memberBytes = 0;
  const identity = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].join(":");
  function visit(file, path, depth) {
    assert.ok(depth <= 64 && path.length <= 4096 && Buffer.byteLength(file) <= 4096, "exit-one extraction path bound");
    const stat = lstatSync(file, { bigint: true }), current = identity(stat);
    tree.update(`${path}\0${current}\0`);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      physical(file);
      const dir = opendirSync(file), names = [];
      try {
        let entry;
        while ((entry = dir.readSync())) {
          const { name } = entry;
          assert.ok(++nodes <= evidenceEnvelope.nodes && name.length <= 255 && portableEvidenceSegment(name), "exit-one extraction inventory bound");
          nameBytes += name.length + 1;
          memberBytes += path.length + name.length + 2;
          assert.ok(nameBytes <= evidenceEnvelope.nameBytes && memberBytes <= evidenceEnvelope.memberBytes, "exit-one extraction inventory bound");
          names.push(name);
        }
      } finally { dir.closeSync(); }
      for (const name of names.sort()) visit(join(file, name), path ? path + "/" + name : name, depth + 1);
    } else assert.ok(stat.isFile() && stat.nlink === 1n, "exit-one extraction requires ordinary files");
    assert.ok(identity(lstatSync(file, { bigint: true })) === current, "exit-one extraction changed during custody check");
  }
  visit(root, "", 0);
  assert.ok(evidenceFileIdentity(archive) === archiveIdentity, "exit-one archive changed during custody check");
  return digest(archiveIdentity + "\0" + tree.digest("hex"));
}

function handoffPublications(local) {
  // Ordinary collection leaves its download files behind. Only the published
  // archive and capture are evidence; never adopt or replace the download.
  for (const name of ["monitor-invalid.json", "state.json.tmp", "failed-native-results.tgz.synced"])
    assert.ok(!lstatSync(join(local, name), { throwIfNoEntry: false }), "foreclosed or incomplete handoff custody");
  assert.ok(!readdirSync(local).some(name => /^state\.json\..*\.tmp$/.test(name)), "unsettled handoff state publication");
}

export function handoffCapture(local, state) {
  assert.ok(stagedFleet(state.fleet) && state.fleet.single?.group === state.group
    && state.control?.monitor?.phase === "closed", "closed single-group handoff required");
  assert.equal(state.control.helperSha256, guardianSha256, "original handoff control source changed");
  assert.ok(!state.control.sealed.includes("collection"), "handoff collection is foreclosed");
  assert.ok(state.id && state.ip && state.createIntentAt && state.fullGroupQualified === false
    && ["collectedAt", "validation", "evidenceOutcome", "exitCode", "preBootstrapTerminal", "mixedCancellation"]
      .every(key => state[key] === undefined), "only an unqualified terminal handoff may retire");
  assert.ok(state.status === "running" && !state.retirement && !state.deletionIntentAt && !state.destroyedAt
    || state.status === "retired" && state.retirement?.kind === "native-failed" && state.deletionIntentAt, "handoff retirement state differs");
  handoffPublications(local);
  if (state.status === "running")
    assert.ok(!lstatSync(join(local, "failed-native-host.json"), { throwIfNoEntry: false }), "foreclosed or incomplete handoff custody");
  const grouped = groupedFailure(local, state);
  const bytes = regular(join(local, "failed-native-capture.json"), 1024 * 1024), capture = JSON.parse(bytes);
  assert.deepEqual(Object.keys(capture).sort(), ["controllerCommit", "evidence", "evidenceSha256", "finishedAtMs", "measuredCommit",
    "observation", "reservationSha256", "schema", "scriptSha256", "startedAtMs"]);
  assert.equal(capture.schema, "benchmark-failed-native-custody/v1");
  assert.equal(capture.measuredCommit, state.commit);
  assert.equal(capture.controllerCommit, state.commit, "handoff capture must come from the measured controller");
  assert.match(capture.evidenceSha256, /^[a-f0-9]{64}$/);
  failedNativeObservation(JSON.stringify(capture.observation), state, capture.startedAtMs, capture.finishedAtMs, grouped);
  const prior = regular(join(local, "failed-native-reservation.json"), 1024 * 1024);
  assert.equal(digest(prior), capture.reservationSha256, "handoff preimage changed");
  verifyFailedNativeReservation(state, JSON.parse(prior), grouped);
  assert.equal(capture.scriptSha256, digest(failedNativeScript(state, null, null, grouped)), "original handoff capture script changed");
  return { grouped, capture, captureSha256: digest(bytes) };
}

export function failedNativeArchive(local, state, grouped) {
  return failedNativeArchiveEvidence(local, state, grouped, groupedFailure);
}

function failedNativeArchiveEvidence(local, state, grouped, readGrouped, verifyTree) {
  const roots = grouped?.roots ?? failedNativeRoots(state);
  let retirementAllowed = true;
  const wrapper = originalFailedWrapper(local, state, verifyTree, grouped?.exitOne ? 1 : 2), { folder } = wrapper;
  if (grouped?.preplan === true) {
    assert.ok(isDeepStrictEqual(grouped, preplanGroup(local, state, readGrouped)), "grouped preplan identity differs");
    verifyPreplanArchive(wrapper, state);
    return { roots, retirementAllowed };
  }
  const names = readdirSync(folder), campaigns = names.filter((name) => new RegExp(`^${state.round}-[a-f0-9]{16}$`).test(name));
  assert.equal(campaigns.length, 1, "one original failed campaign required");
  assert.ok(names.every((name) => name === campaigns[0] || name === ".host-attempt.json"), "unknown campaign root");
  const campaign = campaigns[0], dir = join(folder, campaign); physical(dir);
  const plan = JSON.parse(regular(join(dir, "plan.json"))), result = JSON.parse(regular(join(dir, "campaign-result.json")));
  assert.equal(plan.schema, "benchmark-isolated-group-campaign/v1");
  assert.equal(plan.commit, state.commit); assert.equal(plan.round, state.round); assert.deepEqual(plan.order, [state.group]);
  assert.equal(plan.bindings.length, 1); assert.equal(plan.bindings[0].request.group, state.group);
  assert.ok(roots.includes(`/bench/repo/${plan.bindings[0].validation.artifactRoot}`), "unknown reserved native root");
  assert.equal(result.status.campaign, campaign); assert.equal(result.status.round, state.round);
  assert.equal(result.status.campaignSha256, plan.campaignSha256);
  assert.ok(["preserved-uncertain", "finished"].includes(result.status.state), "saved failed terminal campaign required");
  assert.ok(Array.isArray(result.status.uncollectedNativeRoots));
  for (const pending of result.status.uncollectedNativeRoots) {
    assert.equal(pending.group, state.group);
    assert.ok(["prepare", "timing"].includes(pending.phase));
    assert.ok(roots.includes(`/bench/repo/${pending.artifactRoot}`), "unaccounted pending native output");
  }
  if (grouped) {
    // The wrapper corroborates this attempt. Its paths and authorization
    // flags are never inputs to the remote custody probe.
    const { campaignSha256, ...body } = plan;
    assert.equal(deploymentSha256(body), campaignSha256, "archived campaign plan changed");
    const [binding] = plan.bindings, attempt = JSON.parse(regular(join(folder, ".host-attempt.json"), 4096)), { status } = result;
    assert.equal(binding.request.commit, state.commit); assert.equal(binding.request.round, grouped.round);
    assert.equal(binding.campaignMode, savedLoadLayout(state) ?? savedPlacement(state) ?? "dedicated");
    assert.equal(binding.validation.artifactRoot, grouped.phases.timing, "timing root differs");
    assert.equal(attempt.schema, "benchmark-isolated-campaign-reservation/v1");
    assert.equal(attempt.id, campaign); assert.equal(attempt.commit, state.commit); assert.equal(attempt.campaignSha256, campaignSha256);
    assert.equal(status.schema, "benchmark-isolated-campaign-status/v1"); assert.equal(status.executionVersion, 5);
    assert.equal(status.controllerReady, false); assert.equal(status.isolation, "unverified");
    assert.equal(result.wholeHostTerminal, "parent-must-observe"); assert.equal(result.deletionAuthorized, false);
    assert.equal(status.outcomes.length, 1); assert.equal(status.outcomes[0].group, state.group);
    const outcome = status.outcomes[0].outcome;
    assert.ok(["failed", "blocked", "not-run", "preserved-uncertain", "native-validated"].includes(outcome), "failed campaign outcome required");
    // Native composition can finish before stream seal, drain or campaign
    // collection fails. Keep the data but do not infer retirement or success.
    retirementAllowed = outcome !== "native-validated";
    assert.ok(status.uncollectedNativeRoots.length <= Object.keys(grouped.phases).length);
    const phases = new Set();
    for (const pending of status.uncollectedNativeRoots) {
      assert.ok(Object.hasOwn(grouped.phases, pending.phase) && !phases.has(pending.phase));
      assert.equal(pending.artifactRoot, grouped.phases[pending.phase], "pending root differs from reserved phase");
      phases.add(pending.phase);
    }
    if (grouped.terminal.kind === "terminal") {
      assert.equal(grouped.terminal.campaign, campaign, "sealed campaign differs");
      assert.equal(fileHash(join(dir, "control-stream-seal.json")), grouped.terminal.sealSha256, "saved stream seal differs");
    }
  } else if (state.group === "mixed-production") {
    verifyMixedCancellation(local, state);
    assert.equal(campaign, mixedWait.campaign);
    const { campaignSha256, ...body } = plan;
    assert.equal(campaignSha256, mixedWait.campaignSha256); assert.equal(mixedDigest(body), campaignSha256);
    const event = JSON.parse(regular(join(dir, mixedWait.event))), halted = JSON.parse(regular(join(dir, "00003-halted.json")));
    assert.equal(event.at, mixedWait.waitAt); assert.equal(event.subjectSha256, mixedWait.subjectSha256);
    assert.equal(event.status.state, "blocked-review-needed");
    const subject = JSON.parse(regular(join(dir, "mixed-audit-subject.json"))), { subjectSha256, ...subjectBody } = subject;
    assert.equal(subjectSha256, mixedWait.subjectSha256); assert.equal(mixedDigest(subjectBody), subjectSha256);
    mixedCancelledCustody(join(dir, "mixed-audit-sources"), subject, plan.bindings[0]);
    const reservation = JSON.parse(regular(join(folder, ".host-attempt.json")));
    assert.equal(reservation.id, campaign); assert.equal(reservation.campaignSha256, campaignSha256); assert.equal(reservation.commit, state.commit);
    assert.equal(halted.kind, "halted"); assert.equal(halted.sequence, 3); assert.equal(halted.campaign, campaign);
    assert.equal(halted.campaignSha256, campaignSha256); assert.deepEqual(halted.status, result.status);
    assert.deepEqual(readdirSync(dir).filter((n) => /^\d{5}-/.test(n)).sort(), ["00000-authorized.json", "00001-started.json", mixedWait.event, "00003-halted.json"]);
    assert.equal(result.status.state, "preserved-uncertain"); assert.equal(result.wholeHostTerminal, "parent-must-observe"); assert.equal(result.deletionAuthorized, false);
    assert.deepEqual(result.status.uncollectedNativeRoots, []);
    assert.equal(result.status.outcomes.length, 1); assert.equal(result.status.outcomes[0].group, state.group); assert.equal(result.status.outcomes[0].outcome, "not-run");
    assert.ok(!readdirSync(dir).some((n) => /^mixed-(native-audits|audit-delivery(?:-retained)?)\.json$/.test(n)), "cancelled wait advanced into audit");
  }
  return { campaign, roots, retirementAllowed, pending: result.status.uncollectedNativeRoots,
    ...(grouped?.exitOne ? { exitOneHashes: exitOneCampaign(state, grouped, wrapper, campaign, plan, result) } : {}) };
}

// Only trusted controller code runs remotely. Native files are opened as data,
// never imported, invoked, followed through links, or promoted to valid evidence.
const inodeInfo = `def info(s):
    return [s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns]`;
const cloudInstanceProof = (prelogin) => `cloud_binding = None

def cloud_instance():
    global cloud_binding
    assert re.fullmatch(r'[1-9][0-9]*', host_id)
    descriptors, entries = [], []
    def entry(parent, name, flags):
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        descriptors.append(fd)
        assert info(before) == info(os.fstat(fd))
        entries.append((parent, name, fd, info(before)))
        return fd
    def directory(parent, name):
        return entry(parent, name, os.O_RDONLY | os.O_DIRECTORY)
    def data(parent, name, limit):
        fd = entry(parent, name, os.O_RDONLY)
        s = os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit
        value = os.read(fd, limit + 1)
        assert len(value) == s.st_size and info(s) == info(os.fstat(fd))
        return value
    try:
        cloud = directory(None, '/')
        for name in ['var', 'lib', 'cloud']:
            cloud = directory(cloud, name)
        # Read the one supported selector as data through its own pinned inode.
        # Never traverse it, and never extend opened()'s no-symlink policy.
        selector = entry(cloud, 'instance', os.O_PATH)
        s = os.fstat(selector)
        assert stat.S_ISLNK(s.st_mode) and s.st_nlink == 1
        assert os.readlink('', dir_fd=selector) == '/var/lib/cloud/instances/' + host_id
        instance = directory(directory(cloud, 'instances'), host_id)
        instance_id = data(directory(cloud, 'data'), 'instance-id', 64)
        assert instance_id in [host_id.encode('ascii'), (host_id + '\\n').encode('ascii')]
        ${prelogin ? `assert hashlib.sha256(data(instance, 'user-data.txt', ${preloginUserData.length})).hexdigest() == '${digest(preloginUserData)}'` : "assert data(instance, 'user-data.txt', 0) == b''"}
        for parent, name, fd, before in reversed(entries):
            assert before == info(os.fstat(fd)) == info(os.stat(name, dir_fd=parent, follow_symlinks=False))
        binding = [before for parent, name, fd, before in entries]
        if cloud_binding is not None:
            assert binding == cloud_binding
        cloud_binding = binding
    finally:
        for fd in reversed(descriptors):
            os.close(fd)`;

export function failedNativeScript(state, captureSha256 = null, fence = null, grouped) {
  const roots = grouped?.roots ?? failedNativeRoots(state);
  const exitOne = grouped?.exitOne === true;
  if (exitOne) assert.ok(failedExitOneScope(state));
  assert.ok(captureSha256 === null || /^[a-f0-9]{64}$/.test(captureSha256));
  if (fence !== null) {
    assert.equal(fence.snapshotSha256, captureSha256);
    assert.deepEqual(fence.roots.map((root) => root.path), [...roots, "/bench/run.log", "/bench/host.txt", "/bench/exit-code", "/bench/results.tgz"]);
  }
  const files = !grouped && state.group === "mixed-production" ? originalMixedControls(state)
    : Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  const config = { roots, files, archiveSha256: state.archiveSha256, captureSha256, marker: `${JSON.stringify(bootstrapMarker(state))}\n`,
    requireMarker: state.bootstrapReady !== undefined, commit: state.commit, bounds: evidenceEnvelope, fence,
    ...(grouped ? { host: grouped.host } : {}) };
  return `/usr/bin/timeout 600 /usr/bin/python3 - ${quote(state.id)} ${quote(state.unit)} ${quote(JSON.stringify(config))} <<'CORTEN_FAILED_NATIVE_HOST'
import configparser, hashlib, io, json, os, pathlib, re, stat, subprocess, sys, tarfile, time, urllib.request
host_id, unit, raw_config = sys.argv[1:]
c = json.loads(raw_config)
def failed(kind, value, traceback):
    print(json.dumps(dict(schema='benchmark-failed-native-host/v1', custody=False)))
sys.excepthook = failed
assert os.getuid() == 0
os.umask(0o077)
def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')
def sha(data):
    return hashlib.sha256(data).hexdigest()
${inodeInfo}
def opened(path, flags=os.O_RDONLY):
    parts = path.split('/')
    assert parts[0] == '' and all(p not in ['', '.', '..'] for p in parts[1:])
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        try:
            before = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            assert flags & os.O_CREAT and flags & os.O_EXCL or not flags & os.O_CREAT
            before = None
        if before is not None:
            assert stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode) and before.st_nlink == 1
        result = os.open(parts[-1], flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
        if before is not None:
            try:
                assert info(before) == info(os.fstat(result))
            except:
                os.close(result)
                raise
        return result
    finally:
        os.close(fd)
def small(path, limit):
    fd = opened(path)
    try:
        s = os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit
        data = os.read(fd, limit + 1)
        assert len(data) == s.st_size and info(s) == info(os.fstat(fd))
        return data
    finally:
        os.close(fd)
${cloudInstanceProof(state.quietBootstrap === "prelogin")}

def command(args):
    r = subprocess.run(args, capture_output=True, text=True, timeout=5)
    assert r.returncode == 0
    return r.stdout
parent_pid = os.getppid()
parent = pathlib.Path('/proc') / str(parent_pid)
parent_command = b'\\0'.join(os.fsencode(arg) for arg in ['/usr/bin/timeout', '600', '/usr/bin/python3'] + sys.argv) + b'\\0'${exitOne ? `
def accounted_work():
    work, child = c['roots'][1].rsplit('/', 1)
    try:
        fd = opened(work, os.O_RDONLY | os.O_DIRECTORY)
    except FileNotFoundError:
        return
    try:
        with os.scandir(fd) as entries:
            for entry in entries:
                assert entry.name == child and entry.is_dir(follow_symlinks=False)
    finally:
        os.close(fd)` : ""}
def quiet():
    assert parent_pid > 1 and os.getppid() == parent_pid and parent_pid != os.getpid()
    assert (parent / 'cmdline').read_bytes() == parent_command and os.readlink(parent / 'exe') == '/usr/bin/timeout'
    with ${exitOne ? "urllib.request.build_opener(urllib.request.ProxyHandler({})).open" : "urllib.request.urlopen"}('http://169.254.169.254/metadata/v1/id', timeout=3) as response:
        assert response.read(64).decode().strip() == host_id
    properties = ['Id', 'LoadState', 'FragmentPath', 'ActiveState', 'Restart', 'MainPID', 'Job', 'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestamp']${grouped ? `
    assert os.uname().nodename == c['host']['name']
    assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() == c['host']['bootId']
    properties += ['ControlPID']
    events = pathlib.Path('/sys/fs/cgroup/system.slice') / unit / 'cgroup.events'
    try:
        assert 'populated 0' in events.read_text().splitlines()
    except FileNotFoundError:
        assert not os.path.lexists(events.parent)` : ""}
    lines = command(['systemctl', 'show', unit] + ['--property=' + p for p in properties]).splitlines()
    assert len(lines) == len(properties) and all('=' in line for line in lines)
    v = dict(line.split('=', 1) for line in lines)
    assert set(v) == set(properties) and v['Id'] == unit and v['LoadState'] == 'loaded'
    assert v['FragmentPath'] == '/etc/systemd/system/' + unit
    assert v['ActiveState'] in ['inactive', 'failed'] and v['Restart'] == 'no' and v['MainPID'] == '0' and v['Job'] == ''
    assert v['ExecMainCode'] == '1' and v['ExecMainStatus'] == '${exitOne ? 1 : 2}' and v['ExecMainStartTimestamp'].strip() not in ['', 'n/a']${grouped ? `
    assert v['ControlPID'] == '0'` : ""}
    assert command(['systemctl', 'list-jobs', '--no-legend', '--no-pager']).strip() == ''
    assert json.loads(command(['cloud-init', 'status', '--format', 'json']))['status'] == 'done'
    cloud_instance()
    for name, expected in c['files'].items():
        assert sha(small('/bench/' + name, 1048576)) == expected
    assert sha(small('/etc/systemd/system/' + unit, 1048576)) == c['files'][unit]
    for base in ['/etc/systemd/system', '/run/systemd/system']:
        for entry in pathlib.Path(base).glob('corten-bench*'):
            assert str(entry) == '/etc/systemd/system/' + unit
    if os.path.lexists('/bench/bootstrap-ready.json'):
        assert small('/bench/bootstrap-ready.json', 1024) == c['marker'].encode('ascii')
    else:
        assert not c['requireMarker']
    assert small('/bench/exit-code', 16) == b'${exitOne ? 1 : 2}\\n'${exitOne ? `
    assert not os.path.lexists('/bench/failed-native-custody.tgz')
    accounted_work()` : ""}
    assert small('/bench/repo/.git/HEAD', 128) == (c['commit'] + '\\n').encode('ascii')
    git = configparser.ConfigParser(interpolation=None)
    git.read_string(small('/bench/repo/.git/config', 65536).decode('utf8'))
    assert git['remote "origin"']['url'] == 'https://github.com/corten-run/corten.git'
    if os.path.lexists('/run/docker.sock') or os.path.lexists('/run/containerd/containerd.sock'):
        assert command(['docker', 'ps', '--quiet', '--no-trunc']).strip() == ''
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) in [os.getpid(), parent_pid]:
            continue
        try:
            cmd = (entry / 'cmdline').read_bytes()
            assert b'/bench' not in cmd and b'corten-bench-groups-' not in cmd${grouped ? `
            assert not any(name in cmd.split(b'\\0', 1)[0] for name in [b'containerd-shim', b'conmon'])` : ""}
            for name in ['cwd', 'exe']:
                try:
                    target = os.readlink(entry / name)
                except FileNotFoundError:
                    continue
                assert '/bench' not in target and 'corten-bench-groups-' not in target
        except FileNotFoundError:
            continue
    assert os.getppid() == parent_pid and (parent / 'cmdline').read_bytes() == parent_command
    assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
quiet()
nodes, content, names, members = 0, 0, 0, 0
def admit(key):
    global nodes, names, members
    assert key.count('/') < 60 and len(key) < 3800
    assert nodes + 1 <= c['bounds']['nodes'] - 16
    assert names + len(key.rsplit('/', 1)[-1]) <= c['bounds']['nameBytes'] and members + len(key) <= c['bounds']['memberBytes']
    nodes += 1
    names += len(key.rsplit('/', 1)[-1])
    members += len(key)
def inventory(path, key='', admitted=False):
    global content
    try:
        fd = opened(path)
    except FileNotFoundError:
        assert key == ''
        return None
    try:
        s = os.fstat(fd)
        kind = 'd' if stat.S_ISDIR(s.st_mode) else 'f'
        assert kind == 'd' or stat.S_ISREG(s.st_mode) and s.st_nlink == 1
        if not admitted:
            admit(key)
        rows = [dict(key=key, kind=kind, metadata=info(s))]
        if kind == 'd':
            children = []
            with os.scandir(fd) as entries:
                for entry in entries:
                    name = entry.name
                    assert name.isascii() and re.fullmatch(r'[][A-Za-z0-9_.@$%+-]+', name) and name not in ['.', '..']
                    assert len(name) <= 255 and not name.endswith('.') and not re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?', name)
                    admit(key + '/' + name)
                    children.append(name)
            for name in sorted(children):
                child = inventory(path + '/' + name, key + '/' + name, True)
                assert child is not None
                rows.extend(child)
        else:
            content += s.st_size
            assert content <= c['bounds']['content']
        assert info(s) == info(os.fstat(fd))
        return rows
    finally:
        os.close(fd)
# Validate and hash every node's metadata before reading any evidence payload.
all_roots = c['roots'] + ['/bench/run.log', '/bench/host.txt', '/bench/exit-code', '/bench/results.tgz']
inventories = [inventory(path) for path in all_roots]
assert ${grouped?.preplan === true ? "" : "inventories[0] is not None and "}all(rows is not None for rows in inventories[len(c['roots']):])
metadata_bytes = encoded(inventories)
metadata_sha = sha(metadata_bytes)
def consume(path, row, callback):
    fd = opened(path)
    try:
        assert info(os.fstat(fd)) == row['metadata'] and row['kind'] == 'f'
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            callback(block)
        assert info(os.fstat(fd)) == row['metadata']
    finally:
        os.close(fd)
hashes = {}
roots = []
if c['fence'] is not None:
    assert metadata_sha == c['fence']['metadataSha256']
    roots = c['fence']['roots']
for index, (path, rows) in enumerate([] if c['fence'] is not None else zip(all_roots, inventories)):
    if rows is None:
        roots.append(dict(path=path, present=False))
        continue
    h = hashlib.sha256()
    size = 0
    for row in rows:
        key = row['key']
        if row['kind'] == 'd':
            h.update(('d\\0' + key + '\\0').encode('ascii'))
        else:
            size += row['metadata'][4]
            h.update(('f\\0' + key + '\\0' + str(row['metadata'][4]) + '\\0').encode('ascii'))
            f = hashlib.sha256()
            def update(block):
                h.update(block)
                f.update(block)
            consume(path + key, row, update)
            hashes[path + key] = f.hexdigest()
    roots.append(dict(path=path, present=True, treeSha256=h.hexdigest(), nodes=len(rows), bytes=size))
if c['fence'] is None:
    assert hashes['/bench/results.tgz'] == c['archiveSha256']
snapshot = dict(roots=roots, metadataSha256=metadata_sha)
snapshot_sha = sha(encoded(snapshot))
${exitOne ? `# Read-only: this route must never recreate, download or replace a custody archive.
if c['captureSha256'] is not None:
    assert snapshot_sha == c['captureSha256']
archive_row = inventories[-1][0]
assert archive_row['kind'] == 'f' and archive_row['metadata'][4] <= c['bounds']['compressed']
if c['fence'] is None:
    archive_sha = hashes['/bench/results.tgz']
else:
    h = hashlib.sha256()
    consume('/bench/results.tgz', archive_row, h.update)
    archive_sha = h.hexdigest()
assert archive_sha == c['archiveSha256']` : `archive = '/bench/failed-native-custody.tgz'
if c['captureSha256'] is None:
    # Exclusive publication: unexplained/partial capture files are never adopted.
    fd = opened(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    with os.fdopen(fd, 'wb') as target:
        with tarfile.open(fileobj=target, mode='w|gz', format=tarfile.GNU_FORMAT) as tar:
            def data(name, value):
                t = tarfile.TarInfo(name)
                t.mode, t.size = 0o600, len(value)
                tar.addfile(t, io.BytesIO(value))
            data('campaign/custody-metadata.json', metadata_bytes)
            data('campaign/custody-files.json', encoded(hashes))
            data('campaign/custody-snapshot.json', encoded(snapshot))
            for index, (path, rows) in enumerate(zip(all_roots[:-1], inventories[:-1])):
                if rows is None:
                    continue
                prefix = 'campaign/root-' + str(index) if index < len(c['roots']) else path.rsplit('/', 1)[-1]
                for row in rows:
                    t = tarfile.TarInfo(prefix + row['key'] + ('/' if row['kind'] == 'd' else ''))
                    t.mode = 0o700 if row['kind'] == 'd' else 0o600
                    if row['kind'] == 'd':
                        t.type = tarfile.DIRTYPE
                        tar.addfile(t)
                    else:
                        t.size = row['metadata'][4]
                        f = opened(path + row['key'])
                        with os.fdopen(f, 'rb') as source:
                            assert info(os.fstat(source.fileno())) == row['metadata']
                            class Reader:
                                def __init__(self): self.hash = hashlib.sha256()
                                def read(self, n):
                                    block = source.read(n)
                                    self.hash.update(block)
                                    return block
                            reader = Reader()
                            tar.addfile(t, reader)
                            assert reader.hash.hexdigest() == hashes[path + row['key']]
                            assert info(os.fstat(source.fileno())) == row['metadata']
        target.flush()
        os.fsync(target.fileno())
else:
    assert snapshot_sha == c['captureSha256']
archive_row = inventory(archive)[0]
assert archive_row['metadata'][4] <= c['bounds']['compressed']
h = hashlib.sha256()
consume(archive, archive_row, h.update)
archive_sha = h.hexdigest()
if c['fence'] is not None:
    assert archive_sha == c['fence']['archiveSha256']`}
# Both the captured paths and their metadata must remain current after copying.
nodes, content, names, members = 0, 0, 0, 0
assert encoded([inventory(path) for path in all_roots]) == metadata_bytes
quiet()
print(json.dumps(dict(schema='benchmark-failed-native-host/v1', hostId=host_id, unit=unit, custody=True,
    roots=roots, metadataSha256=metadata_sha, snapshotSha256=snapshot_sha, archiveSha256=archive_sha,
    observedAtMs=int(time.time()*1000), historicalAccountingQualified=False${exitOne ? `,
    wrapper=(dict(runLog=hashes['/bench/run.log'], host=hashes['/bench/host.txt']) if c['fence'] is None else c['fence']['wrapper'])` : ""})))
CORTEN_FAILED_NATIVE_HOST`;
}

export function failedNativeObservation(raw, state, startedAtMs, finishedAtMs, grouped) {
  const roots = grouped?.roots ?? failedNativeRoots(state);
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 16384, "bounded custody observation required");
  const observation = JSON.parse(raw);
  assert.deepEqual(Object.keys(observation).sort(), ["archiveSha256", "custody", "historicalAccountingQualified", "hostId", "metadataSha256", "observedAtMs", "roots", "schema", "snapshotSha256", "unit",
    ...(grouped?.exitOne ? ["wrapper"] : [])].sort());
  assert.equal(observation.schema, "benchmark-failed-native-host/v1");
  assert.equal(observation.hostId, state.id); assert.equal(observation.unit, state.unit);
  assert.equal(observation.custody, true); assert.equal(observation.historicalAccountingQualified, false);
  for (const key of ["archiveSha256", "metadataSha256", "snapshotSha256"]) assert.match(observation[key], /^[a-f0-9]{64}$/);
  assert.deepEqual(observation.roots.map((root) => root.path), [...roots, "/bench/run.log", "/bench/host.txt", "/bench/exit-code", "/bench/results.tgz"]);
  for (const root of observation.roots) {
    assert.equal(typeof root.present, "boolean");
    assert.deepEqual(Object.keys(root).sort(), (root.present ? ["bytes", "nodes", "path", "present", "treeSha256"] : ["path", "present"]).sort());
    if (root.present) {
      assert.match(root.treeSha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(root.nodes) && root.nodes >= 1 && root.nodes <= evidenceEnvelope.nodes);
      assert.ok(Number.isSafeInteger(root.bytes) && root.bytes >= 0 && root.bytes <= evidenceEnvelope.content);
    }
  }
  if (grouped?.preplan !== true) assert.equal(observation.roots[0].present, true);
  assert.ok(observation.roots.slice(roots.length).every((root) => root.present));
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && finishedAtMs - startedAtMs <= 660000, "custody observation exceeded its local window");
  assert.ok(Number.isSafeInteger(observation.observedAtMs) && observation.observedAtMs >= startedAtMs - 5000
    && observation.observedAtMs <= finishedAtMs + 5000, "custody observation clock differs");
  return observation;
}

export function failedExitOneObservation(raw, state, started, finished, { grouped, hashes }) {
  const observation = failedNativeObservation(raw, state, started, finished, grouped);
  const { roots, metadataSha256 } = observation;
  assert.equal(observation.snapshotSha256, deploymentSha256({ roots, metadataSha256 }), "exit-one snapshot differs");
  const [campaign, native, control] = observation.roots;
  assert.equal(observation.archiveSha256, state.archiveSha256, "original remote archive differs");
  assert.equal(campaign.treeSha256, hashes.campaign, "live campaign differs from the archive");
  assert.equal(control.treeSha256, hashes.control, "live control root differs from the archive");
  assert.ok(native.present ? native.treeSha256 === hashes.native : hashes.empty, "unpreserved live native output");
  assert.deepEqual(observation.wrapper, hashes.wrapper, "live wrapper files differ from the archive");
  return observation;
}

export function verifyFailedExitOneRetirement(local, state, expectedSha256 = state.retirement.evidenceSha256, pin = false) {
  const path = join(local, "failed-native-host.json"), original = join(local, "failed-native-reservation.json");
  const files = [path, original].map(path => [path, evidenceFileIdentity(path)]);
  const bytes = regular(path, 65536), record = JSON.parse(bytes);
  assert.equal(digest(bytes), expectedSha256, "exit-one retirement receipt changed");
  assert.equal(record.schema, "benchmark-failed-native-retirement/v3");
  assert.deepEqual(Object.keys(record).sort(), ["controllerCommit", "evidenceFingerprint", "fence", "fleetManifestSha256", "launchIntentSha256",
    "observation", "reservationSha256", "schema"]);
  assert.match(record.controllerCommit, /^[a-f0-9]{40}$/);
  assert.notEqual(record.controllerCommit, state.commit);
  assert.equal(state.status, "retired");
  const custody = verifyFailedExitOneCustody(local, state, { pin });
  const { grouped, launchIntentSha256, fleetManifestSha256 } = custody;
  assert.ok(record.evidenceFingerprint === exitOneEvidenceFingerprint(local, state), "exit-one retirement evidence fingerprint changed");
  assert.ok(record.launchIntentSha256 === launchIntentSha256 && record.fleetManifestSha256 === fleetManifestSha256,
    "exit-one launch or fleet changed");
  const prior = regular(original, 1024 * 1024);
  assert.equal(digest(prior), record.reservationSha256, "exit-one original reservation changed");
  const saved = JSON.parse(prior);
  assert.equal(saved.status, "running");
  assert.ok(!saved.deletionIntentAt && !saved.destroyedAt && !saved.retirement, "prior exit-one retirement intent");
  verifyFailedNativeReservation(state, saved, grouped);
  const probeRows = state.control.ledger.slice(saved.control.ledger.length);
  assert.equal(probeRows.length, 2, "two acknowledged exit-one probes required");
  const check = ({ startedAtMs, finishedAtMs, proof, scriptSha256, ...extra }, first, row) => {
    assert.deepEqual(extra, {});
    const script = failedNativeScript(state, first?.snapshotSha256 ?? null, first ?? null, grouped);
    assert.equal(scriptSha256, digest(script), "exit-one proof script changed");
    assert.ok(row.localTerminal && row.code === 0 && row.request.epoch === "collection" && row.request.seal === undefined
      && row.request.invocation.channel === "ssh" && row.request.invocation.deadlineMs === (first ? 60000 : 660000)
      && row.request.invocation.requestSha256 === digest(`set -euo pipefail\n${script}\n`), "exit-one probe acknowledgement differs");
    return failedExitOneObservation(JSON.stringify(proof), state, startedAtMs, finishedAtMs, custody);
  };
  const first = check(record.observation, null, probeRows[0]), final = check(record.fence, first, probeRows[1]);
  const intent = Date.parse(state.deletionIntentAt);
  assert.ok(record.fence.startedAtMs >= record.observation.finishedAtMs
    && intent >= record.fence.finishedAtMs && intent < record.fence.startedAtMs + 60000
    && (state.destroyedAt === undefined || Date.parse(state.destroyedAt) >= intent), "exit-one proof window differs");
  const withoutTime = ({ observedAtMs, ...rest }) => rest;
  assert.deepEqual(withoutTime(first), withoutTime(final), "exit-one proof changed before deletion");
  const assertCustody = (includeTree = true) => {
    custody.assertCustody(includeTree);
    for (const [path, before] of files) assert.ok(evidenceFileIdentity(path) === before, "exit-one receipt files changed");
  };
  assertCustody();
  return { ...custody, record, assertCustody };
}

export function verifyFailedNativeReservation(state, prior, grouped) {
  const current = { ...state };
  assert.ok(["starting", "running"].includes(prior.status));
  if (current.retirement) {
    current.status = prior.status;
    for (const key of ["retirement", "deletionIntentAt", "destroyedAt"]) delete current[key];
  }
  if (grouped) {
    // Supervised collection records each SSH/SCP in the reservation. No
    // other change to the original reservation (or its ledger prefix) is allowed.
    const { ledger } = current.control, count = prior.control.ledger.length;
    assert.ok(ledger.length >= count && ledger.slice(count).every(r => r.localTerminal && r.request.epoch === "collection"));
    current.control = { ...current.control, ledger: ledger.slice(0, count) };
  }
  assert.deepEqual(current, prior, "original measured reservation changed");
}

export function verifyFailedNativeCustody(local, state, capture, grouped, requireRetirement = false) {
  return verifyFailedNativeCustodyEvidence(local, state, capture, grouped, requireRetirement ? true : undefined, groupedFailure);
}

function verifyEvidenceTree(path, expected, message) {
  assert.equal(treeHash(path), expected, message);
}

export function verifyHandoffCustody(local, state, handoff, pin = false) {
  const launch = join(dirname(dirname(local)), "launch-intent.json");
  const inputs = pin ? [launch, ...["failed-native-capture.json", "failed-native-reservation.json", "results.tgz",
    "failed-native-results.tgz", "known_hosts", "monitor-registration.json", "monitor-local-closed.json", "monitor-terminal.json"]
    .map(name => join(local, name))].map(path => [path, evidenceFileIdentity(path)]) : undefined;
  const { grouped, capture, captureSha256 } = handoffCapture(local, state);
  assert.equal(captureSha256, handoff.captureSha256, "approved original handoff capture changed");
  assert.match(handoff.controllerCommit, /^[a-f0-9]{40}$/);
  assert.notEqual(handoff.controllerCommit, capture.controllerCommit, "distinct repair controller required");
  assert.equal(fileHash(launch, 1024 * 1024), handoff.launchIntentSha256, "approved handoff launch intent changed");
  const trees = [];
  verifyFailedNativeCustodyEvidence(local, state, capture, grouped, false, groupedFailure,
    pin ? (...args) => { trees.push(pinEvidenceTree(...args)); } : verifyEvidenceTree);
  const assertCustody = pin ? (includeTrees = true) => {
    if (includeTrees) for (const unchanged of trees) unchanged();
    assert.equal(fileHash(join(local, "failed-native-capture.json"), 1024 * 1024), handoff.captureSha256,
      "approved original handoff capture changed");
    handoffPublications(local);
    for (const [path, before] of inputs)
      assert.ok(evidenceFileIdentity(path) === before, "local handoff custody changed: file");
  } : undefined;
  assertCustody?.(false);
  return { grouped, capture, assertCustody };
}

function verifyFailedNativeCustodyEvidence(local, state, capture, grouped, requiredEligibility, readGrouped, verifyTree = verifyEvidenceTree) {
  const preplan = Object.hasOwn(capture, "scope");
  if (preplan) assert.ok(capture.scope === "grouped-preplan", "unknown custody scope");
  if (preplan && grouped === undefined) grouped = preplanGroup(local, state, readGrouped);
  assert.equal(grouped?.preplan === true, preplan, "custody preplan scope differs");
  const { retirementAllowed, campaign, pending } = failedNativeArchiveEvidence(local, state, grouped, readGrouped, verifyTree);
  if (requiredEligibility === true) assert.ok(retirementAllowed, "ambiguous native outcome permits custody only");
  if (requiredEligibility === false) assert.ok(!retirementAllowed, "handoff requires a captured native-validated campaign");
  assert.equal(capture.schema, "benchmark-failed-native-custody/v1");
  assert.equal(capture.measuredCommit, state.commit);
  assert.match(capture.controllerCommit, /^[a-f0-9]{40}$/);
  assert.equal(capture.controllerCommit === state.commit, !!grouped && !preplan, "custody controller scope differs");
  if (preplan) {
    const expected = capture.launchIntentSha256;
    assert.ok(Object.hasOwn(capture, "launchIntentSha256") && typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected),
      "preplan launch intent digest required");
    // The capture binds the same raw fleet-root bytes as production approval.
    const launch = join(dirname(dirname(local)), "launch-intent.json");
    assert.equal(fileHash(launch, 1024 * 1024), expected, "preplan launch intent changed");
  }
  assert.match(capture.reservationSha256, /^[a-f0-9]{64}$/);
  const original = regular(join(local, "failed-native-reservation.json"), 1024 * 1024);
  assert.equal(digest(original), capture.reservationSha256);
  verifyFailedNativeReservation(state, JSON.parse(original), grouped);
  assert.match(capture.evidence, /^custody-[A-Za-z0-9]+$/);
  const observation = failedNativeObservation(JSON.stringify(capture.observation), state, capture.startedAtMs, capture.finishedAtMs, grouped);
  if (requiredEligibility === false) {
    const present = (path) => observation.roots.some(root => root.path === "/bench/repo/" + path && root.present);
    assert.ok(pending.every(({ artifactRoot }) => present(artifactRoot)), "uncaptured pending native root");
    // Some runners transfer the original output into the collected phase rather than copying it.
    if (!present(grouped.phases.timing))
      physical(join(local, state.evidence, "campaign", campaign, `00-${state.group}-timing`, "native"));
  }
  assert.equal(capture.scriptSha256, digest(failedNativeScript(state, null, null, grouped)));
  assert.equal(fileHash(join(local, "failed-native-results.tgz")), observation.archiveSha256, "custody archive changed");
  const extracted = join(local, capture.evidence); physical(extracted);
  verifyTree(extracted, capture.evidenceSha256, "custody extraction changed");
  const snapshot = regular(join(extracted, "campaign", "custody-snapshot.json"), 16384);
  assert.equal(digest(snapshot), observation.snapshotSha256);
  assert.deepEqual(JSON.parse(snapshot), { roots: observation.roots, metadataSha256: observation.metadataSha256 });
  assert.equal(fileHash(join(extracted, "campaign", "custody-metadata.json")), observation.metadataSha256);
  for (const [index, root] of observation.roots.slice(0, (grouped?.roots ?? failedNativeRoots(state)).length).entries()) {
    if (!grouped && state.group === "mixed-production" && index === 2) mixedIntentRoot(join(extracted, "campaign", "root-2"), root);
    else if (root.present) assert.equal(treeHash(join(extracted, "campaign", `root-${index}`)), root.treeSha256, "custody root differs");
    else assert.ok(!readdirSync(join(extracted, "campaign")).includes(`root-${index}`), "absent native root was invented");
  }
  for (const name of ["run.log", "host.txt", "exit-code"])
    assert.equal(fileHash(join(extracted, name)), fileHash(join(local, state.evidence, name)), "failed metadata changed");
  if (observation.roots[0].present)
    assert.equal(treeHash(join(extracted, "campaign", "root-0")), treeHash(join(local, state.evidence, "campaign")), "original campaign changed before custody");
  if (!grouped && state.group === "mixed-production") {
    verifyMixedCancellation(local, state);
    assert.equal(capture.observation.roots[2].present, true, "remote cancellation intent missing");
    const intentPath = join(extracted, "campaign", "root-2"), intent = mixedIntentRoot(intentPath, capture.observation.roots[2]);
    const signal = verifyMixedSignal(local, state);
    assert.equal(fileHash(intentPath), signal.remoteIntentSha256, "remote intent differs from acknowledged signal");
    assert.equal(intent.schema, "benchmark-mixed-cancel-remote-intent/v1");
    assert.equal(intent.hostId, state.id); assert.equal(intent.unit, state.unit); assert.equal(intent.campaign, mixedWait.campaign);
    assert.equal(intent.subjectSha256, mixedWait.subjectSha256); assert.equal(intent.signal, "SIGTERM");
    const reservation = JSON.parse(regular(join(extracted, "campaign", "root-0", ".host-attempt.json")));
    assert.equal(intent.pid, reservation.pid); assert.ok(Number.isSafeInteger(intent.startTicks) && intent.startTicks > 0);
    assert.equal(intent.pid, signal.pid); assert.equal(intent.startTicks, signal.startTicks);
    const dir = join(extracted, "campaign", "root-0", mixedWait.campaign);
    const waitFiles = [join(extracted, "campaign", "root-0", ".host-attempt.json"), join(dir, "plan.json"), join(dir, mixedWait.event), join(dir, "mixed-audit-subject.json")];
    assert.equal(intent.waitSha256, digest(Buffer.concat(waitFiles.flatMap((path, i) => [ ...(i ? [Buffer.from([0])] : []), regular(path) ]))), "cancellation wait bytes changed");
  }
  return capture;
}

export function verifyFailedNativeRetirement(local, state, expectedSha256 = state.retirement.evidenceSha256) {
  return replayFailedNativeRetirement(local, state, expectedSha256, groupedFailure);
}

export function pinHandoffRetirement(local, state, handoff) {
  const { record, assertCustody } = replayFailedNativeRetirement(local, state, state.retirement.evidenceSha256, groupedFailure, true);
  assert.deepEqual(record.handoff, handoff, "approved handoff retirement receipt differs");
  return assertCustody;
}

export function verifyHistoricalFailedNativeRetirement(local, state, settledOwner) {
  assert.ok(state.status === "retired" && state.destroyedAt && state.retirement.kind === "native-failed");
  return replayFailedNativeRetirement(local, state, state.retirement.evidenceSha256,
    (dir, saved) => groupedFailureEvidence(dir, saved, settledOwner));
}

function replayFailedNativeRetirement(local, state, expectedSha256, readGrouped, pin = false) {
  const bytes = regular(join(local, "failed-native-host.json"));
  assert.match(expectedSha256, /^[a-f0-9]{64}$/);
  assert.equal(digest(bytes), expectedSha256, "failed-native retirement receipt changed");
  const record = JSON.parse(bytes);
  if (record.schema === "benchmark-failed-native-retirement/v3") {
    assert.ok(!pin, "approved handoff retirement receipt required");
    return verifyFailedExitOneRetirement(local, state, expectedSha256).record;
  }
  const handoff = record.schema === "benchmark-failed-native-retirement/v2";
  assert.deepEqual(Object.keys(record).sort(), ["capture", "confirmation", "finishedAtMs", "rehash", "schema", "scriptSha256", "startedAtMs",
    ...(handoff ? ["handoff"] : [])].sort());
  assert.ok(handoff || record.schema === "benchmark-failed-native-retirement/v1");
  // The explicit scope distinguishes grouped successor custody from historical
  // recovery; ordinary grouped receipts still replay at the measured commit.
  let grouped, assertCustody;
  assert.ok(!pin || handoff, "approved handoff retirement receipt required");
  if (handoff) {
    assert.equal(state.status, "retired");
    assert.deepEqual(Object.keys(record.handoff).sort(), ["captureSha256", "controllerCommit", "launchIntentSha256"]);
    const checked = verifyHandoffCustody(local, state, record.handoff, pin);
    assert.deepEqual(record.capture, checked.capture, "retirement did not preserve the original handoff capture");
    grouped = checked.grouped;
    assertCustody = checked.assertCustody;
  } else {
    grouped = record.capture.scope === "grouped-preplan" ? preplanGroup(local, state, readGrouped)
      : record.capture.controllerCommit === state.commit ? readGrouped(local, state) : undefined;
    verifyFailedNativeCustodyEvidence(local, state, record.capture, grouped, true, readGrouped);
  }
  assert.deepEqual(Object.keys(record.rehash).sort(), ["finishedAtMs", "observation", "scriptSha256", "startedAtMs"]);
  const rehash = failedNativeObservation(JSON.stringify(record.rehash.observation), state, record.rehash.startedAtMs, record.rehash.finishedAtMs, grouped);
  assert.equal(record.rehash.scriptSha256, digest(failedNativeScript(state, record.capture.observation.snapshotSha256, null, grouped)), "retirement rehash script changed");
  const final = failedNativeObservation(JSON.stringify(record.confirmation), state, record.startedAtMs, record.finishedAtMs, grouped);
  assert.equal(record.scriptSha256, digest(failedNativeScript(state, record.capture.observation.snapshotSha256, record.capture.observation, grouped)), "retirement fence script changed");
  const withoutTime = ({ observedAtMs, ...rest }) => rest;
  assert.deepEqual(withoutTime(rehash), withoutTime(record.capture.observation), "remote custody rehash differs");
  assert.deepEqual(withoutTime(final), withoutTime(record.capture.observation), "predelete custody differs");
  return pin ? { record, assertCustody } : record;
}

// An offline-handoff launch that stopped at its create, whose exact posted droplet a
// later collect bound: no SSH, upload, seal or monitor ever existed. Its own pinned,
// separately approved unused-host collection is the only route to retirement.
export function offlineNeverStarted(state) {
  const c = state.control;
  return state.fleet?.single?.offlineHandoff === true && state.quietBootstrap === "prelogin" && c?.monitor === undefined
    && Array.isArray(c?.ledger) && c.ledger.length === 0 && Array.isArray(c.sealed) && c.sealed.length === 0
    && state.launchHostKeySha256 === undefined && state.createErrored === undefined
    && typeof state.id === "string" && state.createPending?.dropletId === state.id;
}

function unusedBootstrapState(state, interrupted = false) {
  const c = state.control;
  const pending = c?.monitor?.phase === "pending" && !c.monitor.registrationSha256;
  // Offline launch has no monitor by design. Admit only this exact interrupted
  // first-upload prefix or a bound posted create that never started, never an
  // unmonitored no-op or settled prefix.
  const offline = interrupted && state.fleet?.single?.offlineHandoff === true
    && state.quietBootstrap === "prelogin" && c?.monitor === undefined;
  return !!(state.id && state.ip && state.createIntentAt && c?.helperSha256 === guardianSha256
    && (pending || offline || !interrupted && offlineNeverStarted(state)) && !c.sealed.length
    && (state.status === "preparing" ? !state.deletionIntentAt : state.status === "retired" && state.retirement?.kind === "unused")
    && ["bootstrapReady", "preBootstrapTerminal", "auditIntent", "auditIntents", "archiveSha256", "evidenceSha256", "extractionAttempts",
      "evidence", "evidenceOutcome", "exitCode", "validation", "collectedAt", "mixedCancellation"].every((key) => state[key] === undefined));
}

// Before provisioning, only the unacknowledged first no-op is allowed.
export function unusedBootstrap(state) {
  if (!unusedBootstrapState(state)) return false;
  const { ledger } = state.control, row = ledger[0], request = row?.request;
  return ledger.length === 0 || ledger.length === 1 && request.epoch === "bootstrap" && request.sequence === 0 && !request.seal && !row.localTerminal
    && request.invocation.channel === "ssh" && request.invocation.deadlineMs === 30000
    && request.invocation.requestSha256 === digest("set -euo pipefail\ntrue\n");
}

export function settledBootstrap(state, local) {
  return uploadPrefix(state, local, false);
}

// A missing reply is never an acknowledgement. Only the first file may be in
// doubt, and only on a host whose launch established its own SSH key.
export function interruptedFirstUpload(state, local) {
  return !!state.launchHostKeySha256 && state.control?.ledger.length === 3 && uploadPrefix(state, local, true);
}

function uploadPrefix(state, local, interrupted) {
  if (!unusedBootstrapState(state, interrupted)) return false;
  const { ledger } = state.control;
  if (ledger.length < 3 || ledger.length > 8) return false;
  const ssh = (script, deadline = 60000) => ["ssh", deadline, digest("set -euo pipefail\n" + script + "\n")];
  const expected = [ssh("true", 30000), ssh(bootstrapWorkspaceScript(state, { launch: interrupted }))];
  // Dispatch checks absolute SFTP operands. Replay also works on moved evidence,
  // where the combined script digest still binds every original request digest.
  for (const [name, content] of Object.entries(remoteFiles(state))) {
    expected.push(["sftp", 15 * 60000, local === undefined ? undefined : digest(JSON.stringify([join(local, name), "root@" + state.ip + ":/bench/" + name]))],
      ssh("printf '%s  %s\\n' '" + digest(content) + "' '/bench/" + name + "' | sha256sum --check --status"));
  }
  return ledger.every(({ request, localTerminal, code }, sequence) => {
    const [channel, deadlineMs, hash] = expected[sequence], invocation = request.invocation;
    const expectedDisposition = interrupted && sequence === 2 ? localTerminal === false && code === undefined : localTerminal === true && code === 0;
    return expectedDisposition && request.epoch === "bootstrap" && request.sequence === sequence && !request.seal
      && invocation.channel === channel && invocation.deadlineMs === deadlineMs && (hash === undefined || invocation.requestSha256 === hash);
  });
}

// Unlike a receipt, this is a failed watcher which never registered the
// transfer. guard() starts the child but cannot forward input until registration.
const refusedUploadProof = String.raw`def refused_upload(root, binding, request, expect, units, g):
    inv = request['invocation']
    identifier = inv['id']
    unit = 'corten-bench-control-' + binding['token'] + '-' + identifier + '.service'
    records = {}
    for prefix in ['request', 'start', 'launcher', 'watch-failure']:
        name = prefix + '-' + identifier + '.json'
        expect.add(name)
        records[prefix] = g['load'](root, name)
    # The subsequent exact directory inventory excludes a registration, result,
    # receipt, or any other work. Never invent terminal ticks for an absent PID.
    assert records['request'] == request and records['launcher'] == {'unit': unit, 'code': 0}
    start, failure = records['start'], records['watch-failure']
    assert set(start) == {'guardian', 'child', 'unit', 'connection', 'deadlineMonoNs'} and start['unit'] == unit
    assert set(failure) == {'helperLine'} and type(failure['helperLine']) is int and 0 < failure['helperLine'] <= len(source.splitlines())
    assert re.fullmatch(r'[1-9][0-9]{0,18}', start['deadlineMonoNs']) and time.monotonic_ns() > int(start['deadlineMonoNs'])
    assert start['guardian'] != start['child']
    for pid in (start['guardian'], start['child']):
        assert type(pid) is int and pid > 1
        try: os.stat('/proc/' + str(pid))
        except FileNotFoundError: pass
        else: raise AssertionError('original transfer PID present')
    client, client_port, server, server_port = start['connection'].split()
    def ip(text):
        value = g['ipaddress'].ip_address(text)
        return getattr(value, 'ipv4_mapped', None) or value
    assert 0 < int(client_port) <= 65535 and int(server_port) == 22
    target = (ip(server), int(server_port), ip(client), int(client_port))
    for fields, _ in g['socket_rows']():
        local, lp = fields[1].split(':')
        remote, rp = fields[2].split(':')
        assert (g['address'](local), int(lp, 16), g['address'](remote), int(rp, 16)) != target
    required = dict(Id=unit, LoadState='loaded', ActiveState='failed', SubState='failed', Restart='no',
                    MainPID='0', ControlPID='0', NRestarts='0', Job='', Triggers='', TriggeredBy='',
                    ExecMainCode='1')
    r = subprocess.run(['systemctl', 'show', '--all', unit] + ['--property=' + k for k in [*required, 'ExecMainStatus']],
                       capture_output=True, text=True, timeout=5, check=True)
    values = dict(line.split('=', 1) for line in r.stdout.splitlines())
    assert 0 < int(values.pop('ExecMainStatus')) <= 255 and values == required
    cg = pathlib.Path('/sys/fs/cgroup/system.slice') / unit
    try: mode = cg.lstat().st_mode
    except FileNotFoundError: pass
    else:
        assert stat.S_ISDIR(mode) and dict(line.split() for line in (cg / 'cgroup.events').read_text().splitlines())['populated'] == '0'
    units.add(unit)
    return dict(invocationId=identifier, jobPresent=False, failureSha256=hashlib.sha256(g['read'](root / ('watch-failure-' + identifier + '.json'))).hexdigest())
`;

const settledDrain = (interrupted) => String.raw`def settled_receipts(root, binding, requests, g):
    g['private'](root)
    assert g['load'](root, 'binding.json') == binding
    expect = {'helper.py', 'binding.json', 'mutex'}
    digests, receipts, units = [], [], set()
    listener, chain, _ = g['ancestry'](os.getpid(), os.environ['SSH_CONNECTION'])
    identities = ('pid', 'startTicks', 'cgroup', 'executable')
    same = lambda a, b: all(a[k] == b[k] for k in identities)
    ${interrupted ? "refused = refused_upload(root, binding, requests[-1], expect, units, g)\n    for request in requests[:-1]:" : "for request in requests:"}
        invocation = request['invocation']
        identifier = invocation['id']
        for prefix in ['request', 'start', 'launcher', 'registration', 'result', 'receipt']:
            expect.add(prefix + '-' + identifier + '.json')
        assert g['load'](root, 'request-' + identifier + '.json') == request
        raw = g['read'](root / ('receipt-' + identifier + '.json'))
        receipt = json.loads(raw)
        registration = g['load'](root, 'registration-' + identifier + '.json')
        start = g['load'](root, 'start-' + identifier + '.json')
        assert g['load'](root, 'launcher-' + identifier + '.json') == {'unit': start['unit'], 'code': 0}
        assert receipt['schema'] == 'benchmark-control-session/v2' and receipt['invocation'] == registration['invocation'] == invocation
        assert receipt['host'] == registration['host'] == g['host']()
        assert receipt['session'] == registration['session'] and receipt['socket'] == registration['socket']
        assert receipt['result'] == g['load'](root, 'result-' + identifier + '.json')
        assert receipt['result']['transport'] == 'exited' and receipt['result']['code'] == 0
        assert receipt['observer'] == registration['observer'] and receipt['listener'] == registration['listener']
        assert same(receipt['listener'], listener)
        terminal = g['watcher_terminal'](root, identifier, receipt)
        assert terminal is not None
        units.add(terminal['unit'])
        receipts.append(receipt)
        digests.append(hashlib.sha256(raw).hexdigest())
    assert {p.name for p in root.iterdir()} == expect
    assert {p.name for p in root.parent.glob('corten-bench-control-*')} == {root.name}
    for directory in ['/run/systemd/transient', '/sys/fs/cgroup/system.slice']:
        assert {p.name for p in pathlib.Path(directory).glob('corten-bench-control-*')} <= units
    listed = subprocess.run(['systemctl', 'list-units', '--all', '--plain', '--no-legend', '--no-pager',
                             'corten-bench-control-*.service'], capture_output=True, text=True, timeout=5)
    assert listed.returncode == 0 and len(listed.stdout) <= 4096
    assert {line.split()[0] for line in listed.stdout.splitlines() if line.strip()} <= units
    rows = g['inventory']()
${interrupted ? `    sftp = os.stat('/usr/lib/openssh/sftp-server')
    assert all(row['executable'] != {'device': str(sftp.st_dev), 'inode': str(sftp.st_ino)} for row in rows.values())
` : ""}    key = g['key']
    live = {key(p) for p in rows.values()}
    allowed = {p['pid'] for p in [listener] + chain}
    assert all(same(rows[p['pid']], p) for p in [listener] + chain)
    for receipt in receipts:
        tracked = {key(p) for sample in receipt['samples'] for p in sample['processes']}
        tracked.remove(key(listener))
        tracked.update(key(p) for p in receipt['session']['chain'] + [receipt['observer']])
        assert tracked and not (tracked & live)
        scope = g['scope_read'](receipt['session']['scope'], rows)
        assert not scope['members'] and (not scope['exists'] or 'populated 0' in scope['events'].splitlines())
    for row in rows.values():
        if row['pid'] in allowed:
            continue
        cgroup = row['cgroup']
        assert g['parent'](row) not in allowed and cgroup != listener['cgroup']
        assert not cgroup.startswith(listener['cgroup'].rstrip('\n') + '/')
        assert not cgroup.startswith(('0::/user.slice/', '0::/system.slice/corten-bench'))
        assert not re.search(r'/session-[^/\n]+\.scope(?:/|\n)', cgroup)
    return ${interrupted ? "digests, refused" : "digests"}`;

// Use the same descriptor-bound instance-ID and user-data proof before
// accepting a new host as unused or failed during setup.
const preloginDataProof = `import re
${inodeInfo}
${cloudInstanceProof(true)}
cloud_instance()`;

export function unusedHostScript(state, { bootstrap = false, legacyTimestamp = false } = {}) {
  const interrupted = bootstrap && interruptedFirstUpload(state);
  const settled = bootstrap && (interrupted || settledBootstrap(state)), pristine = bootstrap && !settled;
  if (pristine) assert.ok(unusedBootstrap(state), "unused bootstrap proof requires pre-provisioning custody");
  assert.ok(!settled || !legacyTimestamp, "settled bootstrap needs current unit proof");
  const files = pristine || interrupted ? {} : Object.fromEntries(Object.entries(remoteFiles(state))
    .slice(0, settled ? Math.ceil((state.control.ledger.length - 2) / 2) : undefined).map(([name, content]) => [name, digest(content)]));
  const invocation = pristine && state.control.ledger[0]?.request.invocation;
  const watcher = invocation && `corten-bench-control-${state.token}-${invocation.id}.service`;
  const timestamp = legacyTimestamp ? "ExecMainStartTimestamp" : "ExecMainStartTimestampMonotonic";
  return `/usr/bin/timeout 25 /usr/bin/python3 - ${quote(state.id)} ${quote(state.unit)} ${quote(JSON.stringify(files))} <<'CORTEN_UNUSED_HOST'
import hashlib, json, os, pathlib, stat, subprocess, sys, time, urllib.request
host_id, unit, manifest = sys.argv[1:]
files = json.loads(manifest)
def failed(kind, value, traceback):
    print(json.dumps(dict(schema='benchmark-unused-host/v1', unused=False)))
sys.excepthook = failed
assert os.getuid() == 0
with urllib.request.urlopen('http://169.254.169.254/metadata/v1/id', timeout=3) as response:
    assert response.read(64).decode().strip() == host_id
properties = ['Id', 'LoadState', 'ActiveState', 'MainPID', 'FragmentPath', '${timestamp}', 'Job', 'Restart']
r = subprocess.run(['systemctl', 'show', unit] + ['--property=' + p for p in properties], capture_output=True, text=True, timeout=5)
assert r.returncode in (0, 1)
values = dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)
assert len(values) == len(properties) and values['Id'] == unit
assert values['ActiveState'] == 'inactive' and values['MainPID'] == '0'
assert values['${timestamp}'] == '${legacyTimestamp ? "" : "0"}' and values['Job'] == ''
assert values['LoadState'] in ['not-found', 'loaded'] and values['Restart'] == 'no'
assert values['FragmentPath'] == (('/etc/systemd/system/' + unit) if values['LoadState'] == 'loaded' else '')
${settled ? `assert values['LoadState'] == 'not-found'
` : ""}${pristine ? `def absent(path):
    try:
        pathlib.Path(path).lstat()
    except FileNotFoundError:
        return
    raise AssertionError('unexpected bootstrap custody')
assert values['LoadState'] == 'not-found'
for path in ['/bench', '/run/corten-bench-control-${state.token}', '/etc/systemd/system/' + unit,
${watcher ? `             '/run/systemd/transient/${watcher}', '/sys/fs/cgroup/system.slice/${watcher}'` : "             "}]:
    absent(path)
assert not any(entry.name.startswith('corten-bench-control-') for entry in pathlib.Path('/run').iterdir())
${watcher && legacyTimestamp ? `watcher = subprocess.run(['systemctl', 'show', '${watcher}', '--property=LoadState'], capture_output=True, text=True, timeout=5)
assert watcher.returncode in (0, 1) and watcher.stdout.strip() == 'LoadState=not-found'
` : ""}${legacyTimestamp ? "" : `for directory in ['/run/systemd/transient', '/sys/fs/cgroup/system.slice']:
    try:
        assert not any(entry.name.startswith('corten-bench-control-') for entry in pathlib.Path(directory).iterdir())
    except FileNotFoundError:
        absent(directory)
r = subprocess.run(['systemctl', 'list-units', '--all', '--plain', '--no-legend', '--no-pager', 'corten-bench-control-*.service'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and r.stdout.strip() == ''
`}` : ""}bench = pathlib.Path('/bench')
${settled ? `assert bench.is_dir() and not bench.is_symlink()
assert {p.name for p in bench.iterdir()} == {'run.log'} | files.keys()
` : ""}if os.path.lexists(bench):
    assert bench.is_dir() and not bench.is_symlink()
    for entry in bench.iterdir():
        assert stat.S_ISREG(entry.lstat().st_mode) and entry.stat().st_size <= 1048576
        if entry.name == 'run.log':
            assert entry.stat().st_size == 0
        else:
            assert entry.name in files and hashlib.sha256(entry.read_bytes()).hexdigest() == files[entry.name]
assert not pathlib.Path('/run/docker.sock').exists() and not pathlib.Path('/run/containerd/containerd.sock').exists()
for base in ['/etc/systemd/system', '/run/systemd/system']:
    for entry in pathlib.Path(base).glob('corten-bench*'):
        assert str(entry) == '/etc/systemd/system/' + unit
        assert stat.S_ISREG(entry.lstat().st_mode) and entry.stat().st_size <= 1048576
        assert hashlib.sha256(entry.read_bytes()).hexdigest() == files[unit]
r = subprocess.run(['systemctl', 'list-jobs', '--no-legend', '--no-pager'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and r.stdout.strip() == ''
r = subprocess.run(['cloud-init', 'status', '--format', 'json'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and json.loads(r.stdout)['status'] == 'done'
${state.quietBootstrap === "prelogin" ? preloginDataProof : `user_data = pathlib.Path('/var/lib/cloud/instance/user-data.txt')
assert not user_data.exists() or user_data.stat().st_size == 0`}
parent_pid = os.getppid()
assert parent_pid > 1 and parent_pid != os.getpid()
parent = pathlib.Path('/proc') / str(parent_pid)
parent_command = b'\\0'.join(os.fsencode(arg) for arg in ['/usr/bin/timeout', '25', '/usr/bin/python3'] + sys.argv) + b'\\0'
assert (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit() or int(entry.name) in [os.getpid(), parent_pid]:
        continue
    try:
        command = (entry / 'cmdline').read_bytes()
    except FileNotFoundError:
        continue
    assert b'/bench/' not in command and b'corten-bench-groups-' not in command
${pristine ? `    assert all(value not in command for value in [b'/bench', b'corten-bench-control-', b'corten-control'])
absent('/run/corten-bench-control-${state.token}')
absent('/bench')
` : ""}${settled ? `import re
${interrupted ? refusedUploadProof : ""}${settledDrain(interrupted)}

root = pathlib.Path('/run/corten-bench-control-${state.token}')
binding = json.loads(${JSON.stringify(JSON.stringify({ round: state.round, commit: state.commit, token: state.token, helperSha256: guardianSha256 }))})
requests = json.loads(${JSON.stringify(JSON.stringify(state.control.ledger.map(({ request }) => request)))})
with os.fdopen(os.open(root / 'helper.py', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as helper:
    source = helper.read(1048577)
assert len(source) <= 1048576 and hashlib.sha256(source).hexdigest() == binding['helperSha256']
namespace = {'__name__': '_settled_bootstrap_observation'}
exec(compile(source, 'bound-control-source', 'exec'), namespace)
assert namespace['read'](root / 'helper.py') == source
${interrupted ? "drained, refused" : "drained"} = settled_receipts(root, binding, requests, namespace)
` : ""}assert os.getppid() == parent_pid and (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
print(json.dumps(dict(schema='benchmark-unused-host/v1', hostId=host_id, unit=unit,
                     observedAtMs=int(time.time()*1000), unused=True${settled ? ", drainedReceipts=drained" : ""}${interrupted ? ", refusedUpload=refused" : ""})))
CORTEN_UNUSED_HOST`;
}

export function unusedEvidence(raw, state, script, startedAtMs, finishedAtMs, knownHostsSha256) {
  const interrupted = interruptedFirstUpload(state), settled = interrupted || settledBootstrap(state);
  if (knownHostsSha256 !== undefined) {
    assert.equal(typeof knownHostsSha256, "string"); assert.match(knownHostsSha256, /^[a-f0-9]{64}$/);
    assert.ok(settled || unusedBootstrap(state));
  }
  if (settled) assert.ok(knownHostsSha256 && script === unusedHostScript(state, { bootstrap: true }), "settled uploads require the pinned drain proof");
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 1024, "bounded unused proof required");
  const observation = JSON.parse(raw);
  assert.ok(observation && typeof observation === "object" && !Array.isArray(observation), "unused proof required");
  assert.deepEqual(Object.keys(observation).sort(), [...(settled ? ["drainedReceipts"] : []), "hostId", "observedAtMs", ...(interrupted ? ["refusedUpload"] : []), "schema", "unit", "unused"]);
  if (interrupted) {
    assert.equal(knownHostsSha256, state.launchHostKeySha256, "unused proof needs the original launch key");
    const failed = observation.refusedUpload;
    assert.deepEqual(Object.keys(failed).sort(), ["failureSha256", "invocationId", "jobPresent"]);
    assert.equal(failed.invocationId, state.control.ledger[2].request.invocation.id);
    assert.equal(failed.jobPresent, false);
    assert.match(failed.failureSha256, /^[a-f0-9]{64}$/);
  }
  if (settled) {
    const hashes = observation.drainedReceipts;
    assert.ok(Array.isArray(hashes) && hashes.length === state.control.ledger.length - Number(interrupted) && new Set(hashes).size === hashes.length
      && hashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)), "complete distinct drain receipts required");
  }
  assert.equal(observation.schema, "benchmark-unused-host/v1");
  assert.equal(observation.hostId, state.id); assert.equal(observation.unit, state.unit); assert.equal(observation.unused, true);
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && finishedAtMs - startedAtMs <= 30000, "unused observation exceeded its local window");
  assert.ok(Number.isSafeInteger(observation.observedAtMs) && observation.observedAtMs >= startedAtMs - 5000
    && observation.observedAtMs <= finishedAtMs + 5000, "unused observation clock differs");
  return { schema: "benchmark-unused-retirement/v1", round: state.round, commit: state.commit, id: state.id, unit: state.unit,
    scriptSha256: digest(script), observation, startedAtMs, finishedAtMs,
    ...(knownHostsSha256 === undefined ? {} : { knownHostsSha256 }) };
}

export function verifyUnusedEvidence(record, state) {
  const pinned = Object.hasOwn(record, "knownHostsSha256");
  const oldBootstrap = !pinned && unusedBootstrap(state) && state.control.ledger.length === 1;
  const current = unusedHostScript(state, { bootstrap: pinned });
  // Previous proof bytes still replay; they are never sent by the collector.
  const script = pinned || record.scriptSha256 === digest(current) ? current
    : unusedHostScript(state, { bootstrap: oldBootstrap, legacyTimestamp: true });
  assert.deepEqual(record, unusedEvidence(JSON.stringify(record.observation), state, script, record.startedAtMs, record.finishedAtMs, record.knownHostsSha256));
}

// The hashed guardian's watcher records only its own line number. This exact record
// means the session was still not drained when the watcher's loop reached its deadline.
// Any other line (an unowned scope participant, a changed listener or observer, a sample
// or row cap, a launcher or observation timing failure) is a different failure.
const deadlineLines = guardianSource.split("\n").flatMap((line, i) =>
  line === '    raise AssertionError("remote session drainage deadline expired")' ? [i + 1] : []);
assert.equal(deadlineLines.length, 1, "guardian drainage deadline line changed");
export const watcherDeadlineFailure = `{"helperLine":${deadlineLines[0]}}\n`;

// Only these refusals mean an archived watcher failure cannot select the drain proof.
// A custody read failure (a non-physical folder, an unreadable record) keeps its own
// error and is not reported as a missing proof.
export class SetupWatcherProofMissing extends Error {}
const proofMissing = (ok, message) => { if (!ok) throw new SetupWatcherProofMissing(message); };

// An archived watch-failure names an earlier bootstrap control whose watcher stopped
// before its receipt. Each must be exactly one settled bootstrap ledger row without an
// archived receipt, and must be the deadline expiry above. The record is diagnostic:
// it only selects the separate drain proof.
export function setupWatcherFailures(state, local) {
  const custody = join(local, state.evidence, "control");
  if (!lstatSync(custody, { throwIfNoEntry: false })) return [];
  physical(custody);
  const names = readdirSync(custody), failures = [];
  for (const name of names) {
    const id = /^watch-failure-([a-f0-9]{32})\.json$/.exec(name)?.[1];
    if (!id) continue;
    proofMissing(state.control, "watcher failure without a control ledger");
    const rows = state.control.ledger.filter((row) => row.request.invocation.id === id);
    proofMissing(rows.length === 1 && rows[0].request.epoch === "bootstrap" && rows[0].localTerminal === true && Number.isInteger(rows[0].code),
      "watcher failure outside the settled bootstrap ledger");
    proofMissing(!names.includes(`receipt-${id}.json`), "watcher failure beside its receipt");
    // The same bound as the custody comparison, so an oversized record is a different record, not a read failure.
    const bytes = regular(join(custody, name), 8 * 1024 * 1024);
    proofMissing(bytes.equals(Buffer.from(watcherDeadlineFailure)), "watcher failure is not a drainage deadline expiry");
    failures.push({ sequence: rows[0].request.sequence, id, failureSha256: digest(bytes) });
  }
  return failures.sort((a, b) => a.sequence - b.sequence).map(({ id, failureSha256 }) => ({ id, failureSha256 }));
}

// The common tooling marker does not prove native entry. Retirement still
// requires an absent or empty campaign, not a native benchmark result.
function setupControlExpected(state, exitCode, sequence, failures = []) {
  assert.equal(state.control.helperSha256, guardianSha256, "setup control source changed");
  assert.deepEqual(state.control.sealed, [], "sealed/native entry cannot use pre-entry retirement");
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0 && sequence < 4096 && sequence <= state.control.ledger.length);
  const rows = state.control.ledger.slice(0, sequence);
  assert.ok(rows.every((row) => row.localTerminal && !row.request.seal), "unsettled control cannot retire");
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  const expected = { binding: { round: state.round, commit: state.commit, token: state.token, helperSha256: guardianSha256 }, sequence,
    requests: rows.map((row) => row.request), queryArgv: ["/usr/bin/python3", "-", state.id, state.unit, JSON.stringify(files), String(exitCode)] };
  // Only an archived watcher failure adds this key, so every other query keeps its bytes.
  if (failures.length) expected.watcherFailures = failures.map(({ id, failureSha256 }) => {
    const row = rows.find((r) => r.request.invocation.id === id);
    assert.ok(row && row.request.epoch === "bootstrap" && failureSha256 === digest(watcherDeadlineFailure), "failed watcher outside the earlier bootstrap ledger");
    return { id, code: row.code, failureSha256 };
  });
  return expected;
}
export function terminalSetupScript(state, exitCode, sequence = state.control?.ledger.length, failures = []) {
  assert.ok(Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 255, "nonzero setup exit code required");
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  assert.deepEqual(Object.keys(files).sort(), ["job.sh", "pack.sh", state.unit].sort());
  const marker = `${JSON.stringify(bootstrapMarker(state))}\n`, observed = state.bootstrapReady !== undefined;
  assert.ok(Buffer.byteLength(marker) <= 1024, "bounded common bootstrap marker required");
  if (observed) {
    assert.ok(state.bootstrapReady && typeof state.bootstrapReady === "object" && !Array.isArray(state.bootstrapReady), "saved bootstrap observation required");
    assert.equal(state.bootstrapReady.sha256, digest(marker), "saved bootstrap marker differs");
  }
  assert.ok(Array.isArray(failures) && (state.control || failures.length === 0), "watcher failures need a control ledger");
  const expected = state.control ? setupControlExpected(state, exitCode, sequence, failures) : null, drain = failures.length > 0;
  // The drain proof is a separate fixed source, run after the guardian in its namespace.
  const drainHeader = drain ? `exec(compile(${JSON.stringify(setupDrainSource)}, '<fixed-setup-drain-source>', 'exec'), control_namespace)\n` : "";
  const controlHeader = expected ? `control_namespace = {'__name__': 'fixed_setup_control'}
exec(compile(${JSON.stringify(guardianSource)}, '<fixed-control-source>', 'exec'), control_namespace)
${drainHeader}control_expected = json.loads(${JSON.stringify(JSON.stringify(expected))})
control_proof = control_namespace['${drain ? "setup_drain_query" : "setup_query"}'](control_namespace['root_for'](${quote(state.token)}), control_expected)
` : "";
  return `/usr/bin/timeout 25 /usr/bin/python3 - ${quote(state.id)} ${quote(state.unit)} ${quote(JSON.stringify(files))} ${quote(String(exitCode))} <<'CORTEN_FAILED_SETUP_HOST'
import hashlib, json, os, pathlib, stat, subprocess, sys, time, urllib.request
host_id, unit, manifest, expected_code = sys.argv[1:]
files = json.loads(manifest)
expected_marker = ${JSON.stringify(marker)}.encode('ascii')
require_marker = ${observed ? "True" : "False"}
def failed(kind, value, traceback):
    print(json.dumps(dict(schema='benchmark-failed-setup-host/v1', setupFailed=False)))
sys.excepthook = failed
assert os.getuid() == 0
assert expected_code.isascii() and expected_code.isdecimal() and str(int(expected_code)) == expected_code and 1 <= int(expected_code) <= 255
with urllib.request.urlopen('http://169.254.169.254/metadata/v1/id', timeout=3) as response:
    assert response.read(64).decode().strip() == host_id
properties = ['Id', 'LoadState', 'ActiveState', 'MainPID', 'FragmentPath', 'ExecMainStartTimestamp', 'Job', 'Restart']
r = subprocess.run(['systemctl', 'show', unit] + ['--property=' + p for p in properties], capture_output=True, text=True, timeout=5)
assert r.returncode == 0
lines = r.stdout.splitlines()
assert len(lines) == len(properties) and all('=' in line for line in lines)
values = dict(line.split('=', 1) for line in lines)
assert set(values) == set(properties) and values['Id'] == unit
assert values['LoadState'] == 'loaded' and values['FragmentPath'] == '/etc/systemd/system/' + unit
assert values['ActiveState'] in ['inactive', 'failed'] and values['MainPID'] == '0' and values['Restart'] == 'no'
assert values['ExecMainStartTimestamp'].strip() not in ['', 'n/a'] and values['Job'] == ''
def regular(path, limit=None):
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and (limit is None or info.st_size <= limit)
def control(path, name):
    regular(path, 1048576)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == files[name]
def common_marker(path):
    regular(path, 1024)
    assert path.read_bytes() == expected_marker
${controlHeader}bench = pathlib.Path('/bench')
assert stat.S_ISDIR(bench.lstat().st_mode)
marker_path = bench / 'bootstrap-ready.json'
if os.path.lexists(marker_path):
    common_marker(marker_path)
else:
    assert not require_marker
for name in files:
    control(bench / name, name)
for entry in bench.iterdir():
    if entry.name in files:
        control(entry, entry.name)
    elif entry.name == 'bootstrap-ready.json':
        common_marker(entry)
${expected ? "    elif entry.name == 'control':\n        control_namespace['private'](entry)\n" : ""}    elif entry.name in ['run.log', 'host.txt', 'exit-code', 'results.tgz']:
        regular(entry)
    else:
        assert entry.name in ['repo', 'campaign'] and stat.S_ISDIR(entry.lstat().st_mode)
        if entry.name == 'campaign':
            assert next(iter(entry.iterdir()), None) is None
code_file = bench / 'exit-code'
regular(code_file, 4)
assert code_file.read_bytes() == (expected_code + '\\n').encode('ascii')
control(pathlib.Path('/etc/systemd/system') / unit, unit)
for base in ['/etc/systemd/system', '/run/systemd/system']:
    for entry in pathlib.Path(base).glob('corten-bench*'):
        assert str(entry) == '/etc/systemd/system/' + unit
        control(entry, unit)
r = subprocess.run(['systemctl', 'list-jobs', '--no-legend', '--no-pager'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and r.stdout.strip() == ''
r = subprocess.run(['cloud-init', 'status', '--format', 'json'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and json.loads(r.stdout)['status'] == 'done'
${state.quietBootstrap === "prelogin" ? preloginDataProof : `user_data = pathlib.Path('/var/lib/cloud/instance/user-data.txt')
if os.path.lexists(user_data):
    regular(user_data, 0)`}
if os.path.lexists('/run/docker.sock') or os.path.lexists('/run/containerd/containerd.sock'):
    r = subprocess.run(['docker', 'ps', '--quiet', '--no-trunc'], capture_output=True, text=True, timeout=5)
    assert r.returncode == 0 and r.stdout.strip() == ''
parent_pid = os.getppid()
assert parent_pid > 1 and parent_pid != os.getpid()
parent = pathlib.Path('/proc') / str(parent_pid)
parent_command = b'\\0'.join(os.fsencode(arg) for arg in ['/usr/bin/timeout', '25', '/usr/bin/python3'] + sys.argv) + b'\\0'
assert (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit() or int(entry.name) in [os.getpid(), parent_pid]:
        continue
    try:
        command = (entry / 'cmdline').read_bytes()
        assert b'/bench' not in command and b'corten-bench-groups-' not in command
        for name in ['cwd', 'exe']:
            try:
                target = os.readlink(entry / name)
            except FileNotFoundError:
                continue
            assert '/bench' not in target and 'corten-bench-groups-' not in target
    except FileNotFoundError:
        continue
assert os.getppid() == parent_pid and (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
print(json.dumps(dict(schema='benchmark-failed-setup-host/${expected ? drain ? "v3" : "v2" : "v1"}', hostId=host_id, unit=unit,
                     observedAtMs=int(time.time()*1000), exitCode=int(expected_code), setupFailed=True${expected ? ", control=control_proof" : ""})))
CORTEN_FAILED_SETUP_HOST`;
}

export function setupEvidence(raw, state, script, exitCode, startedAtMs, finishedAtMs, local) {
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= (state.control ? 8 * 1024 * 1024 : 1024), "bounded setup proof required");
  for (const key of ["archiveSha256", "evidenceSha256"])
    assert.ok(typeof state[key] === "string" && state[key].length === 64 && /^[a-f0-9]{64}$/.test(state[key]), "preserved setup evidence hash required");
  const observation = JSON.parse(raw);
  assert.ok(observation && typeof observation === "object" && !Array.isArray(observation), "setup proof required");
  const sequence = state.control ? observation.control.requests.length - 1 : undefined;
  // The preserved archive, not the receipt, decides whether a watcher failure needs the drain proof.
  const failures = state.control && typeof local === "string" ? setupWatcherFailures(state, local) : [], version = state.control ? failures.length ? "v3" : "v2" : "v1";
  // The drain proof exists only for a pre-registration bootstrap; after registration stream state can exist.
  assert.ok(!failures.length || state.preBootstrapTerminal, "drained watcher retirement requires pre-registration custody");
  assert.ok(typeof script === "string" && script === terminalSetupScript(state, exitCode, sequence, failures), "fixed setup script required");
  assert.deepEqual(Object.keys(observation).sort(), [...(state.control ? ["control"] : []), "exitCode", "hostId", "observedAtMs", "schema", "setupFailed", "unit"]);
  assert.equal(observation.schema, `benchmark-failed-setup-host/${version}`);
  assert.equal(observation.hostId, state.id); assert.equal(observation.unit, state.unit);
  assert.equal(observation.setupFailed, true); assert.equal(observation.exitCode, exitCode);
  if (state.control) {
    assert.equal(sequence, state.control.ledger.length - 1, "setup query is not the final registered control");
    const expected = setupControlExpected(state, exitCode, sequence, failures), proof = observation.control;
    verifyControlSetupQuery(expected, proof);
    const row = state.control.ledger[sequence];
    assert.equal(row.localTerminal, true); assert.equal(row.code, 0);
    assert.deepEqual(row.request, proof.requests.at(-1));
    assert.equal(row.request.invocation.requestSha256, digest(`set -euo pipefail\n${script}\n`), "setup query payload source differs");
    const drained = new Map((failures.length ? proof.drained : []).map((entry) => [entry.id, entry]));
    for (let i = 0; i < sequence; i++) {
      const entry = drained.get(proof.requests[i].invocation.id);
      if (entry) { assert.equal(entry.result.code, state.control.ledger[i].code); continue; }
      assert.equal(proof.receipts[i].result.code, state.control.ledger[i].code);
      verifyControlWatcher(proof.requests[i].invocation, proof.receipts[i], proof.watchers[i]);
    }
    assert.equal(typeof local, "string", "original control custody required");
    const custody = join(local, state.evidence, "control"); physical(custody);
    assert.deepEqual(readdirSync(custody).sort(), proof.custody.map((entry) => entry.name).sort(), "original control custody inventory differs");
    for (const entry of proof.custody) {
      const bytes = regular(join(custody, entry.name), 8 * 1024 * 1024);
      assert.equal(bytes.length, entry.bytes); assert.equal(digest(bytes), entry.sha256, "original control custody bytes differ");
    }
  }
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && finishedAtMs - startedAtMs <= 30000, "setup observation exceeded its local window");
  assert.ok(Number.isSafeInteger(observation.observedAtMs) && observation.observedAtMs >= startedAtMs - 5000
    && observation.observedAtMs <= finishedAtMs + 5000, "setup observation clock differs");
  return { schema: `benchmark-failed-setup-retirement/${version}`, round: state.round, commit: state.commit, id: state.id, unit: state.unit,
    archiveSha256: state.archiveSha256, evidenceSha256: state.evidenceSha256, exitCode, scriptSha256: digest(script),
    observation, startedAtMs, finishedAtMs };
}

export const failedSetupRetirementFile = "failed-setup-host.json";
export function verifyFailedSetupRetirement(local, state) {
  assert.equal(state.retirement?.kind, "setup-failed");
  const bytes = regular(join(local, failedSetupRetirementFile), state.control ? 8 * 1024 * 1024 : 4096);
  assert.equal(digest(bytes), state.retirement.evidenceSha256, "setup retirement receipt changed");
  const record = JSON.parse(bytes);
  const extracted = join(local, state.evidence), campaign = join(extracted, "campaign");
  assert.equal(fileHash(join(local, "results.tgz")), state.archiveSha256, "setup archive changed");
  assert.equal(treeHash(extracted), state.evidenceSha256, "setup evidence changed");
  if (lstatSync(campaign, { throwIfNoEntry: false })) {
    physical(campaign);
    assert.equal(readdirSync(campaign).length, 0, "native evidence cannot use setup retirement");
  }
  const marker = regular(join(extracted, "exit-code"), 16).toString("utf8"), exit = Number(marker.trim());
  assert.ok(/^[1-9]\d{0,2}\n$/.test(marker) && exit <= 255, "nonzero setup exit required");
  // The same archived watcher failures the collect path selected; setupEvidence rereads them
  // and refuses a failure without pre-registration custody.
  const failures = state.control ? setupWatcherFailures(state, local) : [];
  const script = terminalSetupScript(state, exit, state.control ? state.control.ledger.length - 1 : undefined, failures);
  const expected = setupEvidence(JSON.stringify(record.observation), state, script, exit, record.startedAtMs, record.finishedAtMs, local);
  assert.ok(isDeepStrictEqual(record, expected), "setup retirement receipt differs");
}
