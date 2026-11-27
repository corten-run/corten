// One instance of the item API for mixed.test.mjs, in a worker thread the test terminates: loaded
// from its unchanged file with the argv and SLOW_MS the test starts this worker with, then driven
// on the test's messages. With `held`, every timer it sets, from startup on, through the global or
// node:timers setTimeout, is held until the test releases it and tied to the request whose
// handling set it, and each answer's every send is recorded with the held timer whose callback (or
// anything that callback started) made it. After each message, by the next check of the event
// loop, it posts what it holds: its timers and its answers. Without `held` it only listens.
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { ServerResponse } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const http = require("node:http");
const { file, held } = workerData;
/** The request whose handling is running, and the held timer whose callback is running. */
const requests = new AsyncLocalStorage();
const running = new AsyncLocalStorage();
/** @type {{ id: number, ms: number, by: string | null, cleared: boolean, released: boolean, run: () => void }[]} */
const timers = [];

if (held) {
  const timer = (/** @type {(...a: any[]) => void} */ callback, /** @type {number} */ ms, /** @type {any[]} */ ...args) => {
    const one = { id: timers.length + 1, ms, by: requests.getStore() ?? null, cleared: false, released: false, run: () => callback(...args) };
    timers.push(one);
    // Shaped enough as Node's Timeout for a server to keep, ref, unref or clear it.
    return { ref() { return this; }, unref() { return this; }, hasRef: () => true, refresh() { return this; }, close() { one.cleared = true; return this; }, [Symbol.toPrimitive]: () => one.id };
  };
  const clear = (/** @type {any} */ handle) => {
    const id = handle == null ? NaN : Number(handle);
    for (const one of timers) if (one.id === id) one.cleared = true;
  };
  const timersModule = require("node:timers");
  globalThis.setTimeout = timersModule.setTimeout = /** @type {any} */ (timer);
  globalThis.clearTimeout = timersModule.clearTimeout = clear;
}
/** @type {((req: any, res: any) => void) | undefined} */
let handler;
/** @type {import("node:http").Server | undefined} */
let server;
const { createServer } = http;
http.createServer = (/** @type {any[]} */ ...a) => {
  handler = a.find((arg) => typeof arg === "function");
  return (server = createServer(...a));
};
syncBuiltinESMExports();
// Its "listening" line kept out of the test's output.
console.log = () => {};

/** @type {Map<string, { res: ServerResponse, sends: { name: string, timer: number | null }[], chunks: Buffer[] }>} */
const answers = new Map();
const state = () => ({
  timers: timers.map(({ id, ms, by, cleared, released }) => ({ id, ms, by, cleared, released })),
  answers: Object.fromEntries(
    [...answers].map(([key, { res, sends, chunks }]) => [key, { sends, status: res.statusCode, body: Buffer.concat(chunks).toString(), ended: res.writableEnded }]),
  ),
});
/** Its handling, as `key`, of a request for `url`, every send recorded. */
const ask = (/** @type {string} */ key, /** @type {string} */ url) => {
  const req = { method: "GET", url, headers: {}, httpVersionMajor: 1, httpVersionMinor: 1 };
  const res = new ServerResponse(/** @type {any} */ (req));
  const answer = { res, sends: /** @type {{ name: string, timer: number | null }[]} */ ([]), chunks: /** @type {Buffer[]} */ ([]) };
  answers.set(key, answer);
  for (const name of /** @type {const} */ (["writeHead", "flushHeaders", "write", "end"])) {
    const own = /** @type {(...a: any[]) => any} */ (res[name]);
    /** @type {any} */ (res)[name] = function (/** @type {any[]} */ ...a) {
      answer.sends.push({ name, timer: running.getStore() ?? null });
      if ((name === "write" || name === "end") && (typeof a[0] === "string" || a[0] instanceof Uint8Array)) answer.chunks.push(Buffer.from(a[0]));
      return own.apply(this, a);
    };
  }
  requests.run(key, () => /** @type {NonNullable<typeof handler>} */ (handler)(req, res));
};
/** Runs held timer `id`'s callback, once, as its own. */
const release = (/** @type {number} */ id) => {
  const one = timers.find((timer) => timer.id === id);
  if (!one || one.cleared || one.released) throw new Error(`timer ${id} is not held`);
  one.released = true;
  running.run(id, one.run);
};

await import(file);
if (!server || !handler) throw new Error("it made no server with a handler");
if (!server.listening) await once(server, "listening");
parentPort?.on("message", ({ re, op, key, url, id }) => {
  try {
    if (op === "ask") ask(key, url);
    else release(id);
  } catch (error) {
    parentPort?.postMessage({ re, error: String(/** @type {Error} */ (error)?.stack ?? error) });
    return;
  }
  setImmediate(() => parentPort?.postMessage({ re, ...state() }));
});
parentPort?.postMessage({ re: 0, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port, ...state() });
