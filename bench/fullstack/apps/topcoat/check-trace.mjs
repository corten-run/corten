// Functional checks of the native production image, not a performance runner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [image] = process.argv.slice(2);
assert.ok(image, 'usage: node check-trace.mjs IMAGE');
const first = '00-11111111111111111111111111111111-1111111111111111-00';
const second = '00-22222222222222222222222222222222-2222222222222222-01';
const state = 'vendor=\x80\x85\xa0\xe9\xff';
const record = JSON.parse(await readFile(new URL('./tests/marketplace.json', import.meta.url)));
const folder = await mkdtemp(join(tmpdir(), 'topcoat-trace-'));
const observations = [];
let hold;
const upstream = createServer((req, res) => {
  observations.push({ path: req.url, parent: req.headers.traceparent, state: req.headers.tracestate });
  const body = JSON.stringify(record);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.flushHeaders();
  if (hold) {
    const gate = hold;
    hold = undefined;
    gate.release = () => res.end(body);
    gate.entered();
  } else res.end(body);
});
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
// Keep POST bodies as buffers: Node 24 otherwise UTF-8-encodes a coalesced
// header/body string, corrupting obs-text before the native app receives it.
function send(base, path, { parent, traceState = parent === undefined ? undefined : state, post = false, delayed = false } = {}) {
  const headers = parent === undefined ? {} : { traceparent: parent };
  if (traceState !== undefined) headers.tracestate = traceState;
  const body = `email=trace%40example.test&target_price=${path.includes('/en-US/') ? '12.50' : '12%2C50'}`;
  if (post) Object.assign(headers, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) });
  let release;
  const result = new Promise((resolve, reject) => {
    const req = request(base + path, { method: post ? 'POST' : 'GET', headers, timeout: 15_000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('native request timeout')));
    release = () => req.end(post ? Buffer.from(body.slice(delayed ? 1 : 0)) : undefined);
    if (delayed) req.write(Buffer.from(body.slice(0, 1))); else release();
  });
  return { result, release };
}
const ok = async result => {
  const response = await result;
  assert.equal(response.status, 200, response.body.slice(0, 500));
  return response;
};
const expected = (parent, traceState = state) => ({ path: '/marketplace/records/item_1', parent, state: parent ? traceState : undefined });
const within = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('upstream not reached')), 10_000); })]); }
  finally { clearTimeout(timer); }
};
let active;
try {
  await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
  await writeFile(join(folder, 'items.json'), '{}');
  await writeFile(join(folder, 'catalog.json'), '{}');
  await writeFile(join(folder, 'marketplace.json'), JSON.stringify({ item_1: record }));
  for (const profile of ['defaults', 'matched']) for (const source of ['api', 'fixture']) {
    active = `topcoat-trace-${process.pid}-${profile}-${source}`;
    docker('run', '-d', '--name', active,
      '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-parity-topcoat-trace',
      ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
      '-p', '127.0.0.1::8080', '-v', `${folder}:/fixtures:ro`,
      '-e', `PROFILE=${profile}`, '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
      '-e', 'CATALOG_SOURCE=fixture', '-e', `MARKETPLACE_SOURCE=${source}`,
      '-e', 'MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json',
      '-e', `API_BASE=http://host.docker.internal:${upstream.address().port}`, image);
    const binding = JSON.parse(docker('inspect', active))[0].NetworkSettings.Ports['8080/tcp'][0];
    const base = `http://127.0.0.1:${binding.HostPort}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await send(base, '/api/alerts').result).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, docker('logs', active));
    for (const [path, post] of [
      ['/api/marketplace/item_1', false],
      ...['en-US', 'fr-FR', 'de-DE'].flatMap(tag => [[`/marketplace/${tag}/item_1`, false], [`/marketplace/${tag}/item_1`, true]]),
    ]) {
      const start = observations.length;
      const baseline = await ok(send(base, path, { post }).result);
      const traced = await ok(send(base, path, { post, parent: first }).result);
      assert.equal(traced.body, baseline.body, 'trace must not alter native output');
      assert.equal(traced.headers['x-frame-options'], profile === 'matched' ? 'DENY' : undefined);
      if (source === 'api') assert.deepEqual(observations.slice(start), [expected(undefined), expected(first)], `${profile}/${post ? 'POST' : 'GET'} ${path}`);
      if (!post && path.startsWith('/api/')) assert.deepEqual(JSON.parse(traced.body), record);
      if (post) {
        const cookie = traced.headers['set-cookie'][0].split(';')[0];
        const rows = await new Promise((resolve, reject) => {
          const req = request(base + '/api/alerts', { headers: { cookie } }, res => {
            let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text)));
          }); req.on('error', reject); req.end();
        });
        assert.deepEqual(rows, [{ item_id: 'item_1', email: 'trace@example.test', target_minor: 1250 }]);
      }
      if (source === 'api') {
        const start = observations.length;
        let entered;
        const reached = new Promise(resolve => { entered = resolve; });
        const gate = hold = { entered };
        const old = send(base, path, { parent: first, post }).result;
        let finished = false;
        old.then(() => { finished = true; }, () => { finished = true; });
        try {
          await within(reached);
          await ok(send(base, path, { parent: second, post }).result);
          await ok(send(base, path, { post }).result);
          assert.equal(finished, false, 'old request must remain delayed');
        } finally { gate.release?.(); hold = undefined; }
        await ok(old);
        await ok(send(base, path, { post }).result);
        assert.deepEqual(observations.slice(start), [expected(first), expected(second), expected(undefined), expected(undefined)]);
      } else assert.equal(observations.length, start, 'fixture must never call upstream');
    }
    // Hold a native form body before source work while other requests finish.
    const start = observations.length;
    const delayed = send(base, '/marketplace/en-US/item_1', { parent: first, post: true, delayed: true });
    try {
      await ok(send(base, '/api/marketplace/item_1', { parent: second }).result);
      await ok(send(base, '/api/marketplace/item_1').result);
    } finally { delayed.release(); }
    await ok(delayed.result);
    if (source === 'api') assert.deepEqual(observations.slice(start), [expected(second), expected(undefined), expected(first)]);
    else assert.equal(observations.length, start);
    for (const parent of ['bad', '\x80\xe9', first.replace('1111', 'ABCD'), first + '-extra', first + ', ' + second, first.replace('00-', 'ff-')]) {
      const start = observations.length;
      await ok(send(base, '/api/marketplace/item_1', { parent }).result);
      if (source === 'api') assert.deepEqual(observations.slice(start), [expected(undefined)]);
      else assert.equal(observations.length, start);
    }
    const futureStart = observations.length;
    await ok(send(base, '/api/marketplace/item_1', { parent: '01' + first.slice(2) + '-future' }).result);
    await ok(send(base, '/api/marketplace/item_1', { parent: [first, second] }).result);
    await ok(send(base, '/api/marketplace/item_1', { traceState: state }).result);
    await ok(send(base, '/api/marketplace/item_1', { parent: first, traceState: [state, 'other=two'] }).result);
    await ok(send(base, '/api/marketplace/item_1').result);
    if (source === 'api') assert.deepEqual(observations.slice(futureStart), [expected(first), expected(undefined), expected(undefined), expected(first, state + ',other=two'), expected(undefined)]);
    else assert.equal(observations.length, futureStart);
    console.log(`PASS ${profile}/${source}: native pages, JSON, alerts, delayed/concurrent/untraced isolation and header validation`);
    docker('rm', '-f', '-v', active); active = undefined;
  }
} finally {
  hold?.release?.();
  if (active) docker('rm', '-f', '-v', active);
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  const { resolve, sep } = await import('node:path');
  assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
  await rm(folder, { recursive: true, force: true });
}
