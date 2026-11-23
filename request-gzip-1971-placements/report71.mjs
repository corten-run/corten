// Kit 1971's results for one workload in one page: node report71.mjs <results dir> <plain|zstd>
// > placements-<workload>.md (also writes placements-<workload>.json beside it). It reads the
// placement directories p01.. of aa-<workload> and change-<workload> (each placement's
// counts-<workload>.csv and placement.txt) and reports what results/margin.md declares:
//   per placement  the median of its R per-pair changes B / A - 1 in a measure per request;
//   across         the median of the K placement medians and its one-sided 95% upper bound, the
//                  j-th smallest, j the smallest rank with P(Binomial(K, 1/2) >= j) <= 5% (the
//                  20th of 30); the lower bound is the (K + 1 - j)-th smallest;
//   the A/A        read twice from the same pairs: as recorded, and with its lists' labels
//                  swapped (each per-pair change read as A / B - 1); resolved only if both bounds
//                  are under +1%;
//   the change     meets +1% if its bound is under +1% and the A/A is resolved.
// Fail closed: a placement whose directory, CSV or placement.txt is missing, whose pairs are not
// exactly R, or whose A and B are not the plan's binaries for it (by sha256) leaves its
// comparison incomplete, and an incomplete comparison gives no bound. For zstd it also reads the
// single-build comparison sb-gzbr (SB_PAIRS pairs, the bound the 26th of 40). placement.mjs and
// stats.mjs are kit 1965's, unchanged.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { across, spread } from "./placement.mjs";
import { median, pct, upperRank } from "./stats.mjs";

const MARGIN = 0.01, REDUCTION = 0.05;
const COLUMNS = "pair,version,requests,cycles_u,cycles_k,instructions_u,L1_icache_load_misses_u";
const MEASURES = {
  "cycles user+kernel": (r) => (r.cycles_u + r.cycles_k) / r.requests,
  "cycles user": (r) => r.cycles_u / r.requests,
  "cycles kernel": (r) => r.cycles_k / r.requests,
  "instructions user": (r) => r.instructions_u / r.requests,
  "L1 icache misses user": (r) => r.icache_u / r.requests,
};
const GATE = "cycles user+kernel";
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
const ord = (n) => (n == null ? "-" : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`);
const sd = (xs) => {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

function readPairs(file) {
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (header !== COLUMNS) throw new Error(`${file}: not this kit's counts CSV`);
  const rows = lines.map((l) => {
    const [pair, version, ...v] = l.split(",");
    const n = v.map(Number);
    if (n.length !== 5 || n.some((x) => !Number.isFinite(x) || x < 0) || n[0] <= 0) throw new Error(`${file}: unusable row ${l}`);
    return { pair, version, requests: n[0], cycles_u: n[1], cycles_k: n[2], instructions_u: n[3], icache_u: n[4] };
  });
  return [...new Set(rows.map((r) => r.pair))].map((pair) => {
    const one = (v) => {
      const r = rows.filter((x) => x.pair === pair && x.version === v);
      if (r.length !== 1) throw new Error(`${file}: pair ${pair} ${v}: ${r.length} rows`);
      return r[0];
    };
    return { pair, base: one("base"), head: one("head") };
  });
}
function placementStats(pairs) {
  const out = {};
  for (const [name, f] of Object.entries(MEASURES)) {
    const changes = pairs.map((p) => f(p.head) / f(p.base) - 1);
    const swapped = pairs.map((p) => f(p.base) / f(p.head) - 1);
    out[name] = { a: median(pairs.map((p) => f(p.base))), b: median(pairs.map((p) => f(p.head))), changes, median: median(changes), swapped: median(swapped), min: Math.min(...changes), max: Math.max(...changes), sd: sd(changes) };
  }
  return out;
}

