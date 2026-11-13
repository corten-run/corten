// Synthetic source/audit controls through the real integrated core APIs. No
// provider, benchmark, image build or claim of an independently performed audit.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { payloads } from "../json-api/contract.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { auditDelivery } from "./cloud-audit.mjs";
import { campaignOutcome } from "./cloud-options.mjs";
import { digest } from "./cloud-local.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { campaign, commit, harness, syntheticDelivery } from "./cloud-fixtures.mjs";

const integrated = ["campaign-entry.mjs", "campaign-verify.mjs", "json-staging.mjs", "mixed-staging.mjs"]
  .every((name) => existsSync(new URL(`isolated/${name}`, import.meta.url)));

async function fixture(t, group) {
  const h = harness(t), directory = join(h.temp, "sources"), inbox = join(h.temp, "inbox");
  mkdirSync(directory); mkdirSync(join(directory, "blobs")); mkdirSync(inbox);
  const delivery = syntheticDelivery(group), mixed = group === "mixed-production", files = new Map();
  const receipts = delivery.bundle.receipts.map(({ identity }) => {
    const path = identity.app === "corten" ? `bench/${payloads[identity.payload].path}/corten/synthetic-native-source.mjs`
      : `bench/fullstack/apps/${identity.app}/synthetic-native-source.mjs`;
    const source = `// unmistakably synthetic source control: ${path}\n`, sha256 = digest(source);
    if (!files.has(path)) { files.set(path, { path, sha256, storedAs: `blobs/${sha256}` }); writeFileSync(join(directory, "blobs", sha256), source); }
    return { schema: "json-api-native-audit/v1", identity: { ...identity, commit },
      auditor: "synthetic-independent-reviewer", auditedAt: "2026-11-13T12:00:00Z", findings: [], sourceFiles: [{ path, sha256 }],
      verified: { typedCompleteRecord: true, nativeSerialization: true, noOutputCache: true, noJsonPassthrough: true,
        fixtureParsedAtStartup: true, requestTimeFetchParse: true, upstreamErrors: true },
      ...(mixed ? { traceContext: { requestScoped: true, delayedWorkRetainsTrace: true, noAmbientCurrentOperation: true } } : {}) };
  });
  delivery.bundle.receipts = receipts;
  const body = { schema: `benchmark-${mixed ? "mixed" : "json"}-audit-subject/v1`, commit, campaignSha256: "a".repeat(64),
    sourcesManifest: { files: [...files.values()] },
    ...(mixed ? { requests: receipts.map(({ identity, sourceFiles }) => ({ identity, sourceFiles })) } : { identities: receipts.map((r) => r.identity) }) };
  const subject = { ...body, subjectSha256: deploymentSha256(body) };
  delivery.subjectSha256 = delivery.review.subjectSha256 = subject.subjectSha256;
  const native = await import(mixed ? "./isolated/mixed-staging.mjs" : "./isolated/json-staging.mjs");
  const validate = mixed ? native.validateMixedDelivery : native.validateAuditDelivery;
  return { ...h, inbox, subject, delivery, validate: (value) => validate(value, subject, directory) };
}

for (const group of ["json-api", "mixed-production"]) test(`real core validates ${group} delivery and consumes only its fixed private inbox`, { skip: !integrated }, async (t) => {
  const h = await fixture(t, group), prefix = group === "mixed-production" ? "mixed" : "json";
  assert.deepEqual(h.validate(h.delivery), h.delivery);
  const bytes = Buffer.from(JSON.stringify(h.delivery)), options = { auditGroup: group, campaign, approveSubject: h.subject.subjectSha256 };
  assert.equal(auditDelivery(bytes, options).sha256, digest(bytes));
  assert.throws(() => auditDelivery(bytes, { ...options, approveSubject: "0".repeat(64) }));
  const { readAuditInbox } = await import("./isolated/campaign-entry.mjs");
  assert.equal(readAuditInbox(h.inbox, group), null);
  writeFileSync(join(h.inbox, `${prefix}-audit-delivery.json`), bytes, { mode: 0o600 });
  assert.deepEqual(readAuditInbox(h.inbox, group), { delivery: h.delivery, sha256: digest(bytes) });
  assert.equal(readAuditInbox(h.inbox, group === "mixed-production" ? "json-api" : "mixed-production"), null);
  for (const change of [(d) => d.bundle.receipts.pop(), (d) => { d.bundle.receipts[0].identity.commit = "b".repeat(40); },
    (d) => { d.bundle.receipts[0].verified.noOutputCache = false; }]) {
    const changed = structuredClone(h.delivery); change(changed); assert.throws(() => h.validate(changed));
  }
});

test("real current core inspection rejects unsealed synthetic evidence through the native worker", { skip: !integrated }, async (t) => {
  const h = harness(t), report = await inspectCampaign({ folder: h.temp, round: "r21", commit });
  assert.equal(report.status, "invalid"); assert.equal(report.deletionAuthorized, false);
  assert.throws(() => campaignOutcome(report, { round: "r21", commit }, 0));
});
