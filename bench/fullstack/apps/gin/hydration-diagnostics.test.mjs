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
  snapshot = { readyState: 'complete', hydratedType: 'undefined', hydratedAt: null, marketplace: true, scriptCount: 1, resourceCount: 1,
    scripts: [{ resourceKind: 'js', type: 'module', external: true }],
    resources: [{ resourceKind: 'wasm', initiatorType: 'fetch', duration: 5, transferSize: 123 }] };
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

for (const [kind, canary] of [['console', 'html-canary'], ['pageerror', 'error-canary'], ['response', 'short-canary']]) {
  test(`review regression: ${kind} must not retain private HTML or short path content`, async () => {
    const page = new FakePage();
    const { diagnostics, saved, summaries } = observer(page);
    if (kind === 'console') page.emit('console', { type: () => 'error', text: () => '<div>html-canary</div>' });
    if (kind === 'pageerror') page.emit('pageerror', { stack: 'hydration mismatch: expected <div>error-canary</div>' });
    if (kind === 'response') page.emit('response', response(page, 'https://fixture.invalid/pkg/short-canary/app.js', 200));
    await assert.rejects(diagnostics.wait(), error => error === page.error);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].includes(canary), false, 'browser payload must not be retained');
    assert.equal(JSON.stringify(summaries).includes(canary), false);
  });
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
    assert.deepEqual(detail.navigation, { status: 200 });
    assert.ok(detail.events.some(event => event.kind === 'response' && event.resourceKind === 'wasm' && event.status === 404));
    assert.ok(detail.events.some(event => event.kind === 'pageerror' && event.errorClass === 'Error'));
    assert.equal(detail.state.hydratedType, 'undefined');
    assert.equal(detail.state.scripts[0].resourceKind, 'js');
    assert.equal(detail.state.resources[0].resourceKind, 'wasm');
    assert.doesNotMatch(raw, /private\.invalid|password|token=|secret|https?:|user:|src\/marketplace_page.rs/);
    assert.equal(summaries.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(summaries[0])) < 512);
    assert.equal(page.calls.filter(call => call[0] === 'snapshot').length, 1);
    assert.equal(page.calls.length, 2, 'no second navigation, retry or readiness wait');
    assert.deepEqual(page.eventNames(), []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('event counts, resource lists and artifact bytes stay bounded without browser payloads', async () => {
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
    'pass\u001b[31mword=short-secret', 'AWS_ACCESS_KEY_ID=AKIA1234567890123456',
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
  for (const event of detail.events) { assert.equal(event.text, undefined); assert.equal(event.path, undefined); }
  assert.ok(detail.dropped > 0);
  assert.ok(detail.state.scripts.length <= diagnosticLimits.resources);
  assert.ok(detail.state.resources.length <= diagnosticLimits.resources);
  assert.doesNotMatch(raw, /short-secret|AKIA1234567890123456|private\.invalid|person@|query=|secret=|https?:|abcdef0123456789/);
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
  page.evaluate = async fn => runInNewContext(`(${fn})()`, { document, window: {}, URL, performance: {
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
  assert.equal(state.scriptCount, 100);
  assert.equal(state.resourceCount, 100);
  assert.equal(state.scripts[0].resourceKind, 'js');
  assert.equal(state.resources[0].resourceKind, 'wasm');
  assert.doesNotMatch(saved[0], /private\.invalid|hidden/);
});

test('browser snapshot projects categories and numbers before crossing the page boundary', async () => {
  const page = new FakePage();
  let snapshot;
  page.evaluate = async fn => {
    snapshot = runInNewContext(`(${fn})()`, { URL, window: { __hydratedAt: '<div>snapshot-canary</div>' },
      document: { readyState: 'snapshot-canary', querySelector: () => null,
        scripts: [{ src: 'https://fixture.invalid/pkg/short-canary/app.js', type: '<div>snapshot-canary</div>' }] },
      performance: { getEntriesByType: () => [{ name: 'https://fixture.invalid/pkg/short-canary/app.wasm',
        initiatorType: 'snapshot-canary', duration: '<div>snapshot-canary</div>', transferSize: Infinity }] },
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /canary|https?:|\.invalid|<div>/);
    return snapshot;
  };
  const { diagnostics, saved } = observer(page);
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { readyState: 'unknown', hydratedType: 'string', hydratedAt: null,
    marketplace: false, scriptCount: 1, resourceCount: 1,
    scripts: [{ resourceKind: 'js', type: 'other', external: true }],
    resources: [{ resourceKind: 'wasm', initiatorType: 'other', duration: null, transferSize: null }] });
  assert.deepEqual(JSON.parse(saved[0]).state, JSON.parse(JSON.stringify(snapshot)));
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
  assert.doesNotMatch(saved[0], /panicked|src\/app.rs|unexpected token/);
  assert.equal(JSON.parse(saved[0]).events[0].errorClass, 'Error');
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
  assert.doesNotMatch(saved[0], /new navigation panic/);
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.navigationIndex, 2);
  assert.equal(detail.dropped, 1);
  assert.deepEqual(detail.events, [{ sequence: 1, kind: 'pageerror', errorClass: 'Error' }]);
});

test('iframe navigation cannot overwrite the failing main-frame status after reset', async () => {
  const page = new FakePage();
  const { diagnostics, saved } = observer(page);
  page.emit('response', response(page, 'https://fixture.invalid/old-canary', 301, true));
  diagnostics.reset();
  page.emit('response', response(page, 'https://fixture.invalid/short-canary', 200, true));
  page.emit('response', { ...response(page, 'https://fixture.invalid/frame-canary', 503, true), frame: () => ({}) });
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.navigationIndex, 2);
  assert.deepEqual(detail.navigation, { status: 200 });
  assert.deepEqual(detail.events, []);
  assert.doesNotMatch(saved[0], /canary/);
});

test('closed diagnostic schema discards all unknown fields and variable browser strings', async () => {
  const page = new FakePage();
  page.error = { name: 'TimeoutError', message: '<div>original-canary</div>', stack: 'original-canary' };
  page.snapshot = { readyState: '<div>state-canary</div>', hydratedType: 'state-canary', hydratedAt: 'state-canary', marketplace: 'state-canary',
    scriptCount: 'state-canary', resourceCount: Infinity, HTML: '<div>state-canary</div>',
    scripts: [{ resourceKind: 'state-canary', type: 'state-canary', external: 'state-canary', src: 'https://fixture.invalid/pkg/short-canary/app.js' }],
    resources: [{ resourceKind: 'state-canary', initiatorType: 'state-canary', duration: 'state-canary', transferSize: NaN, name: 'https://fixture.invalid/pkg/short-canary/app.wasm' }] };
  const { diagnostics, saved, summaries } = observer(page);
  page.emit('response', response(page, 'https://fixture.invalid/short-canary', 200, true));
  page.emit('console', { type: () => '<div>console-canary</div>', text: () => 'console-canary' });
  page.emit('pageerror', { name: '<div>error-canary</div>', message: 'error-canary', stack: 'error-canary' });
  page.emit('requestfailed', { url: () => 'https://fixture.invalid/pkg/short-canary/app.js', failure: () => ({ errorText: 'failure-canary' }) });
  page.emit('response', response(page, 'https://fixture.invalid/pkg/short-canary/app.wasm', 503));
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  const detail = JSON.parse(saved[0]);
  const keys = (object, expected) => assert.deepEqual(Object.keys(object).sort(), expected.sort());
  keys(detail, ['schema', 'app', 'source', 'profile', 'container', 'navigationIndex', 'navigation', 'errorClass', 'state', 'events', 'dropped']);
  keys(detail.navigation, ['status']);
  keys(detail.state, ['readyState', 'hydratedType', 'hydratedAt', 'marketplace', 'scriptCount', 'resourceCount', 'scripts', 'resources']);
  keys(detail.state.scripts[0], ['resourceKind', 'type', 'external']);
  keys(detail.state.resources[0], ['resourceKind', 'initiatorType', 'duration', 'transferSize']);
  keys(detail.events[0], ['sequence', 'kind', 'level']);
  keys(detail.events[1], ['sequence', 'kind', 'errorClass']);
  keys(detail.events[2], ['sequence', 'kind', 'resourceKind']);
  keys(detail.events[3], ['sequence', 'kind', 'resourceKind', 'status']);
  keys(summaries[0], ['diagnostic', 'app', 'source', 'profile', 'navigationIndex', 'saved', 'events', 'dropped', 'bytes']);
  assert.equal(detail.schema, 'compiled-alerts-hydration/v2');
  assert.equal(detail.errorClass, 'TimeoutError');
  assert.deepEqual(detail.events, [
    { sequence: 1, kind: 'console', level: 'other' }, { sequence: 2, kind: 'pageerror', errorClass: 'unknown' },
    { sequence: 3, kind: 'requestfailed', resourceKind: 'js' }, { sequence: 4, kind: 'response', resourceKind: 'wasm', status: 503 },
  ]);
  assert.deepEqual(detail.state, { readyState: 'unknown', hydratedType: 'unknown', hydratedAt: null, marketplace: false, scriptCount: null, resourceCount: null,
    scripts: [{ resourceKind: 'other', type: 'other', external: false }],
    resources: [{ resourceKind: 'other', initiatorType: 'other', duration: null, transferSize: null }] });
  assert.doesNotMatch(saved[0] + JSON.stringify(summaries), /canary|\.invalid|https?:|<div>/);
});

test('diagnostics never read console text, error message/stack or request failure payloads', async () => {
  const page = new FakePage();
  const forbidden = () => { assert.fail('arbitrary diagnostic payload was read'); };
  const original = { name: 'TimeoutError' }, pageError = { name: 'RuntimeError' };
  for (const error of [original, pageError]) for (const key of ['message', 'stack', 'cause']) Object.defineProperty(error, key, { get: forbidden });
  page.error = original;
  const { diagnostics, saved } = observer(page);
  page.emit('console', { type: () => 'error', text: forbidden, args: forbidden, location: forbidden });
  page.emit('pageerror', pageError);
  page.emit('requestfailed', { url: () => 'https://fixture.invalid/pkg/short-canary/app.wasm', failure: forbidden });
  await assert.rejects(diagnostics.wait(), error => error === original);
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.dropped, 0, 'forbidden getters must not merely be swallowed');
  assert.equal(detail.errorClass, 'TimeoutError');
  assert.deepEqual(detail.events, [{ sequence: 1, kind: 'console', level: 'error' },
    { sequence: 2, kind: 'pageerror', errorClass: 'RuntimeError' }, { sequence: 3, kind: 'requestfailed', resourceKind: 'wasm' }]);
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
