// Focused W3C regressions against a normal release image, not qualification.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { records } from '../../../marketplace/fixtures.mjs';
import { cleanupResources, createOwnedContainer } from '../../native-trace-cost.mjs';

export async function cleanupProbe(active, remove, upstream, temp, original) {
  await cleanupResources(active, remove, [], upstream, original, [() => {
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + sep));
    rmSync(temp, { recursive: true, force: true });
  }]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
const [image, suite = 'flags'] = process.argv.slice(2);
assert.ok(image && ['flags', 'repeated-state', 'parser-controls'].includes(suite), 'usage: node check-trace-flags.mjs IMAGE [flags|repeated-state|parser-controls]');
const app = basename(fileURLToPath(new URL('.', import.meta.url)));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const fixture = records(), id = 'item_1';
const parent = '00-11111111111111111111111111111111-1111111111111111-00';
const state = 'vendor=\x80\xe9\xff';
const temp = mkdtempSync(join(tmpdir(), 'row7-' + app + '-'));
const results = new URL(app === 'drogon' ? './tests/results/' : './results/trace-proof/', import.meta.url);
const raw = new URL('row7-' + suite + '-' + Date.now() + '.ndjson', results);
const record = row => appendFileSync(raw, JSON.stringify(row) + '\n');
const digest = body => createHash('sha256').update(body).digest('hex');
const events = [], failures = [];
let active;
const owned = new Set();
let original;
const upstream = createServer((req, res) => {
  events.push({ path: req.url, parent: req.headers.traceparent ?? null, state: req.headers.tracestate ?? null });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(fixture[id]));
});
function send(base, path, method, headers = {}) {
  const body = Buffer.from('email=trace%40example.test&target_price=' + (path.includes('/en-US/') ? '12.50' : '12%2C50'));
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, agent: false, headers: {
      ...headers, ...(method === 'POST' ? { origin: base, 'content-type': 'application/x-www-form-urlencoded', 'content-length': body.length } : {}),
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('native HTTP timeout')));
    req.end(method === 'POST' ? body : undefined);
  });
}
function hostile(base, byte) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(Buffer.from('GET /api/marketplace/' + id + ' HTTP/1.1\r\nHost: ' + url.host +
        '\r\nConnection: close\r\ntraceparent: ' + parent + String.fromCharCode(byte) +
        '\r\ntracestate: must=not-leak\r\n\r\n', 'latin1'));
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.setTimeout(15_000, () => socket.destroy(new Error('hostile HTTP timeout')));
    socket.on('end', () => resolve(Number(Buffer.concat(chunks).toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/)?.[1])));
  });
}
function check(label, row, callback) {
  try { callback(); record({ label, ...row, pass: true }); }
  catch (error) { failures.push(label + ': ' + error.message); record({ label, ...row, pass: false, error: error.message }); }
}
try {
  mkdirSync(results, { recursive: true });
  await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
  writeFileSync(join(temp, 'items.json'), '{}');
  writeFileSync(join(temp, 'catalog.json'), '{}');
  writeFileSync(join(temp, 'marketplace.json'), JSON.stringify(fixture));
  record({ image, imageId: docker('image', 'inspect', '--format', '{{.Id}}', image), suite, qualification: false });
  for (const profile of ['defaults', 'matched']) for (const source of ['fixture', 'api']) {
    const name = 'row7-' + app + '-' + process.pid + '-' + profile + '-' + source;
    active = createOwnedContainer(docker, owned, name, ['--label', 'agent.owner=codex', '--label', 'agent.task=row7-' + app,
      ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
      '-p', '127.0.0.1::8080', '-v', temp + ':/fixtures:ro',
      '-e', 'PROFILE=' + profile, '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
      '-e', 'CATALOG_SOURCE=fixture', '-e', 'CATALOG_FIXTURE_PATH=/fixtures/catalog.json',
      '-e', 'MARKETPLACE_SOURCE=' + source, '-e', 'MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json',
      '-e', 'API_BASE=http://host.docker.internal:' + upstream.address().port, image]);
    docker('start', active);
    const base = 'http://127.0.0.1:' + docker('port', active, '8080/tcp').split(':').at(-1);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await send(base, '/api/alerts', 'GET')).status === 200) { ready = true; break; } } catch {}
      await sleep(100);
    }
    assert.ok(ready, docker('logs', active));
    const cases = suite === 'parser-controls' ? [] : suite === 'repeated-state' ? [
      [parent, ['first=one', 'second=two'], parent, 'first=one,second=two'],
      [parent, ['second=two', 'first=one'], parent, 'second=two,first=one'],
      [parent, ['first=one', 'second=two', 'third=three'], parent, 'first=one,second=two,third=three'],
    ] : [
      ...['80', '81', 'fe', 'ff'].flatMap(flags => [
        ['01' + parent.slice(2, 53) + flags + '-future', state, parent.slice(0, 53) + (parseInt(flags, 16) & 1 ? '01' : '00'), state],
        [parent.slice(0, 53) + flags, state, parent.slice(0, 53) + flags, state],
      ]),
      ['bad', state, null, null], ['ff' + parent.slice(2), state, null, null],
      [parent + '-extra', state, null, null], [parent + ', ' + parent, state, null, null],
      [parent.replace('1111', 'ABCD'), state, null, null],
      [parent.replace('1'.repeat(32), '0'.repeat(32)), state, null, null],
      ['01' + parent.slice(2) + 'x', state, null, null],
      [undefined, state, null, null],
    ];
    const routes = [['GET', '/api/marketplace/' + id], ['HEAD', '/api/marketplace/' + id],
      ...['en-US', 'fr-FR', 'de-DE'].flatMap(tag => ['GET', 'POST'].map(method => [method, '/marketplace/' + tag + '/' + id]))];
    for (const [method, path] of routes) {
      const start = events.length;
      const baseline = await send(base, path, method);
      assert.equal(baseline.status, 200);
      assert.deepEqual(events.slice(start), source === 'fixture' ? [] : [{ path: '/marketplace/records/' + id, parent: null, state: null }]);
      for (const [input, inputState, expectedParent, expectedState] of cases) {
        const begin = events.length;
        const response = await send(base, path, method, {
          ...(input === undefined ? {} : { traceparent: input }), tracestate: inputState,
        });
        const label = profile + '/' + source + '/' + method + path;
        const observed = events.slice(begin);
        check(label, { input, inputState, expectedParent, expectedState, observed, status: response.status,
          baselineBytes: baseline.body.length, responseBytes: response.body.length,
          baselineHash: digest(baseline.body), responseHash: digest(response.body) }, () => {
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, baseline.body, 'trace must not change native body bytes');
          assert.deepEqual(observed, source === 'fixture' ? [] : [{ path: '/marketplace/records/' + id, parent: expectedParent, state: expectedState }]);
        });
      }
    }
    const controls = suite === 'flags' ? [0, 0x1f, 0x7f] : suite === 'parser-controls' ? [0x0b, 0x0c] : [];
    for (const byte of controls) {
      const start = events.length;
      const status = await hostile(base, byte);
      const observed = events.slice(start);
      check(profile + '/' + source + '/control-' + byte, { status, observed }, () => {
        assert.ok([200, 400, 431].includes(status), 'native parser must reject or safely discard hostile context');
        assert.deepEqual(observed, source === 'fixture' || status !== 200 ? [] : [{ path: '/marketplace/records/' + id, parent: null, state: null }]);
      });
    }
    console.log('CHECKED ' + app + ' ' + suite + ' ' + profile + '/' + source);
    docker('rm', '-f', '-v', active); owned.delete(active); active = undefined;
  }
  assert.equal(failures.length, 0, failures.length + ' regression failures; first: ' + failures[0]);
  console.log('PASS: release native HTTP, exact body bytes and source headers');
} catch (error) {
  original = error;
  throw error;
} finally {
  try { await cleanupProbe(owned, id => docker('rm', '-f', '-v', id), upstream, temp, original); }
  finally { console.log('Raw observations: ' + fileURLToPath(raw)); }
}
}