const [, , dir, W] = process.argv;
if (!dir || !["plain", "zstd"].includes(W)) throw new Error("usage: node report71.mjs <results dir> <plain|zstd>");
const env = Object.fromEntries(
  readFileSync(join(dir, "plan.env"), "utf8").split("\n").map((l) => /^([A-Z_]+)=(?:"([^"]*)"|(\S*))$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? m[3]]),
);
const dry = existsSync(join(dir, "DRYRUN"));
let K = Number(env.K), R = Number(env.R), SB = Number(env.SB_PAIRS);
if (dry) {
  const m = /K=(\d+), R=(\d+), SB_PAIRS=(\d+)/.exec(readFileSync(join(dir, "DRYRUN"), "utf8"));
  [K, R, SB] = m.slice(1).map(Number);
}
const padsP = env.PADS_P.split(/\s+/).slice(0, K), padsQ = env.PADS_Q.split(/\s+/).slice(0, K);
const shas = new Map();
for (const f of [join(dir, "sha256.txt"), join(dir, "..", "bin", "sha256.txt")]) {
  if (!existsSync(f)) continue;
  for (const l of readFileSync(f, "utf8").trim().split("\n")) { const [n, s] = l.split(" "); shas.set(n, s); }
  break;
}
const named = (info, side, name) => shas.has(name) && readFileSync(info, "utf8").trim().split("\n").some((l) => l === `${side} ${name} ${shas.get(name)}`);
const COMPARISONS = [
  { name: `aa-${W}`, what: `the change's base against itself, each side its own pad (base-p<p_i> against base-p<q_i>), on \`${W}\``, sides: (i) => [`base-p${padsP[i]}`, `base-p${padsQ[i]}`] },
  { name: `change-${W}`, what: `the change: base-p<p_i> against head-p<p_i>, each side moved by the same pad, on \`${W}\``, sides: (i) => [`base-p${padsP[i]}`, `head-p${padsP[i]}`] },
];
const results = {};
for (const c of COMPARISONS) {
  const placements = [], problems = [];
  for (let i = 0; i < K; i++) {
    const p = join(dir, c.name, `p${String(i + 1).padStart(2, "0")}`);
    const [A, B] = c.sides(i);
    const csv = join(p, `counts-${W}.csv`), info = join(p, "placement.txt");
    if (!existsSync(csv) || !existsSync(info)) { problems.push(`p${i + 1}: no CSV or placement.txt`); continue; }
    if (!named(info, "A", A) || !named(info, "B", B)) { problems.push(`p${i + 1}: placement.txt does not name ${A} and ${B} with the build's sha256`); continue; }
    let pairs;
    try { pairs = readPairs(csv); } catch (e) { problems.push(`p${i + 1}: ${e.message}`); continue; }
    if (pairs.length !== R) { problems.push(`p${i + 1}: ${pairs.length} pairs, not ${R}`); continue; }
    placements.push({ i: i + 1, A, B, stats: placementStats(pairs) });
  }
  const complete = placements.length === K && problems.length === 0;
  const acrossBy = {}, swappedBy = {}, spreadBy = {};
  for (const m of Object.keys(MEASURES)) {
    const a = across(placements.map((p) => p.stats[m].median));
    const s = across(placements.map((p) => p.stats[m].swapped));
    if (!complete) { a.bound = null; a.lower = null; s.bound = null; s.lower = null; }
    acrossBy[m] = a; swappedBy[m] = s;
    spreadBy[m] = spread(placements.map((p) => p.stats), m, R);
  }
  results[c.name] = { complete, problems, placements, across: acrossBy, swapped: swappedBy, spread: spreadBy, above: placements.filter((p) => p.stats[GATE].median > 0).length };
}
const aa = results[`aa-${W}`], change = results[`change-${W}`];
const aaBound = aa.across[GATE].bound, aaSwapped = aa.swapped[GATE].bound;
const resolved = !aa.complete || aaBound == null || aaSwapped == null ? "not resolved (incomplete)" : aaBound < MARGIN && aaSwapped < MARGIN ? "resolved" : "not resolved";
const cb = change.across[GATE].bound;
const gate = !change.complete || cb == null ? "no bound (incomplete): does not pass" : resolved !== "resolved" ? "not resolved: does not pass" : cb < MARGIN ? "meets +1%" : "misses +1%";

