// The native bootstrap preserves cancellation until the runner installs its handlers.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

export const limits = Object.freeze({ readyMs: 30000, runMs: 36 * 60 * 60 * 1000, stopMs: 120000, killMs: 5000 });
const bootstrap = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url));
// The live observer's admission is not part of the serialized command result.
const startupOutcomes = new WeakMap();
export const startupOutcome = (result) => startupOutcomes.get(result);

/** Supervision is bounded; force/IPC uncertainty is never a clean successful exit. */
export function supervise(invocation, { cwd, env, log, signal, onStart, onStartupRejected, browserDockerFd }, deadlines = limits) {
  assert.equal(invocation.executable, "node");
  assert.equal(invocation.shell, false);
  assert.ok(Array.isArray(invocation.argv) && invocation.argv.length > 0);
  return new Promise((resolve) => {
    let child, ready = false, settled = false, cancelled = false, forced = false, error = null, exited = false;
    let code = null, exitSignal = null, timer, stopTimer, killTimer, setupTimer, pendingTerminal;
    const startup = new AbortController();
    // Rejection stops capture immediately, but the callback remains owned until
    // it returns or its original join bound expires.
    let startupCutoff, setupPending = true, setupExpired = false, admission;
    function rejectStartup(outcome = "interrupted") {
      const first = admission === undefined;
      if (first) admission = outcome;
      startup.abort();
      if (first) {
        try { onStartupRejected?.(outcome); }
        catch { error ??= "native host observation disposal failed"; }
      }
    }
    function expireReady() { if (setupPending) expireSetup(); else requestStop(); }
    function expireSetup() {
      if (!setupPending || setupExpired || settled) return;
      setupExpired = true; error ??= "native host observation setup incomplete";
      rejectStartup("deadline"); requestStop();
      if (pendingTerminal !== undefined) finish(pendingTerminal);
    }
    function expireElapsedSetup() {
      if (setupPending && admission === undefined && performance.now() >= startupCutoff) {
        expireSetup(); return true;
      }
      return false;
    }
    function checkStartup() {
      expireElapsedSetup();
      startup.signal.throwIfAborted();
    }
    const finish = (terminal) => {
      if (settled) return;
      // Child close does not transfer an outstanding observation callback to
      // nobody. Join it up to the original startup deadline, never a renewed one.
      if (setupPending && !setupExpired) {
        pendingTerminal = terminal;
        if (expireElapsedSetup()) return;
        error ??= "native leader closed before host observation setup";
        rejectStartup(); return;
      }
      rejectStartup();
      settled = true;
      clearTimeout(timer); clearTimeout(stopTimer); clearTimeout(killTimer); clearTimeout(setupTimer);
      signal?.removeEventListener("abort", cancel);
      if (!terminal) {
        try {
          child?.unref(); child?.stdout?.unref?.(); child?.stderr?.unref?.();
          if (child?.connected) child.disconnect();
        } catch (failure) { error ??= failure.message; }
      }
      const result = { terminal, code, signal: exitSignal, cancelled, forced, error,
        success: terminal && code === 0 && !cancelled && !forced && error === null };
      startupOutcomes.set(result, admission);
      resolve(result);
    };
    const send = (message) => {
      try {
        if (!child.connected) throw new Error("native IPC disconnected");
        child.send(message, (failure) => { if (failure && !settled) { error ??= failure.message; cancel(); } });
      } catch (failure) { error ??= failure.message; if (!cancelled) cancel(); }
    };
    function cancel() {
      if (!expireElapsedSetup()) requestStop();
    }
    function requestStop() {
      if (settled || cancelled) return;
      cancelled = true;
      rejectStartup();
      if (ready) send({ type: "cancel", signal: "SIGTERM" });
      stopTimer = setTimeout(() => {
        if (settled) return;
        if (exited || child.exitCode != null || child.signalCode != null) {
          error ??= "native leader exited without drained output; descendant ownership unverified";
          finish(false); return;
        }
        forced = true;
        // Only this spawned process group, never a pid supplied by a receipt.
        try {
          if (process.platform === "linux" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch (failure) { error ??= failure.message; }
        killTimer = setTimeout(() => finish(false), deadlines.killMs);
      }, deadlines.stopMs);
    }
    function start() {
      if (!ready || admission !== "accepted" || settled || cancelled || exited || startup.signal.aborted) return;
      if (performance.now() >= startupCutoff) { expireReady(); return; }
      clearTimeout(timer); timer = setTimeout(cancel, deadlines.runMs);
      send({ type: "start" });
    }
    try {
      child = childProcess.spawn(process.execPath, [bootstrap, ...invocation.argv], {
        cwd, env, shell: false, windowsHide: true, detached: process.platform === "linux",
        stdio: browserDockerFd === undefined ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe", "ipc", browserDockerFd],
      });
      child.on("error", (failure) => {
        error ??= failure.message;
        if (!child.pid) finish(true); else cancel();
      });
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", (bytes) => {
        if (settled) return;
        try { log(bytes); } catch (failure) { error ??= failure.message; cancel(); }
      });
      for (const stream of [child.stdout, child.stderr]) stream?.on("error", (failure) => { error ??= failure.message; cancel(); });
      child.on("message", (message) => {
        if (settled || message?.type !== "ready" || ready) return;
        ready = true;
        if (cancelled) send({ type: "cancel", signal: "SIGTERM" });
        else if (!expireElapsedSetup()) start();
      });
      child.on("disconnect", () => {
        if (exited || settled) return;
        // Normal process exit can close IPC before the exit/close events arrive.
        clearTimeout(timer);
        timer = setTimeout(() => { error ??= "native IPC disconnected without exit"; cancel(); }, deadlines.readyMs);
      });
      child.once("exit", (value, reason) => {
        exited = true; code = value; exitSignal = reason;
        if (!expireElapsedSetup()) rejectStartup();
      });
      child.once("close", (value, reason) => { code = value; exitSignal = reason; finish(true); });
      startupCutoff = performance.now() + deadlines.readyMs;
      timer = setTimeout(expireReady, deadlines.readyMs);
      setupTimer = setTimeout(expireSetup, deadlines.readyMs);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      // Observation/containment must precede the bootstrap start message. A
      // rejected setup still drains this owned child through normal cancellation.
      Promise.resolve().then(() => onStart?.(child.pid ?? null, startup.signal, checkStartup)).then(() => {
        // A setup continuation can run before the already-due timer callback.
        expireElapsedSetup();
        setupPending = false; clearTimeout(setupTimer);
        admission ??= "accepted";
        if (pendingTerminal !== undefined) { finish(pendingTerminal); return; }
        start();
      }, () => {
        expireElapsedSetup();
        setupPending = false; clearTimeout(setupTimer);
        error ??= "native host observation setup failed"; cancel();
        if (pendingTerminal !== undefined) finish(pendingTerminal);
      });
    } catch (failure) {
      setupPending = false; clearTimeout(setupTimer);
      error ??= failure.message;
      if (child?.pid) cancel(); else finish(true);
    }
  });
}
