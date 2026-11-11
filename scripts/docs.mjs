// Checks the repository's Markdown for what a bad merge leaves: a conflict's marker starting a
// line, or a table row cut short (a row that does not end with its `|`, as docs/guide/kit.md's
// `corten ui add` row was, at a marker inside the row's text). The house rule this leans on: every
// table row ends with `|`. Fenced code is not read, so a guide can show a conflict. A paragraph
// cut at a marker inside its text is not caught: the text can name a marker (an issue's title).
// Indentation is not measured: indented code (four spaces, outside a list) is read as text, and a
// bare fence line indented or quoted inside fenced code closes it; the guides fence their code
// unindented.
//
// And for a link to a file or folder the repository does not have (bench/browser's README linked
// the view app's code to a file that never existed): an inline link (`[text](target)`,
// `![alt](target)`, spaces around the target allowed) and, inside an HTML tag that closes on its
// line (a `>` in a quoted value does not close it), a `src`, `srcset` or `href` (the README's
// logo). Not read for links: a URL (`https:`, `//host`), the anchor and query of a target, inline
// code (a span may wrap onto the paragraph's next lines, and a backslash in it is its own
// character; a backtick run with no partner in its paragraph is text, as Markdown shows it, and a
// heading, list item, HTML line, table row or blank line ends the paragraph), an escaped bracket or
// backtick, and an HTML comment (whichever of a tag, a comment and a code span starts first wins;
// one inside a line up to its `-->`, `<!-->` and `<!--->` closing at once; one that starts a line
// through the whole line it closes on, and one that never closes is a problem, as it hides the rest
// of the file). Not read at all: a reference definition (`[r]: path`); a target with parentheses in
// it (`a(b).md`) is read only to its first `)`. Read though GitHub hides them: a comment that opens
// inside a line and closes on a later one (its later lines), and one that opens in a block quote or
// list item, or indented (its later lines, until its `-->`); each only reads more than GitHub
// shows.
// Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The problems in the Markdown file `file` (its path from the repository's root) whose text is
 * `text`, where `present` has every file and folder of the repository (`.` the root), and how
 * many table rows and relative links it read.
 * @param {string} file @param {string} text @param {Set<string>} present
 * @returns {{ problems: string[], rows: number, links: number }}
 */
export function scan(file, text, present) {
  /** @type {string[]} */
  const problems = [];
  let rows = 0;
  let links = 0;
  /** The open fence's character and length, or null outside one. @type {{ char: string, length: number } | null} */
  let fence = null;
  // Inside an HTML comment that started a line, and where it started.
  let comment = false;
  let commentAt = "";
  /** The lines of the paragraph being read. @type {{ at: string, body: string }[]} */
  let paragraph = [];
  // Reads the paragraph's links and starts the next one.
  const read = () => {
    const lines = outsideCode(paragraph.map((p) => p.body).join("\n")).split("\n");
    paragraph.forEach(({ at }, n) => {
      for (const path of targetsIn(lines[n])) {
        links += 1;
        let to = path;
        try {
          to = decodeURIComponent(path);
        } catch {}
        // GitHub reads a target starting with `/` from the repository's root.
        to = posix.normalize(to.startsWith("/") ? to.slice(1) || "." : posix.join(posix.dirname(file), to));
        to = to === "/" ? "." : to.replace(/\/$/, "");
        if (!present.has(to)) problems.push(`${at}: a link to ${path}, which the repository does not have`);
      }
    });
    paragraph = [];
  };
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    // A block quote's `>`s and a list item's marker come before a fence or a row.
    const body = line.replace(/^(\s*>)*\s*/, "");
    // A fence opens with three or more of one character and closes on a bare fence of that
    // character at least as long.
    const mark = /^(?:(?:[-*+]|\d{1,9}[.)])\s+)?(`{3,}|~{3,})(.*)$/.exec(body);
    const conflict = /^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>)( |$)/.test(line);
    // Inside a comment that started a line (an HTML block), a fence line is the comment's text:
    // only its `-->` ends it. A conflict's marker is still one.
    if (comment) {
      if (conflict) problems.push(`${at}: a merge conflict's marker`);
      comment = !body.includes("-->");
      return;
    }
    if (fence) {
      // A closing fence is bare: no list marker before it, nothing after it.
      const close = /^(`{3,}|~{3,})\s*$/.exec(body);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return;
    }
    if (mark && !(mark[1][0] === "`" && mark[2].includes("`"))) {
      read();
      fence = { char: mark[1][0], length: mark[1].length };
      return;
    }
    if (conflict) {
      read();
      problems.push(`${at}: a merge conflict's marker`);
      return;
    }
    // A comment that starts a line is an HTML block, hidden through the line it closes on, the
    // rest of that line too (`<!-->` and `<!--->` close at once); one inside a line hides only up
    // to its `-->` on that line, as a `<!--` with none after it is text.
    // Only one at the very start of the line, so outside a block quote or list item: a
    // container's end ends its comment too, which this does not follow, so one inside (or one
    // indented, which may be) is read as a comment within a line.
    if (line.startsWith("<!--")) {
      read();
      commentAt = at;
      comment = !body.includes("-->", 2);
      return;
    }
    // A table row and a heading are lines of their own, and a line that starts a block (a list
    // item, HTML) starts a new paragraph, so a code span never runs into or out of one.
    const tableRow = body.startsWith("|");
    const heading = /^#{1,6}(\s|$)/.test(body);
    if (!body.trim() || tableRow || heading || /^(([-*+]|\d{1,9}[.)])(\s|$)|<[a-z/!?])/i.test(body)) read();
    if (body.trim()) paragraph.push({ at, body });
    if (tableRow || heading) read();
    // A row may sit in a list item or a block quote.
    const row = body;
    if (!row.startsWith("|")) return;
    rows += 1;
    // The last `|` is the row's own unless an odd run of backslashes escapes it.
    if (!/(^|[^\\])(\\\\)*\|\s*$/.test(row)) {
      problems.push(`${at}: a table row that does not end with |, cut short? End each row with |. (…${row.slice(-60)})`);
    }
  });
  read();
  if (fence) problems.push(`${file}: a fence (${fence.char.repeat(fence.length)}) that never closes`);
  // GitHub hides the rest of the file, links and all.
  if (comment) problems.push(`${commentAt}: an HTML comment that never closes`);
  return { problems, rows, links };
}

