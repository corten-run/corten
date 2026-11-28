// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { gateInitialLoad, steady } from "./steady.mjs";

/** A console message as Playwright gives one. */
const message = (/** @type {string} */ type, /** @type {string} */ text) => ({ type: () => type, text: () => text });
const ABORTED = "Failed to load resource: net::ERR_NETWORK_CHANGED";

/** A page, context and browser that emit events as Playwright's do: on the page object. */
class Page extends EventEmitter {
  async goto() {}
  async reload() {}
}
function browser() {
  const context = Object.assign(new EventEmitter(), {
    // Without the "page" event Playwright sends first, so `steady`'s own `quiet` is what filters
    // it; a popup below comes with the event alone.
    async newPage() {
      return new Page();
    },
  });
  return { context, browser: /** @type {any} */ ({ newContext: async () => context }) };
}

test("a page steady opens tells no console listener of a resource ERR_NETWORK_CHANGED aborted, and tells the rest (#904)", async () => {
  const { context, browser: plain } = browser();
  const page = /** @type {Page} */ (await (await steady(plain).newContext()).newPage());
  /** @type {string[]} */
  const errors = [];
  const listen = (/** @type {ReturnType<typeof message>} */ m) => errors.push(`${m.type()}: ${m.text()}`);
  page.on("console", listen);
  // `waitForEvent` listens with `addListener` and stops with `removeListener`; `once` must
  // outlast the line it is not told of.
  /** @type {string[]} */
  const first = [];
  page.once("console", (/** @type {ReturnType<typeof message>} */ m) => first.push(m.text()));
  page.emit("console", message("error", ABORTED));
  page.emit("console", message("error", "Failed to load resource: net::ERR_CONNECTION_REFUSED"));
  page.emit("console", message("error", `${ABORTED}, and more`));
  page.emit("console", message("log", ABORTED));
  assert.deepEqual(errors, [
    "error: Failed to load resource: net::ERR_CONNECTION_REFUSED",
    `error: ${ABORTED}, and more`,
    `log: ${ABORTED}`,
  ]);
  assert.deepEqual(first, ["Failed to load resource: net::ERR_CONNECTION_REFUSED"]);
  page.removeListener("console", listen);
  page.emit("console", message("error", "after"));
  assert.equal(errors.length, 3, "removed by the listener the smoke gave");
  /** @type {unknown[]} */
  const other = [];
  page.addListener("pageerror", (/** @type {unknown} */ e) => other.push(e));
  page.emit("pageerror", ABORTED);
  assert.deepEqual(other, [ABORTED], "other events are untouched");
  // A page that opens itself (a popup) in the same context is filtered too.
  const popup = new Page();
  context.emit("page", popup);
  /** @type {string[]} */
  const popped = [];
  popup.on("console", (/** @type {ReturnType<typeof message>} */ m) => popped.push(m.text()));
  popup.emit("console", message("error", ABORTED));
  popup.emit("console", message("error", "real"));
  assert.deepEqual(popped, ["real"]);
});

test("the WebKit gate releases only the initial HTTP navigation and keeps its options and result", async () => {
  const url = "http://localhost:18482/orders";
  /** @type {Parameters<import("@playwright/test").Page["goto"]>[1]} */
  const options = { timeout: 30_000, waitUntil: "load" };
  const response = {};
  /** @type {unknown[]} */
  const calls = [];
  /** @type {((route: Pick<import("@playwright/test").Route, "fallback">) => Promise<void>) | undefined} */
  let release;
  const page = gateInitialLoad(/** @type {any} */ ({
    url: () => "about:blank",
    isClosed: () => false,
    async route(/** @type {(url: URL) => boolean} */ match, /** @type {NonNullable<typeof release>} */ handler, /** @type {unknown} */ limits) {
      assert.equal(match(new URL(url)), true);
      assert.equal(match(new URL(`${url}/other`)), false);
      assert.deepEqual(limits, { times: 1 });
      calls.push("route");
      release = handler;
    },
    async unroute(/** @type {unknown} */ _match, /** @type {typeof release} */ handler) {
      assert.equal(handler, release);
      calls.push("unroute");
      release = undefined;
    },
    async goto(/** @type {string} */ to, /** @type {unknown} */ opts) {
      calls.push(to);
      assert.equal(opts, options);
      await release?.({ fallback: async () => { calls.push("fallback"); } });
      return response;
    },
  }));
  assert.equal(await page.goto("about:blank", options), response);
  assert.equal(await page.goto(`${url}#meter`, options), response);
  assert.equal(await page.goto(url, options), response);
  assert.deepEqual(calls, ["about:blank", "route", `${url}#meter`, "fallback", "unroute", url]);
});

