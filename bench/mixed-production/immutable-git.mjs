import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

// A child process, rather than process.env mutation: concurrent Docker/tooling
// commands must not inherit Git credentials, replacement refs or lazy fetching.
export function immutableGit(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  const answer = spawnSync("git", ["--no-replace-objects", "--no-lazy-fetch", "-c", "protocol.allow=never",
    "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args], {
    cwd, env, windowsHide: true, encoding: null, maxBuffer: 8 * 1024 ** 2, timeout: 60000,
  });
  assert.ok(!answer.error && answer.status === 0, "immutable local Git evidence unavailable");
  return answer.stdout;
}

export function withImmutableGit(io, cwd) {
  return { get interrupted() { return io.interrupted; }, dispose: () => io.dispose(),
    command: (binary, args, options) => binary === "git"
      ? io.command(process.execPath, [fileURLToPath(import.meta.url), "--", cwd, ...args], options)
      : io.command(binary, args, options) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv[2], "--");
    process.stdout.write(immutableGit(process.argv[3], process.argv.slice(4)));
  } catch { process.stderr.write("immutable local Git evidence unavailable\n"); process.exitCode = 1; }
}
