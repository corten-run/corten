// App-local functional verification, not registry admission or a timed load result.
import assert from 'node:assert/strict';
import { createLiveWorkload, liveCaptureSchema, liveContracts, validateLiveCapture } from '../../../../workloads/live.mjs';
import { wireEvents, wireSnapshots } from '../wire.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const base = process.argv[2], profile = process.argv[3] || 'bounded';
const scenarios = ['normal', 'disconnect', 'missed-updates', 'expired-cursor', 'gap', 'slow-reader'];
const selected = process.argv[4]?.split(',') || scenarios;
assert.ok(base && ['bounded', 'native-feed'].includes(profile)); assert.ok(selected.every(value => scenarios.includes(value)));
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of selected) {
    const context = await browser.newContext(), page = await context.newPage();
    page.setDefaultTimeout(10000);
    const deadline = setTimeout(() => context.close().catch(() => {}), 180000);
    const network = [], errors = [], responses = [];
    try {
      const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
      for (const [name, kind] of [['Network.webSocketCreated', 'native-websocket-created'],
        ['Network.webSocketFrameReceived', 'native-websocket-received'], ['Network.webSocketFrameSent', 'native-websocket-sent']]) {
        cdp.on(name, value => network.push({ kind, ...value }));
      }
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => network.push({ kind: 'request', url: request.url(), body: request.postData() }));
      page.on('response', response => {
        const value = { kind: 'response', url: response.url(), status: response.status(), headers: response.headers() }; network.push(value);
        if (response.headers()['content-type']?.includes('application/json')) responses.push(response.text().then(body => { value.body = body; }));
      });
      const workload = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: profile === 'native-feed' ? 1044 : 24 });
      const settings = { group: 'recoverable-live', scenario, queueLimit: profile === 'native-feed' ? 1024 : 2,
        historyLimit: profile === 'native-feed' ? 1025 : 4, slowOutcome: 'resnapshot', maxRecoveryMs: 10000,
        maxCleanupMs: 5000, cleanupObservationMs: 150, maxSlowMs: 10000, maxPublishLagMs: 5000 };
      const configured = await context.request.post(base + '/parity/configure', { data: { initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit } });
      assert.equal(configured.status(), 200); assert.equal((await configured.json()).framework, 'drogon');
      assert.equal((await page.goto(base)).status(), 200);
      assert.equal(await page.locator('#rows > tr').count(), workload.rowCount, 'initial server-rendered keyed rows missing');
      const call = (method, arg) => page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
      const wait = async through => { await page.waitForFunction(value => window.liveApp.through === value, through); await call('settle'); };
      await call('setup', settings);
      let published = 0;
      const publish = async (deliver = true) => { await call('publish', workload.events[published++]); if (deliver) await wait(published); };
      const missed = async count => {
        if (count > 24) { await call('publishBatch', workload.events.slice(published, published + count)); published += count; }
        else for (let n = 0; n < count; n++) await publish(false);
      };
      // An ordinary upsert preserves its keyed DOM node; remove/reinsert creates a new one.
      await page.evaluate(() => { window.originalRow = document.querySelector('[data-key="listing-0"]'); });
      await publish();
      assert.equal(await page.evaluate(() => window.originalRow === document.querySelector('[data-key="listing-0"]')), true);
      if (['disconnect', 'missed-updates', 'expired-cursor'].includes(scenario)) {
        await call('disconnect'); await missed(scenario === 'expired-cursor' ? settings.historyLimit + 2 : scenario === 'disconnect' ? 1 : 3);
        await call('reconnect'); await wait(published);
      } else if (scenario === 'gap') {
        await call('drop', 2); await publish(false); await publish(false); await wait(published);
      } else if (scenario === 'slow-reader') {
        await call('hold'); await missed(settings.queueLimit + 1); await wait(published);
      }
      while (published < workload.eventCount) await publish();
      assert.equal(await page.evaluate(() => window.originalRow === document.querySelector('[data-key="listing-0"]')), false);
      const duplicateCount = await page.evaluate(() => window.liveApp.records.filter(value => value.kind === 'event' && value.disposition === 'duplicate').length);
      await call('duplicate');
      await page.waitForFunction(count => window.liveApp.records.filter(value => value.kind === 'event' && value.disposition === 'duplicate').length > count, duplicateCount);
      await call('settle'); await call('state'); await call('detach');
      await page.evaluate(event => window.liveApp.publish(event, true), workload.cleanupProbe);
      await new Promise(resolve => setTimeout(resolve, settings.cleanupObservationMs + 10)); await call('released'); await call('state');
      await Promise.all(responses);
      const capture = { schema: liveCaptureSchema, contract: liveContracts[settings.group], records: await page.evaluate(() => window.liveApp.records) };
      const summary = validateLiveCapture(workload, capture, settings);
      assert.deepEqual(errors, []);
      assert.deepEqual(capture.records.filter(value => value.kind === 'event').map(value => value.event), wireEvents(network));
      assert.deepEqual(capture.records.filter(value => value.kind === 'snapshot').map(({ through, rows, work }) => ({ through, rows, work })), wireSnapshots(network));
      const writes = network.filter(value => value.kind === 'request' && new URL(value.url).pathname === '/parity/publish');
      assert.deepEqual(writes.flatMap(value => { const input = JSON.parse(value.body); return input.events || [input.event]; }), [...workload.events, workload.cleanupProbe]);
      const acks = network.filter(value => value.kind === 'response' && new URL(value.url).pathname === '/parity/publish');
      assert.deepEqual(acks.flatMap(value => { assert.equal(value.status, 200); const body = JSON.parse(value.body); return (body.acks || [body]).map(ack => ack.seq); }), [...workload.events, workload.cleanupProbe].map(event => event.seq));
      // A native ack must name a delivery actually seen on that same socket.
      const received = new Set(network.filter(value => value.kind === 'native-websocket-received' && value.response.opcode === 1).flatMap(value => {
        const message = JSON.parse(value.response.payloadData); return message.delivery ? [`${value.requestId}:${message.delivery}`] : [];
      }));
      for (const value of network.filter(value => value.kind === 'native-websocket-sent' && value.response.opcode === 1)) {
        const message = JSON.parse(value.response.payloadData); if (message.kind === 'ack') assert.ok(received.has(`${value.requestId}:${message.delivery}`));
      }
      console.log(`Drogon ${profile}/${scenario}: ${summary.published} individual native writes, ${summary.appliedEffects} effects, ${summary.snapshots} snapshots, queue/history peaks ${summary.queuePeak}/${summary.historyPeak}; raw WS + HTTP + DOM + cleanup passed`);
    } catch (error) {
      console.error('Browser errors:', errors);
      console.error('Last actual records:', await page.evaluate(() => window.liveApp?.records.slice(-5)).catch(() => []));
      throw error;
    } finally { clearTimeout(deadline); await context.close(); }
  }
} finally { await browser.close(); }