const out = [`# corten-run/corten#1971: cycles across placements, workload \`${W}\``, ""];
if (dry) out.push("**DRY RUN: a test of the scripts, not a measurement.**", "");
const g = (n) => results[n].across[GATE];
out.push(
  `K = ${K} placements per comparison (pads PADS_P and PADS_Q, plan.env), R = ${R} recorded pairs in each after one unrecorded pair, every turn on a fresh start. Per placement, the median of its R per-pair changes B / A - 1 in user+kernel cycles per request; across placements, the median of the K medians and its one-sided 95% upper bound, the ${ord(g(`aa-${W}`).rank)} of the ${K} sorted placement medians (lower bound: the ${ord(g(`aa-${W}`).lowerRank)}). Margin +1%, no floor. Generated by report71.mjs from the CSVs beside it.`,
  "",
  "## Verdicts",
  "",
  "| comparison | placements | median of medians | bound | bound, labels swapped | reading |",
  "| --- | ---: | ---: | ---: | ---: | --- |",
  `| aa-${W} | ${aa.placements.length} of ${K} | ${fmt(g(`aa-${W}`).median)} | ${aaBound == null ? "none" : pct(aaBound)} | ${aaSwapped == null ? "none" : pct(aaSwapped)} | A/A: **${resolved}** |`,
  `| change-${W} | ${change.placements.length} of ${K} | ${fmt(g(`change-${W}`).median)} | ${cb == null ? "none" : pct(cb)} | | **${gate}** |`,
  "",
  `Placement spread on the base (A/A, as recorded): placement medians from ${fmt(g(`aa-${W}`).min)} to ${fmt(g(`aa-${W}`).max)}.`,
  "",
);
// Diagnostic, read by nothing: the change's placement medians where the pad is a multiple of 64
// (both sides' every function and section move by exactly the pad) beside the others (the head's
// C code and the sections after .text move by the pad rounded to a multiple of 32 or 64).
const whole = change.placements.filter((p) => Number(padsP[p.i - 1]) % 64 === 0), rest = change.placements.filter((p) => Number(padsP[p.i - 1]) % 64 !== 0);
const part = (ps) => (ps.length ? `${ps.length} placements, median of medians ${fmt(median(ps.map((p) => p.stats[GATE].median)))}, from ${fmt(Math.min(...ps.map((p) => p.stats[GATE].median)))} to ${fmt(Math.max(...ps.map((p) => p.stats[GATE].median)))}` : "none");
out.push(`Diagnostic, not read: the change's placement medians where the pad is a multiple of 64 (${part(whole)}) beside the others (${part(rest)}).`, "");
for (const c of COMPARISONS) {
  const r = results[c.name];
  out.push(`## ${c.name}`, "", `${c.what}.${r.complete ? "" : ` **Incomplete:** ${r.problems.join("; ")}; no bound.`}`, "");
  out.push("| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | mean | t bound | between sd | within sd | from within |", "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const m of Object.keys(MEASURES)) {
    const a = r.across[m], w = r.swapped[m], s = r.spread[m];
    out.push(`| ${m} | ${fmt(a.median)} | ${fmt(a.bound)} | ${fmt(a.lower)} | ${fmt(a.min)} to ${fmt(a.max)} | ${fmt(w.median)} | ${fmt(w.bound)} | ${fmt(a.mean)} | ${fmt(a.tBound)} | ${fmt(s.between)} | ${fmt(s.within)} | ${fmt(s.fromWithin)} |`);
  }
  out.push("", `Placements whose median change is above zero: ${r.above} of ${r.placements.length}.`, "", "| placement | A | B | A cycles/request | B cycles/request | median change | range | user | kernel | instructions:u | L1 icache misses:u (A, B per request) |", "| ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |");
  for (const p of r.placements) {
    const t = p.stats[GATE], ic = p.stats["L1 icache misses user"];
    out.push(`| ${p.i} | ${p.A} | ${p.B} | ${t.a.toFixed(0)} | ${t.b.toFixed(0)} | ${pct(t.median)} | ${pct(t.min)} to ${pct(t.max)} | ${pct(p.stats["cycles user"].median)} | ${pct(p.stats["cycles kernel"].median)} | ${pct(p.stats["instructions user"].median)} | ${pct(ic.median)} (${ic.a.toFixed(1)}, ${ic.b.toFixed(1)}) |`);
  }
  out.push("");
}
out.push("Columns: the bound and lower bound are the order statistics above (none for an incomplete comparison); swapped reads each per-pair change as A / B - 1 (the A/A's second reading; reported for the change too, not read); mean and t bound are the mean of the placement medians and its one-sided 95% Student t bound (diagnostic); between sd is the standard deviation of the placement medians, within sd the pooled standard deviation of per-pair changes inside a placement, from within the spread a median of R pairs would have from that alone (diagnostics).", "");

