import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { containerTimeline, diagnosticLimits, failureCodes, gotoFailureCode, hostEventsEnabled, hydrationArtifactPath, observeHydration,
  projectDockerEvents, readDockerEvents, requestFailureCode } from './hydration-diagnostics.mjs';

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
    artifactPath: 'ignored.json', now: () => 0, wall: () => 1_700_000_000_000,
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
    assert.equal('container' in detail, false, 'no container name is kept');
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
  keys(detail, ['schema', 'app', 'source', 'profile', 'navigationIndex', 'stage', 'failureMs', 'failure', 'navigation', 'errorClass', 'state',
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
  assert.deepEqual(detail.docker, { disabled: true }, 'no host event replay unless the caller enables it');
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
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) });
  // An allowlisted code inside a URL is not the request's error code.
  page.emit('requestfailed', { url: () => 'https://fixture.invalid/pkg/short-canary/app.wasm', resourceType: () => 'fetch',
    failure: () => ({ errorText: 'failed https://fixture.invalid/short-canary/net::ERR_NETWORK_CHANGED' }) });
  await assert.rejects(diagnostics.wait(), error => error === original);
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.dropped, 0, 'forbidden getters must not merely be swallowed');
  assert.equal(detail.errorClass, 'TimeoutError');
  assert.deepEqual(detail.events, [{ sequence: 1, kind: 'console', level: 'error' },
    { sequence: 2, kind: 'pageerror', errorClass: 'RuntimeError' },
    { sequence: 3, kind: 'requestfailed', resourceKind: 'wasm', resourceType: 'fetch', failure: 'ERR_CONNECTION_RESET', stage: 'idle', ms: 0 },
    { sequence: 4, kind: 'requestfailed', resourceKind: 'wasm', resourceType: 'fetch', failure: 'other', stage: 'idle', ms: 0 }]);
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
  assert.ok(source.includes('hydration?.reset();\n          ' + navigate));
  assert.match(source, /timeline, dockerEvents,/);
  assert.match(source, /dockerEvents = hostEventsEnabled\(\) \? readDockerEvents : undefined,/);
  assert.match(source, /const docker = \(args, options\) => timeline\.record\(args, \(\) => run\(args, options\)\);/);
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

