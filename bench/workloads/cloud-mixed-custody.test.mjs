import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("mixed retirement checks captured payloads against the original subject, not merely repacked trees", () => {
  const run = spawnSync(process.execPath, ["--max-old-space-size=256", "--experimental-test-module-mocks", "--test",
    fileURLToPath(new URL("./test-fixtures/mixed-custody-controller.mjs", import.meta.url))],
  { encoding: "utf8", timeout: 60000, maxBuffer: 128 * 1024, windowsHide: true });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
