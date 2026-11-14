import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base = process.argv[2];
assert.ok(base, 'native application URL required');
const request = (path, data) => fetch(base + '/parity/' + path, data === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const row = { id: 'a', version: 0, priceCents: 12, quantity: 2 };
const event = seq => ({ seq, effectId: `e-${seq}`, key: 'a', op: 'upsert', row: { ...row, version: seq } });
assert.equal((await request('configure', { initial: [row, row], queueLimit: 2, historyLimit: 4 })).status, 400);
assert.equal((await request('configure', { initial: [row], queueLimit: 2, historyLimit: 4 })).status, 200);
const before = await (await request('snapshot')).json();
for (const input of [{ event: event(2) }, { events: [event(1)] }, { event: { ...event(1), op: 'bad' } },
  { event: { ...event(1), row: { ...row, id: 'b' } } }]) {
  assert.equal((await request('publish', input)).status, 400);
  assert.deepEqual(await (await request('snapshot')).json(), before);
}
const browser = await chromium.launch({ headless: true }), contexts = [], pages = [], clients = [], errors = [];
const deadline = setTimeout(() => browser.close().catch(() => {}), 90000);
try {
  for (let i = 0; i < 16; i++) {
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message));
    assert.equal((await page.goto(base)).status(), 200);
    clients.push(await page.locator('#parity-app').getAttribute('data-client'));
    await page.waitForFunction(() => !!window.liveApp);
    await page.evaluate(() => window.liveApp.setup({ maxCleanupMs: 5000 }));
  }
  assert.equal((await fetch(base)).status, 429);
  assert.equal((await request('configure', { initial: [], queueLimit: 2, historyLimit: 4 })).status, 409);
  const resources = await (await request('resources')).json();
  for (const name of ['subscriptions', 'connections', 'pendingTasks']) assert.equal(resources[name], 16);
  assert.equal(resources.inventory.clients, 16);
  assert.equal((await request('finish', { client: clients[0] })).status, 409);
  assert.equal((await request('acknowledge', { client: clients[0], serial: 999999 })).status, 400);
  assert.equal((await request('control', { action: 'hold' })).status, 200);
  for (let seq = 1; seq <= 2; seq++) {
    const response = await request('publish', { event: event(seq) }); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.seq, seq); assert.equal(body.resources.queueEvents, 16 * seq);
  }
  const overflow = await request('publish', { event: event(3) }); assert.equal(overflow.status, 200);
  assert.equal((await overflow.json()).resources.queuePeak, 2);
  assert.equal((await request('publisher-ack', { through: 4 })).status, 400);
  assert.equal((await request('publisher-ack', { through: 3 })).status, 200);
  await Promise.all(pages.map(page => page.waitForFunction(() => window.liveApp.through === 3)));
  assert.deepEqual(errors, []);
} finally {
  await Promise.all(contexts.map(context => context.close()));
  clearTimeout(deadline); await browser.close();
}
const cleanupDeadline = performance.now() + 5000;
for (;;) {
  const r = await (await request('resources')).json();
  if (r.connections + r.pendingTasks + r.subscriptions + r.queueEvents === 0) break;
  assert.ok(performance.now() < cleanupDeadline, 'cancelled native render bodies leaked');
  await new Promise(resolve => setTimeout(resolve, 10));
}
// No synthetic finish: the real inactive retention policy must free all slots.
const retentionDeadline = performance.now() + 33000;
for (;;) {
  const r = await (await request('resources')).json();
  if (r.inventory.clients === 0) break;
  assert.ok(performance.now() < retentionDeadline, 'abrupt contexts retained client rows past their reconnect grace');
  await new Promise(resolve => setTimeout(resolve, 100));
}
for (const client of clients) {
  assert.equal((await (await request(`reader?client=${encodeURIComponent(client)}`)).json()).registered, false);
}
assert.equal((await (await request('resources')).json()).inventory.clients, 0);
console.log('Topcoat native HTTP/browser: invalid writes atomic; 16 live readers; real saturation; rejection; cancelled native renders and retained clients released');
