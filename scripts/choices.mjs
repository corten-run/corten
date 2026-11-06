// Holds docs/design.md's Choices to the convention its Choices section states: each ends with a
// "Stands on:" paragraph naming every premise by a kind the section lists (a value last), a
// "Revisit when:" paragraph, and a "Last checked:" paragraph dating its evidence, and the Choices
// are numbered in order, since other documents cite them by number. The kinds are read from the
// section's own list, so the document is their one source.
// Run by npm run check.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The section had 24 Choices when this was written. Fewer than this many found means the parse
// broke (a heading renamed, the list reformatted), not that Choices were removed.
const FEWEST = 20;
// "Revisit when:" names a condition, not a word: the shortest written is about 60 characters.
// Length is all a script can see; whether the condition can be checked is the review's.
const SHORTEST_CONDITION = 30;
// What dates a "Last checked:" entry: the commit a number ran on or was recorded in, or the
// versions probed: an engine and its version (`WebKit 27.2`), or a name and a three-part version
// (`hyper 1.12.0`), so a measured number (`57.5 to 53.8`) is not taken for one.
const COMMIT = /`[0-9a-f]{7,40}`/;
const VERSION = /\b(?:Chromium|Firefox|WebKit) \d+|\b[A-Za-z][\w-]* \d+\.\d+\.\d+\b/;
const PARAGRAPHS = ["Stands on: ", "Revisit when: ", "Last checked: "];

/**
 * The problems in a design document's Choices, one line each, and how many Choices it has.
 * `today` (`YYYY-MM-DD`) is the latest date a "Last checked:" entry may give: by default the date
 * where it is latest (UTC+14), so a date written anywhere today passes wherever the check runs.
 */
export function problems(
  /** @type {string} */ text,
  today = new Date(Date.now() + 14 * 3600 * 1000).toISOString().slice(0, 10),
) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf("## Choices");
  if (start < 0) return { count: 0, problems: ["design.md: no ## Choices section"] };
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const kinds = [];
  /** @type {{ n: number, at: number, lines: string[] }[]} */
  const choices = [];
  for (let i = start + 1; i < end; i += 1) {
    const numbered = /^(\d+)\. /.exec(lines[i]);
    if (numbered && /^\d+\. \*\*/.test(lines[i])) {
      choices.push({ n: Number(numbered[1]), at: i + 1, lines: [lines[i]] });
    } else if (choices.length) {
      if (numbered) found.push(`design.md:${i + 1}: a numbered item among the Choices without a bold title (\`N. **Title.**\`)`);
      choices[choices.length - 1].lines.push(lines[i]);
    } else {
      const kind = /^\d+\. ([a-z]+): /.exec(lines[i]);
      if (kind) kinds.push(kind[1]);
    }
  }
  if (kinds.length === 0) found.push("design.md: the Choices section lists no kinds (`1. measured: ...`)");
  choices.forEach((choice, i) => {
    const at = `design.md:${choice.at}: Choice ${choice.n}`;
    if (choice.n !== i + 1) found.push(`${at} is number ${i + 1} in the list; number the Choices in order`);
    /** @type {string[]} */
    const paragraphs = [];
    /** @type {string[]} */
    let current = [];
    for (const line of choice.lines) {
      if (line.trim() === "") {
        if (current.length) paragraphs.push(current.join(" "));
        current = [];
      } else current.push(line.trim());
    }
    if (current.length) paragraphs.push(current.join(" "));
    const [stands, revisit, checked] = paragraphs.length >= 4 ? paragraphs.slice(-3) : ["", "", ""];
    if (!stands.startsWith(PARAGRAPHS[0]) || !revisit.startsWith(PARAGRAPHS[1]) || !checked.startsWith(PARAGRAPHS[2])) {
      found.push(`${at} does not end with a "Stands on:", a "Revisit when:" and a "Last checked:" paragraph, in that order`);
      return;
    }
    if (paragraphs.filter((p) => PARAGRAPHS.some((start) => p.startsWith(start))).length !== 3) {
      found.push(`${at} has more than one "Stands on:", "Revisit when:" or "Last checked:" paragraph`);
    }
    found.push(...dated(checked.slice(PARAGRAPHS[2].length), today).map((problem) => `${at}: "Last checked:" ${problem}`));
    if (revisit.length - "Revisit when: ".length < SHORTEST_CONDITION) {
      found.push(`${at}: "Revisit when:" names no condition someone could check`);
    }
    const list = premises(stands.slice("Stands on: ".length));
    if (list === null) {
      found.push(`${at}: "Stands on:" has unbalanced parentheses, which would hide a premise`);
      return;
    }
    if (list.length === 0 || list.includes("")) found.push(`${at}: "Stands on:" names no premise, or has an empty one between semicolons`);
    list.filter(Boolean).forEach((premise, j, named) => {
      const kind = /^[a-z]+/.exec(premise)?.[0] ?? "";
      if (!kinds.includes(kind)) {
        found.push(`${at}: a premise of kind "${kind}", not one of ${kinds.join(", ")} (${premise.slice(0, 40)}...)`);
      } else if (!said(premise)) {
        found.push(`${at}: the ${kind} premise does not say what it is, in parentheses after its kind`);
      } else if (kind !== "value" && named.slice(0, j).some((p) => p.startsWith("value"))) {
        found.push(`${at}: the values come last, since they move only with the README's values`);
      }
    });
  });
  return { count: choices.length, problems: found };
}

