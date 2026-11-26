// The statistic and its bounds on hand-worked cases, and the sizing check against the figures the
// placement sizing kit recorded (docs/design.md#choice-placement-runs, "How many placements").
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gauss, rng } from "./model.mjs";
import { DRAWS, eligibility, failing, LIMIT, SEED, sizeByRule } from "./pilot.mjs";
import { shuffled } from "./schedule.mjs";
import { readPilot } from "./size.mjs";
import { across, margin, MARGIN, median, ord, pct, placement, resolution, upperRank, win } from "./stats.mjs";
import { blobs } from "./tags.mjs";

const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-12, `${what ?? ""} ${got} is not ${want}`);

test("the bound's rank is the smallest j with P(Binomial(K, 1/2) >= j) <= 5%", () => {
  // Item 2's own: the 20th of 30, the 59th of 100.
  assert.equal(upperRank(30), 20);
  assert.equal(upperRank(100), 59);
  // K = 5: P(>= 5) = 1/32 = 3.1%, P(>= 4) = 6/32: the 5th. K = 4: P(>= 4) = 1/16 = 6.25%: none.
  assert.equal(upperRank(5), 5);
  assert.equal(upperRank(4), 5);
  // K = 8: P(>= 7) = 9/256 = 3.5%, P(>= 6) = 37/256 = 14.5%: the 7th.
  assert.equal(upperRank(8), 7);
  // The exact tail, summed with whole numbers, for every K the pads allow.
  for (let K = 5; K <= 254; K++) {
    let c = 1n, tail = 0n, j = K + 1;
    const total = 1n << BigInt(K), terms = [];
    for (let i = 0; i <= K; i++) { terms.push(c); c = (c * BigInt(K - i)) / BigInt(i + 1); }
    for (let k = K; k >= 0; k--) { if ((tail + terms[k]) * 20n > total) break; tail += terms[k]; j = k; }
    assert.equal(upperRank(K), j, `K = ${K}`);
  }
});

test("a placement's statistic is the median of its pairs' changes, B / A - 1", () => {
  const p = placement([100, 100, 100, 200], [101, 99, 104, 206]);
  // Changes +1%, -1%, +4%, +3%: median +2%. Swapped: -0.990%, +1.010%, -3.846%, -2.913%.
  near(p.median, 0.02);
  near(p.swapped, (100 / 101 - 1 + (200 / 206 - 1)) / 2);
  near(p.min, -0.01);
  near(p.max, 0.04);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("across placements: the median of the medians, the j-th smallest and the (K + 1 - j)-th", () => {
  // Thirty medians, -15 to +14 in thousandths: the 20th smallest is +4, the 11th is -5.
  const thirty = Array.from({ length: 30 }, (_, i) => (i - 15) / 1000).reverse();
  const a = across(thirty);
  assert.deepEqual([a.K, a.rank, a.lowerRank], [30, 20, 11]);
  near(a.bound, 0.004);
  near(a.lower, -0.005);
  near(a.median, -0.0005);
  near(a.min, -0.015);
  near(a.max, 0.014);
  // Five: the bound is the largest and the lower bound the smallest.
  const five = across([0.002, -0.001, 0.012, 0.0, 0.003]);
  assert.deepEqual([five.rank, five.lowerRank, five.bound, five.lower, five.median], [5, 1, 0.012, -0.001, 0.002]);
  // Four placements have no rank, so no bound.
  const four = across([0.001, 0.002, 0.003, 0.004]);
  assert.deepEqual([four.rank, four.bound, four.lower], [null, null, null]);
  assert.equal(pct(0.012), "+1.20%");
  assert.equal(pct(-0.0005), "-0.05%");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 42, 59, 101, 111].map(ord), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "42nd", "59th", "101st", "111th"]);
});

test("an A/A resolves when both readings' bounds are under +1%; either at or above it does not", () => {
  const b = (bound, lower = -0.002) => ({ bound, lower });
  assert.equal(MARGIN, 0.01);
  assert.equal(resolution(b(0.004), b(0.006)), "resolved");
  assert.equal(resolution(b(0.004), b(0.01)), "not resolved");
  assert.equal(resolution(b(0.0100001), b(0.001)), "not resolved");
  assert.equal(resolution(b(null), b(0.001)), "no bound");
  assert.equal(resolution(null, b(0.001)), "no bound");
});

test("the margin: under +1% with a resolved A/A meets it; nothing else passes", () => {
  assert.equal(margin({ bound: 0.0099 }, "resolved"), "meets +1%");
  assert.equal(margin({ bound: 0.01 }, "resolved"), "misses +1%");
  assert.equal(margin({ bound: -0.05 }, "not resolved"), "not resolved: does not pass");
  assert.equal(margin({ bound: -0.05 }, "no bound"), "the A/A has no bound: does not pass");
  assert.equal(margin({ bound: null }, "resolved"), "no bound: does not pass");
});

test("a win needs the change's bound at or below minus the reduction and the A/A's lower bound above it in both readings", () => {
  const aa = (bound, lower) => ({ bound, lower });
  assert.equal(win({ bound: -0.02 }, aa(0.003, -0.004), aa(0.004, -0.003), 0.02), "reduction established");
  assert.equal(win({ bound: -0.019 }, aa(0.003, -0.004), aa(0.004, -0.003), 0.02), "reduction not established");
  assert.equal(win({ bound: -0.03 }, aa(0.003, -0.02), aa(0.004, -0.003), 0.02), "the A/A's lower bound is not above minus the reduction: no win");
  assert.equal(win({ bound: -0.03 }, aa(0.003, -0.004), aa(0.004, -0.021), 0.02), "the A/A's lower bound is not above minus the reduction: no win");
  assert.equal(win({ bound: -0.03 }, aa(0.012, -0.004), aa(0.004, -0.003), 0.02), "not resolved: no win");
  assert.equal(win({ bound: -0.03 }, aa(null, null), aa(0.004, -0.003), 0.02), "the A/A has no bound: no win");
  assert.equal(win({ bound: null }, aa(0.003, -0.004), aa(0.004, -0.003), 0.02), "no bound: no win");
});

