import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { containerTimeline, diagnosticLimits, failureCode, failureCodes, hydrationArtifactPath, observeHydration,
  projectDockerEvents } from './hydration-diagnostics.mjs';

class FakePage extends EventEmitter {
  calls = [];
  hydrated;
  error = new Error('page.waitForFunction: Timeout 30000ms exceeded.');
  snapshot = { readyState: 'complete', hydratedType: 'undefined', hydratedAt: null, marketplace: true, scriptCount: 1, resourceCount: 1,
    scripts: [{ resourceKind: 'js', type: 'module', external: true }],
    resources: [{ resourceKind: 'wasm', initiatorType: 'fetch', duration: 5, transferSize: 123 }] };
  async waitForFunction(...args) {
    this.calls.push(args);
    this.duringWait?.();
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
    container: 'compiled-alerts-leptos-fixture-123', artifactPath: 'ignored.json', now: () => 0, wall: () => 1_700_000_000_000,
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
  keys(detail, ['schema', 'app', 'source', 'profile', 'container', 'navigationIndex', 'stage', 'failure', 'navigation', 'errorClass', 'state',
    'events', 'dropped', 'containers', 'docker']);
  keys(detail.navigation, ['status']);
  keys(detail.state, ['readyState', 'hydratedType', 'hydratedAt', 'marketplace', 'scriptCount', 'resourceCount', 'scripts', 'resources']);
  keys(detail.state.scripts[0], ['resourceKind', 'type', 'external']);
  keys(detail.state.resources[0], ['resourceKind', 'initiatorType', 'duration', 'transferSize']);
  keys(detail.events[0], ['sequence', 'kind', 'level']);
  keys(detail.events[1], ['sequence', 'kind', 'errorClass']);
  keys(detail.events[2], ['sequence', 'kind', 'resourceKind', 'resourceType', 'failure', 'stage', 'ms']);
  keys(detail.events[3], ['sequence', 'kind', 'resourceKind', 'status']);
  keys(summaries[0], ['diagnostic', 'app', 'source', 'profile', 'navigationIndex', 'stage', 'failure', 'saved', 'events', 'dropped', 'bytes']);
  assert.equal(detail.schema, 'compiled-alerts-hydration/v3');
  assert.equal(detail.stage, 'readiness');
  assert.equal(detail.failure, null, 'a readiness timeout has no net error code');
  assert.deepEqual(detail.containers, []);
  assert.deepEqual(detail.docker, { unavailable: true });
  assert.equal(detail.errorClass, 'TimeoutError');
  assert.deepEqual(detail.events, [
    { sequence: 1, kind: 'console', level: 'other' }, { sequence: 2, kind: 'pageerror', errorClass: 'unknown' },
    { sequence: 3, kind: 'requestfailed', resourceKind: 'js', resourceType: 'other', failure: 'other', stage: 'idle', ms: 0 },
    { sequence: 4, kind: 'response', resourceKind: 'wasm', status: 503 },
  ]);
  assert.deepEqual(detail.state, { readyState: 'unknown', hydratedType: 'unknown', hydratedAt: null, marketplace: false, scriptCount: null, resourceCount: null,
    scripts: [{ resourceKind: 'other', type: 'other', external: false }],
    resources: [{ resourceKind: 'other', initiatorType: 'other', duration: null, transferSize: null }] });
  assert.doesNotMatch(saved[0] + JSON.stringify(summaries), /canary|\.invalid|https?:|<div>/);
});