test("steady gates both fresh tabs in the same context only on Linux WebKit", async () => {
  for (const name of ["webkit", "chromium", "firefox"]) {
    let routed = 0;
    const context = Object.assign(new EventEmitter(), {
      async newPage() {
        return Object.assign(new Page(), {
          url: () => "about:blank",
          isClosed: () => false,
          async route() { routed++; },
          async unroute() {},
        });
      },
    });
    const plain = /** @type {import("@playwright/test").Browser} */ (/** @type {unknown} */ ({
      browserType: () => ({ name: () => name }),
      newContext: async () => context,
    }));
    const opened = await steady(plain, { gateInitialWebKitLoad: true }).newContext();
    for (let tab = 0; tab < 2; tab++) {
      const page = await opened.newPage();
      await page.goto("http://localhost:18482/orders");
    }
    assert.equal(routed, process.platform === "linux" && name === "webkit" ? 2 : 0, name);
  }
});

test("the WebKit gate cleans up after a navigation that times out without retrying it", async () => {
  const failure = new Error("Timeout 30000ms exceeded");
  const calls = [];
  const page = gateInitialLoad(/** @type {any} */ ({
    url: () => "about:blank",
    isClosed: () => false,
    async route() { calls.push("route"); },
    async goto() { calls.push("goto"); throw failure; },
    async unroute() { calls.push("unroute"); },
  }));
  await assert.rejects(page.goto("http://localhost:18482/orders"), (error) => error === failure);
  assert.deepEqual(calls, ["route", "goto", "unroute"]);
});

test("the WebKit gate times out stalled route setup without starting navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const page = gateInitialLoad(/** @type {any} */ ({
    url: () => "about:blank",
    isClosed: () => false,
    route() { calls.push("route"); return new Promise(() => {}); },
    async goto() { calls.push("goto"); },
    async unroute() { calls.push("unroute"); },
  }));
  // Fail the assertion instead of hanging if the fake command still blocks after the tick.
  const result = Promise.race([page.goto("http://localhost:18482/orders"), nextTurn()]);
  t.mock.timers.tick(5000);
  await assert.rejects(result, /WebKit gate route setup timed out/);
  assert.deepEqual(calls, ["route", "unroute"]);
});

for (const navigationFails of [true, false]) {
  test(`stalled WebKit gate cleanup ${navigationFails ? "preserves the navigation error" : "fails a successful navigation clearly"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const failure = new Error("Timeout 30000ms exceeded");
    const { promise: cleaning, resolve: startedCleanup } = Promise.withResolvers();
    const page = gateInitialLoad(/** @type {any} */ ({
      url: () => "about:blank",
      isClosed: () => false,
      async route() {},
      async goto() { if (navigationFails) throw failure; },
      unroute() { startedCleanup(undefined); return new Promise(() => {}); },
    }));
    const result = Promise.race([page.goto("http://localhost:18482/orders"), nextTurn()]);
    assert.equal(await Promise.race([cleaning.then(() => true), nextTurn()]), true, "cleanup started");
    t.mock.timers.tick(5000);
    await assert.rejects(result, (error) => {
      if (navigationFails) return error === failure;
      return error instanceof Error && /WebKit gate route cleanup timed out/.test(error.message);
    });
  });
}
