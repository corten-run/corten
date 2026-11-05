import assert from "node:assert/strict";
import { test } from "node:test";
import { maxPasses, passFile, passesOf, spread, withinNoise } from "./passes.mjs";

test("a round runs one pass unless it asks for more, up to the most allowed", () => {
  assert.equal(passesOf(undefined), 1);
  assert.equal(passesOf(""), 1);
  assert.equal(passesOf("3"), 3);
  assert.equal(passesOf("5"), 5);
  for (const bad of ["0", "-1", "2", "4", "2.5", "x", String(maxPasses + 1)]) assert.throws(() => passesOf(bad), /passes must be/);
});

test("pass 1 writes the file a one-pass round writes, later passes their own", () => {
  assert.equal(passFile("corten-sat64", 1), "corten-sat64");
  assert.equal(passFile("corten-json-fixed", 3), "corten-json-fixed-p3");
});

test("the passes' median is one a pass measured, with their range", () => {
  assert.deepEqual(spread([30, 10, 20]), { median: 20, min: 10, max: 30 });
  assert.deepEqual(spread([40, 10, 20, 30]), { median: 20, min: 10, max: 40 }, "the lower middle of an even count");
  assert.deepEqual(spread([null, 5, undefined, NaN]), { median: 5, min: 5, max: 5 });
  assert.equal(spread([null]), null);
});

test("two apps are within noise when their ranges overlap, and only with two passes each", () => {
  const a = spread([100, 110, 105]);
  assert.equal(withinNoise(a, 3, spread([108, 120, 115]), 3), true);
  assert.equal(withinNoise(a, 3, spread([111, 120, 115]), 3), false);
  assert.equal(withinNoise(a, 3, spread([108]), 1), null, "one run has no range");
  assert.equal(withinNoise(null, 3, a, 3), null);
});