/**
 * What is wrong with a "Last checked:" list: each entry, split as premises are, starts with a date
 * that exists and is not after `today`, and names a commit or the versions probed.
 */
function dated(/** @type {string} */ list, /** @type {string} */ today) {
  const entries = premises(list);
  if (entries === null) return ["has unbalanced parentheses or an open code span"];
  if (entries.length === 0 || entries.includes("")) return ["gives no entry, or an empty one between semicolons"];
  return entries.flatMap((entry) => {
    const date = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(entry);
    const what = `(${entry.slice(0, 40)}...)`;
    if (!date) return [`has an entry that does not start with a date (YYYY-MM-DD) ${what}`];
    const day = new Date(Date.UTC(+date[1], +date[2] - 1, +date[3]));
    if (day.toISOString().slice(0, 10) !== date[0]) return [`gives a date that does not exist ${what}`];
    if (date[0] > today) return [`gives a date after today, ${today} ${what}`];
    if (!COMMIT.test(entry) && !VERSION.test(entry)) return [`has an entry with no commit (in backticks) or versions probed ${what}`];
    return [];
  });
}

/**
 * Whether a premise is its kind, an optional qualifier after a comma, and one parenthesis saying
 * what it is (not blank) that closes at the premise's end, so no second premise hides after it.
 */
function said(/** @type {string} */ premise) {
  const head = /^[a-z]+(, [^(`]+)? \(/.exec(premise);
  if (!head) return false;
  let depth = 0;
  let code = false;
  for (let i = head[0].length - 1; i < premise.length; i += 1) {
    const ch = premise[i];
    if (ch === "`") code = !code;
    if (code || ch === "`") continue;
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0) return i === premise.length - 1 && premise.slice(head[0].length, i).trim() !== "";
  }
  return false;
}

/**
 * A "Stands on" list split at the semicolons outside parentheses and code spans, or null when its
 * parentheses or code spans do not balance. An empty premise (`;;`) is kept as "" for the caller to refuse.
 */
export function premises(/** @type {string} */ list) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let current = "";
  let code = false;
  for (const ch of list) {
    if (ch === "`") code = !code;
    if (code || ch === "`") {
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return null;
    if (ch === ";" && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (depth !== 0 || code) return null;
  out.push(current.trim().replace(/\.$/, ""));
  return out.length === 1 && out[0] === "" ? [] : out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = readFileSync(new URL("../docs/design.md", import.meta.url), "utf8");
  const { count, problems: found } = problems(text);
  if (count < FEWEST) found.push(`design.md: found only ${count} Choices; did the section's format change?`);
  if (found.length) {
    console.error(`choices: ${found.length} problem(s)\n${found.join("\n")}`);
    process.exit(1);
  }
  console.log(`choices: ${count} Choices, each with what it stands on, when to revisit it and when it was last checked`);
}
