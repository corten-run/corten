import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createLiveWorkload } from '../../../../workloads/live.mjs';

const base = process.argv[2], framework = "phoenix";
assert.ok(base, 'native application URL required');
const settings = { maxRecoveryMs: 2000, maxCleanupMs: 5000, maxPublishLagMs: 5000 };
const workload = createLiveWorkload({ seed: 17, rowCount: 5, eventCount: 24 });
const browser = await chromium.launch({ headless: true });
const failures = [];
const call = (page, method, arg) => page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
const observation = page => page.evaluate(() => ({
  through: +document.querySelector('#effects').dataset.through,
  count: +document.querySelector('#effects').value,
  effects: window.liveApp.records.filter(r => r.kind === 'event' && r.disposition === 'applied').map(r => r.event.effectId),
  rows: [...document.querySelector('#rows').children].map(tr => ({ id: tr.id,
    version: +tr.cells[0].textContent, priceCents: +tr.cells[1].textContent, quantity: +tr.cells[2].textContent })),
}));
async function run(name, body) {
  const context = await browser.newContext();
  const timer = setTimeout(() => context.close().catch(() => {}), 20000);
  try {
    assert.equal((await context.request.post(base + '/parity/configure', { data: {
      initial: workload.initial, queueLimit: 2, historyLimit: 4 } })).status(), 200);
    await body(context);
    console.log(`${framework} ${name}: passed`);
  } catch (error) { failures.push(name + ': ' + error.message); console.error(framework, name, error.message); }
  finally { clearTimeout(timer); await context.close(); }
}
try {
  for (const lost of ['ack', 'event']) await run('overflow after lost ' + lost, async context => {
    const page = await context.newPage();
    let intercepted = false;
    const receipts = [];
    await page.routeWebSocket(url => ['/cable', '/live/websocket'].includes(url.pathname), ws => {
      const server = ws.connectToServer();
      ws.onMessage(data => {
        const frame = JSON.parse(data.toString());
        const action = framework === 'rails' && frame.data ? JSON.parse(frame.data) : frame[4];
        const observed = framework === 'rails' ? action : action?.value;
        if (lost === 'ack' && !intercepted &&
            (action?.action === 'acknowledge' || action?.event === 'acknowledge') && observed?.through === 1) {
          intercepted = true; return;
        }
        server.send(data);
      });
      server.onMessage(data => {
        const frame = JSON.parse(data.toString());
        const messages = framework === 'rails' ? [frame.message] :
          (frame[4]?.e || frame[4]?.response?.diff?.e || []).filter(([name]) => name === 'parity').map(([, value]) => value);
        receipts.push(...messages.filter(Boolean));
        if (lost === 'event' && !intercepted && messages.some(m => m?.kind === 'event' && m.event.seq === 1)) {
          intercepted = true; return;
        }
        ws.send(data);
      });
    });
    await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
    await call(page, 'setup', settings);
    await call(page, 'publish', workload.events[0]);
    if (lost === 'ack') await page.waitForFunction(() => window.liveApp.through === 1);
    else await page.waitForTimeout(100);
    assert.ok(intercepted, 'native frame intercepted');
    console.log(JSON.stringify({ framework, lost, before: await observation(page) }));
    const started = performance.now();
    await call(page, 'settle');
    await call(page, 'publishBatch', workload.events.slice(1, 4));
    await page.waitForFunction(() => window.liveApp.through === 4, null, { timeout: 2000 });
    const after = await observation(page);
    console.log(JSON.stringify({ framework, lost, recoveryMs: performance.now() - started, after,
      native: receipts.filter(m => ['overflow', 'snapshot'].includes(m.kind)) }));
    assert.equal(after.count, lost === 'ack' ? 1 : 0, 'snapshot preserves only actually applied effects');
    assert.deepEqual(after.effects, lost === 'ack' ? [workload.events[0].effectId] : []);
    const expected = new Map(workload.initial.map(row => [row.id, row]));
    for (const event of workload.events.slice(0, 4)) event.op === 'remove' ? expected.delete(event.key) : expected.set(event.key, event.row);
    assert.deepEqual(after.rows.sort((a,b) => a.id.localeCompare(b.id)), [...expected.values()].sort((a,b) => a.id.localeCompare(b.id)));
    await call(page, 'duplicate');
    await call(page, 'publish', workload.events[4]);
    await page.waitForFunction(() => window.liveApp.through === 5, null, { timeout: 2000 });
    assert.equal((await observation(page)).count, after.count + 1);
    await call(page, 'detach');
  });
} finally { await browser.close(); }
assert.deepEqual(failures, []);
