// Tests for bench-size.mjs: node --test scripts/bench-size.test.mjs (npm run check runs it).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LIMIT, LIST, check, committedList, listFor, parseList, reason, tracked } from "./bench-size.mjs";
// The checks against a base, through the module's namespace, so one missing export fails only the tests that use it.
import * as size from "./bench-size.mjs";
import { fixtureGitEnv } from "./fixture-git.mjs";

const blob = (/** @type {string} */ c) => c.repeat(40);
const small = { path: "bench/fullstack/results/r1/summary.json", blob: blob("1"), size: 4096 };
const archive = { path: "bench/fullstack/results/r16/raw.tar.xz", blob: blob("2"), size: 449204 };
const big = { path: "bench/marketplace/results/r20/summary.json", blob: blob("3"), size: 1465178 };
const listed = listFor([small, archive, big]);

test("the list holds a line for each archive and file over the limit, sorted by path", () => {
  assert.equal(listed, `${blob("2")} ${archive.path}\n${blob("3")} ${big.path}`);
  assert.deepEqual(check([small, archive, big], listed), []);
  assert.deepEqual(check([small, archive, big], `# a comment\n\n${listed}\n`), [], "comments and blank lines are skipped");
});

test("a new archive or compressed file under bench/ is refused, whatever its size", () => {
  for (const ext of [".tar", ".tgz", ".gz", ".xz", ".zst", ".bz2", ".zip", ".7z", ".json.gz", ".TAR.XZ"]) {
    const added = { path: `bench/live/evidence/new/run${ext}`, blob: blob("4"), size: 20 };
    const problems = check([small, archive, big, added], listed);
    assert.equal(problems.length, 1, ext);
    assert.match(problems[0], /^bench\/live\/evidence\/new\/run\S+: an archive or compressed file \(\.\S+\), not in scripts\/bench-size\.allow$/, ext);
  }
  assert.equal(reason({ path: "bench/x/notes.gzip.md", blob: blob("4"), size: 20 }), null, "an extension in the middle of a name is not one");
});

test("a new file over 256 KiB under bench/ is refused", () => {
  const added = { path: "bench/fullstack/results/r40/run.log", blob: blob("5"), size: 300 * 1024 };
  assert.deepEqual(check([small, archive, big, added], listed), [
    `bench/fullstack/results/r40/run.log: 300.0 KiB (307200 bytes), over the 256 KiB limit, not in ${LIST}`,
  ]);
});

const live = "bench/live/apps/laravel";
const notLock = (/** @type {string} */ path) =>
  `${path}: 256.0 KiB (262145 bytes), over the 256 KiB limit (a lock file over the limit passes only at a path in LOCKS in scripts/bench-size.mjs, beside its manifest: add its path there, for review), not in ${LIST}`;

test("a lock file over 256 KiB at a path in LOCKS beside its manifest needs no listing; any other is refused and told to add its path to LOCKS", () => {
  assert.deepEqual([...size.LOCKS], [
    ["bench/fullstack/apps/laravel/composer.lock", "composer.json"],
    ["bench/fullstack/apps/nuxt/package-lock.json", "package.json"],
    ["bench/live/apps/laravel/composer.lock", "composer.json"],
  ]);
  for (const [path, manifest] of size.LOCKS) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const name = path.slice(dir.length + 1);
    const lock = { path, blob: blob("7"), size: 900 * 1024 };
    const beside = { path: `${dir}/${manifest}`, blob: blob("8"), size: 100 };
    assert.equal(reason(lock, new Set([name, manifest])), null, path);
    assert.deepEqual(check([lock, beside], ""), [], path);
    // A dependency update: another blob at the same path passes with no edit to LOCKS.
    assert.deepEqual(check([{ ...lock, blob: blob("9"), size: 1200 * 1024 }, beside], ""), [], `${path} at a new blob`);
    assert.match(reason(lock, new Set([name])) ?? "", new RegExp(`over the 256 KiB limit \\(a lock file in LOCKS is exempt only as a regular file beside its manifest, ${manifest.replace(".", "\\.")}\\)$`), `${path} alone`);
    assert.equal(check([lock, { ...beside, path: `bench/${manifest}` }], "").length, 1, `${path} with its manifest in another directory`);
  }
  // A lock file's name and its manifest's beside it, at a path not in LOCKS, prove nothing.
  for (const [name, manifest] of [["Cargo.lock", "Cargo.toml"], ["composer.lock", "composer.json"], ["package-lock.json", "package.json"], ["go.sum", "go.mod"]]) {
    const path = `bench/fullstack/apps/new/${name}`;
    assert.deepEqual(check([{ path, blob: blob("7"), size: LIMIT + 1 }, { path: `bench/fullstack/apps/new/${manifest}`, blob: blob("8"), size: 9 }], ""), [notLock(path)], name);
  }
  assert.deepEqual(check([{ path: `${live}/sub/composer.lock`, blob: blob("7"), size: LIMIT + 1 }, { path: `${live}/sub/composer.json`, blob: blob("8"), size: 9 }], ""), [notLock(`${live}/sub/composer.lock`)], "a listed name in another directory");
  assert.match(reason({ path: "bench/x/notcomposer.lock", blob: blob("7"), size: 900 * 1024 }, new Set(["composer.json"])) ?? "", /over the 256 KiB limit$/, "only a lock file's exact name gets the hint");
  assert.match(reason({ path: `${live}/composer.lock.gz`, blob: blob("7"), size: 20 }, new Set(["composer.json"])) ?? "", /archive/);
  assert.deepEqual(check([{ path: `${live}/composer.lock`, blob: blob("7"), size: 900 * 1024 }, { path: `${live}/composer.json`, blob: blob("8"), size: 9 }], `${blob("7")} ${live}/composer.lock`),
    [`${LIST}: ${live}/composer.lock is no longer an archive or over 256 KiB; remove its line`], "a listed lock file is a stale line");
});

