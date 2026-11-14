// Synthetic transport controls only. Nothing here qualifies a native benchmark.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { closeSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createGzip, gzipSync, gunzipSync } from "node:zlib";
import { artifactProfile } from "../client-heavy/verify-v2.mjs";
import { limits as mixedLimits } from "../mixed-production/verify.mjs";
import { groupNames } from "./registry.mjs";
import { archive, metadata } from "./cloud-fixtures.mjs";
import { archivePathLimits, archivePaths } from "./cloud-contract.mjs";
import { archiveLimit, archiveMembers, checkPackage, digest, durableCopy, expandedLimit, extractArchive, fileHash, ioBytes, regular, tarLimit, treeHash } from "./cloud-local.mjs";

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const scratch = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-envelope-")));
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); rmSync(root, { recursive: true }); }); return root;
};
function sparse(path, size) {
  mkdirSync(dirname(path), { recursive: true }); const fd = openSync(path, "wx", 0o600);
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
}
function browserIdentity() {
  const sha256 = "a".repeat(64), size = 512 * MiB;
  const identity = { version: "synthetic", requestedExecutable: "/synthetic/browser", executablePath: "/synthetic/browser",
    executable: { bytes: size, sha256, blob: `evidence/blobs/${sha256}` } };
  assert.equal(artifactProfile.oversized.accepts(identity.executable.blob, size,
    new Map([["evidence/browser.json", Buffer.from(JSON.stringify(identity))]])), true);
  return identity;
}

test("the exact independent 512 MiB + one byte control now hashes without a whole-blob allocation", (t) => {
  const root = scratch(t), identity = browserIdentity(), size = identity.executable.bytes;
  assert.ok(size + 1 < artifactProfile.limits.totalBytes);
  sparse(join(root, "campaign", "00-other", "native", "raw.json"), 1);
  sparse(join(root, "campaign", "05-client-heavy-timing", "native", identity.executable.blob), size);
  assert.match(treeHash(root), /^[a-f0-9]{64}$/);
  console.log("independent synthetic 512 MiB + 1 byte tree accepted; native semantic qualification not tested");
});

test("all ten phase allowances cover current finite native caps and fit the explicit package envelope", (t) => {
  const root = scratch(t);
  // JSON/live have no whole-tree ceiling. These are documented transport allowances.
  const phases = [["catalog-page", 2 * GiB], ["json-api-prepare", 2 * GiB], ["json-api-timing", 2 * GiB],
    ["localized-marketplace", GiB / 2], ["mixed-production", mixedLimits.bytes], ["fullstack-browser", GiB],
    ["client-heavy", artifactProfile.limits.totalBytes], ["live-delivery", GiB], ["recoverable-live", GiB], ["hardening", GiB]];
  assert.deepEqual(phases.map(([name]) => name).filter((name) => !name.startsWith("json-api-")), groupNames.filter((name) => name !== "json-api"));
  assert.equal(phases.reduce((n, [, bytes]) => n + bytes, 0), 13.5 * GiB);
  assert.equal(expandedLimit, 13.5 * GiB + 2.5 * GiB); assert.equal(tarLimit, expandedLimit + GiB); assert.equal(archiveLimit, tarLimit + GiB);
  assert.equal(archivePathLimits.nodes, 10 * 100000 + 100000);
  assert.ok(artifactProfile.limits.files <= 100000 && mixedLimits.files <= 100000);
  // These readers do not export their admission constants. Pin the exact checks,
  // so a changed native ceiling requires reconsidering this operational budget.
  const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(source("fullstack-browser/verify.mjs"), /stat\.size <= 256 \* 1024 \* 1024 && bytes <= 1024 \*\* 3/);
  assert.match(source("fullstack-browser/verify.mjs"), /native \? 50100 : 100/);
  assert.match(source("catalog/verify.mjs"), /entries <= 30000/); assert.match(source("catalog/verify.mjs"), /bytes \+= stat\.size\) <= 2 \*\* 31/);
  assert.match(source("marketplace/saved-files.mjs"), /entries <= 25000/); assert.match(source("marketplace/saved-files.mjs"), /bytes \+= before\.size\) <= 512 \* 2 \*\* 20/);
  assert.match(source("workloads/isolated/adapters/hardening.mjs"), /entries <= 100000/);
  assert.match(source("workloads/isolated/adapters/hardening.mjs"), /bytes <= 1024 \*\* 3/);
  for (const entry of metadata()) writeFileSync(join(root, entry.name), entry.body);
  for (const [name, bytes] of phases) {
    // Use per-file sizes admitted by every finite reader, not multi-GiB native files.
    for (let at = 0, i = 0; at < bytes; at += 32 * MiB, i++) sparse(join(root, "campaign", name, "native", `part-${i}`), Math.min(32 * MiB, bytes - at));
  }
  const result = checkPackage(root);
  assert.equal(result.bytes, 13.5 * GiB + metadata().reduce((n, e) => n + Buffer.byteLength(e.body), 0));
  assert.ok(result.tarBytes <= tarLimit);
  // Exercise the actual 16 GiB boundary by stat-only sparse preflight, not RAM allocation.
  const control = join(root, "campaign", "control"); sparse(control, expandedLimit - result.bytes);
  assert.equal(checkPackage(root).bytes, expandedLimit);
  const fd = openSync(control, "r+"); try { ftruncateSync(fd, statSync(control).size + 1); } finally { closeSync(fd); }
  assert.throws(() => checkPackage(root), /size limit/);
});

