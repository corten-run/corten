import { test } from "node:test";
import assert from "node:assert/strict";
import { classes, problems, unlisted } from "./escapes.mjs";
import { parseFiles } from "./typescript.mjs";

test("a batched parse isolates files with the same basename and preserves declaration/JSDoc types", () => {
  const files = [
    { file: "one/a.js", text: "/** @type {any} */ let bad;" },
    { file: "two/a.js", text: "/** @type {number} */ let good;" },
    { file: "types/a.d.ts", text: "export declare const bad: any;" },
  ];
  assert.deepEqual(parseFiles(files, (file, text, source) => [file, source.text === text]), files.map(({ file }) => [file, true]));
});

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
  // JSDoc's own spellings of it.
  assert.equal(js("/** @type {*} */\nlet s;"), 1);
  assert.equal(js("/** @type {?} */\nlet u;"), 1);
  assert.equal(js("/** @type {Array<?>} */\nlet u;"), 1);
});

test("the word any in prose, a name, a string or a comment is not", () => {
  assert.equal(js("/** Works for any row. @param {number} n */\nconst ok = (n) => n; // any"), 0);
  assert.equal(js("/** @type {{ anyOf: string, company: number }} */\nlet o;"), 0);
  assert.equal(js('/** @type {"any" | "all"} */\nlet s;'), 0);
  assert.equal(js('const q = "any";'), 0);
  assert.equal(js("/** @type {?number} */\nlet n;"), 0);
  assert.equal(problems("a.d.ts", "/* any\n   more any */\n/** The view of a row, if any. */\nexport declare function at(i: number): number; // or any").length, 0);
});

test("a comment that turns the checker off is found, and the same words elsewhere are not", () => {
  assert.equal(js("// @ts-ignore\nconst a = 1;"), 1);
  assert.equal(js("// @ts-nocheck\nconst a = 1;"), 1);
  assert.equal(js("const a = 1;\n// @ts-expect-error a fixture's line\nconst b = 2;"), 1);
  assert.equal(js("/* @ts-ignore */ const a = 1;"), 1);
  assert.equal(js("const a = 1; // @ts-ignore\nconst b = 2;"), 1);
  assert.equal(js("const a = 1; /* @ts-expect-error */\nconst b = 2;"), 1);
  assert.equal(js("x(); // @ts-nocheck"), 1);
  assert.equal(js("function f() { return /* @ts-ignore */; }"), 1);
  assert.equal(js("const n = 1;\n// @ts-ignore"), 1);
  assert.equal(js("/**\n * Text.\n * @ts-ignore\n */\nconst a = 1;"), 1);
  // TypeScript reads these as directives too: no word boundary after the name, any run of / and *.
  assert.equal(js("// @ts-ignored because\nconst a = 1;"), 1);
  assert.equal(js("// @ts-expect-errors\nconst a = 1;"), 1);
  assert.equal(js("/*/ @ts-ignore */\nconst a = 1;"), 1);
  assert.equal(js("/**/ // @ts-ignore\nconst a = 1;"), 1);
  // Prose that names one is not one.
  assert.equal(js("// A fixture marks the line with @ts-expect-error.\nconst a = 1;"), 0);
  assert.equal(js('const a = "// @ts-ignore";\nconst r = /\\/\\/ @ts-ignore/;'), 0);
});

test("a class is found declared, as an expression and nested, named or anonymous, and a function is not one", () => {
  assert.deepEqual(classes("a.js", "export class A extends Error {}"), ["a.js: A"]);
  assert.deepEqual(classes("a.js", 'customElements.define("x-y", class extends HTMLElement {});'), ["a.js: <x-y>"]);
  // Comments and spacing in the call leave the entry as it is.
  assert.deepEqual(classes("a.js", 'customElements /* keep */ . define("x-y", class extends HTMLElement {});'), ["a.js: <x-y>"]);
  // Another element in the same file is another entry, so it cannot take the listed one's place.
  assert.deepEqual(classes("a.js", 'customElements.define("x-z", class extends HTMLElement {});'), ["a.js: <x-z>"]);
  assert.deepEqual(classes("a.js", 'other.define("x-y", class extends HTMLElement {});\nconst k = class anonymous {};'), ["a.js: anonymous", "a.js: anonymous"]);
  assert.deepEqual(classes("a.js", "const B = class Named {};\nfunction f() { return class { m() { return new (class C {})(); } }; }"), ["a.js: Named", "a.js: anonymous", "a.js: C"]);
  assert.deepEqual(classes("a.js", "/** A class of rows. */\nfunction Row() {}\nconst klass = 1; // class Fake {}\nconst s = \"class D {}\";"), []);
});