test("each lock file in LOCKS is in this repository, over 256 KiB, and exempt beside its manifest", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const entries = tracked(root, "HEAD");
  for (const [path, manifest] of size.LOCKS) {
    assert.ok((entries.find((e) => e.path === path)?.size ?? 0) > LIMIT, `${path} is over the limit; when a lock no longer is, remove it from LOCKS`);
    assert.ok(entries.some((e) => e.path === `${path.slice(0, path.lastIndexOf("/"))}/${manifest}`), `${path}'s manifest`);
  }
  const problems = check(entries, "");
  assert.deepEqual(problems.filter((p) => [...size.LOCKS.keys()].some((path) => p.startsWith(`${path}:`))), []);
  assert.ok(problems.length > 0, "the archives are still found without the list");
});

test("exactly 256 KiB passes and one byte more does not", () => {
  const at = { path: "bench/live/results/r4/summary.json", blob: blob("6"), size: LIMIT };
  assert.equal(LIMIT, 262144);
  assert.deepEqual(check([at], ""), []);
  assert.deepEqual(check([{ ...at, size: LIMIT + 1 }], ""), [
    `bench/live/results/r4/summary.json: 256.0 KiB (262145 bytes), over the 256 KiB limit, not in ${LIST}`,
  ]);
});

test("a small file that is not an archive needs no listing", () => {
  const added = { path: "bench/catalog/report.md", blob: blob("7"), size: 0 };
  assert.deepEqual(check([small, archive, big, added], listed), []);
});

test("files outside bench/ are not read", () => {
  const outside = [
    { path: "scripts/patch-generated.json", blob: blob("8"), size: 535101 },
    { path: "docs/raw.tar.xz", blob: blob("9"), size: 10 },
    { path: "benchmarks/raw.tar.xz", blob: blob("a"), size: 10 },
  ];
  assert.deepEqual(check([small, archive, big, ...outside], listed), []);
});

test("a listed file whose blob changed is refused", () => {
  const changed = { ...big, blob: blob("b"), size: big.size + 10 };
  assert.deepEqual(check([small, archive, changed], listed), [
    `${big.path}: 1430.8 KiB (1465188 bytes), over the 256 KiB limit, changed from the listed blob ${blob("3")} to ${blob("b")}; a listed file stays as it is`,
  ]);
});

test("a line whose file is gone, or no longer needs it, is stale and refused", () => {
  assert.deepEqual(check([small, big], listed), [`${LIST}: ${archive.path} (${blob("2")}) is no longer in the tree; remove its line`]);
  const shrunk = { ...big, blob: blob("c"), size: 1000 };
  assert.deepEqual(check([small, archive, shrunk], listed), [`${LIST}: ${big.path} is no longer an archive or over 256 KiB; remove its line`]);
});

test("a list line not in its form, listed twice or out of order is refused", () => {
  const [first, second] = listed.split("\n");
  assert.deepEqual(parseList(`${second}\n${first}`).problems, [`${LIST}:2: ${archive.path} comes before ${big.path}; keep the lines sorted by path`]);
  assert.deepEqual(parseList(`${first}\n${first}`).problems, [`${LIST}:2: ${archive.path} is listed twice`]);
  for (const line of [`${blob("2").slice(1)} ${archive.path}`, `${"E".repeat(40)} ${archive.path}`, `${blob("2")}  ${archive.path}`, `${blob("2")} ${archive.path} `, blob("2")]) {
    assert.deepEqual(parseList(line).problems, [`${LIST}:1: "${line}" is not "<blob ID> <path>"`], line);
  }
  assert.deepEqual(parseList(`${"d".repeat(64)} bench/a b.json`).problems, [], "a SHA-256 repository's IDs and a path with a space");
});

