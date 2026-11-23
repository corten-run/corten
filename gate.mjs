// gate.mjs: 1846r3's fail-closed validator for one workload of passes 1 and 2 (run.sh runs it after
// each pass; results/margin.md declares the plan). It reads, in <results dir>:
//   <cycles|counts>-<w>.csv     run-pair-fresh.sh's rows
//   raw-<w>.log                 every turn's perf and wrk output, warm-up included
//   starts-<w>.txt, warm-<w>.txt, answers-<w>/verdict.txt   run.sh's start, warm-up and answer checks
// and is usable only if: the turns are the declared warm-up pair and pairs 1 to N, each build once a
// pair, in the declared order (base first in odd pairs and the warm-up, head first in even); every
// turn's perf output has each declared event once, a whole number, counted 100% of the turn; every
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
function readRaw(raw, plan, P) {
  const turns = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    const h = line.match(/^## pair (\S+) (\S+)$/);
    if (h) {
      cur = { pair: h[1], version: h[2], perf: [], results: [], errorLines: [] };
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
      if (!(Number(share) >= 100)) P(at + ": " + e + " counted " + share + "% of the turn, not 100%");
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
    out.push({ pair: t.pair, version: t.version, values, requests });
  }
  return out;
}

// files: { csv, raw, starts, warm, verdict } (text, or undefined when missing).
export function validate(files, workload, kind) {
  const plan = PLAN[kind];
  const problems = [];
  const P = (s) => problems.push(s);
  if (upperRank(plan.pairs) !== plan.rank) P("the bound's rank for " + plan.pairs + " pairs is " + upperRank(plan.pairs) + ", not " + plan.rank);
  for (const k of ["csv", "raw", "starts", "warm", "verdict"]) if (files[k] === undefined) P(k + " is missing");
  const turns = files.raw === undefined ? [] : readRaw(files.raw, plan, P);
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
    const cost = kind === "cycles" ? (r) => (r[1] + r[2]) / r[0] : (r) => r[1] / r[0];
    const ins = kind === "cycles" ? (r) => r[3] / r[0] : (r) => r[2] / r[0];
    for (const [name, f] of [[kind === "cycles" ? "cycles user+kernel" : "L1-icache-load-misses:u", cost], ["instructions:u", ins]]) {
      const b = [], h = [], ch = [];
      for (let p = 1; p <= plan.pairs; p++) {
        const x = f(rows.get(p + " base")), y = f(rows.get(p + " head"));
        b.push(x); h.push(y); ch.push(y / x - 1);
      }
      ch.sort((x, y) => x - y);
      out[name] = { base: median(b), head: median(h), change: median(ch), bound: ch[plan.rank - 1], min: ch[0], max: ch.at(-1) };
    }
    if (kind === "cycles") out.met = out["cycles user+kernel"].bound < plan.margin;
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