test('diagnostics never read console text or a readiness error\'s message/stack, and reduce request failures to a code', async () => {
  const page = new FakePage();
  const forbidden = () => { assert.fail('arbitrary diagnostic payload was read'); };
  const original = { name: 'TimeoutError' }, pageError = { name: 'RuntimeError' };
  for (const error of [original, pageError]) for (const key of ['message', 'stack', 'cause']) Object.defineProperty(error, key, { get: forbidden });
  page.error = original;
  const { diagnostics, saved } = observer(page);
  page.emit('console', { type: () => 'error', text: forbidden, args: forbidden, location: forbidden });
  page.emit('pageerror', pageError);
  page.emit('requestfailed', { url: () => 'https://fixture.invalid/pkg/short-canary/app.wasm', resourceType: () => 'fetch',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET at https://fixture.invalid/short-canary' }) });
  await assert.rejects(diagnostics.wait(), error => error === original);
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.dropped, 0, 'forbidden getters must not merely be swallowed');
  assert.equal(detail.errorClass, 'TimeoutError');
  assert.deepEqual(detail.events, [{ sequence: 1, kind: 'console', level: 'error' },
    { sequence: 2, kind: 'pageerror', errorClass: 'RuntimeError' },
    { sequence: 3, kind: 'requestfailed', resourceKind: 'wasm', resourceType: 'fetch', failure: 'ERR_CONNECTION_RESET', stage: 'idle', ms: 0 }]);
  assert.doesNotMatch(saved[0], /canary|\.invalid/);
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
  const navigate = 'if (javaScriptEnabled) await hydration.goto(() => page.goto(pageURL)); else await page.goto(pageURL);';
  assert.ok(attachment > 0 && attachment < source.indexOf(navigate));
  assert.equal(source.split(navigate).length - 1, 2, 'both navigations are observed only when JavaScript is enabled');
  assert.equal(source.match(/page\.goto\(/g)?.length, 4, 'the same goto, with no retry or added options');
  assert.equal(source.match(/if \(javaScriptEnabled\) await hydration\.wait\(\)/g)?.length, 2);
  assert.ok(source.includes('hydration?.reset();\n        ' + navigate));
  assert.match(source, /timeline, dockerEvents: readDockerEvents,/);
  assert.match(source, /const docker = \(\.\.\.args\) => timeline\.record\(args, \(\) => \{/);
});

const gotoMessage = 'page.goto: net::ERR_NETWORK_CHANGED at http://127.0.0.1:32774/marketplace/en-US/item_1\n'
  + 'Call log:\n  - navigating to "http://127.0.0.1:32774/marketplace/en-US/item_1", waiting until "load"\n';

test('a failing goto writes the artifact and rethrows the identical error (#1963)', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hydration-diagnostics-'));
  try {
    const artifactPath = join(folder, 'goto.json');
    const page = new FakePage();
    const { diagnostics, summaries } = observer(page, { artifactPath, write: undefined });
    const original = new Error(gotoMessage);
    let navigations = 0;
    await assert.rejects(diagnostics.goto(async () => {
      navigations++;
      page.emit('requestfailed', { url: () => 'http://127.0.0.1:32774/marketplace/en-US/item_1', resourceType: () => 'document',
        failure: () => ({ errorText: 'net::ERR_NETWORK_CHANGED' }) });
      throw original;
    }), error => error === original);
    assert.equal(navigations, 1, 'no retry');
    assert.equal(original.message, gotoMessage, 'the original error is not rewritten');
    const raw = await readFile(artifactPath, 'utf8'), detail = JSON.parse(raw);
    assert.equal(detail.stage, 'goto');
    assert.equal(detail.failure, 'ERR_NETWORK_CHANGED');
    assert.equal(detail.errorClass, 'Error');
    assert.equal(detail.navigation, null, 'no main-frame response was observed');
    assert.deepEqual(detail.events, [{ sequence: 1, kind: 'requestfailed', resourceKind: 'other', resourceType: 'document',
      failure: 'ERR_NETWORK_CHANGED', stage: 'goto', ms: 0 }]);
    assert.doesNotMatch(raw, /127\.0\.0\.1|32774|marketplace\/|item_1|navigating|https?:/);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].stage, 'goto');
    assert.equal(summaries[0].failure, 'ERR_NETWORK_CHANGED');
    assert.doesNotMatch(JSON.stringify(summaries), /127\.0\.0\.1|item_1/);
    assert.equal(page.calls.filter(call => call[0] !== 'snapshot').length, 0, 'no readiness wait after a failed goto');
    assert.deepEqual(page.eventNames(), []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a goto error outside the allowlist, or without a net code, is recorded as other', async () => {
  for (const message of ['page.goto: net::ERR_SOMETHING_NEW at http://private.invalid/x', 'Navigation failed because page was closed!',
    'page.goto: Timeout 30000ms exceeded.']) {
    const page = new FakePage();
    const { diagnostics, saved } = observer(page);
    const original = new Error(message);
    await assert.rejects(diagnostics.goto(async () => { throw original; }), error => error === original);
    const detail = JSON.parse(saved[0]);
    assert.equal(detail.failure, 'other');
    assert.doesNotMatch(saved[0], /SOMETHING_NEW|private\.invalid|closed|Timeout/);
  }
  const page = new FakePage();
  const { diagnostics, saved } = observer(page);
  const original = { name: 'Error' };
  Object.defineProperty(original, 'message', { get: () => { throw new Error('broken message'); } });
  await assert.rejects(diagnostics.goto(async () => { throw original; }), error => error === original);
  assert.equal(JSON.parse(saved[0]).failure, 'other');
});

test('a successful goto returns the navigation result and writes nothing', async () => {
  const page = new FakePage(); page.hydrated = 1;
  const { diagnostics, saved, summaries } = observer(page);
  const result = { status: () => 200 };
  assert.equal(await diagnostics.goto(async () => result), result);
  await diagnostics.wait();
  assert.deepEqual(saved, []); assert.deepEqual(summaries, []);
});

test('request failures are stamped with the stage they happened in (#1496, #1906)', async () => {
  let clock = 1000;
  const page = new FakePage();
  const { diagnostics, saved } = observer(page, { now: () => clock });
  const script = errorText => ({ url: () => 'http://private.invalid/static/item.js?x=1', resourceType: () => 'script',
    failure: () => ({ errorText }) });
  await diagnostics.goto(async () => { clock = 1040; page.emit('requestfailed', script('net::ERR_NETWORK_CHANGED')); });
  page.duringWait = () => { clock = 1300; page.emit('requestfailed', script('net::ERR_ABORTED')); };
  await assert.rejects(diagnostics.wait(), error => error === page.error);
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.stage, 'readiness');
  assert.deepEqual(detail.events, [
    { sequence: 1, kind: 'requestfailed', resourceKind: 'js', resourceType: 'script', failure: 'ERR_NETWORK_CHANGED', stage: 'goto', ms: 40 },
    { sequence: 2, kind: 'requestfailed', resourceKind: 'js', resourceType: 'script', failure: 'ERR_ABORTED', stage: 'readiness', ms: 300 },
  ]);
  assert.doesNotMatch(saved[0], /private\.invalid|static|x=1/);
});

test('failureCode keeps only allowlisted Chromium net codes', () => {
  assert.equal(failureCode('net::ERR_NETWORK_CHANGED'), 'ERR_NETWORK_CHANGED');
  assert.equal(failureCode(gotoMessage), 'ERR_NETWORK_CHANGED');
  for (const code of failureCodes) assert.equal(failureCode(`net::${code}`), code);
  for (const text of ['net::ERR_SOMETHING_NEW', 'ERR_ABORTED', 'net::err_aborted', 'failure-canary', '', 'x'.repeat(600) + 'net::ERR_ABORTED'])
    assert.equal(failureCode(text), 'other', text.slice(0, 40));
  for (const value of [undefined, null, 1, {}, ['net::ERR_ABORTED']]) assert.equal(failureCode(value), 'other');
});

test('the container timeline records only the check\'s own runs and removals, bounded', () => {
  let clock = 0;
  const timeline = containerTimeline(() => clock);
  const id = 'a'.repeat(64);
  assert.equal(timeline.record(['run', '-d', 'image'], () => { clock = 700; return id; }), id);
  assert.equal(timeline.record(['inspect', 'name'], () => '[]'), '[]');
  const failure = new Error('rm failed');
  assert.throws(() => timeline.record(['rm', '-f', '-v', 'name'], () => { clock = 900; throw failure; }), error => error === failure);
  assert.deepEqual(timeline.entries, [{ op: 'run', start: 0, end: 700, ok: true, id }, { op: 'rm', start: 700, end: 900, ok: false }]);
  for (let i = 0; i < 40; i++) timeline.record(['rm', String(i)], () => '');
  assert.equal(timeline.entries.length, diagnosticLimits.containers);
});

test('docker events keep only type, allowlisted action, time and ownership', () => {
  const own = 'b'.repeat(64), foreign = 'c'.repeat(64), origin = 1_700_000_000_000;
  // The shape readDockerEvents' --format writes: type, action, actor ID, a network event's container, time.
  const line = (type, action, id, ms, container = '') => JSON.stringify([type, action, id, container, (origin + ms) * 1e6]);
  const text = [
    line('container', 'start', own, -2500),
    line('network', 'connect', 'secret-network', -2499, own),
    line('container', 'exec_start: sh -c echo secret-command', foreign, -100),
    line('network', 'disconnect', 'secret-network', 150, foreign),
    line('image', 'pull', 'secret-image', 10),
    '{ not json', JSON.stringify({ Type: 'container', Action: 'start', secret: 'secret-object' }), '',
  ].join('\n');
  const projected = projectDockerEvents(text, origin, new Set([own]));
  assert.deepEqual(projected, { dropped: 2, events: [
    { type: 'container', action: 'start', ms: -2500, own: true },
    { type: 'network', action: 'connect', ms: -2499, own: true },
    { type: 'container', action: 'other', ms: -100, own: false },
    { type: 'network', action: 'disconnect', ms: 150, own: false },
    { type: 'other', action: 'other', ms: 10, own: false },
  ] });
  assert.doesNotMatch(JSON.stringify(projected), /secret|b{64}|c{64}/);
  const many = Array.from({ length: 100 }, (_, i) => line('container', 'die', foreign, i)).join('\n');
  const bounded = projectDockerEvents(many, origin, new Set());
  assert.equal(bounded.events.length, diagnosticLimits.dockerEvents);
  assert.equal(bounded.events.at(-1).ms, 99, 'the latest events are kept');
  assert.equal(bounded.dropped, 100 - diagnosticLimits.dockerEvents);
  assert.deepEqual(projectDockerEvents(undefined, origin, new Set()), { unavailable: true });
});

test('the artifact places own containers and host Docker events on the navigation clock', async () => {
  let clock = 5000;
  const timeline = containerTimeline(() => clock);
  const own = 'd'.repeat(64), origin = 1_700_000_000_000;
  timeline.record(['run', '-d', 'image'], () => { clock = 5600; return own; });
  clock = 8000;
  const page = new FakePage();
  const queries = [];
  const { diagnostics, saved } = observer(page, { timeline, now: () => clock, wall: () => origin,
    dockerEvents: async query => { queries.push(query);
      return JSON.stringify(['network', 'connect', 'n', own, (origin - 2990) * 1e6]); } });
  await assert.rejects(diagnostics.goto(async () => { throw new Error(gotoMessage); }));
  const detail = JSON.parse(saved[0]);
  assert.deepEqual(detail.containers, [{ op: 'run', startMs: -3000, endMs: -2400, ok: true }]);
  assert.deepEqual(detail.docker, { events: [{ type: 'network', action: 'connect', ms: -2990, own: true }], dropped: 0 });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].since, (origin - diagnosticLimits.dockerWindowMs) / 1000);
  assert.equal(queries[0].until, origin / 1000);
  assert.ok(queries[0].signal instanceof AbortSignal);
  assert.doesNotMatch(saved[0], /d{64}/);
});

test('a failing or stalled Docker events query cannot mask the original error', { timeout: 10_000 }, async () => {
  for (const mode of ['reject', 'hang', 'throw']) {
    const page = new FakePage();
    let aborted = false;
    const dockerEvents = mode === 'reject' ? async () => { throw new Error('docker: private detail'); }
      : mode === 'throw' ? () => { throw new Error('sync failure'); }
        : ({ signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); });
    const { diagnostics, saved } = observer(page, { dockerEvents });
    const original = new Error(gotoMessage);
    const started = Date.now();
    await assert.rejects(diagnostics.goto(async () => { throw original; }), error => error === original);
    assert.ok(Date.now() - started < diagnosticLimits.dockerEventsMs + diagnosticLimits.snapshotMs + diagnosticLimits.writeMs + 1000);
    assert.deepEqual(JSON.parse(saved[0]).docker, { unavailable: true });
    assert.doesNotMatch(saved[0], /private detail/);
    if (mode === 'hang') assert.ok(aborted, 'the query is aborted at its budget');
  }
});