// A repository of its own, so the check reads a committed tree rather than this checkout's.
const env = fixtureGitEnv();
delete env.CORTEN_BENCH_SIZE_BASE;
// CI sets it, and with it the check wants an explicit base; a test that means it passes it.
delete env.GITHUB_ACTIONS;
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env,
  }).trim();
let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-size-"));
  git(dir, ["init", "-q"]);
  mkdirSync(join(dir, "bench", "r1"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "bench", "r1", "summary.json"), "{}\n");
  writeFileSync(join(dir, "bench", "r1", "raw.tar.xz"), "not really xz");
  writeFileSync(join(dir, "bench", "r1", "run.log"), Buffer.alloc(LIMIT + 1, 97));
  writeFileSync(join(dir, "outside.tar.xz"), "outside bench/");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "one"]);
});
/** @type {string[]} */
const scratch = [];
after(() => {
  for (const d of [dir, ...scratch]) if (d) rmSync(d, { recursive: true, force: true });
});

test("the tree is read as committed: untracked and uncommitted files are not", () => {
  const committed = tracked(dir, "HEAD", env);
  assert.deepEqual(committed.map((e) => e.path).sort(), ["bench/r1/raw.tar.xz", "bench/r1/run.log", "bench/r1/summary.json"]);
  assert.deepEqual(committed.find((e) => e.path === "bench/r1/run.log"), {
    key: "bench/r1/run.log", path: "bench/r1/run.log", unsupported: null, blob: git(dir, ["rev-parse", "HEAD:bench/r1/run.log"]), size: LIMIT + 1, mode: "100644",
  });
  assert.equal(committedList(dir, "HEAD", env), null, "no list committed yet");
  assert.equal(check(committed, "").length, 2);

  // A list written for the tree, committed, passes; a new file in the working tree is not read.
  writeFileSync(join(dir, LIST), listFor(committed) + "\n");
  git(dir, ["add", LIST]);
  git(dir, ["commit", "-q", "-m", "list"]);
  writeFileSync(join(dir, "bench", "r1", "untracked.zip"), "untracked");
  writeFileSync(join(dir, "bench", "r1", "run.log"), "changed, not committed");
  assert.deepEqual(check(tracked(dir, "HEAD", env), /** @type {string} */ (committedList(dir, "HEAD", env))), []);

  // Committed, the change to a listed file and the new archive are both refused.
  git(dir, ["add", "bench"]);
  git(dir, ["commit", "-q", "-m", "two"]);
  const problems = check(tracked(dir, "HEAD", env), /** @type {string} */ (committedList(dir, "HEAD", env)));
  assert.deepEqual(problems, [
    "bench/r1/untracked.zip: an archive or compressed file (.zip), not in scripts/bench-size.allow",
    "scripts/bench-size.allow: bench/r1/run.log is no longer an archive or over 256 KiB; remove its line",
  ]);
  // The earlier commit still passes: a revision is read as it was.
  assert.deepEqual(check(tracked(dir, "HEAD~1", env), /** @type {string} */ (committedList(dir, "HEAD~1", env))), []);
});

// Repositories with a history: a base commit with a grandfathered archive and its list line, then
// a pull request's commits on top.
const gitIn = (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {Buffer | string} */ input) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd, input, stdio: ["pipe", "pipe", "pipe"], env,
  }).toString("utf8").trim();
/** Writes (a string or Buffer) or removes (null) files, commits all of it and returns the commit. @param {string} d @param {Record<string, string | Buffer | null>} files */
function commit(d, files, message = "change") {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(d, path));
    else {
      mkdirSync(join(d, path, ".."), { recursive: true });
      writeFileSync(join(d, path), content);
    }
  }
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(d, ["rev-parse", "HEAD"]);
}
const id = (/** @type {string} */ d, /** @type {string} */ rev) => git(d, ["rev-parse", rev]);
const header = "# grandfathered\n";
/** A repository whose first commit has bench/r1/raw.tar.xz, listed, and a small file. @param {boolean} [withList] */
function history(withList = true) {
  const d = mkdtempSync(join(tmpdir(), "bench-size-history-"));
  scratch.push(d);
  git(d, ["init", "-q"]);
  git(d, ["config", "core.autocrlf", "false"]);
  commit(d, { "bench/r1/raw.tar.xz": "grandfathered", "bench/r1/summary.json": "{}\n" }, "results");
  const listed = `${id(d, "HEAD:bench/r1/raw.tar.xz")} bench/r1/raw.tar.xz`;
  const base = withList ? commit(d, { [LIST]: `${header}${listed}\n` }, "list") : id(d, "HEAD");
  return { d, base, listed };
}

