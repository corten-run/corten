// catalog/report.mjs [<run dir>] <results dir>: the plan's reading of the catalog's pairs, for
// `page` and `json` each on its own:
//   node report.mjs /m/hc/tree-head/bench/fullstack/results > report.md
// writes report.json beside invocations.txt. Exit 0: both workloads have all their pairs valid;
// 1: one or more pairs not valid (that workload has no bound, which does not pass).
//
// A pair's change is the head's user plus kernel cycles a request over the base's, less 1, from
// the two rows count.mjs wrote (results/<round>/instructions.json, `corten/<target>`). A pair is
// valid when both invocations wrote a row, each with 5,000 requests, no failed request, no failed
// status check in its k6 summary (results/<round>/count-corten-<target>-0.json) and none of its
// five counts null, and the image counted was the side's (before and after the invocation).
// Pair 0 is not recorded. The bound is the one-sided 95% upper bound on the median per-pair
// change: the j-th smallest, j the smallest rank with P(Binomial(n, 1/2) >= j) <= 5% (the 59th
// of 100; stats.mjs's upperRank). A workload with a pair that is not valid has no bound.
// Nothing is dropped: every recorded pair is listed, valid or not, with what failed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { median, pct, upperRank } from "../stats.mjs";

const MARGIN = 0.01, REQUESTS = 5000;
const COUNTS = ["userPerRequest", "kernelPerRequest", "userCyclesPerRequest", "kernelCyclesPerRequest", "userL1iMissesPerRequest"];
const MEASURES = {
  "cycles user+kernel": (r) => r.userCyclesPerRequest + r.kernelCyclesPerRequest,
  "cycles user": (r) => r.userCyclesPerRequest,
  "cycles kernel": (r) => r.kernelCyclesPerRequest,
  "instructions user": (r) => r.userPerRequest,
  "instructions kernel": (r) => r.kernelPerRequest,
  "L1 icache misses user": (r) => r.userL1iMissesPerRequest,
};
const GATE = "cycles user+kernel";
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
const num = (x) => (x == null || !Number.isFinite(x) ? "-" : Math.round(x).toLocaleString("en-US"));

/** One invocation: its row, or why it is not valid. */
function invocation(inv, results) {
  const why = [];
  if (!inv) return { why: ["not run"] };
  if (inv.interrupted) return { why: [inv.interrupted] };
  if (inv.before !== inv.want || inv.after !== inv.want) why.push(`the image counted was not the side's (before ${inv.before.slice(7, 19)}, after ${inv.after.slice(7, 19)}, the side's ${inv.want.slice(7, 19)})`);
  const file = join(results, inv.name, "instructions.json");
  if (!existsSync(file)) return { why: [...why, `no instructions.json (count.mjs exit ${inv.rc})`], seconds: inv.seconds };
  const got = JSON.parse(readFileSync(file, "utf8"))[`corten/${inv.target}`];
  if (!got) return { why: [...why, "no row for the workload"], seconds: inv.seconds };
  if (!Array.isArray(got)) return { why: [...why, `count.mjs recorded failed: ${got.failed}`], seconds: inv.seconds };
  if (got.length !== 1) return { why: [...why, `${got.length} rows, not 1`], seconds: inv.seconds };
  const row = got[0];
  if (row.requests !== REQUESTS) why.push(`${row.requests} requests, not ${REQUESTS}`);
  if (row.failed !== 0) why.push(`${row.failed} failed requests`);
  for (const c of COUNTS) if (row[c] == null) why.push(`${c} is null (${Object.values(row.perfDiagnostics ?? {}).join("; ") || "no diagnostic"})`);
  const summary = join(results, inv.name, `count-corten-${inv.target}-0.json`);
  let checksFailed = null;
  if (!existsSync(summary)) why.push("no k6 summary of the counted load");
  else {
    const m = JSON.parse(readFileSync(summary, "utf8")).metrics;
    checksFailed = m.checks?.fails ?? null;
    if (checksFailed !== 0) why.push(`${checksFailed} failed status checks`);
    if (m.checks?.passes !== REQUESTS) why.push(`${m.checks?.passes} passed status checks, not ${REQUESTS}`);
  }
  return { why, row, checksFailed, seconds: inv.seconds, running: row.perfRunningPct };
}

