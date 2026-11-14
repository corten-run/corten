// Reuse native IPC/signal delivery; add a watchdog that survives supervisor death.
import { limits } from "./process.mjs";

let stopping = false;
function boundShutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => {
    console.error("Isolated native shutdown deadline exceeded; cleanup is unverified, preserve reservation and evidence.");
    // The supervisor creates a new Linux process group for this bootstrap.
    if (process.platform === "linux") process.kill(-process.pid, "SIGKILL");
    else process.exit(143);
  }, limits.stopMs);
  timer.unref();
}
process.on("disconnect", boundShutdown);
process.on("message", (message) => { if (message?.type === "cancel") boundShutdown(); });
await import("../dispatcher-child.mjs");
