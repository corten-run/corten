// A fixture's Git leaves the repository running the checks alone, even when the caller sets
// GIT_DIR and GIT_WORK_TREE, as a container that mounts a linked worktree does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureGitEnv } from "./fixture-git.mjs";

/** A scratch "caller" repository and the environment of a check run against it. @param {import("node:test").TestContext} t */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caller = join(dir, "caller"), elsewhere = join(dir, "caller-worktree"), fixture = join(dir, "fixture");
  for (const path of [caller, elsewhere, fixture]) mkdirSync(path);
  const own = { cwd: caller, env: fixtureGitEnv(), stdio: /** @type {const} */ ("ignore") };
  execFileSync("git", ["init", "-q"], own);
  // Not what a fresh init writes on Linux, so a re-init that probes the file system changes it.
  execFileSync("git", ["config", "core.filemode", "false"], own);
  const callerEnv = { ...process.env, GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: elsewhere,
    GIT_INDEX_FILE: join(caller, ".git", "index"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Caller" };
  return { caller, fixture, callerEnv, config: () => readFileSync(join(caller, ".git", "config")) };
}

/** @param {string} cwd @param {NodeJS.ProcessEnv} env */
const runner = (cwd, env) => (/** @type {string[]} */ ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("a fixture's init, config, add and commit leave the caller's repository byte for byte", (t) => {
  const s = scratch(t), before = s.config();
  const git = runner(s.fixture, fixtureGitEnv({}, s.callerEnv));
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(s.fixture, "a.txt"), "fixture\n"); git("add", "a.txt"); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  assert.deepEqual(s.config(), before);
  assert.equal(existsSync(join(s.caller, ".git", "index")), false);
  assert.deepEqual(readdirSync(join(s.caller, ".git", "refs", "heads")), []);
  assert.equal(git("log", "-1", "--format=%an"), "Fixture");
  assert.match(readFileSync(join(s.fixture, ".git", "config"), "utf8"), /name = Fixture/);
});

test("the same setup with the caller's environment rewrites the caller's config", (t) => {
  const s = scratch(t), before = s.config(), git = runner(s.fixture, s.callerEnv);
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid");
  assert.notDeepEqual(s.config(), before, "the control must show the damage the helper prevents");
  assert.match(s.config().toString(), /worktree = .*caller-worktree/);
});

test("every variable that chooses a repository or adds config goes, whatever its case, and overrides win", () => {
  const removed = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_PREFIX", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_12", "GIT_CONFIG_VALUE_12", "git_dir", "Git_Work_Tree"];
  const kept = { PATH: "/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_KEY: "not numbered" };
  const env = fixtureGitEnv({ GIT_DIR: "/explicit/.git" }, { ...Object.fromEntries(removed.map((name) => [name, "inherited"])), ...kept });
  assert.deepEqual(env, { ...kept, GIT_DIR: "/explicit/.git" });
});
