import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deploymentSha256 } from "../deployments.mjs";
import { verifyNativeReceipt } from "../../json-api/contract.mjs";
import { digest, durable, readRegular, tree } from "./evidence.mjs";
import { exact, freeze } from "./campaign-contract.mjs";

function git(repo, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return execFileSync("git", args, { cwd: repo, input, windowsHide: true, timeout: 60000,
    maxBuffer: 256 * 2 ** 20, stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
}
function committed(repo, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const entries = git(repo, ["ls-tree", "-r", "-z", commit]).toString().split("\0").filter(Boolean).map((row) => {
    const [meta, path] = row.split("\t"), [mode, type, blob] = meta.split(" ");
    assert.ok(["100644", "100755"].includes(mode) && type === "blob");
    assert.ok(path && !/[\\:\r\n]/.test(path) && path.split("/").every((s) => s && s !== "." && s !== ".."));
    return { path, blob };
  });
  const batch = git(repo, ["cat-file", "--batch"], entries.map((e) => `${e.blob}\n`).join(""));
  let offset = 0;
  const files = entries.map(({ path, blob }) => {
    const end = batch.indexOf(10, offset), [id, type, length] = batch.subarray(offset, end).toString().split(" "), size = Number(length);
    assert.ok(end >= offset && id === blob && type === "blob" && Number.isSafeInteger(size) && size >= 0);
    offset = end + 1; const bytes = batch.subarray(offset, offset + size); offset += size;
    assert.ok(bytes.length === size && batch[offset++] === 10); return { path, bytes };
  });
  assert.equal(offset, batch.length); return files;
}
async function contexts(binding, repo) {
  const { nativeBuildArchiveArgs } = await import("../../mixed-production/build-context.mjs");
  assert.equal(typeof nativeBuildArchiveArgs, "function", "reviewed deterministic native archive API required");
  return binding.selection.apps.map((app) => {
    assert.match(app, /^[a-z][a-z0-9-]*$/);
    const prefix = app === "corten" ? "" : `bench/fullstack/apps/${app}/`;
    const args = nativeBuildArchiveArgs(binding.request.commit, app);
    assert.deepEqual(args, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar",
      ...(prefix ? ["--mtime=1970-01-01T00:00:00Z"] : []), `${binding.request.commit}${prefix ? `:${prefix.slice(0, -1)}` : ""}`]);
    const bytes = git(repo, args);
    return { app, prefix, bytes, sha256: digest(bytes), storedAs: `contexts/${app}.tar` };
  });
}
function subject(plan, sourcesManifest, contextRows) {
  const binding = plan.bindings.find((b) => b.request.group === "mixed-production"); assert.ok(binding);
  const requests = contextRows.map(({ app, prefix, sha256 }) => {
    const sourceFiles = sourcesManifest.files.filter((f) => f.path.startsWith(prefix)).map(({ path, sha256 }) => ({ path, sha256 }));
    assert.ok(sourceFiles.length);
    return { identity: { app, payload: "marketplace-v2", key: "mixed-native-source", commit: plan.commit,
      contractSha256: binding.selection.contractSha256, nativeProfile: binding.execution.effectiveOptions.profile,
      contextArchiveSha256: sha256, buildInputsSha256: digest(JSON.stringify(sourceFiles)) }, sourceFiles };
  });
  const body = { schema: "benchmark-mixed-audit-subject/v1", scope: "committed-source-and-build-context-not-built-image",
    campaignSha256: plan.campaignSha256, commit: plan.commit, round: binding.request.round,
    bindingSha256: deploymentSha256(binding), sourcesManifest, requests };
  return freeze({ ...body, subjectSha256: deploymentSha256(body) });
}
export async function prepareMixedAudit(plan, repo, directory) {
  const binding = plan.bindings.find((b) => b.request.group === "mixed-production"), files = committed(repo, plan.commit);
  // Corten's native Docker context is the entire tracked repository, not the
  // narrower executable-source inventory. Capture that actual closure verbatim.
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(directory, "blobs")); mkdirSync(join(directory, "contexts"));
  const written = new Set(), entries = files.map(({ path, bytes }) => {
    const sha256 = digest(bytes), storedAs = `blobs/${sha256}`;
    if (!written.has(sha256)) { durable(join(directory, storedAs), bytes); written.add(sha256); }
    return { path, sha256, bytes: bytes.length, storedAs };
  });
  const contextRows = await contexts(binding, repo);
  for (const c of contextRows) durable(join(directory, c.storedAs), c.bytes);
  const body = { files: entries, snapshot: tree(directory) }, manifest = { ...body, sha256: deploymentSha256(body) };
  return subject(plan, manifest, contextRows);
}
export async function replayMixedSubject(plan, saved, repo, directory) {
  const binding = plan.bindings.find((b) => b.request.group === "mixed-production"), files = committed(repo, plan.commit);
  assert.deepEqual(saved.sourcesManifest.files, files.map(({ path, bytes }) => ({ path, sha256: digest(bytes),
    bytes: bytes.length, storedAs: `blobs/${digest(bytes)}` })));
  for (const file of saved.sourcesManifest.files) assert.equal(digest(readRegular(join(directory, file.storedAs))), file.sha256);
  assert.deepEqual(saved.sourcesManifest.snapshot, tree(directory));
  const { sha256, ...body } = saved.sourcesManifest; assert.equal(sha256, deploymentSha256(body));
  const rows = await contexts(binding, repo);
  for (const c of rows) assert.deepEqual(readRegular(join(directory, c.storedAs)), c.bytes);
  assert.deepEqual(saved, subject(plan, saved.sourcesManifest, rows)); return saved;
}
export function validateMixedDelivery(delivery, saved, directory) {
  const before = tree(directory);
  exact(delivery, ["schema", "subjectSha256", "review", "bundle"]);
  assert.equal(delivery.schema, "benchmark-mixed-audit-delivery/v1"); assert.equal(delivery.subjectSha256, saved.subjectSha256);
  exact(delivery.review, ["reviewer", "reviewedAt", "subjectSha256", "findings", "decision"]);
  assert.equal(delivery.review.subjectSha256, saved.subjectSha256); assert.equal(delivery.review.decision, "approved");
  assert.ok(typeof delivery.review.reviewer === "string" && delivery.review.reviewer.trim());
  assert.ok(Number.isFinite(Date.parse(delivery.review.reviewedAt))); assert.deepEqual(delivery.review.findings, []);
  exact(delivery.bundle, ["schema", "receipts"]); assert.equal(delivery.bundle.schema, "mixed-native-source-audits/v1");
  assert.equal(delivery.bundle.receipts.length, saved.requests.length);
  for (const [index, request] of saved.requests.entries()) {
    const receipt = delivery.bundle.receipts[index]; assert.deepEqual(receipt.identity, request.identity);
    assert.deepEqual(receipt.sourceFiles, request.sourceFiles);
    assert.deepEqual(receipt.traceContext, { requestScoped: true, delayedWorkRetainsTrace: true, noAmbientCurrentOperation: true });
    const bodies = {};
    for (const file of request.sourceFiles) {
      const bytes = readRegular(join(directory, `blobs/${file.sha256}`)); assert.equal(digest(bytes), file.sha256);
      if (/^(bench|crates)\//.test(file.path)) bodies[file.path] = bytes;
    }
    verifyNativeReceipt({ ...receipt, sourceFiles: receipt.sourceFiles.filter((f) => /^(bench|crates)\//.test(f.path)) }, request.identity, bodies);
  }
  assert.deepEqual(tree(directory), before); return freeze(structuredClone(delivery));
}
export function validateMixedRun(binding, directory, saved, bundle) {
  const before = tree(directory);
  if (!before.entries.some((f) => f.path === "summary.json")) return false;
  const summary = JSON.parse(readRegular(join(directory, "summary.json")));
  assert.deepEqual(summary.options, binding.execution.effectiveOptions); let complete = true;
  for (const [index, request] of saved.requests.entries()) {
    const app = request.identity.app, entry = summary.apps?.[app], reference = summary.sourceAudits?.[app]?.artifact;
    if (!reference) { complete = false; continue; }
    assert.equal(reference.path, `source-audits/${app}.json`);
    const bytes = readRegular(join(directory, reference.path)); assert.equal(digest(bytes), reference.sha256);
    const retained = JSON.parse(bytes); assert.deepEqual(retained.receipt, bundle.receipts[index]);
    assert.deepEqual(retained.identity, request.identity); assert.deepEqual(retained.sourceFiles, request.sourceFiles);
    assert.deepEqual(entry.buildInputs, request.sourceFiles); assert.equal(entry.contextArchiveSha256, request.identity.contextArchiveSha256);
    assert.equal(digest(readRegular(join(directory, `${app}-build-context.tar`))), request.identity.contextArchiveSha256);
    assert.equal(entry.image.buildCommit, request.identity.commit); assert.equal(entry.image.buildDirty, "false");
    assert.equal(entry.image.profile, request.identity.nativeProfile); assert.equal(entry.image.contextArchiveSha256, request.identity.contextArchiveSha256);
    assert.match(entry.image.id, /^sha256:[a-f0-9]{64}$/); assert.equal(retained.imageId, entry.image.id);
    assert.equal(retained.receiptSha256, digest(JSON.stringify(bundle.receipts[index])));
  }
  assert.deepEqual(tree(directory), before); return complete;
}
