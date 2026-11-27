// verify.sh on a server of its own, on Linux alone: however verify.sh ends, a signal during the
// stop and a KILL of verify.sh included, the base's server is stopped within a bound, a server
// that ignores TERM too, and nothing is left listening; a START that leaves a server listening
// fails it; a serve.mjs that does not end holds verify.sh no longer than its bound, and no
// NODE_OPTIONS of the caller's reaches serve.mjs; its readiness requests keep their bound whatever
// HOME's curl configuration says; and no proxy of the environment's answers for 127.0.0.1.
// The plan names no placement, so what is run is verify.sh's two starts of the base and nothing
// after them. Then serve.mjs, which runs each start, on its own.
//
// No test signals a fixture server, by number or otherwise: each ends by itself a bounded time
// after it starts, and a test waits for that rather than kill a number that may by then name
// another process. Whether one still runs is asked of a socket of its own, which takes a
// connection while it runs and refuses one once it has ended.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tools = process.platform === "linux" && spawnSync("sh", ["-c", "command -v taskset && command -v timeout && command -v curl"]).status === 0;
const LINUX = { skip: tools ? false : "needs Linux with taskset, timeout and curl" };
const POSIX = { skip: process.platform === "win32" ? "needs POSIX signals and sockets" : false };
const tmp = process.platform === "win32" ? null : realpathSync(mkdtempSync(join(tmpdir(), "placement-verify-")));
after(() => tmp && rmSync(tmp, { recursive: true, force: true }));
const taken = (port = 18083) => spawnSync("curl", ["--disable", "--noproxy", "*", "-s", "-o", "/dev/null", "--max-time", "1", `http://127.0.0.1:${port}/`]).status !== 7;
// turns.sh's two ports for a placement verify.sh runs, which a plan's resolved.sh gives it: not
// the host's 18081 and 18082, which trend.test.mjs's runs of turns.sh take while this file runs
// beside it (npm run check runs the placement test files in parallel).
const PORTS = [18084, 18085];
const lines = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; } };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Whether the fixture whose liveness socket this is still runs: it takes a connection. */
const alive = (sock) => new Promise((done) => { const c = connect(sock); c.on("connect", () => { c.destroy(); done(true); }); c.on("error", () => done(false)); });
/** The liveness sockets under dir of fixtures that still run. */
async function living(dir) {
  const left = [];
  for (const f of readdirSync(dir).filter((f) => /^alive-\d+\.sock$/.test(f))) if (await alive(join(dir, f))) left.push(f);
  return left;
}
/** Waits, at most ms, for every fixture under dir to have ended and 18083 to be free; says which still run past that. */
async function settle(dir, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const left = await living(dir), busy = tools && taken();
    if (left.length === 0 && !busy) return;
    if (Date.now() > until) throw new Error(`fixture servers still running ${ms} ms on, and so not ended by themselves: ${left.join(", ") || "none"}${busy ? "; something answers on 18083" : ""}`);
    await sleep(100);
  }
}

// A fixture server's own bound: it ends by itself this long after it starts, whatever it is sent.
const LIFE = 45000;
/**
 * A server as verify.sh starts one (bin/base <port>), writing beside the work directory's bin/:
 * its pid to pids when it starts, and its liveness socket alive-<pid>.sock. stubborn: ignores
 * TERM, writing its pid to terms when sent it, answers readiness and the request, drops the
 * connection of a request for /drop and never answers one for /hang, writing its pid to hung;
 * yielding: the same but ending on TERM; silent: ends on TERM, takes every connection and answers
 * no request, writing the time each arrives to asked; unavailable: ends on TERM, answers every
 * request but readiness (/) 503 with an x-nonce header of a value of its own. Every kind writes
 * the header names of each request but readiness, lower case and sorted, to names. late: how long
 * after it starts it begins to listen on its port (its liveness socket is there at once).
 */
