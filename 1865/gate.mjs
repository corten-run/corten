// gate.mjs: the declared gate of #1865's run (results/margin.md, kit 1865v3), from the results
// directory. It computes a bound only from complete, consistent evidence:
// 1. results/status.txt is unambiguous: the declared settings line, then "check ok", then
//    "main ok", then at most one diagnostic outcome and "done", each once, in that order, and no
//    other line (a pass recorded both ok and FAILED, twice, or out of order gives no gate);
// 2. for every one of the nine workloads, cycles-<w>.csv has exactly pairs 1 to 100, one base and
//    one head row each, in the declared order (odd pairs base then head, even pairs head then
//    base), with positive integer requests and counters;
// 3. raw-<w>.log has exactly the declared turns in the declared order (the warm-up pair base then
//    head, then the 100 as above), each with exactly one perf reading of each of the three counters,
//    an integer at 100% running, and exactly one wrk RESULT with no error; and every CSV counter and
//    request count is exactly that turn's raw reading (a CSV that differs from its raw log gives
//    no gate);
// 4. answers-<w>/verdict.txt says "checked <n> requests: same" with n the workload's declared
//    count of checked requests (checks-<w>.txt: 5 for the two rotating routes, 1 for the others),
//    and answers-<w>/checks.txt holds that many requests.
// Then, for each workload, the per-pair change in user+kernel cycles a request (head / base - 1),
// sorted, and its 59th smallest: the one-sided 95% upper bound on the median for 100 pairs. The
// gate is met when every workload's bound is under +1%: for that 59th pair,
// (head cycles x base requests) x 100 < (base cycles x head requests) x 101, compared as exact
// integers (BigInt), and pairs are sorted by the same exact cross-products, so a bound of exactly
// +1% is not under it. The percentages printed are rounded for reading only.
// The diagnostic pass is reported (completed, unavailable, failed or not run) and never gates.
// Exit 0: gate met. 1: evidence complete, gate not met. 2: evidence incomplete or invalid, no gate.
// Usage: node gate.mjs <results dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHECKED = { private: 1, off: 1, hit: 1, staged: 5, unstaged: 5, "unstaged-one": 1, fallback: 1, nostore: 1, immutable: 1 };
const WORKLOADS = Object.keys(CHECKED);
const PAIRS = 100;
const WARMUP = 1;
const RANK = 59;
// The margin as a ratio: a bound is under it when change < MARGIN_NUM / MARGIN_DEN - 1, i.e.
// ratio x MARGIN_DEN < MARGIN_NUM.
const MARGIN_NUM = 101n;
const MARGIN_DEN = 100n;
const SETTINGS = "settings main PAIRS=100 WARMUP=1 TURN=3; check PAIRS=0 WARMUP=0; diagnostic ICACHE_PAIRS=30 TURN=1 WARMUP=0";
const COUNTERS = ["cycles:u", "cycles:k", "instructions:u"];
const HEADER = "pair,version,requests,cycles_u,cycles_k,instructions_u";

const [, , dir] = process.argv;
if (!dir) {
  console.error("usage: node gate.mjs <results dir>");
  process.exit(2);
}
const problems = [];
const bad = (why) => problems.push(why);
const read = (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null);
const isCount = (s) => typeof s === "string" && /^[1-9][0-9]*$/.test(s);

// The order statistic for 100 pairs, checked rather than assumed: the smallest j with
// P(Binomial(100, 1/2) >= j) <= 0.05 (as summary.mjs computes it).
const upperRank = (n, alpha = 0.05) => {
  const pmf = [];
  let logc = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logc += Math.log(n - i + 1) - Math.log(i);
    pmf.push(Math.exp(logc - n * Math.LN2));
  }
  let tail = 0;
  for (let k = n; k >= 0; k--) {
    if (tail + pmf[k] > alpha) return k + 1;
    tail += pmf[k];
  }
  return 0;
};
if (upperRank(PAIRS) !== RANK) bad("the order statistic for " + PAIRS + " pairs is not " + RANK);

