// The environment for Git that works on a repository a test makes for itself. GIT_DIR,
// GIT_WORK_TREE and the variables below choose the repository and its config ahead of the working
// directory and `-C`, so a fixture Git command that inherits them from its caller (a container that
// mounts a linked worktree sets GIT_DIR and GIT_WORK_TREE) acts on the caller's repository instead:
// `git init` rewrites its config. GIT_SHALLOW_FILE, GIT_GRAFT_FILE and GIT_REPLACE_REF_BASE name
// the shallow list, grafts and replacement refs Git reads and writes in place of the repository's
// own (an inherited shallow file makes a shallow clone fail), and Git sets GIT_IMPLICIT_WORK_TREE
// for its own children beside GIT_DIR; with the above they are what `git rev-parse --local-env-vars`
// lists. GIT_NO_REPLACE_OBJECTS stays, since it is a switch that
// names no file or ref, and GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM stay, since they choose a user
// or system file rather than a repository. A test that means to set one of these passes it in
// `overrides`.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const selecting = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_PREFIX",
  "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
]);

/** Whether a variable chooses Git's repository or adds to its config; Windows names ignore case. @param {string} name */
function selectsRepository(name) {
  const upper = name.toUpperCase();
  return selecting.has(upper) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper);
}

/**
 * `base` without the variables that choose a repository, then `overrides`. On Windows, where a
 * variable's name ignores case, an override also replaces a base variable spelled differently.
 * @param {Record<string, string>} [overrides]
 * @param {NodeJS.ProcessEnv} [base]
 * @param {NodeJS.Platform} [platform]
 * @returns {NodeJS.ProcessEnv}
 */
export function fixtureGitEnv(overrides = {}, base = process.env, platform = process.platform) {
  const fold = (/** @type {string} */ name) => (platform === "win32" ? name.toUpperCase() : name);
  const replaced = new Set(Object.keys(overrides).map(fold));
  const kept = Object.entries(base).filter(([name]) => !selectsRepository(name) && !replaced.has(fold(name)));
  return { ...Object.fromEntries(kept), ...overrides };
}

/**
 * Runs `run` with the variables that choose a repository taken out of `process.env`, and puts them
 * back when it returns or, for a promise, settles. For a fixture that hands its repository to code
 * that runs Git on the environment of the process, such as Evidence.source() in
 * bench/client-heavy/evidence.mjs; that code is left as it is. The process environment is shared, so
 * use this only where nothing else runs Git meanwhile, as in a test.
 * @template T @param {() => T} run @returns {T}
 */
export function withFixtureGitEnv(run) {
  const taken = Object.entries(process.env).filter(([name]) => selectsRepository(name));
  for (const [name] of taken) delete process.env[name];
  const restore = () => { for (const [name, value] of taken) process.env[name] = value; };
  let result;
  try { result = run(); } catch (error) { restore(); throw error; }
  if (result instanceof Promise) return /** @type {T} */ (result.finally(restore));
  restore();
  return result;
}

/**
 * @typedef {{ readonly interrupted: boolean, dispose(): void,
 *   command(binary: string, args: string[], options?: Record<string, unknown>): Promise<any> }} Commands
 */

/**
 * `io` (a `commands()` runner from bench/json-api/process.mjs) with its `git` commands run on
 * `fixtureGitEnv()`, for a fixture that hands its repository to code that runs Git through `io`, such
 * as `git archive` in bench/mixed-production/build-context.mjs. Every other command is passed to `io`
 * unchanged. Outside Windows `io` runs `env -u <selector>... git`, which replaces itself with Git, so
 * `io` signals, escalates and reports on Git itself. Windows has no `env`, so there `io` runs Git
 * through this file, whose tree `io` ends with taskkill /T /F.
 * @param {Commands} io
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [base] the environment `io` passes to its commands
 * @returns {Commands}
 */
export function fixtureGitCommands(io, platform = process.platform, base = process.env) {
  const git = (/** @type {string[]} */ args) => platform === "win32"
    ? [process.execPath, [fileURLToPath(import.meta.url), "--", ...args]]
    : ["env", [...Object.keys(base).filter(selectsRepository).flatMap((name) => ["-u", name]), "git", ...args]];
  return {
    get interrupted() { return io.interrupted; },
    dispose: () => io.dispose(),
    command: (binary, args, options) => {
      if (binary !== "git") return io.command(binary, args, options);
      const [hop, hopArgs] = git(args);
      return io.command(/** @type {string} */ (hop), /** @type {string[]} */ (hopArgs), options);
    },
  };
}

// `node fixture-git.mjs -- <git arguments>`: Git on fixtureGitEnv(), with this process's working
// directory and streams. INT, TERM and HUP are passed on to Git, and this process stays until Git
// ends, so a runner that sends KILL only while its child lives still reaches Git; it then exits as
// Git did, by the same signal or with the same status.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--") {
    process.stderr.write("usage: node fixture-git.mjs -- <git arguments>\n");
    process.exitCode = 2;
  } else {
    const signals = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
    const git = spawn("git", process.argv.slice(3), { env: fixtureGitEnv(), stdio: "inherit", windowsHide: true });
    const pass = (/** @type {NodeJS.Signals} */ signal) => { if (git.exitCode === null && git.signalCode === null) git.kill(signal); };
    const stop = () => { for (const signal of signals) process.off(signal, pass); };
    for (const signal of signals) process.on(signal, pass);
    git.once("error", (error) => { stop(); process.stderr.write(`git: ${error.message}\n`); process.exitCode = 1; });
    git.once("exit", (code, signal) => {
      stop();
      if (signal) process.kill(process.pid, signal);
      process.exitCode = code ?? 1;
    });
  }
}
