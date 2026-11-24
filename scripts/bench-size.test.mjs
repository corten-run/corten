// Tests for bench-size.mjs: node --test scripts/bench-size.test.mjs (npm run check runs it).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMIT, LIST, check, committedList, listFor, parseList, reason, tracked } from "./bench-size.mjs";
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

test("a dependency lock file over 256 KiB is source input and needs no listing, but an archive named like one is refused", () => {
  for (const name of ["composer.lock", "package-lock.json", "Cargo.lock", "yarn.lock", "pnpm-lock.yaml", "Gemfile.lock", "mix.lock", "go.sum"]) {
    const lock = { path: `bench/fullstack/apps/x/${name}`, blob: blob("7"), size: 900 * 1024 };
    assert.equal(reason(lock), null, name);
    assert.deepEqual(check([lock], ""), [], name);
  }
  assert.match(reason({ path: "bench/x/notcomposer.lock", blob: blob("7"), size: 900 * 1024 }) ?? "", /over the 256 KiB limit/, "only the exact name is a lock file");
  assert.match(reason({ path: "bench/x/package-lock.json.gz", blob: blob("7"), size: 20 }) ?? "", /archive/);
  assert.deepEqual(check([{ path: "bench/x/composer.lock", blob: blob("7"), size: 900 * 1024 }], `${blob("7")} bench/x/composer.lock`),
    [`${LIST}: bench/x/composer.lock is no longer an archive or over 256 KiB; remove its line`], "a listed lock file is a stale line");
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
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("the tree is read as committed: untracked and uncommitted files are not", () => {
  const committed = tracked(dir, "HEAD", env);
  assert.deepEqual(committed.map((e) => e.path).sort(), ["bench/r1/raw.tar.xz", "bench/r1/run.log", "bench/r1/summary.json"]);
  assert.deepEqual(committed.find((e) => e.path === "bench/r1/run.log"), {
    path: "bench/r1/run.log", blob: git(dir, ["rev-parse", "HEAD:bench/r1/run.log"]), size: LIMIT + 1,
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
