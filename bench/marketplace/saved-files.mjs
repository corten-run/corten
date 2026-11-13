import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const stable = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every((k) => a[k] === b[k]);
function localPath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value), "invalid saved folder");
  assert.ok(!/^[\\/]{2}/.test(value) && (!value.includes(":") || /^[a-z]:[\\/]/i.test(value) && !value.slice(2).includes(":")), "saved folder must be local, not UNC/device/ADS");
  assert.ok(!/[?*<>|]/.test(value), "unsafe saved folder");
  for (const part of value.split(/[\\/]/)) {
    if (/^[a-z]:$/i.test(part) || part === "" || part === "." || part === "..") continue;
    assert.ok(!/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), "unsafe saved folder component");
  }
}
function checkedPath(path, directory) {
  const root = parse(path).root;
  let at = root;
  const parts = relative(root, path).split(sep).filter(Boolean);
  let stat = lstatSync(root);
  for (const [i, part] of parts.entries()) {
    at = join(at, part); stat = lstatSync(at);
    assert.ok(!stat.isSymbolicLink(), `linked evidence path: ${at}`);
    assert.ok(i === parts.length - 1 && !directory ? stat.isFile() && stat.nlink === 1 : stat.isDirectory(), `unsafe evidence entry: ${at}`);
  }
  assert.ok(samePath(realpathSync(path), path), "evidence path resolves elsewhere");
  return stat;
}
/** Fixed local tree, at most 25,000 entries, depth 8, 32 MiB/file, 512 MiB read total. */
export function savedFiles(folder) {
  localPath(folder);
  const root = resolve(folder);
  assert.notEqual(root, parse(root).root, "saved folder must not be a filesystem root");
  checkedPath(root, true);
  let entries = 0, bytes = 0;
  function scan(at, depth) {
    assert.ok(depth <= 8, "saved evidence exceeds directory depth bound");
    const dir = opendirSync(at);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        assert.ok(++entries <= 25000, "saved evidence exceeds entry bound");
        const path = join(at, entry.name), stat = lstatSync(path);
        assert.ok(!stat.isSymbolicLink(), "linked saved evidence entry");
        if (stat.isDirectory()) scan(path, depth + 1);
        else assert.ok(stat.isFile() && stat.nlink === 1, "non-regular or hardlinked saved evidence entry");
      }
    } finally { dir.closeSync(); }
  }
  scan(root, 0);
  function read(name) {
    assert.ok(typeof name === "string" && !isAbsolute(name) && /^[a-zA-Z0-9_./-]+$/.test(name) && name.split("/").every((p) => p && p !== "." && p !== ".."), "unsafe raw evidence reference");
    const path = join(root, name), before = checkedPath(path, false);
    assert.ok(before.size <= 32 * 2 ** 20 && (bytes += before.size) <= 512 * 2 ** 20, "saved evidence exceeds read bound");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      assert.ok(opened.isFile() && opened.nlink === 1 && stable(before, opened), "evidence changed while opening");
      const data = Buffer.alloc(before.size + 1);
      let size = 0, n;
      while (size < data.length && (n = readSync(fd, data, size, data.length - size, null))) size += n;
      assert.equal(size, before.size, "evidence changed while reading");
      assert.ok(stable(before, fstatSync(fd)) && stable(before, checkedPath(path, false)), "evidence changed while reading");
      return data.subarray(0, size).toString("utf8");
    } finally { closeSync(fd); }
  }
  return { text: read, json: (name) => JSON.parse(read(name)) };
}
