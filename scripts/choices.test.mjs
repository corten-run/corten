import { test } from "node:test";
import assert from "node:assert/strict";
import { premises, problems } from "./choices.mjs";

const head = "# Design\n\n## Choices\n\n1. measured: a number.\n2. platform: a browser.\n3. value: a value.\n\n";
const tail = "\n## Rules\n\n1. **Not a Choice.** No trailer.\n";
const later = "Revisit when: a browser ships the feature this choice works around.";
const choice = (/** @type {number} */ n, /** @type {string} */ stands, revisit = later) =>
  `${n}. **Choice ${n}.** Why.\n   More of why.\n\n   Stands on: ${stands}\n\n   ${revisit}\n`;
const found = (/** @type {string} */ text) => problems(text).problems.join("\n");

test("a Choice with both paragraphs and listed kinds passes", () => {
  const text = head + choice(1, "measured, one run (a count; it held); platform (a\n   browser); value (Values 2).") + "\n" + choice(2, "platform (an engine).") + tail;
  assert.deepEqual(problems(text).problems, []);
  assert.equal(problems(text).count, 2);
});

test("a Choice missing either paragraph fails", () => {
  assert.match(found(head + "1. **Choice 1.** Why.\n" + tail), /does not end with/);
  assert.match(found(head + "1. **Choice 1.** Why.\n\n   Stands on: measured (a count).\n" + tail), /does not end with/);
  const swapped = `1. **Choice 1.** Why.\n\n   ${later}\n\n   Stands on: measured (a count).\n`;
  assert.match(found(head + swapped + tail), /does not end with/);
});

test("a Stands on with no premise, or a Revisit when with no condition, fails", () => {
  assert.match(found(head + choice(1, ".") + tail), /names no premise/);
  assert.match(found(head + choice(1, "measured (a count).", "Revisit when: no") + tail), /names no condition/);
});

test("a kind the section does not list, or a premise that says nothing, fails", () => {
  assert.match(found(head + choice(1, "hunch (it feels right).") + tail), /kind "hunch"/);
  assert.match(found(head + choice(1, "measured.") + tail), /does not say what it is/);
  assert.match(found(head + choice(1, "measured ( ).") + tail), /does not say what it is/);
  assert.match(found(head + choice(1, "measured x (y).") + tail), /does not say what it is/);
});

test("unbalanced parentheses, an open code span or a missing semicolon cannot hide a premise", () => {
  assert.match(found(head + choice(1, "measured (x) `; hunch (y).") + tail), /unbalanced/);
  assert.match(found(head + choice(1, "measured (x), hunch (y).") + tail), /does not say what it is/);
  assert.match(found(head + choice(1, "measured (x) and value (y); platform (z).") + tail), /does not say what it is/);
  assert.match(found(head + choice(1, "measured (x; hunch (y).") + tail), /unbalanced/);
  assert.match(found(head + choice(1, "measured x); hunch (y).") + tail), /unbalanced/);
});

test("the values come last, and there may be more than one", () => {
  assert.match(found(head + choice(1, "value (Values 1); measured (a count).") + tail), /values come last/);
  assert.equal(found(head + choice(1, "measured (x); value (Values 1); value (Values 2).") + tail), "");
});

test("an empty premise, or a second pair of paragraphs, fails", () => {
  assert.match(found(head + choice(1, "measured (x);; platform (y).") + tail), /empty one/);
  const twice = `1. **Choice 1.** Why.\n\n   Stands on: measured (x).\n\n   ${later}\n\n   More.\n\n   Stands on: measured (x).\n\n   ${later}\n`;
  assert.match(found(head + twice + tail), /more than one/);
});

test("Choices out of order, or a numbered item without a bold title, fail", () => {
  const text = head + choice(2, "measured (a count).") + "\n" + choice(1, "measured (a count).") + tail;
  assert.equal(problems(text).problems.filter((p) => /in order/.test(p)).length, 2);
  const plain = head + choice(1, "measured (a count).") + "\n2. A choice.\n" + tail;
  assert.match(found(plain), /without a bold title/);
});

test("a premise's semicolons inside parentheses do not split it", () => {
  assert.deepEqual(premises("bet (a; b); measured (c)."), ["bet (a; b)", "measured (c)"]);
  assert.equal(premises("bet (a"), null);
  assert.deepEqual(premises("platform (`f(` is a call; ok)."), ["platform (`f(` is a call; ok)"]);
});
