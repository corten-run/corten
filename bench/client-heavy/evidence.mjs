import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, mkdir, readdir, realpath, readlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { sourceRoots, configurationNames } from "./contract.mjs";
import { binTarget, installLayout } from "./install-layout.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = (value) => JSON.stringify(value, null, 2) + "\n";
export const failure = (error) => ({ name: error.name, diagnosticSha256: sha256(String(error)) });
export const clock = () => performance.now();
const inside = (base, path) => { const r = relative(base, path); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`)); };

async function regularBytes(absolute, limit, expectedLinks = 1n) {
  const before = await lstat(absolute, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === expectedLinks, "linked-or-nonregular-source");
  assert.ok(before.size <= BigInt(limit), "evidence-file-limit");
  assert.equal(await realpath(absolute), absolute, "aliased-source-path");
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    assert.ok(stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size, "source-changed-during-read");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      assert.ok(result.bytesRead > 0, "source-truncated-during-read"); offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), leaf = await lstat(absolute, { bigint: true });
    assert.ok(after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs
      && after.nlink === expectedLinks && leaf.nlink === expectedLinks && leaf.ino === before.ino && leaf.dev === before.dev && !leaf.isSymbolicLink()
      && await realpath(absolute) === absolute, "source-changed-during-read");
    return bytes;
  } finally { await handle.close(); }
}

// These receipts describe observations by this process, not an independent approval.
export function command(command, args, cwd) {
  const startedAt = clock();
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    assert.ok(![command, ...args].some((arg) => /[&|<>^%!"\r\n]/.test(arg)), "unsafe-batch-argument");
  }
  const batch = process.platform === "win32" && /\.cmd$/i.test(command);
  const result = spawnSync(batch ? "cmd.exe" : command, batch ? ["/d", "/c", command, ...args] : args,
    { cwd, windowsHide: true, maxBuffer: 64 * 1024 ** 2 });
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
  return { stdout, stderr, receipt: { command, args, configurationNames: configurationNames(process.env), startedAt, endedAt: clock(), status: result.status, signal: result.signal,
    failure: result.error ? failure(result.error) : null, stdout: { bytes: stdout.length, sha256: sha256(stdout) },
    stderr: { bytes: stderr.length, sha256: sha256(stderr) } } };
}

export async function closeObserved(resource, close, observed) {
  const receipt = { resource, startedAt: clock(), endedAt: null, returned: false, observed: null, failure: null };
  try { await close(); receipt.returned = true; receipt.observed = await observed(); }
  catch (error) { receipt.failure = failure(error); }
  receipt.endedAt = clock();
  return receipt;
}

export class Evidence {
  constructor(root, out) {
    this.root = resolve(root); this.out = resolve(out);
    this.limits = { entries: 40000, fileBytes: 128 * 1024 ** 2, bytes: 1024 * 1024 ** 2, depth: 32 };
    this.bytes = 0; this.blobs = new Set(); this.blobFileBytes = new Map();
    this.blockers = ["external-trusted-execution-source-build-and-host-admission-required"];
  }
  async save(path, value) {
    assert.ok(!isAbsolute(path) && inside(this.out, resolve(this.out, path)), "unsafe-evidence-output");
    await mkdir(dirname(join(this.out, path)), { recursive: true });
    await writeFile(join(this.out, path), json(value));
  }
  async blob(bytes, fileBytes = this.limits.fileBytes) {
    const sha = sha256(bytes);
    if (!this.blobs.has(sha)) {
      assert.ok(bytes.length <= fileBytes && this.bytes + bytes.length <= this.limits.bytes, "evidence-byte-limit");
      const path = join(this.out, "evidence/blobs", sha);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: "wx" });
      this.blobs.add(sha); this.bytes += bytes.length;
      this.blobFileBytes.set(`evidence/blobs/${sha}`, fileBytes);
    }
    return { bytes: bytes.length, sha256: sha, blob: `evidence/blobs/${sha}` };
  }
  async file(base, path, fileBytes = this.limits.fileBytes) {
    const absolute = resolve(base, path);
    assert.ok(inside(base, absolute), "source-path-escape");
    // Check every ancestor, not just the leaf: package roots can be junctions.
    let ancestor = resolve(base);
    for (const part of ["", ...relative(base, absolute).split(sep).slice(0, -1)]) {
      ancestor = join(ancestor, part);
      const stat = await lstat(ancestor);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "linked-source-ancestor");
    }
    return this.blob(await regularBytes(absolute, fileBytes), fileBytes);
  }
  git(args) {
    return execFileSync("git", args, { cwd: this.root, maxBuffer: 64 * 1024 ** 2, windowsHide: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
  }
  async source(stage) {
    const value = { schema: "client-heavy-source/v1", stage, startedAt: clock(), commit: null, status: null, diff: null, entries: [], unavailable: [] };
    try {
      value.commit = this.git(["rev-parse", "HEAD"]).toString().trim();
      value.status = await this.blob(this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
      value.diff = await this.blob(this.git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--", ...sourceRoots]));
      const paths = [...new Set(this.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...sourceRoots]).toString().split("\0")
        .filter((path) => path && !inside(this.out, resolve(this.root, path))))].sort();
      assert.ok(paths.length <= this.limits.entries, "source-count-limit");
      for (const path of paths) {
        try { value.entries.push({ path, ...await this.file(this.root, path) }); }
        catch (error) { value.unavailable.push({ path, ...failure(error) }); }
      }
      if (value.status.bytes) this.blockers.push(`source-${stage}-not-clean`);
    } catch (error) { value.unavailable.push({ path: null, ...failure(error) }); }
    if (value.unavailable.length) this.blockers.push(`source-${stage}-incomplete`);
    value.endedAt = clock();
    await this.save(`evidence/source-${stage}.json`, value);
    return value;
  }
  async tree(base, label, stage) {
    const value = { schema: "client-heavy-dependency-bytes/v1", label, stage, entries: [], unavailable: [], startedAt: clock() };
    const npm = ["node-dependencies", "browser-dependencies"].includes(label), regular = [], links = [], groups = new Map();
    let count = 0;
    const walk = async (path, depth) => {
      assert.ok(depth <= this.limits.depth && ++count <= this.limits.entries, "dependency-tree-limit");
      const absolute = join(base, path), stat = await lstat(absolute, { bigint: true });
      if (npm && path && stat.isSymbolicLink()) { links.push({ path, target: await readlink(absolute), stat }); return; }
      assert.ok(!stat.isSymbolicLink(), "linked-dependency");
      assert.equal(await realpath(absolute), resolve(absolute), "aliased-dependency");
      if (stat.isDirectory()) for (const name of (await readdir(absolute)).sort()) await walk(path ? `${path}/${name}` : name, depth + 1);
      else if (npm) {
        assert.ok(stat.isFile(), "nonregular-dependency");
        regular.push({ path, stat });
        const identity = `${stat.dev}:${stat.ino}`;
        if (!groups.has(identity)) groups.set(identity, []);
        groups.get(identity).push(path);
      } else value.entries.push({ path, ...await this.file(base, path) });
    };
    try {
      await walk("", 0);
      if (npm) {
        value.layout = { schema: "client-heavy-install-layout/v1", bins: [], hardlinks: [] };
        for (const paths of groups.values()) if (paths.length > 1) value.layout.hardlinks.push(paths);
        for (const { path, stat } of regular) {
          const peers = groups.get(`${stat.dev}:${stat.ino}`);
          assert.equal(stat.nlink, BigInt(peers.length), "install-hardlink-escapes-root");
          const absolute = resolve(base, path), now = await lstat(absolute, { bigint: true });
          assert.ok(now.dev === stat.dev && now.ino === stat.ino && now.nlink === stat.nlink, "install-layout-changed");
          value.entries.push({ path, ...await this.blob(await regularBytes(absolute, this.limits.fileBytes, stat.nlink)) });
        }
        const entries = new Map(value.entries.map(({ path, ...ref }) => [path, ref]));
        const blob = (ref) => regularBytes(join(this.out, ref.blob), this.limits.fileBytes);
        // The pure declaration check needs only package manifests. Resolve no
        // symlink at all: bin bytes come from already-read regular targets.
        const manifests = new Map();
        for (const [path, ref] of entries) if (path.endsWith("/package.json")) manifests.set(ref.sha256, await blob(ref));
        for (const { path, target, stat } of links) {
          const resolved = binTarget(path, target, entries, (ref) => manifests.get(ref.sha256));
          const absolute = join(base, path), now = await lstat(absolute, { bigint: true });
          assert.ok(now.isSymbolicLink() && now.dev === stat.dev && now.ino === stat.ino && now.mtimeNs === stat.mtimeNs
            && now.ctimeNs === stat.ctimeNs && await readlink(absolute) === target, "install-link-changed");
          value.entries.push({ path, ...entries.get(resolved) });
          value.layout.bins.push({ path, target });
        }
        value.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        installLayout(value.layout, new Map(value.entries.map(({ path, ...ref }) => [path, ref])), (ref) => manifests.get(ref.sha256));
      }
    }
    catch (error) { value.unavailable.push(failure(error)); this.blockers.push(`${label}-${stage}-incomplete`); }
    value.endedAt = clock();
    await this.save(`evidence/${label}-${stage}.json`, value);
    return value;
  }
  async tool(commandName, args, label) {
    const result = command(commandName, args, this.root);
    const receipt = { ...result.receipt, stdout: await this.blob(result.stdout), stderr: await this.blob(result.stderr) };
    await this.save(`evidence/${label}.json`, receipt);
    if (receipt.status !== 0 || receipt.failure) this.blockers.push(`${label}-unavailable`);
    return { ...result, receipt };
  }
  async seal(identity) {
    const files = [], seen = new Set();
    let bytesSeen = 0, count = 0;
    const walk = async (path, depth = 0) => {
      assert.ok(depth <= this.limits.depth, "saved-evidence-depth-limit");
      for (const name of (await readdir(join(this.out, path))).sort()) {
        assert.ok(++count <= this.limits.entries * 2, "saved-evidence-count-limit");
        const next = path ? `${path}/${name}` : name;
        assert.ok(!seen.has(next.toLowerCase()), "duplicate-or-case-colliding-evidence"); seen.add(next.toLowerCase());
        assert.notEqual(next, "review-subject.json", "subject-already-exists");
        const stat = await lstat(join(this.out, next));
        assert.ok(!stat.isSymbolicLink(), "linked-saved-evidence");
        if (stat.isDirectory()) await walk(next, depth + 1);
        else {
          assert.ok(stat.isFile() && stat.nlink === 1, "nonregular-saved-evidence");
          const fileBytes = this.blobFileBytes.get(next) ?? this.limits.fileBytes;
          assert.ok(stat.size <= fileBytes && (bytesSeen += stat.size) <= this.limits.bytes * 2, "saved-evidence-byte-limit");
          const bytes = await regularBytes(join(this.out, next), fileBytes);
          files.push({ path: next, bytes: bytes.length, sha256: sha256(bytes) });
        }
      }
    };
    await walk("");
    const subject = { schema: "client-heavy-review-subject/v1", ...identity, files };
    await this.save("review-subject.json", { ...subject, subjectSha256: sha256(json(subject)) });
    return subject;
  }
}
