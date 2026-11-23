// #1965's results in one page: node report.mjs <results dir> > placements.md (also writes
// placements.json beside it). For each comparison (aa-plain, aa-kept, change-kept, and the
// diagnostic unpadded-kept) it reads the placement directories p01.. the plan names (plan.env copied
// into the results; DRYRUN's numbers when results/DRYRUN says so), each placement's cycles-<workload>.csv and placement.txt, and
// reports what results/margin.md declares (placement.mjs): per placement the median per-pair
// change, across placements the median of the medians with its order-statistic bound, the mean
// with its t bound, and the spread between and within placements; then the resolution of each
// A/A and the gate's reading of the change. Fail closed: a placement whose directory, CSV or
// placement.txt is missing, whose pairs are not exactly R, or whose A and B binaries are not the
// plan's for that placement (its pads and the build's sha256) leaves its comparison incomplete, and
// an incomplete comparison gives no bound. Each A/A also gives its largest placement median in
// absolute value: how far one pair of builds, each at one placement, sat from no change (the
// spread a single-build run can sit off by, Choice 72). The diagnostic is reported, not read.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARGIN, MEASURES, across, placementStats, readPairs, resolution, spread, verdict } from "./placement.mjs";
import { pct } from "./stats.mjs";
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
const ord = (n) => (n == null ? "-" : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`);

const [, , dir] = process.argv;
if (!dir) throw new Error("usage: node report.mjs <results dir>");
const env = Object.fromEntries(
  readFileSync(join(dir, "plan.env"), "utf8").split("\n").map((l) => /^([A-Z_]+)=(?:"([^"]*)"|(\S*))$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? m[3]]),
);
const dry = existsSync(join(dir, "DRYRUN"));
let K = Number(env.K), R = Number(env.R), DK = Number(env.DIAG_K), DR = Number(env.DIAG_R);
if (dry) {
  const m = /K=(\d+), R=(\d+), DIAG_K=(\d+), DIAG_R=(\d+)/.exec(readFileSync(join(dir, "DRYRUN"), "utf8"));
  [K, R, DK, DR] = m.slice(1).map(Number);
}
const padsP = env.PADS_P.split(/\s+/).slice(0, K), padsQ = env.PADS_Q.split(/\s+/).slice(0, K);
const shas = new Map();
for (const f of [join(dir, "sha256.txt"), join(dir, "..", "bin", "sha256.txt")]) {
  if (!existsSync(f)) continue;
  for (const l of readFileSync(f, "utf8").trim().split("\n")) { const [n, s] = l.split(" "); shas.set(n, s); }
  break;
}
const COMPARISONS = [
  { name: "aa-plain", workload: "plain", k: K, r: R, what: "main against main, each side its own pad (main-p<p_i> against main-p<q_i>), on `plain` (GET /private)", sides: (i) => [`main-p${padsP[i]}`, `main-p${padsQ[i]}`] },
  { name: "aa-kept", workload: "kept", k: K, r: R, what: "main against main, each side its own pad (main-p<p_i> against main-p<q_i>), on `kept` (GET /page, given kept)", sides: (i) => [`main-p${padsP[i]}`, `main-p${padsQ[i]}`] },
  { name: "change-kept", workload: "kept", k: K, r: R, what: "#1955's change: base-p<p_i> against head-p<p_i>, each side moved by the same pad, on `kept`", sides: (i) => [`base-p${padsP[i]}`, `head-p${padsP[i]}`] },
  { name: "unpadded-kept", workload: "kept", k: DK, r: DR, diagnostic: true, what: "diagnostic: main unpadded (cargo's binary) against main-p<p_i> for the first DIAG_K pads, on `kept`: where the unpadded build sits among the padded ones", sides: (i) => ["main", `main-p${padsP[i]}`] },
];
// Two-sided sign test: the chance of a split at least this uneven among n placements, each side 1/2.
function signTest(k, n) {
  if (!n) return null;
  const lo = Math.min(k, n - k);
  let c = 0, t = 1;
  for (let j = 0; j <= lo; j++) { c += t; t = (t * (n - j)) / (j + 1); }
  return Math.min(1, (2 * c) / 2 ** n);
}
const results = {};
for (const c of COMPARISONS) {
  const placements = [], problems = [];
  for (let i = 0; i < c.k; i++) {
    const p = join(dir, c.name, `p${String(i + 1).padStart(2, "0")}`);
    const [A, B] = c.sides(i);
    const csv = join(p, `cycles-${c.workload}.csv`), info = join(p, "placement.txt");
    if (!existsSync(csv) || !existsSync(info)) { problems.push(`p${i + 1}: no CSV or placement.txt`); continue; }
    const lines = readFileSync(info, "utf8").trim().split("\n");
    const ok = (side, name) => lines.some((l) => l === `${side} ${name} ${shas.get(name)}`) && shas.has(name);
    if (!ok("A", A) || !ok("B", B)) { problems.push(`p${i + 1}: placement.txt does not name ${A} and ${B} with the build's sha256`); continue; }
    let pairs;
    try { pairs = readPairs(csv); } catch (e) { problems.push(`p${i + 1}: ${e.message}`); continue; }
    if (pairs.length !== c.r) { problems.push(`p${i + 1}: ${pairs.length} pairs, not ${c.r}`); continue; }
    placements.push({ i: i + 1, A, B, stats: placementStats(pairs) });
  }
  const complete = placements.length === c.k && problems.length === 0;
  const acrossBy = {}, spreadBy = {};
  for (const m of Object.keys(MEASURES)) {
    const a = across(placements.map((p) => p.stats[m].median));
    if (!complete) { a.bound = null; a.lower = null; }
    acrossBy[m] = a;
    spreadBy[m] = spread(placements.map((p) => p.stats), m, c.r);
    spreadBy[m].maxAbs = placements.length ? Math.max(...placements.map((p) => Math.abs(p.stats[m].median))) : null;
  }
  const above = placements.filter((p) => p.stats["cycles user+kernel"].median > 0).length;
  results[c.name] = { complete, problems, placements, across: acrossBy, spread: spreadBy, above, signP: signTest(above, placements.length) };
}
const resolved = { plain: resolution(results["aa-plain"]), kept: resolution(results["aa-kept"]) };
const gate = verdict(results["change-kept"], results["aa-kept"]);

