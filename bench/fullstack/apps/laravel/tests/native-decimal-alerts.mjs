// Real ordinary forms and Livewire actions; no synthetic component request or session bypass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

const [base] = process.argv.slice(2);
assert.ok(base, 'usage: native-decimal-alerts.mjs BASE');
const labels = JSON.parse(readFileSync(new URL('../resources/marketplace_labels.json', import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL('./marketplace_fixture.json', import.meta.url)));
const normalize = value => value.replace(/[\u00a0\u202f]/g, ' ');
const cases = [['1.005', 101n], ['1.004999999999999999', 100n], ['1.005000000000000001', 101n],
  ['0.105', 11n], ['2.675', 268n], ['90071992547409.935', 9007199254740994n], ['92233720368547758.065', 9223372036854775807n]];
const browser = await chromium.launch({ headless: true });
try {
  for (const javaScriptEnabled of [false, true]) for (const locale of ['en-US', 'fr-FR', 'de-DE']) {
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      const page = await context.newPage();
      let saves = 0;
      page.on('request', request => {
        if (request.method() === 'POST' && request.headers()['x-livewire']) {
          if (request.postDataJSON()?.components?.some(component => component.calls?.some(call => call.method === 'save'))) saves++;
        }
      });
      const read = async () => {
        const response = await context.request.get(`${base}/api/alerts`);
        assert.equal(response.status(), 200);
        assert.match(response.headers()['cache-control'], /no-store/);
        return JSON.parse(await response.text(), (key, value, source) => key === 'target_minor' ? BigInt(source.source) : value);
      };
      const expected = [];
      for (const [decimal, minor] of cases) {
        assert.equal((await page.goto(`${base}/marketplace/${locale}/item_1`)).status(), 200);
        if (javaScriptEnabled) await page.waitForFunction(() => window.Livewire?.all().some(component => component.name === 'marketplace-alert'));
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        const form = page.locator('.marketplace__alert form');
        const email = `decimal-${expected.length}@example.test`;
        await form.locator('[name=email]').fill(email);
        await form.locator('[name=target_price]').fill(locale === 'en-US' ? decimal : decimal.replace('.', ','));
        await form.locator('[type=submit]').click();
        const price = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).formatToParts(minor / 100n)
          .map(part => part.type === 'fraction' ? String(minor % 100n).padStart(2, '0') : part.value).join('');
        const message = labels[locale].alert_set.replace('{email}', email).replace('{title}', fixture.item_1.title).replace('{price}', price);
        await expect(page.locator('.marketplace__message')).toHaveText(message, { useInnerText: true });
        assert.equal(normalize(await page.locator('.marketplace__message').textContent()), normalize(message));
        expected.push({ item_id: 'item_1', email, target_minor: minor });
        assert.deepEqual(await read(), expected, `${locale} ${decimal}: real native readback`);
        if (javaScriptEnabled) {
          assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, 'Livewire must not reload the document');
          assert.equal(saves, expected.length, 'Exactly one real Livewire save per accepted form');
        }
      }
      const form = page.locator('.marketplace__alert form');
      await form.locator('[name=target_price]').fill(locale === 'en-US' ? '92233720368547758.075' : '92233720368547758,075');
      await form.locator('[type=submit]').click();
      await expect(page.locator('.marketplace__message')).toHaveText(labels[locale].invalid_price);
      assert.deepEqual(await read(), expected, 'Overflow must not append');
      console.log(`${locale} JS=${javaScriptEnabled}: seven decimal boundaries, exact confirmations/readbacks, overflow rejection passed`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
