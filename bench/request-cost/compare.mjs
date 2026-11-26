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
// A build's directory holds what the kit printed, a file a run, named as `--readings` names it;
// `answers/`, as `count.mjs --answers` wrote it; and beside a run the kit refused,
// `<file>.refused`, what the kit said. A run that left no file gave no figure.
//
// The rule: no case's instructions a request rise by more than +0.5% of base's, by the medians
// the kit prints; no case's allocations a request rise; and no idle reading's median of three
// runs on head is above base's by more than base's three span. A reading with no figure on
// either build cannot be counted, which sends the change to the measured way as a rise does.
//
// `--description` is the pull request's description, read for the way the change is decided: a
// line of its own, `Request path: counted` or `Request path: measured`. Exit status 1 when the
// rule does not hold and the description does not say `measured`: a change declared measured is
// reported and never failed on its figures, and one that declares nothing fails only when the
// rule does not hold. Exit status 2 for arguments that are not these.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { median } from "./figures.mjs";
import { cases } from "./requests.mjs";

/** Idle readings taken on each build. */
export const RUNS = 3;
/** The cases also counted with their requests written 16 at a time (README.md, The cases). */
const DEEP = ["pipeline", "get", "unstaged", "text"];
/** The idle readings: each of `idle.mjs`'s lines under Running it. */
const IDLE = [
  { name: "request", what: "after one request", options: [] },
  { name: "browser", what: "after three of a browser's requests", options: ["--case", "get-browser", "--requests", "3"] },
  { name: "silent", what: "before any byte", options: ["--silent"] },
];

/**
 * The runs the rule reads, in the order to take them: every case's instructions, the four at a
 * depth of 16, every case's allocations, and each idle reading `RUNS` times, a reading's runs
 * apart from each other. Each is one run of a kit's script for one case, so a run the kit
 * refuses costs that case's figure alone.
 * @returns {{ file: string, script: "count.mjs" | "idle.mjs", options: string[] }[]}
 */
export function readings() {
  const names = Object.keys(cases);
  /** @type {ReturnType<typeof readings>} */
  const all = [];
  for (const name of names) all.push({ file: `count-${name}.txt`, script: "count.mjs", options: ["--cases", name] });
  for (const name of DEEP) all.push({ file: `count-16-${name}.txt`, script: "count.mjs", options: ["--depth", "16", "--cases", name] });
  for (const name of names) all.push({ file: `allocations-${name}.txt`, script: "count.mjs", options: ["--allocations", "--cases", name] });
  for (let run = 1; run <= RUNS; run += 1) for (const { name, options } of IDLE) all.push({ file: `idle-${name}-${run}.txt`, script: "idle.mjs", options });
  return all;
}

/**
 * A case's row of what `count.mjs` prints: its median, its counts and the seconds of its longest
 * window. Null when the text has no such row. @param {string} text @param {string} name
 */
export function counted(text, name) {
  for (const line of text.split("\n")) {
    const row = /^(\S+)\s+(\d+)\s+\d+\s+\d+\s+(\d+\.\d)\s+\d+ in \d+\s+(\d+(?: \d+)*)\s*$/.exec(line);
    if (row && row[1] === name) return { median: Number(row[2]), counts: /** @type {string} */ (row[4]).split(" ").map(Number), seconds: /** @type {string} */ (row[3]) };
  }
  return null;
}

/**
 * A case's row of what `count.mjs --allocations` prints: allocations and frees a request. Null
 * when the text has no such row. @param {string} text @param {string} name
 */
export function allocated(text, name) {
  for (const line of text.split("\n")) {
    const row = /^(\S+)\s+(\d+\.\d\d)\s+(\d+\.\d\d)(?:\s|$)/.exec(line);
    if (row && row[1] === name) return { allocations: Number(row[2]), frees: Number(row[3]) };
  }
  return null;
}

