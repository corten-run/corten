import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cited, unresolved } from "./design-refs.mjs";

const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
/** A commit on the tree of HEAD, its parent, made by no branch. @param {string} repo @param {string} message */
const loose = (repo, message) => git(repo, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", message]);

let dir = "";
let repo = "";
/** HEAD's parent, on HEAD's history. */
let first = "";
/** A file's object, not a commit. */
let blob = "";
/** A commit the clone has, kept only by a branch HEAD is not on. */
let side = "";
/** A commit the clone has, kept only by an evidence tag. */
let kept = "";
// A commit of another clone, which this one lacks.
const lacking = "7cea497078ee016952f6c8d02bb00e06144baf04";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "design-refs-"));
  // Two commits, so a clone of the last one alone is shallow.
  repo = join(dir, "repo");
  git(dir, ["init", "-q", repo]);
  writeFileSync(join(repo, "a.md"), "one\n");
  git(repo, ["add", "a.md"]);
  git(repo, ["commit", "-q", "-m", "one"]);
  first = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "a.md"), "two\n");
  git(repo, ["commit", "-q", "-am", "two"]);
  blob = git(repo, ["rev-parse", "HEAD:a.md"]);
  side = loose(repo, "side");
  git(repo, ["branch", "side", side]);
  kept = loose(repo, "kept");
  git(repo, ["tag", "-a", `evidence/${kept.slice(0, 8)}`, "-m", "backs a number", kept]);
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a code span of 7 to 40 hex digits alone is a cited commit, with its line", () => {
  const text = "Last checked: 2026-11-04, on `a398ea95`;\n`efa7503b` against `2293663a`.\n";
  assert.deepEqual(cited(text), [
    { line: 1, sha: "a398ea95" },
    { line: 2, sha: "efa7503b" },
    { line: 2, sha: "2293663a" },
  ]);
  // Another repository's commit, too few digits, capitals, other characters and too many.
  const not = "`chase-sets/chase-sets@162ed0c298` `a398ea` `A398EA95` `0x398ea95` `a398ea95 x` `" + "a".repeat(41) + "`";
  assert.deepEqual(cited(not), []);
  // Corten's own commit written as a repository's is read, to be refused.
  assert.deepEqual(cited("`corten-run/corten@a398ea95`"), [{ line: 1, sha: "a398ea95", as: "corten-run/corten" }]);
});

test("a cited commit on HEAD's history or kept by an evidence tag passes, by any length of its name", () => {
  const found = [
    { at: "docs/a.md:1", sha: first.slice(0, 8) },
    { at: "docs/a.md:2", sha: first },
    { at: "docs/a.md:3", sha: kept.slice(0, 7) },
  ];
  assert.deepEqual(unresolved(repo, found), []);
});

test("a cited commit not on HEAD's history or an evidence tag fails, though the clone may have it", () => {
  const found = unresolved(repo, [
    { at: "docs/a.md:1", sha: first.slice(0, 8) },
    { at: "docs/design.md:1013", sha: lacking.slice(0, 8) },
    { at: "docs/a.md:5", sha: side.slice(0, 8) },
    { at: "README.md:7", sha: blob.slice(0, 10) },
  ]);
  assert.deepEqual(found.slice(0, 3), [
    "docs/design.md:1013: `7cea4970` is not a commit on HEAD's history or under refs/tags/evidence/",
    `docs/a.md:5: \`${side.slice(0, 8)}\` is not a commit on HEAD's history or under refs/tags/evidence/`,
    `README.md:7: \`${blob.slice(0, 10)}\` is not a commit on HEAD's history or under refs/tags/evidence/`,
  ]);
  assert.equal(found.length, 4);
  assert.match(found[3], /git fetch https:\/\/github\.com\/corten-run\/corten\.git "\+refs\/tags\/evidence\/\*:refs\/tags\/evidence\/\*"/);
  assert.match(found[3], /without backticks/);
});

test("Corten's own commit written as a repository's fails, saying to write it alone", () => {
  assert.deepEqual(unresolved(repo, [{ at: "docs/a.md:2", sha: first.slice(0, 8), as: "corten-run/corten" }]), [
    `docs/a.md:2: \`corten-run/corten@${first.slice(0, 8)}\` names Corten's own commit; write it as \`${first.slice(0, 8)}\`, so it is checked`,
  ]);
});

test("a shallow clone fails once, saying to fetch the whole history and the evidence tags", () => {
  const shallow = join(dir, "shallow");
  git(dir, ["clone", "-q", "--depth", "1", pathToFileURL(repo).href, shallow]);
  const found = unresolved(shallow, [
    { at: "docs/a.md:1", sha: first.slice(0, 8) },
    { at: "docs/a.md:2", sha: lacking.slice(0, 8) },
  ]);
  assert.equal(found.length, 1);
  assert.match(found[0], /shallow.*git fetch --unshallow https:\/\/github\.com\/corten-run\/corten\.git "\+refs\/tags\/evidence\/\*:refs\/tags\/evidence\/\*"/);
});