test("physical archive content, compressed and expanded boundaries reject boundary+1 before extraction", async (t) => {
  const root = scratch(t), target = join(root, "extract"), file = join(root, "archive.tgz"); mkdirSync(target);
  const entries = [...metadata(), { name: "campaign/data", body: "0123456789abcdef" }], bytes = archive(entries);
  const content = entries.reduce((n, e) => n + Buffer.byteLength(e.body), 0), tar = gunzipSync(bytes).length;
  writeFileSync(file, bytes);
  const limits = { compressed: bytes.length, tar, content };
  const result = await archiveMembers(file, digest(bytes), limits); assert.equal(result.bytes, content);
  for (const [key, value] of Object.entries(limits)) {
    await assert.rejects(extractArchive(file, target, digest(bytes), { ...limits, [key]: value - 1 }));
    assert.deepEqual(readdirSync(target), []); assert.ok(!readdirSync(root).some((name) => name.startsWith(".cloud-spool-")));
  }
  await assert.rejects(extractArchive(file, target, "0".repeat(64)), /archive changed/); assert.deepEqual(readdirSync(target), []);
  const implicit = archive([...metadata(), { name: "campaign/a/b/f" }]);
  const metaBytes = metadata().reduce((n, e) => n + e.name.length, 0);
  await assert.rejects(extractArchive(implicit, target, undefined, { memberBytes: metaBytes + 46 }), /physical path budget/);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(await extractArchive(file, target, digest(bytes), limits), treeHash(target));
  assert.equal(readFileSync(join(target, "campaign/data"), "utf8"), entries.at(-1).body);
  sparse(join(root, "too-large.tgz"), archiveLimit + 1);
  await assert.rejects(archiveMembers(join(root, "too-large.tgz")), /bounded regular/);
  assert.throws(() => regular(file, archiveLimit), /bound/);
  await assert.rejects(archiveMembers(file, undefined, { content: expandedLimit + 1 }), /bound/);
});

