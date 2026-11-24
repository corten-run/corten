// Tests for bench-size.mjs: node --test scripts/bench-size.test.mjs (npm run check runs it).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("a lock file over 256 KiB beside its manifest is source input and needs no listing; elsewhere, or an archive named like one, it is refused", () => {
  const manifests = { "composer.lock": "composer.json", "package-lock.json": "package.json", "npm-shrinkwrap.json": "package.json", "Cargo.lock": "Cargo.toml",
    "yarn.lock": "package.json", "pnpm-lock.yaml": "package.json", "bun.lock": "package.json", "bun.lockb": "package.json", "Gemfile.lock": "Gemfile",
    "mix.lock": "mix.exs", "poetry.lock": "pyproject.toml", "uv.lock": "pyproject.toml", "Pipfile.lock": "Pipfile", "go.sum": "go.mod",
    "gradle.lockfile": "build.gradle.kts", "packages.lock.json": "App.csproj" };
  for (const [name, manifest] of Object.entries(manifests)) {
    const lock = { path: `bench/fullstack/apps/x/${name}`, blob: blob("7"), size: 900 * 1024 };
    const beside = { path: `bench/fullstack/apps/x/${manifest}`, blob: blob("8"), size: 100 };
    assert.equal(reason(lock, new Set([name, manifest])), null, name);
    assert.deepEqual(check([lock, beside], ""), [], name);
    assert.match(reason(lock, new Set([name])) ?? "", /over the 256 KiB limit \(a lock file is exempt only beside its manifest/, `${name} alone`);
    assert.equal(check([lock, { ...beside, path: `bench/fullstack/apps/${manifest}` }], "").length, 1, `${name} with its manifest in another directory`);
  }
  // A result that happens to be named like a lock file is output, not input.
  const result = { path: "bench/review-results/Cargo.lock", blob: blob("7"), size: LIMIT + 1 };
  assert.deepEqual(check([result], ""), [`bench/review-results/Cargo.lock: 256.0 KiB (262145 bytes), over the 256 KiB limit (a lock file is exempt only beside its manifest, Cargo.toml), not in ${LIST}`]);
  assert.match(reason({ path: "bench/x/notcomposer.lock", blob: blob("7"), size: 900 * 1024 }, new Set(["composer.json"])) ?? "", /over the 256 KiB limit$/, "only the exact name is a lock file");
  assert.match(reason({ path: "bench/x/package-lock.json.gz", blob: blob("7"), size: 20 }, new Set(["package.json"])) ?? "", /archive/);
  assert.deepEqual(check([{ path: "bench/x/composer.lock", blob: blob("7"), size: 900 * 1024 }, { path: "bench/x/composer.json", blob: blob("8"), size: 9 }], `${blob("7")} bench/x/composer.lock`),
    [`${LIST}: bench/x/composer.lock is no longer an archive or over 256 KiB; remove its line`], "a listed lock file is a stale line");
});

test("the three lock files over 256 KiB in this repository are exempt beside their manifests", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const entries = tracked(root, "HEAD");
  const locks = ["bench/fullstack/apps/laravel/composer.lock", "bench/fullstack/apps/nuxt/package-lock.json", "bench/live/apps/laravel/composer.lock"];
  for (const path of locks) assert.ok((entries.find((e) => e.path === path)?.size ?? 0) > LIMIT, path);
  const problems = check(entries, "");
  assert.deepEqual(problems.filter((p) => locks.some((path) => p.startsWith(`${path}:`))), []);
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
    key: "bench/r1/run.log", path: "bench/r1/run.log", unsupported: null, blob: git(dir, ["rev-parse", "HEAD:bench/r1/run.log"]), size: LIMIT + 1,
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
    `${archive}: an archive or compressed file (.zip), at blob ${line.split(" ")[0]} from commit ${head}, which is not that path and blob in the base's list; a merged commit stays in every clone even when a later one deletes the file`,
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

test("the base is --base, then CORTEN_BENCH_SIZE_BASE, then a merge commit's first parent, then the merge base with origin/main, and none fails", () => {
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
  assert.deepEqual(size.resolveBase(d, { head: merge, env }), { sha: main, how: "the merge commit's first parent" });
  assert.deepEqual(size.resolveBase(d, { head: merge, env: { ...env, CORTEN_BENCH_SIZE_BASE: base } }), { sha: base, how: "CORTEN_BENCH_SIZE_BASE" });
  assert.deepEqual(size.resolveBase(d, { head: merge, base: topic, env: { ...env, CORTEN_BENCH_SIZE_BASE: base } }), { sha: topic, how: "--base" });
  assert.throws(() => size.resolveBase(d, { head: merge, base: "--all", env }), /"--all" is not a commit/);
  // A merge commit's own changes against its first parent are what the pull request brings.
  git(d, ["checkout", "-q", "topic"]);
  commit(d, { "bench/r1/late.gz": "x" });
  git(d, ["checkout", "-q", "main"]);
  git(d, ["merge", "-q", "--no-ff", "-m", "merge again", "topic"]);
  const problems = size.run(d, { head: "HEAD", env }).problems;
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /^bench\/r1\/late\.gz: an archive or compressed file \(\.gz\), not in /);
  assert.match(problems[1], /^bench\/r1\/late\.gz: an archive or compressed file \(\.gz\), at blob /);
});

test("a lock file over 256 KiB a pull request adds passes beside its manifest and is refused without it", () => {
  const { d, base } = history();
  const lock = Buffer.alloc(LIMIT + 1, 97);
  const app = commit(d, { "bench/app/Cargo.lock": lock, "bench/app/Cargo.toml": "[package]\n" });
  assert.deepEqual(size.run(d, { head: app, base, env }).problems, []);
  const result = commit(d, { "bench/review-results/Cargo.lock": Buffer.alloc(LIMIT + 2, 97) });
  const removed = commit(d, { "bench/review-results/Cargo.lock": null });
  const { problems } = size.run(d, { head: removed, base, env });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], new RegExp(`^bench/review-results/Cargo\\.lock: 256\\.0 KiB \\(262146 bytes\\), over the 256 KiB limit \\(a lock file is exempt only beside its manifest, Cargo\\.toml\\), at blob [0-9a-f]+ from commit ${result}, `));
});

/** A row of `git mktree -z`'s input. @param {string} mode @param {string} object @param {Buffer | string} name */
const row = (mode, object, name) => Buffer.concat([Buffer.from(`${mode} ${mode === "040000" ? "tree" : "blob"} ${object}\t`), Buffer.from(name), Buffer.from([0])]);

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