test('a successful goto starts the navigation synchronously, returns its result and queries nothing', async () => {
  const page = new FakePage(); page.hydrated = 1;
  const queries = [];
  const { diagnostics, saved, summaries } = observer(page, { timeline: containerTimeline(() => 0),
    dockerEvents: async query => { queries.push(query); return ''; } });
  const result = { status: () => 200 };
  let started = false;
  const pending = diagnostics.goto(() => { started = true; return Promise.resolve(result); });
  assert.equal(started, true, 'the navigation starts before goto returns its promise, with no await before it');
  assert.equal(await pending, result);
  await diagnostics.wait();
  assert.deepEqual(saved, []); assert.deepEqual(summaries, []);
  assert.equal(queries.length, 0, 'no Docker events query on success');
  assert.equal(page.calls.filter(call => call[0] === 'snapshot').length, 0, 'no snapshot on success');
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

test('failure codes keep only allowlisted Chromium net codes, read as a whole token from the error itself', () => {
  assert.equal(requestFailureCode('net::ERR_NETWORK_CHANGED'), 'ERR_NETWORK_CHANGED');
  assert.equal(gotoFailureCode(gotoMessage), 'ERR_NETWORK_CHANGED');
  assert.equal(gotoFailureCode('page.goto: net::ERR_ABORTED; maybe frame was detached?'), 'ERR_ABORTED');
  for (const code of failureCodes) {
    assert.equal(requestFailureCode(`net::${code}`), code);
    assert.equal(gotoFailureCode(`page.goto: net::${code} at http://127.0.0.1:1/x`), code);
  }
  for (const text of ['net::ERR_SOMETHING_NEW', 'ERR_ABORTED', 'net::err_aborted', 'failure-canary', '', 'x'.repeat(600) + 'net::ERR_ABORTED',
    'net::ERR_ABORTEDX', 'xnet::ERR_ABORTED', 'net::ERR_ABORTED at http://x/', 'http://x/net::ERR_NETWORK_CHANGED']) {
    assert.equal(requestFailureCode(text), 'other', text.slice(0, 40));
  }
  for (const text of ['page.goto: net::ERR_SOMETHING_NEW at http://x/', 'page.goto: net::ERR_ABORTEDX at http://x/',
    'page.goto: Timeout 30000ms exceeded at http://x/net::ERR_NETWORK_CHANGED', 'x'.repeat(600) + 'net::ERR_ABORTED',
    'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "http://x/net::ERR_NETWORK_CHANGED"\n']) {
    assert.equal(gotoFailureCode(text), 'other', text.slice(0, 40));
  }
  for (const value of [undefined, null, 1, {}, ['net::ERR_ABORTED']]) {
    assert.equal(requestFailureCode(value), 'other'); assert.equal(gotoFailureCode(value), 'other');
  }
});

test('a goto timeout whose call log names ERR_NETWORK_CHANGED only inside a URL is not a network change', async () => {
  const page = new FakePage();
  const { diagnostics, saved, summaries } = observer(page);
  const original = new Error('page.goto: Timeout 30000ms exceeded.\nCall log:\n'
    + '  - navigating to "http://127.0.0.1:32774/marketplace/net::ERR_NETWORK_CHANGED/item_1", waiting until "load"\n');
  original.name = 'TimeoutError';
  await assert.rejects(diagnostics.goto(async () => { throw original; }), error => error === original);
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.failure, 'other');
  assert.equal(detail.errorClass, 'TimeoutError');
  assert.equal(summaries[0].failure, 'other');
  assert.doesNotMatch(saved[0], /NETWORK_CHANGED|127\.0\.0\.1|item_1/);
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
  // The shape readDockerEvents' --format writes: type, action, the event's container, time.
  const line = (type, action, container, ms) => JSON.stringify([type, action, container, (origin + ms) * 1e6]);
  const text = [
    line('container', 'start', own, -2500),
    line('network', 'connect', own, -2499),
    line('container', 'exec_start: sh -c echo secret-command', foreign, -100),
    line('network', 'disconnect', foreign, 150),
    line('image', 'pull', 'secret-image', 10),
    '{ not json', JSON.stringify({ Type: 'container', Action: 'start', secret: 'secret-object' }), '',
  ].join('\n');
  const projected = projectDockerEvents(text, origin, new Set([own]));
  assert.deepEqual(projected, { history: 'best-effort', dropped: 2, events: [
    { type: 'container', action: 'start', ms: -2500, own: true },
    { type: 'network', action: 'connect', ms: -2499, own: true },
    { type: 'container', action: 'other', ms: -100, own: false },
    { type: 'network', action: 'disconnect', ms: 150, own: false },
    { type: 'other', action: 'other', ms: 10, own: false },
  ] });
  assert.doesNotMatch(JSON.stringify(projected), /secret|b{64}|c{64}/);
  assert.deepEqual(projectDockerEvents(text, origin, new Set([own]), origin + 100).events.map(event => event.ms), [-2500, -2499, -100, 10],
    'an event after the cutoff is excluded even if Docker returned it');
  const many = Array.from({ length: 100 }, (_, i) => line('container', 'die', foreign, i)).join('\n');
  const bounded = projectDockerEvents(many, origin, new Set());
  assert.equal(bounded.events.length, diagnosticLimits.dockerEvents);
  assert.equal(bounded.events.at(-1).ms, 99, 'the latest events are kept');
  assert.equal(bounded.dropped, 100 - diagnosticLimits.dockerEvents);
  assert.deepEqual(projectDockerEvents(undefined, origin, new Set()), { unavailable: true });
});

test('a Docker replay is marked best effort even when it is empty and nothing was dropped', async () => {
  // Docker keeps only its latest events before filtering, so an empty replay is not an empty window.
  assert.deepEqual(projectDockerEvents('', 1_700_000_000_000, new Set()), { history: 'best-effort', events: [], dropped: 0 });
  const page = new FakePage();
  const { diagnostics, saved } = observer(page, { dockerEvents: async () => '' });
  await assert.rejects(diagnostics.goto(async () => { throw new Error(gotoMessage); }));
  assert.deepEqual(JSON.parse(saved[0]).docker, { history: 'best-effort', events: [], dropped: 0 });
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('`history: "best-effort"`') && readme.includes('latest 256'), 'the README documents the best-effort replay');
});

