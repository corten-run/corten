// Real process/resource ownership probe, not benchmark qualification.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

if (import.meta.url !== pathToFileURL(process.argv[1]).href) throw new Error("native CLI guard was not preserved");
const mode = process.argv[2];
if (mode === "throw") throw new Error("NATIVE_FAILURE");
if (mode === "exit") {
  console.log(JSON.stringify(process.argv.slice(2)));
  process.exitCode = Number(process.argv[3]);
} else if (mode === "no-handler") {
  console.log("STARTING_NO_HANDLER");
  await setTimeout(100);
} else {
  const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const closed = once(child, "close");
  await once(child, "spawn");
  let finish;
  const cancelled = new Promise((resolve) => { finish = resolve; });
  const interrupt = () => { console.log("HANDLED SIGINT"); finish(); };
  const terminate = () => { console.log("HANDLED SIGTERM"); finish(); };
  try {
    if (mode === "late-handler") {
      console.log(`STARTING ${process.pid} ${child.pid}`);
      await setTimeout(100);
    }
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    console.log(`READY ${process.pid} ${child.pid}`);
    if (mode === "error-after-ready") throw new Error("NATIVE_FAILURE");
    await cancelled;
  } finally {
    child.kill("SIGKILL");
    await closed;
    console.log("CLEANUP_EXECUTED");
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  }
}
