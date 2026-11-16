import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { physical } from "./evidence.mjs";
import { limits } from "./process.mjs";

export const storageLimits = Object.freeze({ bytes: 256 * 2 ** 20, queuedBytes: 8 * 2 ** 20, frames: 64, records: 4096 });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every((key) => a[key] === b[key]);
const codes = new Set(["ENOENT", "EEXIST", "EACCES", "EPERM", "EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "ETIMEDOUT", "ERR_ASSERTION"]);

/** One FIFO; credits include the in-flight frame until its writes finish. */
export function hostDurableWriter(directory) {
  const processes = join(directory, "processes");
  const directories = new Map([directory, processes].map((path) => [physical(path), lstatSync(path)]));
  const handles = new Set(), records = new Map();
  let file, error, operation = "sample-open", closing = false, finalizing = false, complete = false, active = false, cleanup;
  let bytes = 0, queuedBytes = 0, frames = 0, pendingRecords = 0, samples = 0;
  let tail;
  function fail(cause, at = operation) {
    if (!error) error = Object.assign(new Error("host observation storage incomplete"), {
      code: codes.has(cause?.code) ? cause.code : "unknown", operation: at,
    });
    return error;
  }
  function healthy() { if (error) throw error; }
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
  async function syncDirectory(path) {
    await guardDirectory(path); healthy();
    if (process.platform === "win32") return;
    const handle = await opened(path, "r");
    try { healthy(); await handle.sync(); healthy(); }
    finally { await close(handle); }
    await guardDirectory(path);
  }
  async function write(handle, value) {
    const data = Buffer.from(value); let offset = 0;
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
    const timer = setTimeout(() => { fail({ code: "ETIMEDOUT" }, "storage-timeout"); stop(); }, limits.readyMs);
    try {
      healthy(); await action();
      if (performance.now() - start > limits.readyMs) fail({ code: "ETIMEDOUT" }, "storage-timeout");
      healthy();
    } catch (cause) { fail(cause); stop(); }
    finally { clearTimeout(timer); active = false; }
  }
  function stop() {
    closing = true;
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
        timer = setTimeout(() => { reject(fail({ code: "ETIMEDOUT" }, "storage-timeout")); stop(); }, limits.readyMs);
      })]);
      if (performance.now() - start > limits.readyMs) fail({ code: "ETIMEDOUT" }, "storage-timeout");
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
    get settled() { return cleanup ?? tail; },
    state() { return { bytes, queuedBytes, frames, pendingRecords, samples, openFiles: handles.size, complete,
      pendingOwnership: active || frames !== 0 || handles.size !== 0, error: error ? { code: error.code, operation: error.operation } : null }; },
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
        assert.ok(bytes + size <= storageLimits.bytes, "host observation byte bound exceeded");
        assert.ok(queuedBytes + size <= storageLimits.queuedBytes && frames + 1 <= storageLimits.frames
          && pendingRecords + entries.length <= storageLimits.records, "host observation queue bound exceeded");
        bytes += size; queuedBytes += size; frames++; pendingRecords += entries.length;
        for (const { key, value } of entries) records.set(key, digest(value));
        tail = tail.then(() => timed(async () => {
          for (const { key, value } of entries) {
            operation = "process-record-write";
            await guardDirectory(processes); healthy();
            const path = join(processes, `${key}.json`), handle = await opened(path, "wx");
            try {
              await write(handle, value); await guardFile(handle, path);
              operation = "process-record-sync"; healthy(); await handle.sync(); healthy();
              await guardFile(handle, path);
            } finally { await close(handle); }
            operation = "process-directory-sync"; await syncDirectory(processes); healthy();
          }
          operation = "sample-write";
          await guardDirectory(directory); await guardFile(file, join(directory, "samples.jsonl"));
          await write(file, sample); samples++;
        })).finally(() => { queuedBytes -= size; frames--; pendingRecords -= entries.length; });
      } catch (cause) { fail(cause, "storage-admission"); stop(); throw error; }
    },
    drain() { return wait(tail); },
    abort() { fail(null, "storage-abort"); return stop(); },
    async finish() {
      assert.equal(finalizing, false); finalizing = true; closing = true;
      if (!error) tail = tail.then(() => timed(async () => {
        operation = "sample-sync"; healthy(); await guardFile(file, join(directory, "samples.jsonl"));
        await file.sync(); healthy(); await close(file);
        operation = "sample-directory-sync"; await syncDirectory(directory); healthy();
        operation = "process-record-verify";
        for (const [key, expected] of records) {
          await guardDirectory(processes); healthy();
          const path = join(processes, `${key}.json`), handle = await opened(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const before = await guardFile(handle, path), value = await handle.readFile();
            assert.equal(digest(value), expected, "initial host observation record mutated");
            assert.ok(same(before, await guardFile(handle, path))); healthy();
          } finally { await close(handle); }
        }
      }));
      try {
        await wait(tail); await wait(stop()); healthy(); complete = true;
        return { bytes, samples };
      } catch (cause) { fail(cause); stop(); throw error; }
    },
  });
}
