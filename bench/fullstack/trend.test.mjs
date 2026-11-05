import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics, report, trendOf } from "./trend.mjs";

const instructions = /** @type {const} */ ({ better: "lower", noise: 0.01 });
const throughput = /** @type {const} */ ({ better: "higher", noise: 0.1 });
/** @param {number} start @param {number} step a share a round @param {number} n */
const drifting = (start, step, n) => Array.from({ length: n }, (_, i) => start * (1 + step) ** i);

test("a 5% worsening each round is a drift by the third round of instructions", () => {
  const values = drifting(100_000, 0.05, 3);
  assert.equal(trendOf(values.slice(0, 2), 0, instructions).verdict, "ok", "one round worse is not yet a drift");
  assert.equal(trendOf(values, 0, instructions).verdict, "drift");
});

test("one noisy round, however far off, is not a drift; the rounds after it are back", () => {
  const values = [100_000, 100_200, 115_000, 99_900, 100_100];
  assert.equal(trendOf(values.slice(0, 3), 0, instructions).verdict, "ok");
  assert.equal(trendOf(values, 0, instructions).verdict, "ok");
});

test("a step that stays (a regression merged once) is a drift once it has held two rounds", () => {
  assert.equal(trendOf([100_000, 100_100, 104_000], 0, instructions).verdict, "ok");
  assert.equal(trendOf([100_000, 100_100, 104_000, 104_100], 0, instructions).verdict, "drift");
});

test("a noisy number needs a larger sustained move: 5% a round of throughput is a drift only after its noise is used up", () => {
  const falling = drifting(14_000, -0.05, 8);
  const verdicts = falling.map((_, i) => trendOf(falling.slice(0, i + 1), 0, throughput).verdict);
  assert.deepEqual(verdicts.slice(0, 5), ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(verdicts[5], "drift", "by the sixth round, 23% lower");
  // Swings of 10% either way around the baseline never are.
  const swinging = [14_000, 12_700, 15_300, 12_800, 15_100, 12_900, 15_200];
  assert.equal(trendOf(swinging, 0, throughput).verdict, "ok");
});

test("getting better is never a drift, and a round without the number is passed over", () => {
  assert.equal(trendOf(drifting(100_000, -0.05, 6), 0, instructions).verdict, "ok");
  assert.equal(trendOf([100_000, 105_000, null, 110_000], 0, instructions).verdict, "drift");
  assert.equal(trendOf([null, 105_000, 110_000], 0, instructions).verdict, "ok", "the baseline is the first round that has the number");
  assert.equal(trendOf([null, null], 0, instructions).verdict, "unknown");
});

test("the report names the baseline, the commit range and what drifted, and compares with the recent median", () => {
  const page = metrics.find((m) => m.name === "instructions, item page");
  assert.ok(page);
  const rounds = drifting(100_000, 0.05, 4).map((user, i) => ({
    round: `r${i + 1}`,
    commit: String(i + 1).repeat(40),
    summary: { instructions: { "corten/page": { user } }, bytes: { corten: { html: { gzip: 2384 } } } },
  }));
  const out = report(rounds, "r2");
  assert.equal(out.baseline.round, "r2");
  assert.equal(out.commits, `${"2".repeat(12)}..${"4".repeat(12)}`);
  assert.deepEqual(out.drift, ["instructions, item page"]);
  const row = out.metrics.find((m) => m.name === page.name);
  assert.equal(row.worseThanBaselinePct, 10.25);
  assert.equal(row.worseThanRollingPct, 10.25, "the median of r1-r3 is r2's");
  assert.equal(out.metrics.find((m) => m.name === "page HTML, gzip").verdict, "ok");
  assert.equal(out.metrics.find((m) => m.name === "page JS, gzip").verdict, "unknown");
  // An unknown baseline round falls back to the oldest.
  assert.equal(report(rounds, "r9").baseline.round, "r1");
});

test("a number the machine moves is compared only between rounds on the latest one's CPU", () => {
  const rps = (/** @type {number} */ n) => ({ ssr: { fixture: { corten: { sat64: { rps: n } } } } });
  const rounds = [
    { round: "r1", commit: null, cpu: "fast", summary: rps(20_000) },
    { round: "r2", commit: null, cpu: "slow", summary: rps(14_000) },
    { round: "r3", commit: null, cpu: "slow", summary: rps(14_100) },
    { round: "r4", commit: null, cpu: "slow", summary: rps(13_900) },
  ];
  const row = report(rounds, "r1").metrics.find((m) => m.name === "requests a second, 64 users");
  assert.equal(row.baselineRound, "r2");
  assert.equal(row.verdict, "ok");
});
