// Withhold original native frames and close real contexts. Never manufacture an ACK.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const [base, selection = 'undelivered,observed-cancel,late-old-ack-failure,automatic-reconnect,automatic-reconnect-ack-failure,inbound-ack-detach,lost-ack,ordinary-get,abrupt-close'] = process.argv.slice(2);
assert.ok(base);
const row = { id: 'a', version: 0, priceCents: 12, quantity: 2 };
const event = { seq: 1, effectId: 'effect-1', key: 'a', op: 'upsert', row: { ...row, version: 1 } };
const provenance = { qualification: false, scope: 'isolated native lifetime regression' };
if (process.env.LIVE_CONTAINER) {
  const inspect = (kind, id, format) => JSON.parse(execFileSync('docker', [kind, 'inspect', '--format', format, id], { encoding: 'utf8' }));
  const container = inspect('container', process.env.LIVE_CONTAINER, '{"image":{{json .Image}},"ports":{{json .NetworkSettings.Ports}},"labels":{{json .Config.Labels}}}');
  const image = inspect('image', container.image, '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}');
  const url = new URL(base); assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.ok(container.ports['8080/tcp'].some(p => p.HostIp === '127.0.0.1' && p.HostPort === url.port));
  assert.equal(container.labels['agent.owner'], 'codex');
  Object.assign(provenance, { image, container: process.env.LIVE_CONTAINER });
  if (process.env.LIVE_BIND) {
    const hash = execFileSync(process.execPath, [fileURLToPath(new URL('regressions.mjs', import.meta.url)), '--source-hash'], { encoding: 'utf8' }).trim();
    assert.equal(image.labels['bench.source-sha256'], hash);
    provenance.sourceSha256 = hash;
  }
}
const browser = await chromium.launch({ headless: true });
try {
  for (const name of selection.split(',')) {
    assert.ok(['undelivered', 'observed-cancel', 'late-old-ack-failure', 'automatic-reconnect', 'automatic-reconnect-ack-failure', 'inbound-ack-detach', 'lost-ack', 'ordinary-get', 'abrupt-close'].includes(name));
    const controls = [], network = [], faults = [], errors = [], captures = [], responses = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('native lifetime regression deadline exceeded')), 45000);
    const wait = promise => new Promise((resolve, reject) => {
      const finish = (settle, value) => { controller.signal.removeEventListener('abort', abort); settle(value); };
      const abort = () => finish(reject, controller.signal.reason);
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
      if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true });
    });
    async function api(path, input) {
      const response = await fetch(base + '/parity/' + path, input === undefined ? { signal: controller.signal } : {
        signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      const body = await response.json(); controls.push({ path, input, status: response.status, body });
      assert.equal(response.status, 200); return body;
    }
    async function zeroReaders() {
      for (;;) {
        const r = await api('resources');
        if (r.subscriptions + r.connections + r.pendingTasks + r.queueEvents === 0) return r;
        await wait(new Promise(resolve => setTimeout(resolve, 10)));
      }
    }
    let context, page, failure, releaseAck, releaseReady;
    try {
      await api('configure', { initial: [row], queueLimit: 2, historyLimit: 4 });
      if (name === 'ordinary-get') {
        const statuses = [];
        for (let i = 0; i < 32; i++) {
          const response = await fetch(base, { signal: controller.signal }); await response.text(); statuses.push(response.status);
        }
        const r = await api('resources'); faults.push({ statuses, resources: r });
        assert.deepEqual(statuses, Array(32).fill(200), 'completed ordinary GETs exhausted admission');
        assert.equal(r.inventory.clients, 0, 'ordinary page GET retained a client');
      } else {
        context = await wait(browser.newContext()); page = await wait(context.newPage()); page.setDefaultTimeout(6000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => network.push({ kind: 'request', url: request.url(), method: request.method(), body: request.postData() }));
        page.on('response', response => {
          const entry = { kind: 'response', url: response.url(), status: response.status() }; network.push(entry);
          if (response.headers()['content-type']?.includes('application/json')) {
            const pending = response.text().then(body => { entry.body = body; }); pending.catch(() => {}); responses.push(pending);
          }
        });
        let blocked;
        const intercepted = new Promise(resolve => { blocked = resolve; });
        let suppress = name === 'undelivered';
        let blockReady = false, reachedReady;
        const readyBlocked = new Promise(resolve => { reachedReady = resolve; });
        const heldReady = new Promise(resolve => { releaseReady = resolve; });
        let nativeReadyCount = 0, reconnected;
        const nativeReconnected = new Promise(resolve => { reconnected = resolve; });
        await page.addInitScript(() => {
          window.nativeTestSockets = [];
          const Original = window.WebSocket;
          window.WebSocket = class extends Original {
            constructor(...args) { super(...args); window.nativeTestSockets.push(this); }
          };
        });
        await page.routeWebSocket('**/*', ws => {
          const server = ws.connectToServer();
          server.onMessage(async message => {
            const raw = message.toString(); network.push({ direction: 'server', message: raw });
            const envelope = JSON.parse(raw);
            const encoded = /<output id="native-message" data-message="([A-Za-z0-9+/=]+)"/.exec(envelope.frame?.html ?? '')?.[1];
            const m = encoded ? JSON.parse(Buffer.from(encoded, 'base64')) : undefined;
            if (m?.kind === 'ready' && ++nativeReadyCount > 1) reconnected();
            if (suppress && m?.kind === 'event' && m.event.seq === 1) {
              suppress = false; faults.push({ kind: 'withheld-original-native-frame', message: m }); blocked(); return;
            }
            if (blockReady && m?.kind === 'ready') {
              blockReady = false; faults.push({ kind: 'withheld-reconnect-ready', message: m }); reachedReady(); await heldReady;
            }
            ws.send(message);
          });
          ws.onMessage(message => { network.push({ direction: 'client', message: message.toString() }); server.send(message); });
        });
        assert.equal((await wait(page.goto(base))).status(), 200);
        const client = await page.locator('#parity-app').getAttribute('data-client');
        await wait(page.waitForFunction(() => !!window.liveApp));
        const call = method => wait(page.evaluate(async method => window.liveApp[method](), method));
        const state = () => wait(page.evaluate(() => { window.liveApp.state(); return window.liveApp.records.at(-1); }));
        await wait(page.evaluate(maxCleanupMs => {
          window.lifetimeOptions = { maxCleanupMs };
          return window.liveApp.setup(window.lifetimeOptions);
        },
          ['observed-cancel', 'late-old-ack-failure'].includes(name) ? 100 : 2000));
        if (name === 'undelivered') {
          await wait(page.evaluate(event => window.liveApp.publish(event), event)); await wait(intercepted);
          captures.push({ before: await state() });
          assert.equal(captures[0].before.through, 0); assert.equal(captures[0].before.effectCount, 0);
          await call('disconnect'); await zeroReaders(); await call('reconnect');
          await wait(page.waitForFunction(() => window.liveApp.through === 1)); await call('settle');
          const after = await state(); captures.push({ after });
          assert.deepEqual(after.effects, [event.effectId], 'withheld native event was lost on reconnect');
          assert.equal(after.effectCount, 1); assert.equal(after.rows[0].version, 1);
          const records = await page.evaluate(() => window.liveApp.records); captures.push({ records });
          assert.equal(records.filter(r => r.kind === 'event' && r.disposition === 'applied' && r.event.seq === 1).length, 1);
          assert.equal(records.find(r => r.kind === 'resume').from, 0, 'resume cursor advanced without an application acknowledgement');
          await call('detach');
        } else if (['observed-cancel', 'late-old-ack-failure'].includes(name)) {
          let reached;
          const reachedAck = new Promise(resolve => { reached = resolve; });
          const heldAck = new Promise(resolve => { releaseAck = resolve; });
          let hold = true;
          await page.route('**/parity/acknowledge', async route => {
            if (hold) {
              hold = false; reached(); await heldAck;
              if (name === 'late-old-ack-failure') { await route.abort('failed'); return; }
            }
            await route.continue();
          });
          await wait(page.evaluate(event => window.liveApp.publish(event), event)); await wait(reachedAck);
          const before = await state(); captures.push({ before });
          assert.deepEqual(before.effects, [event.effectId]); assert.equal(before.effectCount, 1);
          const faultCleanupMs = await page.evaluate(() => window.lifetimeOptions.maxCleanupMs);
          captures.push({ faultCleanupMs }); assert.equal(faultCleanupMs, 100);
          const outcome = await wait(page.evaluate(async () => {
            try { await window.liveApp.disconnect(); return 'resolved'; }
            catch (error) { return error.message; }
          }));
          assert.match(outcome, /native Topcoat render\/socket not released/); await zeroReaders();
          // Reconcile the observed serial while its original real ACK is still held.
          blockReady = name === 'late-old-ack-failure';
          await wait(page.evaluate(() => {
            window.resuming = window.liveApp.reconnect().then(() => 'resolved', error => `rejected: ${error.message}`);
          }));
          for (;;) {
            const r = await api('resources');
            if (r.subscriptions === 1) break;
            await wait(new Promise(resolve => setTimeout(resolve, 10)));
          }
          if (name === 'late-old-ack-failure') await wait(readyBlocked);
          releaseAck();
          if (name === 'late-old-ack-failure') {
            // Drain the old rejection while the new handshake cannot yet observe ready.
            await call('settle'); captures.push({ beforeReady: await state() }); releaseReady();
          }
          const reconnectOutcome = await wait(page.evaluate(() => window.resuming));
          await wait(page.waitForFunction(() => window.liveApp.records.some(r => r.kind === 'resume')));
          await call('settle');
          const after = await state(); captures.push({ after });
          assert.deepEqual(after.effects, [event.effectId]); assert.equal(after.effectCount, 1); assert.equal(after.rows[0].version, 1);
          const records = await page.evaluate(() => window.liveApp.records); captures.push({ records });
          assert.equal(records.find(r => r.kind === 'resume').from, 1);
          assert.equal(reconnectOutcome, 'resolved', 'old ACK rejection crossed into the new native handshake');
          await page.evaluate(() => { window.lifetimeOptions.maxCleanupMs = 2000; });
          const cleanup = await page.evaluate(() => ({ maxCleanupMs: window.lifetimeOptions.maxCleanupMs }));
          captures.push({ cleanup });
          assert.equal(cleanup.maxCleanupMs, 2000, 'fault cleanup budget leaked into normal final detach');
          await call('detach');
        } else if (['automatic-reconnect', 'automatic-reconnect-ack-failure', 'inbound-ack-detach'].includes(name)) {
          let reached;
          const reachedAck = new Promise(resolve => { reached = resolve; });
          const heldAck = new Promise(resolve => { releaseAck = resolve; });
          await page.route('**/parity/acknowledge', async route => {
            faults.push({ kind: 'held-inbound-application-ack', body: route.request().postData() });
            reached(); await heldAck;
            if (name === 'automatic-reconnect-ack-failure') await route.abort('failed');
            else await route.continue();
          }, { times: 1 });
          await wait(page.evaluate(event => window.liveApp.publish(event), event)); await wait(reachedAck);
          const before = await state(); captures.push({ before });
          assert.deepEqual(before.effects, [event.effectId]); assert.equal(before.effectCount, 1);
          await page.evaluate(() => {
            window.nativeVisibleStates = [];
            window.nativeTestObserver = new MutationObserver(() => window.nativeVisibleStates.push({
              through: Number(document.querySelector('#native-screen').dataset.through),
              count: Number(document.querySelector('#effect-count').textContent),
              versions: Array.from(document.querySelectorAll('#listings > li .version'), n => Number(n.textContent)),
            }));
            window.nativeTestObserver.observe(document.querySelector('#parity-app'), { subtree: true, childList: true, attributes: true });
          });
          let outcome;
          if (name.startsWith('automatic-reconnect')) {
            await wait(page.evaluate(() => window.nativeTestSockets.at(-1).close()));
            await wait(nativeReconnected);
            await wait(page.waitForFunction(() => {
              const node = document.querySelector('#native-message');
              return JSON.parse(atob(node.dataset.message)).kind === 'ready';
            }));
            releaseAck();
            outcome = await wait(page.evaluate(() => window.liveApp.settle().then(() => 'resolved', error => error.message)));
          } else {
            await wait(page.evaluate(() => {
              window.detaching = window.liveApp.detach().then(() => 'resolved', error => error.message);
            }));
            await zeroReaders(); releaseAck();
            outcome = await wait(page.evaluate(() => window.detaching));
          }
          const after = await state();
          const visible = await page.evaluate(() => { window.nativeTestObserver.disconnect(); return window.nativeVisibleStates; });
          captures.push({ outcome, after, visible });
          assert.equal(outcome, 'resolved', 'inbound ACK poisoned native cancellation/reconnect');
          assert.deepEqual(after.rows, before.rows); assert.equal(after.effectCount, before.effectCount);
          assert.equal(after.through, before.through); assert.deepEqual(after.effects, before.effects);
          assert.ok(visible.every(s => s.through === 1 && s.count === 1 && s.versions[0] === 1), 'native rendering rolled back an observed screen');
          if (name.startsWith('automatic-reconnect')) {
            const next = { ...event, seq: 2, effectId: 'effect-2', row: { ...event.row, version: 2 } };
            await wait(page.evaluate(event => window.liveApp.publish(event), next));
            await wait(page.waitForFunction(() => window.liveApp.through === 2)); await call('settle');
            const continued = await state(); captures.push({ continued });
            assert.deepEqual(continued.effects, [event.effectId, next.effectId]); assert.equal(continued.effectCount, 2);
            assert.equal(continued.rows[0].version, 2); await call('detach');
          }
          else assert.equal((await api('resources')).inventory.clients, 0);
        } else if (name === 'lost-ack') {
          let lost;
          const lostAck = new Promise(resolve => { lost = resolve; });
          await page.route('**/parity/acknowledge', async route => {
            const response = await route.fetch();
            faults.push({ kind: 'original-ack-response-lost', status: response.status(), body: await response.text() });
            await route.abort('failed'); lost();
          }, { times: 1 });
          await wait(page.evaluate(event => window.liveApp.publish(event), event)); await wait(lostAck);
          await assert.rejects(call('settle'), /fetch/i);
          await assert.rejects(call('disconnect'), /fetch/i); await zeroReaders();
          await call('reconnect'); await call('settle');
          const after = await state(); captures.push({ after });
          assert.deepEqual(after.effects, [event.effectId]); assert.equal(after.effectCount, 1); assert.equal(after.rows[0].version, 1);
          await call('detach');
        } else {
          await context.close(); context = undefined; page = undefined;
          const r = await zeroReaders(); faults.push({ kind: 'abrupt-close-without-finish', resources: r });
          const end = performance.now() + 33000;
          let last;
          do {
            last = await api('resources');
            if (last.inventory.clients === 0) break;
            await wait(new Promise(resolve => setTimeout(resolve, 100)));
          } while (performance.now() < end);
          faults.push({ kind: 'actual-retention-expiry', resources: last });
          assert.equal(last.inventory.clients, 0, 'abrupt native close retained a client indefinitely');
          assert.equal((await api(`reader?client=${encodeURIComponent(client)}`)).registered, false);
        }
        assert.deepEqual(errors, []);
      }
    } catch (error) { failure = error; }
    finally {
      try {
        releaseAck?.();
        releaseReady?.();
        if (page) captures.push({ records: await wait(page.evaluate(() => window.liveApp?.records ?? [])).catch(() => []) });
        await wait(Promise.all(responses)).catch(() => {});
        if (context) await context.close();
        if (!controller.signal.aborted) await zeroReaders();
        if (process.env.LIVE_EVIDENCE) {
          await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
          await writeFile(`${process.env.LIVE_EVIDENCE}/topcoat-lifetime-${name}${failure ? '-failure' : ''}.json.gz`,
            gzipSync(JSON.stringify({ provenance, controls, network, faults, captures, errors, failure: failure?.message })), { flag: 'wx' });
        }
      } finally { clearTimeout(timer); }
    }
    if (failure) throw failure;
    console.log(`Topcoat native lifetime ${name}: original wire, application acknowledgement and actual client retention passed`);
  }
} finally { await browser.close(); }
