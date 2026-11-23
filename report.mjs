// #1983's results in one page: node report.mjs <results dir> > placements.md (also writes
// placements.json beside it). For each comparison (aa-old, change-old, aa-young, change-young, and
// the diagnostic unpadded-old) it reads the placement directories p01.. the plan names (plan.env
// copied into the results; DRYRUN's numbers when results/DRYRUN says so), each placement's
// counts-<workload>.csv, ages-<workload>.txt and placement.txt, and reports what
// results/margin.md declares (placement.mjs): per placement the median per-pair change, across
// placements the median of the medians with its order-statistic bound, each A/A read again with
// its lists' labels swapped, the mean with its t bound, and the spread between and within
// placements; then the resolution of each A/A and the gate's reading of the change on each
// workload. Fail closed: a placement whose directory, CSV, ages or placement.txt is missing, whose
// pairs are not exactly R, whose starts' ages are not all checked and in the workload's range, or
// whose A and B binaries are not the plan's for that placement (its pads and the build's sha256)
// leaves its comparison incomplete, and an incomplete comparison gives no bound. The diagnostic is
// reported, not read.
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
const RANGE = { old: [Number(env.OLD_LOW), Number(env.OLD_HIGH)], young: [Number(env.YOUNG_LOW), Number(env.YOUNG_HIGH)] };
const padsP = env.PADS_P.split(/\s+/).slice(0, K), padsQ = env.PADS_Q.split(/\s+/).slice(0, K);
const shas = new Map();
for (const f of [join(dir, "sha256.txt"), join(dir, "..", "bin", "sha256.txt")]) {
  if (!existsSync(f)) continue;
  for (const l of readFileSync(f, "utf8").trim().split("\n")) { const [n, s] = l.split(" "); shas.set(n, s); }
  break;
}
const aaSides = (i) => [`base-p${padsP[i]}`, `base-p${padsQ[i]}`], changeSides = (i) => [`base-p${padsP[i]}`, `head-p${padsP[i]}`];
const COMPARISONS = [
  { name: "aa-old", workload: "old", k: K, r: R, aa: true, what: "base against base, each side its own pad (base-p<p_i> against base-p<q_i>), on `old` (GET /picture.png given kept, its Age past the table)", sides: aaSides },
  { name: "change-old", workload: "old", k: K, r: R, against: "aa-old", what: "the change: base-p<p_i> against head-p<p_i>, each side moved by the same pad, on `old`", sides: changeSides },
  { name: "aa-young", workload: "young", k: K, r: R, aa: true, what: "base against base, each side its own pad, on `young` (the same request, its Age in the table)", sides: aaSides },
  { name: "change-young", workload: "young", k: K, r: R, against: "aa-young", what: "the change: base-p<p_i> against head-p<p_i>, on `young`", sides: changeSides },
  { name: "unpadded-old", workload: "old", k: DK, r: DR, diagnostic: true, what: "diagnostic: base unpadded (cargo's binary) against base-p<p_i> for the first DIAG_K pads, on `old`: where the unpadded build sits among the padded ones", sides: (i) => ["base", `base-p${padsP[i]}`] },
];
// Two-sided sign test: the chance of a split at least this uneven among n placements, each side 1/2.
function signTest(k, n) {
  if (!n) return null;
  const lo = Math.min(k, n - k);
  let c = 0, t = 1;
  for (let j = 0; j <= lo; j++) { c += t; t = (t * (n - j)) / (j + 1); }
  return Math.min(1, (2 * c) / 2 ** n);
}
// A placement's starts: every one of its 2 + 2 r lines names an Age before and after its turn in
// the workload's range and one run of the handler. Returns the ages, or throws.
function readAges(file, workload, r) {
  const [low, high] = RANGE[workload];
  const lines = readFileSync(file, "utf8").trim().split("\n");
  if (lines.length !== 2 + 2 * r) throw new Error(`${lines.length} starts, not ${2 + 2 * r}`);
  const ages = [];
  for (const l of lines) {
    const m = /^\S+ (?:base|head) before (\d+) after (\d+) runs 1$/.exec(l);
    if (!m) throw new Error(`unchecked start: ${l}`);
    for (const a of [Number(m[1]), Number(m[2])]) {
      if (!(a >= low && a <= high)) throw new Error(`an Age of ${a} is not in ${low}..${high}`);
      ages.push(a);
    }
  }
  return ages;
}
const results = {};
for (const c of COMPARISONS) {
  const placements = [], problems = [], ages = [];
  for (let i = 0; i < c.k; i++) {
    const p = join(dir, c.name, `p${String(i + 1).padStart(2, "0")}`);
    const [A, B] = c.sides(i);
    const csv = join(p, `counts-${c.workload}.csv`), info = join(p, "placement.txt"), agesFile = join(p, `ages-${c.workload}.txt`);
    if (!existsSync(csv) || !existsSync(info) || !existsSync(agesFile)) { problems.push(`p${i + 1}: no CSV, ages or placement.txt`); continue; }
    const lines = readFileSync(info, "utf8").trim().split("\n");
    const ok = (side, name) => lines.some((l) => l === `${side} ${name} ${shas.get(name)}`) && shas.has(name);
    if (!ok("A", A) || !ok("B", B)) { problems.push(`p${i + 1}: placement.txt does not name ${A} and ${B} with the build's sha256`); continue; }
    let pairs;
    try { pairs = readPairs(csv); } catch (e) { problems.push(`p${i + 1}: ${e.message}`); continue; }
    if (pairs.length !== c.r) { problems.push(`p${i + 1}: ${pairs.length} pairs, not ${c.r}`); continue; }
    try { ages.push(...readAges(agesFile, c.workload, c.r)); } catch (e) { problems.push(`p${i + 1}: ${e.message}`); continue; }
    placements.push({ i: i + 1, A, B, stats: placementStats(pairs) });
  }
  const complete = placements.length === c.k && problems.length === 0;
  const acrossBy = {}, swappedBy = {}, spreadBy = {};
  for (const m of Object.keys(MEASURES)) {
    const a = across(placements.map((p) => p.stats[m].median)), s = across(placements.map((p) => p.stats[m].swapped));
    if (!complete) { a.bound = null; a.lower = null; s.bound = null; s.lower = null; }
    acrossBy[m] = a;
    swappedBy[m] = s;
    spreadBy[m] = spread(placements.map((p) => p.stats), m, c.r);
    spreadBy[m].maxAbs = placements.length ? Math.max(...placements.map((p) => Math.abs(p.stats[m].median))) : null;
  }
  const above = placements.filter((p) => p.stats["cycles user+kernel"].median > 0).length;
  results[c.name] = { complete, problems, placements, across: acrossBy, swapped: swappedBy, spread: spreadBy, above, signP: signTest(above, placements.length), starts: ages.length / 2, ageMin: ages.length ? Math.min(...ages) : null, ageMax: ages.length ? Math.max(...ages) : null };
}
const resolved = { old: resolution(results["aa-old"]), young: resolution(results["aa-young"]) };
const gate = { old: verdict(results["change-old"], results["aa-old"]), young: verdict(results["change-young"], results["aa-young"]) };
const both = gate.old === "meets +1%" && gate.young === "meets +1%";