export function read(runDir, results) {
  const run = Object.fromEntries(readFileSync(join(runDir, "run.txt"), "utf8").trim().split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]));
  const m = /^(\S+) prefix (\S+) pairs 0\.\.(\d+)/.exec(run.mode);
  if (!m) throw new Error("run.txt does not say the mode and pairs");
  const [mode, prefix, last] = [m[1], m[2], Number(m[3])];
  const invs = new Map();
  for (const l of readFileSync(join(runDir, "invocations.txt"), "utf8").split("\n").filter(Boolean)) {
    const f = l.split(" ");
    if (f[1] === "interrupted:") { invs.set(f[0], { name: f[0], interrupted: l.slice(f[0].length + 1) }); continue; }
    const kv = {};
    for (let i = 1; i + 1 < f.length; i += 2) kv[f[i]] = f[i + 1];
    invs.set(f[0], { name: f[0], target: kv.target, pair: Number(kv.pair), side: kv.side, want: kv.want, before: kv.before, after: kv.after, rc: Number(kv.rc), seconds: Number(kv.seconds) });
  }
  const out = { mode, prefix, last, run, targets: {} };
  for (const target of ["page", "json"]) {
    const pairs = [];
    for (let i = 0; i <= last; i++) {
      const name = (side) => `${prefix}-${target}-${String(i).padStart(3, "0")}-${side}`;
      const base = invocation(invs.get(name("base")), results), head = invocation(invs.get(name("head")), results);
      const why = [...base.why.map((w) => `base: ${w}`), ...head.why.map((w) => `head: ${w}`)];
      pairs.push({ pair: i, recorded: i > 0, valid: why.length === 0, why, base, head, first: i % 2 ? "base" : "head" });
    }
    out.targets[target] = pairs;
  }
  return out;
}

function reading(pairs) {
  const recorded = pairs.filter((p) => p.recorded), valid = recorded.filter((p) => p.valid);
  const complete = valid.length === recorded.length;
  const n = recorded.length, rank = upperRank(n);
  const by = {};
  for (const [name, f] of Object.entries(MEASURES)) {
    const changes = valid.map((p) => f(p.head.row) / f(p.base.row) - 1), sorted = [...changes].sort((a, b) => a - b);
    const a = valid.map((p) => f(p.base.row)), b = valid.map((p) => f(p.head.row));
    by[name] = {
      changes, n: changes.length, min: sorted[0] ?? null, max: sorted.at(-1) ?? null, median: changes.length ? median(changes) : null,
      bound: complete && rank >= 1 && rank <= n ? sorted[rank - 1] : null,
      base: a.length ? { median: median(a), min: Math.min(...a), max: Math.max(...a) } : null,
      head: b.length ? { median: median(b), min: Math.min(...b), max: Math.max(...b) } : null,
    };
  }
  const g = by[GATE];
  const verdict = !complete ? "no bound (a pair is not valid): does not pass" : g.bound == null ? "no bound (too few pairs for a 95% rank)" : g.bound < MARGIN ? "meets +1%" : "misses +1%";
  return { n, valid: valid.length, complete, rank: rank <= n ? rank : null, by, verdict };
}

