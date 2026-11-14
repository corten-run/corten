// Bounded functional checks, not a load benchmark. Run against a fresh native app process.
// node bench/fullstack/apps/rails/test/native-alerts.mjs rails|laravel|phoenix http://localhost:8080
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const [stack, base] = process.argv.slice(2);
assert.ok(['rails', 'laravel', 'phoenix'].includes(stack) && base, 'stack and base URL required');
// Bandit closes native exception responses; do not reuse those sockets in the
// independent HTTP probe client. Browser forms/LiveView keep their normal transport.
const probeHeaders = stack === 'phoenix' ? { Connection: 'close' } : {};
const labels = JSON.parse(await readFile(new URL('../config/marketplace_labels.json', import.meta.url)));
const browser = await chromium.launch({ headless: true });
try {
  for (const javaScriptEnabled of [false, true]) {
    for (const locale of ['en-US', 'fr-FR', 'de-DE']) {
      const context = await browser.newContext({ javaScriptEnabled });
      const other = await browser.newContext({ javaScriptEnabled });
      try {
        const read = async (client = context, query = '') => {
          const response = await client.request.get(`${base}/api/alerts${query}`, { headers: probeHeaders });
          assert.equal(response.status(), 200);
          assert.match(response.headers()['content-type'], /application\/json/);
          assert.match(response.headers()['cache-control'], /no-store/);
          return response.json();
        };
        assert.deepEqual(await read(), []);
        const page = await context.newPage();
        const posts = [];
        const frames = [];
        page.on('request', request => { if (request.method() === 'POST') posts.push(request); });
        page.on('websocket', socket => socket.on('framesent', event => frames.push(String(event.payload))));
        const path = `/marketplace/${locale}/item_1`;
        assert.equal((await page.goto(base + path)).status(), 200);
        const form = page.locator('.marketplace__alert form');
        const tokenName = { rails: 'authenticity_token', laravel: '_token', phoenix: '_csrf_token' }[stack];
        const token = await form.locator(`input[name="${tokenName}"]`).inputValue();
        if (javaScriptEnabled) {
          if (stack === 'rails') await page.waitForFunction(() => window.Turbo && customElements.get('turbo-frame'));
          if (stack === 'laravel') await page.waitForFunction(() => window.Livewire?.all().some(component => component.name === 'marketplace-alert'));
          if (stack === 'phoenix') await expect(page.locator('[data-phx-session]').filter({ has: page.locator('.marketplace__alert') })).toHaveClass(/phx-connected/);
        }
        const timeOrigin = javaScriptEnabled ? await page.evaluate(() => performance.timeOrigin) : null;
        const target = locale === 'en-US' ? '12.50' : '12,50';
        const email = `browser-${locale}@example.test`;
        await form.locator('[name=email]').fill(email);
        await form.locator('[name=target_price]').fill(target);
        await form.locator('button[type=submit]').click();
        await expect(page.locator('.marketplace__message')).toContainText(email);
        const expected = [{ item_id: 'item_1', email, target_minor: 1250 }];
        assert.deepEqual(await read(), expected);
        assert.deepEqual(await read(other), []);
        if (javaScriptEnabled) {
          assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, 'Native enhancement must not reload the document');
          if (stack === 'rails') assert.ok(posts.some(request => request.headers()['turbo-frame'] === 'marketplace-alert'), 'Real Turbo frame POST');
          if (stack === 'laravel') assert.ok(posts.some(request => request.postDataJSON()?.components?.some(component => component.calls.some(call => call.method === 'save'))), 'Real Livewire component action');
          if (stack === 'phoenix') assert.ok(frames.some(frame => frame.includes('"event":"save"')), 'Real LiveView event');
        }
        await form.locator('[name=target_price]').fill('0');
        await form.locator('button[type=submit]').click();
        await expect(page.locator('.marketplace__message')).toHaveText(labels[locale].invalid_price);
        assert.deepEqual(await read(), expected, 'Rejected native UI action does not append');
        const post = (params, options = {}) => context.request.post(base + path, { form: { [tokenName]: token, ...params }, ...options, headers: { ...probeHeaders, ...options.headers } });
        for (const params of [{ email: 'bad', target_price: target }, { email, target_price: '0' }, { email, target_price: 'NaN' }, {}, { email }]) {
          assert.equal((await post(params)).status(), 200);
          assert.deepEqual(await read(), expected, 'Rejected/missing fields do not mutate');
        }
        // Native exception handlers may close the socket after sending a CSRF error.
        // Do not pool that socket for the next POST; retain the same browser cookie jar.
        assert.ok((await context.request.post(base + path, { headers: { Connection: 'close' }, form: { email, target_price: target } })).status() >= 400, 'Missing CSRF rejected');
        for (const headers of [{ Origin: 'https://other.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
          assert.ok((await post({ email, target_price: target }, { headers })).status() >= 400, 'Cross-site write rejected');
        }
        // Rails' per-form CSRF token is path-bound and refuses the other action first.
        assert.equal((await context.request.post(`${base}/marketplace/${locale}/missing`, { headers: probeHeaders, form: { [tokenName]: token, email, target_price: target } })).status(), stack === 'rails' ? 422 : 404);
        assert.deepEqual(await read(context, '?email=oracle&target_minor=999'), expected);
        assert.deepEqual(await read(), expected, 'GET never resets the store');
        const second = { item_id: 'item_1', email: 'second@example.test', target_minor: 1050 };
        assert.equal((await post({ email: second.email, target_price: locale === 'en-US' ? '10.50' : '10,50' })).status(), 200);
        expected.push(second);
        assert.deepEqual(await read(), expected, 'Sequential insertion order');
        const concurrent = Array.from({ length: 8 }, (_, index) => `concurrent-${index}@example.test`);
        await Promise.all(concurrent.map(async email => assert.equal((await post({ email, target_price: target })).status(), 200)));
        const stored = await read();
        assert.deepEqual(stored.slice(0, 2), expected);
        assert.deepEqual(stored.slice(2).map(row => row.email).sort(), concurrent.sort(), 'Concurrent same-session POSTs each store one row');
        assert.ok(stored.slice(2).every(row => row.item_id === 'item_1' && row.target_minor === 1250));
        assert.deepEqual(await read(other), []);
        const independent = await other.newPage();
        await independent.goto(base + path);
        const otherForm = independent.locator('.marketplace__alert form');
        const otherToken = await otherForm.locator(`input[name="${tokenName}"]`).inputValue();
        assert.equal((await other.request.post(base + path, { headers: probeHeaders, form: { [tokenName]: otherToken, email: 'isolated@example.test', target_price: target } })).status(), 200);
        assert.deepEqual(await read(other), [{ item_id: 'item_1', email: 'isolated@example.test', target_minor: 1250 }]);
        assert.deepEqual(await read(), stored);
        // Exercise the existing native GET controls and typed/native links too.
        await page.goto(base + path);
        const filter = page.locator('.marketplace__listings form');
        await filter.locator('[name=seller]').fill('Alice');
        await filter.locator('[name=sort]').selectOption('desc');
        await filter.locator('button[type=submit]').click();
        await expect(page).toHaveURL(/seller=Alice/);
        const prices = await page.locator('[data-listing-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-listing-id')));
        assert.deepEqual(prices, ['listing_5', 'listing_4', 'listing_3', 'listing_2', 'listing_1', 'listing_0', 'listing_6', 'listing_7'], 'Native descending filter preserves numeric order and null last');
        await page.locator('.marketplace__more').click();
        await expect(page).toHaveURL(/offers=all/);
        assert.ok(await page.locator('[data-offer-id]').count() > 5, 'Native show-all link');
        await page.locator('.marketplace__contents a').first().click();
        await expect(page).toHaveURL(new RegExp(`/marketplace/${locale}/item_2`));
        assert.deepEqual(await read(), stored, 'Navigation leaves persistent state intact');
        console.log(`${stack} ${locale} JS=${javaScriptEnabled}: native submit/readback/rejection/order/concurrency/isolation/filter/sort/show-all/navigation passed`);
      } finally {
        await context.close();
        await other.close();
      }
    }
  }
} finally {
  await browser.close();
}