test("eligibility: complete, no drift over the run's order, zero inside the interval", () => {
  // Medians that rise through the run are not alike over time.
  const rising = Array.from({ length: 40 }, (_, i) => (i - 20) / 2000 + (i % 3) / 10000);
  const r = eligibility({ complete: true, medians: rising });
  assert.equal(r.spearmanOk, false);
  assert.equal(r.eligible, false);
  // The same values in steps of 17 places: no trend, but each is tied to the one before it.
  const stepped = eligibility({ complete: true, medians: rising.map((_, i) => rising[(i * 17) % 40]) });
  assert.deepEqual([stepped.lag1Ok, stepped.spearmanOk, stepped.eligible], [false, true, false]);
  // The same values in a shuffled order, centred on zero.
  const mixed = shuffled(40, rng(3)).map((i) => rising[i - 1]);
  const m = eligibility({ complete: true, medians: mixed });
  assert.deepEqual([m.lag1Ok, m.spearmanOk, m.zero.inside, m.eligible], [true, true, true, true]);
  assert.deepEqual(m.zero.ranks, [15, 26]);
  assert.equal(eligibility({ complete: false, medians: mixed }).eligible, false);
  // All of them above zero: zero is outside the interval.
  const off = eligibility({ complete: true, medians: mixed.map((x) => x + 0.02) });
  assert.deepEqual([off.zero.inside, off.eligible], [false, false]);
  // The normal model is kept unless a test rejects normality at 5%: forty normal draws keep
  // both models, and the same draws skewed keep the smoothed resample alone.
  const u = rng(5), bell = Array.from({ length: 40 }, () => 0.005 * gauss(u));
  assert.deepEqual(eligibility({ complete: true, medians: bell }).models, ["normal", "smoothed"]);
  assert.deepEqual(eligibility({ complete: true, medians: bell.map((x) => Math.exp(400 * x) / 100) }).models, ["smoothed"]);
});

// The fourth run's A/A (tag evidence/placement-sizing-1999, results/aa-old, 100 placements of 8
// pairs), read by the sizing kit's own readPilot from the files as the tag keeps them.
test("the sizing check gives the counts the Choice quotes from the fourth run's A/A", () => {
  const files = blobs("evidence/placement-sizing-1999", "placement-sizing-1999/results/aa-old", (p) => /^p\d+\/(counts-old\.csv|placement\.txt)$/.test(p));
  assert.equal(files.size, 200);
  const dir = mkdtempSync(join(tmpdir(), "placement-sizing-"));
  let placements;
  try {
    for (const [p, b] of files) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), b); }
    placements = readPilot(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(placements.length, 100);
  assert.ok(placements.every((p) => p.changes.length === 8));
  const pilot = placements.map((p) => [median(p.changes), median(p.swapped)]);
  // In run order (each placement.txt's seq), as eligibility reads them.
  const seq = (name) => Number(/^seq (\d+)$/m.exec(files.get(`${name}/placement.txt`).toString("utf8"))[1]);
  const inOrder = placements.map((p, i) => ({ seq: seq(p.name), median: pilot[i][0] })).sort((a, b) => a.seq - b.seq).map((x) => x.median);
  const e = eligibility({ complete: true, medians: inOrder });
  assert.equal(e.eligible, true);
  assert.equal((100 * e.sd).toFixed(2), "2.05");
  assert.deepEqual(e.zero.ranks, [42, 59]);
  // Normality is rejected, so the smoothed resample alone is kept.
  assert.deepEqual(e.models, ["smoothed"]);
  assert.deepEqual([DRAWS, SEED, LIMIT], [200000, 1983, 10000]);
  // "the normal model fails in 9,037 of 200,000 draws at 91 (the 54th of 91) and 10,823 at 92
  // (the 55th), and the smoothed resample in 9,996 at 69 and 12,134 at 70."
  assert.deepEqual(failing(pilot, ["normal"], 91), [{ model: "normal", failing: 9037, rank: 54 }]);
  assert.deepEqual(failing(pilot, ["normal"], 92), [{ model: "normal", failing: 10823, rank: 55 }]);
  // The rule over those two K's: 69 passes; a larger K, 70, does not.
  const s = sizeByRule(pilot, e.models, { from: 69, to: 70 });
  assert.equal(s.K, 69);
  assert.deepEqual(s.at, [{ model: "smoothed", failing: 9996, rank: 42 }]);
  const none = sizeByRule(pilot, e.models, { from: 70, to: 70 });
  assert.equal(none.K, null);
  assert.deepEqual(none.tried, [{ K: 70, counts: [{ model: "smoothed", failing: 12134, rank: 43 }] }]);
  // Under each model kept: at 69 the smoothed resample passes and the normal model does not, so
  // were both kept 69 would not be a K. Each K tried is handed on as the scan goes.
  const seen = [], both = sizeByRule(pilot, ["normal", "smoothed"], { from: 69, to: 69, each: (t) => seen.push(t.K) });
  assert.deepEqual(both.tried[0].counts.map((c) => c.failing <= LIMIT), [false, true]);
  assert.equal(both.K, null);
  assert.deepEqual(seen, [69]);
});
