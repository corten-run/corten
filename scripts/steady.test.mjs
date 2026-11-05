// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { steady } from "./steady.mjs";

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
