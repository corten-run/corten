// Physical, bounded local evidence. No provider or campaign execution here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, createReadStream, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync,
  readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { archivePathLimits, archivePaths, portableEvidenceSegment } from "./cloud-contract.mjs";

export const evidenceEnvelope = Object.freeze({ schema: "benchmark-cloud-evidence-envelope/v1",
  compressed: 18 * 1024 ** 3, content: 16 * 1024 ** 3, tar: 17 * 1024 ** 3, ioBytes: 64 * 1024, ...archivePathLimits });
export const { compressed: archiveLimit, content: expandedLimit, tar: tarLimit, ioBytes } = evidenceEnvelope;
const depthLimit = 64, pathLimit = 4096, smallLimit = 16 * 1024 ** 2;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every((key) => a[key] === b[key]);
const bounded = (value, max) => { assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= max, "evidence bound"); return value; };
function bounds(input = {}) {
  const max = { compressed: archiveLimit, content: expandedLimit, tar: tarLimit, ...archivePathLimits };
  for (const [key, value] of Object.entries(input)) { assert.ok(Object.hasOwn(max, key)); bounded(value, max[key]); }
  return { ...max, ...input };
}
export function resolveStateRoot(path) {
  const requested = resolve(path); let parent = requested;
  for (;;) {
    try {
      assert.ok(statSync(parent).isDirectory());
      return resolve(realpathSync(parent), relative(parent, requested));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("state path missing or inaccessible");
      const next = dirname(parent);
      assert.notEqual(next, parent, "state path missing or inaccessible"); parent = next;
    }
  }
}
export function physical(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "physical directory required");
  assert.equal(realpathSync(path), path, "directory alias changed");
}
function opened(path, limit) {
  physical(dirname(path));
  const before = lstatSync(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(limit), "bounded regular unlinked file required");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { assert.ok(same(before, fstatSync(fd, { bigint: true })), "file replaced before read"); }
  catch (error) { closeSync(fd); throw error; }
  return { fd, size: Number(before.size), unchanged() {
    physical(dirname(path));
    assert.ok(same(before, fstatSync(fd, { bigint: true })) && same(before, lstatSync(path, { bigint: true })), "file changed while reading");
  } };
}
function readAt(fd, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = readSync(fd, bytes, offset, bytes.length - offset, position + offset);
    assert.ok(n > 0, "truncated evidence file"); offset += n;
  }
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); assert.ok(n > 0); offset += n; }
}
function chunks(file, consume) {
  const buffer = Buffer.alloc(ioBytes);
  for (let offset = 0; offset < file.size;) {
    const bytes = buffer.subarray(0, Math.min(buffer.length, file.size - offset));
    readAt(file.fd, bytes, offset); consume(bytes); offset += bytes.length;
  }
  file.unchanged();
}
// Small controller JSON/markers only. Archive and tree payloads never use this API.
export function regular(path, limit = smallLimit) {
  bounded(limit, smallLimit);
  const file = opened(path, limit);
  try { const bytes = Buffer.alloc(file.size); readAt(file.fd, bytes, 0); file.unchanged(); return bytes; }
  finally { closeSync(file.fd); }
}
export function fileHash(path, limit = archiveLimit) {
  bounded(limit, archiveLimit);
  const file = opened(path, limit), hash = createHash("sha256");
  try { chunks(file, (bytes) => hash.update(bytes)); return hash.digest("hex"); }
  finally { closeSync(file.fd); }
}
export function syncDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function durable(path, bytes) {
  physical(dirname(path)); const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
export function durableCopy(source, destination, expected) {
  const file = opened(source, archiveLimit), hash = createHash("sha256");
  let fd;
  try {
    physical(dirname(destination)); fd = openSync(destination, "wx", 0o600);
    chunks(file, (bytes) => { hash.update(bytes); writeAll(fd, bytes); });
    assert.equal(hash.digest("hex"), expected, "download hash differs"); fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); closeSync(file.fd); }
  syncDirectory(dirname(destination));
}