test("a pull request cannot list its own archive: the line is not the base's and the commit is named", () => {
  const { d, base, listed } = history();
  const archive = "bench/r2/new.zip";
  const head = commit(d, { [archive]: "new archive", [LIST]: `${header}${listed}\n` });
  const line = `${id(d, `HEAD:${archive}`)} ${archive}`;
  const granted = commit(d, { [LIST]: `${header}${listed}\n${line}\n` });
  assert.ok(head);
  const { problems, base: from } = size.run(d, { head: granted, base, env });
  assert.equal(from.sha, base);
  assert.deepEqual(problems, [
    `${LIST}:3: ${archive} (${line.split(" ")[0]}) is not listed in the base ${base}'s list; the list only shrinks, so a line is never added or changed`,
    `${archive}: an archive or compressed file (.zip), at blob ${line.split(" ")[0]} from commit ${head}, which is not that path and blob in the base's list; a merged commit stays in a full clone's history even when a later one deletes the file`,
  ]);
});

test("a grandfathered archive moved with its line is refused", () => {
  const { d, base, listed } = history();
  const blobId = listed.split(" ")[0];
  const head = commit(d, { "bench/r1/raw.tar.xz": null, "bench/r9/raw.tar.xz": "grandfathered", [LIST]: `${header}${blobId} bench/r9/raw.tar.xz\n` });
  const { problems } = size.run(d, { head, base, env });
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /^scripts\/bench-size\.allow:2: bench\/r9\/raw\.tar\.xz \([0-9a-f]+\) is not listed in the base /);
  assert.match(problems[1], new RegExp(`^bench/r9/raw\\.tar\\.xz: an archive or compressed file \\(\\.xz\\), at blob ${blobId} from commit ${head}`));
});

test("an archive a pull request adds and a later commit deletes is refused, naming the commit that added it", () => {
  const { d, base } = history();
  const added = commit(d, { "bench/r2/raw.zip": Buffer.alloc(10, 1) }, "add");
  const deleted = commit(d, { "bench/r2/raw.zip": null }, "delete");
  const big = commit(d, { "bench/r2/run.log": Buffer.alloc(LIMIT + 1, 97) }, "big");
  const shrunk = commit(d, { "bench/r2/run.log": "small now" }, "shrink");
  assert.deepEqual(check(tracked(d, shrunk, env), /** @type {string} */ (committedList(d, shrunk, env))), [], "the tip alone is clean");
  const { problems } = size.run(d, { head: shrunk, base, env });
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], new RegExp(`^bench/r2/raw\\.zip: an archive or compressed file \\(\\.zip\\), at blob [0-9a-f]+ from commit ${added}, `));
  assert.match(problems[1], new RegExp(`^bench/r2/run\\.log: 256\\.0 KiB \\(262145 bytes\\), over the 256 KiB limit, at blob [0-9a-f]+ from commit ${big}, `));
  assert.ok(deleted);
});

test("removing a grandfathered file and its line is accepted, and an unchanged pull request is", () => {
  const { d, base } = history();
  assert.deepEqual(size.run(d, { head: base, base, env }).problems, []);
  const notes = commit(d, { "bench/r1/notes.md": "small\n" });
  assert.deepEqual(size.run(d, { head: notes, base, env }).problems, []);
  const head = commit(d, { "bench/r1/raw.tar.xz": null, [LIST]: header });
  assert.deepEqual(size.run(d, { head, base, env }).problems, []);
});

test("a base with no list accepts a first list only when every line is a file already in its tree", () => {
  const { d, base, listed } = history(false);
  const first = commit(d, { [LIST]: `${header}${listed}\n` }, "list");
  assert.deepEqual(size.run(d, { head: first, base, env }).problems, []);
  git(d, ["reset", "-q", "--hard", base]);
  const added = commit(d, { "bench/r2/raw.zip": "added with the list" }, "archive");
  const line = `${id(d, "HEAD:bench/r2/raw.zip")} bench/r2/raw.zip`;
  const both = commit(d, { [LIST]: `${header}${listed}\n${line}\n` }, "list");
  const { problems } = size.run(d, { head: both, base, env });
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.equal(problems[0], `${LIST}:3: bench/r2/raw.zip (${line.split(" ")[0]}) is not in the base ${base}, which has no list, at that path and blob; a first list holds only files already there`);
  assert.match(problems[1], new RegExp(`^bench/r2/raw\\.zip: an archive or compressed file \\(\\.zip\\), at blob [0-9a-f]+ from commit ${added}, `));
});