test("late gzip, body, padding, GNU and extension failures remain pre-write and remove only owned spools", async (t) => {
  const root = scratch(t), target = join(root, "extract"), retained = join(root, ".cloud-spool-unowned"); mkdirSync(target); mkdirSync(retained);
  writeFileSync(join(retained, "preserve"), "unowned");
  const good = archive([...metadata(), { name: "campaign/data", body: "a" }]);
  const tar = gunzipSync(good), badPadding = Buffer.from(tar); badPadding[tar.length - 1024 - 1] = 1;
  const badCrc = Buffer.from(good); badCrc[badCrc.length - 8] ^= 1;
  const controls = [badCrc, good.subarray(0, -1), gzipSync(badPadding), gzipSync(tar.subarray(0, -1025)),
    ...["1", "2", "3", "4", "6", "7", "x", "g", "S", "K"].map((type) => archive([...metadata(), { name: "campaign/valid", body: "keep" }, { name: "campaign/late", type }])),
    archive([...metadata(), { name: "././@LongLink", type: "L", body: "campaign/name" }, { name: "ignored" }]),
    archive([...metadata(), { name: "././@LongLink", type: "L", body: "campaign/name\0" }]),
    archive([...metadata(), { name: "././@LongLink", type: "L", body: "campaign/name\0" }, { name: "././@LongLink", type: "L", body: "campaign/other\0" }])];
  for (const bytes of controls) {
    const file = join(root, "archive.tgz"); writeFileSync(file, bytes);
    await assert.rejects(extractArchive(file, target, digest(bytes)));
    assert.deepEqual(readdirSync(target), []);
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".cloud-spool-")), [".cloud-spool-unowned"]);
  }
  assert.equal(readFileSync(join(retained, "preserve"), "utf8"), "unowned");
});

test("canonical tree receipts, exclusive copies, physical files and source snapshots are retained", (t) => {
  const root = scratch(t), source = join(root, "source"), target = join(root, "copy"); writeFileSync(source, "abc");
  const h = createHash("sha256").update(`d\0\0f\0/source\0${3}\0abc`).digest("hex");
  assert.equal(treeHash(root), h);
  durableCopy(source, target, digest("abc")); assert.equal(fileHash(target), digest("abc"));
  assert.throws(() => durableCopy(source, target, digest("abc")), /EEXIST/);
  linkSync(source, join(root, "hardlink")); assert.throws(() => fileHash(source), /bounded regular/);
  const changing = join(root, "changing"); writeFileSync(changing, "old");
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (...args) => { const n = read(...args); writeFileSync(changing, "new bytes"); return n; }); syncBuiltinESMExports();
  try { assert.throws(() => fileHash(changing), /changed while reading/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("an extraction write failure preserves partial evidence and still removes only the owned spool", async (t) => {
  const root = scratch(t), target = join(root, "extract"), file = join(root, "archive.tgz"); mkdirSync(target);
  writeFileSync(file, archive([...metadata(), { name: "campaign/data", body: "not truncated into proof" }]));
  const open = fs.openSync, write = fs.writeSync; let failing;
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); if (args[0] === join(target, "campaign", "data")) failing = fd; return fd; });
  t.mock.method(fs, "writeSync", (...args) => { if (args[0] === failing) throw Object.assign(new Error("synthetic write failure"), { code: "EIO" }); return write(...args); });
  syncBuiltinESMExports();
  try { await assert.rejects(extractArchive(file, target), /synthetic write failure/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(target, "run.log"), "utf8"), metadata()[0].body);
  assert.equal(statSync(join(target, "campaign/data")).size, 0); assert.ok(fs.existsSync(file));
  assert.ok(!readdirSync(root).some((name) => name.startsWith(".cloud-spool-")));
});

test("compact archive index covers the full node budget, client plus other groups, and metadata ceilings", () => {
  const paths = archivePaths(); for (const entry of metadata()) paths.add(entry.name, false);
  for (let i = 0; i < archivePathLimits.nodes - 5; i++) paths.add(`campaign/f${i}`, false);
  assert.equal(paths.finish().nodes, archivePathLimits.nodes);
  assert.throws(() => paths.add("campaign/one-more", false), /tree limit/);
  assert.ok(archivePathLimits.nodes > artifactProfile.limits.files + mixedLimits.files + 50100 + 30000 + 25000);
  const meta = metadata().reduce((n, e) => n + e.name.length, 0);
  const small = archivePaths({ nameBytes: meta + 3, memberBytes: meta });
  for (const entry of metadata()) small.add(entry.name, false);
  assert.equal(small.finish().nameBytes, meta + 3);
  assert.throws(() => small.add("campaign/data", false), /member budget/);
  const names = archivePaths({ nameBytes: meta + 3 }); for (const entry of metadata()) names.add(entry.name, false);
  assert.throws(() => names.add("campaign/data", false), /name budget/);
});

