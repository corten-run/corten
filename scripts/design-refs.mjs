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
// the Choices' order is scripts/choices.mjs's to check. Code in Markdown is code: a path to an
// anchor there is checked, and in a fenced block a citation by number is still one, but inline
// code (an example in prose) is checked only for its anchors. A web link to design.md on main is
// checked as a relative one is; one pinned to a commit is left alone, since it names that
// commit's items; a link to a tag, to a branch whose name has a slash, or with a query
// (`?plain=1`) is not written today and not handled. Not read: CHANGELOG.md (a record of what
// each release said), choices.test.mjs's fixtures and this file.
//
// And each commit the repository's Markdown cites: a code span of 7 to 40 hex digits alone
// (`f56bef59`), the form scripts/choices.mjs reads a Last checked commit in, names a commit on
// HEAD's history (main's, or a branch's that merges into it) or under refs/tags/evidence/, which
// keeps a cited commit no branch has (`evidence/<name>`, usually the commit's short name). So a
// number can be taken again on the commit it was taken on, from a clone of corten-run/corten: a
// commit the clone has but GitHub does not keep (one never pushed, or only on a side branch)
// fails too. A code span of hex digits or a number that is not a commit fails the same way, and is
// written without backticks or with its algorithm (`sha256:...`); one of decimal digits alone is
// still read, since a commit's short name can be (`76247120`). Another repository's commit is
// written as GitHub writes one, `owner/repo@sha`, and is not read, but that form naming Corten
// (`*/corten@sha`, in any case) fails: Corten's own commit is written alone, so it is checked. A
// shallow clone fails once, saying to fetch the whole history and the evidence tags, not once for
// each commit it cut off. Not read for commits: code, where a code span of hex digits is as often
// a number, and four commits bench/fullstack/README.md cites (below).
// Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/** A commit cited in Markdown: a code span of 7 to 40 lower-case hex digits alone, or one written
 * as a repository named corten's (`corten-run/corten@sha`, in any case), which is refused. */
const COMMIT = /`(?:([\w.-]+\/corten)@)?([0-9a-f]{7,40})`/gi;
// CHANGELOG.md is not read at all.
/** Fetches the evidence tags from corten-run/corten itself, which a fork's origin may lack. */
const FETCH = 'https://github.com/corten-run/corten.git "+refs/tags/evidence/*:refs/tags/evidence/*"';

/**
 * Each commit the Markdown `text` cites, with its line (from 1), and the repository it was
 * written as, when it was written as one named corten's.
 * @param {string} text @returns {{ line: number, sha: string, as?: string }[]}
 */
export function cited(text) {
  return text.split(/\r?\n/).flatMap((line, i) =>
    [...line.matchAll(COMMIT)]
      // Upper-case digits alone are not a citation (`A398EA95`); in the refused form they are.
      .filter((m) => m[1] || String(m[2]) === String(m[2]).toLowerCase())
      .map((m) => ({ line: i + 1, sha: String(m[2]).toLowerCase(), ...(m[1] ? { as: m[1] } : {}) })),
  );
}

/**
 * The problems with the commits cited at `found` (`at` is `file:line`) in the clone at `root`:
 * one for a shallow clone, which cannot show them, or one for each citation that writes Corten's
 * commit as a repository's, names no commit on HEAD's history or under an evidence tag, or starts
 * more than one's name, and then how to fetch the evidence tags.
 * @param {string} root @param {{ at: string, sha: string, as?: string }[]} found @returns {string[]}
 */
