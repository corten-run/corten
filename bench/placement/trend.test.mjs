// The trend: its plan, the plan a run reads from it, a workload's reading, the page's row and
// what a run past its threshold drafts, and the command's steps in order with the kit's shell
// scripts stood in for (they need a bench host; plan.mjs is the kit's own here). That a gated
// part's report.json is what reading() takes is held in report.test.mjs, on results made there.
// The answers check is run on real processes at the end, on Linux alone.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as path, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256 } from "./answers.mjs";
import { problems as planProblems } from "./plan.mjs";
import { ANSWERS, bodies, history, insert, issue, latest, merged, PAGE, PLAN, problems, reading, resolved, row, rows, run, seed, stray, TABLE, verdict } from "./trend.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = path(here, "..", "..");
const TREND = JSON.parse(readFileSync(PLAN, "utf8"));
const trend = (change = () => {}) => { const t = structuredClone(TREND); change(t); return t; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "placement-trend-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const has = (why, word) => assert.ok(why.some((w) => w.includes(word)), `no "${word}" in: ${why.join(" | ") || "nothing"}`);
const BASE = "a833b4e3e55033c5fa179f50cb9291d190aeedfb", HEAD = "153d10e9cdac318b761ab5bed2c204889606701a", EARLIER = "c6e9be955bedd2766795eab240e061c1b14ee5d0";
const SHA = "c".repeat(64);
// The repository's page as far as its table's heading, which is what these tests add rows to:
// a run's row committed to the page must fail none of them.
const BLANK = (() => { const lines = readFileSync(PAGE, "utf8").split(/\r?\n/), at = lines.indexOf(TABLE[0]); return `${lines.slice(0, at + 2).join("\n")}\n`; })();
// A commit as a row names it, and a row.
const L = (c) => `[\`${c.slice(0, 9)}\`](https://github.com/corten-run/corten/commit/${c})`;
const LINE = (workloads, text, { date = "2026-12-02", head = HEAD } = {}) => `| ${date} | v0.2.0 ${L(BASE)} | ${L(head)} | ${workloads} | ${text} |`;
const PASSES = "pass: no rise of +2.00% shown";

/** A gated part's report.json as far as the trend reads it: what it says it is of, and the change's lower bound, bound and median with its A/A. */
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const report = (w, lower, bound, { resolution = "resolved", aa = [0.004, 0.002], K = 69, sized = { K, from: RUN }, dry = false, exit = 0, complete = exit === 0, part = "gated", plan = SHA, base = BASE, head = HEAD } = {}) => ({
  exit, part, workload: w, plan, base, head, dry, K, sized, complete: { [`aa-${w}`]: complete, [`change-${w}`]: complete },
  gated: { resolution, aaBound: aa[0], aaBoundSwapped: aa[1] },
  [`change-${w}`]: { measures: { "cycles, user and kernel": { recorded: { lower, bound, median: lower == null ? 0.004 : (lower + bound) / 2 } } } },
});
/** A pilot part's report.json as far as the trend reads it: what it is of, its run id and the K it sizes. */
const piloted = (w, K = 69, more = {}) => ({ exit: 0, part: "pilot", workload: w, plan: SHA, dry: false, run: RUN, pilot: { sizing: { ok: true, K } }, ...more });
const OF = (more = {}) => ({ plan: SHA, base: BASE, head: HEAD, dry: false, K: 69, from: RUN, ...more });

test("the trend's plan is usable, and each field that is not is named", () => {
  assert.deepEqual(problems(TREND), []);
  const bad = (change, word) => has(problems(trend(change)), word);
  for (const t of [{ plan: 1 }, null, [], "plan", 1]) assert.deepEqual(problems(t), ['"trend": 1 is missing: not a trend plan this kit reads']);
  bad((t) => { t.base = BASE; }, 'base: "release", the highest tag vX.Y.Z');
  bad((t) => { t.head = HEAD; }, "head: a remote's branch (origin/main)");
  bad((t) => { t.head = "main"; }, "head: a remote's branch (origin/main)");
  bad((t) => { t.head = "origin/main branch"; }, "head: a remote's branch (origin/main)");
  bad((t) => { t.seed = 2026112401; }, 'seed: "date", the rule that gives each run its seeds');
  bad((t) => { t.threshold = 2; }, "threshold: the rise the trend reports, as a fraction");
  bad((t) => { delete t.threshold; }, "threshold");
  bad((t) => { t.margin = 0.01; }, '"margin" is not a field of a trend\'s plan');
  for (const p of ["plan.json", null, []]) bad((t) => { t.plan = p; }, "plan: a plan as plan.mjs reads one");
  // What only a run can give is not the plan's to state.
  bad((t) => { t.plan.base = BASE; }, 'plan.base: the run gives it, by the rule this file\'s "base" names');
  bad((t) => { t.plan.head = HEAD; }, "plan.head: the run gives it");
  bad((t) => { t.plan.workloads[1].seed = 7; }, "workload unstaged: seed: the run gives it, from its date");
  bad((t) => { t.plan.workloads[0].expect = "expect.txt"; }, "workload plain: expect: the run records how the release and main answer differently");
  bad((t) => { t.plan.workloads[0].K = 69; t.plan.workloads[0].sizedFrom = "last week's run"; }, 'workload plain: K: "pilot", since every run sizes K from its own pilot');
  bad((t) => { t.plan.probe.dir = "/srv/probe"; }, "plan.probe.dir: a path from this file to the probe's crate");
  bad((t) => { delete t.plan.probe; }, "plan.probe.dir");
  // A run copies the probe alone, so no workload names a script beside the plan.
  bad((t) => { t.plan.workloads[0].request.script = "post.lua"; }, "workload plain: request.script: a trend's plan names no script");
  // Workloads that are not there, or not workloads, are named and nothing is thrown; a seed
  // gives a workload's place two digits.
  for (const w of [undefined, null, [], [null], ["plain"], {}]) bad((t) => { t.plan.workloads = w; }, "plan.workloads: at least one workload, each with its fields");
  bad((t) => { t.plan.workloads = Array.from({ length: 100 }, (_, i) => ({ ...t.plan.workloads[0], name: `w${"a".repeat(i + 1)}` })); }, "plan.workloads: at most 99");
  // The rest is plan.mjs's to judge, on the plan a run would read.
  bad((t) => { t.plan.R = 0; }, "plan: R: recorded pairs");
  bad((t) => { t.plan.workloads[0].request.method = "POST"; }, 'plan: workload plain: request: "method" is not a field of a plan');
  bad((t) => { delete t.plan.pilot; }, 'plan: workload plain: K is "pilot" and the plan has no pilot');
  // The probe the plan names is in the repository, and each workload says why it is read and
  // what it does not read.
  assert.ok(existsSync(join(dirname(PLAN), TREND.plan.probe.dir, "src", "main.rs")));
  for (const w of TREND.plan.workloads) assert.ok(w.declared.includes("In the trend because") && w.declared.includes("Not read by it:"), w.name);
});

test("the last release is the highest tag vX.Y.Z, whatever order the tags come in", () => {
  assert.equal(latest(["evidence/thread-cache-1979", "v0.2.0", "v0.10.1", "v0.9.12", "v0.10.0", "v1.0.0-rc.1", "v2", ""]), "v0.10.1");
  assert.equal(latest(["v1.0.0", "v0.99.99"]), "v1.0.0");
  assert.equal(latest(["evidence/placement-kit", "release"]), null);
});

test("a run's plan: the release, main and seeds from the date, a plan plan.mjs takes", () => {
  assert.deepEqual([seed("2026-12-02", 0), seed("2026-12-02", 1), seed("2026-12-02", 98), seed("2027-01-01", 0)], [2026120201, 2026120202, 2026120299, 2027010101]);
  const p = resolved(TREND, { base: BASE, head: HEAD, date: "2026-12-02" });
  assert.deepEqual(planProblems(p), []);
  assert.deepEqual([p.plan, p.name, p.base, p.head, p.probe.dir, p.pilot.K], [1, "trend-2026-12-02", BASE, HEAD, "probe", 100]);
  assert.deepEqual(p.workloads.map((w) => [w.name, w.seed, w.K, w.expect]), [["plain", 2026120201, "pilot", undefined], ["unstaged", 2026120202, "pilot", undefined]]);
  // Everything else is the trend's plan as written, and the plan in the file is left as it was.
  assert.deepEqual({ ...p.probe, dir: TREND.plan.probe.dir }, TREND.plan.probe);
  assert.deepEqual([p.host, p.load, p.R, p.placementSeconds], [TREND.plan.host, TREND.plan.load, TREND.plan.R, TREND.plan.placementSeconds]);
  assert.equal(TREND.plan.workloads[0].seed, undefined);
  // The date is all that tells one run's seeds and name from another's, which is why the
  // command refuses a second run of a date (below): the next day's are its own.
  const next = resolved(TREND, { base: BASE, head: HEAD, date: "2026-12-03" });
  assert.deepEqual([next.name, next.workloads.map((w) => w.seed)], ["trend-2026-12-03", [2026120301, 2026120302]]);
  // A workload whose two sides answer differently names the file that holds the difference.
  const q = resolved(TREND, { base: BASE, head: HEAD, date: "2026-12-02", expect: { plain: "expect-plain.txt" } });
  assert.deepEqual([planProblems(q), q.workloads.map((w) => w.expect)], [[], ["expect-plain.txt", undefined]]);
});

test("a workload's reading: past the threshold on the lower bound, a pass under it, and not read for anything else", () => {
  const read = (...a) => { const r = reading(0.02, "plain", { report: report("plain", ...a), expect: OF() }); return [r.state, r.text]; };
  assert.deepEqual(read(0.004, 0.011), ["pass", "+0.40% to +1.10%, median +0.75%, K = 69, A/A resolved"]);
  // The bound over the threshold is not a rise shown: the lower bound decides.
  assert.deepEqual(read(0.0199, 0.031), ["pass", "+1.99% to +3.10%, median +2.54%, K = 69, A/A resolved"]);
  assert.deepEqual(read(0.02, 0.031), ["past", "+2.00% to +3.10%, median +2.55%, K = 69, A/A resolved"]);
  assert.deepEqual(read(-0.031, -0.024), ["pass", "-3.10% to -2.40%, median -2.75%, K = 69, A/A resolved"]);
  const past = reading(0.02, "plain", { report: report("plain", 0.021, 0.03), expect: OF() });
  assert.deepEqual([past.lower, past.bound, past.median], [0.021, 0.03, (0.021 + 0.03) / 2]);
  // An A/A that did not resolve is not read, whatever the change's bounds are.
  assert.deepEqual(read(-0.05, -0.04, { resolution: "not resolved", aa: [0.0103, 0.0079] }), ["not read", "the A/A did not resolve (bounds +1.03% and +0.79%, against +1%)"]);
  assert.deepEqual(read(0.05, 0.06, { resolution: "not resolved", aa: [0.0103, 0.0079] })[0], "not read");
  assert.deepEqual(read(0.001, 0.002, { resolution: "no bound" }), ["not read", "the A/A has no bound"]);
  assert.deepEqual(read(0.001, 0.002, { aa: [null, 0.002] }), ["not read", "the A/A has no bound"]);
  // A comparison without all its placements has no bound; a K nothing checked is no reading.
  assert.deepEqual(read(null, null, { exit: 1 }), ["not read", "the gated part is not complete: a comparison without all its placements has no bound"]);
  assert.deepEqual(read(0.001, 0.002, { sized: null }), ["not read", "K was not checked by the kit"]);
  // A step that failed, results the kit refuses, and a part that left nothing.
  assert.deepEqual(reading(0.02, "plain", { why: "the probe does not build at v0.2.0" }).text, "the probe does not build at v0.2.0");
  assert.deepEqual(reading(0.02, "plain", { report: { exit: 2, refused: ["no run-id in the results: not a complete record of a run"] } }).text, "the kit refused the results: no run-id in the results: not a complete record of a run");
  assert.deepEqual([reading(0.02, "plain").state, reading(0.02, "plain").text], ["not read", "the gated part left no report"]);
  for (const r of [[], "report", 7]) assert.equal(reading(0.02, "plain", { report: r, expect: OF() }).text, "the gated part left no report");
  assert.equal(reading(0.02, "plain", { report: { exit: 0, pilot: {} }, expect: OF() }).text, "the report is not a gated part's of this workload");
  // A dry run is read for nothing, and says so with its figures.
  const dry = reading(0.02, "plain", { report: report("plain", 0.03, 0.04, { dry: true, K: 6, sized: null }), expect: OF({ dry: true, K: undefined }) });
  assert.deepEqual([dry.state, dry.text, dry.dry, dry.complete], ["not read", "DRY RUN, read for nothing (+3.00% to +4.00%, median +3.50%, K = 6)", true, true]);
});

test("a report that is not a complete gated part of this run, with numbers for figures, is never a pass or a past", () => {
  const not = (r, text, expect = OF()) => assert.deepEqual([reading(0.02, "plain", { report: r, expect }).state, reading(0.02, "plain", { report: r, expect }).text], ["not read", text]);
  const good = () => report("plain", 0.03, 0.04);
  assert.equal(reading(0.02, "plain", { report: good(), expect: OF() }).state, "past");
  // The review's example: a failed part, a K nothing sized and a lower bound that is no number.
  const worst = report("plain", "bad", 0.04, { exit: 1, sized: {} });
  not(worst, "the gated part is not complete: a comparison without all its placements has no bound");
  // Each of its faults alone is enough.
  not({ ...good(), exit: 1 }, "the gated part is not complete: a comparison without all its placements has no bound");
  not({ ...good(), complete: { "aa-plain": true, "change-plain": false } }, "the gated part is not complete: a comparison without all its placements has no bound");
  not({ ...good(), complete: { "aa-plain": true } }, "the gated part is not complete: a comparison without all its placements has no bound");
  not({ ...good(), complete: undefined }, "the report is not a gated part's of this workload");
  not({ ...good(), sized: {} }, "K was not checked by the kit");
  not({ ...good(), K: "69", sized: { K: "69" } }, "K was not checked by the kit");
  // A K outside the kit's own limits is none it sized, whatever the report says of it.
  for (const K of [1, 4, 255]) not(report("plain", 0.03, 0.04, { K }), "K was not checked by the kit", OF({ K }));
  assert.equal(reading(0.02, "plain", { report: report("plain", 0.03, 0.04, { K: 5 }), expect: OF({ K: 5 }) }).state, "past");
  not(report("plain", "bad", 0.04), "main against the release has no bound");
  not(report("plain", 0.03, "0.04"), "main against the release has no bound");
  for (const lower of [null, undefined, true, [], "0.03"]) not(report("plain", lower, 0.04), "main against the release has no bound");
  // It says what it is of: this run's plan, commits, workload and part, and the K its pilot sized.
  not(good(), "the report is of another plan than this run's", OF({ plan: "d".repeat(64) }));
  not({ ...good(), base: HEAD }, "the report is of another base than this run's");
  not({ ...good(), head: null }, "the report is of another head than this run's");
  not(report("unstaged", 0.03, 0.04), "the report is not a gated part's of this workload");
  not({ ...good(), part: "pilot" }, "the report is not a gated part's of this workload");
  not(good(), "K = 69 is not the K this run's pilot sized", OF({ K: 91 }));
  not(good(), "K = 69 is not the K this run's pilot sized", OF({ K: null }));
  not(good(), "K = 69 is not the K this run's pilot sized", OF({ from: "another-run" }));
  not(report("plain", 0.03, 0.04, { sized: { K: 69 } }), "K = 69 is not the K this run's pilot sized");
  not(good(), "nothing says which run the report is to be of", null);
  // A dry run's report in a run that is not one, and the other way about.
  not(report("plain", 0.03, 0.04, { dry: true }), "the report is a dry run's, and this run is not one");
  not(good(), "the report is not a dry run's, and this run is one", OF({ dry: true }));
  // A dry run that did not complete says so, and is past nothing.
  const dry = reading(0.02, "plain", { report: report("plain", 0.03, 0.04, { dry: true, exit: 1 }), expect: OF({ dry: true }) });
  assert.deepEqual([dry.state, dry.dry, dry.complete], ["not read", true, false]);
});

test("a run's reading is a pass only when every workload passes, and a pass says no rise was shown", () => {
  const r = (workload, state) => ({ workload, state, text: "" });
  assert.equal(verdict(0.02, [r("plain", "pass"), r("unstaged", "pass")]), PASSES);
  assert.equal(verdict(0.02, [r("plain", "past"), r("unstaged", "pass")]), "past +2.00%: `plain`");
  assert.equal(verdict(0.02, [r("plain", "pass"), r("unstaged", "not read")]), "not read: `unstaged`");
  assert.equal(verdict(0.015, [r("plain", "past"), r("unstaged", "not read")]), "past +1.50%: `plain`; not read: `unstaged`");
  assert.equal(verdict(0.02, [r("plain", "not read"), r("unstaged", "not read")]), "not read: `plain`, `unstaged`");
});

const at = (readings, more = {}) => ({ date: "2026-12-02", tag: "v0.2.0", base: BASE, head: HEAD, threshold: 0.02, readings, ...more });
const READ = [reading(0.02, "plain", { report: report("plain", 0.004, 0.011), expect: OF() }), reading(0.02, "unstaged", { report: report("unstaged", -0.002, 0.003, { K: 91 }), expect: OF({ K: 91 }) })];
const PLAIN = "`plain` +0.40% to +1.10%, median +0.75%, K = 69, A/A resolved", UNSTAGED = "`unstaged` -0.20% to +0.30%, median +0.05%, K = 91, A/A resolved";

test("the row: the run's date, the release and its commit, main's commit, each workload and the reading", () => {
  assert.equal(row(at(READ, { differ: ["plain"] })), LINE(`${PLAIN}, answers differ as recorded; ${UNSTAGED}`, PASSES));
  // Both commits are there whole, behind their first nine digits.
  assert.ok(row(at(READ)).startsWith(`| 2026-12-02 | v0.2.0 [\`a833b4e3e\`](https://github.com/corten-run/corten/commit/${BASE}) | [\`153d10e9c\`](https://github.com/corten-run/corten/commit/${HEAD}) | `));
  const mixed = [reading(0.02, "plain", { report: report("plain", 0.021, 0.03), expect: OF() }), reading(0.02, "unstaged", { report: report("unstaged", 0, 0, { resolution: "not resolved", aa: [0.012, 0.001] }), expect: OF() })];
  assert.equal(row(at(mixed)), LINE("`plain` +2.10% to +3.00%, median +2.55%, K = 69, A/A resolved; `unstaged` not read: the A/A did not resolve (bounds +1.20% and +0.10%, against +1%)", "past +2.00%: `plain`; not read: `unstaged`"));
  // One reason for every workload is said once.
  const none = ["plain", "unstaged"].map((w) => reading(0.02, w, { why: "the probe does not build at v0.2.0" }));
  assert.equal(row(at(none)), LINE("not read: the probe does not build at v0.2.0", "not read: `plain`, `unstaged`"));
  // What a step said is one cell, whatever it holds.
  assert.ok(row(at([reading(0.02, "plain", { why: "the pilot part ended verify-failed: a | b\n  c" })])).includes("| `plain` not read: the pilot part ended verify-failed: a \\| b c | not read: `plain` |"));
});

test("the page: one way to read it and to add a row, the newest first, and nothing else taken for a page", () => {
  // The page in the repository has its table, nothing under its rows, and only rows the
  // command wrote, however many runs have been made.
  const kept = readFileSync(PAGE, "utf8").replaceAll("\r\n", "\n"), page = BLANK;
  assert.ok(kept.startsWith(page));
  assert.equal(rows(kept).length, kept.slice(page.length).split("\n").filter(Boolean).length);
  assert.deepEqual(rows(page), []);
  const first = row(at(READ)), second = row(at(READ, { date: "2026-12-09", head: EARLIER }));
  const two = insert(insert(page, first), second);
  assert.equal(two, `${page}${second}\n${first}\n`);
  assert.deepEqual(rows(two).map((r) => [r.date, r.tag, r.base, r.head, r.reading]), [["2026-12-09", "v0.2.0", BASE, EARLIER, PASSES], ["2026-12-02", "v0.2.0", BASE, HEAD, PASSES]]);
  // Every kind of row the command writes is read back, a cell with a bar in it too.
  const odd = row(at([reading(0.02, "plain", { why: "ended a | b" })]));
  assert.deepEqual(rows(insert(page, odd)).map((r) => [r.workloads, r.reading]), [["`plain` not read: ended a \\| b", "not read: `plain`"]]);
  // The head above the table is kept.
  assert.ok(two.startsWith(page.slice(0, page.indexOf(TABLE[0]))));
  // A page checked out with CRLF line ends keeps them.
  const crlf = page.replaceAll("\n", "\r\n");
  assert.equal(insert(crlf, first), `${crlf}${first}\r\n`);
  assert.deepEqual(rows(insert(insert(crlf, first), second)).map((r) => r.date), ["2026-12-09", "2026-12-02"]);
  // What is not such a page is refused by reading and by adding alike, never appended to: no
  // table, the heading twice, a row by another hand, lines that end in two ways, rows after a
  // blank line, text under the rows, a commit whose two forms disagree.
  const refused = (text, word) => { assert.throws(() => rows(text), word); assert.throws(() => insert(text, second), word); };
  refused("# The trend\n\nNo table here.\n", /the page has no table of runs/);
  refused(`${page}\n${TABLE.join("\n")}\n`, /the page has (no table of runs|text under its table's rows)/);
  refused(`${page}| 2026-12-02 | by hand |\n`, /the page has a row trend\.mjs did not write: \| 2026-12-02 \| by hand \|/);
  refused(`${crlf}${first}\n`, /the page has lines that end in two ways, CRLF and LF/);
  refused(`${page.replace("\n", "\r\n")}`, /the page has lines that end in two ways/);
  refused(`${page}\n${first}\n`, /the page has text under its table's rows, which end the page: \| 2026-12-02 /);
  refused(`${page}${first}\n\nA note.\n`, /the page has text under its table's rows, which end the page: A note\./);
  refused(`${page}${first.replace("`153d10e9c`", "`153d10e9d`")}\n`, /the page has a row trend\.mjs did not write/);
  refused(`${page}${first.replace(L(HEAD), "`153d10e9c`")}\n`, /the page has a row trend\.mjs did not write/);
  // Rows are the newest first and one a date, on the page and when one is added.
  refused(`${page}${first}\n${second}\n`, /the page's rows are not the newest first, one a date: 2026-12-09 is under 2026-12-02/);
  refused(`${page}${first}\n${first}\n`, /the page's rows are not the newest first, one a date: 2026-12-02 is under 2026-12-02/);
  assert.throws(() => insert(insert(page, first), row(at(READ, { head: EARLIER }))), /the page already has a row of 2026-12-02/);
  assert.throws(() => insert(two, first), /the page already has a row of 2026-12-09, and a row goes above rows of earlier dates alone/);
  // Only a row is added, by the test a page's own rows are held to.
  assert.throws(() => insert(page, "| 2026-12-02 | by hand |"), /not a row trend\.mjs writes/);
  assert.throws(() => insert(page, first.replace("`153d10e9c`", "`153d10e9d`")), /not a row trend\.mjs writes/);
});

const LOG = [
  [HEAD, "Merge pull request #2109 from corten-run/docs/catalog-probe-decides", "Let a probe read across placements decide a change's cycles\n\nIts description's first paragraph.\n"],
  ["9e209a32f1bf2b6201b1c15eca6ba894aa43e008", "Parse an allowed origin once (#2100)", "* a commit\n* another\n"],
  ["84658be3835db27572ddfd16bc03c1fd7c398e16", "Fix a typo in the guide", ""],
  ["f37f10652a07e2a6353d53ad6fe76825dbc48cd9", "Merge pull request #2106 from someone/a-fork", ""],
];
const LOGTEXT = LOG.map((r) => r.join("\x1f")).join("\x1e\n") + "\x1e\n";
const PRS = merged(history(LOGTEXT));

test("the pull requests a range of main merged: git log's records read whole or not at all, a merge commit's, a squash's, and a commit that names none", () => {
  assert.deepEqual(history(LOGTEXT), LOG.map(([hash, subject, body]) => ({ hash, subject, body })));
  assert.deepEqual(PRS, [
    { number: 2109, title: "Let a probe read across placements decide a change's cycles" },
    { number: 2100, title: "Parse an allowed origin once" },
    { commit: "84658be3835db27572ddfd16bc03c1fd7c398e16", title: "Fix a typo in the guide" },
    { number: 2106, title: "Merge pull request #2106 from someone/a-fork" },
  ]);
  // No commit in the interval is a list of none; output that is not records is no list.
  assert.deepEqual([history(""), history("\n"), merged([])], [[], [], []]);
  assert.equal(history("fatal: bad revision\n"), null);
  assert.equal(history(`${HEAD}\x1fa subject\x1e\n`), null);
  assert.equal(history(`${HEAD.slice(0, 9)}\x1fa subject\x1f\x1e\n`), null);
  assert.equal(history(`${LOGTEXT}${HEAD}\x1fcut off`), null);
  assert.equal(history(`${HEAD}\x1fa subject\x1fa body with \x1f in it\x1e\n`), null);
});

test("past the threshold: a draft of an issue, with the row, the pull requests and what to add to them", () => {
  const readings = [reading(0.02, "plain", { report: report("plain", 0.021, 0.03), expect: OF() }), READ[1]], line = row(at(readings, { differ: ["plain"] }));
  const since = { date: "2026-11-25", head: EARLIER, reading: "past +2.00%: `plain`" };
  const made = issue({ ...at(readings), line, since, prs: PRS, expected: { plain: `5c5\n< corten-shell: 618f\n---\n> corten-shell: c21c\nbodies same: 6124 bytes, sha256 ${"a".repeat(64)}\n` } });
  assert.equal(made.title, "Trend: main costs a request at least +2.00% more cycles than v0.2.0 on plain (run of 2026-12-02)");
  for (const word of [
    "The trend run of 2026-12-02 read `main` at `153d10e9c` against v0.2.0 (`a833b4e3e`) across placements and is past its threshold on `plain`: the lower bound of the change in user plus kernel cycles a request is at or above +2.00%.",
    `${TABLE.join("\n")}\n${line}\n`,
    "- `plain`: lower bound +2.10%, median +2.55%, bound +3.00%.",
    "It blocks no merge ([CONTRIBUTING.md](https://github.com/corten-run/corten/blob/main/CONTRIBUTING.md#pull-requests), item 2.1, Trend).",
    "attributes a cost to none of them",
    // Whether it is an issue of its own is the reader's, who is told what the row before read.
    "This is a draft the run's command wrote; it opened nothing. Whether it becomes an issue of its own or is added to one already open for v0.2.0 is for whoever reads it.",
    "The row before this one (2026-11-25) reads: past +2.00%: `plain`.",
    `\`plain\`: \`main\` and v0.2.0 answer its request differently, so part of the change may be what the answer now holds. The run recorded this difference before any turn and nobody reviewed it:\n\n\`\`\`\n5c5\n< corten-shell: 618f\n---\n> corten-shell: c21c\nbodies same: 6124 bytes, sha256 ${"a".repeat(64)}\n\`\`\`\n`,
    "Merged from the row before this one (2026-11-25, `c6e9be955`) to this run, 4 on `main`'s first-parent line. Add to each line what its description says after `Request path:` and, for a counted change, the cost it stated:",
    "- [#2109 Let a probe read across placements decide a change's cycles](https://github.com/corten-run/corten/pull/2109)\n- [#2100 Parse an allowed origin once](https://github.com/corten-run/corten/pull/2100)\n- `84658be38` Fix a typo in the guide (no pull request named)\n",
  ]) assert.ok(made.body.includes(word), word);
  assert.ok(!made.body.includes("open no second one") && !made.body.includes("`unstaged`:"));
  // The first run has no row before it, and an interval with no commit says which it is.
  const first = issue({ ...at(readings), line, prs: [] });
  assert.ok(first.body.includes("The page has no row before this one.") && first.body.includes("Merged from v0.2.0 to this run, 0 on `main`'s first-parent line.") && first.body.includes("\n- none: `main` has no commit in that interval\n"));
  // A row before it that the list cannot start from is said, and the list is from the release.
  const note = "The row before this one (2026-11-25) names `c6e9be955`, a commit this run's head does not descend from (`main` was moved back or rewritten since), so the list below is from v0.2.0: the commits `main` has that the release does not.";
  const lacking = issue({ ...at(readings), line, note, prs: PRS });
  assert.ok(lacking.body.includes(`${note}\n`) && lacking.body.includes("Merged from v0.2.0 to this run, 4 on") && !lacking.body.includes("The page has no row before this one."));
  // History that could not be read is said to be that, never "none".
  const unread = issue({ ...at(readings), line, since, prs: null, unread: "git log ended with status 128" });
  assert.ok(unread.body.includes(`The pull requests \`main\` merged from the row before this one (2026-11-25, \`c6e9be955\`) to this run could not be read from the run's checkout (git log ended with status 128). That is not "none": read them in a full clone with \`git log --first-parent ${EARLIER}..${HEAD}\`.`));
  assert.ok(!unread.body.includes("- none") && !unread.body.includes("Merged from"));
});

const DIGEST = { base: "1111111111111111", head: "2222222222222222", third: "3333333333333333" };
const BODY = (a, b) => `body 6124 bytes as received, sha256 ${a} A and ${b} B\n`;

test("the bodies a part's placements answered with are the two the check kept, each side's by its digest", () => {
  const res = join(tmp, "bodies"), put = (c, p, text) => { mkdirSync(join(res, c, p, "answers"), { recursive: true }); writeFileSync(join(res, c, p, "answers", "bodies.txt"), text); };
  const kept = bodies((put("check", "p000", BODY(DIGEST.base, DIGEST.head)), join(res, "check", "p000", "answers", "bodies.txt")));
  assert.deepEqual(kept, { line: BODY(DIGEST.base, DIGEST.head).trimEnd(), bytes: 6124, a: DIGEST.base, b: DIGEST.head });
  assert.deepEqual([bodies(join(res, "none.txt")), bodies((writeFileSync(join(res, "odd.txt"), "bodies differ: 6124 and 6124 bytes\n"), join(res, "odd.txt")))], [null, null]);
  // The placements a part was resolved to have, as its resolved.json lists them, in the order they run.
  const of = (...cs) => [2, 1].flatMap((i) => cs.map((comparison) => ({ comparison, i }))), pilot = of("pilot-plain"), gated = of("aa-plain", "change-plain");
  for (const p of ["p001", "p002"]) { put("pilot-plain", p, BODY(DIGEST.base, DIGEST.base)); put("aa-plain", p, BODY(DIGEST.base, DIGEST.base)); put("change-plain", p, BODY(DIGEST.base, DIGEST.head)); }
  assert.deepEqual([stray(res, pilot, "plain", kept), stray(res, gated, "plain", kept)], [null, null]);
  // A later start that serves a third body of the same length: turns.sh's expected difference
  // fails it on a placement of the change, and so does this, on any placement.
  put("change-plain", "p002", BODY(DIGEST.base, DIGEST.third));
  assert.equal(stray(res, gated, "plain", kept), `change-plain p002 answered with other bodies than the run recorded before any turn (${BODY(DIGEST.base, DIGEST.third).trimEnd()}; recorded: sha256 ${DIGEST.base} and ${DIGEST.head})`);
  // The release's own body on a later start, in an A/A; another length; a file that is not there.
  put("change-plain", "p002", BODY(DIGEST.base, DIGEST.head));
  put("aa-plain", "p001", BODY(DIGEST.third, DIGEST.third));
  assert.ok(stray(res, gated, "plain", kept).startsWith("aa-plain p001 answered with other bodies"));
  put("pilot-plain", "p002", BODY(DIGEST.base, DIGEST.base).replace("6124", "6125"));
  assert.ok(stray(res, pilot, "plain", kept).startsWith("pilot-plain p002 answered with other bodies"));
  rmSync(join(res, "pilot-plain", "p002", "answers", "bodies.txt"));
  assert.ok(stray(res, pilot, "plain", kept).includes("no bodies.txt as the kit writes it"));
  // Every placement the part was to have, not every one that is there: a third that left nothing.
  put("pilot-plain", "p002", BODY(DIGEST.base, DIGEST.base));
  assert.equal(stray(res, pilot, "plain", kept), null);
  assert.ok(stray(res, [...pilot, { comparison: "pilot-plain", i: 3 }], "plain", kept).startsWith("pilot-plain p003 answered with other bodies than the run recorded before any turn (no bodies.txt as the kit writes it;"));
});

// git as the command asks it: the checkout's top, whether it is shallow or partial (promisor:
// its remotes' promisor values as git gives booleans; extension: extensions.partialClone; each
// the text, or the status of a git that gave none), its tags, a ref's commit, whether the head
// descends from a commit (under: the commits it does descend from; apart: those the checkout
// has that it does not) and a range's log.
const TAGS = "evidence/placement-kit\nv0.1.9\nv0.2.0\n";
function git(args, { tags = TAGS, shallow = { status: 0, text: "false\n" }, promisor = 1, extension = 1, commits = {}, under = [EARLIER], apart = [], log = { status: 0, text: LOGTEXT }, calls = [] } = {}) {
  const a = args.slice(2), ok = (stdout) => ({ status: 0, stdout, stderr: "" }), failed = (status = 1) => ({ status, stdout: "", stderr: "fatal: it failed\n" });
  if (a[1] === "--show-toplevel") return ok(`${root}\n`);
  if (a[1] === "--is-shallow-repository") return shallow.status === 0 ? ok(shallow.text) : failed(shallow.status);
  if (a[0] === "config") { const v = { "--type=bool --get-regexp ^remote\\..*\\.promisor$": promisor, "--get extensions.partialclone": extension }[a.slice(1).join(" ")] ?? 2; return typeof v === "string" ? ok(v) : failed(v); }
  if (a[0] === "merge-base") { assert.deepEqual([a[1], a[3]], ["--is-ancestor", HEAD]); return under.includes(a[2]) ? ok("") : failed(apart.includes(a[2]) ? 1 : 128); }
  if (a[0] === "tag") return tags === null ? failed(128) : ok(tags);
  if (a[0] === "log") { calls.push(`git log ${a.at(-1)}`); return log.status === 0 ? ok(log.text) : failed(log.status); }
  const commit = { "refs/tags/v0.2.0": BASE, "refs/remotes/origin/main": HEAD, ...commits }[a.at(-1).replace("^{commit}", "")];
  return commit ? ok(`${commit}\n`) : failed();
}

// The command, with the kit's shell scripts stood in for: build.sh and run.sh leave what a
// step of theirs would, and the two sides' answers differ for the workloads named. With `real`,
// plan.mjs is the kit's own but for a gated part's, which would size K from a pilot no script
// here ran; without, it is stood in for too, since each call of it starts a process. Either way
// a part is resolved to K placements a comparison (a pilot's 100, a gated part's the K of its
// report) and run.sh leaves every one of them.
//   ended    a part's run.sh ended otherwise than complete, with what it said and the report it left
//   written  a part's report.json, in place of the one a complete part leaves: the file's text, or a report
//   placed   a part's second placement answered with these bodies
//   short    parts whose results hold their first placement alone
//   late     workloads whose answers check was stopped at its time limit
//   differed workloads whose answers differ and whose check ended otherwise than turns.sh ends
//            one after a confirmed stop (status 4 and DIFFERS): its status and what it said after the diff
//   piped    a workload's answers check leaves a FIFO at answers/<at> ({ at, status, text }: the
//            check's status and what it said), or a part's second placement one at its bodies.txt,
//            each with a process that opens it to write only after a while (fifo() below)
//   swapped  a workload's answers check, which ends as it would, leaves what it sealed and then
//            something else: { outcome } sealed in place of the outcome it found, { at, text } a
//            regular file of that text put at answers/<at> after the handoff was sealed
const DIFF = `5c5\n< corten-shell: 618f77240fa962cf\n---\n> corten-shell: c21cf50c33ce3fc2\nbodies differ: 6124 and 6124 bytes, sha256 ${DIGEST.base.repeat(4)} and ${DIGEST.head.repeat(4)}\n`;
const DIFFERS = (w) => `turns: ${w}: A and B answer differently; both servers ended and nothing accepted on either port when checked\n`;
let made = 0;
function command({ reports = {}, differ = ["plain"], real = false, silent = {}, late = [], differed = {}, build = {}, sizes = {}, ended = {}, written = {}, placed = {}, short = [], undiffed = {}, piped = {}, swapped = {}, forms = {}, diffs = {}, before = null, dry = false, date = "2026-12-02", ...asked } = {}) {
  const dir = join(tmp, `run-${++made}`), page = join(tmp, `page-${made}.md`), calls = [], said = [];
  writeFileSync(page, before ? insert(BLANK, before) : BLANK);
  const env = { ...process.env, ...(dry ? { DRYRUN: "1" } : {}) };
  if (!dry) delete env.DRYRUN;
  const exec = (cmd, args, { env: e = env, log = null } = {}) => {
    const out = (status, text = "", stdout = "") => { if (log) appendFileSync(log, text); return { status, stdout, stderr: log ? "" : text }; };
    const kit = () => { const r = spawnSync(cmd, args, { env: e, encoding: "utf8" }); return out(r.status, r.stdout + r.stderr, r.stdout); };
    if (cmd === "git") return git(args, { ...asked, calls });
    const script = args[0] === "-c" ? "answers" : basename(args[0]);
    if (script === "plan.mjs" && args.length === 2) return real ? kit() : out(0, "", "plan trend-2026-12-02\n");
    const work = script === "answers" ? args[3] : script === "plan.mjs" ? args[4] : args[1], [x, y] = basename(work).split("-"), [part, w] = x === "check" ? [x, y] : [y, x], key = `${part} ${w}`;
    calls.push(`${key} ${script.replace(/\.(mjs|sh)$/, "")}${script === "plan.mjs" && e.DRYRUN === "1" ? " dry" : ""}`);
    // As plan.mjs resolves a part: the placements it is to have, K a comparison.
    const resolve = (K) => {
      mkdirSync(join(work, "plan"), { recursive: true });
      writeFileSync(join(work, "plan", "resolved.json"), JSON.stringify({ K, schedule: (part === "pilot" ? [`pilot-${w}`] : [`aa-${w}`, `change-${w}`]).flatMap((comparison) => Array.from({ length: K }, (_, n) => ({ comparison, i: n + 1 }))) }));
    };
    if (script === "plan.mjs" && args.includes("--sized-from")) {
      assert.equal(args.at(-1), join(dir, `${w}-pilot`, "results"));
      if (sizes[w]) return out(1, `sizing from pilot-${w} of run 0f8fad5b\nplan.mjs: ${args.at(-1)} ${sizes[w]}\n`);
      resolve(dry ? 6 : (reports[w]?.K ?? 69));
      return out(0, `gated ${w}: K = 69 placements (from the pilot, by the sizing rule)\n`);
    }
    if (script === "plan.mjs" && real) return kit();
    if (script === "plan.mjs") { resolve(dry || part === "check" ? 6 : 100); return out(0, `${part} ${w}: resolved\n`); }
    if (script === "build.sh") {
      const b = build[key] ?? { status: 0, text: "BUILD-DONE\n" };
      if (b.refused) { mkdirSync(join(work, "bin"), { recursive: true }); writeFileSync(join(work, "bin", "refused.txt"), `REFUSED: ${b.refused}\n`); }
      return out(b.status, b.text);
    }
    const mine = differ.includes(w) ? DIGEST.head : DIGEST.base;
    if (script === "answers") {
      // The check is bounded as a placement is, and timeout's status is the step's.
      assert.ok(args[1].includes(' exec timeout -k 30 "$PLACEMENT_SECONDS" taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" '));
      if (late.includes(w)) return out(124, "");
      if (silent[w]) return out(1, `turns: ${w}: ${silent[w]}\n`);
      // As turns.sh does: what it compared is under answers/ in the directory it is given, which
      // is read here from the command itself.
      const given = join(work, /turns\.sh" "\$1\/([a-z]+)" "\$W" 0 /.exec(args[1])[1], "answers");
      mkdirSync(given, { recursive: true });
      const found = diffs[w] ?? (differ.includes(w) ? DIFF : "");
      writeFileSync(join(given, "bodies.txt"), BODY(DIGEST.base, mine));
      // The same answers leave an empty diff.txt (undiffed: none, or with "dir" one that cannot be read).
      if (undiffed[w] === "dir") mkdirSync(join(given, "diff.txt")); else if (!undiffed[w]) writeFileSync(join(given, "diff.txt"), found);
      // As answers.mjs seals the comparison, and turns.sh then names the seal after its stop.
      const sealing = { outcome: swapped[w]?.outcome ?? (found.length ? "differ" : "same"), diff: sha256(found), bodies: sha256(BODY(DIGEST.base, mine)) };
      const handoff = forms[w] ? forms[w](sealing) : `${JSON.stringify(sealing)}\n`;
      writeFileSync(join(given, "handoff.json"), handoff);
      if (swapped[w]?.at) writeFileSync(join(given, swapped[w].at), swapped[w].text);
      const sealed = `turns: ${w}: handoff sha256 ${sha256(handoff)}\n`;
      if (piped[w]) {
        fifo(join(given, piped[w].at));
        return out(piped[w].status, `${piped[w].text}${piped[w].status === 1 ? "" : sealed}`);
      }
      if (!differ.includes(w)) return out(0, `answers: same\n${sealed}`);
      return differed[w] ? out(differed[w].status, `${DIFF}${differed[w].text}`) : out(4, `${DIFF}${DIFFERS(w)}${sealed}`);
    }
    const res = join(work, "results"), leave = (text) => { mkdirSync(res, { recursive: true }); writeFileSync(join(res, "report.json"), text); };
    // A report says which plan it is of: the one this run wrote.
    const stamped = (r) => (typeof r === "string" ? r : JSON.stringify(r)).replaceAll(SHA, createHash("sha256").update(readFileSync(join(dir, "plan.json"))).digest("hex"));
    if (ended[key]) {
      if (ended[key].report) leave(stamped(ended[key].report));
      return out(ended[key].status ?? 1, `== turns start\nRUN-ENDED ${ended[key].outcome}\nALL-DONE\n`);
    }
    // Every placement the part was resolved to have leaves the two bodies it compared.
    for (const { comparison: c, i } of JSON.parse(readFileSync(join(work, "plan", "resolved.json"), "utf8")).schedule) {
      if (short.includes(key) && i > 1) continue;
      const at = join(res, c, `p${String(i).padStart(3, "0")}`, "answers");
      mkdirSync(at, { recursive: true });
      if (i === 2 && piped[key]) fifo(join(at, "bodies.txt"));
      else writeFileSync(join(at, "bodies.txt"), i === 2 && c !== `aa-${w}` && placed[key] ? placed[key] : BODY(DIGEST.base, c === `change-${w}` ? mine : DIGEST.base));
    }
    const left = written[key] ?? (part === "pilot" ? piloted(w, reports[w]?.K ?? 69, dry ? { dry, pilot: { sizing: { ok: false, K: null } } } : {}) : reports[w]);
    leave(stamped(left));
    return out(0, "RUN-ENDED complete: every comparison complete; results/report.md\nALL-DONE\n");
  };
  const result = run({ dir, page, date, env, exec, say: (l) => said.push(l) });
  return { ...result, dir, page: readFileSync(page, "utf8"), calls, said: said.join("\n"), file: (f) => readFileSync(join(dir, f), "utf8") };
}
const PASS = { plain: report("plain", 0.004, 0.011), unstaged: report("unstaged", -0.002, 0.003, { K: 91 }) };
const PARTS = (w) => [`pilot ${w} plan`, `pilot ${w} build`, `pilot ${w} run`, `gated ${w} plan`, `gated ${w} build`, `gated ${w} run`];
const CHECKS = (w) => [`check ${w} plan dry`, `check ${w} build`, `check ${w} answers`];

test("a run: both sides checked before any turn, each workload's pilot and gated part in order, and the row on the page", () => {
  const r = command({ reports: PASS, real: true });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain"), ...PARTS("unstaged")]);
  // The plan the parts read is the trend's with this run's commits and seeds, and plan.mjs took it.
  const plan = JSON.parse(r.file("plan.json"));
  assert.deepEqual([plan.name, plan.base, plan.head, plan.workloads.map((w) => w.seed)], ["trend-2026-12-02", BASE, HEAD, [2026120201, 2026120202]]);
  assert.deepEqual(readFileSync(join(r.dir, "probe", "src", "main.rs")), readFileSync(join(here, "example", "probe", "src", "main.rs")));
  for (const word of [`plan trend-2026-12-02, sha256 `, `base ${BASE}, head ${HEAD}`, "pilot plain: K = 100 placements, R = 8", "gated unstaged: K from the pilot", "the order is drawn from seed 2026120202"]) assert.ok(r.file("declared.txt").includes(word), word);
  // How the release and main answer differently was found before the plan was written, and is
  // the workload's expected difference in every part: plan.mjs listed the file among the inputs.
  assert.deepEqual(plan.workloads.map((w) => w.expect), ["expect-plain.txt", undefined]);
  assert.equal(JSON.parse(r.file("check.json")).workloads[0].expect, undefined);
  assert.equal(r.file("expect-plain.txt"), DIFF);
  assert.equal(r.file(join("plain-pilot", "plan", "expect.txt")), DIFF);
  assert.ok(r.file(join("plain-pilot", "plan", "inputs.sha256")).includes("  plan/expect.txt\n"));
  assert.ok(!existsSync(join(r.dir, "unstaged-pilot", "plan", "expect.txt")));
  // The two bodies of each workload are kept by their digests, whether they differ or not.
  assert.deepEqual([r.file("bodies-plain.txt"), r.file("bodies-unstaged.txt")], [BODY(DIGEST.base, DIGEST.head), BODY(DIGEST.base, DIGEST.base)]);
  // The check is a dry part, which sizes and turns nothing; the parts that are read are not.
  assert.ok(r.file(join("check-plain", "plan", "resolved.sh")).includes("DRY='1'\n") && r.file(join("plain-pilot", "plan", "resolved.sh")).includes("DRY='0'\n"));
  const line = LINE(`${PLAIN}, answers differ as recorded; ${UNSTAGED}`, PASSES);
  assert.equal(r.line, line);
  assert.equal(r.page, `${BLANK}${line}\n`);
  assert.equal(r.file("row.md"), `${TABLE.join("\n")}\n${line}\n`);
  assert.equal(r.issue, null);
  assert.ok(!existsSync(join(r.dir, "issue.md")) && r.said.includes("commit it as it is") && r.said.includes("v0.2.0 and origin/main answer differently. The run records this difference, which nobody reviewed"));
  // The page was replaced whole, and nothing is left beside it.
  assert.deepEqual(readdirSync(tmp).filter((f) => f.endsWith(".tmp")), []);
  // Every step's output is kept with the run.
  assert.deepEqual(readdirSync(join(r.dir, "log")).sort(), [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain"), ...PARTS("unstaged")].map((c) => { const [part, w, step] = c.split(" "); return `${part === "check" ? `check-${w}` : `${w}-${part}`}-${step}.out`; }).sort());
});

test("a run past its threshold: exit 1, and a draft of an issue with the pull requests merged since the row before it", () => {
  const before = row(at(READ, { date: "2026-11-25", head: EARLIER }));
  const r = command({ reports: { ...PASS, unstaged: report("unstaged", 0.024, 0.031, { K: 91 }) }, before });
  assert.equal(r.exit, 1);
  assert.equal(r.calls.at(-1), `git log ${EARLIER}..${HEAD}`);
  assert.deepEqual(rows(r.page).map((x) => [x.date, x.reading]), [["2026-12-02", "past +2.00%: `unstaged`"], ["2026-11-25", PASSES]]);
  assert.equal(r.issue.title, "Trend: main costs a request at least +2.00% more cycles than v0.2.0 on unstaged (run of 2026-12-02)");
  for (const word of ["Merged from the row before this one (2026-11-25, `c6e9be955`) to this run, 4 on `main`'s first-parent line.", `The row before this one (2026-11-25) reads: ${PASSES}.`, "- [#2109 Let a probe read across placements decide a change's cycles](https://github.com/corten-run/corten/pull/2109)", "- `unstaged`: lower bound +2.40%, median +2.75%, bound +3.10%."]) assert.ok(r.issue.body.includes(word), word);
  assert.equal(r.file("issue.md"), `${r.issue.title}\n\n${r.issue.body}`);
  assert.ok(r.said.includes("Past the threshold. A draft of an issue") && r.said.includes("the command opens nothing") && r.said.includes(r.issue.title));
  // No row before it: from the release.
  const first = command({ reports: { ...PASS, plain: report("plain", 0.03, 0.04) } });
  assert.equal(first.calls.at(-1), `git log ${BASE}..${HEAD}`);
  assert.ok(first.issue.body.includes("The page has no row before this one.") && first.issue.body.includes("Merged from v0.2.0 to this run, 4 on"));
  // A row before it whose commit this run's head does not descend from (main moved back, as a
  // forced fetch can bring it), or that git cannot place: from the release, and said, never "none".
  for (const [asked, word] of [[{ under: [], apart: [EARLIER] }, "a commit this run's head does not descend from (`main` was moved back or rewritten since)"], [{ under: [] }, "a commit git could not place before this run's head in the run's checkout"]]) {
    const lacking = command({ reports: { ...PASS, plain: report("plain", 0.03, 0.04) }, before, log: { status: 0, text: "" }, ...asked });
    assert.equal(lacking.calls.at(-1), `git log ${BASE}..${HEAD}`);
    assert.ok(lacking.issue.body.includes(`The row before this one (2026-11-25) names \`c6e9be955\`, ${word}, so the list below is from v0.2.0: the commits \`main\` has that the release does not.`) && lacking.issue.body.includes("Merged from v0.2.0 to this run, 0 on"), lacking.issue.body);
  }
  // A log git could not give, or one that is not a list of commits, is no list: never "none".
  for (const [log, word] of [[{ status: 128 }, "git log ended with status 128"], [{ status: 0, text: "warning: something else\n" }, "git log's output is not a list of commits"]]) {
    const unread = command({ reports: { ...PASS, plain: report("plain", 0.03, 0.04) }, log });
    assert.equal(unread.exit, 1);
    assert.ok(unread.issue.body.includes(`could not be read from the run's checkout (${word}). That is not "none"`) && !unread.issue.body.includes("- none"), unread.issue.body);
  }
  // An interval with no commit is none, and says so.
  assert.ok(command({ reports: { ...PASS, plain: report("plain", 0.03, 0.04) }, log: { status: 0, text: "" } }).issue.body.includes("- none: `main` has no commit in that interval"));
});

test("a probe that does not build at the release tag: said, written as the row for every workload, exit 3, and nothing turned", () => {
  const r = command({ build: { "check plain": { status: 1, text: "error[E0425]: cannot find function `serve_on` in crate `corten`\nbuild: base: the build failed\n" } } });
  assert.equal(r.exit, 3);
  assert.deepEqual(r.calls, ["check plain plan dry", "check plain build"]);
  const line = LINE("not read: the probe does not build at v0.2.0", "not read: `plain`, `unstaged`");
  assert.deepEqual([r.line, r.page.endsWith(`${line}\n`), r.said.includes(line)], [line, true, true]);
  assert.ok(r.file(join("log", "check-plain-build.out")).includes("cannot find function `serve_on`"));
  // The same of main's side, by the ref the plan names.
  const head = command({ build: { "check plain": { status: 1, text: "build: head: the build failed\n" } } });
  assert.ok(head.line.includes("| not read: the probe does not build at origin/main |"));
});

test("not read, never a pass: a side the kit refuses, answers not compared, a pilot that sizes no K, a part that did not end well", () => {
  // A refusal for one workload leaves the other to be read.
  const refused = command({ reports: PASS, differ: [], build: { "check plain": { status: 3, text: "REFUSED: head has no reading across placements\n", refused: "head has no reading across placements: 1 input sections of .text are aligned beyond 64 bytes" } } });
  assert.equal(refused.exit, 3);
  assert.deepEqual(refused.calls, ["check plain plan dry", "check plain build", ...CHECKS("unstaged"), ...PARTS("unstaged")]);
  assert.ok(refused.line.includes("`plain` not read: the kit refuses the run: head has no reading across placements: 1 input sections of .text are aligned beyond 64 bytes; `unstaged` -0.20% to +0.30%"));
  assert.ok(refused.line.endsWith("| not read: `plain` |"));
  // The two sides' answers could not be compared at all, so nothing says how they may differ:
  // not the difference to expect, and no part of that workload is run.
  const silent = command({ reports: PASS, silent: { plain: "nothing answers on 18081" } });
  assert.equal(silent.exit, 3);
  assert.deepEqual(silent.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("unstaged")]);
  assert.ok(silent.line.includes("`plain` not read: the two sides' answers could not be compared: turns: plain: nothing answers on 18081;"));
  assert.ok(!existsSync(join(silent.dir, "expect-plain.txt")) && JSON.parse(silent.file("plan.json")).workloads.every((w) => w.expect === undefined));
  // Answers that differ, after which the servers' stop failed: turns.sh ends 1 and says no
  // difference, so the run records none and the workload is not read. The first is what a
  // turns.sh that said the difference before its stop printed when a server was left listening
  // after it; the second what turns.sh says now. Status 4 alone, or the line alone, is not that
  // outcome either.
  const listening = (port, side) => `turns: plain: something still accepts on ${port} after ${side}'s server was stopped (curl status 0): START must be, or exec, the server that listens, not start it and leave it\n`;
  const before = `turns: plain: A and B answer differently\n${listening(18081, "A")}${listening(18082, "B")}`;
  const cleanup = `${listening(18081, "A")}${listening(18082, "B")}turns: plain: A and B's answers differ, and stopping their servers after the check failed or is unconfirmed: not read as a difference\n`;
  for (const [name, d] of [["said before the stop", { status: 1, text: before }], ["cleanup", { status: 1, text: cleanup }], ["line, status 1", { status: 1, text: DIFFERS("plain") }], ["status 4 alone", { status: 4, text: "" }]]) {
    const r = command({ reports: PASS, differed: { plain: d } });
    assert.equal(r.exit, 3, name);
    assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("unstaged")], name);
    assert.ok(r.line.includes("`plain` not read: the two sides' answers could not be compared: "), `${name}: ${r.line}`);
    assert.ok(!existsSync(join(r.dir, "expect-plain.txt")) && !r.said.includes("answer differently. The run records this difference"), name);
  }
  // A side that takes a connection and never answers: the check is stopped at a placement's
  // time limit, and that is the reason, with the row still written for the other workload.
  const late = command({ reports: PASS, differ: [], late: ["plain"] });
  assert.equal(late.exit, 3);
  assert.deepEqual(late.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("unstaged")]);
  assert.ok(late.line.includes("`plain` not read: the check of the two sides' answers did not finish within a placement's time limit, 600 s, and was stopped, its servers' cleanup unconfirmed; `unstaged` -0.20% to +0.30%"), late.line);
  // Stopped at its deadline after it wrote the difference (timeout's TERM in its stop, or its KILL):
  // the answers were compared, but the check did not finish, so the difference is not recorded.
  for (const status of [124, 137]) {
    const cut = command({ reports: PASS, differed: { plain: { status, text: "" } } });
    assert.equal(cut.exit, 3, String(status));
    assert.equal(readFileSync(join(cut.dir, "check-plain", "compare", "answers", "diff.txt"), "utf8"), DIFF);
    assert.ok(cut.line.includes("`plain` not read: the check of the two sides' answers did not finish within a placement's time limit, 600 s, and was stopped, its servers' cleanup unconfirmed;"), `${status}: ${cut.line}`);
    assert.ok(!existsSync(join(cut.dir, "expect-plain.txt")) && !cut.said.includes("answer differently. The run records this difference"), String(status));
  }
  // A comparison that ended with status 0 and left no diff.txt, or one that is no regular file, found
  // nothing the run can read as "the same": that workload is not read, the other is, and the row is written.
  for (const [how, word] of [[true, "ENOENT: "], ["dir", `${join("check-unstaged", "compare", "answers", "diff.txt")} is a directory, not a regular file, so it is not read)`]]) {
    const bare = command({ reports: PASS, undiffed: { unstaged: how } });
    assert.deepEqual([bare.exit, rows(bare.page).length, bare.file("row.md").includes(bare.line), bare.calls], [3, 1, true, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain")]]);
    assert.ok(bare.line.includes(`${PLAIN}, answers differ as recorded; \`unstaged\` not read: what the check before any turn left could not be read (${word}`) && bare.line.endsWith("| not read: `unstaged` |"), bare.line);
  }
  // A pilot that sizes no K: the gated part is not resolved, built or run. What plan.mjs said
  // is the row's reason, less the run's directory, which is the host's.
  const unsized = command({ reports: PASS, sizes: { plain: "sizes no K for plain: the workload is not read across placements under this plan" } });
  assert.equal(unsized.exit, 3);
  assert.deepEqual(unsized.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain").slice(0, 4), ...PARTS("unstaged")]);
  assert.ok(unsized.line.includes(`\`plain\` not read: the gated part was not resolved: ${join("plain-pilot", "results")} sizes no K for plain: the workload is not read across placements under this plan;`), unsized.line);
  assert.ok(!unsized.page.includes(tmp));
  // A pilot that stopped at verify.sh, in run.sh's own words.
  const stopped = command({ reports: PASS, ended: { "pilot unstaged": { outcome: "verify-failed: a placement does not answer as its unpadded binary, or the plan's mask does not hold (results/verify.log)" } } });
  assert.deepEqual(stopped.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain"), ...PARTS("unstaged").slice(0, 3)]);
  assert.ok(stopped.line.includes("`unstaged` not read: the pilot part ended verify-failed: a placement does not answer as its unpadded binary"));
  // An A/A that did not resolve, with a change that reads far under the threshold.
  const loose = command({ reports: { ...PASS, plain: report("plain", -0.05, -0.04, { resolution: "not resolved", aa: [0.0103, 0.0079] }) } });
  assert.deepEqual([loose.exit, rows(loose.page)[0].reading], [3, "not read: `plain`"]);
  // Past the threshold on one and not read on the other is both, exits as not read, and still drafts the issue.
  const both = command({ reports: { plain: report("plain", 0.03, 0.04), unstaged: report("unstaged", 0, 0, { resolution: "no bound", K: 91 }) } });
  assert.deepEqual([both.exit, rows(both.page)[0].reading, Boolean(both.issue)], [3, "past +2.00%: `plain`; not read: `unstaged`", true]);
});

test("a gated part that did not end with status 0 is not read, whatever report it left, and a report that cannot be read costs its workload alone", () => {
  // The report on disk reads as a rise past the threshold, or as a pass. The part's run did not
  // end well, so neither is read: the row has what run.sh said, and no issue is drafted from it.
  for (const left of [report("plain", 0.03, 0.04), report("plain", 0.004, 0.011), report("plain", "bad", 0.04, { exit: 1, sized: {} })]) {
    for (const [status, outcome] of [[1, "incomplete: a comparison without all its placements has no bound; results/report.md"], [143, "killed: run.sh got TERM"], [1, "report-crashed: report.mjs exit 3: TypeError"]]) {
      const r = command({ reports: PASS, ended: { "gated plain": { status, outcome, report: left } } });
      assert.deepEqual([r.exit, r.issue, rows(r.page)[0].reading], [3, null, "not read: `plain`"]);
      assert.ok(r.line.includes(`\`plain\` not read: the gated part ended ${outcome}; ${UNSTAGED} |`), r.line);
    }
  }
  // One that left no report says how it ended.
  const none = command({ reports: PASS, ended: { "gated plain": { outcome: "perf-preflight-failed: perf cannot count cycles:u here" } } });
  assert.ok(none.line.includes("`plain` not read: the gated part ended perf-preflight-failed: perf cannot count cycles:u here;"));
  // A report that cannot be read, in whatever way, as the file on disk holds it: cut short,
  // empty, not a report, or with a value where a number or a text is read (the review's two,
  // which make reading it throw). That workload is not read, with the reason, the other is, the
  // row is written and the command ends as for any workload not read.
  const whole = JSON.stringify(PASS.plain), could = "the report could not be read (", odd = '{"toString": null}';
  const unreadable = (written, word, calls = PARTS("unstaged")) => {
    const cut = command({ reports: PASS, written });
    assert.equal(cut.exit, 3, cut.line);
    assert.ok(cut.line.includes(`\`plain\` not read: ${word}`) && cut.line.includes(`; ${UNSTAGED} | not read: \`plain\` |`), cut.line);
    assert.deepEqual([rows(cut.page).length, cut.file("row.md").includes(cut.line), cut.calls.slice(-calls.length)], [1, true, calls]);
  };
  for (const [text, word] of [[whole.slice(0, whole.length / 2), could], ["", could], ["null", "the gated part left no report"], ["[1, 2]", "the gated part left no report"],
    [whole.replace('"K":69', `"K":${odd}`), could], [`{"exit": 2, "refused": [${odd}]}`, could], [`${whole.slice(0, -1)},"complete":"all"}`, "the report is not a gated part's of this workload"]]) unreadable({ "gated plain": text }, word);
  // The same of the pilot's, whose K the gated part's is held to: no gated part is run on it.
  const early = [...PARTS("plain").slice(0, 3), ...PARTS("unstaged")];
  for (const text of ['{"exit": 0, "pilot": {"sizing"', "null", `"pilot"`]) unreadable({ "pilot plain": text }, text === `"pilot"` ? "the pilot part's report is not a complete pilot's of this run" : could, early);
  // One that says it is a complete pilot's and holds no sizing: plan.mjs refuses to size from
  // it, and were a gated part made all the same, its report is not read.
  unreadable({ "pilot plain": piloted("plain", 69, { pilot: null }) }, could);
  // A pilot's report that is not a pilot part's of this run, complete: a gated part's, a dry
  // run's, results the kit refused, another plan's, another workload's.
  for (const more of [{ part: "gated" }, { dry: true }, { exit: 2 }, { plan: "d".repeat(64) }, { workload: "unstaged" }]) unreadable({ "pilot plain": piloted("plain", 69, more) }, "the pilot part's report is not a complete pilot's of this run;", early);
  // A gated part at another K than this run's pilot sized or sized from another run's pilot, of
  // another plan, or a dry run's.
  const other = (r, word, written = {}) => { const x = command({ reports: { ...PASS, plain: r }, written }); assert.equal(x.exit, 3); assert.ok(x.line.includes(`\`plain\` not read: ${word};`), x.line); };
  other(report("plain", 0.03, 0.04, { plan: "d".repeat(64) }), "the report is of another plan than this run's");
  other({ ...report("plain", 0.03, 0.04), head: EARLIER }, "the report is of another head than this run's");
  other(report("plain", 0.03, 0.04, { dry: true }), "the report is a dry run's, and this run is not one");
  other(report("plain", 0.03, 0.04, { sized: { K: 69, from: "another-run" } }), "K = 69 is not the K this run's pilot sized");
  other(PASS.plain, "K = 69 is not the K this run's pilot sized", { "pilot plain": piloted("plain", 77) });
  other(PASS.plain, "K = 69 is not the K this run's pilot sized", { "pilot plain": piloted("plain", 69, { pilot: { sizing: { ok: false, K: 69 } } }) });
});

test("a placement that answered with another body than the check kept makes its workload not read", () => {
  // The difference turns.sh holds a placement to has the bodies' lengths alone, so a third
  // body of that length passes it; the part ends complete and its report reads as a pass.
  const third = command({ reports: PASS, placed: { "gated plain": BODY(DIGEST.base, DIGEST.third) } });
  assert.equal(third.exit, 3);
  assert.ok(third.line.includes(`\`plain\` not read: the gated part: change-plain p002 answered with other bodies than the run recorded before any turn (${BODY(DIGEST.base, DIGEST.third).trimEnd()}; recorded: sha256 ${DIGEST.base} and ${DIGEST.head}); ${UNSTAGED} |`), third.line);
  // In the pilot it stops that workload before its gated part.
  const early = command({ reports: PASS, placed: { "pilot unstaged": BODY(DIGEST.third, DIGEST.third) } });
  assert.deepEqual(early.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain"), ...PARTS("unstaged").slice(0, 3)]);
  assert.ok(early.line.includes("`unstaged` not read: the pilot part: pilot-unstaged p002 answered with other bodies than the run recorded before any turn"), early.line);
  // Every placement the part was resolved to have, not every one that is there: results that
  // hold the first of 69 alone, under a report that reads as a pass at K = 69, are not read.
  const few = command({ reports: PASS, short: ["gated plain"] });
  assert.equal(few.exit, 3);
  assert.ok(few.line.includes(`\`plain\` not read: the gated part: aa-plain p002 answered with other bodies than the run recorded before any turn (no bodies.txt as the kit writes it; recorded: sha256 ${DIGEST.base} and ${DIGEST.base}); ${UNSTAGED} |`), few.line);
  assert.ok(command({ reports: PASS, short: ["pilot unstaged"] }).line.includes("`unstaged` not read: the pilot part: pilot-unstaged p002 answered with other bodies"));
});

test("what the check before any turn left is read as its handoff sealed it: a regular file put at diff.txt or bodies.txt afterwards, or another outcome sealed, leaves the workload not read", () => {
  // After answers found the same (status 0) or different (status 4): a regular file, not a FIFO or
  // a link, put in place of what the check wrote. Status 0 with a difference there, a difference
  // other than the one found, another pair of bodies: none is what the check sealed.
  const other = `1c1\n< x-one: a\n---\n> x-one: b\nbodies same: 6124 bytes, sha256 ${DIGEST.base.repeat(4)}\n`;
  for (const [name, differ, swapped, word] of [
    ["status 0, a difference at diff.txt", [], { at: "diff.txt", text: DIFF }, "check-plain/compare/answers/diff.txt is not the difference the comparison sealed"],
    ["status 4, another difference at diff.txt", ["plain"], { at: "diff.txt", text: other }, "check-plain/compare/answers/diff.txt is not the difference the comparison sealed"],
    ["status 0, other bodies at bodies.txt", [], { at: "bodies.txt", text: BODY(DIGEST.third, DIGEST.third) }, "check-plain/compare/answers/bodies.txt is not the bodies line the comparison sealed"],
    ["status 4, other bodies at bodies.txt", ["plain"], { at: "bodies.txt", text: BODY(DIGEST.base, DIGEST.third) }, "check-plain/compare/answers/bodies.txt is not the bodies line the comparison sealed"],
    ["status 4, the outcome sealed as the same", ["plain"], { outcome: "same" }, 'the comparison sealed the outcome "same", not differ'],
    ["status 0, the outcome sealed as a difference", [], { outcome: "differ" }, 'the comparison sealed the outcome "differ", not same'],
  ]) {
    const r = command({ reports: PASS, differ, swapped: { plain: swapped } });
    assert.equal(r.exit, 3, `${name}: ${r.line}`);
    assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("unstaged")], name);
    assert.ok(r.line.includes(`\`plain\` not read: the two sides' answers were compared, and what the check left is not what it sealed: ${word.replaceAll("/", sep)}; ${UNSTAGED} |`), `${name}: ${r.line}`);
    assert.ok(!existsSync(join(r.dir, "expect-plain.txt")) && !existsSync(join(r.dir, "bodies-plain.txt")), name);
  }
  // The same files, left as the check sealed them, are read: the control for each of the above.
  for (const differ of [[], ["plain"]]) {
    const r = command({ reports: PASS, differ });
    assert.ok(r.line.includes(differ.length ? `${PLAIN}, answers differ as recorded;` : `${PLAIN};`), r.line);
  }
});

test("a handoff in another form than the kit writes, a key given twice say, leaves the workload not read, though its line names its bytes", () => {
  const twice = (h) => `{"outcome":"differ","outcome":"${h.outcome}","diff":"${h.diff}","bodies":"${h.bodies}"}\n`;
  const r = command({ reports: PASS, differ: [], forms: { plain: twice } });
  assert.equal(r.exit, 3, r.line);
  assert.ok(r.line.includes(`\`plain\` not read: the two sides' answers were compared, and what the check left is not what it sealed: ${join("check-plain", "compare", "answers", "handoff.json")} is not a handoff the kit writes; ${UNSTAGED} |`), r.line);
});

test("a recorded difference is kept as the bytes the check sealed, a header byte that is not UTF-8 included", () => {
  const bytes = Buffer.concat([Buffer.from("5c5\n< x-name: cafe\n---\n> x-name: caf\xe9\n", "latin1"), Buffer.from(`bodies same: 6124 bytes, sha256 ${DIGEST.base.repeat(4)}\n`)]);
  const r = command({ reports: PASS, diffs: { plain: bytes } });
  assert.ok(r.line.includes(`${PLAIN}, answers differ as recorded;`), r.line);
  assert.deepEqual(readFileSync(join(r.dir, "expect-plain.txt")), bytes);
});

// A FIFO the kit left where a file is read, on Linux alone. A read that opened it would wait for
// a writer; each has one, a process that opens it to write after OPEN_AFTER and so lets such a
// read end, which takes the run past BOUND. A run that opens no FIFO ends well within BOUND.
const FIFOS = { skip: process.platform === "linux" && spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0 ? false : "needs Linux with mkfifo" };
const OPEN_AFTER = 10000, BOUND = 5000, openers = [];
function fifo(file) {
  rmSync(file, { force: true });
  assert.equal(spawnSync("mkfifo", [file]).status, 0, `mkfifo ${file}`);
  openers.push(spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(file)}, ""), ${OPEN_AFTER});`], { stdio: "ignore" }));
}
// Each opener is a child of this process that has not been waited for while it has no exit status here, so the signal reaches it alone.
async function unopened() {
  await Promise.all(openers.splice(0).map((p) => p.exitCode !== null || p.signalCode !== null ? null : new Promise((done) => { p.once("exit", done); p.kill("SIGKILL"); })));
}
const timed = (f) => { const start = performance.now(), r = f(); return { ...r, took: performance.now() - start }; };

test("a FIFO at diff.txt that turns.sh refused (exit 1) is never opened: that workload is not read, and the run goes on to the next", FIFOS, async (t) => {
  t.after(unopened);
  const r = timed(() => command({ reports: PASS, differ: [], piped: { plain: { at: "diff.txt", status: 1, text: "turns: plain: answers/diff.txt cannot be written as a new file: something is there before the check made it\n" } } }));
  assert.ok(r.took < BOUND, `the run took ${Math.round(r.took)} ms: it waited on the FIFO`);
  assert.equal(r.exit, 3);
  assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("unstaged")]);
  assert.ok(r.line.includes(`\`plain\` not read: the two sides' answers could not be compared: turns: plain: answers/diff.txt cannot be written as a new file: something is there before the check made it; ${UNSTAGED} |`), r.line);
});

test("a FIFO at diff.txt or bodies.txt after answers turns.sh found the same (status 0) or different (status 4) is refused, not opened", FIFOS, async (t) => {
  t.after(unopened);
  for (const at of ["diff.txt", "bodies.txt"]) for (const [status, differ, text] of [[0, [], "answers: same\n"], [4, ["plain"], `${DIFF}${DIFFERS("plain")}`]]) {
    const name = `${at}, status ${status}`, r = timed(() => command({ reports: PASS, differ, piped: { plain: { at, status, text } } }));
    assert.ok(r.took < BOUND, `${name}: the run took ${Math.round(r.took)} ms: it waited on the FIFO`);
    assert.equal(r.exit, 3, name);
    assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("unstaged")], name);
    assert.ok(r.line.includes(`\`plain\` not read: what the check before any turn left could not be read (${join("check-plain", "compare", "answers", at)} is a FIFO, not a regular file, so it is not read); ${UNSTAGED} |`), `${name}: ${r.line}`);
    assert.ok(!existsSync(join(r.dir, "expect-plain.txt")) && !existsSync(join(r.dir, "bodies-plain.txt")), name);
  }
});

test("a FIFO at a placement's bodies.txt is refused, not opened: that workload is not read, and the run goes on to the next", FIFOS, async (t) => {
  t.after(unopened);
  const r = timed(() => command({ reports: PASS, piped: { "pilot plain": true } }));
  assert.ok(r.took < BOUND, `the run took ${Math.round(r.took)} ms: it waited on the FIFO`);
  assert.equal(r.exit, 3);
  assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain").slice(0, 3), ...PARTS("unstaged")]);
  assert.ok(r.line.includes(`\`plain\` not read: the pilot part: pilot-plain p002: ${join("plain-pilot", "results", "pilot-plain", "p002", "answers", "bodies.txt")} is a FIFO, not a regular file, so it is not read; ${UNSTAGED} |`), r.line);
});

let refusals = 0;
test("refused before anything is made or run", () => {
  // there: the directory named is there already, so it is not looked for afterwards.
  const refused = (asked, word, change = () => {}, there = false) => {
    const n = ++refusals, dir = join(tmp, `refused-${n}`), page = join(tmp, `refused-${n}.md`), calls = [];
    writeFileSync(page, BLANK);
    const o = { dir, page, date: "2026-12-02", env: { ...process.env, DRYRUN: "0" }, say: () => {}, exec: (cmd, args) => { calls.push(args.slice(2).join(" ")); return cmd === "git" ? git(args, asked) : { status: 0, stdout: "" }; } };
    change(o);
    const was = readFileSync(o.page, "utf8");
    assert.throws(() => run(o), (e) => e.refused === true && e.message.includes(word), word);
    assert.equal(readFileSync(o.page, "utf8"), was);
    assert.ok(!calls.some((c) => c.includes("plan.mjs") || c.includes(".sh")));
    if (!there) assert.ok(!existsSync(o.dir), `${o.dir} was made`);
  };
  // The run's directory: an absolute path with no white space, outside the checkout by whole
  // names and by where it really is, that is not there yet and whose parent is.
  refused({}, "the run's directory is an absolute path without white space", (o) => { o.dir = "run"; });
  refused({}, "the run's directory is an absolute path without white space", (o) => { o.dir = join(tmp, "a run"); });
  refused({}, "is inside the checkout: a run's directory is outside it", (o) => { o.dir = join(here, "trend", "run"); });
  refused({}, "is inside the checkout", (o) => { o.dir = root; }, true);
  refused({}, "is inside the checkout", (o) => { o.dir = join(root, "..runs"); });
  refused({}, "is inside the checkout", (o) => { o.dir = join(root, "..", basename(root), "bench", "..runs", "one"); });
  refused({}, "is already there, and a run is made once in a directory of its own", (o) => mkdirSync(o.dir), true);
  refused({}, "is already there", (o) => { mkdirSync(o.dir); writeFileSync(join(o.dir, "row.md"), ""); }, true);
  refused({}, "where the run's directory is to be made, is not there", (o) => { o.dir = join(tmp, "no-parent", "run"); });
  // A link that leads into the checkout is where it leads (on Windows a junction, which anyone can make).
  const link = join(tmp, "into-the-checkout");
  symlinkSync(join(here, "trend"), link, process.platform === "win32" ? "junction" : "dir");
  refused({}, "is inside the checkout", (o) => { o.dir = join(link, "run"); });
  // Two runs cannot share a directory: the second finds the first's.
  const once = join(tmp, "once"), page = join(tmp, "once.md");
  writeFileSync(page, BLANK);
  const quiet = { page, date: "2026-12-02", env: { ...process.env, DRYRUN: "1" }, say: () => {}, exec: (cmd, args) => (cmd === "git" ? git(args) : { status: 1, stdout: "", stderr: "" }) };
  run({ ...quiet, dir: once });
  assert.throws(() => run({ ...quiet, dir: once }), /is already there, and a run is made once/);
  // The checkout: full, with a release tag and the plan's branch, and git answering as asked.
  refused({ shallow: { status: 0, text: "true\n" } }, "the checkout is shallow, so the commits main merged since a row cannot all be listed from it");
  refused({ shallow: { status: 128 } }, "git could not say whether the checkout is shallow");
  // Partial by a remote whose promisor is true or by the older extension; a promisor that is
  // false is a full clone's, and is not refused.
  refused({ promisor: "remote.fork.promisor false\nremote.origin.promisor true\n" }, "the checkout is a partial clone (a remote of it is a promisor), which lacks objects and fetches them as they are read");
  refused({ extension: "origin\n" }, "the checkout is a partial clone");
  refused({ promisor: 128 }, "git could not say whether the checkout is a partial clone");
  run({ ...quiet, dir: join(tmp, "promisor-false"), exec: (cmd, args) => (cmd === "git" ? git(args, { promisor: "remote.origin.promisor false\n" }) : { status: 1, stdout: "", stderr: "" }) });
  refused({ tags: "evidence/placement-kit\n" }, "the checkout has no release tag vX.Y.Z: fetch the tags");
  refused({ tags: null }, "git could not list the checkout's tags");
  refused({ commits: { "refs/tags/v0.2.0": undefined, "v0.2.0": BASE } }, "v0.2.0 names no commit");
  refused({ commits: { "refs/remotes/origin/main": undefined, "origin/main": HEAD } }, "the checkout has no origin/main (refs/remotes/origin/main): fetch it");
  refused({ commits: { "refs/remotes/origin/main": "warning: refname is ambiguous" } }, 'git gave no commit id for refs/remotes/origin/main: "warning: refname is ambiguous"');
  refused({ commits: { "refs/tags/v0.2.0": BASE.slice(0, 12) } }, "git gave no commit id for refs/tags/v0.2.0");
  // The page: a table as the command writes it, and no row of this date or a later one. One run a date.
  refused({}, "the page has no table of runs", (o) => writeFileSync(o.page, "# The trend\n"));
  refused({}, "the page already has a row of 2026-12-02: one run a date (UTC)", (o) => writeFileSync(o.page, insert(BLANK, row(at(READ, { head: EARLIER })))));
  refused({}, "the page already has a row of 2026-12-09: one run a date (UTC), each later than the page's rows", (o) => writeFileSync(o.page, insert(BLANK, row(at(READ, { date: "2026-12-09" })))));
  // The plan: one that can be read and used, said before anything is made.
  const planned = (text, word) => refused({}, word, (o) => { o.plan = join(tmp, `plan-${refusals}.json`); writeFileSync(o.plan, text); });
  planned(JSON.stringify(trend((t) => { t.threshold = 0; })), "is not a usable trend plan:\n  threshold");
  planned('{"trend": 1, "plan": {', "cannot be read as a trend plan: ");
  planned("null", '"trend": 1 is missing');
  planned(JSON.stringify(trend((t) => { delete t.plan.workloads; })), "plan.workloads: at least one workload");
  planned(JSON.stringify(trend((t) => { t.plan.workloads[1] = null; })), "plan.workloads: at least one workload");
  refused({}, "cannot be read as a trend plan: ", (o) => { o.plan = join(tmp, "no-such-plan.json"); });
  // A plan whose checking throws (a name that is no text, as a file can hold one) is refused
  // like any other, and so is one whose probe is not there.
  planned(JSON.stringify(trend((t) => { t.plan.workloads[0].name = { toString: null }; t.plan.workloads[0].K = 5; })), "cannot be read as a trend plan: ");
  planned(JSON.stringify(TREND), "probe, the plan's probe, is not there");
  // The command says the same and exits 2, with no directory made.
  const r = spawnSync(process.execPath, [join(here, "trend.mjs"), join(here, "trend", "run")], { encoding: "utf8" });
  assert.deepEqual([r.status, r.stdout, existsSync(join(here, "trend", "run"))], [2, "", false]);
  assert.ok(r.stderr.startsWith("trend.mjs: ") && r.stderr.includes("is inside the checkout"), r.stderr);
  const usage = spawnSync(process.execPath, [join(here, "trend.mjs")], { encoding: "utf8" });
  assert.deepEqual([usage.status, usage.stderr], [2, "usage: node trend.mjs <run dir>   (a directory to make: an absolute path outside the checkout that is not there yet)\n"]);
});

test("a dry run: every part the kit's dry run, the row kept with the run and marked, the page left as it was and no issue drafted", () => {
  const dry = { plain: report("plain", 0.03, 0.04, { dry: true, K: 6, sized: null }), unstaged: report("unstaged", 0, 0.001, { dry: true, K: 6, sized: null }) };
  const r = command({ reports: dry, dry: true });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain"), ...PARTS("unstaged")].map((c) => (c.endsWith(" plan") ? `${c} dry` : c)));
  assert.equal(r.page, BLANK);
  assert.ok(r.file("row.md").startsWith("DRY RUN: a test of the scripts, read for nothing. This row is not the page's.\n\n"));
  assert.ok(r.line.includes("`plain` not read: DRY RUN, read for nothing (+3.00% to +4.00%, median +3.50%, K = 6);") && r.line.endsWith("| not read: `plain`, `unstaged` |"));
  // Nothing is past a threshold in a dry run, whatever a report holds: figures over it, or a
  // report that claims to be a run's. No issue is drafted and git is asked for no log.
  assert.deepEqual([r.issue, existsSync(join(r.dir, "issue.md")), r.calls.some((c) => c.startsWith("git log"))], [null, false, false]);
  const claims = command({ reports: { ...dry, plain: report("plain", 0.03, 0.04) }, dry: true });
  assert.deepEqual([claims.exit, claims.issue, claims.page], [3, null, BLANK]);
  assert.ok(claims.line.includes("`plain` not read: the report is not a dry run's, and this run is one;"));
  // One that did not complete says so, and a dry run may follow a run of its date.
  assert.equal(command({ reports: { ...dry, plain: report("plain", null, null, { dry: true, K: 6, sized: null, exit: 1 }) }, dry: true }).exit, 3);
  const second = command({ reports: dry, dry: true, before: row(at(READ, { head: EARLIER })) });
  assert.deepEqual([second.exit, rows(second.page).length], [0, 1]);
});

// The answers check as the command runs it, on servers of its own: turns.sh, taskset, timeout
// and curl, with nothing stood in for but where a test says so. The plan's files are the least
// turns.sh reads.
const tools = process.platform === "linux" && spawnSync("sh", ["-c", "command -v taskset && command -v timeout && command -v curl && command -v sha256sum"]).status === 0;
const LINUX = { skip: tools ? false : "needs Linux with taskset, timeout, curl and sha256sum" };
// side: a value for a header of its own, x-side, so two servers can answer in a header alone.
const serve = (body, side = null) => `require("node:http").createServer((q, s) => { s.setHeader("content-type", "text/plain"); ${side === null ? "" : `s.setHeader("x-side", ${JSON.stringify(side)}); `}s.end(${JSON.stringify(body)}); }).listen(Number(process.argv[2]), "127.0.0.1");`;
const mute = 'require("node:net").createServer(() => {}).listen(Number(process.argv[2]), "127.0.0.1");';
const taken = (port) => spawnSync("curl", ["--disable", "--noproxy", "*", "-s", "-o", "/dev/null", "--max-time", "1", `http://127.0.0.1:${port}/`]).status !== 7;
const full = (body) => createHash("sha256").update(body).digest("hex"), digest = (body) => full(body).slice(0, 16);
/** A server that answers body, as serve() makes one, and ends by itself ms after it starts. */
const brief = (body, ms) => `${serve(body)} setTimeout(() => process.exit(0), ${ms});`;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * The work directory of a check of two sides' answers, base and head each a script node runs,
 * stopped after seconds, and the command that runs it (the command's own, or with EXPECT given).
 * expect: the text of an expected difference, given to turns.sh as a plan's is (the command's own
 * check gives none); path: the request's; start: the plan's start command.
 */
function check(name, base, head, seconds, { expect = null, path = "/page", start = "$BIN $PORT" } = {}) {
  // A CPU this process may run on, which need not be the first, and the kit's two ports free:
  // they are fixed, so one in use would be waited on, and is said instead.
  const cpu = /: *(\d+)/.exec(spawnSync("taskset", ["-cp", String(process.pid)], { encoding: "utf8" }).stdout)?.[1];
  assert.ok(cpu, "taskset names no CPU this process may run on");
  for (const port of [18081, 18082]) assert.ok(!taken(port), `port ${port} is in use, and the kit's ports are fixed: this test needs 18081 and 18082 free`);
  const work = join(tmp, name), vars = { KIT: here, START: start, REQ_PATH: path, STATUS: 200, EVENTS: "cycles:u", CPU_SERVER: cpu, CPU_LOAD: cpu, CPU_DRIVER: cpu, WRK_T: 1, WRK_C: 1, TURN: 1, W: "plain", PLACEMENT_SECONDS: seconds, PORT_A: 18081, PORT_B: 18082 };
  mkdirSync(join(work, "plan"), { recursive: true });
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "plan", "resolved.sh"), Object.entries(vars).map(([k, v]) => `${k}='${v}'\n`).join(""));
  for (const [f, text] of [["headers.txt", ""], ["mask.sed", ""], ["mask.json", "[]\n"], ["request.lua", ""]]) writeFileSync(join(work, "plan", f), text);
  for (const [side, script] of [["base", base], ["head", head]]) writeFileSync(join(work, "bin", side), `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  const expected = join(work, "plan", "expect.txt"), command = expect === null ? ANSWERS : ANSWERS.replace(" EXPECT= exec ", ' EXPECT="$2" exec ');
  if (expect !== null) { assert.notEqual(command, ANSWERS); writeFileSync(expected, expect); }
  return { work, command, expected };
}
// The check of two sides' answers, as check() makes it, run to its end. expect, path and start:
// as check() takes them; first: a directory put first on PATH, of stand-ins for tools turns.sh
// runs; env: more of the environment the check is run with; linger: how long a server the check
// left may take to end by itself before the kit's ports must be free (none, unless a test says so).
function answers(name, base, head, seconds, { first = null, env: more = {}, linger = 0, ...given } = {}) {
  const { work, command, expected } = check(name, base, head, seconds, given);
  const env = { ...process.env, ...more, ...(first ? { PATH: `${first}:${process.env.PATH}` } : {}) };
  const r = spawnSync("sh", ["-c", command, "sh", work, expected], { encoding: "utf8", timeout: 120000, env });
  // Whatever the check found, the servers it started are gone: nothing takes a connection.
  for (const port of [18081, 18082]) {
    const until = Date.now() + linger;
    let still = taken(port);
    while (still && Date.now() < until) { pause(100); still = taken(port); }
    assert.ok(!still, `${name}: something still answers on ${port}`);
  }
  return { status: r.status, said: r.stdout + r.stderr, answers: join(work, "compare", "answers"), expected };
}
/** A directory under the test's own of one stand-in, a shell script, for a tool turns.sh runs. */
const stand = (dir, name, script) => { mkdirSync(join(tmp, dir), { recursive: true }); writeFileSync(join(tmp, dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 }); return join(tmp, dir); };
/**
 * A server as serve() makes one that, as it takes its first request for anything but /, first
 * runs put, code with f the path of the check's answers/diff.txt and fs node:fs: what it puts
 * there is there before the check makes diff.txt, with nothing of the check's run between.
 */
const planting = (body, put, side = null) => `const fs = require("node:fs"), f = require("node:path").join(__dirname, "..", "compare", "answers", "diff.txt"); let put = false;
require("node:http").createServer((q, s) => { if (!put && q.url !== "/") { put = true; ${put} } s.setHeader("content-type", "text/plain"); ${side === null ? "" : `s.setHeader("x-side", ${JSON.stringify(side)}); `}s.end(${JSON.stringify(body)}); }).listen(Number(process.argv[2]), "127.0.0.1");`;
/** A server that answers the page with status (readiness, /, with 200), as serve() makes one. */
const answering = (status, body) => `require("node:http").createServer((q, s) => { if (q.url !== "/") s.statusCode = ${status}; s.setHeader("content-type", "text/plain"); s.end(${JSON.stringify(body)}); }).listen(Number(process.argv[2]), "127.0.0.1");`;

test("the answers check on real servers: the same, two bodies of one length, and a side that never answers", LINUX, () => {
  const same = answers("answers-same", serve("aaaa"), serve("aaaa"), 60);
  assert.equal(same.status, 0, same.said);
  assert.deepEqual([readFileSync(join(same.answers, "diff.txt"), "utf8"), bodies(join(same.answers, "bodies.txt"))], ["", { line: `body 4 bytes as received, sha256 ${digest("aaaa")} A and ${digest("aaaa")} B`, bytes: 4, a: digest("aaaa"), b: digest("aaaa") }]);
  // Two bodies of one length: the difference holds their lengths and their SHA-256s.
  const two = answers("answers-two", serve("aaaa"), serve("bbbb"), 60);
  assert.equal(two.status, 4, two.said);
  assert.ok(two.said.includes("turns: plain: A and B answer differently; both servers ended and nothing accepted on either port when checked\n"), two.said);
  // A difference is no passing verdict: answers/verdict.txt is not written.
  assert.ok(!existsSync(join(two.answers, "verdict.txt")), two.said);
  assert.equal(readFileSync(join(two.answers, "diff.txt"), "utf8"), `bodies differ: 4 and 4 bytes, sha256 ${full("aaaa")} and ${full("bbbb")}\n`);
  assert.deepEqual([bodies(join(two.answers, "bodies.txt")).a, bodies(join(two.answers, "bodies.txt")).b], [digest("aaaa"), digest("bbbb")]);
  // A side that takes a connection and never answers: stopped at the time limit, with timeout's status.
  const never = answers("answers-never", mute, serve("aaaa"), 3);
  assert.equal(never.status, 124, never.said);
});

test("the answers check on real servers: the difference the check recorded holds a placement to its two bodies, not to their lengths", LINUX, () => {
  const recorded = answers("answers-recorded", serve("aaaa"), serve("bbbb"), 60);
  assert.equal(recorded.status, 4, recorded.said);
  const difference = readFileSync(join(recorded.answers, "diff.txt"), "utf8");
  // That difference expected: the same two bodies pass, and a third body of the same length does not.
  const held = answers("answers-held", serve("aaaa"), serve("bbbb"), 60, { expect: difference });
  assert.equal(held.status, 0, held.said);
  assert.ok(held.said.includes("answers: differ only as the plan's expected difference says"), held.said);
  const third = answers("answers-third", serve("aaaa"), serve("cccc"), 60, { expect: difference });
  assert.equal(third.status, 1, third.said);
  assert.ok(third.said.includes("turns: plain: the answers differ other than as the plan's expected difference says"), third.said);
});

test("the answers check on real servers: each answer is taken once, so a body replaced after it was received changes neither the difference nor the bodies line", LINUX, () => {
  // A stand-in for diff, which the check runs once every answer has been taken, replaces B's
  // kept body with a third of the same length as it runs. Nothing the check says may come from a
  // body other than the one B answered with.
  const kept = join(tmp, "answers-swapped", "compare", "answers", "B.body");
  const first = stand("swapped", "diff", `printf cccc >'${kept}'\nPATH=\${PATH#*:} exec diff "$@"`);
  const r = answers("answers-swapped", serve("aaaa"), serve("bbbb"), 60, { first });
  assert.equal(r.status, 4, r.said);
  assert.equal(readFileSync(kept, "utf8"), "cccc", "the stand-in diff did not run");
  assert.equal(readFileSync(join(r.answers, "diff.txt"), "utf8"), `bodies differ: 4 and 4 bytes, sha256 ${full("aaaa")} and ${full("bbbb")}\n`);
  assert.equal(bodies(join(r.answers, "bodies.txt")).b, digest("bbbb"), "the bodies line is not B's answer");
});

/** A server that answers every request with exactly head's bytes (its status and header lines, CRLF each) and then body. */
const rawly = (head, body = "aaaa") => `const head = Buffer.from(${JSON.stringify(head)}, "latin1"), rest = Buffer.from(${JSON.stringify(`content-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`)}, "latin1");
require("node:net").createServer((c) => { let got = Buffer.alloc(0); c.on("error", () => {}); c.on("data", (d) => { got = Buffer.concat([got, d]); if (got.includes("\\r\\n\\r\\n")) c.end(Buffer.concat([head, rest])); }); }).listen(Number(process.argv[2]), "127.0.0.1");`;

test("the answers check on real servers: header lines are compared as sent, so whitespace that differs, or a line after the thousandth, is a difference", LINUX, () => {
  // The two read as one "X-Test: alpha" once a client parses them.
  const ws = answers("answers-whitespace", rawly("HTTP/1.1 200 OK\r\nX-Test:\t alpha  \r\n"), rawly("HTTP/1.1 200 OK\r\nX-Test: alpha\r\n"), 60);
  assert.equal(ws.status, 4, ws.said);
  assert.ok(readFileSync(join(ws.answers, "diff.txt"), "latin1").startsWith("2c2\n< X-Test:\t alpha  \n---\n> X-Test: alpha\n"), ws.said);
  const many = (last) => `HTTP/1.1 200 OK\r\n${Array.from({ length: 1000 }, (_, i) => `x-${i}: ${i}\r\n`).join("")}x-last: ${last}\r\n`;
  const far = answers("answers-thousand", rawly(many("a")), rawly(many("b")), 60);
  assert.equal(far.status, 4, far.said);
  assert.ok(readFileSync(join(far.answers, "diff.txt"), "latin1").startsWith("1002c1002\n< x-last: a\n---\n> x-last: b\n"), far.said);
});

test("the answers check on real servers: the difference is the system diff's of the two masked headers, B,A,B against A,A,B one change", LINUX, () => {
  const r = answers("answers-diff", rawly("HTTP/1.1 200 OK\r\nx: B\r\nx: A\r\nx: B\r\n"), rawly("HTTP/1.1 200 OK\r\nx: A\r\nx: A\r\nx: B\r\n"), 60);
  assert.equal(r.status, 4, r.said);
  const diff = readFileSync(join(r.answers, "diff.txt"), "utf8"), system = spawnSync("diff", [join(r.answers, "A.headers"), join(r.answers, "B.headers")], { encoding: "utf8" }).stdout;
  assert.equal(diff, `${system}bodies same: 4 bytes, sha256 ${full("aaaa")}\n`);
  assert.ok(diff.startsWith("2c2\n< x: B\n---\n> x: A\n"), diff);
});

test("the answers check on real servers: answers of another status than the plan's fail it, whatever a head on PATH prints of them, with no verdict and no counts", LINUX, () => {
  // Both sides answer the page 503 alike, and the plan asks for 200. A stand-in for head prints a
  // status line of the plan's status and ends 2: a status check that read its output and not its
  // status would take the two 503s as the plan's answers, the same.
  const first = stand("headed", "head", "echo 'HTTP/1.1 200 OK'\nexit 2");
  const r = answers("answers-unavailable", answering(503, "busy"), answering(503, "busy"), 60, { first });
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("turns: plain: HTTP/1.1 503 Service Unavailable from A on 18081") && r.said.includes("not status 200"), r.said);
  assert.ok(!r.said.includes("answers: same") && !r.said.includes("answer differently") && !r.said.includes("handoff sha256"), r.said);
  assert.ok(!existsSync(join(r.answers, "verdict.txt")) && !existsSync(join(r.answers, "handoff.json")) && !existsSync(join(r.answers, "..", "counts-plain.csv")), r.said);
});

