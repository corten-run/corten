// The plan file, the mask and the report, on results made here as run.sh leaves them: the words
// a workload is reported in (CONTRIBUTING.md, Pull requests, item 2) and what is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readMap, record } from "./map.mjs";
import { problems as maskProblems, sed, starts, stated, values } from "./mask.mjs";
import { rng } from "./model.mjs";
import { declaration, problems, resolve } from "./plan.mjs";
import { report, sizing } from "./report.mjs";
import { shuffled, sides } from "./schedule.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = JSON.parse(readFileSync(join(here, "example", "plan.json"), "utf8"));
const plan = (change = () => {}) => { const p = structuredClone(EXAMPLE); change(p); return p; };
const tmp = mkdtempSync(join(tmpdir(), "placement-report-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const has = (why, word) => assert.ok(why.some((w) => w.includes(word)), `no "${word}" in: ${why.join(" | ") || "nothing"}`);

test("the example plan is usable, and each field that is not is named", () => {
  assert.deepEqual(problems(EXAMPLE), []);
  const bad = (change, word) => has(problems(plan(change)), word);
  assert.deepEqual(problems({}), ['"plan": 1 is missing: not a plan this kit reads']);
  bad((p) => { p.base = "29c349018"; }, "base: a full commit id");
  bad((p) => { p.probe.binary = "release/server"; }, "named probe");
  bad((p) => { p.probe.start = "$BIN 8080"; }, "probe.start");
  bad((p) => { p.probe.env.PATH = "/x"; }, "probe.env");
  bad((p) => { p.probe.dir = "../probe"; }, "probe.dir");
  bad((p) => { p.host.cpus.driver = 2; }, "CPUs of their own");
  bad((p) => { p.R = 0; }, "R: recorded pairs");
  bad((p) => { p.pilot.K = 60; }, "pilot.why: why a K other than 100 serves");
  bad((p) => { p.pilot.K = 20; }, "pilot.K: from 30 to 254");
  bad((p) => { delete p.pilot; }, 'K is "pilot" and the plan has no pilot');
  bad((p) => { p.workloads[0].K = 4; }, 'K, from 5 to 254 or "pilot"');
  bad((p) => { p.workloads[0].K = 255; }, 'K, from 5 to 254 or "pilot"');
  bad((p) => { p.workloads[0].name = "Plain"; }, "a name of lowercase letters");
  bad((p) => { p.workloads.push(p.workloads[0]); }, "used once");
  bad((p) => { p.workloads[0].declared = " "; }, "declared");
  bad((p) => { p.workloads[0].request.headers = ["Accept-Encoding"]; }, 'each "Name: value"');
  bad((p) => { p.workloads[0].mask = [{ header: "Date" }]; }, "Date is left out of every comparison");
  bad((p) => { p.workloads[0].reduction = 2; }, "reduction");
  bad((p) => { delete p.workloads[0].seed; }, "seed");
  bad((p) => { delete p.head; }, "head: a full commit id. A plan that does not name the commits it reads, the change's base and head, is not declared");
  bad((p) => { p.workloads[0].reads = []; }, "reads, the thresholds this run reads across placements");
  bad((p) => { p.workloads[0].reads = ["margin", "floor"]; }, "reads, the thresholds this run reads across placements");
  bad((p) => { p.workloads[0].reads = ["margin", "reduction"]; }, "reads the reduction and declares none");
  bad((p) => { delete p.workloads[0].recordsSpread; }, "recordsSpread");
  assert.deepEqual(problems(plan((p) => { p.pilot = { K: 60, why: "the setup's last pilot spread 0.6%" }; p.workloads[0].reduction = 0.02; })), []);
});

test("a part's numbers come from the plan: K, the rank, the pad lists, the order", () => {
  const pilot = resolve(EXAMPLE, "pilot", "plain");
  assert.deepEqual([pilot.K, pilot.R, pilot.seconds, pilot.rank, pilot.lowerRank, pilot.sides, pilot.comparisons], [100, 8, 3, 59, 42, ["base"], ["pilot-plain"]]);
  assert.equal(pilot.schedule.length, 100);
  // A workload sized from its pilot has no K until that pilot gives one.
  assert.throws(() => resolve(EXAMPLE, "gated", "plain"), /needs that pilot's results/);
  const gated = resolve(EXAMPLE, "gated", "plain", { K: 69 });
  assert.deepEqual([gated.K, gated.declaredK, gated.rank, gated.sides, gated.comparisons, gated.schedule.length], [69, "pilot", 42, ["base", "head"], ["aa-plain", "change-plain"], 138]);
  assert.equal(new Set([...gated.P, ...gated.Q]).size, 138);
  const lines = declaration(gated);
  assert.ok(lines[0].includes("K = 69 placements (from the pilot, by the sizing rule), R = 8 recorded pairs"));
  assert.ok(lines[3].startsWith("the bound is the 42nd smallest of the 69 placement medians, the lower bound the 28th"));
  // A dry run's numbers replace the plan's and are marked.
  const dry = resolve(EXAMPLE, "gated", "plain", { dry: { K: 6, R: 2, seconds: 1 } });
  assert.deepEqual([dry.K, dry.R, dry.seconds], [6, 2, 1]);
  assert.ok(declaration(dry)[0].includes("DRY RUN"));
  assert.throws(() => resolve(EXAMPLE, "gated", "other"));
  assert.throws(() => resolve(plan((p) => { delete p.pilot; p.workloads[0].K = 30; }), "pilot", "plain"), /no pilot/);
});

test("the mask: only named headers, each differing between two starts or held to its stated value", () => {
  const one = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nETag: W/\"abc\"\r\nage: 3\r\n\r\n", two = one.replace("abc", "def");
  assert.deepEqual(values(one, "etag"), ['W/"abc"']);
  assert.equal(sed([{ header: "ETag" }]), "s/^[Ee][Tt][Aa][Gg]:.*$/etag: <masked>/\n");
  assert.deepEqual(starts([{ header: "etag" }], one, two), []);
  has(starts([{ header: "etag" }], one, one), "only a value that differs between starts is masked");
  has(starts([{ header: "x-key" }], one, two), "sent it 0 and 0 times");
  // A value the cost depends on is checked against the plan's range or value, not accepted as any number.
  assert.deepEqual(starts([{ header: "age", range: [0, 3] }], one, one), []);
  assert.deepEqual(stated([{ header: "age", range: [0, 3] }], one), []);
  has(stated([{ header: "age", range: [0, 2] }], one), '"3", not a number from 0 to 2');
  has(stated([{ header: "age", value: "4" }], one), '"3", not "4"');
  has(stated([{ header: "age", range: [0, 3] }], "HTTP/1.1 200 OK\r\n\r\n"), "sent 0 times, not once");
  has(maskProblems([{ header: "age", range: [3, 0] }]), "range");
  has(maskProblems([{ header: "etag" }, { header: "ETag" }]), "named twice");
  assert.deepEqual(maskProblems([]), []);
});

// Results as run.sh leaves them, for a plan with K = 5 and R = 2 (the bound is the 5th of 5, the
// largest placement median, and the lower bound the smallest). change(c, i) is the change every
// pair of placement i of comparison c shows.
const row = (at, size, align, rest) => `${at.toString(16)} ${at.toString(16)} ${size.toString(16)} ${align} ${rest}`;
const MAP = (align, late = ".text.crc") => [row(0x1000, 0x400, 64, ".text"), row(0x1000, 0x40, 16, "        /usr/lib/Scrt1.o:(.text)"), row(0x1000, 0, 1, "                _start"),
  row(0x1040, 0x100, align, "        /t/out/libc.a(compress.o):(.text.fill)"), row(0x1040, 0, 1, "                fill"), row(0x1140, 0x20, 16, `        /t/out/libc.a(crc.o):(${late})`), row(0x1140, 0, 1, "                crc"),
  row(0x3000, 0x40, 8, ".data")].join("\n") + "\n";
let made = 0;
function results({ part = "gated", change = () => 0, edit = () => {}, align = 16, map = MAP(align), touch = () => {} } = {}) {
  const dir = join(tmp, `run-${++made}`), work = join(dir, "work"), res = join(work, "results");
  mkdirSync(join(dir, "probe"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan((p) => { p.R = 2; p.workloads[0].K = 5; p.pilot = { K: 30, why: "made up for a test" }; edit(p); }), null, 1));
  const env = { ...process.env };
  delete env.DRYRUN;
  const made_ = spawnSync(process.execPath, [join(here, "plan.mjs"), join(dir, "plan.json"), part, "plain", work], { encoding: "utf8", env });
  assert.equal(made_.status, 0, made_.stderr);
  const r = JSON.parse(readFileSync(join(work, "plan", "resolved.json"), "utf8")), second = align > 16;
  cpSync(join(work, "plan"), join(res, "plan"), { recursive: true });
  const put = (f, text) => { mkdirSync(dirname(join(res, f)), { recursive: true }); writeFileSync(join(res, f), text); };
  put("run-id", "0f8fad5b-d9cb-469f-a165-70867728950e\n");
  put("schedule.txt", readFileSync(join(work, "plan", "schedule.txt")));
  put("host-id.txt", "model Made-up CPU\nmicrocode 0x1\nkernel 6.12.0\nos Debian GNU/Linux 13 (trixie)\n");
  const sha = (name) => Buffer.from(name.padEnd(32, ".")).toString("hex"), used = new Set();
  for (const c of r.comparisons) for (let i = 1; i <= r.K; i++) for (const b of sides(c, i, r.P, r.Q)) used.add(b);
  put("sha256.txt", [...r.sides, ...used].map((b) => `${b} ${sha(b)} 1000 bytes\n`).join(""));
  put(join("verify", "verdicts.txt"), [...used].map((b) => `${b} as ${b.replace(/-p\d+$/, "")}: answers: same; body 6077 bytes as received\n`).join(""));
  for (const side of r.sides) { put(join("maps", `${side}.map.gz`), gzipSync(map)); put(`record-${side}.json`, JSON.stringify(record(readMap(map))) + "\n"); }
  for (const b of used) {
    const pad = Number(b.replace(/^.*-p/, ""));
    put(join("layout", `${b}.txt`), `functions in both: 2\nJSON ${JSON.stringify({ ok: true, pad, second })}\n`);
    if (second) put(join("layout", `${b}-map.txt`), `.text: 3 input sections\nJSON ${JSON.stringify({ ok: true, pad, second: 48 })}\n`);
  }
  if (second) put("second-pads.txt", [...used].map((b) => { const pad = Number(b.replace(/^.*-p/, "")); return `${b}: first pad ${pad} (mod 64: ${pad % 64}), second pad 48, .data at 0x3040; .data's offset in a 64-byte line with each size: 16:32 32:48 48:0 64:16\n`; }).join(""));
  const t = (n) => new Date(Date.UTC(2026, 10, 24, 12, 0, 0) + 1000 * n).toISOString().replace(/\.\d+Z$/, "Z");
  for (const s of r.schedule) {
    const [A, B] = sides(s.comparison, s.i, r.P, r.Q), p = join(s.comparison, `p${String(s.i).padStart(3, "0")}`), x = change(s.comparison, s.i);
    put(join(p, "placement.txt"), [`comparison ${s.comparison} placement ${s.i} workload plain`, `A ${A} ${sha(A)}`, `B ${B} ${sha(B)}`, "run 0f8fad5b-d9cb-469f-a165-70867728950e", `plan ${r.plan}`, `seq ${s.seq}`, `started ${t(100 * s.seq)}`, `ended ${t(100 * s.seq + 90)}`].join("\n") + "\n");
    put(join(p, "answers", "verdict.txt"), "answers: same\n");
    const line = (pair, version, f) => `${pair},${version},100000,${Math.round(3e9 * f)},${Math.round(1e9 * f)},9000000000,2000000\n`;
    put(join(p, "counts-plain.csv"), "pair,version,requests,cycles_u,cycles_k,instructions_u,L1_icache_load_misses_u\n" + Array.from({ length: r.R }, (_, k) => (k % 2 ? line(k + 1, "head", 1 + x) + line(k + 1, "base", 1) : line(k + 1, "base", 1) + line(k + 1, "head", 1 + x))).join(""));
  }
  touch(res, put, r);
  return res;
}
const near = (got, want) => assert.ok(Math.abs(got - want) < 1e-6, `${got} is not ${want}`);

test("pass: the change's bound under +1% and the A/A resolved in both readings", () => {
  const r = report(results({ change: (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : 0.002 + i / 1000) }));
  assert.equal(r.exit, 0);
  assert.deepEqual([r.json.gated.resolution, r.json.gated.margin, r.json.gated.reading], ["resolved", "meets +1%", "pass"]);
  // A/A medians -0.2% to +0.2%: bounds +0.2% as recorded and (1 / 0.998 - 1) with the labels swapped.
  near(r.json.gated.aaBound, 0.002);
  near(r.json.gated.aaBoundSwapped, 1 / 0.998 - 1);
  near(r.json.gated.aaMin, -0.002);
  near(r.json.gated.changeBound, 0.007);
  near(r.json.gated.changeMedian, 0.005);
  for (const word of ["`plain`: **pass**", "| change-plain | 5 of 5 | +0.50% | +0.70% |", "A/A: **resolved**", "The margin is +1% with no floor.", "the plan declares no reduction for this workload, so none is read", "this A/A records no placement spread", "## Code aligned beyond 16 bytes", "Neither side has such a section", "the 5th smallest of the 5 placement medians and the lower bound the 1st", "cycles, kernel", "L1 instruction-cache misses, user", "K = 5 is the plan's number"]) assert.ok(r.md.includes(word), word);
  assert.ok(!r.md.includes("DRY RUN"));
  // The split is reported as cycles are: user and kernel move alike in these made-up counts.
  near(r.json["change-plain"].measures["cycles, user"].recorded.bound, 0.007);
  near(r.json["change-plain"].measures["instructions, user"].recorded.bound, 0);
});

test("miss: the change's bound at or above +1% with a resolved A/A", () => {
  const r = report(results({ change: (c, i) => (c === "change-plain" && i === 4 ? 0.012 : 0) }));
  assert.equal(r.exit, 0);
  assert.deepEqual([r.json.gated.margin, r.json.gated.reading], ["misses +1%", "miss"]);
  assert.ok(r.md.includes("`plain`: **miss**"));
});

test("not resolved: an A/A bound at or above +1% in either reading, whatever the change's bound", () => {
  const up = report(results({ change: (c, i) => (c === "aa-plain" ? (i === 2 ? 0.015 : 0) : -0.05) }));
  assert.deepEqual([up.json.gated.resolution, up.json.gated.margin, up.json.gated.reading], ["not resolved", "not resolved: does not pass", "not resolved"]);
  assert.ok(up.md.includes("`plain`: **not resolved**"));
  // A list that ran faster lowers the recorded bound and raises the swapped one.
  const down = report(results({ change: (c, i) => (c === "aa-plain" ? (i === 2 ? -0.015 : 0) : -0.05) }));
  near(down.json.gated.aaBound, 0);
  near(down.json.gated.aaBoundSwapped, 1 / 0.985 - 1);
  assert.equal(down.json.gated.reading, "not resolved");
});

test("no bound: a placement that failed leaves its comparison without one, and nothing passes", () => {
  // A placement whose pairs were not all in has no "ended" line and half its rows.
  const cut = (c) => (res, put) => { put(join(c, "p003", "placement.txt"), readFileSync(join(res, c, "p003", "placement.txt"), "utf8").replace(/ended .*\n$/, "")); };
  const change = report(results({ touch: cut("change-plain") }));
  assert.equal(change.exit, 1);
  assert.deepEqual([change.json.gated.margin, change.json.gated.reading, change.json.gated.changeBound], ["no bound: does not pass", "no bound", null]);
  assert.ok(change.md.includes("**change-plain has no bound** (4 of 5 placements read; none is rerun, replaced or dropped)"));
  const aa = report(results({ touch: cut("aa-plain") }));
  assert.deepEqual([aa.json.gated.resolution, aa.json.gated.margin, aa.json.gated.reading], ["no bound", "the A/A has no bound: does not pass", "no bound"]);
  // Fewer than R valid pairs; a placement that never ran; counts that are not this kit's.
  const short = report(results({ touch: (res, put) => { put(join("change-plain", "p001", "counts-plain.csv"), readFileSync(join(res, "change-plain", "p001", "counts-plain.csv"), "utf8").split("\n").slice(0, 3).join("\n") + "\n"); } }));
  has(short.json.problems["change-plain"], "p001: pairs 1, not 1..2");
  const gone = report(results({ touch: (res) => rmSync(join(res, "aa-plain", "p005"), { recursive: true }) }));
  has(gone.json.problems["aa-plain"], "p005: no placement.txt");
  const other = report(results({ touch: (res, put) => put(join("change-plain", "p002", "answers", "verdict.txt"), "answers: differ\n") }));
  has(other.json.problems["change-plain"], "p002: its two binaries' answers were not compared and passed");
  assert.equal(other.json.gated.reading, "no bound");
});

test("the benefit side is read only when the plan declares a reduction", () => {
  const edit = (p) => { p.workloads[0].reduction = 0.02; p.workloads[0].reads = ["margin", "reduction"]; };
  const won = report(results({ edit, change: (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : -0.03 + i / 1000) }));
  assert.equal(won.json.gated.win, "reduction established");
  assert.ok(won.md.includes("a smallest worthwhile reduction of 2.00%: the change's bound -2.50% against -2.00%"));
  assert.equal(report(results({ edit, change: (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : -0.024 + i / 1000) })).json.gated.win, "reduction not established");
  assert.equal(report(results({ edit, change: (c, i) => (c === "aa-plain" ? (i === 1 ? -0.021 : 0) : -0.04) })).json.gated.win, "not resolved: no win");
});

test("code aligned beyond 16 bytes: each side's sections and list, and every placement's second pad", () => {
  const r = report(results({ align: 32 }));
  assert.equal(r.exit, 0);
  for (const word of ["| `.text.fill` | 32 | libc.a(compress.o) |", "| `crc` | libc.a(crc.o) |", "1 aligned beyond 16 bytes, the first after 1 sections; 2 symbols from it on", "Every placement has a second pad", "- head-p320: first pad 320 (mod 64: 0), second pad 48, .data at 0x3040;"]) assert.ok(r.md.includes(word), word);
  assert.equal(r.json.secondPads.length, 15);
  assert.deepEqual(r.json.records.head.aligned, [{ section: ".text.fill", archive: "libc.a", member: "compress.o", align: 32 }]);
  // Without the second pads' lines and map checks nothing is read.
  const none = report(results({ align: 32, touch: (res) => rmSync(join(res, "second-pads.txt")) }));
  assert.equal(none.exit, 2);
  has(none.json.refused, "no second-pads.txt");
  has(report(results({ align: 32, touch: (res) => rmSync(join(res, "layout", "base-p320-map.txt")) })).json.refused, "base-p320: no second pad's line with a passing map check");
});

test("refused: results a failed, misconfigured or altered run could leave", () => {
  const refused = (opts, word) => { const r = report(results(opts)); assert.equal(r.exit, 2, word); has(r.json.refused, word); assert.ok(r.md.startsWith("# Refused")); };
  refused({ touch: (res) => rmSync(join(res, "run-id")) }, "no run-id in the results");
  refused({ touch: (res, put) => put("schedule.txt", readFileSync(join(res, "schedule.txt"), "utf8").split("\n").reverse().join("\n")) }, "schedule.txt is not the seeded order");
  refused({ touch: (res, put) => put(join("plan", "plan.json"), readFileSync(join(res, "plan", "plan.json"), "utf8").replace('"R": 2', '"R": 3')) }, "resolved.json was written for plan");
  refused({ touch: (res, put) => { const f = join("plan", "resolved.json"), j = JSON.parse(readFileSync(join(res, f), "utf8")); j.P[0] += 16; put(f, JSON.stringify(j)); } }, "resolved.json's P is not what plan.mjs gives");
  refused({ touch: (res, put) => put(join("verify", "verdicts.txt"), readFileSync(join(res, "verify", "verdicts.txt"), "utf8").replace(/^head-p320 .*\n/m, "")) }, "head-p320: not verified to answer as its unpadded binary");
  refused({ touch: (res, put) => put(join("layout", "base-p320.txt"), 'JSON {"ok":false,"pad":320,"second":false}\n') }, "base-p320: no passing layout check");
  refused({ touch: (res, put) => put(join("layout", "base-p320.txt"), 'JSON {"ok":true,"pad":336,"second":false}\n') }, "base-p320: no passing layout check for a pad of 320 bytes");
  refused({ touch: (res) => rmSync(join(res, "maps", "head.map.gz")) }, "head: no unpadded map or no record from it");
  refused({ touch: (res, put) => put("record-base.json", '{"inputs":4,"alignments":{"16":4},"aligned":[],"sectionsBefore":4,"list":[]}\n') }, "record-base.json is not what its map gives");
  refused({ touch: (res, put) => put("DRYRUN", "DRY RUN\n") }, "do not agree on whether this is a dry run");
  // A side whose map shows it has no reading across placements.
  refused({ map: MAP(128) }, "has no reading across placements: 1 input sections of .text are aligned beyond 64 bytes");
  refused({ align: 32, map: MAP(32, ".text._ZN3crc3crc17h0123456789abcdefE") }, "is named for a Rust-mangled symbol and lies at or after the first section aligned beyond 16 bytes");
  // Two placements whose turns overlap did not run one after another.
  refused({ touch: (res, put, r) => { const s = r.schedule[1], f = join(s.comparison, `p${String(s.i).padStart(3, "0")}`, "placement.txt"); put(f, readFileSync(join(res, f), "utf8").replace(/started \S+/, "started 2026-11-24T12:01:45Z")); } }, "the placements did not run one after another");
});

test("a pilot is read for its spread and sizes a K only when it is eligible", () => {
  // Medians rising through the run: not alike over time, so it sizes nothing.
  let order;
  const rising = results({ part: "pilot", touch: (res, put, r) => { order = r.schedule.map((s) => s.i); }, change: (c, i) => i / 100000 });
  const r = report(rising);
  assert.equal(r.exit, 0);
  assert.ok(r.md.includes("A pilot is read only for this spread"));
  assert.equal(order.length, 30);
  // Medians by run order: the k-th placement run shows (k - 15.5) hundredths of a percent.
  const drift = (run) => (c, i) => (run.indexOf(i) - 14.5) / 10000;
  const drifting = report(results({ part: "pilot", change: drift(order) }));
  assert.equal(drifting.json.pilot.sizing.ok, false);
  assert.ok(drifting.md.includes("an A/A that is not eligible sizes nothing"));
  assert.ok(drifting.md.includes("30 of 30 placements read. Placement medians: median +0.00%, standard deviation 0.09%"));
  // The same medians in a shuffled order are eligible; the check at a K is made at that K itself.
  const mix = shuffled(30, rng(11)), even = results({ part: "pilot", change: (c, i) => (mix[order.indexOf(i)] - 15.5) / 10000 });
  const at = sizing(even, 5);
  assert.ok(at.lines.some((l) => l.startsWith("eligible: yes")), at.lines.join("\n"));
  assert.deepEqual([at.ok, at.K, at.workload, at.R], [true, 5, "plain", 2]);
  assert.ok(at.counts.every((m) => m.failing === 0 && m.rank === 5));
  assert.ok(at.lines.at(-1).startsWith("K = 5: failing draws of 200000 (seed 1983) against at most 10000:"));
  assert.equal(sizing(even, 4).ok, false);
  // An incomplete A/A, and results that are refused, size nothing.
  assert.equal(sizing(results({ part: "pilot", change: (c, i) => (mix[order.indexOf(i)] - 15.5) / 10000, touch: (res) => rmSync(join(res, "pilot-plain", "p007"), { recursive: true }) }), 5).ok, false);
  assert.equal(sizing(results({ part: "pilot", touch: (res) => rmSync(join(res, "run-id")) }), 5).ok, false);
});

test("the gated part of a plan sized from its pilot needs that pilot, eligible and under the same plan", () => {
  const dir = join(tmp, "two-parts"), env = { ...process.env };
  delete env.DRYRUN;
  mkdirSync(join(dir, "probe"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan((p) => { p.R = 2; p.pilot = { K: 30, why: "made up for a test" }; })));
  const run = (...args) => spawnSync(process.execPath, [join(here, "plan.mjs"), join(dir, "plan.json"), ...args], { encoding: "utf8", env });
  const none = run("gated", "plain", join(dir, "gated"));
  assert.equal(none.status, 1);
  assert.ok(none.stderr.includes("a workload sized from its pilot needs that pilot's results (--sized-from)"), none.stderr);
  // A pilot run under another plan file is not this plan's first part.
  const other = run("gated", "plain", join(dir, "gated"), "--sized-from", results({ part: "pilot" }));
  assert.equal(other.status, 1);
  assert.ok(/not eligible|not this plan file|sizes no K/.test(other.stderr + other.stdout), other.stderr);
  assert.equal(run("pilot", "plain", join(dir, "pilot")).status, 0);
  assert.ok(readFileSync(join(dir, "pilot", "plan", "resolved.sh"), "utf8").includes("K='30'\n"));
  assert.equal(run().status, 0);
  assert.equal(run("gated").status, 1);
});

test("each threshold the plan declares is stated on its own, and the spread only as the plan declares", () => {
  const quiet = (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : -0.03 + i / 1000);
  // The margin stayed as one build read it; this run reads the reduction alone.
  const win = report(results({ change: quiet, edit: (p) => { p.workloads[0].reduction = 0.02; p.workloads[0].reads = ["reduction"]; } }));
  assert.deepEqual([win.json.gated.margin, win.json.gated.reading, win.json.gated.win], ["not read", "not read", "reduction established"]);
  assert.ok(win.md.includes("- The margin, `plain`: not read by this run: it stays as one build read it, whatever this run reads."));
  assert.ok(win.md.includes("| the margin is not read |"));
  // The reduction stayed as one build read it; this run reads the margin alone.
  const margin = report(results({ change: quiet, edit: (p) => { p.workloads[0].reduction = 0.02; } }));
  assert.deepEqual([margin.json.gated.reading, margin.json.gated.win], ["pass", "not read"]);
  assert.ok(margin.md.includes("- A CPU-cost win, a smallest worthwhile reduction of 2.00%: not read by this run"));
  // An A/A records a spread only if its plan says so before the run, and only complete and resolved.
  const records = (p) => { p.workloads[0].recordsSpread = true; };
  const kept = report(results({ change: quiet, edit: records }));
  assert.equal(kept.json.gated.recordsSpread, true);
  assert.ok(kept.md.includes("the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -0.20% to +0.20%, which is recorded only by a pull request that changes the Choice."));
  assert.ok(report(results({ edit: records, change: (c, i) => (c === "aa-plain" && i === 1 ? 0.02 : 0) })).md.includes("It is not a complete, resolved A/A, so it records none."));
  assert.ok(report(results({ change: quiet })).md.includes("the plan declares that this A/A records no placement spread, so it records none whatever it read."));
  // The declaration a plan's pull request lists says the same before the run.
  const lines = declaration(resolve(plan((p) => { p.workloads[0].reduction = 0.02; p.workloads[0].K = 30; }), "gated", "plain"));
  assert.equal(lines[1], "thresholds: the margin (+1%, no floor): read by this run; a smallest worthwhile reduction of 2.00%: not read by this run, so it stays as one build read it");
  assert.equal(lines[2], "the A/A records no placement spread");
});