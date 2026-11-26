// verify.sh on a server of its own, on Linux alone: however verify.sh ends, a signal during the
// stop and a KILL of verify.sh included, the base's server is stopped within a bound, a server
// that ignores TERM too, and nothing is left listening; a START that leaves a server listening
// fails it; and its readiness requests keep their bound whatever HOME's curl configuration says.
// The plan names no placement, so what is run is verify.sh's two starts of the base and nothing
// after them. Then serve.mjs, which runs each start, on its own.
//
// No test signals a fixture server, by number or otherwise: each ends by itself a bounded time
// after it starts, and a test waits for that rather than kill a number that may by then name
// another process. Whether one still runs is asked of a socket of its own, which takes a
// connection while it runs and refuses one once it has ended.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const taken = () => spawnSync("curl", ["--disable", "-s", "-o", "/dev/null", "--max-time", "1", "http://127.0.0.1:18083/"]).status !== 7;
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
 * no request, writing the time each arrives to asked.
 */
function fixture(kind, life = LIFE) {
  const answer = kind === "silent"
    ? 'note("asked", Date.now());'
    : 'if (q.url === "/drop") s.socket.destroy(); else if (q.url === "/hang") note("hung"); else s.end("ok");';
  return `#!/usr/bin/env node
const at = (f) => require("node:path").join(__dirname, "..", f), note = (f, v = process.pid) => require("node:fs").appendFileSync(at(f), v + "\\n");
setTimeout(() => process.exit(0), ${life});
require("node:net").createServer((c) => c.destroy()).listen(at("alive-" + process.pid + ".sock"));
note("pids");
${kind === "stubborn" ? 'process.on("SIGTERM", () => note("terms"));' : ""}
require("node:http").createServer((q, s) => { ${answer} }).listen(Number(process.argv[2]), "127.0.0.1");
`;
}

/**
 * A work directory whose base is such a server, for the request path given, and the verify.sh
 * command that checks it; the test then waits, past its end, for the work directory's servers
 * to have ended by themselves. start: the plan's start command; life: the server's own bound.
 */
function prepare(t, name, path, { kind = "stubborn", start = "$BIN $PORT", life = LIFE } = {}) {
  const cpu = /: *(\d+)/.exec(spawnSync("taskset", ["-cp", String(process.pid)], { encoding: "utf8" }).stdout)?.[1];
  assert.ok(cpu, "taskset names no CPU this process may run on");
  assert.ok(!taken(), "port 18083 is in use, and verify.sh's port is fixed: this test needs it free");
  const work = join(tmp, name), vars = { WORK: work, KIT: here, START: start, REQ_PATH: path, STATUS: 200, EVENTS: "cycles:u", CPU_SERVER: cpu, CPU_LOAD: cpu, CPU_DRIVER: cpu, WRK_T: 1, WRK_C: 1, TURN: 1, W: "plain", PLACEMENT_SECONDS: 60, PADS_P: "", PADS_Q: "", SIDES: "base" };
  mkdirSync(join(work, "plan"), { recursive: true });
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "plan", "resolved.sh"), Object.entries(vars).map(([k, v]) => `${k}='${v}'\n`).join(""));
  for (const [f, text] of [["headers.txt", ""], ["mask.sed", ""], ["mask.json", "[]\n"], ["request.lua", ""]]) writeFileSync(join(work, "plan", f), text);
  writeFileSync(join(work, "bin", "base"), fixture(kind, life), { mode: 0o755 });
  t.after(() => settle(work, life + 5000));
  return { work, args: [join(here, "verify.sh"), work, join(work, "verify")] };
}

/** verify.sh on such a work directory; killed, through its handle, at 60 s. */
async function verify(t, name, path, options) {
  const { work, args } = prepare(t, name, path, options), began = Date.now();
  const r = spawnSync("sh", args, { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" });
  const seconds = (Date.now() - began) / 1000;
  return { ...r, seconds, pids: lines(join(work, "pids")), left: await living(work), said: (r.stdout ?? "") + (r.stderr ?? "") };
}

/**
 * verify.sh on such a work directory, with signal sent to verify.sh itself (through its handle)
 * once the file of the work directory named by when holds count lines; killed at 60 s. env: the
 * environment verify.sh is run with.
 */
async function interrupted(t, name, path, when, signal, { count = 1, env = process.env, ...options } = {}) {
  const { work, args } = prepare(t, name, path, options), began = Date.now();
  const child = spawn("sh", args, { stdio: ["ignore", "pipe", "pipe"], env });
  let said = "";
  child.stdout.on("data", (d) => { said += d; });
  child.stderr.on("data", (d) => { said += d; });
  const ended = new Promise((done) => child.on("close", (status, sig) => done({ status, signal: sig })));
  const limit = setTimeout(() => child.kill("SIGKILL"), 60000);
  while (lines(join(work, when)).length < count && child.exitCode === null && Date.now() - began < 30000) await sleep(20);
  const sent = lines(join(work, when)).length >= count && child.exitCode === null;
  if (sent) child.kill(signal);
  const sentAt = (Date.now() - began) / 1000;
  const end = await ended;
  clearTimeout(limit);
  const seconds = (Date.now() - began) / 1000;
  return { ...end, sent, sentAt, seconds, work, said };
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

test("verify.sh, sent TERM while it stops a base that ignores TERM, finishes the stop before it ends, and nothing is left listening", LINUX, async (t) => {
  // A failed request ends verify.sh while the base runs; the base's own record of TERM says the
  // stop has begun, and TERM is then sent to verify.sh, which must not cut that stop short.
  const r = await interrupted(t, "term-during-stop", "/drop", "terms", "SIGTERM");
  assert.ok(r.sent, `the stop never began, or verify.sh ended before TERM could be sent: ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  assert.equal(lines(join(r.work, "pids")).length, 1, r.said);
  assert.deepEqual(await living(r.work), [], `the server verify.sh started is still running after verify.sh ended: ${r.said}`);
  assert.ok(!taken(), "something still answers on 18083");
  assert.ok(r.seconds < 30, `verify.sh took ${r.seconds} s to stop its server`);
});

test("verify.sh, killed while a base that ignores TERM runs, still has that base stopped within a bound", LINUX, async (t) => {
  // verify.sh sends no signal by number: its server is stopped by serve.mjs when verify.sh's end
  // of serve.mjs's input closes, which a KILL of verify.sh closes too.
  const r = await interrupted(t, "killed", "/hang", "hung", "SIGKILL");
  assert.ok(r.sent, `the request never reached the base, or verify.sh ended before it could be killed: ${r.said}`);
  let left = [];
  for (let i = 0; i < 150; i++) { left = await living(r.work); if (left.length === 0) break; await sleep(100); }
  assert.equal(lines(join(r.work, "pids")).length, 1, r.said);
  assert.deepEqual(left, [], "the server verify.sh started was still running 15 s after verify.sh was killed");
  assert.ok(!taken(), "something still answers on 18083");
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
  assert.ok(end.said.includes("serve: stopped by SIGTERM, not by verify.sh; stopping the server"), end.said);
  assert.equal(await alive(sock), false, "the server is still running");
  s.child.stdin.destroy();
});
