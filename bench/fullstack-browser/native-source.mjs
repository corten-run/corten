import assert from "node:assert/strict";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { immutableGit } from "../mixed-production/immutable-git.mjs";
import { nativeBuildArchiveArgs } from "../mixed-production/build-context.mjs";
import { packageFiles } from "../mixed-production/execution-inputs.mjs";
import { readRegular, physical } from "../workloads/isolated/evidence.mjs";
import { candidates } from "./contract.mjs";
import { sourceRoots as clientSourceRoots } from "../client-heavy/contract.mjs";
import { exact, sha256 } from "./native-evidence.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const roots = ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "crates", "bench/fullstack-browser", "bench/fullstack", "bench/marketplace", "bench/workloads"];
const tools = ["@playwright/test", "playwright", "playwright-core", "typescript"];
function commitId(commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(immutableGit(repo, ["rev-parse", "--verify", `${commit}^{commit}`]).toString().trim(), commit);
}
function tracked(commit, selected = roots) {
  commitId(commit);
  const output = immutableGit(repo, ["ls-tree", "-rz", "--full-tree", commit, "--", ...selected]).toString("utf8");
  const rows = output.split("\0").filter(Boolean).map((row) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row); assert.ok(match, "nonregular committed source");
    const [, mode, oid, path] = match;
    return { mode, oid, path };
  });
  // Same hardened local Git boundary as immutableGit; batch stdin avoids one
  // process per source file. No saved path, alternate config or lazy fetch.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  const answer = spawnSync("git", ["--no-replace-objects", "--no-lazy-fetch", "-c", "protocol.allow=never", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", "-c", "core.eol=lf", "cat-file", "--batch"], {
    cwd: repo, env, input: rows.map((r) => r.oid + "\n").join(""), maxBuffer: 256 * 1024 ** 2, timeout: 60000, windowsHide: true,
  });
  assert.ok(!answer.error && answer.status === 0); const batch = answer.stdout; let at = 0;
  const files = rows.map(({ mode, oid, path }) => {
    const end = batch.indexOf(10, at); assert.ok(end >= at);
    const [id, type, length] = batch.subarray(at, end).toString().split(" "), size = Number(length);
    assert.ok(id === oid && type === "blob" && Number.isSafeInteger(size) && size >= 0 && size <= 256 * 1024 ** 2);
    at = end + 1; const body = batch.subarray(at, at + size);
    assert.ok(body.length === size && batch[at + size] === 10); at += size + 1;
    assert.equal(createHash("sha1").update(`blob ${size}\0`).update(body).digest("hex"), oid);
    return { path, mode, body, sha256: sha256(body) };
  });
  assert.equal(at, batch.length); return files;
}
const bound = (path) => clientSourceRoots.some((root) => path === root || path.startsWith(root + "/"))
  || !path.split("/").some((part) => ["results", "evidence", "work", "node_modules", "target"].includes(part));
