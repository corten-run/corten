import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inside } from "./evidence.mjs";
import { fixtureGitEnv } from "../../../scripts/fixture-git.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
for (const phase of ["ownership", "validation", "unsafe", "unsupported"]) test(`fake native worker ${phase} in a disposable clean checkout`, { timeout: 600000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-worker-test-")), checkout = join(temporary, "repo");
  const git = (args) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    // A shared clone of HEAD, not a linked worktree, so the repository under test gets no worktree metadata. The clone
    // reads the absolute common Git directory, which works whether or not the caller reaches it through GIT_DIR.
    const source = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    execFileSync("git", ["clone", "--shared", "--no-checkout", "--no-hardlinks", source, checkout],
      { cwd: temporary, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv() });
    execFileSync("git", ["checkout", "--detach", git(["rev-parse", "HEAD"])], { cwd: checkout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv() });
    cpSync(join(repo, "node_modules/semver"), join(checkout, "node_modules/semver"), { recursive: true, errorOnExist: true, force: false });
    assert.equal(JSON.parse(readFileSync(join(checkout, "node_modules/semver/package.json"), "utf8")).version,
      JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).devDependencies.semver, "fixture semver must match the committed pin");
    let output = "";
    const child = spawn(process.execPath, [join(checkout, "bench/workloads/isolated/test-fixtures/worker.mjs"), phase], {
      cwd: checkout, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, env: fixtureGitEnv(),
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 540000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    let code;
    try { code = await new Promise((ok, fail) => { child.once("error", fail); child.once("close", ok); }); }
    finally { clearTimeout(timeout); }
    assert.equal(code, 0, output); assert.ok(output.includes(`WORKER_PROBE_PASS:${phase}`), output);
  } finally {
    assert.ok(inside(resolve(tmpdir()), resolve(temporary))); assert.equal(realpathSync(temporary), resolve(temporary));
    rmSync(temporary, { recursive: true, force: true });
  }
});
