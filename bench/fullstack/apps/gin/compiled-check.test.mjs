import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { cleanUp, closeServer, containerBase, recordedFirst, reportCleanupFailure, startupFailure, writeFixtures } from './compiled-check.mjs';
import { observeHydration, readDockerEvents } from './hydration-diagnostics.mjs';
import './hydration-diagnostics.test.mjs';

test('synthetic fixtures are readable by native image users even with a private umask', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'compiled-fixture-test-'));
  const mask = process.umask(0o077);
  try {
    await writeFixtures(folder, { 'items.json': {}, 'marketplace.json': { item_1: { id: 'item_1' } } });
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'marketplace.json'), 'utf8')), { item_1: { id: 'item_1' } });
    if (process.platform !== 'win32') {
      assert.equal((await stat(folder)).mode & 0o777, 0o755);
      for (const name of ['items.json', 'marketplace.json']) assert.equal((await stat(join(folder, name))).mode & 0o777, 0o644);
    }
  } finally { process.umask(mask); await rm(folder, { recursive: true, force: true }); }
});

test('native container startup failures retain exit state and actual logs without a port binding', () => {
  for (const ports of [undefined, {}, { '8080/tcp': null }, { '8080/tcp': [] }]) {
    const state = { Running: false, ExitCode: 1, Error: '' };
    const docker = (command, name) => {
      assert.equal(name, 'native-test');
      return command === 'inspect' ? JSON.stringify([{ State: state, NetworkSettings: { Ports: ports } }])
        : 'open /fixtures/items.json: permission denied';
    };
    assert.throws(() => containerBase(docker, 'native-test'), /native startup failed: native-test; state=.*"ExitCode":1.*\nopen \/fixtures\/items.json: permission denied/);
    const cause = new Error('readiness timeout');
    assert.equal(startupFailure(docker, 'native-test', cause).cause, cause);
  }
});

test('running native containers use their actual published loopback port', () => {
  const docker = command => {
    assert.equal(command, 'inspect');
    return JSON.stringify([{ State: { Running: true }, NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '18480' }] } } }]);
  };
  assert.equal(containerBase(docker, 'native-test'), 'http://127.0.0.1:18480');
});

// The checker's shape: a case inside the check, each with its own outcome and cleanup, and
// regressions recorded during the check that are asserted at its end.
async function checker({ body, caseSteps, checkSteps, report, recorded = [] }) {
  const outcome = { failed: false };
  try {
    const caseOutcome = { failed: false };
    try { await body(); } catch (error) { caseOutcome.failed = true; throw error; } finally {
      await cleanUp(caseOutcome, caseSteps, report);
    }
    assert.deepEqual(recorded, [], 'recorded regressions');
  } catch (error) { outcome.failed = true; throw recordedFirst(error, recorded, 'recorded regressions', report); } finally {
    await cleanUp(outcome, checkSteps, report);
  }
}

function gatePage() {
  const page = new EventEmitter();
  page.evaluate = async () => ({});
  page.mainFrame = () => page;
  return page;
}

test('a cleanup failure after a failed check is reported and the identical check error surfaces', async () => {
  const page = gatePage();
  const gate = new Error('page.waitForFunction: Timeout 30000ms exceeded.');
  page.waitForFunction = async () => { throw gate; };
  const hydration = observeHydration(page, { app: 'gin', source: 'fixture', profile: 'defaults', artifactPath: 'ignored.json',
    write: async () => {}, log: () => {} });
  const ran = [], reports = [];
  const fail = (step, message) => [step, () => { ran.push(step); throw new Error(message); }];
  await assert.rejects(checker({ body: () => hydration.wait(),
    caseSteps: [fail('context', 'context.close: Target closed'), ['other', () => { ran.push('other'); }]],
    checkSteps: [fail('browser', 'browser.close failed'), fail('rm', 'docker rm: daemon unavailable'), ['folder', async () => { ran.push('folder'); }]],
    report: (error, step) => reports.push(`${step}: ${error.message}`) }), error => error === gate);
  assert.deepEqual(ran, ['context', 'other', 'browser', 'rm', 'folder'], 'every cleanup step still runs');
  assert.deepEqual(reports, ['context: context.close: Target closed', 'browser: browser.close failed', 'rm: docker rm: daemon unavailable']);
  // A broken reporter cannot replace the check's error either.
  await assert.rejects(checker({ body: () => { throw gate; }, caseSteps: [fail('x', 'x')], checkSteps: [],
    report: () => { throw new Error('report failed'); } }), error => error === gate);
});