export function unresolved(root, found) {
  if (found.length === 0) return [];
  const git = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 1 << 26 });
  /** @type {string[]} */
  const problems = [];
  const own = found.filter((c) => !c.as);
  for (const { at, sha, as } of found) {
    if (as) problems.push(`${at}: \`${as}@${sha}\` names Corten's own commit; write it as \`${sha}\`, so it is checked`);
  }
  if (own.length === 0) return problems;
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    return [
      ...problems,
      `this clone is shallow, so it cannot show the ${own.length} citations of ${new Set(own.map((c) => c.sha)).size} commits; fetch the whole history and the evidence tags: git fetch --unshallow ${FETCH}`,
    ];
  }
  // Every commit on HEAD's history or an evidence tag's, by its full name. A cited name is one's
  // start; a few thousand names, matched against a few hundred citations.
  const reachable = git(["rev-list", "HEAD", "--glob=refs/tags/evidence/*"]).split("\n").filter(Boolean);
  /** @type {Map<string, number>} */
  const matches = new Map();
  for (const sha of new Set(own.map((c) => c.sha))) matches.set(sha, reachable.filter((name) => name.startsWith(sha)).length);
  let missing = false;
  for (const { at, sha } of own) {
    const n = matches.get(sha);
    if (n === 1) continue;
    if (n) problems.push(`${at}: \`${sha}\` starts the names of ${n} commits; cite more of its digits`);
    else {
      problems.push(`${at}: \`${sha}\` is not a commit on HEAD's history or under refs/tags/evidence/`);
      missing = true;
    }
  }
  if (missing) {
    problems.push(
      `a cited commit is on main's history (or this branch's) or kept under refs/tags/evidence/<name>; merge main into a branch behind it, and fetch the evidence tags: git fetch ${FETCH}. Hex or a number that is not a commit is written without backticks, or with its algorithm (\`sha256:...\`)`,
    );
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
    .filter((file, i, all) => file && all.indexOf(file) === i && !["CHANGELOG.md", "scripts/design-refs.mjs", "scripts/choices.test.mjs"].includes(file));
  const capital = /\b(?:Choices?|Limits?|Rules?),? \d+\b/;
  const lowerDesign = /\bdesign (?:choices?|rules?|limits?),? \d+\b/i;
  let links = 0;
  /** Each commit the Markdown cites. @type {{ at: string, sha: string, as?: string }[]} */
  const commits = [];
  for (const file of files) {
    // A tracked file deleted in the working tree but not staged is still listed.
    if (!existsSync(join(root, file))) continue;
    const markdown = file.endsWith(".md");
    const toDesign = markdown ? posix.relative(posix.dirname(file), DESIGN) : DESIGN;
    /** Lines inside a Markdown code block, which take a citation as code does. @type {Set<number>} */
    const fenced = new Set();
    const hint = (kind, /** @type {number} */ i) => (markdown && !fenced.has(i) ? `[${names[kind]} N](${file === DESIGN ? "" : toDesign}#${kind}-name)` : `${DESIGN}#${kind}-name, with no number`);
    /** The item an anchor names, or undefined after saying it names none. */
    const item = (/** @type {string} */ at, /** @type {string} */ kind, /** @type {string} */ name, /** @type {string} */ what) => {
      links += 1;
      const n = anchors.get(kind)?.get(name);
      if (n === undefined) problems.push(`${at}: ${what} points at no ${kind} in ${DESIGN}`);
      return n;
    };
    /** Checks the numbers a link's text names against the item its anchor is. */
    const said = (/** @type {string} */ at, /** @type {string} */ link, /** @type {string} */ text, /** @type {string} */ kind, /** @type {number} */ n) => {
      const named = [...text.matchAll(/\b(Choice|Rule|Limit)s?,? (\d+(?:(?:,? and|,? or|,? &| to| through|,) \d+|\s?[-\u2013\u2014]\s?\d+)*)\b/gi)];
      const numbers = named.flatMap((m) => m[2].match(/\d+/g) ?? []);
      if (numbers.length > 1) problems.push(`${at}: ${link} names more than one number; link each item`);
      else if (named.length && (named[0][1].toLowerCase() !== kind || Number(numbers[0]) !== n)) {
        problems.push(`${at}: ${link} names ${named[0][1]} ${numbers[0]}, but its ${kind} is ${names[kind]} ${n} now`);
      }
    };
    /** Checks each anchor path in `text` and returns it with them taken out. */
    const paths = (/** @type {string} */ at, /** @type {string} */ text) =>
      text.replace(/design\.md#(choice|rule|limit)-([a-z0-9-]+)/g, (path, kind, name) => {
        item(at, kind, name, path);
        return "";
      });
    /** Whether `line` ends a link's text that began on the line before, the link going to one of
     * design.md's anchors (relative, or a web link on main). */
    const closesDesignLink = (/** @type {string | undefined} */ line) =>
      /^[^[]*\]\((?:(?!https?:)[^)#\s]*design\.md|https?:[^)\s]*\/blob\/main\/docs\/design\.md|)#(?:choice|rule|limit)-/.test(line ?? "");
    /** @type {string | null} */
    let fence = null;
    const source = readFileSync(join(root, file), "utf8");
    if (markdown) commits.push(...cited(source).map((c) => ({ ...c, at: `${file}:${c.line}` })));
    const lines = source.split(/\r?\n/);
    /** Each line with its citations taken out, or null when it is not read. @type {(string | null)[]} */
    const rests = lines.map((line, i) => {
      const at = `${file}:${i + 1}`;
      if (markdown) {
        const mark = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(`{3,}|~{3,})/.exec(line);
        if (fence) {
          if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && /^\s*(?:>\s*)*(`{3,}|~{3,})\s*$/.test(line)) {
            fence = null;
            return null;
          }
          // Code in a block: its anchors are checked, and a number is a citation as in a source file.
          fenced.add(i);
          return paths(at, line);
        }
        if (mark && !(mark[1][0] === "`" && line.slice(line.indexOf(mark[1]) + mark[1].length).includes("`"))) {
          fence = mark[1];
          return null;
        }
      }
      // In Markdown, inline code (`` `[Choice N](..)` ``) is an example: its anchors are checked,
      // its numbers are not read.
      const text = markdown ? line.replace(/(`+)((?:(?!\1).)+?)\1/g, (_, ticks, code) => (paths(at, code), "")) : line;
      // A link to the web: checked when it is to design.md's anchors on main (a blob URL); one
      // pinned to a commit names that commit's items.
      let rest = text.replace(/\[((?:[^\]\\]|\\.)*)\]\((https?:[^)\s]*)[^)]*\)/g, (link, words, url) => {
        const anchor = /\/blob\/([^/]+)\/docs\/design\.md#(choice|rule|limit)-([a-z0-9-]+)$/.exec(url);
        if (anchor && !/^[0-9a-f]{7,40}$/.test(anchor[1])) {
          const n = item(at, anchor[2], anchor[3], link);
          if (n !== undefined) said(at, link, words, anchor[2], n);
        }
        return "";
      });
      rest = rest.replace(
        /\[([^\]]*)\]\(((?:[^)#\s]*\/)?design\.md)?#(choice|rule|limit)-([a-z0-9-]+)(?:\s+"[^"]*")?\)/g,
        (link, text, path, kind, name) => {
          if (path === undefined && file !== DESIGN) return link;
          if (path !== undefined && posix.join(posix.dirname(file), path) !== DESIGN) {
            const why = path.startsWith("/") ? "a link from the repository's root renders only on GitHub" : `it does not reach ${DESIGN} from here`;
            problems.push(`${at}: ${link}: ${why}; write ${toDesign}#${kind}-${name}`);
            links += 1;
            return "";
          }
          const n = item(at, kind, name, link);
          if (n !== undefined) said(at, link, text, kind, n);
          return "";
        },
      );
      // A URL pinned to a commit, outside a link read whole (one whose text wrapped), names that
      // commit's items.
      return paths(at, rest.replace(/https?:[^)\s]*\/blob\/[0-9a-f]{7,40}\/docs\/design\.md#[a-z0-9-]+/g, ""));
    });
    rests.forEach((rest, i) => {
      if (rest === null) return;
      const at = `${file}:${i + 1}`;
      // `[design\nLimit 14](..)`: a link's text that began on the line before, so the link was not
      // read. One to design.md is a citation it cannot check; the text of a link elsewhere is not one,
      // and the rest of the line is read as any line is.
      let text = rest;
      const close = text.indexOf("](");
      if (close >= 0 && !text.slice(0, close).includes("[") && (capital.test(text.slice(0, close)) || lowerDesign.test(text.slice(0, close)))) {
        if (closesDesignLink(lines[i])) {
          problems.push(`${at}: a link's text wraps over two lines, so it is not read as a link; keep its text on one line`);
          return;
        }
        const end = text.indexOf(")", close);
        text = end < 0 ? "" : text.slice(end + 1);
      }
      const bare = capital.exec(text) ?? lowerDesign.exec(text);
      if (bare) {
        const kind = /^design /i.test(bare[0]) ? bare[0].split(" ")[1].toLowerCase().replace(/s?,?$/, "") : bare[0].toLowerCase().replace(/s?,? \d+$/, "");
        problems.push(`${at}: "${bare[0]}" without its link; write ${hint(kind, i)}`);
        return;
      }
      // A citation split over two lines: the kind ends this one, the number starts the next.
      const next = rests[i + 1];
      const ends = /\b(Choices?|Limits?|Rules?|design (?:choices?|rules?|limits?)|design),?$/i.exec(rest.trimEnd());
      const lead = /^\s*(?:\/\/[\/!]?|#|\*|>)?\s*/;
      // "design" ends this line and a kind with its number starts the next; or the kind ends it
      // and the number starts the next.
      const starts = next && (/^design$/i.test(ends?.[1] ?? "")
        ? new RegExp(lead.source + /((?:choices?|rules?|limits?),? \d+)\b/i.source, "i").exec(next)
        : new RegExp(lead.source + /(\d+)\b/.source).exec(next));
      const split = ends && starts ? `${ends[1]} ${starts[1]}` : "";
      if (split && (capital.test(split) || lowerDesign.test(split))) {
        // A link's text that wraps: reported here unless the next line, holding a whole citation,
        // reports it.
        if (!/^[^[]*\]\(/.test(next)) problems.push(`${at}: "${split}", split over two lines, without its link; write it on one line as a link`);
        else if (closesDesignLink(lines[i + 1]) && !(capital.test(next) || lowerDesign.test(next))) {
          problems.push(`${at}: a link's text wraps over two lines, so it is not read as a link; keep its text on one line`);
        }
      }
    });
  }
  if (files.length < 100 || links < 20) problems.push(`found only ${files.length} files and ${links} citations of design.md's items`);
  // About 220 when this was written: fewer means the files or the form were missed, not that the
  // citations went.
  if (commits.length < 100) problems.push(`found only ${commits.length} citations of commits in the Markdown`);
  problems.push(...unresolved(root, commits));
  if (problems.length) {
    console.error(`design-refs: ${problems.length} problem(s)\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `design-refs: ${links} citations of ${[...anchors.values()].reduce((n, items) => n + items.size, 0)} items, in ${files.length} files; ${commits.length} citations of ${new Set(commits.map((c) => c.sha)).size} commits, each one on HEAD's history or under an evidence tag`,
  );
}
