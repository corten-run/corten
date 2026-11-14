import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inside } from "./evidence.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
for (const phase of ["ownership", "validation", "unsafe", "unsupported"]) test(`fake native worker ${phase} in a disposable clean checkout`, { timeout: 600000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "isolated-worker-test-")), checkout = join(temporary, "repo");
  const git = (args) => execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let added = false;
  try {
    git(["worktree", "add", "--detach", checkout, "HEAD"]); added = true;
    let output = "";
    const child = spawn(process.execPath, [join(checkout, "bench/workloads/isolated/test-fixtures/worker.mjs"), phase], {
      cwd: checkout, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 540000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    let code;
    try { code = await new Promise((ok, fail) => { child.once("error", fail); child.once("close", ok); }); }
    finally { clearTimeout(timeout); }
    assert.equal(code, 0, output); assert.ok(output.includes(`WORKER_PROBE_PASS:${phase}`), output);
  } finally {
    assert.ok(inside(resolve(tmpdir()), resolve(temporary))); assert.equal(realpathSync(temporary), resolve(temporary));
    if (added) git(["worktree", "remove", "--force", checkout]);
    rmSync(temporary, { recursive: true, force: true });
  }
});
