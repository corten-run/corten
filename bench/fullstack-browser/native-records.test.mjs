import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, openEvidence, encoded, sha256 } from "./native-evidence.mjs";
import { jsonSha256, encodeMetadata } from "./json-records.mjs";

// Repeated native journals/proofs and cumulative upstream samples, not large
// error strings. Each logical occurrence must survive, including failed cells.
function cell(index) {
  const events = Array.from({ length: 256 }, (_, i) => ({ request: `request-${i}`, id: String(i), started: i, completed: i + 1, cancelled: null, status: 200 }));
  const journal = { events: events.map((e) => ({ ...e, native: "observed-".repeat(64) })), realms: [{ realm: "realm-1", context: 1 }] };
  return { case: `case-${index}`, outcome: index % 2 ? "failed" : "unsupported", qualificationPassed: false,
    evidence: { steps: Array.from({ length: 16 }, (_, i) => ({ action: { id: `action-${i}` }, lifecycle: structuredClone(journal) })),
      upstreamLedger: { baseline: { events }, phases: Array.from({ length: 16 }, (_, i) => ({ phase: String(i), before: { events: structuredClone(events) }, after: { events: structuredClone(events) } })) },
      platformLifecycle: journal, platformRetirementProofs: Array.from({ length: 16 }, () => ({ journal: structuredClone(journal), outcome: "unknown" })),
      harnessClosedLifecycle: structuredClone(journal), failures: ["A genuine observed failure"], gaps: ["Native proof unsupported"] } };
}

test("multi-cell raw observations deduplicate without discarding logical occurrences", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "browser-records-")); t.after(() => rmSync(folder, { recursive: true }));
  const store = new EvidenceStore(folder), refs = Array.from({ length: 8 }, (_, i) => store.recordJSON(`cell-${i}`, cell(i)));
  const manifest = store.seal();
  assert.ok(store.total < 2 * 1024 ** 2, `Repeated structured observations occupied ${store.total} bytes`);
  const reader = openEvidence(folder);
  for (const [i, ref] of refs.entries()) {
    const value = reader.json(ref);
    assert.equal(value.case, `case-${i}`); assert.equal(value.evidence.steps.length, 16);
    assert.equal(value.evidence.platformRetirementProofs.length, 16);
    assert.equal(value.evidence.upstreamLedger.phases[15].after.events.length, 256);
    assert.equal(value.evidence.harnessClosedLifecycle.events[255].native, "observed-".repeat(64));
    assert.equal(value.outcome, i % 2 ? "failed" : "unsupported");
  }
  reader.finish();
  t.diagnostic(`cells=${refs.length} storedBytes=${store.total} files=${manifest.files.length}`);
});

test("a logical record beyond the old JSON parse bound replays and hashes incrementally", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "browser-records-large-")); t.after(() => rmSync(folder, { recursive: true }));
  const store = new EvidenceStore(folder), raw = cell(0), one = JSON.stringify(raw), copies = 8;
  assert.ok(Buffer.byteLength(one) * copies > 32 * 1024 ** 2);
  const expected = createHash("sha256").update("[");
  for (let i = 0; i < copies; i++) { if (i) expected.update(","); expected.update(one); }
  const ref = store.recordJSON("app", Array(copies).fill(raw)); store.seal();
  assert.ok(ref.bytes < 64 * 1024 && store.total < 2 * 1024 ** 2);
  const reader = openEvidence(folder), replay = reader.json(ref);
  assert.equal(replay.length, copies); assert.equal(jsonSha256(replay), expected.update("]").digest("hex")); reader.finish();
});

test("JSON hashing and record pages preserve Unicode, holes, nulls and property order", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "browser-records-json-")); t.after(() => rmSync(folder, { recursive: true }));
  const store = new EvidenceStore(folder), value = { "10": 10, "2": 2, missing: undefined, array: [undefined, , null, -0, NaN],
    text: ("a".repeat(2047) + "\uD83D\uDE00\uD800\uDC00\uD800\n\\\"").repeat(12), ...JSON.parse('{"__proto__":{"observed":true}}') };
  const text = JSON.stringify(value), ref = store.recordJSON("unicode", value); store.seal();
  assert.equal(jsonSha256(value), sha256(text));
  assert.ok(encodeMetadata(value).equals(Buffer.from(text + "\n")));
  const reader = openEvidence(folder), replay = reader.json(ref);
  assert.equal(JSON.stringify(replay), text); assert.equal(Object.getPrototypeOf(replay), Object.prototype); reader.finish();
  assert.throws(() => { const cyclic = {}; cyclic.self = cyclic; jsonSha256(cyclic); }, /Cyclic/);
});

