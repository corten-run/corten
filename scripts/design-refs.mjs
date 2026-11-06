// Checks citations of docs/design.md's Choices, Rules and Limits. Each item has a stable anchor
// after its number (`<a id="choice-name"></a>`), and a citation names it, so where it points
// survives an item added or removed. In Markdown a citation is a link whose text gives the
// number, `[design Choice N](../design.md#choice-name)` (inside design.md, `(#choice-name)`),
// with the path relative to the citing file; in code, where a link does not render, it is the
// anchor's path alone, `docs/design.md#choice-name`, with no number. This fails on a link or path
// to an anchor design.md lacks, a link whose relative path does not reach docs/design.md, a link
// whose text names a number its item no longer has (or several numbers), and a capitalized
// citation by number with no link (a Choice, Limits or Rules followed by a number, also split
// across two lines, and "design rule" and the like in lower case). A lower-case "choice" or
// "limit" with a number is not read as one (a size limit is not a Limit). Rules and Limits are
// also checked to be numbered in order, and every item to have an anchor of its kind used once;
// the Choices' order is scripts/choices.mjs's to check. Code in Markdown (fenced or inline) is not read, nor
// CHANGELOG.md (a record of what each release said), a test's fixtures or this file.
// Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DESIGN = "docs/design.md";
const problems = [];

/** Each kind's items: anchor name to number. @type {Map<string, Map<string, number>>} */
const anchors = new Map([["choice", new Map()], ["rule", new Map()], ["limit", new Map()]]);
const kinds = { Choices: "choice", Rules: "rule", Limits: "limit" };
const names = { choice: "Choice", rule: "Rule", limit: "Limit" };
/** @type {string | null} */
let section = null;
/** How many items each list has had, anchored or not. @type {Record<string, number>} */
const counted = { choice: 0, rule: 0, limit: 0 };
readFileSync(join(root, DESIGN), "utf8")
  .split(/\r?\n/)
  .forEach((line, i) => {
    const heading = /^## (\w+)/.exec(line);
    if (heading) {
      section = kinds[/** @type {keyof typeof kinds} */ (heading[1])] ?? null;
      return;
    }
    if (!section) return;
    // A Choice is an item with a bold title; the Choices section opens with a list of its own.
    const item =
      section === "choice"
        ? /^(\d+)\. (?:<a id="([a-z]+)-([a-z0-9-]+)"><\/a>)?\*\*/.exec(line)
        : /^(\d+)\. (?:<a id="([a-z]+)-([a-z0-9-]+)"><\/a>)?/.exec(line);
    if (!item) return;
    const at = `${DESIGN}:${i + 1}`;
    const items = /** @type {Map<string, number>} */ (anchors.get(section));
    const n = Number(item[1]);
    counted[section] += 1;
    if (section !== "choice" && n !== counted[section]) {
      problems.push(`${at}: ${names[section]} ${n} is number ${counted[section]} in its list; number the list in order`);
    }
    if (!item[2]) problems.push(`${at}: ${names[section]} ${n} has no anchor; start it with <a id="${section}-a-short-name"></a>`);
    else if (item[2] !== section) problems.push(`${at}: ${names[section]} ${n}'s anchor is a ${item[2]}'s`);
    else if (items.has(item[3])) problems.push(`${at}: the anchor ${section}-${item[3]} is used twice`);
    else items.set(item[3], n);
  });
for (const [kind, items] of anchors) if (items.size < 5) problems.push(`${DESIGN}: found only ${items.size} ${kind}s`);

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.md", "*.rs", "*.mjs", "*.js", "*.ts", "*.toml", "*.yml", "*.yaml", "*.sh", "*.ps1", "*Dockerfile"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  // Listed once each (a file with a merge conflict is listed per stage). This script's own comment
  // shows the forms, and a test's fixtures are documents of their own.
  .filter((file, i, all) => file && all.indexOf(file) === i && file !== "CHANGELOG.md" && file !== "scripts/design-refs.mjs" && !file.endsWith(".test.mjs"));
