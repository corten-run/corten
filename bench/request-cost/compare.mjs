// What a change costs a request against its base: the kit's figures for two builds as one table,
// held to the rule a counted change passes by (CONTRIBUTING.md, Pull requests, item 2.1, Counted).
// The hosted job runs it (.github/workflows/request-cost.yml); nothing here is that job's, so it
// reads two builds counted on a host of one's own as well (README.md, The hosted job).
//
// Usage: node compare.mjs --readings
//          the runs to take on each build, a line each: the file a run's output goes to, then
//          the kit's script and its options (all but the probe's binary, --cpu and --port)
//        node compare.mjs <base's directory> <head's directory> [--description <file>] [--base <name>] [--head <name>]
//          the table and the verdict, in Markdown
//
// A build's directory holds what the kit printed with `--json`, a file a run, named as
// `--readings` names it; `answers/`, as `count.mjs --answers` wrote it; `own-http1`, the build's
// capability record, when present; beside a run that was
// refused or did not end, `<file>.refused`, a line each time saying why; and `unbuilt`, what the
// build said, when the probe did not build: a build with that file, empty or not, has no figure
// and no answer, whatever else its directory holds. A figure is read only from a run's whole
// output, of the case, depth, requests, connections and addresses asked for (`figure`): anything
// else is no figure.
//
// The rule: no case's instructions a request rise by more than +0.5% of base's, by the medians
// the kit gives; no case's allocations rise, by the calls themselves; and no idle reading rises,
// by `idleRise` (figures.mjs): the median of head's three growths of resident memory, in bytes
// (each run's after less its before), is not above base's by more than the larger of base's
// three span and one page, over at least as many connections as the page has bytes. The figures a
// connection are rounded and decide nothing. A reading with no figure on either build, an idle
// reading `idleRise` cannot decide (its six runs not of one page size, or 5,000 connections
// being fewer than a page has bytes), or a case either build gave no answer to, cannot be
// counted, which sends the change to the measured way as a rise does. But for one: if the base
// build records the switch absent and refused every switch-on reading and answer, those rows
// are not compared where head gave a valid figure or answer. A missing head result still fails
// the rule. One refusal on its own never establishes that the build cannot run the switch.
//
// `--description` is the pull request's description, read for the way the change is decided: its
// one line that is `Request path: counted` or `Request path: measured` with nothing after it
// but spaces and then the carriage return of a line that ends in one and a line feed
// (`declared`); with no such line, or more than one, it declares nothing. Exit status
// 1 when the rule does not hold and the description does not say `measured`, and when the probe
// did not build against head: a change declared measured is reported and never failed on its
// figures, and one that declares nothing fails only when the rule does not hold. Exit status 2
// for arguments that are not these.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COUNTED, checkIdleSample, idleRise, median, sent } from "./figures.mjs";
import { REFUSAL, builtWithoutOwnHttp1 } from "./own-http1.mjs";
import { Answers, cases, unexpected } from "./requests.mjs";

/** Idle readings taken on each build, and the counts of a case `count.mjs` takes in a run. */
export const RUNS = 3;
/** The cases also counted with their requests written 16 at a time (README.md, The cases). */
const DEEP = ["pipeline", "get", "unstaged", "text", "pipeline-own"];
/**
 * The idle readings: each of `idle.mjs`'s lines under Running it, of its 5,000 connections from
 * one address, and the same three with `App::own_http1` on.
 */
const IDLE = [
  { name: "request", what: "after one request", options: [], of: { case: "pipeline", requests: 1 } },
  { name: "browser", what: "after three of a browser's requests", options: ["--case", "get-browser", "--requests", "3"], of: { case: "get-browser", requests: 3 } },
  { name: "silent", what: "before any byte", options: ["--silent"], of: { case: "pipeline", requests: 0 } },
  { name: "request-own", what: "after one request, own_http1 on", options: ["--case", "pipeline-own"], of: { case: "pipeline-own", requests: 1 } },
  { name: "browser-own", what: "after three of a browser's requests, own_http1 on", options: ["--case", "get-browser-own", "--requests", "3"], of: { case: "get-browser-own", requests: 3 } },
  { name: "silent-own", what: "before any byte, own_http1 on", options: ["--silent", "--case", "pipeline-own"], of: { case: "pipeline-own", requests: 0 } },
];
const SIDES = /** @type {const} */ (["base", "head"]);

