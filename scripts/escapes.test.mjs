import { test } from "node:test";
import assert from "node:assert/strict";
import { problems } from "./escapes.mjs";

const js = (/** @type {string} */ text) => problems("a.js", text).length;

test("an any in a JSDoc type is found, alone, inside another type or over several lines", () => {
  assert.equal(js("/** @param {any} x */\nconst f = (x) => x;"), 1);
  assert.equal(js("const h = /** @type {Record<string, any>} */ ({});"), 1);
  assert.equal(js("/** @returns {{ a: any }} */\nconst k = () => ({ a: 1 });"), 1);
  assert.equal(js("/** @type {(...args: any[]) => void} */\nlet g;"), 1);
  assert.equal(js("/** @param {...any} args */\nconst f = (...args) => args;"), 1);
  assert.equal(js("/** @type {{ a: { b: string }, c: any }} */\nlet a;"), 1);
  assert.equal(js("/** @type {{ a: string } | any} */\nlet b;"), 1);
  assert.equal(js("/** @type {Array<{x:number}>|any} */\nlet c;"), 1);
  assert.equal(js("/** @this {any} */\nfunction t() {}"), 1);
  assert.equal(js("/**\n * @typedef {{\n *   a: string,\n *   b: any,\n * }} T\n */\nexport {};"), 1);
  assert.equal(js("/** @typedef {object} T\n * @property {any} p */\nexport {};"), 1);
  assert.equal(problems("a.d.ts", "export declare const z: any;").length, 1);
});

test("the word any in prose, a name, a string or a comment is not", () => {
  assert.equal(js("/** Works for any row. @param {number} n */\nconst ok = (n) => n; // any"), 0);
  assert.equal(js("/** @type {{ anyOf: string, company: number }} */\nlet o;"), 0);
  assert.equal(js('/** @type {"any" | "all"} */\nlet s;'), 0);
  assert.equal(js('const q = "any";'), 0);
  assert.equal(problems("a.d.ts", "/* any\n   more any */\n/** The view of a row, if any. */\nexport declare function at(i: number): number; // or any").length, 0);
});

test("a comment that turns the checker off is found, and the same words elsewhere are not", () => {
  assert.equal(js("// @ts-ignore\nconst a = 1;"), 1);
  assert.equal(js("// @ts-nocheck\nconst a = 1;"), 1);
  assert.equal(js("const a = 1;\n// @ts-expect-error a fixture's line\nconst b = 2;"), 1);
  assert.equal(js("/* @ts-ignore */ const a = 1;"), 1);
  assert.equal(js('const a = "// @ts-ignore";\nconst r = /\\/\\/ @ts-ignore/;'), 0);
});
