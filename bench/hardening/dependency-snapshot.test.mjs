import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { digest, savedFiles, snapshotDependencies } from "./evidence.mjs";

const inputPath = (path, input) => {
  if (path === input) return true;
  if (!String(path).startsWith("/proc/self/fd/")) return false;
  try { return fs.realpathSync(path) === input; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "hardening-dependencies-"));
  const from = join(root, "installed"), to = join(root, "snapshot"); fs.mkdirSync(from);
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); fs.rmSync(root, { recursive: true });
  });
  const file = (name, body = "actual installed bytes") => {
    const path = join(from, name); fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, body); return path;
  };
  return { root, from, to, file };
}
function diagnostic(action, reason, path, type) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "ERR_DEPENDENCY_SNAPSHOT");
    assert.ok(error.message.length < 600);
    assert.ok(!error.message.includes(tmpdir()) && !error.message.includes("PRIVATE_CONTENT"));
    const value = JSON.parse(error.message.slice(error.message.indexOf("{")));
    assert.equal(value.reason, reason); if (path) assert.equal(value.path, path); if (type) assert.equal(value.type, type);
    assert.ok(value.nlink === null || /^\d+$/.test(value.nlink)); return true;
  });
}

test("esbuild's installed regular hardlink pair becomes independent single-link evidence", (t) => {
  const f = fixture(t), bytes = Buffer.alloc(11427952, 37);
  const binary = f.file("@esbuild/linux-x64/bin/esbuild", bytes), alias = join(f.from, "esbuild/bin/esbuild");
  fs.mkdirSync(dirname(alias), { recursive: true }); fs.linkSync(binary, alias);
  assert.equal(fs.lstatSync(binary).nlink, 2); assert.equal(fs.lstatSync(alias).nlink, 2);
  const rows = snapshotDependencies(f.from, f.to);
  assert.deepEqual(rows.map((r) => r.path), ["@esbuild/linux-x64/bin/esbuild", "esbuild/bin/esbuild"]);
  for (const row of rows) {
    const copy = join(f.to, row.path); assert.equal(row.sha256, digest(bytes)); assert.equal(row.bytes, bytes.length);
    assert.equal(fs.lstatSync(copy).nlink, 1);
    assert.notEqual(fs.lstatSync(copy).ino, fs.lstatSync(binary).ino);
  }
  fs.writeFileSync(alias, "later source edit");
  assert.deepEqual(savedFiles(f.to), rows, "the saved snapshot must not remain aliased to installed files");
  fs.linkSync(join(f.to, rows[0].path), join(f.to, "malicious-hardlink"));
  assert.throws(() => savedFiles(f.to), "saved evidence still rejects hardlinks");
});

test("only top-level unused .bin launchers are excluded", (t) => {
  const f = fixture(t); f.file("worker.mjs");
  fs.symlinkSync(f.root, join(f.from, ".bin"), "junction");
  assert.deepEqual(snapshotDependencies(f.from, f.to).map((r) => r.path), ["worker.mjs"]);
});

for (const where of ["root", "ancestor", "nested"]) test(`dependency ${where} symlinks cannot be followed`, (t) => {
  const f = fixture(t); const outside = join(f.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "secret"), "PRIVATE_CONTENT");
  let from = f.from, path = ".";
  if (where === "root") { fs.rmSync(f.from, { recursive: true }); fs.symlinkSync(outside, f.from, "junction"); }
  if (where === "ancestor") { const link = join(f.root, "link"); fs.symlinkSync(f.root, link, "junction"); from = join(link, "installed"); }
  if (where === "nested") { fs.symlinkSync(outside, join(f.from, "package"), "junction"); path = "package"; }
  diagnostic(() => snapshotDependencies(from, f.to), "linked-input", path, "symlink");
});

