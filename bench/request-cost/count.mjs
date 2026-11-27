// Instructions and allocations a request costs the probe, counted by callgrind over a keep-alive
// HTTP/1.1 connection. Needs Linux with valgrind, taskset and libjemalloc.so.2 (README.md).
//
// Usage: node count.mjs <probe binary> [--cases get,post,...] [--depth 1] [--reps 3] [--cpu 0] [--port 8080]
//          instructions a request: each case's median, least and most of `reps` counts, how many
//          seconds the longest of their windows lasted, and the most that threads other than the
//          serving one ran in a window, as "<instructions> in <threads>"
//        node count.mjs <probe binary> --allocations [--cases ...] [--depth 1] [--cpu 0] [--port 8080]
//          allocations and frees a request
//        node count.mjs <probe binary> --answers <directory> [--cases ...] [--cpu 0] [--port 8080]
//          each case's answer as sent, its Date and ETag masked, to compare two builds' bytes
//        `--json` with either of the first two prints, in place of the table, a line of JSON a
//          case: what was measured, unrounded (each window's instructions, the allocator's calls
//          and the requests they are over), for compare.mjs to read
//        A case whose name ends in `-own` is sent with `App::own_http1` on (requests.mjs, `OWN`).
//
// A count is one run of the probe under callgrind: 240 requests on one connection, then the 1,000
// that are counted on the same connection, each written after the answer before it (or `--depth`
// at a time), with a callgrind dump before those 1,000 and one after. The count is what the
// probe's first thread, which serves, ran between the two dumps, over the requests (`counted` in
// probe.mjs). What other threads ran there is not in it: a run where they ran more than Corten's
// clock does, or where the first thread did not serve, is refused. The serving thread also does
// some work once a second whatever it serves, so a longer window counts a little more a request:
// the seconds are printed to compare (README.md, How a number is read).
// `--allocations` reads the calls into the allocator from the same kind of dump.
// A case with `App::own_http1` on, given a probe built without that switch (build.sh), is not
// run: its line says so (with `--json`, its JSON's `unsupported` holds the probe's word, and with
// `--answers` a file `<case>.unsupported` does), and the other cases are counted.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { allocatorCalls } from "./allocations.mjs";
import { COUNTED, WARM, each, median, sent } from "./figures.mjs";
import { Connection, WithoutOwnHttp1, counted, send, start } from "./probe.mjs";
import { cases, named } from "./requests.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cases: { type: "string", default: Object.keys(cases).join(",") },
    depth: { type: "string", default: "1" },
    reps: { type: "string" },
    cpu: { type: "string", default: "0" },
    port: { type: "string", default: "8080" },
    allocations: { type: "boolean", default: false },
    answers: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const [binary] = positionals;
if (!binary || positionals.length !== 1) throw new Error("usage: node count.mjs <probe binary> [--cases a,b] [--depth 1] [--reps 3] [--cpu 0] [--port 8080] [--allocations | --answers <directory>]");
const whole = (/** @type {string} */ name, /** @type {string} */ text) => {
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`--${name} takes a whole number above 0, not ${JSON.stringify(text)}`);
  return Number(text);
};
const names = named(values.cases);
const depth = whole("depth", values.depth);
// The 240 requests before the counted ones are written `depth` at a time too: above 240 none would be.
if (depth > WARM) throw new Error(`--depth takes at most ${WARM}`);
if (values.reps !== undefined && (values.allocations || values.answers !== undefined)) throw new Error("--reps is for instruction counts: --allocations and --answers read one run");
if (values.answers !== undefined && depth !== 1) throw new Error("--answers sends its requests one at a time: it takes no --depth");
if (values.answers !== undefined && values.json) throw new Error("--json is of a count: --answers writes files");
const reps = whole("reps", values.reps ?? "3");
const port = whole("port", values.port);
const cpu = values.cpu;
// The case's column: 14 wide, as it was before any case's name was longer, or the longest's and two.
const width = Math.max(14, ...names.map((name) => name.length + 2));

