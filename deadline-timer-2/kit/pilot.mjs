// pilot.mjs: what plan.md's first part reads from a pilot A/A: whether it is eligible to size a
// run, the models kept, and the K the plan's rule gives. It works with the placement sizing kit's
// own functions (model.mjs and size.mjs, tag evidence/placement-sizing-1999, unchanged here), as
// that kit's report.mjs calls them.
//   node pilot.mjs <results dir>/pilot-<w> [--confirm]
// prints the same figures from the placement directories alone (medians in the order of their
// placement.txt's seq) and, with --confirm, repeats the K found with the call the plan names,
// sizePilot(readPilot(dir), { K: [K], draws: 200000, seed: 1983 }), which also works out that
// kit's "K for at most 5%" lines and so takes minutes.
//
// Eligible (design Choice 72, "How many placements"): every placement read with all its pairs;
// neither the lag-1 autocorrelation of the medians in run order nor Spearman's correlation of
// the medians with run order at p < 0.05, each by permutation (20,000 permutations, seed 1999,
// model.mjs's defaults); and zero inside the interval from the (K + 1 - j)-th to the j-th of the
// sorted medians, j the gate's upper rank (placement.mjs's across).
// Models kept: the smoothed resample of the pilot's medians always; the normal model too unless
// Shapiro-Wilk or Anderson-Darling rejects normality at 5%.
// The rule for K (plan.md): the smallest K from 30 to 254 at which every kept model's count of
// failing draws, Math.round(rate * draws) of 200,000 draws at seed 1983, is at most 10,000, read
// at that K itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { across } from "./placement.mjs";
import { andersonDarling, failRateNormal, failRateSmoothed, median, permutationLag1, permutationSpearman, sd, shapiroWilk } from "./model.mjs";
import { readPilot, sizePilot } from "./size.mjs";

/** medians: the placement medians in run order. */
export function eligibility({ complete, medians }) {
  const K = medians.length;
  const lag1 = K >= 3 ? permutationLag1(medians) : { r1: NaN, p: NaN };
  const spearman = K >= 3 ? permutationSpearman(medians) : { rho: NaN, p: NaN };
  const a = across(medians);
  const zero = { low: a.lower, high: a.bound, ranks: a.rank ? [a.lowerRank, a.rank] : null, inside: a.bound != null ? a.lower <= 0 && 0 <= a.bound : null };
  const sw = shapiroWilk(medians), ad = andersonDarling(medians);
  const lag1Ok = !(lag1.p < 0.05), spearmanOk = !(spearman.p < 0.05), normalOk = !(sw.p < 0.05) && !(ad.p < 0.05);
  return { K, sd: sd(medians), lag1, lag1Ok, spearman, spearmanOk, zero, shapiroWilk: sw, andersonDarling: ad, models: normalOk ? ["normal", "smoothed"] : ["smoothed"], eligible: Boolean(complete) && lag1Ok && spearmanOk && zero.inside === true };
}

/** pilot: [[median, swapped median]] in the order of the placements' indices, as readPilot gives them. */
export function sizeByRule(pilot, models, { from = 30, to = 254, draws = 200000, seed = 1983, limit = 10000 } = {}) {
  const s = sd(pilot.map((x) => x[0])), tried = [];
  for (let K = from; K <= to; K++) {
    const counts = models.map((m) => {
      const r = m === "normal" ? failRateNormal(K, s, draws, seed) : failRateSmoothed(pilot, K, draws, seed);
      return { model: m, failing: Math.round(r.rate * draws), rank: r.rank };
    });
    tried.push({ K, counts });
    if (counts.every((c) => c.failing <= limit)) return { K, at: counts, tried, from, to, draws, seed, limit, sd: s };
  }
  return { K: null, at: null, tried, from, to, draws, seed, limit, sd: s };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2], confirm = process.argv.includes("--confirm");
  if (!dir) { console.error("usage: node pilot.mjs <results dir>/pilot-<w> [--confirm]"); process.exit(2); }
  const pl = readPilot(dir);
  const seq = (p) => { const f = join(dir, p.name, "placement.txt"); return existsSync(f) ? Number(/^seq (\d+)$/m.exec(readFileSync(f, "utf8"))?.[1]) : NaN; };
  const meds = pl.map((p) => ({ seq: seq(p), m: median(p.changes), s: median(p.swapped) }));
  if (meds.some((x) => !Number.isFinite(x.seq))) throw new Error("a placement.txt without its seq");
  const el = eligibility({ complete: pl.skipped.length === 0, medians: [...meds].sort((a, b) => a.seq - b.seq).map((x) => x.m) });
  console.log(`${dir}: ${pl.length} placements read (${pl.skipped.length} without their ended line); sd of the medians ${(100 * el.sd).toFixed(3)}%`);
  console.log(`lag-1 r1 ${el.lag1.r1.toFixed(3)} p ${el.lag1.p.toFixed(4)}; Spearman rho ${el.spearman.rho.toFixed(3)} p ${el.spearman.p.toFixed(4)}; zero interval ${(100 * el.zero.low).toFixed(3)}% to ${(100 * el.zero.high).toFixed(3)}% (ranks ${el.zero.ranks}), inside: ${el.zero.inside}`);
  console.log(`Shapiro-Wilk p ${el.shapiroWilk.p.toFixed(4)}; Anderson-Darling p ${el.andersonDarling.p.toFixed(4)}; models kept: ${el.models.join(", ")}; eligible if every placement of the plan is here: ${el.eligible}`);
  const size = sizeByRule(meds.map((x) => [x.m, x.s]), el.models);
  console.log(size.K == null ? `no K from ${size.from} to ${size.to} meets the rule` : `K = ${size.K}: ${size.at.map((c) => `${c.model} ${c.failing} of ${size.draws} (rank ${c.rank})`).join(", ")}`);
  for (const t of size.tried.slice(-8)) console.log(`  K ${t.K}: ${t.counts.map((c) => `${c.model} ${c.failing}`).join(", ")}`);
  if (confirm && size.K != null) {
    const r = sizePilot(pl, { K: [size.K], draws: 200000, seed: 1983 }).rows[0];
    console.log(`sizePilot(readPilot(dir), { K: [${size.K}], draws: 200000, seed: 1983 }): normal ${Math.round(r.normal.rate * 200000)}, smoothed ${Math.round(r.smoothed.rate * 200000)} failing draws`);
  }
}