test("raw native metadata keeps canonical bytes and refuses excess before storage", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "browser-records-metadata-")); t.after(() => rmSync(folder, { recursive: true }));
  const store = new EvidenceStore(folder), value = Array(9000).fill("x".repeat(4096));
  assert.throws(() => store.record("oversized-metadata", value), /bounds/); assert.equal(store.files.size, 0);
});

function hostile(t, make) {
  const folder = mkdtempSync(join(tmpdir(), "browser-records-hostile-")); t.after(() => rmSync(folder, { recursive: true }));
  const store = new EvidenceStore(folder), node = (packet) => { const ref = store.blob(encoded(packet)); store.structured.add(ref.sha256); return ref; };
  const ref = make(node, store); store.records.hostile = ref; store.seal(); return { folder, ref };
}

test("bounded graph replay rejects aliases, duplicate members, oversized pages and expansion bombs", async (t) => {
  for (const change of ["alias", "duplicate", "oversize", "expansion", "missing"]) await t.test(change, (t) => {
    const { folder, ref } = hostile(t, (node) => {
      const leaf = node(["v", [1, 2, 3]]);
      if (change === "alias") return node(["l", [leaf, { ...leaf, path: "native-evidence/blobs/" + "0".repeat(64) }]]);
      if (change === "duplicate") return node(["o", [["same", leaf], ["same", leaf]]]);
      if (change === "oversize") return node(["v", "x".repeat(64 * 1024)]);
      if (change === "expansion") { let root = leaf; for (let i = 0; i < 6; i++) root = node(["a", Array(64).fill(root)]); return root; }
      return leaf;
    });
    if (change === "missing") unlinkSync(join(folder, ref.path));
    assert.throws(() => { const reader = openEvidence(folder); reader.json(ref); reader.finish(); });
  });
});

test("legacy raw JSON records remain readable without promoting historical evidence", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "browser-records-history-")); t.after(() => rmSync(folder, { recursive: true }));
  const store = new EvidenceStore(folder), original = { schema: "historical-diagnostic/v1", passed: false, observations: [1, 2, 3] };
  const ref = store.blob(encoded(original)); store.records.history = ref; const manifest = store.seal();
  delete manifest.structured; manifest.schema = "native-browser-evidence/v2";
  writeFileSync(join(folder, "native-evidence/manifest.json"), encoded(manifest));
  const before = readFileSync(join(folder, "native-evidence/manifest.json")), reader = openEvidence(folder);
  assert.equal(jsonSha256(reader.json(ref)), jsonSha256(original)); reader.finish();
  assert.ok(before.equals(readFileSync(join(folder, "native-evidence/manifest.json"))));
});

test("physical file and cumulative limits reject inventory before opening blob content", async (t) => {
  for (const change of ["file", "cumulative"]) await t.test(change, (t) => {
    const folder = mkdtempSync(join(tmpdir(), "browser-records-bounds-")); t.after(() => rmSync(folder, { recursive: true }));
    const store = new EvidenceStore(folder); for (let i = 0; i < 5; i++) store.blob(`blob-${i}`); store.seal();
    const stat = fs.lstatSync, open = fs.openSync; let opened = 0;
    const statMock = t.mock.method(fs, "lstatSync", (path, ...args) => {
      const result = stat(path, ...args);
      if (String(path).replaceAll("\\", "/").includes("/native-evidence/blobs/") && result.isFile()) result.size = 256 * 1024 ** 2 + (change === "file" ? 1 : 0);
      return result;
    });
    const openMock = t.mock.method(fs, "openSync", (path, ...args) => {
      if (String(path).replaceAll("\\", "/").includes("/native-evidence/blobs/")) opened++;
      return open(path, ...args);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => openEvidence(folder), /bounds/); assert.equal(opened, 0); }
    finally { statMock.mock.restore(); openMock.mock.restore(); syncBuiltinESMExports(); }
  });
});