function fixture(kind, life = LIFE, late = 0) {
  const answer = kind === "silent"
    ? 'note("asked", Date.now());'
    : kind === "unavailable"
      ? 'if (q.url === "/") s.end("ok"); else { s.statusCode = 503; s.setHeader("x-nonce", String(process.pid) + Math.random()); s.end("busy"); }'
      : 'if (q.url === "/drop") s.socket.destroy(); else if (q.url === "/hang") note("hung"); else s.end("ok");';
  return `#!/usr/bin/env node
const at = (f) => require("node:path").join(__dirname, "..", f), note = (f, v = process.pid) => require("node:fs").appendFileSync(at(f), v + "\\n");
setTimeout(() => process.exit(0), ${life});
require("node:net").createServer((c) => c.destroy()).listen(at("alive-" + process.pid + ".sock"));
note("pids");
${kind === "stubborn" ? 'process.on("SIGTERM", () => note("terms"));' : ""}
setTimeout(() => require("node:http").createServer((q, s) => { if (q.url !== "/") note("names", q.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()).sort().join(",")); ${answer} }).listen(Number(process.argv[2]), "127.0.0.1"), ${late});
`;
}

/**
 * A work directory whose base is such a server, for the request path given, and the verify.sh
 * command that checks it; the test then waits, past its end, for the work directory's servers
 * to have ended by themselves. start: the plan's start command; life: the server's own bound;
 * serve: the text of a stand-in for serve.mjs, put in a kit of its own under the work directory;
 * late: how long the server waits before it listens on its port; headers and mask: the plan's
 * headers.txt and mask.json; pads: the plan's PADS_P, each bin/base-p<pad> a copy of bin/base;
 * turns: the text of a turns.sh put in a kit of its own under the work directory, with the kit's
 * own turns.sh beside it as turns-kit.sh; answers: likewise, the text of an answers.mjs.
 */
function prepare(t, name, path, { kind = "stubborn", start = "$BIN $PORT", life = LIFE, serve = null, late = 0, headers = "", mask = "[]\n", pads = "", turns = null, answers = null } = {}) {
  const cpu = /: *(\d+)/.exec(spawnSync("taskset", ["-cp", String(process.pid)], { encoding: "utf8" }).stdout)?.[1];
  assert.ok(cpu, "taskset names no CPU this process may run on");
  assert.ok(!taken(), "port 18083 is in use, and verify.sh's port is fixed: this test needs it free");
  for (const port of PORTS) assert.ok(!taken(port), `port ${port} is in use, and this test gives turns.sh it: this test needs ${PORTS.join(" and ")} free`);
  const own = serve !== null || turns !== null || answers !== null;
  const work = join(tmp, name), vars = { WORK: work, KIT: own ? join(work, "kit") : here, START: start, REQ_PATH: path, STATUS: 200, EVENTS: "cycles:u", CPU_SERVER: cpu, CPU_LOAD: cpu, CPU_DRIVER: cpu, WRK_T: 1, WRK_C: 1, TURN: 1, W: "plain", PLACEMENT_SECONDS: 60, PADS_P: pads, PADS_Q: "", SIDES: "base", PORT_A: PORTS[0], PORT_B: PORTS[1] };
  mkdirSync(join(work, "plan"), { recursive: true });
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "plan", "resolved.sh"), Object.entries(vars).map(([k, v]) => `${k}='${v}'\n`).join(""));
  for (const [f, text] of [["headers.txt", headers], ["mask.sed", ""], ["mask.json", mask], ["request.lua", ""]]) writeFileSync(join(work, "plan", f), text);
  writeFileSync(join(work, "bin", "base"), fixture(kind, life, late), { mode: 0o755 });
  for (const pad of pads.split(" ").filter(Boolean)) writeFileSync(join(work, "bin", `base-p${pad}`), fixture(kind, life, late), { mode: 0o755 });
  if (own) {
    mkdirSync(join(work, "kit"));
    for (const f of ["serve.mjs", "answers.mjs", "mask.mjs", "turns.sh"]) if (existsSync(join(here, f))) copyFileSync(join(here, f), join(work, "kit", f));
    if (serve !== null) writeFileSync(join(work, "kit", "serve.mjs"), serve);
    if (turns !== null) { copyFileSync(join(here, "turns.sh"), join(work, "kit", "turns-kit.sh")); writeFileSync(join(work, "kit", "turns.sh"), turns); }
    if (answers !== null) writeFileSync(join(work, "kit", "answers.mjs"), answers);
  }
  t.after(() => settle(work, life + 5000));
  return { work, args: [join(here, "verify.sh"), work, join(work, "verify")] };
}

/**
 * verify.sh on such a work directory; killed, through its handle, at 60 s. env: the environment
 * verify.sh is run with; before: run on the work directory before verify.sh is; file: its output
 * goes to a file rather than a pipe, so its end is verify.sh's own, not that of the last process
 * holding the pipe.
 */
