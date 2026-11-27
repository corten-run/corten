// The plan file, the mask and the report, on results made here as run.sh leaves them: the words
// a workload is reported in (CONTRIBUTING.md, Pull requests, item 2) and what is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { readMap, record } from "./map.mjs";
import { finalBlock, problems as maskProblems, sed, starts, stated, values } from "./mask.mjs";
import { gauss, rng } from "./model.mjs";
import { pads } from "./pads.mjs";
import { LIMIT } from "./pilot.mjs";
import { order } from "./order.mjs";
import { declaration, inputs, problems, resolve, setup as setupOf } from "./plan.mjs";
import { report, sizing } from "./report.mjs";
import { schedule, shuffled, sides } from "./schedule.mjs";
import { reading } from "./trend.mjs";

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
  // A fragment is refused: curl drops it and wrk 4.1.0 sends it, so the answers and the load would ask for different targets.
  bad((p) => { p.workloads[0].request.path = "/page#top"; }, "request.path, from /, of printable ASCII, with no quote, backslash or fragment (#)");
  bad((p) => { p.workloads[0].mask = [{ header: "Date" }]; }, "Date is left out of every comparison");
  bad((p) => { p.workloads[0].reduction = 2; }, "reduction");
  bad((p) => { delete p.workloads[0].seed; }, "seed");
  bad((p) => { delete p.head; }, "head: a full commit id. A plan that does not name the commits it reads, the change's base and head, is not declared");
  bad((p) => { p.workloads[0].reads = []; }, "reads, the thresholds this run reads across placements");
  bad((p) => { p.workloads[0].reads = ["margin", "floor"]; }, "reads, the thresholds this run reads across placements");
  bad((p) => { p.workloads[0].reads = ["margin", "reduction"]; }, "reads the reduction and declares none");
  bad((p) => { delete p.workloads[0].recordsSpread; }, "recordsSpread");
  assert.deepEqual(problems(plan((p) => { p.pilot = { K: 60, why: "the setup's last pilot spread 0.6%" }; p.workloads[0].reduction = 0.02; })), []);
  // A K given as a number says which A/A it was sized from; a K from the pilot has nothing to say.
  bad((p) => { p.workloads[0].K = 30; }, "sizedFrom, which eligible A/A a K given as a number was sized from");
  bad((p) => { p.workloads[0].sizedFrom = "the last run's A/A"; }, "and only with such a K");
  assert.deepEqual(problems(plan((p) => { p.workloads[0].K = 30; p.workloads[0].sizedFrom = "aa-plain of run 0f8fad5b, under the tag evidence/x"; })), []);
  // A field the kit does not read is refused: a misspelled field is not a field left out.
  bad((p) => { p.extra = 1; }, 'the plan: "extra" is not a field of a plan');
  bad((p) => { p.probe.environment = {}; }, 'probe: "environment" is not a field of a plan');
  bad((p) => { p.host.cpu = "x"; }, 'host: "cpu" is not a field of a plan');
  bad((p) => { p.host.cpus.spare = 9; }, 'host.cpus: "spare" is not a field of a plan');
  bad((p) => { p.load.duration = 3; }, 'load: "duration" is not a field of a plan');
  bad((p) => { p.pilot.reason = "x"; }, 'pilot: "reason" is not a field of a plan');
  bad((p) => { p.workloads[0].starts = "$BIN $PORT"; }, 'workload plain: "starts" is not a field of a plan');
  bad((p) => { p.workloads[0].expects = "expect.txt"; }, 'workload plain: "expects" is not a field of a plan');
  bad((p) => { p.workloads[0].request.method = "POST"; }, 'workload plain: request: "method" is not a field of a plan');
  bad((p) => { p.workloads[0].mask = [{ header: "age", value: "3" }]; }, "age has a field other than header and range");
  // shuffle is true or left out: no other value says whether the placements shuffle.
  for (const v of [false, 1, "yes", "true", null, {}]) bad((p) => { p.workloads[0].shuffle = v; }, "shuffle, true when every placement relinks the workload's functions");
  assert.deepEqual(problems(plan((p) => { p.workloads[0].shuffle = true; })), []);
  // A shuffled workload's seed is one order.mjs reads as resolved.sh writes it: no seed past 2^53 - 1,
  // which a number prints as 1e+21; a plan without the field takes it as before.
  for (const seed of [1e21, 2 ** 53]) bad((p) => { p.workloads[0].shuffle = true; p.workloads[0].seed = seed; }, "seed, at most 9007199254740991 for a workload whose placements shuffle");
  assert.deepEqual(problems(plan((p) => { p.workloads[0].seed = 1e21; })), []);
  assert.deepEqual(problems(plan((p) => { p.workloads[0].shuffle = true; p.workloads[0].seed = Number.MAX_SAFE_INTEGER; })), []);
  assert.equal(order(["a", "b"], Number.MAX_SAFE_INTEGER, 1).split("\n")[0], "corten_layout_pad");
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
  // A number for K is declared with what the plan says it was sized from.
  assert.ok(declaration(resolve(plan((p) => { p.workloads[0].K = 30; p.workloads[0].sizedFrom = "aa-plain of run 0f8fad5b"; }), "gated", "plain"))[0].includes("K = 30 placements (the plan's number, which it says was sized from: aa-plain of run 0f8fad5b), R = 8"));
  // Lists that miss the fourth point's rule are refused, whatever made them.
  const twice = (K) => { const { P, Q } = pads(K); return { P, Q: [P[1], ...Q.slice(1)] }; };
  assert.throws(() => resolve(EXAMPLE, "pilot", "plain", { lists: twice }), /the pad lists for K = 100 miss the fourth point's rule: a size repeats/);
});

test("a shuffled workload is declared before the run, and one without the field is as before", () => {
  const shuffledPlan = plan((p) => { p.workloads[0].shuffle = true; });
  // Without the field nothing plan.mjs gives has a trace of it.
  const plain = resolve(EXAMPLE, "gated", "plain", { K: 69 });
  assert.equal("shuffle" in plain, false);
  assert.ok(!declaration(plain).some((l) => l.includes("inner layout")));
  assert.equal("shuffle" in setupOf(EXAMPLE, EXAMPLE.workloads[0]), false);
  // With it, the run, its declaration and its setup say so; nothing else changes.
  const r = resolve(shuffledPlan, "gated", "plain", { K: 69 });
  assert.equal(r.shuffle, true);
  const { shuffle, ...rest } = r;
  assert.deepEqual(rest, plain);
  const line = declaration(r).find((l) => l.startsWith("inner layout: shuffled."));
  assert.ok(line && line.includes(`an order drawn from seed ${r.seed} and i (order.mjs), the same order for every binary at i, base and head and the A/A's two sides, and another at each i`), line);
  assert.deepEqual(declaration(r).filter((l) => !l.startsWith("inner layout")), declaration(plain));
  assert.equal(setupOf(shuffledPlan, shuffledPlan.workloads[0]).shuffle, true);
});

