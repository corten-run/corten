import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, createReadStream, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { EvidenceStore, openEvidence } from "./native-evidence.mjs";
import { captureSource, replaySource, captureBuildContext, replayBuildContext, captureTools, replayTools,
  captureExecutableBytes, replayExecutableBytes } from "./native-source.mjs";

const commit = "0972dc632fbfe3b66012d188ecdb30250f2469bc";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "corten-native-source-")); t.after(() => rmSync(root, { recursive: true }));
  return { root, store: new EvidenceStore(root) };
}
test("actual immutable local Git closes every binding source and exact native build archive", (t) => {
  const { root, store } = fixture(t), source = captureSource(store, commit), context = captureBuildContext(store, commit, "nextjs");
  const corten = captureBuildContext(store, commit, "corten"), svelte = captureBuildContext(store, commit, "sveltekit");
  const ref = store.record("source", source), build = store.record("context-nextjs", context); store.seal();
  const reader = openEvidence(root), result = replaySource(reader, reader.json(ref), commit);
  assert.ok(result.files.length > 1000 && result.files.some((f) => f.path === "Cargo.lock"));
  assert.equal(replayBuildContext(reader, reader.json(build), commit, "nextjs").dockerfile, "Dockerfile");
  assert.equal(replayBuildContext(reader, corten, commit, "corten").dockerfile, "bench/marketplace/corten/Dockerfile");
  assert.equal(replayBuildContext(reader, svelte, commit, "sveltekit").dockerfile, "Dockerfile.marketplace"); reader.finish();
  for (const mutate of [(v) => { v.files.pop(); }, (v) => { v.files[0].mode = "120000"; },
    (v) => { v.files[0].sha256 = "0".repeat(64); }, (v) => { v.repository = "//saved/network/path"; }]) {
    const v = structuredClone(source); mutate(v); assert.throws(() => replaySource(reader, v, commit));
  }
  assert.throws(() => replayBuildContext(reader, context, commit, "rails"));
  assert.throws(() => replayBuildContext(reader, { ...context, body: source.files[0].body }, commit, "nextjs"));
  assert.throws(() => captureBuildContext(store, commit, "../../arbitrary"));
});
test("actual Playwright/TypeScript installed files, cache archives, lock and executable bytes replay", async (t) => {
  const { root, store } = fixture(t), tools = captureTools(store, { browserExecutable: chromium.executablePath() });
  const ref = store.record("tools", tools); store.seal(); const reader = openEvidence(root);
  const result = replayTools(reader, reader.json(ref));
  const digest = async (file) => { const hash = createHash("sha256"); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest("hex"); };
  assert.deepEqual(result, { node: await digest(process.execPath), browser: await digest(chromium.executablePath()), lockSha256: tools.lock.sha256 });
  assert.equal(tools.schema, "native-browser-tools/v3");
  for (const [value, file] of [[tools.node, process.execPath], [tools.browser, chromium.executablePath()]]) {
    assert.equal(value.bytes, statSync(file).size); assert.equal(value.chunks.length, Math.ceil(value.bytes / (16 * 1024 ** 2)));
  }
  console.log(JSON.stringify({ executableBytes: { node: tools.node.bytes, browser: tools.browser.bytes },
    executableChunks: { node: tools.node.chunks.length, browser: tools.browser.chunks.length } }));
  assert.deepEqual(tools.packages.map((p) => p.name), ["@playwright/test", "playwright", "playwright-core", "typescript"]);
  assert.ok(tools.packages.at(-1).files.length > 100); reader.finish();
  const v = structuredClone(tools); v.packages.at(-1).files.pop(); assert.throws(() => replayTools(reader, v));
  assert.throws(() => replayTools(reader, { ...tools, browserExecutable: "//saved/network/exe" }));
});

const chunkBytes = 16 * 1024 ** 2;
function executableFixture(t) {
  const f = fixture(t), file = join(f.root, "executable"), fd = openSync(file, "wx"), hash = createHash("sha256");
  try {
    for (const body of [Buffer.alloc(chunkBytes, 65), Buffer.alloc(chunkBytes, 66), Buffer.from("tail!")]) {
      writeFileSync(fd, body); hash.update(body);
    }
  } finally { closeSync(fd); }
  return { ...f, file, sha256: hash.digest("hex") };
}

