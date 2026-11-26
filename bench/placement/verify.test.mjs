// verify.sh on a server of its own, on Linux alone: however verify.sh ends, a signal during the
// stop and a KILL of verify.sh included, the base's server is stopped within a bound, a server
// that ignores TERM too, and nothing is left listening. The plan names no placement, so what is
// run is verify.sh's two starts of the base and nothing after them. Then serve.mjs, which runs
// each start, on its own.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tools = process.platform === "linux" && spawnSync("sh", ["-c", "command -v taskset && command -v timeout && command -v curl"]).status === 0;
const LINUX = { skip: tools ? false : "needs Linux with taskset, timeout and curl" };
const tmp = tools ? realpathSync(mkdtempSync(join(tmpdir(), "placement-verify-"))) : null;
after(() => tmp && rmSync(tmp, { recursive: true, force: true }));
const taken = () => spawnSync("curl", ["-s", "-o", "/dev/null", "--max-time", "1", "http://127.0.0.1:18083/"]).status !== 7;
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A server that answers readiness and the request, drops the connection of a request for /drop,
// never answers one for /hang, ignores TERM and writes its pid beside the work directory's bin/,
// as verify.sh starts it: to pids when it starts, to terms when it is sent TERM and to hung when
// it is asked for /hang.
const STUBBORN = `#!/usr/bin/env node
const at = (f) => require("node:path").join(__dirname, "..", f), note = (f) => require("node:fs").appendFileSync(at(f), process.pid + "\\n");
note("pids");
process.on("SIGTERM", () => note("terms"));
require("node:http").createServer((q, s) => { if (q.url === "/drop") s.socket.destroy(); else if (q.url === "/hang") note("hung"); else s.end("ok"); }).listen(Number(process.argv[2]), "127.0.0.1");
`;
const lines = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; } };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A work directory whose base is that server (or, yielding, one that ends on TERM), for the request path given, and the verify.sh command that checks it. */
function prepare(name, path, { yielding = false } = {}) {
  const cpu = /: *(\d+)/.exec(spawnSync("taskset", ["-cp", String(process.pid)], { encoding: "utf8" }).stdout)?.[1];
  assert.ok(cpu, "taskset names no CPU this process may run on");
  assert.ok(!taken(), "port 18083 is in use, and verify.sh's port is fixed: this test needs it free");
  const work = join(tmp, name), vars = { WORK: work, KIT: here, START: "$BIN $PORT", REQ_PATH: path, STATUS: 200, EVENTS: "cycles:u", CPU_SERVER: cpu, CPU_LOAD: cpu, CPU_DRIVER: cpu, WRK_T: 1, WRK_C: 1, TURN: 1, W: "plain", PLACEMENT_SECONDS: 60, PADS_P: "", PADS_Q: "", SIDES: "base" };
  mkdirSync(join(work, "plan"), { recursive: true });
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "plan", "resolved.sh"), Object.entries(vars).map(([k, v]) => `${k}='${v}'\n`).join(""));
  for (const [f, text] of [["headers.txt", ""], ["mask.sed", ""], ["mask.json", "[]\n"], ["request.lua", ""]]) writeFileSync(join(work, "plan", f), text);
  writeFileSync(join(work, "bin", "base"), yielding ? STUBBORN.replace('process.on("SIGTERM", () => note("terms"));\n', "") : STUBBORN, { mode: 0o755 });
  return { work, args: [join(here, "verify.sh"), work, join(work, "verify")] };
}
/** The servers verify.sh started under work, those of them still running (each then killed, so a failed test leaves none). */
function servers(work) {
  const pids = lines(join(work, "pids")), left = pids.filter(running);
  for (const pid of left) process.kill(pid, "SIGKILL");
  return { pids, left };
}

