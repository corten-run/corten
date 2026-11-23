// Summary of a run-pair.sh CSV: the per-pair change (head / base - 1) in cycles per request (user
// + kernel, user, kernel) and in user instructions per request, with the median, the one-sided 95%
// upper bound on the median (distribution-free: an order statistic of the changes) and the range.
// Usage: node summary.mjs <cycles-<workload>.csv> [seconds per turn, default 3]
import { readFileSync } from "node:fs";

const [, , file, turnArg] = process.argv;
const turn = Number(turnArg ?? 3);
const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
const names = header.split(",");
const data = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [names[i], i < 2 ? v : Number(v)])));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Smallest j with P(Binomial(n, 1/2) >= j) <= alpha: the j-th smallest change is a one-sided
// upper bound for the median at 1 - alpha (as the i1817 harness's summary.mjs).
const upperRank = (n, alpha = 0.05) => {
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
const pct = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";
const measures = {
  "cycles user+kernel": (r) => (r.cycles_u + r.cycles_k) / r.requests,
  "cycles user": (r) => r.cycles_u / r.requests,
  "cycles kernel": (r) => r.cycles_k / r.requests,
  "instructions user": (r) => r.instructions_u / r.requests,
};
const pairs = [...new Set(data.map((r) => r.pair))];
const n = pairs.length;
const k = upperRank(n);
const row = (pair, version) => {
  const r = data.filter((x) => x.pair === pair && x.version === version);
  if (r.length !== 1) throw new Error("pair " + pair + " " + version + ": " + r.length + " rows");
  return r[0];
};
const out = { file, pairs: n, boundRank: k, measures: {} };
console.log(file + ": " + n + " pairs; the one-sided 95% upper bound is the " + k + "th smallest change");
console.log("| per request | base median | head median | median per-pair change | one-sided 95% bound | range |");
console.log("| --- | ---: | ---: | ---: | ---: | --- |");
for (const [name, f] of Object.entries(measures)) {
  const b = pairs.map((p) => f(row(p, "base")));
  const h = pairs.map((p) => f(row(p, "head")));
  const ch = pairs.map((p, i) => h[i] / b[i] - 1).sort((x, y) => x - y);
  const m = { base: median(b), head: median(h), change: median(ch), bound: ch[k - 1], min: ch[0], max: ch[n - 1] };
  out.measures[name] = m;
  const d = name.startsWith("instructions") ? 1 : 0;
  console.log("| " + name + " | " + m.base.toFixed(d) + " | " + m.head.toFixed(d) + " | " + pct(m.change) + " | " + pct(m.bound) + " | " + pct(m.min) + " to " + pct(m.max) + " |");
}
for (const v of ["base", "head"]) {
  const rps = median(pairs.map((p) => row(p, v).requests / turn));
  out[v + "RequestsPerSecond"] = rps;
  console.log(v + ": median requests/s " + rps.toFixed(0));
}
const c = out.measures["cycles user+kernel"];
out.cyclesMarginMet = c.bound < 0.01;
console.log("cycles margin (bound on user+kernel change under +1%): " + (out.cyclesMarginMet ? "met" : "NOT met") + " (" + pct(c.bound) + ")");
const ins = out.measures["instructions user"];
out.instructionsFallAtLeast2Pct = ins.bound <= -0.02;
console.log("instructions:u per request (medians): " + ins.base.toFixed(1) + " -> " + ins.head.toFixed(1) + " (" + (ins.head - ins.base >= 0 ? "+" : "") + (ins.head - ins.base).toFixed(1) + "); bound on the change " + pct(ins.bound) + ", at or below -2%: " + out.instructionsFallAtLeast2Pct);
console.log("JSON " + JSON.stringify(out));