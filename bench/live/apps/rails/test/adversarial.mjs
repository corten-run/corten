import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createLiveWorkload } from '../../../../workloads/live.mjs';

const framework = 'rails', base = process.argv[2];
assert.ok(base, 'native application URL required');
const settings = { group: 'recoverable-live', scenario: 'disconnect', queueLimit: 2, historyLimit: 4,
  slowOutcome: 'resnapshot', maxRecoveryMs: 2000, maxCleanupMs: 5000,
  cleanupObservationMs: 150, maxSlowMs: 10000, maxPublishLagMs: 5000 };
const workload = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: 24 });
const rowCountAt = through => {
  const rows = new Map(workload.initial.map(row => [row.id, row]));
  for (const event of workload.events.slice(0, through)) {
    if (event.op === 'remove') rows.delete(event.key); else rows.set(event.key, event.row);
  }
  return rows.size;
};
const browser = await chromium.launch({ headless: true });
const failures = [];
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native recovery deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function run(name, body) {
  const context = await browser.newContext();
  const deadline = setTimeout(() => context.close().catch(() => {}), 20000);
  try {
    const response = await context.request.post(base + '/parity/configure', { data: {
      initial: workload.initial, queueLimit: 2, historyLimit: 4 } });
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).framework, framework);
    await body(context);
    console.log(`${framework} native adversarial ${name}: passed`);
  } catch (error) { failures.push(`${name}: ${error.message}`); console.error(`${framework} ${name}: ${error.message}`); }
  finally { clearTimeout(deadline); await context.close(); }
}
const call = (page, method, arg) => page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
const observed = page => page.evaluate(() => ({ through: window.liveApp.through,
  count: +document.querySelector('#effects').value,
  effects: window.liveApp.records.filter(r => r.kind === 'event' && r.disposition === 'applied').map(r => r.event.effectId),
  rows: document.querySelector('#rows').children.length }));
