// trend.mjs: reads `main` against the last release across placements, from the one plan in
// trend/plan.json, and adds the run's row to trend/README.md (CONTRIBUTING.md, Pull requests,
// item 2.1, Trend; docs/design.md#choice-counted-or-measured):
//   node trend.mjs <run dir>
// on a quiet Linux host prepared as README.md says one is for a placement run, from a full
// (not shallow, not partial) checkout that has `main` and the release tags fetched. <run dir>
// is a directory the command makes: an absolute path without white space, outside the checkout,
// that is not there yet and whose parent is. The run takes hours, so start it detached and leave the host
// alone until it ends:
//   nohup node trend.mjs <run dir> ><run dir>.out 2>&1 &
// The row is in trend/README.md when it ends, to be committed as it is, and <run dir> is what
// the row's figures are read from, to be kept.
//
// The plan (trend/plan.json) is a plan as plan.mjs reads one, less what only a run can give:
//   base       "release": the commit of the highest tag vX.Y.Z in the checkout
//   head       a remote's branch (origin/main), as the checkout has it when the run starts
//   seed       "date": a workload's seed is the run's date (UTC) as YYYYMMDD and then its place
//              in the plan as two digits, so every run has seeds of its own and nobody chooses
//              one after a result. One run a date: a date the page has a row of is refused
//   threshold  the rise the trend reports, a fraction (0.02 for +2%), read on the lower bound
//   plan       the plan, without base, head and each workload's seed and expect; probe.dir is a
//              path from the trend's plan file, and may lead out of its directory, since the
//              probe is copied beside the run's own plan; every workload's K is "pilot", and
//              none names a request script, since nothing but the probe is copied
// In order, each step one of the kit's own commands with its output in <run dir>/log:
//   resolve    <run dir>/check.json, the plan with the run's base, head and seeds, and
//              <run dir>/probe, the probe's copy
//   check      for each workload a dry part of that plan is resolved and built (plan.mjs with
//              DRYRUN=1, build.sh), which turns nothing: so a probe that does not build at the
//              release tag, or a side the kit refuses for its sections, is known before any
//              turn (a placement no second pad fits, when its own part is built). The two sides'
//              unpadded binaries are then started once and their answers compared as turns.sh
//              compares a placement's, under a placement's time limit. A release and `main` may
//              answer differently, and no plan written before the run can say how, so the
//              difference found, as turns.sh reports one after both servers ended and nothing
//              accepted on either port when checked (status 4 and its line), is kept as the workload's expected difference
//              (<run dir>/expect-<workload>.txt) and every placement of the run must show
//              exactly it. Nobody reviewed that difference: the run recorded it. The digests of
//              the two bodies are kept too (<run dir>/bodies-<workload>.txt). What the check left
//              is read only as its handoff binds it: the handoff line turns.sh printed after that
//              stop names answers/handoff.json by its SHA-256, which names the outcome (the same
//              for status 0, differ for 4) and the SHA-256s of diff.txt and bodies.txt, so a file
//              put in place of one of them is refused (answers.mjs handoff)
//   plan       <run dir>/plan.json, check.json with those expected differences, and what it
//              declares (<run dir>/declared.txt)
//   parts      for each workload its pilot and then its gated part at the K that pilot sizes,
//              each as README.md gives the commands: plan.mjs, build.sh, run.sh. After a part,
//              every placement the part was resolved to have must show the two bodies the check
//              kept, by their digests: turns.sh holds a placement of the change to the expected
//              difference, which ends with a bodies line of the bodies' lengths and SHA-256s
//              (one body's, when the headers alone differ), and this
//              holds a pilot's or an A/A's placement, which has no expected difference, to the
//              release's body on both sides
//   row        each workload's reading from its gated part's report.json, kept as
//              <run dir>/row.md and then added to the page, newest first
// A workload is read only when every step of its two parts ended with status 0 and its gated
// part's report.json says the part is this run's (the plan, base, head and workload), complete,
// at the K this run's pilot sized, with figures that are numbers, and its A/A
// resolved. It is then past the threshold when the lower bound of the change in user plus
// kernel cycles a request, `main` against the release, is at or above the threshold, and a pass
// otherwise: a pass says the run did not show a rise of at least the threshold, not that the
// cost is under it. Anything else is "not read" with the reason, never a pass: a step that
// failed (whatever report it left), a report that cannot be read, a pilot that sizes no K, an
// A/A that does not resolve, a comparison without a bound. A probe that does not build at the
// release tag is such a row, for every workload. Nothing is run again.
// What is trusted: what the kit's own scripts wrote in the run's directory during this run,
// when the step that wrote it ended with status 0. The command does not defend against a file
// edited by hand or by another process. It does guarantee that nothing it cannot read becomes a
// pass or loses the row: such a workload is "not read", and the row is written.
// Past the threshold the command drafts an issue, its title and body kept as
// <run dir>/issue.md, with the pull requests merged from the row before this one's head to this
// one's (from the release when the page has no row, or one whose commit this run's head does
// not descend from, which the draft says). It calls no service: opening the issue, or adding
// the draft to one already open, is the reader's.
// Exit 0: every workload read and none past the threshold; 1: one past it and every workload
// read; 3: a workload not read, whatever another read (3 outranks 1); 2: refused, with nothing
// run, nothing made and no row; anything else (4): trend.mjs itself failed, by a defect in it
// or because the page changed while the run was made so that its row cannot be added (once the
// parts have run, the row is in <run dir>/row.md before the page is touched).
// DRYRUN=1 makes every part a dry run of the kit's (README.md): the row is written to
// <run dir>/row.md alone, marked, the page is left as it was and no issue is drafted. It exits
// 0 when every part ran to its end as a dry run, though nothing was read, and 3 otherwise.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as path, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handoff, regularBytes } from "./answers.mjs";
import { K_MAX, K_MIN, problems as planProblems } from "./plan.mjs";
import { pct } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PLAN = join(here, "trend", "plan.json"), PAGE = join(here, "trend", "README.md");
/** Where a commit, a pull request and the rule are linked to. */
export const REPOSITORY = "https://github.com/corten-run/corten";
/** The page's table: a row is added under these two lines, so the newest is first. */
export const TABLE = ["| run | base | head | workloads: lower bound to bound, `main` against the release | reading |", "| --- | --- | --- | --- | --- |"];
const GATE = "cycles, user and kernel";
const FIELDS = ["trend", "base", "head", "seed", "threshold", "plan"];
const HEX40 = /^[0-9a-f]{40}$/;
const short = (commit) => commit.slice(0, 9);
const fmt = (x) => (typeof x === "number" && Number.isFinite(x) ? pct(x) : "-");
const cell = (s) => String(s).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

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
  if (!obj(t) || t.trend !== 1) return ['"trend": 1 is missing: not a trend plan this kit reads'];
  const why = Object.keys(t).filter((k) => !FIELDS.includes(k)).map((k) => `"${k}" is not a field of a trend's plan`);
  if (t.base !== "release") why.push('base: "release", the highest tag vX.Y.Z: the trend reads main against the last release, and a run finds its commit');
  if (typeof t.head !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(t.head)) why.push("head: a remote's branch (origin/main), which a run reads as the checkout has it; a commit named here would be read by every run");
  if (t.seed !== "date") why.push('seed: "date", the rule that gives each run its seeds: the run\'s date and the workload\'s place in the plan');
  if (!(typeof t.threshold === "number" && t.threshold > 0 && t.threshold < 1)) why.push("threshold: the rise the trend reports, as a fraction (0.02 for +2%)");
  const p = t.plan;
  if (!obj(p)) return [...why, "plan: a plan as plan.mjs reads one, without base, head and each workload's seed"];
  for (const k of ["base", "head"]) if (p[k] !== undefined) why.push(`plan.${k}: the run gives it, by the rule this file's "${k}" names`);
  const dir = obj(p.probe) ? p.probe.dir : undefined;
  if (typeof dir !== "string" || !dir || isAbsolute(dir) || /\s/.test(dir)) why.push("plan.probe.dir: a path from this file to the probe's crate");
  if (!Array.isArray(p.workloads) || !p.workloads.length || !p.workloads.every(obj)) why.push("plan.workloads: at least one workload, each with its fields");
  else {
    if (p.workloads.length > 99) why.push("plan.workloads: at most 99, since a seed gives a workload's place in the plan two digits");
    for (const w of p.workloads) {
      if (w.seed !== undefined) why.push(`workload ${w.name}: seed: the run gives it, from its date`);
      if (w.expect !== undefined) why.push(`workload ${w.name}: expect: the run records how the release and main answer differently, before any turn`);
      if (w.K !== "pilot") why.push(`workload ${w.name}: K: "pilot", since every run sizes K from its own pilot`);
      if (obj(w.request) && w.request.script !== undefined) why.push(`workload ${w.name}: request.script: a trend's plan names no script, since a run copies the probe alone beside its plan: every workload is asked for by the kit's own`);
    }
  }
  if (why.length) return why;
  return planProblems(resolved(t, { base: "0".repeat(40), head: "0".repeat(40), date: "2000-01-01" })).map((x) => `plan: ${x}`);
}

