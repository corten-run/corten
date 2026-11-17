import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { records } from "./fixtures.mjs";
import { verifyControl } from "./apparatus.mjs";

const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start(t) {
  const folder = mkdtempSync(join(here, ".worker-test-"));
  const fixture = join(folder, "catalog.json"); writeFileSync(fixture, JSON.stringify(records()));
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ["--max-old-space-size=64", join(here, "upstream.mjs"), "--fixed-workers"], {
    cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, PORT: String(port), CATALOG_FIXTURE_PATH: fixture },
  });
  let output = ""; const keep = (b) => { output = (output + b).slice(-16000); };
  child.stdout.on("data", keep); child.stderr.on("data", keep);
  const done = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  const listening = new Promise((resolve, reject) => {
    child.on("message", (m) => { if (m.type === "catalog-ready") resolve(m); }); child.on("error", reject);
    done.then(() => reject(new Error(`worker exited before readiness: ${output}`)));
  });
  const deadline = setTimeout(() => child.kill(), 12000);
  let state;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await done; clearTimeout(deadline);
    assert.equal(dirname(folder), here); rmSync(folder, { recursive: true, force: true });
  });
  const read = (path, value) => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, agent: false,
      method: value === undefined ? "GET" : "POST", headers: { Connection: "close" }, timeout: 5000 }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (s) => { body += s; if (body.length > 1024 * 1024) req.destroy(new Error("response bound")); });
      res.on("end", () => resolve({ code: res.statusCode, body })); res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request deadline"))); req.on("error", reject);
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
  const ready = await listening;
  assert.equal(ready.identities.length, 3);
  assert.equal((await read("/health")).code, 200);
  const control = async (value) => { const r = await read(value?.observation ? "/__catalog/observe" : "/__catalog/control", value); assert.equal(r.code, 200, output); state = JSON.parse(r.body); return state; };
  return { child, read, control, done, output: () => output };
}

test("two real HTTP workers acknowledge shared reset/override/status epochs and exact local-count aggregates", { timeout: 12000 }, async (t) => {
  const p = await start(t), catalog = records();
  const initial = await p.control({});
  const ids = verifyControl(initial); assert.equal(new Set(ids.map((i) => i.pid)).size, 3);
  assert.equal(initial.epoch, 1);
  for (let i = 0; i < 12; i++) assert.equal((await p.read("/catalog/records/record_1")).body, JSON.stringify(catalog.record_1));
  const counted = await p.control(); verifyControl(counted); assert.equal(counted.requests.record_1, 12);
  assert.ok(counted.workers.every((w) => w.requests.record_1 > 0), "both request loops must serve HTTP");
  await Promise.all([p.control(), ...Array.from({ length: 8 }, () => p.read("/catalog/records/record_1"))]);
  const concurrent = await p.control(); verifyControl(concurrent); assert.equal(concurrent.requests.record_1, 20);
  const changed = { ...catalog.record_1, title: "changed & <escaped>" };
  const overridden = await p.control({ record: changed, pretty: true });
  assert.equal(overridden.epoch, 2); verifyControl(overridden); assert.equal(Object.keys(overridden.requests).length, 0);
  for (let i = 0; i < 4; i++) assert.equal((await p.read("/catalog/records/record_1?x=1")).body, JSON.stringify(changed, null, 2));
  const bad = await p.read("/__catalog/control", { status: 500 }); assert.equal(bad.code, 400);
  assert.equal((await p.control()).epoch, 2);
  const unavailable = await p.control({ status: 503 }); assert.equal(unavailable.epoch, 3); verifyControl(unavailable);
  for (let i = 0; i < 4; i++) assert.equal((await p.read("/catalog/records/record_1")).code, 503);
  const resets = await Promise.all([p.control({}), p.control({})]);
  assert.equal(new Set(resets.map((r) => r.epoch)).size, 2);
  assert.equal((await p.control()).epoch, 5);
  await p.control({ observation: "begin", seconds: 1 });
  await sleep(550);
  const observation = await p.control({ observation: "end" });
  assert.equal(observation.processes.length, 3);
  for (const process of observation.processes) {
    assert.ok(process.samples.length >= 2);
    assert.ok(process.samples.at(-1).cpuUsec >= process.samples[0].cpuUsec);
    assert.ok(BigInt(process.samples.at(-1).beginNs) > BigInt(process.samples[0].endNs));
  }
});

test("lost request worker terminates its coordinator and sibling without replacement", { timeout: 12000 }, async (t) => {
  const p = await start(t), state = await p.control();
  process.kill(state.workers[0].identity.pid);
  const result = await p.done;
  assert.equal(result.code, 1, p.output());
  assert.throws(() => process.kill(state.workers[1].identity.pid, 0), /ESRCH/);
});

test("cancellation during active observation drains all owned HTTP workers", { timeout: 12000 }, async (t) => {
  const p = await start(t), state = await p.control();
  await p.control({ observation: "begin", seconds: 1 });
  p.child.kill("SIGINT");
  await p.done;
  // Windows terminates only the coordinator; IPC disconnect must drain each worker.
  for (const w of state.workers) {
    for (let i = 0; i < 20; i++) {
      try { process.kill(w.identity.pid, 0); } catch (e) { assert.equal(e.code, "ESRCH"); break; }
      if (i === 19) assert.fail("worker survived coordinator termination");
      await sleep(20);
    }
  }
});
