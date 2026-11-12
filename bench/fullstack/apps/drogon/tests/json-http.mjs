import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { records as catalogRecords } from '../../../../catalog/fixtures.mjs';
import { records as marketplaceRecords } from '../../../../marketplace/fixtures.mjs';
import { checkJsonApp } from '../../../../workloads/json-check.mjs';

const [image, mode = 'after'] = process.argv.slice(2);
assert.ok(image, 'usage: node tests/json-http.mjs IMAGE [before|after]');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const data = { catalog: catalogRecords(), marketplace: marketplaceRecords() };
const state = Object.fromEntries(Object.keys(data).map(k => [k, { requests: {}, control: {} }]));
const temp = mkdtempSync(join(tmpdir(), 'corten-bench-parity-drogon-'));
const containers = new Set(), active = new Set();
let redirectTargets = 0;
const folder = new URL('./results/', import.meta.url);
mkdirSync(folder, { recursive: true });
const raw = new URL(`${mode}-http-raw.ndjson`, folder);
writeFileSync(raw, '');
const observe = value => appendFileSync(raw, JSON.stringify(value) + '\n');
let fault, entered;
const server = createServer(async (req, res) => {
  if (req.url === '/redirect-target') { redirectTargets++; res.writeHead(200); res.end('{}'); return; }
  const control = req.url.match(/^\/__(catalog|marketplace)\/control$/);
  if (control) {
    const s = state[control[1]];
    if (req.method === 'POST') {
      let body = '';
      for await (const part of req) body += part;
      s.control = JSON.parse(body); s.requests = {};
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requests: s.requests })); return;
  }
  const match = req.url.match(/^\/(catalog|marketplace)\/records\/(.+)$/);
  if (!match) { res.writeHead(404); res.end('{}'); return; }
  const [, kind, encoded] = match, id = decodeURIComponent(encoded), s = state[kind];
  s.requests[id] = (s.requests[id] ?? 0) + 1;
  observe({ kind: 'upstream-read', path: req.url });
  if (fault?.stall) {
    active.add(res); res.once('close', () => active.delete(res));
    if (fault.stall === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"id":'); }
    entered?.(); return;
  }
  if (fault?.reset) { res.destroy(); return; }
  if (fault?.truncated) { res.writeHead(200, { 'content-length': '10000' }); res.write('{'); res.destroy(); return; }
  const status = fault?.status ?? s.control.status ?? 200;
  const record = fault?.record ?? (s.control.record?.id === id ? s.control.record : data[kind][id]);
  res.writeHead(status !== 200 ? status : record || fault?.body ? 200 : 404,
    { 'content-type': 'application/json', ...(status === 302 ? { location: '/redirect-target' } : {}) });
  res.end(fault?.body ?? (status !== 200 ? '{"error":"upstream"}' : record ? JSON.stringify({ ...record, upstream_only: true }, null, 2) : '{}'));
});
async function read(base, path, options) {
  const response = await fetch(base + path, options), body = await response.text();
  const value = { kind: 'application', path, status: response.status, headers: [...response.headers], body };
  observe(value); return value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
function jsonError(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.find(([key]) => key === 'content-type')?.[1] ?? '', /^application\/(?:problem\+)?json(?:;|$)/);
  assert.equal(JSON.parse(response.body).status, status);
}
async function released() {
  for (let i = 0; i < 100 && active.size; i++) await sleep(20);
  assert.equal(active.size, 0, 'upstream socket released, no ongoing response read');
}
async function lifecycle(base, kind, id) {
  for (const stage of ['headers', 'body']) for (const outcome of ['disconnect', 'deadline']) {
    fault = { stall: stage };
    let didStart = false;
    const started = new Promise(resolve => { entered = () => { didStart = true; resolve(); }; });
    const abort = new AbortController(), before = state[kind].requests[id] ?? 0, begin = performance.now();
    const pending = fetch(`${base}/api/${kind}/${id}`, { signal: abort.signal }).then(response => ({ response }), error => ({ error }));
    await within(Promise.race([started, pending.then(async result => {
      if (!didStart) throw new Error(`upstream did not start: early native response ${result.response?.status}, ${result.response ? await result.response.text() : result.error}`);
    })]), 5000, 'upstream did not start');
    assert.equal(active.size, 1, 'real upstream operation in flight');
    if (outcome === 'disconnect') abort.abort();
    const result = await within(pending, 15_000, 'unbounded request');
    if (outcome === 'disconnect') assert.equal(result.error?.name, 'AbortError');
    else {
      const body = await result.response.text();
      jsonError({ status: result.response.status, headers: [...result.response.headers], body }, 504);
      observe({ kind: 'deadline-response', payload: kind, stage, status: result.response.status, headers: [...result.response.headers], body });
    }
    await released();
    assert.equal(state[kind].requests[id], before + 1, 'one fetch, no cancellation retry');
    const elapsedMs = Math.round(performance.now() - begin);
    fault = undefined; entered = undefined;
    assert.equal((await read(base, `/api/${kind}/${id}`)).status, 200);
    observe({ kind: 'lifecycle', payload: kind, stage, outcome, elapsedMs, active: active.size });
    console.log(`PASS ${kind}: ${stage} ${outcome}, measured ${elapsedMs} ms, upstream active=0, no retry, recovery 200`);
  }
}
try {
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  for (const [kind, records] of Object.entries(data)) writeFileSync(join(temp, kind + '.json'), JSON.stringify(records));
  writeFileSync(join(temp, 'items.json'), JSON.stringify({ legacy: { catalog_item_id: 'legacy', title: 'Old item' } }));
  for (const source of mode === 'before' ? ['api'] : ['fixture', 'api']) {
    const name = `corten-bench-parity-drogon-${process.pid}-${source}`;
    docker('run', '-d', '--name', name, '--cpus', '1',
      '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-parity-drogon',
      ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
      '-p', '127.0.0.1::8080', '-v', `${temp}:/fixtures:ro`, '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
      '-e', `CATALOG_SOURCE=${source}`, '-e', `MARKETPLACE_SOURCE=${source}`,
      '-e', `API_BASE=http://host.docker.internal:${server.address().port}`, image);
    containers.add(name);
    observe({ kind: 'native-runtime', source, container: name, imageId: docker('inspect', '--format', '{{.Image}}', name) });
    const port = docker('port', name, '8080/tcp').split(':').at(-1), base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(base + '/api/items/legacy')).ok; } catch { /* starting */ }
      if (ready) break; await sleep(100);
    }
    assert.ok(ready, 'native server started');
    for (const kind of ['catalog', 'marketplace']) {
      const id = Object.keys(data[kind])[0], path = `/api/${kind}/${id}`;
      if (mode === 'before') {
        for (const [label, p, options] of [['missing', `/api/${kind}/missing`], ['HEAD', path, { method: 'HEAD' }], ['POST', path, { method: 'POST' }]]) {
          const result = await read(base, p, options);
          console.log(`BEFORE ${kind} ${label}: ${result.status}, ${JSON.stringify(result.headers.find(([k]) => k === 'content-type')?.[1])}, body=${JSON.stringify(result.body)}`);
        }
        fault = { stall: 'body' };
        const started = new Promise(resolve => { entered = resolve; });
        const abort = new AbortController();
        const pending = fetch(base + path, { signal: abort.signal }).catch(error => error);
        await Promise.race([started, sleep(5000).then(() => { throw new Error('not in flight'); })]);
        abort.abort(); await pending; await sleep(400);
        console.log(`BEFORE ${kind} caller abort: upstream active=${active.size}`);
        assert.equal(active.size, 1, 'reproduce missing caller-abort cleanup');
        for (const res of active) res.destroy();
        await released(); fault = undefined; entered = undefined;
        if (kind === 'marketplace') for (const change of [record => { record.summary.count = 1e9 + 1; },
          record => { record.listings.push(record.listings[0]); }]) {
          const record = structuredClone(data[kind][id]); change(record); fault = { record };
          const invalid = await read(base, path); assert.equal(invalid.status, 200);
          console.log('BEFORE marketplace: schema-invalid bounds/duplicate record accepted as HTTP 200');
        }
        fault = undefined;
        continue;
      }
      const result = await checkJsonApp({ payload: kind === 'catalog' ? 'catalog-v1' : 'marketplace-v2', source, base, records: data[kind],
        upstream: `http://127.0.0.1:${server.address().port}`, observe });
      observe({ kind: 'shared-gate-result', result });
      assert.equal(result.jsonRecords, 500); assert.equal(result.readyForLoad, false);
      console.log(`PASS ${source} ${kind}: shared gate all 500 exact records and JSON missing/upstream errors, raw retained`);
      const head = await read(base, path, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body, '');
      const countBeforeMethods = JSON.stringify(state[kind].requests);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND', 'MKCOL', 'COPY', 'MOVE']) {
        const rejected = await read(base, path, { method });
        jsonError(rejected, 405);
        assert.equal(rejected.headers.find(([k]) => k === 'allow')?.[1], 'GET, HEAD');
      }
      assert.equal(JSON.stringify(state[kind].requests), countBeforeMethods, 'rejected methods do not fetch');
      const missingHead = await read(base, `/api/${kind}/missing`, { method: 'HEAD' });
      assert.equal(missingHead.status, 404); assert.equal(missingHead.body, '');
      if (source === 'api') {
        const encodedId = 'probe +?#%é';
        const record = { ...data[kind][id], id: encodedId, title: 'Fresh café العربية <&"\\\n' };
        fault = { record };
        const encoded = await read(base, `/api/${kind}/${encodeURIComponent(encodedId)}`);
        assert.equal(encoded.status, 200); assert.deepEqual(JSON.parse(encoded.body), record);
        assert.ok(!encoded.body.includes('upstream_only'), 'native parse/construct/reserialize discards unknown members');
        assert.equal(state[kind].requests[encodedId], 1);
        for (const value of [null, {}, { ...data[kind][id], title: null }, { ...data[kind][id], tags: [null] }]) {
          fault = { body: JSON.stringify(value) };
          jsonError(await read(base, path), 502);
        }
        if (kind === 'marketplace') {
          const boundary = structuredClone(data[kind][id]);
          boundary.summary = { lowest_minor: -1e9, count: 1e9, quantity: 0 };
          Object.assign(boundary.listings[0], { rating_hundredths: 500, reviews: 1e9, quantity: 0, price_minor: -1e9 });
          Object.assign(boundary.offers[0], { quantity: 1e9, price_minor: 1e9 });
          boundary.contents[0].quantity = 0; boundary.included_in[0].quantity = 1e9;
          fault = { record: boundary };
          const numeric = await read(base, path); assert.equal(numeric.status, 200); assert.deepEqual(JSON.parse(numeric.body), boundary);
          boundary.summary = null; boundary.subtitle = null;
          boundary.listings[0].rating_hundredths = null; boundary.listings[0].price_minor = null; boundary.offers[0].price_minor = null;
          fault = { record: boundary };
          const nullable = await read(base, path); assert.equal(nullable.status, 200); assert.deepEqual(JSON.parse(nullable.body), boundary);
          let invalid = 0;
          for (const [collection, key, min, max] of [['summary', 'lowest_minor', -1e9, 1e9], ['summary', 'count', 0, 1e9],
            ['summary', 'quantity', 0, 1e9], ['listings', 'rating_hundredths', 0, 500], ['listings', 'reviews', 0, 1e9],
            ['listings', 'quantity', 0, 1e9], ['listings', 'price_minor', -1e9, 1e9], ['offers', 'quantity', 0, 1e9],
            ['offers', 'price_minor', -1e9, 1e9], ['contents', 'quantity', 0, 1e9], ['included_in', 'quantity', 0, 1e9]]) {
            for (const value of [min - 1, max + 1, 0.5, '1']) {
              const record = structuredClone(data[kind][id]);
              (collection === 'summary' ? record[collection] : record[collection][0])[key] = value;
              fault = { record }; jsonError(await read(base, path), 502); invalid++;
            }
          }
          for (const collection of ['listings', 'offers', 'contents', 'included_in']) {
            const record = structuredClone(data[kind][id]); record[collection].push(record[collection][0]);
            fault = { record }; jsonError(await read(base, path), 502); invalid++;
          }
          console.log(`PASS API marketplace: ${invalid} numeric bounds/types and duplicate IDs rejected as JSON 502`);
        }
        for (const body of ['{', JSON.stringify(data[kind][id]) + ' garbage', `/* comment */${JSON.stringify(data[kind][id])}`,
          JSON.stringify(data[kind][id]).replace(/}$/, ',}'), JSON.stringify(data[kind][id]).replace('{', '{"id":"duplicate",')]) {
          fault = { body }; jsonError(await read(base, path), 502);
        }
        fault = { record: { ...data[kind][id], id: 'wrong-id' } }; jsonError(await read(base, path), 502);
        const redirectsBefore = redirectTargets;
        for (const status of [301, 302, 307, 308, 500, 503]) { fault = { status }; jsonError(await read(base, path), 502); }
        assert.equal(redirectTargets, redirectsBefore, 'redirects refused without following Location');
        for (const value of [{ reset: true }, { truncated: true }]) { fault = value; jsonError(await read(base, path), 502); }
        fault = undefined;
        assert.equal((await read(base, path)).status, 200, 'transport recovers after reset/truncated body');
        const fds = () => Number(docker('exec', name, '/bin/sh', '-c', 'ls /proc/1/fd | wc -l'));
        const beforeFds = fds();
        await lifecycle(base, kind, id);
        await sleep(10_500); // Allow the native client's canceled timeout callbacks to retire.
        const afterFds = fds();
        assert.ok(afterFds <= beforeFds + 2, `native descriptors settle: ${beforeFds} -> ${afterFds}`);
        observe({ kind: 'resource-recovery', payload: kind, beforeFds, afterFds, active: active.size });
        console.log(`PASS ${kind}: native descriptors ${beforeFds} -> ${afterFds} after cancellation/deadline recovery`);
      }
    }
    if (mode === 'after') {
      assert.equal(JSON.parse((await read(base, '/api/items/legacy')).body).title, 'Old item');
      for (const path of ['/catalog/record_1', '/marketplace/en-US/item_1', '/marketplace/fr-FR/item_1', '/marketplace/de-DE/item_1']) {
        const page = await read(base, path);
        assert.equal(page.status, 200, 'native page unchanged');
        assert.ok(page.body.includes('<html') && page.body.includes('<form'), 'native templates still render HTML and forms');
      }
    }
    observe({ kind: 'native-log', source, log: docker('logs', name) });
    docker('rm', '-f', '-v', name); containers.delete(name);
  }
  console.log(mode === 'before' ? 'PASS baseline gaps reproduced' : 'PASS native Drogon JSON checks');
} finally {
  for (const name of containers) {
    observe({ kind: 'native-log', container: name, log: docker('logs', name), state: JSON.parse(docker('inspect', '--format', '{{json .State}}', name)) });
    docker('rm', '-f', '-v', name);
  }
  const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  rmSync(temp, { recursive: true, force: true });
}
