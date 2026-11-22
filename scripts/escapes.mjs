// Checks that the scripts Corten ships (the runtime, the kit, the template, the examples) have no
// explicit `any` (nor JSDoc's `*` or `?`) and no comment that turns the checker off: a value of unknown shape is
// `unknown` and is narrowed, or cast once where it enters with a comment saying what vouches for
// it (docs/design.md#choice-script-boundaries). `@ts-expect-error` belongs to the typing
// fixtures, which are not among these files. Types are read with TypeScript's parser: those in
// JSDoc, over any number of lines, and a declaration file's. It also holds the scripts'
// hand-written classes to the list below, the ones the Choice
// docs/design.md#choice-handlers-checked-where-called names with what holds their fields. Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parse, parseFiles } from "./typescript.mjs";

// The hand-written classes in these scripts, by file and name ("anonymous" for a class expression
// with none: `<corten-live>`'s). A class is where checked JavaScript is weakest: a property its
// constructor or a method sets first is taken as declared, so a misspelled write is an error only
// through a typedef of its fields. docs/design.md#choice-handlers-checked-where-called stands on
// these being all of them, each writing its fields that way; a class added or removed changes that
// Choice and this list together.
export const CLASSES = ["crates/corten/js/corten.js: anonymous", "crates/corten/js/read.js: ReadError"];

/** The classes `text`, the file `file`, has, declared or as an expression, as `CLASSES` lists them. @param {string} file @param {string} text @returns {string[]} */
export function classes(file, text) {
  return parse(file, text, (source) => classesIn(file, source));
}

/** @param {string} file @param {ts.SourceFile} source */
function classesIn(file, source) {
  /** @type {string[]} */
  const found = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.ClassDeclaration || node.kind === ts.SyntaxKind.ClassExpression) {
      const name = /** @type {ts.ClassLikeDeclaration} */ (node).name;
      found.push(`${file}: ${name ? name.text : "anonymous"}`);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

/** What is in `found` and not in `listed`, and the reverse, counting repeats. @param {string[]} found @param {string[]} listed */
export function unlisted(found, listed) {
  /** @param {string[]} a @param {string[]} b */
  const minus = (a, b) => {
    const left = [...b];
    return a.filter((item) => {
      const at = left.indexOf(item);
      if (at < 0) return true;
      left.splice(at, 1);
      return false;
    });
  };
  return { added: minus(found, listed), gone: minus(listed, found) };
}

/** What `text`, the file `file`, has that this check forbids, by line. @param {string} file @param {string} text @returns {string[]} */
export function problems(file, text) {
  return parse(file, text, (source) => problemsIn(file, text, source));
}

/** @param {string} file @param {string} text @param {ts.SourceFile} source */
function problemsIn(file, text, source) {
  /** @type {string[]} */
  const found = [];
  const visited = new Set();
  const at = (/** @type {number} */ pos) => `${file}:${source.getLineAndCharacterOfPosition(pos).line + 1}`;
  /** @param {ts.Node} node */
  const visit = (node) => {
    const key = `${node.kind}:${node.pos}:${node.end}`;
    if (visited.has(key)) return;
    visited.add(key);
    // `*` and `?` are JSDoc's own spellings of it.
    const bareQuestion = node.kind === ts.SyntaxKind.JSDocNullableType && node.getText(source) === "?";
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.JSDocAllType || bareQuestion) found.push(`${at(node.getStart(source))}: \`any\` is unchecked; use \`unknown\` and narrow it, or the type it is`);
    // JSDoc can also appear among a node's children in the native API; visit it once.
    for (const doc of node.jsDoc ?? []) visit(doc);
    node.forEachChild(visit);
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
  for (let pos = 0; pos < source.text.length;) {
    const token = ts.getTokenAtPosition(source, pos);
    for (const range of ts.getLeadingCommentRanges(source.text, token.pos) ?? []) all.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(source.text, token.end) ?? []) all.set(range.pos, range);
    if (token.end <= pos) break;
    pos = token.end;
  }
  return all.values();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z", "--", "crates/corten/js", "crates/corten/src", "crates/corten-ui/src", "crates/corten-cli/template", "examples"], { cwd: root, encoding: "utf8" })
    .split("\0")
    // The scripts the type check covers: not the minified builds, nor the smokes' Node scripts.
    .filter((file) => /\.(js|d\.ts)$/.test(file) && !file.includes("/dist/") && !file.includes("node_modules/"));
  const inputs = files.filter((file) => existsSync(join(root, file))).map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
  const scanned = parseFiles(inputs, (file, text, source) => ({
    problems: problemsIn(file, text, source),
    // A declaration file's class has no body to write a field in.
    classes: file.endsWith(".d.ts") ? [] : classesIn(file, source),
  }));
  const found = scanned.flatMap((one) => one.problems);
  const { added, gone } = unlisted(scanned.flatMap((one) => one.classes), CLASSES);
  if (added.length || gone.length) {
    found.push(
      [
        "The scripts' hand-written classes are not the ones scripts/escapes.mjs lists and the Choice 'Handlers are checked where they are called' (docs/design.md#choice-handlers-checked-where-called) stands on.",
        ...added.map((one) => `  not listed: ${one}`),
        ...gone.map((one) => `  listed, not found: ${one}`),
        "Keep behavior in exported functions; a class that stays writes its fields through a typedef of them (as ReadError does), and goes in CLASSES and in that Choice's premise in the same change.",
      ].join("\n"),
    );
  }
  if (found.length) {
    console.error(found.join("\n"));
    process.exit(1);
  }
  console.log(`Hand-written classes, as docs/design.md#choice-handlers-checked-where-called lists them: ${CLASSES.join(", ")}`);
}