test('a cleanup failure after an otherwise passing check fails it', async () => {
  const ran = [];
  const closeFailure = new Error('context.close failed');
  await assert.rejects(checker({ body: async () => { ran.push('body'); },
    caseSteps: [['context', () => { ran.push('context'); throw closeFailure; }], ['other', () => { ran.push('other'); }]],
    checkSteps: [['browser', () => { ran.push('browser'); }]], report: () => assert.fail('nothing to report beside a passing check') }),
  error => error === closeFailure);
  assert.deepEqual(ran, ['body', 'context', 'other', 'browser']);
  const first = new Error('browser.close failed'), second = new Error('docker rm failed');
  await assert.rejects(checker({ body: async () => {}, caseSteps: [], checkSteps: [['browser', () => { throw first; }], ['rm', () => { throw second; }]] }),
    error => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second);
  const passed = [];
  await checker({ body: async () => {}, caseSteps: [['case', () => passed.push('case')]], checkSteps: [['check', () => passed.push('check')]] });
  assert.deepEqual(passed, ['case', 'check']);
});

test('the default cleanup report prints a fixed step, an allowlisted class and code, and never error text', t => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  const id = 'a'.repeat(64);
  // Docker-like stderr, as the checker's docker() helper puts it in an assertion message.
  const docker = Object.assign(new Error(`Error response from daemon: cannot remove container ${id}: host-canary\r\u001b[31m\nsecond line`),
    { name: 'AssertionError', code: 'ERR_ASSERTION' });
  reportCleanupFailure(docker, 'container.rm');
  reportCleanupFailure(Object.assign(new Error('close'), { code: 'ERR_SERVER_NOT_RUNNING' }), 'upstream.close');
  reportCleanupFailure(Object.assign(new Error(`x ${id}`), { name: `Evil\r${id}`, code: `ERR_X\r${id}` }), `step\r${id}`);
  reportCleanupFailure({ get name() { throw new Error('broken'); }, get code() { throw new Error('broken'); } }, 'browser.close');
  reportCleanupFailure('plain string host-canary', undefined);
  assert.deepEqual(lines, [
    'cleanup also failed after the check failed: step=container.rm class=AssertionError code=ERR_ASSERTION',
    'cleanup also failed after the check failed: step=upstream.close class=Error code=ERR_SERVER_NOT_RUNNING',
    'cleanup also failed after the check failed: step=unknown class=unknown code=none',
    'cleanup also failed after the check failed: step=browser.close class=unknown code=none',
    'cleanup also failed after the check failed: step=unknown class=unknown code=none',
  ]);
  for (const line of lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f]|host-canary|daemon|a{64}/);
});

test('the upstream close adapter fails a passing check and is reported after a failed one', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // A listening server closes cleanly through cleanUp.
  await checker({ body: async () => {}, caseSteps: [], checkSteps: [['upstream.close', () => closeServer(server)]] });
  assert.equal(server.listening, false);
  // A second close reports ERR_SERVER_NOT_RUNNING to its callback, which now rejects.
  await assert.rejects(checker({ body: async () => {}, caseSteps: [], checkSteps: [['upstream.close', () => closeServer(server)]],
    report: () => assert.fail('nothing to report beside a passing check') }), error => error.code === 'ERR_SERVER_NOT_RUNNING');
  const gate = new Error('page.goto: net::ERR_NETWORK_CHANGED');
  const reports = [];
  await assert.rejects(checker({ body: () => { throw gate; }, caseSteps: [], checkSteps: [['upstream.close', () => closeServer(server)]],
    report: (error, step) => reports.push([step, error.code]) }), error => error === gate);
  assert.deepEqual(reports, [['upstream.close', 'ERR_SERVER_NOT_RUNNING']]);
});

