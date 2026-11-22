// summary.mjs: corten-run/corten#1824's kit (1824c). Reads results/pairs-b-*.csv (Pass B, perf
// stat of the server), results/vmstat-*.csv, results/faultcost.txt and results/profile.json (Pass
// A, written by profile.mjs), prints a table a comparison and the readings results/margin.md
// declares, and ends with a JSON line of everything.
// Usage: node summary.mjs <results dir> [seconds per turn, default 3]
//
// A is the store with room, B the store off (the same binary and allocator). For every column a
// request (an event, minflt, resident bytes, a /proc/vmstat delta): the medians of A and B, the
// median per-pair difference A - B and its distribution-free 90% interval (the k-th smallest and
// k-th largest of the n differences, k the largest rank whose binomial tail is at most 5%: the
// 11th and 20th of 30, the 6th and 15th of 20), and the median per-pair ratio A / B - 1.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const [, , dir, turnArg] = process.argv;
if (!dir) throw new Error("usage: node summary.mjs <results dir> [seconds per turn]");
const turn = Number(turnArg ?? 3);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// The least k (1-based) with P(Binomial(n, 1/2) <= k - 1) > 5%: the k-th smallest of n is a one-sided
// 95% lower bound on the median, the k-th largest an upper one.
const rank = (n) => {
  let cum = 0, logc = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logc += Math.log(n - i + 1) - Math.log(i);
    cum += Math.exp(logc - n * Math.LN2);
    if (cum > 0.05) return i;
  }
  return 0;
};
const pct = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(1) + "%" : "n/a");
const sg = (x, d = 0) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const fx = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const digits = (v) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 2 : 4);

function rows(file) {
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const names = header.split(",");
  const data = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [names[i], i < 2 ? v : v === "" ? null : Number(v)])));
  return { names, data };
}
function paired(data, file) {
  const pairs = [...new Set(data.map((r) => r.pair))];
  const row = (pair, version) => {
    const r = data.filter((x) => x.pair === pair && x.version === version);
    if (r.length !== 1) throw new Error(`${file}: pair ${pair} ${version}: ${r.length} rows`);
    return r[0];
  };
  return pairs.map((p) => [row(p, "base"), row(p, "head")]);
}
function stat(pp, f) {
  const a = pp.map(([x]) => f(x)), b = pp.map(([, y]) => f(y));
  const d = pp.map((_, i) => a[i] - b[i]).sort((x, y) => x - y);
  const r = pp.map((_, i) => a[i] / b[i] - 1).filter(Number.isFinite).sort((x, y) => x - y);
  const n = d.length, k = rank(n);
  return { a: median(a), b: median(b), diff: median(d), lo: k > 0 ? d[k - 1] : NaN, hi: k > 0 ? d[n - k] : NaN, ratio: median(r), n };
}

const runs = {};
const vm = {};
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^pairs-b-.*\.csv$/.test(f)).sort() : [];
for (const f of files) {
  const name = f.replace(/^pairs-|\.csv$/g, "");
  try {
    const { names, data } = rows(join(dir, f));
    if (data.length === 0) { console.log(`### ${name}: no recorded pairs\n`); continue; }
    const pp = paired(data, f);
    const skip = new Set(["pair", "version", "requests", "errors", "rss_idle_kb", "rss_end_kb", "hwm_kb", "anon_kb", "anon_huge_kb"]);
    const m = {};
    for (const c of names.filter((c) => !skip.has(c))) {
      if (!data.every((r) => Number.isFinite(r[c]))) throw new Error(`${f}: column ${c} is not a number in every row (a run without perf is not a measurement)`);
      m[c] = stat(pp, (r) => r[c] / r.requests);
    }
    if (names.includes("cycles_k") && names.includes("instructions_k")) m["kernel instructions a cycle"] = stat(pp, (r) => r.instructions_k / r.cycles_k);
    if (names.includes("cycles_u") && names.includes("instructions_u")) m["user instructions a cycle"] = stat(pp, (r) => r.instructions_u / r.cycles_u);
    if (names.includes("cycles_u")) m["cycles user+kernel"] = stat(pp, (r) => (r.cycles_u + r.cycles_k) / r.requests);
    m["resident bytes"] = stat(pp, (r) => ((r.rss_end_kb - r.rss_idle_kb) * 1024) / r.requests);
    m["resident KiB before load (per process)"] = stat(pp, (r) => r.rss_idle_kb);
    m["Anonymous KiB at the end (per process)"] = stat(pp, (r) => r.anon_kb);
    m["AnonHugePages KiB at the end (per process)"] = stat(pp, (r) => r.anon_huge_kb);
    const rps = (v) => median(pp.map((p) => p[v === "a" ? 0 : 1].requests / turn));
    runs[name] = { pairs: pp.length, failures: data.reduce((s, r) => s + (r.errors ?? 0), 0), metrics: m, rps: { a: rps("a"), b: rps("b") } };
    const k = rank(pp.length);
    console.log(`### ${name}: ${pp.length} pairs, 90% interval = differences of rank ${k} and ${pp.length + 1 - k}, failed requests ${runs[name].failures}`);
    console.log("| a request (unless said) | A (room) median | B (off) median | A - B, median per pair | 90% interval | A / B - 1 |");
    console.log("| --- | ---: | ---: | ---: | --- | ---: |");
    for (const [c, v] of Object.entries(m)) {
      const d = digits(Math.max(Math.abs(v.a), Math.abs(v.b)));
      console.log(`| ${c} | ${fx(v.a, d)} | ${fx(v.b, d)} | ${sg(v.diff, d)} | ${sg(v.lo, d)} to ${sg(v.hi, d)} | ${pct(v.ratio)} |`);
    }
    console.log(`median requests/s: A ${fx(runs[name].rps.a)}, B ${fx(runs[name].rps.b)}`);
    console.log("");
  } catch (e) {
    console.log(`### ${name}: not summarized: ${e.message}\n`);
  }
}

