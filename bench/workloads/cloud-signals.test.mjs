import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
test("real SIGTERM during production commands prevents every subsequent external effect", { skip: process.platform !== "linux", timeout: 60000 }, async (t) => {
  for (const scenario of ["fetch", "create", "upload", "install", "start", "final-unit", "final-ownership", "delete", "audit-upload"]) {
    await t.test(scenario, async () => {
      const { stdout, stderr } = await execute(process.execPath, [fileURLToPath(new URL("cloud-signals-fixture.mjs", import.meta.url)), scenario],
        { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024, env: {} });
      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.sent, true, "actual OS signal must be sent inside the fake command");
      assert.equal(result.code, 2, JSON.stringify(result));
      assert.equal(result.cancelObservedAtReturn, true, JSON.stringify(result));
      assert.equal(result.afterSignal, 0, JSON.stringify(result));
      assert.equal(result.starts, scenario === "start" ? 1 : 0);
      assert.equal(result.deletes, scenario === "delete" ? 1 : 0);
      assert.equal(result.delivered, 0); assert.equal(result.destroyed, false);
      assert.equal(result.operationLock, false, "settled local command must release its operation lock");
      if (scenario !== "fetch") assert.equal(result.createIntent, true);
      if (scenario === "create") assert.equal(result.state, "creating");
      if (scenario === "start") assert.equal(result.state, "starting");
      if (["final-unit", "final-ownership", "delete"].includes(scenario)) assert.equal(result.archive, true);
      assert.equal(result.deleteIntent, scenario === "delete");
      assert.equal(result.auditIntent, scenario === "audit-upload");
    });
  }
});
