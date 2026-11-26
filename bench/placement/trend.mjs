// trend.mjs: reads `main` against the last release across placements, from the one plan in
// trend/plan.json, and adds the run's row to trend/README.md (CONTRIBUTING.md, Pull requests,
// item 2.1, Trend; docs/design.md#choice-counted-or-measured):
//   node trend.mjs <run dir>
// on a quiet Linux host prepared as README.md says one is for a placement run, from a checkout
// that has `main` and the release tags fetched. <run dir> is a new directory of its own, an
// absolute path without white space outside the checkout. The run takes hours, so start it
// detached and leave the host alone until it ends:
//   nohup node trend.mjs <run dir> ><run dir>.out 2>&1 &
// The row is in trend/README.md when it ends, to be committed as it is, and <run dir> is what
// the row's figures are read from, to be kept.
//
// The plan (trend/plan.json) is a plan as plan.mjs reads one, less what only a run can give:
//   base       "release": the commit of the highest tag vX.Y.Z in the checkout
//   head       a ref (origin/main), as the checkout has it when the run starts
//   seed       "date": a workload's seed is the run's date (UTC) as YYYYMMDD and then its place
//              in the plan as two digits, so every run has seeds of its own and nobody chooses
//              one after a result
//   threshold  the rise the trend reports, a fraction (0.02 for +2%), read on the lower bound
//   plan       the plan, without base, head and each workload's seed and expect; probe.dir is a
//              path from the trend's plan file, and may lead out of its directory, since the
//              probe is copied beside the run's own plan; every workload's K is "pilot"
// In order, each step one of the kit's own commands with its output in <run dir>/log:
//   resolve    <run dir>/check.json, the plan with the run's base, head and seeds, and
//              <run dir>/probe, the probe's copy
//   check      for each workload a dry part of that plan is resolved and built (plan.mjs with
//              DRYRUN=1, build.sh), which turns nothing: so a probe that does not build at the
//              release tag, or a side the kit refuses, is known before any turn. The two sides'
//              unpadded binaries are then started once and their answers compared as turns.sh
//              compares a placement's. A release and `main` may answer differently, and no plan
//              written before the run can say how, so the difference found is kept as the
//              workload's expected difference (<run dir>/expect-<workload>.txt) and every
//              placement of the run must show exactly it
//   plan       <run dir>/plan.json, check.json with those expected differences, and what it
//              declares (<run dir>/declared.txt)
//   parts      for each workload its pilot and then its gated part at the K that pilot sizes,
//              each as README.md gives the commands: plan.mjs, build.sh, run.sh
//   row        each workload's reading from its gated part's report.json, the row added to the
//              page, newest first, and kept as <run dir>/row.md
// A workload is read when its gated part is complete, its A/A resolved and its K checked by the
// kit: it is past the threshold when the lower bound of the change in user plus kernel cycles a
// request, `main` against the release, is at or above the threshold, and passes otherwise.
// Anything else is "not read" with the reason, never a pass: a step that failed, a pilot that
// sizes no K, an A/A that does not resolve, a comparison without a bound. A probe that does not
// build at the release tag is such a row, for every workload. Nothing is run again.
// Past the threshold the command prints the pull requests merged from the row before this
// one's head to this one's (from the release when the page has no row) and an issue's title and
// body, kept as <run dir>/issue.md. It calls no service: opening the issue is the reader's.
// Exit 0: every workload read and none past the threshold; 1: one past it; 2: refused, nothing
// run and no row; 3: a workload not read, whatever another read; anything else: trend.mjs
// itself failed.
// DRYRUN=1 makes every part a dry run of the kit's (README.md): the row is written to
// <run dir>/row.md alone, marked, and the page is left as it was.
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as path, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { problems as planProblems } from "./plan.mjs";
import { pct } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PLAN = join(here, "trend", "plan.json"), PAGE = join(here, "trend", "README.md");
/** Where a pull request and the rule are linked to from an issue's body. */
export const REPOSITORY = "https://github.com/corten-run/corten";
/** The page's table: a row is added under these two lines, so the newest is first. */
export const TABLE = ["| run | base | head | workloads: lower bound to bound, `main` against the release | reading |", "| --- | --- | --- | --- | --- |"];
const GATE = "cycles, user and kernel";
const FIELDS = ["trend", "base", "head", "seed", "threshold", "plan"];
const short = (commit) => commit.slice(0, 9);
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
const cell = (s) => String(s).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