export function captureSource(store, commit) {
  const files = tracked(commit).filter((f) => bound(f.path)).map(({ path, mode, body, sha256: hash }) => ({ path, mode, sha256: hash, body: store.blob(body) }));
  return { schema: "native-browser-source/v2", commit, files };
}
export function replaySource(reader, receipt, commit) {
  exact(receipt, ["schema", "commit", "files"]); assert.equal(receipt.schema, "native-browser-source/v2"); assert.equal(receipt.commit, commit);
  const expected = tracked(commit).filter((f) => bound(f.path));
  assert.equal(receipt.files.length, expected.length);
  receipt.files.forEach((file, i) => {
    exact(file, ["path", "mode", "sha256", "body"]);
    const want = expected[i]; assert.deepEqual([file.path, file.mode, file.sha256], [want.path, want.mode, want.sha256]);
    assert.ok(reader.read(file.body).equals(want.body));
  });
  return { commit, files: expected.map(({ path, mode, sha256: hash }) => ({ path, mode, sha256: hash })) };
}
function archive(commit, app) {
  commitId(commit); assert.ok(candidates.includes(app));
  const temporary = mkdtempSync(join(tmpdir(), "corten-native-archive-"));
  try {
    const output = join(temporary, "context.tar");
    immutableGit(repo, nativeBuildArchiveArgs(commit, app, { output }));
    assert.ok(lstatSync(output).size <= 256 * 1024 ** 2);
    const body = readRegular(output);
    // Compare standard tar members with canonical Git blobs too. A local
    // attributes/export filter cannot silently erase or substitute source.
    const prefix = app === "corten" ? "" : `bench/fullstack/apps/${app}/`;
    const expected = tracked(commit, prefix ? [prefix] : []).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
    validateArchive(body, expected); return body;
  } finally { rmSync(temporary, { recursive: true }); }
}
// The bounded ustar/PAX reader follows mixed-production/verify.mjs. Never
// extracts or executes saved bytes; only regular files/directories are accepted.
function validateArchive(body, expected) {
  const files = new Map(expected.map((f) => [f.path, f])), seen = new Set(); let at = 0, extended = {};
  const string = (b) => b.subarray(0, b.includes(0) ? b.indexOf(0) : b.length).toString("utf8");
  const octal = (b) => { const s = string(b).trim(); assert.match(s, /^[0-7]+$/); const n = parseInt(s, 8); assert.ok(Number.isSafeInteger(n)); return n; };
  const pax = (data) => {
    const fields = {}; let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(32, offset); assert.ok(space > offset);
      const length = data.subarray(offset, space).toString(); assert.match(length, /^[1-9]\d*$/); const size = Number(length);
      assert.ok(Number.isSafeInteger(size) && size > space - offset + 2 && offset + size <= data.length && data[offset + size - 1] === 10);
      const row = data.subarray(space + 1, offset + size - 1).toString("utf8"), eq = row.indexOf("="); assert.ok(eq > 0);
      const key = row.slice(0, eq); assert.ok(!Object.hasOwn(fields, key) && ["path", "comment", "mtime", "atime", "ctime"].includes(key));
      fields[key] = row.slice(eq + 1); offset += size;
    }
    return fields;
  };
  assert.equal(body.length % 512, 0);
  while (at + 1024 <= body.length) {
    const h = body.subarray(at, at + 512); at += 512;
    if (h.every((v) => v === 0)) {
      assert.ok(body.subarray(at).every((v) => v === 0)); assert.deepEqual([...seen].sort(), [...files.keys()].sort()); return;
    }
    assert.equal(string(h.subarray(257, 263)), "ustar");
    assert.equal(octal(h.subarray(148, 156)), [...h].reduce((n, v, i) => n + (i >= 148 && i < 156 ? 32 : v), 0));
    const size = octal(h.subarray(124, 136)); assert.ok(size <= 256 * 1024 ** 2 && at + size <= body.length);
    const data = body.subarray(at, at + size); at += Math.ceil(size / 512) * 512;
    if ([103, 120].includes(h[156])) {
      const fields = pax(data); if (h[156] === 103) assert.ok(!Object.hasOwn(fields, "path")); else { assert.deepEqual(extended, {}); extended = fields; } continue;
    }
    const prefix = string(h.subarray(345, 500)), name = string(h.subarray(0, 100)), path = extended.path ?? (prefix ? `${prefix}/${name}` : name); extended = {};
    assert.equal(string(h.subarray(157, 257)), "");
    if (h[156] === 53) { assert.ok(size === 0 && path.endsWith("/") && expected.some((f) => f.path.startsWith(path))); continue; }
    assert.ok([0, 48].includes(h[156]) && files.has(path) && !seen.has(path)); seen.add(path);
    assert.equal(octal(h.subarray(100, 108)) & 0o777, files.get(path).mode === "100755" ? 0o775 : 0o664);
    assert.ok(data.equals(files.get(path).body), "archive differs from canonical committed blob");
  }
  throw Error("native archive terminator missing");
}
export function captureBuildContext(store, commit, app) {
  const body = archive(commit, app);
  return { schema: "native-browser-build-context/v2", commit, app,
    dockerfile: app === "corten" ? "bench/marketplace/corten/Dockerfile" : app === "sveltekit" ? "Dockerfile.marketplace" : "Dockerfile", body: store.blob(body) };
}
export function replayBuildContext(reader, receipt, commit, app) {
  exact(receipt, ["schema", "commit", "app", "dockerfile", "body"]);
  assert.deepEqual([receipt.schema, receipt.commit, receipt.app], ["native-browser-build-context/v2", commit, app]);
  assert.equal(receipt.dockerfile, app === "corten" ? "bench/marketplace/corten/Dockerfile" : app === "sveltekit" ? "Dockerfile.marketplace" : "Dockerfile");
  assert.ok(reader.read(receipt.body).equals(archive(commit, app)), "retained Docker stdin differs from immutable build context");
  return { commit, app, dockerfile: receipt.dockerfile, sha256: receipt.body.sha256 };
}
function cached(entry) {
  const key = Buffer.from(entry.integrity.slice(7), "base64").toString("hex");
  const npm = join(dirname(realpathSync(process.execPath)), "node_modules/npm/bin/npm-cli.js");
  const configured = existsSync(npm) ? spawnSync(process.execPath, [npm, "config", "get", "cache", "--offline", "--ignore-scripts"],
    { cwd: repo, windowsHide: true, encoding: "utf8", maxBuffer: 4096, timeout: 10000 }) : null;
  const caches = [process.env.npm_config_cache, configured?.status === 0 && configured.stdout.trim(),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "npm-cache"), join(homedir(), ".npm"), join(homedir(), "npm-cache")].filter(Boolean);
  for (const cache of caches) {
    assert.ok(!cache.replaceAll("\\", "/").startsWith("//"));
    const path = join(cache, "_cacache/content-v2/sha512", key.slice(0, 2), key.slice(2, 4), key.slice(4));
    if (existsSync(path)) return readRegular(path);
  }
  throw Error("locked native tool package absent from local cache; no fetch permitted");
}
function installed(root) {
  physical(root); const files = [];
  function walk(path, prefix, depth) {
    assert.ok(depth < 16);
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), stat = lstatSync(full), key = prefix ? `${prefix}/${name}` : name;
      assert.ok(!stat.isSymbolicLink());
      if (stat.isDirectory()) walk(full, key, depth + 1);
      else { assert.ok(stat.size <= 32 * 1024 ** 2 && files.length < 20000); files.push({ path: key, body: readRegular(full) }); }
    }
  }
  walk(root, "", 0); return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
