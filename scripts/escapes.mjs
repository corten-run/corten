// Checks that the scripts Corten ships (the runtime, the kit, the template, the examples) have no
// explicit `any` (nor JSDoc's `*` or `?`) and no comment that turns the checker off: a value of unknown shape is
// `unknown` and is narrowed, or cast once where it enters with a comment saying what vouches for
// it (docs/design.md#choice-script-boundaries). `@ts-expect-error` belongs to the typing
// fixtures, which are not among these files. Types are read with TypeScript's parser: those in
// JSDoc, over any number of lines, and a declaration file's. It also holds the scripts'
// hand-written classes to the list below, the ones the Choice
// docs/design.md#choice-handlers-checked-where-called names, and refuses a write to one's field
// that is not through a typed cast of `this`. Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parse, parseFiles } from "./typescript.mjs";

// The hand-written classes in these scripts, by file and name: a class expression with none is
// named by the tag `customElements.define` gives it (`<corten-live>`), else "anonymous". A class is
// where checked JavaScript is weakest: a property its constructor or a method sets first is taken
// as declared, so a misspelled write is an error only through a typedef of its fields.
// docs/design.md#choice-handlers-checked-where-called stands on these being all of them, each
// writing its fields that way; a class added or removed changes that Choice and this list together.
export const CLASSES = ["crates/corten/js/corten.js: <corten-live>", "crates/corten/js/read.js: ReadError"];

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
      found.push(`${file}: ${name ? name.text : (definedTag(node, source) ?? "anonymous")}`);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

/** The tag of `customElements.define("tag", class ..)` when `node` is that class. @param {ts.Node} node @param {ts.SourceFile} source */
function definedTag(node, source) {
  const call = node.parent;
  if (call?.kind !== ts.SyntaxKind.CallExpression) return null;
  const { expression, arguments: args } = /** @type {ts.CallExpression} */ (call);
  const tag = args[0];
  if (args[1] !== node || tag?.kind !== ts.SyntaxKind.StringLiteral || !member(expression, "customElements", "define")) return null;
  return `<${/** @type {ts.StringLiteral} */ (tag).text}>`;
}

/**
 * Whether `node` is `object.name` or `object["name"]`, in any parentheses, read from its nodes so
 * comments and spacing do not matter. A local binding named `object` is taken for the global.
 * @param {ts.Node} node @param {string} object @param {string} name
 */
function member(node, object, name) {
  while (node.kind === ts.SyntaxKind.ParenthesizedExpression) node = /** @type {ts.ParenthesizedExpression} */ (node).expression;
  /** @type {ts.Node | undefined} */
  let key;
  if (node.kind === ts.SyntaxKind.PropertyAccessExpression) key = /** @type {ts.PropertyAccessExpression} */ (node).name;
  else if (node.kind === ts.SyntaxKind.ElementAccessExpression) key = /** @type {ts.ElementAccessExpression} */ (node).argumentExpression;
  else return false;
  let target = /** @type {ts.PropertyAccessExpression} */ (node).expression;
  while (target.kind === ts.SyntaxKind.ParenthesizedExpression) target = /** @type {ts.ParenthesizedExpression} */ (target).expression;
  // `Object.assign`'s name is an identifier; `Object[assign]`'s is a variable, and only a string
  // literal there is the key itself.
  const literal = node.kind === ts.SyntaxKind.PropertyAccessExpression ? key.kind === ts.SyntaxKind.Identifier : key.kind === ts.SyntaxKind.StringLiteral || key.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
  const keyText = literal ? /** @type {ts.Identifier} */ (key).text : null;
  return target.kind === ts.SyntaxKind.Identifier && /** @type {ts.Identifier} */ (target).text === object && keyText === name;
}

// Calls that write the properties their first argument has by keys no type of it checks.
const WRITERS = [["Object", "assign"], ["Object", "defineProperty"], ["Object", "defineProperties"], ["Reflect", "set"], ["Reflect", "defineProperty"], ["Reflect", "deleteProperty"]];

