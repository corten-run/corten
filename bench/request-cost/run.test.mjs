// node --test bench/request-cost/run.test.mjs
// count.mjs and idle.mjs run whole, with stand-ins on PATH for taskset, valgrind and
// callgrind_control and stand-in.mjs for the probe: which dump a count reads, what its window
// holds, and what makes a run print no figure. The stand-ins are shell scripts and idle.mjs reads
// /proc, so these run on Linux with sh and are skipped elsewhere; the refusals of an option run
// anywhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { counted } from "./probe.mjs";

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

/** A script of the kit run with the stand-ins. @param {string} script @param {string[]} args @param {Record<string, string>} [asked] */
async function running(script, args, asked = {}) {
  const stand = standIns();
  try {
    return spawnSync(process.execPath, [join(kit, script), stand.probe, "--cpu", "3", "--port", String(await free()), ...args], { env: { ...stand.env, ...asked }, encoding: "utf8" });
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
  assert.match(run.stdout, /^-?\d+ bytes a connection \(40 that answered 1 pipeline, opened in \d+\.\d s; \d+ before, \d+ after\)$/m);
});

test("idle.mjs prints no figure when a connection's answer is not the case's", { skip }, async () => {
  // The 50 warm requests are answered; the 21st of the 40 connections gets a 404.
  const run = await running("idle.mjs", ["--connections", "40"], { STAND_IN_NOT_FOUND_FROM: "71" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /pipeline: not a 200: HTTP\/1\.1 404 Not Found/);
  assert.doesNotMatch(run.stdout, /bytes a connection/);
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
  refused("count.mjs", ["--cases", "get,pages"], /no case "pages"/);
  refused("idle.mjs", ["--silent", "--requests", "3"], /--silent sends nothing/);
  refused("idle.mjs", ["--addresses", "255"], /--addresses takes at most 254/);
});