test("the mask: only named headers, each differing between two starts, one with a range held to it as well", () => {
  const one = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nETag: W/\"abc\"\r\nage: 3\r\n\r\n", two = one.replace("abc", "def");
  assert.deepEqual(values(one, "etag"), ['W/"abc"']);
  assert.equal(sed([{ header: "ETag" }]), "s/^[Ee][Tt][Aa][Gg]:.*$/etag: <masked>/\n");
  assert.deepEqual(starts([{ header: "etag" }], one, two), []);
  has(starts([{ header: "etag" }], one, one), "only a value that differs between starts is masked");
  has(starts([{ header: "x-key" }], one, two), "sent it 0 and 0 times");
  // A value the cost depends on is masked only if it differs between starts too, and is then
  // checked against the plan's range, not accepted as any number.
  has(starts([{ header: "age", range: [0, 3] }], one, two), 'age: two starts of one binary both sent "3"; only a value that differs between starts is masked');
  assert.deepEqual(starts([{ header: "age", range: [0, 3] }], one, one.replace("age: 3", "age: 2")), []);
  assert.deepEqual(stated([{ header: "age", range: [0, 3] }], one), []);
  has(stated([{ header: "age", range: [0, 2] }], one), '"3", not a number from 0 to 2');
  has(stated([{ header: "age", range: [0, 3] }], one.replace("age: 3", "age: soon")), '"soon", not a number from 0 to 3');
  has(stated([{ header: "age", range: [0, 3] }], "HTTP/1.1 200 OK\r\n\r\n"), "sent 0 times, not once");
  // An interim 1xx response's header lines are no evidence for the answer's own: both checks read the final response's alone.
  const hinted = (early, last) => `HTTP/1.1 103 Early Hints\r\n${early}\r\nHTTP/1.1 200 OK\r\n${last}content-type: text/html\r\n\r\n`;
  has(stated([{ header: "age", range: [0, 3] }], hinted("age: 1\r\n", "")), "sent 0 times, not once");
  assert.deepEqual(stated([{ header: "age", range: [0, 3] }], hinted("age: 9\r\n", "age: 2\r\n")), []);
  has(starts([{ header: "age", range: [0, 3] }], hinted("age: 1\r\n", ""), hinted("age: 2\r\n", "")), "sent it 0 and 0 times");
  assert.deepEqual(starts([{ header: "etag" }], hinted("", 'ETag: "a"\r\n'), hinted("", 'ETag: "b"\r\n')), []);
  // The final block runs from its status line to its own blank line: a line inside it that reads
  // like a status line is one of its header lines, and what curl writes after that blank line (a
  // chunked response's trailers, these bytes as curl 7.88.1 wrote them) is in no block.
  const embedded = "HTTP/1.1 200 OK\r\nAge: 99\r\nHTTP/1.1 200 : x\r\nAge: 2\r\ncontent-length: 4\r\n\r\n";
  has(stated([{ header: "age", range: [0, 3] }], embedded), "age: sent 2 times, not once");
  has(starts([{ header: "age", range: [0, 3] }], embedded, embedded.replace("Age: 2", "Age: 1")), "sent it 2 and 2 times");
  const trailed = (head, trailers) => `HTTP/1.1 200 OK\r\n${head}Transfer-Encoding: chunked\r\n\r\n${trailers}`;
  has(stated([{ header: "age", range: [0, 3] }], trailed("", "Age: 2\r\n")), "age: sent 0 times, not once");
  has(stated([{ header: "age", range: [0, 3] }], trailed("", "HTTP/1.1 200 : x\r\nAge: 2\r\n")), "age: sent 0 times, not once");
  assert.deepEqual(stated([{ header: "age", range: [0, 3] }], trailed("Age: 2\r\n", "Age: 9\r\n")), []);
  has(starts([{ header: "age", range: [0, 3] }], trailed("", "Age: 1\r\n"), trailed("", "Age: 2\r\n")), "sent it 0 and 0 times");
  assert.deepEqual(finalBlock(trailed("", "HTTP/1.1 200 : x\r\nAge: 2\r\n")), { line: "HTTP/1.1 200 OK", code: "200", lines: ["HTTP/1.1 200 OK", "Transfer-Encoding: chunked"] });
  assert.equal(finalBlock(hinted("age: 9\r\n", "age: 2\r\n")).line, "HTTP/1.1 200 OK");
  assert.equal(finalBlock("age: 2\r\n\r\n"), null);
  has(maskProblems([{ header: "age", range: [3, 0] }]), "range");
  // A range of one value could never hold a header that two starts send differently.
  has(maskProblems([{ header: "age", range: [0, 0] }]), "age's range is not [low, high] with low under high");
  assert.deepEqual(maskProblems([{ header: "age", range: [0, 1] }]), []);
  // A header with a range that did not differ in these two starts is refused in words that say
  // what the kit takes "can differ" to mean and what the plan's author can do; one without a
  // range has nothing more to be told.
  const [ranged] = starts([{ header: "age", range: [0, 3] }], one, two), [plain] = starts([{ header: "etag" }], one, one);
  for (const word of ["The kit shows that by the two starts it makes and does not take it on the plan's word", "that can differ between starts and did not in these two stops the run here", "The plan's author can leave it out of the mask", "or ask on the pull request whether the rule lets a range stand on the plan's word"]) assert.ok(ranged.includes(word), word);
  assert.ok(plain.endsWith("only a value that differs between starts is masked"), plain);
  // One stated value cannot differ between two starts, so the kit takes a range alone.
  has(maskProblems([{ header: "age", value: "3" }]), "a field other than header and range");
  has(maskProblems([{ header: "etag" }, { header: "ETag" }]), "named twice");
  assert.deepEqual(maskProblems([]), []);
});

// Results as run.sh leaves them, for a plan with K = 5 and R = 2 (the bound is the 5th of 5, the
// largest placement median, and the lower bound the smallest) and a pilot of 30. change(c, i) is
// the change every pair of placement i of comparison c shows: a number, for user and kernel
// cycles alike, or { u, k } for each. sizedFrom: results given to plan.mjs as --sized-from; dry:
// the dry run's variables (DRY_K and the others); model: the host's CPU model.
const row = (at, size, align, rest) => `${at.toString(16)} ${at.toString(16)} ${size.toString(16)} ${align} ${rest}`;
const MAP = (align, late = ".text.crc") => [row(0x1000, 0x400, 64, ".text"), row(0x1000, 0x40, 16, "        /usr/lib/Scrt1.o:(.text)"), row(0x1000, 0, 1, "                _start"),
  row(0x1040, 0x100, align, "        /t/out/libc.a(compress.o):(.text.fill)"), row(0x1040, 0, 1, "                fill"), row(0x1140, 0x20, 16, `        /t/out/libc.a(crc.o):(${late})`), row(0x1140, 0, 1, "                crc"),
  row(0x3000, 0x40, 8, ".data")].join("\n") + "\n";
let made = 0;
const PROBE = "fn main() {}\n";
const numbered = (edit = () => {}) => (p) => { p.R = 2; p.workloads[0].K = 5; p.workloads[0].sizedFrom = "an A/A made up for a test"; p.pilot = { K: 30, why: "made up for a test" }; edit(p); };
function results({ part = "gated", change = () => 0, edit = () => {}, align = 16, map = MAP(align), touch = () => {}, sizedFrom = null, dry = null, model = "Made-up CPU" } = {}) {
  const dir = join(tmp, `run-${++made}`), work = join(dir, "work"), res = join(work, "results");
  mkdirSync(join(dir, "probe", "src"), { recursive: true });
  writeFileSync(join(dir, "probe", "src", "main.rs"), PROBE);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan(numbered(edit)), null, 1));
  const env = { ...process.env, ...(dry ? { DRYRUN: "1", ...dry } : {}) };
  if (!dry) delete env.DRYRUN;
  const made_ = spawnSync(process.execPath, [join(here, "plan.mjs"), join(dir, "plan.json"), part, "plain", work, ...(sizedFrom ? ["--sized-from", sizedFrom] : [])], { encoding: "utf8", env });
  assert.equal(made_.status, 0, made_.stderr);
  const r = JSON.parse(readFileSync(join(work, "plan", "resolved.json"), "utf8")), second = align > 16;
  cpSync(join(work, "plan"), join(res, "plan"), { recursive: true });
  cpSync(join(dir, "probe"), join(res, "probe"), { recursive: true });
  const put = (f, text) => { mkdirSync(dirname(join(res, f)), { recursive: true }); writeFileSync(join(res, f), text); };
  if (dry) put("DRYRUN", "DRY RUN: a test of the scripts, read for nothing\n");
  put("run-id", "0f8fad5b-d9cb-469f-a165-70867728950e\n");
  put("schedule.txt", readFileSync(join(work, "plan", "schedule.txt")));
  put("host-id.txt", `model ${model}\nmicrocode 0x1\nkernel 6.12.0\nos Debian GNU/Linux 13 (trixie)\n`);
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
    const u = typeof x === "number" ? x : x.u, k_ = typeof x === "number" ? x : x.k;
    const line = (pair, version, on) => `${pair},${version},100000,${Math.round(3e9 * (1 + on * u))},${Math.round(1e9 * (1 + on * k_))},9000000000,2000000\n`;
    put(join(p, "counts-plain.csv"), "pair,version,requests,cycles_u,cycles_k,instructions_u,L1_icache_load_misses_u\n" + Array.from({ length: r.R }, (_, k) => (k % 2 ? line(k + 1, "head", 1) + line(k + 1, "base", 0) : line(k + 1, "base", 0) + line(k + 1, "head", 1))).join(""));
  }
  touch(res, put, r);
  return res;
}
const near = (got, want) => assert.ok(Math.abs(got - want) < 1e-6, `${got} is not ${want}`);
/** What follows every reading of a K the kit did not check, as these made-up plans' K = 5 is not. */
const U = "; K not checked by the kit";
// The order the pilot's 30 placements run in, and 30 medians of a spread (in hundredths of a
// percent a step), shuffled over it: alike over time and centred on zero, so eligible.
const ORDER = schedule("pilot", "plain", 30, EXAMPLE.workloads[0].seed).map((s) => s.i), MIX = shuffled(30, rng(11));
const even = (step = 1) => (c, i) => (step * (MIX[ORDER.indexOf(i)] - 15.5)) / 10000;
/** The same medians rising through the run, the k-th placement run showing (k - 15.5) steps: not alike over time. */
const DRIFT = (c, i) => (ORDER.indexOf(i) - 14.5) / 10000;
/** Thirty normal draws at a spread and a K where one kept model's count passes and the other's does not. */
const SPLIT = { seed: 3, sd: 0.004, K: 7, passes: [false, true] };

