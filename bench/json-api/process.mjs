import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export function commands(cwd) {
  const children = new Set(); let interrupted = false;
  const kill = (child) => {
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { cwd, windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill("SIGKILL"));
    } else if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      else child.kill("SIGKILL");
    } }, 2000); timer.unref();
  };
  const interrupt = () => { interrupted = true; for (const child of children) kill(child); };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
  return {
    get interrupted() { return interrupted; },
    dispose() { for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt); },
    async command(binary, args, { timeout = 30000, file, cleanup = false, input } = {}) {
      if (interrupted && !cleanup) throw new Error("JSON run interrupted");
      if (input !== undefined && !Buffer.isBuffer(input)) throw new TypeError("command input must be a Buffer");
      const child = spawn(binary, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      children.add(child); let output = "", error = "", expired = false;
      let inputError;
      if (input !== undefined) {
        child.stdin.on("error", (failure) => { inputError = failure; });
        child.stdin.end(input);
      }
      child.stdout.on("data", (c) => { output = (output + c).slice(-8 * 1024 * 1024); if (file) appendFileSync(file, c); });
      child.stderr.on("data", (c) => { error = (error + c).slice(-65536); if (file) appendFileSync(file, c); });
      const timer = setTimeout(() => { expired = true; kill(child); }, timeout);
      try {
        const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        if (code !== 0 || expired || inputError || (interrupted && !cleanup)) throw new Error(`${binary} ${args.slice(0, 3).join(" ")}: ${expired ? "timeout" : `exit ${code}`}\n${inputError?.message || error || output}`);
        return output.trim();
      } finally { clearTimeout(timer); children.delete(child); }
    },
  };
}
