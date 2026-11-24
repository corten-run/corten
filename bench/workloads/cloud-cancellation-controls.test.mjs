import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function emitted(future = false) {
  const run = spawnSync(process.execPath, ["--max-old-space-size=256", fileURLToPath(new URL("./test-fixtures/mixed-controls-programs.mjs", import.meta.url)),
    ...(future ? ["--future-template"] : [])], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr); return JSON.parse(run.stdout);
}
const hashes = (files) => Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]));
test("cancellation and custody bind original uploaded controls, not current launch bytes", () => {
  const value = emitted(), expected = hashes(value.original.files);
  const config = JSON.parse(JSON.parse(value.cancelProgram.split("\n")[1].slice("c = json.loads(".length, -1)));
  assert.equal(expected["job.sh"], "ffcf390ccec8caac47a90c1a54bb3ca58166ac1c30e8cbfeb22ae2fd38adb181");
  assert.deepEqual(config.files, expected);
  assert.ok(value.custodyScript.includes(`"files":${JSON.stringify(expected)}`));
  assert.notEqual(hashes(value.current)["job.sh"], expected["job.sh"]);
});
test("later launch-template changes cannot change either historical caller/callee", () => {
  const current = emitted(), future = emitted(true);
  for (const key of ["cancelProgram", "cancelScript", "custodyScript"]) assert.equal(future[key], current[key]);
});
test("Linux production control-byte boundary accepts only original files", { skip: process.env.CORTEN_SYNTHETIC_CONTROL_BOUNDARY !== "1" }, () => {
  assert.equal(process.platform, "linux");
  const run = spawnSync("/usr/bin/python3", [fileURLToPath(new URL("./test-fixtures/mixed-controls-boundary.py", import.meta.url))],
    { input: JSON.stringify(emitted()), encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const rows = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 18);
  assert.equal(rows.filter((row) => row.acceptedOriginal).length, 2);
  assert.ok(rows.every((row) => row.noRemoteIntent && row.noSignal && row.noCapture));
  console.log(run.stdout.trim());
});

// This setup check needs Python 3, so it runs only under the boundary's opt-in above or
// CORTEN_REQUIRE_PYTHON=1, which hosted CI sets where Python 3 is guaranteed, and then fails rather than
// skips without Python (bench/workloads/CLOUD.md).
const requirePython = process.env.CORTEN_SYNTHETIC_CONTROL_BOUNDARY === "1" || process.env.CORTEN_REQUIRE_PYTHON === "1";
test("the control boundary makes its repository without touching a caller named by GIT_DIR and GIT_WORK_TREE",
  { skip: !requirePython && "needs Python 3: set CORTEN_REQUIRE_PYTHON=1" }, (t) => {
  // The setup the opt-in boundary runs before its controls, here under a scratch caller's selectors.
  const dir = mkdtempSync(join(tmpdir(), "mixed-controls-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caller = join(dir, "caller"), elsewhere = join(dir, "elsewhere"), repo = join(dir, "repo");
  for (const path of [caller, elsewhere]) mkdirSync(path);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: clean, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(caller, "init", "-q"); writeFileSync(join(caller, "caller.txt"), "caller\n"); git(caller, "add", "caller.txt");
  git(caller, "-c", "user.name=Caller", "-c", "user.email=caller@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "caller");
  const state = () => [readFileSync(join(caller, ".git", "config"), "utf8"), git(caller, "for-each-ref"), git(caller, "status", "--porcelain")];
  const before = state();
  const run = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-B", "-c",
    "import os, pathlib, sys; sys.path.insert(0, sys.argv[1]); import mixed_controls_repo as m; print(*m.make_repo(pathlib.Path(sys.argv[2]), m.fixture_env(os.environ)))",
    fileURLToPath(new URL("./test-fixtures/", import.meta.url)), repo],
    { env: { ...clean, GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: elsewhere }, encoding: "utf8", timeout: 30000 });
  assert.equal(run.error, undefined, `Python 3 is required here (CORTEN_REQUIRE_PYTHON or CORTEN_SYNTHETIC_CONTROL_BOUNDARY is set): ${run.error?.message}`);
  assert.deepEqual(state(), before, "the caller's config, refs and work tree are unchanged");
  assert.equal(run.status, 0, run.stderr);
  const [commit, tree] = run.stdout.trim().split(" ");
  assert.deepEqual([git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD^{tree}")], [commit, tree]);
  assert.equal(git(repo, "ls-files"), "sentinel");
});