/** A workload's seed: the run's date as YYYYMMDD, then its place in the plan (from 1) as two digits. */
export const seed = (date, i) => Number(date.replaceAll("-", "")) * 100 + i + 1;

/** The highest release tag, vX.Y.Z, among a checkout's tags, or null. */
export function latest(tags) {
  const releases = tags.map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t.trim())).filter(Boolean).map((m) => ({ tag: m[0], v: m.slice(1).map(Number) }));
  releases.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return releases[0]?.tag ?? null;
}

/**
 * The plan a run reads, as plan.mjs takes one: the trend's with its base, head and seeds, the
 * probe beside it and, for a workload whose two sides answer differently, the file that holds
 * the difference. expect: workload names to such files.
 */
export function resolved(t, { base, head, date, expect = {} }) {
  const { plan, name, probe, workloads, ...rest } = t.plan;
  return {
    plan, name: `${name}-${date}`, base, head, probe: { ...probe, dir: "probe" }, ...rest,
    workloads: workloads.map((w, i) => ({ ...w, seed: seed(date, i), ...(expect[w.name] ? { expect: expect[w.name] } : {}) })),
  };
}

/** Why a trend's plan is not usable, or [] when it is. */
export function problems(t) {
  if (t?.trend !== 1) return ['"trend": 1 is missing: not a trend plan this kit reads'];
  const why = Object.keys(t).filter((k) => !FIELDS.includes(k)).map((k) => `"${k}" is not a field of a trend's plan`);
  if (t.base !== "release") why.push('base: "release", the highest tag vX.Y.Z: the trend reads main against the last release, and a run finds its commit');
  if (typeof t.head !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(t.head) || /^[0-9a-f]{40}$/.test(t.head)) why.push("head: a ref (origin/main), which a run reads as the checkout has it; a commit named here would be read by every run");
  if (t.seed !== "date") why.push('seed: "date", the rule that gives each run its seeds: the run\'s date and the workload\'s place in the plan');
  if (!(typeof t.threshold === "number" && t.threshold > 0 && t.threshold < 1)) why.push("threshold: the rise the trend reports, as a fraction (0.02 for +2%)");
  const p = t.plan;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return [...why, "plan: a plan as plan.mjs reads one, without base, head and each workload's seed"];
  for (const k of ["base", "head"]) if (p[k] !== undefined) why.push(`plan.${k}: the run gives it, by the rule this file's "${k}" names`);
  const dir = p.probe?.dir, workloads = Array.isArray(p.workloads) ? p.workloads.filter((w) => w !== null && typeof w === "object") : [];
  if (typeof dir !== "string" || !dir || isAbsolute(dir) || /\s/.test(dir)) why.push("plan.probe.dir: a path from this file to the probe's crate");
  for (const w of workloads) {
    if (w.seed !== undefined) why.push(`workload ${w.name}: seed: the run gives it, from its date`);
    if (w.expect !== undefined) why.push(`workload ${w.name}: expect: the run records how the release and main answer differently, before any turn`);
    if (w.K !== "pilot") why.push(`workload ${w.name}: K: "pilot", since every run sizes K from its own pilot`);
  }
  if (why.length) return why;
  return planProblems(resolved(t, { base: "0".repeat(40), head: "0".repeat(40), date: "2000-01-01" })).map((x) => `plan: ${x}`);
}

/**
 * One workload's reading. part: { report, why }, the gated part's report.json or why there is
 * none. state is "pass", "past" (the threshold) or "not read"; text is what the row says.
 */