const scratch = mkdtempSync(join(tmpdir(), "request-cost-"));
try {
  if (values.answers !== undefined) await answers(values.answers);
  else if (values.allocations) await allocations();
  else await count();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function count() {
  const row = (/** @type {(string | number)[]} */ [name, middle, least, most, seconds, others, ...counts]) =>
    String(name).padEnd(width) + [middle, least, most].map((n) => String(n).padStart(10)).join("") + String(seconds).padStart(9) + String(others).padStart(15) + "  " + counts.join(" ");
  if (!values.json) console.log(row(["case", "median", "least", "most", "seconds", "other threads", "counts"]));
  for (const name of names) {
    const windows = [];
    try {
      for (let rep = 0; rep < reps; rep += 1) windows.push(await counted(binary, name, { cpu, port, depth, scratch }));
    } catch (error) {
      if (!(error instanceof WithoutOwnHttp1)) throw error;
      unsupported("instructions", name, error);
      continue;
    }
    const counts = windows.map((window) => Math.round(each(window.serving, depth)));
    // The longest window, and the most the other threads ran in one, with how many they were.
    const seconds = Math.max(...windows.map((window) => window.seconds)).toFixed(1);
    const most = windows.reduce((a, b) => (b.others > a.others ? b : a));
    const measured = { ...of("instructions", name), counts, median: median(counts), windows: windows.map(({ serving, seconds, others, threads }) => ({ instructions: serving, seconds, others, threads })) };
    console.log(values.json ? JSON.stringify(measured) : row([name, median(counts), Math.min(...counts), Math.max(...counts), seconds, `${most.others} in ${most.threads}`, ...counts]));
  }
}

/** What a line of `--json` opens with: the run it is of. @param {string} kind @param {string} name */
function of(kind, name) {
  return { kind, case: name, depth, requests: sent(COUNTED, depth) };
}

/** Says that the probe could not run a case, which has no figure. @param {string} kind @param {string} name @param {Error} error */
function unsupported(kind, name, error) {
  console.log(values.json ? JSON.stringify({ ...of(kind, name), unsupported: error.message }) : `${name.padEnd(width)}not run: ${error.message}`);
}

async function allocations() {
  const two = (/** @type {number} */ count) => each(count, depth).toFixed(2);
  if (!values.json) console.log("case".padEnd(width) + "allocations".padStart(12) + "frees".padStart(10) + "  calls");
  for (const name of names) {
    let window;
    try {
      window = await counted(binary, name, { cpu, port, depth, scratch });
    } catch (error) {
      if (!(error instanceof WithoutOwnHttp1)) throw error;
      unsupported("allocations", name, error);
      continue;
    }
    const found = allocatorCalls(window.profile);
    // Every case allocates for each request: fewer means the profile is not of the requests.
    if (found.allocations < sent(COUNTED, depth)) throw new Error(`${name}: the profile holds ${found.allocations} allocations for ${sent(COUNTED, depth)} requests`);
    const calls = Object.entries(found.calls).sort().map(([call, count]) => `${call}=${two(count)}`).join(" ");
    console.log(values.json ? JSON.stringify({ ...of("allocations", name), ...found }) : name.padEnd(width) + two(found.allocations).padStart(12) + two(found.frees).padStart(10) + "  " + calls);
  }
}

async function answers(/** @type {string} */ directory) {
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    for (const suffix of ["http", "unsupported"]) rmSync(join(directory, `${name}.${suffix}`), { force: true });
  }
  for (const name of names) {
    const { configuration, hosts, own } = /** @type {typeof cases[string]} */ (cases[name]);
    let probe;
    try {
      probe = await start(binary, configuration, { cpu, port, hosts, own });
    } catch (error) {
      if (!(error instanceof WithoutOwnHttp1)) throw error;
      writeFileSync(join(directory, `${name}.unsupported`), `${error.message}\n`);
      continue;
    }
    try {
      const connection = await Connection.open(port);
      writeFileSync(join(directory, `${name}.http`), await send(connection, name, 3));
      await connection.close();
    } finally {
      await probe.stop();
    }
  }
}
