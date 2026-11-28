// A fixture's Git leaves the repository running the checks alone, even when the caller sets
// GIT_DIR and GIT_WORK_TREE, as a container that mounts a linked worktree does.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { commands } from "../bench/json-api/process.mjs";
import { fixtureGitCommands, fixtureGitEnv } from "./fixture-git.mjs";

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

test("Mixed Production's archive tests, run under a caller's GIT_DIR, archive their own fixtures and leave the caller alone", (t) => {
  // extractNativeSource and nativeBuildContext run `git archive` through the commands() runner the
  // tests give them, so the archive reads the fixture only if that runner's Git drops the selectors too.
  nested(t, "../bench/mixed-production/build-context.test.mjs", 3, ["init", "add", "commit", "archive"]);
});

test("the client-heavy collector's source test, run under a caller's GIT_DIR, reads its own fixture and leaves the caller alone", (t) => {
  // Evidence.source() runs Git on the environment of the process, so the test must hand it the fixture's.
  nested(t, "../bench/client-heavy/evidence.test.mjs", 1, ["init", "add", "commit", "rev-parse", "status", "ls-files"],
    ["^source before/after saves real bytes"]);
});

test("group continuation's checkout test, run under a caller's GIT_DIR, reads its own fixture and leaves the caller alone", (t) => {
  // measuredCheckout() runs Git on the environment of the process, as Evidence.source() does.
  nested(t, "../bench/workloads/group-continuation.test.mjs", 1, ["init", "add", "commit", "worktree", "rev-parse"],
    ["^a retained group at X finds its original checkout"]);
});

test("fixtureGitCommands passes other commands through and reports a failed fixture Git as a failure", async (t) => {
  /** @type {unknown[][]} */
  const calls = [];
  let disposed = 0, interrupted = false;
  const io = fixtureGitCommands({ get interrupted() { return interrupted; }, dispose: () => { disposed += 1; },
    command: async (binary, args, options) => { calls.push([binary, args, options]); return "ok"; } });
  const options = { timeout: 5000, cleanup: true }, args = ["-xf", "a.tar"];
  assert.equal(await io.command("tar", args, options), "ok");
  assert.deepEqual(calls, [["tar", args, options]]);
  assert.equal(/** @type {unknown[]} */ (calls[0])[2], options);
  interrupted = true; assert.equal(io.interrupted, true);
  io.dispose(); assert.equal(disposed, 1);
  // Elsewhere `env` drops the selectors and then replaces itself with Git, so `io` signals and waits on Git itself.
  const base = { PATH: "/bin", GIT_DIR: "/caller/.git", git_work_tree: "/caller", GIT_CONFIG_KEY_0: "user.name", GIT_TRACE2: "/trace" };
  await fixtureGitCommands(io, "linux", base).command("git", ["rev-parse", "HEAD"], options);
  assert.deepEqual(calls[1], ["env", ["-u", "GIT_DIR", "-u", "git_work_tree", "-u", "GIT_CONFIG_KEY_0", "git", "rev-parse", "HEAD"], options]);
  await fixtureGitCommands(io, "linux", { PATH: "/bin" }).command("git", ["status"], options);
  assert.deepEqual(calls[2], ["env", ["git", "status"], options]);
  // Windows has no `env`; taskkill /T /F ends the hop and its Git together.
  await fixtureGitCommands(io, "win32", base).command("git", ["rev-parse", "HEAD"], options);
  assert.deepEqual(calls[3], [process.execPath, [fileURLToPath(new URL("./fixture-git.mjs", import.meta.url)), "--", "rev-parse", "HEAD"], options]);

  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-commands-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = fixtureGitCommands(commands(dir));
  try {
    await real.command("git", ["init", "-q"]);
    assert.equal(await real.command("git", ["rev-parse", "--is-inside-work-tree"]), "true");
    await assert.rejects(real.command("git", ["rev-parse", "--verify", "--quiet", `${"0".repeat(40)}^{commit}`]),
      (/** @type {any} */ error) => error.exit?.code === 1);
  } finally { real.dispose(); }
});

const cli = fileURLToPath(new URL("./fixture-git.mjs", import.meta.url));
const posixOnly = { skip: process.platform === "win32" && "POSIX signals; on Windows the runner ends the whole tree with taskkill /T /F" };

/**
 * A directory holding a `git` stand-in that runs `body` with /bin/sh.
 * @param {import("node:test").TestContext} t @param {string} body
 */
function standIn(t, body) {
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-stand-in-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

/**
 * Calls `start` with `dir` first on PATH; the runner spawns synchronously, so its child sees that PATH.
 * @template T @param {string} dir @param {() => T} start @returns {T}
 */
function onPath(dir, start) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  try { return start(); } finally { process.env.PATH = saved; }
}

/** @param {Promise<unknown>} pending @returns {Promise<any>} */
const failure = (pending) => pending.then(() => assert.fail("the command must fail"), (error) => error);

/**
 * Resolves once `path` exists; a stand-in writes it when it is ready for a signal.
 * @param {string} path @param {string} what
 */
async function appears(path, what) {
  for (const began = performance.now(); !existsSync(path); await delay(20))
    if (performance.now() - began > 10000) assert.fail(`${what} never became ready`);
}

/**
 * A `git` stand-in that holds stdout and stderr and survives TERM, INT and HUP until KILL: it records
 * each in `received`, keeps running and writes `ready` once its traps are set.
 * @param {import("node:test").TestContext} t
 */
