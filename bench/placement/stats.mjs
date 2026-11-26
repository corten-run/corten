// stats.mjs: the statistic of a placement run and the words its readings are reported in
// (CONTRIBUTING.md, Pull requests, item 2: the placement plan's third and fourth points and the
// paragraph after the fifth). Nothing here reads a file.
//
// A comparison is K placements; a placement is R recorded pairs of turns, A and B. Per pair the
// change is B / A - 1 in a measure per request, and A / B - 1 with the labels swapped. A
// placement's statistic is the median of its R changes. Across the K placements the reading is
// the median of the K medians and its one-sided 95% upper bound, the j-th smallest of them, j the
// smallest rank with P(Binomial(K, 1/2) >= j) <= 5%; the lower bound is the (K + 1 - j)-th.

/** The no-regression margin a workload read across placements is held to: +1%, no floor. */
export const MARGIN = 0.01;

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The smallest rank j with P(Binomial(n, 1/2) >= j) <= alpha; n + 1 when no rank of n has it. */
export const upperRank = (n, alpha = 0.05) => {
  const pmf = [];
  let logc = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logc += Math.log(n - i + 1) - Math.log(i);
    pmf.push(Math.exp(logc - n * Math.LN2));
  }
  let tail = 0;
  for (let k = n; k >= 0; k--) {
    if (tail + pmf[k] > alpha) return k + 1;
    tail += pmf[k];
  }
  return 0;
};

export const pct = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";

/** A rank as it is written: 1st, 42nd, 59th; "-" for none. */
export const ord = (n) => (n == null ? "-" : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`);

export const sd = (xs) => {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** One placement's statistic in one measure: a and b are its R per-request values, pair by pair. */
export function placement(a, b) {
  const changes = a.map((x, i) => b[i] / x - 1), swapped = a.map((x, i) => x / b[i] - 1);
  return { a: median(a), b: median(b), median: median(changes), swapped: median(swapped), min: Math.min(...changes), max: Math.max(...changes) };
}

/** Across placements: the K placement medians of one measure. No bound with fewer than 5. */
export function across(medians) {
  const K = medians.length, s = [...medians].sort((x, y) => x - y), j = upperRank(K);
  const has = K >= 5 && j >= 1 && j <= K;
  return {
    K,
    rank: has ? j : null,
    lowerRank: has ? K + 1 - j : null,
    median: K ? median(medians) : NaN,
    bound: has ? s[j - 1] : null,
    lower: has ? s[K - j] : null,
    min: K ? s[0] : NaN,
    max: K ? s[K - 1] : NaN,
    sd: sd(medians),
  };
}

/**
 * An A/A as the fourth point reads it: `recorded` and `swapped` are across() of its placement
 * medians as recorded and with its lists' labels swapped, or null where it has no bound.
 */
export function resolution(recorded, swapped) {
  if (!recorded || !swapped || recorded.bound == null || swapped.bound == null) return "no bound";
  return recorded.bound < MARGIN && swapped.bound < MARGIN ? "resolved" : "not resolved";
}

/** The margin's reading of a change on a workload, given its A/A's resolution. */
export function margin(change, aa) {
  if (!change || change.bound == null) return "no bound: does not pass";
  if (aa === "no bound") return "the A/A has no bound: does not pass";
  if (aa !== "resolved") return "not resolved: does not pass";
  return change.bound < MARGIN ? "meets +1%" : "misses +1%";
}

/**
 * The benefit side, for a workload whose plan declares a smallest worthwhile reduction (a
 * fraction, 0.01 for 1%): the change's upper bound at or below minus the reduction, and the
 * A/A's lower bound above minus the reduction in both readings, with the A/A resolved.
 */
export function win(change, recorded, swapped, reduction) {
  if (!change || change.bound == null) return "no bound: no win";
  const aa = resolution(recorded, swapped);
  if (aa !== "resolved") return `${aa === "no bound" ? "the A/A has no bound" : "not resolved"}: no win`;
  if (!(recorded.lower > -reduction && swapped.lower > -reduction)) return "the A/A's lower bound is not above minus the reduction: no win";
  return change.bound <= -reduction ? "reduction established" : "reduction not established";
}