test("regular-looking source replacement is rejected before any content read", (t) => {
  const f = fixture(t), input = f.file("worker.mjs"), open = fs.openSync; let reads = 0;
  t.mock.method(fs, "openSync", (path, ...args) => {
    if (inputPath(path, input)) { fs.renameSync(input, input + ".held"); fs.writeFileSync(input, "actual installed bytes"); }
    return open(path, ...args);
  });
  t.mock.method(fs, "readSync", () => { reads++; throw new Error("must not read replaced input"); }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "changed-input", "worker.mjs", "file"); assert.equal(reads, 0);
});

test("a symlink substituted at open cannot supply content", (t) => {
  const f = fixture(t), input = f.file("worker.mjs"), outside = join(f.root, "private"); fs.writeFileSync(outside, "PRIVATE_CONTENT");
  const open = fs.openSync; let reads = 0;
  t.mock.method(fs, "openSync", (path, ...args) => {
    if (inputPath(path, input)) { fs.rmSync(input); fs.symlinkSync(outside, input); }
    return open(path, ...args);
  });
  t.mock.method(fs, "readSync", () => { reads++; throw new Error("must not read symlink target"); }); syncBuiltinESMExports();
  assert.throws(() => snapshotDependencies(f.from, f.to), { code: "ERR_DEPENDENCY_SNAPSHOT" }); assert.equal(reads, 0);
});

for (const change of ["bytes", "hardlink-alias", "link-count", "mode"]) test(`source ${change} changes during a descriptor read remain invalid`, (t) => {
  const f = fixture(t), input = f.file("worker.mjs"), alias = join(f.root, "alias");
  if (change === "hardlink-alias") fs.linkSync(input, alias);
  const read = fs.readSync; let changed = false;
  t.mock.method(fs, "readSync", (fd, ...args) => {
    const n = read(fd, ...args);
    if (!changed) {
      changed = true;
      if (change === "link-count") fs.linkSync(input, alias);
      else if (change === "mode") fs.chmodSync(input, 0o444);
      else fs.writeFileSync(change === "hardlink-alias" ? alias : input, "changed installed bytes");
    }
    return n;
  }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "changed-input", "worker.mjs", "file");
});

test("a completed earlier file cannot change while a later file is copied", (t) => {
  const f = fixture(t), earlier = f.file("a.mjs"), later = f.file("b.mjs"), open = fs.openSync;
  t.mock.method(fs, "openSync", (path, ...args) => {
    if (inputPath(path, later)) fs.writeFileSync(earlier, "changed earlier input");
    return open(path, ...args);
  }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "changed-input", "a.mjs", "file");
});

test("source directory membership must stay stable", (t) => {
  const f = fixture(t); f.file("worker.mjs"); const read = fs.readSync; let changed = false;
  t.mock.method(fs, "readSync", (...args) => {
    const n = read(...args); if (!changed) { changed = true; f.file("added.mjs"); } return n;
  }); syncBuiltinESMExports();
  assert.throws(() => snapshotDependencies(f.from, f.to), { code: "ERR_DEPENDENCY_SNAPSHOT" });
});

test("special source entries fail with bounded path/type/link diagnostics before open", (t) => {
  const f = fixture(t), input = f.file("pipe"), lstat = fs.lstatSync, open = fs.openSync; let opened = false;
  t.mock.method(fs, "lstatSync", (path, ...args) => {
    const stat = lstat(path, ...args); if (!inputPath(path, input)) return stat;
    return Object.assign(Object.create(stat), { isFile: () => false, isDirectory: () => false, isFIFO: () => true });
  });
  t.mock.method(fs, "openSync", (path, ...args) => { if (inputPath(path, input)) opened = true; return open(path, ...args); }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "unsupported-entry", "pipe", "fifo"); assert.equal(opened, false);
});

test("an actual Linux FIFO is rejected without opening or blocking", { skip: process.platform !== "linux" && "requires mkfifo" }, (t) => {
  const f = fixture(t); execFileSync("mkfifo", [join(f.from, "pipe")], { timeout: 1000, env: { PATH: "/usr/bin:/bin" } });
  diagnostic(() => snapshotDependencies(f.from, f.to), "unsupported-entry", "pipe", "fifo");
});

