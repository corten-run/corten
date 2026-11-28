// Run one command for job.sh on Linux. FD 3 reports our deadline apart from the command's
// output and exit status. As with timeout -k, the signals go to the command's process group.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { constants } from "node:os";

const [limit, grace, command, ...args] = process.argv.slice(2);
/** @param {NodeJS.Signals} signal */
function send(signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
  }
}

/** @type {NodeJS.Timeout | undefined} */
let force;
/** @param {NodeJS.Signals} signal */
function stop(signal) {
  send(signal);
  force ??= setTimeout(() => send("SIGKILL"), Number(grace) * 1000);
}
for (const signal of /** @type {const} */ (["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"])) {
  process.on(signal, () => {
    clearTimeout(deadline);
    stop(signal);
  });
}
const child = spawn(command, args, { detached: true, stdio: "inherit" });
let expired = false;
const deadline = setTimeout(() => {
  expired = true;
  writeSync(3, "deadline\n");
  stop("SIGTERM");
}, Number(limit) * 1000);
child.on("error", (error) => {
  clearTimeout(deadline);
  clearTimeout(force);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  clearTimeout(deadline);
  clearTimeout(force);
  process.exitCode = expired ? 124 : code ?? (signal === null ? 1 : 128 + constants.signals[signal]);
});
