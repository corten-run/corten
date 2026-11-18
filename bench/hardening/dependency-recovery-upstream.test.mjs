import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { records } from "../marketplace/fixtures.mjs";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { delayMs, dependencyRecoveryServer, statusPath, watchRecoveryTrigger, windowMs } from "./dependency-recovery-upstream.mjs";

const control = "/__marketplace/control";
const first = "/marketplace/records/item_1";
const post = value => ({ method: "POST", body: JSON.stringify(value) });
const totals = (normal, slow, restored) => ({ normal, slow, restored });

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, options) => fetch(base + path, { signal: AbortSignal.timeout(3000), redirect: "manual", ...options });
}

async function answer(res) {
  return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body: await res.text() };
}

test("normal reads and qualification controls match the ordinary marketplace upstream", async t => {
  const data = records(), recovery = dependencyRecoveryServer(data);
  const wrapped = await listen(t, recovery.server), ordinary = await listen(t, marketplaceServer(data));
  for (const [path, options] of [[first], ["/marketplace/records/item_500"],
    ["/marketplace/records/item_501"], ["/health"], [control],
    [control, post({ record: { ...data.item_1, title: "Qualification override" }, pretty: true })], [first],
    [control, post({ status: 503 })], [first], [control, post({})], [first], [control]]) {
    assert.deepEqual(await answer(await wrapped(path, options)), await answer(await ordinary(path, options)));
  }
  assert.equal(recovery.snapshot().phase, "normal");
  assert.equal(recovery.snapshot().elapsedSinceStartMs, null);
});

test("only record reads receive 150 ms in the single eight-second window", { timeout: 6000 }, async t => {
  const data = records();
  let now = 100, release, waits = 0, entered;
  const enteredWait = new Promise(resolve => { entered = resolve; });
  const recovery = dependencyRecoveryServer(data, { now: () => now, wait(ms) {
    waits++;
    assert.equal(ms, 150);
    return new Promise(resolve => { release = resolve; entered(); });
  } });
  const request = await listen(t, recovery.server);
  const status = async () => (await request(statusPath)).json();
  assert.equal((await request(statusPath, post({ delayMs: 9000 }))).status, 405);
  assert.equal((await request(control, post({ hang: true }))).status, 200);
  assert.equal((await status()).elapsedSinceStartMs, null);
  assert.deepEqual((await status()).reads, totals(0, 0, 0));
  await request(control, post({}));
  assert.equal(await (await request(first)).text(), JSON.stringify(data.item_1));
  await request(control, post({ status: 503, hang: true }));
  assert.equal(recovery.start(), true);
  assert.equal(windowMs, 8000);
  assert.equal((await status()).elapsedSinceStartMs, 0);
  assert.equal((await request(control, post({ hang: true }))).status, 405);
  assert.equal((await request("/health")).status, 200);
  assert.equal((await request("/not-a-record")).status, 404);
  assert.equal((await request(first, { method: "POST" })).status, 404);
  assert.equal(waits, 0);

  now += windowMs - 1;
  const delayed = request(first + "?delayMs=1");
  await enteredWait;
  assert.equal(recovery.start(), false);
  const active = await status();
  assert.equal(active.phase, "slow");
  assert.equal(active.elapsedSinceStartMs, windowMs - 1);
  assert.deepEqual(active.reads, totals(1, 1, 0));
  assert.deepEqual(active.responses200, totals(1, 0, 0));
  now++;
  assert.equal((await status()).phase, "restored");
  assert.equal((await status()).elapsedSinceStartMs, windowMs);
  assert.equal(await (await request(first)).text(), JSON.stringify(data.item_1));
  assert.equal(waits, 1);
  release();
  assert.equal(await (await delayed).text(), JSON.stringify(data.item_1));
  assert.equal(recovery.start(), false);
  assert.deepEqual((await status()).responses200, totals(1, 1, 1));
  assert.equal((await request(control, post({}))).status, 405);
});

test("the default delay waits on a real clock and returns an identical response", async t => {
  const data = records(), recovery = dependencyRecoveryServer(data);
  const request = await listen(t, recovery.server);
  const normal = await answer(await request(first));
  recovery.start();
  const before = performance.now();
  assert.deepEqual(await answer(await request(first)), normal);
  assert.ok(performance.now() - before >= delayMs - 1);
  assert.deepEqual(recovery.snapshot().responses200, totals(1, 1, 0));
});