/**
 * One workload's reading. report: its gated part's report.json, read only when every step of
 * the part ended with status 0, or null; why: why there is none to read. expect: what this
 * run's report must say of itself, { plan (the SHA-256 of the run's plan file), base, head,
 * dry, K (the K this run's pilot sized), from (that pilot's run id) }. state is "pass", "past"
 * (the threshold) or "not read"; text is what the row says. The change's figures are read from
 * one place, the report's own measure. A value no report of the kit's holds may make this
 * throw, which a run catches as "not read".
 */
export function reading(threshold, workload, { report = null, why = null, expect = null } = {}) {
  const not = (text) => ({ workload, state: "not read", text });
  if (why) return not(why);
  if (!obj(report)) return not("the gated part left no report");
  if (report.exit === 2 || report.refused) return not(`the kit refused the results: ${Array.isArray(report.refused) && report.refused.length ? report.refused[0] : "no reason given"}`);
  const g = report.gated, c = report[`change-${workload}`]?.measures?.[GATE]?.recorded;
  if (report.part !== "gated" || report.workload !== workload || !obj(g) || !obj(c) || !obj(report.complete)) return not("the report is not a gated part's of this workload");
  if (!obj(expect)) return not("nothing says which run the report is to be of");
  for (const k of ["plan", "base", "head"]) if (typeof report[k] !== "string" || report[k] !== expect[k]) return not(`the report is of another ${k} than this run's`);
  if (report.dry !== Boolean(expect.dry)) return not(report.dry === true ? "the report is a dry run's, and this run is not one" : "the report is not a dry run's, and this run is one");
  const complete = report.exit === 0 && report.complete[`aa-${workload}`] === true && report.complete[`change-${workload}`] === true;
  const figures = `${fmt(c.lower)} to ${fmt(c.bound)}, median ${fmt(c.median)}, K = ${report.K}`;
  if (report.dry) return { ...not(`DRY RUN, read for nothing (${figures})`), dry: true, complete };
  if (!complete) return not("the gated part is not complete: a comparison without all its placements has no bound");
  if (!Number.isInteger(report.K) || report.K < K_MIN || report.K > K_MAX || !obj(report.sized) || report.sized.K !== report.K) return not("K was not checked by the kit");
  if (report.K !== expect.K || report.sized.from !== expect.from) return not(`K = ${report.K} is not the K this run's pilot sized`);
  const number = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
  if (g.resolution === "no bound" || !number(g.aaBound, g.aaBoundSwapped)) return not("the A/A has no bound");
  if (g.resolution !== "resolved") return not(`the A/A did not resolve (bounds ${fmt(g.aaBound)} and ${fmt(g.aaBoundSwapped)}, against +1%)`);
  if (!number(c.lower, c.bound, c.median)) return not("main against the release has no bound");
  return { workload, state: c.lower >= threshold ? "past" : "pass", text: `${figures}, A/A resolved`, lower: c.lower, bound: c.bound, median: c.median };
}

