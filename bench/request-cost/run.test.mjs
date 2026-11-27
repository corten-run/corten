// node --test bench/request-cost/run.test.mjs
// count.mjs and idle.mjs run whole, with stand-ins on PATH for taskset, valgrind and
// callgrind_control and stand-in.mjs for the probe: which dump a count reads, what its window
// holds, and what makes a run print no figure. idle.mjs runs with stand-in-status.mjs preloaded,
// so it reads the stand-in's resident memory from the status the stand-in writes and a test knows
// each reading, and its open files from /proc. The stand-ins are shell scripts and idle.mjs reads
// /proc, so these run on Linux with sh and are skipped elsewhere; the refusals of an option run
// anywhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as compare from "./compare.mjs";
import { counted } from "./probe.mjs";
import { cases } from "./requests.mjs";

const kit = dirname(fileURLToPath(import.meta.url));
const linux = process.platform === "linux" && spawnSync("sh", ["-c", "true"]).status === 0;
const skip = !linux && "needs Linux and sh";

/** A directory with the stand-ins, each a script that runs stand-in.mjs, and one for their notes. */
function standIns() {
  const directory = mkdtempSync(join(tmpdir(), "request-cost-test-"));
  const quoted = (/** @type {string} */ text) => `'${text.replaceAll("'", "'\\''")}'`;
  const run = `exec ${quoted(process.execPath)} ${quoted(join(kit, "stand-in.mjs"))}`;
  const scripts = {
    // taskset -c <cpu> <command>: notes the CPU and becomes the command, as taskset does.
    taskset: 'printf \'%s %s\\n\' "$1" "$2" > "$STAND_IN/held-to"\nshift 2\nexec "$@"',
    valgrind: `${run} "$@"`,
    callgrind_control: `${run} control "$@"`,
    probe: `${run} "$@"`,
    // getconf PAGESIZE: the page size a test asks for (4096 unless STAND_IN_PAGE says). Asked for
    // anything else, it answers nothing; with STAND_IN_PAGE=fail it prints a page size and fails.
    getconf: '[ "$#" = 1 ] && [ "$1" = PAGESIZE ] || exit 2\nif [ "$STAND_IN_PAGE" = fail ]; then echo 4096; exit 1; fi\nprintf \'%s\\n\' "${STAND_IN_PAGE:-4096}"',
  };
  for (const [name, script] of Object.entries(scripts)) {
    writeFileSync(join(directory, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(directory, name), 0o755);
  }
  const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, STAND_IN: directory };
  const notes = (/** @type {string} */ name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
  return { directory, env, probe: join(directory, "probe"), notes, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * A port nothing listens on, below the ports Linux gives a socket that asks for any (32768 and
 * up): the other test files' servers ask for any, and one could be given a port found free here
 * before the stand-in listens on it.
 */
async function free() {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const server = net.createServer();
    server.listen(port, "127.0.0.1");
    const [event] = await Promise.race([once(server, "listening").then(() => ["listening"]), once(server, "error").then(() => ["error"])]);
    if (event === "error") continue;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }
}

/**
 * `counted` for a case with the stand-ins in this process's environment, and what they noted.
 * @param {string} name @param {number} depth @param {Record<string, string>} [asked] the stand-in's variables
 */
async function counting(name, depth, asked = {}) {
  const stand = standIns();
  const before = { ...process.env };
  Object.assign(process.env, stand.env, asked);
  try {
    const window = await counted(stand.probe, name, { cpu: "3", port: await free(), depth, scratch: stand.directory });
    return { window, started: stand.notes("started.json"), parts: stand.notes("parts.json"), taskset: readFileSync(join(stand.directory, "held-to"), "utf8") };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    stand.remove();
  }
}

/** The head of the case's request to `port`, as the stand-in notes it. @param {string} name @param {number} port */
function sent(name, port) {
  return cases[name].request(port).toString("latin1").replace(/\r\n\r\n$/, "");
}

/**
 * Requires the line an idle run over 40 connections printed for `what` (`answered 1 pipeline`),
 * whole: the readings the counted gate decides by, its growth after less before, and its figure
 * that growth over the connections. With `requests`, the readings are the stand-in's: 10,440 kB
 * before (10,240 and a 4,096-byte page each of the 50 warm connections left behind), and two
 * pages more after for each connection and one for each request on it.
 * @param {string} stdout @param {string} what @param {{ page?: number, requests?: number }} [expected]
 */
function printedWhole(stdout, what, { page = 4096, requests } = {}) {
  const line = new RegExp(`^(-?\\d+) bytes a connection \\(40 that ${what}, opened in \\d+\\.\\d s; (\\d+) before, (\\d+) after, (-?\\d+) grown, in ${page}-byte pages\\)$`, "m").exec(stdout);
  assert.ok(line, stdout);
  const [, figure, before, after, grown] = line.map(Number);
  assert.equal(grown, after - before);
  assert.equal(figure, Math.round(grown / 40));
  if (requests !== undefined) assert.deepEqual([before, after, grown, figure], standInReadings(requests), stdout);
}

/**
 * The stand-in's before, after, growth and figure over 40 connections that each sent `requests`.
 * @param {number} requests @returns {number[]}
 */
function standInReadings(requests) {
  const before = (10_240 + 4 * 50) * 1024;
  const grown = 40 * (2 + requests) * 4096;
  return [before, before + grown, grown, grown / 40];
}

/**
 * A script of the kit run with the stand-ins and stand-in-status.mjs preloaded, so that idle.mjs
 * reads the stand-in's status; with `{ preload: false }` it is run as on a host.
 * @param {string} script @param {string[]} args @param {Record<string, string>} [asked] @param {{ preload?: boolean, capability?: string }} [how]
 */
async function running(script, args, asked = {}, { preload = true, capability } = {}) {
  const stand = standIns();
  try {
    if (capability !== undefined) writeFileSync(`${stand.probe}.own-http1`, `${capability}\n`);
    const port = await free();
    const loaded = preload ? ["--import", pathToFileURL(join(kit, "stand-in-status.mjs")).href] : [];
    const run = spawnSync(process.execPath, [...loaded, join(kit, script), stand.probe, "--cpu", "3", "--port", String(port), ...args], { env: { ...stand.env, ...asked }, encoding: "utf8" });
    // The request heads each connection to the probe sent, which the stand-in notes as it stops.
    const noted = join(stand.directory, "connections.json");
    const connections = existsSync(noted) ? /** @type {string[][]} */ (JSON.parse(readFileSync(noted, "utf8"))) : null;
    return { ...run, port, started: existsSync(join(stand.directory, "started.json")), connections };
  } finally {
    stand.remove();
  }
}

test("a count is the first thread's dump of the 1,000 requests after the 240, on the one connection, before it closes", { skip }, async () => {
  const { window, started, parts, taskset } = await counting("get", 1);
  // 1,000 requests at the stand-in's 1,000 instructions each and its 600: no connection opened or
  // closed in the window, which either would add millions for.
  assert.equal(window.serving, 1_000_600);
  assert.match(window.profile, /^part: 2$/m);
  assert.match(window.profile, /^thread: 1$/m);
  assert.deepEqual([window.others, window.threads], [243, 1]);
  assert.ok(window.seconds > 0 && window.seconds < 30, `${window.seconds} s`);
  // The stand-in's own account: the two dumps, and what was left when it was stopped.
  assert.deepEqual(parts, [
    { requests: 240, opened: 1, closed: 0, mostInARead: 1 },
    { requests: 1000, opened: 0, closed: 0, mostInARead: 1 },
    { requests: 0, opened: 0, closed: 1, mostInARead: 0 },
  ]);
  // Held to the CPU asked for, under callgrind with a file a thread, with the allocator's settings.
  assert.equal(taskset, "-c 3\n");
  assert.deepEqual(started.options.filter((/** @type {string} */ option) => !option.startsWith("--callgrind-out-file=")), ["--tool=callgrind", "--separate-threads=yes", "--compress-strings=no", "--compress-pos=no"]);
  assert.equal(started.configuration, "api");
  assert.deepEqual([started.LD_PRELOAD, started.MALLOC_CONF, started.PROBE_ALLOCATOR], ["libjemalloc.so.2", "background_thread:false,tcache_max:524288", "jemalloc"]);
});

test("at a depth both the 240 and the 1,000 are written that many at a time, in whole batches", { skip }, async () => {
  const { window, parts, started } = await counting("text", 7);
  assert.equal(window.serving, 994_600);
  assert.equal(started.configuration, "pages");
  assert.deepEqual([parts[0].requests, parts[1].requests], [238, 994]);
  assert.ok(parts[0].mostInARead > 1 && parts[1].mostInARead > 1, "the requests came one at a time");
});

test("a window the first thread did not serve in is not a count", { skip }, async () => {
  await assert.rejects(counting("get", 1, { STAND_IN_THREAD: "2" }), /not a count: the probe's first thread ran 0 instructions for 1000 requests, so it did not serve them \(1 other threads ran 1000600\)/);
});

test("a window where another thread ran more than the clock's ticks is not a count", { skip }, async () => {
  await assert.rejects(counting("get", 1, { STAND_IN_OTHERS: "50000" }), /not a count: 1 other threads ran 50000 instructions in a window of \d+\.\d s, where the clock's ticks explain \d+ at most; the first thread ran 1000600/);
  // What the clock runs in the ticks a window can hold is let through, and reported.
  const { window } = await counting("get", 1, { STAND_IN_OTHERS: "600" });
  assert.deepEqual([window.serving, window.others, window.threads], [1_000_600, 600, 1]);
  // Every other thread's file is read: a third thread's work refuses the window by itself, and
  // is in the sum when the window is let through.
  await assert.rejects(counting("get", 1, { STAND_IN_THIRD: "50000" }), /not a count: 2 other threads ran 50243 instructions in a window of \d+\.\d s/);
  const three = await counting("get", 1, { STAND_IN_OTHERS: "300", STAND_IN_THIRD: "200" });
  assert.deepEqual([three.window.serving, three.window.others, three.window.threads], [1_000_600, 500, 2]);
});

test("a dump that callgrind_control did not make the probe write is an error, though the control exits 0", { skip }, async () => {
  await assert.rejects(counting("get", 1, { STAND_IN_DEAF_AFTER: "0" }), /callgrind_control did not make the probe write dump 1/);
  await assert.rejects(counting("get", 1, { STAND_IN_DEAF_AFTER: "1" }), /callgrind_control did not make the probe write dump 2/);
});

test("a run whose dumps were not written prints no figure from the dumps of the run before it", { skip }, async () => {
  // The control works for the first of two counts and reaches nothing for the second.
  const run = await running("count.mjs", ["--cases", "get", "--reps", "2"], { STAND_IN_DEAF_AFTER: "2" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /callgrind_control did not make the probe write dump 1/);
  assert.doesNotMatch(run.stdout, /^get/m);
});

test("count.mjs prints each case's count to the nearest instruction, its window's seconds and the other threads' instructions", { skip }, async () => {
  const run = await running("count.mjs", ["--cases", "get,pipeline", "--reps", "2"]);
  assert.equal(run.status, 0, run.stderr);
  const [header, get, pipeline] = run.stdout.trimEnd().split("\n").map((line) => line.trim().split(/\s{2,}/));
  assert.deepEqual(header, ["case", "median", "least", "most", "seconds", "other threads", "counts"]);
  // 1,000,600 over 1,000 is 1,000.6: 1,001, not 1,000.
  assert.deepEqual([get?.slice(0, 4), get?.slice(5)], [["get", "1001", "1001", "1001"], ["243 in 1", "1001 1001"]]);
  assert.match(String(get?.[4]), /^\d+\.\d$/);
  assert.deepEqual(pipeline?.slice(0, 4), ["pipeline", "1001", "1001", "1001"]);
});

test("a case of an app that answers to any host starts the probe with HOSTS=*, and the others with no HOSTS whatever the caller's holds", { skip }, async () => {
  const any = await counting("unstaged-any-last", 1);
  assert.equal(any.started.HOSTS, "*");
  assert.equal(any.started.configuration, "api");
  assert.equal(any.window.serving, 1_000_600);
  const named = await counting("get", 1, { HOSTS: "shop.example" });
  assert.equal(named.started.HOSTS, null);
  const set = await counting("get-any", 1, { HOSTS: "shop.example" });
  assert.equal(set.started.HOSTS, "*");
});

test("a case with own_http1 on starts the probe with PROBE_OWN_HTTP1=1, and the others without it whatever the caller's holds", { skip }, async () => {
  const own = await counting("unstaged-any-long-own", 1);
  assert.deepEqual([own.started.PROBE_OWN_HTTP1, own.started.HOSTS, own.started.configuration], ["1", "*", "api"]);
  assert.equal(own.window.serving, 1_000_600);
  // Cases the stand-in answers, with the switch on and off.
  for (const name of ["get", "get-own", "pipeline-own", "get-any", "text"]) {
    const { started } = await counting(name, 1, { PROBE_OWN_HTTP1: "1" });
    assert.equal(started.PROBE_OWN_HTTP1, cases[name]?.own ? "1" : null, name);
  }
});

test("a probe built without the switch runs no case with own_http1 on, which each script says and goes on, exiting 0", { skip }, async () => {
  const word = "NO own_http1: this probe was built without the own-http1 feature, as against a Corten that has no App::own_http1";
  const asked = { STAND_IN_NO_OWN: "1" };
  const record = { capability: "without" };
  const text = await running("count.mjs", ["--cases", "get-own,get", "--reps", "1"], asked, record);
  assert.equal(text.status, 0, text.stderr);
  const [, own, get] = text.stdout.trimEnd().split("\n");
  assert.equal(own, `${"get-own".padEnd(14)}not run: ${word}`);
  assert.match(String(get), /^get\s+1001\s+1001\s+1001\s/);
  // As compare.mjs reads it: the run asked for, and what the probe said, in place of a figure.
  const plan = Object.fromEntries(compare.readings().map((reading) => [reading.file, reading]));
  for (const file of ["count-get-own.json", "count-16-pipeline-own.json", "allocations-post-own.json", "idle-request-own-1.json", "idle-browser-own-1.json", "idle-silent-own-1.json"]) {
    const { script, options, expect } = /** @type {ReturnType<typeof compare.readings>[number]} */ (plan[file]);
    const run = await running(script, options, asked, record);
    assert.equal(run.status, 0, `${file}: ${run.stderr}`);
    assert.match(run.stdout, /^\{.*\}\n$/, file);
    assert.equal(compare.figure(run.stdout, expect), null, file);
    assert.equal(compare.unsupported(run.stdout, expect), word, file);
  }
  // A probe that has the switch is counted as any other.
  const has = await running("count.mjs", ["--json", "--cases", "get-own"]);
  assert.equal(has.status, 0, has.stderr);
  assert.equal(compare.figure(has.stdout, /** @type {any} */ (plan["count-get-own.json"]).expect)?.median, 1001);
  // --answers writes what the probe said in the place of the case's answer, and the other answers.
  const answers = mkdtempSync(join(tmpdir(), "request-cost-answers-"));
  try {
    const run = await running("count.mjs", ["--cases", "pipeline-own,pipeline", "--answers", answers], asked, record);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(answers).sort(), ["pipeline-own.unsupported", "pipeline.http"]);
    assert.equal(readFileSync(join(answers, "pipeline-own.unsupported"), "utf8"), `${word}\n`);
  } finally {
    rmSync(answers, { recursive: true, force: true });
  }
});

test("an unexpected refusal line, status, switch request or build record fails the run", { skip }, async () => {
  const asked = { STAND_IN_NO_OWN: "1" };
  for (const [name, environment, capability] of /** @type {[string, Record<string, string>, string | undefined][]} */ ([
    ["get-own", asked, undefined],
    ["get-own", asked, "with"],
    ["get-own", { ...asked, STAND_IN_EXIT: "0" }, "without"],
    ["get-own", { ...asked, STAND_IN_EXIT: "2" }, "without"],
    ["get-own", { ...asked, STAND_IN_REFUSAL: "NO own_http1: not the refusal" }, "without"],
    ["get", { ...asked, STAND_IN_REFUSES_OFF: "1" }, "without"],
  ])) {
    const run = await running("count.mjs", ["--json", "--cases", name], environment, { capability });
    assert.equal(run.status, 1, `${name}: ${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /the probe stopped before it was ready/);
  }
  const ready = await running("count.mjs", ["--json", "--cases", "get-own"], {}, { capability: "without" });
  assert.equal(ready.status, 1, ready.stdout);
  assert.match(ready.stderr, /said READY.*build record says without/);
});

test("a repeated answer capture clears both artifacts of selected cases before any probe starts", { skip }, async (t) => {
  const answers = mkdtempSync(join(tmpdir(), "request-cost-answers-"));
  t.after(() => rmSync(answers, { recursive: true, force: true }));
  const capture = (/** @type {string} */ names, /** @type {Record<string, string>} */ environment = {}, /** @type {string} */ capability = "with") =>
    running("count.mjs", ["--cases", names, "--answers", answers], environment, { capability });
  const files = () => readdirSync(answers).sort();
  assert.equal((await capture("get,pipeline-own,get-own")).status, 0);
  assert.deepEqual(files(), ["get-own.http", "get.http", "pipeline-own.http"]);
  assert.equal((await capture("pipeline-own,get-own", { STAND_IN_NO_OWN: "1" }, "without")).status, 0);
  assert.deepEqual(files(), ["get-own.unsupported", "get.http", "pipeline-own.unsupported"]);
  assert.equal((await capture("pipeline-own")).status, 0);
  assert.deepEqual(files(), ["get-own.unsupported", "get.http", "pipeline-own.http"]);
  // A failure at the first selected case does not leave a later case's old artifact behind.
  assert.equal((await capture("pipeline-own,get-own", { STAND_IN_NO_OWN: "1" })).status, 1);
  assert.deepEqual(files(), ["get.http"]);
});

test("count.mjs widens the case's column for a name longer than it, and keeps it 14 for the rest", { skip }, async () => {
  const run = await running("count.mjs", ["--cases", "get,unstaged-any-last", "--reps", "1"]);
  assert.equal(run.status, 0, run.stderr);
  const [header, get, last] = run.stdout.trimEnd().split("\n");
  assert.equal(header?.indexOf("median"), 19 + 4);
  assert.match(String(get), /^get {16}\s+1001\s/);
  assert.match(String(last), /^unstaged-any-last  \s+1001\s/);
  assert.equal(get?.indexOf("1001"), last?.indexOf("1001"));
  const short = await running("count.mjs", ["--cases", "get", "--reps", "1"]);
  assert.equal(short.stdout.split("\n")[0]?.indexOf("median"), 14 + 4);
});

test("count.mjs takes a depth of 240, the whole of the requests before the counted ones", { skip }, async () => {
  const run = await running("count.mjs", ["--cases", "pipeline", "--reps", "1", "--depth", "240"]);
  assert.equal(run.status, 0, run.stderr);
  // 960 are counted: 960,600 over 960.
  assert.match(run.stdout, /^pipeline\s+1001\s+1001\s+1001\s/m);
});

test("count.mjs --allocations prints calls a request, and no figure for a dump with fewer allocations than requests", { skip }, async () => {
  const run = await running("count.mjs", ["--cases", "get", "--allocations"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^get\s+16\.00\s+0\.00\s+malloc=16\.00$/m);
  const fewer = await running("count.mjs", ["--cases", "get", "--allocations"], { STAND_IN_FEWER_MALLOCS: "1" });
  assert.equal(fewer.status, 1);
  assert.match(fewer.stderr, /get: the profile holds 999 allocations for 1000 requests/);
  assert.doesNotMatch(fewer.stdout, /^get/m);
});

test("idle.mjs prints a figure when the probe's open files grew by the connections, counted from after the warm ones closed", { skip }, async () => {
  const run = await running("idle.mjs", ["--connections", "40"]);
  assert.equal(run.status, 0, run.stderr);
  printedWhole(run.stdout, "answered 1 pipeline", { requests: 1 });
  // Without the preload it reads the process's own status in /proc, as on a host, though STAND_IN
  // names the directory the stand-in wrote its status in: idle.mjs has no way to read another.
  const own = await running("idle.mjs", ["--connections", "40"], {}, { preload: false });
  assert.equal(own.status, 0, own.stderr);
  printedWhole(own.stdout, "answered 1 pipeline");
  assert.notEqual(Number(/; (\d+) before,/.exec(own.stdout)?.[1]), standInReadings(1)[0], own.stdout);
});

test("idle.mjs prints the case and the requests an active run sent", { skip }, async () => {
  const run = await running("idle.mjs", ["--connections", "40", "--case", "get-browser", "--requests", "3"]);
  assert.equal(run.status, 0, run.stderr);
  printedWhole(run.stdout, "answered 3 get-browser", { requests: 3 });
  // The 50 warm connections sent the case once each, then the 40 sent it 3 times each.
  const request = sent("get-browser", run.port);
  assert.deepEqual(run.connections?.filter((heads) => heads.length), [...Array(50).fill([request]), ...Array(40).fill([request, request, request])]);
});

test("idle.mjs names the case a silent run's probe was set up and warmed for", { skip }, async () => {
  for (const name of ["text", "pipeline"]) {
    const run = await running("idle.mjs", ["--connections", "40", "--silent", "--case", name]);
    assert.equal(run.status, 0, run.stderr);
    printedWhole(run.stdout, `sent nothing to the probe for ${name}`, { requests: 0 });
    // The 50 warm connections sent the case once each, and the 40 nothing.
    assert.deepEqual(run.connections?.filter((heads) => heads.length), Array(50).fill([sent(name, run.port)]), name);
  }
});

test("idle.mjs prints the page size getconf gives, and starts nothing without a whole one", { skip }, async () => {
  const large = await running("idle.mjs", ["--connections", "40"], { STAND_IN_PAGE: "65536" });
  assert.equal(large.status, 0, large.stderr);
  printedWhole(large.stdout, "answered 1 pipeline", { page: 65536, requests: 1 });
  for (const page of ["fail", "4096.5", "0", "4k", "9007199254740992", "9".repeat(310)]) {
    const run = await running("idle.mjs", ["--connections", "40"], { STAND_IN_PAGE: page });
    assert.equal(run.status, 1, `page ${JSON.stringify(page)}`);
    assert.match(run.stderr, /getconf PAGESIZE did not give the page size/);
    assert.doesNotMatch(run.stdout, /bytes a connection/);
    assert.equal(run.started, false, `page ${JSON.stringify(page)} started the probe`);
  }
});

test("idle.mjs prints no figure when a connection's answer is not the case's", { skip }, async () => {
  // The 50 warm requests are answered; the 21st of the 40 connections gets a 404.
  const run = await running("idle.mjs", ["--connections", "40"], { STAND_IN_NOT_FOUND_FROM: "71" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /pipeline: not a 200: HTTP\/1\.1 404 Not Found/);
  assert.doesNotMatch(run.stdout, /bytes a connection/);
});

test("each kind of run compare.mjs asks for is one the kit takes, and its --json is what was measured, the whole figure compare.mjs reads", { skip }, async () => {
  const plan = Object.fromEntries(compare.readings().map((reading) => [reading.file, reading]));
  const take = async (/** @type {string} */ file, /** @type {string[]} */ more = [], asked = {}, /** @type {Record<string, string>} */ environment = {}) => {
    const { script, options, expect } = /** @type {ReturnType<typeof compare.readings>[number]} */ (plan[file]);
    const run = await running(script, [...options, ...more], environment);
    assert.equal(run.status, 0, `${file}: ${run.stderr}`);
    // One line, and nothing of the table printed for people.
    assert.match(run.stdout, /^\{.*\}\n$/, file);
    return { text: run.stdout, expect, found: compare.figure(run.stdout, { ...expect, ...asked }) };
  };
  const count = (await take("count-get.json")).found;
  assert.deepEqual([count.median, count.counts, count.windows.map((/** @type {any} */ window) => [window.instructions, window.others, window.threads])], [1001, [1001, 1001, 1001], Array(3).fill([1_000_600, 243, 1])]);
  assert.ok(count.windows.every((/** @type {any} */ window) => window.seconds > 0 && window.seconds < 30));
  // 992 requests are counted at a depth of 16: 992,600 over them.
  const deep = (await take("count-16-pipeline.json")).found;
  assert.deepEqual([deep.depth, deep.requests, deep.windows[0].instructions, deep.median], [16, 992, 992_600, 1001]);
  // The calls themselves, not calls a request.
  const calls = (await take("allocations-get.json")).found;
  assert.deepEqual([calls.requests, calls.allocations, calls.frees, calls.calls], [1000, 16_000, 0, { malloc: 16_000 }]);
  // The stand-in's 40 connections are a whole run of 40, and not the reading of 5,000 asked for.
  for (const [file, requests] of /** @type {const} */ ([["idle-request-1.json", 1], ["idle-browser-1.json", 3], ["idle-silent-1.json", 0]])) {
    const { text, expect, found } = await take(file, ["--connections", "40"], { connections: 40 });
    // The growth and the page size the gate decides by, beside the rounded figure.
    const [before, after, grown, bytes] = standInReadings(requests);
    assert.deepEqual([found.requests, found.connections, found.before, found.after, found.grown, found.page, found.bytes], [requests, 40, before, after, grown, 4096, bytes], file);
    assert.equal(compare.figure(text, expect), null, file);
  }
  // The page size getconf gives is the one the JSON carries. Its resident memory is still the
  // stand-in's, in 4,096-byte pages: the printed JSON is read here, and the 65,536-byte rule is
  // tested on figures of its own.
  const large = await take("idle-silent-1.json", ["--connections", "40"], { connections: 40 }, { STAND_IN_PAGE: "65536" });
  assert.equal(JSON.parse(large.text).page, 65536);
});

test("an option that would give a figure of something else is refused before anything is started", () => {
  const refused = (/** @type {string} */ script, /** @type {string[]} */ args, /** @type {RegExp} */ why) => {
    const run = spawnSync(process.execPath, [join(kit, script), "no-such-probe", ...args], { encoding: "utf8" });
    assert.equal(run.status, 1, `${script} ${args.join(" ")}`);
    assert.match(run.stderr, why);
    assert.equal(run.stdout, "");
  };
  refused("count.mjs", ["--depth", "241"], /--depth takes at most 240/);
  refused("count.mjs", ["--depth", "0"], /--depth takes a whole number above 0/);
  refused("count.mjs", ["--allocations", "--reps", "2"], /--reps is for instruction counts/);
  refused("count.mjs", ["--answers", "answers", "--reps", "2"], /--reps is for instruction counts/);
  refused("count.mjs", ["--answers", "answers", "--depth", "2"], /--answers sends its requests one at a time/);
  refused("count.mjs", ["--answers", "answers", "--json"], /--json is of a count/);
  refused("count.mjs", ["--cases", "get,pages"], /no case "pages"/);
  refused("idle.mjs", ["--silent", "--requests", "3"], /--silent sends nothing/);
  refused("idle.mjs", ["--addresses", "255"], /--addresses takes at most 254/);
});