for (const bound of ["file", "total"]) test(`dependency ${bound} byte bounds apply before reading`, (t) => {
  const f = fixture(t), lstat = fs.lstatSync; let reads = 0;
  for (let i = 0; i < (bound === "file" ? 1 : 9); i++) f.file(`${i}.mjs`);
  t.mock.method(fs, "lstatSync", (path, ...args) => {
    const stat = lstat(path, ...args);
    return String(path).endsWith(".mjs") ? Object.assign(Object.create(stat), { size: args[0]?.bigint ? BigInt(512 * 1024 ** 2 + (bound === "file" ? 1 : 0)) : 512 * 1024 ** 2 + (bound === "file" ? 1 : 0) }) : stat;
  });
  t.mock.method(fs, "readSync", () => { reads++; throw new Error("byte bound must precede reads"); }); syncBuiltinESMExports();
  assert.throws(() => snapshotDependencies(f.from, f.to), { code: "ERR_DEPENDENCY_SNAPSHOT" });
  assert.equal(reads, 0);
});

test("a directory substituted at file-open cannot supply content", (t) => {
  const f = fixture(t), input = f.file("package/worker.mjs"), folder = dirname(input), outside = join(f.root, "private");
  fs.mkdirSync(outside); fs.writeFileSync(join(outside, "worker.mjs"), "PRIVATE_CONTENT");
  const open = fs.openSync; let reads = 0, changed = false;
  t.mock.method(fs, "openSync", (path, ...args) => {
    if (!changed && inputPath(path, input)) {
      changed = true; fs.renameSync(folder, folder + ".held"); fs.symlinkSync(outside, folder, "junction");
    }
    return open(path, ...args);
  });
  t.mock.method(fs, "readSync", () => { reads++; throw new Error("must not read after directory substitution"); }); syncBuiltinESMExports();
  assert.throws(() => snapshotDependencies(f.from, f.to), { code: "ERR_DEPENDENCY_SNAPSHOT" });
  assert.ok(changed); assert.equal(reads, 0);
});

test("a FIFO substituted at file-open cannot block or supply bytes", { skip: process.platform !== "linux" && "requires mkfifo", timeout: 3000 }, (t) => {
  const f = fixture(t), input = f.file("worker.mjs"), open = fs.openSync; let reads = 0, changed = false;
  t.mock.method(fs, "openSync", (path, ...args) => {
    if (!changed && inputPath(path, input)) {
      assert.ok(typeof args[0] === "number" && (args[0] & fs.constants.O_NONBLOCK), "red replay must not block opening a FIFO");
      changed = true; fs.rmSync(input); execFileSync("mkfifo", [input], { timeout: 1000, env: { PATH: "/usr/bin:/bin" } });
    }
    return open(path, ...args);
  });
  t.mock.method(fs, "readSync", () => { reads++; throw new Error("must not read special input"); }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "changed-input", "worker.mjs", "fifo"); assert.equal(reads, 0);
});

test("dependency reads handle short chunks without changing the private copy", (t) => {
  const f = fixture(t), body = "many actual short reads"; f.file("worker.mjs", body); const read = fs.readSync;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(3, length), position)); syncBuiltinESMExports();
  assert.deepEqual(snapshotDependencies(f.from, f.to), [{ path: "worker.mjs", bytes: body.length, sha256: digest(Buffer.from(body)) }]);
});

test("a failed read closes source, destination and traversal descriptors", (t) => {
  const f = fixture(t); f.file("package/worker.mjs"); const open = fs.openSync, close = fs.closeSync, held = new Set();
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); held.add(fd); return fd; });
  t.mock.method(fs, "closeSync", (fd) => { held.delete(fd); return close(fd); });
  t.mock.method(fs, "readSync", () => { throw Object.assign(new Error("PRIVATE_CONTENT"), { code: "EIO" }); }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "input-io", "package/worker.mjs"); assert.equal(held.size, 0);
});