/**
 * A run's reading, the row's last cell: a pass only when every workload passes, and a pass
 * says what it is, that the run showed no rise of the threshold, not that there is none.
 */
export function verdict(threshold, readings) {
  const of = (state) => readings.filter((r) => r.state === state).map((r) => `\`${r.workload}\``).join(", ");
  if (readings.length && readings.every((r) => r.state === "pass")) return `pass: no rise of ${pct(threshold)} shown`;
  return [of("past") && `past ${pct(threshold)}: ${of("past")}`, of("not read") && `not read: ${of("not read")}`].filter(Boolean).join("; ");
}

const link = (commit) => `[\`${short(commit)}\`](${REPOSITORY}/commit/${commit})`;

/**
 * The page's row for a run: { date, tag, base, head, threshold, readings, differ }, base and
 * head full commit ids, differ the workloads whose two sides answer differently.
 */
export function row({ date, tag, base, head, threshold, readings, differ = [] }) {
  const alike = readings.length > 1 && readings.every((r) => r.state === "not read" && r.text === readings[0].text);
  const each = (r) => `\`${r.workload}\` ${r.state === "not read" ? "not read: " : ""}${r.text}${differ.includes(r.workload) && r.state !== "not read" ? ", answers differ as recorded" : ""}`;
  const workloads = alike ? `not read: ${readings[0].text}` : readings.map(each).join("; ");
  return `| ${date} | ${tag} ${link(base)} | ${link(head)} | ${cell(workloads)} | ${cell(verdict(threshold, readings))} |`;
}

const ID = `\\[\`([0-9a-f]{9})\`\\]\\(${REPOSITORY.replace(/[.\/]/g, "\\$&")}\\/commit\\/([0-9a-f]{40})\\)`;
const ROW = new RegExp(`^\\| (\\d{4}-\\d{2}-\\d{2}) \\| (v\\d+\\.\\d+\\.\\d+) ${ID} \\| ${ID} \\| (.*) \\| ((?:[^|\\\\]|\\\\.)*) \\|$`);

/** A line as row() writes one, { date, tag, base, head, workloads, reading }, or null. */
function parsed(line) {
  const m = ROW.exec(line);
  return m && m[4].startsWith(m[3]) && m[6].startsWith(m[5]) ? { date: m[1], tag: m[2], base: m[4], head: m[6], workloads: m[7], reading: m[8] } : null;
}

/**
 * The page as both reading and adding a row take it, or an error saying why it is not one:
 * one kind of line ending, the table's two heading lines once, under them rows this command
 * wrote, the newest first and one a date, and nothing else to the page's end.
 */
