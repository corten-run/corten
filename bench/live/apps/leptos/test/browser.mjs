// The oracle runs only here, after observing the actual framework browser application.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { browserJourney } from '../../../parity.mjs';
import { scenarios, settingsFor, workloadFor } from '../../../native.mjs';
import { wireEvents, wireSnapshots } from '../wire.mjs';

const [base, profile = 'bounded', selection] = process.argv.slice(2);
assert.ok(base, 'native application URL required');
const browser = await chromium.launch({ headless: true });
try {
  const plain = await browser.newContext({ javaScriptEnabled: false });
  try {
    const workload = workloadFor(profile), settings = settingsFor('recoverable-live', 'normal', profile);
    assert.equal((await plain.request.post(base + '/parity/configure', { data: {
      initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit,
    } })).status(), 200);
    const page = await plain.newPage(); await page.goto(base);
    assert.deepEqual(await page.locator('#listings > li').evaluateAll(rows => rows.map(row => row.dataset.key)), workload.initial.map(row => row.id));
    assert.equal(await page.locator('#effect-count').textContent(), '0');
    console.log(`Leptos native ${profile}: initial keyed HTML works without JavaScript`);
  } finally { await plain.close(); }
  for (const scenario of selection?.split(',') ?? scenarios('recoverable-live')) {
    assert.ok(scenarios('recoverable-live').includes(scenario));
    let journey;
    try {
      journey = await browserJourney(browser, base, workloadFor(profile), settingsFor('recoverable-live', scenario, profile));
    } catch (error) {
      console.error('Actual browser errors:', error.evidence?.failures);
      console.error('Last native records:', JSON.stringify(error.evidence?.capture?.records.slice(-5)));
      if (process.env.LIVE_EVIDENCE) {
        await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
        await writeFile(`${process.env.LIVE_EVIDENCE}/leptos-${profile}-${scenario}-failure.json.gz`, gzipSync(JSON.stringify(error.evidence)), { flag: 'wx' });
      }
      throw error;
    }
    assert.equal(journey.configuration.framework, 'leptos');
    assert.deepEqual(journey.capture.records.filter(r => r.kind === 'event').map(r => r.event), wireEvents(journey.network));
    assert.deepEqual(journey.capture.records.filter(r => r.kind === 'snapshot').map(({ through, rows, work }) => ({ through, rows, work })), wireSnapshots(journey.network));
    const writes = journey.network.filter(r => r.kind === 'request' && new URL(r.url).pathname === '/parity/publish');
    const workload = workloadFor(profile);
    let cursor = 0;
    for (const record of journey.capture.records) {
      if (record.kind === 'snapshot') cursor = record.through;
      else if (record.kind === 'event' && record.disposition === 'applied') cursor++;
      else if (record.kind !== 'event') continue;
      const ordered = new Map(workload.initial.map(row => [row.id, row]));
      for (const event of workload.events.slice(0, cursor)) {
        if (event.op === 'remove') ordered.delete(event.key); else ordered.set(event.key, event.row);
      }
      assert.deepEqual(record.state, [...ordered.values()], 'native visible row order drifted');
    }
    assert.deepEqual(writes.flatMap(r => { const body = JSON.parse(r.body); return body.events ?? [body.event]; }), [...workload.events, workload.cleanupProbe]);
    const acks = journey.network.filter(r => r.kind === 'response' && new URL(r.url).pathname === '/parity/publish');
    assert.deepEqual(acks.flatMap(r => { assert.equal(r.status, 200); const body = JSON.parse(r.body); return (body.acks ?? [body]).map(a => a.seq); }), [...workload.events, workload.cleanupProbe].map(e => e.seq));
    if (process.env.LIVE_EVIDENCE) {
      await mkdir(process.env.LIVE_EVIDENCE, { recursive: true });
      await writeFile(`${process.env.LIVE_EVIDENCE}/leptos-${profile}-${scenario}.json.gz`, gzipSync(JSON.stringify(journey)), { flag: 'wx' });
    }
    console.log(`Leptos native ${profile}/${scenario}: actual DOM, raw SSE, HTTP writes/acks, effects, recovery and cleanup passed`);
  }
} finally { await browser.close(); }
