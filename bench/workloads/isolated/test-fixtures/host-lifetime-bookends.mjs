// Keep two actual members stable while the observer tests snapshot bookends.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const gate = process.argv[2];
assert.ok(gate);
const child = spawn(process.execPath, ["-e", "process.on('message', () => process.exit(0)); process.send('ready');"], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
const closed = once(child, "close");
try {
  await once(child, "message"); console.log(`BOOKENDS_READY ${process.pid} ${child.pid}`);
  const deadline = Date.now() + 5000;
  while (!existsSync(gate)) { assert.ok(Date.now() < deadline, "observer fixture gate did not open"); await setTimeout(10); }
  child.send("finish"); assert.deepEqual(await closed, [0, null]);
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await closed; }
}
