import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { verifyNativeReceipt } from "../json-api/contract.mjs";
import { sha256 } from "./capture.mjs";

export function buildInputPaths(app) {
  // Corten's Dockerfile copies the whole repository, unlike the other contexts.
  return app === "corten" ? ["."] : [`bench/fullstack/apps/${app}`];
}

export function sourceSnapshot(root, paths) {
  const files = {}, base = realpathSync(root);
  assert.ok(paths.length > 0 && new Set(paths).size === paths.length, "complete unique native build inputs required");
  for (const path of [...paths].sort()) {
    assert.ok(!isAbsolute(path) && !/[\\:]/.test(path) && path.split("/").every((p) => p && p !== "." && p !== ".."), "invalid native source path");
    const target = realpathSync(join(base, path)), rel = relative(base, target);
    assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"), "native source escaped build root");
    files[path] = readFileSync(target);
  }
  return { files, sourceFiles: Object.entries(files).map(([path, body]) => ({ path, sha256: sha256(body) })) };
}

export function sourceAuditIdentity(summary, app) {
  return { app, payload: "marketplace-v2", key: "mixed-native-source", commit: summary.provenance.nativeSource.commit,
    contractSha256: summary.contractSha256, nativeProfile: summary.options.profile,
    contextArchiveSha256: summary.apps[app].contextArchiveSha256,
    buildInputsSha256: sha256(JSON.stringify(summary.apps[app].buildInputs)) };
}

// Reuse the independent JSON-source attestation, not a whitespace/byte-difference
// heuristic. The runner emits requests for audits, never positive audit receipts.
export function verifySourceAudit(receipt, expected, snapshot, image) {
  assert.equal(image?.buildCommit, expected.commit, "native audit/image source commit differs");
  assert.equal(image.buildDirty, "false", "native audit needs a clean fresh image");
  assert.equal(image.profile, expected.nativeProfile, "native audit/image configuration differs");
  assert.match(expected.contextArchiveSha256 ?? "", /^[a-f0-9]{64}$/, "immutable Docker build context required");
  assert.equal(image.contextArchiveSha256, expected.contextArchiveSha256, "native image/audited Docker archive differs");
  assert.match(image.id ?? "", /^sha256:[0-9a-f]{64}$/, "immutable native image required");
  assert.deepEqual(receipt?.sourceFiles, snapshot.sourceFiles, "independent source audit must cover every exact native build input");
  assert.deepEqual(receipt.traceContext, { requestScoped: true, delayedWorkRetainsTrace: true, noAmbientCurrentOperation: true },
    "independent audit must verify immutable native request trace propagation");
  assert.equal(sha256(JSON.stringify(snapshot.sourceFiles)), expected.buildInputsSha256, "native build input set differs from the audit identity");
  assert.deepEqual(Object.keys(snapshot.files).sort(), snapshot.sourceFiles.map((f) => f.path).sort(), "native build input bodies missing");
  for (const f of snapshot.sourceFiles) assert.equal(sha256(snapshot.files[f.path]), f.sha256, "native build input bytes changed");
  // Root Cargo manifests stay bound by buildInputsSha256 and the exact comparison;
  // the reused JSON verifier restricts its individual source paths to bench/crates.
  const files = Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => /^(bench|crates)\//.test(path)));
  const checked = receipt && { ...receipt, sourceFiles: receipt.sourceFiles.filter((f) => /^(bench|crates)\//.test(f.path)) };
  verifyNativeReceipt(checked, expected, files);
  return { identity: expected, imageId: image.id, sourceFiles: snapshot.sourceFiles, receiptSha256: sha256(JSON.stringify(receipt)) };
}
