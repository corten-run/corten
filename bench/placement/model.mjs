// model.mjs: the statistics this kit adds to placement.mjs, shared by report.mjs, size.mjs and
// check-report.mjs. Plain functions on arrays of numbers (fractions, 0.01 = 1%), seeded where
// they draw, so a result is the same every time it is computed.
//
//   rng(seed)                     a seeded uniform generator (mulberry32, as analysis/*.mjs)
//   qnorm(p), pnorm(z)            the normal quantile (AS 241) and distribution function
//   pchisq(x, df), qchisq(p, df)  the chi-square distribution function and quantile
//   shapiroWilk(xs)               W and its p-value (Royston 1995, AS R94, as R and scipy)
//   andersonDarling(xs)           A^2 for normality with mean and variance estimated, A*^2 and
//                                 its p-value (D'Agostino and Stephens 1986, table 4.9)
//   lag1(xs)                      the lag-1 autocorrelation, in the order given
//   permutationLag1(xs, n, seed)  its two-sided permutation p-value
//   failRate*(...)                how often an A/A of K placements fails one of its two readings
//                                 (the j-th smallest at or over +1% as recorded or with the labels
//                                 swapped), under the normal model, resampling a pilot, or
//                                 resampling it smoothed
//   kNeeded(...)                  the smallest K whose failure rate is at most a target
//   fromWithin(placements, R)     what R pairs alone give a placement median's spread: the normal
//                                 formula, pooled residuals (low), and leave-one-out residuals
//                                 rescaled (the figure this kit reads)
import { upperRank } from "./stats.mjs";

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw from a uniform generator (Box-Muller, one value a call, as resolve-sim.mjs). */
export const gauss = (u) => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());

