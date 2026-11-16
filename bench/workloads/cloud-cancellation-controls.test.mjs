import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
