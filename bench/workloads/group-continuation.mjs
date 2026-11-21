// A read-only index of original group attempts, not a fleet or launch intent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { roundName, selection } from "./cloud-contract.mjs";
import { digest, physical } from "./cloud-local.mjs";
import { full } from "./cloud-options.mjs";
import { continuationIndex, continuationIndexSha256, fleetLockSnapshot, fleetRoot, outside, present, readFleet, readGroup, readLaunchIntent,
  recheckCollectedGroup, verifyFleet } from "./fleet-verify.mjs";

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

async function measuredReplay(repo, checkout, commit) {
  assert.equal(git(checkout, "rev-parse", "--verify", "HEAD^{commit}").trim(), commit, "use the original measured checkout");
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

const acceptable = (row) => ["missing", "verified", "native-failed-retired", "setup-failed-retired", "unused-retired"].includes(row.outcome)
  || ["failed", "blocked"].includes(row.outcome) && !!row.destroyedAt;

// inspect is a synthetic in-process test seam. On the CLI every accepted result
// comes from the measured native replay; index entries are references, not verdicts.
export async function inspectContinuation(root, { repo, interrupted, inspect } = {}) {
  root = fleetRoot(root, repo);
  const bytes = continuationIndex(root), indexSha256 = digest(bytes), index = JSON.parse(bytes);
  assert.ok(Array.isArray(index) && index.length <= names.length, "invalid continuation index");
  const members = () => readdirSync(root).filter((name) => name !== continuationLock).sort();
  const paths = members();
  assert.ok(paths.every((name) => name === "index.json" || name === continuationLock || names.includes(name)), "continuation root members differ");
  const attempts = new Map(names.map((group) => [group, []])), slots = new Map(), sources = new Set(), ids = new Set();
  const proofs = [], manifests = [], states = [], needsCensus = new Set();
  const read = async (fleet, checkout, archives) => {
    const { manifest, manifestSha256 } = fleet, { round, commit } = manifest;
    const lock = fleetLockSnapshot(fleet.root);
    assert.notEqual(lock, "busy", "continuation source has an active batch");
    manifests.push({ ...fleet, lock });
    const replay = inspect ? { inspect } : await measuredReplay(repo, checkout, commit);
    const report = await verifyFleet({ root: fleet.root, round, commit }, { ...replay, interrupted, details: true, priorSelection: true });
    assert.ok(!report.error, report.error);
    assert.equal(report.manifestSha256, manifestSha256, "continuation manifest changed");
    for (const row of report.groups) {
      const { group, outcome } = row;
      const saved = readGroup(fleet, group);
      assert.equal(saved.stateSha256, row.stateSha256, "continuation state changed");
      states.push({ fleet, group, stateSha256: saved.stateSha256, outcome: saved.outcome });
      const selected = manifest.selection.groups.find((s) => s.group === group);
      const matches = groups.groups.some((s) => s.group === group && s.contractSha256 === selected.contractSha256
        && JSON.stringify(s.apps) === JSON.stringify(selected.apps));
      const reusable = outcome === "verified" && matches;
      if (archives) {
        const pinned = Object.hasOwn(archives, group);
        assert.equal(reusable, pinned, `retained ${group} must have a compatible replayed archive pin`);
        if (pinned) assert.equal(row.archiveSha256, archives[group], `retained ${group} archive changed`);
      }
      if (row.id) {
        assert.ok(!ids.has(row.id), "duplicate continuation host identity"); ids.add(row.id);
      }
      if (reusable) {
        if (manifest.single) readLaunchIntent(fleet);
        const { stateSha256, archiveSha256, evidenceSha256 } = row;
        proofs.push({ fleet, snapshot: { group, stateSha256, archiveSha256, evidenceSha256 } });
      }
      // A historic host can have preserved failure bytes behind an invalid
      // monitor, without deletion confirmation. A bound host cannot be created
      // again by its old controller. The new launch still has to prove that no
      // foreign benchmark host is present in that same account's create census.
      const censusRequired = !!(archives && row.id && ["busy", "uncollected", "cleanup-pending"].includes(outcome)
        && saved.state.validation?.status !== "verified");
      if (censusRequired) needsCensus.add(manifest.provider.accountId);
      assert.ok(attempts.has(group) || censusRequired || acceptable(row), "unresolved custody for a historical group");
      attempts.get(group)?.push({ ...row, ...(outcome === "verified" && !reusable ? { outcome: "incompatible" } : {}),
        round, commit, manifestSha256, selection: selected,
        ...(censusRequired ? { cleanupUnconfirmed: true } : {}),
        ...(row.archiveSha256 ? { archive: `${group}/groups-${round}/results.tgz` } : {}) });
    }
  };
  for (const entry of index) {
    keys(entry, ["archives", "checkout", "commit", "root", "round"]);
    const saved = fleetRoot(entry.root, repo), checkout = fleetRoot(entry.checkout);
    assert.ok(outside(root, saved) && outside(saved, root) && !sources.has(saved), "retained fleet root must be separate and unique");
    sources.add(saved); physical(checkout);
    full(entry.commit, /[a-f0-9]{40}/, "retained commit"); roundName(entry.round);
    assert.equal(Object.getPrototypeOf(entry.archives), Object.prototype, "archive pins required");
    const fleet = readFleet(saved, entry.round, { priorSelection: true });
    assert.ok(!fleet.manifest.single && fleet.manifest.commit === entry.commit, "retained fleet source differs");
    for (const [group, hash] of Object.entries(entry.archives)) {
      assert.ok(fleet.manifest.jobs.some((job) => job.group === group), "unknown retained group");
      full(hash, /[a-f0-9]{64}/, "retained archive pin");
    }
    await read(fleet, checkout, entry.archives);
  }
  for (const group of names.filter((name) => paths.includes(name))) {
    const slot = join(root, group);
    physical(slot);
    const files = readdirSync(slot).filter((name) => /^fleet-r[1-9]\d{0,8}\.json$/.test(name));
    assert.equal(files.length, 1, `ambiguous continuation slot: ${group}`);
    const fleet = readFleet(slot, files[0].slice(6, -5), { priorSelection: true });
    assert.equal(fleet.manifest.single?.group, group, "independent reservation required");
    assert.equal(fleet.manifest.single.indexSha256, indexSha256, "continuation index changed");
    slots.set(group, fleet);
    await read(fleet, fleetRoot(fleet.manifest.single.checkout));
    const row = attempts.get(group).at(-1);
    if (row.outcome === "missing") row.outcome = present(join(slot, "launch-intent.json")) ? "attempt-consumed" : "prepared";
  }
  const rows = names.map((group) => {
    const history = attempts.get(group), verified = history.filter((row) => row.outcome === "verified");
    assert.ok(verified.length < 2, `duplicate verified group: ${group}`);
    const blocked = history.some((row) => !acceptable(row) && !["prepared", "incompatible"].includes(row.outcome) && !row.cleanupUnconfirmed);
    return { group, outcome: blocked ? "blocked" : verified.length ? "verified" : slots.has(group) ? history.at(-1).outcome : "missing",
      ...(blocked ? { unresolved: true } : {}), ...(verified.length ? { result: verified[0] } : {}), attempts: history };
  });
  const recheck = (operatingRoot) => {
    assert.ok(!interrupted?.());
    assert.equal(continuationIndexSha256(root), indexSha256, "continuation index changed");
    assert.deepEqual(members(), paths, "continuation slots changed");
    for (const { root, manifest, manifestSha256, lock } of manifests) {
      assert.equal(readFleet(root, manifest.round, { priorSelection: true }).manifestSha256, manifestSha256);
      if (root !== operatingRoot) assert.equal(fleetLockSnapshot(root), lock, "continuation source lock changed");
    }
    for (const { fleet, group, stateSha256, outcome } of states) {
      const current = readGroup(fleet, group);
      assert.equal(current.stateSha256, stateSha256, "continuation state changed");
      assert.equal(current.outcome, outcome, "continuation custody changed");
    }
    for (const { fleet, snapshot } of proofs) recheckCollectedGroup(fleet, snapshot);
  };
  recheck();
  const subject = { indexSha256, verified: proofs.map(({ fleet, snapshot }) => ({ root: fleet.root, round: fleet.manifest.round,
    manifestSha256: fleet.manifestSha256, ...snapshot })) };
  const eligibleToRun = rows.some((row) => row.unresolved) ? [] : rows.filter((row) => ["missing", "prepared"].includes(row.outcome)).map((row) => row.group);
  return { root, indexSha256, slots, needsCensus, recheck, subject,
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