function table(page) {
  const eol = page.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n" && /(^|[^\r])\n/.test(page)) throw new Error("the page has lines that end in two ways, CRLF and LF");
  const lines = page.split(eol), at = lines.indexOf(TABLE[0]);
  if (at < 0 || lines.lastIndexOf(TABLE[0]) !== at || lines[at + 1] !== TABLE[1]) throw new Error("the page has no table of runs: its two heading lines are not there once, as trend.mjs writes them");
  const rest = lines.slice(at + 2), rows = [];
  let n = 0;
  for (; n < rest.length && rest[n] !== ""; n++) {
    const r = parsed(rest[n]);
    if (!r) throw new Error(`the page has a row trend.mjs did not write: ${rest[n]}`);
    if (rows.length && !(r.date < rows.at(-1).date)) throw new Error(`the page's rows are not the newest first, one a date: ${r.date} is under ${rows.at(-1).date}`);
    rows.push(r);
  }
  const under = rest.slice(n).find((l) => l !== "");
  if (under !== undefined) throw new Error(`the page has text under its table's rows, which end the page: ${under}`);
  return { eol, lines, at, rows };
}

/** The page's rows, newest first, each { date, tag, base, head, workloads, reading }. */
export const rows = (page) => table(page).rows;

/** The page with a run's row added under the table's heading, above every earlier row. */
export function insert(page, line) {
  const t = table(page), r = parsed(line);
  if (!r) throw new Error(`not a row trend.mjs writes: ${line}`);
  if (t.rows.length && !(t.rows[0].date < r.date)) throw new Error(`the page already has a row of ${t.rows[0].date}, and a row goes above rows of earlier dates alone`);
  t.lines.splice(t.at + 2, 0, line);
  return t.lines.join(t.eol);
}

/** `git log --format=%H%x1f%s%x1f%b%x1e` output as { hash, subject, body } records, or null when it is not that. */
export function history(text) {
  const parts = text.split("\x1e"), out = [];
  if (parts.pop().trim() !== "") return null;
  for (const part of parts) {
    const f = part.replace(/^\r?\n/, "").split("\x1f");
    if (f.length !== 3 || !HEX40.test(f[0])) return null;
    out.push({ hash: f[0], subject: f[1], body: f[2] });
  }
  return out;
}

/**
 * The pull requests a range of `main` merged, from history()'s records: a merge commit's (its
 * title is the body's first line) and a squash's (the subject ends with its number). A commit
 * that names none is kept by its hash.
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
 * A draft of an issue for a run past its threshold: { title, body }. run: what row() takes,
 * with line (its row); since, the row before it when the checkout has its commit, or null;
 * note, why a row before it is not where the list starts, or null; prs, merged()'s list from
 * that row (or the release) to this run, or null when the history could not be read, with
 * unread saying why; expected, workload names to the difference recorded between the two
 * sides' answers.
 */
export function issue({ date, tag, base, head, threshold, readings, line, since = null, note = null, prs, unread = null, expected = {} }) {
  const past = readings.filter((r) => r.state === "past"), names = past.map((r) => `\`${r.workload}\``).join(" and ");
  const title = `Trend: main costs a request at least ${pct(threshold)} more cycles than ${tag} on ${past.map((r) => r.workload).join(" and ")} (run of ${date})`;
  const from = since ? `the row before this one (${since.date}, \`${short(since.head)}\`)` : tag;
  const body = [
    `The trend run of ${date} read \`main\` at \`${short(head)}\` against ${tag} (\`${short(base)}\`) across placements and is past its threshold on ${names}: the lower bound of the change in user plus kernel cycles a request is at or above ${pct(threshold)}.`, "",
    ...TABLE, line, "",
    ...past.map((r) => `- \`${r.workload}\`: lower bound ${pct(r.lower)}, median ${pct(r.median)}, bound ${pct(r.bound)}.`), "",
    `It blocks no merge ([CONTRIBUTING.md](${REPOSITORY}/blob/main/CONTRIBUTING.md#pull-requests), item 2.1, Trend). The run reads every change since the release together and attributes a cost to none of them; the list below is where to look.`, "",
    `This is a draft the run's command wrote; it opened nothing. Whether it becomes an issue of its own or is added to one already open for ${tag} is for whoever reads it.`, "",
    ...(since ? [`The row before this one (${since.date}) reads: ${since.reading}.`, ""] : note ? [note, ""] : ["The page has no row before this one.", ""]),
    ...Object.entries(expected).flatMap(([w, text]) => [`\`${w}\`: \`main\` and ${tag} answer its request differently, so part of the change may be what the answer now holds. The run recorded this difference before any turn and nobody reviewed it:`, "", "```", ...text.replace(/\n$/, "").split("\n"), "```", ""]),
    ...(prs === null
      ? [`The pull requests \`main\` merged from ${from} to this run could not be read from the run's checkout (${unread}). That is not "none": read them in a full clone with \`git log --first-parent ${since ? since.head : base}..${head}\`.`, ""]
      : [`Merged from ${from} to this run, ${prs.length} on \`main\`'s first-parent line. Add to each line what its description says after \`Request path:\` and, for a counted change, the cost it stated:`, "",
        ...(prs.length ? prs.map((p) => (p.number ? `- [#${p.number} ${p.title}](${REPOSITORY}/pull/${p.number})` : `- \`${short(p.commit)}\` ${p.title} (no pull request named)`)) : ["- none: `main` has no commit in that interval"]), ""]),
  ].join("\n");
  return { title, body };
}

