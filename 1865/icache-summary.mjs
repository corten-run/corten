// Summary of run-pair-icache.sh's CSV (the run's diagnostic pass, not a gate): per request, user L1
// instruction-cache misses and user instructions, each build's median, the median per-pair change
// (head / base - 1), its range, and the per-pair changes in pair order.
// Usage: node icache-summary.mjs <results>/icache-<workload>.csv
import { readFileSync } from "node:fs";

const [, , file] = process.argv;
const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
const names = header.split(",");
const data = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [names[i], i < 2 ? v : Number(v)])));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";
const pairs = [...new Set(data.map((r) => r.pair))];
const row = (pair, version) => {
  const r = data.filter((x) => x.pair === pair && x.version === version);
  if (r.length !== 1) throw new Error("pair " + pair + " " + version + ": " + r.length + " rows");
  return r[0];
};
console.log(file + ": " + pairs.length + " pairs (a diagnostic, not a gate)");
console.log("| per request | base median | head median | median per-pair change | range |");
console.log("| --- | ---: | ---: | ---: | --- |");
for (const [name, col] of [["L1-icache-load-misses:u", "icache_misses_u"], ["instructions:u", "instructions_u"]]) {
  const b = pairs.map((p) => row(p, "base")[col] / row(p, "base").requests);
  const h = pairs.map((p) => row(p, "head")[col] / row(p, "head").requests);
  const ch = pairs.map((p, i) => h[i] / b[i] - 1);
  const s = [...ch].sort((x, y) => x - y);
  console.log("| " + name + " | " + median(b).toFixed(2) + " | " + median(h).toFixed(2) + " | " + pct(median(ch)) + " | " + pct(s[0]) + " to " + pct(s[s.length - 1]) + " |");
  console.log("  per pair: " + ch.map(pct).join(" "));
}
