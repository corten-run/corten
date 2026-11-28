import assert from "node:assert/strict";
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256 } from "./contract.mjs";
import { readFixedStreamSync, verifyStreamReceipt } from "./fixed-stream.mjs";

function referenceKeys(reference, expected, message) {
  const keys = Object.keys(reference ?? {});
  assert.ok(keys.length === expected.length && expected.every((key) => keys.includes(key)), message);
}

export function contained(root, path) {
  assert.ok(typeof path === "string" && path.length && !isAbsolute(path) && !path.includes("\\") && !path.includes(":"), "relative artifact path required");
  assert.ok(path.split("/").every((part) => part && part !== "." && part !== ".."), "unsafe artifact path");
  const absolute = resolve(root, path), rel = relative(resolve(root), absolute);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel), "artifact escapes root");
  return absolute;
}
export function writer(root) {
  return (path, value) => {
    const bytes = JSON.stringify(value, null, 2);
    writeFileSync(contained(root, path), bytes);
    return { path, sha256: sha256(bytes) };
  };
}
export function reader(root) {
  const load = (reference) => {
    referenceKeys(reference, ["path", "sha256"], "artifact reference must bind path and hash");
    const bytes = readContained(root, reference.path);
    assert.ok(sha256(bytes) === reference.sha256, "raw artifact digest differs");
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new SyntaxError("invalid raw artifact JSON"); }
  };
  load.stream = (reference) => {
    referenceKeys(reference, ["path", "receipt"], "full raw stream reference required");
    verifyStreamReceipt(reference.receipt);
    return readFixedStreamSync(realContained(root, reference.path), reference.receipt);
  };
  load.bytes = (reference, cap) => {
    assert.ok(Number.isSafeInteger(cap) && cap > 0, "bounded raw byte reader required");
    referenceKeys(reference, ["bytes", "path", "sha256"], "raw byte reference required");
    assert.ok(Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && reference.bytes <= cap, "raw byte reference over cap");
    const fd = openSync(realContained(root, reference.path), "r");
    try {
      const info = fstatSync(fd); assert.ok(info.isFile() && info.size === reference.bytes, "raw byte length differs");
      const buffer = Buffer.alloc(info.size + 1); let length = 0, n;
      while (length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null))) length += n;
      assert.equal(length, reference.bytes, "raw bytes changed during replay");
      const bytes = buffer.subarray(0, length); assert.ok(sha256(bytes) === reference.sha256, "raw byte digest differs"); return bytes;
    } finally { closeSync(fd); }
  };
  return load;
}
function realContained(root, path) {
  const file = contained(root, path), realRoot = realpathSync(root), real = realpathSync(file), rel = relative(realRoot, real);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel), "artifact symlink escapes root");
  return real;
}
export function readContained(root, path) {
  return readFileSync(realContained(root, path));
}
