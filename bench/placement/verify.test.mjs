// verify.sh on a server of its own, on Linux alone: however verify.sh ends, it stops the base's
// server within a bound, a server that ignores TERM too, and leaves nothing listening. The plan
// names no placement, so what is run is verify.sh's two starts of the base and nothing after them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
// ignores TERM and writes its pid beside the work directory's bin/, as verify.sh starts it.
const STUBBORN = `#!/usr/bin/env node
require("node:fs").appendFileSync(require("node:path").join(__dirname, "..", "pids"), process.pid + "\\n");
process.on("SIGTERM", () => {});
require("node:http").createServer((q, s) => { if (q.url === "/drop") s.socket.destroy(); else s.end("ok"); }).listen(Number(process.argv[2]), "127.0.0.1");
`;

/** verify.sh on a work directory whose base is that server (or, yielding, one that ends on TERM), for the request path given; killed at 60 s. */
function verify(name, path, { yielding = false } = {}) {
  const cpu = /: *(\d+)/.exec(spawnSync("taskset", ["-cp", String(process.pid)], { encoding: "utf8" }).stdout)?.[1];
  assert.ok(cpu, "taskset names no CPU this process may run on");
  assert.ok(!taken(), "port 18083 is in use, and verify.sh's port is fixed: this test needs it free");
  const work = join(tmp, name), vars = { WORK: work, KIT: here, START: "$BIN $PORT", REQ_PATH: path, STATUS: 200, EVENTS: "cycles:u", CPU_SERVER: cpu, CPU_LOAD: cpu, CPU_DRIVER: cpu, WRK_T: 1, WRK_C: 1, TURN: 1, W: "plain", PLACEMENT_SECONDS: 60, PADS_P: "", PADS_Q: "", SIDES: "base" };
  mkdirSync(join(work, "plan"), { recursive: true });
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "plan", "resolved.sh"), Object.entries(vars).map(([k, v]) => `${k}='${v}'\n`).join(""));
  for (const [f, text] of [["headers.txt", ""], ["mask.sed", ""], ["mask.json", "[]\n"], ["request.lua", ""]]) writeFileSync(join(work, "plan", f), text);
  writeFileSync(join(work, "bin", "base"), yielding ? STUBBORN.replace('process.on("SIGTERM", () => {});\n', "") : STUBBORN, { mode: 0o755 });
  const began = Date.now();
  const r = spawnSync("sh", [join(here, "verify.sh"), work, join(work, "verify")], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" });
  const seconds = (Date.now() - began) / 1000;
  let pids = [];
  try { pids = readFileSync(join(work, "pids"), "utf8").split("\n").filter(Boolean).map(Number); } catch {}
  const left = pids.filter(running);
  for (const pid of left) process.kill(pid, "SIGKILL");
  return { ...r, seconds, pids, left, said: (r.stdout ?? "") + (r.stderr ?? "") };
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
