import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { diagnosticLimits, hydrationArtifactPath, observeHydration } from './hydration-diagnostics.mjs';

class FakePage extends EventEmitter {
  calls = [];
  hydrated;
  error = new Error('page.waitForFunction: Timeout 30000ms exceeded.');
  snapshot = { readyState: 'complete', hydratedType: 'undefined', hydratedAt: null, marketplace: true,
    scripts: [{ src: 'http://user:password@private.invalid/pkg/item_page.js?token=hidden', type: 'module' }],
    resources: [{ name: 'http://private.invalid/pkg/item_page.wasm?token=hidden', initiatorType: 'fetch', duration: 5, transferSize: 123 }] };
  async waitForFunction(...args) {
    this.calls.push(args);
    assert.equal(args.length, 1, 'keep Playwright\'s existing default 30s gate, with no override');
    const ready = runInNewContext(`(${args[0]})()`, { window: { __hydratedAt: this.hydrated } });
    if (!ready) throw this.error;
  }
  async evaluate(fn) { this.calls.push(['snapshot', fn]); return this.snapshot; }
  mainFrame() { return this; }
}

function response(page, url, status, navigation = false) {
  return { url: () => url, status: () => status, frame: () => page,
    request: () => ({ isNavigationRequest: () => navigation }) };
}
function observer(page, overrides = {}) {
  const saved = [], summaries = [];
  const diagnostics = observeHydration(page, { app: 'leptos', source: 'fixture', profile: 'defaults',
    container: 'compiled-alerts-leptos-fixture-123', artifactPath: 'ignored.json',
    write: async (_path, text) => saved.push(text), log: summary => summaries.push(summary), ...overrides });
  return { diagnostics, saved, summaries };
}

test('numeric hydration passes unchanged without snapshot, artifact or navigation', async () => {
  for (const mark of [0, 123.5, NaN]) {
    const page = new FakePage(); page.hydrated = mark;
    const { diagnostics, saved, summaries } = observer(page);
    await diagnostics.wait();
    assert.equal(page.calls.length, 1);
    assert.deepEqual(saved, []); assert.deepEqual(summaries, []);
    diagnostics.dispose();
    assert.deepEqual(page.eventNames(), []);
  }
});

test('undefined, null and nonnumeric hydration marks remain readiness failures', async () => {
  for (const mark of [undefined, null, '123', true, {}]) {
    const page = new FakePage(); page.hydrated = mark;
    const { diagnostics, saved } = observer(page);
    await assert.rejects(diagnostics.wait(), error => error === page.error);
    assert.equal(saved.length, 1);
  }
});