/**
 * The runs the rule reads, in the order to take them: every case's instructions, the five at a
 * depth of 16, every case's allocations, and each idle reading `RUNS` times, a reading's runs
 * apart from each other. Each is one run of a kit's script for one case, so a run the kit
 * refuses costs that case's figure alone. `expect` is what the run's JSON must say it is of.
 * @returns {{ file: string, script: "count.mjs" | "idle.mjs", options: string[], expect: Record<string, string | number> }[]}
 */
export function readings() {
  const names = Object.keys(cases);
  const count = (/** @type {string} */ kind, /** @type {string} */ name, /** @type {number} */ depth) => ({ kind, case: name, depth, requests: sent(COUNTED, depth) });
  /** @type {ReturnType<typeof readings>} */
  const all = [];
  for (const name of names) all.push({ file: `count-${name}.json`, script: "count.mjs", options: ["--json", "--cases", name], expect: count("instructions", name, 1) });
  for (const name of DEEP) all.push({ file: `count-16-${name}.json`, script: "count.mjs", options: ["--json", "--depth", "16", "--cases", name], expect: count("instructions", name, 16) });
  for (const name of names) all.push({ file: `allocations-${name}.json`, script: "count.mjs", options: ["--json", "--allocations", "--cases", name], expect: count("allocations", name, 1) });
  for (let run = 1; run <= RUNS; run += 1) for (const { name, options, of } of IDLE) all.push({ file: `idle-${name}-${run}.json`, script: "idle.mjs", options: ["--json", ...options], expect: { kind: "idle", ...of, connections: 5000, addresses: 1 } });
  return all;
}

/**
 * What a run printed with `--json`, when it is the whole of the run asked for: one JSON object,
 * every field of `expect` as given, whole numbers where the kit measures whole numbers, and for
 * instructions `RUNS` counts that are their windows' own and whose median is the one stated.
 * Null for anything else, so a figure is never read out of part of a run's output.
 * @param {string} text @param {Record<string, string | number>} expect @returns {any}
 */