export function reading(threshold, workload, { report = null, why = null } = {}) {
  const not = (text) => ({ workload, state: "not read", text });
  if (why) return not(why);
  if (!report) return not("the gated part left no report");
  if (report.exit === 2 || report.refused) return not(`the kit refused the results: ${report.refused?.[0] ?? "no reason given"}`);
  const g = report.gated, c = report[`change-${workload}`]?.measures?.[GATE]?.recorded;
  if (!g || !c) return not("the report is not a gated part's");
  const figures = `${fmt(c.lower)} to ${fmt(g.changeBound)}, median ${fmt(g.changeMedian)}, K = ${report.K}`;
  if (report.dry) return { ...not(`DRY RUN, read for nothing (${figures})`), dry: true, complete: report.exit === 0 };
  if (g.resolution !== "resolved") return not(g.resolution === "no bound" ? "the A/A has no bound" : `the A/A did not resolve (bounds ${fmt(g.aaBound)} and ${fmt(g.aaBoundSwapped)}, against +1%)`);
  if (g.changeBound == null || c.lower == null) return not("main against the release has no bound");
  if (!report.sized) return not("K was not checked by the kit");
  return { workload, state: c.lower >= threshold ? "past" : "pass", text: `${figures}, A/A resolved`, lower: c.lower, bound: g.changeBound, median: g.changeMedian };
}

/** A run's reading, the row's last cell: a pass only when every workload passes. */
export function verdict(threshold, readings) {
  const of = (state) => readings.filter((r) => r.state === state).map((r) => `\`${r.workload}\``).join(", ");
  if (readings.length && readings.every((r) => r.state === "pass")) return `pass at ${pct(threshold)}`;
  return [of("past") && `past ${pct(threshold)}: ${of("past")}`, of("not read") && `not read: ${of("not read")}`].filter(Boolean).join("; ");
}

/**
 * The page's row for a run: { date, tag, base, head, threshold, readings, differ }, differ the
 * workloads whose two sides answer differently.
 */
export function row({ date, tag, base, head, threshold, readings, differ = [] }) {
  const alike = readings.length > 1 && readings.every((r) => r.state === "not read" && r.text === readings[0].text);
  const each = (r) => `\`${r.workload}\` ${r.state === "not read" ? "not read: " : ""}${r.text}${differ.includes(r.workload) && r.state !== "not read" ? ", answers differ" : ""}`;
  const workloads = alike ? `not read: ${readings[0].text}` : readings.map(each).join("; ");
  return `| ${date} | ${tag} \`${short(base)}\` | \`${short(head)}\` | ${cell(workloads)} | ${cell(verdict(threshold, readings))} |`;
}

/** The page's rows, newest first, each { date, tag, base, head, workloads, reading }. */
export function rows(page) {
  const lines = page.split(/\r?\n/), at = lines.indexOf(TABLE[0]);
  if (at < 0 || lines[at + 1] !== TABLE[1]) throw new Error("the page has no table of runs: its two heading lines are not there as trend.mjs writes them");
  const out = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith("|")) break;
    const m = /^\| (\d{4}-\d{2}-\d{2}) \| (\S+) `([0-9a-f]{7,40})` \| `([0-9a-f]{7,40})` \| (.*) \| ((?:[^|\\]|\\.)*) \|$/.exec(l);
    if (!m) throw new Error(`the page has a row trend.mjs did not write: ${l}`);
    out.push({ date: m[1], tag: m[2], base: m[3], head: m[4], workloads: m[5], reading: m[6] });
  }
  return out;
}

/** The page with a run's row added under the table's heading, above every earlier row. */
export function insert(page, line) {
  rows(page);
  const eol = page.includes("\r\n") ? "\r\n" : "\n", lines = page.split(eol), at = lines.indexOf(TABLE[0]);
  lines.splice(at + 2, 0, line);
  return lines.join(eol);
}

/**
 * The pull requests a range of `main` merged, from `git log --first-parent` records of
 * { hash, subject, body }: a merge commit's (its title is the body's first line) and a squash's
 * (the subject ends with its number). A commit that names none is kept by its hash.
 */
export function merged(records) {
  return records.map(({ hash, subject, body }) => {
    const merge = /^Merge pull request #(\d+) from \S+/.exec(subject), squash = /^(.*\S) \(#(\d+)\)$/.exec(subject);
    if (merge) return { number: Number(merge[1]), title: body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? subject };
    if (squash) return { number: Number(squash[2]), title: squash[1] };
    return { commit: hash, title: subject };
  });
}

/**
 * An issue for a run past its threshold: { title, body }. run: what row() takes, with line (its
 * row), since ({ date, head } of the row before it, or null), again (that row was past the
 * threshold against this release too), prs (merged()'s list) and expected (workload names to
 * the difference found between the two sides' answers).
 */
