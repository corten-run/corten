// Bounded app-local correctness proof. The oracle is used only after actual browser capture.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createLiveWorkload, validateLiveCapture, liveCaptureSchema, liveContracts } from '../../../../workloads/live.mjs';
import { wireEvents, wireSnapshots } from '../wire.mjs';

const base = process.argv[2];
assert.ok(base, 'native app URL required');
const profile = process.argv[3] || 'bounded';
assert.ok(['bounded', 'native-feed'].includes(profile));
const selected = process.argv[4]?.split(',') || ['normal', 'disconnect', 'missed-updates', 'expired-cursor', 'gap', 'slow-reader'];
assert.ok(selected.every(value => ['normal', 'disconnect', 'missed-updates', 'expired-cursor', 'gap', 'slow-reader'].includes(value)));
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of selected) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const deadline = setTimeout(() => context.close().catch(() => {}), profile === 'native-feed' ? 300000 : 45000);
    const network = [], errors = [], responses = [];
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketFrameReceived', event => network.push({ kind: 'native-websocket-received', ...event }));
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/parity/publish') network.push({ kind: 'write-request', body: request.postData() });
      });
      page.on('response', response => {
        if (new URL(response.url()).pathname === '/parity/publish') {
          const entry = { kind: 'write-response', status: response.status() }; network.push(entry);
          responses.push(response.json().then(body => { entry.body = body; }));
        }
      });
      page.on('pageerror', error => errors.push(error.message));
      const workload = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: profile === 'native-feed' ? 1044 : 24 });
      const settings = { group: 'recoverable-live', scenario,
        queueLimit: profile === 'native-feed' ? 1024 : 2, historyLimit: profile === 'native-feed' ? 1025 : 4,
        slowOutcome: 'resnapshot', maxRecoveryMs: 10000, maxCleanupMs: 5000,
        cleanupObservationMs: 150, maxSlowMs: 10000, maxPublishLagMs: 5000 };
      assert.equal((await context.request.post(base + '/parity/configure', {
        data: { initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit },
      })).status(), 200);
      assert.equal((await context.request.post(base + '/parity/publish', { data: { event: { ...workload.events[0], seq: 10000 } } })).status(), 400);
      assert.equal((await page.goto(base)).status(), 200);
      await page.waitForFunction(() => !!window.liveApp);
      const call = (method, arg) => page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
      const wait = async through => {
        await page.waitForFunction(value => window.liveApp.through === value, through);
        await call('settle');
      };
      await call('setup', settings);
      let published = 0;
      const publish = async (delivered = true) => { await call('publish', workload.events[published++]); if (delivered) await wait(published); };
      await publish();
      if (['disconnect', 'missed-updates', 'expired-cursor'].includes(scenario)) {
        await call('disconnect');
        const missed = scenario === 'expired-cursor' ? settings.historyLimit + 2 : scenario === 'disconnect' ? 1 : 3;
        if (profile === 'native-feed') {
          await call('publishBatch', workload.events.slice(published, published + missed)); published += missed;
        } else for (let n = 0; n < missed; n++) await publish(false);
        await call('reconnect'); await wait(published);
      } else if (scenario === 'gap') {
        await call('drop', 2); await publish(false); await publish(false); await wait(published);
      } else if (scenario === 'slow-reader') {
        await call('hold');
        if (profile === 'native-feed') {
          await call('publishBatch', workload.events.slice(published, published + settings.queueLimit + 1)); published += settings.queueLimit + 1;
        } else for (let n = 0; n <= settings.queueLimit; n++) await publish(false);
        await wait(published);
      }
      while (published < workload.eventCount) await publish();
      const duplicates = await page.evaluate(() => window.liveApp.records.filter(r => r.kind === 'event' && r.disposition === 'duplicate').length);
      await call('duplicate');
      await page.waitForFunction(value => window.liveApp.records.filter(r => r.kind === 'event' && r.disposition === 'duplicate').length > value, duplicates);
      await call('settle'); await call('state'); await call('detach');
      await page.evaluate(event => window.liveApp.publish(event, true), workload.cleanupProbe);
      await new Promise(resolve => setTimeout(resolve, 170));
      await call('released'); await call('state');
      const capture = { schema: liveCaptureSchema, contract: liveContracts['recoverable-live'],
        records: await page.evaluate(() => window.liveApp.records) };
      await Promise.all(responses);
      const summary = validateLiveCapture(workload, capture, settings);
      assert.deepEqual(errors, []);
      assert.deepEqual(capture.records.filter(r => r.kind === 'event').map(r => r.event), wireEvents(network));
      assert.deepEqual(capture.records.filter(r => r.kind === 'snapshot').map(({ through, rows, work }) => ({ through, rows, work })), wireSnapshots(network));
      assert.deepEqual(network.filter(r => r.kind === 'write-request').flatMap(r => {
        const body = JSON.parse(r.body); return body.events || [body.event];
      }), [...workload.events, workload.cleanupProbe]);
      assert.deepEqual(network.filter(r => r.kind === 'write-response').flatMap(r => {
        assert.equal(r.status, 200); return (r.body.acks || [r.body]).map(ack => ack.seq);
      }), [...workload.events, workload.cleanupProbe].map(event => event.seq));
      console.log(`Rails native ${profile}/${scenario}: DOM/raw Action Cable/Turbo/HTTP writes+acks/effects/recovery/cleanup passed (${summary.snapshots} snapshots)`);
    } catch (error) {
      console.error('Native browser errors:', errors);
      console.error('Last actual records:', await page.evaluate(() => window.liveApp?.records.slice(-8)).catch(() => []));
      throw error;
    } finally { clearTimeout(deadline); await context.close(); }
  }
} finally { await browser.close(); }
