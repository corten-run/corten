// Local: the rows of the table for main and B from count6.py's output files.
// Usage: node rows8.mjs <dir with count-*.txt>
import { existsSync, readFileSync } from "node:fs";
const dir = process.argv[2];
const ROWS = [
  ["1", "staged GET, no wait, kept-alive", "multi", "count-default", "get"],
  ["2", "staged GET, sleeps 1 ms, kept-alive", "multi", "count-default", "sdelay1"],
  ["3", "unstaged GET, no wait, kept-alive", "multi", "count-default", "pipeline"],
  ["4", "unstaged GET, sleeps 1 ms, kept-alive", "multi", "count-default", "delay1"],
  ["5", "a connection for each request, no wait", "multi", "count-each-default", "get"],
  ["6", "a connection for each request, sleeps 1 ms", "multi", "count-each-default", "sdelay1"],
  ["7", "kept-alive, the first request sleeps 1 ms, the later ones do not wait: the later ones", "multi", "count-first-default", "get"],
  ["8", "kept-alive, the first two requests sleep 1 ms, the later ones do not wait: the later ones", "multi", "count-first2-default", "get"],
  ["9", "kept-alive, the first three requests sleep 1 ms, the later ones do not wait: the later ones", "multi", "count-first3-default", "get"],
  ["1", "staged GET, no wait, kept-alive", "single", "count-percore-by-hand", "get"],
  ["2", "staged GET, sleeps 1 ms, kept-alive", "single", "count-percore-by-hand", "sdelay1"],
  ["5", "a connection for each request, no wait, 10 ms after each close", "single", "count-settle", "get"],
  ["6", "a connection for each request, sleeps 1 ms, 10 ms after each close", "single", "count-settle", "sdelay1"],
  ["7", "kept-alive, the first request sleeps 1 ms, the later ones do not wait: the later ones", "single", "count-first-percore-by-hand", "get"],
  ["8", "kept-alive, the first two requests sleep 1 ms, the later ones do not wait: the later ones", "single", "count-first2-percore-by-hand", "get"],
  ["9", "kept-alive, the first three requests sleep 1 ms, the later ones do not wait: the later ones", "single", "count-first3-percore-by-hand", "get"],
];
function read(kind, name, round, kase) {
  const f = `${dir}/${kind}-${name}-${round}.txt`;
  if (!existsSync(f)) return null;
  for (const l of readFileSync(f, "utf8").split("\n")) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d ]+)\|\s*([\d.]+),\s*([\d. ]+)\|\s*([\d. ]+)$/.exec(l);
    if (m && m[1] === kase) return { median: +m[2], least: +m[3], most: +m[4], runs: m[5].trim().split(" ").map(Number), allocs: +m[6], allocRuns: m[7].trim().split(" ").map(Number), frees: m[8].trim().split(" ").map(Number) };
  }
  return null;
}
const two = (f) => [1, 2].map(f);
const show = (xs, f = (x) => x.toLocaleString("en-US")) => (xs.some((x) => x == null) ? "-" : xs[0] === xs[1] ? f(xs[0]) : `${f(xs[0])} and ${f(xs[1])}`);
const signed = (x) => `${x >= 0 ? "+" : ""}${x}`;
console.log("| Row | Request | Runtime | `main` | The change | Over `main` | `main`: most minus least of 3, by round | The change: the same |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [row, what, rt, kind, kase] of ROWS) {
  const g = (name) => two((r) => read(kind, name, r, kase));
  const m = g("main"), b = g("b");
  const med = (x) => x.map((y) => y?.median ?? null), d = (x) => x.map((y, i) => (y && m[i] ? y.median - m[i].median : null)), sp = (x) => x.map((y) => (y ? y.most - y.least : null));
  console.log(`| ${row} | ${what} | ${rt} | ${show(med(m))} | ${show(med(b))} | ${show(d(b), signed)} | ${show(sp(m), String)} | ${show(sp(b), String)} |`);
}
console.log("");
console.log("| Row | Request | Runtime | `main`: allocations a request | The change | `main`: frees | The change |");
console.log("|---|---|---|---|---|---|---|");
const fx = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(3));
for (const [row, what, rt, kind, kase] of ROWS) {
  const g = (name, k) => two((r) => { const x = read(kind, name, r, kase); if (!x) return null; const v = [...x[k]].sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; });
  console.log(`| ${row} | ${what} | ${rt} | ${show(g("main", "allocRuns"), fx)} | ${show(g("b", "allocRuns"), fx)} | ${show(g("main", "frees"), fx)} | ${show(g("b", "frees"), fx)} |`);
}
console.log("");
for (const [row, what, rt, kind, kase] of ROWS) for (const name of ["main", "b"]) for (const r of [1, 2]) { const x = read(kind, name, r, kase); if (x) console.log(`row ${row} ${rt} ${name} round ${r}: ${x.runs.join(" ")} | allocations ${x.allocRuns.join(" ")} | frees ${x.frees.join(" ")}`); }
