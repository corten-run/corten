import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { sha256 } from "./capture.mjs";

export const toolPackages = ["@playwright/test", "playwright", "playwright-core"];
export const mountSourceHash = (path) => sha256(path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase())
  .replace(/^\/run\/desktop\/mnt\/host(?=\/)/, "").replace(/^\/host_mnt(?=\/)/, "").replace(/\/$/, ""));
const safe = (path) => typeof path === "string" && path.length <= 1024 && !/[\\:"<>|?*\x00-\x1f\x7f]/.test(path)
  && path.split("/").every((v) => v && v !== "." && v !== ".." && !/[. ]$/.test(v) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v));

export function packageFiles(compressed, integrity) {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal("sha512-" + createHash("sha512").update(compressed).digest("base64"), integrity, "tool package lock integrity differs");
  const tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 ** 2 }), files = new Map(); let at = 0, ended = false;
  const text = (b) => b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)).toString("utf8");
  const octal = (b) => { const s = text(b).trim(); assert.match(s, /^[0-7]+$/); return parseInt(s, 8); };
  while (at + 512 <= tar.length) {
    const h = tar.subarray(at, at + 512); at += 512;
    if (h.every((v) => v === 0)) { assert.ok(tar.subarray(at).every((v) => v === 0)); ended = true; break; }
    assert.equal(text(h.subarray(257, 263)), "ustar");
    assert.equal(octal(h.subarray(148, 156)), [...h].reduce((n, v, i) => n + (i >= 148 && i < 156 ? 32 : v), 0));
    assert.ok([0, 48].includes(h[156]) && text(h.subarray(157, 257)) === "", "linked/special tool package entry");
    const name = text(h.subarray(0, 100)), prefix = text(h.subarray(345, 500)), full = prefix ? `${prefix}/${name}` : name;
    assert.ok(full.startsWith("package/")); const path = full.slice(8); assert.ok(safe(path) && !files.has(path.toLowerCase()));
    const size = octal(h.subarray(124, 136)); assert.ok(size <= 32 * 1024 ** 2 && at + size <= tar.length && files.size < 20000);
    files.set(path.toLowerCase(), { path, body: tar.subarray(at, at + size) }); at += Math.ceil(size / 512) * 512;
  }
  assert.ok(ended && files.size > 0); return [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

const harnessHash = (root, path) => {
  root = resolve(root);
  assert.ok(safe(path)); const full = join(root, path), stat = lstatSync(full); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  for (let dir = dirname(full); dir !== root; dir = dirname(dir)) assert.ok(!lstatSync(dir).isSymbolicLink());
  return sha256(readFileSync(full, "utf8").replaceAll("\r\n", "\n"));
};
export function prepareExecutionInputs({ folder, buildRoot, commit, cacheRoots, repo = buildRoot, harnessPaths = [] }) {
  const lockBody = readFileSync(join(buildRoot, "package-lock.json")), lock = JSON.parse(lockBody);
  const caches = cacheRoots ?? [process.env.MIXED_PRODUCTION_NPM_CACHE, process.env.npm_config_cache,
    join(homedir(), "npm-cache"), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "npm-cache"), join(homedir(), ".npm")].filter(Boolean);
  const receipt = { schema: "mixed-native-execution-inputs/v1", commit, lockSha256: sha256(lockBody),
    mounts: { source: mountSourceHash(realpathSync(buildRoot)), dependencies: mountSourceHash(join(realpathSync(folder), "execution/dependencies")), output: mountSourceHash(realpathSync(folder)) },
    harnessFiles: [...harnessPaths].sort().map((path) => {
      const hash = harnessHash(buildRoot, path); assert.equal(harnessHash(repo, path), hash, "native host executable differs from archived commit"); return { path, sha256: hash };
    }), packages: [] };
  for (const [index, name] of toolPackages.entries()) {
    const entry = lock.packages[`node_modules/${name}`]; assert.ok(entry && typeof entry.integrity === "string");
    const key = Buffer.from(entry.integrity.slice(7), "base64").toString("hex"); let archive;
    for (const cache of caches) {
      assert.ok(typeof cache === "string" && !cache.replaceAll("\\", "/").startsWith("//"), "local tool cache required");
      const path = join(cache, "_cacache/content-v2/sha512", key.slice(0, 2), key.slice(2, 4), key.slice(4));
      if (existsSync(path)) { archive = readFileSync(path); break; }
    }
    assert.ok(archive, "locked native tool package unavailable in local cache; no fetch permitted");
    const files = packageFiles(archive, entry.integrity), root = `execution/dependencies/${name}`;
    for (const file of files) { const target = join(folder, root, file.path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, file.body, { flag: "wx" }); }
    const packageJSON = JSON.parse(files.find((f) => f.path === "package.json").body); assert.equal(packageJSON.name, name); assert.equal(packageJSON.version, entry.version);
    const path = `execution/packages/${index}.tgz`; mkdirSync(join(folder, "execution/packages"), { recursive: true }); writeFileSync(join(folder, path), archive, { flag: "wx" });
    receipt.packages.push({ name, version: entry.version, integrity: entry.integrity, archive: { path, sha256: sha256(archive) },
      files: files.map(({ path, body }) => ({ path: `${root}/${path}`, sha256: sha256(body) })) });
  }
  const body = JSON.stringify(receipt), path = "execution/inputs.json"; writeFileSync(join(folder, path), body, { flag: "wx" });
  return { path, sha256: sha256(body) };
}