test("the answers check on real servers: answers that differ, after which a server is left listening, are no recorded difference, and the command reads none", LINUX, () => {
  // A START that forks the server and execs a sleep, which serve.mjs then holds: its stop ends the
  // sleep and leaves each server listening, until it ends by itself 10 s after it starts. The two
  // answer differently, so the difference is found before the stop that fails.
  const r = answers("answers-left", brief("aaaa", 10000), brief("bbbb", 10000), 60, { start: "$BIN $PORT & exec sleep 30", linger: 15000 });
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("turns: plain: something still accepts on 18081 after A's server was stopped (curl status 0)"), r.said);
  assert.ok(r.said.includes("turns: plain: A and B's answers differ, and stopping their servers after the check failed or is unconfirmed: not read as a difference"), r.said);
  assert.ok(!r.said.includes("A and B answer differently"), r.said);
  // The diff was made before the stop, so it is there: the status and the missing line, which
  // the command's own test above holds it to, are what keep it from being recorded.
  assert.equal(readFileSync(join(r.answers, "diff.txt"), "utf8"), `bodies differ: 4 and 4 bytes, sha256 ${full("aaaa")} and ${full("bbbb")}\n`);
});

test("the answers check on real servers: the same answers, after which a server is left listening, leave no passing verdict", LINUX, () => {
  // As above, but A and B answer the same: the verdict waits for the stop, which fails, so
  // neither "answers: same" nor answers/verdict.txt says the placement passed.
  const r = answers("answers-left-same", brief("aaaa", 10000), brief("aaaa", 10000), 60, { start: "$BIN $PORT & exec sleep 30", linger: 15000 });
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("turns: plain: something still accepts on 18081 after A's server was stopped (curl status 0)"), r.said);
  assert.ok(r.said.includes("turns: plain: stopping the two servers after their answers were compared failed or is unconfirmed: no verdict"), r.said);
  assert.ok(!r.said.includes("answers: same") && !existsSync(join(r.answers, "verdict.txt")), r.said);
  assert.equal(readFileSync(join(r.answers, "diff.txt"), "utf8"), "");
});

