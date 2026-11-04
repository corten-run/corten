import { test } from "node:test";
import assert from "node:assert/strict";
import { article, gzipped, keep, phrase } from "./readme-size.mjs";

test("the article is the one the number is read with", () => {
  for (const [kb, want] of [["1.5", "A"], ["8.4", "An"], ["11.2", "An"], ["12.5", "A"], ["18.0", "An"], ["80.0", "An"], ["110.0", "A"], ["118.0", "A"]]) {
    assert.equal(article(kb), want, kb);
  }
});

test("a build writes the phrase and a check holds the README to it", () => {
  const readme = "- **Fast.** A 5.3 KB (gzip) runtime; more.\n";
  const bytes = 11 * 1024; // "An 11.0"
  assert.equal(keep(readme, bytes, false).text, "- **Fast.** An 11.0 KB (gzip) runtime; more.\n");
  assert.match(keep(readme, bytes, true).error ?? "", /says "A 5.3 KB \(gzip\) runtime"/);
  assert.equal(keep("An 11.0 KB (gzip) runtime", bytes, true).error, undefined);
  assert.ok(keep("An 11.1 KB (gzip) runtime", bytes, true).error, "0.1 KB above fails");
  assert.ok(keep("A 10.9 KB (gzip) runtime", bytes, true).error, "0.1 KB below fails");
  assert.ok(keep("A 11.0 KB (gzip) runtime", bytes, true).error, "the wrong article fails");
});

test("a number another zlib could round to passes, and is left as it is", () => {
  const bytes = Math.round(11.05 * 1024) - 10; // rounds to 11.0; 32 bytes more rounds to 11.1
  assert.equal(phrase(bytes), "An 11.0 KB (gzip) runtime");
  const readme = "An 11.1 KB (gzip) runtime";
  assert.equal(keep(readme, bytes, true).error, undefined);
  assert.equal(keep(readme, bytes, false).text, readme, "a build does not flip it back");
  // Two builds on either side of a step, each written after the other: the README stays.
  const [low, high] = [Math.round(11.05 * 1024) - 16, Math.round(11.05 * 1024) + 16];
  assert.notEqual(phrase(low), phrase(high));
  for (const [first, second] of [[low, high], [high, low]]) {
    const written = /** @type {string} */ (keep("A 1.0 KB (gzip) runtime", first, false).text);
    assert.equal(keep(written, second, false).text, written, `${first} then ${second}`);
  }
});

test("a README without the phrase, with two, or with a malformed number, is refused", () => {
  for (const readme of ["A 11..2 KB (gzip) runtime", "A . KB (gzip) runtime", "DATA 11.0 KB (gzip) runtime", "An 11.0 KB (gzip)\nruntime", "An 11.0 KB (brotli) runtime", "An 11.0 KB (gzip) runtime, An 11.0 KB (gzip) runtime"]) {
    assert.ok(keep(readme, 11 * 1024, true).error, readme);
    assert.ok(keep(readme, 11 * 1024, false).error, readme);
  }
});

test("the phrase is the runtime's gzip size in KB of 1,024 bytes", () => {
  assert.equal(phrase(gzipped(new Uint8Array(0))), "A 0.0 KB (gzip) runtime");
});
