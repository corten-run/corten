import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { descriptor, identity, verifyImage, verifyNativeReceipt } from "../../json-api/contract.mjs";
import { inspectJson } from "../../json-api/report.mjs";
import { contained, reader } from "../../json-api/artifacts.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { digest, durable, inside, readRegular, tree } from "./evidence.mjs";
import { exact, freeze } from "./campaign-contract.mjs";
import { matchesWorkingSource } from "./worker.mjs";
import { dockerRead } from "./host-observation.mjs";

export function inspectPreparation(binding, root) {
  const summary = JSON.parse(readRegular(join(root, "summary.json")));
  assert.equal(summary.round, binding.request.round); assert.equal(summary.commit, binding.request.commit);
  assert.deepEqual(summary.options, binding.execution.effectiveOptions);
  assert.deepEqual(summary.measurement?.cpus, binding.resources.expectedCpus);
  assert.equal(summary.options.build, true); assert.equal(summary.options.checkOnly, true);
  assert.equal(summary.checksPassed, false); assert.equal(summary.complete, false);
  assert.deepEqual(summary.cleanupFailures, []);
  const report = inspectJson(summary, { load: reader(root), commit: binding.request.commit });
  assert.equal(report.baseline, false);
  assert.equal(report.functionalAttemptComplete, true, "functional raw matrix/configuration incomplete");
  assert.ok(Object.values(report.apps).every((rows) => Object.values(rows).every((r) => r.functionalComplete && !r.nativeQualified && r.passes === 0)),
    "all 36 functional attempts must replay without prebuild audit claims");
  assert.equal(summary.failures.length, 36, "only the 36 missing independent audits may block staging");
  const seen = new Set();
  for (const failure of summary.failures) {
    assert.equal(failure.stage, "JSON qualification");
    assert.ok(descriptor().apps.includes(failure.app) && descriptor().cases.some((p) => p.key === failure.key));
    assert.match(failure.error, /exactly one independently audited native receipt required/);
    assert.ok(!seen.has(`${failure.app}/${failure.key}`)); seen.add(`${failure.app}/${failure.key}`);
  }
  assert.ok(report.warnings.every((w) => / native audit:| timing:|^suite outcome:/.test(w)), report.warnings.join("; "));
  for (const app of descriptor().apps) for (const profile of descriptor().cases) {
    const check = summary.apps[app].checks[profile.key];
    assert.equal(check.nativeSourceVerified, false); assert.equal(check.nativeSerializationVerified, false);
    assert.equal(check.native, undefined);
    assert.deepEqual(summary.apps[app].runs[profile.key], [], "preparation must not have timed anything");
  }
  return { summary, report };
}

export function imageProof(summary) {
  const images = [];
  for (const app of descriptor().apps) for (const payload of descriptor().payloads) {
    const saved = summary.apps[app].images[payload]; verifyImage(saved, summary.commit, app, payload);
    const raw = JSON.parse(dockerRead(["image", "inspect", saved.imageId]));
    assert.equal(raw.length, 1); const info = raw[0];
    assert.equal(info.Id, saved.imageId);
    for (const [key, value] of Object.entries(saved.labels)) assert.equal(info.Config?.Labels?.[key], value);
    // Preserve actual configuration without forwarding image Env, which may contain secrets.
    images.push({ app, payload, imageId: info.Id, created: info.Created, architecture: info.Architecture, os: info.Os,
      rootFS: info.RootFS, config: { entrypoint: info.Config?.Entrypoint, cmd: info.Config?.Cmd, workingDir: info.Config?.WorkingDir },
      labels: saved.labels });
  }
  return images;
}

export function snapshotSources(binding, repo, destination) {
  mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, "blobs"), { mode: 0o700 });
  const files = [], written = new Set();
  for (const file of binding.sources.files) {
    assert.ok(typeof file.path === "string" && !/[\\:]/.test(file.path) && file.path.split("/").every((s) => s && s !== "." && s !== ".."));
    const original = resolve(repo, file.path); assert.ok(inside(repo, original));
    let bytes = readRegular(original);
    assert.ok(matchesWorkingSource(bytes, file.sha256), `audited source changed: ${file.path}`);
    if (digest(bytes) !== file.sha256) bytes = Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
    // Native route names contain brackets/plus signs. Preserve their names as data,
    // not archive paths; every actual retained path stays within the strict collector.
    const storedAs = `blobs/${file.sha256}`;
    if (!written.has(file.sha256)) { durable(join(destination, storedAs), bytes); written.add(file.sha256); }
    files.push({ ...file, bytes: bytes.length, storedAs });
  }
  const body = { files, snapshot: tree(destination) };
  return { ...body, sha256: deploymentSha256(body) };
}

export function auditSubject(plan, prepared, nativeManifest, sourcesManifest, images) {
  const body = { schema: "benchmark-json-audit-subject/v1", campaignSha256: plan.campaignSha256, commit: plan.commit,
    round: prepared.summary.round, sourceSha256: plan.sourceSha256, nativeManifest, sourcesManifest, images,
    identities: descriptor().apps.flatMap((app) => descriptor().cases.map((profile) => identity(prepared.summary, app, profile))),
    blockers: ["independent exact-image native source audit required"], qualified: false };
  return freeze({ ...body, subjectSha256: deploymentSha256(body) });
}

