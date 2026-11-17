import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Execute the image's actual launcher with argv-recording stand-ins, without Docker
// or Python dependencies. Windows uses the POSIX shell supplied by Git.
let shell = "sh";
if (process.platform === "win32") {
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 5000 });
  assert.ifError(git.error);
  assert.equal(git.status, 0, git.stderr);
  shell = resolve(git.stdout.trim(), "../../../bin/sh.exe");
}
const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
const command = JSON.parse(dockerfile.split(/\r?\n/).find(line => line.startsWith("CMD ")).slice(4));
assert.deepEqual(command.slice(0, 2), ["sh", "-c"]);
assert.equal(command.length, 3);

test("catalog-lean changes only access logging in the native FastAPI launcher", async t => {
  const folder = await mkdtemp(join(tmpdir(), "fastapi-launcher-"));
  try {
    for (const name of ["uvicorn", "fastapi"]) {
      await writeFile(join(folder, name), `#!/bin/sh\nprintf '%s\\n' '${name}' "$@"\nprintf '%s\\n' 'native error output' >&2\nexit 23\n`, { mode: 0o755 });
    }
    for (const profile of [undefined, "", "defaults", "matched", "catalog-lean", "catalog-lean-extra", " catalog-lean", "CATALOG-LEAN"]) {
      for (const cap of ["", "17"]) {
        await t.test(`${JSON.stringify(profile)}/${cap || "no cap"}`, () => {
          const env = { ...process.env, MAX_CONNECTIONS: cap };
          if (profile === undefined) delete env.PROFILE;
          else env.PROFILE = profile;
          const result = spawnSync(shell, ["-c", `PATH="$PWD:$PATH"; export PATH; ${command[2]}`], {
            cwd: folder, env, encoding: "utf8", timeout: 5000,
          });
          assert.ifError(result.error);
          assert.equal(result.status, 23, result.stderr);
          assert.equal(result.stderr.trim(), "native error output", "native stderr is not suppressed");
          const expected = profile === "matched"
            ? ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", ...(cap ? ["--limit-concurrency", cap] : [])]
            : profile === "catalog-lean"
              ? ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
              : ["fastapi", "run", "app/main.py", "--host", "0.0.0.0", "--port", "8080"];
          assert.deepEqual(result.stdout.trim().split(/\r?\n/), expected,
            "only the exact lean profile disables access logs, without changing error logging, loop, parser or workers");
        });
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
