// The statistics summary.mjs gives a run-pair CSV, for any of its columns: per request, the
// median of each build, the median per-pair change (B / A - 1, B being the CSV's "head" rows and
// A its "base" rows), the one-sided 95% upper bound on that median (an order statistic, the
// smallest rank j with P(Binomial(n, 1/2) >= j) <= 5%: the 59th of 100 changes, the 20th of 30)
// and the range. A cycles CSV also gets user+kernel cycles, as summary.mjs reports them.
import { readFileSync } from "node:fs";

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

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

const NAMES = { cycles_u: "cycles user", cycles_k: "cycles kernel", instructions_u: "instructions user" };

export function summarize(file, turn = 3) {
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const names = header.split(",");
  if (names.slice(0, 3).join(",") !== "pair,version,requests") throw new Error(file + ": not a run-pair CSV");
  const data = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [names[i], i < 2 ? v : Number(v)])));
  const pairs = [...new Set(data.map((r) => r.pair))];
  const row = (pair, version) => {
    const r = data.filter((x) => x.pair === pair && x.version === version);
    if (r.length !== 1) throw new Error(file + ": pair " + pair + " " + version + ": " + r.length + " rows");
    return r[0];
  };
  const measures = {};
  if (names.includes("cycles_u") && names.includes("cycles_k")) measures["cycles user+kernel"] = (r) => (r.cycles_u + r.cycles_k) / r.requests;
  for (const c of names.slice(3)) measures[NAMES[c] ?? c] = (r) => r[c] / r.requests;
  const n = pairs.length;
  const k = upperRank(n);
  const out = { file, pairs: n, boundRank: k, measures: {} };
  for (const [name, f] of Object.entries(measures)) {
    const a = pairs.map((p) => f(row(p, "base")));
    const b = pairs.map((p) => f(row(p, "head")));
    const ch = pairs.map((p, i) => b[i] / a[i] - 1).sort((x, y) => x - y);
    out.measures[name] = { a: median(a), b: median(b), change: median(ch), bound: ch[k - 1], min: ch[0], max: ch[n - 1] };
  }
  for (const v of ["base", "head"]) out[v === "base" ? "aRequestsPerSecond" : "bRequestsPerSecond"] = median(pairs.map((p) => row(p, v).requests / turn));
  return out;
}

export function table(s) {
  const lines = [
    `${s.file}: ${s.pairs} pairs; the one-sided 95% upper bound is the change of rank ${s.boundRank} from the smallest (A = base rows, B = head rows)`,
    "| per request | A median | B median | median per-pair change | one-sided 95% bound | range |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const [name, m] of Object.entries(s.measures)) {
    const d = name.startsWith("cycles") ? 0 : 2;
    lines.push(`| ${name} | ${m.a.toFixed(d)} | ${m.b.toFixed(d)} | ${pct(m.change)} | ${pct(m.bound)} | ${pct(m.min)} to ${pct(m.max)} |`);
  }
  lines.push(`median requests/s: A ${s.aRequestsPerSecond.toFixed(0)}, B ${s.bRequestsPerSecond.toFixed(0)}`);
  return lines.join("\n");
}