test('the Docker replay starts beside the snapshot, not after it', async () => {
  const page = new FakePage();
  let replayStarted;
  const started = new Promise(resolve => { replayStarted = resolve; });
  // This snapshot completes only once the replay has started. Run one after the other, it would
  // wait out its budget and be recorded as unavailable.
  page.evaluate = async () => { await started; return page.snapshot; };
  const { diagnostics, saved } = observer(page, { dockerEvents: async () => { replayStarted(); return ''; } });
  await assert.rejects(diagnostics.goto(async () => { throw new Error(gotoMessage); }));
  const detail = JSON.parse(saved[0]);
  assert.equal(detail.state.readyState, 'complete', 'the snapshot completed while the replay ran');
  assert.deepEqual(detail.docker, { history: 'best-effort', events: [], dropped: 0 });
});

test('host-wide Docker events are opt-in: on for a GitHub-hosted runner or an explicit flag, off otherwise', () => {
  assert.equal(hostEventsEnabled({}), false, 'a local or shared daemon');
  assert.equal(hostEventsEnabled({ RUNNER_ENVIRONMENT: 'self-hosted' }), false);
  assert.equal(hostEventsEnabled({ RUNNER_ENVIRONMENT: 'github-hosted' }), true);
  assert.equal(hostEventsEnabled({ RUNNER_ENVIRONMENT: 'github-hosted', COMPILED_ALERTS_HOST_EVENTS: '0' }), false);
  assert.equal(hostEventsEnabled({ COMPILED_ALERTS_HOST_EVENTS: '1' }), true);
  assert.equal(hostEventsEnabled({ COMPILED_ALERTS_HOST_EVENTS: 'yes' }), false, 'only 1 opts in');
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
      return JSON.stringify(['network', 'connect', own, (origin - 2990) * 1e6]); } });
  await assert.rejects(diagnostics.goto(async () => { throw new Error(gotoMessage); }));
  const detail = JSON.parse(saved[0]);
  assert.deepEqual(detail.containers, [{ op: 'run', startMs: -3000, endMs: -2400, ok: true }]);
  assert.equal(detail.failureMs, 0);
  assert.deepEqual(detail.docker, { history: 'best-effort', events: [{ type: 'network', action: 'connect', ms: -2990, own: true }], dropped: 0 });
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

test('the Docker window ends when the gate rejects, even if the clock advances during the snapshot', async () => {
  for (const gate of ['goto', 'readiness']) {
    let mono = 1000, wall = 1_700_000_000_000;
    const page = new FakePage();
    const queries = [];
    // The snapshot takes 900 ms; a container event lands during it, after the failure.
    page.evaluate = async () => { mono += 900; wall += 900; return page.snapshot; };
    const { diagnostics, saved } = observer(page, { now: () => mono, wall: () => wall,
      dockerEvents: async query => { queries.push(query); return [
        JSON.stringify(['container', 'die', 'e'.repeat(64), (1_700_000_000_000 + 200) * 1e6]),
        JSON.stringify(['network', 'disconnect', 'e'.repeat(64), (1_700_000_000_000 + 700) * 1e6]),
      ].join('\n'); } });
    const original = new Error(gotoMessage);
    if (gate === 'goto') {
      await assert.rejects(diagnostics.goto(async () => { mono += 300; wall += 300; throw original; }), error => error === original);
    } else {
      page.duringWait = () => { mono += 300; wall += 300; };
      await assert.rejects(diagnostics.wait(), error => error === page.error);
    }
    const detail = JSON.parse(saved[0]);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].until, (1_700_000_000_000 + 300) / 1000, `${gate}: the cutoff is the rejection, not after the snapshot`);
    assert.equal(detail.failureMs, 300);
    assert.deepEqual(detail.docker.events, [{ type: 'container', action: 'die', ms: 200, own: false }],
      'the post-failure event is excluded');
  }
});

