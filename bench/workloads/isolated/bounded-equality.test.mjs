import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { copyEvidence } from "./evidence.mjs";
import { validateMixedDelivery } from "./mixed-staging.mjs";

function temporary(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "isolated-bounded-equality-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

function rejectedWith(message) {
  return (error) => {
    assert.equal(error.code, "ERR_ASSERTION");
    assert.equal(error.actual, false);
    assert.equal(error.expected, true);
    assert.equal(error.message, message);
    assert.ok(Buffer.byteLength(error.message) < 256);
    return true;
  };
}

for (const side of ["source", "copy"]) test(`${side} tree mutation rejects without retaining a manifest diff`, (t) => {
  const root = temporary(t), source = join(root, "source"), destination = join(root, "copy");
  fs.mkdirSync(source); fs.writeFileSync(join(source, "raw.log"), "synthetic raw evidence");
  const original = fs.fsyncSync; let changed = false;
  const mock = t.mock.method(fs, "fsyncSync", (...args) => {
    const result = original(...args);
    if (!changed && fs.existsSync(join(destination, "raw.log"))) {
      changed = true;
      fs.writeFileSync(join(root, side, "unexpected.log"), "archive-controlled-payload".repeat(64));
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => copyEvidence(source, destination), rejectedWith(side === "source"
      ? "source tree mutated during collection" : "copied evidence differs"));
    assert.equal(changed, true);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

for (const [name, mutate, message] of [
  ["field", (r) => { r.sourceFiles[0].sha256 = "b".repeat(64); }, "mixed audit source files differ"],
  ["order", (r) => { r.sourceFiles.reverse(); }, "mixed audit source files differ"],
  ["type", (r) => { r.sourceFiles[0].path = 0; }, "mixed audit source files differ"],
  ["extra field", (r) => { r.sourceFiles[0].extra = "archive-controlled-payload".repeat(64); }, "mixed audit source files differ"],
  ["identity type", (r) => { r.identity.version = "1"; }, "mixed audit identity differs"],
]) test(`mixed source ${name} drift is strictly rejected with a bounded diagnostic`, (t) => {
  const directory = temporary(t), identity = { app: "corten", version: 1 };
  const sourceFiles = Array.from({ length: 32 }, (_, i) => ({ path: `bench/source-${i}.mjs`, sha256: "a".repeat(64) }));
  const saved = { subjectSha256: "c".repeat(64), requests: [{ identity, sourceFiles }] };
  const delivery = { schema: "benchmark-mixed-audit-delivery/v1", subjectSha256: saved.subjectSha256,
    review: { reviewer: "synthetic", reviewedAt: "2026-11-14T00:00:00Z", subjectSha256: saved.subjectSha256,
      findings: [], decision: "approved" },
    bundle: { schema: "mixed-native-source-audits/v1", receipts: [structuredClone({ identity, sourceFiles })] } };
  mutate(delivery.bundle.receipts[0]);
  assert.throws(() => validateMixedDelivery(delivery, saved, directory), rejectedWith(message));
});

test("equal mixed source inventory continues past the strict comparison", (t) => {
  const directory = temporary(t), identity = { app: "corten" }, sourceFiles = [];
  const saved = { subjectSha256: "c".repeat(64), requests: [{ identity, sourceFiles }] };
  const delivery = { schema: "benchmark-mixed-audit-delivery/v1", subjectSha256: saved.subjectSha256,
    review: { reviewer: "synthetic", reviewedAt: "2026-11-14T00:00:00Z", subjectSha256: saved.subjectSha256,
      findings: [], decision: "approved" },
    bundle: { schema: "mixed-native-source-audits/v1", receipts: [{ identity: { ...identity }, sourceFiles: [] }] } };
  assert.throws(() => validateMixedDelivery(delivery, saved, directory), (error) => {
    assert.equal(error.code, "ERR_ASSERTION");
    assert.notEqual(error.message, "mixed audit identity differs");
    assert.notEqual(error.message, "mixed audit source files differ");
    return true;
  });
});
