// Read-only fleet inventory. Receipts are diagnostics, never evidence authority.
import assert from "node:assert/strict";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { roundName, validateFleet } from "./cloud-contract.mjs";
import { campaignOutcome, controllerState, full } from "./cloud-options.mjs";
import { digest, fileHash, physical, regular, resolveStateRoot, treeHash } from "./cloud-local.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";

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
export function readFleet(root, round) {
  roundName(round); physical(root);
  const path = join(root, `fleet-${round}.json`), bytes = regular(path, 1024 * 1024), manifest = validateFleet(JSON.parse(bytes));
  assert.equal(manifest.round, round);
  const allowed = new Set([`fleet-${round}.json`, ".fleet-operation.lock", "launch-intent.json", "receipts", ...manifest.jobs.map((j) => j.group)]);
  assert.ok(readdirSync(root).every((name) => allowed.has(name)), "fleet-root-members");
  return { root, path, bytes, manifest, manifestSha256: digest(bytes) };
}
export function readGroup(fleet, group) {
  assert.ok(fleet.manifest.jobs.some((j) => j.group === group));
  physical(fleet.root);
  const stateRoot = join(fleet.root, group), local = join(stateRoot, `groups-${fleet.manifest.round}`);
  if (!present(stateRoot)) return { group, outcome: "missing" };
  physical(stateRoot);
  if (!present(local)) return { group, outcome: "ambiguous" };
  physical(local);
  const bytes = regular(join(local, "state.json"), 1024 * 1024), state = controllerState(JSON.parse(bytes), fleet.manifest.round);
  assert.equal(state.schema, "benchmark-dedicated-group-host/v1");
  assert.equal(state.group, group); assert.deepEqual(state.fleet, fleet.manifest);
  assert.deepEqual(state.provider, fleet.manifest.provider);
  return { group, stateRoot, local, state, stateSha256: digest(bytes), outcome: present(join(local, "operation.lock")) ? "busy"
    : ["running", "collected"].includes(state.status) ? "available" : "ambiguous" };
}

function evidenceSnapshot(job) {
  physical(job.local);
  const s = job.state, extracted = join(job.local, s.evidence);
  assert.equal(fileHash(join(job.local, "results.tgz")), s.archiveSha256);
  assert.equal(treeHash(extracted), s.evidenceSha256);
  assert.equal(digest(regular(join(job.local, "state.json"), 1024 * 1024)), job.stateSha256);
  return { stateSha256: job.stateSha256, archiveSha256: s.archiveSha256, evidenceSha256: s.evidenceSha256 };
}

