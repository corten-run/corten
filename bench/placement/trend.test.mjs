// The trend: its plan, the plan a run reads from it, a workload's reading, the page's row and
// what a run past its threshold prints, and the command's steps in order with the kit's shell
// scripts stood in for (they need a bench host; plan.mjs is the kit's own here). That a gated
// part's report.json is what reading() takes is held in report.test.mjs, on results made there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as path } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { problems as planProblems } from "./plan.mjs";
import { insert, issue, latest, merged, PAGE, PLAN, problems, reading, resolved, row, rows, run, seed, TABLE, verdict } from "./trend.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = path(here, "..", "..");
const TREND = JSON.parse(readFileSync(PLAN, "utf8"));
const trend = (change = () => {}) => { const t = structuredClone(TREND); change(t); return t; };
const tmp = mkdtempSync(join(tmpdir(), "placement-trend-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const has = (why, word) => assert.ok(why.some((w) => w.includes(word)), `no "${word}" in: ${why.join(" | ") || "nothing"}`);
const BASE = "a833b4e3e55033c5fa179f50cb9291d190aeedfb", HEAD = "153d10e9cdac318b761ab5bed2c204889606701a", EARLIER = "c6e9be955bedd2766795eab240e061c1b14ee5d0";

/** A gated part's report.json as far as the trend reads it: the change's lower bound, bound and median, and its A/A. */
const report = (w, lower, bound, { resolution = "resolved", aa = [0.004, 0.002], K = 69, sized = { K }, dry = false, exit = 0 } = {}) => ({
  exit, dry, K, sized, gated: { resolution, changeBound: bound, changeMedian: lower == null ? 0.004 : (lower + bound) / 2, aaBound: aa[0], aaBoundSwapped: aa[1] },
  [`change-${w}`]: { measures: { "cycles, user and kernel": { recorded: { lower, bound } } } },
});

test("the trend's plan is usable, and each field that is not is named", () => {
  assert.deepEqual(problems(TREND), []);
  const bad = (change, word) => has(problems(trend(change)), word);
  assert.deepEqual(problems({ plan: 1 }), ['"trend": 1 is missing: not a trend plan this kit reads']);
  bad((t) => { t.base = BASE; }, 'base: "release", the highest tag vX.Y.Z');
  bad((t) => { t.head = HEAD; }, "head: a ref (origin/main)");
  bad((t) => { t.head = "main branch"; }, "head: a ref (origin/main)");
  bad((t) => { t.seed = 2026112401; }, 'seed: "date", the rule that gives each run its seeds');
  bad((t) => { t.threshold = 2; }, "threshold: the rise the trend reports, as a fraction");
  bad((t) => { delete t.threshold; }, "threshold");
  bad((t) => { t.margin = 0.01; }, '"margin" is not a field of a trend\'s plan');
  bad((t) => { t.plan = "plan.json"; }, "plan: a plan as plan.mjs reads one");
  // What only a run can give is not the plan's to state.
  bad((t) => { t.plan.base = BASE; }, 'plan.base: the run gives it, by the rule this file\'s "base" names');
  bad((t) => { t.plan.head = HEAD; }, "plan.head: the run gives it");
  bad((t) => { t.plan.workloads[1].seed = 7; }, "workload unstaged: seed: the run gives it, from its date");
  bad((t) => { t.plan.workloads[0].expect = "expect.txt"; }, "workload plain: expect: the run records how the release and main answer differently");
  bad((t) => { t.plan.workloads[0].K = 69; t.plan.workloads[0].sizedFrom = "last week's run"; }, 'workload plain: K: "pilot", since every run sizes K from its own pilot');
  bad((t) => { t.plan.probe.dir = "/srv/probe"; }, "plan.probe.dir: a path from this file to the probe's crate");
  // The rest is plan.mjs's to judge, on the plan a run would read.
  bad((t) => { t.plan.R = 0; }, "plan: R: recorded pairs");
  bad((t) => { t.plan.workloads[0].request.method = "POST"; }, 'plan: workload plain: request: "method" is not a field of a plan');
  bad((t) => { delete t.plan.pilot; }, 'plan: workload plain: K is "pilot" and the plan has no pilot');
  // The probe the plan names is in the repository, and each workload says why it is read.
  assert.ok(existsSync(join(dirname(PLAN), TREND.plan.probe.dir, "src", "main.rs")));
  for (const w of TREND.plan.workloads) assert.ok(w.declared.includes("In the trend because"), w.name);
});

test("the last release is the highest tag vX.Y.Z, whatever order the tags come in", () => {
  assert.equal(latest(["evidence/thread-cache-1979", "v0.2.0", "v0.10.1", "v0.9.12", "v0.10.0", "v1.0.0-rc.1", "v2", ""]), "v0.10.1");
  assert.equal(latest(["v1.0.0", "v0.99.99"]), "v1.0.0");
  assert.equal(latest(["evidence/placement-kit", "release"]), null);
});

test("a run's plan: the release, main and seeds from the date, a plan plan.mjs takes", () => {
  assert.deepEqual([seed("2026-12-02", 0), seed("2026-12-02", 1), seed("2027-01-01", 0)], [2026120201, 2026120202, 2027010101]);
  const p = resolved(TREND, { base: BASE, head: HEAD, date: "2026-12-02" });
  assert.deepEqual(planProblems(p), []);
  assert.deepEqual([p.plan, p.name, p.base, p.head, p.probe.dir, p.pilot.K], [1, "trend-2026-12-02", BASE, HEAD, "probe", 100]);
  assert.deepEqual(p.workloads.map((w) => [w.name, w.seed, w.K, w.expect]), [["plain", 2026120201, "pilot", undefined], ["unstaged", 2026120202, "pilot", undefined]]);
  // Everything else is the trend's plan as written, and the plan in the file is left as it was.
  assert.deepEqual({ ...p.probe, dir: TREND.plan.probe.dir }, TREND.plan.probe);
  assert.deepEqual([p.host, p.load, p.R, p.placementSeconds], [TREND.plan.host, TREND.plan.load, TREND.plan.R, TREND.plan.placementSeconds]);
  assert.equal(TREND.plan.workloads[0].seed, undefined);
  // Two runs on one date have one order; the next day's has another.
  assert.deepEqual(resolved(TREND, { base: BASE, head: HEAD, date: "2026-12-02" }), p);
  assert.notEqual(resolved(TREND, { base: BASE, head: HEAD, date: "2026-12-03" }).workloads[0].seed, p.workloads[0].seed);
  // A workload whose two sides answer differently names the file that holds the difference.
  const q = resolved(TREND, { base: BASE, head: HEAD, date: "2026-12-02", expect: { plain: "expect-plain.txt" } });
  assert.deepEqual([planProblems(q), q.workloads.map((w) => w.expect)], [[], ["expect-plain.txt", undefined]]);
});

test("a workload's reading: past the threshold on the lower bound, a pass under it, and not read for anything else", () => {
  const read = (...a) => { const r = reading(0.02, "plain", { report: report("plain", ...a) }); return [r.state, r.text]; };
  assert.deepEqual(read(0.004, 0.011), ["pass", "+0.40% to +1.10%, median +0.75%, K = 69, A/A resolved"]);
  // The bound over the threshold is not a rise shown: the lower bound decides.
  assert.deepEqual(read(0.0199, 0.031), ["pass", "+1.99% to +3.10%, median +2.54%, K = 69, A/A resolved"]);
  assert.deepEqual(read(0.02, 0.031), ["past", "+2.00% to +3.10%, median +2.55%, K = 69, A/A resolved"]);
  assert.deepEqual(read(-0.031, -0.024), ["pass", "-3.10% to -2.40%, median -2.75%, K = 69, A/A resolved"]);
  const past = reading(0.02, "plain", { report: report("plain", 0.021, 0.03) });
  assert.deepEqual([past.lower, past.bound, past.median], [0.021, 0.03, (0.021 + 0.03) / 2]);
  // An A/A that did not resolve is not read, whatever the change's bounds are.
  assert.deepEqual(read(-0.05, -0.04, { resolution: "not resolved", aa: [0.0103, 0.0079] }), ["not read", "the A/A did not resolve (bounds +1.03% and +0.79%, against +1%)"]);
  assert.deepEqual(read(0.05, 0.06, { resolution: "not resolved", aa: [0.0103, 0.0079] })[0], "not read");
  assert.deepEqual(read(0.001, 0.002, { resolution: "no bound" }), ["not read", "the A/A has no bound"]);
  // A comparison without all its placements has no bound; a K nothing checked is no reading.
  assert.deepEqual(read(null, null, { exit: 1 }), ["not read", "main against the release has no bound"]);
  assert.deepEqual(read(0.001, 0.002, { sized: null }), ["not read", "K was not checked by the kit"]);
  // A step that failed, results the kit refuses, and a part that left nothing.
  assert.deepEqual(reading(0.02, "plain", { why: "the probe does not build at v0.2.0" }).text, "the probe does not build at v0.2.0");
  assert.deepEqual(reading(0.02, "plain", { report: { exit: 2, refused: ["no run-id in the results: not a complete record of a run"] } }).text, "the kit refused the results: no run-id in the results: not a complete record of a run");
  assert.deepEqual([reading(0.02, "plain").state, reading(0.02, "plain").text], ["not read", "the gated part left no report"]);
  assert.equal(reading(0.02, "plain", { report: { exit: 0, pilot: {} } }).text, "the report is not a gated part's");
  // A dry run is read for nothing, and says so with its figures.
  const dry = reading(0.02, "plain", { report: report("plain", 0.03, 0.04, { dry: true, K: 6, sized: null }) });
  assert.deepEqual([dry.state, dry.text, dry.dry, dry.complete], ["not read", "DRY RUN, read for nothing (+3.00% to +4.00%, median +3.50%, K = 6)", true, true]);
});

test("a run's reading is a pass only when every workload passes", () => {
  const r = (workload, state) => ({ workload, state, text: "" });
  assert.equal(verdict(0.02, [r("plain", "pass"), r("unstaged", "pass")]), "pass at +2.00%");
  assert.equal(verdict(0.02, [r("plain", "past"), r("unstaged", "pass")]), "past +2.00%: `plain`");
  assert.equal(verdict(0.02, [r("plain", "pass"), r("unstaged", "not read")]), "not read: `unstaged`");
  assert.equal(verdict(0.015, [r("plain", "past"), r("unstaged", "not read")]), "past +1.50%: `plain`; not read: `unstaged`");
  assert.equal(verdict(0.02, [r("plain", "not read"), r("unstaged", "not read")]), "not read: `plain`, `unstaged`");
});

const at = (readings, more = {}) => ({ date: "2026-12-02", tag: "v0.2.0", base: BASE, head: HEAD, threshold: 0.02, readings, ...more });
const READ = [reading(0.02, "plain", { report: report("plain", 0.004, 0.011) }), reading(0.02, "unstaged", { report: report("unstaged", -0.002, 0.003, { K: 91 }) })];

test("the row: the run's date, the release and its commit, main's commit, each workload and the reading", () => {
  assert.equal(row(at(READ, { differ: ["plain"] })), "| 2026-12-02 | v0.2.0 `a833b4e3e` | `153d10e9c` | `plain` +0.40% to +1.10%, median +0.75%, K = 69, A/A resolved, answers differ; `unstaged` -0.20% to +0.30%, median +0.05%, K = 91, A/A resolved | pass at +2.00% |");
  const mixed = [reading(0.02, "plain", { report: report("plain", 0.021, 0.03) }), reading(0.02, "unstaged", { report: report("unstaged", 0, 0, { resolution: "not resolved", aa: [0.012, 0.001] }) })];
  assert.equal(row(at(mixed)), "| 2026-12-02 | v0.2.0 `a833b4e3e` | `153d10e9c` | `plain` +2.10% to +3.00%, median +2.55%, K = 69, A/A resolved; `unstaged` not read: the A/A did not resolve (bounds +1.20% and +0.10%, against +1%) | past +2.00%: `plain`; not read: `unstaged` |");
  // One reason for every workload is said once.
  const none = ["plain", "unstaged"].map((w) => reading(0.02, w, { why: "the probe does not build at v0.2.0" }));
  assert.equal(row(at(none)), "| 2026-12-02 | v0.2.0 `a833b4e3e` | `153d10e9c` | not read: the probe does not build at v0.2.0 | not read: `plain`, `unstaged` |");
  // What a step said is one cell, whatever it holds.
  assert.ok(row(at([reading(0.02, "plain", { why: "the pilot part ended verify-failed: a | b\n  c" })])).includes("| `plain` not read: the pilot part ended verify-failed: a \\| b c | not read: `plain` |"));
});

test("the page: a row is added under the table's heading, the newest first, and read back", () => {
  const page = readFileSync(PAGE, "utf8");
  // No run has been made: the page in the repository has its table and no row.
  assert.deepEqual(rows(page), []);
  assert.ok(page.endsWith(`${TABLE.join("\n")}\n`));
  const first = row(at(READ)), second = row(at(READ, { date: "2026-12-09", head: EARLIER }));
  const two = insert(insert(page, first), second);
  assert.equal(two, `${page}${second}\n${first}\n`);
  assert.deepEqual(rows(two).map((r) => [r.date, r.tag, r.base, r.head, r.reading]), [["2026-12-09", "v0.2.0", "a833b4e3e", "c6e9be955", "pass at +2.00%"], ["2026-12-02", "v0.2.0", "a833b4e3e", "153d10e9c", "pass at +2.00%"]]);
  // Every kind of row the command writes is read back, a cell with a bar in it too.
  const odd = row(at([reading(0.02, "plain", { why: "ended a | b" })]));
  assert.deepEqual(rows(insert(page, odd)).map((r) => [r.workloads, r.reading]), [["`plain` not read: ended a \\| b", "not read: `plain`"]]);
  // The head above the table is kept, and a page without the table is refused, not appended to.
  assert.ok(two.startsWith(page.slice(0, page.indexOf(TABLE[0]))));
  assert.throws(() => insert("# The trend\n\nNo table here.\n", first), /the page has no table of runs/);
  assert.throws(() => rows(`${page}| 2026-12-02 | by hand |\n`), /the page has a row trend\.mjs did not write: \| 2026-12-02 \| by hand \|/);
  // A page checked out with CRLF line ends keeps them.
  assert.equal(insert(page.replaceAll("\n", "\r\n"), first), `${page.replaceAll("\n", "\r\n")}${first}\r\n`);
});

const LOG = [
  [HEAD, "Merge pull request #2109 from corten-run/docs/catalog-probe-decides", "Let a probe read across placements decide a change's cycles\n\nIts description's first paragraph.\n"],
  ["9e209a32f1bf2b6201b1c15eca6ba894aa43e008", "Parse an allowed origin once (#2100)", "* a commit\n* another\n"],
  ["84658be3835db27572ddfd16bc03c1fd7c398e16", "Fix a typo in the guide", ""],
  ["f37f10652a07e2a6353d53ad6fe76825dbc48cd9", "Merge pull request #2106 from someone/a-fork", ""],
];
const PRS = merged(LOG.map(([hash, subject, body]) => ({ hash, subject, body })));

test("the pull requests a range of main merged: a merge commit's, a squash's, and a commit that names none", () => {
  assert.deepEqual(PRS, [
    { number: 2109, title: "Let a probe read across placements decide a change's cycles" },
    { number: 2100, title: "Parse an allowed origin once" },
    { commit: "84658be3835db27572ddfd16bc03c1fd7c398e16", title: "Fix a typo in the guide" },
    { number: 2106, title: "Merge pull request #2106 from someone/a-fork" },
  ]);
  assert.deepEqual(merged([]), []);
});

test("past the threshold: an issue's title and body, with the row, the pull requests and what to add to them", () => {
  const readings = [reading(0.02, "plain", { report: report("plain", 0.021, 0.03) }), READ[1]], line = row(at(readings, { differ: ["plain"] }));
  const made = issue({ ...at(readings), line, since: { date: "2026-11-25", head: "c6e9be955" }, again: false, prs: PRS, expected: { plain: "5c5\n< corten-shell: 618f\n---\n> corten-shell: c21c\nbodies differ: 6124 and 6124 bytes\n" } });
  assert.equal(made.title, "Trend: main costs a request at least +2.00% more cycles than v0.2.0 on plain (run of 2026-12-02)");
  for (const word of [
    "The trend run of 2026-12-02 read `main` at `153d10e9c` against v0.2.0 (`a833b4e3e`) across placements and is past its threshold on `plain`: the lower bound of the change in user plus kernel cycles a request is at or above +2.00%.",
    `${TABLE.join("\n")}\n${line}\n`,
    "- `plain`: lower bound +2.10%, median +2.55%, bound +3.00%.",
    "It blocks no merge ([CONTRIBUTING.md](https://github.com/corten-run/corten/blob/main/CONTRIBUTING.md#pull-requests), item 2.1, Trend).",
    "attributes a cost to none of them",
    "`plain`: `main` and v0.2.0 answer its request differently, so part of the change may be what the answer now holds:\n\n```\n5c5\n< corten-shell: 618f\n---\n> corten-shell: c21c\nbodies differ: 6124 and 6124 bytes\n```\n",
    "Merged from the run before it (2026-11-25, `c6e9be955`) to this one, 4 on `main`'s first-parent line. Add to each line what its description says after `Request path:` and, for a counted change, the cost it stated:",
    "- [#2109 Let a probe read across placements decide a change's cycles](https://github.com/corten-run/corten/pull/2109)\n- [#2100 Parse an allowed origin once](https://github.com/corten-run/corten/pull/2100)\n- `84658be38` Fix a typo in the guide (no pull request named)\n",
  ]) assert.ok(made.body.includes(word), word);
  assert.ok(!made.body.includes("open no second one") && !made.body.includes("`unstaged`:"));
  // The first run has no run before it, and one after a run already past it opens no second issue.
  const first = issue({ ...at(readings), line, since: null, again: false, prs: [] });
  assert.ok(first.body.includes("The page has no run before this one. Merged from v0.2.0 to this run, 0 on `main`'s first-parent line.") && first.body.includes("\n- none\n"));
  const again = issue({ ...at(readings), line, since: { date: "2026-11-25", head: "c6e9be955" }, again: true, prs: PRS });
  assert.ok(again.body.includes("The run before it (2026-11-25) was past the threshold against v0.2.0 too: add this to that run's issue and open no second one."));
});

// The command, with the kit's shell scripts stood in for: build.sh and run.sh leave what a
// step of theirs would, and the two sides' answers differ for the workloads named. With `real`,
// plan.mjs is the kit's own but for a gated part's, which would size K from a pilot no script
// here ran; without, it is stood in for too, since each call of it starts a process.
const DIFF = "5c5\n< corten-shell: 618f77240fa962cf\n---\n> corten-shell: c21cf50c33ce3fc2\nbodies differ: 6124 and 6124 bytes\n";
let made = 0;
function command({ reports = {}, differ = ["plain"], real = false, silent = {}, build = {}, sizes = {}, ended = {}, known = [EARLIER], before = null, dry = false, tags = "evidence/placement-kit\nv0.1.9\nv0.2.0\n" } = {}) {
  const dir = join(tmp, `run-${++made}`), page = join(tmp, `page-${made}.md`), calls = [], said = [];
  writeFileSync(page, before ? insert(readFileSync(PAGE, "utf8"), before) : readFileSync(PAGE, "utf8"));
  const env = { ...process.env, ...(dry ? { DRYRUN: "1" } : {}) };
  if (!dry) delete env.DRYRUN;
  const exec = (cmd, args, { env: e = env, log = null } = {}) => {
    const out = (status, text = "", stdout = "") => { if (log) appendFileSync(log, text); return { status, stdout, stderr: log ? "" : text }; };
    const kit = () => { const r = spawnSync(cmd, args, { env: e, encoding: "utf8" }); return out(r.status, r.stdout + r.stderr, r.stdout); };
    if (cmd === "git") {
      const a = args.slice(2), ref = a.at(-1).replace("^{commit}", "");
      if (a[1] === "--show-toplevel") return out(0, "", `${root}\n`);
      if (a[0] === "tag") return out(0, "", tags);
      if (a[0] === "log") { calls.push(`git log ${a.at(-1)}`); return out(0, "", LOG.map((r) => r.join("\x1f")).join("\x1e\n") + "\x1e\n"); }
      const commit = { "v0.2.0": BASE, "origin/main": HEAD }[ref] ?? known.find((c) => c.startsWith(ref));
      return commit ? out(0, "", `${commit}\n`) : out(1);
    }
    const script = args[0] === "-c" ? "answers" : basename(args[0]);
    if (script === "plan.mjs" && args.length === 2) return real ? kit() : out(0, "", "plan trend-2026-12-02\n");
    const work = script === "answers" ? args[3] : script === "plan.mjs" ? args[4] : args[1], [x, y] = basename(work).split("-"), [part, w] = x === "check" ? [x, y] : [y, x], key = `${part} ${w}`;
    calls.push(`${key} ${script.replace(/\.(mjs|sh)$/, "")}${script === "plan.mjs" && e.DRYRUN === "1" ? " dry" : ""}`);
    if (script === "plan.mjs" && args.includes("--sized-from")) {
      assert.equal(args.at(-1), join(dir, `${w}-pilot`, "results"));
      if (sizes[w]) return out(1, `sizing from pilot-${w} of run 0f8fad5b\nplan.mjs: ${args.at(-1)} ${sizes[w]}\n`);
      mkdirSync(join(work, "plan"), { recursive: true });
      return out(0, `gated ${w}: K = 69 placements (from the pilot, by the sizing rule)\n`);
    }
    if (script === "plan.mjs" && real) return kit();
    if (script === "plan.mjs") { mkdirSync(join(work, "plan"), { recursive: true }); return out(0, `${part} ${w}: resolved\n`); }
    if (script === "build.sh") {
      const b = build[key] ?? { status: 0, text: "BUILD-DONE\n" };
      if (b.refused) { mkdirSync(join(work, "bin"), { recursive: true }); writeFileSync(join(work, "bin", "refused.txt"), `REFUSED: ${b.refused}\n`); }
      return out(b.status, b.text);
    }
    if (script === "answers") {
      if (silent[w]) return out(1, `turns: ${w}: ${silent[w]}\n`);
      if (!differ.includes(w)) return out(0, "answers: same\n");
      // As turns.sh does: what it compared is under answers/ in the directory it is given, which
      // is read here from the command itself.
      const given = /turns\.sh" "\$1\/([a-z]+)" "\$W" 0 /.exec(args[1])[1];
      mkdirSync(join(work, given, "answers"), { recursive: true });
      writeFileSync(join(work, given, "answers", "diff.txt"), DIFF);
      return out(1, `${DIFF}turns: ${w}: A and B answer differently\n`);
    }
    if (ended[key]) {
      if (ended[key].report) { mkdirSync(join(work, "results"), { recursive: true }); writeFileSync(join(work, "results", "report.json"), JSON.stringify(ended[key].report)); }
      return out(1, `== turns start\nRUN-ENDED ${ended[key].outcome}\nALL-DONE\n`);
    }
    if (part === "gated") { mkdirSync(join(work, "results"), { recursive: true }); writeFileSync(join(work, "results", "report.json"), JSON.stringify(reports[w])); }
    return out(0, "RUN-ENDED complete: every comparison complete; results/report.md\nALL-DONE\n");
  };
  const result = run({ dir, page, date: "2026-12-02", env, exec, say: (l) => said.push(l) });
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
  // The check is a dry part, which sizes and turns nothing; the parts that are read are not.
  assert.ok(r.file(join("check-plain", "plan", "resolved.sh")).includes("DRY='1'\n") && r.file(join("plain-pilot", "plan", "resolved.sh")).includes("DRY='0'\n"));
  const line = "| 2026-12-02 | v0.2.0 `a833b4e3e` | `153d10e9c` | `plain` +0.40% to +1.10%, median +0.75%, K = 69, A/A resolved, answers differ; `unstaged` -0.20% to +0.30%, median +0.05%, K = 91, A/A resolved | pass at +2.00% |";
  assert.equal(r.line, line);
  assert.equal(r.page, `${readFileSync(PAGE, "utf8")}${line}\n`);
  assert.equal(r.file("row.md"), `${TABLE.join("\n")}\n${line}\n`);
  assert.equal(r.issue, null);
  assert.ok(!existsSync(join(r.dir, "issue.md")) && r.said.includes("commit it as it is") && r.said.includes("v0.2.0 and origin/main answer differently"));
  // Every step's output is kept with the run.
  assert.deepEqual(readdirSync(join(r.dir, "log")).sort(), [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain"), ...PARTS("unstaged")].map((c) => { const [part, w, step] = c.split(" "); return `${part === "check" ? `check-${w}` : `${w}-${part}`}-${step}.out`; }).sort());
});

test("a run past its threshold: exit 1, and the pull requests merged since the row before it with an issue to open", () => {
  const before = row(at(READ, { date: "2026-11-25", head: EARLIER }));
  const r = command({ reports: { ...PASS, unstaged: report("unstaged", 0.024, 0.031) }, before });
  assert.equal(r.exit, 1);
  assert.equal(r.calls.at(-1), `git log ${EARLIER.slice(0, 9)}..${HEAD}`);
  assert.deepEqual(rows(r.page).map((x) => [x.date, x.reading]), [["2026-12-02", "past +2.00%: `unstaged`"], ["2026-11-25", "pass at +2.00%"]]);
  assert.equal(r.issue.title, "Trend: main costs a request at least +2.00% more cycles than v0.2.0 on unstaged (run of 2026-12-02)");
  for (const word of ["Merged from the run before it (2026-11-25, `c6e9be955`) to this one, 4 on `main`'s first-parent line.", "- [#2109 Let a probe read across placements decide a change's cycles](https://github.com/corten-run/corten/pull/2109)", "- `unstaged`: lower bound +2.40%, median +2.75%, bound +3.10%."]) assert.ok(r.issue.body.includes(word), word);
  assert.equal(r.file("issue.md"), `${r.issue.title}\n\n${r.issue.body}`);
  assert.ok(r.said.includes("Past the threshold. An issue to open") && r.said.includes(r.issue.title));
  // The row before it was past the threshold against the same release: one issue, not two.
  const again = command({ reports: { ...PASS, plain: report("plain", 0.03, 0.04) }, before: row(at([reading(0.02, "plain", { report: report("plain", 0.021, 0.03) })], { date: "2026-11-25", head: EARLIER })) });
  assert.ok(again.issue.body.includes("was past the threshold against v0.2.0 too: add this to that run's issue and open no second one."));
  // No row before it, or one whose commit the checkout does not have: from the release.
  for (const opts of [{}, { before, known: [] }]) {
    const first = command({ reports: { ...PASS, plain: report("plain", 0.03, 0.04) }, ...opts });
    assert.equal(first.calls.at(-1), `git log ${BASE}..${HEAD}`);
    assert.ok(first.issue.body.includes("The page has no run before this one. Merged from v0.2.0 to this run"));
  }
});

test("a probe that does not build at the release tag: said, written as the row for every workload, exit 3, and nothing turned", () => {
  const r = command({ build: { "check plain": { status: 1, text: "error[E0425]: cannot find function `serve_on` in crate `corten`\nbuild: base: the build failed\n" } } });
  assert.equal(r.exit, 3);
  assert.deepEqual(r.calls, ["check plain plan dry", "check plain build"]);
  const line = "| 2026-12-02 | v0.2.0 `a833b4e3e` | `153d10e9c` | not read: the probe does not build at v0.2.0 | not read: `plain`, `unstaged` |";
  assert.deepEqual([r.line, r.page.endsWith(`${line}\n`), r.said.includes(line)], [line, true, true]);
  assert.ok(r.file(join("log", "check-plain-build.out")).includes("cannot find function `serve_on`"));
  // The same of main's side, by the ref the plan names.
  const head = command({ build: { "check plain": { status: 1, text: "build: head: the build failed\n" } } });
  assert.ok(head.line.includes("| not read: the probe does not build at origin/main |"));
});

test("not read, never a pass: a side the kit refuses, a pilot that sizes no K, a part that did not complete, an A/A not resolved", () => {
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
  // A gated part without all its placements left a report, which has no bound.
  const short = command({ reports: PASS, ended: { "gated plain": { outcome: "incomplete: a comparison without all its placements has no bound; results/report.md", report: report("plain", null, null, { exit: 1 }) } } });
  assert.ok(short.line.includes("`plain` not read: main against the release has no bound;") && short.exit === 3);
  // One that left none says how it ended.
  const none = command({ reports: PASS, ended: { "gated plain": { outcome: "perf-preflight-failed: perf cannot count cycles:u here" } } });
  assert.ok(none.line.includes("`plain` not read: the gated part ended perf-preflight-failed: perf cannot count cycles:u here;"));
  // An A/A that did not resolve, with a change that reads far under the threshold.
  const loose = command({ reports: { ...PASS, plain: report("plain", -0.05, -0.04, { resolution: "not resolved", aa: [0.0103, 0.0079] }) } });
  assert.deepEqual([loose.exit, rows(loose.page)[0].reading], [3, "not read: `plain`"]);
  // Past the threshold on one and not read on the other is both, and exits as not read.
  const both = command({ reports: { plain: report("plain", 0.03, 0.04), unstaged: report("unstaged", 0, 0, { resolution: "no bound" }) } });
  assert.deepEqual([both.exit, rows(both.page)[0].reading, Boolean(both.issue)], [3, "past +2.00%: `plain`; not read: `unstaged`", true]);
});

test("refused before anything is run: a directory that holds something or lies in the checkout, no release tag, a page with no table", () => {
  const refused = (opts, word, change = () => {}) => {
    const dir = join(tmp, `refused-${++made}`), page = join(tmp, `refused-${made}.md`), calls = [];
    writeFileSync(page, readFileSync(PAGE, "utf8"));
    const o = { dir, page, date: "2026-12-02", say: () => {}, exec: (cmd, args) => { calls.push(args.slice(2).join(" ")); return cmd === "git" && args[3] === "--show-toplevel" ? { status: 0, stdout: `${root}\n` } : { status: 0, stdout: opts.tags ?? "" }; } };
    change(o);
    const was = readFileSync(page, "utf8");
    assert.throws(() => run(o), (e) => e.refused === true && e.message.includes(word), word);
    assert.equal(readFileSync(page, "utf8"), was);
    assert.ok(!calls.some((c) => c.includes("plan.mjs") || c.includes(".sh")));
  };
  refused({}, "already holds something, and a run is made once", (o) => { mkdirSync(o.dir); writeFileSync(join(o.dir, "row.md"), ""); });
  refused({}, "is inside the checkout: a run's directory is outside it", (o) => { o.dir = join(here, "trend", "run"); });
  refused({}, "is inside the checkout", (o) => { o.dir = root; });
  refused({}, "the run's directory is an absolute path without white space", (o) => { o.dir = "run"; });
  refused({}, "the run's directory is an absolute path without white space", (o) => { o.dir = join(tmp, "a run"); });
  refused({ tags: "evidence/placement-kit\n" }, "the checkout has no release tag vX.Y.Z: fetch the tags");
  refused({}, "the page has no table of runs", (o) => writeFileSync(o.page, "# The trend\n"));
  refused({}, "is not a usable trend plan:\n  threshold", (o) => { o.plan = join(tmp, `plan-${made}.json`); writeFileSync(o.plan, JSON.stringify(trend((t) => { t.threshold = 0; }))); });
  // The command says the same and exits 2, with no directory made.
  const r = spawnSync(process.execPath, [join(here, "trend.mjs"), join(here, "trend", "run")], { encoding: "utf8" });
  assert.deepEqual([r.status, r.stdout, existsSync(join(here, "trend", "run"))], [2, "", false]);
  assert.ok(r.stderr.startsWith("trend.mjs: ") && r.stderr.includes("is inside the checkout"), r.stderr);
  const usage = spawnSync(process.execPath, [join(here, "trend.mjs")], { encoding: "utf8" });
  assert.deepEqual([usage.status, usage.stderr], [2, "usage: node trend.mjs <run dir>   (a new directory, an absolute path outside the checkout)\n"]);
});

test("a dry run: every part the kit's dry run, the row kept with the run and marked, the page left as it was", () => {
  const dry = { plain: report("plain", 0.03, 0.04, { dry: true, K: 6, sized: null }), unstaged: report("unstaged", 0, 0.001, { dry: true, K: 6, sized: null }) };
  const r = command({ reports: dry, dry: true });
  assert.equal(r.exit, 0);
  assert.deepEqual(r.calls, [...CHECKS("plain"), ...CHECKS("unstaged"), ...PARTS("plain"), ...PARTS("unstaged")].map((c) => (c.endsWith(" plan") ? `${c} dry` : c)));
  assert.equal(r.page, readFileSync(PAGE, "utf8"));
  assert.ok(r.file("row.md").startsWith("DRY RUN: a test of the scripts, read for nothing. This row is not the page's.\n\n"));
  assert.ok(r.line.includes("`plain` not read: DRY RUN, read for nothing (+3.00% to +4.00%, median +3.50%, K = 6);") && r.line.endsWith("| not read: `plain`, `unstaged` |"));
  // Nothing is past a threshold in a dry run, whatever it read, and one that did not complete says so.
  assert.equal(r.issue, null);
  assert.equal(command({ reports: { ...dry, plain: report("plain", null, null, { dry: true, K: 6, sized: null, exit: 1 }) }, dry: true }).exit, 3);
});
