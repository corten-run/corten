import assert from 'node:assert/strict';
import { createLiveWorkload, liveSnapshot } from '../../../../workloads/live.mjs';
import { wireEvents, wireSnapshots } from '../wire.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const base = process.argv[2]; assert.ok(base, 'isolated app URL required');
const workload = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: 24 });
const settings = { maxCleanupMs: 5000 };
async function api(name, data) {
  const response = await fetch(base + '/parity/' + name, { signal: AbortSignal.timeout(10000), ...(data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }) }); assert.equal(response.status, 200); return response.json();
}
async function resources(count) {
  const deadline = performance.now() + 5000;
  while (true) {
    const value = await api('resources');
    if (value.connections === count && value.subscriptions === count && value.pendingTasks === count) {
      assert.ok(value.queueEvents <= count * 2 && value.queuePeak <= 2 && value.historyPeak <= 4);
      if (!count) assert.equal(value.queueEvents, 0); return value;
    }
    assert.ok(performance.now() < deadline, 'native reader ownership mismatch'); await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const browser = await chromium.launch({ headless: true });
try {
  for (const count of [1, 2, 4]) {
    const readers = [];
    try {
      await api('configure', { initial: workload.initial, queueLimit: 2, historyLimit: 4 });
      for (let n = 0; n < count; n++) {
        const context = await browser.newContext(), page = await context.newPage(), network = [], errors = [], pending = [];
        readers.push({ context, page, network, errors, pending });
        page.setDefaultTimeout(10000); const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
        for (const [name, kind] of [['Network.webSocketCreated', 'native-websocket-created'], ['Network.webSocketFrameReceived', 'native-websocket-received']]) {
          cdp.on(name, value => network.push({ kind, ...value }));
        }
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => {
          if (new URL(response.url()).pathname !== '/parity/snapshot') return;
          const value = { kind: 'response', url: response.url(), status: response.status() }; network.push(value);
          pending.push(response.text().then(body => { value.body = body; }));
        });
        await page.goto(base); await page.evaluate(settings => window.liveApp.setup(settings), settings);
      }
      await resources(count);
      for (const event of workload.events) {
        await readers[0].page.evaluate(event => window.liveApp.publish(event), event);
        await Promise.all(readers.map(async ({ page }) => {
          await page.waitForFunction(seq => window.liveApp.through === seq, event.seq); await page.evaluate(() => window.liveApp.settle());
        }));
      }
      await resources(count);
      await readers[0].page.evaluate(() => window.liveApp.duplicate());
      for (const { page } of readers) await page.waitForFunction(() => window.liveApp.records.some(value => value.kind === 'event' && value.disposition === 'duplicate'));
      for (const { page, network, errors, pending } of readers) {
        await page.evaluate(() => { window.liveApp.state(); }); await Promise.all(pending);
        const records = await page.evaluate(() => window.liveApp.records), events = records.filter(value => value.kind === 'event');
        assert.deepEqual(errors, []); assert.deepEqual(events.map(value => value.event), wireEvents(network));
        assert.deepEqual(events.filter(value => value.disposition === 'applied').map(value => value.event), workload.events);
        assert.ok(events.every(value => ['applied', 'duplicate'].includes(value.disposition)));
        const snapshots = wireSnapshots(network); assert.equal(snapshots.length, 1); assert.equal(snapshots[0].through, 0);
        const final = records.at(-1); assert.equal(final.effectCount, workload.eventCount);
        assert.deepEqual(final.effects, workload.events.map(value => value.effectId));
        assert.deepEqual([...final.rows].sort((a, b) => a.id.localeCompare(b.id)), liveSnapshot(workload, workload.eventCount).rows);
      }
      // Closing one browser context without detach must release only its native reader.
      await readers[0].context.close(); await resources(count - 1);
      await Promise.all(readers.slice(1).map(({ page }) => page.evaluate(() => window.liveApp.detach())));
      await resources(0);
      console.log(`Drogon ${count} real browser readers: individual native publications, raw WS/DOM/effects, bounded resources, abrupt close and detach passed (functional, untimed)`);
    } finally { await Promise.all(readers.map(({ context }) => context.close())); await resources(0); }
  }
} finally { await browser.close(); }