test('readiness negative preserves the identical original error and captures the failing instance only', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hydration-diagnostics-'));
  try {
    const artifactPath = join(folder, 'failure.json');
    const page = new FakePage();
    const { diagnostics, summaries } = observer(page, { artifactPath, write: undefined });
    page.emit('response', response(page, 'http://private.invalid/marketplace/en-US/item_1?secret=x', 200, true));
    page.emit('response', response(page, 'http://user:password@private.invalid/pkg/item_page.js?token=x', 200));
    page.emit('response', response(page, 'http://private.invalid/pkg/item_page.wasm#secret', 404));
    page.emit('pageerror', new Error('panicked at src/marketplace_page.rs:42:7:\nhydration mismatch: expected an element'));
    page.emit('requestfailed', { url: () => 'https://user:password@private.invalid/pkg/chunk.js?secret=x',
      failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
    await assert.rejects(diagnostics.wait(), error => error === page.error);
    const raw = await readFile(artifactPath, 'utf8'), detail = JSON.parse(raw);
    assert.equal(detail.container, 'compiled-alerts-leptos-fixture-123');
    assert.deepEqual(detail.navigation, { status: 200, path: '/marketplace/en-US/item_1' });
    assert.ok(detail.events.some(event => event.kind === 'response' && event.path === '/pkg/item_page.wasm' && event.status === 404));
    assert.ok(detail.events.some(event => event.kind === 'pageerror' && event.text.includes('src/marketplace_page.rs:42:7')));
    assert.equal(detail.state.hydratedType, 'undefined');
    assert.equal(detail.state.scripts[0].path, '/pkg/item_page.js');
    assert.equal(detail.state.resources[0].path, '/pkg/item_page.wasm');
    assert.doesNotMatch(raw, /private\.invalid|password|token=|secret|https?:|user:/);
    assert.equal(summaries.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(summaries[0])) < 512);
    assert.equal(page.calls.filter(call => call[0] === 'snapshot').length, 1);
    assert.equal(page.calls.length, 2, 'no second navigation, retry or readiness wait');
    assert.deepEqual(page.eventNames(), []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('events, diagnostic text, resource lists and artifact bytes are capped and sanitized', async () => {
  const page = new FakePage();
  const { diagnostics, saved } = observer(page);
  const secrets = [
    'Cookie: marketplace_session=short-secret', 'Authorization: Bearer short-secret',
    'password=short-secret', 'API_KEY: short-secret', 'TOKEN=short-secret',
    'Origin: https://short-secret.invalid', 'process.env={PRIVATE:short-secret}',
    'fetch https://user:short-secret@private.invalid/pkg/app.js?query=short-secret#short-secret',
    'fetch /pkg/app.js?query=short-secret', 'email person@example.test',
    'value "short-secret"', 'value abcdef0123456789abcdef0123456789',
    'process.env={\nPRIVATE:short-secret\n}', 'Cookie:\nshort-secret',
  ];
  for (const text of secrets) page.emit('console', { type: () => 'error', text: () => text });
  for (let i = 0; i < 200; i++) page.emit('pageerror', new Error('panic hydration mismatch ' + '\u2603'.repeat(5000)));
  page.snapshot.scripts = Array(100).fill({ src: 'https://private.invalid/pkg/app.js?secret=x', type: 'module', rawHTML: 'short-secret' });
  page.snapshot.resources = Array(100).fill({ name: 'https://private.invalid/pkg/app.wasm?secret=x', initiatorType: 'fetch', duration: 1, transferSize: 10, headers: 'short-secret' });
  page.snapshot.cookies = 'short-secret';
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  const raw = saved[0], detail = JSON.parse(raw);
  assert.ok(Buffer.byteLength(raw) <= diagnosticLimits.artifactBytes);
  assert.ok(detail.events.length <= diagnosticLimits.events);
  assert.ok(Buffer.byteLength(JSON.stringify(detail.events)) <= diagnosticLimits.eventBytes);
  for (const event of detail.events) if (event.text) assert.ok(Buffer.byteLength(event.text) <= diagnosticLimits.textBytes);
  assert.ok(detail.dropped > 0);
  assert.ok(detail.state.scripts.length <= diagnosticLimits.resources);
  assert.ok(detail.state.resources.length <= diagnosticLimits.resources);
  assert.doesNotMatch(raw, /short-secret|private\.invalid|person@|query=|secret=|https?:|abcdef0123456789/);
  assert.equal(detail.state.cookies, undefined);
});

test('snapshot failure, stuck evaluation, artifact failure and logging failure never mask readiness failure', { timeout: 6000 }, async () => {
  for (const mode of ['reject', 'hang', 'write', 'write-hang', 'log']) {
    const page = new FakePage();
    if (mode === 'reject') page.evaluate = async () => { throw new Error('sensitive snapshot error'); };
    if (mode === 'hang') page.evaluate = () => new Promise(() => {});
    const { diagnostics, saved } = observer(page, {
      ...(mode === 'write' ? { write: async () => { throw new Error('private filesystem path'); } } : {}),
      ...(mode === 'write-hang' ? { write: () => new Promise(() => {}) } : {}),
      ...(mode === 'log' ? { log: () => { throw new Error('private logging failure'); } } : {}),
    });
    await assert.rejects(diagnostics.wait(), error => error === page.error);
    if (mode === 'reject' || mode === 'hang') assert.deepEqual(JSON.parse(saved[0]).state, { unavailable: true });
    assert.deepEqual(page.eventNames(), []);
  }
});

test('actual snapshot function reads only bounded structural state, never HTML or credentials', async () => {
  const page = new FakePage();
  const document = { readyState: 'complete', querySelector: selector => {
    assert.equal(selector, '.marketplace__alert form'); return {};
  }, scripts: Array(100).fill({ src: 'http://private.invalid/pkg/app.js?value=hidden', type: 'module' }) };
  for (const forbidden of ['cookie', 'body', 'documentElement', 'location']) Object.defineProperty(document, forbidden, {
    get: () => { assert.fail(`must not read document.${forbidden}`); },
  });
  page.evaluate = async fn => runInNewContext(`(${fn})()`, { document, window: {}, performance: {
    getEntriesByType: type => {
      assert.equal(type, 'resource');
      return Array(100).fill({ name: 'http://private.invalid/pkg/app.wasm?value=hidden', initiatorType: 'fetch', duration: 10, transferSize: 50 });
    },
  } });
  const { diagnostics, saved } = observer(page);
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  const state = JSON.parse(saved[0]).state;
  assert.equal(state.readyState, 'complete');
  assert.equal(state.scripts.length, diagnosticLimits.resources);
  assert.equal(state.resources.length, diagnosticLimits.resources);
  assert.doesNotMatch(saved[0], /private\.invalid|hidden/);
});

test('default diagnostic log is only a small JSON summary, never panic or asset text', async t => {
  const calls = [];
  t.mock.method(console, 'error', text => calls.push(text));
  const page = new FakePage();
  const { diagnostics, saved } = observer(page, { log: undefined });
  page.emit('pageerror', new Error('panicked at src/app.rs:7:1: unexpected token'));
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0], 'string');
  assert.ok(Buffer.byteLength(calls[0]) < 512);
  assert.equal(JSON.parse(calls[0]).saved, true);
  assert.doesNotMatch(calls[0], /panicked|src\/app.rs/);
  assert.match(saved[0], /src\/app.rs:7:1: unexpected token/);
});

test('broken event removal cannot mask the original hydration exception', async () => {
  const page = new FakePage();
  const { diagnostics } = observer(page);
  page.off = () => { throw new Error('broken page'); };
  await assert.rejects(diagnostics.wait(), error => error === page.error);
});

test('new navigation clears old events, and throwing event accessors are contained', async () => {
  const page = new FakePage();
  const { diagnostics, saved } = observer(page);
  page.emit('console', { type: () => 'error', text: () => 'old navigation' });
  diagnostics.reset();
  page.emit('console', { text: () => { throw new Error('broken event'); } });
  page.emit('pageerror', new Error('new navigation panic'));
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  assert.doesNotMatch(saved[0], /old navigation/);
  assert.match(saved[0], /new navigation panic/);
});

test('artifact destination is already collected by the catalog parity workflow', async () => {
  const path = hydrationArtifactPath('leptos', 'fixture', 'defaults');
  assert.match(path.replaceAll('\\', '/'), /\/bench\/catalog\/results\/c1\/compiled-alerts-leptos-fixture-defaults-\d+-hydration\.json$/);
  const workflow = await readFile(new URL('../../../../.github/workflows/catalog.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: always\(\)[\s\S]*bench\/catalog\/results\/c1\//);
  assert.match(workflow, /node --test bench\/fullstack\/apps\/gin\/compiled-check\.test\.mjs/);
  const entry = await readFile(new URL('./compiled-check.test.mjs', import.meta.url), 'utf8');
  assert.match(entry, /import '\.\/hydration-diagnostics\.test\.mjs'/);
});

test('checker observes before the original navigations and keeps both hydration gates', async () => {
  const source = await readFile(new URL('./check-alerts.mjs', import.meta.url), 'utf8');
  const attachment = source.indexOf('observeHydration(page,');
  assert.ok(attachment > 0 && attachment < source.indexOf('await page.goto(pageURL)'));
  assert.equal(source.match(/await page\.goto\(pageURL\)/g)?.length, 2);
  assert.equal(source.match(/if \(javaScriptEnabled\) await hydration\.wait\(\)/g)?.length, 2);
  assert.ok(source.includes('hydration?.reset();\n        await page.goto(pageURL)'));
});