test("executable chunks retain ordered bytes and reject receipt tampering before whole-file acceptance", async (t) => {
  const f = executableFixture(t), value = captureExecutableBytes(f.store, f.file), ref = f.store.record("executable", value);
  assert.equal(value.bytes, 2 * chunkBytes + 5); assert.equal(value.sha256, f.sha256);
  assert.deepEqual(value.chunks.map((r) => r.bytes), [chunkBytes, chunkBytes, 5]);
  f.store.seal(); const reader = openEvidence(f.root);
  assert.equal(replayExecutableBytes(reader, reader.json(ref)), f.sha256);
  for (const [name, mutate] of [
    ["missing chunk", (v) => { v.chunks.pop(); }],
    ["extra chunk", (v) => { v.chunks.push(v.chunks[0]); }],
    ["reordered chunks", (v) => { [v.chunks[0], v.chunks[1]] = [v.chunks[1], v.chunks[0]]; }],
    ["repeated different chunk", (v) => { v.chunks[1] = v.chunks[0]; }],
    ["wrong whole hash", (v) => { v.sha256 = "0".repeat(64); }],
    ["wrong whole size", (v) => { v.bytes++; }],
    ["noncanonical piece length", (v) => { v.chunks[0].bytes--; }],
    ["empty final piece", (v) => { v.chunks[2].bytes = 0; }],
    ["wrong chunk hash", (v) => { v.chunks[0].sha256 = "0".repeat(64); }],
    ["saved local executable path", (v) => { v.path = f.file; }],
    ["saved alternate chunk path", (v) => { v.chunks[0].path = "//network/executable"; }],
    ["extra chunk field", (v) => { v.chunks[0].offset = 0; }],
    ["old executable shape", (v) => { delete v.chunks; }],
    ["unknown executable schema", (v) => { v.schema = "native-browser-executable-bytes/v2"; }],
  ]) await t.test(name, () => { const v = structuredClone(value); mutate(v); assert.throws(() => replayExecutableBytes(reader, v)); });
  reader.finish();
});

test("all executable receipt bounds are checked before any saved blob read", () => {
  const ref = { path: `native-evidence/blobs/${"a".repeat(64)}`, bytes: chunkBytes, sha256: "a".repeat(64) };
  const base = { schema: "native-browser-executable-bytes/v1", bytes: chunkBytes + 1, sha256: "b".repeat(64),
    chunks: [ref, { ...ref, bytes: 1 }] };
  for (const mutate of [
    (v) => { v.bytes = 0; }, (v) => { v.bytes = -1; }, (v) => { v.bytes = 1.5; },
    (v) => { v.bytes = 512 * 1024 ** 2 + 1; }, (v) => { v.chunks = null; },
    (v) => { v.chunks[1].bytes = 256 * 1024 ** 2; }, (v) => { v.chunks[1].path = "outside"; },
  ]) {
    const v = structuredClone(base); mutate(v); let reads = 0;
    assert.throws(() => replayExecutableBytes({ read() { reads++; throw Error("must not read"); } }, v), { code: "ERR_ASSERTION" });
    assert.equal(reads, 0);
  }
});

test("positive exact 512MiB executable bound uses at most 16MiB allocations and permits identical chunks", (t) => {
  const { root, store } = fixture(t), file = join(root, "executable"), fd = openSync(file, "wx");
  try { ftruncateSync(fd, 512 * 1024 ** 2); } finally { closeSync(fd); }
  const allocate = Buffer.alloc; let allocations = 0;
  t.mock.method(Buffer, "alloc", (size, ...args) => { assert.ok(size <= chunkBytes); allocations++; return allocate(size, ...args); });
  const value = captureExecutableBytes(store, file), ref = store.record("executable", value); store.seal();
  assert.ok(allocations >= 32); assert.equal(value.chunks.length, 32);
  assert.equal(new Set(value.chunks.map((r) => r.sha256)).size, 1);
  const reader = openEvidence(root); assert.equal(replayExecutableBytes(reader, reader.json(ref)), value.sha256); reader.finish();
});