test("the base is --base, then CORTEN_BENCH_SIZE_BASE, then the merge base with origin/main, for a merge commit too, and none fails", () => {
  const { d, base } = history();
  assert.throws(() => size.resolveBase(d, { head: "HEAD", env }), /no base to check HEAD against.*--base <revision> or CORTEN_BENCH_SIZE_BASE/);
  git(d, ["branch", "-q", "-M", "main"]);
  git(d, ["checkout", "-q", "-b", "topic"]);
  const topic = commit(d, { "bench/r1/notes.md": "topic\n" });
  git(d, ["checkout", "-q", "main"]);
  const main = commit(d, { "bench/r1/other.md": "main\n" });
  git(d, ["update-ref", "refs/remotes/origin/main", main]);
  assert.deepEqual(size.resolveBase(d, { head: topic, env }), { sha: base, how: "the merge base with origin/main" });
  git(d, ["merge", "-q", "--no-ff", "-m", "merge", "topic"]);
  const merge = id(d, "HEAD");
  assert.deepEqual(size.resolveBase(d, { head: merge, env }), { sha: main, how: "the merge base with origin/main" });
  assert.deepEqual(size.resolveBase(d, { head: merge, env: { ...env, CORTEN_BENCH_SIZE_BASE: base } }), { sha: base, how: "CORTEN_BENCH_SIZE_BASE" });
  assert.deepEqual(size.resolveBase(d, { head: merge, base: topic, env: { ...env, CORTEN_BENCH_SIZE_BASE: base } }), { sha: topic, how: "--base" });
  assert.throws(() => size.resolveBase(d, { head: merge, base: "--all", env }), /"--all" is not a commit/);
  // A file a merged topic brings is read in the merge's history.
  git(d, ["checkout", "-q", "topic"]);
  commit(d, { "bench/r1/late.gz": "x" });
  git(d, ["checkout", "-q", "main"]);
  git(d, ["merge", "-q", "--no-ff", "-m", "merge again", "topic"]);
  const problems = size.run(d, { head: "HEAD", env }).problems;
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /^bench\/r1\/late\.gz: an archive or compressed file \(\.gz\), not in /);
  assert.match(problems[1], /^bench\/r1\/late\.gz: an archive or compressed file \(\.gz\), at blob /);
});

test("a topic that has merged main is checked from its merge base with origin/main, so a file it added and deleted before the merge still fails", () => {
  const { d } = history();
  git(d, ["branch", "-q", "-M", "main"]);
  git(d, ["checkout", "-q", "-b", "topic"]);
  const added = commit(d, { "bench/transient.raw": Buffer.alloc(LIMIT + 1, 97) }, "raw output");
  commit(d, { "bench/transient.raw": null }, "removed");
  git(d, ["checkout", "-q", "main"]);
  const main = commit(d, { "bench/noise.md": "main\n" });
  git(d, ["update-ref", "refs/remotes/origin/main", main]);
  git(d, ["checkout", "-q", "topic"]);
  git(d, ["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
  assert.deepEqual(size.resolveBase(d, { head: "HEAD", env }), { sha: main, how: "the merge base with origin/main" });
  const { problems } = size.run(d, { head: "HEAD", env });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], new RegExp(`^bench/transient\\.raw: .*, at blob [0-9a-f]+ from commit ${added}, `));
});

test("a lock file over 256 KiB a pull request adds or updates at a path in LOCKS passes beside its manifest; without it, or at another path, it is refused", () => {
  const { d, base } = history();
  const added = commit(d, { [`${live}/composer.lock`]: Buffer.alloc(LIMIT + 1, 97), [`${live}/composer.json`]: "{}\n" });
  const bumped = commit(d, { [`${live}/composer.lock`]: Buffer.alloc(LIMIT + 9, 98) }, "dependency update");
  assert.ok(added);
  assert.deepEqual(size.run(d, { head: bumped, base, env }).problems, [], "a new blob at a listed path");
  const alone = commit(d, { [`${live}/composer.json`]: null }, "manifest removed");
  const atTip = size.run(d, { head: alone, base, env }).problems;
  assert.equal(atTip.length, 2, atTip.join("\n"));
  assert.equal(atTip[0], `${live}/composer.lock: 256.0 KiB (262153 bytes), over the 256 KiB limit (a lock file in LOCKS is exempt only as a regular file beside its manifest, composer.json), not in ${LIST}`);
  assert.match(atTip[1], new RegExp(`^${live}/composer\\.lock: .*, at blob [0-9a-f]+ from commit ${alone}, `));

  const { d: d2, base: base2 } = history();
  const result = commit(d2, { "bench/review-results/Cargo.lock": Buffer.alloc(LIMIT + 2, 97), "bench/review-results/Cargo.toml": "[package]\n" });
  const removed = commit(d2, { "bench/review-results/Cargo.lock": null });
  const { problems } = size.run(d2, { head: removed, base: base2, env });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], new RegExp(`^bench/review-results/Cargo\\.lock: 256\\.0 KiB \\(262146 bytes\\), over the 256 KiB limit \\(a lock file over the limit passes only at a path in LOCKS in scripts/bench-size\\.mjs, beside its manifest: add its path there, for review\\), at blob [0-9a-f]+ from commit ${result}, `));
});

