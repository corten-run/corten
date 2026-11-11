import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cited, unresolved } from "./design-refs.mjs";

const dir = mkdtempSync(join(tmpdir(), "design-refs-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
// A clone with two commits, so a clone of its last one alone is shallow.
const repo = join(dir, "repo");
git(dir, ["init", "-q", repo]);
writeFileSync(join(repo, "a.md"), "one\n");
git(repo, ["add", "a.md"]);
git(repo, ["commit", "-q", "-m", "one"]);
const first = git(repo, ["rev-parse", "HEAD"]);
writeFileSync(join(repo, "a.md"), "two\n");
git(repo, ["commit", "-q", "-am", "two"]);
const blob = git(repo, ["rev-parse", "HEAD:a.md"]);
// A commit of another clone, which this one lacks.
const lacking = "7cea497078ee016952f6c8d02bb00e06144baf04";

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
});

test("a cited commit the clone has passes, by any length of its name", () => {
  assert.deepEqual(unresolved(repo, [{ at: "docs/a.md:1", sha: first.slice(0, 8) }, { at: "docs/a.md:2", sha: first }]), []);
});

test("a cited commit the clone lacks fails, naming the file, the line and the commit, then how to fetch it", () => {
  const found = unresolved(repo, [
    { at: "docs/a.md:1", sha: first.slice(0, 8) },
    { at: "docs/design.md:1013", sha: lacking.slice(0, 8) },
    { at: "README.md:7", sha: blob.slice(0, 10) },
  ]);
  assert.deepEqual(found.slice(0, 2), [
    "docs/design.md:1013: `7cea4970` is not a commit this clone has",
    `README.md:7: \`${blob.slice(0, 10)}\` is not a commit this clone has`,
  ]);
  assert.equal(found.length, 3);
  assert.match(found[2], /refs\/tags\/evidence/);
});

test("a shallow clone fails once, saying to fetch the whole history and the evidence tags", () => {
  const shallow = join(dir, "shallow");
  git(dir, ["clone", "-q", "--depth", "1", pathToFileURL(repo).href, shallow]);
  const found = unresolved(shallow, [
    { at: "docs/a.md:1", sha: first.slice(0, 8) },
    { at: "docs/a.md:2", sha: lacking.slice(0, 8) },
  ]);
  assert.equal(found.length, 1);
  assert.match(found[0], /shallow.*git fetch --unshallow origin "\+refs\/tags\/evidence\/\*:refs\/tags\/evidence\/\*"/);
});