test("a class's field written through a this no cast types is found, however it is written", () => {
  const writes = (/** @type {string} */ body) => js(`/** @typedef {{ a: number }} F */\nclass A { a = 0; m() { ${body} } }`);
  assert.equal(writes("this.a = 1;"), 1);
  assert.equal(writes("(this).a = 1;"), 1);
  assert.equal(writes('this["a"] = 1;'), 1);
  assert.equal(writes("this.a += 1;"), 1);
  assert.equal(writes("this.a ??= 1;"), 1);
  assert.equal(writes("this.a++;"), 1);
  assert.equal(writes("--this.a;"), 1);
  assert.equal(writes("delete this.a;"), 1);
  assert.equal(writes("[this.a] = [1];"), 1);
  assert.equal(writes("({ a: this.a } = { a: 1 });"), 1);
  assert.equal(writes("[...this.a] = [1];"), 1);
  assert.equal(writes("[this.a = 2] = [];"), 1);
  assert.equal(writes("const f = () => { this.a = 1; };"), 1);
  assert.equal(writes("for (this.a of [1]);"), 1);
  assert.equal(writes("for (this.a in {});"), 1);
  assert.equal(writes("Object.assign(this, { a: 1 });"), 1);
  assert.equal(writes("Object.defineProperty((this), \"a\", { value: 1 });"), 1);
  assert.equal(writes("Reflect.set(this, \"a\", 1);"), 1);
  // A writer's keys are checked by no type of its target, so a typed this is refused too.
  assert.equal(writes('Object["assign"](this, { a: 1 });'), 1);
  assert.equal(writes("(Object.assign)(this, { a: 1 });"), 1);
  assert.equal(writes("Object[`assign`](this, { a: 1 });"), 1);
  assert.equal(writes("((Object)).assign(this, { a: 1 });"), 1);
  // A method a @this tag types has its field writes checked by tsc, but not a writer call's keys.
  assert.equal(js("/** @typedef {{ a: number }} F */\nclass A {\n  a = 0;\n  /** @this {F} */\n  m() { Object.assign(this, { b: 1 }); }\n}"), 1);
  assert.equal(writes("Object.assign(/** @type {F} */ (this), { a: 1 });"), 1);
  // In a class nested in an object's method, the class's own body is still the class's.
  assert.equal(js("const s = { go() { return class B { b = 0; m() { this.b = 1; } }; } };"), 1);
  // A @this tag in a block TypeScript does not read (not the last before the method) types nothing.
  assert.equal(js("/** @typedef {{ a: number }} F */\nclass A {\n  a = 0;\n  /** @this {F} */\n  /** Describe it. */\n  m() { this.a = 1; }\n}"), 1);
  assert.equal(js("class A { a = 0; get b() { this.a = 1; return 1; } set b(v) { this.a = v; } }"), 2);
  // A computed method name is read with the class's this.
  assert.equal(js("class A { a = 0; m() { const o = { [this.a = 1]() {} }; return o; } }"), 1);
  assert.equal(js('customElements.define("x-y", class extends HTMLElement { connectedCallback() { this.source = 1; } });'), 1);
  // Through a typedef of the fields, a read, a call, another object, or a function's own this: not one.
  assert.equal(writes("/** @type {F} */ (this).a = 1;"), 0);
  assert.equal(writes("/** @type {F} */ (this).a++;"), 0);
  assert.equal(writes("const b = this.a; this.m(); other.a = 1; const g = function () { this.a = 1; };"), 0);
  assert.equal(js("function f() { this.a = 1; }\nconst o = { m() { this.a = 1; } };"), 0);
  // An object literal's method or accessor in a class has the object's this, and an arrow in it too.
  assert.equal(writes("const s = { count: 0, inc() { this.count++; const f = () => { this.count = 2; }; }, get c() { return this.count; }, set c(v) { this.count = v; } }; s.inc();"), 0);
  // A method whose this a @this tag types: tsc checks its writes.
  assert.equal(js("/** @typedef {{ a: number }} F */\nclass A {\n  a = 0;\n  /** @this {F} */\n  m() { this.a++; this.a = 1; }\n}"), 0);
  assert.equal(js("/** @typedef {{ a: number }} F */\nclass A {\n  a = 0;\n  /** A method. */\n  m() { this.a = 1; }\n}"), 1);
  assert.equal(writes("for (const x of [1]) x; for (const k in {}) k; Object.assign({}, this); other.assign(this, {});"), 0);
  // A computed key names a variable, not the writer: here a read.
  assert.equal(writes('const assign = "keys"; Object[assign](this);'), 0);
  assert.equal(js("/** @typedef {{ a: number }} F */\nclass A {\n  a = 0;\n  /** Describe it. */\n  /** @this {F} */\n  m() { this.a = 1; }\n}"), 0);
  // tsc checks a #private name itself.
  assert.equal(js("class A { #count = 0; run() { this.#count++; this.#count = 2; return this.#count; } }"), 0);
  // A class's extends has the this around the class: here the object's.
  assert.equal(js("export const s = { count: 0, go() { return class B extends ((this.count = 1), Object) {}; } };"), 0);
});

test("the classes found are held to the list, counting repeats", () => {
  assert.deepEqual(unlisted(["a.js: A", "b.js: anonymous"], ["b.js: anonymous", "a.js: A"]), { added: [], gone: [] });
  assert.deepEqual(unlisted(["a.js: A", "a.js: anonymous", "a.js: anonymous"], ["a.js: anonymous", "a.js: B"]), { added: ["a.js: A", "a.js: anonymous"], gone: ["a.js: B"] });
});