async function verify(t, name, path, { env = process.env, before = null, file = false, ...options } = {}) {
  const { work, args } = prepare(t, name, path, options);
  if (before) await before(work);
  const began = Date.now(), log = join(work, "verify.out"), fd = file ? openSync(log, "w") : null;
  const r = spawnSync("sh", args, { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", env, ...(file ? { stdio: ["ignore", fd, fd] } : {}) });
  const ended = Date.now(), seconds = (ended - began) / 1000;
  if (file) closeSync(fd);
  const said = file ? readFileSync(log, "utf8") : (r.stdout ?? "") + (r.stderr ?? "");
  return { ...r, seconds, ended, work, pids: lines(join(work, "pids")), left: await living(work), said };
}

/**
 * verify.sh on such a work directory, with signal sent to verify.sh itself (through its handle)
 * once the file of the work directory named by when holds count lines; killed at 60 s. env: the
 * environment verify.sh is run with. Its end is verify.sh's own exit, not its output closing (a
 * serve.mjs, which inherits that output, may hold it), and what still runs is asked at that moment:
 * left, the fixtures still running, and busy, whether something still takes a connection on 18083.
 * closing: how long, after verify.sh has exited, to wait for its output to close before returning.
 */
async function interrupted(t, name, path, when, signal, { count = 1, env = process.env, closing = 20000, ...options } = {}) {
  const { work, args } = prepare(t, name, path, options), began = Date.now();
  const child = spawn("sh", args, { stdio: ["ignore", "pipe", "pipe"], env });
  let said = "";
  child.stdout.on("data", (d) => { said += d; });
  child.stderr.on("data", (d) => { said += d; });
  const ended = new Promise((done) => child.on("exit", (status, sig) => done({ status, signal: sig })));
  const closed = new Promise((done) => child.on("close", done));
  const limit = setTimeout(() => child.kill("SIGKILL"), 60000);
  while (lines(join(work, when)).length < count && child.exitCode === null && Date.now() - began < 30000) await sleep(20);
  const sent = lines(join(work, when)).length >= count && child.exitCode === null;
  if (sent) child.kill(signal);
  const sentTime = Date.now(), sentAt = (sentTime - began) / 1000;
  const end = await ended;
  const seconds = (Date.now() - began) / 1000, left = await living(work), busy = taken();
  clearTimeout(limit);
  // What verify.sh said, once its output has closed: at most as long as a serve.mjs it left holds it.
  await Promise.race([closed, sleep(closing)]);
  return { ...end, sent, sentAt, sentTime, seconds, left, busy, work, said };
}

test("a fixture server ends by itself within its bound, though it ignores TERM, so no test need signal one", POSIX, async (t) => {
  const dir = join(tmp, "bounded");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "base"), fixture("stubborn", 1500), { mode: 0o755 });
  t.after(() => settle(dir, 1000));
  // Run here, on a port of its own choosing, as this test's own child: its handle holds it until
  // this test has seen it end, so the KILL below, sent only if it did not end, cannot reach another process.
  const child = spawn(process.execPath, [join(dir, "bin", "base"), "0"], { stdio: "ignore" });
  const ended = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
  const began = Date.now();
  while ((await living(dir)).length === 0 && Date.now() - began < 5000) await sleep(20);
  assert.equal((await living(dir)).length, 1, "the fixture never took a connection on its liveness socket");
  const end = await Promise.race([ended, sleep(6000).then(() => null)]);
  if (end === null) child.kill("SIGKILL");
  assert.notEqual(end, null, "the fixture was still running 6 s after it started, past its 1.5 s bound");
  assert.deepEqual(end, { code: 0, signal: null });
  assert.deepEqual(await living(dir), [], "its liveness socket still takes a connection after it ended");
});

