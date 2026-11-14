import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, linkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, openEvidence, sha256 } from "./native-evidence.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "corten-native-store-"));
  t.after(() => rmSync(root, { recursive: true })); const store = new EvidenceStore(root);
  const data = store.blob("public native bytes"), ref = store.record("source", { data }); store.seal();
  return { root, data, ref };
}
test("bounded content-addressed store seals, consumes and rechecks every file", (t) => {
  const { root, ref, data } = fixture(t), reader = openEvidence(root);
  assert.deepEqual(reader.json(ref), { data }); assert.equal(reader.read(data).toString(), "public native bytes");
  const before = readFileSync(join(root, "native-evidence/manifest.json")); reader.finish();
  assert.ok(readFileSync(join(root, "native-evidence/manifest.json")).equals(before));
  assert.throws(() => reader.read({ ...data, path: "C:/untrusted" }));
  assert.throws(() => reader.read({ ...data, bytes: data.bytes + 1 }));
});
test("unconsumed blobs, missing/extra/corrupt members and duplicate keys fail closed", async (t) => {
  for (const change of ["unused", "extra", "corrupt", "duplicate"]) await t.test(change, (t) => {
    const { root, ref, data } = fixture(t), reader = openEvidence(root);
    if (change === "unused") { reader.json(ref); assert.throws(() => reader.finish()); return; }
    if (change === "extra") writeFileSync(join(root, "native-evidence/extra.json"), "{}");
    if (change === "corrupt") writeFileSync(join(root, data.path), "wrong");
    if (change === "duplicate") {
      const path = join(root, "native-evidence/manifest.json"), text = readFileSync(path, "utf8");
      writeFileSync(path, text.replace('"schema":', '"schema":"duplicate","schema":'));
    }
    assert.throws(() => openEvidence(root));
  });
});
test("hard links, symlinks and mutation during replay cannot hide behind the seal", async (t) => {
  for (const change of ["hardlink", "symlink", "mutation"]) await t.test(change, (t) => {
    const { root, ref, data } = fixture(t), reader = openEvidence(root);
    if (change === "hardlink") linkSync(join(root, data.path), join(root, "linked"));
    if (change === "symlink") symlinkSync(join(root, "native-evidence/blobs"), join(root, "native-evidence/linked"), "junction");
    if (change === "mutation") writeFileSync(join(root, data.path), "different bytes");
    assert.throws(() => { reader.json(ref); reader.read(data); reader.finish(); });
  });
});
test("store refuses duplicate reservation, unsafe record names and post-seal writes", (t) => {
  const { root } = fixture(t); assert.throws(() => new EvidenceStore(root));
  const other = mkdtempSync(join(tmpdir(), "corten-native-store-")); t.after(() => rmSync(other, { recursive: true }));
  const store = new EvidenceStore(other); assert.throws(() => store.record("../outside", {}));
  store.record("one", {}); assert.throws(() => store.record("one", {})); store.seal(); assert.throws(() => store.blob("later"));
  assert.equal(sha256("bytes").length, 64);
});
