import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report, roundsIn, trendOf } from "./trend.mjs";

const instructions = /** @type {const} */ ({ better: "lower", noise: 0.01 });
const memory = /** @type {const} */ ({ better: "lower", noise: 0.05 });
/** @param {number} start @param {number} step a share a round @param {number} n */
const drifting = (start, step, n) => Array.from({ length: n }, (_, i) => start * (1 + step) ** i);

test("a 5% worsening each round is a drift by the third round of instructions", () => {
  const values = drifting(100_000, 0.05, 3);
  assert.equal(trendOf(values.slice(0, 2), 0, instructions).verdict, "ok", "one round worse is not yet a drift");
  assert.equal(trendOf(values, 0, instructions).verdict, "drift");
});

test("one noisy round, however far off, is not a drift or a warning, nor are ordinary rounds around the baseline after it", () => {
  const values = [100_000, 100_200, 115_000, 99_600, 100_700, 100_300];
  for (let n = 2; n <= values.length; n += 1) assert.equal(trendOf(values.slice(0, n), 0, instructions).verdict, "ok", `after ${n} rounds`);
});

test("a step that stays (a regression merged once) is a drift once it has held two rounds", () => {
  assert.equal(trendOf([100_000, 100_100, 104_000], 0, instructions).verdict, "ok");
  assert.equal(trendOf([100_000, 100_100, 104_000, 104_100], 0, instructions).verdict, "drift");
});

test("a recent step that holds but has not yet drifted from the baseline is a warning", () => {
  // Memory, 5% noise: the baseline was high, so a 7% step from the recent level is not yet worse than it.
  const values = [17, 16, 16, 16, 17.2, 17.3];
  assert.equal(trendOf(values, 0, memory).verdict, "warn");
  assert.equal(trendOf(values.slice(0, 5), 0, memory).verdict, "ok", "one round is not a warning");
});

test("getting better is never a drift or a warning, and a round without the number is passed over", () => {
  assert.equal(trendOf(drifting(100_000, -0.05, 6), 0, instructions).verdict, "ok");
  assert.equal(trendOf([100_000, 105_000, null, 110_000], 0, instructions).verdict, "drift");
  assert.equal(trendOf([null, 105_000], 0, instructions).verdict, "unknown");
  assert.equal(trendOf([100_000, 105_000, 110_000, null], 0, instructions).verdict, "unknown", "the latest round without it has no verdict");
});

test("an outlier left in the sum does not let a later pair just past the noise become a drift", () => {
  assert.equal(trendOf([100_000, 115_000, 100_000, 101_100, 101_100], 0, instructions).verdict, "ok");
  // The same pair after a real step that held is still a drift.
  assert.equal(trendOf([100_000, 104_000, 104_100, 105_000, 105_100], 0, instructions).verdict, "drift");
});

test("a warning takes a median of at least three rounds and a step of at least 3%", () => {
  // One unusually good round among two cannot set the median.
  assert.equal(trendOf([16.4, 15.4, 16.4, 16.4], 0, memory).verdict, "ok");
  // A 1.5% step past 1% noise is not yet a warning.
  assert.equal(trendOf([100_000, 99_000, 99_500, 100_000, 101_500, 101_500], 1, instructions).verdict, "ok");
});

/** Rounds whose page instructions are `users`, each with a commit and the same HTML. @param {number[]} users */
const roundsOf = (users) =>
  users.map((user, i) => ({
    round: `r${i + 1}`,
    commit: String(i + 1).repeat(40),
    summary: {
      instructions: { "corten/page": { user }, "corten/json": { user: 70_000 } },
      bytes: { corten: { html: { gzip: 2384 }, js: { gzip: 13_155 }, css: { gzip: 2777 } } },
      ssr: { fixture: { corten: { sat64: { memMaxMiB: 16.4, rps: 14_000 - 2_000 * i }, fixed: { perCpuSecond: 5_000 } } } },
    },
  }));

test("the report names each number's baseline round and commit range, and what drifted", () => {
  const out = report(roundsOf(drifting(100_000, 0.05, 4)), { round: "r2" });
  assert.deepEqual(out.drift, ["instructions, item page"]);
  const page = out.metrics.find((m) => m.name === "instructions, item page");
  assert.equal(page.baselineRound, "r2");
  assert.equal(page.commits, `${"2".repeat(12)}..${"4".repeat(12)}`);
  assert.equal(page.worseThanBaselinePct, 10.25);
  assert.equal(page.worseThanRollingPct, null, "no median of fewer than three rounds after the baseline");
  assert.equal(page.baselineSummary, "bench/fullstack/results/r2/summary.json");
  assert.equal(out.metrics.find((m) => m.name === "page HTML, gzip").verdict, "ok");
  // Throughput fell 14% a round here, and is still only shown: its rounds vary by 20%.
  const rps = out.metrics.find((m) => m.name === "requests a second, 64 users");
  assert.equal(rps.verdict, "none");
  // 8,000 a second against r2's 12,000 is a third fewer (not half again as many), and the median
  // of rounds that may have run on other CPUs is left out.
  assert.equal(rps.worseThanBaselinePct, 33.33);
  assert.equal(rps.worseThanRollingPct, null);
});

test("one number's baseline can move on its own, so accepting it does not reset the others", () => {
  const out = report(roundsOf(drifting(100_000, 0.05, 4)), { round: "r1", metrics: { "instructions, item page": { round: "r3", why: "accepted" } } });
  const page = out.metrics.find((m) => m.name === "instructions, item page");
  assert.equal(page.baselineRound, "r3");
  assert.equal(page.baselineWhy, "accepted");
  assert.equal(page.verdict, "ok");
  assert.equal(out.metrics.find((m) => m.name === "page HTML, gzip").baselineRound, "r1");
});

test("a baseline round that is not among the rounds, or lacks the number, is an error, not a fallback", () => {
  assert.throws(() => report(roundsOf([100_000, 101_000]), { round: "r9" }), /the baseline r9 is not among the rounds/);
  const rounds = roundsOf([100_000, 101_000]);
  delete rounds[0].summary.instructions;
  assert.throws(() => report(rounds, { round: "r1" }), /r1 has no "instructions, item page"/);
});

test("a round just collected, with no commit.txt yet, is placed by the commit its images were built from", () => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).stdout.trim();
  const results = mkdtempSync(join(tmpdir(), "trend-"));
  try {
    const round = (/** @type {string} */ name, /** @type {Record<string, string>} */ files) => {
      mkdirSync(join(results, name));
      writeFileSync(join(results, name, "summary.json"), "{}");
      for (const [file, text] of Object.entries(files)) writeFileSync(join(results, name, file), text);
    };
    round("r1", { "commit.txt": `${head}\n` });
    round("r5", { "commit.txt": `${head}\n`, "conformance.json": JSON.stringify({ imagesFrom: `${head}-dirty` }) });
    round("r2", { "conformance.json": JSON.stringify({ imagesFrom: `${head}-dirty` }) });
    round("r3", { "conformance.json": JSON.stringify({ imagesFrom: "unknown" }) });
    round("r4", {});
    assert.deepEqual(roundsIn(results).map((r) => [r.round, r.commit, r.dirty]), [["r1", head, false], ["r2", head, true], ["r5", head, true]]);
  } finally {
    rmSync(results, { recursive: true, force: true });
  }
});
