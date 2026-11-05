// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { quiet } from "./steady.mjs";

/** A console message as Playwright gives one. */
const message = (/** @type {string} */ type, /** @type {string} */ text) => ({ type: () => type, text: () => text });

test("a console listener is not told of a resource ERR_NETWORK_CHANGED aborted, and is told of the rest (#904)", () => {
  const page = quiet(new EventEmitter());
  /** @type {string[]} */
  const errors = [];
  const listen = (/** @type {ReturnType<typeof message>} */ m) => errors.push(`${m.type()}: ${m.text()}`);
  page.on("console", listen);
  page.emit("console", message("error", "Failed to load resource: net::ERR_NETWORK_CHANGED"));
  page.emit("console", message("error", "Failed to load resource: net::ERR_CONNECTION_REFUSED"));
  page.emit("console", message("error", "Failed to load resource: net::ERR_NETWORK_CHANGED, and more"));
  page.emit("console", message("log", "Failed to load resource: net::ERR_NETWORK_CHANGED"));
  assert.deepEqual(errors, [
    "error: Failed to load resource: net::ERR_CONNECTION_REFUSED",
    "error: Failed to load resource: net::ERR_NETWORK_CHANGED, and more",
    "log: Failed to load resource: net::ERR_NETWORK_CHANGED",
  ]);
  // Removed by the listener the smoke gave, and other events are untouched.
  page.off("console", listen);
  page.emit("console", message("error", "after"));
  assert.equal(errors.length, 3);
  /** @type {unknown[]} */
  const other = [];
  page.on("pageerror", (/** @type {unknown} */ e) => other.push(e));
  page.emit("pageerror", "Failed to load resource: net::ERR_NETWORK_CHANGED");
  assert.deepEqual(other, ["Failed to load resource: net::ERR_NETWORK_CHANGED"]);
});
