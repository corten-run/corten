// shares.mjs: how often one placement of a commit against another placement of the same commit
// read at or beyond the +1% line, in the A/As across placements that design Choice 72 records.
//
//   node shares.mjs [medians.csv] > shares.txt      (from a clone that has the evidence tags)
//
// It reads every placement's counts from the four evidence tags below with `git show`, counts no
// cycle itself, and recomputes each placement's statistic as the kits do: per recorded pair the
// change B / A - 1 in user plus kernel cycles a request (A the CSV's "base" rows, B its "head"
// rows: two pad lists of one commit), per placement the median of its R = 8 changes. It then
// counts, per A/A and pooled:
//
//   1. the placement medians at or above +1%, and at or below -1%;
//   2. with each median m moved to (1 + m)(1 + c) - 1 for c = +1%, +2% and +3%, those under +1%:
//      what one placement would have read under the line had B cost c more than A everywhere.
//
// Each is also given with the lists' labels swapped (each pair read as A / B - 1), since which
// list was called A is arbitrary.
//
// What the numbers are: medians of 8 pairs, one placement of a commit against one other. What
// they are not: the single-build gate's statistic (the 59th of 100 sorted per-pair changes on
// the unpadded builds), and so not a measured false-pass or false-miss rate of that gate. See
// README.md beside this file.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const AAS = [
  { run: "first", tag: "evidence/ee7b0b41", name: "plain", K: 30, file: (p) => `results/aa-plain/p${p}/cycles-plain.csv` },
  { run: "first", tag: "evidence/ee7b0b41", name: "kept", K: 30, file: (p) => `results/aa-kept/p${p}/cycles-kept.csv` },
  { run: "second", tag: "evidence/0c0c599c", name: "young", K: 30, file: (p) => `results/aa-young/p${p}/counts-young.csv` },
  { run: "second", tag: "evidence/0c0c599c", name: "old", K: 30, file: (p) => `results/aa-old/p${p}/counts-old.csv` },
  { run: "third", tag: "evidence/stage-header-checks-2002", name: "page", K: 60, file: (p) => `stage-header-checks-2002/results/plain/results/aa-plain/p${p}/counts-plain.csv` },
  { run: "third", tag: "evidence/stage-header-checks-2002", name: "page, browser headers", K: 60, file: (p) => `stage-header-checks-2002/results/browser/results/aa-browser/p${p}/counts-browser.csv` },
  { run: "third", tag: "evidence/stage-header-checks-2002", name: "api", K: 60, file: (p) => `stage-header-checks-2002/results/api/results/aa-api/p${p}/counts-api.csv` },
  { run: "fourth", tag: "evidence/placement-sizing-1999", name: "old", K: 100, file: (p) => `placement-sizing-1999/results/aa-old/p${p}/counts-old.csv` },
];
const R = 8, LINE = 0.01, COSTS = [0.01, 0.02, 0.03];

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (xs) => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const pct = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";
const share = (n, k) => `${n} of ${k} (${((100 * n) / k).toFixed(1)}%)`;

// One placement's CSV: the median of its R per-pair changes, as recorded and with labels swapped.
function placement(text, where) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  const at = (n) => { const i = cols.indexOf(n); if (i < 0) throw new Error(`${where}: no ${n}`); return i; };
  const [iPair, iVersion, iReq, iU, iK] = ["pair", "version", "requests", "cycles_u", "cycles_k"].map(at);
  const cost = new Map();
  for (const l of lines) {
    const v = l.split(",");
    const [req, u, k] = [v[iReq], v[iU], v[iK]].map(Number);
    if (!(req > 0 && u > 0 && k > 0)) throw new Error(`${where}: unusable row ${l}`);
    const key = `${v[iPair]} ${v[iVersion]}`;
    if (cost.has(key)) throw new Error(`${where}: two rows for ${key}`);
    cost.set(key, (u + k) / req);
  }
  const pairs = [...new Set(lines.map((l) => l.split(",")[iPair]))];
  if (pairs.length !== R || cost.size !== 2 * R) throw new Error(`${where}: ${pairs.length} pairs, not ${R}`);
  const a = pairs.map((p) => cost.get(`${p} base`)), b = pairs.map((p) => cost.get(`${p} head`));
  return { recorded: median(a.map((x, i) => b[i] / x - 1)), swapped: median(a.map((x, i) => x / b[i] - 1)) };
}

