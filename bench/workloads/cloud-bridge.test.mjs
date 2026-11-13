// Synthetic protocol controls, never external audit authority or native readiness.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { auditDelivery } from "./cloud-audit.mjs";
import { selection } from "./cloud-contract.mjs";
import { campaignOutcome } from "./cloud-options.mjs";
import { archive, campaign, commit, harness, metadata, subject, syntheticDelivery, syntheticInspection } from "./cloud-fixtures.mjs";

test("mixed audit selection follows the native selected apps, independently of JSON cells", () => {
  const bytes = Buffer.from(JSON.stringify(syntheticDelivery("mixed-production")));
  assert.equal(auditDelivery(bytes, { auditGroup: "mixed-production", campaign, approveSubject: subject }).group, "mixed-production");
});

test("each native audit group has its own one-shot delivery attempt", async (t) => {
  const h = harness(t, { active: true }); h.seed();
  for (const group of ["json-api", "mixed-production"]) {
    const path = join(h.temp, `${group}.json`); writeFileSync(path, JSON.stringify(syntheticDelivery(group)));
    const options = { collect: undefined, deliverAudit: path, auditGroup: group, campaign, approveSubject: subject };
    assert.equal(await h.task({}, options).deliverAudit(), 3);
    await assert.rejects(h.task({}, options).deliverAudit(), /already attempted/);
  }
  assert.deepEqual(Object.keys(h.saved().auditIntents).sort(), ["json-api", "mixed-production"]);
  assert.equal(h.deletes, 0);
});

test("a cancelled mixed transfer keeps both group histories and never authorizes retry", async (t) => {
  const h = harness(t, { active: true }); h.seed();
  const deliver = (group) => {
    const path = join(h.temp, `${group}.json`); writeFileSync(path, JSON.stringify(syntheticDelivery(group)));
    return h.task({}, { collect: undefined, deliverAudit: path, auditGroup: group, campaign, approveSubject: subject });
  };
  assert.equal(await deliver("json-api").deliverAudit(), 3);
  h.flags.cancelAt = (binary) => binary === "scp";
  await assert.rejects(deliver("mixed-production").deliverAudit());
  assert.deepEqual(Object.keys(h.saved().auditIntents).sort(), ["json-api", "mixed-production"]);
  h.flags.cancelAt = undefined; h.flags.cancelled = false;
  await assert.rejects(deliver("mixed-production").deliverAudit(), /already attempted/); assert.equal(h.deletes, 0);
});

test("a legacy JSON attempt remains consumed without suppressing the separate mixed attempt", async (t) => {
  const h = harness(t, { active: true }); h.seed();
  h.change((s) => { s.auditIntent = { campaign, sha256: "a".repeat(64), subjectSha256: subject }; });
  for (const group of ["json-api", "mixed-production"]) {
    const path = join(h.temp, `${group}.json`); writeFileSync(path, JSON.stringify(syntheticDelivery(group)));
    const task = h.task({}, { collect: undefined, deliverAudit: path, auditGroup: group, campaign, approveSubject: subject });
    if (group === "json-api") await assert.rejects(task.deliverAudit(), /already attempted/);
    else assert.equal(await task.deliverAudit(), 3);
  }
  assert.ok(h.saved().auditIntent); assert.ok(h.saved().auditIntents["mixed-production"]);
});

test("current core verified inspection maps to intrinsic validated, never full qualification", () => {
  assert.deepEqual(campaignOutcome(syntheticInspection("verified"), { round: "r21", commit, selection: selection() }, 0),
    { fullGroupQualified: false, evidenceOutcome: "validated" });
});

test("uncertain CLI exit cannot be converted to safe failed evidence", () => {
  assert.throws(() => campaignOutcome(syntheticInspection("blocked"), { round: "r21", commit, selection: selection() }, 2));
});

test("wrong group, self-approved bytes, duplicate/missing/foreign selection cannot reach an inbox", () => {
  for (const group of ["json-api", "mixed-production"]) {
    const options = { auditGroup: group, campaign, approveSubject: subject };
    for (const change of [(d) => { d.subjectSha256 = "b".repeat(64); }, (d) => { d.review.subjectSha256 = "b".repeat(64); },
      (d) => { d.bundle.receipts.pop(); }, (d) => { d.bundle.receipts[0] = d.bundle.receipts[1]; },
      (d) => { d.bundle.receipts[0].identity.app = "synthetic-foreign-app"; }, (d) => { d.review.reviewer = ""; }]) {
      const delivery = syntheticDelivery(group); change(delivery);
      assert.throws(() => auditDelivery(Buffer.from(JSON.stringify(delivery)), options));
    }
    assert.throws(() => auditDelivery(Buffer.from(JSON.stringify(syntheticDelivery(group))), { ...options, auditGroup: group === "json-api" ? "mixed-production" : "json-api" }));
  }
});

test("intrinsic verified collection returns zero only after the unchanged host/deletion gates", async (t) => {
  const h = harness(t, { reportStatus: "verified" }); h.seed(); const entries = metadata(); entries[2].body = "0\n";
  h.setArchive(archive([...entries, { name: "campaign/" }]));
  assert.equal(await h.task().collect(), 0); assert.equal(h.deletes, 1); assert.ok(h.saved().destroyedAt);
  assert.equal(h.saved().evidenceOutcome, "validated"); assert.equal(h.saved().fullGroupQualified, false);
  assert.equal(await h.task().collect(), 0); assert.equal(h.deletes, 1);
});

test("verified schema, all-group completeness and terminal lifecycle cannot be weakened", () => {
  for (const change of [(r) => { delete r.scope; }, (r) => { r.groups.pop(); }, (r) => { r.selection.groups.pop(); },
    (r) => { r.groups[0].appOutcomes.pop(); }, (r) => { r.commandLifecycle = "incomplete-preserved"; },
    (r) => { r.controllerReady = true; }, (r) => { r.blockers.push("synthetic missing proof"); },
    (r) => { r.groups[0].outcome = "blocked"; }, (r) => { r.groups[0].nativeManifestSha256 = "not-a-hash"; }]) {
    const report = syntheticInspection("verified"); change(report);
    assert.throws(() => campaignOutcome(report, { round: "r21", commit, selection: selection() }, 0));
  }
  const report = syntheticInspection("verified"); report.groups[0].appOutcomes[0] = { ...report.groups[0].appOutcomes[0], outcome: "failed", comparisonEligible: false };
  assert.equal(campaignOutcome(report, { round: "r21", commit, selection: selection() }, 0).fullGroupQualified, false);
  for (const [status, code] of [["blocked", 0], ["failed", 0], ["verified", 1]])
    assert.throws(() => campaignOutcome(syntheticInspection(status), { round: "r21", commit, selection: selection() }, code));
});
