// gate.mjs: 1846r5's fail-closed validator for one workload of passes 1 and 2 (run.sh runs it after
// each pass; results/margin.md declares the plan). 1846r4's, with two checks added: no counter may
// be zero on a turn that answered requests (so neither a turn's aggregate cycles nor any paired
// change's denominator can be zero) and every paired change must be a finite number before the
// changes are sorted; and for `twice` every turn's AGED lines (lua/twice-browser.lua) must show its
// URLs asked twice and the second answer kept. It reads, in <results dir>:
//   <cycles|counts>-<w>.csv     run-pair-fresh.sh's rows
//   raw-<w>.log                 every turn's perf and wrk output, warm-up included
//   starts-<w>.txt, warm-<w>.txt, answers-<w>/verdict.txt   run.sh's start, warm-up and answer checks
// and is usable only if: the turns are the declared warm-up pair and pairs 1 to N, each build once a
// pair, in the declared order (base first in odd pairs and the warm-up, head first in even); every
// turn's perf output has each declared event once, a whole number above zero, counted exactly 100% of the turn; every
// turn's wrk RESULT line has requests above zero and no connect, read, write, status or timeout
// error; the CSV holds exactly those N pairs' rows, each equal to its turn's raw values; every start
// of both builds logged its WARM line (and, for refused, FENCE ok); and the answers were checked.
// Only then is a statistic given. For pass 1 (cycles) the gate is met only if it is usable, N is 100
// and the one-sided 95% upper bound on the median per-pair change in user plus kernel cycles a
// request (the 59th smallest of the 100) is under +1%. Pass 2 (icache) is a diagnostic: usable or
// not, with no margin.
// Usage: node gate.mjs <results dir> <workload> <cycles|icache>; exits 0 only if usable (and, for
// cycles, met), 1 otherwise, 2 on bad arguments.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { median, pct, upperRank } from "./stats.mjs";

export const PLAN = {
  cycles: { pairs: 100, warmup: 1, csv: "cycles", events: ["cycles:u", "cycles:k", "instructions:u"], columns: ["cycles_u", "cycles_k", "instructions_u"], margin: 0.01, rank: 59 },
  icache: { pairs: 30, warmup: 1, csv: "counts", events: ["L1-icache-load-misses:u", "instructions:u"], columns: ["L1_icache_load_misses_u", "instructions_u"], margin: null, rank: 20 },
};

const whole = (s) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s));
// perf's running share of a counter, printed as 100.00 when it counted the whole turn: exactly 100,
// written as digits (so not 101.00, 99.99, Infinity, NaN, 1e2 or an empty field).
export const fullShare = (s) => typeof s === "string" && /^100(\.0+)?$/.test(s);
// perf names a cache event without its :u (L1-icache-load-misses) though it counts user space only.
const sameEvent = (seen, want) => seen === want || seen === want.replace(/:u$/, "");

// The turns in the order run-pair-fresh.sh runs them.
export function expectedTurns(plan) {
  const t = [];
  for (let w = 1; w <= plan.warmup; w++) t.push(["w" + w, "base"], ["w" + w, "head"]);
  for (let p = 1; p <= plan.pairs; p++) t.push(...(p % 2 ? [[String(p), "base"], [String(p), "head"]] : [[String(p), "head"], [String(p), "base"]]));
  return t;
}

