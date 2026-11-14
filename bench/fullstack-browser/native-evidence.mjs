import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { physical, durable } from "../workloads/isolated/evidence.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const encoded = (value) => Buffer.from(JSON.stringify(value) + "\n");
export function exact(value, keys) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
const maxFile = 256 * 1024 ** 2, maxTotal = 1024 ** 3, maxFiles = 50000;
const refPath = (hash) => `native-evidence/blobs/${hash}`;
function local(folder) {
  assert.ok(typeof folder === "string" && !folder.replaceAll("\\", "/").startsWith("//"), "network evidence root refused");
  return resolve(folder);
}
function reference(ref) {
  exact(ref, ["path", "bytes", "sha256"]);
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ref.path, refPath(ref.sha256));
  assert.ok(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= maxFile);
}
// Same physical/identity rules as isolated readRegular, but bound allocation
// BEFORE reading. A concurrently enlarged saved blob cannot allocate past cap.
function readBytes(path, limit = maxFile) {
  physical(dirname(path)); const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit);
  const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every((key) => a[key] === b[key]);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.ok(same(before, fstatSync(fd))); const bytes = Buffer.alloc(before.size); let at = 0;
    while (at < bytes.length) { const count = readSync(fd, bytes, at, bytes.length - at, at); assert.ok(count > 0); at += count; }
    assert.ok(same(before, fstatSync(fd)) && same(before, lstatSync(path))); physical(dirname(path)); return bytes;
  } finally { closeSync(fd); }
}
function inventory(folder) {
  physical(folder); physical(join(folder, "blobs"));
  assert.deepEqual(readdirSync(folder).sort(), ["blobs", "manifest.json"]);
  const names = readdirSync(join(folder, "blobs")).sort();
  assert.ok(names.length <= maxFiles);
  let total = 0;
  return names.map((name) => {
    assert.match(name, /^[a-f0-9]{64}$/);
    const path = join(folder, "blobs", name), stat = lstatSync(path);
    assert.ok(stat.isFile() && stat.size <= maxFile);
    total += stat.size; assert.ok(total <= maxTotal);
    const bytes = readBytes(path); assert.equal(sha256(bytes), name);
    return { path: refPath(name), bytes: bytes.length, sha256: name };
  });
}
function parse(bytes) {
  assert.ok(bytes.length <= 32 * 1024 ** 2);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.ok(encoded(value).equals(bytes), "noncanonical/duplicate-key evidence JSON");
  return value;
}

/** Exclusive namespace. Caller never passes a path obtained from saved evidence. */
export class EvidenceStore {
  constructor(folder) {
    physical(local(folder)); this.root = join(local(folder), "native-evidence");
    mkdirSync(this.root, { mode: 0o700 }); mkdirSync(join(this.root, "blobs"), { mode: 0o700 });
    this.records = {}; this.files = new Map(); this.total = 0; this.sealed = false;
  }
  blob(value) {
    assert.equal(this.sealed, false); const bytes = Buffer.from(value), hash = sha256(bytes);
    assert.ok(bytes.length <= maxFile);
    const ref = { path: refPath(hash), bytes: bytes.length, sha256: hash };
    if (!this.files.has(hash)) {
      assert.ok(this.files.size < maxFiles && this.total + bytes.length <= maxTotal);
      durable(join(this.root, "blobs", hash), bytes); this.files.set(hash, ref); this.total += bytes.length;
    } else assert.ok(readBytes(join(this.root, "blobs", hash)).equals(bytes));
    return ref;
  }
  record(name, value) {
    assert.match(name, /^[a-z][a-z0-9-]{0,79}$/); assert.ok(!Object.hasOwn(this.records, name));
    const ref = this.blob(encoded(value)); this.records[name] = ref; return ref;
  }
  seal() {
    assert.equal(this.sealed, false);
    const files = [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
    const value = { schema: "native-browser-evidence/v2", records: this.records, files, sha256: sha256(encoded(files)) };
    durable(join(this.root, "manifest.json"), encoded(value)); this.sealed = true;
    assert.deepEqual(inventory(this.root), files); return value;
  }
}

export function openEvidence(folder) {
  const root = join(local(folder), "native-evidence");
  assert.ok(existsSync(root)); physical(root);
  assert.ok(lstatSync(join(root, "manifest.json")).size <= 32 * 1024 ** 2);
  const before = readBytes(join(root, "manifest.json"), 32 * 1024 ** 2), manifest = parse(before);
  exact(manifest, ["schema", "records", "files", "sha256"]);
  assert.equal(manifest.schema, "native-browser-evidence/v2");
  const files = inventory(root); assert.deepEqual(manifest.files, files);
  assert.equal(manifest.sha256, sha256(encoded(files)));
  assert.ok(manifest.records && !Array.isArray(manifest.records));
  const available = new Map(files.map((r) => [r.sha256, r])), used = new Set();
  for (const [name, ref] of Object.entries(manifest.records)) {
    assert.match(name, /^[a-z][a-z0-9-]{0,79}$/); reference(ref); assert.deepEqual(available.get(ref.sha256), ref);
  }
  const read = (ref) => {
    reference(ref); assert.deepEqual(available.get(ref.sha256), ref);
    const bytes = readBytes(join(root, "blobs", ref.sha256));
    assert.equal(bytes.length, ref.bytes); assert.equal(sha256(bytes), ref.sha256); used.add(ref.sha256); return bytes;
  };
  return { manifest, read, json: (ref) => parse(read(ref)), finish() {
    assert.ok(before.equals(readBytes(join(root, "manifest.json"), 32 * 1024 ** 2)), "manifest changed during replay");
    assert.deepEqual(inventory(root), files, "evidence changed during replay");
    assert.deepEqual([...used].sort(), [...available.keys()].sort(), "unconsumed evidence blob");
    return manifest;
  } };
}