/** The bytes a connection of what `idle.mjs` prints, or null when the text has no figure. @param {string} text */
export function idled(text) {
  const found = /^(-?\d+) bytes a connection \(/m.exec(text);
  return found ? Number(found[1]) : null;
}

/**
 * The way a description says its change is decided: "counted" or "measured" when a line of its
 * own says one of them, "both" when lines say both, and null when none does.
 * @param {string} description @returns {"counted" | "measured" | "both" | null}
 */
export function declared(description) {
  const said = new Set([...description.matchAll(/^Request path: (counted|measured)[ \t]*\r?$/gm)].map((line) => line[1]));
  if (said.size > 1) return "both";
  return /** @type {"counted" | "measured" | null} */ ([...said][0] ?? null);
}

/** Whether a case's instructions rose by more than the budget, 0.5% of base's. @param {number} base @param {number} head */
export const over = (base, head) => (head - base) * 200 > base;

/**
 * Whether an idle reading rose: head's median above base's by more than base's runs span.
 * @param {number[]} base @param {number[]} head
 */
export const rose = (base, head) => median(head) - median(base) > Math.max(...base) - Math.min(...base);

/** What the kit said of each run it refused, an error's message a run. @param {string} said */
function reasons(said) {
  const errors = [...said.matchAll(/^Error: (.*)$/gm)].map((line) => /** @type {string} */ (line[1]));
  const last = said.trim().split("\n").at(-1) ?? "";
  return (errors.length > 0 ? errors : [last]).map((reason) => reason.trim().slice(0, 300));
}

/**
 * What a run left in a build's directory: its figure, or why there is none, and what the kit
 * said of each time it refused the run.
 * @template T @param {string} directory @param {string} file @param {(text: string) => T | null} read
 * @returns {{ figure: T | null, why: string, refused: string[] }}
 */
function taken(directory, file, read) {
  const at = join(directory, file);
  const refused = existsSync(`${at}.refused`) ? reasons(readFileSync(`${at}.refused`, "utf8")) : [];
  if (!existsSync(at)) return { figure: null, why: refused.at(-1) ?? "the run left no output", refused };
  const figure = read(readFileSync(at, "utf8"));
  return { figure, why: figure === null ? "the run's output is not what the kit prints" : "", refused };
}

const whole = (/** @type {number} */ n) => n.toLocaleString("en-US");
const signed = (/** @type {number} */ n, digits = 0) => (n > 0 ? "+" : "") + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
  /** What keeps the rule from holding, each a clause of the verdict. @type {string[]} */
  const against = [];
  /** @type {string[]} */
  const refusals = [];
  /**
   * Both builds' figures of a reading, with what to say when either has none.
   * @template T @param {string} file @param {string} what @param {(text: string) => T | null} read
   */
  const both = (file, what, read) => {
    const sides = { base: taken(base, file, read), head: taken(head, file, read) };
    for (const side of /** @type {const} */ (["base", "head"])) {
      for (const reason of sides[side].refused) refusals.push(`- ${code(file)} on ${side}: ${code(reason)}${sides[side].figure === null ? "" : " (taken again, and counted)"}`);
    }
    const none = /** @type {const} */ (["base", "head"]).filter((side) => sides[side].figure === null);
    if (none.length > 0) against.push(`${what} has no figure on ${none.join(" and ")} (${code(sides[/** @type {"base" | "head"} */ (none[0])].why)})`);
    return sides;
  };

  const instructions = [...Object.keys(cases).map((name) => ({ name, file: `count-${name}.txt`, label: code(name) })), ...DEEP.map((name) => ({ name, file: `count-16-${name}.txt`, label: `${code(name)}, 16 at a time` }))].map(({ name, file, label }) => {
    const sides = both(file, `${label}'s instructions`, (text) => counted(text, name));
    const [b, h] = [sides.base.figure, sides.head.figure];
    const runs = (/** @type {typeof b} */ side) => (side ? `${side.counts.join(" ")} (${side.seconds} s)` : "none");
    if (!b || !h) return [label, b ? whole(b.median) : "none", h ? whole(h.median) : "none", "", "", runs(b), runs(h), "no figure"];
    const high = over(b.median, h.median);
    // The budget in instructions is the most a case may rise by: 0.5% of base's, rounded down.
    if (high) against.push(`${label} runs ${whole(h.median - b.median)} more instructions a request than base's ${whole(b.median)}, over the budget of ${whole(Math.floor(b.median / 200))} (+0.5%)`);
    return [label, whole(b.median), whole(h.median), signed(h.median - b.median), percent(b.median, h.median, 3), runs(b), runs(h), high ? "over the budget" : ""];
  });

  const allocations = Object.keys(cases).map((name) => {
    const sides = both(`allocations-${name}.txt`, `${code(name)}'s allocations`, (text) => allocated(text, name));
    const [b, h] = [sides.base.figure, sides.head.figure];
    const frees = (/** @type {typeof b} */ side) => (side ? side.frees.toFixed(2) : "none");
    if (!b || !h) return [code(name), b ? b.allocations.toFixed(2) : "none", h ? h.allocations.toFixed(2) : "none", "", "", frees(b), frees(h), "no figure"];
    const more = h.allocations > b.allocations;
    if (more) against.push(`${code(name)} allocates ${(h.allocations - b.allocations).toFixed(2)} more a request (${b.allocations.toFixed(2)} to ${h.allocations.toFixed(2)})`);
    return [code(name), b.allocations.toFixed(2), h.allocations.toFixed(2), signed(h.allocations - b.allocations, 2), percent(b.allocations, h.allocations), frees(b), frees(h), more ? "rose" : ""];
  });

  const idle = IDLE.map(({ name, what }) => {
    const runs = [];
    for (let run = 1; run <= RUNS; run += 1) runs.push(both(`idle-${name}-${run}.txt`, `idle memory ${what}, run ${run},`, idled));
    const b = runs.map((sides) => sides.base.figure);
    const h = runs.map((sides) => sides.head.figure);
    /** A build's figures of the reading, when every run gave one: a median of fewer is not the rule's. */
    const all = (/** @type {(number | null)[]} */ figures) => (figures.every((figure) => figure !== null) ? /** @type {number[]} */ (figures) : null);
    const shown = (/** @type {(number | null)[]} */ figures) => figures.map((figure) => (figure === null ? "none" : whole(figure))).join(" ");
    const [bases, heads] = [all(b), all(h)];
    if (!bases || !heads) return [what, bases ? whole(median(bases)) : "none", heads ? whole(median(heads)) : "none", "", "", "", shown(b), shown(h), "no figure"];
    const span = Math.max(...bases) - Math.min(...bases);
    const [low, high] = [median(bases), median(heads)];
    const up = rose(bases, heads);
    if (up) against.push(`idle memory ${what} rises: head's median, ${whole(high)} bytes a connection, is above base's ${whole(low)} by more than base's span of ${whole(span)}`);
    return [what, whole(low), whole(high), signed(high - low), percent(low, high), whole(span), shown(bases), shown(heads), up ? "rose" : ""];
  });

  const said = declared(description);
  const holds = against.length === 0;
  const why = against.join("; ");
  const rule = "CONTRIBUTING.md (Pull requests, item 2.1)";
  const line = "a line of its own in the description";
  /** @type {0 | 1} */
  let status = 0;
  let verdict;
  if (said === "counted" && holds) {
    verdict = "**Passes as counted.** No case's instructions a request rise by more than +0.5% of base's, no case's allocations a request rise, and idle memory does not rise.";
  } else if (said === "counted") {
    status = 1;
    verdict = `**Does not pass as counted:** ${why}. By ${rule} the change is then measured: the description says \`Request path: measured\`, gives what the measured way asks, and keeps these counts.`;
  } else if (said === "measured") {
    verdict = `**Declared measured: these counts are reported and decide nothing.** As counted they would ${holds ? "pass" : `not pass: ${why}`}.`;
  } else {
    const none = said === "both" ? "The description says both `Request path: counted` and `Request path: measured`, so it declares neither." : "The description does not say which way decides the change.";
    if (holds) {
      verdict = `**Would pass as counted.** ${none} Say it on ${line}, \`Request path: counted\` or \`Request path: measured\` (${rule}).`;
    } else {
      status = 1;
      verdict = `**Does not pass as counted:** ${why}. ${none} By ${rule} such a change is measured: say \`Request path: measured\` on ${line}, and give what the measured way asks.`;
    }
  }

  const answers = Object.keys(cases).map((name) => {
    const [b, h] = [base, head].map((directory) => join(directory, "answers", `${name}.http`)).map((at) => (existsSync(at) ? readFileSync(at) : null));
    return { name, state: !b || !h ? "none" : b.equals(h) ? "same" : "differ" };
  });
  const differ = answers.filter(({ state }) => state === "differ").map(({ name }) => code(name));
  const unread = answers.filter(({ state }) => state === "none").map(({ name }) => code(name));
  const answered = [
    differ.length > 0 ? `The two builds answer differently in ${differ.join(", ")}: a count of two builds that answer differently compares two different jobs, which the review weighs.` : "",
    unread.length > 0 ? `No answer to compare in ${unread.join(", ")}.` : "",
    differ.length + unread.length === 0 ? `Both builds give the same answer, byte for byte with its \`Date\` and \`ETag\` masked, in all ${answers.length} cases.` : "",
  ].filter(Boolean).join(" ");

  const markdown = [
    `## What a request costs: ${code(short(names.head))} against ${code(short(names.base))}`,
    verdict,
    answered,
    "### Instructions a request",
    table(["Case", "Base", "Head", "Difference", "Percent", "Base's counts", "Head's counts", "Rule"], instructions),
    "### Allocations a request",
    table(["Case", "Base", "Head", "Difference", "Percent", "Base's frees", "Head's frees", "Rule"], allocations),
    "### Memory an idle connection holds, in bytes",
    table(["Reading", "Base's median", "Head's median", "Difference", "Percent", "Base's span", "Base's runs", "Head's runs", "Rule"], idle),
    ...(refusals.length > 0 ? ["### Runs the kit refused", refusals.join("\n")] : []),
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