// raw: raw-<w>.log's text. Returns [{ pair, version, values, requests }] and pushes problems.
function readRaw(raw, plan, P, twice) {
  const turns = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    const h = line.match(/^## pair (\S+) (\S+)$/);
    if (h) {
      cur = { pair: h[1], version: h[2], perf: [], results: [], aged: [], errorLines: [] };
      turns.push(cur);
      continue;
    }
    if (!cur) {
      if (line.trim() !== "") P("raw: a line before the first turn: " + line);
      continue;
    }
    const f = line.split(",");
    if (f.length >= 5 && plan.events.some((e) => sameEvent(f[2], e))) cur.perf.push(f);
    else if (/^RESULT /.test(line)) cur.results.push(line);
    else if (/^AGED /.test(line)) cur.aged.push(line);
    else if (/Socket errors|Non-2xx|<not counted>|<not supported>/.test(line)) cur.errorLines.push(line.trim());
  }
  const want = expectedTurns(plan);
  const got = turns.map((t) => t.pair + " " + t.version);
  const wantS = want.map(([p, v]) => p + " " + v);
  if (got.join("|") !== wantS.join("|")) {
    const i = wantS.findIndex((w, j) => got[j] !== w);
    P("raw: " + got.length + " turns, not the declared " + wantS.length + " in order (first difference at turn " + (i + 1) + ": " + (got[i] ?? "none") + ", not " + (wantS[i] ?? "none") + ")");
  }
  const out = [];
  for (const t of turns) {
    const at = "raw " + t.pair + " " + t.version;
    const values = [];
    for (const e of plan.events) {
      const lines = t.perf.filter((f) => sameEvent(f[2], e));
      if (lines.length !== 1) { P(at + ": " + e + " reported " + lines.length + " times"); values.push(NaN); continue; }
      const [v, , , , share] = lines[0];
      if (!whole(v)) P(at + ": " + e + " " + v + " is not a whole number");
      if (!fullShare(share)) P(at + ": " + e + " counted " + JSON.stringify(share) + "% of the turn, not exactly 100%");
      values.push(whole(v) ? Number(v) : NaN);
    }
    if (t.errorLines.length) P(at + ": " + t.errorLines.join("; "));
    let requests = NaN;
    if (t.results.length !== 1) P(at + ": " + t.results.length + " RESULT lines");
    else {
      const r = t.results[0].split(" ").slice(1);
      if (r.length !== 6 || !r.every(whole)) P(at + ": " + t.results[0]);
      else if (r.slice(1).some((x) => x !== "0")) P(at + ": failed requests (connect read write status timeout: " + r.slice(1).join(" ") + ")");
      else if (!(Number(r[0]) > 0)) P(at + ": no request answered");
      else requests = Number(r[0]);
    }
    // A turn that answered requests ran on cycles and instructions and, at these turns' lengths, took
    // instruction-cache misses: a zero counter is a counter that did not count, and would make a
    // paired change's denominator zero or its change -100%.
    if (requests > 0) values.forEach((v, i) => { if (v === 0) P(at + ": " + plan.events[i] + " counted 0 on a turn that answered " + requests + " requests"); });
    const kept = twice ? checkAged(t.aged, requests, at, P) : null;
    if (!twice && t.aged.length) P(at + ": AGED lines from a workload that writes none");
    out.push({ pair: t.pair, version: t.version, values, requests, kept });
  }
  return out;
}

// twice's wrk script (lua/twice-browser.lua) prints, for each of its two threads, "AGED <thread>
// <first requests made> <second requests made> <answers with an Age> <answers without>". Each thread
// has 32 connections (wrk -t2 -c64), each with one request unanswered at most when the turn ends; a
// request wrk makes and then makes again, its write having been put off, counts twice among those
// made and is answered once (the workstation's trial turns showed a thread with 33 unanswered). So
// the turn shows its URLs asked twice and the second answer kept (the answer that queues the head's
// job) only if both threads' lines are there, whole numbers, their answers sum to RESULT's
// requests, and for each thread: no more answers than requests made and at most SLACK (64 and 1% of
// those made) not answered; no more answers with an Age than second requests (a first request is
// of a URL not asked before); at most SLACK of its second requests (64 and 1% of them) not answered
// with an Age; and some answered with one.
export const CONNECTIONS = 32;
const slack = (n) => 2 * CONNECTIONS + Math.floor(n / 100);
export function checkAged(lines, requests, at, P) {
  const seen = new Map();
  for (const line of lines) {
    const f = line.split(" ").slice(1);
    if (f.length !== 5 || !f.every(whole)) { P(at + ": " + line); continue; }
    const [thread, firsts, seconds, aged, made] = f.map(Number);
    if (seen.has(thread)) P(at + ": two AGED lines for thread " + thread);
    seen.set(thread, { firsts, seconds, aged, made });
  }
  if ([...seen.keys()].sort().join(",") !== "1,2") { P(at + ": AGED lines for threads " + ([...seen.keys()].join(",") || "none") + ", not 1 and 2"); return null; }
  let answers = 0, seconds = 0, aged = 0;
  for (const [thread, t] of seen) {
    const sent = t.firsts + t.seconds, answered = t.aged + t.made;
    answers += answered; seconds += t.seconds; aged += t.aged;
    if (answered > sent || sent - answered > slack(sent)) P(at + ": thread " + thread + " answered " + answered + " of " + sent + " requests made (at most " + slack(sent) + " unanswered)");
    if (t.aged > t.seconds) P(at + ": thread " + thread + ": " + t.aged + " answers with an Age, more than its " + t.seconds + " second requests");
    if (t.seconds - t.aged > slack(t.seconds)) P(at + ": thread " + thread + ": " + (t.seconds - t.aged) + " of " + t.seconds + " second requests not answered with an Age (at most " + slack(t.seconds) + ")");
    if (!(t.aged > 0)) P(at + ": thread " + thread + ": no second request answered with an Age");
  }
  if (Number.isFinite(requests) && answers !== requests) P(at + ": AGED answers " + answers + ", RESULT requests " + requests);
  return { seconds, aged };
}

