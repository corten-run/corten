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
 * The ambient environment without any `GIT_*` variable, whatever its case. Setup and the raw controls
 * run on this, not on the helper under test, so a broken helper cannot reach an outer caller's
 * repository before the assertions that detect it; the positive cases add only scratch selectors to it.
 * @returns {NodeJS.ProcessEnv}
 */
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));

/**
 * A scratch "caller" repository, an unrelated repository and config file that an inherited GIT_CONFIG
 * and GIT_COMMON_DIR point at, and the environments of a check run against them: `inherited` has
 * every scratch selector, `callerEnv` only the scratch caller's (the control runs with it unsanitized,
 * so it must not reach anything outside the scratch directory). Neither carries an ambient `GIT_*`.
 * @param {import("node:test").TestContext} t
 */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caller = join(dir, "caller"), elsewhere = join(dir, "caller-worktree"), fixture = join(dir, "fixture");
  const unrelated = join(dir, "unrelated"), unrelatedConfig = join(dir, "unrelated.gitconfig");
  for (const path of [caller, elsewhere, fixture, unrelated]) mkdirSync(path);
  for (const path of [caller, unrelated]) {
    const own = { cwd: path, env: clean(), stdio: /** @type {const} */ ("ignore") };
    execFileSync("git", ["init", "-q"], own);
    // Not what a fresh init writes on Linux, so a re-init that probes the file system changes it.
    execFileSync("git", ["config", "core.filemode", "false"], own);
  }
  writeFileSync(unrelatedConfig, "[user]\n\temail = unrelated@example.invalid\n");
  const selectors = { GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: elsewhere, GIT_INDEX_FILE: join(caller, ".git", "index"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Caller" };
  const inherited = { ...clean(), GIT_CONFIG: unrelatedConfig, GIT_COMMON_DIR: join(unrelated, ".git"), ...selectors };
  const callerEnv = { ...clean(), ...selectors };
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
  runner(s.dir, clean())("init", "-q", source);
  const commit = runner(source, { ...clean(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
  // Two commits, so a clone of the last one alone is shallow.
  for (const text of ["one\n", "two\n"]) {
    writeFileSync(join(source, "a.txt"), text);
    commit("add", "a.txt"); commit("-c", "commit.gpgsign=false", "commit", "-qm", text.trim());
  }
  const git = runner(s.dir, fixtureGitEnv({}, { ...s.inherited, GIT_SHALLOW_FILE: shallow }));
  git("clone", "-q", "--depth", "1", pathToFileURL(source).href, clone);
  assert.equal(readFileSync(join(clone, ".git", "shallow"), "utf8").trim(), runner(clone, clean())("rev-parse", "HEAD"));
  assert.equal(readFileSync(shallow, "utf8"), "");
});

/**
 * Runs `file`'s tests (those matching `patterns`, or all) in a child whose own environment selects a
 * scratch caller with a commit of its own, so a fixture read that fell back to the inherited selectors
 * would read that history rather than the fixture's and fail. Asserts every selected test passed, the
 * fixture's setup ran Git (`commands`, recorded by GIT_TRACE2, which is not a selector) and every
 * scratch config is byte for byte unchanged.
 * @param {import("node:test").TestContext} t @param {string} file @param {number} count
 * @param {string[]} commands @param {string[]} [patterns]
 */
function nested(t, file, count, commands, patterns = []) {
  const s = scratch(t), here = fileURLToPath(new URL(".", import.meta.url)), trace = join(s.dir, "trace2.txt");
  writeFileSync(join(s.caller, "caller.txt"), "caller\n");
  const own = runner(s.caller, clean());
  own("add", "caller.txt");
  own("-c", "user.name=Caller", "-c", "user.email=caller@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "caller");
  const before = s.files();
  const env = { ...s.callerEnv, GIT_TRACE2: trace };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...patterns.map((p) => `--test-name-pattern=${p}`), join(here, file)],
    { cwd: here, env, encoding: "utf8", windowsHide: true, timeout: 300000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const line of [`# tests ${count}`, `# pass ${count}`, "# fail 0", "# cancelled 0"]) assert.match(run.stdout, new RegExp(`^${line}$`, "m"));
  assert.ok(existsSync(trace), "the fixture's setup must have run Git");
  const ran = new Set([...readFileSync(trace, "utf8").matchAll(/\bcmd_name (\S+)/g)].map(([, name]) => name));
  for (const name of commands) assert.ok(ran.has(name), `the fixture's setup must have run git ${name}`);
  assert.deepEqual(s.files(), before);
}

test("every design-refs test, run under a caller's GIT_DIR, reads its own fixture and leaves the caller alone", (t) => {
  // Its before hook makes, commits to and tags its repository; four of its six tests read that repository.
  nested(t, "design-refs.test.mjs", 6, ["init", "commit", "tag", "rev-list"]);
});

test("benchmark-scope's fixture tests, run under a caller's GIT_DIR, read their own fixtures and leave the caller alone", (t) => {
  // The four tests that make a repository, diff it in process and run the scope script on it; the
  // others read the checkout under test, which that GIT_DIR replaces on purpose.
  nested(t, "benchmark-scope.test.mjs", 4, ["init", "commit", "merge", "diff"],
    ["^PR diff excludes base-only changes", "^a base-side rename scopes", "^a push to main scopes Catalog", "^PR and multi-commit push diffs"]);
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
