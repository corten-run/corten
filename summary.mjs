// summary.mjs: corten-run/corten#1824's kit (1824e). Reads every results/pairs-<name>.csv that
// run-pair.sh wrote, prints a table a comparison and the verdicts results/margin.md declares, and
// ends with a JSON line of everything.
// Usage: node summary.mjs <results dir> [seconds per turn, default 3]
//
// In each comparison A is the CSV's base rows and B its head rows. Per request: cycles (user +
// kernel, user, kernel) and user instructions as the median per-pair change B / A - 1, with the
// one-sided 95% upper bound on that median (an order statistic, distribution-free: the j-th
// smallest change with j the least rank whose binomial tail is at most 5%: the 20th of 30, the
// 26th of 40, the 59th of 100) and the range; page faults, minor faults (perf), minflt (/proc),
// resident bytes a request ((VmRSS after - VmRSS before) / requests), resident memory before the
// load and AnonHugePages after it as the median per-pair difference B - A, with the same bound.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const [, , dir, turnArg] = process.argv;
if (!dir) throw new Error("usage: node summary.mjs <results dir> [seconds per turn]");
const turn = Number(turnArg ?? 3);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
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
const pct = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%" : "n/a");
const num = (x, d = 0) => (x >= 0 && d === 0 ? "" : "") + x.toFixed(d);
const signed = (x, d = 0) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");

const RATIO = {
  "cycles user+kernel": (r) => (r.cycles_u + r.cycles_k) / r.requests,
  "cycles user": (r) => r.cycles_u / r.requests,
  "cycles kernel": (r) => r.cycles_k / r.requests,
  "instructions user": (r) => r.instructions_u / r.requests,
  "L1 icache misses user (diagnostic)": (r) => (Number.isFinite(r.icache_u) ? r.icache_u / r.requests : NaN),
};
const DIFF = {
  "cycles kernel (difference)": (r) => r.cycles_k / r.requests,
  "page faults (perf)": (r) => r.page_faults / r.requests,
  "minor faults (perf)": (r) => r.minor_faults / r.requests,
  "minflt (/proc)": (r) => r.minflt / r.requests,
  "resident bytes": (r) => ((r.rss_end_kb - r.rss_idle_kb) * 1024) / r.requests,
  "resident KiB before load (per process)": (r) => r.rss_idle_kb * r.requests,
  "AnonHugePages KiB after (per process)": (r) => r.anon_huge_kb * r.requests,
};

function load(file) {
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const names = header.split(",");
  const data = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [names[i], i < 2 ? v : v === "" ? null : Number(v)])));
  for (const r of data) {
    for (const c of ["requests", "cycles_u", "cycles_k", "instructions_u"]) {
      if (!Number.isFinite(r[c])) throw new Error(file + ": pair " + r.pair + " " + r.version + ": no usable " + c + " (a run without perf is not a measurement)");
    }
    if (!(r.requests > 0)) throw new Error(file + ": pair " + r.pair + " " + r.version + ": " + r.requests + " requests (a turn that answered none is not a measurement)");
    // A blank or missing count of failed requests is not a count of none: the turn is unusable.
    if (!Number.isInteger(r.errors) || r.errors < 0) throw new Error(file + ": pair " + r.pair + " " + r.version + ": no usable errors (blank or missing is not zero)");
  }
  const pairs = [...new Set(data.map((r) => r.pair))];
  const row = (pair, version) => {
    const r = data.filter((x) => x.pair === pair && x.version === version);
    if (r.length !== 1) throw new Error(file + ": pair " + pair + " " + version + ": " + r.length + " rows");
    return r[0];
  };
  const n = pairs.length;
  const k = upperRank(n);
  const out = { file, pairs: n, boundRank: k, ratio: {}, diff: {}, failures: data.reduce((s, r) => s + r.errors, 0) };
  for (const [name, f] of Object.entries(RATIO)) {
    if (name.startsWith("L1") && !data.every((r) => Number.isFinite(r.icache_u) && r.icache_u > 0)) continue;
    const a = pairs.map((p) => f(row(p, "base")));
    const b = pairs.map((p) => f(row(p, "head")));
    const ch = pairs.map((p, i) => b[i] / a[i] - 1).sort((x, y) => x - y);
    out.ratio[name] = { a: median(a), b: median(b), change: median(ch), bound: k > 0 ? ch[k - 1] : NaN, min: ch[0], max: ch[n - 1] };
  }
  for (const [name, f0] of Object.entries(DIFF)) {
    const per = name.includes("(per process)");
    const f = per ? (r) => f0(r) / r.requests : f0;
    const a = pairs.map((p) => f(row(p, "base")));
    const b = pairs.map((p) => f(row(p, "head")));
    const d = pairs.map((p, i) => b[i] - a[i]).sort((x, y) => x - y);
    out.diff[name] = { a: median(a), b: median(b), change: median(d), bound: k > 0 ? d[k - 1] : NaN, min: d[0], max: d[n - 1] };
  }
  out.aRequestsPerSecond = median(pairs.map((p) => row(p, "base").requests / turn));
  out.bRequestsPerSecond = median(pairs.map((p) => row(p, "head").requests / turn));
  return out;
}

