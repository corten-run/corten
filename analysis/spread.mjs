// Where a comparison's placement medians get their spread: read from the results of a placement
// run (results/<comparison>/pNN/counts-<workload>.csv). For each comparison: the standard
// deviation of its placement medians (user plus kernel cycles a request, B over A less one); the
// pairs' spread about their placement's median, as a standard deviation and as 1.4826 x the median
// absolute deviation; what the normal formula (1.2533 x sd / sqrt(R)) gives a median of R pairs;
// and the standard deviation of a median of R drawn with replacement from the comparison's pooled
// residuals. Then, for two A/As, a permutation test on the ratio of their medians' standard
// deviations. Seeded.
//   node spread.mjs <results dir> <comparison:workload> ...   (the first two are permuted)
import fs from "node:fs";
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const median = (v) => { const s = [...v].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const sd = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); };
const [dir, ...specs] = process.argv.slice(2);
const u = rng(1983);
const all = [];
for (const spec of specs) {
  const [c, w] = spec.split(":");
  const medians = [], residuals = [];
  let R = 0;
  for (const p of fs.readdirSync(`${dir}/${c}`).sort()) {
    const rows = fs.readFileSync(`${dir}/${c}/${p}/counts-${w}.csv`, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
    const per = new Map();
    for (const [pair, version, requests, cu, ck] of rows) {
      const e = per.get(pair) ?? {};
      e[version] = (Number(cu) + Number(ck)) / Number(requests);
      per.set(pair, e);
    }
    const changes = [...per.values()].map((e) => 100 * (e.head / e.base - 1));
    R = changes.length;
    const m = median(changes);
    medians.push(m);
    for (const x of changes) residuals.push(x - m);
  }
  const mad = 1.4826 * median(residuals.map(Math.abs));
  const draws = [];
  for (let n = 0; n < 200000; n++) {
    const s = [];
    for (let i = 0; i < R; i++) s.push(residuals[Math.floor(u() * residuals.length)]);
    draws.push(median(s));
  }
  all.push(medians);
  console.log(`${c}: ${medians.length} placements of ${R}; medians sd ${sd(medians).toFixed(2)}%; pairs sd ${sd(residuals).toFixed(2)}%, 1.4826 x MAD ${mad.toFixed(2)}%, largest ${Math.max(...residuals.map(Math.abs)).toFixed(1)}%; a median of ${R} by the normal formula ${(1.2533 * sd(residuals) / Math.sqrt(R)).toFixed(2)}%, from pooled residuals ${sd(draws).toFixed(2)}%`);
}
if (all.length >= 2) {
  const [a, b] = all, ratio = sd(a) / sd(b), pool = [...a, ...b].map((x, i) => x - (i < a.length ? median(a) : median(b)));
  let ge = 0, two = 0;
  const N = 200000;
  for (let n = 0; n < N; n++) {
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(u() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const r = sd(pool.slice(0, a.length)) / sd(pool.slice(a.length));
    if (r >= ratio) ge++;
    if (r >= ratio || r <= 1 / ratio) two++;
  }
  console.log(`${specs[0]} against ${specs[1]}: ratio of medians' sd ${ratio.toFixed(2)}; of ${N} permutations of the ${pool.length} centred medians ${(100 * ge / N).toFixed(2)}% reach it (one-sided), ${(100 * two / N).toFixed(2)}% either way`);
}
