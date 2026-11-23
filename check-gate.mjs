// Checks gate.mjs on made-up turns (no host needed): a complete pass whose bound is under +1% is
// usable and met, one over is usable and not met, and each way a pass can be incomplete, fail a
// request, multiplex a counter (or report any running share but exactly 100%) or disagree with its raw log makes it unusable, so the gate is not
// met. Usage: node check-gate.mjs (exits 1 on a failure). pack.ps1 runs it.
import { validate, expectedTurns, PLAN, fullShare } from "./gate.mjs";

// One turn's raw text and CSV row. cost: user+kernel cycles a request.
function turn(kind, pair, version, cost, opts = {}) {
  const req = opts.requests ?? 200000;
  const share = opts.share ?? "100.00";
  const perf = kind === "cycles"
    ? [[Math.round((cost * req) / 2), "cycles:u"], [Math.round((cost * req) / 2), "cycles:k"], [30000 * req, "instructions:u"]]
    : [[Math.round(cost * req), "L1-icache-load-misses"], [30000 * req, "instructions:u"]];
  const raw = ["## pair " + pair + " " + version, "# started on Sun Nov 22 22:23:42 2026", ""];
  for (const [v, e] of perf) raw.push(v + ",," + e + ",2998791288," + share + ",,");
  raw.push("Running 3s test @ http://127.0.0.1:18081/page", "RESULT " + req + " " + (opts.errors ?? "0 0 0 0 0"));
  return { raw: raw.join("\n"), row: [pair, version, req, ...perf.map(([v]) => v)].join(",") };
}
function files(kind, workload, f = {}) {
  const plan = PLAN[kind];
  const raw = [], rows = [];
  for (const [p, v] of expectedTurns(plan)) {
    const n = p.startsWith("w") ? 0 : Number(p);
    // Head 1% cheaper, spread so the bound sits under the median change plus a little.
    const base = 50000, head = base * (1 + (f.shift ?? -0.01) + ((n % 7) - 3) * 0.001);
    const t = turn(kind, p, v, v === "base" ? base : head, (f.turn ?? (() => ({})))(p, v));
    raw.push(t.raw);
    if (!p.startsWith("w")) rows.push(t.row);
  }
  const starts = 1 + plan.warmup + plan.pairs;
  const refused = workload.startsWith("refused");
  const startsText = ["base", "head"].map((v) => workload + " " + v + ": " + starts + " of " + starts + " starts: WARM x: /page: content-encoding zstd, age _, 1819 bytes" + (refused ? "; FENCE ok in " + starts : "")).join("\n") + "\n";
  const out = {
    csv: "pair,version,requests," + plan.columns.join(",") + "\n" + rows.join("\n") + "\n",
    raw: raw.join("\n") + "\n",
    starts: startsText,
    warm: "check-warm: " + workload + ": same:zstd: base zstd age 0 1819 bytes; head zstd age 0 1819 bytes\n",
    verdict: "checked 2 requests: same\n",
  };
  (f.edit ?? (() => {}))(out);
  return out;
}
let failed = 0;
function expect(name, kind, workload, f, usable, met, pattern) {
  const out = validate(files(kind, workload, f), workload, kind);
  const why = out.problems.join("; ");
  const ok = out.usable === usable && (kind !== "cycles" || out.met === met) && (!pattern || pattern.test(why));
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + name + ": usable " + out.usable + (kind === "cycles" ? ", met " + out.met : "") + (why ? " (" + why.slice(0, 150) + ")" : out["cycles user+kernel"] ? ", bound " + (100 * out["cycles user+kernel"].bound).toFixed(2) + "%" : ""));
}
const dropLine = (key, re) => (o) => { o[key] = o[key].split("\n").filter((l) => !re.test(l)).join("\n"); };
const rewrite = (key, from, to) => (o) => { if (!o[key].includes(from)) throw new Error("no " + from); o[key] = o[key].replace(from, to); };
expect("complete, bound under +1%", "cycles", "browser", {}, true, true);
expect("complete refused, fenced", "cycles", "refused", {}, true, true);
expect("complete, bound over +1%", "cycles", "gzip", { shift: 0.012 }, true, false);
expect("complete diagnostic pass", "icache", "json-browser-icache", {}, true, null);
expect("99 pairs: pair 100 missing in raw and csv", "cycles", "browser", { edit: (o) => { o.raw = o.raw.split("## pair 100 ")[0]; o.csv = o.csv.split("\n").filter((l) => !l.startsWith("100,")).join("\n"); } }, false, false, /turns, not the declared/);
expect("a csv row missing", "cycles", "browser", { edit: dropLine("csv", /^37,head,/) }, false, false, /no row for pair 37 head/);
expect("a duplicate csv row", "cycles", "browser", { edit: (o) => { o.csv += o.csv.split("\n")[5] + "\n"; } }, false, false, /two rows/);
expect("an undeclared pair", "cycles", "browser", { edit: (o) => { o.csv += "101,base,1,1,1,1\n"; } }, false, false, /undeclared pair/);
expect("a csv value not its turn's", "cycles", "browser", { edit: (o) => { const L = o.csv.split("\n"); const f = L[10].split(","); f[3] = String(Number(f[3]) - 1000000); L[10] = f.join(","); o.csv = L.join("\n"); } }, false, false, /not its turn's raw values/);
expect("a counter at 99.5%", "cycles", "browser", { turn: (p, v) => (p === "42" && v === "head" ? { share: "99.50" } : {}) }, false, false, /"99.50"% of the turn/);
expect("a multiplexed counter in the warm-up", "cycles", "browser", { turn: (p, v) => (p === "w1" && v === "base" ? { share: "50.00" } : {}) }, false, false, /w1 base/);
expect("a counter not counted", "cycles", "browser", { edit: (o) => { const i = o.raw.indexOf("## pair 3 base"); const j = o.raw.indexOf(",,cycles:k,", i); const s = o.raw.lastIndexOf("\n", j) + 1; o.raw = o.raw.slice(0, s) + "<not counted>" + o.raw.slice(j); } }, false, false, /cycles:k <not counted> is not a whole number/);
expect("a counter reported twice", "cycles", "browser", { edit: rewrite("raw", "2998791288,100.00,,\n", "2998791288,100.00,,\n1,,cycles:k,2998791288,100.00,,\n") }, false, false, /reported 2 times/);
expect("a timeout", "cycles", "browser", { turn: (p, v) => (p === "7" && v === "base" ? { errors: "0 0 0 0 3" } : {}) }, false, false, /failed requests/);
expect("a non-2xx answer", "cycles", "browser", { turn: (p, v) => (p === "8" && v === "head" ? { errors: "0 0 0 5 0" } : {}) }, false, false, /failed requests/);
expect("no RESULT line", "cycles", "browser", { edit: (o) => { const i = o.raw.indexOf("## pair 9 base"); const j = o.raw.indexOf("RESULT", i); o.raw = o.raw.slice(0, j) + "XRESULT" + o.raw.slice(j + 6); } }, false, false, /0 RESULT lines/);
expect("the order not turned", "cycles", "browser", { edit: (o) => { o.raw = o.raw.replace("## pair 2 head", "## pair 2 tmp").replace("## pair 2 base", "## pair 2 head").replace("## pair 2 tmp", "## pair 2 base"); } }, false, false, /first difference at turn 5/);
expect("no warm-up pair", "cycles", "browser", { edit: (o) => { o.raw = o.raw.slice(o.raw.indexOf("## pair 1 base")); } }, false, false, /not the declared/);
expect("a start not warmed", "cycles", "browser", { edit: rewrite("starts", "head: 102 of 102", "head: 101 of 102") }, false, false, /starts of head/);
expect("refused: a fence short", "cycles", "refused", { edit: rewrite("starts", "FENCE ok in 102\n", "FENCE ok in 101\n") }, false, false, /fenced/);
expect("the starts file missing", "cycles", "browser", { edit: (o) => { delete o.starts; } }, false, false, /starts is missing/);
expect("the answers not checked", "cycles", "browser", { edit: (o) => { delete o.verdict; } }, false, false, /verdict is missing/);
expect("a wrong csv header", "cycles", "browser", { edit: rewrite("csv", "pair,version,requests,", "pair,version,reqs,") }, false, false, /header/);
expect("a diagnostic pair missing", "icache", "gzip-icache", { edit: dropLine("csv", /^30,base,/) }, false, null, /no row for pair 30 base/);
// The running share must be exactly 100: each of these, on the warm-up base's first cycles:u only
// (the first perf line of the raw log), makes the pass unusable.
const firstShare = (to) => rewrite("raw", ",,cycles:u,2998791288,100.00,,", ",,cycles:u,2998791288," + to + ",,");
for (const bad of ["101.00", "Infinity", "-Infinity", "NaN", "", "1e2", "100.01", "99.99"]) {
  expect("the warm-up's first cycles:u counted " + JSON.stringify(bad) + "%", "cycles", "browser", { edit: firstShare(bad) }, false, false, new RegExp("raw w1 base: cycles:u counted " + JSON.stringify(bad).replace(/[.+]/g, "\\$&") + "% of the turn, not exactly 100%"));
}
expect("a recorded turn's counter at 101.00%", "cycles", "browser", { turn: (p, v) => (p === "64" && v === "base" ? { share: "101.00" } : {}) }, false, false, /raw 64 base: cycles:u counted "101.00"%/);
expect("a diagnostic counter at Infinity%", "icache", "refused-icache", { turn: (p, v) => (p === "12" && v === "head" ? { share: "Infinity" } : {}) }, false, null, /raw 12 head: L1-icache-load-misses:u counted "Infinity"%/);
for (const [s, want] of [["100.00", true], ["100", true], ["100.0", true], ["101.00", false], ["Infinity", false], ["NaN", false], ["", false], [undefined, false], [" 100.00", false], ["100.00\n", false]]) {
  const ok = fullShare(s) === want;
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + "fullShare(" + JSON.stringify(s) + ") is " + want);
}console.log(failed ? failed + " FAILED" : "all ok");
process.exit(failed ? 1 : 0);
