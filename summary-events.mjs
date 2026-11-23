// Summary of any run-pair CSV (cycles-<w>.csv or counts-<w>.csv, run-pair-fresh.sh's EVENTS):
// per request and per column, each build's median, the median per-pair change, the one-sided
// 95% upper bound and the range (stats.mjs). No margin is applied.
// Usage: node summary-events.mjs <csv> [seconds per turn, default 3]
import { summarize, table } from "./stats.mjs";

const [, , file, turn] = process.argv;
const s = summarize(file, Number(turn ?? 3));
console.log(table(s));
console.log("JSON " + JSON.stringify(s));