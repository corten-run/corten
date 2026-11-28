import { test } from "node:test";
import assert from "node:assert/strict";
import { presentIn, scan } from "./docs.mjs";

const present = presentIn(["README.md", "docs/guide/app.md", "docs/brand/logo dark.svg", "bench/browser/gen/src/bench.js", "bench/browser/README.md"]);
const found = (/** @type {string} */ file, /** @type {string} */ text) => scan(file, text, present);

test("a link to a file or folder the repository has passes, from where the page is", () => {
  const text = [
    "[code](gen/src/bench.js) and [folder](gen/src) and [slash](gen/src/)",
    "[up](../../docs/guide/app.md#links) [root](/README.md) [titled](gen/src/bench.js \"t\") [spaced](<gen/src/bench.js>)",
    "| [in a row](../../README.md) |",
  ].join("\n");
  const { problems, links, rows } = found("bench/browser/README.md", text);
  assert.deepEqual(problems, []);
  assert.equal(links, 8);
  assert.equal(rows, 1);
});

test("a link to a file the repository does not have fails, naming the line", () => {
  const { problems } = found("bench/browser/README.md", "One.\n| view | [apps/view](apps/view/app.js) |\n![shot](shot.png)");
  assert.deepEqual(problems, [
    "bench/browser/README.md:2: a link to apps/view/app.js, which the repository does not have",
    "bench/browser/README.md:3: a link to shot.png, which the repository does not have",
  ]);
});

test("a link to the repository's root passes, however it is written", () => {
  assert.deepEqual(found("README.md", "[a](./) [b](/) [c](.)").problems, []);
  assert.deepEqual(found("docs/guide/app.md", "[a](../../) [b](../..)").problems, []);
});

test("URLs, anchors, code, comments and escaped brackets hold no link to check", () => {
  const text = [
    "[web](https://example.com/x) [mail](mailto:a@b.c) [proto](//example.com/missing.md) [here](#links)",
    "`[x](missing.md)` and ``[x](missing.md)`` and \\[x\\](missing.md)",
    "Text <!-- [x](missing.md) --> then [y](missing-too.md)",
    "<!-- opens",
    "[x](missing.md)",
    "closes --> [z](missing.md), hidden with the block's line",
    "A <!-- with no end is text: [w](missing-three.md)",
    "```md",
    "[x](missing.md)",
    "```",
  ].join("\n");
  const { problems, links } = found("README.md", text);
  assert.deepEqual(problems, [
    "README.md:3: a link to missing-too.md, which the repository does not have",
    "README.md:7: a link to missing-three.md, which the repository does not have",
  ]);
  assert.equal(links, 2);
});

test("an HTML comment that starts a line and never closes is a problem, since it hides the rest", () => {
  assert.deepEqual(found("README.md", "One.\n<!-- a note\n[x](missing.md)").problems, ["README.md:2: an HTML comment that never closes"]);
});

test("a fence line inside a comment is the comment's text, and <!--> closes at once", () => {
  const text = ["<!--", "```", "-->", "[x](m3.md)", "<!-->", "[y](m4.md)", "<!--->", "[z](m5.md)"].join("\n");
  assert.deepEqual(found("README.md", text).problems, [
    "README.md:4: a link to m3.md, which the repository does not have",
    "README.md:6: a link to m4.md, which the repository does not have",
    "README.md:8: a link to m5.md, which the repository does not have",
  ]);
  assert.deepEqual(found("README.md", "<!--\n<<<<<<< ours\n-->").problems, ["README.md:2: a merge conflict's marker"]);
});

test("a comment opened in a block quote or list item hides no line after it", () => {
  const text = ["> <!-- q", "", "[x](q1.md)", "<!-- c -->", "- item", "  <!-- c", "", "Next [y](l1.md)", "<!-- d -->"].join("\n");
  assert.deepEqual(found("README.md", text).problems, [
    "README.md:3: a link to q1.md, which the repository does not have",
    "README.md:8: a link to l1.md, which the repository does not have",
  ]);
});

test("a code span that wraps onto the next line holds no link, and the line after it is read", () => {
  const text = ["See `foo", "bar` and [x](missing.md) and `baz`.", "Use `a", "[y](missing-too.md)` b", "", "`open", "", "[z](m3.md)"].join("\n");
  assert.deepEqual(found("README.md", text).problems, [
    "README.md:2: a link to missing.md, which the repository does not have",
    "README.md:8: a link to m3.md, which the repository does not have",
  ]);
});

test("a table row is a line of its own: a backtick left open in one hides no link in the next", () => {
  const text = ["| a | `open |", "| b | [x](missing.md) |"].join("\n");
  assert.deepEqual(found("README.md", text).problems, ["README.md:2: a link to missing.md, which the repository does not have"]);
});

