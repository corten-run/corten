// node --test bench/request-cost/compare.test.mjs
// The comparison against two builds' directories written here as the kit's scripts print: what
// passes, what does not, what a declaration changes, and what is said of a run with no figure.
// Nothing is counted, so these run anywhere; run.test.mjs holds what the kit really prints
// against the readers here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RUNS, allocated, compare, counted, declared, idled, over, readings, rose } from "./compare.mjs";
import { median } from "./figures.mjs";
import { cases } from "./requests.mjs";

const kit = dirname(fileURLToPath(import.meta.url));
const names = Object.keys(cases);

/** A build's figures: three counts a case, allocations and frees a case, three runs an idle reading. */
const figures = () => ({
  count: Object.fromEntries(names.map((name, at) => [name, [20_000 + at, 20_000 + at, 20_001 + at]])),
  deep: { pipeline: [9_000, 9_000, 9_000], get: [15_000, 15_001, 15_000], unstaged: [10_000, 10_000, 10_000], text: [9_500, 9_500, 9_500] },
  allocations: Object.fromEntries(names.map((name) => [name, [16, 16]])),
  idle: { request: [8_419, 8_423, 8_421], browser: [9_100, 9_100, 9_104], silent: [2_641, 2_645, 2_643] },
});

/** What `count.mjs` prints for a case's counts. @param {string} name @param {number[]} counts */
const row = (name, counts) =>
  "case".padEnd(14) + ["median", "least", "most"].map((n) => n.padStart(10)).join("") + "seconds".padStart(9) + "other threads".padStart(15) + "  counts\n" +
  name.padEnd(14) + [median(counts), Math.min(...counts), Math.max(...counts)].map((n) => String(n).padStart(10)).join("") + "0.9".padStart(9) + "243 in 1".padStart(15) + "  " + counts.join(" ") + "\n";

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
    for (const name of names) writeFileSync(join(at, "answers", `${name}.http`), `HTTP/1.1 200 OK\r\ndate: -\r\n\r\n${name}`);
    for (const [name, counts] of Object.entries(build.count)) if (counts) writeFileSync(join(at, `count-${name}.txt`), row(name, counts));
    for (const [name, counts] of Object.entries(build.deep)) if (counts) writeFileSync(join(at, `count-16-${name}.txt`), row(name, counts));
    for (const [name, calls] of Object.entries(build.allocations)) {
      if (calls) writeFileSync(join(at, `allocations-${name}.txt`), `${"case".padEnd(14)}${"allocations".padStart(12)}${"frees".padStart(10)}  calls\n${name.padEnd(14)}${calls[0].toFixed(2).padStart(12)}${calls[1].toFixed(2).padStart(10)}  free=${calls[1].toFixed(2)} malloc=${calls[0].toFixed(2)}\n`);
    }
    for (const [name, runs] of Object.entries(build.idle)) {
      runs.forEach((bytes, run) => {
        if (bytes !== null) writeFileSync(join(at, `idle-${name}-${run + 1}.txt`), `${bytes} bytes a connection (5000 that answered 1 pipeline, opened in 0.6 s; 7577600 before, 49692672 after)\n`);
      });
    }
  }
  return { base: join(directory, "base"), head: join(directory, "head") };
}

const counting = "Request path: counted\n";
const measuring = "Request path: measured\n";