test("pass: the change's bound under +1% and the A/A resolved in both readings", () => {
  const r = report(results({ change: (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : 0.002 + i / 1000) }));
  assert.equal(r.exit, 0);
  assert.deepEqual([r.json.gated.resolution, r.json.gated.margin, r.json.gated.reading], ["resolved", "meets +1%", `pass${U}`]);
  // A/A medians -0.2% to +0.2%: bounds +0.2% as recorded and (1 / 0.998 - 1) with the labels swapped.
  near(r.json.gated.aaBound, 0.002);
  near(r.json.gated.aaBoundSwapped, 1 / 0.998 - 1);
  near(r.json.gated.aaMin, -0.002);
  near(r.json.gated.changeBound, 0.007);
  near(r.json.gated.changeMedian, 0.005);
  for (const word of ["| change-plain | 5 of 5 | +0.50% | +0.70% |", "A/A: **resolved**", "The margin is +1% with no floor.", "the plan declares no reduction for this workload, so none is read", "this A/A records no placement spread", "## Code aligned beyond 16 bytes", "Neither side has such a section", "the 5th smallest of the 5 placement medians and the lower bound the 1st", "cycles, kernel", "L1 instruction-cache misses, user"]) assert.ok(r.md.includes(word), word);
  assert.ok(!r.md.includes("DRY RUN"));
  // Nothing checked this plan's K, a number: no reading is a bare pass, and report.json says so.
  for (const word of ["`plain`: **pass; K not checked by the kit** (meets +1%).", "| **meets +1%; K not checked by the kit** |", "K = 5 is the plan's number, which the plan says was sized from: an A/A made up for a test. **The kit did not check it**"]) assert.ok(r.md.includes(word), word);
  assert.ok(!/\*\*(pass|meets \+1%)\*\*/.test(r.md));
  assert.deepEqual([r.json.sized, r.json.sizedFrom], [null, "an A/A made up for a test"]);
  // The split is reported as cycles are: user and kernel move alike in these made-up counts.
  near(r.json["change-plain"].measures["cycles, user"].recorded.bound, 0.007);
  near(r.json["change-plain"].measures["instructions, user"].recorded.bound, 0);
});

test("miss: the change's bound at or above +1% with a resolved A/A", () => {
  const r = report(results({ change: (c, i) => (c === "change-plain" && i === 4 ? 0.012 : 0) }));
  assert.equal(r.exit, 0);
  assert.deepEqual([r.json.gated.margin, r.json.gated.reading], ["misses +1%", `miss${U}`]);
  assert.ok(r.md.includes(`\`plain\`: **miss${U}**`));
});

test("the gate is user and kernel cycles together: a change that lowers one and raises the other", () => {
  // User cycles (3 of every 4) fall 2% and kernel cycles rise 12%: +1.50% a request in every
  // placement, a miss, though user cycles alone would pass.
  const r = report(results({ change: (c) => (c === "change-plain" ? { u: -0.02, k: 0.12 } : 0) }));
  near(r.json.gated.changeBound, 0.015);
  assert.deepEqual([r.json.gated.margin, r.json.gated.reading], ["misses +1%", `miss${U}`]);
  near(r.json["change-plain"].measures["cycles, user"].recorded.bound, -0.02);
  near(r.json["change-plain"].measures["cycles, kernel"].recorded.bound, 0.12);
});

test("not resolved: an A/A bound at or above +1% in either reading, whatever the change's bound", () => {
  const up = report(results({ change: (c, i) => (c === "aa-plain" ? (i === 2 ? 0.015 : 0) : -0.05) }));
  assert.deepEqual([up.json.gated.resolution, up.json.gated.margin, up.json.gated.reading], ["not resolved", "not resolved: does not pass", `not resolved${U}`]);
  assert.ok(up.md.includes(`\`plain\`: **not resolved${U}**`));
  // A list that ran faster lowers the recorded bound and raises the swapped one.
  const down = report(results({ change: (c, i) => (c === "aa-plain" ? (i === 2 ? -0.015 : 0) : -0.05) }));
  near(down.json.gated.aaBound, 0);
  near(down.json.gated.aaBoundSwapped, 1 / 0.985 - 1);
  assert.equal(down.json.gated.reading, `not resolved${U}`);
});

test("no bound: a placement that failed leaves its comparison without one, and nothing passes", () => {
  // A placement whose pairs were not all in has no "ended" line and half its rows.
  const cut = (c) => (res, put) => { put(join(c, "p003", "placement.txt"), readFileSync(join(res, c, "p003", "placement.txt"), "utf8").replace(/ended .*\n$/, "")); };
  const change = report(results({ touch: cut("change-plain") }));
  assert.equal(change.exit, 1);
  assert.deepEqual([change.json.gated.margin, change.json.gated.reading, change.json.gated.changeBound], ["no bound: does not pass", `no bound${U}`, null]);
  assert.ok(change.md.includes("**change-plain has no bound** (4 of 5 placements read; none is rerun, replaced or dropped)"));
  const aa = report(results({ touch: cut("aa-plain") }));
  assert.deepEqual([aa.json.gated.resolution, aa.json.gated.margin, aa.json.gated.reading], ["no bound", "the A/A has no bound: does not pass", `no bound${U}`]);
  // Fewer than R valid pairs; a placement that never ran; counts that are not this kit's.
  const short = report(results({ touch: (res, put) => { put(join("change-plain", "p001", "counts-plain.csv"), readFileSync(join(res, "change-plain", "p001", "counts-plain.csv"), "utf8").split("\n").slice(0, 3).join("\n") + "\n"); } }));
  has(short.json.problems["change-plain"], "p001: pairs 1, not 1..2");
  const gone = report(results({ touch: (res) => rmSync(join(res, "aa-plain", "p005"), { recursive: true }) }));
  has(gone.json.problems["aa-plain"], "p005: no placement.txt");
  const other = report(results({ touch: (res, put) => put(join("change-plain", "p002", "answers", "verdict.txt"), "answers: differ\n") }));
  has(other.json.problems["change-plain"], "p002: its two binaries' answers were not compared and passed");
  assert.equal(other.json.gated.reading, `no bound${U}`);
  // A row read twice, a counter that counted nothing, and a placement another run left.
  const csv = join("change-plain", "p004", "counts-plain.csv"), rows = (res) => readFileSync(join(res, csv), "utf8").split("\n");
  const twice = report(results({ touch: (res, put) => { const l = rows(res); put(csv, [...l.slice(0, 2), l[1], ...l.slice(2)].join("\n")); } }));
  has(twice.json.problems["change-plain"], "p004: pair 1 base: 2 rows");
  assert.equal(twice.json.gated.changeBound, null);
  for (const column of [2, 3, 4, 5, 6]) {
    const zero = report(results({ touch: (res, put) => { const l = rows(res); l[1] = l[1].split(",").map((v, j) => (j === column ? "0" : v)).join(","); put(csv, l.join("\n")); } }));
    has(zero.json.problems["change-plain"], "p004: unusable row 1,base,");
    assert.deepEqual([zero.exit, zero.json.gated.reading], [1, `no bound${U}`]);
  }
  const txt = join("aa-plain", "p002", "placement.txt");
  const left = report(results({ touch: (res, put) => put(txt, readFileSync(join(res, txt), "utf8").replace("run 0f8fad5b", "run 1f8fad5b")) }));
  has(left.json.problems["aa-plain"], 'p002: placement.txt line 4 is "run 1f8fad5b-d9cb-469f-a165-70867728950e", not "run 0f8fad5b-d9cb-469f-a165-70867728950e"');
  assert.equal(left.json.gated.resolution, "no bound");
});

test("no bound at K = 30: 29 placements have a rank, and an incomplete comparison still has no bound", () => {
  const thirty = (p) => { p.workloads[0].K = 30; };
  const whole = report(results({ edit: thirty, change: (c, i) => (c === "aa-plain" ? 0 : i / 10000) }));
  // The 20th smallest of 30 changes of 0.01% to 0.30%.
  near(whole.json.gated.changeBound, 0.002);
  assert.equal(whole.json.gated.reading, `pass${U}`);
  const r = report(results({ edit: thirty, change: (c, i) => (c === "aa-plain" ? 0 : i / 10000), touch: (res) => rmSync(join(res, "change-plain", "p030"), { recursive: true }) }));
  assert.equal(r.exit, 1);
  assert.deepEqual([r.json.gated.changeBound, r.json.gated.margin, r.json.gated.reading], [null, "no bound: does not pass", `no bound${U}`]);
  for (const m of Object.values(r.json["change-plain"].measures)) assert.deepEqual([m.recorded.bound, m.recorded.lower, m.swapped.bound, m.swapped.lower], [null, null, null, null]);
  for (const word of ["**change-plain has no bound** (29 of 30 placements read; none is rerun, replaced or dropped)", "| change-plain | 29 of 30 | +0.15% | none |", `\`plain\`: **no bound${U}** (no bound: does not pass).`]) assert.ok(r.md.includes(word), word);
  // The A/A incomplete: nothing resolves, whatever the change's bound.
  const aa = report(results({ edit: thirty, touch: (res) => rmSync(join(res, "aa-plain", "p001"), { recursive: true }) }));
  assert.deepEqual([aa.json.gated.aaBound, aa.json.gated.aaBoundSwapped, aa.json.gated.resolution, aa.json.gated.reading], [null, null, "no bound", `no bound${U}`]);
});