/**
 * Whether `node`, a method or accessor, has its `this` typed by a `@this` tag in the JSDoc
 * block TypeScript reads, the last before it. The scan cannot tell that the type is a typedef of
 * the fields and not the class itself; docs/design.md#choice-handlers-checked-where-called asks for the typedef.
 * @param {ts.Node} node
 */
function typedThis(node) {
  const docs = node.jsDoc ?? [];
  return (docs.at(-1)?.tags ?? []).some((tag) => tag.kind === ts.SyntaxKind.JSDocThisTag);
}

/** Whether `node` is `this`, bare or in parentheses, with no cast giving it a type. @param {ts.Node} node */
function plainThis(node) {
  while (node.kind === ts.SyntaxKind.ParenthesizedExpression) node = /** @type {ts.ParenthesizedExpression} */ (node).expression;
  return node.kind === ts.SyntaxKind.ThisKeyword;
}

/** Whether `node` is `this`, in any parentheses and casts. @param {ts.Node} node */
function anyThis(node) {
  while (node.kind === ts.SyntaxKind.ParenthesizedExpression || node.kind === ts.SyntaxKind.AsExpression || node.kind === ts.SyntaxKind.TypeAssertionExpression || node.kind === ts.SyntaxKind.SatisfiesExpression || node.kind === ts.SyntaxKind.NonNullExpression) {
    node = /** @type {ts.ParenthesizedExpression} */ (node).expression;
  }
  return node.kind === ts.SyntaxKind.ThisKeyword;
}

/** The property accesses `target`, the left of an assignment, writes, through any destructuring. @param {ts.Node} target @param {ts.Node[]} out */
function written(target, out) {
  while (target.kind === ts.SyntaxKind.ParenthesizedExpression) target = /** @type {ts.ParenthesizedExpression} */ (target).expression;
  if (target.kind === ts.SyntaxKind.PropertyAccessExpression || target.kind === ts.SyntaxKind.ElementAccessExpression) out.push(target);
  else if (target.kind === ts.SyntaxKind.ArrayLiteralExpression || target.kind === ts.SyntaxKind.ObjectLiteralExpression) target.forEachChild((part) => { written(part, out); });
  else if (target.kind === ts.SyntaxKind.PropertyAssignment) written(/** @type {ts.PropertyAssignment} */ (target).initializer, out);
  else if (target.kind === ts.SyntaxKind.SpreadElement || target.kind === ts.SyntaxKind.SpreadAssignment) written(/** @type {ts.SpreadElement} */ (target).expression, out);
  else if (target.kind === ts.SyntaxKind.BinaryExpression) written(/** @type {ts.BinaryExpression} */ (target).left, out);
  return out;
}

/**
 * Each write to a field of a hand-written class through a `this` no cast types, by line: checked
 * JavaScript takes a field such a write sets first as declared, so a misspelling there is no error.
 * A write is an assignment of any operator, `++`, `--`, `delete`, a `for .. of` or `for .. in`
 * target, through any destructuring. A `#private` field is not one: `tsc` checks its name. Apart,
 * `this`, typed or not, handed first to one of `WRITERS` named directly (`Object.assign`,
 * `Object["assign"]`) is refused, as no type of it checks the keys those write; a writer reached
 * another way (an alias, a computed key) is not seen. A function, and an object literal's method or
 * accessor, has a `this` of its own and is not looked in; an arrow function is, a class's
 * `extends` has the `this` around the class, and a method a `@this` tag types is not looked in.
 * @param {string} file @param {ts.SourceFile} source
 */