test("the capture controller has fresh counters and is isolated from an in-flight qualification POST", { timeout: 4000 }, async t => {
  const data = records();
  const recovery = dependencyRecoveryServer(data, { wait: async () => {} });
  const request = await listen(t, recovery.server);
  const override = { ...data.item_1, title: "Qualification override" };
  assert.equal((await request(control, post({ record: override }))).status, 200);
  assert.deepEqual(await (await request(first)).json(), override);
  assert.deepEqual(await (await request(control)).json(), { requests: { item_1: 1 }, status: 200, answers: { 200: 1 } });

  const body = JSON.stringify({ status: 503, hang: true });
  const dispatched = new Promise(resolve => recovery.server.prependOnceListener("request", resolve));
  const pending = httpRequest({ host: "127.0.0.1", port: recovery.server.address().port, path: control,
    method: "POST", headers: { "Content-Length": Buffer.byteLength(body) } });
  const completed = new Promise((resolve, reject) => {
    pending.on("error", reject);
    pending.on("response", res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
      res.on("error", reject);
    });
  });
  t.after(() => pending.destroy());
  pending.flushHeaders();
  await dispatched;
  assert.equal(recovery.start(), true);
  pending.end(body);
  assert.equal(await completed, 200);
  assert.deepEqual(await (await request(control)).json(), { requests: {}, status: 200, answers: {} });
  assert.deepEqual(await (await request(first)).json(), data.item_1);
  assert.deepEqual(await (await request(control)).json(), { requests: { item_1: 1 }, status: 200, answers: { 200: 1 } });
  assert.deepEqual(recovery.snapshot().responses200, totals(1, 1, 0));
});

test("the private marker is unchanged and observed restore is within 100 ms", { timeout: 12000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "corten-recovery-")), file = join(directory, "start");
  t.after(() => { unlinkSync(file); rmdirSync(directory); });
  const recovery = dependencyRecoveryServer(records()), stop = new AbortController();
  t.after(() => stop.abort());
  const request = await listen(t, recovery.server);
  const watched = watchRecoveryTrigger(directory, recovery.start, { signal: stop.signal });
  assert.equal(recovery.snapshot().phase, "normal");
  const expectedRestoreAt = performance.now() + windowMs;
  writeFileSync(file, "probe-owned marker", { flag: "wx" });
  await watched;
  assert.equal(recovery.snapshot().phase, "slow");
  assert.deepEqual(recovery.snapshot().reads, totals(0, 0, 0));
  assert.equal(readFileSync(file, "utf8"), "probe-owned marker");
  assert.deepEqual(readdirSync(directory), ["start"]);
  await assert.rejects(watchRecoveryTrigger(directory, recovery.start), /already exists/);

  await sleep(Math.max(0, expectedRestoreAt - performance.now() - 50));
  let restored, observedAt;
  do {
    restored = await (await request(statusPath)).json();
    observedAt = performance.now();
    if (restored.phase === "restored") break;
    await sleep(10);
  } while (performance.now() < expectedRestoreAt + 100);
  assert.equal(restored.phase, "restored");
  const driftMs = observedAt - expectedRestoreAt;
  t.diagnostic(`Restore observed ${driftMs.toFixed(1)} ms after the trigger-relative deadline`);
  assert.ok(Math.abs(driftMs) <= 100, `restore observation drifted ${driftMs.toFixed(1)} ms`);
  assert.ok(restored.elapsedSinceStartMs >= windowMs);
});

test("polling stops without activation on cancellation and rejects a non-file trigger", { timeout: 4000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "corten-recovery-")), marker = join(directory, "start");
  let started = false;
  t.after(() => { rmdirSync(marker); rmdirSync(directory); });
  const stop = new AbortController(), start = () => { started = true; };
  const watched = watchRecoveryTrigger(directory, start, { signal: stop.signal });
  stop.abort();
  await watched;
  const invalid = watchRecoveryTrigger(directory, start);
  mkdirSync(marker);
  await assert.rejects(invalid, /must be a regular file/);
  assert.equal(started, false);
});

test("a cancelled record read aborts its delay and does not count as a 200", { timeout: 4000 }, async t => {
  let started, ended;
  const waiting = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { ended = resolve; });
  const recovery = dependencyRecoveryServer(records(), { wait(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { ended(); reject(signal.reason); }, { once: true });
      started();
    });
  } });
  const request = await listen(t, recovery.server), stop = new AbortController();
  recovery.start();
  const response = assert.rejects(request(first, { signal: stop.signal }), { name: "AbortError" });
  await waiting;
  stop.abort();
  await response;
  await stopped;
  assert.deepEqual(recovery.snapshot().reads, totals(0, 1, 0));
  assert.deepEqual(recovery.snapshot().responses200, totals(0, 0, 0));
});
