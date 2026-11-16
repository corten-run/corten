import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { digest, savedFiles, snapshotDependencies } from "./evidence.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "hardening-destination-"));
  const from = join(root, "installed"), parent = join(root, "output"), to = join(parent, "snapshot"), outside = join(root, "outside");
  for (const dir of [from, parent, outside]) fs.mkdirSync(dir);
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); fs.rmSync(root, { recursive: true });
  });
  const put = (path, body = "review bytes") => {
    const full = join(from, path); fs.mkdirSync(dirname(full), { recursive: true }); fs.writeFileSync(full, body); return full;
  };
  const pathIs = (actual, expected) => actual === expected || String(actual).startsWith("/proc/self/fd/")
    && join(fs.realpathSync(dirname(actual)), basename(actual)) === expected;
  const reject = () => assert.throws(() => snapshotDependencies(from, to), (error) => {
    assert.equal(error.code, "ERR_DEPENDENCY_SNAPSHOT"); assert.ok(error.message.length < 600); assert.ok(!error.message.includes(root)); return true;
  });
  return { root, from, parent, to, outside, put, pathIs, reject };
}

for (const at of ["root", "ancestor", "descendant"]) for (const kind of ["directory", "junction"])
  test(`destination ${at} ${kind} substitution at output open is rejected without redirected bytes`, (t) => {
    const f = fixture(t), file = at === "descendant" ? "package/worker" : "worker"; f.put(file);
    const target = at === "root" ? f.to : at === "ancestor" ? f.parent : join(f.to, "package");
    const open = fs.openSync; let attempted = false, replaced = false;
    t.mock.method(fs, "openSync", (path, ...args) => {
      if (!attempted && f.pathIs(path, join(f.to, file))) {
        attempted = true; fs.renameSync(target, target + ".held"); replaced = true;
        if (kind === "junction") fs.symlinkSync(f.outside, target, "junction"); else fs.mkdirSync(target);
      }
      return open(path, ...args);
    }); syncBuiltinESMExports();
    f.reject(); assert.ok(attempted); assert.deepEqual(fs.readdirSync(f.outside), []);
    if (replaced && kind === "directory") assert.deepEqual(fs.readdirSync(target), []);
  });

for (const at of ["ancestor", "root"]) test(`destination ${at} substitution at mkdir cannot create outside`, (t) => {
  const f = fixture(t); f.put("package/worker"); const mkdir = fs.mkdirSync; let attempted = false;
  const created = at === "ancestor" ? f.to : join(f.to, "package"), target = at === "ancestor" ? f.parent : f.to;
  t.mock.method(fs, "mkdirSync", (path, ...args) => {
    if (!attempted && f.pathIs(path, created)) {
      attempted = true; fs.renameSync(target, target + ".held"); fs.symlinkSync(f.outside, target, "junction");
    }
    return mkdir(path, ...args);
  }); syncBuiltinESMExports();
  f.reject(); assert.ok(attempted); assert.deepEqual(fs.readdirSync(f.outside), []);
});

for (const at of ["root", "ancestor", "descendant"]) test(`destination ${at} substitution at write cannot redirect a chunk`, (t) => {
  const f = fixture(t); f.put("package/worker", Buffer.alloc(2 * 1024 * 1024, 37));
  const target = at === "root" ? f.to : at === "ancestor" ? f.parent : join(f.to, "package");
  const write = fs.writeSync; let attempted = false;
  t.mock.method(fs, "writeSync", (...args) => {
    if (!attempted) { attempted = true; fs.renameSync(target, target + ".held"); fs.symlinkSync(f.outside, target, "junction"); }
    return write(...args);
  }); syncBuiltinESMExports();
  f.reject(); assert.ok(attempted); assert.deepEqual(fs.readdirSync(f.outside), []);
});