test("spaces around a target and escaped backticks do not hide a link", () => {
  assert.deepEqual(found("README.md", "[a]( missing.md ) and \\`[b](m2.md)\\`").problems, [
    "README.md:1: a link to missing.md, which the repository does not have",
    "README.md:1: a link to m2.md, which the repository does not have",
  ]);
});

test("an HTML src, srcset or href is checked as a link", () => {
  const text = [
    '<img src="docs/brand/logo%20dark.svg"> <source srcset="docs/brand/logo%20dark.svg 1x, docs/brand/gone.svg 2x">',
    '<a href="docs/guide/app.md#x">a</a> <img src="https://example.com/x.svg"> <img src="missing.svg">',
  ].join("\n");
  const { problems, links } = found("README.md", text);
  assert.deepEqual(problems, [
    "README.md:1: a link to docs/brand/gone.svg, which the repository does not have",
    "README.md:2: a link to missing.svg, which the repository does not have",
  ]);
  assert.equal(links, 5);
});

test("a target is the repository's own spelling: its case, %-escapes, query and the root are kept", () => {
  assert.deepEqual(found("docs/guide/app.md", "[a](../brand/logo%20dark.svg) [b](../../README.md?plain=1)").problems, []);
  assert.deepEqual(found("docs/guide/app.md", "[c](../../readme.md) [d](../../../x.md)").problems, [
    "docs/guide/app.md:1: a link to ../../readme.md, which the repository does not have",
    "docs/guide/app.md:1: a link to ../../../x.md, which the repository does not have",
  ]);
});

test("changelog anchors follow headings, duplicate suffixes and explicit HTML anchors", () => {
  const archive = "CHANGELOG.0.2.0.md";
  const paths = presentIn(["CHANGELOG.md", archive, "docs/guide/kit.md"]);
  const sections = scan(archive, [
    "## 0.2.0 (2026-11-11)", "### Breaking changes", "### Breaking changes",
    "### Use `App` and Café", '<a id="upgrade"></a>', "```markdown", "    ```", "# Not a heading", "```",
  ].join("\n"), paths).anchors;
  const anchorsFor = (/** @type {string} */ file) => file === archive ? sections
    : { ids: new Set(["unreleased"]), unsupported: false };
  const text = [
    "[old](../../CHANGELOG.0.2.0.md#breaking-changes-1) [up](/CHANGELOG.0.2.0.md#upgrade)",
    "[new](../../CHANGELOG.md#unreleased) [version](/CHANGELOG.0.2.0.md#020-2026-11-11)",
    "[Unicode](https://github.com/corten-run/corten/blob/main/CHANGELOG.0.2.0.md#use-app-and-caf%C3%A9)",
    "[moved](/CHANGELOG.md#breaking-changes) [code](/CHANGELOG.0.2.0.md#not-a-heading)",
    "[other repo](https://github.com/nats-io/nats.rs/blob/main/CHANGELOG.md#breaking-changes)",
    "[historic tag](https://github.com/corten-run/corten/blob/v0.2.0/CHANGELOG.md#breaking-changes)",
  ].join("\n");
  assert.deepEqual(scan("docs/guide/kit.md", text, paths, anchorsFor).problems, [
    "docs/guide/kit.md:4: a link to /CHANGELOG.md#breaking-changes, but CHANGELOG.md has no #breaking-changes anchor",
    "docs/guide/kit.md:4: a link to /CHANGELOG.0.2.0.md#not-a-heading, but CHANGELOG.0.2.0.md has no #not-a-heading anchor",
  ]);
  assert.deepEqual(scan(archive, "[self](#breaking-changes) [bad](#absent)", paths, anchorsFor).problems, [
    "CHANGELOG.0.2.0.md:1: a link to #absent, but CHANGELOG.0.2.0.md has no #absent anchor",
  ]);
});

test("changelog heading slugs keep literal code and identifier underscores", () => {
  const archive = "CHANGELOG.0.2.0.md";
  const paths = presentIn(["README.md", archive]);
  const headings = [
    "### Use `foo_bar_baz`",
    "### x and y with plain_name",
    "### Read `` Vec<T> `inner` ``!",
  ].join("\n");
  const anchorsFor = () => scan(archive, headings, paths).anchors;
  const links = [
    "[code](CHANGELOG.0.2.0.md#use-foo_bar_baz)",
    "[wrong](CHANGELOG.0.2.0.md#use-foobarbaz)",
    "[prose](CHANGELOG.0.2.0.md#x-and-y-with-plain_name)",
    "[literal](CHANGELOG.0.2.0.md#read-vect-inner)",
  ].join("\n");
  assert.deepEqual(scan("README.md", links, paths, anchorsFor).problems, [
    "README.md:2: a link to CHANGELOG.0.2.0.md#use-foobarbaz, but CHANGELOG.0.2.0.md has no #use-foobarbaz anchor",
  ]);
});