test('a Docker stdout read error during a failed goto leaves the identical Playwright error on the checker path', async () => {
  const page = gatePage();
  const gate = new Error('page.goto: net::ERR_NETWORK_CHANGED at http://127.0.0.1:41234/marketplace/en-US/item_1');
  const saved = [], signals = [];
  let child;
  const start = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = signal => { signals.push(signal); return true; };
    child.unref = () => {};
    // The pipe fails after the query starts; the child itself never closes or errors.
    setImmediate(() => child.stdout.destroy(Object.assign(new Error('read EIO'), { code: 'EIO' })));
    return child;
  };
  const hydration = observeHydration(page, { app: 'gin', source: 'fixture', profile: 'defaults', artifactPath: 'ignored.json',
    wall: () => 1_700_000_000_000, write: async (_path, text) => saved.push(text), log: () => {},
    dockerEvents: options => readDockerEvents({ ...options, start }) });
  const started = performance.now();
  await assert.rejects(checker({ body: () => hydration.goto(async () => { throw gate; }), caseSteps: [], checkSteps: [] }),
    error => error === gate);
  assert.ok(performance.now() - started < 1000, 'the reader settles on the stream error, not at its deadline');
  const detail = JSON.parse(saved[0]);
  assert.deepEqual(detail.docker, { unavailable: true });
  assert.equal(detail.failure, 'ERR_NETWORK_CHANGED');
  assert.deepEqual(signals, ['SIGKILL']);
  assert.equal(child.stdout.destroyed, true);
});

test('recorded regressions outrank a cleanup failure that ends the check before they are asserted', async () => {
  const closeFailure = Object.assign(new Error('context.close: Target closed'), { code: 'ERR_CLOSED' });
  const reports = [];
  const recorded = ['gin fixture en-US 1.005: accepted price must confirm its email'];
  await assert.rejects(checker({ body: async () => {}, caseSteps: [['money-context.close', () => { throw closeFailure; }]], checkSteps: [],
    recorded, report: (error, step) => reports.push([step, error]) }),
  error => error instanceof assert.AssertionError && error.message.includes('recorded regressions')
    && error.message.includes('accepted price must confirm its email'));
  assert.deepEqual(reports, [['money-context.close', closeFailure]], 'the cleanup failure is reported, not lost');
  // The cleanup failure stays primary when nothing was recorded.
  await assert.rejects(checker({ body: async () => {}, caseSteps: [['money-context.close', () => { throw closeFailure; }]], checkSteps: [],
    report: () => assert.fail('nothing else failed') }), error => error === closeFailure);
  // A gate's own error is not a cleanup failure and stays the identical object thrown.
  const gate = new Error('page.waitForFunction: Timeout 30000ms exceeded.');
  await assert.rejects(checker({ body: () => { throw gate; }, caseSteps: [], checkSteps: [], recorded,
    report: () => assert.fail('nothing to report') }), error => error === gate);
  // With no cleanup failure the recorded assertion is the check's own failure, as before.
  await assert.rejects(checker({ body: async () => {}, caseSteps: [], checkSteps: [], recorded }),
    error => error instanceof assert.AssertionError && error.message.includes('recorded regressions'));
});

test('the checker routes every cleanup through cleanUp', async () => {
  const source = await readFile(new URL('./check-alerts.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/finally \{/g)?.length, 3);
  assert.equal(source.match(/\} catch \(error\) \{ \w*[oO]utcome\.failed = true; throw (?:error|recordedFirst\(error, moneyFailures, moneyMessage\)); \} finally \{\s*await cleanUp\(\w*[oO]utcome, \[\s*\['[a-z.-]+', /g)?.length, 3);
  assert.match(source, /\['upstream\.close', \(\) => closeServer\(upstream\)\]/);
  assert.doesNotMatch(source, /upstream\.close\(resolve\)/);
});