const executableChunkBytes = 16 * 1024 ** 2, maxExecutableBytes = 512 * 1024 ** 2;
const sameExecutable = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every((key) => a[key] === b[key]);
/** Live executable input only. Saved receipts never choose a local path to open. */
export function captureExecutableBytes(store, path) {
  assert.ok(typeof path === "string" && !path.replaceAll("\\", "/").startsWith("//"));
  path = resolve(path); physical(path, false);
  const before = lstatSync(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size > 0n && before.size <= BigInt(maxExecutableBytes), "executable size/type outside fixed bounds");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.ok(sameExecutable(before, fstatSync(fd, { bigint: true })), "executable replaced before capture");
    const bytes = Number(before.size), chunks = [], hash = createHash("sha256");
    for (let offset = 0; offset < bytes; offset += executableChunkBytes) {
      assert.ok(sameExecutable(before, fstatSync(fd, { bigint: true })), "executable mutated during capture");
      const body = Buffer.alloc(Math.min(executableChunkBytes, bytes - offset)); let at = 0;
      while (at < body.length) {
        const count = readSync(fd, body, at, body.length - at, offset + at); assert.ok(count > 0); at += count;
      }
      hash.update(body); chunks.push(store.blob(body));
    }
    assert.ok(sameExecutable(before, fstatSync(fd, { bigint: true })) && sameExecutable(before, lstatSync(path, { bigint: true })),
      "executable mutated during capture");
    physical(path, false);
    return { schema: "native-browser-executable-bytes/v1", bytes, sha256: hash.digest("hex"), chunks };
  } finally { closeSync(fd); }
}
export function replayExecutableBytes(reader, receipt) {
  exact(receipt, ["schema", "bytes", "sha256", "chunks"]);
  assert.equal(receipt.schema, "native-browser-executable-bytes/v1");
  assert.ok(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= maxExecutableBytes);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(receipt.chunks) && receipt.chunks.length === Math.ceil(receipt.bytes / executableChunkBytes));
  // Validate ALL sizes/refs before the evidence reader can allocate any chunk.
  receipt.chunks.forEach((ref, i) => {
    exact(ref, ["path", "bytes", "sha256"]); assert.match(ref.sha256, /^[a-f0-9]{64}$/);
    assert.equal(ref.path, `native-evidence/blobs/${ref.sha256}`);
    assert.equal(ref.bytes, Math.min(executableChunkBytes, receipt.bytes - i * executableChunkBytes));
  });
  const hash = createHash("sha256"); let bytes = 0;
  for (const ref of receipt.chunks) {
    const body = reader.read(ref); assert.equal(body.length, ref.bytes); hash.update(body); bytes += body.length;
  }
  assert.equal(bytes, receipt.bytes); const digest = hash.digest("hex"); assert.equal(digest, receipt.sha256);
  return digest;
}
export function captureTools(store, { browserExecutable }) {
  assert.ok(["win32", "linux"].includes(process.platform), "native browser tool closure currently covers Windows/Linux only");
  assert.ok(typeof browserExecutable === "string" && !browserExecutable.replaceAll("\\", "/").startsWith("//"));
  const lockBody = readRegular(join(repo, "package-lock.json")), lock = JSON.parse(lockBody);
  const packages = tools.map((name) => {
    const entry = lock.packages[`node_modules/${name}`]; assert.ok(entry);
    const compressed = cached(entry), expected = packageFiles(compressed, entry.integrity);
    const manifest = JSON.parse(expected.find((f) => f.path === "package.json").body);
    assert.deepEqual([manifest.name, manifest.version], [name, entry.version]);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) assert.ok(tools.includes(dependency), "unbundled runtime tool dependency");
    const actual = installed(realpathSync(join(repo, "node_modules", name)));
    assert.deepEqual(actual.map((f) => [f.path, sha256(f.body)]), expected.map((f) => [f.path, sha256(f.body)]), "installed tool differs from locked package");
    return { name, version: entry.version, archive: store.blob(compressed), files: actual.map((f) => ({ path: f.path, body: store.blob(f.body) })) };
  });
  return { schema: "native-browser-tools/v3", lock: store.blob(lockBody), node: captureExecutableBytes(store, realpathSync(process.execPath)),
    browser: captureExecutableBytes(store, realpathSync(resolve(browserExecutable))), packages };
}
export function replayTools(reader, receipt) {
  exact(receipt, ["schema", "lock", "node", "browser", "packages"]);
  assert.equal(receipt.schema, "native-browser-tools/v3", "unsupported tool receipt; regenerate unpublished v2 development evidence");
  const lock = JSON.parse(reader.read(receipt.lock));
  assert.deepEqual(receipt.packages.map((p) => p.name), tools);
  for (const pkg of receipt.packages) {
    exact(pkg, ["name", "version", "archive", "files"]);
    const entry = lock.packages[`node_modules/${pkg.name}`]; assert.equal(pkg.version, entry.version);
    const expected = packageFiles(reader.read(pkg.archive), entry.integrity);
    const manifest = JSON.parse(expected.find((f) => f.path === "package.json").body);
    assert.deepEqual([manifest.name, manifest.version], [pkg.name, entry.version]);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) assert.ok(tools.includes(dependency), "unbundled runtime tool dependency");
    assert.deepEqual(pkg.files.map((f) => f.path), expected.map((f) => f.path));
    pkg.files.forEach((f, i) => { exact(f, ["path", "body"]); assert.ok(reader.read(f.body).equals(expected[i].body)); });
  }
  return { node: replayExecutableBytes(reader, receipt.node), browser: replayExecutableBytes(reader, receipt.browser), lockSha256: receipt.lock.sha256 };
}