test('the artifact keeps no container name, image, label, container ID or URL', async () => {
  const name = 'compiled-alerts-leptos-fixture-4242', image = 'cb-catalog-leptos', id = 'f'.repeat(64);
  let clock = 0;
  const timeline = containerTimeline(() => clock);
  timeline.record(['run', '-d', '--name', name, '--label', 'agent.owner=codex', '--label', 'agent.task=compiled-alerts', image],
    () => { clock = 10; return id; });
  const page = new FakePage();
  const { diagnostics, saved, summaries } = observer(page, { timeline, now: () => clock, container: name, image,
    dockerEvents: async () => [JSON.stringify(['container', 'start', id, 1_700_000_000_000 * 1e6]),
      JSON.stringify(['network', 'connect', id, 1_700_000_000_000 * 1e6])].join('\n') });
  await assert.rejects(diagnostics.goto(async () => { throw new Error(gotoMessage); }));
  const raw = saved[0] + JSON.stringify(summaries);
  assert.equal('container' in JSON.parse(saved[0]), false);
  assert.deepEqual(JSON.parse(saved[0]).docker.events.map(event => event.own), [true, true], 'ownership survives as a bit');
  assert.doesNotMatch(raw, /compiled-alerts-(?:gin|drogon|topcoat|leptos)-|4242|cb-catalog|agent\.|codex|[0-9a-f]{64}|https?:|127\.0\.0\.1/);
});

// A stand-in docker executable: it ignores SIGTERM and holds stdout open until killed.
// 'grandchild' also hands its stdout to a holder process (holder.mjs) that outlives it.
// Arguments: mode, base (a per-attempt path prefix), holder script, then the docker arguments.
// Every fixture process publishes its own PID as its first act (to BASE.docker.pid or
// BASE.holder.pid, atomically) and exits once the test's BASE.stop file appears, or after 20 s
// so a broken test cannot leak it for long. The test owns that stop file; no PID is signalled.
const fakeDocker = `import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
const [mode, base, holder] = process.argv.slice(2);
process.on('SIGTERM', () => {});
if (mode === 'ok') { process.stdout.write(JSON.stringify(process.argv.slice(5)) + '\\n'); process.exit(0); }
writeFileSync(base + '.docker.pid.tmp', String(process.pid));
renameSync(base + '.docker.pid.tmp', base + '.docker.pid');
setInterval(() => { if (existsSync(base + '.stop')) process.exit(0); }, 25);
setTimeout(() => process.exit(0), 20_000);
// Detached, so on Windows it leaves libuv's kill-on-close job and outlives the reader's process there too.
if (mode === 'grandchild') spawn(process.execPath, [holder, base], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref();
if (mode === 'flood') {
  const chunk = 'x'.repeat(64 * 1024);
  const pump = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', pump); };
  pump();
} else process.stdout.write('["container","start","x",1]\\n');
`;
const holderScript = `import { existsSync, renameSync, writeFileSync } from 'node:fs';
const [base] = process.argv.slice(2);
writeFileSync(base + '.holder.pid.tmp', String(process.pid));
renameSync(base + '.holder.pid.tmp', base + '.holder.pid');
setInterval(() => { if (existsSync(base + '.stop')) process.exit(0); }, 25);
setTimeout(() => process.exit(0), 20_000);
`;

