import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Retain bounded diagnostics without repeatedly copying a growing multi-MiB string.
// Raw artifacts are written independently and never truncated to the diagnostic tail.
// With `receipt`, it notes where this command's bytes begin, so `segment()` can hash them
// once the file is closed; nothing is hashed while the command runs. With `fileStderr: false` the
// client's stderr stays out of `file` (it is kept for the diagnostic alone), so the file holds the
// client's stdout byte for byte.
export function commandOutput({ file, capture = true, receipt = false, fileStderr = true } = {}) {
  const fd = file === undefined ? null : openSync(file, "a");
  let start = null;
  // The descriptor is this helper's from open onward: a failure before it is returned closes it.
  if (fd !== null && receipt) {
    try { start = fstatSync(fd).size; } catch (e) { try { closeSync(fd); } catch {} throw e; }
  }
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
  // With `receipt` only: every byte a write call accepted, including those before a failed write.
  let written = 0, writeError, closed = false;
  const append = (chunk, buffer, toFile = true) => {
    if (closed) throw new Error("command output already closed");
    // After a failed write nothing more reaches the file, so it ends at the bytes counted.
    if (writeError) throw writeError;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (fd !== null && toFile) {
      let offset = 0;
      try {
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      } catch (e) { if (receipt) written += offset; writeError = e; throw e; }
      if (receipt) written += offset;
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
    stderr: fileStderr ? (chunk) => append(chunk, stderr) : (chunk) => append(chunk, stderr, false),
    result: () => capture ? stdout.text().trim() : "",
    diagnostic: () => stderr.text() || stdout.text(),
    receiptBytes: () => start === null ? null : written,
    segment,
    close() { if (!closed) { closed = true; if (fd !== null) closeSync(fd); } },
  };
}

// After a stop, how long the runner keeps reading pipes that another process holds open.
export const releaseMs = 5000;
// Node has reaped the client. Until then its PID, which is also its process group's ID, is reserved.
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

// Stops a command client once, and resolves with what it did inside the stop bound (before
// `releaseMs`); it never rejects. It stops command clients, not browser descendants: browsers
// run ONLY in owned containers, which the runner removes even when their docker client exited.
// The group rule (Linux): the client leads its own process group, whose numeric ID is the
// client's PID. That ID is provably the client's group ONLY while Node has not reaped the
// client: an unreaped leader, even a zombie, keeps the number reserved. Once the client is
// reaped, a successful probe cannot tell the original group from a new one that took its
// number, so the group is never signalled again. So: SIGTERM to the group, and SIGKILL after
// `graceMs`, both only while the client is unreaped, each checked and sent from a callback of
// its own (see stopGroup); it resolves when the client exits or at the bound. A group member
// that ignores SIGTERM after the client has exited is not killed:
// if it holds a pipe, commandRunner releases the pipes at the bound and fails the command,
// recording that the client exited while its output stayed open. Owned Docker containers are
// removed independently, so this leaves no browser or k6 container behind. If the group signal
// fails while the client is unreaped, only the client is stopped, through its own handle.
// Windows tree cleanup is best effort: `taskkill /T` receives a bare PID, gets `helperMs` to
// stop the client's tree, and is abandoned at the bound; whenever it fails, cannot start or
// crosses `helperMs`, whatever its exit code, a still-live client is killed through its own
// handle. A failed signal (a group signal, the client's own handle, or the helper's kill) is
// recorded in the result and never ends the stop early or throws: the bound still applies, and
// an abandoned helper is unreferenced. Nothing is signalled for a client already reaped. A
// process that left the group (a new session) or the tree is out of reach; see commandRunner.
// Options other than `cwd` are for tests.
export function killCommand(child, { cwd, platform = process.platform, graceMs = 2000, helperMs = 3000,
  boundMs = releaseMs - 250, taskkill = (pid) => ["taskkill.exe", ["/PID", String(pid), "/T", "/F"]] } = {}) {
  const method = platform === "win32" ? "taskkill" : "process group";
  if (!child.pid) return Promise.resolve({ method, end: "no process" });
  if (exited(child)) return Promise.resolve({ method, end: "the client had already exited; nothing signalled" });
  return platform === "win32" ? stopTree(child, { cwd, helperMs, boundMs, taskkill }) : stopGroup(child, { graceMs, boundMs });
}

// Signals the client through its own handle. Node reports a failed signal by throwing or by
// emitting `error` on the child inside kill(); either is recorded and never ends the stop.
function signalClient(child, signal, record) {
  const failed = (e) => { record.clientError ??= e?.code ?? "error"; };
  child.on("error", failed);
  try { child.kill(signal); } catch (e) { failed(e); } finally { child.removeListener("error", failed); }
}

function stopGroup(child, { graceMs, boundMs }) {
  const record = { method: "process group", term: null, kill: null, end: null, clientError: null }, group = -child.pid;
  // Each signal, to the group or the client's handle, is sent in the same synchronous step as
  // its check that the client is unreaped, and never in the caller's turn: SIGTERM from an
  // immediate, SIGKILL from the grace timer. On Linux libuv reaps every exited child in one
  // batch and only then calls each one's exit callback, so inside one exit callback (where a
  // stop can start, an interrupt for example) another client can already be reaped while its
  // exit fields are still null. The timers and check phases run outside that batch, and by then
  // every child libuv has reaped has had its exit callback, which sets those fields first.
  // A failed group signal while the client is unreaped is unexpected: from then on only the
  // client is stopped, through its own handle.
  let owned = true;
  const send = (signal) => {
    if (!owned) { signalClient(child, signal, record); return "client"; }
    try { process.kill(group, signal); return "sent"; }
    catch (e) { owned = false; signalClient(child, signal, record); return e?.code ?? "error"; }
  };
  return new Promise((resolve) => {
    let first, grace, bound;
    const done = (end) => {
      if (record.end !== null) return;
      record.end = end; clearImmediate(first); clearTimeout(grace); clearTimeout(bound); child.removeListener("exit", reaped); resolve(record);
    };
    const reaped = () => done("the client exited; its group is not signalled again");
    child.once("exit", reaped);
    first = setImmediate(() => {
      if (exited(child)) return reaped();
      record.term = send("SIGTERM");
      grace = setTimeout(() => { if (exited(child)) reaped(); else record.kill = send("SIGKILL"); }, graceMs);
    });
    bound = setTimeout(() => done(exited(child) ? "the client exited; its group is not signalled again" : "bound reached; the client was still running"), boundMs);
  });
}

function stopTree(child, { cwd, helperMs, boundMs, taskkill }) {
  const record = { method: "taskkill", helper: null, kill: null, clientError: null };
  return new Promise((resolve) => {
    let finished = false, stalled = false, killError = null, helper, limit, cap;
    const finish = (result) => {
      if (finished) return;
      finished = true; clearTimeout(limit); clearTimeout(cap);
      record.helper = { ...result, stalled, killError };
      // A helper that crossed its budget did not stop the tree in time, whatever its exit code.
      if ((result.exitCode !== 0 || stalled) && !exited(child)) { record.kill = "client"; signalClient(child, "SIGKILL", record); }
      resolve(record);
    };
    try {
      const [binary, args] = taskkill(child.pid);
      helper = spawn(binary, args, { windowsHide: true, stdio: "ignore", cwd });
    } catch (e) { finish({ exitCode: null, signal: null, error: e?.code ?? "error" }); return; }
    // Node reports a failed kill() of the helper as an `error` too; that is not the helper's end,
    // so it is recorded and the helper is still abandoned at the bound.
    helper.on("error", (e) => {
      if (e?.syscall === "kill") killError ??= e.code ?? "error";
      else finish({ exitCode: null, signal: null, error: e?.code ?? "error" });
    });
    helper.once("exit", (code, signal) => finish({ exitCode: code, signal, error: null }));
    limit = setTimeout(() => { stalled = true; try { helper.kill(); } catch (e) { killError ??= e?.code ?? "error"; } }, helperMs);
    // A helper that survives its own kill is abandoned, unreferenced, at the bound.
    cap = setTimeout(() => { helper.unref(); finish({ exitCode: null, signal: null, error: "did not exit" }); }, boundMs);
  });
}

// Bounded external commands. A command succeeds only on `close`: the client exited AND
// both pipes reached end of file, so its output is complete, and nothing stopped it. A
// command the runner stopped (deadline, interrupt, output error) or whose pipes it had to
// release fails, whatever its exit code or `cleanup`; `cleanup` only lets it start after
// an interrupt. The first stop reason the runner accepts decides the outcome. A failure
// carries `exit` (the stable outcome other evidence checks); an output error after another
// stop was accepted is kept as `outputError`, and a failed signal to the client as
// `signalError`; neither changes it. A client that cannot be started (spawn ENOENT, for
// example) fails with Node's spawn error, given an `exit` with no code or signal, unless a stop
// was accepted first: then that stop decides, as for any command, and the spawn error is kept as
// `spawnError`. A stopped command settles only after its stop has
// (killCommand), inside the stop bound. At the bound the runner releases the pipes and, if the
// client is still running, unreferences it so it no longer holds the runner, records that it
// survived, and fails; a failed signal never cancels that release.
// With `receipt`, a failure also carries `lifetime`: when the client was spawned, first
// and last wrote, exited, closed each pipe and was stopped, in milliseconds after spawn,
// what the stop did, whether the client had exited when its pipes were released, and, after
// the file is closed, the bytes this command appended and their hash. Without `receipt` (every
// timed-phase command) it keeps no lifetime and no receipt byte count, reads no receipt clock,
// hashes nothing and adds no listener beyond its output, error and close. That path is still
// not the one before receipts: each chunk also passes an earlier-write-error check and a receipt
// flag test, and command setup and settlement changed. Its timing effect was not measured.
export function commandRunner({ cwd, interrupted = () => false, interruptMessage = "catalog run interrupted", killOptions = {} } = {}) {
  const running = new Set();
  async function command(binary, args, { timeout = 30000, file, capture = true, cleanup = false, receipt = false, fileStderr = true } = {}) {
    if (interrupted() && !cleanup) throw new Error(interruptMessage);
    const output = commandOutput({ file, capture, receipt, fileStderr });
    let child;
    // The output's descriptor is closed when the client cannot even be spawned.
    try { child = spawn(binary, args, { cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) {
      try { output.close(); } catch (c) { if (e && typeof e === "object") e.outputCloseError ??= firstLine(c); }
      throw e;
    }
    const origin = receipt ? performance.now() : 0, at = () => Math.round(performance.now() - origin);
    const lifetime = receipt ? { command: [binary, ...args.slice(0, 3)], spawnedAt: new Date().toISOString(), timeoutMs: timeout, pid: child.pid ?? null,
      stdout: { bytes: 0, firstMs: null, lastMs: null, closedMs: null }, stderr: { bytes: 0, firstMs: null, lastMs: null, closedMs: null },
      exitMs: null, exitCode: null, exitSignal: null, closeMs: null, stopped: null, stoppedMs: null, releasedMs: null, clientAtRelease: null, kill: null,
      file: null, settledMs: null } : null;
    let reason = null, exitedAtStop = false, released = false, survived = false, settled = false, escalation = null;
    let ioError, signalError, spawnError, release, timer, settleNow;
    // Idempotent, and the first accepted reason decides the outcome: a later deadline, interrupt
    // or output error neither signals again, restarts the grace, nor changes the outcome.
    const stop = (why) => {
      if (reason !== null || settled) return;
      reason = why; clearTimeout(timer); exitedAtStop = exited(child);
      if (lifetime) { lifetime.stopped = why; lifetime.stoppedMs = at(); }
      // A process that inherited the client's pipes (outside its process group or
      // taskkill tree, or a group member that outlived the client) keeps them open after the
      // client exits, so `close` may never come. Stop reading after a bounded grace; the
      // command still fails. Such a process is not stopped here: only a container the runner
      // owns is removed. A client its stop did not end is left running, unreferenced. The
      // release is armed before anything is signalled, and nothing in the stop cancels it.
      release = setTimeout(() => {
        released = true; survived = !exited(child);
        if (lifetime) { lifetime.releasedMs = at(); lifetime.clientAtRelease = survived ? "running" : "exited"; }
        child.stdout.destroy(); child.stderr.destroy();
        if (survived) child.unref();
        settleNow({ code: child.exitCode, signal: child.signalCode });
      }, releaseMs);
      try { escalation = killCommand(child, { cwd, ...killOptions }); }
      catch (e) { escalation = Promise.resolve({ error: e?.code ?? e?.name ?? "error" }); }
    };
    const closed = new Promise((resolve) => {
      settleNow = (value) => { settled = true; resolve(value); };
      // Node also emits `error` when a kill() fails; the client may still be running, so that is
      // secondary evidence (killCommand records it too) and the release stays armed. Any other
      // `error` means the client was never started; it settles the command, and is classified
      // below with whatever stop was accepted before it.
      child.on("error", (e) => {
        if (e?.syscall === "kill") { signalError ??= e; return; }
        spawnError ??= e ?? new Error(`${binary}: failed to start`); settleNow({ code: null, signal: null });
      });
      child.on("close", (code, signal) => { if (lifetime && !released) lifetime.closeMs = at(); settleNow({ code, signal }); });
    });
    const write = (chunk, stderr) => {
      try { (stderr ? output.stderr : output.stdout)(chunk); }
      catch (e) { ioError ??= e; stop("output error"); }
    };
    if (lifetime) {
      const keep = (chunk, stderr) => {
        const stream = stderr ? lifetime.stderr : lifetime.stdout;
        stream.bytes += chunk.length; stream.lastMs = at(); stream.firstMs ??= stream.lastMs;
        write(chunk, stderr);
      };
      child.stdout.on("data", (c) => keep(c, false));
      child.stderr.on("data", (c) => keep(c, true));
      // A pipe the runner destroyed on release did not close; it is not recorded as closed.
      child.stdout.once("close", () => { if (!released) lifetime.stdout.closedMs = at(); });
      child.stderr.once("close", () => { if (!released) lifetime.stderr.closedMs = at(); });
      child.once("exit", (code, signal) => { lifetime.exitMs = at(); lifetime.exitCode = code; lifetime.exitSignal = signal; });
    } else {
      child.stdout.on("data", (c) => write(c, false));
      child.stderr.on("data", (c) => write(c, true));
    }
    timer = setTimeout(() => stop("deadline"), timeout);
    const entry = { stop };
    running.add(entry);
    // After close, and a copy: pipe events after a release must not change a receipt already taken.
    const settle = () => { lifetime.file = output.segment(); lifetime.settledMs = at(); return structuredClone(lifetime); };
    let failure, result, code, signal;
    try { ({ code, signal } = await closed); }
    catch (error) { failure = error ?? new Error(`${binary}: failed`); }
    finally { clearTimeout(timer); clearTimeout(release); running.delete(entry); }
    // A stopped command settles only once its stop has, so no signal for it is left pending.
    if (escalation) { const stopped = await escalation; if (lifetime) lifetime.kill = stopped; }
    if (failure === undefined) {
      try {
        // An output error that was itself the stop is the failure; after another accepted stop it is secondary.
        if (ioError && (reason === "output error" || reason === null)) throw ioError;
        const expired = reason === "deadline", interruption = reason === "interrupt", runInterrupted = interrupted() && !cleanup;
        const exit = { code, signal, expired, interrupted: interruption || (reason === null && runInterrupted) };
        // Unopposed, a client that never started fails with its own spawn error.
        if (spawnError !== undefined && reason === null) {
          if (typeof spawnError === "object") spawnError.exit ??= exit;
          throw spawnError;
        }
        if (code !== 0 || reason !== null || released || runInterrupted) {
          // The client finished, before the stop or before the release, but a pipe was still held open.
          const held = exitedAtStop || (released && !survived)
            ? `; the client exited ${child.exitCode ?? child.signalCode}${lifetime ? ` at ${lifetime.exitMs} ms` : ""} but its output stayed open` : "";
          const forced = released ? `; its pipes were released${lifetime ? ` at ${lifetime.releasedMs} ms` : ""} without end of file${survived
            ? " while the client was still running; it was left running" : ""}` : "";
          const ended = expired ? `timeout after ${timeout} ms` : spawnError !== undefined ? `did not start (${spawnError?.code ?? "error"})` : `exit ${code}`;
          const error = new Error(`${binary} ${args.slice(0, 3).join(" ")}: ${ended}${interruption ? "; interrupted" : ""}${held}${forced}\n${output.diagnostic()}`);
          error.exit = exit;
          if (ioError) error.outputError = firstLine(ioError);
          if (spawnError !== undefined) error.spawnError = firstLine(spawnError);
          throw error;
        }
        result = output.result();
      } catch (error) { failure = error ?? new Error(`${binary}: failed`); }
    }
    // Closing is reported, but never replaces the command's own error. A command that otherwise
    // succeeded is not complete without its artifact, so the close failure becomes its error.
    let closeError;
    try { output.close(); } catch (e) { closeError = e; }
    if (closeError !== undefined) {
      if (failure === undefined) failure = closeError;
      else if (failure && typeof failure === "object") failure.outputCloseError ??= firstLine(closeError);
    }
    if (signalError !== undefined && failure && typeof failure === "object") failure.signalError ??= firstLine(signalError);
    if (failure !== undefined) {
      if (receipt && failure && typeof failure === "object") failure.lifetime ??= settle();
      throw failure;
    }
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
// nothing read from the container. `probe(args)` runs one bounded Docker command. With
// `id`, it inspects that ID, never the name: a container that took the name since is not
// read, and a missing one is "verified container gone".
export async function ownedContainer(probe, name, owned, { id } = {}) {
  let text, info;
  try { text = await probe(["inspect", "--type", "container", id ?? name]); }
  catch (e) {
    const gone = id !== undefined && /No such (container|object)/i.test(String(e?.message ?? ""));
    return { refusal: gone ? "verified container gone" : "not inspected", problem: problem("inspect", e) };
  }
  try { [info] = JSON.parse(text); } catch { return { refusal: "not inspected", problem: "inspect: unparseable output" }; }
  if (!info || typeof info !== "object") return { refusal: "not inspected", problem: "inspect: unparseable output" };
  if (typeof info.Id !== "string" || !containerId.test(info.Id) || (id !== undefined && info.Id !== id) || info.Name !== `/${name}`
    || owned(info.Config?.Labels) !== true) {
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
// the container. `verified` is the one ownership check the command relied on (ownedContainer's
// result); the receipt never resolves the name again. For a refusal it keeps the command's own
// evidence and that refusal and queries nothing. For a verified ID it reads that ID only, and
// only while it is still this run's: allowlisted inspect state and its events' actions and
// times; if the ID is gone it records that and queries nothing else. With `fresh` (a detached
// start, whose only check is the one taken for this receipt) that check's inspect snapshot is the
// state, and it is not inspected again. Each probe is bounded and read-only; a probe failure is
// recorded in the receipt, never thrown.
export async function failureReceipt(docker, { stage, container, error, verified, owned, fresh = false }) {
  const lifetime = error?.lifetime ?? null;
  const receipt = { schema: "catalog-command-failure/v1", stage, container, id: verified?.id ?? null, recordedAt: new Date().toISOString(),
    error: firstLine(error), exit: error?.exit ?? null, outputError: error?.outputError ?? null, outputCloseError: error?.outputCloseError ?? null,
    signalError: error?.signalError ?? null, spawnError: error?.spawnError ?? null, lifetime, refusal: null, inspect: null, events: null, diagnosticErrors: [] };
  if (!verified?.id) {
    receipt.refusal = verified?.refusal ?? "not verified";
    if (verified?.problem) receipt.diagnosticErrors.push(verified.problem);
    return receipt;
  }
  const probe = (args) => docker(args, { cleanup: true, timeout: 10000 });
  const found = fresh && verified.info ? verified : await ownedContainer(probe, container, owned, { id: verified.id });
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