function plainWritesIn(file, source) {
  /** @type {string[]} */
  const found = [];
  // A destructuring default (`[this.a = 1] = []`) is reached as its pattern and as an assignment.
  const seen = new Set();
  const at = (/** @type {ts.Node} */ node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  // What `this` is where the visit is: no class's, a class's with no type, or a class's a `@this`
  // tag types (its field writes tsc checks, but not the keys a writer call sets).
  /** @param {ts.Node} node @param {"none" | "plain" | "typed"} self */
  const visit = (node, self) => {
    const kind = node.kind;
    if (kind === ts.SyntaxKind.ClassDeclaration || kind === ts.SyntaxKind.ClassExpression) {
      // Its `extends` is read with the `this` around the class; its members with the class's.
      node.forEachChild((child) => { visit(child, child.kind === ts.SyntaxKind.HeritageClause ? self : "plain"); });
      return;
    } else if (kind === ts.SyntaxKind.FunctionDeclaration || kind === ts.SyntaxKind.FunctionExpression) self = "none";
    else if (kind === ts.SyntaxKind.MethodDeclaration || kind === ts.SyntaxKind.GetAccessor || kind === ts.SyntaxKind.SetAccessor) {
      // A computed name is read with the enclosing `this`; the body has the method's own.
      const { name, body } = /** @type {ts.MethodDeclaration} */ (node);
      if (name) visit(name, self);
      /** @type {"none" | "plain" | "typed"} */
      const own = self === "none" || node.parent?.kind === ts.SyntaxKind.ObjectLiteralExpression ? "none" : typedThis(node) ? "typed" : "plain";
      node.forEachChild((child) => { if (child !== name && child !== body) visit(child, own); });
      if (body) visit(body, own);
      return;
    }
    if (self !== "none") {
      /** @type {ts.Node[]} */
      let targets = [];
      if (kind === ts.SyntaxKind.BinaryExpression) {
        const { left, operatorToken } = /** @type {ts.BinaryExpression} */ (node);
        if (operatorToken.kind >= ts.SyntaxKind.FirstAssignment && operatorToken.kind <= ts.SyntaxKind.LastAssignment) targets = written(left, []);
      } else if (kind === ts.SyntaxKind.PrefixUnaryExpression || kind === ts.SyntaxKind.PostfixUnaryExpression) {
        const { operator, operand } = /** @type {ts.PrefixUnaryExpression} */ (node);
        if (operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken) targets = written(operand, []);
      } else if (kind === ts.SyntaxKind.DeleteExpression) targets = written(/** @type {ts.DeleteExpression} */ (node).expression, []);
      else if (kind === ts.SyntaxKind.ForOfStatement || kind === ts.SyntaxKind.ForInStatement) targets = written(/** @type {ts.ForOfStatement} */ (node).initializer, []);
      else if (kind === ts.SyntaxKind.CallExpression) {
        const { expression, arguments: args } = /** @type {ts.CallExpression} */ (node);
        if (args[0] && anyThis(args[0]) && WRITERS.some(([object, name]) => member(expression, object, name))) {
          found.push(`${at(node)}: a class's fields are written by handing its \`this\` to a call no type of it checks the keys of, so a misspelled name is taken as a new field; write each through a typedef of its fields, \`/** @type {Fields} */ (this).name = ..\` (docs/design.md#choice-handlers-checked-where-called)`);
        }
      }
      for (const target of self === "plain" ? targets : []) {
        if (seen.has(target.pos)) continue;
        seen.add(target.pos);
        const access = /** @type {ts.PropertyAccessExpression} */ (target);
        if (access.name?.kind === ts.SyntaxKind.PrivateIdentifier) continue;
        if (plainThis(access.expression)) found.push(`${at(target)}: a class's field is written through a \`this\` with no type, so a misspelled name is taken as a new field; write it through a typedef of its fields, \`/** @type {Fields} */ (this).name = ..\` (docs/design.md#choice-handlers-checked-where-called)`);
      }
    }
    node.forEachChild((child) => { visit(child, self); });
  };
  visit(source, "none");
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
  return parse(file, text, (source) => [...problemsIn(file, text, source), ...(file.endsWith(".d.ts") ? [] : plainWritesIn(file, source))]);
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
    problems: [...problemsIn(file, text, source), ...(file.endsWith(".d.ts") ? [] : plainWritesIn(file, source))],
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