export function finalizeExecutionInputs({ folder, repo }) {
  const receipt = JSON.parse(readFileSync(join(folder, "execution/inputs.json"))), harnessFiles = receipt.harnessFiles.map(({ path }) => ({ path, sha256: harnessHash(repo, path) }));
  writeFileSync(join(folder, "execution/inputs-final.json"), JSON.stringify({ schema: "mixed-native-execution-inputs-final/v1", commit: receipt.commit, harnessFiles }), { flag: "wx" });
  assert.deepEqual(harnessFiles, receipt.harnessFiles, "native host executable changed during execution");
}

export function replayExecutionInputs({ receipt, tracked, fs, commit }) {
  assert.deepEqual(Object.keys(receipt).sort(), ["schema", "commit", "lockSha256", "mounts", "harnessFiles", "packages"].sort());
  assert.equal(receipt.schema, "mixed-native-execution-inputs/v1"); assert.equal(receipt.commit, commit);
  assert.deepEqual(Object.keys(receipt.mounts).sort(), ["dependencies", "output", "source"]);
  for (const value of Object.values(receipt.mounts)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(receipt.lockSha256, sha256(tracked["package-lock.json"]));
  const harnessFiles = Object.keys(tracked).filter((p) => /\.(?:mjs|cjs|js|json)$/.test(p)).sort()
    .map((path) => ({ path, sha256: sha256(tracked[path].toString("utf8").replaceAll("\r\n", "\n")) }));
  assert.deepEqual(receipt.harnessFiles, harnessFiles);
  assert.deepEqual(fs.read("execution/inputs-final.json"), { schema: "mixed-native-execution-inputs-final/v1", commit, harnessFiles });
  const lock = JSON.parse(tracked["package-lock.json"]); assert.deepEqual(receipt.packages.map((p) => p.name), toolPackages);
  const expected = [], sourceFiles = [];
  for (const [index, pkg] of receipt.packages.entries()) {
    assert.deepEqual(Object.keys(pkg).sort(), ["name", "version", "integrity", "archive", "files"].sort());
    assert.deepEqual(Object.keys(pkg.archive).sort(), ["path", "sha256"]);
    const entry = lock.packages[`node_modules/${pkg.name}`]; assert.deepEqual([pkg.version, pkg.integrity, pkg.archive.path], [entry.version, entry.integrity, `execution/packages/${index}.tgz`]);
    const archive = fs.body(pkg.archive.path); assert.equal(sha256(archive), pkg.archive.sha256);
    const files = packageFiles(archive, entry.integrity).map(({ path, body }) => ({ path: `execution/dependencies/${pkg.name}/${path}`, sha256: sha256(body) }));
    assert.deepEqual(pkg.files, files); for (const file of files) { assert.equal(fs.digest(file.path), file.sha256); expected.push(file.path); sourceFiles.push(file); }
  }
  assert.deepEqual([...fs.files.keys()].filter((p) => p.startsWith("execution/dependencies/")).sort(), expected.sort());
  return sourceFiles;
}
