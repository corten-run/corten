// Run against the production image with the canonical marketplace fixture.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { alertReady, observeAlertTransport, submitAlert } from '../../../../marketplace/check.mjs';

const [base] = process.argv.slice(2);
assert.ok(base, 'usage: native-origins.mjs BASE');

function rejectedUpgrade(url, origin, cookie) {
  return new Promise((resolve, reject) => {
    const req = request(url.replace(/^ws:/, 'http:'), { headers: {
      Origin: origin, Cookie: cookie, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'MDEyMzQ1Njc4OWFiY2RlZg=='
    } });
    req.on('response', response => { response.resume(); resolve(response.statusCode); });
    req.on('upgrade', (_response, socket) => { socket.destroy(); reject(Error('Foreign origin upgraded')); });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(Error('Origin rejection timed out')));
    req.end();
  });
}

const browser = await chromium.launch({ headless: true });
try {
  for (const host of ['127.0.0.1', 'localhost']) for (const transport of ['websocket', 'longpoll']) {
    const target = new URL(base); target.hostname = host;
    const context = await browser.newContext();
    context.setDefaultTimeout(15000);
    try {
      const page = await context.newPage();
      observeAlertTransport(page);
      const frames = [], polls = [];
      page.on('websocket', socket => socket.on('framesent', event => frames.push(JSON.parse(String(event.payload)))));
      page.on('request', req => { if (new URL(req.url()).pathname === '/live/longpoll') polls.push(req.url()); });
      if (transport === 'longpoll') await page.routeWebSocket('**/live/websocket**', socket => socket.close());
      assert.equal((await page.goto(`${target.origin}/marketplace/en-US/item_1`)).status(), 200);
      const form = page.locator('.marketplace__alert form');
      await alertReady(page, form, true);
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const email = `origin-${host}-${transport}@example.test`;
      await form.locator('[name=email]').fill(email);
      await form.locator('[name=target_price]').fill('12.50');
      await submitAlert(page, form, true);
      await expect(page.locator('.marketplace__message')).toContainText(email);
      assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
      assert.deepEqual(await (await context.request.get(`${target.origin}/api/alerts`, { headers: { Connection: 'close' } })).json(),
        [{ item_id: 'item_1', email, target_minor: 1250 }]);
      if (transport === 'websocket') {
        assert.ok(frames.some(frame => frame[3] === 'event' && frame[4]?.event === 'save'), 'Real WebSocket save');
        assert.equal(polls.length, 0, 'WebSocket case must not silently fall back');
      } else assert.ok(polls.length, 'Native long-poll fallback used');

      const csrf = await page.locator('meta[name=csrf-token]').getAttribute('content');
      const params = new URLSearchParams({ vsn: '2.0.0', _csrf_token: csrf });
      const cookie = (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
      const foreignHost = new URL(target); foreignHost.hostname = host === 'localhost' ? '127.0.0.1' : 'localhost';
      const foreignPort = new URL(target); foreignPort.port = String(Number(target.port || 80) + 1);
      const foreignScheme = new URL(target); foreignScheme.protocol = 'https:';
      for (const origin of [foreignHost.origin, foreignPort.origin, foreignScheme.origin]) {
        assert.equal(await rejectedUpgrade(`${target.origin.replace(/^http:/, 'ws:')}/live/websocket?${params}`, origin, cookie), 403);
        const response = await context.request.get(`${target.origin}/live/longpoll?${params}`, { headers: { Origin: origin, Connection: 'close' } });
        assert.equal((await response.json()).status, 403, 'Long-poll must reject a foreign origin with valid session/CSRF');
      }
      console.log(JSON.stringify({ host, transport, joined: true, correlatedSave: true, foreignOriginsRejected: 3 }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
