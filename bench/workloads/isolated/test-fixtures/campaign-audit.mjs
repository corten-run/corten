// Synthetic audit data for process/archive tests, never native qualification.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deploymentSha256 } from "../../deployments.mjs";
import { digest, tree } from "../evidence.mjs";

const source = "synthetic source\n";
export const sourceFile = { path: "bench/unit-source.mjs", sha256: digest(source) };
export function snapshotSources(binding, repo, destination) {
  mkdirSync(destination); mkdirSync(join(destination, "blobs"));
  writeFileSync(join(destination, "blobs", sourceFile.sha256), source);
  const body = { files: [{ ...sourceFile, bytes: Buffer.byteLength(source), storedAs: `blobs/${sourceFile.sha256}` }], snapshot: tree(destination) };
  return { ...body, sha256: deploymentSha256(body) };
}
export function auditSubject(plan, prepared, nativeManifest, sourcesManifest, images) {
  const body = { schema: "benchmark-json-audit-subject/v1", campaignSha256: plan.campaignSha256,
    commit: plan.commit, sourceSha256: plan.sourceSha256 ?? "synthetic-sources", nativeManifest, sourcesManifest, images, qualified: false };
  return { ...body, subjectSha256: deploymentSha256(body) };
}
export function auditDelivery(subjectSha256) {
  return { schema: "benchmark-json-audit-delivery/v1", subjectSha256,
    review: { reviewer: "independent", reviewedAt: "2026-11-12T12:00:00Z", subjectSha256, findings: [], decision: "approved" },
    bundle: { schema: "json-api-native-audits/v1", receipts: [] } };
}
export function validateAuditDelivery(delivery, subject) {
  assert.deepEqual(delivery, auditDelivery(subject.subjectSha256)); return delivery;
}
export function validateTimingAudit() { return { complete: false }; }
