// Physical, bounded local evidence. No provider or campaign execution here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { safeArchive } from "./cloud-contract.mjs";

export const archiveLimit = 256 * 1024 ** 2, expandedLimit = 512 * 1024 ** 2;
const treeLimit = 100000, depthLimit = 64, pathLimit = 4096;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function physical(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "physical directory required");
  assert.equal(realpathSync(path), path, "directory alias changed");
}
export function regular(path, limit = archiveLimit) {
  physical(dirname(path));
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit, "bounded regular unlinked file required");
  const bytes = readFileSync(path);
  assert.equal(bytes.length, stat.size, "file changed while reading");
  return bytes;
}
export function syncDirectory(path) {
  if (process.platform === "win32") return; // Windows does not support opening directories for fsync.
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function durable(path, bytes) {
  physical(dirname(path));
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
export function treeHash(root) {
  const hash = createHash("sha256"); let count = 0, size = 0;
  function visit(path, key, depth) {
    assert.ok(++count <= treeLimit && depth <= depthLimit, "evidence tree limit");
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), "evidence link");
    if (stat.isDirectory()) {
      physical(path); hash.update(`d\0${key}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${key}/${name}`, depth + 1);
    } else {
      assert.ok(stat.isFile() && stat.nlink === 1, "evidence special file/hardlink");
      size += stat.size; assert.ok(size <= expandedLimit, "evidence size limit");
      hash.update(`f\0${key}\0${stat.size}\0`); hash.update(regular(path, expandedLimit));
    }
  }
  visit(root, "", 0); return hash.digest("hex");
}

// Decode the same bytes we inspect, not tar's human-readable listings. Reject pax,
// sparse files and every extension except GNU long names (emitted by the fixed packer).
export function archiveMembers(bytes) {
  assert.ok(bytes.length <= archiveLimit, "compressed archive size limit");
  const tar = gunzipSync(bytes, { maxOutputLength: expandedLimit }), members = [];
  let offset = 0, longName = null, ended = false;
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
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512); offset += 512;
    if (h.every((b) => b === 0)) {
      assert.ok(tar.length - offset >= 512 && tar.subarray(offset).every((b) => b === 0), "tar trailing content");
      ended = true; break;
    }
    assert.ok(members.length < 100000, "archive entry limit");
    const sum = h.reduce((total, b, i) => total + (i >= 148 && i < 156 ? 32 : b), 0);
    assert.equal(octal(h.subarray(148, 156)), sum, "tar checksum");
    assert.ok(h.subarray(257, 263).equals(Buffer.from("ustar\0")) || h.subarray(257, 263).equals(Buffer.from("ustar ")), "tar format");
    const size = octal(h.subarray(124, 136)), type = String.fromCharCode(h[156] || 48);
    assert.ok(offset + Math.ceil(size / 512) * 512 <= tar.length, "truncated tar body");
    const body = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === "L") {
      assert.equal(longName, null, "repeated GNU long name"); assert.ok(size <= 4097);
      longName = text(body); continue;
    }
    assert.ok(type === "0" || type === "5", "archive link, special file or extension");
    assert.equal(text(h.subarray(157, 257)), "", "tar link target");
    const prefix = h[262] === 0 ? text(h.subarray(345, 500)) : "";
    const name = longName ?? `${prefix ? `${prefix}/` : ""}${text(h.subarray(0, 100))}`; longName = null;
    assert.ok(type !== "5" || size === 0, "directory has body");
    members.push({ name, directory: type === "5", body });
  }
  assert.ok(ended && longName === null, "incomplete tar archive");
  archiveTree(members);
  safeArchive(members.map((e) => e.name).join("\n") + "\n", members.map((e) => e.directory ? "d" : "-").join("\n") + "\n");
  return members;
}

function archiveTree(members, destination) {
  // Include the extraction root and every implicit directory, not just tar headers.
  const nodes = new Set([""]); let size = 0;
  for (const entry of members) {
    const parts = entry.name.replace(/\/$/, "").split("/");
    assert.ok(parts.length <= depthLimit && entry.name.length <= pathLimit, "evidence path limit");
    let path = "";
    for (const part of parts) {
      assert.ok(part.length <= 255, "evidence component limit");
      path = path ? `${path}/${part}` : part;
      if (destination) assert.ok(Buffer.byteLength(join(destination, path)) <= pathLimit, "extraction path limit");
      nodes.add(path); assert.ok(nodes.size <= treeLimit, "evidence tree limit");
    }
    if (!entry.directory) size += entry.body.length;
    assert.ok(size <= expandedLimit, "evidence size limit");
  }
}

export function extractArchive(bytes, destination) {
  physical(destination); assert.deepEqual(readdirSync(destination), [], "fresh extraction required");
  const members = archiveMembers(bytes);
  archiveTree(members, destination);
  // Parents are created only after validation of the entire archive.
  for (const entry of members) {
    const parts = entry.name.replace(/\/$/, "").split("/"); let parent = destination;
    for (const segment of parts.slice(0, -1)) {
      parent = join(parent, segment);
      try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      physical(parent);
    }
    const path = join(parent, parts.at(-1));
    if (entry.directory) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      physical(path);
    } else durable(path, entry.body);
  }
  syncDirectory(destination); return treeHash(destination);
}