// files: { csv, raw, starts, warm, verdict } (text, or undefined when missing).
export function validate(files, workload, kind) {
  const plan = PLAN[kind];
  const problems = [];
  const P = (s) => problems.push(s);
  if (upperRank(plan.pairs) !== plan.rank) P("the bound's rank for " + plan.pairs + " pairs is " + upperRank(plan.pairs) + ", not " + plan.rank);
  for (const k of ["csv", "raw", "starts", "warm", "verdict"]) if (files[k] === undefined) P(k + " is missing");
  const twice = workload === "twice" || workload === "twice-icache";
  const turns = files.raw === undefined ? [] : readRaw(files.raw, plan, P, twice);
  const rows = new Map();
  if (files.csv !== undefined) {
    const lines = files.csv.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const header = "pair,version,requests," + plan.columns.join(",");
    if (lines[0] !== header) P("csv: header " + lines[0] + ", not " + header);
    for (const line of lines.slice(1)) {
      const f = line.split(",");
      const key = f[0] + " " + f[1];
      if (f.length !== 3 + plan.columns.length || !/^\d+$/.test(f[0]) || !["base", "head"].includes(f[1])) { P("csv: row " + line); continue; }
      if (!f.slice(2).every(whole) || !(Number(f[2]) > 0)) P("csv: row " + line + " has a value that is not a whole number or no request");
      else if (f.slice(3).some((x) => Number(x) === 0)) P("csv: row " + line + " has a counter at 0");
      if (rows.has(key)) P("csv: two rows for pair " + key);
      rows.set(key, f.slice(2).map(Number));
    }
    for (let p = 1; p <= plan.pairs; p++) for (const v of ["base", "head"]) if (!rows.has(p + " " + v)) P("csv: no row for pair " + p + " " + v);
    for (const key of rows.keys()) {
      const [p, v] = key.split(" ");
      if (!(Number(p) >= 1 && Number(p) <= plan.pairs && String(Number(p)) === p)) P("csv: an undeclared pair " + key);
      else {
        const t = turns.find((x) => x.pair === p && x.version === v);
        const r = rows.get(key);
        if (!t) P("csv: pair " + key + " has no turn in raw");
        else if (r[0] !== t.requests || t.values.some((x, i) => x !== r[i + 1])) P("csv: pair " + key + " is not its turn's raw values");
      }
    }
  }
  const starts = 1 + plan.warmup + plan.pairs;
  const refused = workload === "refused" || workload === "refused-icache";
  if (files.starts !== undefined) {
    for (const v of ["base", "head"]) {
      const re = new RegExp("^" + workload.replace(/[-]/g, "\\-") + " " + v + ": " + starts + " of " + starts + " starts: WARM .*" + (refused ? "; FENCE ok in " + starts : "") + "$", "m");
      if (!re.test(files.starts)) P("starts: no line showing all " + starts + " starts of " + v + " warmed" + (refused ? " and fenced" : ""));
    }
  }
  if (files.warm !== undefined && !/^check-warm: /.test(files.warm)) P("warm: " + files.warm.trim());
  if (files.verdict !== undefined && !/^checked \d+ requests: /.test(files.verdict)) P("answers: " + files.verdict.trim());
  const out = { workload, kind, pairs: plan.pairs, boundRank: plan.rank, usable: problems.length === 0, problems };
  if (out.usable) {
    const stats = {};
    const cost = kind === "cycles" ? (r) => (r[1] + r[2]) / r[0] : (r) => r[1] / r[0];
    const ins = kind === "cycles" ? (r) => r[3] / r[0] : (r) => r[2] / r[0];
    for (const [name, f] of [[kind === "cycles" ? "cycles user+kernel" : "L1-icache-load-misses:u", cost], ["instructions:u", ins]]) {
      const b = [], h = [], ch = [];
      for (let p = 1; p <= plan.pairs; p++) {
        const x = f(rows.get(p + " base")), y = f(rows.get(p + " head"));
        b.push(x); h.push(y); ch.push(y / x - 1);
        // Checked before the sort: a NaN or an infinity would sort anywhere and move the bound.
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(y / x - 1)) P(name + ": pair " + p + "'s change is not a finite number (base " + x + ", head " + y + ")");
      }
      ch.sort((x, y) => x - y);
      stats[name] = { base: median(b), head: median(h), change: median(ch), bound: ch[plan.rank - 1], min: ch[0], max: ch.at(-1) };
    }
    out.usable = problems.length === 0;
    if (out.usable) {
      Object.assign(out, stats);
      if (twice) {
        // The recorded turns' second requests and those answered with an Age, each build.
        for (const v of ["base", "head"]) {
          const k = turns.filter((x) => x.version === v && !x.pair.startsWith("w")).map((x) => x.kept);
          out["second requests kept, " + v] = { seconds: k.reduce((s, x) => s + x.seconds, 0), aged: k.reduce((s, x) => s + x.aged, 0) };
        }
      }
      if (kind === "cycles") out.met = out["cycles user+kernel"].bound < plan.margin;
    }
  }
  if (kind === "cycles" && out.met === undefined) out.met = false;
  return out;
}