// A killed but unreaped (zombie) process has exited; an orphan's reaper may not be this process.
const alive = pid => {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'EPERM'; }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z'; } catch { return process.platform === 'win32'; }
};
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// Resolves with a promise's value, or rejects with `message` once `milliseconds` pass.
const within = (promise, milliseconds, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
    .finally(() => clearTimeout(timer));
};

// Adds to `pids` each of `roles` whose PID file now holds a valid PID.
async function readPublished(base, roles, pids) {
  for (const role of roles) {
    if (role in pids) continue;
    try {
      const pid = Number(await readFile(`${base}.${role}.pid`, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) pids[role] = pid;
    } catch { /* Not yet. */ }
  }
  return pids;
}

// The PIDs the attempt's fixture processes published, once all of `roles` have (the handshake).
// Each PID is recorded in `pids` as it appears, so a handshake that misses its deadline still
// leaves the processes that did publish for the teardown to wait on.
async function published(base, roles, milliseconds, pids = {}) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    await readPublished(base, roles, pids);
    if (roles.every(role => role in pids)) return pids;
    if (Date.now() > deadline) throw new Error(`fixture processes did not publish their PIDs: ${roles.filter(role => !(role in pids)).join(', ')}`);
    await pause(25);
  }
}

// The fixture's own teardown: the stop file every fixture process watches, then each process's
// exit, awaited under its own bound. The PID files are reread throughout, so a process that
// publishes after a missed handshake is waited on too; the bound ends the wait for one that never
// publishes. Returns every PID seen, those still running at the bound, and roles never published.
async function stopFixture(base, roles, milliseconds = 3000, pids = {}) {
  await writeFile(`${base}.stop`, '');
  const deadline = Date.now() + milliseconds;
  for (;;) {
    await readPublished(base, roles, pids);
    const waiting = roles.some(role => !(role in pids)) || Object.values(pids).some(alive);
    if (!waiting || Date.now() >= deadline) break;
    await pause(50);
  }
  return { checked: pids, survivors: Object.values(pids).filter(alive), unpublished: roles.filter(role => !(role in pids)) };
}