test("the answers check on real servers: a difference in the headers alone holds a placement to the body the two sides share", LINUX, () => {
  const recorded = answers("answers-headers", serve("aaaa", "a"), serve("aaaa", "b"), 60);
  assert.equal(recorded.status, 4, recorded.said);
  const difference = readFileSync(join(recorded.answers, "diff.txt"), "utf8");
  assert.equal(difference.split("\n").at(-2), `bodies same: 4 bytes, sha256 ${full("aaaa")}`, difference);
  assert.match(difference, /^(\d+)c\1\n< x-side: a\n---\n> x-side: b\nbodies same: /, difference);
  // That difference expected: the same two answers pass, and another body both sides share, of
  // the same length, does not, though the headers differ just as they did.
  const held = answers("answers-headers-held", serve("aaaa", "a"), serve("aaaa", "b"), 60, { expect: difference });
  assert.equal(held.status, 0, held.said);
  const shared = answers("answers-headers-shared", serve("cccc", "a"), serve("cccc", "b"), 60, { expect: difference });
  assert.equal(shared.status, 1, shared.said);
  assert.ok(shared.said.includes("turns: plain: the answers differ other than as the plan's expected difference says"), shared.said);
});

test("the answers check on real servers: a diff.txt that cannot be written fails it, and does not read as the same answers", LINUX, () => {
  // B, as it answers, makes diff.txt a link to a directory that is not there, just before the check
  // creates it: something is there already, so diff.txt cannot be created as the check's own.
  const r = answers("answers-unwritable", serve("aaaa"), planting("aaaa", 'fs.symlinkSync("/nonexistent/diff.txt", f);'), 60);
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("answers/diff.txt cannot be written") && !r.said.includes("answers: same"), r.said);
});