export const median = (xs) => {
  const s = Float64Array.from(xs).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
export const sd = (xs) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

// The normal quantile, Wichura's AS 241 (PPND16), accurate to about 1e-16.
export function qnorm(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r + 133.14166789178437745) * r + 3.387132872796366608)) /
      (((((((5226.495278852545925 * r + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r + 42.313330701600911252) * r + 1);
  }
  let r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let v;
  if (r <= 5) {
    r -= 1.6;
    v = (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r + 4.6303378461565452959) * r + 1.42343711074968357734) /
      (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r + 2.05319162663775882187) * r + 1);
  } else {
    r -= 5;
    v = (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r + 5.4637849111641143699) * r + 6.6579046435011037772) /
      (((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r + 0.59983220655588793769) * r + 1);
  }
  return q < 0 ? -v : v;
}

// erfc by its continued fraction / series (W. J. Cody's rational approximations would do as well;
// this one is accurate to about 1e-14 over the range used here).
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
/** The standard normal distribution function, refined by Newton steps on qnorm. */
export function pnorm(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  // Numerical Recipes' erfc (1.2e-7) as a start, then two Newton steps against qnorm.
  let p = 0.5 * erfc(-z / Math.SQRT2);
  if (p <= 0 || p >= 1) return p;
  for (let i = 0; i < 3; i++) {
    const q = qnorm(p);
    const d = Math.exp(-0.5 * q * q) / Math.sqrt(2 * Math.PI);
    if (!(d > 0)) break;
    const next = p + (z - q) * d;
    if (!(next > 0 && next < 1)) break;
    p = next;
  }
  return p;
}

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
/** The regularized lower incomplete gamma P(a, x) (series, or Lentz's continued fraction). */
export function pgamma(a, x) {
  if (x <= 0) return 0;
  const front = Math.exp(-x + a * Math.log(x) - lgamma(a));
  if (x < a + 1) {
    let sum = 1 / a, term = 1 / a;
    for (let n = 1; n < 1000; n++) { term *= x / (a + n); sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-16) break; }
    return sum * front;
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return 1 - front * h;
}
export const pchisq = (x, df) => pgamma(df / 2, x / 2);
export function qchisq(p, df) {
  let lo = 0, hi = Math.max(10, df * 10);
  while (pchisq(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (pchisq(m, df) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

const poly = (c, x) => { let r = 0; for (let i = c.length - 1; i >= 0; i--) r = r * x + c[i]; return r; };

/**
 * Shapiro-Wilk W and its p-value, Royston's (1995) algorithm AS R94, the one R's shapiro.test and
 * scipy.stats.shapiro use, for 3 <= n <= 5000.
 */
export function shapiroWilk(xs) {
  const n = xs.length;
  if (n < 3 || n > 5000) return { n, w: NaN, p: NaN };
  const x = Float64Array.from(xs).sort();
  const range = x[n - 1] - x[0];
  if (!(range > 0)) return { n, w: NaN, p: NaN };
  const half = Math.floor(n / 2);
  const a = new Float64Array(half + 1); // a[1..half], the coefficients of the upper half
  if (n === 3) a[1] = Math.SQRT1_2;
  else {
    const m = new Float64Array(half + 1);
    let summ2 = 0;
    for (let i = 1; i <= half; i++) { m[i] = qnorm((i - 0.375) / (n + 0.25)); summ2 += m[i] * m[i]; }
    summ2 *= 2;
    const ssumm2 = Math.sqrt(summ2), rsn = 1 / Math.sqrt(n);
    const a1 = poly([0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056], rsn) - m[1] / ssumm2;
    let i1, fac;
    if (n > 5) {
      i1 = 3;
      const a2 = -m[2] / ssumm2 + poly([0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633], rsn);
      fac = Math.sqrt((summ2 - 2 * m[1] * m[1] - 2 * m[2] * m[2]) / (1 - 2 * a1 * a1 - 2 * a2 * a2));
      a[2] = a2;
    } else {
      i1 = 2;
      fac = Math.sqrt((summ2 - 2 * m[1] * m[1]) / (1 - 2 * a1 * a1));
    }
    a[1] = a1;
    for (let i = i1; i <= half; i++) a[i] = -m[i] / fac;
  }
  let num = 0;
  for (let i = 1; i <= half; i++) num += a[i] * (x[n - i] - x[i - 1]);
  const mu = mean(x);
  let den = 0;
  for (const v of x) den += (v - mu) ** 2;
  let w = (num * num) / den;
  if (w > 1) w = 1;
  let p;
  if (n === 3) {
    p = Math.max(0, (6 / Math.PI) * (Math.asin(Math.sqrt(w)) - Math.PI / 3));
  } else {
    let y = Math.log(1 - w), mm, s;
    const lx = Math.log(n);
    if (n <= 11) {
      const gamma = -2.273 + 0.459 * n;
      if (y >= gamma) return { n, w, p: 1e-99 };
      y = -Math.log(gamma - y);
      mm = poly([0.544, -0.39978, 0.025054, -6.714e-4], n);
      s = Math.exp(poly([1.3822, -0.77857, 0.062767, -0.0020322], n));
    } else {
      mm = poly([-1.5861, -0.31082, -0.083751, 0.0038915], lx);
      s = Math.exp(poly([-0.4803, -0.082676, 0.0030302], lx));
    }
    p = 1 - pnorm((y - mm) / s);
  }
  return { n, w, p };
}

/**
 * Anderson-Darling A^2 against the normal with mean and variance estimated from the sample (the
 * statistic scipy.stats.anderson gives), A*^2 = A^2 (1 + 0.75 / n + 2.25 / n^2), and the p-value
 * of A*^2 by D'Agostino and Stephens (1986), table 4.9.
 */
export function andersonDarling(xs) {
  const n = xs.length;
  if (n < 8) return { n, a2: NaN, a2star: NaN, p: NaN };
  const x = Float64Array.from(xs).sort();
  const mu = mean(x), s = sd(x);
  if (!(s > 0)) return { n, a2: NaN, a2star: NaN, p: NaN };
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const lo = pnorm((x[i] - mu) / s), hi = pnorm((x[n - 1 - i] - mu) / s);
    sum += (2 * i + 1) * (Math.log(lo) + Math.log(1 - hi));
  }
  const a2 = -n - sum / n;
  const st = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  let p;
  if (st >= 0.6) p = Math.exp(1.2937 - 5.709 * st + 0.0186 * st * st);
  else if (st >= 0.34) p = Math.exp(0.9177 - 4.279 * st - 1.38 * st * st);
  else if (st >= 0.2) p = 1 - Math.exp(-8.318 + 42.796 * st - 59.938 * st * st);
  else p = 1 - Math.exp(-13.436 + 101.14 * st - 223.73 * st * st);
  return { n, a2, a2star: st, p: Math.min(1, Math.max(0, p)) };
}

/** The lag-1 autocorrelation of a series in the order given. */
export function lag1(xs) {
  const n = xs.length, m = mean(xs);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { den += (xs[i] - m) ** 2; if (i) num += (xs[i] - m) * (xs[i - 1] - m); }
  return num / den;
}
/** Two-sided permutation p-value of the lag-1 autocorrelation (its distance from the permutations' mean). */
export function permutationLag1(xs, n = 20000, seed = 1999) {
  const obs = lag1(xs), u = rng(seed), pool = [...xs], draws = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(u() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    draws[k] = lag1(pool);
  }
  const centre = mean(draws);
  let far = 0;
  for (const d of draws) if (Math.abs(d - centre) >= Math.abs(obs - centre) - 1e-15) far++;
  return { r1: obs, expected: centre, p: (far + 1) / (n + 1) };
}
/**
 * The permutation p-value of Spearman's rank correlation of xs with their order (0, 1, 2, ...):
 * two-sided (|rho| at least the observed) or, with side = 1, one-sided (rho at least the observed).
 * With ys given, the correlation of xs with ys instead (xs permuted).
 */
export function permutationSpearman(xs, { ys = null, n = 20000, seed = 1999, side = 2 } = {}) {
  // Spearman's rho is Pearson's r of the ranks, and permuting xs permutes their ranks: rank once.
  const other = ranks(ys ?? xs.map((_, i) => i)), pool = ranks(xs), obs = pearson(pool, other), u = rng(seed);
  let far = 0;
  for (let k = 0; k < n; k++) {
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(u() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const r = pearson(pool, other);
    if (side === 1 ? r >= obs - 1e-15 : Math.abs(r) >= Math.abs(obs) - 1e-15) far++;
  }
  return { rho: obs, p: (far + 1) / (n + 1) };
}
/** P(Binomial(n, 1/2) >= j). */
export function binomUpper(n, j) {
  let s = 0, c = 1;
  for (let i = 0; i <= n; i++) { if (i >= j) s += c / 2 ** n; c = (c * (n - i)) / (i + 1); }
  return s;
}
/**
 * The sizing rule plan.md declares (Amendment 1, P2-4): which of size.mjs's models sizes a later
 * plan from this A/A. The raw resample is never used (size.mjs: it reads a pilot's gaps near the
 * centre as the population's shape). Both other models assume placement medians that are
 * independent, alike over time and centred on zero, so neither is used if the lag-1 or Spearman
 * permutation test rejects (p < 0.05) or the two-sided interval for the common median excludes
 * zero. The normal model is also rejected if Shapiro-Wilk or Anderson-Darling rejects normality
 * (p < 0.05). Of the models left, the one needing the larger K for the target (the more
 * conservative) sizes the plan; "over 400" counts as the largest.
 */
export function chooseModel({ complete, swP, adP, lag1P, spearmanP, zeroInside, kNormal, kSmoothed }) {
  if (!complete) return { model: null, K: null, why: "A is incomplete: no model is chosen" };
  const bad = [];
  if (lag1P < 0.05) bad.push(`lag-1 dependence in run order (p = ${lag1P.toFixed(3)})`);
  if (spearmanP < 0.05) bad.push(`drift with run order (Spearman p = ${spearmanP.toFixed(3)})`);
  if (zeroInside === false) bad.push("a common median of zero rejected");
  if (bad.length) return { model: null, K: null, why: `neither model: ${bad.join("; ")}` };
  const normalOk = !(swP < 0.05) && !(adP < 0.05);
  const left = [...(normalOk ? [["normal", kNormal]] : []), ["smoothed resample", kSmoothed]];
  const size = (k) => (k == null ? Infinity : k);
  const [model, K] = left.reduce((a, b) => (size(b[1]) > size(a[1]) ? b : a));
  return { model, K, why: normalOk ? `normal and smoothed resample both left; the larger K` : `normality rejected (Shapiro-Wilk p = ${swP?.toFixed(3)}, Anderson-Darling p = ${adP?.toFixed(3)}): smoothed resample` };
}
/** Spearman's rank correlation of two equal-length series (average ranks for ties). */
export const ranks = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(v.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
export function spearman(a, b) {
  return pearson(ranks(a), ranks(b));
}
export function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
}

/**
 * An A/A of K placements fails if either reading's bound is at or over the margin: the j-th
 * smallest placement median as recorded, or the j-th smallest with the labels swapped. `draw`
 * fills one placement's [recorded, swapped] medians.
 */
function failRate(K, draws, seed, draw, margin = 0.01) {
  const j = upperRank(K);
  if (K < 5 || !(j >= 1 && j <= K)) return { K, rank: null, rate: NaN, draws };
  const u = rng(seed), rec = new Float64Array(K), swp = new Float64Array(K), pair = [0, 0];
  let fail = 0, sumBound = 0;
  for (let n = 0; n < draws; n++) {
    for (let i = 0; i < K; i++) { draw(u, pair); rec[i] = pair[0]; swp[i] = pair[1]; }
    rec.sort(); swp.sort();
    sumBound += rec[j - 1];
    if (rec[j - 1] >= margin || swp[j - 1] >= margin) fail++;
  }
  return { K, rank: j, rate: fail / draws, se: Math.sqrt((fail / draws) * (1 - fail / draws) / draws), meanBound: sumBound / draws, draws };
}
/**
 * The normal model of docs/design.md#choice-placement-runs and analysis/resolve-sim.mjs: K placement medians drawn
 * normal with a common median of zero and standard deviation `s` (a fraction); the swapped reading
 * of a median x is -x.
 */
export const failRateNormal = (K, s, draws = 200000, seed = 1983) =>
  failRate(K, draws, seed, (u, out) => { const x = gauss(u) * s; out[0] = x; out[1] = -x; });
/**
 * The resampling model: K placements drawn with replacement from a pilot's placements, each its
 * pair of medians (as recorded, labels swapped), each reading centred on its own median of the
 * pilot's medians and scaled by sqrt(n / (n - 1)) so the draws' spread is not the sample's
 * shrunken one.
 */
export function failRateResample(pilot, K, draws = 200000, seed = 1983) {
  const n = pilot.length, f = Math.sqrt(n / (n - 1));
  const mr = median(pilot.map((p) => p[0])), ms = median(pilot.map((p) => p[1]));
  const rec = pilot.map((p) => (p[0] - mr) * f), swp = pilot.map((p) => (p[1] - ms) * f);
  return failRate(K, draws, seed, (u, out) => { const i = Math.floor(u() * n); out[0] = rec[i]; out[1] = swp[i]; });
}
/**
 * The resampling model smoothed (Efron's shrunk smoothed bootstrap): each draw is a resampled
 * placement plus normal noise of a bandwidth h = 0.9 min(sd, IQR / 1.349) n^(-1/5) (Silverman's
 * rule), the sum shrunk by 1 / sqrt(1 + h^2 / sd^2) so its spread stays the pilot's; the swapped
 * reading takes the same noise with its sign turned, as it is nearly the recorded one negated. A
 * pilot of 30 leaves gaps between its medians near the centre, where the bound sits, and the plain
 * resampling model reads those gaps as the shape of the population; this one does not.
 */
export function failRateSmoothed(pilot, K, draws = 200000, seed = 1983) {
  const n = pilot.length, f = Math.sqrt(n / (n - 1));
  const mr = median(pilot.map((p) => p[0])), ms = median(pilot.map((p) => p[1]));
  const rec = pilot.map((p) => (p[0] - mr) * f), swp = pilot.map((p) => (p[1] - ms) * f);
  const s = sd(rec), sorted = [...rec].sort((a, b) => a - b);
  const q = (p) => { const x = p * (n - 1), i = Math.floor(x); return sorted[i] + (x - i) * ((sorted[i + 1] ?? sorted[i]) - sorted[i]); };
  const h = 0.9 * Math.min(s, (q(0.75) - q(0.25)) / 1.349) * n ** -0.2;
  const shrink = 1 / Math.sqrt(1 + (h * h) / (s * s));
  return { ...failRate(K, draws, seed, (u, out) => { const i = Math.floor(u() * n), e = h * gauss(u); out[0] = (rec[i] + e) * shrink; out[1] = (swp[i] - e) * shrink; }), bandwidth: h };
}
/**
 * The smallest K (from 5 to `maxK`) whose failure rate is at most `target`, by `rate(K, draws)`:
 * a scan in steps of 5 with `coarse` draws, then each K back from the first one under the target
 * with `fine` draws, so the order statistic's steps do not hide a smaller K; null past maxK.
 */
export function kNeeded(rate, target = 0.05, { maxK = 400, coarse = 20000, fine = 100000 } = {}) {
  let first = null;
  for (let K = 5; K <= maxK; K += 5) if (rate(K, coarse).rate <= target) { first = K; break; }
  if (first == null) return null;
  let best = null;
  for (let K = Math.max(5, first - 9); K <= Math.min(maxK, first + 5); K++) {
    const r = rate(K, fine);
    if (r.rate <= target) { best = r; break; }
  }
  return best;
}

/**
 * What R pairs alone give a placement median's spread, from the per-pair changes inside each
 * placement (an array of arrays, R each):
 *   normal    1.2533 x the pooled sd of the pairs about their placement's mean / sqrt(R): the
 *             formula report.mjs has always printed, which long-tailed pairs inflate
 *   pooled    the sd of a median of R drawn from the pooled residuals about each placement's
 *             median: low, because that median sits among its own pairs
 *   loo       the same from leave-one-out residuals (each pair less the median of the other R - 1
 *             of its placement), which are not drawn toward their pair but carry the noise of
 *             that median: high
 *   corrected loo's residuals rescaled by 1 / sqrt(1 + k), k the variance of a median of R - 1
 *             drawn from them over their own variance, which removes that noise for a family of
 *             one shape and any scale: the figure this kit reads as "from within"
 */
export function fromWithin(placements, draws = 100000, seed = 1999) {
  const R = placements[0]?.length ?? 0;
  if (R < 3 || placements.some((p) => p.length !== R)) return { R, normal: NaN, pooled: NaN, loo: NaN, corrected: NaN };
  const pooled = [], loo = [];
  let ss = 0, dfs = 0;
  for (const p of placements) {
    const m = median(p), mu = mean(p);
    for (let i = 0; i < R; i++) {
      pooled.push(p[i] - m);
      loo.push(p[i] - median(p.filter((_, k) => k !== i)));
      ss += (p[i] - mu) ** 2;
    }
    dfs += R - 1;
  }
  const u = rng(seed);
  const medSd = (pool, r) => {
    const out = new Float64Array(draws), s = new Float64Array(r);
    for (let n = 0; n < draws; n++) { for (let i = 0; i < r; i++) s[i] = pool[Math.floor(u() * pool.length)]; out[n] = median(s); }
    return sd(out);
  };
  const looSd = medSd(loo, R);
  const k = medSd(loo, R - 1) ** 2 / sd(loo) ** 2;
  return { R, normal: (1.2533 * Math.sqrt(ss / dfs)) / Math.sqrt(R), pooled: medSd(pooled, R), loo: looSd, corrected: looSd / Math.sqrt(1 + k), k };
}

/** The order-statistic interval for a median of n values: (x(r), x(n + 1 - r)), r the largest rank with coverage >= level. */
export function medianInterval(xs, level = 0.9) {
  const n = xs.length, s = [...xs].sort((a, b) => a - b);
  const pmf = [];
  let c = 1;
  for (let i = 0; i <= n; i++) { pmf.push(c / 2 ** n); c = (c * (n - i)) / (i + 1); }
  let r = 0, cov = NaN;
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    const tail = pmf.slice(0, k).reduce((a, x) => a + x, 0);
    const coverage = 1 - 2 * tail;
    if (coverage >= level) { r = k; cov = coverage; } else break;
  }
  if (!r) return { n, median: n ? median(s) : NaN, low: null, high: null, rank: null, coverage: NaN };
  return { n, median: median(s), low: s[r - 1], high: s[n - r], rank: r, coverage: cov };
}