test('the Docker events reader kills a subprocess that ignores SIGTERM and settles, and its process exits', { timeout: 60_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'fake-docker-'));
  try {
    const fake = join(folder, 'docker.mjs'), holder = join(folder, 'holder.mjs');
    await writeFile(fake, fakeDocker);
    await writeFile(holder, holderScript);
    const module = new URL('./hydration-diagnostics.mjs', import.meta.url).href;
    // 'forced' is the grandchild fixture with the reader's process killed after the handshake,
    // before the reader can kill anything: the fixture must still exit through its own teardown.
    for (const [mode, limit, forced] of [['hold', diagnosticLimits.dockerEventsMs + 500], ['grandchild', diagnosticLimits.dockerEventsMs + 500],
      ['flood', diagnosticLimits.dockerEventsMs], ['grandchild', diagnosticLimits.dockerEventsMs + 500, true]]) {
      const name = forced ? 'forced' : mode, base = join(folder, name), roles = mode === 'grandchild' ? ['docker', 'holder'] : ['docker'];
      // The reader runs in its own Node process, so a handle it leaves behind would keep that process alive.
      const script = `const { readDockerEvents } = await import(${JSON.stringify(module)});
const started = performance.now();
try { await readDockerEvents({ since: 0, until: 1, command: process.execPath, prefix: ${JSON.stringify([fake, mode, base, holder])} });
  console.log(JSON.stringify({ settled: 'resolved' }));
} catch (error) { console.log(JSON.stringify({ settled: error.message, ms: performance.now() - started })); }`;
      const started = Date.now();
      const runner = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      runner.stdout.on('data', chunk => { out += chunk; });
      // 'close' rather than 'exit', so the reader's final output has been read before it is parsed.
      const closed = new Promise(resolve => runner.once('close', (code, signal) => resolve({ code, signal })));
      const pids = {};
      let failure;
      try {
        await published(base, roles, limit, pids);
        if (forced) runner.kill('SIGKILL');
        const { code, signal } = await within(closed, limit + 4000, `${name}: the reader's process did not exit`);
        const exited = Date.now() - started;
        if (forced) assert.equal(signal, 'SIGKILL', `${name}: the reader's process was killed before it settled`);
        else {
          assert.equal(code, 0);
          const result = JSON.parse(out.trim());
          assert.notEqual(result.settled, 'resolved', `${name}: a deadline or overflow is a failure`);
          assert.ok(result.ms < limit, `${name}: settled in ${Math.round(result.ms)} ms`);
          assert.match(result.settled, mode === 'flood' ? /exceeded its cap/ : /deadline/);
          // Node startup is outside the reader's budget; the process must exit promptly after it settles.
          assert.ok(exited < limit + 3000, `${name}: the reader's process exited after ${exited} ms`);
          // Checked before the fixture's own teardown: the reader killed it.
          const deadline = Date.now() + 3000;
          while (alive(pids.docker) && Date.now() < deadline) await pause(50);
          assert.equal(alive(pids.docker), false, `${name}: the SIGTERM-ignoring docker process is killed`);
        }
      } catch (error) { failure = error; } finally {
        // A reader process still running after a failure above is killed, and its exit awaited.
        if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
        try { await within(closed, 5000, `${name}: the reader's process did not exit after SIGKILL`); } catch (error) { failure ??= error; }
      }
      // Whatever happened above, including a handshake that published only some PIDs, every
      // fixture process this attempt started exits through the fixture's own teardown within its
      // bound, and the stop file stays until then.
      const { survivors, unpublished } = await stopFixture(base, roles, 3000, pids);
      if (failure) throw failure;
      assert.deepEqual(survivors, [], `${name}: fixture processes still running after teardown`);
      assert.deepEqual(unpublished, [], `${name}: fixture processes never published their PIDs`);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// A fixture process for the partial handshake. It marks itself running (BASE.ROLE.ready, not a PID
// file) and exits once the stop file appears, or after 20 s overall. 'now' publishes its PID at
// once; 'on-stop' publishes only after the stop file appears, then keeps running for 300 ms, so a
// teardown sees its PID while it is still alive and must wait for its exit.
const lateScript = `import { existsSync, renameSync, writeFileSync } from 'node:fs';
const [base, role, mode] = process.argv.slice(2);
setTimeout(() => process.exit(0), 20_000);
const publish = () => {
  writeFileSync(base + '.' + role + '.pid.tmp', String(process.pid));
  renameSync(base + '.' + role + '.pid.tmp', base + '.' + role + '.pid');
};
if (mode === 'now') publish();
writeFileSync(base + '.' + role + '.ready', '');
const poll = setInterval(() => {
  if (!existsSync(base + '.stop')) return;
  clearInterval(poll);
  if (mode === 'now') process.exit(0);
  publish();
  setTimeout(() => process.exit(0), 300);
}, 25);
`;

// Resolves once `path` exists, or rejects with `message` after `milliseconds`.
async function appears(path, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    try { await readFile(path); return; } catch { /* Not yet. */ }
    if (Date.now() > deadline) throw new Error(message);
    await pause(25);
  }
}

test('a partial handshake keeps what was published, and teardown waits for every fixture process', { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'fake-docker-'));
  const children = [], base = join(folder, 'partial');
  try {
    const script = join(folder, 'late.mjs');
    await writeFile(script, lateScript);
    // The docker stand-in publishes at once; the holder cannot publish until the teardown's stop file.
    for (const [role, mode] of [['docker', 'now'], ['holder', 'on-stop']]) {
      const child = spawn(process.execPath, [script, base, role, mode], { stdio: 'ignore' });
      children.push(new Promise(resolve => child.once('exit', resolve)));
    }
    // The first handshake, explicitly: the docker PID is published and both processes are running,
    // however long their startup takes.
    const first = await published(base, ['docker'], 15_000);
    await appears(`${base}.holder.ready`, 15_000, 'the holder did not start');
    // So the partial timeout fires with only the docker PID published, whatever the scheduling.
    const pids = {};
    await assert.rejects(published(base, ['docker', 'holder'], 300, pids), /did not publish their PIDs: holder$/);
    assert.equal(pids.docker, first.docker, 'the PID published before the deadline is kept');
    assert.equal(pids.holder, undefined);
    // The stop file releases the holder, which publishes only now and then runs for 300 ms more.
    const { checked, survivors, unpublished } = await stopFixture(base, ['docker', 'holder'], 3000, pids);
    assert.deepEqual(Object.keys(checked).sort(), ['docker', 'holder'], 'teardown rereads the PID files');
    assert.equal(checked.docker, first.docker);
    assert.deepEqual(unpublished, []);
    assert.deepEqual(survivors, []);
    assert.equal(alive(checked.docker), false);
    assert.equal(alive(checked.holder), false);
  } finally {
    // Whatever failed above, the stop file ends every fixture process before the folder goes.
    await writeFile(`${base}.stop`, '');
    await within(Promise.all(children), 5000, 'fixture processes did not exit');
    await rm(folder, { recursive: true, force: true });
  }
});