test("the runs to take are every case's instructions, four at a depth of 16, every case's allocations and three idle readings three times", () => {
  const all = readings();
  assert.equal(all.length, 9 + 4 + 9 + 3 * RUNS);
  assert.equal(RUNS, 3);
  assert.deepEqual(all[0], { file: "count-get.txt", script: "count.mjs", options: ["--cases", "get"] });
  assert.deepEqual(all.filter(({ options }) => options.includes("--depth")).map(({ file, options }) => [file, options.join(" ")]), [
    ["count-16-pipeline.txt", "--depth 16 --cases pipeline"],
    ["count-16-get.txt", "--depth 16 --cases get"],
    ["count-16-unstaged.txt", "--depth 16 --cases unstaged"],
    ["count-16-text.txt", "--depth 16 --cases text"],
  ]);
  assert.deepEqual(all.filter(({ options }) => options.includes("--allocations")).map(({ options }) => options.at(-1)), names);
  // An idle reading's three runs are not one after another: the other readings are between them.
  assert.deepEqual(all.filter(({ script }) => script === "idle.mjs").map(({ file, options }) => `${file} ${options.join(" ")}`.trim()), [1, 2, 3].flatMap((run) => [`idle-request-${run}.txt`, `idle-browser-${run}.txt --case get-browser --requests 3`, `idle-silent-${run}.txt --silent`]));
  // No two runs write one file, and none names the probe, its CPU or its port: the caller's.
  assert.equal(new Set(all.map(({ file }) => file)).size, all.length);
  assert.ok(all.every(({ options }) => !options.some((option) => option === "--cpu" || option === "--port")));
  const printed = spawnSync(process.execPath, [join(kit, "compare.mjs"), "--readings"], { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(printed.stdout.trimEnd().split("\n"), all.map(({ file, script, options }) => [file, script, ...options].join(" ")));
});

test("a row is read as count.mjs prints it, an idle figure as idle.mjs does, and anything else is no figure", () => {
  assert.deepEqual(counted(row("get", [18_987, 18_990, 18_986]), "get"), { median: 18_987, counts: [18_987, 18_990, 18_986], seconds: "0.9" });
  assert.equal(counted(row("get-browser", [1, 2, 3]), "get"), null);
  assert.equal(counted("get 18987\n", "get"), null);
  assert.deepEqual(allocated("case           allocations     frees  calls\nget                  16.00     15.50  free=15.50 malloc=16.00\n", "get"), { allocations: 16, frees: 15.5 });
  assert.equal(allocated(row("get", [16, 16, 16]), "get"), null);
  assert.equal(idled("8423 bytes a connection (5000 that answered 1 pipeline, opened in 0.6 s; 7577600 before, 49692672 after)\n"), 8423);
  assert.equal(idled("-12 bytes a connection (40 that sent nothing, opened in 0.0 s; 10 before, 5 after)\n"), -12);
  assert.equal(idled("bytes a connection\n"), null);
});

test("the way is declared by a line of its own, and by nothing else", () => {
  assert.equal(declared("What changed.\n\n## Measurements\n\nRequest path: counted\n\nThe counts.\n"), "counted");
  assert.equal(declared("Request path: measured"), "measured");
  // As a browser's form sends a description, and with spaces left at the line's end.
  assert.equal(declared("What changed.\r\nRequest path: measured\r\n\r\n## Checks\r\n"), "measured");
  assert.equal(declared("Request path: counted  \n"), "counted");
  assert.equal(declared(""), null);
  // The template's own sentence, a line that says more, and one that is quoted or listed.
  assert.equal(declared("own: `Request path: counted` or `Request path: measured`.\n"), null);
  assert.equal(declared("Request path: counted, as the job says\n> Request path: counted\n- Request path: measured\n"), null);
  assert.equal(declared("request path: counted\nRequest path: Counted\nRequest path: neither\n"), null);
  assert.equal(declared("Request path: counted\nRequest path: counted\n"), "counted");
  assert.equal(declared("Request path: counted\n\nRequest path: measured\n"), "both");
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

test("idle memory rises only when head's median is above base's by more than base's three span", () => {
  // Base spans 4, and its median is 8,421.
  assert.equal(rose([8_419, 8_423, 8_421], [8_425, 8_425, 8_425]), false);
  assert.equal(rose([8_419, 8_423, 8_421], [8_426, 8_426, 8_426]), true);
  // The median, not the highest run; and a base that does not vary allows no rise at all.
  assert.equal(rose([8_419, 8_423, 8_421], [8_400, 8_425, 9_000]), false);
  assert.equal(rose([8_421, 8_421, 8_421], [8_421, 8_422, 8_422]), true);
  assert.equal(rose([8_421, 8_421, 8_421], [8_421, 8_421, 8_500]), false);
  assert.equal(rose([8_419, 8_423, 8_421], [8_000, 8_000, 8_000]), false);
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
  assert.match(markdown, /^\*\*Passes as counted\.\*\* No case's instructions a request rise by more than \+0\.5% of base's, no case's allocations a request rise, and idle memory does not rise\.$/m);
  assert.match(markdown, /^Both builds give the same answer, byte for byte with its `Date` and `ETag` masked, in all 9 cases\.$/m);
  assert.ok(markdown.includes("| `get` | 20,000 | 20,100 | +100 | +0.500% | 20000 20000 20001 (0.9 s) | 20100 20100 20101 (0.9 s) |  |"), markdown);
  assert.ok(markdown.includes("| `post` | 20,001 | 19,000 | -1,001 | -5.005% | 20001 20001 20002 (0.9 s) | 19000 19001 19000 (0.9 s) |  |"), markdown);
  assert.ok(markdown.includes("| `get`, 16 at a time | 15,000 | 15,000 | 0 | 0.000% | 15000 15001 15000 (0.9 s) | 15000 15001 15000 (0.9 s) |  |"), markdown);
  assert.ok(markdown.includes("| `page-browser` | 16.00 | 16.00 | 0.00 | 0.00% | 16.00 | 16.00 |  |"), markdown);
  assert.ok(markdown.includes("| after one request | 8,421 | 8,421 | 0 | 0.00% | 4 | 8,419 8,423 8,421 | 8,419 8,423 8,421 |  |"), markdown);
  assert.ok(markdown.includes("| before any byte | 2,643 | 2,643 | 0 | 0.00% | 4 | 2,641 2,645 2,643 | 2,641 2,645 2,643 |  |"), markdown);
  // A row a case and a row a reading, and no section for refusals when there were none.
  assert.equal(markdown.split("\n").filter((line) => line.startsWith("| `") || /^\| (after|before) /.test(line)).length, 9 + 4 + 9 + 3);
  assert.doesNotMatch(markdown, /refused|no figure|over the budget|rose/);
});

test("one case over the budget does not pass as counted, and the verdict names it and the measured way", (t) => {
  const { base, head } = builds(t, (_, build) => {
    build.count.unstaged = [20_103, 20_103, 20_104];
  });
  const { markdown, status, holds } = compare(base, head, { description: counting });
  assert.deepEqual([status, holds], [1, false]);
  assert.match(markdown, /^\*\*Does not pass as counted:\*\* `unstaged` runs 101 more instructions a request than base's 20,002, over the budget of 100 \(\+0\.5%\)\. By CONTRIBUTING\.md \(Pull requests, item 2\.1\) the change is then measured: the description says `Request path: measured`, gives what the measured way asks, and keeps these counts\.$/m);
  assert.ok(markdown.includes("| `unstaged` | 20,002 | 20,103 | +101 | +0.505% | 20002 20002 20003 (0.9 s) | 20103 20103 20104 (0.9 s) | over the budget |"), markdown);
  assert.equal(markdown.match(/\| over the budget \|/g)?.length, 1);
  // At a depth of 16 a case is held to the budget as well.
  const deep = builds(t, (_, build) => {
    build.deep.text = [9_548, 9_548, 9_548];
  });
  const at16 = compare(deep.base, deep.head, { description: counting });
  assert.equal(at16.status, 1);
  assert.match(at16.markdown, /`text`, 16 at a time runs 48 more instructions a request than base's 9,500, over the budget of 47 \(\+0\.5%\)\. By /);
});

test("an allocation more a request does not pass, however the instructions read", (t) => {
  const { base, head } = builds(t, (_, build) => {
    build.allocations.post = [17, 17];
    build.count.post = [19_000, 19_000, 19_000];
  });
  const { markdown, status } = compare(base, head, { description: counting });
  assert.equal(status, 1);
  assert.match(markdown, /^\*\*Does not pass as counted:\*\* `post` allocates 1\.00 more a request \(16\.00 to 17\.00\)\. /m);
  assert.ok(markdown.includes("| `post` | 16.00 | 17.00 | +1.00 | +6.25% | 16.00 | 17.00 | rose |"), markdown);
  // The least the kit prints, and frees alone are not the rule's.
  const least = builds(t, (_, build) => {
    build.allocations.get = [16.01, 16];
    build.allocations.text = [16, 18];
  });
  const found = compare(least.base, least.head, { description: counting });
  assert.match(found.markdown, /`get` allocates 0\.01 more a request \(16\.00 to 16\.01\)\. /);
  assert.doesNotMatch(found.markdown, /`text` allocates/);
  const fewer = builds(t, (_, build) => {
    build.allocations.get = [15, 15];
  });
  assert.equal(compare(fewer.base, fewer.head, { description: counting }).status, 0);
});

test("idle memory above base's median by more than base's span does not pass, and by less does", (t) => {
  // Base's runs after one request span 4 about 8,421.
  const more = builds(t, (_, build) => {
    build.idle.request = [8_426, 8_430, 8_420];
  });
  const rises = compare(more.base, more.head, { description: counting });
  assert.equal(rises.status, 1);
  assert.match(rises.markdown, /^\*\*Does not pass as counted:\*\* idle memory after one request rises: head's median, 8,426 bytes a connection, is above base's 8,421 by more than base's span of 4\. /m);
  assert.ok(rises.markdown.includes("| after one request | 8,421 | 8,426 | +5 | +0.06% | 4 | 8,419 8,423 8,421 | 8,426 8,430 8,420 | rose |"), rises.markdown);
  const less = builds(t, (_, build) => {
    build.idle.request = [8_425, 8_500, 8_420];
    build.idle.silent = [2_000, 2_000, 2_000];
  });
  const stays = compare(less.base, less.head, { description: counting });
  assert.equal(stays.status, 0);
  assert.ok(stays.markdown.includes("| after one request | 8,421 | 8,425 | +4 | +0.05% | 4 | 8,419 8,423 8,421 | 8,425 8,500 8,420 |  |"), stays.markdown);
});

test("a case the kit refused on one build cannot be counted, and the kit's reason is given", (t) => {
  const refusal =
    "file:///kit/figures.mjs:50\n    throw new Error(\n          ^\n\nError: not a count: 1 other threads ran 50000 instructions in a window of 0.9 s, where the clock's ticks explain 600 at most; the first thread ran 18987000, and a count reads it alone\n    at alone (file:///kit/figures.mjs:50:11)\n\nNode.js v26.13.1\n";
  const { base, head } = builds(t, (_, build) => {
    build.count.get = null;
  });
  // Refused, taken again and refused again: the kit said so twice.
  writeFileSync(join(head, "count-get.txt.refused"), refusal + refusal);
  const { markdown, status, holds } = compare(base, head, { description: counting });
  assert.deepEqual([status, holds], [1, false]);
  const reason = "`not a count: 1 other threads ran 50000 instructions in a window of 0.9 s, where the clock's ticks explain 600 at most; the first thread ran 18987000, and a count reads it alone`";
  assert.ok(markdown.includes(`**Does not pass as counted:** \`get\`'s instructions has no figure on head (${reason}). By CONTRIBUTING.md (Pull requests, item 2.1) the change is then measured`), markdown);
  assert.ok(markdown.includes("| `get` | 20,000 | none |  |  | 20000 20000 20001 (0.9 s) | none | no figure |"), markdown);
  assert.ok(markdown.includes(`### Runs the kit refused\n\n- \`count-get.txt\` on head: ${reason}\n- \`count-get.txt\` on head: ${reason}\n`), markdown);
});

test("a run the kit refused once and counted when taken again is counted, and the refusal is still given", (t) => {
  const { base, head } = builds(t);
  writeFileSync(join(base, "idle-silent-2.txt.refused"), "Error: not a measurement: the probe had closed 3 of the 5000 connections (they took 31.0 s to open)\n    at held\n");
  writeFileSync(join(head, "allocations-page.txt.refused"), "Error: page: the profile holds 999 allocations for 1000 requests\n");
  const { markdown, status } = compare(base, head, { description: counting });
  assert.equal(status, 0);
  assert.match(markdown, /^\*\*Passes as counted\.\*\*/m);
  assert.ok(markdown.includes("### Runs the kit refused\n\n- `allocations-page.txt` on head: `page: the profile holds 999 allocations for 1000 requests` (taken again, and counted)\n- `idle-silent-2.txt` on base: `not a measurement: the probe had closed 3 of the 5000 connections (they took 31.0 s to open)` (taken again, and counted)\n"), markdown);
});

test("a missing figure cannot be counted: a run that left nothing, one of an idle reading's three, and output that is not the kit's", (t) => {
  const { base, head } = builds(t, (build, other) => {
    build.allocations.text = null;
    other.allocations.text = null;
    other.idle.browser = [9_100, null, 9_104];
  });
  writeFileSync(join(head, "count-16-pipeline.txt"), "pipeline 9000\n");
  // What a run said when it stopped with no error of the kit's is still its reason.
  writeFileSync(join(head, "idle-browser-2.txt.refused"), "Killed\n");
  const { markdown, status } = compare(base, head, { description: counting });
  assert.equal(status, 1);
  const verdict = /** @type {string} */ (markdown.split("\n").find((line) => line.startsWith("**")));
  assert.ok(verdict.includes("`pipeline`, 16 at a time's instructions has no figure on head (`the run's output is not what the kit prints`); `text`'s allocations has no figure on base and head (`the run left no output`); idle memory after three of a browser's requests, run 2, has no figure on head (`Killed`). By"), verdict);
  assert.ok(markdown.includes("| `pipeline`, 16 at a time | 9,000 | none |  |  | 9000 9000 9000 (0.9 s) | none | no figure |"), markdown);
  assert.ok(markdown.includes("| `text` | none | none |  |  | none | none | no figure |"), markdown);
  // No median of two runs: the rule's is of three.
  assert.ok(markdown.includes("| after three of a browser's requests | 9,100 | none |  |  |  | 9,100 9,100 9,104 | 9,100 none 9,104 | no figure |"), markdown);
  // A build with nothing counted at all, as one that did not build.
  const empty = mkdtempSync(join(tmpdir(), "request-cost-compare-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const none = compare(empty, head, { description: measuring });
  assert.deepEqual([none.status, none.holds], [0, false]);
  assert.equal(none.markdown.match(/\| no figure \|$/gm)?.length, 9 + 4 + 9 + 3);
  assert.match(none.markdown, /^No answer to compare in `get`, `post`, `unstaged`, `pipeline`, `text`, `page`, `get-browser`, `text-browser`, `page-browser`\.$/m);
});

test("a change declared measured is reported and never failed on its figures", (t) => {
  const { base, head } = builds(t, (_, build) => {
    build.count.page = [30_000, 30_000, 30_000];
    build.allocations.page = [20, 20];
    build.idle.silent = [9_000, 9_000, 9_000];
  });
  const { markdown, status, holds } = compare(base, head, { description: measuring });
  assert.deepEqual([status, holds], [0, false]);
  assert.match(markdown, /^\*\*Declared measured: these counts are reported and decide nothing\.\*\* As counted they would not pass: `page` runs 9,995 more instructions a request than base's 20,005, over the budget of 100 \(\+0\.5%\); `page` allocates 4\.00 more a request \(16\.00 to 20\.00\); idle memory before any byte rises: head's median, 9,000 bytes a connection, is above base's 2,643 by more than base's span of 4\.$/m);
  const inside = builds(t);
  assert.match(compare(inside.base, inside.head, { description: measuring }).markdown, /^\*\*Declared measured: these counts are reported and decide nothing\.\*\* As counted they would pass\.$/m);
});

test("a description that declares no way fails only when the rule does not hold, and is told the line to add", (t) => {
  const inside = builds(t);
  const passes = compare(inside.base, inside.head, { description: "What changed and why.\n" });
  assert.equal(passes.status, 0);
  assert.match(passes.markdown, /^\*\*Would pass as counted\.\*\* The description does not say which way decides the change\. Say it on a line of its own in the description, `Request path: counted` or `Request path: measured` \(CONTRIBUTING\.md \(Pull requests, item 2\.1\)\)\.$/m);
  const high = builds(t, (_, build) => {
    build.count.get = [21_000, 21_000, 21_000];
  });
  // No description at all is one that declares nothing.
  for (const description of [undefined, "", "Request path: counted\nRequest path: measured\n"]) {
    const fails = compare(high.base, high.head, { description });
    assert.equal(fails.status, 1);
    assert.match(fails.markdown, /^\*\*Does not pass as counted:\*\* `get` runs 1,000 more instructions a request than base's 20,000, over the budget of 100 \(\+0\.5%\)\. The description .*\. By CONTRIBUTING\.md \(Pull requests, item 2\.1\) such a change is measured: say `Request path: measured` on a line of its own in the description, and give what the measured way asks\.$/m);
  }
  assert.match(compare(high.base, high.head, { description: "Request path: counted\nRequest path: measured\n" }).markdown, /The description says both `Request path: counted` and `Request path: measured`, so it declares neither\./);
  assert.match(compare(high.base, high.head).markdown, /The description does not say which way decides the change\./);
});

test("builds that answer differently are said to, and the rule is read as it is", (t) => {
  const { base, head } = builds(t);
  writeFileSync(join(head, "answers", "post.http"), "HTTP/1.1 200 OK\r\ndate: -\r\nvary: accept\r\n\r\npost");
  rmSync(join(base, "answers", "page.http"));
  const { markdown, status } = compare(base, head, { description: counting });
  assert.equal(status, 0);
  assert.match(markdown, /^The two builds answer differently in `post`: a count of two builds that answer differently compares two different jobs, which the review weighs\. No answer to compare in `page`\.$/m);
});

test("compare.mjs prints the table and exits by the verdict, and refuses arguments that are not two directories", (t) => {
  const { base, head } = builds(t, (_, build) => {
    build.count.text = [25_000, 25_000, 25_000];
  });
  const description = join(dirname(base), "description.md");
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [join(kit, "compare.mjs"), ...args], { encoding: "utf8" });
  writeFileSync(description, `What changed.\r\n\r\n${counting}`);
  const failed = run(base, head, "--description", description, "--base", "c9666dc96", "--head", "the change");
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, compare(base, head, { description: counting, names: { base: "c9666dc96", head: "the change" } }).markdown);
  assert.match(failed.stdout, /^## What a request costs: `the change` against `c9666dc96`\n\n\*\*Does not pass as counted:\*\* `text` runs /);
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
