import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// The host opens each gate after observing the probe's real Linux process.
// This preload runs before the probe's clock and again after its event loop drains.
async function waitForHost(stage) {
  const deadline = performance.now() + 6000;
  while (!existsSync(`/results/.cpu-${stage}`)) {
    if (performance.now() >= deadline) throw new Error(`CPU boundary gate: ${stage} not acknowledged`);
    await sleep(15);
  }
}

await waitForHost("enter");
process.once("beforeExit", async () => {
  writeFileSync("/results/.cpu-drained", "", { flag: "wx" });
  await waitForHost("leave");
});
