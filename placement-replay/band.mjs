// band.mjs: the lowest and the highest placement median of each A/A across placements in the
// reports given (placements-<workload>.json), and the lowest and highest of them all.
//   node band.mjs <label=file>...
import { readFileSync } from "node:fs";
const pct = (x) => (x < 0 ? "-" : "+") + (100 * Math.abs(x)).toFixed(2) + "%";
let low = Infinity, high = -Infinity, lowOf = "", highOf = "";
for (const arg of process.argv.slice(2)) {
  const [label, file] = arg.split("=");
  const j = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, r] of Object.entries(j.results)) {
    if (!name.startsWith("aa-")) continue;
    const m = r.placements.map((p) => p.medians["cycles user+kernel"].median);
    const lo = Math.min(...m), hi = Math.max(...m);
    console.log(`${label} ${name}: K ${m.length}; placement medians from ${pct(lo)} to ${pct(hi)}`);
    if (lo < low) { low = lo; lowOf = `${label} ${name}`; }
    if (hi > high) { high = hi; highOf = `${label} ${name}`; }
  }
}
console.log(`lowest ${pct(low)} (${lowOf}); highest ${pct(high)} (${highOf})`);
