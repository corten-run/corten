// The oracle runs only after the actual native browser, HTTP and WebSocket capture.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { liveCaptureSchema, liveContracts, validateLiveCapture } from '../../../../workloads/live.mjs';
import { scenarios, settingsFor, workloadFor } from '../../../native.mjs';
import { wireEvents, wireSnapshots } from '../wire.mjs';

const [base, profile = 'bounded', selection, group = 'recoverable-live'] = process.argv.slice(2);
assert.ok(base, 'native application URL required');
assert.ok(Object.hasOwn(liveContracts, group), 'unknown live contract');
const workload = workloadFor(profile), browser = await chromium.launch({ headless: true });
async function save(name, data) {
  if (!process.env.LIVE_EVIDENCE) return;
  await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
  await writeFile(`${process.env.LIVE_EVIDENCE}/topcoat-${group}-${profile}-${name}.json.gz`, gzipSync(JSON.stringify(data)), { flag: 'wx' });
}
try {
  const plain = await browser.newContext({ javaScriptEnabled: false });
  try {
    const settings = settingsFor(group, 'normal', profile);
    assert.equal((await plain.request.post(base + '/parity/configure', { data: {
      initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit,
    } })).status(), 200);
    const page = await plain.newPage(); assert.equal((await page.goto(base)).status(), 200);
    assert.deepEqual(await page.locator('#listings > li').evaluateAll(rows => rows.map(row => row.dataset.key)), workload.initial.map(row => row.id));
    assert.equal(await page.locator('#effect-count').textContent(), '0');
    console.log(`Topcoat native ${profile}: keyed initial HTML works without JavaScript`);
  } finally { await plain.close(); }
  for (const scenario of selection?.split(',') ?? scenarios(group)) {
    assert.ok(scenarios(group).includes(scenario));
    const settings = settingsFor(group, scenario, profile);
    const context = await browser.newContext(), page = await context.newPage();
    await page.addInitScript(() => { window.originalNativeWebSocket = window.WebSocket; });
    const deadline = setTimeout(() => context.close().catch(() => {}), profile === 'native-feed' ? 300000 : 45000);
    page.setDefaultTimeout(15000);
    const network = [], failures = [], observations = [];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    for (const [event, kind] of [['webSocketFrameReceived', 'native-websocket-received'], ['webSocketFrameSent', 'native-websocket-sent'],
      ['webSocketCreated', 'native-websocket-created'], ['webSocketClosed', 'native-websocket-closed']]) {
      cdp.on(`Network.${event}`, data => network.push({ kind, ...data }));
    }
    page.on('pageerror', error => failures.push(error.message));
    page.on('request', request => network.push({ kind: 'request', url: request.url(), method: request.method(), body: request.postData() }));
    page.on('response', response => {
      const entry = { kind: 'response', url: response.url(), status: response.status(), headers: response.headers() };
      network.push(entry);
      if (entry.headers['content-type']?.includes('application/json')) observations.push(response.text().then(body => { entry.body = body; }));
    });
    try {
      const configured = await context.request.post(base + '/parity/configure', { data: {
        initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit,
      } });
      assert.equal(configured.status(), 200);
      const configuration = await configured.json(); assert.equal(configuration.framework, 'topcoat');
      const invalid = [{ event: { ...workload.events[0], seq: 10000 } }];
      if (profile === 'native-feed') invalid.push({ event: workload.events[0], events: [workload.events[0]] },
        { events: [workload.events[0], { ...workload.events[1], seq: 10000 }] }, { events: [] });
      const controls = [];
      for (const input of invalid) {
        const response = await context.request.post(base + '/parity/publish', { data: input });
        assert.equal(response.status(), 400); controls.push({ request: input, status: response.status(), body: await response.text() });
      }
      assert.equal((await page.goto(base)).status(), 200);
      await page.waitForFunction(() => !!window.liveApp);
      const call = (method, arg) => page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
      const wait = async through => { await page.waitForFunction(value => window.liveApp.through === value, through); await call('settle'); };
      await call('setup', settings);
      const retained = await page.locator('#listings > li').first().elementHandle();
      let published = 0;
      const publish = async (deliver = true) => { await call('publish', workload.events[published++]); if (deliver) await wait(published); };
      const missed = async count => {
        const events = workload.events.slice(published, published + count);
        await page.evaluate(async events => {
          if (events.length > 24) await window.liveApp.publishBatch(events);
          else for (const event of events) await window.liveApp.publish(event);
        }, events);
        published += count;
      };
      await publish();
      assert.equal(await retained.evaluate((node, key) => node === Array.from(document.querySelectorAll('#listings > li')).find(li => li.dataset.key === key), workload.initial[0].id), true,
        'native keyed morph replaced the existing row node');
      await retained.dispose();
      if (['disconnect', 'missed-updates', 'expired-cursor'].includes(scenario)) {
        await call('disconnect');
        await missed(scenario === 'expired-cursor' ? settings.historyLimit + 2 : scenario === 'disconnect' ? 1 : 3);
        await call('reconnect'); await wait(published);
      } else if (scenario === 'gap') {
        await call('drop', 2); await publish(false); await publish(false); await wait(published);
      } else if (scenario === 'slow-reader') {
        await call('hold'); await missed(settings.queueLimit + 1); await wait(published);
      }
      while (published < workload.eventCount) await publish();
      const duplicates = await page.evaluate(() => window.liveApp.records.filter(r => r.kind === 'event' && r.disposition === 'duplicate').length);
      await call('duplicate');
      await page.waitForFunction(value => window.liveApp.records.filter(r => r.kind === 'event' && r.disposition === 'duplicate').length > value, duplicates);
      await call('settle'); await call('state'); await call('detach');
      assert.equal(await page.evaluate(() => window.WebSocket === window.originalNativeWebSocket), true,
        'detach retained the native transport observation wrapper');
      await page.evaluate(event => window.liveApp.publish(event, true), workload.cleanupProbe);
      await new Promise(resolve => setTimeout(resolve, settings.cleanupObservationMs + 10));
      await call('released'); await call('state'); await Promise.all(observations);
      const capture = { schema: liveCaptureSchema, contract: liveContracts[settings.group], records: await page.evaluate(() => window.liveApp.records) };
      const summary = validateLiveCapture(workload, capture, settings);
      assert.deepEqual(failures, []);
      assert.deepEqual(capture.records.filter(r => r.kind === 'event').map(r => r.event), wireEvents(network));
      const snapshots = capture.records.filter(r => r.kind === 'snapshot').map(({ through, rows, work }) => ({ through, rows, work }));
      assert.deepEqual(snapshots, wireSnapshots(network));
      assert.deepEqual(snapshots, network.filter(r => r.kind === 'response' && new URL(r.url).pathname === '/parity/snapshot').map(r => {
        assert.equal(r.status, 200); return JSON.parse(r.body);
      }));
      assert.deepEqual(network.filter(r => r.kind === 'request' && new URL(r.url).pathname === '/parity/publish').flatMap(r => {
        const body = JSON.parse(r.body); return body.events ?? [body.event];
      }), [...workload.events, workload.cleanupProbe]);
      assert.deepEqual(network.filter(r => r.kind === 'response' && new URL(r.url).pathname === '/parity/publish').flatMap(r => {
        assert.equal(r.status, 200); const body = JSON.parse(r.body); return (body.acks ?? [body]).map(a => a.seq);
      }), [...workload.events, workload.cleanupProbe].map(e => e.seq));
      let cursor = 0;
      for (const record of capture.records) {
        if (record.kind === 'snapshot') cursor = record.through;
        else if (record.kind === 'event' && record.disposition === 'applied') cursor++;
        else if (record.kind !== 'event') continue;
        const ordered = new Map(workload.initial.map(row => [row.id, row]));
        for (const event of workload.events.slice(0, cursor)) {
          if (event.op === 'remove') ordered.delete(event.key); else ordered.set(event.key, event.row);
        }
        assert.deepEqual(record.state, [...ordered.values()], 'native visible order drifted');
      }
      assert.ok(network.some(r => r.kind === 'native-websocket-created'));
      assert.equal(network.filter(r => r.kind === 'native-websocket-created').length, network.filter(r => r.kind === 'native-websocket-closed').length);
      await save(scenario, { configuration, controls, capture, summary, network, failures, html: await page.content(), browser: browser.version() });
      console.log(`Topcoat native ${group}/${profile}/${scenario}: actual DOM, native frames, HTTP writes/acks, effects, recovery and cleanup passed`);
    } catch (error) {
      const capture = { records: await page.evaluate(() => window.liveApp?.records ?? []).catch(() => []) };
      console.error('Native browser errors:', failures); console.error('Last records:', JSON.stringify(capture.records.slice(-6)));
      await save(`${scenario}-failure`, { capture, network, failures, html: await page.content().catch(() => '') });
      throw error;
    } finally { clearTimeout(deadline); await context.close(); }
  }
} finally { await browser.close(); }