test("the answers check on real servers: something put at diff.txt while the answers are compared fails it, and is neither written over nor read as the difference", LINUX, () => {
  // B, as it answers, puts an empty file at diff.txt, or a link to /dev/null (every write to which
  // succeeds and leaves it empty): no check of the path stands between that and the create, which
  // is itself exclusive (answers.mjs), so either is something there before it, and refused, for
  // answers that differ in their headers, in their bodies, or not at all.
  for (const [kind, put] of [["emptied", 'fs.writeFileSync(f, "");'], ["swallowed", 'fs.symlinkSync("/dev/null", f);']]) {
    for (const [name, base, head] of [[`answers-${kind}-headers`, serve("aaaa", "a"), planting("aaaa", put, "b")], [`answers-${kind}-bodies`, serve("aaaa"), planting("bbbb", put)], [`answers-${kind}-same`, serve("aaaa"), planting("aaaa", put)]]) {
      const r = answers(name, base, head, 60);
      assert.equal(r.status, 1, `${name}: ${r.said}`);
      assert.ok(r.said.includes("answers/diff.txt cannot be written as a new file: something is there before the check made it") && !r.said.includes("answers: same") && !r.said.includes("answer differently"), `${name}: ${r.said}`);
      assert.ok(!existsSync(join(r.answers, "verdict.txt")), `${name}: ${r.said}`);
    }
  }
});

