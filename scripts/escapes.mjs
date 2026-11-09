// Checks that the scripts Corten ships (the runtime, the kit, the template, the examples) have no
// explicit `any` (nor JSDoc's `*` or `?`) and no comment that turns the checker off: a value of unknown shape is
// `unknown` and is narrowed, or cast once where it enters with a comment saying what vouches for
// it (docs/design.md#choice-script-boundaries). `@ts-expect-error` belongs to the typing
// fixtures, which are not among these files. Types are read with TypeScript's parser: those in
// JSDoc, over any number of lines, and a declaration file's. Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** What `text`, the file `file`, has that this check forbids, by line. @param {string} file @param {string} text @returns {string[]} */
export function problems(file, text) {
  /** @type {string[]} */
  const found = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const at = (/** @type {number} */ pos) => `${file}:${source.getLineAndCharacterOfPosition(pos).line + 1}`;
  /** @param {ts.Node} node */
  const visit = (node) => {
    // `*` and `?` are JSDoc's own spellings of it.
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.JSDocAllType || node.kind === ts.SyntaxKind.JSDocUnknownType) found.push(`${at(node.getStart(source))}: \`any\` is unchecked; use \`unknown\` and narrow it, or the type it is`);
    // A node's JSDoc is not among its children.
    for (const doc of /** @type {{ jsDoc?: ts.JSDoc[] }} */ (node).jsDoc ?? []) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const range of commentsOf(source)) {
    // Wherever TypeScript reads one and a few places it does not, so never fewer: at the start of
    // the comment or of any of its lines, after any run of `/` and `*` (TypeScript's own pattern,
    // which reads `@ts-ignored` as `@ts-ignore`), where TypeScript reads only a block comment's
    // last line and `@ts-nocheck` only in the file's leading comments.
    const off = /^\s*[/*]*\s*@ts-(ignore|nocheck|expect-error)/m.exec(text.slice(range.pos, range.end));
    if (off) found.push(`${at(range.pos)}: @ts-${off[1]} turns the type check off here; fix the type, or narrow the value`);
  }
  return found;
}

/** Every comment in `source`: each is in the trivia before a token or after one on its line. @param {ts.SourceFile} source */
function commentsOf(source) {
  /** @type {Map<number, ts.CommentRange>} */
  const all = new Map();
  /** @param {ts.Node} node */
  const visit = (node) => {
    for (const range of ts.getLeadingCommentRanges(source.text, node.pos) ?? []) all.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(source.text, node.end) ?? []) all.set(range.pos, range);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return all.values();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z", "--", "crates/corten/js", "crates/corten/src", "crates/corten-ui/src", "crates/corten-cli/template", "examples"], { cwd: root, encoding: "utf8" })
    .split("\0")
    // The scripts the type check covers: not the minified builds, nor the smokes' Node scripts.
    .filter((file) => /\.(js|d\.ts)$/.test(file) && !file.includes("/dist/") && !file.includes("node_modules/"));
  const found = files.filter((file) => existsSync(join(root, file))).flatMap((file) => problems(file, readFileSync(join(root, file), "utf8")));
  if (found.length) {
    console.error(found.join("\n"));
    process.exit(1);
  }
}
