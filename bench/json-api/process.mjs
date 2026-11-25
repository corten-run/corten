import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export function commands(cwd, { spawnClient = spawn, pipeGrace = 5000 } = {}) {
  const children = new Map(), terminations = new Map(); let interrupted = false;
  const signalHandle = (child, signal, report) => {
    try { child.kill(signal); } catch (error) { report(error); }
  };
  const kill = (child, report) => {
    if (terminations.has(child) || child.exitCode !== null || child.signalCode !== null) return;
    const termination = {}; terminations.set(child, termination);
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { cwd, windowsHide: true, stdio: "ignore" });
      termination.helper = killer;
      termination.done = new Promise((resolve) => {
        const bound = setTimeout(() => { killer.unref(); resolve(false); }, pipeGrace);
        const settled = () => { clearTimeout(bound); resolve(true); };
        killer.once("close", settled); killer.once("error", settled);
      });
      killer.on("error", (error) => {
        report(error);
        if (child.exitCode === null && child.signalCode === null) signalHandle(child, "SIGKILL", report);
      });
    } else if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { signalHandle(child, "SIGTERM", report); } }
    termination.timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { signalHandle(child, "SIGKILL", report); } }
        else signalHandle(child, "SIGKILL", report);
      }
      if (termination.helper?.exitCode === null && termination.helper.signalCode === null) signalHandle(termination.helper, "SIGKILL", report);
    }, 2000); termination.timer.unref();
  };
  const interrupt = () => { interrupted = true; for (const stop of children.values()) stop(); };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
  return {
    get interrupted() { return interrupted; },
    dispose() { for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt); },
    async command(binary, args, { timeout = 30000, file, cleanup = false, input, observeExit = false,
      stdoutFile, stderrFile, maxStdoutBytes, maxStderrBytes, onExit } = {}) {
      if (interrupted && !cleanup) throw new Error("JSON run interrupted");
      if (input !== undefined && !Buffer.isBuffer(input)) throw new TypeError("command input must be a Buffer");
      for (const cap of [maxStdoutBytes, maxStderrBytes]) if (cap !== undefined && (!Number.isSafeInteger(cap) || cap <= 0)) throw new TypeError("positive byte cap required");
      const startedAt = Date.now();
      const child = spawnClient(binary, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      let output = "", error = "", expired = false;
      let inputError, stdoutBytes = 0, stderrBytes = 0, release, settle, timer;
      const ioErrors = [];
      const report = (failure) => { ioErrors.push(failure.message); };
      const stop = () => {
        if (release !== undefined) return;
        clearTimeout(timer);
        release = setTimeout(() => {
          ioErrors.push("command did not close within the stop grace; output incomplete");
          child.stdin?.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          settle(child.exitCode, child.signalCode);
        }, pipeGrace);
        try { kill(child, report); }
        catch (failure) { report(failure); }
      };
      const ioFailure = (failure) => { report(failure); stop(); };
      children.set(child, stop);
      const result = new Promise((resolve) => {
        settle = (code, signal) => resolve({ code, signal, expired, interrupted: interrupted && !cleanup });
        // Node also emits `error` when a signal fails. Retain it as evidence;
        // closing pipes or the accepted stop's grace must decide settlement.
        child.on("error", ioFailure); child.once("close", settle);
        if (onExit) child.once("exit", () => { try { onExit(); } catch (failure) { ioFailure(failure); } });
      });
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
      timer = setTimeout(() => { expired = true; stop(); }, timeout);
      try {
        const exit = await result;
        const clock = { startedAt, finishedAt: Date.now() };
        if (exit.signal !== null || (exit.code !== 0 && !(observeExit && exit.code === 99)) || expired || inputError || ioErrors.length || exit.interrupted) {
          const failure = new Error(`${binary} ${args.slice(0, 3).join(" ")}: ${expired ? "timeout" : `exit ${exit.code}`}\n${inputError?.message || ioErrors[0] || error || output}`);
          failure.ioErrors = [...ioErrors, ...(inputError ? [inputError.message] : [])];
          if (observeExit || !inputError && !ioErrors.length) { failure.exit = exit; failure.clock = clock; }
          throw failure;
        }
        if (observeExit) return { exit, clock, ioErrors, stdoutBytes, stderrBytes };
        return output.trim();
      } finally {
        clearTimeout(timer); clearTimeout(release); children.delete(child);
        const termination = terminations.get(child);
        if (termination) {
          // taskkill may outlive an already closed target. Do not leak its owned
          // process handle, or hide it by unref'ing an unfinished child.
          if (termination.helper?.exitCode === null && termination.helper.signalCode === null) signalHandle(termination.helper, "SIGKILL", report);
          if (termination.done) await termination.done;
          clearTimeout(termination.timer); terminations.delete(child);
        }
      }
    },
  };
}