const out = ["# corten-run/corten#1983: an older kept answer's Age written to a buffer, cycles across placements", ""];
if (dry) out.push("**DRY RUN in a container: not a measurement.** The counters are stand-ins (no PMU); every number below is the pipeline's, not a cost.", "");
const uk = (n) => results[n].across["cycles user+kernel"], sw = (n) => results[n].swapped["cycles user+kernel"];
const b = (x) => (x == null ? "none" : pct(x));
out.push(
  `K = ${K} placements per comparison (pads PADS_P and PADS_Q, plan.env), R = ${R} recorded pairs in each after one unrecorded pair, every turn on a fresh start. Per placement, the median of its R per-pair changes B / A - 1 in user+kernel cycles per request; across placements, the median of the K medians and its one-sided 95% upper bound, the ${ord(uk("aa-old").rank)} of the ${K} sorted placement medians. Each A/A is read twice from the same pairs, as recorded and with its lists' labels swapped, and resolves +1% only if both bounds are under it. Margin +${(MARGIN * 100).toFixed(0)}%, no floor. Generated by report.mjs from the CSVs beside it.`,
  "",
  "## Verdicts",
  "",
  "| comparison | placements | median of medians | bound | bound, labels swapped | the run resolves +1% | reading |",
  "| --- | ---: | ---: | ---: | ---: | --- | --- |",
);
for (const w of ["old", "young"]) {
  const aa = `aa-${w}`, ch = `change-${w}`;
  out.push(
    `| ${aa} | ${results[aa].placements.length} of ${K} | ${fmt(uk(aa).median)} | ${b(uk(aa).bound)} | ${b(sw(aa).bound)} | ${resolved[w]} | A/A: what the run can resolve on \`${w}\` |`,
    `| ${ch} | ${results[ch].placements.length} of ${K} | ${fmt(uk(ch).median)} | ${b(uk(ch).bound)} | | (${aa}) ${resolved[w]} | **${gate[w]}** |`,
  );
}
out.push(
  "",
  `**The plan's cycle condition (both workloads meet +1%, each with its A/A resolved) is ${both ? "met" : "not met"}.** The instruction and allocation conditions are counted apart from this run (margin.md).`,
  "",
  `Placement spread on base (A/A, as recorded): the placement medians run from ${fmt(uk("aa-old").min)} to ${fmt(uk("aa-old").max)} on \`old\` and from ${fmt(uk("aa-young").min)} to ${fmt(uk("aa-young").max)} on \`young\`.`,
  "",
  `Every start's Age, asked for before and after its turn: \`old\` ${results["aa-old"].ageMin} to ${results["aa-old"].ageMax} (aa-old, ${results["aa-old"].starts} starts) and ${results["change-old"].ageMin} to ${results["change-old"].ageMax} (change-old, ${results["change-old"].starts} starts), range ${RANGE.old.join(" to ")}; \`young\` ${results["aa-young"].ageMin} to ${results["aa-young"].ageMax} (aa-young, ${results["aa-young"].starts} starts) and ${results["change-young"].ageMin} to ${results["change-young"].ageMax} (change-young, ${results["change-young"].starts} starts), range ${RANGE.young.join(" to ")}. Each start's handler ran once.`,
  "",
  `Diagnostic, not read: base unpadded against base-p<p_i> on \`old\` over ${results["unpadded-old"].placements.length} of ${DK} placements, median of the placement medians ${fmt(uk("unpadded-old").median)}, range ${fmt(uk("unpadded-old").min)} to ${fmt(uk("unpadded-old").max)}; ${results["unpadded-old"].above} of ${results["unpadded-old"].placements.length} padded placements cost more than the unpadded build (two-sided sign test p = ${results["unpadded-old"].signP == null ? "-" : results["unpadded-old"].signP.toFixed(3)}).`,
  "",
);
for (const c of COMPARISONS) {
  const r = results[c.name];
  out.push(`## ${c.name}`, "", `${c.what}.${r.complete ? "" : ` **Incomplete:** ${r.problems.join("; ")}; no bound.`}${c.diagnostic ? " Its bounds are order statistics of its own count of placements and are not read." : ""}`, "");
  out.push("| per request | median of medians | bound | lower bound | range of medians | mean | t bound | between sd | within sd | from within | placement only |", "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const m of Object.keys(MEASURES)) {
    const a = r.across[m], s = r.spread[m];
    out.push(`| ${m} | ${fmt(a.median)} | ${fmt(a.bound)} | ${fmt(a.lower)} | ${fmt(a.min)} to ${fmt(a.max)} | ${fmt(a.mean)} | ${fmt(a.tBound)} | ${fmt(s.between)} | ${fmt(s.within)} | ${fmt(s.fromWithin)} | ${fmt(s.placementOnly)} |`);
  }
  if (c.aa) {
    out.push("", "With the lists' labels swapped (A / B - 1 from the same pairs):", "", "| per request | median of medians | bound | range of medians |", "| --- | ---: | ---: | --- |");
    for (const m of Object.keys(MEASURES)) { const s = r.swapped[m]; out.push(`| ${m} | ${fmt(s.median)} | ${fmt(s.bound)} | ${fmt(s.min)} to ${fmt(s.max)} |`); }
  }
  out.push("", `Placements whose median change is above zero: ${r.above} of ${r.placements.length} (two-sided sign test p = ${r.signP == null ? "-" : r.signP.toFixed(3)}); largest placement median in absolute value ${fmt(r.spread["cycles user+kernel"].maxAbs)}.`, "", "| placement | A | B | A cycles/request | B cycles/request | median change | range | user | kernel | instructions:u | L1i misses:u | A L1i/request | B L1i/request |", "| ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const p of r.placements) {
    const g = p.stats["cycles user+kernel"], l = p.stats["L1i misses user"];
    out.push(`| ${p.i} | ${p.A} | ${p.B} | ${g.a.toFixed(0)} | ${g.b.toFixed(0)} | ${pct(g.median)} | ${pct(g.min)} to ${pct(g.max)} | ${pct(p.stats["cycles user"].median)} | ${pct(p.stats["cycles kernel"].median)} | ${pct(p.stats["instructions user"].median)} | ${pct(l.median)} | ${l.a.toFixed(1)} | ${l.b.toFixed(1)} |`);
  }
  out.push("");
}
out.push(
  "Columns: the bound and lower bound are the order statistics above (no bound for an incomplete comparison); mean and t bound are the mean of the placement medians and its one-sided 95% Student t bound (diagnostic); between sd is the standard deviation of the placement medians, within sd the pooled standard deviation of per-pair changes inside a placement, from within the spread a median of R pairs would have from that alone (1.2533 x within / sqrt(R)), placement only what is left of between once that is taken out (diagnostics).",
  "",
);
console.log(out.join("\n"));
writeFileSync(join(dir, "placements.json"), JSON.stringify({ dry, K, R, DIAG_K: DK, DIAG_R: DR, resolved, gate, both, results: Object.fromEntries(Object.entries(results).map(([n, r]) => [n, { complete: r.complete, problems: r.problems, across: r.across, swapped: r.swapped, spread: r.spread, above: r.above, signP: r.signP, starts: r.starts, ageMin: r.ageMin, ageMax: r.ageMax, placements: r.placements.map((p) => ({ i: p.i, A: p.A, B: p.B, medians: Object.fromEntries(Object.entries(p.stats).map(([m, s]) => [m, { a: s.a, b: s.b, median: s.median, swapped: s.swapped, min: s.min, max: s.max }])) })) }])) }, null, 1) + "\n");
