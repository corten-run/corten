// How often an A/A of K placement medians with a common zero median resolves +1% in
// both readings (the j-th smallest under +1%, and the (K + 1 - j)-th smallest over -1%, j the
// smallest rank with P(Binomial(K, 1/2) >= j) <= 5%), for normal placement medians of a given
// standard deviation (percent). Seeded, 200,000 draws each. Arguments: K:sd ...
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
function rank(K) {
  const p = [1];
  for (let i = 1; i <= K; i++) { p.push(0); for (let k = i; k > 0; k--) p[k] = (p[k] + p[k - 1]) / 2; p[0] /= 2; }
  let tail = 0;
  for (let j = K; j >= 0; j--) { tail += p[j]; if (tail > 0.05) return j + 1; }
}
const N = 200000;
for (const arg of process.argv.slice(2)) {
  const [K, sd] = arg.split(":").map(Number);
  const j = rank(K);
  const u = rng(1983);
  let fail = 0, sum = 0;
  for (let n = 0; n < N; n++) {
    const x = [];
    for (let i = 0; i < K; i++) x.push(Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) * sd);
    x.sort((p, q) => p - q);
    sum += x[j - 1];
    if (x[j - 1] >= 1 || -x[K - j] >= 1) fail++;
  }
  console.log(`K ${K} rank ${j} sd ${sd}: mean bound ${(sum / N).toFixed(2)}%, not resolved in ${(100 * fail / N).toFixed(1)}% of draws`);
}