/** A row of `git mktree -z`'s input. @param {string} mode @param {string} object @param {Buffer | string} name */
const row = (mode, object, name) =>
  Buffer.concat([Buffer.from(`${mode} ${mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob"} ${object}\t`), Buffer.from(name), Buffer.from([0])]);

/**
 * A commit on `base` whose bench/ has `base`'s r1/ and the files `extra` (raw name bytes and
 * content), with `base`'s scripts/, built from Git objects so any path bytes can be used.
 * @param {string} d @param {string} base @param {[Buffer, Buffer][]} extra
 */
function rawCommit(d, base, extra) {
  const files = extra.map(([name, content]) => row("100644", gitIn(d, ["hash-object", "-w", "--stdin"], content), name));
  const bench = gitIn(d, ["mktree", "-z"], Buffer.concat([row("040000", id(d, `${base}:bench/r1`), "r1"), ...files]));
  const root = gitIn(d, ["mktree", "-z"], Buffer.concat([row("040000", bench, "bench"), row("040000", id(d, `${base}:scripts`), "scripts")]));
  return gitIn(d, ["commit-tree", root, "-p", base, "-m", "raw paths"], "");
}

test("paths are read as bytes: two that are not UTF-8 are distinct, and a control character or a trailing space is unsupported", () => {
  const { d, base } = history();
  const unsupported = (/** @type {string} */ path, /** @type {string} */ why) =>
    `${path}: an unsupported path under bench/ (${why}); rename it with valid UTF-8, no control characters and no name starting or ending with a space`;

  // Two names that a lossy decoding makes the same: the big one is not hidden behind the small one.
  const fe = rawCommit(d, base, [[Buffer.from([0x72, 0x61, 0x77, 0xfe]), Buffer.alloc(LIMIT + 1, 97)], [Buffer.from([0x72, 0x61, 0x77, 0xff]), Buffer.from("small!")]]);
  const entries = tracked(d, fe, env).filter((e) => e.unsupported);
  assert.deepEqual(entries.map((e) => [e.path, e.size]), [['"bench/raw\\xfe"', LIMIT + 1], ['"bench/raw\\xff"', 6]]);
  assert.notEqual(entries[0].key, entries[1].key);
  let problems = size.run(d, { head: fe, base, env }).problems;
  assert.deepEqual(problems.map((p) => p.split("; ")[0]), [
    '"bench/raw\\xfe": an unsupported path under bench/ (not valid UTF-8)',
    '"bench/raw\\xff": an unsupported path under bench/ (not valid UTF-8)',
    `"bench/raw\\xfe": an unsupported path under bench/ (not valid UTF-8), in commit ${fe}`,
    `"bench/raw\\xff": an unsupported path under bench/ (not valid UTF-8), in commit ${fe}`,
  ]);
  assert.equal(problems[0], unsupported('"bench/raw\\xfe"', "not valid UTF-8"));

  // A newline in a name, in a small file that would otherwise pass.
  const newline = rawCommit(d, base, [[Buffer.from("a\nb.json"), Buffer.from("{}")]]);
  problems = size.run(d, { head: newline, base, env }).problems;
  assert.deepEqual(problems.map((p) => p.split("; ")[0]), ['"bench/a\\nb.json": an unsupported path under bench/ (a control character)', `"bench/a\\nb.json": an unsupported path under bench/ (a control character), in commit ${newline}`]);

  // A small archive whose name ends in a space, which the suffix alone would miss.
  const space = rawCommit(d, base, [[Buffer.from("review.zip "), Buffer.from("PK")]]);
  problems = size.run(d, { head: space, base, env }).problems;
  assert.deepEqual(problems.map((p) => p.split("; ")[0]), [
    '"bench/review.zip ": an unsupported path under bench/ (a name that starts or ends with white space)',
    `"bench/review.zip ": an unsupported path under bench/ (a name that starts or ends with white space), in commit ${space}`,
  ]);
});