export function report(runDir, results) {
  const r = read(runDir, results), dry = r.mode === "dry";
  const out = ["# A scope's lines in one pass: the catalog's item page and item JSON, cycles a request on one build of each side", ""];
  if (dry) out.push("**DRY RUN: a test of the scripts on the base's image alone, standing under both sides' names. No figure below is read.**", "");
  out.push(`Pairs 0 to ${r.last} of each target (pair 0 not recorded), each invocation one run of \`bench/fullstack/count.mjs <round> 1 corten <target>\` on a freshly started app; base image ${r.run.base}, head image ${r.run.head}; kernel ${r.run.kernel}; started ${r.run.started}.`, "");
  const json = { mode: r.mode, prefix: r.prefix, pairs: r.last, run: r.run, exit: 0, targets: {} };
  for (const target of ["page", "json"]) {
    const pairs = r.targets[target], s = reading(pairs), g = s.by[GATE];
    if (!s.complete) json.exit = 1;
    out.push(`## \`${target}\`: ${s.verdict}`, "");
    out.push(`${s.valid} of ${s.n} recorded pairs valid. User plus kernel cycles a request, head / base - 1 per pair: least ${fmt(g.min)}, median ${fmt(g.median)}, greatest ${fmt(g.max)}; bound (the ${s.rank ?? "-"}th smallest of ${s.n}) ${g.bound == null ? "none" : fmt(g.bound)}. Margin +1%, no floor.`, "");
    const bad = pairs.filter((p) => !p.valid);
    out.push(bad.length ? `Pairs not valid (kept, not run again, replaced or dropped): ${bad.map((p) => `${p.pair}${p.recorded ? "" : " (not recorded)"}: ${p.why.join("; ")}`).join(" | ")}.` : "Every pair is valid, the one not recorded included.", "");
    out.push("| per request | base median (range) | head median (range) | change: least | median | greatest | bound |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [name, m] of Object.entries(s.by)) {
      out.push(`| ${name} | ${num(m.base?.median)} (${num(m.base?.min)} to ${num(m.base?.max)}) | ${num(m.head?.median)} (${num(m.head?.min)} to ${num(m.head?.max)}) | ${fmt(m.min)} | ${fmt(m.median)} | ${fmt(m.max)} | ${fmt(m.bound)} |`);
    }
    const own = (side) => (g[side] ? (g[side].max - g[side].min) / g[side].median : null);
    const between = g.base && g.head ? Math.abs(g.head.median / g.base.median - 1) : null;
    out.push("", `Each side's own range across its turns, in user plus kernel cycles a request: base ${fmt(own("base"))} of its median, head ${fmt(own("head"))}; the sides' medians differ by ${fmt(between)}.${own("base") != null && between != null && Math.max(own("base"), own("head")) > between ? " A side's turns vary more than the sides differ: by item 2 this is said in place of a difference between the builds' medians, and the paired bound above is the reading." : ""}`, "");
    out.push("| pair | first | base cycles u+k | head cycles u+k | change | instructions:u | base failed, checks failed | head failed, checks failed | counters at 100% | seconds (base, head) |", "| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |");
    for (const p of pairs) {
      const f = MEASURES[GATE], ok = p.base.row && p.head.row;
      const usable = ok && COUNTS.every((c) => p.base.row[c] != null && p.head.row[c] != null);
      const all100 = (x) => (x.running ? (Object.values(x.running).every((v) => v === 100) ? "yes" : Object.entries(x.running).filter(([, v]) => v !== 100).map(([k, v]) => `${k} ${v}`).join(" ")) : "-");
      const fails = (x) => (x.row ? `${x.row.failed}, ${x.checksFailed ?? "-"}` : "-");
      out.push(`| ${p.pair}${p.recorded ? "" : " (not recorded)"}${p.valid ? "" : " NOT VALID"} | ${p.first} | ${usable ? num(f(p.base.row)) : "-"} | ${usable ? num(f(p.head.row)) : "-"} | ${usable ? pct(f(p.head.row) / f(p.base.row) - 1) : "-"} | ${usable ? pct(p.head.row.userPerRequest / p.base.row.userPerRequest - 1) : "-"} | ${fails(p.base)} | ${fails(p.head)} | ${all100(p.base)}; ${all100(p.head)} | ${p.base.seconds ?? "-"}, ${p.head.seconds ?? "-"} |`);
    }
    out.push("");
    json.targets[target] = { verdict: s.verdict, pairs: s.n, valid: s.valid, rank: s.rank, measures: Object.fromEntries(Object.entries(s.by).map(([k, m]) => [k, { ...m }])), notValid: bad.map((p) => ({ pair: p.pair, recorded: p.recorded, why: p.why })),
      invocations: pairs.map((p) => ({ pair: p.pair, first: p.first, valid: p.valid, base: { row: p.base.row ?? null, checksFailed: p.base.checksFailed ?? null, seconds: p.base.seconds ?? null }, head: { row: p.head.row ?? null, checksFailed: p.head.checksFailed ?? null, seconds: p.head.seconds ?? null } })) };
  }
  const secs = Object.values(r.targets).flat().flatMap((p) => [p.base.seconds, p.head.seconds]).filter((x) => Number.isFinite(x));
  if (secs.length) { json.seconds = { n: secs.length, median: median(secs), min: Math.min(...secs), max: Math.max(...secs) }; out.push(`An invocation took ${Math.min(...secs)} to ${Math.max(...secs)} s, median ${median(secs)} s (${secs.length} invocations).`, ""); }
  return { exit: json.exit, json, md: out.join("\n") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // With one argument it is the results directory, and the run's is the kit's own.
  const args = process.argv.slice(2);
  const [runDir, results] = args.length === 1 ? ["/m/hc/catalog-state/run", args[0]] : args;
  if (!results) { console.error("usage: node report.mjs [<run dir>] <results dir>"); process.exit(3); }
  let r;
  try { r = report(runDir, results); } catch (e) { console.error(e.stack ?? String(e)); process.exit(3); }
  writeFileSync(join(runDir, "report.json"), JSON.stringify(r.json, null, 1) + "\n");
  console.log(r.md);
  process.exit(r.exit);
}
