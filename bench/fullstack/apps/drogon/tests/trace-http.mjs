// Focused native HTTP observations, not a qualification or source-audit receipt.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { records } from '../../../../marketplace/fixtures.mjs';

const [image, mode = 'after'] = process.argv.slice(2);
assert.ok(image && ['before', 'after'].includes(mode), 'usage: node tests/trace-http.mjs IMAGE [before|after]');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const fixture = records(), id = Object.keys(fixture)[0];
const a = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa-00';
const b = '00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bbbbbbbbbbbbbbbb-01';
const states = ['vendor=first', 'vendor=second'];
const temp = mkdtempSync(join(tmpdir(), 'drogon-trace-'));
const folder = new URL('./results/', import.meta.url);
mkdirSync(folder, { recursive: true });
const raw = new URL(`trace-${mode}-${Date.now()}.ndjson`, folder);
const observe = row => appendFileSync(raw, JSON.stringify(row) + '\n');
const events = [], containers = new Set();
let hold, current, missing = 0;
const upstream = createServer((req, res) => {
  const event = { path: req.url, traceparent: req.headers.traceparent ?? null,
    tracestate: req.headers.tracestate ?? null, rawHeaders: req.rawHeaders, completed: false };
  events.push(event); observe({ kind: 'source-start', ...current, ...event });
  res.once('finish', () => { event.completed = true; observe({ kind: 'source-finish', ...event }); });
  const record = fixture[decodeURIComponent(req.url.split('/').at(-1))];
  const body = JSON.stringify(record ?? {});
  const answer = () => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(record ? 200 : 404, { 'content-type': 'application/json' }); res.end(body);
  };
  if (hold && !hold.release) {
    if (hold.stage === 'body') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write(body.slice(0, 40));
      hold.release = () => { if (!res.writableEnded && !res.destroyed) res.end(body.slice(40)); };
    } else hold.release = answer;
  } else answer();
});
function send(base, path, { parent, state, post = false, head = false, deferred = false, cookie } = {}) {
  const body = new URLSearchParams({ email: 'trace@example.test', target_price: path.includes('/en-US/') ? '12.50' : '12,50' }).toString();
  let client, finished = false;
  const result = new Promise((resolve, reject) => {
    client = request(base + path, { method: post ? 'POST' : head ? 'HEAD' : 'GET', agent: false, headers: {
      ...(parent === undefined ? {} : { traceparent: parent }), ...(state === undefined ? {} : { tracestate: state }),
      ...(cookie ? { cookie } : {}), ...(post ? { origin: base, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => text += part);
      res.on('error', reject); res.on('end', () => {
        finished = true;
        const response = { status: res.statusCode, headers: res.headers, text };
        observe({ kind: 'response', ...current, method: post ? 'POST' : head ? 'HEAD' : 'GET', path, parent: parent ?? null, state: state ?? null, ...response });
        resolve(response);
      });
    });
    client.on('error', reject); client.setTimeout(15_000, () => client.destroy(new Error('native request timed out')));
    if (deferred) { client.flushHeaders(); client.write(body.slice(0, 10)); }
    // A string body makes Node 24 encode coalesced headers as UTF-8, not field bytes.
    else client.end(post ? Buffer.from(body, 'ascii') : undefined);
  });
  result.catch(() => {});
  return { result, finished: () => finished, finish: () => client.end(body.slice(10)), abort: () => client.destroy() };
}
async function wait(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await sleep(10); }
  assert.fail('delayed native source did not start');
}
function verify(start, expected) {
  const actual = events.slice(start);
  if (current.source === 'fixture') { assert.equal(actual.length, 0, 'fixture issued an HTTP read'); return; }
  assert.equal(actual.length, expected.length, 'exactly one source read per operation');
  actual.forEach((event, index) => {
    assert.equal(event.path, `/marketplace/records/${id}`);
    assert.equal(event.completed, true);
    assert.deepEqual([event.traceparent, event.tracestate], expected[index]);
  });
}
async function read(base, path, options) {
  const response = await send(base, path, options).result;
  assert.equal(response.status, 200);
  if (options?.head) assert.equal(response.text, '');
  else if (path.startsWith('/api/marketplace/')) assert.deepEqual(JSON.parse(response.text), fixture[id]);
  else if (!path.startsWith('/api/')) assert.ok(response.text.includes(fixture[id].title), 'native page rendered');
  return response;
}
try {
  upstream.listen(0, '0.0.0.0'); await once(upstream, 'listening');
  writeFileSync(join(temp, 'marketplace.json'), JSON.stringify(fixture));
  writeFileSync(join(temp, 'items.json'), JSON.stringify({ legacy: { catalog_item_id: 'legacy', title: 'Old item' } }));
  const imageId = docker('image', 'inspect', '--format', '{{.Id}}', image);
  observe({ kind: 'identity', image, imageId, mode, qualification: false });
  for (const profile of ['defaults', 'matched']) for (const source of ['fixture', 'api']) {
    current = { profile, source };
    const name = `drogon-trace-${process.pid}-${profile}-${source}`;
    docker('run', '-d', '--name', name, '--cpus', '1', '--label', 'agent.owner=codex', '--label', 'agent.task=parity-drogon-trace',
      ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
      '-p', '127.0.0.1::8080', '-v', `${temp}:/fixtures:ro`, '-e', `PROFILE=${profile}`, '-e', 'MAX_CONNECTIONS=256',
      '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json', '-e', `MARKETPLACE_SOURCE=${source}`,
      '-e', `API_BASE=http://host.docker.internal:${upstream.address().port}`, imageId);
    containers.add(name);
    const base = `http://127.0.0.1:${docker('port', name, '8080/tcp').split(':').at(-1)}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await send(base, '/').result).status === 200; } catch { await sleep(100); }
    }
    assert.ok(ready, 'native server ready');
    const cases = [{ path: `/api/marketplace/${id}` }, ...['en-US', 'fr-FR', 'de-DE'].flatMap(locale =>
      [false, true].map(post => ({ path: `/marketplace/${locale}/${id}`, post })))];
    for (const { path, post } of cases) {
      let start = events.length;
      const response = await read(base, path, { parent: a, state: states[0], post });
      if (mode === 'before' && source === 'api') {
        assert.equal(events.length, start + 1);
        assert.deepEqual([events[start].traceparent, events[start].tracestate], [null, null]); missing++;
      } else verify(start, [[a, states[0]]]);
      if (post) {
        start = events.length;
        const cookie = response.headers['set-cookie']?.map(value => value.split(';', 1)[0]).join('; ');
        assert.ok(cookie);
        const result = await read(base, '/api/alerts', { parent: b, cookie });
        assert.deepEqual(JSON.parse(result.text), [{ item_id: id, email: 'trace@example.test', target_minor: 1250 }]);
        assert.equal(events.length, start, 'alert readback does not fetch');
      }
      if (mode === 'before') continue;
      for (const stage of source === 'api' ? ['headers', 'body'] : ['fixture']) {
        start = events.length;
        hold = source === 'api' ? { stage } : undefined;
        const old = send(base, path, { parent: a, state: states[0], post });
        try {
          if (hold) await wait(() => hold.release);
          await read(base, path, { parent: b, state: states[1], post });
          await read(base, path, { state: 'orphan=must-not-forward', post });
          if (hold) { assert.equal(old.finished(), false); hold.release(); }
          assert.equal((await old.result).status, 200);
          verify(start, [[a, states[0]], [b, states[1]], [null, null]]);
        } finally { hold?.release?.(); hold = undefined; old.abort(); }
      }
      for (const [parent, state, expected] of [
        [undefined, states[0], [null, null]], ['bad', states[0], [null, null]],
        [a.toUpperCase(), states[0], [null, null]], [`ff${a.slice(2)}`, states[0], [null, null]],
        [a.replace('a'.repeat(32), '0'.repeat(32)), states[0], [null, null]],
        [a.replace('a'.repeat(16) + '-00', '0'.repeat(16) + '-00'), states[0], [null, null]],
        [`${a}-extra`, states[0], [null, null]], [`${a}, ${b}`, states[0], [null, null]],
        // Drogon's native parser exposes the first repeated field, not the raw duplicates.
        [[a, b], states[0], [a, states[0]]],
        ['\xe9', states[0], [null, null]], [`01${a.slice(2)}-future`, states[0], [a, states[0]]],
        [a, 'vendor=\xe9\xff', [a, 'vendor=\xe9\xff']], [a, undefined, [a, null]],
      ]) {
        start = events.length; await read(base, path, { parent, state, post });
        await read(base, path, { post }); verify(start, [expected, [null, null]]);
      }
      if (post) {
        start = events.length;
        const old = send(base, path, { parent: a, state: states[0], post, deferred: true });
        try {
          await sleep(100); assert.equal(events.length, start, 'incomplete body did not start source read');
          await read(base, path, { parent: b, state: states[1] }); await read(base, path);
          old.finish(); assert.equal((await old.result).status, 200);
          verify(start, [[b, states[1]], [null, null], [a, states[0]]]);
        } finally { old.abort(); }
      }
    }
    if (mode === 'after') {
      const start = events.length;
      await read(base, `/api/marketplace/${id}`, { head: true, parent: b, state: states[1] });
      await read(base, `/api/marketplace/${id}`, { head: true });
      verify(start, [[b, states[1]], [null, null]]);
    }
    console.log(`PASS ${mode} ${profile}/${source}: native JSON, pages/forms in three locales, readback${mode === 'after' ? ', HEAD, delayed and untraced isolation' : ''}`);
    docker('rm', '-f', '-v', name); containers.delete(name);
  }
  if (mode === 'before') { assert.equal(missing, 14); console.log(`REPRODUCED: ${missing} API source reads lost incoming traceparent and tracestate`); }
} finally {
  hold?.release?.();
  for (const name of containers) docker('rm', '-f', '-v', name);
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  rmSync(temp, { recursive: true, force: true });
  console.log(`Raw observations: ${raw.pathname}`);
}
