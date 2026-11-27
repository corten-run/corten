import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { physical } from "./evidence.mjs";
import { hostObservationBytes } from "./host-observation.mjs";
import { limits } from "./process.mjs";

// Allow one writer deadline of 100 ms samples, subject to both payload limits.
export const storageLimits = Object.freeze({ bytes: hostObservationBytes, queuedBytes: 8 * 2 ** 20, frames: 300, records: 4096 });
const sampleBatchFrames = 16, sampleBatchBytes = 256 * 2 ** 10;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every((key) => a[key] === b[key]);
const codes = new Set(["ENOENT", "EEXIST", "EACCES", "EPERM", "EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "ETIMEDOUT", "ERR_ASSERTION"]);
const failures = new WeakMap();
const startupReaders = new Map();

// Only diagnostics created by this writer may be copied into a campaign halt.
export const hostStorageFailure = (error) => failures.get(error);

// Only the current command's startup is tracked. Take the diagnostic once
// when supervision returns, even if the writer still owns outstanding I/O.
export function trackHostStorageStartup(directory) {
  assert.ok(!startupReaders.has(directory));
  const startup = {};
  startupReaders.set(directory, startup);
  return (timedOut) => {
    startupReaders.delete(directory);
    return startup.read?.(timedOut);
  };
}

/** One FIFO; credits include the in-flight frame until its writes finish. */
export function hostDurableWriter(directory) {
  const processes = join(directory, "processes");
  const directories = new Map([directory, processes].map((path) => [physical(path), lstatSync(path)]));
  const handles = new Set(), records = new Map();
  let file, error, operation = "sample-open", closing = false, finalizing = false, complete = false, active = false, cleanup;
  let cancelled, interruptedStage;
  let bytes = 0, queuedBytes = 0, frames = 0, pendingRecords = 0, samples = 0;
  let tail, pendingBatch;
  const startup = startupReaders.get(directory);
  if (startup) startup.read = (timedOut) => hostStorageFailure(error)
    ?? (timedOut && interruptedStage ? Object.freeze({ operation: interruptedStage, code: "ETIMEDOUT" }) : undefined);
  function fail(cause, at = operation, limit) {
    if (cancelled && cause === cancelled) return error ?? cancelled;
    if (!error) {
      const code = cause?.code;
      const diagnostic = Object.freeze({ operation: at, code: codes.has(code) ? code : "unknown", ...(limit ? { limit } : {}) });
      error = Object.assign(new Error("host observation storage incomplete"), diagnostic);
      failures.set(error, diagnostic);
    }
    return error;
  }
  function timeout(at = active ? operation : "storage-wait") { return error ?? cancelled ?? fail({ code: "ETIMEDOUT" }, at); }
  function overLimit(limit) { return fail({ code: "ERR_ASSERTION" }, "storage-admission", limit); }
  function healthy() { if (error || cancelled) throw error ?? cancelled; }
  async function opened(path, flags) {
    const handle = await open(path, flags, 0o600); handles.add(handle); return handle;
  }
  async function close(handle) {
    await handle.close(); handles.delete(handle);
  }
  async function guardDirectory(path) {
    const before = directories.get(path), after = await lstat(path);
    assert.ok(after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino);
    assert.equal(await realpath(path), path);
  }
  async function guardFile(handle, path) {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.nlink === 1);
    assert.ok(same(info, await lstat(path)), "host observation file replaced");
    return info;
  }
  async function syncDirectory(path, closeOperation) {
    const syncOperation = operation;
    await guardDirectory(path); healthy();
    if (process.platform === "win32") return;
    const handle = await opened(path, "r");
    try { healthy(); await handle.sync(); healthy(); }
    catch (cause) { throw fail(cause); }
    finally { operation = closeOperation; await close(handle); }
    operation = syncOperation;
    await guardDirectory(path);
  }
  async function write(handle, data) {
    let offset = 0;
    while (offset < data.length) {
      healthy();
      const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
      assert.ok(Number.isSafeInteger(bytesWritten) && bytesWritten > 0 && bytesWritten <= data.length - offset);
      offset += bytesWritten;
    }
    healthy();
  }
  async function timed(action) {
    active = true;
    const start = performance.now();
    const timer = setTimeout(() => { timeout(operation); stop(); }, limits.readyMs);
    try {
      healthy(); await action();
      if (performance.now() - start > limits.readyMs) timeout(operation);
      healthy();
    } catch (cause) { fail(cause); stop(); }
    finally { clearTimeout(timer); active = false; }
  }
  function stop() {
    closing = true;
    pendingBatch = undefined;
    // Neither a rejected wait nor a timeout cancels an outstanding filesystem
    // operation. Its chain retains ownership and closes handles once it returns.
    cleanup ??= tail.then(async () => {
      for (const handle of handles) {
        try { await close(handle); } catch (cause) { fail(cause, "storage-close"); }
      }
    });
    return cleanup;
  }
  async function wait(promise) {
    let timer;
    const start = performance.now();
    try {
      await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => { reject(timeout()); stop(); }, limits.readyMs);
      })]);
      if (performance.now() - start > limits.readyMs) timeout();
      healthy();
    } finally { clearTimeout(timer); }
  }
  tail = timed(async () => {
    await guardDirectory(directory); healthy();
    file = await opened(join(directory, "samples.jsonl"), "wx");
    healthy(); await guardFile(file, join(directory, "samples.jsonl"));
  });
  const ready = tail;
  return Object.freeze({
    ready: () => wait(ready),
    has: (key) => records.has(key),
    get error() { return error; },
    get settled() { pendingBatch = undefined; return cleanup ?? tail; },
    state() { return { bytes, queuedBytes, frames, pendingRecords, samples, openFiles: handles.size, complete,
      pendingOwnership: active || frames !== 0 || handles.size !== 0, error: hostStorageFailure(error) ?? null }; },
    enqueue(initial, sample) {
      try {
        healthy(); assert.equal(closing, false); assert.equal(typeof sample, "string");
        const keys = new Set();
        const entries = initial.map(({ key, value }) => {
          assert.match(key, /^[a-f0-9]{64}$/); assert.equal(typeof value, "string");
          assert.ok(!keys.has(key) && !records.has(key)); keys.add(key);
          return { key, value };
        });
        const size = Buffer.byteLength(sample) + entries.reduce((n, entry) => n + Buffer.byteLength(entry.value), 0);
        if (bytes + size > storageLimits.bytes) throw overLimit("total-bytes");
        if (queuedBytes + size > storageLimits.queuedBytes) throw overLimit("queued-bytes");
        if (frames + 1 > storageLimits.frames) throw overLimit("queued-frames");
        if (pendingRecords + entries.length > storageLimits.records) throw overLimit("queued-records");
        bytes += size; queuedBytes += size; frames++; pendingRecords += entries.length;
        for (const { key, value } of entries) records.set(key, digest(value));
        if (!entries.length && pendingBatch && pendingBatch.samples.length < sampleBatchFrames
          && pendingBatch.size + size <= sampleBatchBytes) {
          pendingBatch.samples.push(sample);
          pendingBatch.size += size;
          return;
        }
        // Only the last, not-yet-started sample batch can grow. Schedule it
        // immediately; an active append, record or wait boundary is never crossed.
        const batch = { samples: [sample], size };
        pendingBatch = entries.length ? undefined : batch;
        tail = tail.then(() => timed(async () => {
          if (pendingBatch === batch) pendingBatch = undefined;
          for (const { key, value } of entries) {
            operation = "process-record-write";
            await guardDirectory(processes); healthy();
            const path = join(processes, `${key}.json`), handle = await opened(path, "wx");
            try {
              await write(handle, Buffer.from(value)); await guardFile(handle, path);
              operation = "process-record-sync"; healthy(); await handle.sync(); healthy();
              await guardFile(handle, path);
            } catch (cause) { throw fail(cause); }
            finally { operation = "process-record-close"; await close(handle); }
            operation = "process-directory-sync"; await syncDirectory(processes, "process-directory-close"); healthy();
          }
          operation = "sample-write";
          await guardDirectory(directory); await guardFile(file, join(directory, "samples.jsonl"));
          const data = batch.samples.length === 1 ? Buffer.from(sample)
            : Buffer.concat(batch.samples.map((value) => Buffer.from(value)), batch.size);
          await write(file, data); samples += batch.samples.length;
        })).finally(() => { queuedBytes -= batch.size; frames -= batch.samples.length; pendingRecords -= entries.length; });
      } catch (cause) { const failure = fail(cause, "storage-admission"); stop(); throw failure; }
    },
    drain() { pendingBatch = undefined; return wait(tail); },
    abort() {
      if (!cancelled) {
        if (startup && active) interruptedStage = operation;
        cancelled = new Error("host observation storage cancelled");
      }
      return stop();
    },
    async finish() {
      assert.equal(finalizing, false); finalizing = true; closing = true;
      if (!error && !cancelled) tail = tail.then(() => timed(async () => {
        operation = "sample-sync"; healthy(); await guardFile(file, join(directory, "samples.jsonl"));
        await file.sync(); healthy();
        operation = "sample-close"; await close(file);
        operation = "sample-directory-sync"; await syncDirectory(directory, "sample-directory-close"); healthy();
        operation = "process-record-verify";
        for (const [key, expected] of records) {
          await guardDirectory(processes); healthy();
          const path = join(processes, `${key}.json`), handle = await opened(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const before = await guardFile(handle, path), value = await handle.readFile();
            assert.equal(digest(value), expected, "initial host observation record mutated");
            assert.ok(same(before, await guardFile(handle, path))); healthy();
          } catch (cause) { throw fail(cause); }
          finally { operation = "process-record-close"; await close(handle); }
          operation = "process-record-verify";
        }
      }));
      try {
        await wait(tail); await wait(stop()); healthy(); complete = true;
        return { bytes, samples };
      } catch (cause) { const failure = fail(cause); stop(); throw failure; }
    },
  });
}
