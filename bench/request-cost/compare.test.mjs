// node --test bench/request-cost/compare.test.mjs
// The comparison against two builds' directories written here as the kit's scripts print with
// --json: what passes, what does not, what a declaration changes, and what is said of a run with
// no figure. Nothing is counted, so these run anywhere; run.test.mjs holds what the kit really
// prints against the reader here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { RUNS, compare, declared, figure, over, readings } from "./compare.mjs";
import { median } from "./figures.mjs";
import { cases } from "./requests.mjs";

const CASES = Object.keys(cases).length;

const kit = dirname(fileURLToPath(import.meta.url));
const names = Object.keys(cases);
/** What each run's JSON must say it is of, by its file. */
const expect = Object.fromEntries(readings().map((reading) => [reading.file, reading.expect]));

/**
 * A build's figures: three counts a case, allocations and frees in the case's requests, three runs
 * an idle reading, each its growth in pages, and the page size the idle runs were read in.
 */
const figures = () => ({
  count: Object.fromEntries(names.map((name, at) => [name, [20_000 + at, 20_000 + at, 20_001 + at]])),
  deep: { pipeline: [9_000, 9_000, 9_000], get: [15_000, 15_001, 15_000], unstaged: [10_000, 10_000, 10_000], text: [9_500, 9_500, 9_500] },
  allocations: Object.fromEntries(names.map((name) => [name, [16_000, 16_000]])),
  idle: { request: [10_279, 10_281, 10_280], browser: [11_108, 11_108, 11_109], silent: [3_224, 3_227, 3_225] },
  page: 4_096,
});

/**
 * A run's line of JSON as the kit prints it: `count.mjs` for counts, a pair of calls, or an idle
 * run's growth in pages of `page` bytes.
 * @param {string} file @param {number[] | number} measured
 */
function printed(file, measured, page = 4_096) {
  const of = /** @type {Record<string, any>} */ (expect[file]);
  if (of.kind === "instructions") {
    const counts = /** @type {number[]} */ (measured);
    return JSON.stringify({ ...of, counts, median: median(counts), windows: counts.map((each) => ({ instructions: each * of.requests, seconds: 0.9, others: 243, threads: 1 })) }) + "\n";
  }
  if (of.kind === "allocations") {
    const [allocations, frees] = /** @type {number[]} */ (measured);
    return JSON.stringify({ ...of, allocations, frees, calls: { free: frees, malloc: allocations } }) + "\n";
  }
  const grown = /** @type {number} */ (measured) * page;
  // Resident memory is whole pages, so the reading before is one too, in either page size.
  const before = Math.ceil(7_577_600 / page) * page;
  return JSON.stringify({ ...of, bytes: Math.round(grown / of.connections), before, after: before + grown, grown, page, seconds: 0.6 }) + "\n";
}

