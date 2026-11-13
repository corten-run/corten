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

const [base, selection = 'detach,overlap'] = process.argv.slice(2);
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
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const name of selection.split(',')) {
  assert.ok(['detach', 'overlap'].includes(name));
  const readers = [], controls = [], faults = [];
  const deadline = setTimeout(() => { for (const r of readers) r.context.close().catch(() => {}); }, 45000);
  async function api(path, input) {
    const response = await fetch(`${base}/parity/${path}`, input === undefined ? {} : {
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
        r.pending.push(response.text().then(body => { entry.body = body; }));
      }
    });
    assert.equal((await page.goto(base)).status(), 200);
    const bridgeResponse = await context.request.get(base + '/bridge.js');
    r.servedBridgeSha256 = sha(await bridgeResponse.body());
    assert.equal(r.servedBridgeSha256, localBridgeSha256, 'loaded bridge differs from the local source under test');
    await page.waitForFunction(() => !!window.liveApp);
    await page.evaluate(settings => window.liveApp.setup(settings), settings);
    return r;
  }
  const call = (r, method, arg) => r.page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
  const dom = r => r.page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('#listings > li'), li => ({ id: li.dataset.key,
      version: +li.querySelector('.version').textContent, priceCents: +li.querySelector('.price').textContent,
      quantity: +li.querySelector('.quantity').textContent })),
    effectCount: Number(document.querySelector('#effect-count').textContent),
  }));
  const wait = async (r, through) => { await r.page.waitForFunction(n => window.liveApp.through === n, through); await call(r, 'settle'); };
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
    } else {
      const r = await open(), committed = deferred(), releaseFirst = deferred(), receivedSecond = deferred();
      r.page.on('response', response => {
        if (new URL(response.url()).pathname === '/parity/publish') r.pending.push(response.json().then(body => {
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
          await route.fulfill({ response, body });
        } else { await committed.promise; await route.continue(); }
      });
      try {
        // Both calls reserve their acknowledgement barrier in the same browser task.
        // Request 2 is forwarded only after the real server has committed request 1.
        await r.page.evaluate(events => { window.overlappingWrites = Promise.all(events.map(e => window.liveApp.publish(e))); }, [event(1), event(2)]);
        await receivedSecond.promise;
        const end = performance.now() + 5000;
        while (wireEvents(r.network).length !== 2) {
          assert.ok(performance.now() < end, 'two real SSE events were not received');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await r.page.waitForTimeout(100);
        faults.push({ kind: 'before-held-response-release', dom: await dom(r), records: await r.page.evaluate(() => window.liveApp.records) });
        assert.deepEqual(await dom(r), { rows: [row], effectCount: 0 }, 'events escaped the outstanding real HTTP acknowledgement');
        assert.deepEqual(await r.page.evaluate(() => window.liveApp.records.filter(r => r.kind === 'publish')), []);
      } finally { releaseFirst.resolve(); await r.page.evaluate(() => window.overlappingWrites); }
      await wait(r, 2); await Promise.all(r.pending);
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
  } catch (error) { failure = error; }
  finally {
    await api('resources').catch(() => {});
    const captures = [];
    for (const r of readers) {
      await Promise.all(r.pending).catch(() => {});
      captures.push({ servedBridgeSha256: r.servedBridgeSha256, network: r.network, errors: r.errors,
        records: await r.page.evaluate(() => window.liveApp?.records ?? []).catch(() => []), dom: await dom(r).catch(() => null) });
    }
    if (process.env.LIVE_EVIDENCE) {
      await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
      await writeFile(`${process.env.LIVE_EVIDENCE}/leptos-regression-${name}${failure ? '-failure' : ''}.json.gz`,
        gzipSync(JSON.stringify({ schema: 'native-leptos-regression/v1', localBridgeSha256, controls, faults, captures,
          failure: failure?.message, provenance })), { flag: 'wx' });
    }
    clearTimeout(deadline); await Promise.all(readers.map(r => r.context.close()));
  }
  if (failure) { await browser.close(); throw failure; }
}
await browser.close();