const bareCitation = /\b(?:Choices?|Limits?|Rules?),? \d+\b|\bdesign (?:choices?|rules?|limits?),? \d+\b/i;
const capital = /\b(?:Choices?|Limits?|Rules?),? \d+\b/;
const lowerDesign = /\bdesign (?:choices?|rules?|limits?),? \d+\b/i;
let links = 0;
for (const file of files) {
  // A tracked file deleted in the working tree but not staged is still listed.
  if (!existsSync(join(root, file))) continue;
  const markdown = file.endsWith(".md");
  const toDesign = markdown ? posix.relative(posix.dirname(file), DESIGN) : DESIGN;
  const hint = (kind) => (markdown ? `[${names[kind]} N](${file === DESIGN ? "" : toDesign}#${kind}-name)` : `${DESIGN}#${kind}-name, with no number`);
  /** The item an anchor names, or undefined after saying it names none. */
  const item = (/** @type {string} */ at, /** @type {string} */ kind, /** @type {string} */ name, /** @type {string} */ what) => {
    links += 1;
    const n = anchors.get(kind)?.get(name);
    if (n === undefined) problems.push(`${at}: ${what} points at no ${kind} in ${DESIGN}`);
    return n;
  };
  /** @type {string | null} */
  let fence = null;
  const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
  /** Each line with its citations taken out, or null when it is not read. @type {(string | null)[]} */
  const rests = lines.map((line, i) => {
    const at = `${file}:${i + 1}`;
    if (markdown) {
      const mark = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && /^\s*(?:>\s*)*(`{3,}|~{3,})\s*$/.test(line)) fence = null;
        return null;
      }
      if (mark && !(mark[1][0] === "`" && line.slice(line.indexOf(mark[1]) + mark[1].length).includes("`"))) {
        fence = mark[1];
        return null;
      }
    }
    // In Markdown, code (`` `[Choice N](..)` ``) is an example, not a citation.
    const text = markdown ? line.replace(/(`+)(?:(?!\1).)+?\1/g, "") : line;
    // A link to the web: checked only when it is to design.md's anchors (a blob URL).
    let rest = text.replace(/\[(?:[^\]\\]|\\.)*\]\((https?:[^)\s]*)[^)]*\)/g, (link, url) => {
      const anchor = /\/docs\/design\.md#(choice|rule|limit)-([a-z0-9-]+)$/.exec(url);
      if (anchor) item(at, anchor[1], anchor[2], link);
      return "";
    });
    rest = rest.replace(
      /\[([^\]]*)\]\(((?:[^)#\s]*\/)?design\.md)?#(choice|rule|limit)-([a-z0-9-]+)(?:\s+"[^"]*")?\)/g,
      (link, text, path, kind, name) => {
        if (path === undefined && file !== DESIGN) return link;
        if (path !== undefined && posix.join(posix.dirname(file), path) !== DESIGN) {
          problems.push(`${at}: ${link} does not reach ${DESIGN} from here; write ${toDesign}#${kind}-${name}`);
          links += 1;
          return "";
        }
        const n = item(at, kind, name, link);
        const said = /\b(Choice|Rule|Limit)s?,? (\d+)\b/i.exec(text);
        const numbers = text.match(/\b\d+\b/g) ?? [];
        if (n === undefined) return "";
        if (numbers.length > 1) problems.push(`${at}: ${link} names more than one number; link each item`);
        else if (said && (said[1].toLowerCase() !== kind || Number(said[2]) !== n)) {
          problems.push(`${at}: ${link} names ${said[1]} ${said[2]}, but its ${kind} is ${names[kind]} ${n} now`);
        }
        return "";
      },
    );
    return rest.replace(/design\.md#(choice|rule|limit)-([a-z0-9-]+)/g, (path, kind, name) => {
      item(at, kind, name, path);
      return "";
    });
  });
  rests.forEach((rest, i) => {
    if (rest === null) return;
    const at = `${file}:${i + 1}`;
    const bare = capital.exec(rest) ?? lowerDesign.exec(rest);
    if (bare) {
      const kind = /^design /i.test(bare[0]) ? bare[0].split(" ")[1].toLowerCase().replace(/s?,?$/, "") : bare[0].toLowerCase().replace(/s?,? \d+$/, "");
      problems.push(`${at}: "${bare[0]}" without its link; write ${hint(kind)}`);
      return;
    }
    // A citation split over two lines: the kind ends this one, the number starts the next.
    const next = rests[i + 1];
    const ends = /\b(Choices?|Limits?|Rules?|design (?:choices?|rules?|limits?)),?$/i.exec(rest.trimEnd());
    const starts = next && /^\s*(?:\/\/[\/!]?|#|\*|>)?\s*(\d+)\b/.exec(next);
    if (ends && starts && (bareCitation.test(`${ends[1]} ${starts[1]}`) && (capital.test(`${ends[1]} ${starts[1]}`) || /^design /i.test(ends[1])))) {
      problems.push(`${at}: "${ends[1]} ${starts[1]}", split over two lines, without its link; write it on one line as a link`);
    }
  });
}
if (files.length < 100 || links < 20) problems.push(`found only ${files.length} files and ${links} citations of design.md's items`);
if (problems.length) {
  console.error(`design-refs: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`design-refs: ${links} citations of ${[...anchors.values()].reduce((n, items) => n + items.size, 0)} items, in ${files.length} files`);
