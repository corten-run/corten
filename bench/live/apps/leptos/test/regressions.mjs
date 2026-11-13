// Native browser regressions. Faults delay real HTTP responses, never fabricate wire/state.
// Label a fresh app-local build bench.source-sha256=$(node this-file --source-hash).
// LIVE_CONTAINER verifies that full context hash, immutable image id and mapped HTTP target.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { wireEvents } from '../wire.mjs';

const [base, selection = 'detach,overlap,cleanup-disconnect,cleanup-detach,watchdog'] = process.argv.slice(2);
assert.ok(base, 'native application URL required');
const sha = value => createHash('sha256').update(value).digest('hex');
async function sourceHashes(directory = new URL('../', import.meta.url), prefix = '') {
  const hashes = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name;
    if (['target', 'node_modules', 'test/evidence'].includes(name)) continue;
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) Object.assign(hashes, await sourceHashes(path, name + '/'));
    else { assert.ok(entry.isFile(), `unreviewed context entry ${name}`); hashes[name] = sha(await readFile(path)); }
  }
  return hashes;
}
const sources = await sourceHashes(), sourceSha256 = sha(JSON.stringify(sources));
if (base === '--source-hash') { console.log(sourceSha256); process.exit(0); }
let provenance = { qualification: false, scope: 'runtime diagnostic, served bridge hash checked; not exact-commit qualification' };
if (process.env.LIVE_CONTAINER) {
  const inspect = (kind, target, format) => JSON.parse(execFileSync('docker', [kind, 'inspect', '--format', format, target], { encoding: 'utf8' }));
  const container = inspect('container', process.env.LIVE_CONTAINER,
    '{"image":{{json .Image}},"ports":{{json .NetworkSettings.Ports}},"labels":{{json .Config.Labels}}}');
  const image = inspect('image', container.image, '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}');
  assert.equal(image.labels['bench.source-sha256'], sourceSha256, 'image was not built from the entire current app context');
  assert.equal(container.labels['agent.owner'], 'codex');
  const url = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.ok(container.ports['8080/tcp'].some(p => p.HostIp === '127.0.0.1' && p.HostPort === url.port), 'HTTP target differs from the inspected image deployment');
  provenance = { qualification: false, scope: 'full app context/image/deployment binding checked; local functional proof only',
    sourceSha256, sources, imageId: image.id, container: process.env.LIVE_CONTAINER };
}
const row = { id: 'one', version: 0, priceCents: 100, quantity: 1 };
const event = seq => ({ seq, effectId: `regression-${seq}`, key: row.id, op: 'upsert', row: { ...row, version: seq } });
const browser = await chromium.launch({ headless: true });
const localBridgeSha256 = sha(await readFile(new URL('../public/bridge.js', import.meta.url)));
const settings = { maxCleanupMs: 5000 };
function budget(ms) {
  const controller = new AbortController(); let timer;
  const reset = duration => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('native regression deadline exceeded')), duration); };
  reset(ms);
  return { signal: controller.signal, reset, dispose: () => clearTimeout(timer),
    wait: promise => new Promise((resolve, reject) => {
      const finish = (settle, value) => { controller.signal.removeEventListener('abort', abort); settle(value); };
      const abort = () => finish(reject, controller.signal.reason);
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
      if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true });
    }) };
}
function deferred(signal) {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  const abort = () => reject(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const clear = () => signal?.removeEventListener('abort', abort);
  promise.then(clear, clear);
  return { promise, resolve, reject };
}

try {
for (const name of selection.split(',')) {
  assert.ok(['detach', 'overlap', 'cleanup-disconnect', 'cleanup-detach', 'watchdog'].includes(name));
  const readers = [], controls = [], faults = [], releases = [];
  const deadline = budget(45000);
  let backup, watchdogStartedAt;
  async function api(path, input, signal = deadline.signal) {
    const response = await fetch(`${base}/parity/${path}`, input === undefined ? { signal } : {
      signal,
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const body = await response.json(); controls.push({ path, input, status: response.status, body });
    assert.equal(response.status, 200); return body;
  }
  async function resources(count) {
    const end = performance.now() + settings.maxCleanupMs;
    for (;;) {
      const r = await api('resources');
      if (r.subscriptions === count && r.connections === count && r.pendingTasks === count && r.queueEvents === 0) return r;
      assert.ok(performance.now() < end, `actual server readers did not reach ${count}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  function pending(r, promise) {
    promise.catch(() => {}); // Preserve the original rejection for the bounded capture drain.
    r.pending.push(promise);
  }
  async function open() {
    const context = await browser.newContext(), page = await context.newPage();
    const r = { context, page, network: [], pending: [], errors: [] }; readers.push(r);
    page.setDefaultTimeout(15000);
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    cdp.on('Network.eventSourceMessageReceived', data => r.network.push({ kind: 'native-sse', ...data }));
    cdp.on('Network.loadingFailed', data => r.network.push({ kind: 'native-loading-failed', ...data }));
    page.on('pageerror', error => r.errors.push(error.message));
    page.on('request', request => r.network.push({ kind: 'request', url: request.url(), method: request.method(), body: request.postData() }));
    page.on('response', response => {
      const entry = { kind: 'response', url: response.url(), status: response.status() }; r.network.push(entry);
      if (response.headers()['content-type']?.includes('application/json')) {
        pending(r, response.text().then(body => { entry.body = body; }));
      }
    });
    assert.equal((await deadline.wait(page.goto(base))).status(), 200);
    const bridgeResponse = await deadline.wait(context.request.get(base + '/bridge.js'));
    r.servedBridgeSha256 = sha(await deadline.wait(bridgeResponse.body()));
    assert.equal(r.servedBridgeSha256, localBridgeSha256, 'loaded bridge differs from the local source under test');
    await deadline.wait(page.waitForFunction(() => !!window.liveApp));
    await deadline.wait(page.evaluate(settings => window.liveApp.setup(settings), settings));
    return r;
  }
  const call = (r, method, arg) => deadline.wait(r.page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg }));
  const dom = r => r.page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('#listings > li'), li => ({ id: li.dataset.key,
      version: +li.querySelector('.version').textContent, priceCents: +li.querySelector('.price').textContent,
      quantity: +li.querySelector('.quantity').textContent })),
    effectCount: Number(document.querySelector('#effect-count').textContent),
  }));
  const wait = async (r, through) => { await deadline.wait(r.page.waitForFunction(n => window.liveApp.through === n, through)); await call(r, 'settle'); };
  let failure;
  try {
    await api('configure', { initial: [row], queueLimit: 2, historyLimit: 4 });
    if (name === 'detach') {
      const a = await open(), b = await open();
      await resources(2);
      const detachedDom = await dom(a);
      await call(a, 'detach'); await call(a, 'released');
      assert.equal((await resources(1)).subscriptions, 1, 'healthy peer was not retained');
      for (const seq of [1, 2]) { await call(b, 'publish', event(seq)); await wait(b, seq); }
      assert.deepEqual(await dom(a), detachedDom, 'detached native component changed');
      assert.deepEqual(await dom(b), { rows: [event(2).row], effectCount: 2 });
      assert.equal((await call(a, 'released')).subscriptions, 1); // Actual healthy peer, not a fabricated zero.
      assert.equal((await resources(1)).connections, 1);
      assert.deepEqual(wireEvents(a.network), []);
      assert.deepEqual(wireEvents(b.network), [event(1), event(2)]);
      await call(b, 'detach'); await resources(0);
    } else if (name.startsWith('cleanup-')) {
      settings.maxCleanupMs = 100;
      const r = await open(), accepted = deferred(deadline.signal), release = deferred(); releases.push(release);
      await r.page.route('**/parity/publish', async route => {
        const response = await route.fetch(), body = await response.body();
        assert.equal(response.status(), 200); accepted.resolve();
        await release.promise; await route.fulfill({ response, body });
      });
      try {
        await deadline.wait(r.page.evaluate(e => {
          window.heldWrite = window.liveApp.publish(e); window.heldWrite.catch(() => {});
        }, event(1)));
        await deadline.wait(accepted.promise);
        while (!wireEvents(r.network).length) {
          deadline.signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 10));
        }
        await deadline.wait(r.page.evaluate(method => { window.cleanupOutcome = { status: 'pending', startedAt: performance.now() };
          window.cleanupAttempt = window.liveApp[method]().then(() => { window.cleanupOutcome.status = 'resolved'; }, error => {
            window.cleanupOutcome.status = 'rejected'; window.cleanupOutcome.error = error.message;
          }).finally(() => { window.cleanupOutcome.elapsedMs = performance.now() - window.cleanupOutcome.startedAt; });
        }, name.slice('cleanup-'.length)));
        await r.page.waitForTimeout(500);
        assert.equal((await resources(0)).subscriptions, 0);
        const outcome = await r.page.evaluate(() => window.cleanupOutcome); faults.push({ kind: 'held-ack-cleanup', outcome });
        assert.equal(outcome.status, 'rejected', 'cleanup work drain escaped its original deadline');
        assert.match(outcome.error, /native reader not released/);
        assert.ok(outcome.elapsedMs < 400);
        assert.deepEqual(await dom(r), { rows: [row], effectCount: 0 }, 'cleanup timeout advanced an unacknowledged effect');
      } finally { release.resolve(); await deadline.wait(r.page.evaluate(() => Promise.all([window.heldWrite, window.cleanupAttempt]))); settings.maxCleanupMs = 5000; }
      const records = await r.page.evaluate(() => window.liveApp.records);
      const applied = records.findIndex(r => r.kind === 'event' && r.disposition === 'applied');
      if (name === 'cleanup-disconnect') assert.ok(applied > records.findIndex(r => r.kind === 'publish'));
      else assert.equal(applied, -1);
      await resources(0);
    } else {
      const r = await open(), committed = deferred(deadline.signal), releaseFirst = deferred(), receivedSecond = deferred(deadline.signal), releaseSecond = deferred();
      releases.push(releaseFirst, releaseSecond);
      r.page.on('response', response => {
        if (new URL(response.url()).pathname === '/parity/publish') pending(r, response.json().then(body => {
          if (body.seq === 2) receivedSecond.resolve();
        }));
      });
      await r.page.route('**/parity/publish', async route => {
        const input = route.request().postDataJSON();
        if (input.event.seq === 1) {
          const response = await route.fetch(), body = await response.body();
          assert.equal(response.status(), 200); assert.equal(JSON.parse(body).seq, 1);
          faults.push({ kind: 'upstream-real-ack', body: JSON.parse(body) }); committed.resolve();
          await releaseFirst.promise;
          await route.fulfill({ response, body }).catch(error => { if (!r.page.isClosed()) throw error; });
        } else {
          await committed.promise;
          if (name !== 'watchdog') { await route.continue(); return; }
          const response = await route.fetch(), body = await response.body();
          assert.equal(response.status(), 200); assert.equal(JSON.parse(body).seq, 2);
          faults.push({ kind: 'held-real-second-ack', body: JSON.parse(body) });
          watchdogStartedAt = performance.now(); deadline.reset(100);
          backup = setTimeout(() => { releaseSecond.resolve(); receivedSecond.reject(new Error('watchdog backup after 500ms')); }, 500);
          await releaseSecond.promise; await route.fulfill({ response, body }).catch(() => {});
        }
      });
      try {
        // Both calls reserve their acknowledgement barrier in the same browser task.
        // Request 2 is forwarded only after the real server has committed request 1.
        await deadline.wait(r.page.evaluate(events => {
          window.overlappingWrites = Promise.all(events.map(e => window.liveApp.publish(e)));
          window.overlappingWrites.catch(() => {}); // Teardown still observes the original promise.
        }, [event(1), event(2)]));
        await deadline.wait(receivedSecond.promise);
        const end = performance.now() + 5000;
        while (wireEvents(r.network).length !== 2) {
          assert.ok(performance.now() < end, 'two real SSE events were not received');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await r.page.waitForTimeout(100);
        faults.push({ kind: 'before-held-response-release', dom: await dom(r), records: await r.page.evaluate(() => window.liveApp.records) });
        assert.deepEqual(await dom(r), { rows: [row], effectCount: 0 }, 'events escaped the outstanding real HTTP acknowledgement');
        assert.deepEqual(await r.page.evaluate(() => window.liveApp.records.filter(r => r.kind === 'publish')), []);
      } finally { releaseFirst.resolve(); releaseSecond.resolve(); await deadline.wait(r.page.evaluate(() => window.overlappingWrites)); }
      await wait(r, 2); await deadline.wait(Promise.all(r.pending));
      const records = await r.page.evaluate(() => window.liveApp.records);
      assert.deepEqual(records.filter(r => r.kind === 'publish').map(r => r.seq), [1, 2]);
      for (const seq of [1, 2]) assert.ok(records.findIndex(r => r.kind === 'publish' && r.seq === seq)
        < records.findIndex(r => r.kind === 'event' && r.event.seq === seq), 'effect preceded its real acknowledgement');
      const responses = r.network.filter(n => n.kind === 'response' && new URL(n.url).pathname === '/parity/publish');
      assert.deepEqual(responses.map(n => { assert.equal(n.status, 200); return JSON.parse(n.body).seq; }), [2, 1]);
      assert.deepEqual(wireEvents(r.network), [event(1), event(2)]);
      assert.deepEqual(await dom(r), { rows: [event(2).row], effectCount: 2 });
      assert.equal((await api('snapshot')).through, 2);
      await call(r, 'detach'); await resources(0);
    }
    for (const r of readers) assert.deepEqual(r.errors, []);
    console.log(`Leptos native regression ${name}: actual DOM, HTTP, native SSE and reader counters passed`);
  } catch (error) {
    if (name === 'watchdog') {
      const elapsedMs = performance.now() - watchdogStartedAt; faults.push({ kind: 'watchdog-result', elapsedMs, error: error.message });
      failure = elapsedMs < 400 && error.message.includes('native regression deadline') ? undefined
        : new Error(`watchdog did not reject the operation within its 100ms budget: ${Math.round(elapsedMs)}ms; ${error.message}`);
      if (!failure) console.log(`Leptos native watchdog: held real second acknowledgement rejected after ${Math.round(elapsedMs)}ms and reached teardown`);
    } else failure = error;
  }
  finally {
    clearTimeout(backup); settings.maxCleanupMs = 5000;
    for (const release of releases) release.resolve();
    const teardown = budget(5000);
    try {
    const captures = [];
    for (const r of readers) {
      await teardown.wait(Promise.all(r.pending)).catch(() => {});
      captures.push({ servedBridgeSha256: r.servedBridgeSha256, network: r.network, errors: r.errors,
        records: await teardown.wait(r.page.evaluate(() => window.liveApp?.records ?? [])).catch(() => []),
        dom: await teardown.wait(dom(r)).catch(() => null) });
    }
    await teardown.wait(Promise.all(readers.map(r => r.context.close())));
    for (;;) {
      const final = await api('resources', undefined, teardown.signal);
      if (final.subscriptions + final.connections + final.pendingTasks + final.queueEvents === 0) break;
      await teardown.wait(new Promise(resolve => setTimeout(resolve, 10)));
    }
    if (process.env.LIVE_EVIDENCE) {
      await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
      await writeFile(`${process.env.LIVE_EVIDENCE}/leptos-regression-${name}${failure ? '-failure' : ''}.json.gz`,
        gzipSync(JSON.stringify({ schema: 'native-leptos-regression/v1', localBridgeSha256, controls, faults, captures,
          failure: failure?.message, provenance })), { flag: 'wx' });
    }
    } finally { deadline.dispose(); teardown.dispose(); }
  }
  if (failure) throw failure;
}
} finally { await browser.close(); }