test("verify.sh stops a base that ignores TERM after its two starts, within a bound, and nothing is left listening", LINUX, async (t) => {
  const r = await verify(t, "stubborn", "/page");
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.equal(r.status, 0, r.said);
  assert.ok(r.said.includes("verify: 0 placements answer as their unpadded binary"), r.said);
  assert.equal(r.pids.length, 2, r.said);
  assert.deepEqual(r.left, [], "a server verify.sh started is still running");
  assert.ok(r.seconds < 30, `verify.sh took ${r.seconds} s to stop two servers`);
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh, ended by a failed request while the base runs, stops that base though it ignores TERM, within a bound", LINUX, async (t) => {
  const r = await verify(t, "dropped", "/drop");
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  assert.equal(r.pids.length, 1, r.said);
  assert.deepEqual(r.left, [], "the server verify.sh started is still running");
  assert.ok(r.seconds < 30, `verify.sh took ${r.seconds} s to stop its server`);
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh stops a base that ends on TERM without waiting out the time it gives one that does not", LINUX, async (t) => {
  const r = await verify(t, "yielding", "/page", { kind: "yielding" });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.equal(r.status, 0, r.said);
  assert.equal(r.pids.length, 2, r.said);
  assert.deepEqual(r.left, [], "a server verify.sh started is still running");
  // Two stops held to their 5 s each would take 10 s: an exited server is seen as one at once.
  assert.ok(r.seconds < 8, `verify.sh took ${r.seconds} s to stop two servers that end on TERM`);
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh's starts and turns.sh's comparison send the one request, Host and the plan's header lines alone, and a placement is recorded with its verdict and its bodies line", LINUX, async (t) => {
  // Two starts of the base, and then one placement, base-p1, whose comparison asks A twice and B
  // once: five requests for the page, each with the same header names. A request with a client's
  // own User-Agent or Accept could be answered otherwise than the one the comparison makes.
  const r = await verify(t, "one-request", "/page", { kind: "yielding", headers: "X-Plan: 1\n", pads: "1" });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.equal(r.status, 0, r.said);
  const names = readFileSync(join(r.work, "names"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(names, Array(5).fill("host,x-plan"), `the requests for the page did not all send Host and the plan's header alone: ${names.join(" | ")}`);
  assert.ok(r.said.includes("verify: 1 placements answer as their unpadded binary"), r.said);
  assert.match(readFileSync(join(r.work, "verify", "verdicts.txt"), "utf8"), /^base-p1 as base: answers: same; body 2 bytes as received, sha256 [0-9a-f]{16} A and [0-9a-f]{16} B\n$/);
});

test("verify.sh takes no answer of another status than the plan's as evidence for its mask, though two such answers differ in the masked header", LINUX, async (t) => {
  const r = await verify(t, "unavailable", "/page", { kind: "unavailable", mask: '[{ "header": "x-nonce" }]\n' });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  assert.ok(r.said.includes("verify: HTTP/1.1 503 Service Unavailable on 18083") && r.said.includes("not status 200: an answer of another status is no evidence for the plan's mask"), r.said);
  assert.ok(!r.said.includes("every header the plan masks differs between them") && !existsSync(join(r.work, "verify", "starts.txt")), r.said);
  assert.ok(!r.said.includes("placements answer as their unpadded binary"), r.said);
});

test("verify.sh records no placement whose bodies line or verdict is not what turns.sh sealed, though turns.sh passed it", LINUX, async (t) => {
  // A turns.sh that runs the kit's own, which passes, and then takes away or replaces part of
  // what it left: the placement is recorded only from both the verdict and the bodies' evidence.
  for (const [name, after] of [["no-bodies", 'rm -f "$1/answers/bodies.txt"'], ["other-bodies", `printf 'body 2 bytes as received, sha256 ${"1".repeat(16)} A and ${"1".repeat(16)} B\\n' >"$1/answers/bodies.txt"`], ["no-verdict", 'rm -f "$1/answers/verdict.txt"']]) {
    const turns = `st=0; sh "$KIT/turns-kit.sh" "$@" || st=$?\n${after}\nexit $st\n`;
    const r = await verify(t, `unsealed-${name}`, "/page", { kind: "yielding", pads: "1", turns });
    assert.equal(r.error, undefined, `${name}: verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
    assert.equal(r.status, 1, `${name}: ${r.said}`);
    assert.ok(r.said.includes("VERIFY FAILED: base-p1 against base: what turns.sh left is not a verified placement"), `${name}: ${r.said}`);
    assert.equal(readFileSync(join(r.work, "verify", "verdicts.txt"), "utf8"), "", `${name}: a placement was recorded`);
    assert.ok(!r.said.includes("placements answer as their unpadded binary"), `${name}: ${r.said}`);
  }
});

test("verify.sh fails, saying so, when a START that forks the server and ends on TERM leaves that server listening after its stop", LINUX, async (t) => {
  // START runs the server in the background and execs a sleep, which serve.mjs then holds: TERM
  // ends the sleep, serve.mjs sees its child end, and the server, which no one stopped, still
  // listens (until its own 10 s bound). The second start's server cannot take the port, but the
  // first's answers for it, so only a look at the port after the stop can see it.
  const r = await verify(t, "forked", "/page", { start: "$BIN $PORT & exec sleep 30", life: 10000 });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  assert.ok(r.said.includes("verify: something still accepts on 18083 after the base's server was stopped (curl status 0): START must be, or exec, the server that listens"), r.said);
  assert.ok(!r.said.includes("placements answer as their unpadded binary"), r.said);
  assert.equal(r.pids.length, 1, `verify.sh went on to a second start: ${r.said}`);
  assert.ok(r.seconds < 8, `verify.sh took ${r.seconds} s to find the server left listening`);
});

test("verify.sh gives each readiness request at most a second, whatever retries HOME's curl configuration asks for, to a base that takes the connection and never answers", LINUX, async (t) => {
  // A .curlrc that retries a timed-out request three times, 3 s apart: read, it would stretch a
  // readiness request of a second to 13 s, and the requests would arrive 4 s apart, not one.
  const home = join(tmp, "curl-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".curlrc"), "retry = 3\nretry-delay = 3\nretry-all-errors\n");
  const env = { ...process.env, HOME: home };
  delete env.CURL_HOME;
  delete env.XDG_CONFIG_HOME;
  const r = await interrupted(t, "silent", "/", "asked", "SIGTERM", { kind: "silent", count: 4, env });
  const asked = lines(join(r.work, "asked")).slice(0, 4), gaps = asked.slice(1).map((v, i) => (v - asked[i]) / 1000);
  assert.ok(r.sent, `four readiness requests did not reach the base within 30 s (${asked.length} did): ${r.said}`);
  assert.ok(gaps.every((g) => g < 2.5), `readiness requests arrived ${gaps.join(" s, ")} s apart, not a second or so: ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  // TERM is taken once the readiness request under way has ended, a second at most, and the stop follows.
  assert.ok(r.seconds - r.sentAt < 8, `verify.sh took ${r.seconds - r.sentAt} s to end after TERM`);
  assert.deepEqual(await living(r.work), [], "the server verify.sh started is still running");
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh, sent TERM while it stops a base that ignores TERM after a request that succeeded, finishes the stop before it ends, fails for the TERM, and nothing is left listening", LINUX, async (t) => {
  // The first start's request succeeds and its stop begins, which the base's own record of TERM
  // says; TERM is then sent to verify.sh, which must not cut that stop short, and then ends 1 for
  // it rather than go on to the second start (which, with no TERM, it would, and pass).
  const r = await interrupted(t, "term-during-stop", "/page", "terms", "SIGTERM");
  assert.ok(r.sent, `the stop never began, or verify.sh ended before TERM could be sent: ${r.said}`);
  assert.deepEqual([r.status, r.signal], [1, null], r.said);
  assert.equal(lines(join(r.work, "pids")).length, 1, `verify.sh went on to a second start: ${r.said}`);
  assert.ok(existsSync(join(r.work, "verify", "start-1.raw-headers")) && !r.said.includes("placements answer as their unpadded binary"), r.said);
  assert.deepEqual(r.left, [], `the server verify.sh started was still running when verify.sh exited: ${r.said}`);
  assert.ok(!r.busy, `something still answered on 18083 when verify.sh exited: ${r.said}`);
  assert.ok(r.seconds < 30, `verify.sh took ${r.seconds} s to stop its server`);
});

test("verify.sh, killed while a base that ignores TERM runs, still has that base stopped within a bound", LINUX, async (t) => {
  // verify.sh sends no signal by number: its server is stopped by serve.mjs when verify.sh's end
  // of serve.mjs's input closes, which a KILL of verify.sh closes too. The bound is counted from
  // the KILL, not from verify.sh's pipes closing (serve.mjs holds them until it ends), and is well
  // short of the fixture's own, so the fixture ending by itself cannot pass for the stop.
  const bound = 15000;
  assert.ok(bound < LIFE - 5000);
  const r = await interrupted(t, "killed", "/hang", "hung", "SIGKILL");
  assert.ok(r.sent, `the request never reached the base, or verify.sh ended before it could be killed: ${r.said}`);
  let left = await living(r.work), busy = taken();
  while ((left.length > 0 || busy) && Date.now() - r.sentTime < bound) { await sleep(100); left = await living(r.work); busy = taken(); }
  const ms = Date.now() - r.sentTime;
  assert.equal(lines(join(r.work, "pids")).length, 1, r.said);
  assert.deepEqual(left, [], `the server verify.sh started was still running ${ms} ms after verify.sh was killed`);
  assert.ok(!busy, `something still answered on 18083 ${ms} ms after verify.sh was killed`);
});

test("verify.sh, killed while a sleep its readiness loop runs stalls, still has the base stopped within the same bound", LINUX, async (t) => {
  // The base listens on its port 3 s after it starts, so the first readiness request is refused
  // and the loop runs its sleep: a stand-in that waits for the base to have started, notes that it
  // runs and then stalls 25 s, holding every descriptor it was given (run again, it is the real
  // sleep). verify.sh is killed while it
  // stalls: a sleep given the shell's end of serve.mjs's input would keep the base running until
  // it ended. It also holds verify.sh's output, so the base is looked at from the KILL on, not
  // once that output has closed.
  const bound = 15000, name = "killed-in-sleep", work = join(tmp, name), stalled = join(work, "stalled"), unstalled = join(work, "unstalled");
  assert.ok(bound < 25000 - 5000 && bound < LIFE - 5000);
  const real = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real.startsWith("/"), `no sleep on PATH: ${real}`);
  const first = join(tmp, "stall-sleep");
  mkdirSync(first, { recursive: true });
  writeFileSync(join(first, "sleep"), `#!/bin/sh\n[ ! -e '${stalled}' ] || exec '${real}' "$@"\nuntil [ -s '${join(work, "pids")}' ]; do '${real}' 0.05; done\necho $$ >>'${stalled}'\n'${real}' 25\necho $$ >>'${unstalled}'\n`, { mode: 0o755 });
  t.after(async () => { for (const until = Date.now() + 30000; lines(unstalled).length === 0 && Date.now() < until;) await sleep(200); await sleep(500); });
  const env = { ...process.env, PATH: `${first}:${process.env.PATH}` };
  const r = await interrupted(t, name, "/page", "stalled", "SIGKILL", { env, late: 3000, closing: 0 });
  assert.ok(r.sent, `the readiness loop never ran its sleep, or verify.sh ended before it could be killed: ${r.said}`);
  let left = r.left, busy = r.busy;
  while ((left.length > 0 || busy) && Date.now() - r.sentTime < bound) { await sleep(100); left = await living(r.work); busy = taken(); }
  const ms = Date.now() - r.sentTime;
  assert.equal(lines(join(r.work, "pids")).length, 1, r.said);
  assert.deepEqual(left, [], `the server verify.sh started was still running ${ms} ms after verify.sh was killed in its readiness sleep`);
  assert.ok(!busy, `something still answered on 18083 ${ms} ms after verify.sh was killed in its readiness sleep`);
});

// A proxy of the environment's, at an address of its own: it answers every request it is sent
// 200 and notes it in proxied. It ends by itself 20 s after it starts, and has a liveness socket
// beside the work directory's servers', so the test waits for it as for them.
const PROXY = `const at = (f) => require("node:path").join(process.argv[1], f), fs = require("node:fs");
setTimeout(() => process.exit(0), 20000);
require("node:net").createServer((c) => c.destroy()).listen(at("alive-" + process.pid + ".sock"));
const s = require("node:http").createServer((q, r) => { fs.appendFileSync(at("proxied"), q.url + "\\n"); r.end("proxy"); });
s.listen(0, "127.0.0.1", () => fs.writeFileSync(at("proxy-port"), String(s.address().port)));`;
async function proxy(dir) {
  spawn(process.execPath, ["-e", PROXY, dir], { stdio: "ignore" });
  for (let i = 0; i < 200; i++) { try { return Number(readFileSync(join(dir, "proxy-port"), "utf8")); } catch { await sleep(25); } }
  throw new Error("the stand-in proxy never listened");
}

test("verify.sh sends no request through a proxy of the environment's: readiness, the request and the check of the port after each stop all go to 127.0.0.1", LINUX, async (t) => {
  let port;
  const env = { ...process.env };
  for (const k of ["NO_PROXY", "no_proxy"]) delete env[k];
  const r = await verify(t, "proxied", "/page", { kind: "yielding", env, before: async (work) => { port = await proxy(work); env.http_proxy = env.ALL_PROXY = `http://127.0.0.1:${port}`; } });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  const proxied = existsSync(join(r.work, "proxied")) ? readFileSync(join(r.work, "proxied"), "utf8") : "";
  assert.equal(proxied, "", "requests went to the proxy");
  assert.equal(r.status, 0, r.said);
  assert.equal(r.pids.length, 2, r.said);
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh runs serve.mjs and answers.mjs with no NODE_OPTIONS of the caller's, so a preload that would hold either before it starts does not reach it", LINUX, async (t) => {
  // The preload holds serve.mjs and answers.mjs, and nothing else node runs, for 40 s before its
  // own code runs, as --inspect-brk would without end, noting that it did; after that each goes on as ever.
  const pause = join(tmp, "pause.cjs");
  writeFileSync(pause, `if (/(serve|answers)\\.mjs$/.test(process.argv[1] ?? "")) { require("node:fs").appendFileSync(${JSON.stringify(join(tmp, "paused"))}, process.pid + "\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40000); }\n`);
  const r = await verify(t, "node-options", "/page", { kind: "yielding", env: { ...process.env, NODE_OPTIONS: `--require=${pause}` } });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.deepEqual(lines(join(tmp, "paused")), [], "the caller's NODE_OPTIONS reached serve.mjs or answers.mjs");
  assert.equal(r.status, 0, r.said);
  assert.ok(r.seconds < 8, `verify.sh took ${r.seconds} s`);
});

test("verify.sh stops an answers.mjs that does not end, at its bound, and fails with the base stopped and nothing left on its port", LINUX, async (t) => {
  // A stand-in for answers.mjs that ignores TERM and would run 45 s: timeout ends it 30 s on, with KILL 5 s after its TERM.
  const answers = 'import { appendFileSync } from "node:fs";\nimport { join } from "node:path";\nprocess.on("SIGTERM", () => {});\nappendFileSync(join(import.meta.dirname, "..", "stalled"), process.pid + "\\n");\nsetTimeout(() => process.exit(0), 45000);\n';
  const r = await verify(t, "answers-stalled", "/page", { kind: "yielding", answers, file: true });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.equal(r.status, 1, r.said);
  assert.equal(lines(join(r.work, "stalled")).length, 1, r.said);
  assert.ok(r.said.includes("verify: answers.mjs start did not end within 30 s, and was stopped"), r.said);
  assert.ok(r.seconds >= 30 && r.seconds < 42, `verify.sh ended ${r.seconds} s on, not at answers.mjs's bound`);
  assert.deepEqual(r.left, [], "the server verify.sh started is still running");
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh, whose serve.mjs does not end when its input closes, fails within its bound saying the cleanup is unconfirmed, and signals nothing", LINUX, async (t) => {
  // A stand-in for serve.mjs that runs no server but is one, on 18083, ignores the signals it
  // could be sent and its input ending, and ends by itself 30 s after it starts.
  const serve = `import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as web } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const at = (f) => join(dirname(fileURLToPath(import.meta.url)), "..", f);
setTimeout(() => process.exit(0), 30000);
for (const s of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(s, () => appendFileSync(at("signals"), s + "\\n"));
createServer((c) => c.destroy()).listen(at("alive-" + process.pid + ".sock"));
web((q, s) => s.end("ok")).listen(18083, "127.0.0.1");
process.stdin.on("end", () => appendFileSync(at("closed"), Date.now() + "\\n"));
process.stdin.resume();
`;
  const r = await verify(t, "serve-stuck", "/page", { serve, life: 30000, file: true });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  assert.ok(r.said.includes("verify: serve.mjs, stopping the base's server, has not ended 15 s after its input closed: cleanup unconfirmed"), r.said);
  const [closed] = lines(join(r.work, "closed")), waited = (r.ended - closed) / 1000;
  assert.ok(closed, `serve.mjs's input never closed: ${r.said}`);
  assert.ok(waited >= 14.5 && waited < 22, `verify.sh ended ${waited} s after serve.mjs's input closed, not about 15 s`);
  assert.deepEqual(lines(join(r.work, "signals")), [], "the stand-in serve.mjs was sent a signal");
  assert.equal((await living(r.work)).length, 1, "the stand-in serve.mjs, which ends by itself at 30 s, had already ended");
});

// serve.mjs on its own: what verify.sh relies on to stop a server. POSIX alone, for its signals.
/** A node script serve.mjs runs as its server: its liveness socket sock, its own 30 s bound, and body. */
const bounded = (sock, body = "") => `require("node:net").createServer((c) => c.destroy()).listen(${JSON.stringify(sock)}); setTimeout(() => process.exit(0), 30000); ${body}`;
/** serve.mjs running a node script as its server, its input a pipe this test holds. */
function serve(script) {
  const child = spawn(process.execPath, [join(here, "serve.mjs"), process.execPath, "-e", script], { stdio: ["pipe", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  const ended = new Promise((done) => child.on("close", (status, signal) => done({ status, signal, said })));
  return { child, ended };
}
const up = async (sock) => { for (let i = 0; i < 200; i++) { if (await alive(sock)) return true; await sleep(25); } return false; };

test("serve.mjs stops its server when its input ends: TERM, KILL 5 s later for one that ignores TERM, and nothing after", POSIX, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "placement-serve-"));
  t.after(async () => { await settle(dir, 35000); rmSync(dir, { recursive: true, force: true }); });
  for (const [ignores, most] of [[true, 9], [false, 2]]) {
    const sock = join(dir, `alive-${ignores ? 1 : 2}.sock`);
    const s = serve(bounded(sock, ignores ? 'process.on("SIGTERM", () => {});' : ""));
    assert.ok(await up(sock), "the server never started");
    const began = Date.now();
    s.child.stdin.end();
    const end = await s.ended, seconds = (Date.now() - began) / 1000;
    assert.equal(end.status, 0, end.said);
    assert.equal(await alive(sock), false, "the server is still running");
    assert.ok(ignores ? seconds >= 4.5 && seconds < most : seconds < most, `stopped in ${seconds} s (ignores TERM: ${ignores})`);
  }
});

test("serve.mjs ends, saying so, when its server ends before it is stopped, so it never signals a server that has gone; and stops its server when it is itself sent TERM", POSIX, async (t) => {
  const early = serve("process.exit(0);");
  const gone = await early.ended;
  assert.equal(gone.status, 1, gone.said);
  assert.ok(gone.said.includes("serve: the server ended before it was stopped (exit 0)"), gone.said);
  const dir = mkdtempSync(join(tmpdir(), "placement-serve-")), sock = join(dir, "alive-1.sock");
  t.after(async () => { await settle(dir, 35000); rmSync(dir, { recursive: true, force: true }); });
  const s = serve(bounded(sock));
  assert.ok(await up(sock), "the server never started");
  s.child.kill("SIGTERM");
  const end = await s.ended;
  assert.equal(end.status, 1, end.said);
  assert.ok(end.said.includes("serve: stopped by SIGTERM, not by its input ending; stopping the server"), end.said);
  assert.equal(await alive(sock), false, "the server is still running");
  s.child.stdin.destroy();
});

test("serve.mjs refuses anything already at its process number's file, a FIFO there included, without waiting on it, and stops its server at once", { skip: process.platform === "linux" && spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0 ? false : "needs Linux with mkfifo" }, async (t) => {
  // A FIFO with no reader at <file>.tmp: a write that opened it would wait for one, holding
  // serve.mjs before it reads its input, and its server would outlive the stop it is sent.
  const dir = mkdtempSync(join(tmpdir(), "placement-serve-")), sock = join(dir, "alive-1.sock"), pid = join(dir, "server.pid");
  t.after(async () => { await settle(dir, 35000); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(spawnSync("mkfifo", [`${pid}.tmp`]).status, 0);
  const child = spawn(process.execPath, [join(here, "serve.mjs"), `--pid=${pid}`, process.execPath, "-e", bounded(sock, 'process.on("SIGTERM", () => {});')], { stdio: ["pipe", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  const ended = new Promise((done) => child.on("close", (status) => done(status)));
  const began = Date.now(), end = await Promise.race([ended, sleep(15000).then(() => null)]), seconds = (Date.now() - began) / 1000;
  // Ended through its own handle only if it did not end by itself: its server then ends at its own 30 s bound.
  if (end === null) child.stdin.end();
  assert.notEqual(end, null, `serve.mjs had not ended 15 s after it started: it waited on the FIFO (${said})`);
  assert.equal(end, 1, said);
  assert.ok(said.includes("serve: the server's process number could not be written") && said.includes("stopping the server"), said);
  assert.ok(seconds < 12, `serve.mjs took ${seconds} s`);
  assert.equal(await alive(sock), false, "the server is still running");
  assert.ok(!existsSync(pid), "a process number was published");
});