try {
  await run('lost native event before browser acknowledgement', async context => {
    const page = await context.newPage();
    let dropped;
    const droppedNativeFrame = new Promise(resolve => { dropped = resolve; });
    let intercepted = false;
    await page.routeWebSocket(url => ['/cable', '/live/websocket'].includes(url.pathname), ws => {
      const server = ws.connectToServer();
      server.onMessage(data => {
        const frame = JSON.parse(data.toString());
        const messages = framework === 'rails' ? [frame.message] : (frame[4]?.e || frame[4]?.response?.diff?.e || []).filter(([name]) => name === 'parity').map(([, value]) => value);
        const event = messages.find(message => message?.kind === 'event' && message.event.seq === 1)?.event;
        if (event && !intercepted) { intercepted = true; dropped(event); return; }
        ws.send(data);
      });
    });
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    await call(page, 'publish', workload.events[0]);
    assert.deepEqual(await bounded(droppedNativeFrame, 5000), workload.events[0]);
    assert.deepEqual(await observed(page), { through: 0, count: 0, effects: [], rows: 5 });
    await call(page, 'disconnect');
    await bounded(call(page, 'reconnect'), settings.maxRecoveryMs);
    await page.waitForFunction(() => window.liveApp.through === 1, null, { timeout: settings.maxRecoveryMs });
    assert.deepEqual(await observed(page), { through: 1, count: 1, effects: [workload.events[0].effectId], rows: 5 });
    await call(page, 'detach');
  });
  await run('lost browser acknowledgement retains exactly one real effect', async context => {
    const page = await context.newPage();
    let dropped;
    const droppedAck = new Promise(resolve => { dropped = resolve; });
    let intercepted = false;
    await page.routeWebSocket(url => ['/cable', '/live/websocket'].includes(url.pathname), ws => {
      const server = ws.connectToServer();
      ws.onMessage(data => {
        const frame = JSON.parse(data.toString());
        const action = framework === 'rails' && frame.data ? JSON.parse(frame.data) : frame[4];
        const observed = framework === 'rails' ? action : action?.value;
        if (!intercepted && (action?.action === 'acknowledge' || action?.event === 'acknowledge') && observed?.through === 1) {
          intercepted = true; dropped(); return;
        }
        server.send(data);
      });
    });
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    await call(page, 'publish', workload.events[0]);
    await bounded(droppedAck, 5000);
    assert.deepEqual(await observed(page), { through: 1, count: 1, effects: [workload.events[0].effectId], rows: 5 });
    await call(page, 'disconnect');
    await bounded(call(page, 'reconnect'), settings.maxRecoveryMs);
    await page.waitForFunction(() => window.liveApp.records.some(r => r.kind === 'event' && r.disposition === 'duplicate'), null, { timeout: settings.maxRecoveryMs });
    assert.deepEqual(await observed(page), { through: 1, count: 1, effects: [workload.events[0].effectId], rows: 5 });
    await call(page, 'detach');
  });
  await run('two pages sharing the native session remain independent consumers', async context => {
    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) {
      await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
      await call(page, 'setup', settings);
    }
    await call(pages[0], 'publish', workload.events[0]);
    await Promise.all(pages.map(page => page.waitForFunction(() => window.liveApp.through === 1, null, { timeout: 10000 })));
    for (const page of pages) assert.deepEqual(await observed(page), { through: 1, count: 1, effects: [workload.events[0].effectId], rows: 5 });
    await Promise.all(pages.map(page => call(page, 'detach')));
    const resources = await (await context.request.get(base + '/parity/resources')).json();
    for (const key of ['subscriptions', 'connections', 'pendingTasks', 'queueEvents']) assert.equal(resources[key], 0);
  });
  await run('one consumer disconnects and detaches while its peer keeps receiving', async context => {
    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) {
      await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
      await call(page, 'setup', settings);
    }
    await call(pages[0], 'publish', workload.events[0]);
    await Promise.all(pages.map(page => page.waitForFunction(() => window.liveApp.through === 1)));
    await bounded(call(pages[0], 'disconnect'), settings.maxCleanupMs + 500);
    const ids = await Promise.all(pages.map(page => page.evaluate(() => window.liveApp.consumerId)));
    assert.ok(ids.every(id => typeof id === 'string' && id.length > 20));
    assert.notEqual(ids[0], ids[1]);
    const resources = async () => (await context.request.get(base + '/parity/resources')).json();
    const remaining = await resources();
    for (const key of ['subscriptions', 'connections', 'pendingTasks']) {
      assert.equal(remaining[key], 1, 'peer remains active');
      assert.equal(remaining.inventory.consumers[ids[0]][key], 0, 'only disconnected consumer is released');
      assert.equal(remaining.inventory.consumers[ids[1]][key], 1);
    }
    await call(pages[1], 'publish', workload.events[1]);
    await pages[1].waitForFunction(() => window.liveApp.through === 2);
    assert.equal((await observed(pages[0])).through, 1);
    await bounded(call(pages[0], 'reconnect'), settings.maxRecoveryMs);
    await pages[0].waitForFunction(() => window.liveApp.through === 2);
    for (const page of pages) assert.deepEqual(await observed(page), {
      through: 2, count: 2, effects: workload.events.slice(0, 2).map(event => event.effectId), rows: rowCountAt(2) });
    await bounded(call(pages[0], 'detach'), settings.maxCleanupMs + 500);
    const detached = await resources();
    assert.equal(detached.connections, 1); assert.equal(detached.subscriptions, 1);
    assert.equal(detached.inventory.consumers[ids[0]], undefined);
    await call(pages[1], 'publish', workload.events[2]);
    await pages[1].waitForFunction(() => window.liveApp.through === 3);
    assert.equal((await observed(pages[0])).through, 2);
    await call(pages[1], 'detach');
    const empty = await resources();
    for (const key of ['subscriptions', 'connections', 'pendingTasks', 'queueEvents']) assert.equal(empty[key], 0);
  });
  await run('unknown per-consumer counters cannot prove cleanup', async context => {
    const page = await context.newPage();
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    const id = await page.evaluate(() => window.liveApp.consumerId);
    let intercepted;
    const seen = new Promise(resolve => { intercepted = resolve; });
    let unknown = true;
    await page.route('**/parity/resources', async route => {
      if (!unknown) { await route.continue(); return; }
      const response = await route.fetch();
      const value = await response.json();
      assert.ok(value.inventory.consumers[id], 'native consumer remains active');
      value.inventory.consumers[id] = {
        subscriptions: null, connections: null, pendingTasks: null, queueEvents: null,
      };
      await route.fulfill({ response, json: value });
      intercepted();
    });
    let released = false;
    const pending = call(page, 'released').then(() => { released = true; });
    try {
      await bounded(seen, 5000);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(released, false, 'unknown counters are not observed zero');
    } finally {
      unknown = false;
      await call(page, 'detach');
      await pending;
    }
  });
  await run('overlapping publications cannot bypass the earlier native acknowledgement', async context => {
    const page = await context.newPage();
    let written, releaseHttp, releaseFrame;
    const firstWritten = new Promise(resolve => { written = resolve; });
    const httpGate = new Promise(resolve => { releaseHttp = resolve; });
    const frameGate = new Promise(resolve => { releaseFrame = resolve; });
    await page.route('**/parity/publish', async route => {
      if (route.request().postDataJSON().event.seq !== 1) { await route.continue(); return; }
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      written(); await httpGate; await route.fulfill({ response });
    });
    await page.routeWebSocket(url => ['/cable', '/live/websocket'].includes(url.pathname), ws => {
      const server = ws.connectToServer();
      server.onMessage(async data => {
        const frame = JSON.parse(data.toString());
        const messages = framework === 'rails' ? [frame.message] : (frame[4]?.e || frame[4]?.response?.diff?.e || []).filter(([name]) => name === 'parity').map(([, value]) => value);
        if (messages.some(message => message?.kind === 'event' && message.event.seq === 1)) await frameGate;
        ws.send(data);
      });
    });
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    const pending = [call(page, 'publish', workload.events[0])];
    try {
      await bounded(firstWritten, 5000);
      pending.push(call(page, 'publish', workload.events[1]));
      await new Promise(resolve => setTimeout(resolve, 200));
      releaseFrame();
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(await observed(page), { through: 0, count: 0, effects: [], rows: 5 },
        'actual native DOM must not advance before the held first publication acknowledgement');
      assert.equal(await page.evaluate(() => window.liveApp.records.filter(r => r.kind === 'publish').length), 0);
    } finally {
      releaseHttp(); releaseFrame();
      await Promise.all(pending);
    }
    await page.waitForFunction(() => window.liveApp.through === 2);
    assert.deepEqual(await observed(page), { through: 2, count: 2,
      effects: workload.events.slice(0, 2).map(event => event.effectId), rows: rowCountAt(2) });
    await call(page, 'detach');
  });
} finally { await browser.close(); }
assert.deepEqual(failures, [], failures.join('\n'));