export function validateAuditDelivery(delivery, subject, sourceRoot) {
  exact(delivery, ["schema", "subjectSha256", "review", "bundle"]);
  assert.equal(delivery.schema, "benchmark-json-audit-delivery/v1");
  assert.equal(delivery.subjectSha256, subject.subjectSha256);
  exact(delivery.review, ["reviewer", "reviewedAt", "subjectSha256", "findings", "decision"]);
  const review = delivery.review;
  assert.equal(review.subjectSha256, subject.subjectSha256); assert.equal(review.decision, "approved");
  assert.ok(typeof review.reviewer === "string" && review.reviewer.trim());
  assert.ok(Number.isFinite(Date.parse(review.reviewedAt))); assert.deepEqual(review.findings, []);
  exact(delivery.bundle, ["schema", "receipts"]);
  assert.equal(delivery.bundle.schema, "json-api-native-audits/v1");
  assert.ok(Array.isArray(delivery.bundle.receipts)); assert.equal(delivery.bundle.receipts.length, subject.identities.length);
  const seen = new Set();
  for (const receipt of delivery.bundle.receipts) {
    const expected = subject.identities.find((i) => i.app === receipt.identity?.app && i.key === receipt.identity?.key);
    assert.ok(expected, "unexpected audit member");
    const key = `${expected.app}/${expected.key}`; assert.ok(!seen.has(key), "duplicate native audit"); seen.add(key);
    const files = {};
    for (const file of receipt.sourceFiles ?? []) {
      assert.ok(typeof file.path === "string" && /^(bench|crates)\//.test(file.path)
        && file.path.split("/").every((p) => p && p !== "." && p !== "..") && !/[\\:]/.test(file.path));
      const manifest = subject.sourcesManifest.files.find((e) => e.path === file.path);
      assert.ok(manifest && manifest.sha256 === file.sha256, "audit differs from sealed built-source snapshot");
      assert.equal(manifest.storedAs, `blobs/${file.sha256}`);
      files[file.path] = readRegular(join(sourceRoot, manifest.storedAs)).toString("utf8");
    }
    verifyNativeReceipt(receipt, expected, files);
  }
  return freeze(structuredClone(delivery)); // Data validation only; caller authority is checked separately.
}

// A separately valid native receipt is not necessarily the receipt that was staged.
// Missing cells retain a failed/partial attempt; any present receipt must be exact.
export function validateTimingAudit(binding, root, subject, bundle, sourceRoot) {
  const before = tree(root);
  if (!before.entries.some((e) => e.path === "summary.json")) return freeze({ complete: false });
  const summary = JSON.parse(readRegular(join(root, "summary.json")));
  assert.equal(summary.round, binding.request.round); assert.equal(summary.commit, binding.request.commit);
  assert.deepEqual(summary.group, descriptor());
  assert.equal(bundle.schema, "json-api-native-audits/v1");
  assert.equal(subject.identities.length, descriptor().apps.length * descriptor().cases.length);
  assert.equal(bundle.receipts.length, subject.identities.length);
  let complete = true;
  for (const app of descriptor().apps) for (const profile of descriptor().cases) {
    const expected = subject.identities.filter((i) => i.app === app && i.key === profile.key);
    assert.equal(expected.length, 1);
    const accepted = bundle.receipts.filter((r) => r.identity?.app === app && r.identity?.key === profile.key);
    assert.equal(accepted.length, 1); assert.deepEqual(accepted[0].identity, expected[0]);
    const checked = summary.apps?.[app]?.checks?.[profile.key];
    if (checked?.native === undefined) { complete = false; continue; }
    assert.deepEqual(identity(summary, app, profile), expected[0]);
    assert.deepEqual(checked.identity, expected[0]);
    exact(checked.native, ["path", "sha256"]);
    const bytes = readRegular(contained(root, checked.native.path));
    assert.equal(digest(bytes), checked.native.sha256);
    const native = JSON.parse(bytes); exact(native, ["receipt", "files"]);
    assert.deepEqual(native.receipt, accepted[0], "timing audit differs from accepted receipt");
    assert.deepEqual(Object.keys(native.files).sort(), accepted[0].sourceFiles.map((f) => f.path).sort());
    for (const file of accepted[0].sourceFiles) {
      const saved = subject.sourcesManifest.files.find((f) => f.path === file.path);
      assert.ok(saved && saved.sha256 === file.sha256); assert.equal(saved.storedAs, `blobs/${file.sha256}`);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      const source = readRegular(join(sourceRoot, saved.storedAs));
      assert.equal(digest(source), file.sha256); assert.equal(typeof native.files[file.path], "string");
      assert.deepEqual(Buffer.from(native.files[file.path], "utf8"), source, "timing source differs from accepted source snapshot");
    }
    verifyNativeReceipt(native.receipt, expected[0], native.files);
  }
  assert.deepEqual(tree(root), before);
  return freeze({ complete });
}
