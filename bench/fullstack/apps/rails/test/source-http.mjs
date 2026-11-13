// Real native Rails HTTP routing against fixture startup and an uncached HTTP source.
// Build this application's ordinary Dockerfile first, then pass the resulting image.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const image = process.argv[2];
assert.ok(image, 'built native Rails image required');
const docker = async (...args) => (await promisify(execFile)('docker', args, { timeout: 30000 })).stdout.trim();
const records = JSON.parse(await readFile(new URL('./marketplace_fixture.json', import.meta.url)));
const calls = [];
const upstream = createServer((request, response) => {
  calls.push(request.url);
  const id = decodeURIComponent(request.url.replace(/^\/marketplace\/records\//, ''));
  const record = records[id];
  response.writeHead(id === 'failed' ? 503 : record ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(record || { error: 'missing' }));
});
await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
const upstreamPort = upstream.address().port;
try {
  for (const source of ['fixture', 'api']) {
    const name = `parity-native-rails-source-${randomBytes(8).toString('hex')}`;
    calls.length = 0;
    const expected = [];
    try {
      await docker('run', '-d', '--name', name, '--cpus', '1', '--memory', '1g',
        '--label', 'agent.owner=codex', '--label', 'agent.task=parity-native-livewire',
        '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::8080',
        '-e', 'SECRET_KEY_BASE_DUMMY=1', '-e', `MARKETPLACE_SOURCE=${source}`,
        '-e', 'MARKETPLACE_FIXTURE_PATH=/rails/test/marketplace_fixture.json',
        '-e', `API_BASE=http://host.docker.internal:${upstreamPort}`, image);
      const address = await docker('port', name, '8080/tcp');
      const base = `http://${address}`;
      const end = Date.now() + 30000;
      for (;;) {
        try { if ((await fetch(base + '/api/alerts', { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
        assert.ok(Date.now() < end, 'native Rails startup deadline');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const get = async (path, id, status) => {
        if (id !== undefined && source === 'api') expected.push(`/marketplace/records/${encodeURIComponent(id)}`);
        const response = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, status, `${source} ${path}`);
        return response;
      };
      for (const [id, record] of Object.entries(records)) {
        for (const locale of ['en-US', 'fr-FR', 'de-DE']) {
          const response = await get(`/marketplace/${locale}/${id}`, id, 200);
          assert.match(response.headers.get('content-type'), /text\/html/);
          assert.match(await response.text(), /<article class="marketplace"/);
        }
        const response = await get(`/api/marketplace/${id}`, id, 200);
        assert.deepEqual(await response.json(), record);
      }
      for (const path of ['/marketplace/en-US/missing', '/api/marketplace/missing']) {
        assert.equal(await (await get(path, 'missing', 404)).text(), '', 'native missing source returns an empty 404');
      }
      await get('/marketplace/es-ES/item_1', undefined, 400);
      if (source === 'api') {
        for (const path of ['/marketplace/en-US/failed', '/api/marketplace/failed']) {
          await get(path, 'failed', 500);
        }
      }
      assert.deepEqual(await (await get('/api/alerts', undefined, 200)).json(), []);
      assert.deepEqual(calls, expected, 'exactly one uncached upstream request per legitimate native route, none in fixture mode');
      console.log(`Rails native real HTTP ${source}: both records, all locales, JSON, missing 404, error semantics and empty alert state passed`);
    } finally { await docker('rm', '-f', '-v', name); }
  }
} finally {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
