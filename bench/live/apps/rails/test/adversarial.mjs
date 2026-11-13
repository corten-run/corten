import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createLiveWorkload } from '../../../../workloads/live.mjs';

const framework = 'rails', base = process.argv[2];
assert.ok(base, 'native application URL required');
const settings = { group: 'recoverable-live', scenario: 'disconnect', queueLimit: 2, historyLimit: 4,
  slowOutcome: 'resnapshot', maxRecoveryMs: 2000, maxCleanupMs: 5000,
  cleanupObservationMs: 150, maxSlowMs: 10000, maxPublishLagMs: 5000 };
const workload = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: 24 });
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
} finally { await browser.close(); }
assert.deepEqual(failures, [], failures.join('\n'));