// A child whose stdout pipe fails; the child itself never closes or emits an error on its own.
function brokenPipeChild(signals) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = signal => { signals.push(signal); return true; };
  child.unref = () => signals.push('unref');
  setImmediate(() => child.stdout.destroy(Object.assign(new Error('read EIO'), { code: 'EIO' })));
  return child;
}

test('a Docker events stdout error kills the query, destroys its pipe and rejects once', async () => {
  const signals = [];
  let child;
  const started = performance.now();
  await assert.rejects(readDockerEvents({ since: 0, until: 1, start: () => (child = brokenPipeChild(signals)) }),
    error => error.code === 'EIO');
  assert.ok(performance.now() - started < 1000, 'settled on the stream error, not at the deadline');
  assert.deepEqual(signals, ['SIGKILL', 'unref']);
  assert.equal(child.stdout.destroyed, true);
  // Errors after settling (a failed kill, another stream error) are absorbed, not unhandled.
  child.emit('error', new Error('kill ESRCH'));
  child.stdout.emit('error', new Error('second'));
  child.emit('close', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGKILL', 'unref'], 'teardown runs once');
});

test('the Docker events reader returns a complete query and asks for no network ID', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'fake-docker-'));
  try {
    const fake = join(folder, 'docker.mjs');
    await writeFile(fake, fakeDocker);
    const text = await readDockerEvents({ since: 1.5, until: 2.25, command: process.execPath, prefix: [fake, 'ok', join(folder, 'ok'), join(folder, 'holder.mjs')] });
    const args = JSON.parse(text);
    assert.deepEqual(args.slice(0, 5), ['events', '--since', '1.500', '--until', '2.250']);
    const format = args[args.indexOf('--format') + 1];
    assert.equal(format, '[{{json .Type}},{{json .Action}},{{if eq .Type "network"}}{{json (index .Actor.Attributes "container")}}'
      + '{{else}}{{json .Actor.ID}}{{end}},{{json .TimeNano}}]');
    assert.deepEqual(args.filter((arg, i) => args[i - 1] === '--filter' && arg.startsWith('type=')), ['type=container', 'type=network']);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(readDockerEvents({ since: 0, until: 1, signal: aborted.signal, command: process.execPath, prefix: [fake, 'hold', join(folder, 'x'), join(folder, 'holder.mjs')] }),
      /aborted/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