// inspect is an in-process synthetic TEST seam only. The CLI never accepts code,
// module paths, reports or commands from JSON. Default replay imports fixed code.
export async function verifyFleet({ root, round, commit }, { inspect, interrupted = () => false } = {}) {
  const base = { schema: "benchmark-group-fleet-inspection/v1", scope: "intrinsic-evidence", status: "incomplete",
    evidenceMode: inspect ? "synthetic-inspection" : "native-replay", nativeReadiness: false,
    publishableBaseline: false, comparisonScope: "within-group-host-only" };
  let fleet;
  try {
    full(commit, /[a-f0-9]{40}/, "fleet-source");
    fleet = readFleet(fleetRoot(root), round); assert.equal(fleet.manifest.commit, commit);
  } catch { return { ...base, error: "fleet-invalid", groups: [] }; }
  const result = { ...base, round, commit, fleetSha256: fleet.manifest.fleetSha256,
    manifestSha256: fleet.manifestSha256, selection: fleet.manifest.selection, groups: [] };
  const snapshots = [], identities = new Set();
  let duplicate = false;
  for (const { group } of fleet.manifest.jobs) {
    let job;
    try {
      job = readGroup(fleet, group);
      if (job.state?.id) {
        for (const key of [`id:${job.state.id}`, `ip:${job.state.ip}`]) {
          if (identities.has(key)) duplicate = true;
          identities.add(key);
        }
      }
      if (job.outcome !== "available") { result.groups.push({ group, outcome: job.outcome }); continue; }
      const s = job.state;
      if (s.status !== "collected" || !s.collectedAt) { result.groups.push({ group, outcome: "uncollected" }); continue; }
      assert.ok(!interrupted());
      const hashes = evidenceSnapshot(job), folder = join(job.local, s.evidence, "campaign");
      // The existing bounded worker lazily imports the fixed native verifier,
      // drains private output and confirms worker exit before consuming a report.
      const report = await inspectCampaign(Object.freeze({ folder, round, commit }), { inspect, interrupted });
      assert.ok(!interrupted());
      campaignOutcome(report, s, s.exitCode);
      assert.deepEqual(report.selection, s.selection);
      assert.equal(report.campaign, s.validation.campaign); assert.equal(report.status, s.validation.status);
      assert.equal(s.evidenceOutcome, report.status === "verified" ? "validated" : report.status);
      // Native replay binds its source closure. Bind its public identities back
      // to the saved plan/reservation too, never to a supplied summary receipt.
      const reservation = JSON.parse(regular(join(folder, ".host-attempt.json"), 1024 * 1024));
      const plan = JSON.parse(regular(join(folder, report.campaign, "plan.json"), 16 * 1024 ** 2));
      assert.equal(reservation.commit, commit); assert.equal(reservation.id, report.campaign);
      assert.equal(reservation.campaignSha256, report.campaignSha256);
      assert.equal(digest(regular(join(folder, ".host-attempt.json"), 1024 * 1024)), report.reservationSha256);
      assert.equal(plan.commit, commit); assert.equal(plan.round, round);
      assert.equal(plan.campaignSha256, report.campaignSha256); assert.equal(plan.sourceSha256, report.sourceSha256);
      const marker = regular(join(job.local, s.evidence, "exit-code"), 16).toString("ascii");
      assert.equal(marker, `${s.exitCode}\n`);
      assert.deepEqual(evidenceSnapshot(job), hashes);
      snapshots.push({ job, hashes });
      const outcome = !s.destroyedAt || !s.deletionIntentAt ? "cleanup-pending" : report.status === "verified" ? "verified" : report.status;
      const hardwareEvidence = { artifact: `${group}/groups-${round}/${s.evidence}/host.txt`, sha256: fileHash(join(job.local, s.evidence, "host.txt")) };
      result.groups.push({ group, outcome, id: s.id, host: s.host, hardwareEvidence,
        nativeTimingEvidence: { artifact: `${group}/groups-${round}/${s.evidence}/campaign`, archiveTreeSha256: report.archiveTreeSha256,
          scope: "saved-native-journal-and-raw-timings-not-cross-host-comparable" },
        recordedTimes: { reservationCreatedAt: s.createdAt, collectedAt: s.collectedAt, ...(s.destroyedAt ? { destroyedAt: s.destroyedAt } : {}) },
        timeScope: "reservation-and-collection-not-provider-billing-or-benchmark-elapsed", ...hashes, campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256,
        ...(report.status === "verified" ? { appOutcomes: report.groups[0].appOutcomes.map(({ app, outcome, comparisonEligible }) => ({ app, outcome, comparisonEligible })) } : {}) });
    } catch { result.groups.push({ group, outcome: "error", error: "group-evidence-invalid" }); }
  }
  try {
    assert.ok(!interrupted());
    assert.ok(!present(join(fleet.root, ".fleet-operation.lock")), "fleet-operation-active");
    assert.equal(readFleet(fleet.root, round).manifestSha256, fleet.manifestSha256);
    for (const { job, hashes } of snapshots) {
      const current = readGroup(fleet, job.group);
      assert.equal(current.outcome, "available"); assert.equal(current.stateSha256, job.stateSha256);
      assert.deepEqual(evidenceSnapshot(current), hashes);
    }
    assert.ok(!duplicate);
  } catch { return { ...result, error: "fleet-evidence-changed-or-duplicated" }; }
  if (result.groups.every((g) => g.outcome === "verified")) result.status = "verified";
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