// An attribute as CommonMark reads inline HTML: its name, then its value double-quoted,
// single-quoted or bare, if it has one.
const attribute = /\s+([a-z_:][a-z\d_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.source;
// An open tag on one line, its attributes captured.
const tag = `<[a-z][a-z\\d-]*((?:${attribute})*)\\s*/?>`;

/**
 * `text` (a paragraph's lines, joined by `\n`) with its inline code and its comments that close
 * on their line blanked and its escapes removed, line breaks kept, read from the left so whichever
 * of a tag, a comment and a code span starts first wins. A code span is a backtick run and the
 * next run of the same length, with any backslash inside it its own character; a run with no such
 * partner is text. Outside code, `\\` and the punctuation after it are removed, so an escaped
 * bracket or backtick is no link and no span.
 * @param {string} text
 */
export function outsideCode(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\" && /[!-/:-@[-`{-~]/.test(text[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    // A tag is read as it is, a backtick in a quoted value included.
    if (text[i] === "<") {
      const opening = new RegExp(tag, "iy");
      opening.lastIndex = i;
      const found = opening.exec(text);
      if (found) {
        out += found[0];
        i += found[0].length;
        continue;
      }
    }
    // A comment that closes on its line hides to its `-->` (`<!-->` and `<!--->` close at once);
    // one that does not is text.
    if (text.startsWith("<!--", i)) {
      const shut = text.startsWith("<!-->", i) ? i + 2 : text.startsWith("<!--->", i) ? i + 3 : -1;
      const end = shut !== -1 ? shut : text.indexOf("-->", i + 4);
      const eol = text.indexOf("\n", i);
      if (end !== -1 && (eol === -1 || end < eol)) {
        out += " ".repeat(end + 3 - i);
        i = end + 3;
        continue;
      }
    }
    if (text[i] !== "`") {
      out += text[i++];
      continue;
    }
    const open = /^`+/.exec(text.slice(i))?.[0] ?? "`";
    const run = /`+/g;
    run.lastIndex = i + open.length;
    let close;
    while ((close = run.exec(text)) && close[0].length !== open.length);
    if (!close) {
      out += open;
      i += open.length;
      continue;
    }
    out += text.slice(i, close.index + close[0].length).replace(/[^\n]/g, " ");
    i = close.index + close[0].length;
  }
  return out;
}

/**
 * The relative targets of one line's prose: an inline link's or image's (`[text](target)`, spaces
 * around it allowed, `<..>` holding one with spaces) and, inside an HTML tag that closes on the
 * line (a `>` in a quoted value does not close it), a `src`, `srcset` or `href` value, quoted
 * either way or not at all. A URL, an anchor alone and an empty target are left out, and the
 * anchor and query are cut off.
 * @param {string} prose
 */
function targetsIn(prose) {
  /** @type {string[]} */
  const targets = [];
  for (const [, target] of prose.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)/g)) targets.push(target.replace(/^<|>$/g, ""));
  for (const [, attributes] of prose.matchAll(new RegExp(tag, "gi"))) {
    for (const [, name, double, single, bare] of attributes.matchAll(new RegExp(attribute, "gi"))) {
      const value = double ?? single ?? bare;
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (lower === "srcset") for (const each of value.split(",")) targets.push(each.trim().split(/\s+/)[0]);
      else if (lower === "src" || lower === "href") targets.push(value);
    }
  }
  return targets.map((t) => t.split(/[#?]/)[0]).filter((path) => path && !/^[a-z][a-z\d+.-]*:/i.test(path) && !path.startsWith("//"));
}

/** Every path of `paths` (files, from the root) and every folder above one, and `.`. @param {string[]} paths */
export function presentIn(paths) {
  const present = new Set(["."]);
  for (const file of paths) {
    for (let at = file; at && at !== "."; at = posix.dirname(at)) present.add(at);
  }
  return present;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  // Once each: a file with a conflict is listed once per side.
  const files = [...new Set(git(["ls-files", "-z", "--", "*.md"]))];
  // Every file a commit would hold: tracked, or new and not ignored.
  const present = presentIn(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  /** @type {string[]} */
  const problems = [];
  let rows = 0;
  let links = 0;
  for (const file of files) {
    // A tracked file deleted in the working tree but not staged is still listed.
    if (!existsSync(join(root, file))) continue;
    const found = scan(file, readFileSync(join(root, file), "utf8"), present);
    problems.push(...found.problems);
    rows += found.rows;
    links += found.links;
  }
  if (files.length < 20 || rows < 100 || links < 100) problems.push(`found only ${files.length} Markdown files, ${rows} table rows and ${links} relative links`);
  if (problems.length) {
    console.error(`docs: ${problems.length} problem(s)\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`docs: ${files.length} Markdown files, ${rows} table rows, ${links} relative links`);
}