/** A commit on `parent` whose bench/ is `base`'s r1/ and live/apps/laravel/ with `rows` (`git mktree -z` rows), and `base`'s scripts/. @param {string} d @param {string} parent @param {string} base @param {Buffer[]} rows */
function appCommit(d, parent, base, rows) {
  const tree = (/** @type {string} */ name, /** @type {string} */ inner) => gitIn(d, ["mktree", "-z"], row("040000", inner, name));
  const liveTree = tree("apps", tree("laravel", gitIn(d, ["mktree", "-z"], Buffer.concat(rows))));
  const bench = gitIn(d, ["mktree", "-z"], Buffer.concat([row("040000", liveTree, "live"), row("040000", id(d, `${base}:bench/r1`), "r1")]));
  const root = gitIn(d, ["mktree", "-z"], Buffer.concat([row("040000", bench, "bench"), row("040000", id(d, `${base}:scripts`), "scripts")]));
  return gitIn(d, ["commit-tree", root, "-p", parent, "-m", "app"], "");
}

test("a lock file's manifest is a regular file: a directory, a submodule or a symbolic link named like one does not exempt it, at the tip or in history", () => {
  const { d, base } = history();
  const hash = (/** @type {Buffer | string} */ content) => gitIn(d, ["hash-object", "-w", "--stdin"], content);
  const lock = row("100644", hash(Buffer.alloc(LIMIT + 1, 97)), "composer.lock");
  const kinds = {
    directory: row("040000", gitIn(d, ["mktree", "-z"], row("100644", hash("{}\n"), "x")), "composer.json"),
    submodule: row("160000", base, "composer.json"),
    "symbolic link": row("120000", hash("../../../r1/summary.json"), "composer.json"),
  };
  for (const [kind, manifest] of Object.entries(kinds)) {
    const tip = appCommit(d, base, base, [lock, manifest]);
    const atTip = size.run(d, { head: tip, base, env }).problems;
    assert.ok(atTip.includes(`${live}/composer.lock: 256.0 KiB (262145 bytes), over the 256 KiB limit (a lock file in LOCKS is exempt only as a regular file beside its manifest, composer.json), not in ${LIST}`), `${kind} at the tip:\n${atTip.join("\n")}`);
    // The lock deleted in the next commit: only history has it.
    const deleted = appCommit(d, tip, base, [manifest]);
    const inHistory = size.run(d, { head: deleted, base, env }).problems;
    assert.equal(inHistory.length, 1, `${kind} in history:\n${inHistory.join("\n")}`);
    assert.match(inHistory[0], new RegExp(`^${live}/composer\\.lock: 256\\.0 KiB \\(262145 bytes\\), over the 256 KiB limit \\(a lock file in LOCKS is exempt only as a regular file beside its manifest, composer\\.json\\), at blob [0-9a-f]+ from commit ${tip}, `), kind);
  }
  for (const mode of ["100644", "100755"]) {
    const tip = appCommit(d, base, base, [lock, row(mode, hash("{}\n"), "composer.json")]);
    assert.deepEqual(size.run(d, { head: tip, base, env }).problems, [], `a manifest of mode ${mode}`);
  }
});

test("a lock file over 256 KiB is checked in every commit that has it: its manifest removed then restored, or the lock deleted and added back alone, fails", () => {
  const lock = Buffer.alloc(LIMIT + 1, 97);
  {
    const { d, base } = history();
    commit(d, { [`${live}/composer.lock`]: lock, [`${live}/composer.json`]: "{}\n" });
    const removed = commit(d, { [`${live}/composer.json`]: null }, "manifest removed");
    const restored = commit(d, { [`${live}/composer.json`]: "{}\n" }, "manifest restored");
    const { problems } = size.run(d, { head: restored, base, env });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], new RegExp(`^${live}/composer\\.lock: .*exempt only as a regular file beside its manifest, composer\\.json\\), at blob [0-9a-f]+ from commit ${removed}, `));
  }
  {
    const { d, base } = history();
    commit(d, { [`${live}/composer.lock`]: lock, [`${live}/composer.json`]: "{}\n" });
    commit(d, { [`${live}/composer.lock`]: null, [`${live}/composer.json`]: null }, "both removed");
    const alone = commit(d, { [`${live}/composer.lock`]: lock }, "lock back alone");
    const gone = commit(d, { [`${live}/composer.lock`]: null }, "lock removed");
    const { problems } = size.run(d, { head: gone, base, env });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], new RegExp(`^${live}/composer\\.lock: .*, at blob [0-9a-f]+ from commit ${alone}, `));
  }
});