// /proc/vmstat deltas a request (the host's counters over each turn), every comparison.
const vfiles = existsSync(dir) ? readdirSync(dir).filter((f) => /^vmstat-.*\.csv$/.test(f)).sort() : [];
for (const f of vfiles) {
  const name = f.replace(/^vmstat-|\.csv$/g, "");
  try {
    const { names, data } = rows(join(dir, f));
    if (data.length === 0) continue;
    const pp = paired(data, f);
    const m = {};
    for (const c of names.slice(3)) {
      const s = stat(pp, (r) => r[c] / r.requests);
      if (s.a === 0 && s.b === 0 && s.lo === 0 && s.hi === 0) continue;
      m[c] = s;
    }
    vm[name] = m;
    console.log(`### vmstat ${name}: ${pp.length} pairs, the host's /proc/vmstat delta over a turn, a request (fields zero throughout left out)`);
    console.log("| field | A (room) | B (off) | A - B, median per pair | 90% interval |");
    console.log("| --- | ---: | ---: | ---: | --- |");
    for (const [c, v] of Object.entries(m)) {
      const d = Math.max(4, digits(Math.max(Math.abs(v.a), Math.abs(v.b))));
      console.log(`| ${c} | ${fx(v.a, d)} | ${fx(v.b, d)} | ${sg(v.diff, d)} | ${sg(v.lo, d)} to ${sg(v.hi, d)} |`);
    }
    console.log("");
  } catch (e) {
    console.log(`### vmstat ${name}: not summarized: ${e.message}\n`);
  }
}

// faultcost.txt, as 1824b's summary read it.
const fc = {};
const fcFile = join(dir, "faultcost.txt");
if (existsSync(fcFile)) {
  for (const line of readFileSync(fcFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^round \d+ FAULTCOST (.*)$/);
    if (!m) continue;
    const kv = Object.fromEntries(m[1].split(" ").map((x) => x.split("=")));
    (fc[kv.mode] ??= []).push(Number(kv.kcycles_per_page));
  }
  console.log("### faultcost: kernel cycles a 4 KiB page, median of the rounds after memory was warmed");
  console.log(Object.entries(fc).map(([mode, v]) => `${mode} ${fx(median(v.filter(Number.isFinite)))}`).join(", "));
  console.log("");
}