test("the benefit side is read only when the plan declares a reduction", () => {
  const edit = (p) => { p.workloads[0].reduction = 0.02; p.workloads[0].reads = ["margin", "reduction"]; };
  const won = report(results({ edit, change: (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : -0.03 + i / 1000) }));
  assert.equal(won.json.gated.win, `reduction established${U}`);
  assert.ok(won.md.includes("a smallest worthwhile reduction of 2.00%: the change's bound -2.50% against -2.00%"));
  assert.ok(won.md.includes(`with the labels swapped: **reduction established${U}**.`));
  assert.equal(report(results({ edit, change: (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : -0.024 + i / 1000) })).json.gated.win, `reduction not established${U}`);
  assert.equal(report(results({ edit, change: (c, i) => (c === "aa-plain" ? (i === 1 ? -0.021 : 0) : -0.04) })).json.gated.win, `not resolved: no win${U}`);
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

// A shuffled run's results: each side's list of functions, every placement map's SHA-256
// (maps/placements.sha256, here a stand-in from the placement's name), and every layout check
// (and map check, with a second pad) a shuffled one naming the SHA-256 of the ordering file
// order.mjs draws from that list, the seed and the binary's index, and of its placement map; each
// head's check against base's at its index names both ordering files and both maps.
const FUNCTIONS = "_start\ncrc\n_ZN5probe4main17h0123456789abcdefE.llvm.123\n";
const mapSha = (b) => createHash("sha256").update(`map of ${b}`).digest("hex");
const shuffledRun = ({ touch = () => {}, align = 16, index = (i) => i, layout = {}, alike = {}, ...o } = {}) => results({ ...o, align, edit: (p) => { p.workloads[0].shuffle = true; }, touch: (res, put, r) => {
  const second = align > 16;
  for (const side of r.sides) put(`functions-${side}.txt.gz`, gzipSync(FUNCTIONS));
  const used = new Set();
  for (const c of r.comparisons) for (let i = 1; i <= r.K; i++) for (const b of sides(c, i, r.P, r.Q)) used.add(b);
  const orderOf = (b) => {
    const pad = Number(b.replace(/^.*-p/, "")), i = r.P.includes(pad) ? r.P.indexOf(pad) + 1 : r.Q.indexOf(pad) + 1;
    return createHash("sha256").update(order(FUNCTIONS.trim().split("\n"), r.seed, index(i))).digest("hex");
  };
  put(join("maps", "placements.sha256"), [...used].map((b) => `${mapSha(b)}  ${b}.map\n`).join(""));
  for (const b of used) {
    const pad = Number(b.replace(/^.*-p/, "")), sha = orderOf(b);
    put(join("layout", `${b}.txt`), `functions in both: 3\nJSON ${JSON.stringify({ ok: true, pad, second, shuffled: true, order: sha, placedMap: mapSha(b), ...layout })}\n`);
    if (second) put(join("layout", `${b}-map.txt`), `.text: 3 input sections\nJSON ${JSON.stringify({ ok: true, pad, second: 48, shuffled: true })}\n`);
    if (b.startsWith("head-")) put(join("layout", `${b}-alike.txt`), `3 shared names compared, 0 left out as ambiguous\nJSON ${JSON.stringify({ ok: true, pad, shuffled: true, shared: 3, compared: 3, leftOut: 0, baseOrder: orderOf(`base-p${pad}`), headOrder: sha, baseMap: mapSha(`base-p${pad}`), headMap: mapSha(b), ...alike })}\n`);
  }
  touch(res, put, r);
} });

test("a shuffled run says so in its header and reads only placements linked in their drawn order", () => {
  const res = shuffledRun();
  assert.ok(readFileSync(join(res, "plan", "resolved.sh"), "utf8").includes("SHUFFLE='1'\n"));
  const r = report(res);
  assert.equal(r.exit, 0, r.json.refused?.join(" | "));
  assert.equal(r.json.shuffle, true);
  for (const word of ["Inner layout: shuffled. Each placement i was linked with its pad first", "That order is partial: input sections the file gives one key", "every function whose name (less a ThinLTO suffix) each side defines exactly once", "Each placement is a link no app builds.", "in the order of its ordering file"]) assert.ok(r.md.includes(word), word);
  assert.ok(!r.md.includes("every function moved by exactly its pad"));
  assert.equal(report(shuffledRun({ align: 32 })).exit, 0);
  const refused = (opts, word) => { const x = report(shuffledRun(opts)); assert.equal(x.exit, 2, word); has(x.json.refused, word); };
  refused({ touch: (res_) => rmSync(join(res_, "functions-head.txt.gz")) }, "head: no list of its functions (functions-head.txt.gz)");
  refused({ touch: (res_, put) => put("functions-base.txt.gz", gzipSync("crc\ncrc\n")) }, "its side's list of functions makes no ordering file");
  // Linked in another index's order, or the list kept is not the one the files were drawn from.
  refused({ index: (i) => i + 1 }, "no passing shuffled layout check for a pad of");
  refused({ touch: (res_, put) => put("functions-base.txt.gz", gzipSync("_start\ncrc\n")) }, "no passing shuffled layout check");
  // A layout check that is not a shuffled one, and a map check that is not.
  refused({ layout: { shuffled: undefined } }, "no passing shuffled layout check");
  refused({ align: 32, touch: (res_, put) => put(join("layout", "base-p320-map.txt"), `JSON ${JSON.stringify({ ok: true, pad: 320, second: 48 })}\n`) }, "base-p320: no second pad's line with a passing map check");
  // resolved.json that drops the declaration.
  refused({ touch: (res_, put) => { const f = join("plan", "resolved.json"), j = JSON.parse(readFileSync(join(res_, f), "utf8")); delete j.shuffle; put(f, JSON.stringify(j)); } }, "resolved.json's shuffle is not what plan.mjs gives");
  // A head placement without a passing check that it lays the functions it shares with base's at its index alike.
  refused({ touch: (res_) => rmSync(join(res_, "layout", "head-p320-alike.txt")) }, "head-p320: no passing check that it lays the functions it has with base-p320 in one order with it");
  refused({ alike: { ok: false } }, "no passing check that it lays the functions it has with base-p");
  refused({ alike: { shuffled: undefined } }, "no passing check that it lays the functions it has with base-p");
});

test("a shuffled run's checks are bound to the placement maps it kept and the ordering files it draws", () => {
  assert.equal(report(shuffledRun()).exit, 0);
  const refused = (opts, word) => { const x = report(shuffledRun(opts)); assert.equal(x.exit, 2, word); has(x.json.refused, word); };
  // A run that does not say which placement maps it kept; a layout check of another map.
  refused({ touch: (res_) => rmSync(join(res_, "maps", "placements.sha256")) }, "a shuffled run without maps/placements.sha256");
  refused({ layout: { placedMap: mapSha("elsewhere") } }, "base-p320: no passing shuffled layout check");
  // A check against base at the same pad that read other maps or ordering files than this run's,
  // or names none: its pad matches, its maps contradict the run's.
  for (const k of ["baseMap", "headMap", "baseOrder", "headOrder"]) {
    refused({ alike: { [k]: mapSha("elsewhere") } }, "head-p320: no passing check that it lays the functions it has with base-p320 in one order with it, of the ordering files drawn for both and the placement maps kept for both");
    refused({ alike: { [k]: undefined } }, "head-p320: no passing check that it lays the functions it has with base-p320");
  }
  // Two placements' maps swapped in the alike check: each a map this run kept, neither the one for its side.
  refused({ alike: { baseMap: mapSha("head-p320"), headMap: mapSha("base-p320") } }, "head-p320: no passing check that it lays the functions it has with base-p320");
});

test("build.sh and run.sh shuffle only when the plan says so, whatever SHUFFLE the caller's environment holds", { skip: process.platform !== "linux" && "runs the scripts' start under sh" }, () => {
  // Each script up to the line after it reads the plan, then what it holds SHUFFLE to be.
  const work = mkdtempSync(join(tmp, "shuffle-env-"));
  mkdirSync(join(work, "plan"));
  for (const [script, next] of [["build.sh", "B=$WORK/bin; M=$WORK/maps"], ["run.sh", "B=$WORK/bin; PL=$WORK/plan"]]) {
    const text = readFileSync(join(here, script), "utf8"), cut = text.indexOf(`\n${next}\n`);
    assert.ok(cut > 0, `${script} no longer has the line ${next}`);
    const start = join(work, `start-${script}`);
    writeFileSync(start, `${text.slice(0, cut)}\necho "SHUFFLE=\${SHUFFLE:-0}"\n`);
    const held = (resolved, env) => {
      writeFileSync(join(work, "plan", "resolved.sh"), resolved);
      const r = spawnSync("sh", [start, work], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
      return /^SHUFFLE=(\S*)$/m.exec(r.stdout)?.[1];
    };
    assert.equal(held("DRY=0\n", { SHUFFLE: "1" }), "0", `${script} reads the caller's SHUFFLE`);
    assert.equal(held("DRY=0\n", {}), "0", script);
    assert.equal(held("DRY=0\nSHUFFLE='1'\n", {}), "1", script);
    assert.equal(held("DRY=0\nSHUFFLE='1'\n", { SHUFFLE: "0" }), "1", script);
  }
});

test("build.sh and run.sh keep the plan's SHUFFLE when the cargo env file they source sets another", { skip: process.platform !== "linux" && "runs the scripts under sh" }, () => {
  const work = mkdtempSync(join(tmp, "shuffle-cargo-")), home = join(work, "home");
  mkdirSync(join(work, "plan")); mkdirSync(join(home, ".cargo"), { recursive: true });
  const cargo = (text) => writeFileSync(join(home, ".cargo", "env"), text);
  // build.sh up to the line after it sources the cargo env file, then what SHUFFLE is and whether it is exported.
  const text = readFileSync(join(here, "build.sh"), "utf8"), next = '\nexport RUSTUP_TOOLCHAIN="$TOOLCHAIN"\n', cut = text.indexOf(next);
  assert.ok(cut > 0 && text.slice(0, cut).includes(".cargo/env"), "build.sh no longer sources the cargo env file before it sets RUSTUP_TOOLCHAIN");
  const start = join(work, "start-build.sh");
  writeFileSync(start, `${text.slice(0, cut)}\necho "SHUFFLE=${"${SHUFFLE:-0}"} exported=$(env | grep -c '^SHUFFLE=')"\n`);
  const held = (resolved) => {
    writeFileSync(join(work, "plan", "resolved.sh"), `WORK='${work}'\nDRY=0\n${resolved}`);
    const r = spawnSync("sh", [start, work], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return /^SHUFFLE=(\S*) exported=(\d+)$/m.exec(r.stdout)?.slice(1).join(" ");
  };
  cargo('export SHUFFLE=1\nexport PATH="$HOME/.cargo/bin:$PATH"\n');
  assert.equal(held(""), "0 0", "build.sh takes the cargo env file's SHUFFLE over an unshuffled plan's");
  cargo("export SHUFFLE=0\n");
  assert.equal(held("SHUFFLE='1'\n"), "1 0", "build.sh takes the cargo env file's SHUFFLE over a shuffled plan's");
  cargo('export PATH="$HOME/.cargo/bin:$PATH"\n');
  assert.equal(held(""), "0 0");
  assert.equal(held("SHUFFLE='1'\n"), "1 0");
  // run.sh sources it after checks a test cannot meet: its line that sources it, run with the plan's value held.
  const line = readFileSync(join(here, "run.sh"), "utf8").split("\n").filter((l) => l.includes(".cargo/env") && !l.startsWith("#"));
  assert.equal(line.length, 1, "run.sh does not source the cargo env file on one line");
  const run = (plan, file) => {
    cargo(file);
    const r = spawnSync("sh", ["-c", `set -eu; SHUFFLE=${plan}; ${line[0]}\necho "SHUFFLE=$SHUFFLE exported=$(env | grep -c '^SHUFFLE=' || true)"`], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return /^SHUFFLE=(\S*) exported=(\d+)$/m.exec(r.stdout)?.slice(1).join(" ");
  };
  assert.equal(run(0, "export SHUFFLE=1\n"), "0 0", "run.sh takes the cargo env file's SHUFFLE over an unshuffled plan's");
  assert.equal(run(1, "export SHUFFLE=0\n"), "1 0", "run.sh takes the cargo env file's SHUFFLE over a shuffled plan's");
  assert.equal(run(1, ""), "1 0");
});

test("run.sh stops before any turn when it cannot keep a shuffled run's list of functions", { skip: process.platform !== "linux" && "runs run.sh's line under sh" }, () => {
  // Its line that keeps each side's list, run as run.sh runs it (set -u, finish ends the run), then a
  // line run.sh would reach only after it.
  const line = readFileSync(join(here, "run.sh"), "utf8").split("\n").filter((l) => l.includes("functions-$s.txt.gz") && !l.startsWith("#"));
  assert.equal(line.length, 1, "run.sh does not keep the lists on one line");
  const work = mkdtempSync(join(tmp, "shuffle-keep-")), bin = join(work, "bin"), res = join(work, "results");
  mkdirSync(bin); mkdirSync(res);
  const run = (shuffle) => spawnSync("sh", ["-c", `set -u; finish() { echo "FINISH $1 $2"; exit "$1"; }; B='${bin}'; RES='${res}'; SIDES='base head'; SHUFFLE=${shuffle}\n${line[0]}\necho CONTINUED`], { encoding: "utf8", env: { PATH: process.env.PATH } });
  // A side's list missing, or empty: the run ends there, refused, and goes on to nothing.
  writeFileSync(join(bin, "functions-base.txt"), "a\nb\n");
  for (const head of [null, ""]) {
    rmSync(join(bin, "functions-head.txt"), { force: true });
    if (head !== null) writeFileSync(join(bin, "functions-head.txt"), head);
    const r = run(1);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FINISH 1 refused: a shuffled run's list of head's functions, bin\/functions-head\.txt, from which report\.mjs draws every ordering file again, could not be kept in the results$/m);
    assert.doesNotMatch(r.stdout, /CONTINUED/);
  }
  // Both lists there: kept, gzipped, and the run goes on.
  writeFileSync(join(bin, "functions-head.txt"), "a\nc\n");
  const ok = run(1);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^CONTINUED$/m);
  assert.equal(gunzipSync(readFileSync(join(res, "functions-head.txt.gz"))).toString(), "a\nc\n");
  // An unshuffled run keeps none and needs none.
  rmSync(join(bin, "functions-head.txt")); rmSync(join(res, "functions-head.txt.gz"));
  const plain = run(0);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.equal(existsSync(join(res, "functions-head.txt.gz")), false);
});

test("a run without the field reads as before and refuses a shuffled placement's check", () => {
  const res = results(), r = report(res);
  assert.equal(r.exit, 0);
  assert.equal("shuffle" in r.json, false);
  assert.ok(!r.md.includes("Inner layout"));
  assert.ok(!readFileSync(join(res, "plan", "resolved.sh"), "utf8").includes("SHUFFLE"));
  assert.equal("shuffle" in JSON.parse(readFileSync(join(res, "plan", "resolved.json"), "utf8")), false);
  const refused = (touch, word) => { const x = report(results({ touch })); assert.equal(x.exit, 2, word); has(x.json.refused, word); };
  refused((res_, put) => put(join("layout", "base-p320.txt"), `JSON ${JSON.stringify({ ok: true, pad: 320, second: false, shuffled: true, order: "0".repeat(64) })}\n`), "base-p320: no passing layout check for a pad of 320 bytes");
  refused((res_, put) => { const f = join("plan", "resolved.json"), j = JSON.parse(readFileSync(join(res_, f), "utf8")); j.shuffle = true; put(f, JSON.stringify(j)); }, "resolved.json's shuffle is not what plan.mjs gives");
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
  // What the plan names by path is kept with the results and is what plan.mjs listed: a probe
  // edited, a file added to it or left out, and another request script are each refused.
  const other = "are not the files plan.mjs resolved";
  refused({ touch: (res, put) => put(join("probe", "src", "main.rs"), PROBE + "// edited\n") }, other);
  refused({ touch: (res, put) => put(join("probe", "build.rs"), PROBE) }, other);
  refused({ touch: (res) => rmSync(join(res, "probe"), { recursive: true }) }, other);
  refused({ touch: (res, put) => put(join("plan", "request.lua"), "wrk.method = \"POST\"\n") }, other);
  refused({ touch: (res, put) => put(join("plan", "expect.txt"), "1c1\n") }, other);
  refused({ touch: (res) => rmSync(join(res, "plan", "request.lua")) }, `no ${join("plan", "request.lua")} in the results`);
  // A side whose map shows it has no reading across placements.
  refused({ map: MAP(128) }, "has no reading across placements: 1 input sections of .text are aligned beyond 64 bytes");
  refused({ align: 32, map: MAP(32, ".text._ZN3crc3crc17h0123456789abcdefE") }, "is named for a Rust-mangled symbol and lies at or after the first section aligned beyond 16 bytes");
  // Two placements whose turns overlap did not run one after another.
  refused({ touch: (res, put, r) => { const s = r.schedule[1], f = join(s.comparison, `p${String(s.i).padStart(3, "0")}`, "placement.txt"); put(f, readFileSync(join(res, f), "utf8").replace(/started \S+/, "started 2026-11-24T12:01:45Z")); } }, "the placements did not run one after another");
});

test("a pilot is read for its spread and sizes a K only when it is eligible", () => {
  // Medians by run order, the k-th placement run showing (k - 15.5) hundredths of a percent: not
  // alike over time, so it sizes nothing.
  const drifting = report(results({ part: "pilot", change: DRIFT }));
  assert.equal(drifting.exit, 0);
  assert.ok(drifting.md.includes("A pilot is read only for this spread"));
  assert.equal(drifting.json.pilot.sizing.ok, false);
  assert.ok(drifting.md.includes("an A/A that is not eligible sizes nothing"));
  assert.ok(drifting.md.includes("30 of 30 placements read. Placement medians: median +0.00%, standard deviation 0.09%"));
  // The same medians in a shuffled order are eligible; the check at a K is made at that K itself.
  const pilot = results({ part: "pilot", change: even() });
  const at = sizing(pilot, 5);
  assert.ok(at.lines.some((l) => l.startsWith("eligible: yes")), at.lines.join("\n"));
  assert.deepEqual([at.ok, at.K, at.workload, at.R, at.model], [true, 5, "plain", 2, "Made-up CPU"]);
  assert.ok(at.counts.every((m) => m.failing === 0 && m.rank === 5));
  assert.ok(at.lines.at(-1).startsWith("K = 5: failing draws of 200000 (seed 1983) against at most 10000:"));
  assert.equal(sizing(pilot, 4).ok, false);
  // As the command an author runs: the same lines, and exit 0 only when the K passes.
  const command = (...args) => spawnSync(process.execPath, [join(here, "pilot.mjs"), ...args], { encoding: "utf8" });
  const ran = command(pilot, "5");
  assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, at.lines.join("\n") + "\n", ""]);
  assert.equal(command(pilot, "4").status, 1);
  assert.deepEqual([command().status, command().stdout], [2, ""]);
  // An incomplete A/A, and results that are refused, size nothing.
  assert.equal(sizing(results({ part: "pilot", change: even(), touch: (res) => rmSync(join(res, "pilot-plain", "p007"), { recursive: true }) }), 5).ok, false);
  assert.equal(sizing(results({ part: "pilot", touch: (res) => rmSync(join(res, "run-id")) }), 5).ok, false);
});

test("a K passes only under each model kept: one model's count over the limit refuses it", () => {
  // Thirty medians from a normal draw, in a shuffled order: eligible, normality not rejected, so
  // both models are kept. At this K the two models' counts lie on either side of the limit.
  const z = Array.from({ length: 30 }, ((u) => () => gauss(u))(rng(SPLIT.seed)));
  const res = results({ part: "pilot", change: (c, i) => SPLIT.sd * z[MIX[ORDER.indexOf(i)] - 1] });
  const at = sizing(res, SPLIT.K);
  assert.ok(at.lines.some((l) => l.startsWith("eligible: yes")), at.lines.join("\n"));
  assert.deepEqual(at.models, ["normal", "smoothed"]);
  assert.deepEqual(at.counts.map((m) => m.failing <= LIMIT), SPLIT.passes, JSON.stringify(at.counts));
  assert.equal(at.ok, false);
  assert.ok(at.lines.at(-1).endsWith("does not pass; the plan takes no K the models do not allow"));
});

test("a dry run says what it is on its page and sizes nothing", () => {
  // A dry pilot of 30 placements whose medians would size a K if it were a run.
  const dry = results({ part: "pilot", dry: { DRY_K: "30" }, change: even() });
  const s = sizing(dry, 5);
  assert.deepEqual([s.ok, s.K, s.counts, s.lines.at(-1)], [false, null, null, "a dry run sizes nothing"]);
  const page = report(dry);
  assert.ok(page.md.includes("**DRY RUN: a test of the scripts, read for nothing. No figure below is a measurement of anything.**"));
  assert.deepEqual([page.json.dry, page.json.pilot.sizing.ok, page.json.pilot.sizing.K], [true, false, null]);
  assert.ok(page.md.includes("- a dry run sizes nothing"));
  // A dry gated part: its K is the dry run's, and nothing checked it.
  const gated = report(results({ dry: {} }));
  for (const word of ["**DRY RUN: a test of the scripts, read for nothing.", "K = 6 is the dry run's, not one the plan declares or the sizing check passed.", `\`plain\`: **pass${U}**`]) assert.ok(gated.md.includes(word), word);
  assert.deepEqual([gated.json.dry, gated.json.K, gated.json.sized], [true, 6, null]);
});

const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
/** A plan in two parts: the workload's K is the pilot's to give. */
const sized = (p) => { p.workloads[0].K = "pilot"; delete p.workloads[0].sizedFrom; };

test("a plan in two parts: the gated part takes its K from its pilot, and its readings carry no note", () => {
  const pilot = results({ part: "pilot", edit: sized, change: even() });
  const res = results({ edit: sized, sizedFrom: pilot, change: (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : 0.002 + i / 1000) });
  const saved = JSON.parse(readFileSync(join(res, "plan", "resolved.json"), "utf8"));
  assert.deepEqual([saved.K, saved.declaredK, saved.sized.K, saved.sized.from, saved.sized.model, saved.sized.models], [5, "pilot", 5, RUN, "Made-up CPU", ["normal", "smoothed"]]);
  assert.ok(readFileSync(join(res, "plan", "resolved.sh"), "utf8").includes("SIZED_MODEL='Made-up CPU'\n"));
  const r = report(res);
  assert.equal(r.exit, 0);
  assert.deepEqual([r.json.gated.reading, r.json.sized.K, r.json.sized.from, r.json.sizedFrom], ["pass", 5, RUN, null]);
  for (const word of ["`plain`: **pass** (meets +1%).", `K = 5 is the smallest at which the sizing check passes from run ${RUN}: normal 0 failing draws of 200000, smoothed 0 failing draws of 200000, against at most 10000.`]) assert.ok(r.md.includes(word), word);
  assert.ok(!r.md.includes("not checked by the kit") && !r.md.includes("did not check"));
  // A K given as a number, checked at that K itself from an A/A of this kit on the plan's setup.
  const aa = results({ part: "pilot", change: even() });
  const checked = report(results({ sizedFrom: aa }));
  assert.deepEqual([checked.json.gated.reading, checked.json.sized.K, checked.json.sizedFrom], ["pass", 5, "an A/A made up for a test"]);
  assert.ok(checked.md.includes(`K = 5 is the plan's number (which it says was sized from: an A/A made up for a test), checked at that K itself from run ${RUN}: normal 0 failing draws`));
  // The A/A was read on one CPU model and the run is on another: not the A/A's setup.
  const moved = report(results({ edit: sized, sizedFrom: pilot, model: "Another CPU" }));
  assert.equal(moved.exit, 2);
  has(moved.json.refused, 'K was checked from an A/A read on "Made-up CPU", and this run\'s host is "Another CPU"');
});

test("--sized-from: each result that does not size this plan's K is refused in its own words", () => {
  const env = { ...process.env };
  delete env.DRYRUN;
  let n = 0;
  // plan.mjs on a plan made here as the results above are, on their probe unless another is given.
  const resolved = (edit, from, { probe = PROBE, part = "gated", workload = "plain" } = {}) => {
    const dir = join(tmp, `sized-${++n}`);
    mkdirSync(join(dir, "probe", "src"), { recursive: true });
    writeFileSync(join(dir, "probe", "src", "main.rs"), probe);
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan(numbered(edit)), null, 1));
    const r = spawnSync(process.execPath, [join(here, "plan.mjs"), join(dir, "plan.json"), ...(part ? [part, workload, join(dir, "work")] : []), ...(from ? ["--sized-from", from] : [])], { encoding: "utf8", env });
    return { status: r.status, out: r.stdout, err: r.stderr, written: existsSync(join(dir, "work", "plan")) };
  };
  const refused = (r, word) => { assert.equal(r.status, 1, r.out); assert.ok(r.err.includes(word), `no "${word}" in: ${r.err}`); assert.equal(r.written, false, word); };
  const taken = (r, ...words) => { assert.equal(r.status, 0, r.err); for (const w of words) assert.ok(r.out.includes(w), `no "${w}" in: ${r.out}`); assert.equal(r.written, true); };
  const pilot = results({ part: "pilot", edit: sized, change: even() });

  // A plan in two parts: the pilot, eligible, under this plan file and on the files it names.
  taken(resolved(sized, pilot), "K = 5, the smallest from 5 to 254 at which every kept model's count of failing draws is at most 10000 of 200000", "gated plain: K = 5 placements (from the pilot, by the sizing rule), R = 2", "inputs: sha256 ");
  refused(resolved(sized), "plain: K is undefined: a workload sized from its pilot needs that pilot's results (--sized-from)");
  refused(resolved((p) => { sized(p); p.workloads[0].declared = "the same workload in other words"; }, pilot), "not this plan file: the pilot and the gated run are two parts of one plan");
  refused(resolved((p) => { sized(p); p.R = 3; }, pilot), "holds workload plain at R = 2, not plain at R = 3");
  refused(resolved(sized, pilot, { probe: PROBE + "// edited since the pilot\n" }), "the probe, the request script or the expected answer changed since the pilot, and the two parts are one plan");
  refused(resolved(sized, results({ part: "pilot", edit: sized, change: DRIFT })), "sizes no K for plain: the workload is not read across placements under this plan");
  refused(resolved(sized, results({ part: "pilot", edit: sized, change: even(), touch: (res) => rmSync(join(res, "pilot-plain", "p007"), { recursive: true }) })), "sizes no K for plain");
  refused(resolved(sized, results({ part: "pilot", edit: sized, touch: (res) => rmSync(join(res, "run-id")) })), "is not a run's results this kit reads");
  refused(resolved(sized, pilot, { part: "pilot" }), "a pilot is sized from nothing");
  // A pilot of one workload sizes that workload alone, though another of the same plan file is
  // read on the same files: the plan and its inputs are one, and the workload is not.
  const two = (p) => { sized(p); p.workloads.push({ ...p.workloads[0], name: "other", seed: p.workloads[0].seed + 1 }); };
  const ofPlain = results({ part: "pilot", edit: two, change: even() });
  taken(resolved(two, ofPlain), "gated plain: K = 5 placements (from the pilot, by the sizing rule)");
  refused(resolved(two, ofPlain, { workload: "other" }), "holds workload plain at R = 2, not other at R = 2");

  // A K given as a number: checked at that K itself from an A/A of this kit, on this plan's
  // setup; without one, resolved and said to be unchecked.
  const aa = results({ part: "pilot", change: even() }), same = () => {};
  taken(resolved(same, aa), "K = 5: failing draws of 200000 (seed 1983) against at most 10000: normal 0 (the 5th), smoothed 0 (the 5th): passes", "(the plan's number, which it says was sized from: an A/A made up for a test)");
  assert.ok(!resolved(same, aa).out.includes("not checked by the kit"));
  taken(resolved(same), "K = 5 is not checked by the kit: no --sized-from names results of this kit to check it from");
  // The same medians forty times as wide: K = 5 does not pass.
  refused(resolved(same, results({ part: "pilot", change: even(40) })), "does not pass K = 5 for plain: the plan takes no K the sizing check does not allow");
  // An A/A read under another plan sizes this one only on this plan's setup.
  const setup = (edit, word, probe) => refused(resolved(edit, aa, { probe }), `was read on another setup than this plan's: its ${word}`);
  setup((p) => { p.load.connections = 128; }, "load differs");
  setup((p) => { p.workloads[0].start = "$BIN $PORT other"; }, "start differs");
  setup((p) => { p.probe.start = "$BIN $PORT other"; }, "start differs");
  setup((p) => { p.workloads[0].request.headers = ["Accept-Encoding: gzip"]; }, "request differs");
  setup((p) => { p.workloads[0].mask = [{ header: "etag" }]; }, "mask differs");
  // The build command and the build's environment make the binary as the probe's source does.
  setup((p) => { p.probe.build = "cargo build --release --locked"; }, "build differs");
  setup((p) => { p.probe.env.RUSTFLAGS = "-C target-cpu=native"; }, "env differs");
  setup((p) => { delete p.probe.env.ZSTD_SYS_USE_PKG_CONFIG; }, "env differs");
  // The environment is compared by name, whatever order the two plans write it in; everything
  // else as written, so the same load with its fields in another order is another setup.
  const flags = (...names) => (p) => { p.probe.env = Object.fromEntries(names.map((k) => [k, "1"])); };
  const flagged = results({ part: "pilot", change: even(), edit: flags("ZSTD_SYS_USE_PKG_CONFIG", "A_FLAG") });
  taken(resolved(flags("A_FLAG", "ZSTD_SYS_USE_PKG_CONFIG"), flagged), "K = 5: failing draws of 200000 (seed 1983) against at most 10000:", "passes");
  setup((p) => { const { threads, connections, seconds } = p.load; p.load = { seconds, connections, threads }; }, "load differs");
  setup(same, "probe or request script differs", PROBE + "// another probe\n");
  setup((p) => { p.load.threads = 4; p.workloads[0].request.path = "/unstaged"; }, "request, load differ");
  // An A/A of placements moved by their pads alone does not size a shuffled plan's K.
  setup((p) => { p.workloads[0].shuffle = true; }, "shuffle differs");
  // What a plan declares before any part is resolved includes the inputs' digest.
  taken({ ...resolved(sized, null, { part: null }), written: true }, "pilot plain: K = 30 placements, R = 2", "plain: inputs: sha256 ");
});