export function issue({ date, tag, base, head, threshold, readings, line, since, again, prs, expected = {} }) {
  const past = readings.filter((r) => r.state === "past"), names = past.map((r) => `\`${r.workload}\``).join(" and ");
  const title = `Trend: main costs a request at least ${pct(threshold)} more cycles than ${tag} on ${past.map((r) => r.workload).join(" and ")} (run of ${date})`;
  const body = [
    `The trend run of ${date} read \`main\` at \`${short(head)}\` against ${tag} (\`${short(base)}\`) across placements and is past its threshold on ${names}: the lower bound of the change in user plus kernel cycles a request is at or above ${pct(threshold)}.`, "",
    ...TABLE, line, "",
    ...past.map((r) => `- \`${r.workload}\`: lower bound ${pct(r.lower)}, median ${pct(r.median)}, bound ${pct(r.bound)}.`), "",
    `It blocks no merge ([CONTRIBUTING.md](${REPOSITORY}/blob/main/CONTRIBUTING.md#pull-requests), item 2.1, Trend). The run reads every change since the release together and attributes a cost to none of them; the list below is where to look.`, "",
    ...(again ? [`The run before it (${since.date}) was past the threshold against ${tag} too: add this to that run's issue and open no second one.`, ""] : []),
    ...Object.entries(expected).flatMap(([w, text]) => [`\`${w}\`: \`main\` and ${tag} answer its request differently, so part of the change may be what the answer now holds:`, "", "```", ...text.replace(/\n$/, "").split("\n"), "```", ""]),
    `${since ? `Merged from the run before it (${since.date}, \`${short(since.head)}\`) to this one` : `The page has no run before this one. Merged from ${tag} to this run`}, ${prs.length} on \`main\`'s first-parent line. Add to each line what its description says after \`Request path:\` and, for a counted change, the cost it stated:`, "",
    ...(prs.length ? prs.map((p) => (p.number ? `- [#${p.number} ${p.title}](${REPOSITORY}/pull/${p.number})` : `- \`${short(p.commit)}\` ${p.title} (no pull request named)`)) : ["- none"]), "",
  ].join("\n");
  return { title, body };
}

/** What a step that failed said: the last line of its output a reader can use. */
function said(log, pattern = /\S/) {
  const lines = existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter((l) => pattern.test(l)) : [];
  return (lines.at(-1) ?? "it printed nothing").trim().slice(0, 400);
}

/** Runs a command with its output in a file, or returned when no file is given. */
function execute(command, args, { env = process.env, log = null } = {}) {
  if (!log) { const r = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 1 << 28 }); return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") }; }
  const fd = openSync(log, "a");
  try { const r = spawnSync(command, args, { env, stdio: ["ignore", fd, fd] }); return { status: r.status ?? 1 }; } finally { closeSync(fd); }
}

// The two sides' unpadded binaries, started once each and their answers compared as turns.sh
// compares a placement's, with no pair turned (as verify.sh calls it): $1 is a work directory
// build.sh has built. turns.sh keeps what it compared under its own directory's answers/, so
// this leaves <work dir>/compare/answers/diff.txt, the text a plan's `expect` holds.
const ANSWERS = '. "$1/plan/resolved.sh" && export KIT START REQ_PATH STATUS EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C TURN && HEADERS="$1/plan/headers.txt" SCRIPT="$1/plan/request.lua" MASK="$1/plan/mask.sed" MASK_JSON="$1/plan/mask.json" WARMUP=0 EXPECT= exec taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" "$1/compare" "$W" 0 "$1/bin/base" "$1/bin/head"';

/**
 * A run. dir: the run's directory; plan and page: the trend's plan file and its page; date:
 * the run's date, YYYY-MM-DD; exec: what runs a command (a test gives its own); say: where a
 * line of progress goes. Returns { exit, line, issue }.
 */