// status.txt: one line a step, in order, each once.
const STEPS = [
  { name: "settings", lines: [SETTINGS], required: true, gate: SETTINGS },
  { name: "check", lines: ["check ok", "check FAILED"], required: true, gate: "check ok" },
  { name: "main", lines: ["main ok", "main FAILED"], required: true, gate: "main ok" },
  { name: "diagnostic", lines: ["diagnostic ok", "diagnostic unavailable", "diagnostic FAILED"], required: false },
  { name: "done", lines: ["done"], required: false },
];
const statusText = read("status.txt");
const status = (statusText ?? "").split(/\r?\n/).filter((l) => l !== "");
let diagnostic = "diagnostic not run";
if (!status.length) bad("status.txt is missing or empty");
else {
  const seen = new Map();
  let at = 0;
  for (const line of status) {
    const i = STEPS.findIndex((s) => s.lines.includes(line));
    if (i < 0) { bad("status.txt: an unknown line '" + line + "'"); continue; }
    const step = STEPS[i];
    if (seen.has(step.name)) { bad("status.txt: the " + step.name + " step is recorded twice ('" + seen.get(step.name) + "' and '" + line + "'): the status is ambiguous"); continue; }
    if (i < at) bad("status.txt: '" + line + "' is out of order");
    at = Math.max(at, i);
    seen.set(step.name, line);
  }
  if (status[0] !== SETTINGS) bad("status.txt: the first line is not the declared settings: " + status[0]);
  for (const step of STEPS) {
    if (step.required && seen.get(step.name) !== step.gate) bad("status.txt: " + step.name + " is " + (seen.has(step.name) ? "'" + seen.get(step.name) + "'" : "absent") + ", not '" + step.gate + "'");
  }
  if (seen.has("done") && !seen.has("diagnostic")) bad("status.txt: done without a diagnostic outcome");
  if (seen.has("diagnostic")) diagnostic = seen.get("diagnostic");
}

// The declared turn order: the warm-up pairs base then head, then odd pairs base then head and
// even pairs head then base (run-pair-fresh.sh).
const order = [];
for (let p = 1; p <= WARMUP; p++) order.push("w" + p + " base", "w" + p + " head");
const recorded = [];
for (let p = 1; p <= PAIRS; p++) {
  if (p % 2 === 1) recorded.push(p + " base", p + " head");
  else recorded.push(p + " head", p + " base");
}
order.push(...recorded);