test("unverifiable changelog headings do not hide later supported anchors or fail links", () => {
  const archive = "CHANGELOG.0.2.0.md";
  const paths = presentIn(["README.md", archive]);
  for (const [heading, slug] of [
    ["### Ampersand &amp; names", "ampersand--names"],
    ["### Use [CLI](https://example.org/a(b)c)", "use-cli"],
    ["### Use <strong>CLI</strong>", "use-cli"],
    ["### Use **the _CLI_**", "use-the-cli"],
  ]) {
    const index = scan(archive, [
      "### Earlier heading", heading, '<a id="explicit"></a>', "### Unique plain heading", "### Earlier heading",
    ].join("\n"), paths).anchors;
    assert.equal(index.unsupported, true, heading);
    assert.deepEqual(index.ids, new Set(["earlier-heading", "explicit", "unique-plain-heading", "earlier-heading-1"]), heading);
    const link = (/** @type {string} */ id) => "[section](" + archive + "#" + id + ")";
    assert.equal(index.ids.has(slug), false, heading);
    const text = [link(slug), link("unique-plain-heading"), link("missing")].join("\n");
    assert.deepEqual(scan("README.md", text, paths, () => index).problems, [], heading);
  }
});

test("changelog anchors ignore indented code but keep headings in list continuations", () => {
  const archive = "CHANGELOG.0.2.0.md";
  const paths = presentIn([archive]);
  const headings = [
    "    ### At the start", "", "    ### Still code &amp; not a heading",
    "### A plain heading", "", "    ### Only an example", "    ```",
    "10. An item", "", "    ### A list heading", "", "### Back at top level", "", "    ### Not in the list",
  ].join("\n");
  const index = scan(archive, headings, paths);
  assert.deepEqual(index.problems, []);
  const links = "[start](#at-the-start) [example](#only-an-example) [list](#a-list-heading) [outside](#not-in-the-list) [missing](#missing)";
  assert.deepEqual(scan(archive, links, paths, () => index.anchors).problems, [
    "CHANGELOG.0.2.0.md:1: a link to #at-the-start, but CHANGELOG.0.2.0.md has no #at-the-start anchor",
    "CHANGELOG.0.2.0.md:1: a link to #only-an-example, but CHANGELOG.0.2.0.md has no #only-an-example anchor",
    "CHANGELOG.0.2.0.md:1: a link to #not-in-the-list, but CHANGELOG.0.2.0.md has no #not-in-the-list anchor",
    "CHANGELOG.0.2.0.md:1: a link to #missing, but CHANGELOG.0.2.0.md has no #missing anchor",
  ]);
});

test("a backtick with no partner in its paragraph is text, and hides no link after it", () => {
  const text = ["1. A stray ` here", "2. [x](m1.md)", "3. [y](m2.md)", "", "# A heading with ` open", "[z](m3.md)", "Path `C:\\` then [w](m4.md)"].join("\n");
  assert.deepEqual(found("README.md", text).problems, [
    "README.md:2: a link to m1.md, which the repository does not have",
    "README.md:3: a link to m2.md, which the repository does not have",
    "README.md:6: a link to m3.md, which the repository does not have",
    "README.md:7: a link to m4.md, which the repository does not have",
  ]);
});

test("an HTML attribute is read only inside a tag, quoted either way or bare", () => {
  const text = ["<img data-src=\"m1.svg\"> and src=\"m2.svg\" in prose", "<img src='m3.svg'> <a href=m4.md>a</a>"].join("\n");
  assert.deepEqual(found("README.md", text).problems, [
    "README.md:2: a link to m3.svg, which the repository does not have",
    "README.md:2: a link to m4.md, which the repository does not have",
  ]);
});

test("a tag ends at its own >, not one in a quoted value, and a comment or code span is whichever starts first", () => {
  const text = [
    'if a <b and src=m1.svg in prose, <source media="(min-width>600px)" srcset="m2.svg"> <img alt="src=m3.svg" src=m4.svg>',
    "Text <!-- a ` b --> [x](m5.md) and `c`. Code `<!--` then [y](m6.md) <!-- -->",
  ].join("\n");
  assert.deepEqual(found("README.md", text).problems, [
    "README.md:1: a link to m2.svg, which the repository does not have",
    "README.md:1: a link to m4.svg, which the repository does not have",
    "README.md:2: a link to m5.md, which the repository does not have",
    "README.md:2: a link to m6.md, which the repository does not have",
  ]);
});

test("a backtick in a tag's quoted value opens no code span, and an inline <!--> or <!---> closes at once", () => {
  const text = ['<img alt="a`b" src="m1.svg"> and `c`', "a <!--> [x](m2.md) -->", "a <!---> [y](m3.md) -->"].join("\n\n");
  assert.deepEqual(found("README.md", text).problems, [
    "README.md:1: a link to m1.svg, which the repository does not have",
    "README.md:3: a link to m2.md, which the repository does not have",
    "README.md:5: a link to m3.md, which the repository does not have",
  ]);
});
