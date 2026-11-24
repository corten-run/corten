// measure-sim.mjs: what the measurement of the data's place reads by chance, on the model
// design Choice 72 uses for an A/A (resolve-sim.mjs under the tag evidence/c448780e): the K
// placement medians of a comparison are normal draws with one standard deviation (percent) and
// a common median. The measurement is three comparisons of K placements. Its outcomes:
//   held    every comparison's upper bound is under +1% in both readings (the j-th smallest
//           median under +1% and the (K + 1 - j)-th smallest over -1%, j the smallest rank with
//           P(Binomial(K, 1/2) >= j) <= 5%);
//   shown   not held, and in some comparison at least j2 of the K medians lie on one side of
//           zero, j2 the smallest count with P(Binomial(K, 1/2) >= j2) <= 5% / 6 (two sides of
//           three comparisons);
//   notmade neither.
// Seeded, N draws of the three comparisons each. Arguments: K:sd[:effect] ..., effect the common
// median (percent) of the third comparison alone, 0 when left out.
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
function tails(K) {
  const p = [1];
  for (let i = 1; i <= K; i++) { p.push(0); for (let k = i; k > 0; k--) p[k] = (p[k] + p[k - 1]) / 2; p[0] /= 2; }
  const t = new Array(K + 2).fill(0);
  for (let j = K; j >= 0; j--) t[j] = t[j + 1] + p[j];
  return t;
}
const rank = (t, level) => { for (let j = 0; j < t.length; j++) if (t[j] <= level) return j; };
const N = 200000;
for (const arg of process.argv.slice(2)) {
  const [K, sd, effect = 0] = arg.split(":").map(Number);
  const t = tails(K), j = rank(t, 0.05), j2 = rank(t, 0.05 / 6);
  const u = rng(2024);
  let held = 0, shown = 0, notmade = 0, one = 0;
  for (let n = 0; n < N; n++) {
    let allResolve = true, sign = false;
    for (let c = 0; c < 3; c++) {
      const x = [], shift = c === 2 ? effect : 0;
      let above = 0;
      for (let i = 0; i < K; i++) { const v = Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) * sd + shift; x.push(v); if (v > 0) above++; }
      x.sort((p, q) => p - q);
      const fails = x[j - 1] >= 1 || -x[K - j] >= 1;
      if (fails) allResolve = false;
      if (c === 0 && fails) one++;
      if (above >= j2 || K - above >= j2) sign = true;
    }
    if (allResolve) held++; else if (sign) shown++; else notmade++;
  }
  const pc = (k) => (100 * k / N).toFixed(1) + "%";
  console.log(`K ${K} sd ${sd} effect ${effect}: ranks ${j} and ${j2} (tails ${(100 * t[j]).toFixed(2)}% and ${(100 * t[j2]).toFixed(2)}%); one comparison not resolved ${pc(one)}; held ${pc(held)}, shown ${pc(shown)}, not made ${pc(notmade)}`);
}