const turnsOf = (raw, workload) => {
  // "## pair <p> <version>" then perf's -x, lines and wrk's output, until the next "## pair".
  const keys = [];
  const turns = new Map();
  const blocks = raw.split(/^## pair /m);
  if (blocks[0].trim() !== "") bad(workload + ": raw log has text before its first turn");
  for (const block of blocks.slice(1)) {
    const [first, ...rest] = block.split(/\r?\n/);
    const key = first.trim();
    if (!/^(w?[0-9]+) (base|head)$/.test(key)) { bad(workload + ": raw log has a turn named '" + key + "'"); continue; }
    if (turns.has(key)) bad(workload + ": raw log has turn '" + key + "' twice");
    keys.push(key);
    turns.set(key, rest);
  }
  return { keys, turns };
};

const results = [];
for (const w of WORKLOADS) {
  const before = problems.length;
  const csv = read("cycles-" + w + ".csv");
  const raw = read("raw-" + w + ".log");
  const verdict = read("answers-" + w + "/verdict.txt");
  const checks = read("answers-" + w + "/checks.txt");
  if (csv === null) { bad(w + ": cycles-" + w + ".csv is missing"); continue; }
  if (raw === null) { bad(w + ": raw-" + w + ".log is missing"); continue; }
  const want = "checked " + CHECKED[w] + " requests: same";
  if (verdict === null || verdict.trim() !== want) bad(w + ": answers-" + w + "/verdict.txt is not '" + want + "' (" + (verdict === null ? "missing" : JSON.stringify(verdict.trim())) + ")");
  const checkLines = (checks ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (checks === null || checkLines.length !== CHECKED[w]) bad(w + ": answers-" + w + "/checks.txt holds " + (checks === null ? "nothing" : checkLines.length) + " requests, not " + CHECKED[w]);

  const [header, ...lines] = csv.trim().split(/\r?\n/);
  if (header !== HEADER) bad(w + ": CSV header is '" + header + "'");
  const rows = new Map();
  const csvKeys = [];
  for (const line of lines) {
    const f = line.split(",");
    if (f.length !== 6 || !/^[0-9]+$/.test(f[0]) || !["base", "head"].includes(f[1])) { bad(w + ": CSV row '" + line + "'"); continue; }
    const pair = Number(f[0]);
    if (pair < 1 || pair > PAIRS) bad(w + ": CSV pair " + pair + " is outside 1.." + PAIRS);
    const key = pair + " " + f[1];
    if (rows.has(key)) bad(w + ": CSV has pair " + key + " twice");
    if (!f.slice(2).every(isCount)) bad(w + ": CSV row '" + line + "' has a count that is not a positive integer");
    csvKeys.push(key);
    rows.set(key, { requests: f[2], cu: f[3], ck: f[4], iu: f[5] });
  }
  for (const key of recorded) if (!rows.has(key)) bad(w + ": CSV lacks pair " + key);
  if (rows.size !== 2 * PAIRS) bad(w + ": CSV has " + rows.size + " rows, not " + 2 * PAIRS);
  if (csvKeys.length === recorded.length && csvKeys.some((k, i) => k !== recorded[i])) {
    const i = csvKeys.findIndex((k, j) => k !== recorded[j]);
    bad(w + ": CSV turns are not in the declared order (row " + (i + 1) + " is " + csvKeys[i] + ", declared " + recorded[i] + ")");
  }

  const { keys, turns } = turnsOf(raw, w);
  if (keys.length !== order.length) bad(w + ": raw log has " + keys.length + " turns, not " + order.length);
  else if (keys.some((k, i) => k !== order[i])) {
    const i = keys.findIndex((k, j) => k !== order[j]);
    bad(w + ": raw log turns are not in the declared order (turn " + (i + 1) + " is " + keys[i] + ", declared " + order[i] + ")");
  }
  for (const key of order) {
    const body = turns.get(key);
    if (!body) { bad(w + ": raw log lacks turn " + key); continue; }
    const reading = {};
    for (const c of COUNTERS) {
      const found = body.filter((x) => x.split(",")[2] === c);
      if (found.length !== 1) { bad(w + ": turn " + key + ": " + found.length + " perf readings of " + c + ", not exactly one"); continue; }
      const f = found[0].split(",");
      if (!isCount(f[0]) || !/^[0-9.]+$/.test(f[4] ?? "") || Number(f[4]) !== 100) { bad(w + ": turn " + key + ": " + c + " not counted at 100% (" + found[0] + ")"); continue; }
      reading[c] = f[0];
    }
    const results_ = body.filter((x) => x.startsWith("RESULT "));
    const r = results_.length === 1 ? results_[0].split(" ").slice(1) : [];
    if (results_.length !== 1) bad(w + ": turn " + key + ": " + results_.length + " wrk RESULT lines, not exactly one");
    else if (r.length !== 6 || !isCount(r[0]) || r.slice(1).some((x) => x !== "0")) bad(w + ": turn " + key + ": wrk " + results_[0]);
    const row = rows.get(key);
    if (!row) continue; // the warm-up pair has no row; a missing recorded row is reported above
    if (r.length === 6 && row.requests !== r[0]) bad(w + ": turn " + key + ": CSV requests " + row.requests + " are not wrk's " + r[0]);
    const pairs_ = [["cycles:u", "cu"], ["cycles:k", "ck"], ["instructions:u", "iu"]];
    for (const [c, field] of pairs_) {
      if (reading[c] !== undefined && row[field] !== reading[c]) bad(w + ": turn " + key + ": CSV " + c + " " + row[field] + " is not the raw reading " + reading[c]);
    }
  }
  for (const key of rows.keys()) if (!order.includes(key)) bad(w + ": CSV row " + key + " is not a declared turn");
  if (problems.length !== before) continue;

  // Exact per-pair ratios: change + 1 = (head cycles / head requests) / (base cycles / base requests)
  // = (hc x br) / (bc x hr), kept as a numerator and denominator.
  const big = (x) => BigInt(x);
  const pairs = [];
  for (let p = 1; p <= PAIRS; p++) {
    const b = rows.get(p + " base"), h = rows.get(p + " head");
    const bc = big(b.cu) + big(b.ck), hc = big(h.cu) + big(h.ck);
    pairs.push({
      pair: p,
      num: hc * big(b.requests),
      den: bc * big(h.requests),
      ins: Number(h.iu) / Number(h.requests) / (Number(b.iu) / Number(b.requests)) - 1,
    });
  }
  const cmp = (a, b) => {
    const l = a.num * b.den, r = b.num * a.den;
    return l < r ? -1 : l > r ? 1 : 0;
  };
  const sorted = [...pairs].sort(cmp);
  const bound = sorted[RANK - 1];
  const under = bound.num * MARGIN_DEN < MARGIN_NUM * bound.den;
  // For reading only: the change as a double, from the exact fraction.
  const change = (x) => Number((x.num - x.den) * 10n ** 12n / x.den) / 1e12;
  const median = (s) => (change(s[PAIRS / 2 - 1]) + change(s[PAIRS / 2])) / 2;
  const sortedIns = pairs.map((x) => x.ins).sort((a, b) => a - b);
  results.push({
    workload: w,
    median: median(sorted),
    bound: change(bound),
    boundPair: bound.pair,
    boundExact: bound.num + "/" + bound.den,
    under,
    min: change(sorted[0]),
    max: change(sorted[PAIRS - 1]),
    insMedian: (sortedIns[PAIRS / 2 - 1] + sortedIns[PAIRS / 2]) / 2,
    insBound: sortedIns[RANK - 1],
  });
}

const pct = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";
const diagnosticText = {
  "diagnostic ok": "completed (icache-<w>.csv; node icache-summary.mjs; not a gate)",
  "diagnostic unavailable": "skipped: perf could not count L1-icache-load-misses:u at 100% on this host (icache-unavailable.txt); not measured",
  "diagnostic FAILED": "FAILED (icache.log); no instruction-cache result; not a gate",
  "diagnostic not run": "not run",
}[diagnostic] ?? "unknown: " + diagnostic;
if (problems.length) {
  console.log("NO GATE: the evidence is incomplete or invalid (" + problems.length + " problems):");
  for (const p of problems.slice(0, 40)) console.log("  " + p);
  if (problems.length > 40) console.log("  ... and " + (problems.length - 40) + " more");
  console.log("diagnostic pass: " + diagnosticText);
  process.exit(2);
}
console.log("| workload | median change, user+kernel cycles a request | one-sided 95% bound (59th of 100) | range | median change, user instructions | bound | under +1% (exact) |");
console.log("| --- | ---: | ---: | --- | ---: | ---: | --- |");
for (const r of results) {
  console.log("| " + r.workload + " | " + pct(r.median) + " | " + pct(r.bound) + " | " + pct(r.min) + " to " + pct(r.max) + " | " + pct(r.insMedian) + " | " + pct(r.insBound) + " | " + (r.under ? "yes" : "NO") + " |");
}
const met = results.every((r) => r.under);
console.log("gate (every workload's bound under +1%, exact; no floor): " + (met ? "MET" : "NOT MET"));
console.log("diagnostic pass: " + diagnosticText);
console.log("JSON " + JSON.stringify({ met, results, diagnostic }));
process.exit(met ? 0 : 1);