function table(name, s) {
  const lines = [
    `### ${name}: ${s.pairs} pairs, bound = change of rank ${s.boundRank}, failed requests ${s.failures}`,
    "| per request | A median | B median | median per-pair change | one-sided 95% bound | range |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const [m, v] of Object.entries(s.ratio)) {
    const d = m.startsWith("cycles") || m.startsWith("L1") ? 0 : 1;
    lines.push(`| ${m} | ${v.a.toFixed(d)} | ${v.b.toFixed(d)} | ${pct(v.change)} | ${pct(v.bound)} | ${pct(v.min)} to ${pct(v.max)} |`);
  }
  for (const [m, v] of Object.entries(s.diff)) {
    const d = m.startsWith("cycles") || m.startsWith("resident") || m.startsWith("Anon") ? 0 : 3;
    lines.push(`| ${m} | ${v.a.toFixed(d)} | ${v.b.toFixed(d)} | ${signed(v.change, d)} | ${signed(v.bound, d)} | ${signed(v.min, d)} to ${signed(v.max, d)} |`);
  }
  lines.push(`median requests/s: A ${s.aRequestsPerSecond.toFixed(0)}, B ${s.bRequestsPerSecond.toFixed(0)}`);
  return lines.join("\n");
}

const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^pairs-.*\.csv$/.test(f)).sort() : [];
const runs = {};
for (const f of files) {
  const name = f.replace(/^pairs-|\.csv$/g, "");
  try {
    const lines = readFileSync(join(dir, f), "utf8").trim().split(/\r?\n/);
    if (lines.length < 3) { console.log(`### ${name}: no recorded pairs`); continue; }
    runs[name] = load(join(dir, f));
    console.log(table(name, runs[name]));
    console.log("");
  } catch (e) {
    console.log(`### ${name}: not summarized: ${e.message}`);
  }
}

// The verdicts margin.md declares. A is main, B the candidate. EXPECT: the bytes a kept answer
// holds that the candidate saves (the allocation map, jemalloc's classes), and the kernel cycles
// that is at 0.95 a byte (#1824's profile). Gated, every one the change's code runs in: room,
// jroom, hit and plain, each held strictly under +1% at the 59th of 100 sorted per-pair changes,
// with no floor. room and jroom are also reported against the bytes they are expected to save.
// Exits 1 when any comparison is missing, has other than 100 pairs, a failed request or a value
// that is not a number: then there is no verdict.
const PAIRS = 100;
const EXPECT = { room: { bytes: 536, kernel: -509 }, jroom: { bytes: 408, kernel: -388 } };
const verdicts = [];
let judged = true;
const say = (s) => { verdicts.push(s); console.log(s); };
console.log("### verdicts (results/margin.md)");
const usable = (name) => {
  const r = runs[name];
  if (!r) return say(`${name}: not run or not summarized: NO VERDICT`), (judged = false), null;
  const values = [...Object.entries(r.ratio), ...Object.entries(r.diff)].filter(([m]) => !m.startsWith("L1"));
  const bad = values.filter(([, v]) => ![v.a, v.b, v.change, v.bound].every(Number.isFinite)).map(([m]) => m);
  if (r.pairs !== PAIRS || r.boundRank !== 59 || r.failures !== 0 || bad.length) {
    say(`${name}: ${r.pairs} pairs (bound rank ${r.boundRank}), ${r.failures} failed requests${bad.length ? ", not a number: " + bad.join(", ") : ""}; ${PAIRS} pairs, rank 59 and none failed are declared: NO VERDICT`);
    judged = false;
    return null;
  }
  return r;
};
const reported = (name) => {
  const r = usable(name);
  if (!r) return null;
  const tot = r.ratio["cycles user+kernel"], user = r.ratio["cycles user"], kern = r.ratio["cycles kernel"], ins = r.ratio["instructions user"];
  const dk = r.diff["cycles kernel (difference)"], res = r.diff["resident bytes"];
  const e = EXPECT[name];
  const ratio = dk.change / e.kernel;
  const pass = tot.bound < 0.01;
  say(`${name} (gated): user+kernel ${pct(tot.change)}, bound ${pct(tot.bound)} against strictly under +1%: ${pass ? "met" : "MISSED +1%"}; ${tot.bound < 0 ? "fewer cycles shown" : "fewer cycles not shown"}; user ${pct(user.change)} (bound ${pct(user.bound)}), kernel ${pct(kern.change)} (bound ${pct(kern.bound)}); instructions ${pct(ins.change)}`);
  say(`${name}: kernel cycles a request ${signed(dk.change)} (bound ${signed(dk.bound)}) against the expected ${e.kernel} (${e.bytes} bytes x 0.95): ${ratio.toFixed(2)} of it, ${ratio >= 0.5 && ratio <= 2 ? "consistent with the bytes (0.5 to 2)" : "not explained by the bytes alone (outside 0.5 to 2)"}; resident bytes a request ${signed(res.change)} (bound ${signed(res.bound)}) against the expected -${e.bytes}`);
  return { pass };
};
const held = (name) => {
  const r = usable(name);
  if (!r) return null;
  const tot = r.ratio["cycles user+kernel"], ins = r.ratio["instructions user"];
  const pass = tot.bound < 0.01;
  say(`${name} (gated): user+kernel ${pct(tot.change)}, bound ${pct(tot.bound)} against strictly under +1%: ${pass ? "met" : "MISSED +1%"} (user ${pct(r.ratio["cycles user"].change)}, kernel ${pct(r.ratio["cycles kernel"].change)}; instructions ${pct(ins.change)}, bound ${pct(ins.bound)})`);
  return { pass };
};
const room = reported("room");
const hit = held("hit");
const plain = held("plain");
const jroom = reported("jroom");
if (!judged) say("DECISION: none: a comparison could not be judged (above)");
else if (room.pass && jroom.pass && hit.pass && plain.pass) say("DECISION: no regression shown on any of the four workloads (every bound strictly under +1%); room's and jroom's savings are reported above");
else say("DECISION: a gated workload missed +1%: the change is not shown free of a regression by this run");
console.log("JSON " + JSON.stringify({ runs, verdicts, judged }));
if (!judged) process.exitCode = 1;