function count(ms) {
  return {
    k: ms.length,
    over: ms.filter((m) => m >= LINE).length,
    under: ms.filter((m) => m <= -LINE).length,
    pass: COSTS.map((c) => ms.filter((m) => (1 + m) * (1 + c) - 1 < LINE).length),
  };
}
const row = (label, c) => `| ${label} | ${c.k} | ${share(c.over, c.k)} | ${share(c.under, c.k)} | ${c.pass.map((n) => share(n, c.k)).join(" | ")} |`;

const out = [], csv = ["run,tag,commit,workload,placement,median_recorded,median_swapped"];
const all = { recorded: [], swapped: [] }, per = [];
out.push("Same-commit comparisons across placements, from the A/As design Choice 72 records.", "");
out.push("| A/A | tag (commit) | K | lowest median | highest median | standard deviation |", "| --- | --- | ---: | ---: | ---: | ---: |");
for (const aa of AAS) {
  const commit = git("rev-parse", `refs/tags/${aa.tag}^{commit}`).trim();
  const width = aa.K >= 100 ? 3 : 2;
  const ms = [];
  for (let i = 1; i <= aa.K; i++) {
    const path = aa.file(String(i).padStart(width, "0"));
    const m = placement(git("show", `${commit}:${path}`), `${aa.tag}:${path}`);
    ms.push(m);
    csv.push([aa.run, aa.tag, commit.slice(0, 9), aa.name, i, m.recorded.toFixed(6), m.swapped.toFixed(6)].join(","));
  }
  const rec = ms.map((m) => m.recorded), swp = ms.map((m) => m.swapped);
  all.recorded.push(...rec);
  all.swapped.push(...swp);
  per.push({ label: `${aa.run} run, \`${aa.name}\``, rec: count(rec), swp: count(swp) });
  out.push(`| ${aa.run} run, \`${aa.name}\` | \`${aa.tag}\` (\`${commit.slice(0, 9)}\`) | ${aa.K} | ${pct(Math.min(...rec))} | ${pct(Math.max(...rec))} | ${(100 * sd(rec)).toFixed(2)}% |`);
}
const head = ["| A/A | placements | median at or above +1% | median at or below -1% | under +1% with a cost of +1% | of +2% | of +3% |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"];
for (const [reading, key, list] of [["as recorded (B / A - 1)", "rec", all.recorded], ["with the lists' labels swapped (A / B - 1)", "swp", all.swapped]]) {
  out.push("", `Placement medians ${reading}:`, "", ...head);
  for (const p of per) out.push(row(p.label, p[key]));
  out.push(row("pooled, every placement counted once", count(list)));
  const mean = (f) => (100 * per.reduce((s, p) => s + f(p[key]) / p[key].k, 0)) / per.length;
  out.push(`| mean of the eight A/As' shares | ${per.length} A/As | ${mean((c) => c.over).toFixed(1)}% | ${mean((c) => c.under).toFixed(1)}% | ${COSTS.map((_, i) => mean((c) => c.pass[i]).toFixed(1) + "%").join(" | ")} |`);
  const both = per.filter((p) => p[key].over > 0 && p[key].under > 0).length;
  out.push("", `A/As with a placement median at or above +1% and another at or below -1%: ${both} of ${per.length}.`);
}
out.push("", `Pooled: ${all.recorded.length} placements, medians from ${pct(Math.min(...all.recorded))} to ${pct(Math.max(...all.recorded))}; with the labels swapped, from ${pct(Math.min(...all.swapped))} to ${pct(Math.max(...all.swapped))}.`);
console.log(out.join("\n"));
if (process.argv[2]) writeFileSync(process.argv[2], csv.join("\n") + "\n");
