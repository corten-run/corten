import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Retain bounded diagnostics without repeatedly copying a growing multi-MiB string.
// Raw artifacts are written independently and never truncated to the diagnostic tail.
export function commandOutput({ file, capture = true } = {}) {
  const fd = file === undefined ? null : openSync(file, "a");
  const tail = (limit) => {
    let chunks = [], bytes = 0;
    return {
      add(chunk) {
        if (chunk.length >= limit) { chunks = [chunk.subarray(chunk.length - limit)]; bytes = limit; return; }
        chunks.push(chunk); bytes += chunk.length;
        while (bytes > limit) {
          const extra = bytes - limit;
          if (chunks[0].length <= extra) bytes -= chunks.shift().length;
          else { chunks[0] = chunks[0].subarray(extra); bytes -= extra; }
        }
      },
      text: () => Buffer.concat(chunks, bytes).toString("utf8"),
    };
  };
  const stdout = tail(capture ? 8 * 1024 * 1024 : 65536), stderr = tail(65536);
  // Hash what this command appended, so a partial artifact can be matched to its receipt.
  const hash = fd === null ? null : createHash("sha256");
  let written = 0;
  let closed = false;
  const append = (chunk, buffer) => {
    if (closed) throw new Error("command output already closed");
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (fd !== null) {
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      hash.update(data); written += data.length;
    }
    buffer.add(data);
  };
  return {
    stdout: (chunk) => append(chunk, stdout),
    stderr: (chunk) => append(chunk, stderr),
    result: () => capture ? stdout.text().trim() : "",
    diagnostic: () => stderr.text() || stdout.text(),
    written: () => hash === null ? null : { bytes: written, sha256: hash.copy().digest("hex") },
    close() { if (!closed) { closed = true; if (fd !== null) closeSync(fd); } },
  };
}

// This stops command clients, not browser descendants. Browsers run ONLY in
// owned containers, which the runner removes even when their docker client exited.
export function killCommand(child, cwd) {
  if (process.platform === "win32" && child.pid) {
    // Node's Windows kill terminates only the child; the check's browser would survive.
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", cwd });
    killer.on("error", () => child.kill("SIGKILL"));
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    else child.kill("SIGKILL");
  }, 2000);
  force.unref();
}

// After a stop, how long the runner keeps reading pipes that another process holds open.
export const releaseMs = 5000;

