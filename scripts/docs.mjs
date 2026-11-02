// Checks the repository's Markdown for what a bad merge leaves: a conflict's marker starting a
// line, or a table row cut short (a row that does not end with its `|`, as docs/guide/kit.md's
// `corten ui add` row was, at a marker inside the row's text). Run by npm run check.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set([".git", "node_modules"]);

/** Every `.md` file under `dir`, outside build output. @param {string} dir @returns {string[]} */
function markdown(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return skip.has(entry.name) || entry.name.startsWith("target") ? [] : markdown(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

const problems = [];
let rows = 0;
const files = markdown(root);
for (const file of files) {
  let fenced = false;
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const at = `${relative(root, file)}:${i + 1}`;
      if (/^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>)( |$)|^=======$/.test(line)) problems.push(`${at}: a merge conflict's marker`);
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || !line.startsWith("|")) return;
      rows += 1;
      if (!/\|\s*$/.test(line)) problems.push(`${at}: a table row that does not end with |, cut short? (…${line.slice(-60)})`);
    });
}
if (files.length < 20 || rows < 100) problems.push(`found only ${files.length} Markdown files and ${rows} table rows`);
if (problems.length) {
  console.error(`docs: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`docs: ${files.length} Markdown files, ${rows} table rows`);
