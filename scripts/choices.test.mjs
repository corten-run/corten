import { test } from "node:test";
import assert from "node:assert/strict";
import { premises, problems } from "./choices.mjs";

const head = "# Design\n\n## Choices\n\n1. measured: a number.\n2. platform: a browser.\n\n";
const tail = "\n## Rules\n\n1. **Not a Choice.** No trailer.\n";
const choice = (/** @type {number} */ n, /** @type {string} */ stands, revisit = "Revisit when: a browser ships it.") =>
  `${n}. **Choice ${n}.** Why.\n   More of why.\n\n   Stands on: ${stands}\n\n   ${revisit}\n`;

test("a Choice with both paragraphs and listed kinds passes", () => {
  const text = head + choice(1, "measured (a count; it held); platform (a\n   browser).") + "\n" + choice(2, "platform (an engine).") + tail;
  assert.deepEqual(problems(text).problems, []);
  assert.equal(problems(text).count, 2);
});

test("a Choice missing either paragraph fails", () => {
  const none = head + "1. **Choice 1.** Why.\n" + tail;
  assert.match(problems(none).problems.join(), /does not end with/);
  const noRevisit = head + "1. **Choice 1.** Why.\n\n   Stands on: measured (a count).\n" + tail;
  assert.match(problems(noRevisit).problems.join(), /does not end with/);
  const swapped = head + "1. **Choice 1.** Why.\n\n   Revisit when: later.\n\n   Stands on: measured (a count).\n" + tail;
  assert.match(problems(swapped).problems.join(), /does not end with/);
});

test("a kind the section does not list, or a premise that says nothing, fails", () => {
  assert.match(problems(head + choice(1, "hunch (it feels right).") + tail).problems.join(), /kind "hunch"/);
  assert.match(problems(head + choice(1, "measured.") + tail).problems.join(), /does not say what it is/);
});

test("Choices out of order fail, and the Rules after them are not read", () => {
  const text = head + choice(2, "measured (a count).") + "\n" + choice(1, "measured (a count).") + tail;
  assert.equal(problems(text).problems.filter((p) => /in order/.test(p)).length, 2);
});

test("a premise's semicolons inside parentheses do not split it", () => {
  assert.deepEqual(premises("bet (a; b); measured (c)."), ["bet (a; b)", "measured (c)"]);
});