// Bounded external commands. A command succeeds only on `close`: the client exited AND
// both pipes reached end of file, so its output is complete. A failure carries `exit`
// (the stable outcome other evidence checks) and `lifetime`: when the client was
// spawned, first and last wrote, exited, closed each pipe and was stopped, in
// milliseconds after spawn, so a stalled command shows which signal never arrived.
export function commandRunner({ cwd, interrupted = () => false } = {}) {
  const running = new Set();
  async function command(binary, args, { timeout = 30000, file, capture = true, cleanup = false } = {}) {
    if (interrupted() && !cleanup) throw new Error("catalog run interrupted");
    const output = commandOutput({ file, capture });
    const origin = performance.now(), spawnedAt = new Date().toISOString();
    const at = () => Math.round(performance.now() - origin);
    const child = spawn(binary, args, { cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lifetime = { command: [binary, ...args.slice(0, 3)], spawnedAt, timeoutMs: timeout, pid: child.pid ?? null,
      stdout: { bytes: 0, firstMs: null, lastMs: null, closedMs: null }, stderr: { bytes: 0, firstMs: null, lastMs: null, closedMs: null },
      exitMs: null, exitCode: null, exitSignal: null, closeMs: null, stopped: null, stoppedMs: null, releasedMs: null, file: null, settledMs: null };
    let killed = false;
    let ioError;
    let release, settleNow;
    const stop = (reason) => {
      if (lifetime.stopped === null) { lifetime.stopped = reason; lifetime.stoppedMs = at(); }
      killCommand(child, cwd);
      // A process that inherited the client's pipes (outside its process group or
      // taskkill tree) keeps them open after the client exits, so `close` may never
      // come. Stop reading after a bounded grace; the command still fails.
      release ??= setTimeout(() => {
        lifetime.releasedMs = at();
        child.stdout.destroy(); child.stderr.destroy();
        settleNow({ code: child.exitCode, signal: child.signalCode });
      }, releaseMs);
    };
    const entry = { stop };
    running.add(entry);
    const keep = (chunk, stderr) => {
      const stream = stderr ? lifetime.stderr : lifetime.stdout;
      stream.bytes += chunk.length; stream.lastMs = at(); stream.firstMs ??= stream.lastMs;
      try { (stderr ? output.stderr : output.stdout)(chunk); }
      catch (e) { ioError ??= e; stop("output error"); }
    };
    child.stdout.on("data", (c) => keep(c, false));
    child.stderr.on("data", (c) => keep(c, true));
    child.stdout.once("close", () => { lifetime.stdout.closedMs = at(); });
    child.stderr.once("close", () => { lifetime.stderr.closedMs = at(); });
    child.once("exit", (code, signal) => { lifetime.exitMs = at(); lifetime.exitCode = code; lifetime.exitSignal = signal; });
    const timer = setTimeout(() => { killed = true; stop("deadline"); }, timeout);
    // A copy: pipe events after a release must not change a receipt already taken.
    const settle = () => { lifetime.file = output.written(); lifetime.settledMs = at(); return structuredClone(lifetime); };
    try {
      const { code, signal } = await new Promise((resolve, reject) => {
        settleNow = resolve;
        child.on("error", reject);
        child.on("close", (code, signal) => { lifetime.closeMs = at(); resolve({ code, signal }); });
      });
      if (ioError) throw ioError;
      if (code !== 0 || killed || (interrupted() && !cleanup)) {
        // Exit before the stop means the client finished but a pipe was still held open.
        const held = lifetime.exitMs !== null && lifetime.stoppedMs !== null && lifetime.exitMs <= lifetime.stoppedMs
          ? `; the client exited ${lifetime.exitCode ?? lifetime.exitSignal} at ${lifetime.exitMs} ms but its output stayed open` : "";
        const failure = new Error(`${binary} ${args.slice(0, 3).join(" ")}: ${killed ? `timeout after ${timeout} ms` : `exit ${code}`}${held}\n${output.diagnostic()}`);
        failure.exit = { code, signal, expired: killed, interrupted: interrupted() && !cleanup }; throw failure;
      }
      return output.result();
    } catch (error) {
      if (error && typeof error === "object") error.lifetime ??= settle();
      throw error;
    } finally { clearTimeout(timer); clearTimeout(release); running.delete(entry); output.close(); }
  }
  return { command, interrupt() { for (const entry of running) entry.stop("interrupt"); } };
}

// Daemon-side evidence for a failed container command: the container's state and its
// recent events, taken before owned cleanup removes it. Each probe is bounded and
// read-only; a probe failure is recorded in the receipt, never thrown.
export async function failureReceipt(docker, { stage, container, error, owned }) {
  const lifetime = error?.lifetime ?? null;
  const receipt = { schema: "catalog-command-failure/v1", stage, container, recordedAt: new Date().toISOString(),
    error: String(error?.message ?? error).split("\n")[0], exit: error?.exit ?? null, lifetime, inspect: null, events: null, diagnosticErrors: [] };
  const probe = (args) => docker(args, { cleanup: true, timeout: 10000 });
  const problem = (what, e) => receipt.diagnosticErrors.push(`${what}: ${String(e?.message ?? e).split("\n")[0]}`);
  try {
    const info = JSON.parse(await probe(["inspect", "--type", "container", container]))[0];
    receipt.inspect = { id: info.Id, name: info.Name, created: info.Created, owned: owned(info.Config?.Labels),
      restartCount: info.RestartCount, state: info.State };
  } catch (e) { problem("inspect", e); }
  try {
    const since = (lifetime ? Date.parse(lifetime.spawnedAt) : Date.now()) - 60000, until = Date.now();
    const lines = (await probe(["events", "--since", (since / 1000).toFixed(3), "--until", (until / 1000).toFixed(3),
      "--filter", `container=${container}`, "--format", "{{json .}}"])).split("\n").filter(Boolean);
    receipt.events = { since: new Date(since).toISOString(), until: new Date(until).toISOString(), total: lines.length,
      recent: lines.slice(-100).map((line) => JSON.parse(line)) };
  } catch (e) { problem("events", e); }
  return receipt;
}
