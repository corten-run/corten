import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { physical, durable } from "../workloads/isolated/evidence.mjs";
import { writeJSON, readJSON, encodeMetadata } from "./json-records.mjs";

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
function readBytes(path, limit = maxFile, digestOnly = false) {
  physical(dirname(path)); const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit);
  const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every((key) => a[key] === b[key]);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.ok(same(before, fstatSync(fd))); const bytes = Buffer.alloc(digestOnly ? Math.min(64 * 1024, before.size) : before.size), digest = digestOnly ? createHash("sha256") : null; let at = 0;
    while (at < before.size) {
      const count = readSync(fd, bytes, digestOnly ? 0 : at, Math.min(bytes.length, before.size - at), at); assert.ok(count > 0);
      if (digest) digest.update(bytes.subarray(0, count)); at += count;
    }
    assert.ok(same(before, fstatSync(fd)) && same(before, lstatSync(path))); physical(dirname(path)); return digest ? digest.digest("hex") : bytes;
  } finally { closeSync(fd); }
}
function inventory(folder) {
  physical(folder); physical(join(folder, "blobs"));
  const members = readdirSync(folder).sort();
  assert.ok(members.length === 2 && members[0] === "blobs" && members[1] === "manifest.json", "Unknown native evidence member");
  const names = readdirSync(join(folder, "blobs")).sort();
  assert.ok(names.length <= maxFiles, "Native evidence inventory exceeds bounds");
  let total = 0;
  const entries = names.map((name) => {
    assert.match(name, /^[a-f0-9]{64}$/);
    const path = join(folder, "blobs", name), stat = lstatSync(path);
    assert.ok(stat.isFile() && stat.size <= maxFile, "Native evidence member exceeds bounds");
    total += stat.size; assert.ok(total <= maxTotal, "Native evidence total exceeds bounds");
    return { name, path, size: stat.size };
  });
  return entries.map(({ name, path, size }) => {
    assert.equal(readBytes(path, maxFile, true), name);
    return { path: refPath(name), bytes: size, sha256: name };
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
    this.records = {}; this.files = new Map(); this.structured = new Set(); this.total = 0; this.sealed = false;
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
    // Source/tool/execution metadata keeps its original canonical byte identity,
    // notably the execution root also used as the native host subject.
    const bytes = encodeMetadata(value);
    const ref = this.blob(bytes); this.records[name] = ref; return ref;
  }
  recordJSON(name, value) {
    assert.match(name, /^[a-z][a-z0-9-]{0,79}$/); assert.ok(!Object.hasOwn(this.records, name));
    const ref = this.json(value); this.records[name] = ref; return ref;
  }
  json(value) { assert.equal(this.sealed, false); return writeJSON(value, (bytes) => this.blob(bytes), this.structured); }
  readJSON(ref) {
    return readJSON(ref, (r) => {
      reference(r); assert.ok(encoded(this.files.get(r.sha256)).equals(encoded(r)), "Unknown JSON record reference");
      const bytes = readBytes(join(this.root, "blobs", r.sha256)); assert.equal(sha256(bytes), r.sha256); return bytes;
    }, this.structured, parse);
  }
  seal() {
    assert.equal(this.sealed, false);
    const files = [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
    const value = { schema: "native-browser-evidence/v3", records: this.records, structured: [...this.structured].sort(), files, sha256: sha256(encoded(files)) };
    durable(join(this.root, "manifest.json"), encoded(value)); this.sealed = true;
    assert.ok(encoded(inventory(this.root)).equals(encoded(files)), "Store inventory differs"); return value;
  }
}

export function openEvidence(folder) {
  const root = join(local(folder), "native-evidence");
  assert.ok(existsSync(root)); physical(root);
  assert.ok(lstatSync(join(root, "manifest.json")).size <= 32 * 1024 ** 2);
  const before = readBytes(join(root, "manifest.json"), 32 * 1024 ** 2), manifest = parse(before);
  assert.ok(["native-browser-evidence/v2", "native-browser-evidence/v3"].includes(manifest.schema));
  const paged = manifest.schema === "native-browser-evidence/v3";
  exact(manifest, ["schema", "records", "files", "sha256", ...(paged ? ["structured"] : [])]);
  const files = inventory(root); assert.ok(encoded(manifest.files).equals(encoded(files)), "Manifest inventory differs");
  assert.equal(manifest.sha256, sha256(encoded(files)));
  assert.ok(manifest.records && typeof manifest.records === "object" && !Array.isArray(manifest.records));
  const available = new Map(files.map((r) => [r.sha256, r])), used = new Set();
  const structured = new Set(paged ? manifest.structured : []);
  if (paged) {
    assert.ok(Array.isArray(manifest.structured) && encoded([...structured].sort()).equals(encoded(manifest.structured)), "Noncanonical structured inventory");
    for (const hash of structured) assert.ok(available.has(hash), "Missing structured page");
  }
  for (const [name, ref] of Object.entries(manifest.records)) {
    assert.match(name, /^[a-z][a-z0-9-]{0,79}$/); reference(ref); assert.deepEqual(available.get(ref.sha256), ref);
  }
  const read = (ref) => {
    reference(ref); assert.deepEqual(available.get(ref.sha256), ref);
    const bytes = readBytes(join(root, "blobs", ref.sha256));
    assert.equal(bytes.length, ref.bytes); assert.equal(sha256(bytes), ref.sha256); used.add(ref.sha256); return bytes;
  };
  return { manifest, read, json: (ref) => structured.has(ref.sha256) ? readJSON(ref, read, structured, parse) : parse(read(ref)), finish() {
    assert.ok(before.equals(readBytes(join(root, "manifest.json"), 32 * 1024 ** 2)), "manifest changed during replay");
    assert.ok(encoded(inventory(root)).equals(encoded(files)), "evidence changed during replay");
    assert.ok(used.size === available.size && [...available.keys()].every((hash) => used.has(hash)), "unconsumed evidence blob");
    return manifest;
  } };
}
