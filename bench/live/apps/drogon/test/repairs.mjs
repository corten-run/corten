// Real native-image regressions. Routing delays/aborts actual HTTP, never forges an ack or frame.
import assert from 'node:assert/strict';
import { createLiveWorkload, liveSnapshot } from '../../../../workloads/live.mjs';
import { wireEvents, wireSnapshots } from '../wire.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const base = process.argv[2]; assert.ok(base, 'isolated native app URL required');
const fixture = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: 6 });
const settings = { maxCleanupMs: 5000 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function api(name, input) {
  const response = await fetch(base + '/parity/' + name, { signal: AbortSignal.timeout(10000), ...(input === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }) }); assert.equal(response.status, 200); return response.json();
}
async function readers(expected) {
  const deadline = performance.now() + 5000;
  while (true) {
    const value = await api('resources');
    if (value.connections === expected && value.subscriptions === expected && value.pendingTasks === expected) {
      assert.ok(value.queueEvents <= expected * 2 && value.queuePeak <= 2 && value.historyPeak <= 4);
      if (!expected) for (const field of ['queueEvents', 'replayEvents', 'inFlight', 'overflowSlots']) {
        assert.equal(field === 'queueEvents' ? value[field] : value.inventory[field], 0);
      }
      return value;
    }
    assert.ok(performance.now() < deadline, `expected ${expected} native readers, got ${JSON.stringify(value)}`); await delay(10);
  }
}
const browser = await chromium.launch({ headless: true });
let contexts = [];
async function open() {
  const context = await browser.newContext(); contexts.push(context);
  const page = await context.newPage(), network = [], errors = [], pending = [], failed = [];
  page.setDefaultTimeout(10000);
  const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
  for (const [name, kind] of [['Network.webSocketCreated', 'native-websocket-created'],
    ['Network.webSocketFrameReceived', 'native-websocket-received'], ['Network.webSocketFrameSent', 'native-websocket-sent']]) {
    cdp.on(name, value => network.push({ kind, ...value }));
  }
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('request', request => network.push({ kind: 'request', url: request.url(), body: request.postData() }));
  page.on('response', response => {
    if (!response.headers()['content-type']?.includes('application/json')) return;
    const value = { kind: 'response', url: response.url(), status: response.status() }; network.push(value);
    const body = response.text().then(body => { value.body = body; });
    body.catch(() => {}); pending.push(body);
  });
  await page.goto(base); await page.evaluate(settings => window.liveApp.setup(settings), settings);
  const call = (method, arg) => page.evaluate(({ method, arg }) => window.liveApp[method](arg), { method, arg });
  const wait = async seq => { await page.waitForFunction(seq => window.liveApp.through === seq, seq); await call('settle'); };
  const records = () => page.evaluate(() => window.liveApp.records);
  const state = async seq => {
    await call('state'); const value = (await records()).at(-1);
    assert.equal(value.through, seq);
    assert.deepEqual([...value.rows].sort((a, b) => a.id.localeCompare(b.id)), liveSnapshot(fixture, seq).rows);
    return value;
  };
  const raw = async () => {
    await Promise.all(pending); const values = await records();
    assert.deepEqual(values.filter(value => value.kind === 'event').map(value => value.event), wireEvents(network));
    assert.deepEqual(values.filter(value => value.kind === 'snapshot').map(({ through, rows, work }) => ({ through, rows, work })), wireSnapshots(network));
  };
  return { page, context, network, errors, failed, call, wait, records, state, raw };
}
async function outcome(reader, method) {
  return reader.page.evaluate(async method => {
    const started = performance.now(); let timer;
    try {
      return await Promise.race([
        window.liveApp[method]().then(() => ({ ok: true, elapsedMs: performance.now() - started }),
          error => ({ ok: false, error: error.message, elapsedMs: performance.now() - started })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: '10-second deadline', elapsedMs: performance.now() - started }), 10000); }),
      ]);
    } finally { clearTimeout(timer); }
  }, method);
}
const cases = {
  async overlapping() {
    const reader = await open(), held = deferred(), release = deferred();
    await reader.page.route('**/parity/publish', async route => {
      const seq = route.request().postDataJSON().event?.seq;
      if (seq !== 1) { if (seq === 2) await held.promise; return route.continue(); }
      const response = await route.fetch(); assert.equal(response.status(), 200); assert.equal((await response.json()).seq, 1);
      held.resolve(); await release.promise; await route.fulfill({ response });
    });
    try {
      await reader.page.evaluate(events => {
        window.overlap = Promise.all(events.map(event => window.liveApp.publish(event)));
        window.overlap.catch(() => {});
      }, fixture.events.slice(0, 2));
      await held.promise;
      // Native event 1 must really arrive while its actual HTTP acknowledgement is held.
      await reader.page.waitForFunction(() => window.liveApp.records.some(value => value.kind === 'publish' && value.seq === 2), null, { timeout: 350 }).catch(error => {
        if (error.name !== 'TimeoutError') throw error;
      });
      assert.ok(reader.network.some(value => value.kind === 'native-websocket-received' && JSON.parse(value.response.payloadData).event?.seq === 1));
      const premature = (await reader.records()).filter(value => ['publish', 'event'].includes(value.kind));
      release.resolve(); await reader.page.evaluate(() => window.overlap); await reader.wait(2);
      const order = (await reader.records()).filter(value => ['publish', 'event'].includes(value.kind)).map(value => `${value.kind}:${value.seq ?? value.event.seq}`);
      assert.equal(premature.length, 0, `work escaped held acknowledgement: ${order.join(',')}`);
      assert.ok(order.indexOf('publish:1') < order.indexOf('publish:2'), order.join(','));
      for (const seq of [1, 2]) assert.ok(order.indexOf(`publish:${seq}`) < order.indexOf(`event:${seq}`), order.join(','));
      assert.deepEqual((await reader.state(2)).effects, fixture.events.slice(0, 2).map(event => event.effectId));
      await reader.raw(); assert.deepEqual(reader.errors, []); await reader.call('detach'); await readers(0);
      console.log('overlapping: real delayed HTTP ack, ordered publications/effects, raw native WS and zero resources passed');
    } finally { release.resolve(); }
  },
  async snapshotFailure() {
    const reader = await open();
    await reader.call('publish', fixture.events[0]); await reader.wait(1); await reader.call('drop', 2);
    await reader.page.route('**/parity/snapshot', route => route.abort('failed'), { times: 1 });
    const failedRead = reader.page.waitForEvent('pageerror', { predicate: error => error.message.includes('Failed to fetch') });
    await reader.call('publish', fixture.events[1]); await reader.call('publish', fixture.events[2]); await failedRead;
    assert.ok(reader.failed.some(value => new URL(value.url).pathname === '/parity/snapshot'));
    const settle = await outcome(reader, 'settle');
    assert.equal(settle.ok, false); assert.match(settle.error, /Failed to fetch/);
    assert.equal((await reader.state(1)).effectCount, 1, 'failed snapshot fabricated effects');
    await readers(0);
    const gap = reader.network.filter(value => value.kind === 'native-websocket-received')
      .map(value => JSON.parse(value.response.payloadData)).find(value => value.event?.seq === 3);
    assert.ok(gap, 'actual gap frame missing');
    assert.equal(reader.network.filter(value => value.kind === 'native-websocket-sent')
      .map(value => JSON.parse(value.response.payloadData)).some(value => value.kind === 'ack' && value.delivery === gap.delivery), false,
    'failed snapshot falsely acknowledged native delivery');
    const disconnected = await outcome(reader, 'disconnect'), disconnectedResources = await api('resources');
    const reconnected = await outcome(reader, 'reconnect'), reconnectedResources = await api('resources');
    assert.equal(disconnected.ok, true, `disconnect retained failed chain: ${JSON.stringify({ disconnected, disconnectedResources, reconnected, reconnectedResources })}`);
    assert.equal(reconnected.ok, true, `reconnect poisoned: ${JSON.stringify({ reconnected, reconnectedResources })}`);
    await reader.wait(3); assert.equal((await reader.state(3)).effectCount, 1);
    await reader.call('publish', fixture.events[3]); await reader.wait(4);
    const values = await reader.records();
    assert.ok(values.some(value => value.kind === 'failure' && value.message.includes('Failed to fetch')), 'actual snapshot failure lost');
    assert.equal(reader.errors.filter(value => value.includes('Failed to fetch')).length, 1);
    assert.deepEqual((await reader.state(4)).effects, [fixture.events[0].effectId, fixture.events[3].effectId]);
    await reader.raw(); await reader.call('detach'); await readers(0);
    console.log('snapshotFailure: actual failed fetch preserved, failed reader cleaned, reconnect/resnapshot and subsequent native consumption passed');
  },
  async independent() {
    const first = await open(), second = await open(); await readers(2);
    await first.call('publish', fixture.events[0]); await Promise.all([first.wait(1), second.wait(1)]);
    const disconnected = await outcome(first, 'disconnect'); const remaining = await readers(1);
    assert.equal(disconnected.ok, true, `healthy peer prevented own cleanup: ${JSON.stringify({ disconnected, remaining })}`);
    assert.ok(disconnected.elapsedMs < settings.maxCleanupMs);
    await first.call('released');
    const scoped = (await first.records()).filter(value => value.kind === 'resources').at(-1);
    assert.equal(scoped.connections, 1, 'aggregate peer resources fabricated as zero');
    assert.equal(scoped.reader.connections, 0); assert.equal(scoped.reader.pendingTasks, 0);
    const ready = first.network.filter(value => value.kind === 'native-websocket-received').map(value => JSON.parse(value.response.payloadData)).find(value => value.kind === 'ready');
    assert.equal(scoped.reader.id, ready.readerId);
    await second.call('publish', fixture.events[1]); await second.wait(2); await first.state(1);
    await first.call('reconnect'); await first.wait(2); await readers(2);
    await second.call('publish', fixture.events[2]); await Promise.all([first.wait(3), second.wait(3)]);
    await first.call('detach'); await readers(1);
    await second.call('publish', fixture.events[3]); await second.wait(4); await first.call('released'); await first.state(3);
    assert.deepEqual((await second.state(4)).effects, fixture.events.slice(0, 4).map(event => event.effectId));
    await first.raw(); await second.raw(); assert.deepEqual([...first.errors, ...second.errors], []);
    await second.call('detach'); await readers(0);
    console.log('independent: own native identity released while healthy peer remains counted/live; replay, detach, raw WS/DOM and final zero resources passed');
  },
};
let failures = 0;
try {
  for (const [name, check] of Object.entries(cases)) {
    await readers(0); await api('configure', { initial: fixture.initial, queueLimit: 2, historyLimit: 4 });
    try { await check(); }
    catch (error) { failures++; console.error(`${name}: FAILED`, error.message); }
    finally { await Promise.all(contexts.map(context => context.close())); contexts = []; await readers(0); }
  }
} finally { await browser.close(); }
if (failures) process.exitCode = 1;
