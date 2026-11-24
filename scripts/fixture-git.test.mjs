// A fixture's Git leaves the repository running the checks alone, even when the caller sets
// GIT_DIR and GIT_WORK_TREE, as a container that mounts a linked worktree does.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { fixtureGitEnv } from "./fixture-git.mjs";

/**
 * A scratch "caller" repository, an unrelated repository and config file that an inherited GIT_CONFIG
 * and GIT_COMMON_DIR point at, and the environments of a check run against them: `inherited` has
 * every variable, `callerEnv` only the scratch caller's (the control runs with it unsanitized, so it
 * must not reach anything outside the scratch directory).
 * @param {import("node:test").TestContext} t
 */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caller = join(dir, "caller"), elsewhere = join(dir, "caller-worktree"), fixture = join(dir, "fixture");
  const unrelated = join(dir, "unrelated"), unrelatedConfig = join(dir, "unrelated.gitconfig");
  for (const path of [caller, elsewhere, fixture, unrelated]) mkdirSync(path);
  for (const path of [caller, unrelated]) {
    const own = { cwd: path, env: fixtureGitEnv(), stdio: /** @type {const} */ ("ignore") };
    execFileSync("git", ["init", "-q"], own);
    // Not what a fresh init writes on Linux, so a re-init that probes the file system changes it.
    execFileSync("git", ["config", "core.filemode", "false"], own);
  }
  writeFileSync(unrelatedConfig, "[user]\n\temail = unrelated@example.invalid\n");
  const selectors = { GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: elsewhere, GIT_INDEX_FILE: join(caller, ".git", "index"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Caller" };
  const inherited = { ...process.env, GIT_CONFIG: unrelatedConfig, GIT_COMMON_DIR: join(unrelated, ".git"), ...selectors };
  const callerEnv = fixtureGitEnv(selectors);
  const files = () => [join(caller, ".git", "config"), join(unrelated, ".git", "config"), unrelatedConfig].map((path) => readFileSync(path));
  return { dir, caller, fixture, inherited, callerEnv, config: () => readFileSync(join(caller, ".git", "config")),
    unrelated: () => files().slice(1), files };
}

/** @param {string} cwd @param {NodeJS.ProcessEnv} env */
const runner = (cwd, env) => (/** @type {string[]} */ ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("a fixture's init, config, add and commit leave the caller's repository byte for byte", (t) => {
  const s = scratch(t), before = s.files();
  const git = runner(s.fixture, fixtureGitEnv({}, s.inherited));
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(s.fixture, "a.txt"), "fixture\n"); git("add", "a.txt"); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  assert.deepEqual(s.files(), before);
  assert.equal(existsSync(join(s.caller, ".git", "index")), false);
  assert.deepEqual(readdirSync(join(s.caller, ".git", "refs", "heads")), []);
  assert.equal(git("log", "-1", "--format=%an"), "Fixture");
  assert.match(readFileSync(join(s.fixture, ".git", "config"), "utf8"), /name = Fixture/);
});

test("the same setup with the caller's environment rewrites the caller's config and nothing else", (t) => {
  const s = scratch(t), before = s.config(), unrelated = s.unrelated(), git = runner(s.fixture, s.callerEnv);
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid");
  assert.notDeepEqual(s.config(), before, "the control must show the damage the helper prevents");
  assert.match(s.config().toString(), /worktree = .*caller-worktree/);
  assert.deepEqual(s.unrelated(), unrelated, "the control must not reach past the scratch caller");
});

test("a shallow clone ignores an inherited GIT_SHALLOW_FILE and leaves that file alone", (t) => {
  const s = scratch(t), source = join(s.dir, "source"), clone = join(s.dir, "clone"), shallow = join(s.dir, "other-shallow");
  writeFileSync(shallow, "");
  runner(s.dir, fixtureGitEnv())("init", "-q", source);
  const commit = runner(source, fixtureGitEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }));
  // Two commits, so a clone of the last one alone is shallow.
  for (const text of ["one\n", "two\n"]) {
    writeFileSync(join(source, "a.txt"), text);
    commit("add", "a.txt"); commit("-c", "commit.gpgsign=false", "commit", "-qm", text.trim());
  }
  const git = runner(s.dir, fixtureGitEnv({}, { ...s.inherited, GIT_SHALLOW_FILE: shallow }));
  git("clone", "-q", "--depth", "1", pathToFileURL(source).href, clone);
  assert.equal(readFileSync(join(clone, ".git", "shallow"), "utf8").trim(), runner(clone, fixtureGitEnv())("rev-parse", "HEAD"));
  assert.equal(readFileSync(shallow, "utf8"), "");
});

test("design-refs' fixture setup, run under a caller's GIT_DIR, leaves the caller's config byte for byte", (t) => {
  const s = scratch(t), before = s.files(), here = fileURLToPath(new URL(".", import.meta.url));
  const env = { ...s.callerEnv };
  delete env.NODE_TEST_CONTEXT;
  // Its before hook makes and commits to its repository; the one test it runs needs no Git.
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^a code span", join(here, "design-refs.test.mjs")],
    { cwd: here, env, encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /# pass 1\b/);
  assert.deepEqual(s.files(), before);
});

test("every variable that chooses a repository or adds config goes, whatever its case, and overrides win", () => {
  const removed = ["GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_PREFIX", "GIT_SHALLOW_FILE",
    "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_12", "GIT_CONFIG_VALUE_12", "git_dir", "Git_Work_Tree", "git_shallow_file"];
  const kept = { PATH: "/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_KEY: "not numbered" };
  const env = fixtureGitEnv({ GIT_DIR: "/explicit/.git" }, { ...Object.fromEntries(removed.map((name) => [name, "inherited"])), ...kept });
  assert.deepEqual(env, { ...kept, GIT_DIR: "/explicit/.git" });
});

test("on Windows an override replaces a base variable whose name differs only in case; elsewhere both stay", () => {
  const base = { PATH: "/bin", fixture_case: "base", OTHER_CASE: "base" };
  const overrides = { FIXTURE_CASE: "override", other_case: "override" };
  assert.deepEqual(fixtureGitEnv(overrides, base, "win32"), { PATH: "/bin", ...overrides });
  assert.deepEqual(fixtureGitEnv(overrides, base, "linux"), { ...base, ...overrides });
});
