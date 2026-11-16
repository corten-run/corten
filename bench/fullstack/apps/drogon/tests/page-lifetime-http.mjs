// Actual native page sockets, not a source audit, qualification or throughput receipt.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { records } from '../../../../marketplace/fixtures.mjs';
import { createPlan, responseStatuses } from '../../../../workloads/mixed.mjs';
import { slowMs } from '../../../../fullstack/mixed.mjs';

const [image, output = 'bench/fullstack/apps/drogon/tests/results/page-lifetime.ndjson'] = process.argv.slice(2);
assert.ok(image, 'usage: node tests/page-lifetime-http.mjs IMAGE [RAW_OUTPUT]');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const raw = resolve(output), fixture = records();
mkdirSync(resolve(raw, '..'), { recursive: true }); writeFileSync(raw, '');
const observe = value => appendFileSync(raw, JSON.stringify(value) + '\n');
const plan = createPlan({ seed: 11, clients: 1, repetitions: 1, records: fixture });
const operations = new Map(), errors = [];
const temp = mkdtempSync(join(tmpdir(), 'drogon-page-lifetime-'));
const name = `drogon-page-lifetime-${process.pid}`;
let serial = 0, launched = false;
const server = createServer((req, res) => {
  const op = operations.get(req.headers.traceparent);
  if (!op) { observe({ kind: 'unattributed-source', path: req.url }); res.writeHead(503); res.end(); return; }
  const event = { path: req.url, parent: req.headers.traceparent, state: req.headers.tracestate, result: 'pending' };
  op.events.push(event);
  observe({ kind: 'source-start', operation: op.id, ...event });
  const body = JSON.stringify(fixture[op.request.itemId]);
  const finish = result => {
    if (event.result !== 'pending') return;
    event.result = result; clearTimeout(timer);
    observe({ kind: 'source-end', operation: op.id, ...event });
  };
  res.once('finish', () => finish('completed'));
  res.once('close', () => finish(res.writableFinished ? 'completed' : 'cancelled'));
  if (op.stage === 'body') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write(body.slice(0, 30));
  }
  const timer = setTimeout(() => {
    if (op.stage !== 'body') res.writeHead(200, { 'content-type': 'application/json' });
    res.end(op.stage === 'body' ? body.slice(30) : body);
  }, op.request.variant === 'complete' ? 100 : slowMs);
});
function send(base, path, headers = {}) {
  let client, guard;
  const pending = new Promise(resolve => {
    client = request(base + path, { agent: false, headers }, res => {
      let body = '';
      res.on('data', part => { body += part; if (body.length > 2_000_000) client.destroy(new Error('response too large')); });
      res.on('end', () => { clearTimeout(guard); resolve({ status: res.statusCode, body }); });
      res.on('error', error => { clearTimeout(guard); resolve({ status: 0, error: error.message }); });
    });
    client.on('error', error => { clearTimeout(guard); resolve({ status: 0, error: error.message }); });
    guard = setTimeout(() => client.destroy(new Error('driver guard, not a native deadline')), 60_000);
    client.end();
  });
  return { pending, abort: () => client.destroy(new Error('caller-cancelled')) };
}
function counts(op) {
  return Object.fromEntries(['requests', 'completed', 'cancelled', 'pending'].map(key => [key,
    key === 'requests' ? op.events.length : op.events.filter(event => event.result === key).length]));
}
async function until(test, ms) {
  const end = performance.now() + ms;
  while (!test() && performance.now() < end) await sleep(5);
  return test();
}
async function run(base, request, stage = 'headers') {
  const id = `page_${++serial}`, hex = serial.toString(16).padStart(32, '0');
  const parent = `00-${hex}-${hex.slice(16)}-01`;
  const op = { id, request, stage, events: [] }; operations.set(parent, op);
  const started = performance.now();
  const client = send(base, request.path, { traceparent: parent, tracestate: `test=${id}` });
  assert.ok(await until(() => op.events.length > 0, 5000), 'native page must start its source read');
  if (request.variant === 'cancel') { await sleep(50); client.abort(); }
  const response = await client.pending;
  const elapsedMs = Math.round(performance.now() - started);
  await until(() => counts(op).pending === 0, 500);
  const actual = counts(op);
  observe({ kind: 'page-result', id, request, stage, response, elapsedMs, upstream: actual });
  try {
    assert.equal(actual.requests, 1, 'one source fetch, no retry');
    assert.equal(actual.pending, 0, 'upstream must close within the unchanged 500ms cleanup observation');
    for (const event of op.events) {
      assert.equal(event.path, `/marketplace/records/${request.itemId}`);
      assert.equal(event.parent, parent); assert.equal(event.state, `test=${id}`);
    }
    if (request.variant === 'complete') {
      assert.equal(response.status, 200); assert.ok(response.body.includes('<article class="marketplace">'));
      assert.equal(actual.completed, 1); assert.equal(actual.cancelled, 0);
    } else {
      assert.equal(actual.completed, 0); assert.equal(actual.cancelled, 1);
      if (request.variant === 'cancel') assert.equal(response.error, 'caller-cancelled');
      else { assert.ok(responseStatuses.deadline.includes(response.status), 'real native deadline status required'); assert.ok(elapsedMs < 35_000); }
    }
    console.log(`PASS ${request.locale} ${stage} ${request.variant}: ${elapsedMs}ms ${JSON.stringify(actual)}`);
  } catch (error) { errors.push(`${request.locale}/${stage}/${request.variant}: ${error.message}`); }
  // A different traced operation must recover while any old failed operation is still visible.
  if (request.variant !== 'complete') await run(base, { ...request, variant: 'complete' });
  op.sealed = { ...actual };
}
try {
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  writeFileSync(join(temp, 'items.json'), JSON.stringify({ legacy: { catalog_item_id: 'legacy', title: 'Old item' } }));
  observe({ kind: 'image', image: JSON.parse(docker('image', 'inspect', image))[0].Id, planSha256: plan.sha256 });
  docker('run', '-d', '--name', name, '--cpus', '1', '--memory', '1g',
    '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-drogon-lifetime-repair',
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '-p', '127.0.0.1::8080', '-v', `${temp}:/fixtures:ro`,
    '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
    '-e', 'MARKETPLACE_SOURCE=api', '-e', `API_BASE=http://host.docker.internal:${server.address().port}`, image);
  launched = true;
  const binding = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['8080/tcp'][0];
  const base = `http://127.0.0.1:${binding.HostPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await send(base, '/api/alerts').pending).status === 200; } catch {}
    if (!ready) await sleep(100);
  }
  assert.ok(ready, 'native executable must become ready');
  // Readback has no source fetch and cannot accidentally arm a record operation.
  async function readback() { const r = await send(base, '/api/alerts').pending; assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), []); }
  for (const locale of ['en-US', 'fr-FR', 'de-DE']) {
    for (const variant of ['complete', 'cancel', 'deadline']) {
      const planned = plan.requests.find(r => r.category === 'slow' && r.locale === locale && r.variant === variant);
      await run(base, planned);
    }
    await readback();
    if (errors.length) break; // Red retains all three first-locale outcomes before stopping.
  }
  if (!errors.length) {
    const request = plan.requests.find(r => r.category === 'slow' && r.locale === 'en-US');
    for (const variant of ['cancel', 'deadline']) await run(base, { ...request, variant }, 'body');
    await readback();
    await sleep(500);
    for (const op of operations.values()) assert.deepEqual(counts(op), op.sealed, 'sealed operation drift or late replay');
  }
  observe({ kind: 'result', passed: errors.length === 0, errors });
  assert.deepEqual(errors, []);
} finally {
  // Observations/assertions precede teardown: removal cannot manufacture source cancellation.
  if (launched) { observe({ kind: 'native-log', log: docker('logs', name) }); docker('rm', '-f', '-v', name); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
