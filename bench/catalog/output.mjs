import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Retain bounded diagnostics without repeatedly copying a growing multi-MiB string.
// Raw artifacts are written independently and never truncated to the diagnostic tail.
// With `receipt`, it notes where this command's bytes begin, so `segment()` can hash them
// once the file is closed; nothing is hashed while the command runs.
export function commandOutput({ file, capture = true, receipt = false } = {}) {
  const fd = file === undefined ? null : openSync(file, "a");
  const start = fd !== null && receipt ? fstatSync(fd).size : null;
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
  // Every byte a write call accepted, including those before a failed write.
  let written = 0, writeError, closed = false;
  const append = (chunk, buffer) => {
    if (closed) throw new Error("command output already closed");
    // After a failed write nothing more reaches the file, so it ends at the bytes counted.
    if (writeError) throw writeError;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (fd !== null) {
      let offset = 0;
      try {
        while (offset < data.length) { const n = writeSync(fd, data, offset, data.length - offset); offset += n; written += n; }
      } catch (e) { writeError = e; throw e; }
    }
    buffer.add(data);
  };
  // After close: this command's bytes as the file now holds them, and their SHA-256.
  const segment = () => {
    if (start === null) return null;
    const hash = createHash("sha256"), block = Buffer.allocUnsafe(Math.max(1, Math.min(written, 1 << 20)));
    let reader;
    try {
      reader = openSync(file, "r");
      for (let done = 0; done < written;) {
        const n = readSync(reader, block, 0, Math.min(block.length, written - done), start + done);
        if (n === 0) throw Object.assign(new Error("file shorter than written"), { code: "ESHORT" });
        hash.update(block.subarray(0, n)); done += n;
      }
      return { offset: start, bytes: written, sha256: hash.digest("hex") };
    } catch (e) { return { offset: start, bytes: written, sha256: null, unreadable: e?.code ?? e?.name ?? "error" }; }
    finally { if (reader !== undefined) try { closeSync(reader); } catch {} }
  };
  return {
    stdout: (chunk) => append(chunk, stdout),
    stderr: (chunk) => append(chunk, stderr),
    result: () => capture ? stdout.text().trim() : "",
    diagnostic: () => stderr.text() || stdout.text(),
    segment,
    close() { if (!closed) { closed = true; if (fd !== null) closeSync(fd); } },
  };
}

// This stops command clients, not browser descendants. Browsers run ONLY in
// owned containers, which the runner removes even when their docker client exited.
// Call it once per command. On Linux the client leads its own process group; a
// descendant that stays in it is killed with it, even after the leader has exited. A
// process that left the group (a new session) is out of reach; see commandRunner.
export function killCommand(child, cwd) {
  if (process.platform === "win32" && child.pid) {
    // Node's Windows kill terminates only the child; the check's browser would survive.
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", cwd });
    killer.on("error", () => child.kill("SIGKILL"));
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  const force = setTimeout(() => {
    const exited = child.exitCode !== null || child.signalCode !== null;
    // The group outlives its leader while any member lives, and its ID is not reused
    // until then, so an exited leader is no reason to skip the group.
    if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { if (!exited) child.kill("SIGKILL"); } }
    else if (!exited) child.kill("SIGKILL");
  }, 2000);
  force.unref();
}

// After a stop, how long the runner keeps reading pipes that another process holds open.
export const releaseMs = 5000;

