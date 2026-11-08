import assert from "node:assert/strict";
import test from "node:test";
import { costs, perCpuSecond } from "./cost-under-load.mjs";

/** A fixed-rate row of ab.mjs's summary. */
const row = (/** @type {string} */ image, /** @type {number} */ round, /** @type {number} */ perCpuSecond, extra = {}) =>
  ({ round, image, target: "page", enc: "identity", phase: "fixed300", perCpuSecond, failed: 0, ...extra });

// as-is: 2,000 and 2,500 a CPU-second (500 and 400 us a request); without the default: 2,500 and
// 3,125 (400 and 320 us).
const rows = [row("cbd-as-is", 1, 2000), row("cbd-no-x", 1, 2500), row("cbd-as-is", 2, 2500), row("cbd-no-x", 2, 3125),
  row("cbd-as-is", 1, 9999, { phase: "vus64" })];

test("each phase is its own group, by build, target, encoding and round", () => {
  const per = perCpuSecond(rows);
  assert.deepEqual([...per.get("as-is\tpage\tidentity\tfixed300") ?? []], [[1, 2000], [2, 2500]]);
  assert.deepEqual([...per.get("as-is\tpage\tidentity\tvus64") ?? []], [[1, 9999]]);
});

test("a default costs the CPU a request takes with it less without it, round by round, with the median and range", () => {
  const cost = costs(rows).find((r) => r.variant === "no-x" && r.phase === "fixed300");
  assert.ok(cost);
  assert.deepEqual([cost.cost, cost.costRange], [90, [80, 100]]);
  assert.deepEqual([cost.rate, cost.rateRange], [2812.5, [2500, 3125]]);
  assert.equal(cost.share, 90 / 450);
});

test("a round with failed requests, an uncounted CPU or a missing as-is round stops it", () => {
  assert.throws(() => costs([row("cbd-as-is", 1, 2000, { failed: 3 })]), /3 failed requests/);
  assert.throws(() => costs([row("cbd-as-is", 1, 0, { perCpuSecond: null })]), /not counted/);
  assert.throws(() => costs([row("cbd-as-is", 1, 2000), row("cbd-no-x", 2, 2500)]), /no run of round 1|round 2 has no as-is run/);
  assert.throws(() => costs([row("cbd-no-x", 1, 2500)]), /no as-is build/);
  // A variant measured at a phase the build as it is was not.
  assert.throws(() => costs([row("cbd-as-is", 1, 2000), row("cbd-no-x", 1, 2500, { phase: "vus64" })]), /no as-is build for page identity vus64/);
});
