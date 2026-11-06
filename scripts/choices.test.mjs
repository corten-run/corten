import { test } from "node:test";
import assert from "node:assert/strict";
import { premises, problems } from "./choices.mjs";

const head = "# Design\n\n## Choices\n\n1. measured: a number.\n2. platform: a browser.\n3. value: a value.\n\n";
const tail = "\n## Rules\n\n1. **Not a Choice.** No trailer.\n";
const later = "Revisit when: a browser ships the feature this choice works around.";
const checked = "Last checked: 2026-11-06, probed in Chromium 156; 2026-10-21, one run at `e8bc9236`.";
const choice = (/** @type {number} */ n, /** @type {string} */ stands, revisit = later, last = checked) =>
  `${n}. **Choice ${n}.** Why.\n   More of why.\n\n   Stands on: ${stands}\n\n   ${revisit}\n\n   ${last}\n`;
const today = "2026-11-06";
const found = (/** @type {string} */ text) => problems(text, today).problems.join("\n");

test("a Choice with all three paragraphs and listed kinds passes", () => {
  const text = head + choice(1, "measured, one run (a count; it held); platform (a\n   browser); value (Values 2).") + "\n" + choice(2, "platform (an engine).") + tail;
  assert.deepEqual(problems(text, today).problems, []);
  assert.equal(problems(text, today).count, 2);
});

test("a Choice missing any of the three paragraphs, or with them out of order, fails", () => {
  assert.match(found(head + "1. **Choice 1.** Why.\n" + tail), /does not end with/);
  assert.match(found(head + "1. **Choice 1.** Why.\n\n   Stands on: measured (a count).\n" + tail), /does not end with/);
  const unchecked = `1. **Choice 1.** Why.\n\n   Stands on: measured (a count).\n\n   ${later}\n`;
  assert.match(found(head + unchecked + tail), /does not end with/);
  const swapped = `1. **Choice 1.** Why.\n\n   ${later}\n\n   Stands on: measured (a count).\n\n   ${checked}\n`;
  assert.match(found(head + swapped + tail), /does not end with/);
  const early = `1. **Choice 1.** Why.\n\n   Stands on: measured (a count).\n\n   ${checked}\n\n   ${later}\n`;
  assert.match(found(head + early + tail), /does not end with/);
});

test("each Last checked entry starts with a real date no later than today and names a commit or versions", () => {
  const last = (/** @type {string} */ line) => found(head + choice(1, "measured (a count).", later, line) + tail);
  assert.equal(last("Last checked: 2026-11-06, Firefox 157 and WebKit 27.2; 2026-11-04, hyper 1.12.0."), "");
  assert.equal(last("Last checked: 2026-11-05, round r15 (median of 10) on `ec10c8fb1f2d`."), "");
  assert.match(last("Last checked: recently, at `e8bc9236`."), /does not start with a date/);
  assert.match(last("Last checked: 2026-02-30, at `e8bc9236`."), /does not exist/);
  assert.match(last("Last checked: 2026-11-07, at `e8bc9236`."), /after today/);
  assert.match(last("Last checked: 2026-11-06, read again."), /no commit/);
  assert.match(last("Last checked: 2026-11-06, median 57.5 to 53.8 us."), /no commit/);
  assert.equal(last("Last checked: 2026-11-06, OpenAPI 3.1.1."), "");
  assert.match(last("Last checked: 2026-11-06, at e8bc9236."), /no commit/);
  assert.match(last("Last checked: 2026-11-06, at `e8bc9236`; read again."), /does not start with a date/);
  assert.match(last("Last checked: 2026-11-06 (at `e8bc9236`; 2026-11-05, Chromium 156."), /unbalanced/);
  assert.match(last("Last checked: 2026-11-06, at `e8bc9236`;; 2026-11-05, Chromium 156."), /empty one/);
  assert.match(last("Last checked: ."), /no entry/);
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
  const twice = `1. **Choice 1.** Why.\n\n   ${checked}\n\n   More.\n\n   Stands on: measured (x).\n\n   ${later}\n\n   ${checked}\n`;
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