// Bounded external commands. A command succeeds only on `close`: the client exited AND
// both pipes reached end of file, so its output is complete, and nothing stopped it. A
// command the runner stopped (deadline, interrupt, output error) or whose pipes it had to
// release fails, whatever its exit code or `cleanup`; `cleanup` only lets it start after
// an interrupt. A failure carries `exit` (the stable outcome other evidence checks).
// With `receipt`, a failure also carries `lifetime`: when the client was spawned, first
// and last wrote, exited, closed each pipe and was stopped, in milliseconds after spawn,
// and, after the file is closed, the bytes this command appended and their hash. Without
// `receipt` (every timed-phase command), each chunk costs what it did before receipts.
export function commandRunner({ cwd, interrupted = () => false } = {}) {
  const running = new Set();
  async function command(binary, args, { timeout = 30000, file, capture = true, cleanup = false, receipt = false } = {}) {
    if (interrupted() && !cleanup) throw new Error("catalog run interrupted");
    const output = commandOutput({ file, capture, receipt });
    const origin = performance.now(), spawnedAt = new Date().toISOString();
    const at = () => Math.round(performance.now() - origin);
    const child = spawn(binary, args, { cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lifetime = { command: [binary, ...args.slice(0, 3)], spawnedAt, timeoutMs: timeout, pid: child.pid ?? null,
      stdout: { bytes: 0, firstMs: null, lastMs: null, closedMs: null }, stderr: { bytes: 0, firstMs: null, lastMs: null, closedMs: null },
      exitMs: null, exitCode: null, exitSignal: null, closeMs: null, stopped: null, stoppedMs: null, releasedMs: null, file: null, settledMs: null };
    let killed = false, released = false;
    let ioError;
    let release, settleNow;
    // Idempotent: a second deadline, interrupt or output error neither signals again nor
    // restarts the grace.
    const stop = (reason) => {
      if (lifetime.stopped !== null) return;
      lifetime.stopped = reason; lifetime.stoppedMs = at();
      killCommand(child, cwd);
      // A process that inherited the client's pipes (outside its process group or
      // taskkill tree) keeps them open after the client exits, so `close` may never
      // come. Stop reading after a bounded grace; the command still fails. Such an
      // escaped process is not stopped here: only a container the runner owns is removed.
      release = setTimeout(() => {
        released = true; lifetime.releasedMs = at();
        child.stdout.destroy(); child.stderr.destroy();
        settleNow({ code: child.exitCode, signal: child.signalCode });
      }, releaseMs);
    };
    const entry = { stop };
    running.add(entry);
    const write = (chunk, stderr) => {
      try { (stderr ? output.stderr : output.stdout)(chunk); }
      catch (e) { ioError ??= e; stop("output error"); }
    };
    const keep = receipt ? (chunk, stderr) => {
      const stream = stderr ? lifetime.stderr : lifetime.stdout;
      stream.bytes += chunk.length; stream.lastMs = at(); stream.firstMs ??= stream.lastMs;
      write(chunk, stderr);
    } : write;
    child.stdout.on("data", (c) => keep(c, false));
    child.stderr.on("data", (c) => keep(c, true));
    // A pipe the runner destroyed on release did not close; it is not recorded as closed.
    child.stdout.once("close", () => { if (!released) lifetime.stdout.closedMs = at(); });
    child.stderr.once("close", () => { if (!released) lifetime.stderr.closedMs = at(); });
    child.once("exit", (code, signal) => { lifetime.exitMs = at(); lifetime.exitCode = code; lifetime.exitSignal = signal; });
    const timer = setTimeout(() => { killed = true; stop("deadline"); }, timeout);
    // After close, and a copy: pipe events after a release must not change a receipt already taken.
    const settle = () => { lifetime.file = output.segment(); lifetime.settledMs = at(); return structuredClone(lifetime); };
    let failure, result;
    try {
      const { code, signal } = await new Promise((resolve, reject) => {
        settleNow = resolve;
        child.on("error", reject);
        child.on("close", (code, signal) => { if (!released) lifetime.closeMs = at(); resolve({ code, signal }); });
      });
      if (ioError) throw ioError;
      const stopped = lifetime.stopped !== null;
      if (code !== 0 || killed || stopped || released || (interrupted() && !cleanup)) {
        // Exit before the stop means the client finished but a pipe was still held open.
        const held = lifetime.exitMs !== null && lifetime.stoppedMs !== null && lifetime.exitMs <= lifetime.stoppedMs
          ? `; the client exited ${lifetime.exitCode ?? lifetime.exitSignal} at ${lifetime.exitMs} ms but its output stayed open` : "";
        const forced = released ? `; its pipes were released at ${lifetime.releasedMs} ms without end of file` : "";
        const interruption = lifetime.stopped === "interrupt" ? "; interrupted" : "";
        const error = new Error(`${binary} ${args.slice(0, 3).join(" ")}: ${killed ? `timeout after ${timeout} ms` : `exit ${code}`}${interruption}${held}${forced}\n${output.diagnostic()}`);
        error.exit = { code, signal, expired: killed, interrupted: lifetime.stopped === "interrupt" || (interrupted() && !cleanup) }; throw error;
      }
      result = output.result();
    } catch (error) { failure = error ?? new Error(`${binary}: failed`); }
    finally { clearTimeout(timer); clearTimeout(release); running.delete(entry); }
    // Closing is reported, but never replaces the command's own error.
    let closeError;
    try { output.close(); } catch (e) { closeError = e; }
    if (failure !== undefined) {
      if (typeof failure === "object") {
        if (closeError) failure.outputCloseError ??= firstLine(closeError);
        if (receipt) failure.lifetime ??= settle();
      }
      throw failure;
    }
    // A command that succeeded but whose artifact did not close is not complete.
    if (closeError) throw closeError;
    return result;
  }
  return { command, interrupt() { for (const entry of running) entry.stop("interrupt"); } };
}

const firstLine = (e) => String(e?.message ?? e).split("\n")[0];
// A probe failure in a receipt. A runner command's first line is its own text; anything
// else (an exception's message can quote what it parsed) is reduced to its code or name.
const problem = (what, e) => `${what}: ${e?.exit ? firstLine(e) : e?.code ?? e?.name ?? "error"}`;
const containerId = /^[0-9a-f]{64}$/;

// The immutable ID of container `name` when this run owns it: Docker names it exactly
// `name` and it carries this run's label (`owned(labels)`). Otherwise a refusal, and
// nothing read from the container. `probe(args)` runs one bounded Docker command.
export async function ownedContainer(probe, name, owned) {
  let text, info;
  try { text = await probe(["inspect", "--type", "container", name]); }
  catch (e) { return { refusal: "not inspected", problem: problem("inspect", e) }; }
  try { [info] = JSON.parse(text); } catch { return { refusal: "not inspected", problem: "inspect: unparseable output" }; }
  if (!info || typeof info !== "object") return { refusal: "not inspected", problem: "inspect: unparseable output" };
  if (typeof info.Id !== "string" || !containerId.test(info.Id) || info.Name !== `/${name}` || owned(info.Config?.Labels) !== true) {
    return { refusal: "not owned by this run" };
  }
  return { id: info.Id, info };
}

// The investigation's fields of a container's inspect `State`; never health-check output.
const stateOf = (state) => ({ status: state?.Status ?? null, running: state?.Running ?? null, exitCode: state?.ExitCode ?? null,
  oomKilled: state?.OOMKilled ?? null, startedAt: state?.StartedAt ?? null, finishedAt: state?.FinishedAt ?? null });
// An event's action and time; never its attributes, which copy every container label. An
// action's detail after the colon (an exec command, a health status) is dropped too.
function eventOf(line, id) {
  let event;
  try { event = JSON.parse(line); } catch { return "unreadable"; }
  if (!event || typeof event !== "object") return "unreadable";
  if ((event.Actor?.ID ?? event.id) !== id) return "excluded";
  const action = String(event.Action ?? event.status ?? "").split(":")[0].trim();
  const ms = Number.isFinite(event.timeNano) ? Math.round(event.timeNano / 1e6) : Number.isFinite(event.time) ? event.time * 1000 : NaN;
  if (!/^[a-z_]+$/.test(action) || !Number.isFinite(ms)) return "unreadable";
  return { action, time: new Date(ms).toISOString() };
}

// Daemon-side evidence for a failed container command, taken before owned cleanup removes
// the container. It reads only a container this run owns, bound to the immutable ID it
// resolved: allowlisted inspect state and its events' actions and times. For a missing or
// foreign container it keeps the command's own evidence and the refusal. Each probe is
// bounded and read-only; a probe failure is recorded in the receipt, never thrown.
export async function failureReceipt(docker, { stage, container, error, owned }) {
  const lifetime = error?.lifetime ?? null;
  const receipt = { schema: "catalog-command-failure/v1", stage, container, recordedAt: new Date().toISOString(),
    error: firstLine(error), exit: error?.exit ?? null, outputCloseError: error?.outputCloseError ?? null, lifetime,
    refusal: null, inspect: null, events: null, diagnosticErrors: [] };
  const probe = (args) => docker(args, { cleanup: true, timeout: 10000 });
  const found = await ownedContainer(probe, container, owned);
  if (found.problem) receipt.diagnosticErrors.push(found.problem);
  if (!found.id) { receipt.refusal = found.refusal; return receipt; }
  receipt.inspect = { id: found.id, restartCount: found.info.RestartCount ?? null, state: stateOf(found.info.State) };
  try {
    const since = (lifetime ? Date.parse(lifetime.spawnedAt) : Date.now()) - 60000, until = Date.now();
    const lines = (await probe(["events", "--since", (since / 1000).toFixed(3), "--until", (until / 1000).toFixed(3),
      "--filter", `container=${found.id}`, "--format", "{{json .}}"])).split("\n").filter(Boolean);
    const kept = [];
    let excluded = 0, unreadable = 0;
    for (const line of lines) {
      const event = eventOf(line, found.id);
      if (event === "excluded") excluded++; else if (event === "unreadable") unreadable++; else kept.push(event);
    }
    receipt.events = { since: new Date(since).toISOString(), until: new Date(until).toISOString(), total: kept.length, excluded, unreadable,
      recent: kept.slice(-100) };
  } catch (e) { receipt.diagnosticErrors.push(problem("events", e)); }
  return receipt;
}
