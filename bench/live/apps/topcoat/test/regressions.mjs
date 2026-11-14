// Real native Topcoat controls: no fabricated HTTP acknowledgements or DOM renderer.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { wireEvents } from '../wire.mjs';

const [base, selection = 'peer,overlap,cleanup-disconnect,cleanup-detach'] = process.argv.slice(2);
assert.ok(base, 'native application URL required');
const sha = value => createHash('sha256').update(value).digest('hex');
async function hashes(directory = new URL('../', import.meta.url), prefix = '') {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name;
    if (['target', 'node_modules', 'test/evidence'].includes(name)) continue;
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) Object.assign(result, await hashes(path, name + '/'));
    else { assert.ok(entry.isFile()); result[name] = sha(await readFile(path)); }
  }
  return result;
}
const sources = await hashes(), sourceSha256 = sha(JSON.stringify(sources));
if (base === '--source-hash') { console.log(sourceSha256); process.exit(0); }
const bridgeSha256 = sources['static/bridge.js'];
let provenance = { qualification: false, scope: 'local functional runtime proof, served bridge hash checked' };
if (process.env.LIVE_CONTAINER) {
  const inspect = (kind, id, format) => JSON.parse(execFileSync('docker', [kind, 'inspect', '--format', format, id], { encoding: 'utf8' }));
  const container = inspect('container', process.env.LIVE_CONTAINER,
    '{"image":{{json .Image}},"ports":{{json .NetworkSettings.Ports}},"labels":{{json .Config.Labels}}}');
  const image = inspect('image', container.image, '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}');
  assert.equal(image.labels['bench.source-sha256'], sourceSha256);
  assert.equal(container.labels['agent.owner'], 'codex');
  const url = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.ok(container.ports['8080/tcp'].some(p => p.HostIp === '127.0.0.1' && p.HostPort === url.port));
  provenance = { ...provenance, scope: 'full app context/image/deployment bound, local functional proof only',
    sources, sourceSha256, imageId: image.id, container: process.env.LIVE_CONTAINER };
}
function gate() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function budget(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('native Topcoat regression deadline exceeded')), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer),
    wait: promise => new Promise((resolve, reject) => {
      const finish = (settle, value) => { controller.signal.removeEventListener('abort', abort); settle(value); };
      const abort = () => finish(reject, controller.signal.reason);
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
      if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true });
    }) };
}
const row = { id: 'one', version: 0, priceCents: 100, quantity: 1 };
const event = seq => ({ seq, effectId: `regression-${seq}`, key: row.id, op: 'upsert', row: { ...row, version: seq } });
const browser = await chromium.launch({ headless: true });
try {
  for (const name of selection.split(',')) {
    assert.ok(['peer', 'overlap', 'cleanup-disconnect', 'cleanup-detach'].includes(name));
    const deadline = budget(45000), readers = [], controls = [], faults = [], gates = [];
    let failure;
    async function api(path, input, signal = deadline.signal) {
      const response = await fetch(base + '/parity/' + path, input === undefined ? { signal } : {
        signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      const body = await response.json(); controls.push({ path, input, status: response.status, body });
      assert.equal(response.status, 200); return body;
    }
    async function resourceCount(count, timer = deadline) {
      for (;;) {
        const r = await api('resources', undefined, timer.signal);
        if (['subscriptions', 'connections', 'pendingTasks'].every(k => r[k] === count) && r.queueEvents === 0) return r;
        await timer.wait(new Promise(resolve => setTimeout(resolve, 10)));
      }
    }
    const call = (r, method, arg) => deadline.wait(r.page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg }));
    const dom = r => r.page.evaluate(() => ({
      versions: Array.from(document.querySelectorAll('#listings > li .version'), n => Number(n.textContent)),
      count: Number(document.querySelector('#effect-count').textContent),
    }));
    async function open(maxCleanupMs = 5000) {
      const context = await deadline.wait(browser.newContext()), page = await deadline.wait(context.newPage());
      const r = { context, page, network: [], pending: [], errors: [] }; readers.push(r);
      page.setDefaultTimeout(15000);
      const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
      for (const [event, kind] of [['webSocketFrameReceived', 'native-websocket-received'],
        ['webSocketCreated', 'native-websocket-created'], ['webSocketClosed', 'native-websocket-closed']]) {
        cdp.on(`Network.${event}`, data => r.network.push({ kind, ...data }));
      }
      page.on('pageerror', error => r.errors.push(error.message));
      page.on('request', request => r.network.push({ kind: 'request', url: request.url(), method: request.method(), body: request.postData() }));
      page.on('response', response => {
        const entry = { kind: 'response', url: response.url(), status: response.status() }; r.network.push(entry);
        if (response.headers()['content-type']?.includes('application/json')) {
          const promise = response.text().then(body => { entry.body = body; }); promise.catch(() => {}); r.pending.push(promise);
        }
      });
      assert.equal((await deadline.wait(page.goto(base))).status(), 200);
      r.client = await page.locator('#parity-app').getAttribute('data-client');
      const bridge = await context.request.get(new URL(await page.locator('script[type="module"]').first().getAttribute('src'), base).href);
      assert.equal(sha(await bridge.body()), bridgeSha256);
      await deadline.wait(page.waitForFunction(() => !!window.liveApp));
      await call(r, 'setup', { maxCleanupMs });
      return r;
    }
    const wait = async (r, through) => {
      await deadline.wait(r.page.waitForFunction(n => window.liveApp.through === n, through)); await call(r, 'settle');
    };
    function hold() { const g = gate(); gates.push(g); return g; }
    try {
      await api('configure', { initial: [row], queueLimit: 2, historyLimit: 4 });
      if (name === 'peer') {
        const a = await open(), b = await open(); await resourceCount(2);
        await call(a, 'detach'); await resourceCount(1);
        assert.equal((await call(a, 'released')).subscriptions, 1);
        for (const seq of [1, 2]) { await call(b, 'publish', event(seq)); await wait(b, seq); }
        assert.deepEqual(await dom(a), { versions: [0], count: 0 });
        assert.deepEqual(await dom(b), { versions: [2], count: 2 });
        assert.deepEqual(wireEvents(a.network), []); assert.deepEqual(wireEvents(b.network), [event(1), event(2)]);
        await call(b, 'detach'); await resourceCount(0);
      } else if (name === 'overlap') {
        const r = await open(), committed = gate(), second = gate(), release = hold();
        await r.page.route('**/parity/publish', async route => {
          if (route.request().postDataJSON().event.seq === 2) await deadline.wait(committed.promise);
          const response = await route.fetch(), body = await response.body(), result = JSON.parse(body);
          assert.equal(response.status(), 200); faults.push({ kind: 'real-write-ack', result });
          if (result.seq === 1) { committed.resolve(); await release.promise; }
          await route.fulfill({ response, body });
          if (result.seq === 2) second.resolve();
        });
        try {
          await deadline.wait(r.page.evaluate(events => {
            window.regressionWrites = Promise.all(events.map(e => window.liveApp.publish(e))); window.regressionWrites.catch(() => {});
          }, [event(1), event(2)]));
          await deadline.wait(second.promise); await r.page.waitForTimeout(100);
          assert.deepEqual(await dom(r), { versions: [0], count: 0 }, 'native frame changed DOM before the real HTTP acknowledgement');
          assert.deepEqual(wireEvents(r.network), [], 'native event emission escaped the publisher fence');
          faults.push({ kind: 'before-held-response-release', dom: await dom(r), resources: await api('resources') });
        } finally { release.resolve(); await deadline.wait(r.page.evaluate(() => window.regressionWrites)); }
        await wait(r, 2); await deadline.wait(Promise.all(r.pending));
        const writes = r.network.filter(n => n.kind === 'response' && new URL(n.url).pathname === '/parity/publish');
        assert.deepEqual(writes.map(n => JSON.parse(n.body).seq), [2, 1]);
        assert.deepEqual(wireEvents(r.network), [event(1), event(2)]);
        assert.deepEqual(await dom(r), { versions: [2], count: 2 });
        const records = await r.page.evaluate(() => window.liveApp.records);
        assert.deepEqual(records.filter(n => n.kind === 'publish').map(n => n.seq), [1, 2]);
        for (const seq of [1, 2]) assert.ok(records.findIndex(n => n.kind === 'publish' && n.seq === seq)
          < records.findIndex(n => n.kind === 'event' && n.event.seq === seq));
        await call(r, 'detach'); await resourceCount(0);
      } else {
        const r = await open(100), accepted = gate(), release = hold();
        await r.page.route('**/parity/acknowledge', async route => {
          const response = await route.fetch(), body = await response.body(); assert.equal(response.status(), 200);
          accepted.resolve(); await release.promise; await route.fulfill({ response, body });
        });
        try {
          await call(r, 'publish', event(1)); await deadline.wait(accepted.promise);
          await r.page.evaluate(method => {
            const result = window.cleanupResult = { status: 'pending' }, startedAt = performance.now();
            window.cleanupAttempt = window.liveApp[method]().then(() => { result.status = 'resolved'; }, error => {
              result.status = 'rejected'; result.error = error.message;
            }).finally(() => { result.elapsedMs = performance.now() - startedAt; });
          }, name.slice('cleanup-'.length));
          await r.page.waitForTimeout(500); await resourceCount(0);
          const outcome = await r.page.evaluate(() => window.cleanupResult); faults.push({ kind: 'held-native-emission-ack', outcome });
          assert.equal(outcome.status, 'rejected'); assert.match(outcome.error, /native Topcoat render\/socket not released/);
          assert.ok(outcome.elapsedMs < 400);
          assert.deepEqual(await dom(r), { versions: [1], count: 1 });
        } finally { release.resolve(); await deadline.wait(r.page.evaluate(() => Promise.all([window.cleanupAttempt, window.liveApp.settle()]))); }
      }
      for (const r of readers) assert.deepEqual(r.errors, []);
    } catch (error) { failure = error; }
    finally {
      for (const g of gates) g.resolve();
      const teardown = budget(5000), captures = [];
      try {
        for (const r of readers) {
          await teardown.wait(Promise.all(r.pending)).catch(() => {});
          captures.push({ network: r.network, errors: r.errors, records: await teardown.wait(r.page.evaluate(() => window.liveApp?.records ?? [])).catch(() => []) });
        }
        await teardown.wait(Promise.all(readers.map(r => r.context.close()))); await resourceCount(0, teardown);
        for (const r of readers) {
          const status = await api(`reader?client=${encodeURIComponent(r.client)}`, undefined, teardown.signal);
          if (status.registered) await api('finish', { client: r.client }, teardown.signal);
        }
        assert.equal((await api('resources', undefined, teardown.signal)).inventory.clients, 0);
        if (process.env.LIVE_EVIDENCE) {
          await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
          await writeFile(`${process.env.LIVE_EVIDENCE}/topcoat-regression-${name}${failure ? '-failure' : ''}.json.gz`,
            gzipSync(JSON.stringify({ provenance, controls, faults, captures, failure: failure?.message })), { flag: 'wx' });
        }
      } finally { deadline.dispose(); teardown.dispose(); }
    }
    if (failure) throw failure;
    console.log(`Topcoat native regression ${name}: actual HTTP acknowledgements, DOM, native wire and reader cleanup passed`);
  }
} finally { await browser.close(); }