const BODIES = /^body (\d+) bytes as received, sha256 ([0-9a-f]{16}) A and ([0-9a-f]{16}) B$/;

/**
 * The text of a file the kit left, read only when it is a regular file of its own: never
 * through a link, and a FIFO or a device is never opened, so no read of one can hold the run.
 * Throws an error with code ENOTREG for anything else, and lstat's when it is not there.
 */
export const regular = (file) => regularBytes(file).toString("utf8");

/** Whether a path is there, a link or a FIFO included, without opening or following it. */
function there(file) {
  try { lstatSync(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

/**
 * What turns.sh kept of the two bodies it compared, its answers/bodies.txt: { line, bytes, a, b },
 * or null when the file is not that. One that is not a regular file is not read: that throws.
 */
export function bodies(file) {
  let text;
  try { text = regular(file); } catch (e) { if (e.code === "ENOTREG") throw e; return null; }
  const m = BODIES.exec(text.replace(/\r?\n$/, ""));
  return m && { line: m[0], bytes: Number(m[1]), a: m[2], b: m[3] };
}

/**
 * Why the placements a part was resolved to have (schedule: its resolved.json's, each
 * { comparison, i }) did not every one answer with the two bodies the check kept, or null:
 * the release's on both sides of an A/A, the release's and main's in the change.
 */
export function stray(results, schedule, w, kept) {
  for (const { comparison: c, i } of schedule) {
    const d = `p${String(i).padStart(3, "0")}`, b = c === `change-${w}` ? kept.b : kept.a;
    let got;
    try { got = bodies(join(results, c, d, "answers", "bodies.txt")); } catch (e) { if (e.code === "ENOTREG") return `${c} ${d}: ${e.message}`; throw e; }
    if (!got || got.bytes !== kept.bytes || got.a !== kept.a || got.b !== b) return `${c} ${d} answered with other bodies than the run recorded before any turn (${got ? got.line : "no bodies.txt as the kit writes it"}; recorded: sha256 ${kept.a} and ${b})`;
  }
  return null;
}

/** What a step that failed said: the last line of its output a reader can use (a file that is not there said nothing). */
function said(log, pattern = /\S/) {
  const lines = there(log) ? regular(log).split(/\r?\n/).filter((l) => pattern.test(l)) : [];
  return (lines.at(-1) ?? "it printed nothing").trim().slice(0, 400);
}

/** Runs a command with its output in a file, or returned when no file is given. */
function execute(command, args, { env = process.env, log = null } = {}) {
  if (!log) { const r = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 1 << 28 }); return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") }; }
  const fd = openSync(log, "a");
  try { const r = spawnSync(command, args, { env, stdio: ["ignore", fd, fd] }); return { status: r.status ?? 1 }; } finally { closeSync(fd); }
}

/**
 * The two sides' unpadded binaries, started once each and their answers compared as turns.sh
 * compares a placement's, with no pair turned and under a placement's time limit, as verify.sh
 * calls it (timeout signals turns.sh's whole process group, its servers included, TERM and 30 s
 * later KILL, and then exits 124 or 137): $1 is a work directory build.sh has built. turns.sh
 * keeps what it compared under its own directory's answers/, so this leaves
 * <work dir>/compare/answers/diff.txt, the text a plan's `expect` holds, and bodies.txt.
 */
export const ANSWERS = '. "$1/plan/resolved.sh" && export KIT START REQ_PATH STATUS EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C TURN PORT_A PORT_B && HEADERS="$1/plan/headers.txt" SCRIPT="$1/plan/request.lua" MASK="$1/plan/mask.sed" MASK_JSON="$1/plan/mask.json" WARMUP=0 EXPECT= exec timeout -k 30 "$PLACEMENT_SECONDS" taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" "$1/compare" "$W" 0 "$1/bin/base" "$1/bin/head"';

/** A path with every part of it that exists resolved to where it really is. */
function physical(p) {
  const rest = [];
  let at = path(p);
  while (!existsSync(at) && dirname(at) !== at) { rest.unshift(basename(at)); at = dirname(at); }
  return join(realpathSync(at), ...rest);
}

/** Whether a path is a directory or under it, by whole names. */
function within(root, p) {
  const rel = relative(root, p);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/**
 * A run. dir: the run's directory; plan and page: the trend's plan file and its page; date:
 * the run's date, YYYY-MM-DD; exec: what runs a command (a test gives its own); say: where a
 * line of progress goes. Returns { exit, line, readings, issue }, or throws an error marked
 * refused before anything is made or run.
 */
export function run({ dir, plan = PLAN, page = PAGE, date = new Date().toISOString().slice(0, 10), env = process.env, exec = execute, say = console.log }) {
  const refuse = (why) => { const e = new Error(why); e.refused = true; throw e; };
  // git as this command asks it, never fetching an object the checkout lacks: a partial clone the check below misjudges fails there.
  const asks = (...args) => exec("git", ["-C", here, ...args], { env: { ...env, GIT_NO_LAZY_FETCH: "1" } });
  const git = (...args) => { const r = asks(...args); return r.status === 0 ? String(r.stdout ?? "").trim() : null; };
  const commit = (ref, missing) => {
    const out = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    if (out === null) refuse(missing);
    if (!HEX40.test(out)) refuse(`git gave no commit id for ${ref}: ${JSON.stringify(out.slice(0, 80))}`);
    return out;
  };
  const top = git("rev-parse", "--show-toplevel") ?? refuse("the kit is not in a git checkout");
  if (!dir || !isAbsolute(dir) || /\s/.test(dir)) refuse("the run's directory is an absolute path without white space");
  dir = physical(dir);
  if (/\s/.test(dir)) refuse("the run's directory is an absolute path without white space, and it leads to one with some");
  if (within(physical(top), dir)) refuse(`${dir} is inside the checkout: a run's directory is outside it`);
  const shallow = git("rev-parse", "--is-shallow-repository");
  if (shallow !== "false") refuse(shallow === "true" ? "the checkout is shallow, so the commits main merged since a row cannot all be listed from it: use a full clone (git fetch --unshallow)" : "git could not say whether the checkout is shallow");
  // A partial clone has a remote whose promisor is true, as git reads a boolean, or the older extensions.partialClone.
  const promisor = asks("config", "--type=bool", "--get-regexp", "^remote\\..*\\.promisor$"), extension = asks("config", "--get", "extensions.partialclone").status;
  if (promisor.status > 1 || promisor.status < 0 || extension > 1 || extension < 0) refuse("git could not say whether the checkout is a partial clone");
  if (extension === 0 || /^remote\..*\.promisor true$/m.test(String(promisor.stdout ?? ""))) refuse("the checkout is a partial clone (a remote of it is a promisor), which lacks objects and fetches them as they are read, so a run would build and list from what it does not hold: use a full clone");
  let t, bad;
  try { t = JSON.parse(readFileSync(plan, "utf8")); bad = problems(t); } catch (e) { refuse(`${plan} cannot be read as a trend plan: ${e.message}`); }
  if (bad.length) refuse(`${plan} is not a usable trend plan:\n  ${bad.join("\n  ")}`);
  const probe = path(dirname(plan), t.plan.probe.dir);
  if (!existsSync(probe)) refuse(`${probe}, the plan's probe, is not there`);
  const dry = env.DRYRUN === "1";
  let earlier;
  try { earlier = rows(readFileSync(page, "utf8")); } catch (e) { refuse(`${page}: ${e.message}`); }
  if (!dry && earlier[0]?.date >= date) refuse(`the page already has a row of ${earlier[0].date}: one run a date (UTC), each later than the page's rows, since the date gives a run its seeds and its plan's name`);
  const tags = git("tag", "--list", "v*") ?? refuse("git could not list the checkout's tags");
  const tag = latest(tags.split("\n")) ?? refuse("the checkout has no release tag vX.Y.Z: fetch the tags (git fetch --tags)");
  const base = commit(`refs/tags/${tag}`, `${tag} names no commit`);
  const head = commit(`refs/remotes/${t.head}`, `the checkout has no ${t.head} (refs/remotes/${t.head}): fetch it`);
  // The last refusal makes the directory, and makes it alone: two runs cannot share one.
  try { mkdirSync(dir); } catch (e) {
    refuse(e.code === "EEXIST" ? `${dir} is already there, and a run is made once in a directory of its own: nothing is run again for its result` : e.code === "ENOENT" ? `${dirname(dir)}, where the run's directory is to be made, is not there` : `${dir} cannot be made: ${e.message}`);
  }

  const names = t.plan.workloads.map((w) => w.name), logs = join(dir, "log");
  mkdirSync(logs);
  cpSync(probe, join(dir, "probe"), { recursive: true });
  const write = (name, expect) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(resolved(t, { base, head, date, expect }), null, 2) + "\n"); return f; };
  say(`trend ${date}${dry ? " (DRY RUN: a test of the scripts, read for nothing)" : ""}: ${t.head} ${head} against ${tag} ${base}; threshold ${pct(t.threshold)} on the lower bound; workloads ${names.join(", ")}`);

  // What a step or a file said, less the run's directory, which is this host's and not for the page.
  const clean = (s) => String(s).replaceAll(dir + sep, "").replaceAll(dir, "the run's directory");
  // A step of the kit, its output in the run's log directory: null when it ended with status 0.
  const step = (name, command, args, { env: e = env, pattern } = {}) => {
    const log = join(logs, `${name}.out`), status = exec(command, args, { env: e, log }).status;
    say(`${name}: ${status === 0 ? "done" : `exit ${status}`}`);
    return status === 0 ? null : { status, log, said: clean(said(log, pattern)) };
  };
  const kit = (f) => join(here, f), why = {}, expect = {}, expected = {}, kept = {};

  // Check: both sides built once for each workload with nothing turned, and their answers compared.
  // Whatever it left that cannot be read leaves that workload not read, and the check goes on.
  const check = write("check.json");
  for (const w of names) try {
    const work = join(dir, `check-${w}`);
    let failed = step(`check-${w}-plan`, process.execPath, [kit("plan.mjs"), check, "gated", w, work], { env: { ...env, DRYRUN: "1" } });
    if (failed) { why[w] = `plan.mjs refused the plan: ${failed.said}`; continue; }
    failed = step(`check-${w}-build`, "sh", [kit("build.sh"), work]);
    if (failed) {
      // The probe and its build command are the plan's, so a side that does not build for one
      // workload builds for none.
      const side = /^build: (base|head): the build failed$/m.exec(readFileSync(failed.log, "utf8"))?.[1];
      if (failed.status === 3) why[w] = clean(said(join(work, "bin", "refused.txt"))).replace(/^REFUSED: /, "the kit refuses the run: ");
      else if (side) { for (const x of names) why[x] ??= `the probe does not build at ${side === "base" ? tag : t.head}`; break; }
      else why[w] = `build.sh failed before any turn: ${failed.said}`;
      continue;
    }
    failed = step(`check-${w}-answers`, "sh", ["-c", ANSWERS, "sh", work]);
    // Stopped at its deadline, the check may have compared the answers already (diff.txt can be
    // there) but did not finish: its servers' stop is not confirmed, so nothing it left is read.
    if (failed && (failed.status === 124 || failed.status === 137)) { why[w] = `the check of the two sides' answers did not finish within a placement's time limit, ${t.plan.placementSeconds} s, and was stopped, its servers' cleanup unconfirmed`; continue; }
    // A difference is read only as turns.sh says one after a stop of both servers that passed its
    // checks (serve.mjs said each ended, and nothing accepted on either port when checked): its
    // status 4 and that line together. A difference it found and then failed to clean up after,
    // or any other failure, leaves the workload not read, and nothing that check left is opened:
    // turns.sh may have refused what was at diff.txt (a FIFO, say), which a read could wait on.
    const log = regular(join(logs, `check-${w}-answers.out`));
    const confirmed = failed?.status === 4 && log.split("\n").includes(`turns: ${w}: A and B answer differently; both servers ended and nothing accepted on either port when checked`);
    if (failed && !confirmed) { why[w] = `the two sides' answers could not be compared: ${failed.said}`; continue; }
    // What the check left is read as its handoff binds it, after the stop: the outcome turns.sh's
    // status says (the same for 0, a difference for 4), diff.txt and bodies.txt by the SHA-256s it
    // sealed, each read once, as a regular file of its own. Anything else leaves the workload not read.
    const sealed = handoff(join(work, "compare", "answers"), log, `turns: ${w}`, [failed ? "differ" : "same"]);
    if (typeof sealed === "string") { why[w] = `the two sides' answers were compared, and what the check left is not what it sealed: ${clean(sealed)}`; continue; }
    // diff.txt's bytes are kept as the sealed bytes, never through text, and made text only to say them.
    const diff = sealed.diff, shown = diff.toString("utf8"), b = sealed.bodies, differs = Boolean(failed);
    kept[w] = b;
    writeFileSync(join(dir, `bodies-${w}.txt`), `${b.line}\n`);
    if (differs) {
      expect[w] = `expect-${w}.txt`; expected[w] = shown;
      writeFileSync(join(dir, expect[w]), diff);
      say(`${w}: ${tag} and ${t.head} answer differently. The run records this difference, which nobody reviewed, and every placement must show it and no other:\n${shown}`);
    }
  } catch (e) { why[w] = `what the check before any turn left could not be read (${clean(e?.message ?? e)})`; }

  // The plan the parts are read from, and what it declares.
  const file = write("plan.json", expect), sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const declared = exec(process.execPath, [kit("plan.mjs"), file], { env });
  writeFileSync(join(dir, "declared.txt"), declared.stdout ?? "");
  if (declared.status !== 0) for (const w of names) why[w] ??= `plan.mjs refused the plan: ${clean(String(declared.stderr ?? "").trim().split("\n").at(-1))}`;
  else say(String(declared.stdout ?? "").trimEnd());

  // A workload's pilot and then its gated part, as README.md gives the commands, and its
  // reading, or why it has none. A part counts only when each of its steps ended with status 0
  // and every placement it was resolved to have answered with the bodies the check kept; a
  // report a failed part left is not read.
  const json = (...f) => JSON.parse(regular(join(...f)));
  const workload = (w) => {
    const pilot = join(dir, `${w}-pilot`), gated = join(dir, `${w}-gated`);
    const part = (name, work, more = []) => {
      let failed = step(`${w}-${name}-plan`, process.execPath, [kit("plan.mjs"), file, name, w, work, ...more], { pattern: /^plan\.mjs: |sizes no K|does not pass/ });
      if (failed) return `the ${name} part was not resolved: ${failed.said.replace(/^plan\.mjs: /, "")}`;
      failed = step(`${w}-${name}-build`, "sh", [kit("build.sh"), work]);
      if (failed) return failed.status === 3 ? clean(said(join(work, "bin", "refused.txt"))).replace(/^REFUSED: /, "the kit refuses the run: ") : `the ${name} part was not built: ${failed.said}`;
      failed = step(`${w}-${name}-run`, "sh", [kit("run.sh"), work], { pattern: /^RUN-ENDED / });
      if (failed) return `the ${name} part ended ${failed.said.replace(/^RUN-ENDED /, "")}`;
      const other = stray(join(work, "results"), json(work, "plan", "resolved.json").schedule, w, kept[w]);
      return other && `the ${name} part: ${clean(other)}`;
    };
    let failed = part("pilot", pilot);
    if (failed) return failed;
    const p = json(pilot, "results", "report.json");
    if (p.part !== "pilot" || p.workload !== w || p.plan !== sha || p.dry !== dry || p.exit !== 0) return "the pilot part's report is not a complete pilot's of this run";
    failed = part("gated", gated, ["--sized-from", join(pilot, "results")]);
    return failed || reading(t.threshold, w, { report: json(gated, "results", "report.json"), expect: { plan: sha, base, head, dry, K: p.pilot.sizing.ok === true ? p.pilot.sizing.K : null, from: p.run } });
  };
  // Whatever of a workload's own files cannot be read leaves that workload not read, and the row is still written.
  const readings = names.map((w) => {
    let r = why[w];
    if (!r) try { r = workload(w); } catch (e) { r = `the report could not be read (${clean(e?.message ?? e)})`; }
    return typeof r === "string" ? reading(t.threshold, w, { why: r }) : r;
  });
  const at = { date, tag, base, head, threshold: t.threshold, readings, differ: Object.keys(expect) }, line = row(at);
  // Kept with the run before the page is touched: the row, and the draft of an issue.
  writeFileSync(join(dir, "row.md"), `${dry ? "DRY RUN: a test of the scripts, read for nothing. This row is not the page's.\n\n" : ""}${TABLE.join("\n")}\n${line}\n`);
  let made = null;
  if (!dry && readings.some((r) => r.state === "past")) {
    // From the row before this one when this run's head descends from its commit, and else from the release.
    const prior = earlier[0] ?? null, placed = prior && asks("merge-base", "--is-ancestor", prior.head, head).status, since = placed === 0 ? prior : null;
    const note = prior && !since ? `The row before this one (${prior.date}) names \`${short(prior.head)}\`, ${placed === 1 ? "a commit this run's head does not descend from (`main` was moved back or rewritten since)" : "a commit git could not place before this run's head in the run's checkout"}, so the list below is from ${tag}: the commits \`main\` has that the release does not.` : null;
    const log = asks("log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", `${since ? since.head : base}..${head}`);
    const records = log.status === 0 ? history(String(log.stdout ?? "")) : null;
    made = issue({ ...at, line, since, note, prs: records && merged(records), unread: log.status === 0 ? "git log's output is not a list of commits" : `git log ended with status ${log.status}`, expected });
    writeFileSync(join(dir, "issue.md"), `${made.title}\n\n${made.body}`);
  }
  if (!dry) {
    // The page is replaced whole, by a file written beside it, so a run stopped here leaves it as it was or with the row.
    const next = insert(readFileSync(page, "utf8"), line), beside = `${page}.${process.pid}.tmp`;
    writeFileSync(beside, next);
    try { renameSync(beside, page); } catch (e) { rmSync(beside, { force: true }); throw e; }
  }
  say(`\n${TABLE.join("\n")}\n${line}\n\n${dry ? `DRY RUN: the row is in ${join(dir, "row.md")} alone` : `the row is in ${page}: commit it as it is. Keep each part's results under ${dir}, with its plan.json, row.md, expected differences and bodies: the row's figures are read from them`}`);
  if (made) say(`\nPast the threshold. A draft of an issue, kept as ${join(dir, "issue.md")}; the command opens nothing:\n\n${made.title}\n\n${made.body}`);
  const exit = dry ? (readings.every((r) => r.dry && r.complete) ? 0 : 3) : readings.some((r) => r.state === "not read") ? 3 : made ? 1 : 0;
  return { exit, line, readings, issue: made };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) { console.error("usage: node trend.mjs <run dir>   (a directory to make: an absolute path outside the checkout that is not there yet)"); process.exit(2); }
  try { process.exit(run({ dir: args[0] }).exit); } catch (e) { console.error(`trend.mjs: ${e.refused ? e.message : (e.stack ?? e)}`); process.exit(e.refused ? 2 : 4); }
}