// A generated stream, not a multi-GiB Buffer or a native semantic fixture.
function header(name, size) {
  const h = Buffer.alloc(512); h.write(name); h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124); h.write("00000000000\0", 136); h.fill(32, 148, 156); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
  h.write(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148); return h;
}
test("streamed client 2 GiB + browser 1 GiB + other groups transports under a small JS heap", async (t) => {
  const root = scratch(t), file = join(root, "large.tgz");
  const identity = browserIdentity();
  const sizes = [[`campaign/client-heavy/native/${identity.executable.blob}`, identity.executable.bytes],
    ...Array.from({ length: 12 }, (_, i) => [`campaign/client-heavy/native/evidence/vendor/part-${i}`, 128 * MiB]),
    ...Array.from({ length: 4 }, (_, i) => [`campaign/fullstack-browser/native/part-${i}`, 256 * MiB]),
    ...groupNames.filter((name) => !["client-heavy", "fullstack-browser"].includes(name)).map((name) => [`campaign/${name}/native/proof`, 1])];
  const bytes = sizes.reduce((n, [, size]) => n + size, 0); assert.equal(bytes, 3 * GiB + 7);
  const zero = Buffer.alloc(ioBytes);
  // The longest blob path uses GNU long names; the stream below supplies them.
  function* gnuTar() {
    for (const entry of metadata()) { const b = Buffer.from(entry.body); yield header(entry.name, b.length); yield b; yield Buffer.alloc((512 - b.length % 512) % 512); }
    for (const [name, size] of sizes) {
      if (name.length > 100) {
        const b = Buffer.from(`${name}\0`), h = header("././@LongLink", b.length); h[156] = 76; h.fill(32, 148, 156);
        h.write(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
        yield h; yield b; yield Buffer.alloc((512 - b.length % 512) % 512);
      }
      yield header(name.slice(0, 100), size);
      for (let at = 0; at < size; at += zero.length) yield zero.subarray(0, Math.min(zero.length, size - at));
      yield Buffer.alloc((512 - size % 512) % 512);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(gnuTar(), { objectMode: false, highWaterMark: ioBytes }), createGzip({ level: 1, chunkSize: ioBytes }), fs.createWriteStream(file, { flags: "wx" }));
  const module = pathToFileURL(resolve("bench/workloads/cloud-local.mjs")).href;
  const script = `import { checkPackage, extractArchive, fileHash } from ${JSON.stringify(module)};
    import { createHash } from 'node:crypto';
    import { mkdirSync, statSync } from 'node:fs';
    const [file, folder] = process.argv.slice(1); mkdirSync(folder);
    const sha = fileHash(file), files = new Map(${JSON.stringify([...metadata().map((e) => [e.name, { size: Buffer.byteLength(e.body), body: e.body }]), ...sizes.map(([name, size]) => [name, { size }])])});
    const expected = createHash('sha256'), zero = Buffer.alloc(${ioBytes});
    function visit(key) {
      const path = key.slice(1), entry = files.get(path);
      if (entry) {
        expected.update('f\\0' + key + '\\0' + entry.size + '\\0');
        if (entry.body !== undefined) expected.update(entry.body);
        else for (let at = 0; at < entry.size; at += zero.length) expected.update(zero.subarray(0, Math.min(zero.length, entry.size - at)));
      } else {
        expected.update('d\\0' + key + '\\0'); const prefix = path ? path + '/' : '';
        const children = new Set([...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]));
        for (const child of [...children].sort()) visit(key + '/' + child);
      }
    }
    visit('');
    const receipt = await extractArchive(file, folder, sha);
    const content = checkPackage(folder).bytes;
    if (receipt !== expected.digest('hex') || content !== ${bytes + metadata().reduce((n, e) => n + Buffer.byteLength(e.body), 0)}) process.exit(1);
    console.log(JSON.stringify({ synthetic: true, contentBytes: content, archiveBytes: statSync(file).size,
      maxRssKiB: process.resourceUsage().maxRSS, heapLimitMiB: 64, nativeSemanticQualification: false }));`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", script, file, join(root, "extracted")],
    { encoding: "utf8", timeout: 600000, windowsHide: true, maxBuffer: MiB });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); console.log(result.stdout.trim());
  assert.ok(!readdirSync(root).some((name) => name.startsWith(".cloud-spool-")));
});
