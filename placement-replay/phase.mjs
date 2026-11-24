// phase.mjs: do an A/A's placement medians spread further where its two pads differ in their
// place in a 64-byte line than where they share it? Reads the reports (placements-<workload>.json):
//   node phase.mjs <label=file>...
import { readFileSync } from "node:fs";
const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (x) => (100 * x).toFixed(2) + "%";
const all = { same: [], other: [] };
for (const arg of process.argv.slice(2)) {
  const [label, file] = arg.split("=");
  const j = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, r] of Object.entries(j.results)) {
    if (!name.startsWith("aa-")) continue;
    const rows = r.placements.map((p) => ({ a: Number(/-p(\d+)$/.exec(p.A)[1]), b: Number(/-p(\d+)$/.exec(p.B)[1]), m: p.medians["cycles user+kernel"].median }));
    const centre = med(rows.map((x) => x.m));
    const same = rows.filter((x) => x.a % 64 === x.b % 64).map((x) => x.m - centre), other = rows.filter((x) => x.a % 64 !== x.b % 64).map((x) => x.m - centre);
    all.same.push(...same); all.other.push(...other);
    console.log(`${label} ${name}: K ${rows.length}; pads sharing a place in a line: ${same.length}, sd ${pct(sd(same))}, median |d| ${pct(med(same.map(Math.abs)))}, range ${pct(Math.min(...same))} to ${pct(Math.max(...same))}; differing: ${other.length}, sd ${pct(sd(other))}, median |d| ${pct(med(other.map(Math.abs)))}, range ${pct(Math.min(...other))} to ${pct(Math.max(...other))}`);
  }
}
console.log(`all, each centred on its own A/A's median: sharing ${all.same.length}, sd ${pct(sd(all.same))}, median |d| ${pct(med(all.same.map(Math.abs)))}; differing ${all.other.length}, sd ${pct(sd(all.other))}, median |d| ${pct(med(all.other.map(Math.abs)))}`);
// A permutation test of the ratio of the two sds.
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pool = [...all.same, ...all.other], n = all.same.length, obs = sd(all.other) / sd(all.same);
let ge = 0; const N = 20000;
for (let t = 0; t < N; t++) { const p = [...pool]; for (let i = p.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [p[i], p[k]] = [p[k], p[i]]; } const r = sd(p.slice(n)) / sd(p.slice(0, n)); if (Math.abs(Math.log(r)) >= Math.abs(Math.log(obs))) ge++; }
console.log(`ratio of sds, differing over sharing: ${obs.toFixed(2)}; ${(100 * ge / N).toFixed(1)}% of ${N} seeded permutations reach it either way`);