// The readings results/margin.md declares.
const profile = existsSync(join(dir, "profile.json")) ? JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) : { comparisons: {} };
const verdicts = [];
const say = (s) => { verdicts.push(s); console.log(s); };
console.log("### readings (results/margin.md)");
const P = profile.comparisons;
const share = (c, names) => names.reduce((s, n) => s + (c?.categories?.[n]?.diff ?? 0), 0) / (c?.kernelDiff ?? NaN);
const NEW = ["zeroing", "page allocator", "memcg", "fault handling"];
const INDIRECT = ["network", "copies to and from user", "epoll and syscall entry", "slab", "interrupts, timers and RCU", "locks"];
const above0 = (v) => v && v.lo > 0;
const readings = {};
for (const al of ["je", "gl"]) {
  const core = runs[`b-${al}-core`]?.metrics;
  const flat = P[`a-${al}-flat`], graph = P[`a-${al}-graph`];
  const dk = core?.cycles_k;
  const label = al === "je" ? "jemalloc (the image)" : "glibc";
  if (!flat) { say(`${al}: no flat profile (a-${al}-flat not run or not summarized)`); continue; }
  const r = {
    dk: dk?.diff, flatKernelDiff: flat.kernelDiff,
    agree: dk ? flat.kernelDiff / dk.diff : NaN,
    newMemory: share(flat, NEW), zeroing: share(flat, ["zeroing"]), compaction: share(flat, ["compaction and khugepaged"]),
    unmapping: share(flat, ["unmapping and TLB"]), scheduler: share(flat, ["scheduler and wakeups"]), indirect: share(flat, INDIRECT),
    faultMarker: graph?.markers?.["page fault (any)"]?.share, zeroingAtFault: graph?.markerWhere?.["zeroing (clear_page)"]?.["page fault"],
    hugeFault: graph?.markers?.["huge page fault"]?.share,
  };
  const v = vm[`b-${al}-core`] ?? {};
  r.compactStall = (v.compact_stall?.diff ?? 0) + (v.thp_collapse_alloc?.diff ?? 0);
  r.thpFaultAlloc = v.thp_fault_alloc;
  r.cs = core?.context_switches?.diff;
  r.llc = runs[`b-${al}-cache`]?.metrics?.cache_misses_k;
  r.dtlb = runs[`b-${al}-tlb`]?.metrics?.dTLB_load_misses_k;
  r.resident = core?.["resident bytes"]?.diff;
  r.minflt = core?.minflt?.diff;
  r.faultCycles = graph?.markers?.["page fault (any)"]?.diff;
  // What faultcost says first touch should cost: glibc a demand fault a fault, jemalloc's resident
  // bytes at thp's cycles a 4 KiB page.
  const fcm = (m) => (fc[m] ? median(fc[m].filter(Number.isFinite)) : NaN);
  r.faultEstimate = al === "gl" ? r.minflt * fcm("demand") : (r.resident / 4096) * fcm("thp");
  readings[al] = r;
  say(`${al} (${label}): kernel A - B ${sg(r.dk)} cycles a request by perf stat (Pass B core; 90% ${sg(dk?.lo)} to ${sg(dk?.hi)}), ${sg(r.flatKernelDiff)} ${profile.unit} by the flat profile (ratio ${fx(r.agree, 2)}: ${r.agree >= 0.75 && r.agree <= 1.33 ? "agree" : "DISAGREE, outside 0.75 to 1.33"})`);
  say(`${al}: shares of the flat profile's kernel A - B: new memory (zeroing, page allocator, memcg, fault handling) ${pct(r.newMemory)}, of it zeroing ${pct(r.zeroing)}; compaction and khugepaged ${pct(r.compaction)}; unmapping and TLB ${pct(r.unmapping)}; scheduler ${pct(r.scheduler)}; network, copies, syscall entry, slab, interrupts, locks ${pct(r.indirect)}`);
  if (graph) say(`${al}: call graphs: page-fault paths ${pct(r.faultMarker)} of the kernel A - B (huge page fault ${pct(r.hugeFault)}); of A's zeroing, ${pct(r.zeroingAtFault)} under a page fault; page-fault paths ${sg(r.faultCycles)} ${profile.unit} a request against faultcost's first-touch estimate ${sg(r.faultEstimate)} (${al === "gl" ? "minflt x demand" : "resident bytes / 4 KiB x thp"}): ratio ${fx(r.faultCycles / r.faultEstimate, 2)}`);
  else say(`${al}: no call-graph profile`);
  say(`${al}: vmstat a request A - B: thp_fault_alloc ${sg(r.thpFaultAlloc?.diff, 5)}, compact_stall + thp_collapse_alloc ${sg(r.compactStall, 5)}; context switches ${sg(r.cs, 4)}; LLC misses:k ${r.llc ? `${sg(r.llc.diff, 1)} (90% ${sg(r.llc.lo, 1)} to ${sg(r.llc.hi, 1)})` : "not counted"}; dTLB load misses:k ${r.dtlb ? `${sg(r.dtlb.diff, 1)} (90% ${sg(r.dtlb.lo, 1)} to ${sg(r.dtlb.hi, 1)})` : "not counted"}; resident bytes ${sg(r.resident)}`);
}
const gl = readings.gl, je = readings.je;
const validated = gl && gl.faultMarker >= 0.5;
say(`R0 (method: glibc's page-fault paths, inclusive in the call graphs, at least 50% of its kernel A - B there): ${!gl || !Number.isFinite(gl.faultMarker) ? "NOT available (no glibc call graphs)" : validated ? `validated, ${pct(gl.faultMarker)}` : `NOT validated, ${pct(gl.faultMarker)}: the jemalloc readings below are unconfirmed`}`);
const next = [];
if (je) {
  // New memory: the page-fault paths, inclusive, where there are call graphs; else the flat categories.
  const R1 = Number.isFinite(je.faultMarker) ? je.faultMarker >= 0.5 : je.newMemory >= 0.5;
  const R1z = R1 && je.zeroingAtFault !== undefined ? je.zeroingAtFault >= 0.5 : null;
  const R2 = je.compaction >= 0.25 || je.compactStall > 0.001;
  const R3 = je.unmapping >= 0.25;
  const R4 = je.scheduler >= 0.25 || je.cs >= 0.05;
  const R5 = je.indirect >= 0.25 && (above0(je.llc) || above0(je.dtlb));
  say(`R1 (new memory at least 50%: page-fault paths ${pct(je.faultMarker)} in the call graphs, flat categories ${pct(je.newMemory)}): ${R1 ? "holds" : "does not hold"}${R1z === null ? "" : R1z ? "; zeroing mostly at a page fault" : "; zeroing mostly NOT at a page fault (khugepaged or a syscall: see profile.md)"}`);
  say(`R2 (compaction or khugepaged at least 25%, or compaction/collapse events): ${R2 ? "holds" : "does not hold"}`);
  say(`R3 (unmapping and TLB at least 25%): ${R3 ? "holds" : "does not hold"}`);
  say(`R4 (scheduler at least 25%, or 0.05 more context switches a request): ${R4 ? "holds" : "does not hold"}`);
  say(`R5 (network, copies, syscall entry, slab, interrupts and locks at least 25%, with more LLC or dTLB misses in the kernel): ${R5 ? "holds" : "does not hold"}`);
  if (Number.isFinite(je.resident) && je.resident > 0 && Number.isFinite(je.newMemory)) {
    const perByte = (x) => (Number.isFinite(x.faultCycles) ? x.faultCycles : x.newMemory * x.flatKernelDiff) / x.resident;
    say(`new memory (page-fault paths where there are call graphs, else the flat categories): ${fx(perByte(je), 2)} kernel ${profile.unit} a resident byte with jemalloc${gl && gl.resident > 0 ? `, ${fx(perByte(gl), 2)} with glibc` : ""}; faultcost: thp ${fc.thp ? fx(median(fc.thp) / 4096, 2) : "n/a"}, demand ${fc.demand ? fx(median(fc.demand) / 4096, 2) : "n/a"} kernel cycles a byte`);
  }
  if (R1 && !R2 && !R3 && !R4) next.push("store-side allocation sizing: the kernel's share is the price of new memory and follows the bytes a kept answer makes resident; no jemalloc setting is indicated");
  if (R2) next.push("a jemalloc setting candidate that avoids huge-page compaction or collapse (for example thp:never), judged against the 4 KiB faults it brings back");
  if (R3 || R4) next.push("a jemalloc purge or background-thread setting candidate (dirty_decay_ms, muzzy_decay_ms, background_thread), measured on room, hit and plain");
  if (R5 && !R1) next.push("store-side allocation sizing, for the cache and TLB pressure of the memory a kept answer touches");
  if (next.length === 0) next.push("option 2 (profile the ask in a full store); the share with room stays unexplained by this run");
  if (!validated) next.push("(the method was not validated on glibc: treat the above as unconfirmed)");
  if (je.agree < 0.75 || je.agree > 1.33) next.push("(the profile and the counters disagree on the size of the share: treat the shares as approximate)");
  for (const n of next) say(`NEXT: ${n}`);
}
console.log("JSON " + JSON.stringify({ runs, vmstat: vm, faultcost: fc, readings, verdicts }));