for (const at of ["root", "ancestor", "descendant"]) test(`destination ${at} replaced at sealing cannot pass with identical copied bytes`, (t) => {
  const f = fixture(t); f.put("package/worker"); const read = fs.readdirSync;
  const target = at === "root" ? f.to : at === "ancestor" ? f.parent : join(f.to, "package"); let attempted = false;
  t.mock.method(fs, "readdirSync", (path, ...args) => {
    if (!attempted && path === f.to) {
      attempted = true; fs.renameSync(target, target + ".held");
      fs.mkdirSync(dirname(join(f.to, "package/worker")), { recursive: true });
      fs.writeFileSync(join(f.to, "package/worker"), "review bytes");
    }
    return read(path, ...args);
  }); syncBuiltinESMExports();
  f.reject(); assert.ok(attempted);
});

test("destination file replaced at sealing cannot pass with identical copied bytes", (t) => {
  const f = fixture(t); f.put("worker"); const read = fs.readdirSync; let attempted = false;
  t.mock.method(fs, "readdirSync", (path, ...args) => {
    if (!attempted && path === f.to) {
      attempted = true; fs.renameSync(join(f.to, "worker"), join(f.parent, "worker.held"));
      fs.writeFileSync(join(f.to, "worker"), "review bytes");
    }
    return read(path, ...args);
  }); syncBuiltinESMExports();
  f.reject(); assert.ok(attempted);
});

test("unrelated destination-ancestor membership changes do not invalidate a private copy", (t) => {
  const f = fixture(t); f.put("worker"); const write = fs.writeSync; let attempted = false;
  t.mock.method(fs, "writeSync", (...args) => {
    if (!attempted) { attempted = true; fs.writeFileSync(join(f.parent, "unrelated"), "unrelated"); }
    return write(...args);
  }); syncBuiltinESMExports();
  const rows = snapshotDependencies(f.from, f.to); assert.ok(attempted); assert.deepEqual(savedFiles(f.to), rows);
});

test("destination directory handles are bounded by traversal depth, not sibling count", (t) => {
  const f = fixture(t); for (let i = 0; i < 80; i++) f.put(`package-${i}/worker`);
  const open = fs.openSync, close = fs.closeSync, held = new Set(); let peak = 0;
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); held.add(fd); peak = Math.max(peak, held.size); return fd; });
  t.mock.method(fs, "closeSync", (fd) => { held.delete(fd); return close(fd); }); syncBuiltinESMExports();
  assert.equal(snapshotDependencies(f.from, f.to).length, 80); assert.equal(held.size, 0); assert.ok(peak <= 7, `peak owned descriptors: ${peak}`);
});

test("completed destination directory replacement before later writes is rejected", (t) => {
  const f = fixture(t); f.put("a/worker"); f.put("b/worker"); const open = fs.openSync; let attempted = false;
  t.mock.method(fs, "openSync", (path, ...args) => {
    if (!attempted && f.pathIs(path, join(f.to, "b/worker"))) {
      attempted = true; fs.renameSync(join(f.to, "a"), join(f.to, "a.held")); fs.mkdirSync(join(f.to, "a"));
      fs.writeFileSync(join(f.to, "a/worker"), "review bytes");
    }
    return open(path, ...args);
  }); syncBuiltinESMExports();
  f.reject(); assert.ok(attempted);
});

test("destination handles close on failed writes and successful independent copies", (t) => {
  const f = fixture(t); f.put("package/worker");
  const open = fs.openSync, close = fs.closeSync, write = fs.writeSync, held = new Set(); let failed = false;
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); held.add(fd); return fd; });
  t.mock.method(fs, "closeSync", (fd) => { held.delete(fd); return close(fd); });
  t.mock.method(fs, "writeSync", (...args) => { if (!failed) { failed = true; throw Object.assign(new Error("private"), { code: "ENOSPC" }); } return write(...args); });
  syncBuiltinESMExports(); f.reject(); assert.equal(held.size, 0);
  const second = join(f.parent, "second"), rows = snapshotDependencies(f.from, second);
  assert.equal(held.size, 0); assert.deepEqual(savedFiles(second), rows);
  assert.deepEqual(rows, [{ path: "package/worker", bytes: 12, sha256: digest("review bytes") }]);
});