// Compact sorted directory inventory: <=32 MiB name bytes + 4.2 MiB offsets.
// opendir checks admission before retaining a name, unlike read-entire-directory.
function walkTree(root, limits, selected, hashFiles) {
  physical(root);
  const arena = Buffer.alloc(limits.nameBytes), offsets = new Uint32Array(limits.nodes), hash = createHash("sha256");
  let used = 0, count = 1, size = 0, memberBytes = 0, tarBytes = 0;
  const nameAt = (i) => { const at = offsets[i]; return arena.subarray(at + 1, at + 1 + arena[at]); };
  function visit(path, key, depth) {
    assert.ok(depth <= depthLimit && key.length <= pathLimit && Buffer.byteLength(path) <= pathLimit, "evidence path limit");
    const member = key.replace(/^\//, "");
    const stat = lstatSync(path);
    memberBytes += member.length + (key && stat.isDirectory() ? 1 : 0); assert.ok(memberBytes <= limits.memberBytes, "archive index member budget");
    assert.ok(!stat.isSymbolicLink(), "evidence link");
    if (key) tarBytes += 512 + (member.length + (stat.isDirectory() ? 1 : 0) > 100 ? 512 + Math.ceil((member.length + (stat.isDirectory() ? 1 : 0) + 1) / 512) * 512 : 0);
    if (stat.isDirectory()) {
      physical(path); hash.update(`d\0${key}\0`);
      const start = count - 1; let end = start;
      const add = (name) => {
        assert.ok(portableEvidenceSegment(name) && name.length <= 255, "unsafe evidence component");
        assert.ok(++count <= limits.nodes, "evidence tree limit");
        assert.ok(used + name.length + 1 <= arena.length, "archive index name budget");
        offsets[end++] = used; arena[used++] = name.length; arena.write(name, used, name.length, "ascii"); used += name.length;
      };
      if (depth === 0 && selected) selected.forEach(add);
      else {
        const dir = opendirSync(path);
        try { let entry; while ((entry = dir.readSync())) add(entry.name); } finally { dir.closeSync(); }
      }
      offsets.subarray(start, end).sort((a, b) => Buffer.compare(arena.subarray(a + 1, a + 1 + arena[a]), arena.subarray(b + 1, b + 1 + arena[b])));
      for (let i = start; i < end; i++) {
        const name = nameAt(i).toString("ascii"); visit(join(path, name), `${key}/${name}`, depth + 1);
      }
    } else {
      assert.ok(stat.isFile() && stat.nlink === 1, "evidence special file/hardlink");
      size += stat.size; assert.ok(size <= limits.content, "evidence size limit");
      tarBytes += Math.ceil(stat.size / 512) * 512;
      hash.update(`f\0${key}\0${stat.size}\0`);
      const file = opened(path, limits.content);
      try {
        assert.equal(file.size, stat.size, "evidence file changed");
        if (hashFiles) chunks(file, (bytes) => hash.update(bytes)); else file.unchanged();
      } finally { closeSync(file.fd); }
    }
  }
  visit(root, "", 0);
  return { sha256: hashFiles ? hash.digest("hex") : null, nodes: count, bytes: size, tarBytes: Math.ceil((tarBytes + 1024) / 10240) * 10240 };
}
export function treeHash(root, lowered = {}) { return walkTree(root, bounds(lowered), null, true).sha256; }
export function checkPackage(root) {
  physical(root);
  const selected = ["run.log", "host.txt", "exit-code"];
  for (const name of selected) {
    const stat = lstatSync(join(root, name)); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "package metadata must be regular");
  }
  const campaign = lstatSync(join(root, "campaign"), { throwIfNoEntry: false });
  if (campaign) { assert.ok(campaign.isDirectory() && !campaign.isSymbolicLink(), "package campaign must be physical"); selected.push("campaign"); }
  const result = walkTree(root, bounds(), selected, false);
  assert.ok(result.tarBytes <= tarLimit, "expanded archive size limit"); return result;
}

