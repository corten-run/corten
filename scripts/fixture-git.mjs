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

import { spawnSync } from "node:child_process";
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
 * @typedef {{ readonly interrupted: boolean, dispose(): void,
 *   command(binary: string, args: string[], options?: Record<string, unknown>): Promise<any> }} Commands
 */

/**
 * `io` (a `commands()` runner from bench/json-api/process.mjs) with its `git` commands run on
 * `fixtureGitEnv()`, for a fixture that hands its repository to code that runs Git through `io`, such
 * as `git archive` in bench/mixed-production/build-context.mjs. Git goes through this file as a child
 * of `io`, so `io` keeps its deadline, interruption and output handling; every other command is
 * passed to `io` unchanged.
 * @param {Commands} io
 * @returns {Commands}
 */
export function fixtureGitCommands(io) {
  return {
    get interrupted() { return io.interrupted; },
    dispose: () => io.dispose(),
    command: (binary, args, options) => binary === "git"
      ? io.command(process.execPath, [fileURLToPath(import.meta.url), "--", ...args], options)
      : io.command(binary, args, options),
  };
}

// `node fixture-git.mjs -- <git arguments>`: Git on fixtureGitEnv(), with this process's working
// directory and streams, exiting with Git's status.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--") {
    process.stderr.write("usage: node fixture-git.mjs -- <git arguments>\n");
    process.exitCode = 2;
  } else {
    const git = spawnSync("git", process.argv.slice(3), { env: fixtureGitEnv(), stdio: "inherit", windowsHide: true });
    if (git.error) process.stderr.write(`git: ${git.error.message}\n`);
    process.exitCode = git.status ?? 1;
  }
}
