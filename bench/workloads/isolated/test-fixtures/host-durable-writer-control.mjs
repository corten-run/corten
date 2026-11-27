// Test-owned FileHandle interception. Production has no hooks or alternate paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { hostDurableWriter } from "../host-durable-writer.mjs";

export const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
export const ioError = () => Object.assign(new Error("PRIVATE_STORAGE_DETAIL"), { code: "EIO" });
export const record = (n, value = `${JSON.stringify({ initial: n })}\n`) => ({ key: n.toString(16).padStart(64, "0"), value });

export async function storageControl(t) {
  const temporary = fs.mkdtempSync(join(tmpdir(), "host-durable-writer-")), directory = join(temporary, "host");
  fs.mkdirSync(directory); fs.mkdirSync(join(directory, "processes"));
  const originalOpen = fsp.open, actual = new Map(), nativePlatform = process.platform;
  const f = { directory, temporary, trace: [], live: new Set(), maximumFiles: 0, releases: [], before() {} };
  t.mock.method(fsp, "open", async (path, ...args) => {
    path = String(path); await f.before("open", path, args);
    const handle = nativePlatform === "win32" && fs.existsSync(path) && fs.statSync(path).isDirectory() ? {
      async stat() { return fsp.stat(path); }, async sync() {}, async close() {},
      async write() { throw new Error("not a file"); }, async readFile() { throw new Error("not a file"); },
    } : await originalOpen(path, ...args);
    f.live.add(handle); f.maximumFiles = Math.max(f.maximumFiles, f.live.size);
    const methods = Object.fromEntries(["write", "stat", "sync", "close", "readFile"].map((name) => [name, handle[name].bind(handle)]));
    actual.set(handle, methods);
    for (const name of Object.keys(methods)) t.mock.method(handle, name, async (...values) => {
      f.trace.push({ name, path, phase: "begin", at: Date.now() });
      const result = await f.before(name, path, values, handle);
      const value = result === undefined ? await methods[name](...values) : result;
      if (name === "close") f.live.delete(handle);
      f.trace.push({ name, path, phase: "end", at: Date.now() });
      return value;
    });
    return handle;
  });
  syncBuiltinESMExports();
  f.writer = hostDurableWriter(directory);
  t.after(async () => {
    f.before = () => {}; for (const release of f.releases) release(); f.writer.abort(); await f.writer.settled;
    for (const [handle, methods] of actual) await methods.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep)); fs.rmSync(temporary, { recursive: true });
  });
  await f.writer.ready();
  f.pause = (name, match) => {
    const entered = deferred(), release = deferred(); let used = false;
    f.before = async (operation, path) => {
      if (!used && operation === name && match(path)) { used = true; entered.resolve(); await release.promise; }
    };
    f.releases.push(release.resolve);
    return { entered: entered.promise, release: release.resolve };
  };
  return f;
}