/** verify.sh on such a work directory; killed at 60 s. */
function verify(name, path, options) {
  const { work, args } = prepare(name, path, options), began = Date.now();
  const r = spawnSync("sh", args, { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" });
  const seconds = (Date.now() - began) / 1000;
  return { ...r, seconds, ...servers(work), said: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** verify.sh on such a work directory, with signal sent to verify.sh itself once the file of the work directory named by when holds a line; killed at 60 s. */
async function interrupted(name, path, when, signal) {
  const { work, args } = prepare(name, path), began = Date.now();
  const child = spawn("sh", args, { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stdout.on("data", (d) => { said += d; });
  child.stderr.on("data", (d) => { said += d; });
  const ended = new Promise((done) => child.on("close", (status, sig) => done({ status, signal: sig })));
  const limit = setTimeout(() => child.kill("SIGKILL"), 60000);
  while (lines(join(work, when)).length === 0 && child.exitCode === null && Date.now() - began < 30000) await sleep(20);
  const sent = lines(join(work, when)).length > 0 && child.exitCode === null;
  if (sent) child.kill(signal);
  const sentAt = (Date.now() - began) / 1000;
  const end = await ended;
  clearTimeout(limit);
  const seconds = (Date.now() - began) / 1000;
  return { ...end, sent, sentAt, seconds, work, said };
}

test("verify.sh stops a base that ignores TERM after its two starts, within a bound, and nothing is left listening", LINUX, () => {
  const r = verify("stubborn", "/page");
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.equal(r.status, 0, r.said);
  assert.ok(r.said.includes("verify: 0 placements answer as their unpadded binary"), r.said);
  assert.equal(r.pids.length, 2, r.said);
  assert.deepEqual(r.left, [], "a server verify.sh started is still running");
  assert.ok(r.seconds < 30, `verify.sh took ${r.seconds} s to stop two servers`);
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh, ended by a failed request while the base runs, stops that base though it ignores TERM, within a bound", LINUX, () => {
  const r = verify("dropped", "/drop");
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  assert.equal(r.pids.length, 1, r.said);
  assert.deepEqual(r.left, [], "the server verify.sh started is still running");
  assert.ok(r.seconds < 30, `verify.sh took ${r.seconds} s to stop its server`);
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh stops a base that ends on TERM without waiting out the time it gives one that does not", LINUX, () => {
  const r = verify("yielding", "/page", { yielding: true });
  assert.equal(r.error, undefined, `verify.sh did not end within 60 s (${r.seconds} s): ${r.said}`);
  assert.equal(r.status, 0, r.said);
  assert.equal(r.pids.length, 2, r.said);
  assert.deepEqual(r.left, [], "a server verify.sh started is still running");
  // Two stops held to their 5 s each would take 10 s: an exited server is seen as one at once.
  assert.ok(r.seconds < 8, `verify.sh took ${r.seconds} s to stop two servers that end on TERM`);
  assert.ok(!taken(), "something still answers on 18083");
});

test("verify.sh, sent TERM while it stops a base that ignores TERM, finishes the stop before it ends, and nothing is left listening", LINUX, async () => {
  // A failed request ends verify.sh while the base runs; the base's own record of TERM says the
  // stop has begun, and TERM is then sent to verify.sh, which must not cut that stop short.
  const r = await interrupted("term-during-stop", "/drop", "terms", "SIGTERM");
  assert.ok(r.sent, `the stop never began, or verify.sh ended before TERM could be sent: ${r.said}`);
  assert.notEqual(r.status, 0, r.said);
  const { pids, left } = servers(r.work);
  assert.equal(pids.length, 1, r.said);
  assert.deepEqual(left, [], `the server verify.sh started is still running after verify.sh ended: ${r.said}`);
  assert.ok(!taken(), "something still answers on 18083");
  assert.ok(r.seconds < 30, `verify.sh took ${r.seconds} s to stop its server`);
});

test("verify.sh, killed while a base that ignores TERM runs, still has that base stopped within a bound", LINUX, async () => {
  // verify.sh sends no signal by number: its server is stopped by serve.mjs when verify.sh's end
  // of serve.mjs's input closes, which a KILL of verify.sh closes too.
  const r = await interrupted("killed", "/hang", "hung", "SIGKILL");
  assert.ok(r.sent, `the request never reached the base, or verify.sh ended before it could be killed: ${r.said}`);
  let left = [];
  for (let i = 0; i < 150; i++) { left = lines(join(r.work, "pids")).filter(running); if (left.length === 0) break; await sleep(100); }
  const { pids } = servers(r.work);
  assert.equal(pids.length, 1, r.said);
  assert.deepEqual(left, [], "the server verify.sh started was still running 15 s after verify.sh was killed");
  assert.ok(!taken(), "something still answers on 18083");
});

// serve.mjs on its own: what verify.sh relies on to stop a server. POSIX alone, for its signals.
const POSIX = { skip: process.platform === "win32" ? "needs POSIX signals" : false };
/** serve.mjs running a node script as its server, its input a pipe this test holds. */
function serve(script) {
  const child = spawn(process.execPath, [join(here, "serve.mjs"), process.execPath, "-e", script], { stdio: ["pipe", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  const ended = new Promise((done) => child.on("close", (status, signal) => done({ status, signal, said })));
  return { child, ended };
}
const pidOf = async (file) => { for (let i = 0; i < 200; i++) { const [pid] = lines(file); if (pid) return pid; await sleep(25); } return null; };

test("serve.mjs stops its server when its input ends: TERM, KILL 5 s later for one that ignores TERM, and nothing after", POSIX, async () => {
  const dir = mkdtempSync(join(tmpdir(), "placement-serve-")), file = join(dir, "pid");
  try {
    for (const [ignores, most] of [[true, 9], [false, 2]]) {
      const s = serve(`require("node:fs").writeFileSync(${JSON.stringify(file)}, process.pid + "\\n"); ${ignores ? 'process.on("SIGTERM", () => {}); ' : ""}setInterval(() => {}, 1000);`);
      const pid = await pidOf(file);
      assert.ok(pid, "the server never started");
      const began = Date.now();
      s.child.stdin.end();
      const end = await s.ended, seconds = (Date.now() - began) / 1000;
      assert.equal(end.status, 0, end.said);
      assert.equal(running(pid), false, "the server is still running");
      assert.ok(ignores ? seconds >= 4.5 && seconds < most : seconds < most, `stopped in ${seconds} s (ignores TERM: ${ignores})`);
      rmSync(file, { force: true });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("serve.mjs ends, saying so, when its server ends before it is stopped, so it never signals a server that has gone; and stops its server when it is itself sent TERM", POSIX, async () => {
  const early = serve("process.exit(0);");
  const gone = await early.ended;
  assert.equal(gone.status, 1, gone.said);
  assert.ok(gone.said.includes("serve: the server ended before it was stopped (exit 0)"), gone.said);
  const dir = mkdtempSync(join(tmpdir(), "placement-serve-")), file = join(dir, "pid");
  try {
    const s = serve(`require("node:fs").writeFileSync(${JSON.stringify(file)}, process.pid + "\\n"); setInterval(() => {}, 1000);`);
    const pid = await pidOf(file);
    assert.ok(pid, "the server never started");
    s.child.kill("SIGTERM");
    const end = await s.ended;
    assert.equal(end.status, 1, end.said);
    assert.ok(end.said.includes("serve: stopped by SIGTERM, not by verify.sh; stopping the server"), end.said);
    assert.equal(running(pid), false, "the server is still running");
    s.child.stdin.destroy();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});