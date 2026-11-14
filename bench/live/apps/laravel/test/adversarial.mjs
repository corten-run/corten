import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createLiveWorkload } from '../../../../workloads/live.mjs';

const base = process.argv[2];
assert.ok(base, 'native Laravel URL required');
const settings = { maxRecoveryMs: 2000, maxCleanupMs: 5000, maxPublishLagMs: 5000 };
const workload = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: 24 });
const browser = await chromium.launch({ headless: true });
const failures = [];
const call = (page, method, arg) => page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
const observed = page => page.evaluate(() => ({ through: window.liveApp.through,
  count: +document.querySelector('#effects').value,
  effects: window.liveApp.records.filter(r => r.kind === 'event' && r.disposition === 'applied').map(r => r.event.effectId),
  rows: [...document.querySelector('#rows').children].map(tr => ({ id: tr.id,
    version: +tr.cells[0].textContent, priceCents: +tr.cells[1].textContent, quantity: +tr.cells[2].textContent })) }));
function expected(through, applied) {
  const rows = new Map(workload.initial.map(row => [row.id, row]));
  for (const event of workload.events.slice(0, through)) {
    if (event.op === 'remove') rows.delete(event.key); else rows.set(event.key, event.row);
  }
  return { through, count: applied.length, effects: applied.map(seq => workload.events[seq - 1].effectId),
    rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
async function checkDOM(page, through, applied) {
  const actual = await observed(page);
  actual.rows.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(actual, expected(through, applied));
  return actual;
}
function receipt(fault, began, fields) {
  const recoveryMs = performance.now() - began;
  assert.ok(recoveryMs <= settings.maxRecoveryMs, `${fault} recovery ${recoveryMs}ms exceeded ${settings.maxRecoveryMs}ms`);
  console.log(JSON.stringify({ fault, recoveryMs, ...fields }));
}
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('native deadline exceeded')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function start(context) {
  const page = await context.newPage();
  await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
  await call(page, 'setup', settings);
  return page;
}
async function wait(page, through) {
  await page.waitForFunction(value => window.liveApp.through === value, through, { timeout: settings.maxRecoveryMs });
  await bounded(call(page, 'settle'), settings.maxRecoveryMs);
}
const resources = context => context.request.get(base + '/parity/resources').then(response => response.json());
async function run(name, body) {
  const context = await browser.newContext();
  const timer = setTimeout(() => context.close().catch(() => {}), 25000);
  try {
    assert.equal((await context.request.post(base + '/parity/configure', { data: {
      initial: workload.initial, queueLimit: 2, historyLimit: 4 } })).status(), 200);
    await body(context);
    const empty = await resources(context);
    for (const key of ['subscriptions', 'connections', 'pendingTasks', 'queueEvents']) assert.equal(empty[key], 0);
    console.log(JSON.stringify({ cleanup: name, subscriptions: empty.subscriptions, connections: empty.connections,
      pendingTasks: empty.pendingTasks, queueEvents: empty.queueEvents }));
    console.log('Laravel native adversarial ' + name + ': passed');
  } catch (error) {
    failures.push(name + ': ' + error.message);
    console.error('Laravel native adversarial ' + name + ': ' + error.stack);
  } finally {
    clearTimeout(timer);
    for (const page of context.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
}
function reverbPacket(data) {
  const frame = JSON.parse(data.toString());
  if (frame.event !== 'delivery') return null;
  return (typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data).packet;
}
async function suppressAck(page) {
  let suppressed = false, resolve;
  const seen = new Promise(done => { resolve = done; });
  await page.route(/\/livewire(?:\/|-).*update/, async route => {
    const body = route.request().postDataJSON();
    for (const component of body.components || []) {
      component.calls = component.calls.filter(action => {
        if (!suppressed && action.method === 'acknowledge' && action.params[0]?.through === 1) {
          suppressed = true; resolve(); return false;
        }
        return true;
      });
    }
    // Drop only the ACK operation. Laravel returns a genuine signed native
    // no-action response, so this does not forge a response or poison $call.
    await route.continue({ postData: JSON.stringify(body) });
  });
  return { seen, get suppressed() { return suppressed; } };
}
try {
  for (const overflow of [false, true]) await run('lost Reverb event then ' + (overflow ? 'overflow' : 'reconnect'), async context => {
    const page = await context.newPage();
    let dropped = false;
    let confirmDrop;
    const dropSeen = new Promise(resolve => { confirmDrop = resolve; });
    await page.routeWebSocket(url => url.pathname.startsWith('/app/'), ws => {
      const server = ws.connectToServer();
      server.onMessage(data => {
        const packet = reverbPacket(data);
        if (!dropped && packet?.event?.seq === 1) { dropped = true; confirmDrop(); return; }
        ws.send(data);
      });
    });
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    await call(page, 'publish', workload.events[0]);
    await bounded(dropSeen, settings.maxRecoveryMs);
    assert.ok(dropped);
    await checkDOM(page, 0, []);
    const began = performance.now();
    if (overflow) {
      await call(page, 'publishBatch', workload.events.slice(1, 4)); await wait(page, 4);
      await checkDOM(page, 4, []);
      await call(page, 'duplicate'); await call(page, 'publish', workload.events[4]); await wait(page, 5);
      await checkDOM(page, 5, [5]);
    } else {
      await bounded(call(page, 'disconnect'), settings.maxCleanupMs);
      await bounded(call(page, 'reconnect'), settings.maxRecoveryMs); await wait(page, 1);
      await checkDOM(page, 1, [1]);
    }
    receipt('lost-Reverb-event', began, { overflow, actual: await observed(page) });
    await call(page, 'detach');
  });
  await run('automatic native reconnect resumes after publication before second start', async context => {
    const page = await context.newPage();
    const sockets = [], deliveries = [], starts = [], nativeEvents = [];
    await page.routeWebSocket(url => url.pathname.startsWith('/app/'), ws => {
      const server = ws.connectToServer(); sockets.push({ ws, server });
      // connectToServer uses a browser WebSocket: its close() cannot send 1001.
      ws.onClose((code, reason) => server.close({ code: code === 1000 || code >= 3000 && code <= 4999 ? code : 1000, reason }));
      server.onClose((code, reason) => ws.close({ code, reason }));
      server.onMessage(data => {
        const packet = reverbPacket(data);
        if (packet?.event) deliveries.push(packet.event.seq);
        ws.send(data);
      });
    });
    page.on('response', async response => {
      if (!/\/livewire(?:\/|-).*update/.test(response.url()) || response.status() !== 200) return;
      const body = await response.json();
      for (const component of body.components || []) for (const dispatch of component.effects?.dispatches || []) {
        if (dispatch.name === 'parity' && dispatch.params.packet.kind === 'event') nativeEvents.push(dispatch.params.packet.event.seq);
      }
    });
    await page.route(/\/livewire(?:\/|-).*update/, async route => {
      const body = route.request().postDataJSON();
      for (const component of body.components || []) for (const action of component.calls) {
        if (action.method !== 'start') continue;
        starts.push(action.params);
        if (starts.length === 2) {
          assert.deepEqual(action.params, [1, false, { through: 1, effectCount: 1, rowCount: 5 }]);
          const response = await context.request.post(base + '/parity/publish', { data: { event: workload.events[1] } });
          assert.equal(response.status(), 200);
        }
      }
      await route.continue();
    });
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    await call(page, 'publish', workload.events[0]); await wait(page, 1);
    const began = performance.now();
    await sockets[0].server.close({ code: 1000 }); await sockets[0].ws.close({ code: 1001 });
    try { await wait(page, 2); } catch (error) {
      console.error('automatic reconnect at deadline', JSON.stringify({ sockets: sockets.length, starts, deliveries, nativeEvents,
        actual: await observed(page), resources: await resources(context),
        records: await page.evaluate(() => window.liveApp.records.slice(-8)) }));
      throw error;
    }
    assert.equal(sockets.length, 2); assert.equal(starts.length, 2);
    assert.ok(deliveries.includes(2)); assert.ok(nativeEvents.includes(2));
    assert.deepEqual(await page.evaluate(() => window.liveApp.records.filter(r => r.kind === 'snapshot').map(r => r.through)), [0]);
    receipt('automatic-native-reconnect', began, { starts, deliveries, nativeEvents, actual: await checkDOM(page, 2, [1, 2]) });
    await call(page, 'detach');
  });
  for (const overflow of [false, true]) await run('lost native ACK ' + (overflow ? 'then overflow' : 'then reconnect'), async context => {
    const page = await context.newPage();
    const fault = await suppressAck(page);
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    await call(page, 'publish', workload.events[0]);
    await bounded(fault.seen, settings.maxRecoveryMs); await wait(page, 1);
    assert.ok(fault.suppressed);
    await checkDOM(page, 1, [1]);
    assert.equal((await resources(context)).inventory.stagedClientRows, 5, 'render remains staged without ACK');
    const began = performance.now();
    if (overflow) {
      await call(page, 'publishBatch', workload.events.slice(1, 4)); await wait(page, 4);
      await checkDOM(page, 4, [1]);
      await call(page, 'duplicate');
      await call(page, 'publish', workload.events[4]); await wait(page, 5);
      await checkDOM(page, 5, [1, 5]);
    } else {
      await call(page, 'disconnect');
      await bounded(call(page, 'reconnect'), settings.maxRecoveryMs); await wait(page, 1);
      await checkDOM(page, 1, [1]);
    }
    receipt('lost-native-ACK', began, { overflow, actual: await observed(page) });
    await call(page, 'detach');
  });
  await run('two cookie-sharing tabs own independent readers and cleanup', async context => {
    const pages = [await start(context), await start(context)];
    const ids = await Promise.all(pages.map(page => page.evaluate(() => window.liveApp.consumerId)));
    assert.notEqual(ids[0], ids[1]);
    await call(pages[0], 'publish', workload.events[0]); await Promise.all(pages.map(page => wait(page, 1)));
    for (const page of pages) await checkDOM(page, 1, [1]);
    await bounded(call(pages[0], 'disconnect'), settings.maxCleanupMs);
    const remaining = await resources(context);
    for (const key of ['subscriptions', 'connections', 'pendingTasks']) {
      assert.equal(remaining[key], 1);
      assert.equal(remaining.inventory.consumers[ids[0]][key], 0);
      assert.equal(remaining.inventory.consumers[ids[1]][key], 1);
    }
    await call(pages[1], 'publish', workload.events[1]); await wait(pages[1], 2);
    await checkDOM(pages[0], 1, [1]);
    await bounded(call(pages[0], 'reconnect'), settings.maxRecoveryMs); await wait(pages[0], 2);
    await checkDOM(pages[0], 2, [1, 2]);
    await bounded(call(pages[0], 'detach'), settings.maxCleanupMs);
    const detached = await resources(context);
    assert.equal(detached.connections, 1); assert.equal(detached.subscriptions, 1);
    assert.equal(detached.inventory.consumers[ids[0]], undefined);
    await call(pages[1], 'publish', workload.events[2]); await wait(pages[1], 3);
    await checkDOM(pages[0], 2, [1, 2]);
    await call(pages[1], 'detach');
  });
  await run('unknown resource counts cannot prove cleanup', async context => {
    const page = await start(context);
    const id = await page.evaluate(() => window.liveApp.consumerId);
    let unknown = true, intercepted;
    const seen = new Promise(resolve => { intercepted = resolve; });
    await page.route('**/parity/resources', async route => {
      if (!unknown) { await route.continue(); return; }
      const response = await route.fetch(), value = await response.json();
      assert.ok(value.inventory.consumers[id]);
      value.inventory.consumers[id] = { subscriptions: null, connections: null, pendingTasks: null, queueEvents: null };
      await route.fulfill({ response, json: value }); intercepted();
    });
    let released = false;
    const pending = call(page, 'released').then(() => { released = true; });
    try {
      await bounded(seen, 2000);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(released, false);
    } finally { unknown = false; await call(page, 'detach'); await pending; }
  });
  await run('overlapping publishers cannot render before first HTTP ACK', async context => {
    const page = await context.newPage();
    let written, release;
    const seen = new Promise(resolve => { written = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/parity/publish', async route => {
      if (route.request().postDataJSON().event?.seq !== 1) { await route.continue(); return; }
      const response = await route.fetch(); assert.equal(response.status(), 200);
      written(); await gate; await route.fulfill({ response });
    });
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    const pending = [call(page, 'publish', workload.events[0])];
    try {
      await bounded(seen, 5000);
      pending.push(call(page, 'publish', workload.events[1]));
      await new Promise(resolve => setTimeout(resolve, 250));
      await checkDOM(page, 0, []);
      assert.equal(await page.evaluate(() => window.liveApp.records.filter(r => r.kind === 'publish').length), 0);
    } finally { release(); await Promise.all(pending); }
    await wait(page, 2); await checkDOM(page, 2, [1, 2]); await call(page, 'detach');
  });
} finally { await browser.close(); }
assert.deepEqual(failures, [], failures.join('\n'));
