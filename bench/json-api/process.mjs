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
    async command(binary, args, { timeout = 30000, file, cleanup = false, input, observeExit = false,
      stdoutFile, stderrFile, maxStdoutBytes, maxStderrBytes } = {}) {
      if (interrupted && !cleanup) throw new Error("JSON run interrupted");
      if (input !== undefined && !Buffer.isBuffer(input)) throw new TypeError("command input must be a Buffer");
      for (const cap of [maxStdoutBytes, maxStderrBytes]) if (cap !== undefined && (!Number.isSafeInteger(cap) || cap <= 0)) throw new TypeError("positive byte cap required");
      const startedAt = Date.now();
      const child = spawn(binary, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      children.add(child); let output = "", error = "", expired = false;
      let inputError, stdoutBytes = 0, stderrBytes = 0;
      const ioErrors = [];
      const ioFailure = (failure) => { ioErrors.push(failure.message); kill(child); };
      if (input !== undefined) {
        child.stdin.on("error", (failure) => { inputError = failure; });
        child.stdin.end(input);
      }
      child.stdout.on("error", ioFailure); child.stderr.on("error", ioFailure);
      child.stdout.on("data", (c) => {
        stdoutBytes += c.length;
        if (ioErrors.length) return;
        try {
          if (maxStdoutBytes !== undefined && stdoutBytes > maxStdoutBytes) throw new Error("stdout byte cap exceeded; capture incomplete");
          if (!stdoutFile) output = (output + c).slice(-8 * 1024 * 1024);
          if (stdoutFile) appendFileSync(stdoutFile, c);
          if (file) appendFileSync(file, c);
        } catch (failure) { ioFailure(failure); }
      });
      child.stderr.on("data", (c) => {
        stderrBytes += c.length;
        if (ioErrors.length) return;
        try {
          if (maxStderrBytes !== undefined && stderrBytes > maxStderrBytes) throw new Error("stderr byte cap exceeded; capture incomplete");
          error = (error + c).slice(-65536);
          if (stderrFile) appendFileSync(stderrFile, c);
          if (file) appendFileSync(file, c);
        } catch (failure) { ioFailure(failure); }
      });
      const timer = setTimeout(() => { expired = true; kill(child); }, timeout);
      try {
        const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, expired, interrupted: interrupted && !cleanup })); });
        const clock = { startedAt, finishedAt: Date.now() };
        if (exit.signal !== null || (exit.code !== 0 && !(observeExit && exit.code === 99)) || expired || inputError || ioErrors.length || exit.interrupted) {
          const failure = new Error(`${binary} ${args.slice(0, 3).join(" ")}: ${expired ? "timeout" : `exit ${exit.code}`}\n${inputError?.message || ioErrors[0] || error || output}`);
          failure.ioErrors = [...ioErrors, ...(inputError ? [inputError.message] : [])];
          if (observeExit || !inputError && !ioErrors.length) { failure.exit = exit; failure.clock = clock; }
          throw failure;
        }
        if (observeExit) return { exit, clock, ioErrors, stdoutBytes, stderrBytes };
        return output.trim();
      } finally { clearTimeout(timer); children.delete(child); }
    },
  };
}