let single = null;
const sbCsv = join(dir, "sb-gzbr", "counts-gzbr.csv");
if (W === "zstd") {
  out.push("## sb-gzbr", "");
  if (!existsSync(sbCsv)) out.push("No CSV: the single-build comparison did not complete; no bound, and no reduction is claimed.", "");
  else {
    const pairs = readPairs(sbCsv), n = pairs.length, k = upperRank(n);
    const info = join(dir, "sb-gzbr", "placement.txt");
    const right = named(info, "A", "base") && named(info, "B", "head") && n === SB;
    single = { pairs: n, rank: k, complete: right, measures: {} };
    out.push(`The reduction the change is for, on one build of each side: base against head (cargo's unpadded binaries), \`GET /private\` with \`Accept-Encoding: gzip, br\`, ${n} recorded pairs after one that is not${right ? "" : ` (**not the plan's ${SB} pairs or binaries: no bound**)`}; the bound is the ${ord(k)} of the ${n} sorted per-pair changes.`, "", "| per request | A median | B median | A best | B best | median per-pair change | bound | range |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const [name, f] of Object.entries(MEASURES)) {
      const a = pairs.map((p) => f(p.base)), b = pairs.map((p) => f(p.head));
      const ch = pairs.map((p) => f(p.head) / f(p.base) - 1).sort((x, y) => x - y);
      const m = { a: median(a), b: median(b), aBest: Math.min(...a), bBest: Math.min(...b), change: median(ch), bound: right && k >= 1 && k <= n ? ch[k - 1] : null, min: ch[0], max: ch[n - 1] };
      single.measures[name] = m;
      const d = name.startsWith("L1") ? 1 : 0;
      out.push(`| ${name} | ${m.a.toFixed(d)} | ${m.b.toFixed(d)} | ${m.aBest.toFixed(d)} | ${m.bBest.toFixed(d)} | ${pct(m.change)} | ${fmt(m.bound)} | ${pct(m.min)} to ${pct(m.max)} |`);
    }
    const b = single.measures[GATE].bound;
    single.reading = b == null ? "no bound: no reduction claimed" : b <= -REDUCTION ? "reduction established (bound at or below -5%)" : "reduction not established";
    out.push("", `Reading: **${single.reading}**.`, "");
  }
}
console.log(out.join("\n"));
const slim = (r) => ({ complete: r.complete, problems: r.problems, across: r.across, swapped: r.swapped, spread: r.spread, above: r.above, placements: r.placements.map((p) => ({ i: p.i, A: p.A, B: p.B, medians: Object.fromEntries(Object.entries(p.stats).map(([m, s]) => [m, { a: s.a, b: s.b, median: s.median, swapped: s.swapped, min: s.min, max: s.max }])) })) });
writeFileSync(join(dir, `placements-${W}.json`), JSON.stringify({ dry, workload: W, K, R, resolved, gate, single, results: Object.fromEntries(Object.entries(results).map(([n, r]) => [n, slim(r)])) }, null, 1) + "\n");
