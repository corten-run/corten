// Local: the recount's rows from the count files: for each row and runtime, both rounds' medians
// of the control pair (main = the earlier base, b = the two-stage form on it) and of the new pair
// (newbase = main as merged, merge = the merge commit), and each pair's differences.
// Usage: node n10-rows.mjs <dir of count-*.txt> [--md]
import { existsSync, readFileSync } from "node:fs";
const dir = process.argv[2], md = process.argv.includes("--md");
const ROWS = [
  ["1", "multi", "default", "get", "staged GET, no wait, kept-alive"],
  ["2", "multi", "default", "sdelay1", "staged GET, sleeps 1 ms, kept-alive"],
  ["3", "multi", "default", "pipeline", "unstaged GET, no wait, kept-alive"],
  ["4", "multi", "default", "delay1", "unstaged GET, sleeps 1 ms, kept-alive"],
  ["5", "multi", "each-default", "get", "a connection for each request, no wait"],
  ["6", "multi", "each-default", "sdelay1", "a connection for each request, sleeps 1 ms"],
  ["9", "multi", "first3-default", "get", "kept-alive, the first three requests sleep 1 ms: the later ones"],
  ["1", "single", "percore-by-hand", "get", "staged GET, no wait, kept-alive"],
  ["2", "single", "percore-by-hand", "sdelay1", "staged GET, sleeps 1 ms, kept-alive"],
  ["5", "single", "settle", "get", "a connection for each request, no wait, 10 ms after each close"],
  ["6", "single", "settle", "sdelay1", "a connection for each request, sleeps 1 ms, 10 ms after each close"],
  ["9", "single", "first3-percore-by-hand", "get", "kept-alive, the first three requests sleep 1 ms: the later ones"],
];
function cell(kind, name, round, c) {
  const f = `${dir}/count-${kind}-${name}-${round}.txt`;
  if (!existsSync(f)) return null;
  const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith(c + " "));
  if (!line) return null;
  const [counts, allocs] = line.split("|");
  const n = counts.trim().split(/\s+/).slice(1).map(Number);
  return { median: n[0], least: n[1], most: n[2], spread: n[2] - n[1], allocs: allocs.trim().split(",")[0] };
}
const num = (x) => (x == null ? "-" : x.toLocaleString("en-US"));
const sign = (x) => (x == null || Number.isNaN(x) ? "-" : (x > 0 ? "+" : "") + x);
if (md) console.log("| Row | Request | Runtime | `main` at `df9242b56` | The merge, `2a653b1d0` | Over `main` | Control: `ca259c467` over `81e77162a` |\n|---|---|---|---|---|---|---|");
for (const [row, rt, kind, c, what] of ROWS) {
  const g = (name) => [1, 2].map((r) => cell(kind, name, r, c));
  const [m, b, nb, mg] = ["main", "b", "newbase", "merge"].map(g);
  const d = (x, y) => [0, 1].map((k) => (x[k] && y[k] ? x[k].median - y[k].median : NaN));
  const both = (x) => x.map((v) => num(v?.median)).join(" and ");
  const spread = Math.max(...[m, b, nb, mg].flat().filter(Boolean).map((v) => v.spread));
  const allocs = [...new Set([m, b, nb, mg].flat().filter(Boolean).map((v) => v.allocs))].join("/");
  if (md) console.log(`| ${row} | ${what} | ${rt} | ${both(nb)} | ${both(mg)} | ${d(mg, nb).map(sign).join(" and ")} | ${d(b, m).map(sign).join(" and ")} |`);
  else console.log(`row ${row} ${rt}: control main ${both(m)}, b ${both(b)}: ${d(b, m).map(sign).join(", ")} | newbase ${both(nb)}, merge ${both(mg)}: ${d(mg, nb).map(sign).join(", ")} | newbase over oldbase ${d(nb, m).map(sign).join(", ")}; merge over b ${d(mg, b).map(sign).join(", ")} | widest three counts ${spread}; allocations ${allocs}`);
}