const page = "<!DOCTYPE html><table><tr><td>119</td><td>A row of the page, about as long as a row of a listing is</td><td>833</td></tr></table></main></body></html>";
/** The answer a case must get, as `count.mjs --answers` writes it. @param {string} name */
function answer(name) {
  const { body, encoding } = /** @type {typeof cases[string]} */ (cases[name]);
  const sent = typeof body === "string" ? Buffer.from(body) : encoding ? zlib.zstdCompressSync(page) : Buffer.from(page);
  return Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${sent.length}\r\n${encoding ? `content-encoding: ${encoding}\r\n` : ""}date: -\r\n\r\n`), sent]);
}

/**
 * A directory with two builds' runs, each a file as `readings` names it, and their answers.
 * `edit` changes the figures before they are written; a figure set to null leaves no file.
 * @param {import("node:test").TestContext} t
 * @param {(base: ReturnType<typeof figures>, head: ReturnType<typeof figures>) => void} [edit]
 */
function builds(t, edit = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "request-cost-compare-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const [base, head] = [figures(), figures()];
  edit(base, head);
  for (const [side, build] of /** @type {const} */ ([["base", base], ["head", head]])) {
    const at = join(directory, side);
    mkdirSync(join(at, "answers"), { recursive: true });
    for (const name of names) writeFileSync(join(at, "answers", `${name}.http`), answer(name));
    const write = (/** @type {string} */ file, /** @type {number[] | number | null} */ measured) => measured !== null && writeFileSync(join(at, file), printed(file, measured, build.page));
    for (const [name, counts] of Object.entries(build.count)) write(`count-${name}.json`, counts);
    for (const [name, counts] of Object.entries(build.deep)) write(`count-16-${name}.json`, counts);
    for (const [name, calls] of Object.entries(build.allocations)) write(`allocations-${name}.json`, calls);
    for (const [name, runs] of Object.entries(build.idle)) runs.forEach((bytes, run) => write(`idle-${name}-${run + 1}.json`, bytes));
  }
  return { base: join(directory, "base"), head: join(directory, "head") };
}

const counting = "Request path: counted\n";
const measuring = "Request path: measured\n";
/** What a verdict says it read of `counting`, and of `measuring`. */
const readCounted = "Read from the description: `Request path: counted`, at line 1.";
const readMeasured = "Read from the description: `Request path: measured`, at line 1.";
/** The verdict's line of a table. @param {string} markdown */
const verdict = (markdown) => /** @type {string} */ (markdown.split("\n").find((line) => line.startsWith("**")));

test("the runs to take are every case's instructions, four at a depth of 16, every case's allocations and three idle readings three times", () => {
  const all = readings();
  assert.equal(all.length, CASES + 4 + CASES + 3 * RUNS);
  assert.equal(RUNS, 3);
  assert.deepEqual(all[0], { file: "count-get.json", script: "count.mjs", options: ["--json", "--cases", "get"], expect: { kind: "instructions", case: "get", depth: 1, requests: 1000 } });
  assert.deepEqual(all.filter(({ options }) => options.includes("--depth")).map(({ file, options, expect: of }) => [file, options.join(" "), of.requests]), [
    ["count-16-pipeline.json", "--json --depth 16 --cases pipeline", 992],
    ["count-16-get.json", "--json --depth 16 --cases get", 992],
    ["count-16-unstaged.json", "--json --depth 16 --cases unstaged", 992],
    ["count-16-text.json", "--json --depth 16 --cases text", 992],
  ]);
  assert.deepEqual(all.filter(({ options }) => options.includes("--allocations")).map(({ options }) => options.at(-1)), names);
  // An idle reading's three runs are not one after another: the other readings are between them.
  assert.deepEqual(all.filter(({ script }) => script === "idle.mjs").map(({ file, options }) => `${file} ${options.join(" ")}`), [1, 2, 3].flatMap((run) => [`idle-request-${run}.json --json`, `idle-browser-${run}.json --json --case get-browser --requests 3`, `idle-silent-${run}.json --json --silent`]));
  assert.deepEqual(all.at(-1)?.expect, { kind: "idle", case: "pipeline", requests: 0, connections: 5000, addresses: 1 });
  // No two runs write one file, and none names the probe, its CPU or its port: the caller's.
  assert.equal(new Set(all.map(({ file }) => file)).size, all.length);
  assert.ok(all.every(({ options }) => !options.some((option) => option === "--cpu" || option === "--port")));
  const lines = spawnSync(process.execPath, [join(kit, "compare.mjs"), "--readings"], { encoding: "utf8" });
  assert.equal(lines.status, 0, lines.stderr);
  assert.deepEqual(lines.stdout.trimEnd().split("\n"), all.map(({ file, script, options }) => [file, script, ...options].join(" ")));
});

test("a figure is a run's whole JSON, of the run asked for: cut short, of another run or with a number the kit could not have measured, it is none", () => {
  for (const [file, measured] of /** @type {[string, number[] | number][]} */ ([["count-get.json", [18_987, 18_990, 18_986]], ["count-16-text.json", [9_500, 9_500, 9_501]], ["allocations-post.json", [16_004, 15_000]], ["idle-browser-2.json", 11_108], ["idle-silent-1.json", -3]])) {
    const text = printed(file, measured);
    const of = /** @type {Record<string, any>} */ (expect[file]);
    assert.deepEqual(figure(text, of), JSON.parse(text), file);
    // Cut anywhere, it is no figure: neither the first sample, nor a number that had more digits.
    for (let length = 0; length < text.length - 1; length += 1) assert.equal(figure(text.slice(0, length), of), null, `${file} cut to ${length}`);
    // Whole, and of another run: each thing a run is asked for, by turns.
    for (const key of Object.keys(of)) assert.equal(figure(text, { ...of, [key]: typeof of[key] === "number" ? of[key] + 1 : "other" }), null, `${file} of another ${key}`);
    assert.equal(figure(text + text, of), null, "two runs' output");
  }
  const count = /** @type {Record<string, any>} */ (expect["count-get.json"]);
  const changed = (/** @type {(found: any) => void} */ change) => {
    const found = JSON.parse(printed("count-get.json", [20_000, 21_000, 21_000]));
    change(found);
    return figure(JSON.stringify(found), count);
  };
  assert.equal(changed(() => {})?.median, 21_000);
  // A median that is not the counts', counts that are not the windows', and fewer than three.
  assert.equal(changed((found) => (found.median = 20_000)), null);
  assert.equal(changed((found) => (found.counts = [21_000, 21_000, 21_000])), null);
  assert.equal(changed((found) => [found.counts.pop(), found.windows.pop()]), null);
  assert.equal(changed((found) => (found.windows[1].others = null)), null);
  assert.equal(changed((found) => (found.windows[2].seconds = "0.9")), null);
  const calls = /** @type {Record<string, any>} */ (expect["allocations-get.json"]);
  assert.equal(figure(JSON.stringify({ ...calls, allocations: 16_000 }), calls), null);
  assert.equal(figure(JSON.stringify({ ...calls, allocations: 16_000.5, frees: 1 }), calls), null);
  assert.equal(figure(JSON.stringify({ ...calls, allocations: 999, frees: 999 }), calls), null);
  // An idle run of 40 connections, of 5,000 from two addresses (`--addresses 2`), of another
  // case, of requests where none were to be sent, and one whose bytes are not its own growth
  // over its connections.
  const idle = /** @type {Record<string, any>} */ (expect["idle-silent-1.json"]);
  const run = JSON.parse(printed("idle-silent-1.json", 3_225));
  assert.ok(figure(JSON.stringify(run), idle));
  assert.equal(figure(JSON.stringify({ ...run, connections: 40 }), idle), null);
  assert.equal(figure(JSON.stringify({ ...run, addresses: 2 }), idle), null);
  assert.equal(figure(JSON.stringify({ ...run, case: "get-browser" }), idle), null);
  assert.equal(figure(JSON.stringify({ ...run, requests: 1 }), idle), null);
  assert.equal(figure(JSON.stringify({ ...run, bytes: 2_000 }), idle), null);
  // A growth that is not its after less its before, and a page size that is not one; and a run
  // without either, as idle.mjs printed before them, whose growth is not guessed from its bytes.
  assert.equal(figure(JSON.stringify({ ...run, grown: run.grown + 4_096 }), idle), null);
  // A growth of whole pages between readings that are not whole pages, which no VmRSS gives.
  assert.equal(figure(JSON.stringify({ ...run, before: 1, after: 1 + run.grown }), idle), null);
  assert.equal(figure(JSON.stringify({ ...run, before: run.before + 1, after: run.after + 1 }), idle), null);
  for (const page of [0, -4_096, 4_096.5, "4096", 2 ** 53, null]) assert.equal(figure(JSON.stringify({ ...run, page }), idle), null, String(page));
  const { grown, page, ...old } = run;
  for (const before of [old, { ...old, grown }, { ...old, page }]) assert.equal(figure(JSON.stringify(before), idle), null, JSON.stringify(before));
  for (const text of ["", "null", "[]", "2641", "2641 bytes a connection (5000 that sent nothing, opened in 0.6 s; 1 before, 2 after)\n"]) assert.equal(figure(text, idle), null, text);
});

test("the way is declared by exactly one line that is the declaration and nothing else, wherever it stands", () => {
  // First and last; and in an example's fence, a comment and under a quoted line, for no Markdown is read.
  assert.deepEqual(declared("Request path: measured"), { way: "measured", lines: [1] });
  assert.deepEqual(declared("What changed.\n\n## Measurements\n\nRequest path: counted\n"), { way: "counted", lines: [5] });
  assert.deepEqual(declared("An example:\n\n```\nRequest path: measured\n```\n"), { way: "measured", lines: [4] });
  assert.deepEqual(declared("<!--\nRequest path: measured\n-->\n"), { way: "measured", lines: [2] });
  assert.deepEqual(declared("> The job says:\nRequest path: counted\n"), { way: "counted", lines: [2] });
  // As a browser's form sends a description, with spaces left at the line's end and without.
  assert.deepEqual(declared("What changed.\r\nRequest path: measured  \r\n\r\n## Checks\r\n"), { way: "measured", lines: [2] });
  assert.deepEqual(declared("Request path: counted\r\n"), { way: "counted", lines: [1] });
  // None; and more than one, the same or not.
  assert.deepEqual(declared(""), { way: null, lines: [] });
  assert.deepEqual(declared("Request path: counted\n\nRequest path: counted\n"), { way: null, lines: [1, 3] });
  assert.deepEqual(declared("Request path: counted\n\n```\nRequest path: measured\n```\n"), { way: null, lines: [1, 4] });
  // Not a declaration line: words after it, anything before it, and any other spelling.
  for (const line of [
    "Request path: counted, as the job says",
    "Request path: counted <!-- the kit's page says why -->",
    "Request path: counted\t",
    // A carriage return that is not the one before the line feed: before a space, or with another.
    "Request path: counted\r ",
    "Request path: counted\r \r",
    "Request path: counted\r\r",
    " Request path: counted",
    "> Request path: measured",
    "- Request path: measured",
    "own: `Request path: counted` or `Request path: measured`.",
    "request path: counted",
    "Request path: Counted",
    "Request path:  counted",
    "Request path: neither",
  ]) {
    assert.deepEqual(declared(`${line}\n`), { way: null, lines: [] }, line);
  }
});

test("the budget is more than 0.5% of base's instructions, and a rise of exactly that is inside it", () => {
  assert.equal(over(20_000, 20_100), false);
  assert.equal(over(20_000, 20_101), true);
  // 0.5% of 18,987 is 94.9: 94 more is inside, 95 is over.
  assert.equal(over(18_987, 18_987 + 94), false);
  assert.equal(over(18_987, 18_987 + 95), true);
  // By the whole count, where a percentage of three places would read both as +0.500%.
  assert.equal(over(221_809, 221_809 + 1_109), false);
  assert.equal(over(221_809, 221_809 + 1_110), true);
  assert.equal(over(18_987, 18_000), false);
  assert.equal(over(18_987, 18_987), false);
});

test("a change inside the budget passes as counted, and the table gives every run's figure", (t) => {
  const { base, head } = builds(t, (_, build) => {
    // +0.5% exactly on one case, and fewer on another.
    build.count.get = [20_100, 20_100, 20_101];
    build.count.post = [19_000, 19_001, 19_000];
  });
  const { markdown, status, holds } = compare(base, head, { description: counting, names: { base: "a".repeat(40), head: "b".repeat(40) } });
  assert.deepEqual([status, holds], [0, true]);
  assert.match(markdown, /^## What a request costs: `bbbbbbbbb` against `aaaaaaaaa`$/m);
  assert.equal(verdict(markdown), `**Passes as counted.** No case's instructions a request rise by more than +0.5% of base's, no case's allocations rise, idle memory does not rise, and both builds gave every case its answer. ${readCounted}`);
  assert.ok(markdown.split("\n").includes(`Both builds give the same answer, byte for byte with its \`Date\` and \`ETag\` masked, in all ${CASES} cases.`), markdown);
  // Each count, the longest window's seconds and the most the other threads ran in a window.
  assert.ok(markdown.includes("| `get` | 20,000 | 20,100 | +100 | +0.500% | 20000 20000 20001 (0.9 s; others 243 in 1) | 20100 20100 20101 (0.9 s; others 243 in 1) |  |"), markdown);
  assert.ok(markdown.includes("| `post` | 20,001 | 19,000 | -1,001 | -5.005% | 20001 20001 20002 (0.9 s; others 243 in 1) | 19000 19001 19000 (0.9 s; others 243 in 1) |  |"), markdown);
  assert.ok(markdown.includes("| `get`, 16 at a time | 15,000 | 15,000 | 0 | 0.000% | 15000 15001 15000 "), markdown);
  assert.ok(markdown.includes("| `page-browser` | 16.00 | 16.00 | 0 in 1,000 | 0.00% | 16,000 and 16,000 frees | 16,000 and 16,000 frees |  |"), markdown);
  // Each run's growth in bytes, its rounded figure a connection after it, and what base allows.
  assert.ok(markdown.includes("| after one request | 42,106,880 | 42,106,880 | 0 | 0.00% | 8,192 | 42,102,784 (8,421) 42,110,976 (8,422) 42,106,880 (8,421) | 42,102,784 (8,421) 42,110,976 (8,422) 42,106,880 (8,421) |  |"), markdown);
  // A row a case and a row a reading, and no section for runs with no figure when all gave one.
  assert.equal(markdown.split("\n").filter((line) => line.startsWith("| `") || /^\| (after|before) /.test(line)).length, CASES + 4 + CASES + 3);
  // Each idle run is given whole, with its before, after, growth and page size, which decide.
  const record = markdown.split("\n").filter((line) => /^(base|head), .*, run [1-3]: /.test(line));
  assert.equal(record.length, 2 * 3 * 3, markdown);
  assert.ok(record.includes("base, after one request, run 2: 8422 bytes a connection (5000 that answered 1 pipeline, from 1 address; 7577600 before, 49688576 after, 42110976 grown, in 4096-byte pages)"), record.join("\n"));
  assert.doesNotMatch(markdown, /no figure|over the budget|rose|not decided/);
});

