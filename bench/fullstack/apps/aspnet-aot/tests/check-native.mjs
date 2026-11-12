// Focused native JSON checks only. This does not alter benchmark admission or the standard runner.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { records as catalogRecords } from '../../../../catalog/fixtures.mjs';
import { records as marketplaceRecords } from '../../../../marketplace/fixtures.mjs';
import { validateRecord } from '../../../../marketplace/records.mjs';
import { checkJsonApp } from '../../../../workloads/json-check.mjs';
import { invalidMarketplaceCases } from './marketplace-cases.mjs';

const image = process.argv[2];
assert.ok(image, 'usage: node tests/check-native.mjs IMAGE');
// Docker Desktop supplies this hostname; Docker Engine on Linux needs the explicit gateway.
const hostGateway = process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const logs = name => {
  const result = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, 'read owned container logs');
  return result.stdout + result.stderr;
};
const catalog = catalogRecords();
const marketplace = marketplaceRecords();
const temp = mkdtempSync(join(tmpdir(), 'corten-bench-parity-aot-'));
const containers = new Set();
const requests = [];
const raw = new URL('./results/review-native-raw.ndjson', import.meta.url);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(raw, '');
const observe = value => appendFileSync(raw, JSON.stringify(value) + '\n');
const controls = { catalog: { requests: {} }, marketplace: { requests: {} } };
let gateMode = false;
const stalled = new Set();
let enteredStall;
let responseOverride;
const upstream = createServer(async (req, res) => {
  const control = req.url.match(/^\/__(catalog|marketplace)\/control$/);
  if (control) {
    const state = controls[control[1]];
    if (req.method === 'POST') {
      let body = '';
      for await (const part of req) body += part;
      Object.assign(state, { requests: {}, value: JSON.parse(body) });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requests: state.requests }));
    return;
  }
  requests.push(req.url);
  if (responseOverride) {
    if (responseOverride.stall) {
      stalled.add(res);
      res.once('close', () => stalled.delete(res));
      if (responseOverride.stall === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"id":');
      }
      enteredStall?.();
      return;
    }
    res.writeHead(responseOverride.status ?? 200, { 'content-type': 'application/json', ...responseOverride.headers });
    res.end(responseOverride.body);
    return;
  }
  const match = req.url.match(/^\/(catalog|marketplace)\/records\/(.+)$/);
  const id = match && decodeURIComponent(match[2]);
  const state = match && controls[match[1]];
  if (state) state.requests[id] = (state.requests[id] ?? 0) + 1;
  const value = gateMode && state?.value;
  if (value?.status && value.status !== 200) {
    res.writeHead(value.status, { 'content-type': 'application/json', ...(value.status === 302 ? { location: '/redirect-target' } : {}) });
    res.end('{"error":"upstream"}');
    return;
  }
  const data = match && (value?.record?.id === id ? value.record : (match[1] === 'catalog' ? catalog : marketplace)[id]);
  res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
  // Unknown members and whitespace must not be passed through by the adapter.
  res.end(data ? JSON.stringify({ ...data, upstream_only: true }, null, 2) : '{}');
});
const eventually = async (predicate, message) => {
  const end = performance.now() + 5000;
  while (!predicate() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), message);
};
async function checkCancellation(base, kind, id) {
  for (const stage of ['headers', 'body']) {
    for (const outcome of ['disconnect', 'deadline']) {
      responseOverride = { stall: stage };
      const started = new Promise(resolve => { enteredStall = resolve; });
      const cancel = new AbortController();
      const before = requests.length;
      const begin = performance.now();
      // Capture rejection immediately: abort occurs only after the upstream has begun real work.
      const pending = fetch(`${base}/api/${kind}/${id}`, { signal: cancel.signal }).then(response => ({ response }), error => ({ error }));
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream never entered stall')), 5000).unref())]);
      assert.equal(stalled.size, 1, 'one upstream request really active');
      if (outcome === 'disconnect') cancel.abort();
      const result = await pending;
      if (outcome === 'disconnect') assert.equal(result.error?.name, 'AbortError');
      else {
        assert.equal(result.response.status, 503, `${kind}: real 10-second deadline`);
        const body = await result.response.text();
        observe({ kind: 'deadline', payload: kind, stage, status: result.response.status, headers: [...result.response.headers], body });
      }
      await eventually(() => stalled.size === 0, 'cancellation/deadline releases upstream socket/response');
      assert.equal(requests.length, before + 1, 'no cancellation retry');
      const elapsedMs = Math.round(performance.now() - begin);
      responseOverride = undefined;
      enteredStall = undefined;
      assert.equal((await fetch(`${base}/api/${kind}/${id}`)).status, 200, 'source recovers after canceled HTTP work');
      assert.equal((await fetch(`${base}/health/ready`)).status, 200, 'readiness preserved');
      observe({ kind: 'resource-check', payload: kind, stage, outcome, elapsedMs, activeUpstream: stalled.size, upstreamRequests: 1 });
      console.log(`PASS api ${kind}: in-flight ${stage} ${outcome}, measured ${elapsedMs} ms, upstream active=0, one read, recovery healthy`);
    }
  }
}
try {
  upstream.listen(0, '0.0.0.0');
  await once(upstream, 'listening');
  writeFileSync(join(temp, 'catalog.json'), JSON.stringify(catalog));
  writeFileSync(join(temp, 'marketplace.json'), JSON.stringify(marketplace));
  writeFileSync(join(temp, 'items.json'), JSON.stringify({ legacy: { catalog_item_id: 'legacy', title: 'Old item' } }));
  for (const source of ['fixture', 'api']) {
    const name = `corten-bench-parity-aot-${process.pid}-${source}`;
    docker('run', '--rm', '-d', '--name', name,
      '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-parity-aot',
      ...hostGateway,
      '-p', '127.0.0.1::8080', '-v', `${temp}:/fixtures:ro`,
      '-e', 'ASPNETCORE_ENVIRONMENT=Production', '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
      '-e', `CATALOG_SOURCE=${source}`, '-e', `MARKETPLACE_SOURCE=${source}`,
      '-e', `API_BASE=http://host.docker.internal:${upstream.address().port}`, image);
    containers.add(name);
    const port = docker('port', name, '8080/tcp').split(':').at(-1);
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(base + '/health/ready')).ok; } catch { /* process starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `${source}: native process ready`);
    console.log(`PASS ${source}: native process started; readiness healthy`);
    if (source === 'fixture') {
      writeFileSync(join(temp, 'catalog.json'), '{}');
      writeFileSync(join(temp, 'marketplace.json'), '{}');
    }
    for (const [kind, data] of [['catalog', catalog], ['marketplace', marketplace]]) {
      const start = requests.length;
      for (const [id, record] of Object.entries(data)) {
        const response = await fetch(`${base}/api/${kind}/${id}`);
        assert.equal(response.status, 200, `${source} ${kind} ${id}`);
        assert.match(response.headers.get('content-type'), /^application\/json/);
        assert.equal(response.headers.get('cache-control'), 'private, no-cache');
        const text = await response.text();
        const actual = JSON.parse(text);
        assert.deepEqual(actual, record, `${source} ${kind} ${id}: exact full schema and values`);
        if (kind === 'marketplace') validateRecord(actual, id);
        if (id === 'record_1' || id === 'item_17') {
          assert.ok(!text.includes('<script>'), 'HTML-sensitive content escaped');
          assert.ok(text.includes('\\u003C'), 'native JSON encoder escaping');
        }
      }
      assert.equal(requests.length - start, source === 'api' ? 500 : 0);
      console.log(`PASS ${source} ${kind}: all 500 exact records, escaping, empty/null/numeric schemas; ${requests.length - start} upstream reads`);
      const missing = await fetch(`${base}/api/${kind}/missing`);
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get('content-type'), /^application\/problem\+json/);
      assert.equal((await missing.json()).status, 404);
      const id = Object.keys(data)[0];
      const head = await fetch(`${base}/api/${kind}/${id}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.equal((await fetch(`${base}/api/${kind}/${id}`, { method: 'POST' })).status, 405);
      console.log(`PASS ${source} ${kind}: missing 404 Problem Details, HEAD and method rejection`);
      if (source === 'api') {
        const record = structuredClone(data[id]);
        record.title = 'Fresh café العربية <&"\\\n';
        const before = requests.length;
        responseOverride = { body: JSON.stringify({ ...record, upstream_only: true }, null, 2) };
        const escapedId = encodeURIComponent('probe ?#%é');
        if (kind === 'marketplace') {
          record.id = decodeURIComponent(escapedId);
          responseOverride.body = JSON.stringify({ ...record, upstream_only: true }, null, 2);
        }
        const freshResponse = await fetch(`${base}/api/${kind}/${escapedId}`);
        const text = await freshResponse.text();
        assert.equal(freshResponse.status, 200);
        assert.deepEqual(JSON.parse(text), record);
        assert.notEqual(text, responseOverride.body, 'parse/reserialize, not upstream pass-through');
        assert.ok(text.includes('café العربية'), 'non-Latin text stays UTF-8');
        assert.equal(requests.length, before + 1);
        assert.equal(requests.at(-1), `/${kind}/records/${escapedId}`);
        record.title = 'Changed again';
        record.id = id;
        responseOverride.body = JSON.stringify(record);
        assert.deepEqual(await (await fetch(`${base}/api/${kind}/${id}`)).json(), record);
        const invalid = structuredClone(record);
        delete invalid.title;
        const cases = [
          { status: 503, body: 'unavailable' },
          { status: 302, headers: { location: '/unexpected-redirect-target' }, body: '{}' },
          { body: 'null' }, { body: '{' }, { body: '{}' }, { body: JSON.stringify(invalid) },
          { body: JSON.stringify({ ...record, tags: [null] }) },
        ];
        if (kind === 'marketplace') cases.push({ body: JSON.stringify({ ...record, summary: { lowest_minor: '1', count: 0, quantity: 0 } }) });
        for (const fault of cases) {
          responseOverride = fault;
          const before = requests.length;
          const failure = await fetch(`${base}/api/${kind}/${id}`);
          assert.equal(failure.status, 500, `${kind}: ${JSON.stringify(fault)}`);
          assert.match(failure.headers.get('content-type'), /^application\/problem\+json/);
          assert.equal((await failure.json()).status, 500);
          assert.equal(requests.length, before + 1, 'exactly one upstream read, no redirect follow');
        }
        responseOverride = undefined;
        console.log(`PASS api ${kind}: uncached fresh data, UTF-8/escaping, encoded id, native reserialization, upstream/malformed/missing-field errors and unfollowed redirect`);
        if (kind === 'marketplace') {
          const invalidCases = invalidMarketplaceCases(data[id]);
          for (const invalid of invalidCases) {
            responseOverride = { body: JSON.stringify(invalid.record) };
            const before = requests.length;
            const response = await fetch(`${base}/api/${kind}/${id}`);
            const body = await response.text();
            observe({ kind: 'invalid-schema', name: invalid.name, input: invalid.record, status: response.status, headers: [...response.headers], body });
            assert.equal(response.status, 500, invalid.name);
            assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
            assert.equal(JSON.parse(body).status, 500);
            assert.equal(requests.length, before + 1);
          }
          responseOverride = undefined;
          console.log(`PASS api marketplace: ${invalidCases.length} canonical complete-schema invalid cases return JSON 500; one read each`);
        }
        await checkCancellation(base, kind, id);
      }
      gateMode = true;
      const result = await checkJsonApp({ payload: kind === 'catalog' ? 'catalog-v1' : 'marketplace-v2', source, base,
        records: data, upstream: `http://127.0.0.1:${upstream.address().port}`, observe });
      observe({ kind: 'shared-gate-result', result });
      assert.equal(result.jsonRecords, 500);
      assert.equal(result.readyForLoad, false);
      gateMode = false;
      console.log(`PASS reviewed shared JSON gate: ${source} ${kind}, 500 records; raw responses retained; no load-readiness claim`);
    }
    assert.equal((await (await fetch(base + '/api/items/legacy')).json()).title, 'Old item');
    assert.equal((await fetch(base + '/api/items/missing')).status, 404);
    assert.equal((await fetch(base + '/health/live')).status, 200);
    assert.equal((await fetch(base + '/health/ready')).status, 200);
    assert.equal((await fetch(base + '/catalog/record_1')).status, 404);
    assert.equal((await fetch(base + '/marketplace/en-US/item_1')).status, 404);
    console.log(`PASS ${source}: legacy items, health and production headers preserved; no page routes`);
    docker('rm', '-f', '-v', name);
    containers.delete(name);
  }
  writeFileSync(join(temp, 'catalog.json'), JSON.stringify(catalog));
  const startupCases = invalidMarketplaceCases(marketplace.item_1).filter(c => [
    'summary.count invalid numeric -1', 'listings.0.rating_hundredths invalid numeric 501',
    'listings.0.quantity invalid numeric -1', 'listings duplicate id', 'record id mismatch', 'title null',
  ].includes(c.name));
  const badReference = structuredClone(marketplace.item_1);
  badReference.contents[0].item_id = 'missing';
  startupCases.push({ name: 'unknown fixture item reference', record: badReference });
  for (const [index, invalid] of startupCases.entries()) {
    writeFileSync(join(temp, 'marketplace.json'), JSON.stringify({ ...marketplace, item_1: invalid.record }));
    const name = `corten-bench-parity-aot-${process.pid}-invalid-${index}`;
    docker('run', '-d', '--name', name, '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-parity-aot',
      '-v', `${temp}:/fixtures:ro`, '-e', 'ASPNETCORE_ENVIRONMENT=Production', '-e', 'ITEM_SOURCE=fixture',
      '-e', 'FIXTURE_PATH=/fixtures/items.json', '-e', 'CATALOG_SOURCE=fixture', '-e', 'MARKETPLACE_SOURCE=fixture', image);
    containers.add(name);
    let state;
    for (let i = 0; i < 100; i++) {
      state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
      if (!state.Running) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const output = logs(name);
    observe({ kind: 'invalid-fixture-startup', name: invalid.name, state, logs: output });
    assert.equal(state.Running, false, `${invalid.name}: startup must reject invalid fixture`);
    assert.notEqual(state.ExitCode, 0);
    assert.match(output, /JsonException/);
    docker('rm', '-f', '-v', name);
    containers.delete(name);
  }
  console.log(`PASS native fixture startup: ${startupCases.length} invalid numeric/duplicate/id/null/reference cases rejected before serving`);
  console.log('PASS native AOT JSON checks: both sources, both full 500-record workloads');
} catch (error) {
  for (const name of containers) console.error(logs(name));
  throw error;
} finally {
  for (const name of containers) docker('rm', '-f', '-v', name);
  const closed = new Promise(resolve => upstream.close(resolve));
  upstream.closeAllConnections();
  await closed;
  rmSync(temp, { recursive: true, force: true });
}
