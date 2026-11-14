// Opt-in real Linux apparatus controls. No framework qualification or Rust build.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Evidence, sha256 } from "./evidence.mjs";
import { npmClosure } from "./build-replay.mjs";
import { installLayout } from "./install-layout.mjs";
import { launchBrowser, browserIdentity } from "./launch.mjs";
import { verifyHostProof } from "./host-proof.mjs";
import { hostFixture } from "./host-fixture.mjs";
import { snapshot } from "./verify.mjs";
import { artifactProfile } from "./verify-v2.mjs";

const enabled = process.platform === "linux" && process.env.CLIENT_LINUX_CONTROLS === "1";
async function fileHash(path) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "client-linux-control-")), out = join(root, "saved"); await mkdir(out);
  t.after(async () => { const r = relative(tmpdir(), root); assert.ok(r && !isAbsolute(r) && !r.startsWith("..")); await rm(root, { recursive: true, force: true }); });
  return { root, out, e: new Evidence(root, out) };
}

test("Linux ordinary npm install closes before/after including bin symlinks and esbuild hardlinks", { skip: !enabled, timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "package.json"), JSON.stringify({ name: "native-install-control", private: true, dependencies: { esbuild: "0.28.2" } }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: f.root, stdio: "pipe", timeout: 120000 });
  const base = join(f.root, "node_modules"), bin = await lstat(join(base, ".bin/esbuild")), binary = await lstat(join(base, "esbuild/bin/esbuild"));
  assert.equal(bin.isSymbolicLink(), true); assert.ok(binary.nlink > 1);
  const before = await f.e.tree(base, "browser-dependencies", "before");
  const require = createRequire(join(f.root, "package.json")), esbuild = require("esbuild");
  const bundle = await esbuild.build({ stdin: { contents: "console.log('native Linux install control')" }, bundle: true, write: false });
  assert.ok(bundle.outputFiles[0].contents.length > 0);
  const after = await f.e.tree(base, "browser-dependencies", "after");
  assert.deepEqual(before.unavailable, []); assert.deepEqual(after.unavailable, []);
  assert.deepEqual(before.entries, after.entries); assert.deepEqual(before.layout, after.layout);
  const entries = new Map(before.entries.map(({ path, ...ref }) => [path, ref])), blobs = new Map();
  for (const [path, ref] of entries) { const bytes = await readFile(join(f.out, ref.blob)); blobs.set(ref.sha256, bytes);
    assert.equal(sha256(await readFile(join(base, path))), ref.sha256); }
  const blob = (ref) => blobs.get(ref.sha256);
  installLayout(before.layout, entries, blob); npmClosure(entries, JSON.parse(await readFile(join(f.root, "package-lock.json"))), blob);
  t.diagnostic(JSON.stringify({ entries: entries.size, bins: before.layout.bins, hardlinks: before.layout.hardlinks, compiled: true }));
});

test("Linux headless launch hashes the owned process image, not full Chromium; wrong OS digest is rejected", { skip: !enabled, timeout: 120000 }, async (t) => {
  const { chromium } = await import("playwright"), f = await fixture(t);
  const launched = await launchBrowser(chromium), child = launched.process;
  const stages = [{ stage: "launched", at: performance.now() }];
  try {
    const identity = await browserIdentity(f.e, launched), actual = await realpath(`/proc/${child.pid}/exe`);
    await f.e.save("evidence/browser.json", identity);
    stages.push({ stage: "image-saved", at: performance.now() });
    assert.equal(identity.executablePath, actual); assert.equal(identity.executable.sha256, await fileHash(actual));
    assert.notEqual(identity.executablePath, await realpath(chromium.executablePath()));
    assert.notEqual(identity.executable.sha256, await fileHash(chromium.executablePath()));
    stages.push({ stage: "image-compared", at: performance.now() });
    const context = await launched.browser.newContext(), page = await context.newPage(); await page.setContent("<h1>native control</h1>");
    assert.equal(await page.locator("h1").textContent(), "native control"); await context.close();
    stages.push({ stage: "context-closed", at: performance.now() });
    // Synthetic composition adversary, not OS authority or campaign evidence.
    const replay = { commit: "a".repeat(40), round: "control", subjectSha256: "b".repeat(64), files: [],
      executionWindow: { startedAt: 10, endedAt: 30 }, processWindows: [{ kind: "browser", startedAt: 15, endedAt: 25 }], toolIdentities: { node: "c".repeat(64), browser: identity.executable.sha256 } };
    const host = hostFixture(replay);
    for (const sample of host.proof.samples) for (const p of sample.processes) if (["browser", "renderer"].includes(p.role)) p.executableSha256 = "d".repeat(64);
    assert.throws(() => verifyHostProof(replay, host.context, host.proof), /process-executable-differs-from-native/);
    t.diagnostic(JSON.stringify({ pid: child.pid, actual, defaultExecutable: chromium.executablePath(), executableSha256: identity.executable.sha256 }));
  } finally { await launched.close(); }
  assert.equal(launched.browser.isConnected(), false); assert.ok(child.exitCode !== null || child.signalCode !== null);
  stages.push({ stage: "process-closed", at: performance.now() });
  const subject = await f.e.seal({ group: "client-heavy", round: "linux-control", commit: "a".repeat(40) });
  assert.ok(subject.files.some((f) => f.bytes > 128 * 1024 ** 2));
  const files = await snapshot(f.out, artifactProfile), identity = JSON.parse(files.get("evidence/browser.json"));
  assert.equal(sha256(files.get(identity.executable.blob)), identity.executable.sha256);
  assert.equal(files.get(identity.executable.blob).length, identity.executable.bytes);
  // Removing the checked browser role must remove its exceptional size bound.
  await rm(join(f.out, "evidence/browser.json"));
  await assert.rejects(snapshot(f.out, artifactProfile), /oversized-blob-not-browser-executable/);
  t.diagnostic(JSON.stringify({ stages, sealedFiles: subject.files.length }));
});