test("the answers check on real servers: a two-hunk difference in the headers is held whole, so a diff.txt left holding its first hunk alone, with that hunk expected, fails it", LINUX, () => {
  // Two headers that differ, with one between them that does not: two hunks.
  const twice = (side) => `require("node:http").createServer((q, s) => { s.setHeader("x-one", ${JSON.stringify(side)}); s.setHeader("content-type", "text/plain"); s.setHeader("x-two", ${JSON.stringify(side)}); s.end("aaaa"); }).listen(Number(process.argv[2]), "127.0.0.1");`;
  const recorded = answers("answers-hunks", twice("a"), twice("b"), 60);
  assert.equal(recorded.status, 4, recorded.said);
  const difference = readFileSync(join(recorded.answers, "diff.txt"), "utf8");
  assert.match(difference, /^(\d+)c\1\n< x-one: a\n---\n> x-one: b\n(\d+)c\2\n< x-two: a\n---\n> x-two: b\nbodies same: 4 bytes, sha256 [0-9a-f]{64}\n$/, difference);
  const lines = difference.split("\n"), hunk = `${lines.slice(0, 4).join("\n")}\n`, one = `${hunk}${lines.at(-2)}\n`;
  // The whole difference expected passes; its first hunk alone, with the right bodies line, does not.
  const held = answers("answers-hunks-held", twice("a"), twice("b"), 60, { expect: difference });
  assert.equal(held.status, 0, held.said);
  assert.ok(held.said.includes("answers: differ only as the plan's expected difference says"), held.said);
  const short = answers("answers-hunks-short", twice("a"), twice("b"), 60, { expect: one });
  assert.equal(short.status, 1, short.said);
  assert.ok(short.said.includes("turns: plain: the answers differ other than as the plan's expected difference says"), short.said);
  // B, as it answers, writes the first hunk alone to diff.txt: what is compared with the expected
  // difference is the difference of the answers, both hunks, and diff.txt, there before the check
  // writes it, is refused rather than read.
  const dropping = twice("b").replace("(q, s) => {", `(q, s) => { if (q.url !== "/" && !require("node:fs").existsSync(require("node:path").join(__dirname, "..", "compare", "answers", "diff.txt"))) require("node:fs").writeFileSync(require("node:path").join(__dirname, "..", "compare", "answers", "diff.txt"), ${JSON.stringify(hunk)});`);
  assert.notEqual(dropping, twice("b"));
  const r = answers("answers-hunks-dropped", twice("a"), dropping, 60, { expect: one });
  assert.equal(r.status, 1, r.said);
  assert.ok(!r.said.includes("differ only as") && !existsSync(join(r.answers, "verdict.txt")), r.said);
  assert.ok(r.said.includes("answers/diff.txt cannot be written as a new file: something is there before the check made it"), r.said);
  assert.equal(readFileSync(r.expected, "utf8"), one, "the expected difference was changed");
});