const text = (field) => {
  const zero = field.indexOf(0), end = zero === -1 ? field.length : zero;
  if (zero !== -1) assert.ok(field.subarray(zero).every((b) => b === 0), "tar field suffix");
  assert.ok(field.subarray(0, end).every((b) => b >= 32 && b <= 126), "non-ASCII tar name");
  return field.subarray(0, end).toString("ascii");
};
const octal = (field) => {
  assert.ok(field.every((b) => b === 0 || b === 32 || b >= 48 && b <= 55), "tar numeric encoding");
  const value = field.toString("ascii"); assert.match(value, /^[0-7]+[\0 ]*$/, "tar numeric encoding");
  const n = Number.parseInt(value, 8); assert.ok(Number.isSafeInteger(n)); return n;
};

// Every byte, including body padding and both trailer blocks, contributes to the
// spool receipt. File bodies are drained, not retained in the validated index.
function scanTar(file, limits, destination, extract = false) {
  const paths = extract ? null : archivePaths({ nodes: limits.nodes, nameBytes: limits.nameBytes, memberBytes: limits.memberBytes });
  const hash = createHash("sha256"), buffer = Buffer.alloc(ioBytes);
  let offset = 0, content = 0, longName = null, ended = false, headers = 0;
  const consume = (size, use = () => {}) => {
    assert.ok(offset + size <= file.size, "truncated tar body");
    while (size) {
      const bytes = buffer.subarray(0, Math.min(size, buffer.length)); readAt(file.fd, bytes, offset);
      hash.update(bytes); use(bytes); offset += bytes.length; size -= bytes.length;
    }
  };
  const small = (size) => { const bytes = Buffer.alloc(size); let at = 0; consume(size, (part) => { part.copy(bytes, at); at += part.length; }); return bytes; };
  const zero = (bytes) => assert.ok(bytes.every((b) => b === 0), "tar trailing content/padding");
  while (offset + 512 <= file.size) {
    const h = small(512);
    if (h.every((b) => b === 0)) {
      assert.ok(file.size - offset >= 512 && file.size % 512 === 0, "tar trailing content");
      consume(file.size - offset, zero); ended = true; break;
    }
    assert.ok(++headers <= 2 * limits.nodes, "archive header limit");
    const sum = h.reduce((total, b, i) => total + (i >= 148 && i < 156 ? 32 : b), 0);
    assert.equal(octal(h.subarray(148, 156)), sum, "tar checksum");
    assert.ok(h.subarray(257, 263).equals(Buffer.from("ustar\0")) || h.subarray(257, 263).equals(Buffer.from("ustar ")), "tar format");
    const size = octal(h.subarray(124, 136)), type = String.fromCharCode(h[156] || 48), padding = (512 - size % 512) % 512;
    assert.ok(offset + size + padding <= file.size, "truncated tar body");
    if (type === "L") {
      assert.equal(longName, null, "repeated GNU long name"); assert.ok(size >= 1 && size <= 4097, "GNU long name bound");
      const body = small(size); assert.equal(body.at(-1), 0, "GNU long name terminator"); longName = text(body); consume(padding, zero); continue;
    }
    assert.ok(type === "0" || type === "5", "archive link, special file or extension");
    assert.equal(text(h.subarray(157, 257)), "", "tar link target");
    const prefix = h[262] === 0 ? text(h.subarray(345, 500)) : "";
    const name = longName ?? `${prefix ? `${prefix}/` : ""}${text(h.subarray(0, 100))}`; longName = null;
    const directory = type === "5"; assert.ok(!directory || size === 0, "directory has body");
    paths?.add(name, directory); content += size; assert.ok(content <= limits.content, "evidence size limit");
    if (destination) assert.ok(Buffer.byteLength(join(destination, name)) <= pathLimit, "extraction path limit");
    if (extract) {
      const parts = name.replace(/\/$/, "").split("/"); let parent = destination;
      for (const segment of directory ? parts : parts.slice(0, -1)) {
        parent = join(parent, segment);
        try { mkdirSync(parent, { mode: 0o700 }); syncDirectory(dirname(parent)); } catch (error) { if (error.code !== "EEXIST") throw error; }
        physical(parent);
      }
      if (!directory) {
        physical(parent); const fd = openSync(join(parent, parts.at(-1)), "wx", 0o600);
        try { consume(size, (bytes) => writeAll(fd, bytes)); fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(parent);
      }
    } else consume(size);
    consume(padding, zero);
  }
  assert.ok(ended && longName === null, "incomplete tar archive");
  file.unchanged(); return { ...paths?.finish(), bytes: content, sha256: hash.digest("hex") };
}

async function spooled(input, expected, lowered, destination, extract) {
  const limits = bounds(lowered), source = typeof input === "string" ? opened(input, limits.compressed) : null;
  let scratch, scratchIdentity, spoolParent, fd;
  try {
    // Buffer input is retained only for small local fixtures. Production uses a physical file.
    if (!source) assert.ok(Buffer.isBuffer(input) && input.length <= Math.min(limits.compressed, smallLimit), "compressed archive size limit");
    spoolParent = source ? dirname(input) : realpathSync(tmpdir()); physical(spoolParent);
    scratch = mkdtempSync(join(spoolParent, ".cloud-spool-")); physical(scratch); scratchIdentity = lstatSync(scratch, { bigint: true });
    const path = join(scratch, "archive.tar"); fd = openSync(path, "wx+", 0o600);
    const compressedHash = createHash("sha256"), tarHash = createHash("sha256"); let compressed = 0, expanded = 0;
    const raw = source ? createReadStream(null, { fd: source.fd, autoClose: false, start: 0, highWaterMark: ioBytes })
      : Readable.from((function* () { for (let at = 0; at < input.length; at += ioBytes) yield input.subarray(at, at + ioBytes); })(), { objectMode: false, highWaterMark: ioBytes });
    async function* counted() {
      for await (const bytes of raw) {
        compressed += bytes.length; assert.ok(compressed <= limits.compressed, "compressed archive size limit"); compressedHash.update(bytes); yield bytes;
      }
    }
    await pipeline(Readable.from(counted(), { objectMode: false, highWaterMark: ioBytes }), createGunzip({ chunkSize: ioBytes }),
      new Writable({ highWaterMark: ioBytes, write(bytes, encoding, done) {
        try {
          expanded += bytes.length; assert.ok(expanded <= limits.tar, "expanded archive size limit");
          tarHash.update(bytes); writeAll(fd, bytes); done();
        } catch (error) { done(error); }
      } }));
    if (source) { assert.equal(compressed, source.size, "archive changed while reading"); source.unchanged(); }
    const archiveSha256 = compressedHash.digest("hex");
    if (expected !== undefined) assert.equal(archiveSha256, expected, "archive changed; preserve host");
    fsyncSync(fd);
    const before = fstatSync(fd, { bigint: true }); assert.equal(before.size, BigInt(expanded));
    const file = { fd, size: expanded, unchanged() {
      physical(scratch); assert.ok(same(before, fstatSync(fd, { bigint: true })) && same(before, lstatSync(path, { bigint: true })), "spool changed while reading");
    } };
    const receipt = tarHash.digest("hex"), preflight = scanTar(file, limits, destination);
    assert.equal(preflight.sha256, receipt, "spool differs from decoded archive");
    if (extract) {
      physical(destination); assert.deepEqual(readdirSync(destination), [], "fresh extraction required"); file.unchanged();
      assert.equal(scanTar(file, limits, destination, true).sha256, receipt, "extracted spool differs");
      syncDirectory(destination); return treeHash(destination, lowered);
    }
    return { ...preflight, archiveSha256 };
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (source) closeSync(source.fd);
    if (scratch) {
      // Only this invocation's exclusively created spool, never partial evidence.
      assert.equal(dirname(scratch), spoolParent); physical(spoolParent); physical(scratch);
      const now = lstatSync(scratch, { bigint: true });
      assert.ok(now.dev === scratchIdentity.dev && now.ino === scratchIdentity.ino, "owned spool directory replaced");
      rmSync(scratch, { recursive: true });
    }
  }
}
export async function archiveMembers(input, expected, lowered = {}) { return spooled(input, expected, lowered); }
export async function extractArchive(input, destination, expected, lowered = {}) {
  physical(destination); assert.deepEqual(readdirSync(destination), [], "fresh extraction required");
  return spooled(input, expected, lowered, destination, true);
}