export function lines(out) {
  const L = [out.workload + " (" + out.kind + ", " + out.pairs + " pairs): usable " + out.usable + (out.problems.length ? " (" + out.problems.length + " problems: " + out.problems.slice(0, 20).join("; ") + ")" : "")];
  for (const name of ["cycles user+kernel", "L1-icache-load-misses:u", "instructions:u"]) {
    const m = out[name];
    if (m) L.push("  " + name + " a request: base " + m.base.toFixed(2) + ", head " + m.head.toFixed(2) + "; median change " + pct(m.change) + ", bound (rank " + out.boundRank + ") " + pct(m.bound) + ", range " + pct(m.min) + " to " + pct(m.max));
  }
  for (const v of ["base", "head"]) {
    const k = out["second requests kept, " + v];
    if (k) L.push("  second requests answered kept (" + v + ", recorded turns): " + k.aged + " of " + k.seconds + " (" + (100 * k.aged / k.seconds).toFixed(3) + "%)");
  }
  if (out.kind === "cycles") L.push("  gate (usable, 100 pairs, bound under +1%): " + (out.met ? "met" : "NOT met"));
  return L;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, workload, kind] = process.argv.slice(2);
  if (!dir || !workload || !(kind in PLAN)) {
    console.error("usage: node gate.mjs <results dir> <workload> <cycles|icache>");
    process.exit(2);
  }
  const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);
  const out = validate({
    csv: read(dir + "/" + PLAN[kind].csv + "-" + workload + ".csv"),
    raw: read(dir + "/raw-" + workload + ".log"),
    starts: read(dir + "/starts-" + workload + ".txt"),
    warm: read(dir + "/warm-" + workload + ".txt"),
    verdict: read(dir + "/answers-" + workload + "/verdict.txt"),
  }, workload, kind);
  console.log(lines(out).join("\n"));
  console.log("JSON " + JSON.stringify(out));
  process.exit(out.usable && (kind !== "cycles" || out.met) ? 0 : 1);
}
