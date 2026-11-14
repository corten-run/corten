// Synthetic saved artifacts only. These cannot establish native readiness.
import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import { accountId, archive, commit, context, harness, syntheticInspection } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { digest, fileHash, treeHash } from "./cloud-local.mjs";
import { groupNames } from "./registry.mjs";
import { verifyFleet, verifyFleetCli } from "./fleet-verify.mjs";

function fixture(t) {
  const h = harness(t), at = "2026-11-14T00:00:00.000Z";
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16),
    tokens: Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")])),
    provider: { accountId, context }, sshKey: "42" }, at);
  const manifestPath = join(h.base, "fleet-r21.json"); writeFileSync(manifestPath, JSON.stringify(fleet));
  const reports = new Map(), jobs = new Map(), calls = [];
  function seed(group) {
    const i = groupNames.indexOf(group), local = join(h.base, group, "groups-r21"), evidence = join(local, "evidence-Synthetic");
    const report = syntheticInspection("verified");
    Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", campaign: `r21-${fleet.jobs[i].token}`,
      selection: { ...fleet.selection, groups: fleet.selection.groups.filter((g) => g.group === group) }, groups: report.groups.filter((g) => g.group === group) });
    const folder = join(evidence, "campaign"), planPath = join(folder, report.campaign, "plan.json"), reservationPath = join(folder, ".host-attempt.json");
    mkdirSync(join(folder, report.campaign), { recursive: true });
    writeFileSync(reservationPath, JSON.stringify({ schema: "benchmark-isolated-campaign-reservation/v1", id: report.campaign, commit, campaignSha256: report.campaignSha256 }));
    report.reservationSha256 = digest(readFileSync(reservationPath));
    writeFileSync(planPath, JSON.stringify({ round: "r21", commit, campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256 }));
    writeFileSync(join(evidence, "exit-code"), "0\n"); writeFileSync(join(evidence, "host.txt"), "SYNTHETIC hardware, not measured\n");
    writeFileSync(join(evidence, "run.log"), "SYNTHETIC no native measurement\n");
    const archivePath = join(local, "results.tgz"); writeFileSync(archivePath, archive([{ name: "campaign/" }]));
    const state = { ...reservation({ round: "r21", commit, token: fleet.jobs[i].token, group, fleet }, at),
      provider: fleet.provider, fullGroupQualified: false, status: "collected", createIntentAt: at,
      id: String(i + 1), ip: `192.0.2.${i + 1}`, archiveSha256: fileHash(archivePath),
      evidence: "evidence-Synthetic", extractionAttempts: ["evidence-Synthetic"], evidenceSha256: treeHash(evidence),
      evidenceOutcome: "validated", exitCode: 0, collectedAt: at, deletionIntentAt: at, destroyedAt: at,
      validation: { status: "verified", campaign: report.campaign, collectionIntegrity: "manifest-verified" } };
    const path = join(local, "state.json"); writeFileSync(path, JSON.stringify(state));
    const job = { group, local, evidence, folder, path, state, report, planPath, reservationPath, archivePath,
      save() { writeFileSync(path, JSON.stringify(state)); }, rehash() { state.evidenceSha256 = treeHash(evidence); this.save(); } };
    reports.set(folder, report); jobs.set(group, job); return job;
  }
  const input = { root: h.base, round: "r21", commit };
  const inspect = async (input) => { calls.push(input); assert.deepEqual(Object.keys(input).sort(), ["commit", "folder", "round"]); return reports.get(input.folder); };
  return { h, fleet, manifestPath, input, inspect, calls, jobs, seed,
    seedAll() { groupNames.forEach(seed); }, verify(deps = {}) { return verifyFleet(input, { inspect, ...deps }); } };
}

test("all current groups replay individually; hardware/hash references and failed app outcomes remain per host", async (t) => {
  const p = fixture(t); p.seedAll();
  const app = p.jobs.get(groupNames[0]).report.groups[0].appOutcomes[0];
  Object.assign(app, { outcome: "failed", comparisonEligible: false });
  const unsupported = p.jobs.get(groupNames[1]).report.groups[0].appOutcomes[0];
  Object.assign(unsupported, { outcome: "unsupported", comparisonEligible: false });
  const before = treeHash(p.h.base), result = await p.verify();
  assert.equal(result.schema, "benchmark-group-fleet-inspection/v1"); assert.equal(result.status, "verified");
  assert.equal(result.evidenceMode, "synthetic-inspection"); assert.equal(result.nativeReadiness, false); assert.equal(result.publishableBaseline, false);
  assert.equal(result.comparisonScope, "within-group-host-only");
  assert.deepEqual(result.groups.map((g) => g.group), groupNames); assert.equal(p.calls.length, groupNames.length);
  assert.deepEqual(result.groups[0].appOutcomes[0], app); assert.deepEqual(result.groups[1].appOutcomes[0], unsupported);
  for (const row of result.groups) {
    assert.deepEqual(row.host, p.fleet.host); assert.equal(row.id, p.jobs.get(row.group).state.id);
    assert.equal(row.hardwareEvidence.sha256, digest(readFileSync(join(p.jobs.get(row.group).evidence, "host.txt"))));
    assert.equal(row.stateSha256, digest(readFileSync(p.jobs.get(row.group).path)));
    assert.equal(row.recordedTimes.reservationCreatedAt, p.jobs.get(row.group).state.createdAt);
    assert.match(row.timeScope, /not-provider-billing-or-benchmark-elapsed/);
  }
  assert.equal(treeHash(p.h.base), before, "inspection must be read-only");
});

