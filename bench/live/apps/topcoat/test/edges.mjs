// Actual native DOM, original frames and real delayed HTTP requests/responses.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const [base, selection = 'ack-response-loss,pending-generation,finish-deadline,row-identities'] = process.argv.slice(2);
assert.ok(base);
const provenance = { qualification: false, scope: 'actual native ACK/generation/deadline/identity controls' };
if (process.env.LIVE_CONTAINER) {
  const inspect = (kind, id, format) => JSON.parse(execFileSync('docker', [kind, 'inspect', '--format', format, id], { encoding: 'utf8' }));
  const container = inspect('container', process.env.LIVE_CONTAINER, '{"image":{{json .Image}},"ports":{{json .NetworkSettings.Ports}},"labels":{{json .Config.Labels}}}');
  const image = inspect('image', container.image, '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}');
  const url = new URL(base); assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.ok(container.ports['8080/tcp'].some(p => p.HostIp === '127.0.0.1' && p.HostPort === url.port));
  assert.equal(container.labels['agent.owner'], 'codex');
  Object.assign(provenance, { image, container: process.env.LIVE_CONTAINER });
  if (process.env.LIVE_BIND) {
    const source = execFileSync(process.execPath, [fileURLToPath(new URL('regressions.mjs', import.meta.url)), '--source-hash'], { encoding: 'utf8' }).trim();
    assert.equal(image.labels['bench.source-sha256'], source); provenance.sourceSha256 = source;
  }
}
const browser = await chromium.launch({ headless: true });
try {
  for (const name of selection.split(',')) {
    assert.ok(['ack-response-loss', 'pending-generation', 'finish-deadline', 'row-identities'].includes(name));
    const network = [], controls = [], captures = [], errors = [], responses = [], releases = [];
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('native edge regression deadline exceeded')), 45000);
    const wait = promise => new Promise((resolve, reject) => {
      const finish = (settle, value) => { deadline.signal.removeEventListener('abort', abort); settle(value); };
      const abort = () => finish(reject, deadline.signal.reason);
      Promise.resolve(promise).then(v => finish(resolve, v), e => finish(reject, e));
      if (deadline.signal.aborted) abort(); else deadline.signal.addEventListener('abort', abort, { once: true });
    });
    const gate = () => {
      let resolve; const promise = new Promise(r => { resolve = r; }); releases.push(resolve); return { promise, resolve };
    };
    const api = async (path, input) => {
      const r = await fetch(base + '/parity/' + path, input === undefined ? { signal: deadline.signal } : {
        signal: deadline.signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      const body = await r.json(); controls.push({ path, input, status: r.status, body }); assert.equal(r.status, 200); return body;
    };
    const zero = async () => {
      for (;;) {
        const r = await api('resources');
        if (r.subscriptions + r.connections + r.pendingTasks + r.queueEvents === 0) return r;
        await wait(new Promise(r => setTimeout(r, 10)));
      }
    };
    const row = { id: 'a', version: 0, priceCents: 12, quantity: 2 };
    const event = seq => ({ seq, effectId: `edge-${seq}`, key: row.id, op: 'upsert', row: { ...row, version: seq } });
    let context, page, failure;
    try {
      const initial = name === 'row-identities' ? ['native-message', 'native-screen', 'parity-app', 'listings', 'effect-count',
        'native-connect', 'native-disconnect', 'listing-row-YQ==', 'a', 'a b', 'é'].map(id => ({ ...row, id })) : [row];
      await api('configure', { initial, queueLimit: 2, historyLimit: 4 });
      context = await wait(browser.newContext()); page = await wait(context.newPage()); page.setDefaultTimeout(6000);
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => network.push({ kind: 'request', url: r.url(), method: r.method(), body: r.postData() }));
      page.on('response', r => {
        const item = { kind: 'response', url: r.url(), status: r.status() }; network.push(item);
        if (r.headers()['content-type']?.includes('application/json')) {
          const pending = r.text().then(body => { item.body = body; }); pending.catch(() => {}); responses.push(pending);
        }
      });
      const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
      cdp.on('Network.webSocketFrameReceived', r => network.push({ kind: 'native-websocket-received', ...r }));
      await page.addInitScript(() => {
        window.edgeSockets = []; const Original = window.WebSocket;
        window.WebSocket = class extends Original { constructor(...args) { super(...args); window.edgeSockets.push(this); } };
      });
      assert.equal((await wait(page.goto(base))).status(), 200);
      await wait(page.waitForFunction(() => !!window.liveApp));
      const call = (method, input) => wait(page.evaluate(([m, v]) => window.liveApp[m](v), [method, input]));
      const state = () => wait(page.evaluate(() => { window.liveApp.state(); return window.liveApp.records.at(-1); }));
      await call('setup', { maxCleanupMs: name === 'finish-deadline' ? 100 : 2000 });
      if (name === 'row-identities') {
        assert.deepEqual(await page.locator('#listings > li').evaluateAll(nodes => nodes.map(n => n.dataset.key)), initial.map(r => r.id));
        assert.deepEqual(await page.evaluate(() => {
          const ids = Array.from(document.querySelectorAll('[id]'), n => n.id); return ids.filter((id, i) => ids.indexOf(id) !== i);
        }), []);
        for (let i = 0; i < initial.length; i++) {
          const change = { ...event(i + 1), key: initial[i].id, row: { ...initial[i], version: i + 1 } };
          await call('publish', change); await wait(page.waitForFunction(n => window.liveApp.through === n, i + 1)); await call('settle');
        }
        captures.push(await state()); assert.equal(captures.at(-1).effectCount, initial.length); await call('detach');
      } else if (name === 'finish-deadline') {
        const held = gate(), reached = gate();
        await page.route('**/parity/finish', async route => { reached.resolve(); await held.promise; await route.continue(); }, { times: 1 });
        await page.evaluate(() => {
          const startedAt = performance.now(); window.edgeDetach = { status: 'pending' };
          window.edgeDetaching = window.liveApp.detach().then(() => { window.edgeDetach.status = 'resolved'; }, e => {
            window.edgeDetach.status = 'rejected'; window.edgeDetach.error = e.message;
          }).finally(() => { window.edgeDetach.elapsedMs = performance.now() - startedAt; });
        });
        await wait(reached.promise); await page.waitForTimeout(500);
        const outcome = await page.evaluate(() => window.edgeDetach); captures.push({ outcome, resources: await api('resources') });
        assert.equal(outcome.status, 'rejected'); assert.match(outcome.error, /native Topcoat render\/socket not released/);
        assert.ok(outcome.elapsedMs < 400); await wait(page.evaluate(() => window.edgeDetaching));
      } else {
        const held = gate(), reached = gate();
        await page.route('**/parity/acknowledge', async route => {
          if (name === 'ack-response-loss') {
            const response = await route.fetch(); captures.push({ acceptedAck: { status: response.status(), body: await response.text() } });
            assert.equal(response.status(), 200);
          }
          reached.resolve(); await held.promise;
          if (name === 'ack-response-loss') await route.abort('failed'); else await route.continue();
        }, { times: 1 });
        await call('publish', event(1)); await wait(reached.promise);
        if (name === 'ack-response-loss') {
          await call('publish', event(2));
          await wait(page.waitForFunction(() => document.querySelector('#native-screen').dataset.through === '2'));
          held.resolve(); await call('settle').catch(error => captures.push({ oldAckError: error.message }));
          await call('publish', event(3));
          await wait(page.waitForFunction(() => document.querySelector('#native-screen').dataset.through === '3'));
          captures.push({ beforeRetry: await state() });
          assert.deepEqual(captures.at(-1).beforeRetry.effects, ['edge-1', 'edge-2', 'edge-3']);
          assert.equal(captures.at(-1).beforeRetry.effectCount, 3);
        }
        await page.evaluate(() => window.edgeSockets.at(-1).close());
        await wait(page.waitForFunction(() => window.liveApp.records.some(r => r.kind === 'resume')));
        if (name === 'pending-generation') {
          await call('publish', event(2));
          // The old request stays held across resume and the next actual effect.
          await wait(page.waitForFunction(() => window.liveApp.through === 2));
          await call('settle'); captures.push({ whileOldHeld: await state() });
          held.resolve();
        }
        await call('settle'); captures.push({ afterRetry: await state() });
        const prefix = name === 'ack-response-loss' ? 3 : 2;
        const expected = Array.from({ length: prefix }, (_, i) => `edge-${i + 1}`);
        assert.deepEqual(captures.at(-1).afterRetry.effects, expected);
        assert.equal(captures.at(-1).afterRetry.effectCount, prefix);
        await call('publish', event(prefix + 1)); await wait(page.waitForFunction(n => window.liveApp.through === n, prefix + 1)); await call('settle');
        captures.push({ continued: await state() }); assert.deepEqual(captures.at(-1).continued.effects, [...expected, `edge-${prefix + 1}`]);
        assert.equal(captures.at(-1).continued.effectCount, prefix + 1); await call('detach');
      }
      assert.deepEqual(errors, []);
    } catch (error) { failure = error; }
    finally {
      try {
        for (const release of releases) release();
        if (page && !page.isClosed()) captures.push({ records: await wait(page.evaluate(() => window.liveApp?.records)).catch(() => undefined) });
        if (context) await context.close();
        await wait(Promise.allSettled(responses)).catch(() => {});
        if (!deadline.signal.aborted) await zero();
        if (process.env.LIVE_EVIDENCE) {
          await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
          await writeFile(`${process.env.LIVE_EVIDENCE}/topcoat-edge-${name}${failure ? '-failure' : ''}.json.gz`,
            gzipSync(JSON.stringify({ provenance, network, controls, captures, errors, failure: failure?.stack })), { flag: 'wx' });
        }
      } finally { clearTimeout(timer); }
    }
    if (failure) throw failure;
    console.log(`Topcoat native edge ${name}: original frames, observed effects, generation progress and bounded cleanup passed`);
  }
} finally { await browser.close(); }
