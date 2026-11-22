// summary.mjs: corten-run/corten#1824's kit (1824b). Reads every results/pairs-<name>.csv that
// run-pair.sh wrote and results/faultcost.txt, prints a table a comparison and the verdicts
// results/margin.md declares, and ends with a JSON line of everything.
// Usage: node summary.mjs <results dir> [seconds per turn, default 3]
//
// In each comparison A is the CSV's base rows and B its head rows. Per request: cycles (user +
// kernel, user, kernel) and user instructions as the median per-pair change B / A - 1, with the
// one-sided 95% upper bound on that median (an order statistic, distribution-free: the j-th
// smallest change with j the least rank whose binomial tail is at most 5%: the 20th of 30, the
// 26th of 40, the 15th of 20) and the range; page faults, minor faults (perf), minflt (/proc),
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
  }
  const pairs = [...new Set(data.map((r) => r.pair))];
  const row = (pair, version) => {
    const r = data.filter((x) => x.pair === pair && x.version === version);
    if (r.length !== 1) throw new Error(file + ": pair " + pair + " " + version + ": " + r.length + " rows");
    return r[0];
  };
  const n = pairs.length;
  const k = upperRank(n);
  const out = { file, pairs: n, boundRank: k, ratio: {}, diff: {}, failures: data.reduce((s, r) => s + (r.errors ?? 0), 0) };
  for (const [name, f] of Object.entries(RATIO)) {
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
    const d = m.startsWith("cycles") ? 0 : 1;
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

// faultcost.txt: FAULTCOST lines, the first (cold) one apart.
const fc = { first: null, warm: {} };
const fcFile = join(dir, "faultcost.txt");
if (existsSync(fcFile)) {
  for (const line of readFileSync(fcFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^(first|warmed|round \d+) FAULTCOST (.*)$/);
    if (!m) continue;
    const kv = Object.fromEntries(m[2].split(" ").map((x) => x.split("=")));
    if (m[1] === "first") fc.first = kv;
    else if (m[1].startsWith("round")) (fc.warm[kv.mode] ??= []).push(kv);
  }
  console.log("### faultcost: per 4 KiB page, median of the rounds after memory was warmed (range)");
  console.log("| mode | kernel cycles | user cycles | ns | minflt | AnonHugePages KiB |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [mode, rows] of Object.entries(fc.warm)) {
    const col = (c) => rows.map((r) => Number(r[c])).filter(Number.isFinite);
    const show = (c) => { const v = col(c); return v.length ? `${median(v).toFixed(0)} (${Math.min(...v).toFixed(0)}-${Math.max(...v).toFixed(0)})` : "-"; };
    fc.warm[mode].median = { k: median(col("kcycles_per_page")), u: median(col("ucycles_per_page")), ns: median(col("ns_per_page")) };
    console.log(`| ${mode} | ${show("kcycles_per_page")} | ${show("ucycles_per_page")} | ${show("ns_per_page")} | ${median(col("minflt_per_page")).toFixed(4)} | ${median(col("anon_huge_kb")).toFixed(0)} |`);
  }
  if (fc.first) console.log(`first demand run (${fc.first.mib} MiB, before memory was warmed): ${fc.first.kcycles_per_page} kernel cycles, ${fc.first.ns_per_page} ns a page`);
  const d = fc.warm.demand?.median?.k, p = fc.warm.populate?.median?.k, t = fc.warm.thp?.median?.k;
  if (d) {
    if (p) console.log(`populate / demand, kernel cycles a page: ${(p / d).toFixed(2)} (half or less: ${p <= d / 2 ? "yes" : "no"})`);
    if (t) console.log(`thp / demand, kernel cycles a page: ${(t / d).toFixed(2)} (half or less: ${t <= d / 2 ? "yes" : "no"})`);
  }
  console.log("");
}

// The verdicts margin.md declares.
const verdicts = [];
const say = (s) => { verdicts.push(s); console.log(s); };
console.log("### verdicts (results/margin.md)");
const share = (attr) => {
  const r = runs[attr];
  if (!r) return null;
  const k = r.diff["cycles kernel (difference)"];
  return { k: k.a - k.b, u: r.ratio["cycles user"].a - r.ratio["cycles user"].b, faults: r.diff["minflt (/proc)"].a, resident: r.diff["resident bytes"].a };
};
for (const [attr, label] of [["je-room-off", "jemalloc (the image)"], ["gl-room-off", "glibc"]]) {
  const s = share(attr);
  if (!s) { say(`${attr}: not run or not summarized`); continue; }
  const touch = (s.faults * 4096) / s.resident;
  say(`${attr} (${label}): the store's share a kept-with-room request: kernel ${s.k.toFixed(0)} cycles, user ${s.u.toFixed(0)}; ${s.faults.toFixed(3)} minflt and ${s.resident.toFixed(0)} resident bytes a request; faults x 4 KiB / resident = ${touch.toFixed(2)} (${touch > 0.8 && touch < 1.25 ? "first touch: within 0.8 to 1.25" : "NOT first touch alone: outside 0.8 to 1.25"})`);
}
const room = (name, attr) => {
  const r = runs[name], s = share(attr);
  if (!r || !s) return say(`${name}: not run, not summarized, or no ${attr} to judge it by`);
  const dk = r.diff["cycles kernel (difference)"];
  const tot = r.ratio["cycles user+kernel"];
  const res = r.diff["resident bytes"];
  const idle = r.diff["resident KiB before load (per process)"];
  const halves = dk.change <= -s.k / 2 && dk.bound < 0;
  const fewer = tot.bound < 0;
  const resChange = res.change / res.a;
  const memory = resChange <= 0.05 && idle.change <= 2048;
  say(`${name}: kernel cycles a request ${signed(dk.change)} (bound ${signed(dk.bound)}) against half the share ${(-s.k / 2).toFixed(0)}: ${halves ? "met" : "NOT met"}; user+kernel ${pct(tot.change)} (bound ${pct(tot.bound)}): ${fewer ? "fewer" : "fewer NOT shown"}; resident bytes a request ${pct(resChange)}, resident before load ${signed(idle.change)} KiB: ${memory ? "within the memory limits" : "OVER a memory limit"}`);
  return { halves, fewer, memory };
};
const control = (name) => {
  const r = runs[name];
  if (!r) return say(`${name}: not run or not summarized`), null;
  const tot = r.ratio["cycles user+kernel"], ins = r.ratio["instructions user"];
  const pass = tot.bound < 0.01;
  const flat = Math.abs(ins.change) < 0.001;
  const v = pass ? "met" : flat ? "NOT resolved (instructions flat: layout or noise, #1923)" : "NOT met";
  say(`${name}: user+kernel ${pct(tot.change)}, bound ${pct(tot.bound)} against +1%: ${v}; instructions ${pct(ins.change)}`);
  return { pass, flat };
};
const thp = [room("je-room-thp", "je-room-off"), control("je-hit-thp"), control("je-plain-thp")];
const pop = [room("je-room-populate", "je-room-off"), control("je-hit-populate"), control("je-plain-populate")];
room("gl-room-thp", "gl-room-off");
room("gl-room-pad", "gl-room-off");
const ok = ([r, h, p]) => r && h && p && r.halves && r.fewer && r.memory;
if (ok(pop) && pop[1].pass && pop[2].pass) say("DECISION: build option 1 (a store that keeps new answers in memory made resident ahead): justified");
else if (ok(pop) && (pop[1].pass || pop[1].flat) && (pop[2].pass || pop[2].flat)) say("DECISION: option 1 justified for a candidate run (hit or plain not resolved, instructions flat)");
else say("DECISION: option 1 (store code) not justified by this run");
if (ok(thp) && thp[1].pass && thp[2].pass) say("DECISION: huge pages for the image's allocator (MALLOC_CONF thp:always): worth a candidate change to Choice 23");
else say("DECISION: huge pages for the image's allocator: not shown worth it by this run");
console.log("JSON " + JSON.stringify({ runs, faultcost: fc, verdicts }));