test("the answers check on real servers: a diff.txt linked to the expected difference fails it, and the expected difference is left as it was", LINUX, () => {
  // Expected: the difference of aaaa and bbbb. The placement answers cccc, which it does not allow.
  const expect = `bodies differ: 4 and 4 bytes, sha256 ${full("aaaa")} and ${full("bbbb")}\n`;
  // A, as it first answers, or B, as it answers, links diff.txt to the expected difference: a write
  // through the link would truncate that file, take the difference found, and leave the two the
  // same. The check writes diff.txt as a new file, so the link is refused and goes untouched.
  for (const [name, side] of [["prelinked", "base"], ["relinked", "head"]]) {
    const put = `fs.symlinkSync(${JSON.stringify(join(tmp, `answers-${name}`, "plan", "expect.txt"))}, f);`;
    const r = answers(`answers-${name}`, side === "base" ? planting("aaaa", put) : serve("aaaa"), side === "head" ? planting("cccc", put) : serve("cccc"), 60, { expect });
    assert.equal(readFileSync(r.expected, "utf8"), expect, `${name}: the expected difference was written through the link`);
    assert.equal(r.status, 1, `${name}: ${r.said}`);
    assert.ok(r.said.includes("answers/diff.txt cannot be written as a new file: something is there before the check made it") && !r.said.includes("differ only as"), `${name}: ${r.said}`);
  }
});