function termResistant(t) {
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-marks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ready = join(dir, "ready"), received = join(dir, "received");
  const bin = standIn(t, [
    ...["TERM", "INT", "HUP"].map((signal) => `trap 'echo ${signal} >> "${received}"' ${signal}`),
    `: > "${ready}"`, "echo held", "echo held >&2", "while :; do sleep 1; done",
  ].join("\n"));
  return { bin, ready, received: () => (existsSync(received) ? readFileSync(received, "utf8") : "") };
}

test("a fixture Git that ignores TERM and holds its pipes still ends on the runner's deadline and on interruption", posixOnly, async (t) => {
  // TERM goes to the group at the deadline or interruption, and KILL 2 s later while the watched child
  // lives. The stand-in records the TERM and carries on, so only that KILL ends it.
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-term-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  /** @type {[string, (io: import("./fixture-git.mjs").Commands, options: Record<string, unknown>) => Promise<unknown>][]} */
  const routes = [
    ["fixtureGitCommands", (io, options) => fixtureGitCommands(io).command("git", ["status"], options)],
    ["the fixture-git.mjs hop", (io, options) => io.command(process.execPath, [cli, "--", "status"], options)],
  ];
  for (const [route, start] of routes) {
    const io = commands(dir), deadline = termResistant(t);
    try {
      const began = performance.now();
      const error = await failure(onPath(deadline.bin, () => start(io, { timeout: 1500 })));
      const took = performance.now() - began;
      assert.ok(existsSync(deadline.ready), `${route}: the stand-in must have been ready before the deadline`);
      assert.deepEqual([error.exit?.expired, error.exit?.signal], [true, "SIGKILL"], `${route}: ${error.message}`);
      assert.match(deadline.received(), /^TERM$/m, `${route}: the stand-in must have received TERM and carried on`);
      assert.ok(took >= 3400 && took < 6000, `${route}: a 1.5 s deadline with KILL 2 s after TERM settled after ${Math.round(took)} ms`);
    } finally { io.dispose(); }

    const listening = new Set(process.listeners("SIGINT"));
    const stoppable = commands(dir), interrupt = process.listeners("SIGINT").find((listener) => !listening.has(listener));
    const interrupted = termResistant(t);
    try {
      assert.equal(typeof interrupt, "function");
      const pending = failure(onPath(interrupted.bin, () => start(stoppable, { timeout: 30000 })));
      await appears(interrupted.ready, `${route}: the stand-in`);
      const began = performance.now();
      /** @type {Function} */ (interrupt)();
      const error = await pending, took = performance.now() - began;
      assert.deepEqual([error.exit?.interrupted, error.exit?.signal], [true, "SIGKILL"], `${route}: ${error.message}`);
      assert.match(interrupted.received(), /^TERM$/m, `${route}: the stand-in must have received TERM and carried on`);
      assert.ok(took >= 1900 && took < 4000, `${route}: an interruption with KILL 2 s after TERM settled after ${Math.round(took)} ms`);
    } finally { stoppable.dispose(); }
  }
});

test("the fixture-git.mjs hop passes a TERM sent to it alone on to Git, then ends by it as Git did", posixOnly, async (t) => {
  // Git records the TERM, then ends by it. The signal goes to the hop's PID, not its group, so Git
  // receives it only if the hop passes it on.
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-forward-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ready = join(dir, "ready"), received = join(dir, "received");
  const bin = standIn(t, [
    `trap 'echo TERM >> "${received}"; kill $sleeper; trap - TERM; kill -TERM $$' TERM`,
    // Bounded on its own, so a hop that dropped the TERM leaves nothing running for long.
    "sleep 12 & sleeper=$!", `: > "${ready}"`, "wait $sleeper",
  ].join("\n"));
  const hop = onPath(bin, () => spawn(process.execPath, [cli, "--", "status"], { cwd: dir, detached: true, stdio: "ignore" }));
  const exited = once(hop, "exit");
  // The hop leads its own group. Only while it is still running does that group number name this
  // test's processes, so teardown signals the group then and never after the hop has exited; a
  // stand-in a hop left behind ends by its own bound.
  t.after(() => {
    if (hop.exitCode !== null || hop.signalCode !== null) return;
    try { process.kill(-(/** @type {number} */ (hop.pid)), "SIGKILL"); } catch { /* the group has ended */ }
  });
  const timer = new AbortController();
  t.after(() => timer.abort());
  await appears(ready, "the stand-in");
  hop.kill("SIGTERM");
  const ended = await Promise.race([exited, delay(10000, null, { signal: timer.signal }).catch(() => null)]);
  timer.abort();
  assert.equal(existsSync(received) ? readFileSync(received, "utf8") : "", "TERM\n", "the hop must pass TERM on to Git");
  assert.deepEqual(ended, [null, "SIGTERM"]);
});

test("a fixture Git ended by a signal is reported with that signal, not as exit 1", posixOnly, async (t) => {
  const bin = standIn(t, "kill -TERM $$");
  const dir = mkdtempSync(join(tmpdir(), "corten-fixture-git-signal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const io = fixtureGitCommands(commands(dir));
  try {
    const error = await failure(onPath(bin, () => io.command("git", ["status"])));
    assert.deepEqual([error.exit?.code, error.exit?.signal], [null, "SIGTERM"]);
  } finally { io.dispose(); }
  const hop = onPath(bin, () => spawnSync(process.execPath, [cli, "--", "status"], { cwd: dir, encoding: "utf8", timeout: 30000 }));
  assert.deepEqual([hop.error, hop.status, hop.signal], [undefined, null, "SIGTERM"]);
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