test("oversized and empty live executable are rejected before allocation or storage", (t) => {
  const { root } = fixture(t), file = join(root, "executable"), fd = openSync(file, "wx");
  closeSync(fd); let allocations = 0, writes = 0;
  t.mock.method(Buffer, "alloc", () => { allocations++; throw Error("must not allocate"); });
  const store = { blob() { writes++; throw Error("must not store"); } };
  assert.throws(() => captureExecutableBytes(store, file), /executable size\/type/);
  const enlarged = openSync(file, "r+");
  try { ftruncateSync(enlarged, 512 * 1024 ** 2 + 1); } finally { closeSync(enlarged); }
  assert.throws(() => captureExecutableBytes(store, file), /executable size\/type/);
  assert.equal(allocations, 0); assert.equal(writes, 0);
});

test("live executable links and unsafe physical parents are refused", (t) => {
  const { root, store } = fixture(t), directory = join(root, "real"), alias = join(root, "alias"); mkdirSync(directory);
  const file = join(directory, "executable"); writeFileSync(file, "bytes");
  const hard = join(root, "hard"); linkSync(file, hard); assert.throws(() => captureExecutableBytes(store, file)); rmSync(hard);
  symlinkSync(directory, alias, "junction"); assert.throws(() => captureExecutableBytes(store, join(alias, "executable")));
  assert.throws(() => captureExecutableBytes(store, directory));
  assert.throws(() => captureExecutableBytes(store, "//network/executable"));
});

test("live executable final-component symlink is not followed", { skip: process.platform === "win32" && "file symlink requires workstation privilege; covered on Linux" }, (t) => {
  const { root, store } = fixture(t), file = join(root, "executable"), alias = join(root, "alias");
  writeFileSync(file, "bytes"); symlinkSync(file, alias); assert.throws(() => captureExecutableBytes(store, alias));
});

for (const change of ["overwrite", "grow", "truncate", "replace", "hardlink", "after-final-chunk"]) test(`live executable ${change} during capture cannot produce a receipt`, (t) => {
  const f = executableFixture(t); let chunks = 0;
  assert.throws(() => captureExecutableBytes({ blob(body) {
    const ref = f.store.blob(body); chunks++;
    if (chunks === (change === "after-final-chunk" ? 3 : 1)) {
      if (change === "replace") { renameSync(f.file, `${f.file}.original`); writeFileSync(f.file, "replacement"); }
      else if (change === "hardlink") linkSync(f.file, `${f.file}.linked`);
      else {
        const fd = openSync(f.file, "r+");
        try {
          if (change === "grow") ftruncateSync(fd, 2 * chunkBytes + 6);
          else if (change === "truncate") ftruncateSync(fd, chunkBytes);
          else writeSync(fd, Buffer.from("changed"), 0, 7, 0);
        } finally { closeSync(fd); }
      }
    }
    return ref;
  } }, f.file), /executable mutated/);
});

test("saved executable mutation and unconsumed chunk cannot hide behind an evidence seal", (t) => {
  const f = executableFixture(t), value = captureExecutableBytes(f.store, f.file), ref = f.store.record("executable", value);
  const extra = f.store.blob("extra executable chunk"); f.store.seal(); const reader = openEvidence(f.root);
  assert.equal(replayExecutableBytes(reader, reader.json(ref)), value.sha256);
  assert.throws(() => reader.finish(), /unconsumed/); reader.read(extra); reader.finish();
  writeFileSync(join(f.root, value.chunks[0].path), "mutated chunk");
  assert.throws(() => replayExecutableBytes(reader, value)); assert.throws(() => reader.finish());
});

test("old v2 tools are rejected before byte replay and require unpublished development regeneration", () => {
  let reads = 0;
  assert.throws(() => replayTools({ read() { reads++; } }, { schema: "native-browser-tools/v2", lock: null, node: null, browser: null, packages: [] }),
    /regenerate unpublished v2 development evidence/);
  assert.equal(reads, 0);
});
