// Verify one uncached upstream read for every catalog page and JSON request.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
assert.ok(image, 'usage: node tests/catalog-api-smoke.mjs cb-catalog-axum-maud');
const cwd = fileURLToPath(new URL('../../../../../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('catalog.json', import.meta.url), 'utf8'));
let reads = 0;
let title = 'Revision A';
const upstream = createServer((request, response) => {
  reads++;
  response.setHeader('Content-Type', 'application/json');
  switch (request.url) {
    case '/catalog/records/record_1':
      response.end(JSON.stringify({ ...fixture.record_1, title }));
      break;
    case '/catalog/records/unknown':
      response.writeHead(404).end('{}');
      break;
    case '/catalog/records/error':
      response.writeHead(503).end('{}');
      break;
    case '/catalog/records/bad-json':
      response.end('{');
      break;
    case '/catalog/records/bad-record':
      response.end(JSON.stringify({ ...fixture.record_1, tags: 12 }));
      break;
    case '/api/discovery/items/item_1':
      response.end(JSON.stringify({ catalog_item_id: 'item_1', title: 'Old market item', description: 'Marketplace route remains separate.' }));
      break;
    case '/api/discovery/items/unknown':
      response.writeHead(404).end('{}');
      break;
    default:
      response.writeHead(500).end(JSON.stringify({ unexpected: request.url }));
  }
});
upstream.listen(18939, '0.0.0.0');
await once(upstream, 'listening');
const name = `catalog-api-check-${process.pid}`;
const docker = args => execFileSync('docker', args, { cwd, encoding: 'utf8' }).trim();
let started = false;
try {
  docker(['run', '-d', '--name', name, '-p', '18934:8080', '-e', 'CATALOG_SOURCE=api',
    '-e', 'API_BASE=http://host.docker.internal:18939', image]);
  started = true;
  const base = 'http://localhost:18934';
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(base + '/');
      break;
    } catch (error) {
      if (attempt === 60) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async function request(path, status) {
    const before = reads;
    const response = await fetch(base + path);
    assert.equal(response.status, status, path);
    assert.equal(reads - before, 1, `one upstream read: ${path}`);
    return response;
  }
  for (const next of ['Revision A', 'Revision B']) {
    title = next;
    const response = await request('/catalog/record_1', 200);
    assert.ok((await response.text()).includes(next));
  }
  for (const next of ['Revision C', 'Revision D']) {
    title = next;
    const response = await request('/api/catalog/record_1', 200);
    assert.equal((await response.json()).title, next);
  }
  for (const route of ['/catalog/', '/api/catalog/']) {
    await request(route + 'unknown', 404);
    for (const id of ['error', 'bad-json', 'bad-record']) {
      const before = reads;
      const response = await fetch(base + route + id);
      assert.ok(response.status >= 500 && response.status < 600, `${route}${id}: ${response.status}`);
      assert.equal(reads - before, 1, `one failed upstream read: ${route}${id}`);
    }
  }
  assert.ok((await (await fetch(base + '/items/item_1')).text()).includes('Old market item'));
  assert.equal((await (await fetch(base + '/api/items/item_1')).json()).id, 'item_1');
  for (const route of ['/items/', '/api/items/']) {
    assert.equal((await fetch(base + route + 'unknown')).status, 404, 'original item 404');
  }
  console.log(`PASS ${image}: one uncached fetch/parse per page and JSON request; changing records, upstream 404, 503, malformed JSON and wrong schema`);
} finally {
  if (started) docker(['rm', '-f', name]);
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