test("the answers check on real servers: no request goes through a proxy of the environment's, so one that answers everything cannot stand in for the servers", LINUX, async () => {
  // A proxy that answers every request 200 and notes it, ending by itself 20 s after it starts;
  // the test waits for that rather than signal it.
  const dir = join(tmp, "proxy");
  mkdirSync(dir, { recursive: true });
  const script = `const fs = require("node:fs"), at = (f) => require("node:path").join(process.argv[1], f);
setTimeout(() => process.exit(0), 20000);
const s = require("node:http").createServer((q, r) => { fs.appendFileSync(at("proxied"), q.url + "\\n"); r.end("proxy"); });
s.listen(0, "127.0.0.1", () => fs.writeFileSync(at("port"), String(s.address().port)));`;
  const child = spawn(process.execPath, ["-e", script, dir], { stdio: "ignore" });
  const ended = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
  let port = null;
  for (let i = 0; i < 200 && port === null; i++) { try { port = Number(readFileSync(join(dir, "port"), "utf8")); } catch { await new Promise((done) => setTimeout(done, 25)); } }
  assert.ok(port, "the stand-in proxy never listened");
  const url = `http://127.0.0.1:${port}`, env = { http_proxy: url, HTTP_PROXY: url, ALL_PROXY: url, all_proxy: url, NO_PROXY: "", no_proxy: "" };
  const r = answers("answers-proxied", serve("aaaa"), serve("aaaa"), 60, { env });
  const proxied = existsSync(join(dir, "proxied")) ? readFileSync(join(dir, "proxied"), "utf8") : "";
  const end = await Promise.race([ended, new Promise((done) => setTimeout(() => done(null), 25000))]);
  if (end === null) child.kill("SIGKILL");
  assert.notEqual(end, null, "the stand-in proxy was still running past its own 20 s bound");
  assert.equal(proxied, "", "requests went to the proxy");
  assert.equal(r.status, 0, r.said);
  assert.ok(r.said.includes("answers: same"), r.said);
});

test("the answers check on real servers: an answer cut short fails it, and does not read as a difference or the same answers", LINUX, () => {
  const cut = 'require("node:http").createServer((q, s) => { if (q.url === "/") return s.end("ok"); s.setHeader("content-length", "10"); s.write("aaaa"); setTimeout(() => s.socket.destroy(), 50); }).listen(Number(process.argv[2]), "127.0.0.1");';
  const r = answers("answers-cut", serve("aaaa"), cut, 60);
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("turns: plain: the answer on 18082 could not be taken whole: curl ended with status 18") && !r.said.includes("answers: same") && !r.said.includes("answer differently"), r.said);
});

// turns.sh's servers are stopped however it ends, within a bound, though they ignore TERM. No test
// signals a fixture server, by number or otherwise: each ends by itself LIFE after it starts, and
// the test waits for that rather than kill a number that may by then name another process.
// Whether one still runs is asked of a socket of its own, which takes a connection while it runs
// and refuses one once it has ended.
const LIFE = 45000;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const noted = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; } };
/** Whether the fixture whose liveness socket this is still runs: it takes a connection. */
const alive = (sock) => new Promise((done) => { const c = connect(sock); c.on("connect", () => { c.destroy(); done(true); }); c.on("error", () => done(false)); });
/** The liveness sockets under dir of fixtures that still run, and the kit's ports that still take a connection. */
async function left(dir) {
  const running = [];
  for (const f of readdirSync(dir).filter((f) => /^alive-\d+\.sock$/.test(f))) if (await alive(join(dir, f))) running.push(f);
  return { running, busy: [18081, 18082].filter(taken) };
}
/**
 * A server as turns.sh starts one (<binary> <port>), writing beside the work directory's bin/:
 * its pid to pids when it starts, its liveness socket alive-<pid>.sock, and its pid to terms when
 * sent TERM, which it ignores (with yields, ends at once on it). It answers body, and never
 * answers a request for hang (/hang), or with mute any request, writing its pid to hung, and with
 * readied writes its pid to readied as it answers a readiness request (for /). start: code it
 * runs as it starts, with at() and note() to hand.
 */
const stubborn = (body, mute = false, { hang = "/hang", yields = false, start = "", readied = false } = {}) => `#!/usr/bin/env node
const at = (f) => require("node:path").join(__dirname, "..", f), note = (f) => require("node:fs").appendFileSync(at(f), process.pid + "\\n");
setTimeout(() => process.exit(0), ${LIFE});
require("node:net").createServer((c) => c.destroy()).listen(at("alive-" + process.pid + ".sock"));
${start}
note("pids");
process.on("SIGTERM", () => { note("terms");${yields ? " process.exit(0);" : ""} });
require("node:http").createServer((q, s) => { if (${readied} && q.url === "/") note("readied"); if (${mute} || q.url === ${JSON.stringify(hang)}) note("hung"); else { s.setHeader("content-type", "text/plain"); s.end(${JSON.stringify(body)}); } }).listen(Number(process.argv[2]), "127.0.0.1");
`;
/**
 * turns.sh with no pair, A and B such servers answering base and head, as this test's own child
 * (killed through its handle at 60 s). signal is sent to turns.sh alone, through that handle, once
 * the work directory's file when holds a line. Returns as soon as turns.sh has exited, with what
 * still runs at that moment; the test then waits, past LIFE, for the servers to have ended.
 * servers: a script for a side (base or head) in place of stubborn(its body); before: run with
 * the work directory once the kit's ports are found free, before turns.sh is started. first: a
 * directory put first on turns.sh's PATH, of stand-ins for tools it runs; closing: how long, after
 * turns.sh has exited, to wait for its output to close before returning; pairs: turns.sh's;
 * delay: how long after when holds a line to send signal.
 */
async function stopping(t, name, { base, head, path = "/page", signal = null, when = null, servers = {}, before = null, first = null, closing = 12000, pairs = 0, delay = 0 }) {
  const cpu = /: *(\d+)/.exec(spawnSync("taskset", ["-cp", String(process.pid)], { encoding: "utf8" }).stdout)?.[1];
  assert.ok(cpu, "taskset names no CPU this process may run on");
  for (const port of [18081, 18082]) assert.ok(!taken(port), `port ${port} is in use, and the kit's ports are fixed: this test needs 18081 and 18082 free`);
  const work = join(tmp, name), plan = join(work, "plan");
  mkdirSync(plan, { recursive: true });
  mkdirSync(join(work, "bin"));
  for (const [f, text] of [["headers.txt", ""], ["mask.sed", ""], ["mask.json", "[]\n"], ["request.lua", ""]]) writeFileSync(join(plan, f), text);
  for (const [side, body] of [["base", base], ["head", head]]) writeFileSync(join(work, "bin", side), servers[side] ?? stubborn(body), { mode: 0o755 });
  t.after(async () => {
    const until = Date.now() + LIFE + 5000;
    for (let l = await left(work); l.running.length > 0 || l.busy.length > 0; l = await left(work)) {
      if (Date.now() > until) throw new Error(`fixture servers still running past their own bound: ${l.running.join(", ")} ${l.busy.join(", ")}`);
      await wait(200);
    }
  });
  if (before !== null) await before(work);
  const env = { ...process.env, KIT: here, PORT_A: "18081", PORT_B: "18082", START: "$BIN $PORT", REQ_PATH: path, STATUS: "200", EVENTS: "cycles:u", CPU_SERVER: cpu, CPU_LOAD: cpu, WRK_T: "1", WRK_C: "1", TURN: "1", WARMUP: "0", EXPECT: "", HEADERS: join(plan, "headers.txt"), SCRIPT: join(plan, "request.lua"), MASK: join(plan, "mask.sed"), MASK_JSON: join(plan, "mask.json"), ...(first ? { PATH: `${first}:${process.env.PATH}` } : {}) };
  const began = Date.now(), child = spawn("sh", [join(here, "turns.sh"), join(work, "compare"), "plain", String(pairs), join(work, "bin", "base"), join(work, "bin", "head")], { stdio: ["ignore", "pipe", "pipe"], env });
  let said = "";
  child.stdout.on("data", (d) => { said += d; });
  child.stderr.on("data", (d) => { said += d; });
  const exited = new Promise((done) => child.on("exit", (status, sig) => done({ status, signal: sig })));
  const closed = new Promise((done) => child.on("close", done));
  const limit = setTimeout(() => child.kill("SIGKILL"), 60000);
  let sent = false, sentTime = null;
  if (signal !== null) {
    while (noted(join(work, when)).length === 0 && child.exitCode === null && child.signalCode === null && Date.now() - began < 30000) await wait(20);
    if (delay > 0) await wait(delay);
    if (noted(join(work, when)).length > 0 && child.exitCode === null && child.signalCode === null) { child.kill(signal); sent = true; sentTime = Date.now(); }
  }
  const end = await exited, ended = Date.now(), now = await left(work);
  clearTimeout(limit);
  // What turns.sh said, once its output has closed (at most a few seconds more: a curl it started may hold it).
  await Promise.race([closed, wait(closing)]);
  return { ...end, said, work, sent, sentTime, endedTime: ended, seconds: (ended - began) / 1000, ...now };
}

test("turns.sh, whose answers differ, sent TERM while it stops servers that ignore TERM, finishes the stop before it ends, says no difference, and nothing is left listening", LINUX, async (t) => {
  // The servers' own record of TERM says the stop has begun; TERM is then sent to turns.sh alone
  // and must not cut that stop short. (The placement's timeout sends its TERM to turns.sh's whole
  // process group, the servers included: the test after this one holds that.) A signal during the
  // stop leaves that stop unconfirmed as the difference's, so turns.sh ends 1 and says none.
  const r = await stopping(t, "stop-term", { base: "aaaa", head: "bbbb", signal: "SIGTERM", when: "terms" });
  assert.ok(r.sent, `the stop never began, or turns.sh ended before TERM could be sent: ${r.said}`);
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes(`bodies differ: 4 and 4 bytes, sha256 ${full("aaaa")} and ${full("bbbb")}`) && !r.said.includes("A and B answer differently"), r.said);
  assert.deepEqual(r.running, [], `a server turns.sh started was still running when turns.sh ended: ${r.said}`);
  assert.deepEqual(r.busy, [], `something still answered on the kit's ports when turns.sh ended: ${r.said}`);
  assert.ok(r.seconds < 20, `turns.sh took ${r.seconds} s to stop its servers`);
});