for (const [operation, code, reason] of [["readSync", "EACCES", "input-io"], ["writeSync", "ENOSPC", "output-io"]])
  test(`snapshot diagnostics distinguish ${operation} ${code} without raw error text`, (t) => {
    const f = fixture(t); f.file("worker.mjs");
    t.mock.method(fs, operation, () => { throw Object.assign(new Error("PRIVATE_CONTENT"), { code }); }); syncBuiltinESMExports();
    diagnostic(() => snapshotDependencies(f.from, f.to), reason, "worker.mjs");
    assert.throws(() => snapshotDependencies(f.from, join(f.root, "second")), (error) => {
      assert.equal(JSON.parse(error.message.slice(error.message.indexOf("{"))).fsCode, code); return true;
    });
  });

for (const names of [["a.mjs", "A.mjs"], ["bad:name"], ["\u0001".repeat(200)]]) test(`unsafe/colliding names fail with bounded diagnostics (${names[0].slice(0, 8)})`, (t) => {
  const f = fixture(t); f.file("a.mjs"); if (names.length > 1) f.file("A.mjs"); const read = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (path, ...args) => inputPath(path, f.from) ? names : read(path, ...args)); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "unsafe-name");
});

test("nested .bin symlinks are not exempted as unused top-level launchers", (t) => {
  const f = fixture(t); f.file("package/worker.mjs"); fs.symlinkSync(f.root, join(f.from, "package/.bin"), "junction");
  diagnostic(() => snapshotDependencies(f.from, f.to), "linked-input", "package/.bin", "symlink");
});

test("source depth bound applies before any content is read", (t) => {
  const f = fixture(t); f.file(`${"d/".repeat(65)}worker.mjs`); let reads = 0;
  t.mock.method(fs, "readSync", () => { reads++; throw new Error("depth bound must precede reads"); }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, f.to), "depth-bound"); assert.equal(reads, 0);
});

for (const to of ["source", "nested"]) test(`snapshot roots may not overlap (${to})`, (t) => {
  const f = fixture(t); f.file("worker.mjs");
  // Keep the old implementation's recursive self-copy bounded in red replays.
  const mkdir = fs.mkdirSync; let creations = 0;
  t.mock.method(fs, "mkdirSync", (path, ...args) => {
    if (path === join(f.from, "copy")) { creations++; throw new Error("overlap must be rejected before target creation"); }
    return mkdir(path, ...args);
  }); syncBuiltinESMExports();
  diagnostic(() => snapshotDependencies(f.from, to === "source" ? f.from : join(f.from, "copy")), "unsafe-root");
  assert.equal(creations, 0);
});

if (process.env.HARDENING_SNAPSHOT_INSTALL) test("actual pinned npm installation with esbuild postinstall hardlinks snapshots unchanged", (t) => {
  const f = fixture(t), from = resolve(process.env.HARDENING_SNAPSHOT_INSTALL);
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const version = JSON.parse(fs.readFileSync(join(repo, "package.json"))).devDependencies["@playwright/test"];
  assert.equal(JSON.parse(fs.readFileSync(join(from, "@playwright/test/package.json"))).version, version);
  const linked = ["@esbuild/linux-x64/bin/esbuild", "esbuild/bin/esbuild"].map((path) => ({ path, stat: fs.lstatSync(join(from, path)) }));
  for (const { stat } of linked) { assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.nlink, 2); }
  assert.equal(linked[0].stat.ino, linked[1].stat.ino);
  console.log(JSON.stringify({ control: "actual-pinned-npm-install", playwright: version, linked: linked.map(({ path, stat }) => ({ path, nlink: stat.nlink, bytes: stat.size })) }));
  const rows = snapshotDependencies(from, f.to); assert.deepEqual(savedFiles(f.to), rows);
  for (const { path, stat } of linked) {
    assert.equal(fs.lstatSync(join(from, path)).nlink, 2); assert.equal(fs.lstatSync(join(from, path)).ino, stat.ino);
    assert.equal(fs.lstatSync(join(f.to, path)).nlink, 1);
    assert.equal(digest(fs.readFileSync(join(from, path))), digest(fs.readFileSync(join(f.to, path))));
  }
});