const out = ["# corten-run/corten#1965: cycles across placements", ""];
if (dry) out.push("**DRY RUN in a container: not a measurement.** The counters are stand-ins (no PMU); every number below is the pipeline's, not a cost.", "");
const uk = (n) => results[n].across["cycles user+kernel"];
out.push(
  `K = ${K} placements per comparison (pads PADS_P and PADS_Q, plan.env), R = ${R} recorded pairs in each after one unrecorded pair, every turn on a fresh start. Per placement, the median of its R per-pair changes B / A - 1 in user+kernel cycles per request; across placements, the median of the K medians and its one-sided 95% upper bound, the ${ord(uk("aa-plain").rank)} of the ${K} sorted placement medians (lower bound, for the benefit side: the ${ord(uk("aa-plain").lowerRank)}). Margin +${(MARGIN * 100).toFixed(0)}%, no floor. Generated by report.mjs from the CSVs beside it.`,
  "",
  "## Verdicts",
  "",
  "| comparison | placements | median of medians | bound | the run resolves +1% | reading |",
  "| --- | ---: | ---: | ---: | --- | --- |",
  `| aa-plain | ${results["aa-plain"].placements.length} of ${K} | ${pct(uk("aa-plain").median)} | ${uk("aa-plain").bound == null ? "none" : pct(uk("aa-plain").bound)} | ${resolved.plain} | A/A: what the run can resolve on \`plain\` |`,
  `| aa-kept | ${results["aa-kept"].placements.length} of ${K} | ${pct(uk("aa-kept").median)} | ${uk("aa-kept").bound == null ? "none" : pct(uk("aa-kept").bound)} | ${resolved.kept} | A/A: what the run can resolve on \`kept\` |`,
  `| change-kept | ${results["change-kept"].placements.length} of ${K} | ${pct(uk("change-kept").median)} | ${uk("change-kept").bound == null ? "none" : pct(uk("change-kept").bound)} | (aa-kept) ${resolved.kept} | **${gate}** |`,
  "",
  `Placement spread on main (A/A): the largest placement median in absolute value is ${fmt(results["aa-plain"].spread["cycles user+kernel"].maxAbs)} on \`plain\` and ${fmt(results["aa-kept"].spread["cycles user+kernel"].maxAbs)} on \`kept\`, the range of placement medians ${fmt(uk("aa-plain").min)} to ${fmt(uk("aa-plain").max)} and ${fmt(uk("aa-kept").min)} to ${fmt(uk("aa-kept").max)}: how far a single-build run, one placement on each side, can sit from no change (Choice 72 reads a touched workload across placements only when a single-build bound on it, less +1%, lands inside this range).`,
  "",
  `Diagnostic, not read: main unpadded against main-p<p_i> on \`kept\` over ${results["unpadded-kept"].placements.length} of ${DK} placements, median of the placement medians ${fmt(uk("unpadded-kept").median)}, range ${fmt(uk("unpadded-kept").min)} to ${fmt(uk("unpadded-kept").max)}; ${results["unpadded-kept"].above} of ${results["unpadded-kept"].placements.length} padded placements cost more than the unpadded build (two-sided sign test p = ${results["unpadded-kept"].signP == null ? "-" : results["unpadded-kept"].signP.toFixed(3)}).`,
  "",
);
for (const c of COMPARISONS) {
  const r = results[c.name];
  out.push(`## ${c.name}`, "", `${c.what}.${r.complete ? "" : ` **Incomplete:** ${r.problems.join("; ")}; no bound.`}${c.diagnostic ? " Its bounds are order statistics of its own count of placements and are not read." : ""}`, "");
  out.push("| per request | median of medians | bound | lower bound | range of medians | mean | t bound | between sd | within sd | from within | placement only |", "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const m of Object.keys(MEASURES)) {
    const a = r.across[m], s = r.spread[m];
    const f = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
    out.push(`| ${m} | ${f(a.median)} | ${f(a.bound)} | ${f(a.lower)} | ${f(a.min)} to ${f(a.max)} | ${f(a.mean)} | ${f(a.tBound)} | ${f(s.between)} | ${f(s.within)} | ${f(s.fromWithin)} | ${f(s.placementOnly)} |`);
  }
  out.push("", `Placements whose median change is above zero: ${r.above} of ${r.placements.length} (two-sided sign test p = ${r.signP == null ? "-" : r.signP.toFixed(3)}); largest placement median in absolute value ${fmt(r.spread["cycles user+kernel"].maxAbs)}.`, "", "| placement | A | B | A cycles/request | B cycles/request | median change | range | user | kernel | instructions:u |", "| ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |");
  for (const p of r.placements) {
    const g = p.stats["cycles user+kernel"];
    out.push(`| ${p.i} | ${p.A} | ${p.B} | ${g.a.toFixed(0)} | ${g.b.toFixed(0)} | ${pct(g.median)} | ${pct(g.min)} to ${pct(g.max)} | ${pct(p.stats["cycles user"].median)} | ${pct(p.stats["cycles kernel"].median)} | ${pct(p.stats["instructions user"].median)} |`);
  }
  out.push("");
}
out.push(
  "Columns: the bound and lower bound are the order statistics above (no bound for an incomplete comparison); mean and t bound are the mean of the placement medians and its one-sided 95% Student t bound (diagnostic); between sd is the standard deviation of the placement medians, within sd the pooled standard deviation of per-pair changes inside a placement, from within the spread a median of R pairs would have from that alone (1.2533 x within / sqrt(R)), placement only what is left of between once that is taken out (diagnostics).",
  "",
);
console.log(out.join("\n"));
writeFileSync(join(dir, "placements.json"), JSON.stringify({ dry, K, R, DIAG_K: DK, DIAG_R: DR, resolved, gate, results: Object.fromEntries(Object.entries(results).map(([n, r]) => [n, { complete: r.complete, problems: r.problems, across: r.across, spread: r.spread, above: r.above, signP: r.signP, placements: r.placements.map((p) => ({ i: p.i, A: p.A, B: p.B, medians: Object.fromEntries(Object.entries(p.stats).map(([m, s]) => [m, { a: s.a, b: s.b, median: s.median, min: s.min, max: s.max }])) })) }])) }, null, 1) + "\n");