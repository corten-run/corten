import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { guardianSource } from "./cloud-control-runtime.mjs";
import { deploymentSha256 } from "./deployments.mjs";

function fixture(t, chunks) {
  const root = mkdtempSync(join(tmpdir(), "corten-audit-material-")), directory = join(root, "r21-0123456789abcdef");
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true }); });
  for (const path of [directory, join(directory, "mixed-audit-sources"), join(directory, "mixed-audit-sources/blobs"), join(directory, "mixed-audit-sources/contexts")]) mkdirSync(path, { mode: 0o700 });
  const path = join(directory, "mixed-audit-sources/contexts/corten.tar"), fd = openSync(path, "wx", 0o600);
  const block = Buffer.alloc(32768, 97), hash = createHash("sha256");
  try { for (let i = 0; i < chunks; i++) { assert.equal(writeSync(fd, block), block.length); hash.update(block); } } finally { closeSync(fd); }
  const entries = [{ path: "", type: "directory" }, { path: "blobs", type: "directory" }, { path: "contexts", type: "directory" },
    { path: "contexts/corten.tar", type: "file", bytes: chunks * block.length, sha256: hash.digest("hex") }];
  const manifest = { files: [], snapshot: { entries, sha256: deploymentSha256(entries) } };
  const body = { sourcesManifest: { ...manifest, sha256: deploymentSha256(manifest) } };
  writeFileSync(join(directory, "mixed-audit-subject.json"), JSON.stringify({ ...body, subjectSha256: deploymentSha256(body) }), { mode: 0o600 });
  return { root, directory, path };
}

function material(directory, mode) {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-stream-material.py"],
    { cwd: resolve("."), input: JSON.stringify({ source: guardianSource, directory, mode, group: "mixed-production" }),
      encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test("shipped guardian reads a 32MiB context in bounded chunks without whole-file allocation", (t) => {
  const f = fixture(t, 1024), result = material(f.directory, "normal");
  assert.equal(result.failed, false); assert.equal(result.ended, true); assert.equal(result.files, 2);
  assert.ok(result.bytes > 32 * 1024 * 1024); assert.equal(result.maximumChunk, 32768);
});

for (const mode of ["hash", "truncated", "identity", "hardlink", "extra"])
  test("shipped guardian payload intentional negative: " + mode, (t) => {
    const f = fixture(t, 2);
    if (mode === "hardlink") linkSync(f.path, join(f.root, "second-link"));
    if (mode === "extra") writeFileSync(join(f.directory, "mixed-audit-sources/contexts/extra.tar"), "extra", { mode: 0o600 });
    const result = material(f.directory, mode); assert.equal(result.failed, true); assert.equal(result.ended, false);
  });
