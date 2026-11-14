// Hold only real LiveView join replies. Heartbeats, native transports and form events stay native.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

const [base] = process.argv.slice(2);
assert.ok(base, 'usage: native-preconnect.mjs BASE');
const labels = JSON.parse(readFileSync(new URL('../priv/marketplace-labels.json', import.meta.url)));
const browser = await chromium.launch({ headless: true });
try {
  for (const locale of ['en-US', 'fr-FR']) for (const mode of ['ordinary', 'connected', 'delayed']) {
    const context = await browser.newContext({ javaScriptEnabled: mode !== 'ordinary' });
    try {
      const page = await context.newPage();
      const held = [];
      let release = mode !== 'delayed', save = false, heldJoin;
      const waitingForJoin = new Promise(resolve => { heldJoin = resolve; });
      if (mode === 'delayed') await page.routeWebSocket('**/live/websocket**', client => {
        const server = client.connectToServer();
        client.onMessage(message => {
          const frame = JSON.parse(String(message));
          if (frame[3] === 'event' && frame[4]?.event === 'save') save = true;
          server.send(message);
        });
        server.onMessage(message => {
          const frame = JSON.parse(String(message));
          if (!release && frame[2]?.startsWith('lv:') && frame[3] === 'phx_reply') {
            held.push(() => client.send(message)); heldJoin();
          } else client.send(message);
        });
      });
      assert.equal((await page.goto(`${base}/marketplace/${locale}/item_1`)).status(), 200);
      const form = page.locator('.marketplace__alert form');
      const root = page.locator('[data-phx-session]').filter({ has: page.locator('.marketplace__alert') });
      if (mode === 'delayed') {
        let timer;
        try { await Promise.race([waitingForJoin, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('native join was not held')), 15000); })]); }
        finally { clearTimeout(timer); }
        await expect(root).not.toHaveClass(/phx-connected/);
      }
      if (mode === 'connected') await expect(root).toHaveClass(/phx-connected/);
      const email = `preconnect-${locale}@example.test`, target = locale === 'en-US' ? '12.50' : '12,50';
      await form.locator('[name=email]').fill(email);
      await form.locator('[name=target_price]').fill(target);
      await page.locator('.marketplace__alert h2').click();
      await expect(form.locator('[name=email]')).not.toBeFocused();
      await expect(form.locator('[name=target_price]')).not.toBeFocused();
      if (mode === 'delayed') { release = true; held.splice(0).forEach(send => send()); await expect(root).toHaveClass(/phx-connected/); }
      await expect(form.locator('[name=email]')).toHaveValue(email);
      await expect(form.locator('[name=target_price]')).toHaveValue(target);
      assert.deepEqual(await (await context.request.get(`${base}/api/alerts`, { headers: { Connection: 'close' } })).json(), [], 'Recovery/change must not append');
      const origin = await page.evaluate(() => performance.timeOrigin);
      await form.locator('[type=submit]').click();
      await expect(page.locator('.marketplace__message')).toContainText(email);
      assert.deepEqual(await (await context.request.get(`${base}/api/alerts`, { headers: { Connection: 'close' } })).json(), [{ item_id: 'item_1', email, target_minor: 1250 }]);
      if (mode !== 'ordinary') assert.equal(await page.evaluate(() => performance.timeOrigin), origin, 'Native enhancement must not reload');
      if (mode === 'delayed') assert.ok(save, 'Held join must resume a real native WebSocket save');
      if (mode === 'delayed') {
        // Subsequent joins use LiveView's normal phx-change/id form recovery.
        await page.evaluate(() => window.liveSocket.disconnect());
        await expect(root).not.toHaveClass(/phx-connected/);
        const recoveredEmail = `recovered-${locale}@example.test`;
        await form.locator('[name=email]').fill(recoveredEmail);
        await form.locator('[name=target_price]').fill('0');
        await page.locator('.marketplace__alert h2').click();
        await expect(form.locator('[name=email]')).not.toBeFocused();
        await expect(form.locator('[name=target_price]')).not.toBeFocused();
        await page.evaluate(() => window.liveSocket.connect());
        await expect(root).toHaveClass(/phx-connected/);
        await expect(form.locator('[name=email]')).toHaveValue(recoveredEmail);
        await expect(form.locator('[name=target_price]')).toHaveValue('0');
        await form.locator('[type=submit]').click();
        await expect(page.locator('.marketplace__message')).toHaveText(labels[locale].invalid_price);
        await expect(form.locator('[name=email]')).toHaveValue(recoveredEmail);
        await expect(form.locator('[name=target_price]')).toHaveValue('0');
        assert.deepEqual(await (await context.request.get(`${base}/api/alerts`, { headers: { Connection: 'close' } })).json(), [{ item_id: 'item_1', email, target_minor: 1250 }], 'Recovered invalid form must not append');
        await form.locator('[name=target_price]').fill(locale === 'en-US' ? '10.50' : '10,50');
        await form.locator('[type=submit]').click();
        await expect(page.locator('.marketplace__message')).toContainText(recoveredEmail);
        assert.deepEqual(await (await context.request.get(`${base}/api/alerts`, { headers: { Connection: 'close' } })).json(), [{ item_id: 'item_1', email, target_minor: 1250 }, { item_id: 'item_1', email: recoveredEmail, target_minor: 1050 }]);
        assert.equal(await page.evaluate(() => performance.timeOrigin), origin, 'Recovery must stay on the native document');
      }
      console.log(`${locale} ${mode}: blurred edits retained, no pre-submit mutation, native submit and independent readback passed`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
