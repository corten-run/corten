// placement.mjs: the statistics across placements (results/margin.md, "Reading"; kit 1965's, with
// the A/A's second reading and instruction-cache misses added), used by report.mjs and tested by
// check-report.mjs on made-up numbers.
//
// A comparison is K placements; a placement is R recorded pairs of turns (A = the CSV's "base"
// rows, B its "head" rows), each turn on a fresh start. Per pair, the change is B / A - 1 in a
// measure per request. Per placement, its statistic is the median of its R changes. Across the K
// placements, the gate's statistic is the median of those K medians with its one-sided 95%
// distribution-free upper bound: the j-th smallest of the K, j the smallest rank with
// P(Binomial(K, 1/2) >= j) <= 5% (stats.mjs's upperRank: the 20th of 30). With fewer than 5
// placements no rank has that coverage and there is no bound. An A/A is read twice from the same
// pairs: as recorded, and with its lists' labels swapped (each per-pair change read as
// A / B - 1); it resolves the margin only if its bound is under +1% in both readings. The
// one-sided 95% lower bound (the (K + 1 - j)-th smallest), the mean of the K medians with a
// one-sided 95% Student t bound, and the spread between placements against the spread within
// them, are diagnostics: no verdict reads them.
import { readFileSync } from "node:fs";
import { median, upperRank } from "./stats.mjs";

/** The no-regression margin a touched workload is held to: +1%, no floor. */
export const MARGIN = 0.01;

export const HEADER = "pair,version,requests,cycles_u,cycles_k,instructions_u,l1i_misses_u";

export const MEASURES = {
  "cycles user+kernel": (r) => (r.cycles_u + r.cycles_k) / r.requests,
  "cycles user": (r) => r.cycles_u / r.requests,
  "cycles kernel": (r) => r.cycles_k / r.requests,
  "instructions user": (r) => r.instructions_u / r.requests,
  "L1i misses user": (r) => r.l1i_misses_u / r.requests,
};

/** The pairs of a run-pair-old.sh counts CSV: [{ pair, base, head }], each a row. */
export function readPairs(file) {
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (header !== HEADER) throw new Error(`${file}: not a counts CSV`);
  const rows = lines.map((l) => {
    const [pair, version, ...v] = l.split(",");
    const n = v.map(Number);
    if (n.length !== 5 || n.some((x) => !Number.isFinite(x) || x < 0) || n[0] <= 0 || n.slice(1).some((x) => x <= 0)) throw new Error(`${file}: unusable row ${l}`);
    return { pair, version, requests: n[0], cycles_u: n[1], cycles_k: n[2], instructions_u: n[3], l1i_misses_u: n[4] };
  });
  const pairs = [...new Set(rows.map((r) => r.pair))];
  return pairs.map((pair) => {
    const one = (v) => {
      const r = rows.filter((x) => x.pair === pair && x.version === v);
      if (r.length !== 1) throw new Error(`${file}: pair ${pair} ${v}: ${r.length} rows`);
      return r[0];
    };
    return { pair, base: one("base"), head: one("head") };
  });
}

const sd = (xs) => {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/**
 * One placement: per measure, A's and B's median per request, the per-pair changes B / A - 1 and
 * their median, and the median of the same pairs read with the labels swapped (A / B - 1).
 */
export function placementStats(pairs) {
  const out = {};
  for (const [name, f] of Object.entries(MEASURES)) {
    const changes = pairs.map((p) => f(p.head) / f(p.base) - 1);
    out[name] = {
      a: median(pairs.map((p) => f(p.base))),
      b: median(pairs.map((p) => f(p.head))),
      changes,
      median: median(changes),
      swapped: median(pairs.map((p) => f(p.base) / f(p.head) - 1)),
      min: Math.min(...changes),
      max: Math.max(...changes),
      sd: sd(changes),
    };
  }
  return out;
}

// ln Gamma (Lanczos, g = 7), and the regularized incomplete beta I_x(a, b) by its continued
// fraction (Numerical Recipes' betacf), for the Student t distribution.
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betacf(a, b, x) {
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d);
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d);
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d);
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}
/** P(T <= t) for Student's t with df degrees of freedom. */
export function tCdf(t, df) {
  const tail = ibeta(df / (df + t * t), df / 2, 0.5) / 2;
  return t >= 0 ? 1 - tail : tail;
}
/** The p quantile of Student's t with df degrees of freedom (bisection). */
export function tQuantile(p, df) {
  let lo = -1000, hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Across placements: the K placement medians of one measure. */
export function across(medians, alpha = 0.05) {
  const K = medians.length;
  const s = [...medians].sort((x, y) => x - y);
  const j = upperRank(K, alpha);
  const has = K >= 5 && j >= 1 && j <= K;
  const mean = K ? medians.reduce((a, x) => a + x, 0) / K : NaN;
  const dev = sd(medians);
  const t = K > 1 ? tQuantile(1 - alpha, K - 1) : NaN;
  return {
    K,
    rank: has ? j : null,
    lowerRank: has ? K + 1 - j : null,
    median: K ? median(medians) : NaN,
    bound: has ? s[j - 1] : null,
    lower: has ? s[K - j] : null,
    min: s[0],
    max: s[K - 1],
    mean,
    sd: dev,
    t,
    tBound: mean + (t * dev) / Math.sqrt(K),
    tLower: mean - (t * dev) / Math.sqrt(K),
  };
}

/**
 * The spread between placements against the spread within them, for one measure: `between` is
 * the standard deviation of the K placement medians; `within` the pooled standard deviation of
 * the per-pair changes inside a placement; `fromWithin` the standard deviation a placement median
 * of R pairs would have from that within-placement spread alone (normal approximation,
 * 1.2533 x within / sqrt(R)); `placementOnly` what is left of `between` once that is taken out.
 */
export function spread(stats, measure, R) {
  const medians = stats.map((p) => p[measure].median);
  const variances = stats.map((p) => p[measure].sd ** 2).filter(Number.isFinite);
  const within = variances.length ? Math.sqrt(variances.reduce((a, x) => a + x, 0) / variances.length) : NaN;
  const between = sd(medians);
  const fromWithin = (1.2533 * within) / Math.sqrt(R);
  return { between, within, fromWithin, placementOnly: Math.sqrt(Math.max(0, between ** 2 - fromWithin ** 2)), ratio: between / fromWithin };
}

/**
 * Whether an A/A comparison resolves the margin: complete, with a bound in both readings (as
 * recorded and with its lists' labels swapped), each under +1%.
 */
export function resolution(aa) {
  if (!aa || !aa.complete) return "not resolved (incomplete)";
  const b = aa.across["cycles user+kernel"].bound, s = aa.swapped["cycles user+kernel"].bound;
  if (b == null || s == null) return "not resolved (no bound)";
  return b < MARGIN && s < MARGIN ? "resolved" : "not resolved";
}

/** The gate's reading of a change on a workload, given that workload's A/A of the same run. */
export function verdict(change, aa) {
  if (!change || !change.complete) return "no bound (incomplete): does not pass";
  const b = change.across["cycles user+kernel"].bound;
  if (b == null) return "no bound: does not pass";
  if (resolution(aa) !== "resolved") return "not resolved: does not pass";
  return b < MARGIN ? "meets +1%" : "misses +1%";
}