export function run({ dir, plan = PLAN, page = PAGE, date = new Date().toISOString().slice(0, 10), env = process.env, exec = execute, say = console.log }) {
  const refuse = (why) => { const e = new Error(why); e.refused = true; throw e; };
  const git = (...args) => { const r = exec("git", ["-C", here, ...args], { env }); return r.status === 0 ? r.stdout.trim() : null; };
  const repo = git("rev-parse", "--show-toplevel") ?? refuse("the kit is not in a git checkout");
  if (!dir || !isAbsolute(dir) || /\s/.test(dir)) refuse("the run's directory is an absolute path without white space");
  dir = path(dir);
  const within = relative(path(repo), dir);
  if (!within || (!within.startsWith("..") && !isAbsolute(within))) refuse(`${dir} is inside the checkout: a run's directory is outside it`);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length)) refuse(`${dir} already holds something, and a run is made once: nothing is run again for its result`);
  const t = JSON.parse(readFileSync(plan, "utf8")), bad = problems(t);
  if (bad.length) refuse(`${plan} is not a usable trend plan:\n  ${bad.join("\n  ")}`);
  let before;
  try { before = rows(readFileSync(page, "utf8"))[0] ?? null; } catch (e) { refuse(`${page}: ${e.message}`); }
  const tag = latest((git("tag", "--list", "v*") ?? "").split("\n")) ?? refuse("the checkout has no release tag vX.Y.Z: fetch the tags (git fetch --tags)");
  const base = git("rev-parse", "--verify", "--quiet", `${tag}^{commit}`) ?? refuse(`${tag} names no commit`);
  const head = git("rev-parse", "--verify", "--quiet", `${t.head}^{commit}`) ?? refuse(`the checkout has no ${t.head}: fetch it`);
  const dry = env.DRYRUN === "1", names = t.plan.workloads.map((w) => w.name), logs = join(dir, "log");
  mkdirSync(logs, { recursive: true });
  cpSync(path(dirname(plan), t.plan.probe.dir), join(dir, "probe"), { recursive: true });
  const write = (name, expect) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(resolved(t, { base, head, date, expect }), null, 2) + "\n"); return f; };
  say(`trend ${date}${dry ? " (DRY RUN: a test of the scripts, read for nothing)" : ""}: ${t.head} ${head} against ${tag} ${base}; threshold ${pct(t.threshold)} on the lower bound; workloads ${names.join(", ")}`);

  // A step of the kit, its output in the run's log directory: null when it passed, or what it
  // said, less the run's directory, which is this host's and not for the page.
  const step = (name, command, args, { env: e = env, pattern } = {}) => {
    const log = join(logs, `${name}.out`), status = exec(command, args, { env: e, log }).status;
    say(`${name}: ${status === 0 ? "done" : `exit ${status}`}`);
    return status === 0 ? null : { status, log, said: said(log, pattern).replaceAll(dir + sep, "").replaceAll(dir, "the run's directory") };
  };
  const kit = (f) => join(here, f), why = {}, expect = {}, expected = {};

  // Check: both sides built once for each workload with nothing turned, and their answers compared.
  const check = write("check.json");
  for (const w of names) {
    const work = join(dir, `check-${w}`);
    let failed = step(`check-${w}-plan`, process.execPath, [kit("plan.mjs"), check, "gated", w, work], { env: { ...env, DRYRUN: "1" } });
    if (failed) { why[w] = `plan.mjs refused the plan: ${failed.said}`; continue; }
    failed = step(`check-${w}-build`, "sh", [kit("build.sh"), work]);
    if (failed) {
      // The probe and its build command are the plan's, so a side that does not build for one
      // workload builds for none.
      const side = /^build: (base|head): the build failed$/m.exec(readFileSync(failed.log, "utf8"))?.[1];
      if (failed.status === 3) why[w] = said(join(work, "bin", "refused.txt")).replace(/^REFUSED: /, "the kit refuses the run: ");
      else if (side) { for (const x of names) why[x] ??= `the probe does not build at ${side === "base" ? tag : t.head}`; break; }
      else why[w] = `build.sh failed before any turn: ${failed.said}`;
      continue;
    }
    failed = step(`check-${w}-answers`, "sh", ["-c", ANSWERS, "sh", work]);
    const diff = join(work, "compare", "answers", "diff.txt");
    if (!failed) continue;
    if (existsSync(diff) && statSync(diff).size && /A and B answer differently/.test(readFileSync(failed.log, "utf8"))) {
      expect[w] = `expect-${w}.txt`; expected[w] = readFileSync(diff, "utf8");
      copyFileSync(diff, join(dir, expect[w]));
      say(`${w}: ${tag} and ${t.head} answer differently; every placement must show this difference and no other:\n${expected[w]}`);
    } else why[w] = `the two sides' answers could not be compared: ${failed.said}`;
  }

  // The plan the parts are read from, and what it declares.
  const file = write("plan.json", expect), declared = exec(process.execPath, [kit("plan.mjs"), file], { env });
  writeFileSync(join(dir, "declared.txt"), declared.stdout ?? "");
  if (declared.status !== 0) for (const w of names) why[w] ??= `plan.mjs refused the plan: ${(declared.stderr ?? "").trim().split("\n").at(-1)}`;
  else say(declared.stdout.trimEnd());

  // Each workload's pilot and then its gated part, as README.md gives the commands.
  const reports = {};
  for (const w of names) {
    if (why[w]) continue;
    const pilot = join(dir, `${w}-pilot`), gated = join(dir, `${w}-gated`);
    const part = (name, work, more = []) => {
      let failed = step(`${w}-${name}-plan`, process.execPath, [kit("plan.mjs"), file, name, w, work, ...more], { pattern: /^plan\.mjs: |sizes no K|does not pass/ });
      if (failed) return `the ${name} part was not resolved: ${failed.said.replace(/^plan\.mjs: /, "")}`;
      failed = step(`${w}-${name}-build`, "sh", [kit("build.sh"), work]);
      if (failed) return failed.status === 3 ? said(join(work, "bin", "refused.txt")).replace(/^REFUSED: /, "the kit refuses the run: ") : `the ${name} part was not built: ${failed.said}`;
      failed = step(`${w}-${name}-run`, "sh", [kit("run.sh"), work], { pattern: /^RUN-ENDED / });
      return failed ? `the ${name} part ended ${failed.said.replace(/^RUN-ENDED /, "")}` : null;
    };
    why[w] = part("pilot", pilot);
    if (why[w]) continue;
    const ended = part("gated", gated, ["--sized-from", join(pilot, "results")]), json = join(gated, "results", "report.json");
    // A gated part that ended without all its placements still left a report, which says so.
    if (existsSync(json)) reports[w] = JSON.parse(readFileSync(json, "utf8"));
    else why[w] = ended ?? "the gated part left no report";
  }

  const readings = names.map((w) => reading(t.threshold, w, { report: reports[w], why: reports[w] ? null : why[w] }));
  const at = { date, tag, base, head, threshold: t.threshold, readings, differ: Object.keys(expect) }, line = row(at);
  writeFileSync(join(dir, "row.md"), `${dry ? "DRY RUN: a test of the scripts, read for nothing. This row is not the page's.\n\n" : ""}${TABLE.join("\n")}\n${line}\n`);
  if (!dry) writeFileSync(page, insert(readFileSync(page, "utf8"), line));
  say(`\n${TABLE.join("\n")}\n${line}\n\n${dry ? `DRY RUN: the row is in ${join(dir, "row.md")} alone` : `the row is in ${page}: commit it as it is. Keep each part's results under ${dir}, with its plan.json, row.md and expected differences: the row's figures are read from them`}`);
  let made = null;
  if (readings.some((r) => r.state === "past")) {
    const from = before && git("rev-parse", "--verify", "--quiet", `${before.head}^{commit}`) ? before : null;
    const log = exec("git", ["-C", here, "log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", `${from ? from.head : base}..${head}`], { env }).stdout ?? "";
    const prs = merged(log.split("\x1e").map((r) => r.replace(/^\s+/, "").split("\x1f")).filter((r) => r.length === 3).map(([hash, subject, body]) => ({ hash, subject, body })));
    made = issue({ ...at, line, since: from, again: Boolean(from && from.tag === tag && from.reading.startsWith("past ")), prs, expected });
    writeFileSync(join(dir, "issue.md"), `${made.title}\n\n${made.body}`);
    say(`\nPast the threshold. An issue to open, kept as ${join(dir, "issue.md")}:\n\n${made.title}\n\n${made.body}`);
  }
  const exit = dry ? (readings.every((r) => r.dry && r.complete) ? 0 : 3) : readings.some((r) => r.state === "not read") ? 3 : made ? 1 : 0;
  return { exit, line, readings, issue: made };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) { console.error("usage: node trend.mjs <run dir>   (a new directory, an absolute path outside the checkout)"); process.exit(2); }
  try { process.exit(run({ dir: args[0] }).exit); } catch (e) { console.error(`trend.mjs: ${e.refused ? e.message : (e.stack ?? e)}`); process.exit(e.refused ? 2 : 4); }
}
