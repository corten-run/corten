import { test } from "node:test";
import assert from "node:assert/strict";
import { article, keep, phrase } from "./readme-size.mjs";

test("the article is the one the number is read with", () => {
  for (const [kb, want] of [["1.5", "A"], ["8.4", "An"], ["11.2", "An"], ["12.5", "A"], ["18.0", "An"], ["80.0", "An"], ["110.0", "A"], ["118.0", "A"]]) {
    assert.equal(article(kb), want, kb);
  }
});

test("a build writes the phrase and a check holds the README to it", () => {
  const readme = "- **Fast.** A 5.3 KB (gzip) runtime; more.\n";
  const want = "An 11.0 KB (gzip) runtime";
  assert.equal(keep(readme, want, false).text, "- **Fast.** An 11.0 KB (gzip) runtime; more.\n");
  assert.match(keep(readme, want, true).error ?? "", /says "A 5.3 KB \(gzip\) runtime"/);
  assert.equal(keep("An 11.0 KB (gzip) runtime", want, true).error, undefined);
  assert.equal(keep("An 11.1 KB (gzip) runtime", want, true).error, undefined, "0.1 KB off passes");
  assert.ok(keep("An 11.2 KB (gzip) runtime", want, true).error, "0.2 KB off fails");
  assert.ok(keep("A 11.0 KB (gzip) runtime", want, true).error, "the wrong article fails");
});

test("a README without the phrase, or with a malformed number, is refused", () => {
  for (const readme of ["A 11..2 KB (gzip) runtime", "A . KB (gzip) runtime", "DATA 11.0 KB (gzip) runtime", "An 11.0 KB (gzip)\nruntime", "An 11.0 KB (brotli) runtime"]) {
    assert.ok(keep(readme, "An 11.0 KB (gzip) runtime", true).error, readme);
  }
});

test("the phrase is the runtime's gzip size in KB of 1,024 bytes", () => {
  assert.match(phrase(new Uint8Array(0)), /^A 0\.0 KB \(gzip\) runtime$/);
});
