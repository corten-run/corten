// Checks the repository's Markdown for what a bad merge leaves: a conflict's marker starting a
// line, or a table row cut short (a row that does not end with its `|`, as docs/guide/kit.md's
// `corten ui add` row was, at a marker inside the row's text). The house rule this leans on: every
// table row ends with `|`. Fenced code is not read, so a guide can show a conflict. A paragraph
// cut at a marker inside its text is not caught: the text can name a marker (an issue's title).
// Run by npm run check.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const problems = [];
let rows = 0;
for (const file of files) {
  /** The open fence's character and length, or null outside one. @type {{ char: string, length: number } | null} */
  let fence = null;
  readFileSync(join(root, file), "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      // A fence opens with three or more of one character, indented up to three spaces, and
      // closes on a bare fence of that character at least as long.
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (mark && mark[1][0] === fence.char && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
        return;
      }
      if (mark && !(mark[1][0] === "`" && mark[2].includes("`"))) {
        fence = { char: mark[1][0], length: mark[1].length };
        return;
      }
      if (/^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>)( |$)/.test(line)) {
        problems.push(`${at}: a merge conflict's marker`);
      }
      // A row may sit in a list item or a block quote.
      const row = line.replace(/^(\s*>)*\s*/, "");
      if (!row.startsWith("|")) return;
      rows += 1;
      if (!/(^|[^\\])\|\s*$/.test(row)) {
        problems.push(`${at}: a table row that does not end with |, cut short? End each row with |. (…${row.slice(-60)})`);
      }
    });
  if (fence) problems.push(`${file}: a fence (${fence.char.repeat(fence.length)}) that never closes`);
}
if (files.length < 20 || rows < 100) problems.push(`found only ${files.length} Markdown files and ${rows} table rows`);
if (problems.length) {
  console.error(`docs: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`docs: ${files.length} Markdown files, ${rows} table rows`);
