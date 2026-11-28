// pilot.mjs: what a plan reads from an A/A to size K (docs/design.md#choice-placement-runs, "How many
// placements"): whether the A/A is eligible, the models kept, the check of a K at that K itself
// and the smallest K that passes it. The tests and the models are the placement sizing kit's
// (model.mjs and size.mjs, unchanged from the tag evidence/placement-sizing-1999).
//   node pilot.mjs <results dir> [<K>]
// prints the eligibility of that part's A/A (report.mjs reads the results), the models kept and,
// for the K given or else for the smallest K that passes, each kept model's count of failing
// draws against 10,000 of 200,000. A scan for the smallest K prints each K it tries on standard
// error as it goes.
//
// Eligible: every placement of the plan read with all its pairs, in the seeded order saved with
// the results; neither the lag-1 autocorrelation of the medians in run order nor Spearman's
// correlation of the medians with run order at p < 0.05, each by permutation (20,000
// permutations, seed 1999, model.mjs's defaults); and zero inside the interval from the
// (K + 1 - j)-th to the j-th of the sorted medians, j the gate's upper rank.
// Models kept: the smoothed resample of the A/A's medians always; the normal model too unless
// Shapiro-Wilk or Anderson-Darling rejects normality at 5%.
// The check of a K: under each model kept, Math.round(rate * draws) of 200,000 draws at seed
// 1983 is at most 10,000, the counts sizePilot(readPilot(dir), { K: [K], draws: 200000, seed:
// 1983 }) gives in its rows.
import { fileURLToPath } from "node:url";
import { andersonDarling, failRateNormal, failRateSmoothed, permutationLag1, permutationSpearman, sd, shapiroWilk } from "./model.mjs";
import { across } from "./stats.mjs";

export const DRAWS = 200000, SEED = 1983, LIMIT = 10000;

/** medians: the placement medians in run order; complete: every placement of the plan is among them. */
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

/** pilot: [[median, swapped median]] in the order of the placements' indices, as size.mjs's readPilot gives them. */
export function failing(pilot, models, K) {
  const s = sd(pilot.map((x) => x[0]));
  return models.map((m) => {
    const r = m === "normal" ? failRateNormal(K, s, DRAWS, SEED) : failRateSmoothed(pilot, K, DRAWS, SEED);
    return { model: m, failing: Math.round(r.rate * DRAWS), rank: r.rank };
  });
}

/**
 * The smallest K from `from` to `to` at which every kept model's count of failing draws is at
 * most LIMIT. each: called with every K tried and its counts, since a scan can take minutes.
 */
export function sizeByRule(pilot, models, { from = 5, to = 254, each = () => {} } = {}) {
  const tried = [];
  for (let K = from; K <= to; K++) {
    const counts = failing(pilot, models, K);
    tried.push({ K, counts });
    each(tried.at(-1));
    if (counts.every((c) => c.failing <= LIMIT)) return { K, at: counts, tried, from, to };
  }
  return { K: null, at: null, tried, from, to };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, kArg] = process.argv.slice(2);
  if (!dir) { console.error("usage: node pilot.mjs <results dir> [<K>]"); process.exit(2); }
  // report.mjs imports this file, so it is loaded once this one has been: awaited here, at the
  // top level, the two would wait for each other and node would end with nothing printed.
  import("./report.mjs").then(({ sizing }) => {
    const s = sizing(dir, kArg === undefined ? undefined : Number(kArg));
    for (const l of s.lines) console.log(l);
    process.exit(s.ok ? 0 : 1);
  }).catch((e) => { console.error(`pilot.mjs: ${e.message}`); process.exit(1); });
}
