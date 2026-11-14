// Actual short-lived descendants, not a benchmark or saved-process authority.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

for (let i = 0; i < 8; i++) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 250)"], { stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await once(child, "spawn"); console.log(`CHURN ${child.pid}`);
    assert.deepEqual(await closed, [0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await closed; }
  }
}
