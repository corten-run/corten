import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { measuredCheckout as measured } from "./group-continuation.mjs";
import { fixtureGitEnv, withFixtureGitEnv } from "../../scripts/fixture-git.mjs";

// measuredCheckout runs Git on the process's environment, so it reads the fixture only without the caller's selectors.
const measuredCheckout = (/** @type {string} */ root, /** @type {string} */ saved, /** @type {string} */ commit) =>
  withFixtureGitEnv(() => measured(root, saved, commit));

test("a retained group at X finds its original checkout after the operator checkout advances to Y", (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "group-checkouts-"))), repo = join(temp, "repo"), root = join(temp, "results");
  t.after(() => { assert.equal(dirname(temp), realpathSync(tmpdir())); rmSync(temp, { recursive: true }); });
  mkdirSync(repo); mkdirSync(root); mkdirSync(`${root}-checkouts`);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv() }).trim();
  const commit = (source) => {
    writeFileSync(join(repo, "input.txt"), source); git("add", "input.txt"); git("commit", "-m", source); return git("rev-parse", "HEAD");
  };
  git("init");
  const x = commit("group B source");
  assert.equal(measuredCheckout(root, repo, x), repo);
  const y = commit("group C source");
  assert.throws(() => measuredCheckout(root, repo, x), /original measured checkout/);
  git("worktree", "add", "--detach", join(`${root}-checkouts`, x), x);
  assert.deepEqual([measuredCheckout(root, repo, x), measuredCheckout(root, repo, y)], [join(`${root}-checkouts`, x), repo]);
  git("worktree", "add", "--detach", join(`${root}-checkouts`, y), x);
  assert.throws(() => measuredCheckout(root, repo, y), /original measured checkout/, "a wrongly pinned checkout must not fall back silently");
});
