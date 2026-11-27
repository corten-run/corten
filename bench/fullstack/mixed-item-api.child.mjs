// One instance of the item API for mixed.test.mjs, in a child process the test starts with fork and
// kills: its unchanged file loaded with the argv (`<items> 0 1`) and SLOW_MS the test starts this
// process with, then driven on the test's messages over the IPC channel. With MIXED_ITEM_API_HELD=1,
// each timer set through the global or node:timers setTimeout, from startup on, is held until the
// test releases it and tied to the request whose handling (every listener of the server's "request"
// event) set it, and each writeHead, flushHeaders, write and end of an answer is recorded with the
// held timer whose callback, or anything that callback started, made it. Nothing else that waits
// (setInterval, setImmediate, node:timers/promises) is held. Without it, it only listens.
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const http = require("node:http");
const held = process.env.MIXED_ITEM_API_HELD === "1";
/** A message to the test, told apart from the server's own `process.send`. @param {Record<string, unknown>} message */
const post = (message) => process.send?.({ harness: "mixed-item-api", ...message });
/** The request whose handling is running, and the held timer whose callback is running. */
const requests = new AsyncLocalStorage();
const running = new AsyncLocalStorage();
/** @type {{ id: number, ms: number, by: string | null, cleared: boolean, released: boolean, run: () => void }[]} */
const timers = [];
/** Each answer's sends, by the item its request names. @type {Map<string, { name: string, timer: number | null }[]>} */
const sends = new Map();
/** Messages waiting for a timer set by the handling of a request for `by`. @type {{ re: number, by: string }[]} */
const waiters = [];
const state = () => ({ timers: timers.map(({ id, ms, by, cleared, released }) => ({ id, ms, by, cleared, released })), sends: Object.fromEntries(sends) });
/** By the next check of the event loop, answers each waiter whose request has set a timer. */
const settle = () =>
  setImmediate(() => {
    for (const waiter of [...waiters]) {
      if (!timers.some((one) => one.by === waiter.by)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      post({ re: waiter.re, ...state() });
    }
  });
/** The item a request names: the last segment of its path. */
const named = (/** @type {unknown} */ url) => String(url ?? "").split("/").pop() ?? "";

if (held) {
  const timer = (/** @type {(...a: any[]) => void} */ callback, /** @type {number} */ ms, /** @type {any[]} */ ...args) => {
    const one = { id: timers.length + 1, ms, by: requests.getStore() ?? null, cleared: false, released: false, run: () => callback(...args) };
    timers.push(one);
    settle();
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
  const response = /** @type {any} */ (http.ServerResponse.prototype);
  for (const name of ["writeHead", "flushHeaders", "write", "end"]) {
    const own = response[name];
    response[name] = function (/** @type {any[]} */ ...a) {
      const key = named(this.req?.url);
      if (!sends.has(key)) sends.set(key, []);
      sends.get(key)?.push({ name, timer: running.getStore() ?? null });
      return own.apply(this, a);
    };
  }
}
/** @type {import("node:http").Server | undefined} */
let server;
const { createServer } = http;
http.createServer = (/** @type {any[]} */ ...a) => {
  const made = createServer(...a);
  if (held) {
    const emit = made.emit;
    made.emit = function (/** @type {string | symbol} */ event, /** @type {any[]} */ ...rest) {
      return event === "request" ? requests.run(named(rest[0]?.url), () => emit.call(this, event, ...rest)) : emit.call(this, event, ...rest);
    };
  }
  return (server = made);
};
syncBuiltinESMExports();
// Its "listening" line kept out of the test's output.
console.log = () => {};
// Gone with the test, should the test end without killing it.
process.on("disconnect", () => process.exit(0));

/** Runs held timer `id`'s callback, once, as its own. */
const release = (/** @type {number} */ id) => {
  const one = timers.find((timer) => timer.id === id);
  if (!one || one.cleared || one.released) throw new Error(`timer ${id} is not held`);
  one.released = true;
  running.run(id, one.run);
};

const listening = await (async () => {
  try {
    await import(new URL("./item-api/server.mjs", import.meta.url).href);
    if (!server) throw new Error("it made no server");
    if (!server.listening) await once(server, "listening");
    return server;
  } catch (error) {
    post({ re: 0, error: String(/** @type {Error} */ (error)?.stack ?? error) });
  }
})();
if (listening) {
  process.on("message", (/** @type {any} */ message) => {
    const { re, op, by, id } = message ?? {};
    try {
      if (op === "until") {
        waiters.push({ re, by });
        settle();
        return;
      }
      if (op === "release") release(id);
      else if (op !== "state") throw new Error(`no such message: ${op}`);
    } catch (error) {
      post({ re, error: String(/** @type {Error} */ (error)?.stack ?? error) });
      return;
    }
    setImmediate(() => post({ re, ...state() }));
  });
  post({ re: 0, port: /** @type {import("node:net").AddressInfo} */ (listening.address()).port });
}