test("the inputs: every file the plan names by path, listed with its SHA-256 as sha256sum reads it", () => {
  const res = results(), list = readFileSync(join(res, "plan", "inputs.sha256"), "utf8");
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  assert.equal(list, `${sha(readFileSync(join(here, "get.lua")))}  plan/request.lua\n${sha(PROBE)}  probe/src/main.rs\n`);
  const saved = JSON.parse(readFileSync(join(res, "plan", "resolved.json"), "utf8"));
  assert.equal(saved.inputs, sha(list));
  assert.ok(readFileSync(join(res, "plan", "resolved.sh"), "utf8").includes(`INPUTS_SHA='${sha(list)}'\n`));
  const r = report(res);
  assert.equal(r.json.inputs, sha(list));
  assert.ok(r.md.includes(`plan sha256 ${saved.plan}, inputs sha256 ${sha(list)} (the 2 files the plan names by path`));
  // The list is of the files as they are, sorted by path, with the expected answer when there is one.
  const got = inputs(join(res, "probe"), join(res, "plan", "request.lua"), join(res, "run-id"));
  assert.deepEqual([got.files, got.text], [3, `${sha(RUN + "\n")}  plan/expect.txt\n${list}`]);
  // A probe's directory with a Cargo.lock of its own is refused: build.sh puts each side's there.
  const dir = join(tmp, "locked");
  mkdirSync(join(dir, "probe"), { recursive: true });
  writeFileSync(join(dir, "probe", "Cargo.lock"), "");
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan(numbered())));
  const env = { ...process.env };
  delete env.DRYRUN;
  const locked = spawnSync(process.execPath, [join(here, "plan.mjs"), join(dir, "plan.json"), "gated", "plain", join(dir, "work")], { encoding: "utf8", env });
  assert.equal(locked.status, 1);
  assert.ok(locked.stderr.includes("the probe's directory holds a Cargo.lock"), locked.stderr);
});

