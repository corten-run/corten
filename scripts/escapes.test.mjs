import { test } from "node:test";
import assert from "node:assert/strict";
import { problems } from "./escapes.mjs";

const js = (/** @type {string} */ text) => problems("a.js", text).length;

test("an any in a JSDoc type is found, alone or inside another type", () => {
  assert.equal(js("/** @param {any} x */"), 1);
  assert.equal(js("const h = /** @type {Record<string, any>} */ ({});"), 1);
  assert.equal(js("/** @returns {{ a: any }} */"), 1);
  assert.equal(js("/** @type {(...args: any[]) => void} */"), 1);
  assert.equal(js("/** @param {...any} args */"), 1);
  assert.equal(problems("a.d.ts", "export declare const z: any;").length, 1);
});

test("the word any in prose, a name or a comment is not", () => {
  assert.equal(js("/** Works for any row. @param {number} n */"), 0);
  assert.equal(js("const ok = (n) => n; // any"), 0);
  assert.equal(js("/** @type {{ anyOf: string, company: number }} */"), 0);
  assert.equal(problems("a.d.ts", "  /** The view of a row, if any. */\n  at(i: number): V | undefined; // or any").length, 0);
});

test("a comment that turns the checker off is found", () => {
  assert.equal(js("// @ts-ignore"), 1);
  assert.equal(js("// @ts-nocheck"), 1);
  assert.equal(js("// @ts-expect-error a fixture's line"), 1);
});
