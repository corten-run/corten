import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFailedCheck } from "./check-result.mjs";

test("a missing, malformed or rejected failed-check receipt never masks the original checker failure", () => {
  const folder = mkdtempSync(join(tmpdir(), "catalog-check-result-"));
  const file = join(folder, "checks.json.failure.json");
  try {
    for (const original of [new Error("desktop-light js=false record_1: article styles at 0"),
      Object.assign(new Error("checker timeout after 900000 ms"), { exit: { expired: true } })]) {
      for (const artifact of [null, "not json", "{}"]) {
        rmSync(file, { force: true });
        if (artifact !== null) writeFileSync(file, artifact);
        let verified = false;
        assert.throws(() => readFailedCheck(file, original, () => { verified = true; throw new Error("invalid negative boundary"); }), (error) => {
          assert.equal(error.cause, original);
          assert.ok(error.message.startsWith(original.message));
          assert.match(error.message, /Failed-check evidence unavailable or invalid/);
          return true;
        });
        assert.equal(verified, artifact === "{}");
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("negative receipts still require verification before they can be returned", () => {
  const folder = mkdtempSync(join(tmpdir(), "catalog-check-result-"));
  const file = join(folder, "checks.json.failure.json");
  try {
    const failure = { source: "fixture", requests: [] };
    writeFileSync(file, JSON.stringify(failure));
    let verified = false;
    assert.deepEqual(readFailedCheck(file, new Error("checker exited 1"), (value) => {
      assert.deepEqual(value, failure); verified = true;
    }), { failure });
    assert.equal(verified, true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
