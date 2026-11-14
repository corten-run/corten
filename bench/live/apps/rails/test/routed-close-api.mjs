// Unrouted native probe for the browser API used by Playwright's upstream route.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = process.argv[2];
assert.ok(base, 'native application URL required');
const browser = await chromium.launch({ headless: true });
const summary = value => ({ connections: value.connections, subscriptions: value.subscriptions,
  pendingTasks: value.pendingTasks, queueEvents: value.queueEvents, retainedClients: value.inventory.retainedClients });
const empty = { connections: 0, subscriptions: 0, pendingTasks: 0, queueEvents: 0, retainedClients: 0 };
try {
  const context = await browser.newContext();
  const timer = setTimeout(() => context.close().catch(() => {}), 10000);
  try {
    const resources = async () => (await context.request.get(base + '/parity/resources')).json();
    assert.deepEqual(summary(await resources()), empty, 'isolated native application required');
    const page = await context.newPage();
    await page.goto(base);
    const invalid = await page.evaluate(async () => {
      window.closeProbe = new WebSocket(location.origin.replace(/^http/, 'ws') + '/cable', ['actioncable-v1-json']);
      await new Promise((resolve, reject) => {
        closeProbe.onmessage = event => { if (JSON.parse(event.data).type === 'welcome') resolve(); };
        closeProbe.onerror = () => reject(new Error('native cable connection failed'));
      });
      try { closeProbe.close(1001, 'native interruption'); return { threw: false }; }
      catch (error) { return { threw: true, name: error.name, message: error.message, readyState: closeProbe.readyState }; }
    });
    assert.equal(invalid.threw, true);
    assert.equal(invalid.name, 'InvalidAccessError');
    assert.equal(invalid.readyState, 1);
    const before = await resources();
    assert.deepEqual(summary(before), { ...empty, connections: 1 });
    const closed = await page.evaluate(async () => {
      const event = new Promise(resolve => { closeProbe.onclose = value => resolve({ code: value.code, reason: value.reason, wasClean: value.wasClean }); });
      closeProbe.close(3001, 'native interruption');
      return event;
    });
    assert.deepEqual(closed, { code: 3001, reason: 'native interruption', wasClean: true });
    const end = performance.now() + 5000;
    let after;
    for (;;) {
      after = await resources();
      if (after.connections === 0) break;
      if (performance.now() >= end) throw new Error('native socket cleanup deadline');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(summary(after), empty);
    console.log(JSON.stringify({ browser: browser.version(), invalid1001: invalid,
      afterInvalid: summary(before), valid3001: closed, afterValid: summary(after) }));
  } finally { clearTimeout(timer); await context.close(); }
} finally { await browser.close(); }