test("missing, live, busy, ambiguous and cleanup-pending groups keep a partial fleet incomplete", async (t) => {
  const p = fixture(t);
  const pending = p.seed(groupNames[0]); delete pending.state.destroyedAt; pending.save();
  const live = p.seed(groupNames[1]); Object.assign(live.state, { status: "running" });
  for (const key of ["collectedAt", "destroyedAt", "deletionIntentAt"]) delete live.state[key]; live.save();
  const busy = p.seed(groupNames[2]); writeFileSync(join(busy.local, "operation.lock"), "SYNTHETIC-live");
  const ambiguous = p.seed(groupNames[3]); Object.assign(ambiguous.state, { status: "creating" });
  for (const key of ["id", "ip", "collectedAt", "destroyedAt", "deletionIntentAt"]) delete ambiguous.state[key]; ambiguous.save();
  const result = await p.verify(); assert.equal(result.status, "incomplete"); assert.equal(result.publishableBaseline, false);
  assert.deepEqual(result.groups.slice(0, 4).map((r) => r.outcome), ["cleanup-pending", "uncollected", "busy", "ambiguous"]);
  assert.ok(result.groups.slice(4).every((r) => r.outcome === "missing")); assert.equal(p.calls.length, 1);
});

test("strict roster, source and all original replay/lifecycle gates cannot be supplied by receipts", async (t) => {
  for (const kind of ["manifest", "source", "schema", "selection", "lifecycle", "pending", "raw", "exit", "eligibility", "plan-source", "reservation", "archive", "tree", "duplicate-id", "duplicate-ip", "active-operation"]) {
    const p = fixture(t); p.seedAll(); const j = p.jobs.get(groupNames[0]);
    if (kind === "manifest") { const f = structuredClone(p.fleet); f.jobs.reverse(); writeFileSync(p.manifestPath, JSON.stringify(f)); }
    if (kind === "source") p.input.commit = "b".repeat(40);
    if (kind === "schema") j.report.schema = "benchmark-isolated-campaign-inspection/v1";
    if (kind === "selection") j.report.selection = p.fleet.selection;
    if (kind === "lifecycle") j.report.commandLifecycle = "incomplete-preserved";
    if (kind === "pending") j.report.uncollectedNativeRoots = [{ group: groupNames[0] }];
    if (kind === "raw") j.report.collectionIntegrity = "unsealed-partial";
    if (kind === "exit") { writeFileSync(join(j.evidence, "exit-code"), "2\n"); j.rehash(); }
    if (kind === "eligibility") Object.assign(j.report.groups[0].appOutcomes[0], { outcome: "failed", comparisonEligible: true });
    if (kind === "plan-source") { const plan = JSON.parse(readFileSync(j.planPath)); plan.sourceSha256 = "f".repeat(64); writeFileSync(j.planPath, JSON.stringify(plan)); j.rehash(); }
    if (kind === "reservation") { appendFileSync(j.reservationPath, " "); j.rehash(); }
    if (kind === "archive") appendFileSync(j.archivePath, "tampered");
    if (kind === "tree") appendFileSync(join(j.evidence, "host.txt"), "tampered");
    if (kind === "duplicate-id" || kind === "duplicate-ip") { const other = p.jobs.get(groupNames[1]); other.state[kind === "duplicate-id" ? "id" : "ip"] = j.state[kind === "duplicate-id" ? "id" : "ip"]; other.save(); }
    if (kind === "active-operation") writeFileSync(join(p.h.base, ".fleet-operation.lock"), "live");
    const result = await p.verify(); assert.equal(result.status, "incomplete", kind); assert.equal(result.publishableBaseline, false);
  }
  const p = fixture(t); mkdirSync(join(p.h.base, "receipts"));
  writeFileSync(join(p.h.base, "receipts", `detach-${"a".repeat(16)}-${groupNames[0]}.json`), JSON.stringify({ status: "verified", nativeReadiness: true }));
  const result = await p.verify(); assert.ok(result.groups.every((r) => r.outcome === "missing")); assert.deepEqual(p.calls, []);
});

