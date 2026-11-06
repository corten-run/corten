// Checks citations of docs/design.md's Choices, Rules and Limits. Each item has a stable anchor
// (`<a id="choice-layout-reads"></a>` after its number), and a citation names it, so inserting or
// removing an item leaves every citation pointing where it did. In Markdown a citation is a link,
// `[Choice 20](docs/design.md#choice-layout-reads)` (from design.md itself `[Choice 20](#choice-layout-reads)`);
// in code, where a relative link would not render, the anchor's path, `docs/design.md#choice-layout-reads`,
// with no number. This fails on an anchor design.md lacks, a link whose text names a number its item
// no longer has, and a "Choice 20", "Limits 14" or "design rule 10" written without its link. It
// also checks design.md's lists are numbered 1, 2, 3 in order, each item with an anchor of its kind
// used once. CHANGELOG.md is a record of what each release said, so it is not read. A link to a web
// page (an issue whose title names a Choice) is not a citation.
// Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const problems = [];

/** Each kind's items in order: the number and the anchor. @type {Map<string, Map<string, number>>} */
const anchors = new Map([["choice", new Map()], ["rule", new Map()], ["limit", new Map()]]);
const kinds = { Choices: "choice", Rules: "rule", Limits: "limit" };
/** @type {string | null} */
let section = null;
readFileSync(join(root, "docs/design.md"), "utf8")
  .split(/\r?\n/)
  .forEach((line, i) => {
    const heading = /^## (\w+)/.exec(line);
    if (heading) {
      section = kinds[/** @type {keyof typeof kinds} */ (heading[1])] ?? null;
      return;
    }
    const item = /^(\d+)\. (?:<a id="([a-z]+)-([a-z0-9-]+)"><\/a>)?/.exec(line);
    if (!section || !item) return;
    const at = `docs/design.md:${i + 1}`;
    const items = /** @type {Map<string, number>} */ (anchors.get(section));
    const n = Number(item[1]);
    if (n !== items.size + 1) problems.push(`${at}: ${section} ${n} follows ${items.size}; number the list in order`);
    if (!item[2]) problems.push(`${at}: ${section} ${n} has no anchor; start it with <a id="${section}-a-short-name"></a>`);
    else if (item[2] !== section) problems.push(`${at}: ${section} ${n}'s anchor is a ${item[2]}'s`);
    else if (items.has(item[3])) problems.push(`${at}: the anchor ${section}-${item[3]} is used twice`);
    if (item[3]) items.set(item[3], n);
  });
for (const [kind, items] of anchors) if (items.size < 5) problems.push(`docs/design.md: found only ${items.size} ${kind}s`);

const names = { choice: "Choice", rule: "Rule", limit: "Limit" };
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.rs", "*.mjs", "*.js", "*.toml", "*Dockerfile"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((file) => file && file !== "CHANGELOG.md");
let links = 0;
for (const file of files) {
  // A tracked file deleted in the working tree but not staged is still listed.
  if (!existsSync(join(root, file))) continue;
  readFileSync(join(root, file), "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      // Links to a web page go first: an issue's title may name a Choice.
      let rest = line.replace(/\[(?:[^\]\\]|\\.)*\]\(https?:[^)]*\)/g, "");
      /** The item an anchor names, or undefined after saying it names none. @param {string} kind @param {string} name @param {string} what */
      const item = (kind, name, what) => {
        links += 1;
        const n = anchors.get(kind)?.get(name);
        if (n === undefined) problems.push(`${at}: ${what} points at no ${kind} in docs/design.md`);
        return n;
      };
      rest = rest.replace(/\[([^\]]*)\]\(((?:[^)#\s]*\/)?design\.md)?#(choice|rule|limit)-([a-z0-9-]+)\)/g, (link, text, path, kind, name) => {
        if (path === undefined && file !== "docs/design.md") return link;
        const n = item(kind, name, link);
        const said = /\b(Choice|Rule|Limit)s?,? (\d+)\b/i.exec(text);
        if (n !== undefined && said && (said[1].toLowerCase() !== kind || Number(said[2]) !== n)) {
          problems.push(`${at}: ${link} names ${said[1]} ${said[2]}, but its ${kind} is ${names[kind]} ${n} now`);
        }
        return "";
      });
      rest = rest.replace(/design\.md#(choice|rule|limit)-([a-z0-9-]+)/g, (path, kind, name) => {
        item(kind, name, path);
        return "";
      });
      const bare = /\b(?:Choices?|Limits?|Rules?),? \d+\b|\bdesign (?:choice|rule|limit)s?,? \d+\b/.exec(rest);
      if (bare) problems.push(`${at}: "${bare[0]}" without its link; write [${bare[0]}](docs/design.md#<its anchor>)`);
    });
}
if (files.length < 100 || links < 20) problems.push(`found only ${files.length} files and ${links} links to design.md's items`);
if (problems.length) {
  console.error(`design-refs: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`design-refs: ${links} links to ${[...anchors.values()].reduce((n, items) => n + items.size, 0)} items, in ${files.length} files`);