test("one case over the budget does not pass as counted, and the verdict names it and the measured way", (t) => {
  const { base, head } = builds(t, (_, build) => {
    build.count.unstaged = [20_104, 20_104, 20_105];
  });
  const { markdown, status, holds } = compare(base, head, { description: counting });
  assert.deepEqual([status, holds], [1, false]);
  assert.equal(verdict(markdown), `**Does not pass as counted:** \`unstaged\` runs 101 more instructions a request than base's 20,003, over the budget of 100 (+0.5%). ${readCounted} By CONTRIBUTING.md (Pull requests, item 2.1) the change is then measured: the description says \`Request path: measured\`, gives what the measured way asks, and keeps these counts.`);
  assert.equal(markdown.match(/\| over the budget \|/g)?.length, 1);
  // At a depth of 16 a case is held to the budget as well.
  const deep = builds(t, (_, build) => {
    build.deep.text = [9_548, 9_548, 9_548];
  });
  const at16 = compare(deep.base, deep.head, { description: counting });
  assert.equal(at16.status, 1);
  assert.match(at16.markdown, /`text`, 16 at a time runs 48 more instructions a request than base's 9,500, over the budget of 47 \(\+0\.5%\)\. Read from the description: `Request path: counted`, at line 1\. By /);
});

test("an allocation more does not pass, however few they are among the requests and however the instructions read", (t) => {
  // Four more in a thousand requests: 16.00 a request on both builds, to two places.
  const { base, head } = builds(t, (_, build) => {
    build.allocations.post = [16_004, 16_000];
    build.count.post = [19_000, 19_000, 19_000];
  });
  const { markdown, status } = compare(base, head, { description: counting });
  assert.equal(status, 1);
  assert.match(verdict(markdown), /^\*\*Does not pass as counted:\*\* `post` makes 4 more allocations in 1,000 requests \(16,000 to 16,004\)\. /);
  assert.ok(markdown.includes("| `post` | 16.00 | 16.00 | +4 in 1,000 | +0.03% | 16,000 and 16,000 frees | 16,004 and 16,000 frees | rose |"), markdown);
  // Frees alone are not the rule's, and fewer allocations pass.
  const other = builds(t, (_, build) => {
    build.allocations.text = [16_000, 18_000];
    build.allocations.get = [15_999, 15_999];
  });
  assert.equal(compare(other.base, other.head, { description: counting }).status, 0);
});

test("idle memory is decided by growths in bytes: one page over base's agreeing three passes, two pages fail, and more than base's span fails", (t) => {
  // Base's three agree, 15,335 pages, 62,812,160 bytes over 5,000 connections (12,562 a
  // connection), and head's are one page more (62,816,256, 12,563): the rounded figures rise
  // by one, and a page is allowed.
  const agreeing = (/** @type {ReturnType<typeof figures>} */ build, /** @type {number} */ pages) => (build.idle.browser = [pages, pages, pages]);
  const one = builds(t, (base, head) => [agreeing(base, 15_335), agreeing(head, 15_336)]);
  const page = compare(one.base, one.head, { description: counting });
  assert.deepEqual([page.status, page.holds], [0, true], page.markdown);
  assert.match(verdict(page.markdown), /^\*\*Passes as counted\.\*\*/);
  assert.ok(page.markdown.includes("| after three of a browser's requests | 62,812,160 | 62,816,256 | +4,096 | +0.01% | 4,096 | 62,812,160 (12,562) 62,812,160 (12,562) 62,812,160 (12,562) | 62,816,256 (12,563) 62,816,256 (12,563) 62,816,256 (12,563) |  |"), page.markdown);
  // Two pages more, whose figures also round to one byte a connection more (12,562 to 12,563),
  // is a rise.
  const two = builds(t, (base, head) => [agreeing(base, 15_334), agreeing(head, 15_336)]);
  const pages = compare(two.base, two.head, { description: counting });
  assert.deepEqual([pages.status, pages.holds], [1, false]);
  assert.match(verdict(pages.markdown), /^\*\*Does not pass as counted:\*\* idle memory after three of a browser's requests rises: the median of head's growths, 62,816,256 bytes over 5,000 connections, is above base's 62,808,064 by 8,192, more than the 4,096 allowed \(the larger of base's span and a 4,096-byte page\)\. /);
  assert.ok(pages.markdown.includes("| after three of a browser's requests | 62,808,064 | 62,816,256 | +8,192 | +0.01% | 4,096 | 62,808,064 (12,562) 62,808,064 (12,562) 62,808,064 (12,562) | 62,816,256 (12,563) 62,816,256 (12,563) 62,816,256 (12,563) | rose |"), pages.markdown);
  // Base's runs after one request span 2 pages (8,192 bytes) about a median of 10,280 pages:
  // head's median 3 pages above is a rise, 2 above is not, whatever head's highest run.
  const more = builds(t, (_, build) => {
    build.idle.request = [10_283, 10_290, 10_270];
  });
  const rises = compare(more.base, more.head, { description: counting });
  assert.equal(rises.status, 1);
  assert.match(verdict(rises.markdown), /^\*\*Does not pass as counted:\*\* idle memory after one request rises: the median of head's growths, 42,119,168 bytes over 5,000 connections, is above base's 42,106,880 by 12,288, more than the 8,192 allowed \(the larger of base's span and a 4,096-byte page\)\. /);
  const less = builds(t, (_, build) => {
    build.idle.request = [10_282, 10_400, 10_270];
    build.idle.silent = [2_000, 2_000, 2_000];
  });
  const stays = compare(less.base, less.head, { description: counting });
  assert.equal(stays.status, 0, stays.markdown);
  assert.ok(stays.markdown.includes("| after one request | 42,106,880 | 42,115,072 | +8,192 | +0.02% | 8,192 | "), stays.markdown);
});

test("an idle reading over fewer connections than its page has bytes, or of two page sizes, is not decided and never passes", (t) => {
  // 65,536-byte pages over the hosted job's 5,000 connections: one page is 13 bytes a
  // connection, a step the gate does not let pass unseen, so no reading is decided.
  const large = builds(t, (base, head) => {
    base.page = 65_536;
    head.page = 65_536;
  });
  for (const description of [counting, "", measuring]) {
    const { markdown, status, holds } = compare(large.base, large.head, { description });
    assert.deepEqual([status, holds], [description === measuring ? 0 : 1, false], description);
    assert.doesNotMatch(verdict(markdown), /Passes|Would pass|would pass\./, description);
    for (const what of ["after one request", "after three of a browser's requests", "before any byte"]) {
      assert.ok(verdict(markdown).includes(`idle memory ${what} is not decided (\`not a gate reading: one 65536-byte page over 5000 connections is more than a byte a connection; open at least 65536\`)`), `${what}\n${markdown}`);
    }
    assert.equal(markdown.match(/\| not decided \|$/gm)?.length, 3, markdown);
  }
  // Base read in 4,096-byte pages and head in 65,536-byte ones: two page sizes are not one reading.
  const mixed = builds(t, (_, head) => {
    head.page = 65_536;
    head.idle.request = [643, 643, 643];
  });
  const both = compare(mixed.base, mixed.head, { description: counting });
  assert.equal(both.status, 1);
  assert.ok(verdict(both.markdown).includes("idle memory after one request is not decided (`its runs read pages of 4,096 and 65,536 bytes, and the rule compares runs of one page size`)"), both.markdown);
});

test("an idle run printed without its page size and growth is no figure: its growth is not guessed from its rounded figure", (t) => {
  // Head's runs are base's, which would pass, written as idle.mjs printed them before the page
  // size and the growth: bytes, before and after alone.
  const { base, head } = builds(t);
  for (let run = 1; run <= RUNS; run += 1) {
    const file = `idle-request-${run}.json`;
    const { grown, page, ...old } = JSON.parse(printed(file, /** @type {number} */ (figures().idle.request[run - 1])));
    writeFileSync(join(head, file), JSON.stringify(old) + "\n");
  }
  const why = "(`the run gives no page size or growth, as idle.mjs printed before them, and its growth is not guessed from its figure`)";
  for (const description of [counting, ""]) {
    const { markdown, status, holds } = compare(base, head, { description });
    assert.deepEqual([status, holds], [1, false], description);
    assert.ok(verdict(markdown).includes(`idle memory after one request, run 1, has no figure on head ${why}`), markdown);
    assert.ok(markdown.includes("| after one request | 42,106,880 | none |  |  |  | 42,102,784 (8,421) 42,110,976 (8,422) 42,106,880 (8,421) | none none none | no figure |"), markdown);
  }
});

test("a run with no figure on one build cannot be counted, and why each attempt gave none is given", (t) => {
  const refusal = "Error: not a count: 1 other threads ran 50000 instructions in a window of 0.9 s, where the clock's ticks explain 600 at most; the first thread ran 18987000, and a count reads it alone\n";
  const { base, head } = builds(t, (_, build) => {
    build.count.get = null;
    build.idle.browser = [11_108, null, 11_109];
  });
  // Refused and, taken again, not ended in its time; and a run that stopped with no error of the kit's.
  writeFileSync(join(head, "count-get.json.refused"), `${refusal}Error: did not end in 120 s\n`);
  writeFileSync(join(head, "idle-browser-2.json.refused"), "Killed\nnot attempted, the job's time for readings was spent\n");
  const { markdown, status, holds } = compare(base, head, { description: counting });
  assert.deepEqual([status, holds], [1, false]);
  assert.ok(verdict(markdown).startsWith(`**Does not pass as counted:** \`get\`'s instructions has no figure on head (\`did not end in 120 s\`); idle memory after three of a browser's requests, run 2, has no figure on head (\`not attempted, the job's time for readings was spent\`). ${readCounted} By CONTRIBUTING.md (Pull requests, item 2.1) the change is then measured`), markdown);
  assert.ok(markdown.includes("| `get` | 20,000 | none |  |  | 20000 20000 20001 (0.9 s; others 243 in 1) | none | no figure |"), markdown);
  // No median of two runs: the rule's is of three.
  assert.ok(markdown.includes("| after three of a browser's requests | 45,498,368 | none |  |  |  | 45,498,368 (9,100) 45,498,368 (9,100) 45,502,464 (9,100) | 45,498,368 (9,100) none 45,502,464 (9,100) | no figure |"), markdown);
  assert.ok(markdown.includes(`### Runs that gave no figure\n\n- \`count-get.json\` on head: \`${refusal.trim().slice(7)}\`\n- \`count-get.json\` on head: \`did not end in 120 s\`\n- \`idle-browser-2.json\` on head: \`Killed\`\n- \`idle-browser-2.json\` on head: \`not attempted, the job's time for readings was spent\`\n`), markdown);
});

test("a run refused once and counted when taken again is counted, and the refusal is still given", (t) => {
  const { base, head } = builds(t);
  writeFileSync(join(base, "idle-silent-2.json.refused"), "Error: not a measurement: the probe had closed 3 of the 5000 connections (they took 31.0 s to open)\n");
  const { markdown, status } = compare(base, head, { description: counting });
  assert.equal(status, 0);
  assert.match(markdown, /^\*\*Passes as counted\.\*\*/m);
  assert.ok(markdown.includes("### Runs that gave no figure\n\n- `idle-silent-2.json` on base: `not a measurement: the probe had closed 3 of the 5000 connections (they took 31.0 s to open)` (taken again, and counted)\n"), markdown);
});

test("output that is not the whole of the run its file is named for is no figure, on either build, and never a pass", (t) => {
  const whole = builds(t);
  const cut = (/** @type {string} */ side, /** @type {string} */ file, /** @type {(text: string) => string} */ change) => writeFileSync(join(side, file), change(printed(file, file.startsWith("idle") ? 10_280 : file.startsWith("allocations") ? [16_000, 16_000] : [20_000, 20_000, 20_001])));
  // Cut after its first count on base, after its frees' name on head, and before its last brace.
  cut(whole.base, "count-get.json", (text) => text.slice(0, text.indexOf(",20000")));
  cut(whole.head, "allocations-text.json", (text) => text.slice(0, text.indexOf("frees") + 7));
  cut(whole.head, "idle-request-2.json", (text) => text.trimEnd().slice(0, -1));
  // Whole, and of another run: 40 connections, and the silent reading where a request was asked.
  cut(whole.base, "idle-request-1.json", (text) => text.replace('"connections":5000', '"connections":40'));
  cut(whole.head, "idle-request-3.json", (text) => text.replace('"requests":1', '"requests":0'));
  // The sentence the kit prints for people, which reads as a figure and is not the JSON.
  writeFileSync(join(whole.base, "count-16-pipeline.json"), "pipeline            9000      9000      9000      0.9       243 in 1  9000 9000 9000\n");
  for (const description of [counting, "", measuring]) {
    const { markdown, status, holds } = compare(whole.base, whole.head, { description });
    assert.deepEqual([status, holds], [description === measuring ? 0 : 1, false], description);
    assert.doesNotMatch(verdict(markdown), /Passes|Would pass|would pass\./);
    const not = "(`the run's output is not the whole of the run asked for`)";
    for (const clause of [`\`get\`'s instructions has no figure on base ${not}`, `\`pipeline\`, 16 at a time's instructions has no figure on base ${not}`, `\`text\`'s allocations has no figure on head ${not}`, `idle memory after one request, run 1, has no figure on base ${not}`, `run 2, has no figure on head ${not}`, `run 3, has no figure on head ${not}`]) assert.ok(verdict(markdown).includes(clause), `${clause}\n${markdown}`);
    assert.ok(markdown.includes("| after one request | none | none |  |  |  | none 42,110,976 (8,422) 42,106,880 (8,421) | 42,102,784 (8,421) none none | no figure |"), markdown);
  }
  // A run that left nothing on both builds.
  const { base, head } = builds(t, (build, other) => {
    build.allocations.text = null;
    other.allocations.text = null;
  });
  const none = compare(base, head, { description: counting });
  assert.equal(none.status, 1);
  assert.ok(verdict(none.markdown).includes(`\`text\`'s allocations has no figure on base and head (\`the run left no output\`). ${readCounted} By`), none.markdown);
  assert.ok(none.markdown.includes("| `text` | none | none |  |  | none | none | no figure |"), none.markdown);
});

test("a probe that did not build is said once: against base it leaves the change uncounted, against head it fails the job", (t) => {
  const { base, head } = builds(t);
  const empty = mkdtempSync(join(tmpdir(), "request-cost-compare-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  writeFileSync(join(empty, "unbuilt"), "   Compiling probe v0.0.0\nerror[E0599]: no method named `kept_answers` found for struct `App`\nerror: could not compile `probe` (bin \"probe\") due to 1 previous error\n");
  const said = "the probe did not build against base (`error: could not compile 'probe' (bin \"probe\") due to 1 previous error`)";
  const counted = compare(empty, head, { description: counting });
  assert.equal(counted.status, 1);
  assert.equal(verdict(counted.markdown), `**Does not pass as counted:** ${said}. ${readCounted} By CONTRIBUTING.md (Pull requests, item 2.1) the change is then measured: the description says \`Request path: measured\`, gives what the measured way asks, and keeps these counts.`);
  assert.equal(counted.markdown.match(/\| no figure \|$/gm)?.length, CASES + 4 + CASES + 3);
  assert.match(counted.markdown, /^No answer to compare in `get`, `post`, `post-absolute`, `unstaged`, `pipeline`, `text`, `page`, `get-browser`, `text-browser`, `page-browser`, `get-any`, `unstaged-any`, `get-any-last`, `unstaged-any-last`, `unstaged-any-name`, `unstaged-any-long`, `unstaged-any-encoded`, `unstaged-any-short`, `unstaged-subdomain`\.$/m);
  const measured = compare(empty, head, { description: measuring });
  assert.deepEqual([measured.status, measured.holds], [0, false]);
  assert.equal(verdict(measured.markdown), `**Declared measured: these counts are reported and decide nothing.** As counted they would not pass: ${said}. ${readMeasured}`);
  // Against head the job fails though the change is declared measured; what the built base lacks is still said.
  rmSync(join(base, "count-get.json"));
  const broken = compare(base, empty, { description: measuring });
  assert.equal(broken.status, 1);
  assert.equal(verdict(broken.markdown), `**Declared measured: these counts are reported and decide nothing.** As counted they would not pass: ${said.replace("base", "head")}; \`get\`'s instructions has no figure on base (\`the run left no output\`). ${readMeasured} The job fails whatever the description says: the probe is the kit's, and a change it no longer builds against changes it in the same pull request.`);
  // A build with nothing in its directory and no word of why lacks every figure and every answer.
  rmSync(join(empty, "unbuilt"));
  assert.equal(verdict(compare(base, empty, { description: counting }).markdown).match(/ has no (figure|answer) on (base and )?head /g)?.length, CASES + 4 + CASES + 3 * RUNS + CASES);
  // The file being there is the failure: empty, and beside every figure and answer of a build
  // that ran all the same, it leaves that build none.
  const whole = builds(t);
  writeFileSync(join(whole.base, "unbuilt"), "");
  const marked = compare(whole.base, whole.head, { description: counting });
  assert.equal(marked.status, 1);
  assert.ok(verdict(marked.markdown).startsWith(`**Does not pass as counted:** the probe did not build against base (\`the build left no word of why\`). ${readCounted} By `), marked.markdown);
  assert.equal(marked.markdown.match(/\| no figure \|$/gm)?.length, CASES + 4 + CASES + 3);
  assert.doesNotMatch(marked.markdown, /^\| `get` \| 20,000 /m);
  writeFileSync(join(whole.head, "unbuilt"), "");
  assert.equal(compare(whole.base, whole.head, { description: measuring }).status, 1);
});

test("a change declared measured is reported and never failed on its figures", (t) => {
  const { base, head } = builds(t, (_, build) => {
    build.count.page = [30_000, 30_000, 30_000];
    build.allocations.page = [20_000, 20_000];
    build.idle.silent = [11_000, 11_000, 11_000];
  });
  const { markdown, status, holds } = compare(base, head, { description: measuring });
  assert.deepEqual([status, holds], [0, false]);
  assert.equal(verdict(markdown), `**Declared measured: these counts are reported and decide nothing.** As counted they would not pass: \`page\` runs 9,994 more instructions a request than base's 20,006, over the budget of 100 (+0.5%); \`page\` makes 4,000 more allocations in 1,000 requests (16,000 to 20,000); idle memory before any byte rises: the median of head's growths, 45,056,000 bytes over 5,000 connections, is above base's 13,209,600 by 31,846,400, more than the 12,288 allowed (the larger of base's span and a 4,096-byte page). ${readMeasured}`);
  const inside = builds(t);
  assert.equal(verdict(compare(inside.base, inside.head, { description: measuring }).markdown), `**Declared measured: these counts are reported and decide nothing.** As counted they would pass. ${readMeasured}`);
  // The one line is the declaration where it stands, an example's fence as well: the verdict says where it was read.
  const fenced = compare(base, head, { description: "What changed.\n\n```\nRequest path: measured\n```\n" });
  assert.equal(fenced.status, 0);
  assert.ok(verdict(fenced.markdown).endsWith(" Read from the description: `Request path: measured`, at line 4."), fenced.markdown);
});

test("a description that declares no way fails only when the rule does not hold, and is told what was read and the line to add", (t) => {
  const inside = builds(t);
  const one = "exactly one line of its own in the description";
  // The line inside a sentence is no declaration line.
  const passes = compare(inside.base, inside.head, { description: "What changed and why. The job reads `Request path: counted` from a line of its own.\n" });
  assert.equal(passes.status, 0);
  assert.equal(verdict(passes.markdown), `**Would pass as counted.** Read from the description: no declaration line. Say the way on ${one}, \`Request path: counted\` or \`Request path: measured\` (CONTRIBUTING.md (Pull requests, item 2.1)).`);
  const high = builds(t, (_, build) => {
    build.count.get = [21_000, 21_000, 21_000];
  });
  // No description at all has no line; one that says the line and quotes it whole in an example
  // has two, and so has one that says both ways.
  const none = "no declaration line.";
  const two = (/** @type {number[]} */ ...at) => `2 declaration lines, at lines ${at.join(", ")}: a description holds one, so this one declares nothing.`;
  for (const [description, read] of /** @type {[string | undefined, string][]} */ ([
    [undefined, none],
    ["", none],
    ["Request path: measured\n\nThe line is written so:\n\n```\nRequest path: measured\n```\n", two(1, 6)],
    ["Request path: counted\nRequest path: measured\n", two(1, 2)],
  ])) {
    const fails = compare(high.base, high.head, { description });
    assert.equal(fails.status, 1);
    assert.equal(verdict(fails.markdown), `**Does not pass as counted:** \`get\` runs 1,000 more instructions a request than base's 20,000, over the budget of 100 (+0.5%). Read from the description: ${read} By CONTRIBUTING.md (Pull requests, item 2.1) such a change is measured: say \`Request path: measured\` on ${one}, and give what the measured way asks.`);
  }
});

test("builds that answer differently are said to and fail nothing; a case either build gave no whole answer to is not a pass", (t) => {
  const differ = builds(t);
  writeFileSync(join(differ.head, "answers", "post.http"), Buffer.from(answer("post").latin1Slice().replace("date: -", "date: -\r\nvary: accept"), "latin1"));
  const said = compare(differ.base, differ.head, { description: counting });
  assert.equal(said.status, 0);
  assert.match(said.markdown, /^\*\*Passes as counted\.\*\*.*\n\nThe two builds answer differently in `post`: a count of two builds that answer differently compares two different jobs, which the review weighs\.$/m);
  // No capture, an empty one on both builds (which are the same bytes), one cut short, and another case's.
  const { base, head } = builds(t);
  rmSync(join(base, "answers", "page.http"));
  for (const side of [base, head]) writeFileSync(join(side, "answers", "text.http"), "");
  writeFileSync(join(head, "answers", "page-browser.http"), answer("page-browser").subarray(0, -9));
  writeFileSync(join(head, "answers", "post.http"), answer("pipeline"));
  // A head that says two bytes follow, and the one of them the case's body is; and a whole
  // answer with more after it.
  writeFileSync(join(base, "answers", "get.http"), "HTTP/1.1 200 OK\r\nContent-Length: 2\r\ndate: -\r\n\r\n3");
  writeFileSync(join(base, "answers", "pipeline.http"), Buffer.concat([answer("pipeline"), answer("pipeline")]));
  const not = "(`not one whole answer and no more`)";
  for (const description of [counting, "", measuring]) {
    const { markdown, status, holds } = compare(base, head, { description });
    assert.deepEqual([status, holds], [description === measuring ? 0 : 1, false], description);
    for (const clause of ["`post` has no answer on head (`not the body of post: \"ok\"`)", "`text` has no answer on base and head (`no capture`)", "`page` has no answer on base (`no capture`)", `\`page-browser\` has no answer on head ${not}`, `\`get\` has no answer on base ${not}`, `\`pipeline\` has no answer on base ${not}`]) assert.ok(verdict(markdown).includes(clause), `${clause}\n${markdown}`);
    assert.match(markdown, /^No answer to compare in `get`, `post`, `pipeline`, `text`, `page`, `page-browser`\.$/m);
  }
});

test("compare.mjs prints the table and exits by the verdict, and refuses arguments that are not two directories", (t) => {
  const { base, head } = builds(t, (_, build) => {
    build.count.text = [25_000, 25_000, 25_000];
  });
  const description = join(dirname(base), "description.md");
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [join(kit, "compare.mjs"), ...args], { encoding: "utf8" });
  const written = `What changed.\r\n\r\n${counting}`;
  writeFileSync(description, written);
  const failed = run(base, head, "--description", description, "--base", "c9666dc96", "--head", "the change");
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, compare(base, head, { description: written, names: { base: "c9666dc96", head: "the change" } }).markdown);
  assert.match(failed.stdout, /^## What a request costs: `the change` against `c9666dc96`\n\n\*\*Does not pass as counted:\*\* `text` runs .* Read from the description: `Request path: counted`, at line 3\. By /);
  writeFileSync(description, measuring);
  assert.equal(run(base, head, "--description", description).status, 0);
  assert.equal(run(base, base, "--description", description).status, 0);
  // With no description, the change declares nothing.
  assert.equal(run(base, head).status, 1);
  assert.equal(run(base, base).status, 0);
  for (const args of [[], [base], [base, head, head], [base, head, "--readings"], [base, head, "--budget", "1"]]) {
    const refused = run(...args);
    assert.equal(refused.status, 2, args.join(" "));
    assert.match(refused.stderr, /usage: node compare\.mjs --readings \| node compare\.mjs <base's directory> <head's directory>/);
    assert.equal(refused.stdout, "");
  }
});