test("the expected difference: it ends with one bodies line with the SHA-256s in full, whether the bodies differ or not, and any other is refused before anything is written", () => {
  const dir = join(tmp, "expected"), env = { ...process.env };
  delete env.DRYRUN;
  mkdirSync(join(dir, "probe", "src"), { recursive: true });
  writeFileSync(join(dir, "probe", "src", "main.rs"), PROBE);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan(numbered((p) => { p.workloads[0].expect = "expect.txt"; }))));
  const resolve_ = (text, work) => { writeFileSync(join(dir, "expect.txt"), text); return spawnSync(process.execPath, [join(here, "plan.mjs"), join(dir, "plan.json"), "gated", "plain", join(dir, work)], { encoding: "utf8", env }); };
  const headers = "5c5\n< corten-shell: 618f\n---\n> corten-shell: c21c\n", digests = `sha256 ${"a".repeat(64)} and ${"b".repeat(64)}`;
  const differ = `bodies differ: 6124 and 6124 bytes, ${digests}`, same = `bodies same: 6124 bytes, sha256 ${"a".repeat(64)}`;
  for (const [work, text] of [["bodies", `${headers}${differ}\n`], ["body-only", `bodies differ: 6124 and 6125 bytes, ${digests}\n`], ["headers", `${headers}${same}\n`]]) {
    const r = resolve_(text, work);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, work, "plan", "expect.txt"), "utf8"), text);
  }
  // What turns.sh cannot write is refused, since the placement would fail after its build: the
  // lengths alone (the kit's line before it bound the bodies' digests), a digest cut short, a
  // difference in the headers with no bodies line (which binds no body), a bodies line that is
  // not the last or not the only one, and a file with no difference at all.
  const why = "does not end with one bodies line as turns.sh writes it";
  for (const [work, text] of [
    ["lengths", `${headers}bodies differ: 6124 and 6124 bytes\n`],
    ["short", `${headers}bodies differ: 6124 and 6124 bytes, sha256 ${"a".repeat(16)} and ${"b".repeat(16)}\n`],
    ["short-same", `${headers}bodies same: 6124 bytes, sha256 ${"a".repeat(16)}\n`],
    ["header-only", headers],
    ["not-last", `${same}\n${headers}`],
    ["two", `${headers}${same}\n${same}\n`],
    ["unended", `${headers}${same}`],
    ["empty", ""],
  ]) {
    const r = resolve_(text, work);
    assert.equal(r.status, 1, `${work}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`expect.txt, the workload's expected difference: ${why}`) && r.stderr.includes("record the difference again with this kit"), `${work}: ${r.stderr}`);
    assert.equal(existsSync(join(dir, work)), false);
  }
  // A "bodies same" line alone is one turns.sh never writes: it writes that line only after the
  // headers' diff, and nothing when neither the headers nor the bodies differ.
  for (const [work, text] of [["same-alone", `${same}\n`], ["same-after-blank", `\n${same}\n`]]) {
    const r = resolve_(text, work);
    assert.equal(r.status, 1, `${work}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`expect.txt, the workload's expected difference: is a "bodies same" line alone, which turns.sh writes only after the headers' diff`) && r.stderr.includes("record the difference again with this kit"), `${work}: ${r.stderr}`);
    assert.equal(existsSync(join(dir, work)), false);
  }
});

test("the inputs: a file name the list cannot hold and a symbolic link are refused, each in its own words", () => {
  const dir = join(tmp, "odd"), probe = join(dir, "probe"), script = join(here, "get.lua");
  mkdirSync(join(probe, "src"), { recursive: true });
  writeFileSync(join(probe, "src", "main.rs"), PROBE);
  assert.equal(inputs(probe, script, null).files, 2);
  // sha256sum reads a line a file, so a name with white space in it has no line.
  writeFileSync(join(probe, "two words.rs"), PROBE);
  assert.throws(() => inputs(probe, script, null), /^Error: probe\/two words\.rs: a file's name the list of inputs cannot hold \(white space, a backslash or a character outside ASCII\)$/);
  rmSync(join(probe, "two words.rs"));
  // A link is not a file of the probe: what it points at lies outside what the plan names. A
  // link to a directory is made as a junction where the system asks a right for any other.
  const link = (target, at, type) => { try { symlinkSync(target, at, type); return true; } catch (e) { if (process.platform === "win32" && e.code === "EPERM") return false; throw e; } };
  const words = (name) => new RegExp(`^Error: probe/${name}: a symbolic link, which the list of inputs does not take: it lists the probe's files by what they hold`);
  if (link(join(probe, "src", "main.rs"), join(probe, "build.rs"), "file")) {
    assert.throws(() => inputs(probe, script, null), words("build\\.rs"));
    rmSync(join(probe, "build.rs"));
  }
  mkdirSync(join(dir, "else"));
  writeFileSync(join(dir, "else", "config.toml"), "[build]\nrustflags = [\"-C\", \"target-cpu=native\"]\n");
  symlinkSync(join(dir, "else"), join(probe, ".cargo"), "junction");
  assert.throws(() => inputs(probe, script, null), words("\\.cargo"));
  symlinkSync(join(dir, "else"), join(probe, "src", "deep"), "junction");
  rmSync(join(probe, ".cargo"));
  assert.throws(() => inputs(probe, script, null), words("src/deep"));
  rmSync(join(probe, "src", "deep"));
  assert.equal(inputs(probe, script, null).files, 2);
  // A probe directory that is itself a link gets one refusal, from plan.mjs, before anything is written.
  symlinkSync(probe, join(dir, "linked"), "junction");
  assert.throws(() => inputs(join(dir, "linked"), script, null), /the probe's directory is itself a symbolic link, which the list of inputs does not take/);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan(numbered((p) => { p.probe.dir = "linked"; }))));
  const env = { ...process.env };
  delete env.DRYRUN;
  const r = spawnSync(process.execPath, [join(here, "plan.mjs"), join(dir, "plan.json"), "gated", "plain", join(dir, "work")], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("the probe's directory is itself a symbolic link") && r.stderr.trim().split("\n").length === 1, r.stderr);
  assert.equal(existsSync(join(dir, "work")), false);
});

test("each threshold the plan declares is stated on its own, and the spread only as the plan declares", () => {
  const quiet = (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : -0.03 + i / 1000);
  // The margin stayed as one build read it; this run reads the reduction alone.
  const win = report(results({ change: quiet, edit: (p) => { p.workloads[0].reduction = 0.02; p.workloads[0].reads = ["reduction"]; } }));
  assert.deepEqual([win.json.gated.margin, win.json.gated.reading, win.json.gated.win], ["not read", "not read", `reduction established${U}`]);
  assert.ok(win.md.includes("- The margin, `plain`: not read by this run: it stays as one build read it, whatever this run reads."));
  assert.ok(win.md.includes("| the margin is not read |"));
  // The reduction stayed as one build read it; this run reads the margin alone.
  const margin = report(results({ change: quiet, edit: (p) => { p.workloads[0].reduction = 0.02; } }));
  assert.deepEqual([margin.json.gated.reading, margin.json.gated.win], [`pass${U}`, "not read"]);
  assert.ok(margin.md.includes("- A CPU-cost win, a smallest worthwhile reduction of 2.00%: not read by this run"));
  // An A/A records a spread only if its plan says so before the run, and only complete and resolved.
  const records = (p) => { p.workloads[0].recordsSpread = true; };
  const kept = report(results({ change: quiet, edit: records }));
  assert.equal(kept.json.gated.recordsSpread, true);
  assert.ok(kept.md.includes("the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -0.20% to +0.20%, which is recorded only by a pull request that changes the Choice."));
  assert.ok(report(results({ edit: records, change: (c, i) => (c === "aa-plain" && i === 1 ? 0.02 : 0) })).md.includes("It is not a complete, resolved A/A, so it records none."));
  assert.ok(report(results({ change: quiet })).md.includes("the plan declares that this A/A records no placement spread, so it records none whatever it read."));
  // The declaration a plan's pull request lists says the same before the run.
  const lines = declaration(resolve(plan((p) => { p.workloads[0].reduction = 0.02; p.workloads[0].K = 30; p.workloads[0].sizedFrom = "an A/A made up for a test"; }), "gated", "plain"));
  assert.equal(lines[1], "thresholds: the margin (+1%, no floor): read by this run; a smallest worthwhile reduction of 2.00%: not read by this run, so it stays as one build read it");
  assert.equal(lines[2], "the A/A records no placement spread");
});

test("the trend reads a gated part's report.json as it is written: the change's lower bound against its own threshold", () => {
  // At K = 5 the lower bound is the smallest placement median and the bound the largest.
  const pilot = results({ part: "pilot", edit: sized, change: even() });
  const from = (low) => (c, i) => (c === "aa-plain" ? (i - 3) / 1000 : low + (i - 1) / 1000);
  // What a run holds its report to is here what the test itself knows, not what the report
  // says: the plan file it wrote, the plan's two commits, and the K and the run id the pilot's
  // own report gives.
  const p = report(pilot).json, K = p.pilot.sizing.K, run = p.run;
  const of = (res, more) => ({ plan: createHash("sha256").update(readFileSync(join(res, "..", "..", "plan.json"))).digest("hex"), base: EXAMPLE.base, head: EXAMPLE.head, dry: false, K, from: run, ...more });
  // A pilot's report as a run takes it: a pilot part's of the plan, complete, and a dry one's too.
  assert.deepEqual([p.part, p.workload, p.plan, p.dry, p.exit, p.pilot.sizing.ok, K, run], ["pilot", "plain", of(pilot).plan, false, 0, true, 5, RUN]);
  const d = report(results({ part: "pilot", edit: sized, dry: {}, change: even() })).json;
  assert.deepEqual([d.part, d.dry, d.exit, d.pilot.sizing.ok], ["pilot", true, 0, false]);
  const read = (opts, more = {}) => { const res = results(opts); return reading(0.02, "plain", { report: report(res).json, expect: of(res, more) }); };
  const pass = read({ edit: sized, sizedFrom: pilot, change: from(0.003) });
  assert.deepEqual([pass.state, pass.text], ["pass", "+0.30% to +0.70%, median +0.50%, K = 5, A/A resolved"]);
  near(pass.lower, 0.003);
  near(pass.bound, 0.007);
  near(pass.median, 0.005);
  // The kit's margin reads the bound against +1%; the trend reads the lower bound against its
  // threshold. A bound over the threshold with a lower bound under it is not a rise shown.
  assert.deepEqual(read({ edit: sized, sizedFrom: pilot, change: from(0.017) }).text, "+1.70% to +2.10%, median +1.90%, K = 5, A/A resolved");
  assert.equal(read({ edit: sized, sizedFrom: pilot, change: from(0.017) }).state, "pass");
  const past = read({ edit: sized, sizedFrom: pilot, change: from(0.021) });
  assert.deepEqual([past.state, past.text], ["past", "+2.10% to +2.50%, median +2.30%, K = 5, A/A resolved"]);
  // Not read, each for its own reason: an A/A that did not resolve, a comparison without all
  // its placements, a K nothing checked, a dry run, results the kit refuses, and a report of
  // another plan, commit or K than the run's, or a pilot's.
  const not = (opts, text, more) => { const r = read(opts, more); assert.equal(r.state, "not read", text); assert.ok(r.text.startsWith(text), `${r.text} does not start with ${text}`); };
  const incomplete = "the gated part is not complete: a comparison without all its placements has no bound";
  not({ edit: sized, sizedFrom: pilot, change: (c, i) => (c === "aa-plain" ? (i === 2 ? 0.015 : 0) : 0.05) }, "the A/A did not resolve (bounds +1.50% and ");
  not({ edit: sized, sizedFrom: pilot, change: from(0.05), touch: (res, put) => { const f = join("change-plain", "p003", "placement.txt"); put(f, readFileSync(join(res, f), "utf8").replace(/ended .*\n$/, "")); } }, incomplete);
  not({ edit: sized, sizedFrom: pilot, change: from(0.05), touch: (res) => rmSync(join(res, "aa-plain", "p001"), { recursive: true }) }, incomplete);
  not({ change: from(0.05) }, "K was not checked by the kit");
  not({ dry: {}, change: from(0.05) }, "the report is a dry run's, and this run is not one");
  not({ dry: {}, change: from(0.05) }, "DRY RUN, read for nothing (+5.00% to +5.", { dry: true });
  not({ edit: sized, sizedFrom: pilot, change: from(0.05) }, "the report is not a dry run's, and this run is one", { dry: true });
  not({ edit: sized, sizedFrom: pilot, touch: (res) => rmSync(join(res, "run-id")) }, "the kit refused the results: no run-id in the results");
  not({ edit: sized, sizedFrom: pilot, change: from(0.05) }, "the report is of another plan than this run's", { plan: "0".repeat(64) });
  not({ edit: sized, sizedFrom: pilot, change: from(0.05) }, "the report is of another base than this run's", { base: "0".repeat(40) });
  not({ edit: sized, sizedFrom: pilot, change: from(0.05) }, "the report is of another head than this run's", { head: "0".repeat(40) });
  not({ edit: sized, sizedFrom: pilot, change: from(0.05) }, "K = 5 is not the K this run's pilot sized", { K: 6 });
  not({ edit: sized, sizedFrom: pilot, change: from(0.05) }, "K = 5 is not the K this run's pilot sized", { from: "another run's pilot" });
  not({ part: "pilot", edit: sized, change: even() }, "the report is not a gated part's of this workload");
});