test("the answers check under its own deadline, whose TERM reaches turns.sh's whole process group, servers that ignore TERM included, ends with timeout's status and nothing is left listening", LINUX, async (t) => {
  // The command's own check, timeout and all, with A in a request it never answers: at the
  // deadline timeout sends TERM to the group, turns.sh, its curl, both serve.mjs and both servers;
  // the servers ignore it and serve.mjs, sent it too, stops each with KILL 5 s later. What still
  // runs is asked at the moment the check exits, not once its output closes.
  const seconds = 3, { work, command, expected } = check("deadline-group", stubborn("aaaa").replace(/^#!.*\n/, ""), stubborn("aaaa").replace(/^#!.*\n/, ""), seconds, { path: "/hang" });
  t.after(async () => {
    const until = Date.now() + LIFE + 5000;
    for (let l = await left(work); l.running.length > 0 || l.busy.length > 0; l = await left(work)) {
      if (Date.now() > until) throw new Error(`fixture servers still running past their own bound: ${l.running.join(", ")} ${l.busy.join(", ")}`);
      await wait(200);
    }
  });
  const began = Date.now(), child = spawn("sh", ["-c", command, "sh", work, expected], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stdout.on("data", (d) => { said += d; });
  child.stderr.on("data", (d) => { said += d; });
  const closed = new Promise((done) => child.on("close", done));
  const limit = setTimeout(() => child.kill("SIGKILL"), 60000);
  const end = await new Promise((done) => child.on("exit", (status, sig) => done({ status, signal: sig })));
  const took = (Date.now() - began) / 1000, now = await left(work);
  clearTimeout(limit);
  await Promise.race([closed, wait(12000)]);
  assert.deepEqual(end, { status: 124, signal: null }, said);
  assert.equal(noted(join(work, "hung")).length, 1, `the request never reached A: ${said}`);
  const pids = noted(join(work, "pids")), terms = noted(join(work, "terms"));
  assert.equal(pids.length, 2, said);
  assert.ok(pids.every((p) => terms.includes(p)), `a server was not sent TERM: pids ${pids}, terms ${terms}: ${said}`);
  assert.deepEqual(now.running, [], `a server was still running when the check exited: ${said}`);
  assert.deepEqual(now.busy, [], `something still answered on the kit's ports when the check exited: ${said}`);
  // The deadline, then KILL 5 s after the TERM the servers ignore: well short of timeout's own KILL 30 s on.
  assert.ok(took >= seconds && took < seconds + 15, `the check took ${took} s`);
  assert.ok(!said.includes("A and B answer differently") && !said.includes("answers: same"), said);
});

test("turns.sh stops two servers that ignore TERM after the answers check within a bound, KILL 5 s after TERM, and nothing is left listening", LINUX, async (t) => {
  const r = await stopping(t, "stop-stubborn", { base: "aaaa", head: "aaaa" });
  assert.equal(r.status, 0, r.said);
  assert.ok(r.said.includes("answers: same"), r.said);
  assert.equal(noted(join(r.work, "pids")).length, 2, r.said);
  assert.equal(noted(join(r.work, "terms")).length, 2, `each server was not sent TERM once: ${r.said}`);
  assert.deepEqual(r.running, [], `a server turns.sh started was still running when turns.sh ended: ${r.said}`);
  assert.deepEqual(r.busy, [], "something still answered on the kit's ports when turns.sh ended");
  // The two are stopped together: TERM, ignored, then KILL 5 s later, well short of their own bound.
  assert.ok(r.seconds >= 4.5 && r.seconds < 15, `turns.sh took ${r.seconds} s to stop two servers that ignore TERM`);
});

test("turns.sh, killed outright while its servers run, still has them stopped within a bound, though they ignore TERM", LINUX, async (t) => {
  // A's answer is never sent, so turns.sh is in that request's curl (bounded to 10 s) when it is
  // killed. turns.sh sends no signal by number: a server is stopped by serve.mjs when turns.sh's
  // end of its input closes, which a KILL of turns.sh closes too and the curl does not hold. The
  // bound is counted from the KILL, short of the curl's 10 s and of the servers' own bound.
  const bound = 9000;
  const r = await stopping(t, "stop-killed", { base: "aaaa", head: "aaaa", path: "/hang", signal: "SIGKILL", when: "hung" });
  assert.ok(r.sent, `the request never reached A, or turns.sh ended before it could be killed: ${r.said}`);
  let now = { running: r.running, busy: r.busy };
  while ((now.running.length > 0 || now.busy.length > 0) && Date.now() - r.sentTime < bound) { await wait(100); now = await left(r.work); }
  const ms = Date.now() - r.sentTime;
  assert.equal(noted(join(r.work, "pids")).length, 2, r.said);
  assert.deepEqual(now.running, [], `a server turns.sh started was still running ${ms} ms after turns.sh was killed`);
  assert.deepEqual(now.busy, [], `something still answered on the kit's ports ${ms} ms after turns.sh was killed`);
});

test("turns.sh, killed outright while answers.mjs waits on B's answer, still has its servers stopped within the same bound", LINUX, async (t) => {
  // B takes the request for the page and never answers it, so answers.mjs, which has A's two
  // answers, waits (bounded to 10 s) when turns.sh is killed: given the shell's ends of the
  // servers' inputs it would keep both servers running. It also holds turns.sh's output open, so
  // the servers are looked at from the KILL on, not once that output has closed.
  const bound = 9000;
  const r = await stopping(t, "stop-killed-answers", { base: "aaaa", head: "aaaa", servers: { head: stubborn("aaaa", false, { hang: "/page" }) }, signal: "SIGKILL", when: "hung", closing: 0 });
  assert.ok(r.sent, `the request never reached B, or turns.sh ended before it could be killed: ${r.said}`);
  let now = { running: r.running, busy: r.busy };
  while ((now.running.length > 0 || now.busy.length > 0) && Date.now() - r.sentTime < bound) { await wait(100); now = await left(r.work); }
  const ms = Date.now() - r.sentTime;
  assert.equal(noted(join(r.work, "pids")).length, 2, r.said);
  assert.deepEqual(now.running, [], `a server turns.sh started was still running ${ms} ms after turns.sh was killed in answers.mjs`);
  assert.deepEqual(now.busy, [], `something still answered on the kit's ports ${ms} ms after turns.sh was killed in answers.mjs`);
});

test("turns.sh, killed outright while B's start waits to open its log (a FIFO there), still has A's server stopped within the same bound", LINUX, async (t) => {
  // A, as it starts, puts a FIFO at B's log, which turns.sh has already made: B's start then waits
  // in the open of that log for its error output, before serve.mjs runs. turns.sh is killed while
  // it waits, a second after A answered its readiness request. A start that took its log before
  // it closed the shell's ends of the servers' inputs would hold A's open the whole time, and A's
  // server would keep running.
  const bound = 9000, work = join(tmp, "stop-killed-starting"), log = join(work, "compare", "serve-B.log");
  const fifoed = 'require("node:fs").rmSync(at("compare/serve-B.log"), { force: true }); require("node:child_process").execFileSync("mkfifo", [at("compare/serve-B.log")]);';
  // Then the FIFO is opened to read (without waiting), so B's start goes on and, its input already
  // ended, has its server stopped; it is held open until every fixture has ended.
  t.after(async () => {
    let fd = null;
    try { fd = openSync(log, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return; }
    for (const until = Date.now() + LIFE + 5000; Date.now() < until;) { const l = await left(work); if (l.running.length === 0 && l.busy.length === 0) break; await wait(200); }
    closeSync(fd);
  });
  const r = await stopping(t, "stop-killed-starting", { base: "aaaa", head: "aaaa", servers: { base: stubborn("aaaa", false, { start: fifoed, readied: true }) }, signal: "SIGKILL", when: "readied", delay: 1000, closing: 0 });
  assert.ok(r.sent, `A never answered its readiness request, or turns.sh ended before it could be killed: ${r.said}`);
  // B's start is waiting in its log's open: A alone has started.
  assert.equal(noted(join(r.work, "pids")).length, 1, r.said);
  let now = await left(r.work);
  while ((now.running.length > 0 || now.busy.length > 0) && Date.now() - r.sentTime < bound) { await wait(100); now = await left(r.work); }
  const ms = Date.now() - r.sentTime;
  assert.deepEqual(now.running, [], `A's server was still running ${ms} ms after turns.sh was killed while B's start waited on its log`);
  assert.deepEqual(now.busy, [], `something still answered on the kit's ports ${ms} ms after turns.sh was killed while B's start waited on its log`);
});

/**
 * turns.sh with one pair, the servers ending at once on TERM, and stand-ins for perf and wrk: perf
 * writes perf, and wrk prints wrk, each as given (bytes, a NUL included). Returns what stopping()
 * does and the raw log's bytes and the CSV's text, or null for one that is not there.
 */
async function turned(t, name, perf, wrk, { once = false } = {}) {
  const dir = join(tmp, `${name}-tools`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "perf.out"), perf);
  writeFileSync(join(dir, "wrk.out"), wrk);
  const cat = spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim();
  // once: perf writes its output for the first turn alone, and for the next writes nothing.
  const first = once ? `[ -e '${join(dir, "wrote")}' ] && exit 0; : >'${join(dir, "wrote")}'; ` : "";
  stand(`${name}-tools`, "perf", `${first}while [ $# -gt 0 ]; do [ "$1" = -o ] && { '${cat}' '${join(dir, "perf.out")}' >"$2"; exit 0; }; shift; done; exit 2`);
  stand(`${name}-tools`, "wrk", `exec '${cat}' '${join(dir, "wrk.out")}'`);
  const yielding = stubborn("aaaa", false, { yields: true });
  const r = await stopping(t, name, { base: "aaaa", head: "aaaa", servers: { base: yielding, head: yielding }, first: dir, pairs: 1 });
  const at = (f) => (existsSync(join(r.work, "compare", f)) ? readFileSync(join(r.work, "compare", f)) : null);
  return { ...r, raw: at("raw-plain.log"), csv: at("counts-plain.csv")?.toString() ?? null };
}
const RESULTS = "RESULT 100 0 0 0 0 0\n", COUNTED = "12345,,cycles:u,1000,100.00,,\n";

test("turns.sh records a turn from its perf and wrk output as they are, a NUL byte included, in the raw log", LINUX, async (t) => {
  const perf = Buffer.from(`# started\n\0 a NUL\n${COUNTED}`, "latin1");
  const r = await turned(t, "turned-nul", perf, RESULTS);
  assert.equal(r.status, 0, r.said);
  assert.equal(r.csv, "pair,version,requests,cycles_u\n1,base,100,12345\n1,head,100,12345\n");
  const turn = (v) => Buffer.concat([Buffer.from(`## pair 1 ${v}\n`), perf, Buffer.from(RESULTS)]);
  assert.deepEqual(r.raw, Buffer.concat([turn("base"), turn("head")]), "the raw log is not the turns' output byte for byte");
});

for (const [what, perf, wrk, word] of [
  ["two incomplete RESULT lines, which joined make six counts", COUNTED, "RESULT 100 0 0\nRESULT 0 0 0\n", "2 RESULT lines from wrk in pair 1 base"],
  ["a counter at 100oops, which reads as a number as 100", COUNTED.replace("100.00", "100oops"), RESULTS, 'counter not at 100% in pair 1 base: cycles:u "100oops"'],
  ["a counter at 99.99999999999999999, which reads as a number as 100", COUNTED.replace("100.00", "99.99999999999999999"), RESULTS, 'counter not at 100% in pair 1 base: cycles:u "99.99999999999999999"'],
  ["a row cut short at 100, which is no complete row", "12345,,cycles:u,1000,100", RESULTS, "perf's output in pair 1 base does not end with a complete row"],
]) test(`turns.sh refuses a turn whose output has ${what}, and records no row`, LINUX, async (t) => {
  const r = await turned(t, `turned-${what.split(" ")[0]}-${what.length}`, perf, wrk);
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes(`turns: plain: ${word}`), r.said);
  assert.equal(r.csv, "pair,version,requests,cycles_u\n", r.said);
  assert.ok(!r.said.includes(": done, "), r.said);
});

test("turns.sh reads each turn's output from files of that turn's own, so a perf that writes nothing for the second turn records nothing for it, not the first turn's counts", LINUX, async (t) => {
  const r = await turned(t, "turned-stale", COUNTED, RESULTS, { once: true });
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("turns: plain: cycles:u not reported once in pair 1 head"), r.said);
  assert.equal(r.csv, "pair,version,requests,cycles_u\n1,base,100,12345\n", r.said);
});

/**
 * A server as stubborn() makes one but for TERM: on TERM it starts a process of its own session
 * (as a START that forks a worker might leave one) that is quiet for a moment and then listens on
 * its port, answering body, and then ends at once, so serve.mjs sees its stop end quickly. The
 * process it starts ends by itself 12 s on.
 */
const reopening = (body) => `#!/usr/bin/env node
const at = (f) => require("node:path").join(__dirname, "..", f), note = (f) => require("node:fs").appendFileSync(at(f), process.pid + "\\n");
setTimeout(() => process.exit(0), ${LIFE});
require("node:net").createServer((c) => c.destroy()).listen(at("alive-" + process.pid + ".sock"));
note("pids");
const port = Number(process.argv[2]), body = ${JSON.stringify(body)};
const answer = "(q, s) => { s.setHeader('content-type', 'text/plain'); s.end(" + JSON.stringify(body) + "); }";
const worker = "setTimeout(() => process.exit(0), 12000); setTimeout(() => require('node:http').createServer(" + answer + ").listen(" + port + ", '127.0.0.1'), 1500);";
process.on("SIGTERM", () => {
  note("terms");
  require("node:child_process").spawn(process.execPath, ["-e", worker], { detached: true, stdio: "ignore" }).unref();
  process.exit(0);
});
require("node:http").createServer((q, s) => { s.setHeader("content-type", "text/plain"); s.end(body); }).listen(port, "127.0.0.1");
`;

for (const [what, head, status] of [["that differ", "bbbb", 4], ["that are the same", "aaaa", 0]]) test(`turns.sh, after answers ${what}, checks no port until both servers have ended, so one opened again while the other's stop runs fails it`, LINUX, async (t) => {
  // A ends at once on TERM, leaving a process that opens A's port again 1.5 s later; B ignores
  // TERM, so its stop takes 5 s. A port checked when A's stop alone has ended is closed, and
  // turns.sh would say the stop was confirmed (${status}) with A's port answering.
  const r = await stopping(t, `stop-reopen-${head}`, { base: "aaaa", head, servers: { base: reopening("aaaa") } });
  assert.notEqual(r.status, status, r.said);
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("turns: plain: something still accepts on 18081 after A's server was stopped (curl status 0)"), r.said);
  // Neither a difference nor a passing verdict is said, or written to verdict.txt, before that stop passes.
  assert.ok(!r.said.includes("A and B answer differently") && !r.said.includes("answers: same"), r.said);
  assert.ok(!existsSync(join(r.work, "compare", "answers", "verdict.txt")), r.said);
  assert.ok(!r.said.includes(": done, "), r.said);
  assert.equal(noted(join(r.work, "terms")).length, 2, `each server was not sent TERM once: ${r.said}`);
});

test("turns.sh, sent TERM alone while a readiness request waits on a server that takes the connection and never answers, ends within a bound with both servers stopped", LINUX, async (t) => {
  // B takes every connection and never answers, so turns.sh is in B's readiness request when TERM
  // reaches it, and the shell holds off its trap until that curl ends. Each such request is
  // bounded to a second, so turns.sh ends then, stopping both servers (KILL 5 s after the TERM they
  // ignore), well before the test's own KILL at 60 s.
  const r = await stopping(t, "stop-ready", { base: "aaaa", head: "aaaa", servers: { head: stubborn("aaaa", true) }, signal: "SIGTERM", when: "hung" });
  assert.ok(r.sent, `B never took a readiness request, or turns.sh ended before TERM could be sent: ${r.said}`);
  const after = (r.endedTime - r.sentTime) / 1000;
  // The curl's second, then KILL 5 s after the servers' TERM.
  assert.ok(after < 10, `turns.sh ended ${after} s after its TERM: ${r.said}`);
  assert.deepEqual([r.status, r.signal], [1, null], r.said);
  assert.equal(noted(join(r.work, "pids")).length, 2, r.said);
  assert.equal(noted(join(r.work, "terms")).length, 2, `each server was not sent TERM once: ${r.said}`);
  assert.deepEqual(r.running, [], `a server turns.sh started was still running when turns.sh ended: ${r.said}`);
  assert.deepEqual(r.busy, [], `something still answered on the kit's ports when turns.sh ended: ${r.said}`);
});

test("turns.sh refuses at once a port something already takes connections on without answering, and starts no server", LINUX, async (t) => {
  // A listener on A's port that takes a connection and never answers, ending by itself 8 s on.
  let ended = null;
  const before = async (work) => {
    const ready = join(work, "listening");
    const child = spawn(process.execPath, ["-e", `setTimeout(() => process.exit(0), 8000); require("node:net").createServer(() => {}).listen(18081, "127.0.0.1", () => require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""));`], { stdio: "ignore" });
    ended = new Promise((done) => child.on("exit", done));
    t.after(() => Promise.race([ended, wait(15000)]));
    for (let i = 0; i < 200 && !existsSync(ready); i++) await wait(25);
    assert.ok(existsSync(ready), "the stand-in listener never listened");
  };
  const r = await stopping(t, "stop-preflight", { base: "aaaa", head: "aaaa", before });
  assert.equal(r.status, 1, r.said);
  assert.ok(r.said.includes("turns: plain: something already accepts on 18081 (curl status 28)"), r.said);
  assert.deepEqual(noted(join(r.work, "pids")), [], `a server was started: ${r.said}`);
  assert.ok(r.seconds < 5, `turns.sh took ${r.seconds} s to refuse the port`);
});