export function figure(text, expect) {
  let found;
  try {
    found = JSON.parse(text);
  } catch {
    return null;
  }
  if (found === null || typeof found !== "object" || Object.hasOwn(found, "unsupported") || Object.entries(expect).some(([key, value]) => found[key] !== value)) return null;
  const whole = (/** @type {unknown} */ n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;
  if (expect.kind === "allocations") return whole(found.allocations) && whole(found.frees) && found.allocations >= found.requests ? found : null;
  // An idle run's growth is its after less its before, stated as `grown` too, with the page size
  // it was read in: a run printed before they were has no figure, its growth not guessed from its
  // rounded `bytes`.
  if (expect.kind === "idle") {
    // Resident memory is whole pages, so each reading of it is too, not only their difference.
    const paged = Number.isSafeInteger(found.page) && found.page > 0 && found.before % found.page === 0 && found.after % found.page === 0;
    const sound = Number.isSafeInteger(found.bytes) && whole(found.before) && whole(found.after) && found.grown === found.after - found.before && paged;
    return sound && found.bytes === Math.round(found.grown / found.connections) ? found : null;
  }
  const { counts, windows } = found;
  if (!Array.isArray(counts) || !Array.isArray(windows) || counts.length !== RUNS || windows.length !== RUNS || found.median !== median(counts)) return null;
  const sound = windows.every(
    (window, at) => window && whole(window.instructions) && window.instructions >= found.requests && counts[at] === Math.round(window.instructions / found.requests) && Number.isFinite(window.seconds) && window.seconds >= 0 && whole(window.others) && whole(window.threads),
  );
  return sound ? found : null;
}

/**
 * The way a description says its change is decided, and the numbers of its declaration lines. A
 * declaration line is a line of the description's text, as written, that is
 * `Request path: counted` or `Request path: measured` from its first character with nothing
 * after it but spaces, and then the one carriage return of a line that ends in a carriage
 * return and a line feed, wherever it stands: no Markdown is read, so a line in an example, a
 * quote or a comment is one as well. The description declares a way only when it has exactly
 * one: with none, or more than one whether or not they agree, `way` is null.
 * @param {string} description @returns {{ way: "counted" | "measured" | null, lines: number[] }}
 */
export function declared(description) {
  const found = description.split("\n").flatMap((line, at) => {
    const way = /^Request path: (counted|measured) *\r?$/.exec(line)?.[1];
    return way ? [{ way: /** @type {"counted" | "measured"} */ (way), line: at + 1 }] : [];
  });
  return { way: found.length === 1 ? /** @type {typeof found[number]} */ (found[0]).way : null, lines: found.map(({ line }) => line) };
}

/** Whether a case's instructions rose by more than the budget, 0.5% of base's. @param {number} base @param {number} head */
export const over = (base, head) => (head - base) * 200 > base;

/** A file's lines that say something, each cut to what a table can hold. @param {string} at */
const lines = (at) => (existsSync(at) ? readFileSync(at, "utf8").split("\n").map((line) => line.trim().replace(/^Error: /, "").slice(0, 300)).filter(Boolean) : []);

/**
 * What the probe said when it could not run a case with `App::own_http1` on, being built without
 * that switch, when a run's whole output is the JSON of the run asked for saying so: null for
 * anything else, and for a case with the switch off, which every build can run.
 * @param {string} text @param {Record<string, string | number>} expect @returns {string | null}
 */
export function unsupported(text, expect) {
  let found;
  try {
    found = JSON.parse(text);
  } catch {
    return null;
  }
  if (found === null || typeof found !== "object" || cases[expect.case]?.own !== true) return null;
  const keys = [...Object.keys(expect), "unsupported"];
  if (Object.keys(found).length !== keys.length || keys.some((key) => !Object.hasOwn(found, key))) return null;
  if (Object.entries(expect).some(([key, value]) => found[key] !== value)) return null;
  return found.unsupported === REFUSAL ? REFUSAL : null;
}

/**
 * What a run left in a build's directory: its figure, or why there is none, and why each attempt
 * that gave none did not; `unsupported`, what the probe said, when it could not run the case.
 * @param {string} directory @param {ReturnType<typeof readings>[number]} reading
 * @returns {{ figure: any, why: string, refused: string[], unsupported?: string }}
 */
function taken(directory, { file, expect }) {
  const at = join(directory, file);
  const refused = lines(`${at}.refused`);
  if (!existsSync(at)) return { figure: null, why: refused.at(-1) ?? "the run left no output", refused };
  const text = readFileSync(at, "utf8");
  const found = figure(text, expect);
  const without = found === null ? unsupported(text, expect) : null;
  if (without !== null) return { figure: null, why: without, refused, unsupported: without };
  return { figure: found, why: found === null ? (expect.kind === "idle" && unpaged(text) ? "the run gives no page size or growth, as idle.mjs printed before them, and its growth is not guessed from its figure" : "the run's output is not the whole of the run asked for") : "", refused };
}

/**
 * A case's capture: one whole answer the case must get, or the probe's exact refusal and no
 * capture at all. A directory with both files has contradictory evidence.
 * @param {string} directory @param {string} name
 * @returns {{ bytes: Buffer, why: string | null, unsupported?: string }}
 */
function captured(directory, name) {
  const file = join(directory, "answers", `${name}.http`);
  const refusal = join(directory, "answers", `${name}.unsupported`);
  const present = existsSync(file);
  const bytes = present ? readFileSync(file) : Buffer.alloc(0);
  if (cases[name]?.own && existsSync(refusal)) {
    if (present) return { bytes, why: "both a capture and a refusal" };
    if (readFileSync(refusal, "utf8") === `${REFUSAL}\n`) return { bytes, why: REFUSAL, unsupported: REFUSAL };
    return { bytes, why: "the refusal is not the probe's own line" };
  }
  try {
    if (bytes.length === 0) return { bytes, why: "no capture" };
    if (new Answers().push(bytes)[0]?.length !== bytes.length) return { bytes, why: "not one whole answer and no more" };
    return { bytes, why: unexpected(name, bytes) };
  } catch (error) {
    return { bytes, why: /** @type {Error} */ (error).message };
  }
}

/** Whether a run's output is an idle run's JSON without a page size or a growth. @param {string} text */
function unpaged(text) {
  try {
    const found = JSON.parse(text);
    return found !== null && typeof found === "object" && found.kind === "idle" && (!("page" in found) || !("grown" in found));
  } catch {
    return false;
  }
}

const whole = (/** @type {number} */ n) => n.toLocaleString("en-US");
const signed = (/** @type {number} */ n) => (n > 0 ? "+" : "") + whole(n);
const percent = (/** @type {number} */ base, /** @type {number} */ head, digits = 2) => {
  if (base === 0) return "";
  const text = (((head - base) / base) * 100).toFixed(digits);
  return `${head > base ? "+" : ""}${Number(text) === 0 ? text.replace("-", "") : text}%`;
};
/** Text as inline code, whatever it holds. @param {string} text */
const code = (text) => `\`${text.replaceAll("`", "'").replaceAll("|", "/")}\``;
const short = (/** @type {string} */ name) => (/^[0-9a-f]{40}$/.test(name) ? name.slice(0, 9) : name);
const table = (/** @type {string[]} */ head, /** @type {string[][]} */ rows) =>
  [`| ${head.join(" | ")} |`, `| ${head.map((_, column) => (column === 0 || column >= head.length - 3 ? "---" : "---:")).join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");

/**
 * The table and the verdict for two builds' directories.
 * @param {string} base @param {string} head
 * @param {{ description?: string, names?: { base: string, head: string } }} [given] the pull
 *   request's description, and what to call the builds
 * @returns {{ markdown: string, status: 0 | 1, holds: boolean }}
 */
export function compare(base, head, { description = "", names = { base: "base", head: "head" } } = {}) {
  const at = { base, head };
  const runs = readings();
  const namesOfCases = Object.keys(cases);
  const plan = Object.fromEntries(runs.map((reading) => [reading.file, reading]));
  /**
   * What a build that failed said last. The file being there is the failure, empty or not: such a
   * build has no figure and no answer, whatever else its directory holds, which is said of it once.
   */
  const failed = (/** @type {string} */ directory) => (existsSync(join(directory, "unbuilt")) ? (lines(join(directory, "unbuilt")).at(-1) ?? "the build left no word of why") : undefined);
  const unbuilt = { base: failed(base), head: failed(head) };
  /** What keeps the rule from holding, each a clause of the verdict. @type {string[]} */
  const against = SIDES.filter((side) => unbuilt[side] !== undefined).map((side) => `the probe did not build against ${side} (${code(/** @type {string} */ (unbuilt[side]))})`);
  const evidence = (/** @type {"base" | "head"} */ side) => {
    const built = unbuilt[side] === undefined;
    const figures = new Map(runs.map((reading) => [reading.file, built ? taken(at[side], reading) : { figure: null, why: "", refused: [], unsupported: undefined }]));
    const answers = new Map(namesOfCases.map((name) => [name, built ? captured(at[side], name) : { bytes: Buffer.alloc(0), why: "no capture", unsupported: undefined }]));
    const recorded = built && builtWithoutOwnHttp1(join(at[side], "own-http1"));
    const without = recorded &&
      runs.every(({ file, expect }) => !cases[expect.case]?.own || figures.get(file)?.unsupported === REFUSAL) &&
      namesOfCases.every((name) => !cases[name]?.own || answers.get(name)?.unsupported === REFUSAL);
    if (recorded && !without) against.push(`${side}'s build records own_http1 absent but did not refuse every switch-on reading and answer`);
    return { figures, answers, without };
  };
  const builds = { base: evidence("base"), head: evidence("head") };
  /** @type {string[]} */
  const refusals = [];
  /** Says what the builds that were built lack: `whys` is why, for each build that lacks it. @param {string} what @param {{ base?: string, head?: string }} whys */
  const lacks = (what, whys) => {
    const none = SIDES.filter((side) => whys[side] !== undefined && unbuilt[side] === undefined);
    if (none.length > 0) against.push(`${what} on ${none.join(" and ")} (${code(/** @type {string} */ (whys[/** @type {"base" | "head"} */ (none[0])]))})`);
  };
  // A missing capability excuses base's evidence, never head's. Decide whether to waive the
  // comparison only after the whole row's head evidence has been checked.
  const baseCannotRun = (/** @type {string | number} */ name) => builds.base.without && cases[name]?.own === true;
  const uncompared = new Set();
  let missingHead = false;
  const waiveComparison = (/** @type {string} */ name, /** @type {boolean} */ headValid) => {
    if (!baseCannotRun(name)) return false;
    if (headValid) uncompared.add(name);
    else missingHead = true;
    return headValid;
  };
  /** Both builds' figures of a run. @param {string} file @param {string} what @returns {[any, any]} */
  const figuresFor = (file, what) => {
    const reading = /** @type {ReturnType<typeof readings>[number]} */ (plan[file]);
    const name = String(reading.expect.case);
    const found = { base: /** @type {ReturnType<typeof taken>} */ (builds.base.figures.get(file)), head: /** @type {ReturnType<typeof taken>} */ (builds.head.figures.get(file)) };
    for (const side of SIDES) for (const reason of found[side].refused) refusals.push(`- ${code(file)} on ${side}: ${code(reason)}${found[side].figure === null ? "" : " (taken again, and counted)"}`);
    const none = SIDES.filter((side) => found[side].figure === null && (side !== "base" || !baseCannotRun(name)));
    lacks(`${what} has no figure`, Object.fromEntries(none.map((side) => [side, found[side].why])));
    return [found.base.figure, found.head.figure];
  };

  const instructions = [...namesOfCases.map((name) => ({ name, file: `count-${name}.json`, label: code(name) })), ...DEEP.map((name) => ({ name, file: `count-16-${name}.json`, label: `${code(name)}, 16 at a time` }))].map(({ name, file, label }) => {
    const [b, h] = figuresFor(file, `${label}'s instructions`);
    const waived = waiveComparison(name, h !== null);
    // The counts, the longest window, and the most that threads other than the serving one ran in a window.
    const runs = (/** @type {any} */ side) => {
      if (!side) return "none";
      const most = side.windows.reduce((/** @type {any} */ most, /** @type {any} */ window) => (window.others > most.others ? window : most));
      return `${side.counts.join(" ")} (${Math.max(...side.windows.map((/** @type {any} */ window) => window.seconds)).toFixed(1)} s; others ${most.others} in ${most.threads})`;
    };
    if (!b || !h) return [label, b ? whole(b.median) : "none", h ? whole(h.median) : "none", "", "", runs(b), runs(h), waived ? "not compared" : "no figure"];
    const high = over(b.median, h.median);
    // The budget in instructions is the most a case may rise by: 0.5% of base's, rounded down.
    if (high) against.push(`${label} runs ${whole(h.median - b.median)} more instructions a request than base's ${whole(b.median)}, over the budget of ${whole(Math.floor(b.median / 200))} (+0.5%)`);
    return [label, whole(b.median), whole(h.median), signed(h.median - b.median), percent(b.median, h.median, 3), runs(b), runs(h), high ? "over the budget" : ""];
  });

  const allocations = namesOfCases.map((name) => {
    const [b, h] = figuresFor(`allocations-${name}.json`, `${code(name)}'s allocations`);
    const waived = waiveComparison(name, h !== null);
    const each = (/** @type {any} */ side) => (side ? (side.allocations / side.requests).toFixed(2) : "none");
    const calls = (/** @type {any} */ side) => (side ? `${whole(side.allocations)} and ${whole(side.frees)} frees` : "none");
    if (!b || !h) return [code(name), each(b), each(h), "", "", calls(b), calls(h), waived ? "not compared" : "no figure"];
    // By the calls themselves, over the same requests: a rise the two places of a rate hide is a rise.
    const more = h.allocations - b.allocations;
    if (more > 0) against.push(`${code(name)} makes ${whole(more)} more allocations in ${whole(h.requests)} requests (${whole(b.allocations)} to ${whole(h.allocations)})`);
    return [code(name), each(b), each(h), `${signed(more)} in ${whole(h.requests)}`, percent(b.allocations, h.allocations), calls(b), calls(h), more > 0 ? "rose" : ""];
  });

  // An idle reading is decided by its growths in bytes, not by the figures a connection, which
  // are rounded: `idleRise` is the rule, and a reading it cannot decide is not counted.
  const connections = /** @type {number} */ (/** @type {ReturnType<typeof readings>[number]} */ (plan["idle-request-1.json"]).expect.connections);
  /** Each idle run's record, as `idle.mjs` prints it on a host, with what decides: its before, after, growth and page size. */
  const records = /** @type {string[]} */ ([]);
  const mixedPages = (/** @type {number[]} */ pages) => `its runs read pages of ${pages.map(whole).join(" and ")} bytes, and the rule compares runs of one page size`;
  const idle = IDLE.map(({ name, what, of }) => {
    const runs = Array.from({ length: RUNS }, (_, at) => figuresFor(`idle-${name}-${at + 1}.json`, `idle memory ${what}, run ${at + 1},`));
    const reading = (/** @type {"base" | "head"} */ side, /** @type {0 | 1} */ column) => {
      const found = runs.map((run) => run[column]);
      for (const [at, run] of found.entries()) {
        if (run === null) continue;
        const did = run.requests === 0 ? `sent nothing to the probe for ${run.case}` : `answered ${run.requests} ${run.case}`;
        records.push(`${side}, ${what}, run ${at + 1}: ${run.bytes} bytes a connection (${run.connections} that ${did}, from ${run.addresses} address; ${run.before} before, ${run.after} after, ${run.grown} grown, in ${run.page}-byte pages)`);
      }
      const shown = found.map((run) => (run === null ? "none" : `${whole(run.grown)} (${whole(run.bytes)})`)).join(" ");
      // A median of fewer than three is not the rule's. Each figure is already of the case,
      // connections and addresses asked for, with a growth in whole pages.
      if (found.some((run) => run === null)) return { shown, sample: null };
      const growths = found.map((run) => /** @type {number} */ (run.grown));
      const pages = [...new Set(found.map((run) => /** @type {number} */ (run.page)))];
      const page = /** @type {number} */ (pages[0]);
      let why = pages.length !== 1 ? mixedPages(pages) : null;
      if (why === null) {
        try {
          checkIdleSample(side, growths, page, connections);
        } catch (error) {
          why = /** @type {Error} */ (error).message;
        }
      }
      return { shown, sample: { growths, pages, page, middle: median(growths), why } };
    };
    const b = reading("base", 0);
    const h = reading("head", 1);
    const waived = waiveComparison(of.case, h.sample?.why === null);
    const show = (/** @type {number | undefined} */ n) => n === undefined ? "none" : whole(n);
    const start = [what, show(b.sample?.middle), show(h.sample?.middle)];
    if (waived) return [...start, "", "", "", b.shown, h.shown, "not compared"];
    if (!h.sample || (!b.sample && !baseCannotRun(of.case))) return [...start, "", "", "", b.shown, h.shown, "no figure"];
    const pages = [...new Set([...(b.sample?.pages ?? []), ...h.sample.pages])];
    const why = pages.length !== 1 ? mixedPages(pages) : b.sample?.why ?? h.sample.why;
    const difference = b.sample ? [signed(h.sample.middle - b.sample.middle), percent(b.sample.middle, h.sample.middle)] : ["", ""];
    if (why !== null) {
      against.push(`idle memory ${what} is not decided (${code(why)})`);
      return [...start, ...difference, "", b.shown, h.shown, "not decided"];
    }
    // The only way for a row with sound head evidence and no base sample to reach here is
    // ruled out above: it was either waived or had no figure.
    const bases = /** @type {NonNullable<typeof b.sample>} */ (b.sample);
    const { page, middle: high } = h.sample;
    const { rise, allowed, rose } = idleRise({ base: bases.growths, head: h.sample.growths, page, connections });
    if (rose) against.push(`idle memory ${what} rises: the median of head's growths, ${whole(high)} bytes over ${whole(connections)} connections, is above base's ${whole(bases.middle)} by ${whole(rise)}, more than the ${whole(allowed)} allowed (the larger of base's span and a ${whole(page)}-byte page)`);
    return [...start, ...difference, whole(allowed), b.shown, h.shown, rose ? "rose" : ""];
  });

  const answers = namesOfCases.map((name) => {
    const found = { base: /** @type {ReturnType<typeof captured>} */ (builds.base.answers.get(name)), head: /** @type {ReturnType<typeof captured>} */ (builds.head.answers.get(name)) };
    const none = SIDES.filter((side) => found[side].why !== null && (side !== "base" || !baseCannotRun(name)));
    lacks(`${code(name)} has no answer`, Object.fromEntries(none.map((side) => [side, /** @type {string} */ (found[side].why).split("\n")[0]])));
    if (waiveComparison(name, found.head.why === null)) return { name, state: "uncompared" };
    return { name, state: none.length > 0 ? "none" : found.base.bytes.equals(found.head.bytes) ? "same" : "differ" };
  });
  const differ = answers.filter(({ state }) => state === "differ").map(({ name }) => code(name));
  const unread = answers.filter(({ state }) => state === "none").map(({ name }) => code(name));
  const compared = answers.filter(({ state }) => state !== "uncompared").length;
  const answered = [
    differ.length > 0 ? `The two builds answer differently in ${differ.join(", ")}: a count of two builds that answer differently compares two different jobs, which the review weighs.` : "",
    unread.length > 0 ? `No answer to compare in ${unread.join(", ")}.` : "",
    differ.length + unread.length === 0 ? `Both builds give the same answer, byte for byte with its \`Date\` and \`ETag\` masked, in ${compared === answers.length ? "all " : ""}${compared} cases${compared === answers.length ? "" : " both ran"}.` : "",
  ].filter(Boolean).join(" ");
  // Said with the verdict, which covers only what was compared.
  const notCompared =
    uncompared.size === 0
      ? ""
      : ` Not compared, so neither passed nor failed: ${[...uncompared].map(code).join(", ")}, which base's probe could not run (${code(REFUSAL)})${missingHead ? ", only for rows and answers head completed" : ""}.`;

  const { way, lines: declaring } = declared(description);
  // What was read of the description, so that an author sees why a line did or did not count.
  const read =
    way !== null
      ? `Read from the description: \`Request path: ${way}\`, at line ${declaring[0]}.`
      : declaring.length === 0
        ? "Read from the description: no declaration line."
        : `Read from the description: ${declaring.length} declaration lines, at lines ${declaring.join(", ")}: a description holds one, so this one declares nothing.`;
  const holds = against.length === 0;
  const why = against.join("; ");
  const rule = "CONTRIBUTING.md (Pull requests, item 2.1)";
  const line = "exactly one line of its own in the description";
  /** @type {0 | 1} */
  let status = 0;
  let verdict;
  if (way === "counted" && holds) {
    verdict = `**Passes as counted.** No case's instructions a request rise by more than +0.5% of base's, no case's allocations rise, idle memory does not rise, and both builds gave every case ${uncompared.size === 0 ? "" : "compared "}its answer. ${read}`;
  } else if (way === "counted") {
    status = 1;
    verdict = `**Does not pass as counted:** ${why}. ${read} By ${rule} the change is then measured: the description says \`Request path: measured\`, gives what the measured way asks, and keeps these counts.`;
  } else if (way === "measured") {
    verdict = `**Declared measured: these counts are reported and decide nothing.** As counted they would ${holds ? "pass" : `not pass: ${why}`}. ${read}`;
  } else if (holds) {
    verdict = `**Would pass as counted.** ${read} Say the way on ${line}, \`Request path: counted\` or \`Request path: measured\` (${rule}).`;
  } else {
    status = 1;
    verdict = `**Does not pass as counted:** ${why}. ${read} By ${rule} such a change is measured: say \`Request path: measured\` on ${line}, and give what the measured way asks.`;
  }
  verdict += notCompared;
  if (unbuilt.head !== undefined) {
    status = 1;
    verdict += " The job fails whatever the description says: the probe is the kit's, and a change it no longer builds against changes it in the same pull request.";
  }

  const markdown = [
    `## What a request costs: ${code(short(names.head))} against ${code(short(names.base))}`,
    verdict,
    answered,
    "### Instructions a request",
    table(["Case", "Base", "Head", "Difference", "Percent", "Base's counts", "Head's counts", "Rule"], instructions),
    "### Allocations a request",
    table(["Case", "Base", "Head", "Difference", "Percent", "Base's calls", "Head's calls", "Rule"], allocations),
    "### Memory idle connections hold",
    `Each run's growth of resident memory in bytes over its ${whole(connections)} connections, with its rounded figure a connection after it, which decides nothing; a rise is allowed up to the larger of base's three span and one page.`,
    table(["Reading", "Base's median", "Head's median", "Difference", "Percent", "Allowed", "Base's runs", "Head's runs", "Rule"], idle),
    "Each run, with what decides it (as `idle.mjs` prints a run on a host, and in its place in a description):",
    ["```text", ...records, "```"].join("\n"),
    ...(refusals.length > 0 ? ["### Runs that gave no figure", refusals.join("\n")] : []),
  ].join("\n\n");
  return { markdown: `${markdown}\n`, status, holds };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { readings: { type: "boolean", default: false }, description: { type: "string" }, base: { type: "string" }, head: { type: "string" } } });
  } catch (error) {
    parsed = null;
    console.error(/** @type {Error} */ (error).message);
  }
  const usage = "usage: node compare.mjs --readings | node compare.mjs <base's directory> <head's directory> [--description <file>] [--base <name>] [--head <name>]";
  if (parsed?.values.readings && parsed.positionals.length === 0) {
    for (const { file, script, options } of readings()) console.log([file, script, ...options].join(" "));
    return;
  }
  const [base, head] = parsed?.positionals ?? [];
  if (!parsed || !base || !head || parsed.positionals.length !== 2 || parsed.values.readings) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const { description, base: baseName, head: headName } = parsed.values;
  const { markdown, status } = compare(base, head, { description: description === undefined ? "" : readFileSync(description, "utf8"), names: { base: baseName ?? "base", head: headName ?? "head" } });
  process.stdout.write(markdown);
  process.exitCode = status;
}

// `import.meta.main` is Node 24.2's and 22.18's; before them, the script's own path.
if (import.meta.main ?? (process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) main();
