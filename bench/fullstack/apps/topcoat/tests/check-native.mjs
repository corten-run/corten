// Functional checks of the actual CLI-built image, not a throughput receipt.
// Usage: node tests/check-native.mjs IMAGE [defaults|matched]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerBase, startupFailure, writeFixtures } from '../../gin/compiled-check.mjs';

const { chromium, expect } = createRequire(import.meta.url)('@playwright/test');
const [image, profile = 'defaults'] = process.argv.slice(2);
assert.ok(image && ['defaults', 'matched'].includes(profile), 'usage: node tests/check-native.mjs IMAGE [defaults|matched]');
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const folder = await mkdtemp(join(tmpdir(), 'topcoat-native-'));
const name = `topcoat-native-${process.pid}`;
const title = 'Ember <dragon> & friends';
const item = {
  catalog_item_id: 'item_1', title, description: 'Native <markup> & data',
  market_listings: [3, 1, 2].map(price => ({
    listing_id: `listing_${price}`, seller_display_name: `Seller ${price}`,
    product_summary: 'New', ship_from_code: 'US', visible_quantity: 1,
    price_amount: `${price}.00`, price_currency_code: 'USD',
  })),
  offer_demand_matches: Array.from({ length: 6 }, (_, i) => ({
    offer_id: `offer_${i}`, buyer_display_name: `Buyer ${i}`, product_summary: 'New',
    quantity_requested: 1, price_amount: '1.00', price_currency_code: 'USD',
  })),
  contents: [{ contained_catalog_item_id: 'item_2', contained_item: { title: 'Related card' }, quantity: 1 }],
};
let active = false;
let browser;
try {
  await writeFixtures(folder, {
    'items.json': { item_1: item, item_2: { catalog_item_id: 'item_2', title: 'Related card' } },
    'catalog.json': JSON.parse(await readFile(new URL('../../axum-maud/tests/catalog.json', import.meta.url), 'utf8')),
    'marketplace.json': {},
  });
  docker('run', '-d', '--name', name,
    '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-refresh-rust',
    '-p', '127.0.0.1::8080', '-v', `${folder}:/fixtures:ro`,
    '-e', `PROFILE=${profile}`, '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
    '-e', 'CATALOG_SOURCE=fixture', '-e', 'CATALOG_FIXTURE_PATH=/fixtures/catalog.json',
    '-e', 'MARKETPLACE_SOURCE=fixture', '-e', 'MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json', image);
  active = true;
  const base = containerBase(docker, name);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, ready ? undefined : startupFailure(docker, name).message);
  const catalog = spawnSync(process.execPath, [fileURLToPath(new URL('../../axum-maud/tests/catalog-smoke.mjs', import.meta.url)), base], { encoding: 'utf8' });
  assert.ifError(catalog.error);
  assert.equal(catalog.status, 0, catalog.stdout + catalog.stderr);
  console.log(catalog.stdout.trim());
  const response = await fetch(`${base}/items/item_1`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('Ember &lt;dragon&gt; &amp; friends'));
  if (profile === 'matched') assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const assets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(assets.length >= 4, 'native runtime, readiness module and both stylesheets');
  for (const href of assets) {
    const asset = await fetch(new URL(href, base));
    assert.equal(asset.status, 200, href);
    assert.ok((await asset.arrayBuffer()).byteLength > 0, href);
    assert.match(asset.headers.get('cache-control'), /immutable/, href);
  }
  for (const path of ['/items/missing', '/api/items/missing', '/unknown/path']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const json = await (await fetch(`${base}/api/items/item_1`)).json();
  assert.equal(json.title, title);
  assert.equal(json.offers.length, 6);
  const abort = new AbortController();
  try {
    const live = await fetch(`${base}/live/prices`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) });
    assert.match(live.headers.get('content-type'), /text\/event-stream/);
    assert.equal((await fetch(`${base}/live/publish`, { method: 'POST', body: 'native-refresh' })).status, 204);
    let events = '';
    const reader = live.body.getReader();
    while (!events.includes('data:native-refresh') && !events.includes('data: native-refresh')) {
      const { value, done } = await reader.read();
      assert.ok(!done, 'native SSE closed before publication');
      events += new TextDecoder().decode(value);
    }
  } finally { abort.abort(); }
  browser = await chromium.launch({ headless: true });
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`${base}/`);
      if (javaScriptEnabled) await page.waitForFunction(() => typeof window.__hydratedAt === 'number');
      const documents = [];
      let phase = 'home link';
      page.on('request', request => { if (request.resourceType() === 'document') documents.push(`${phase}: ${request.url()}`); });
      await page.getByRole('link', { name: title }).click();
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      if (javaScriptEnabled) await page.waitForFunction(() => typeof window.__hydratedAt === 'number');
      // Native links may load the document when the destination needs new scripts.
      // Once the item runtime is loaded, shards, procedures and warm links must not.
      const coldDocumentLoads = documents.length;
      if (javaScriptEnabled) assert.ok(coldDocumentLoads <= 1, JSON.stringify(documents));
      documents.length = 0;
      phase = 'shards and procedure';
      const listings = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Listings', exact: true }) });
      await expect(listings.locator('tbody tr td:first-child')).toHaveText(['Seller 1', 'Seller 2', 'Seller 3']);
      if (javaScriptEnabled) {
        await page.getByRole('button', { name: 'Price: low to high', exact: true }).click();
        await expect(listings.locator('tbody tr td:first-child')).toHaveText(['Seller 3', 'Seller 2', 'Seller 1']);
      }
      const offers = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Offers', exact: true }) });
      await expect(offers.locator('tbody tr')).toHaveCount(5);
      await page.getByRole('button', { name: 'Show all 6 offers', exact: true }).click();
      await expect(offers.locator('tbody tr')).toHaveCount(6);
      assert.equal(new URL(page.url()).search, javaScriptEnabled ? '' : '?offers=all');
      await page.getByLabel('Email', { exact: true }).fill('native@example.test');
      await page.getByLabel('Alert me below', { exact: true }).fill('12.34');
      await page.getByRole('button', { name: 'Set alert', exact: true }).click();
      await expect(page.locator('#alert-message')).toHaveText(`Alert set: we will email native@example.test when ${title} drops below $12.34.`);
      phase = 'related link';
      await page.getByRole('link', { name: 'Related card', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Related card', exact: true })).toBeVisible();
      assert.equal(new URL(page.url()).pathname, '/items/item_2');
      if (javaScriptEnabled) assert.deepEqual(documents, [], 'links, shards and procedure must update natively, not reload');
      assert.deepEqual(errors, [], 'native runtime errors');
      console.log(`PASS Topcoat ${profile} JS=${javaScriptEnabled}: routes, shards, procedure, escaping and native navigation; cold document loads=${coldDocumentLoads}`);
    } finally { await context.close(); }
  }
  console.log(`PASS Topcoat ${profile}: CLI bundle assets, catalog contract, JSON, SSE and 404 routes`);
} finally {
  if (browser) await browser.close();
  if (active) docker('rm', '-f', '-v', name);
  assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
  await rm(folder, { recursive: true, force: true });
}