test("evidence/state/manifest mutation by a verifier is rejected, including earlier sibling mutation", async (t) => {
  for (const kind of ["tree", "state", "manifest", "earlier"]) {
    const p = fixture(t); p.seedAll(); let n = 0;
    const inspect = async (input) => {
      const report = await p.inspect(input); n++;
      const j = p.jobs.get(groupNames[0]);
      if (kind === "tree" && n === 1) appendFileSync(join(j.evidence, "host.txt"), "private");
      if (kind === "state" && n === 1) { j.state.id = "999"; j.save(); }
      if (kind === "manifest" && n === 1) appendFileSync(p.manifestPath, " ");
      if (kind === "earlier" && n === 2) appendFileSync(j.archivePath, "private");
      return report;
    };
    const result = await p.verify({ inspect }); assert.equal(result.status, "incomplete", kind);
  }
});

test("bounded default worker rejects synthetic artifacts instead of trusting injected reports", async (t) => {
  const p = fixture(t); p.seed(groupNames[0]);
  const before = treeHash(p.h.base), result = await verifyFleet(p.input);
  assert.equal(result.status, "incomplete"); assert.equal(result.evidenceMode, "native-replay");
  assert.equal(result.groups[0].error, "group-evidence-invalid"); assert.equal(treeHash(p.h.base), before);
});

test("cancelled pending inspection cannot qualify or expose late/private reports", async (t) => {
  const p = fixture(t); p.seed(groupNames[0]); let cancelled = false, entered = false, finish;
  const result = p.verify({ interrupted: () => cancelled, inspect: () => { entered = true; return new Promise((resolve) => { finish = resolve; }); } });
  while (!entered) await turn(); cancelled = true;
  const report = await result; assert.equal(report.status, "incomplete");
  assert.ok(!JSON.stringify(report).includes("PRIVATE")); finish({ private: "PRIVATE" }); await turn();
  assert.equal(report.status, "incomplete");
});

test("public errors contain no raw paths, exception content, argv or provider output", async (t) => {
  const p = fixture(t); p.seed(groupNames[0]);
  const result = await p.verify({ inspect: () => { throw new Error(`PRIVATE_ARGV_PROVIDER ${p.h.base}`); } });
  assert.ok(!JSON.stringify(result).includes("PRIVATE")); assert.ok(!JSON.stringify(result).includes(p.h.base));
  const output = [];
  assert.equal(await verifyFleetCli(["PRIVATE_ARGV_PROVIDER"], { write: (v) => output.push(v) }), 2);
  assert.deepEqual(JSON.parse(output[0]), { schema: "benchmark-group-fleet-inspection/v1", status: "incomplete", publishableBaseline: false, error: "fleet-inspection-invalid" });
});

test("physical state and archive aliases/hardlinks and foreign members refuse read-only inspection", async (t) => {
  for (const kind of ["state-hardlink", "archive-hardlink", "group-alias", "foreign"]) {
    const p = fixture(t); const j = p.seed(groupNames[0]);
    if (kind === "state-hardlink") linkSync(j.path, join(p.h.temp, "state-link"));
    if (kind === "archive-hardlink") linkSync(j.archivePath, join(p.h.temp, "archive-link"));
    if (kind === "group-alias") {
      const path = join(p.h.base, groupNames[1]); symlinkSync(join(p.h.base, groupNames[0]), path, process.platform === "win32" ? "junction" : "dir");
    }
    if (kind === "foreign") writeFileSync(join(p.h.base, "foreign.json"), "{}");
    const result = await p.verify(); assert.equal(result.status, "incomplete"); assert.equal(result.publishableBaseline, false);
  }
});

test("blocked and harness-failed campaigns remain incomplete even with confirmed deletion", async (t) => {
  for (const status of ["blocked", "failed"]) {
    const p = fixture(t); const j = p.seed(groupNames[0]);
    Object.assign(j.report, { status, controllerReady: false, qualified: false, isolation: "unverified", deletionAuthorized: false });
    j.state.validation.status = status; j.state.evidenceOutcome = status; j.state.exitCode = 1;
    writeFileSync(join(j.evidence, "exit-code"), "1\n"); j.rehash();
    const result = await p.verify(); assert.equal(result.status, "incomplete"); assert.equal(result.groups[0].outcome, status);
  }
});
