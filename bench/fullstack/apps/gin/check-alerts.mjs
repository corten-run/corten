// Functional native-image checks, never a throughput runner. Each browser context's
// APIRequestContext uses that browser's real cookie jar for independent readback.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { records as marketplaceRecords } from '../../../marketplace/fixtures.mjs';
import { records as catalogRecords } from '../../../catalog/fixtures.mjs';

const { chromium } = createRequire(import.meta.url)('@playwright/test');

const [app, image] = process.argv.slice(2);
assert.ok(['gin', 'drogon', 'topcoat', 'leptos'].includes(app) && image, 'usage: node check-alerts.mjs APP IMAGE');
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const folder = await mkdtemp(join(tmpdir(), 'compiled-alerts-'));
const records = marketplaceRecords();
let fetched = 0;
const upstream = createServer((req, res) => {
  const id = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.split('/').at(-1));
  fetched++;
  if (id === 'failed') { res.writeHead(503); res.end('source unavailable'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (!records[id]) { res.writeHead(404); res.end('{}'); return; }
  res.end(JSON.stringify(records[id]));
});
await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
let browser;
let active;
try {
  await writeFile(join(folder, 'items.json'), '{}');
  await writeFile(join(folder, 'catalog.json'), JSON.stringify(catalogRecords()));
  await writeFile(join(folder, 'marketplace.json'), JSON.stringify(records));
  browser = await chromium.launch({ headless: true });
  for (const source of ['fixture', 'api']) {
    active = `compiled-alerts-${app}-${source}-${process.pid}`;
    docker('run', '-d', '--name', active, '--cpus', '1', '--memory', '512m',
      '--label', 'agent.owner=codex', '--label', 'agent.task=compiled-alerts',
      '-p', '127.0.0.1::8080', '-v', `${folder}:/fixtures:ro`,
      '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json', '-e', 'CATALOG_SOURCE=fixture',
      '-e', `MARKETPLACE_SOURCE=${source}`, '-e', 'MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json',
      '-e', `API_BASE=http://host.docker.internal:${upstream.address().port}`, image);
    const binding = JSON.parse(docker('inspect', active))[0].NetworkSettings.Ports['8080/tcp'][0];
    const base = `http://127.0.0.1:${binding.HostPort}`;
    const pageURL = `${base}/marketplace/en-US/item_1`;
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${base}/api/alerts`)).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(docker('logs', active));
    });
    for (const javaScriptEnabled of [false, true]) {
      const context = await browser.newContext({ javaScriptEnabled });
      const other = await browser.newContext({ javaScriptEnabled: false });
      try {
        const read = async (client = context) => {
          const before = fetched;
          const response = await client.request.get(`${base}/api/alerts`);
          assert.equal(response.status(), 200);
          assert.match(response.headers()['content-type'], /application\/json/);
          assert.equal(response.headers()['cache-control'], 'no-store');
          assert.equal(response.headers()['set-cookie'], undefined, 'GET must not issue or reset sessions');
          const rows = await response.json();
          assert.ok(Array.isArray(rows));
          assert.equal(fetched, before, 'readback must not fetch a marketplace record');
          return rows;
        };
        assert.deepEqual(await read(), []);
        const rejected = await context.request.post(pageURL, { form: { email: 'bad', target_price: '1' } });
        assert.equal(rejected.status(), 200);
        assert.equal(rejected.headers()['set-cookie'], undefined, 'rejection must not create a session');
        assert.deepEqual(await read(), []);
        const page = await context.newPage();
        await page.goto(pageURL);
        if (javaScriptEnabled) await page.waitForFunction(() => typeof window.__hydratedAt === 'number');
        const form = page.locator('.marketplace__alert form');
        const email = `native-${javaScriptEnabled}@example.test`;
        await form.locator('[name=email]').fill(email);
        await form.locator('[name=target_price]').fill('12.34');
        const posted = page.waitForRequest(req => req.method() === 'POST');
        await form.locator('button').click();
        const sent = await posted;
        assert.equal(new URL(sent.url()).pathname, app === 'leptos' && javaScriptEnabled ? '/api/marketplace-alert' : '/marketplace/en-US/item_1');
        await page.locator('.marketplace__message').filter({ hasText: email }).waitFor();
        const expected = [{ item_id: 'item_1', email, target_minor: 1234 }];
        assert.deepEqual(await read(), expected, 'accepted native form commits exactly once');
        assert.deepEqual(await read(), expected, 'GET does not clear storage');
        const cookies = await context.cookies(base);
        const cookie = cookies.find(cookie => cookie.name === 'marketplace_session');
        assert.ok(cookie && cookie.value.length >= 44);
        assert.equal(cookie.domain, '127.0.0.1'); assert.equal(cookie.path, '/');
        assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Lax');
        assert.equal(cookie.secure, false); assert.equal(cookie.expires, -1);
        assert.deepEqual(await read(other), [], 'fresh browser context has no alerts');
        await page.goto(pageURL);
        if (javaScriptEnabled) await page.waitForFunction(() => typeof window.__hydratedAt === 'number');
        await page.locator('.marketplace__alert [name=email]').fill(email);
        await page.locator('.marketplace__alert [name=target_price]').fill('invalid');
        await page.locator('.marketplace__alert button').click();
        await page.locator('.marketplace__message').filter({ hasText: 'Enter a target price above zero.' }).waitFor();
        assert.deepEqual(await read(), expected, 'native rejected form does not commit');
        for (const [path, form, headers, status] of [
          ['/marketplace/fr-FR/item_1', { email, target_price: '12.34' }, {}, 200],
          ['/marketplace/de-DE/item_1', { email, target_price: '0' }, {}, 200],
          ['/marketplace/en-US/item_1?email=query%40example.test&target_price=9', {}, {}, 200],
          ['/marketplace/en-US/missing', { email, target_price: '1' }, {}, 404],
          ['/marketplace/es-ES/item_1', { email, target_price: '1' }, {}, 400],
          ['/marketplace/en-US/item_1', { email, target_price: '1' }, { Origin: 'https://attacker.invalid' }, 403],
          ['/marketplace/en-US/item_1', { email, target_price: '1' }, { 'Sec-Fetch-Site': 'cross-site' }, 403],
        ]) {
          const before = fetched;
          const response = await context.request.post(base + path, { form, headers });
          assert.equal(response.status(), status, path);
          if (status === 403) assert.equal(fetched, before, 'guard runs before source work');
          assert.deepEqual(await read(), expected, 'rejected/missing request mutated storage');
        }
        if (source === 'api') {
          const response = await context.request.post(`${base}/marketplace/en-US/failed`, { form: { email, target_price: '1' } });
          assert.equal(response.status(), app === 'topcoat' ? 500 : 502, 'preserve each native source-error status');
          assert.deepEqual(await read(), expected, 'source failure mutated storage');
        }
        if (app === 'leptos') {
          const before = fetched;
          const response = await context.request.post(`${base}/api/marketplace-alert`, {
            form: { tag: 'en-US', item_id: 'item_1', email, target_price: '1' }, headers: { Origin: 'https://attacker.invalid' },
          });
          assert.equal(response.status(), 403);
          assert.equal(fetched, before, 'enhanced cross-site guard precedes source work');
          assert.deepEqual(await read(), expected);
        }
        for (const tag of ['fr-FR', 'de-DE']) {
          const address = `${tag}@example.test`;
          assert.equal((await context.request.post(`${base}/marketplace/${tag}/item_1`, { form: { email: address, target_price: '43,21' } })).status(), 200);
          expected.push({ item_id: 'item_1', email: address, target_minor: 4321 });
          assert.deepEqual(await read(), expected, 'insertion order and localized cents');
        }
        assert.equal((await other.request.post(pageURL, { form: { email: 'other@example.test', target_price: '3.21' } })).status(), 200);
        assert.deepEqual(await read(other), [{ item_id: 'item_1', email: 'other@example.test', target_minor: 321 }]);
        await Promise.all(Array.from({ length: 8 }, async (_, i) => {
          const response = await context.request.post(pageURL, { form: { email: `concurrent${i}@example.test`, target_price: '1.23' } });
          assert.equal(response.status(), 200);
        }));
        const rows = await read();
        assert.equal(rows.length, 11); assert.deepEqual(rows.slice(0, 3), expected);
        assert.equal(new Set(rows.map(row => row.email)).size, 11, 'concurrent writes are neither lost nor duplicated');
        console.log(`PASS ${app} ${source} JS=${javaScriptEnabled}: native form, readback, locale validation, isolation, guards, concurrent writes`);
      } finally { await context.close(); await other.close(); }
    }
    docker('rm', '-f', '-v', active); active = undefined;
  }
} finally {
  if (browser) await browser.close();
  if (active) docker('rm', '-f', '-v', active);
  await new Promise(resolve => upstream.close(resolve));
  assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
  await rm(folder, { recursive: true, force: true });
}