test("a push is checked from the commit before it, a new branch or tag (an all-zero base) from its merge base with origin/main, and GitHub Actions with no base fails", () => {
  const { d, base } = history();
  commit(d, { "bench/r2/run.log": Buffer.alloc(LIMIT + 1, 97) }, "add");
  const tip = commit(d, { "bench/r2/run.log": null }, "delete");
  // The push has moved origin/main to its tip, so the merge base with origin/main is the tip itself.
  git(d, ["update-ref", "refs/remotes/origin/main", tip]);
  assert.equal(size.run(d, { head: tip, base, env }).problems.length, 1, "the commit before the push");
  assert.throws(() => size.run(d, { head: tip, env: { ...env, GITHUB_ACTIONS: "true" } }), /GitHub Actions.*CORTEN_BENCH_SIZE_BASE/);
  // A new ref: the all-zero commit GitHub gives as its before.
  for (const zero of ["0".repeat(40), "0".repeat(64)]) {
    git(d, ["update-ref", "refs/remotes/origin/main", base]);
    const fromZero = size.run(d, { head: tip, base: zero, env });
    assert.deepEqual(fromZero.base, { sha: base, how: "the merge base with origin/main, for a new branch or tag (an all-zero base)" });
    assert.equal(fromZero.problems.length, 1, zero.length.toString());
    // A tag on main brings nothing main's own pushes did not.
    git(d, ["update-ref", "refs/remotes/origin/main", tip]);
    const onMain = size.run(d, { head: tip, env: { ...env, CORTEN_BENCH_SIZE_BASE: zero } });
    assert.equal(onMain.base.sha, tip);
    assert.deepEqual(onMain.problems, []);
  }
  git(d, ["update-ref", "-d", "refs/remotes/origin/main"]);
  assert.throws(() => size.run(d, { head: tip, base: "0".repeat(40), env }), /all-zero base.*no merge base with origin\/main/);
});

test("an explicit root scan checks the root commit itself without trusting a later list", () => {
  const { d, base, listed } = history();
  const root = id(d, "HEAD^");
  const { problems } = size.run(d, { head: base, base: "root", env });
  assert.ok(problems.some(problem => problem.includes(listed.slice(41)) && problem.includes(`from commit ${root}`)));
  assert.ok(problems.some(problem => problem.includes("not in the base empty history")), problems.join("\n"));
});

test("a shallow clone fails, even with both ends of the range fetched, saying to fetch the whole history", () => {
  const { d, base } = history();
  commit(d, { "bench/r2/run.log": Buffer.alloc(LIMIT + 1, 97) }, "add");
  commit(d, { "bench/r2/run.log": null }, "delete");
  git(d, ["tag", "before", base]);
  const shallow = mkdtempSync(join(tmpdir(), "bench-size-shallow-"));
  scratch.push(shallow);
  rmSync(shallow, { recursive: true });
  git(d, ["clone", "-q", "--depth", "1", pathToFileURL(d).href, shallow]);
  git(shallow, ["fetch", "-q", "--depth", "1", "origin", "refs/tags/before:refs/tags/before"]);
  assert.equal(id(shallow, "before"), base, "the base is in the clone");
  assert.throws(() => size.run(shallow, { head: "HEAD", base, env }), /shallow.*git fetch --unshallow/);
});
test("a file named like a lock beside a file named like its manifest, at a path not in LOCKS, is held to the limit at the tip and in history", () => {
  const { d, base } = history();
  const fake = Buffer.alloc(LIMIT + 1, 97);
  const tip = commit(d, { "bench/results/fake/Cargo.lock": fake, "bench/results/fake/Cargo.toml": "not even TOML" }, "fake pair");
  const atTip = size.run(d, { head: tip, base, env }).problems;
  assert.ok(atTip.some((p) => p.startsWith("bench/results/fake/Cargo.lock: 256.0 KiB (262145 bytes), over the 256 KiB limit") && p.endsWith(`not in ${LIST}`)), atTip.join("\n"));
  const deleted = commit(d, { "bench/results/fake/Cargo.lock": null }, "fake lock deleted");
  const inHistory = size.run(d, { head: deleted, base, env }).problems;
  assert.equal(inHistory.length, 1, inHistory.join("\n"));
  assert.match(inHistory[0], new RegExp(`^bench/results/fake/Cargo\\.lock: 256\\.0 KiB \\(262145 bytes\\), over the 256 KiB limit.*, at blob [0-9a-f]+ from commit ${tip}, `));
});
