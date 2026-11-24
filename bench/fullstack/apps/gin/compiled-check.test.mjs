import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { cleanUp, containerBase, reportCleanupFailure, startupFailure, writeFixtures } from './compiled-check.mjs';
import { observeHydration } from './hydration-diagnostics.mjs';
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

// The checker's shape: a case inside the check, each with its own outcome and cleanup.
async function checker({ body, caseSteps, checkSteps, report }) {
  const outcome = { failed: false };
  try {
    const caseOutcome = { failed: false };
    try { await body(); } catch (error) { caseOutcome.failed = true; throw error; } finally {
      await cleanUp(caseOutcome, caseSteps, report);
    }
  } catch (error) { outcome.failed = true; throw error; } finally {
    await cleanUp(outcome, checkSteps, report);
  }
}

test('a cleanup failure after a failed check is reported and the identical check error surfaces', async () => {
  const page = new EventEmitter();
  const gate = new Error('page.waitForFunction: Timeout 30000ms exceeded.');
  page.waitForFunction = async () => { throw gate; };
  page.evaluate = async () => ({});
  page.mainFrame = () => page;
  const hydration = observeHydration(page, { app: 'gin', source: 'fixture', profile: 'defaults', artifactPath: 'ignored.json',
    write: async () => {}, log: () => {} });
  const ran = [], reports = [];
  const fail = (step, message) => () => { ran.push(step); throw new Error(message); };
  await assert.rejects(checker({ body: () => hydration.wait(),
    caseSteps: [fail('context', 'context.close: Target closed'), () => { ran.push('other'); }],
    checkSteps: [fail('browser', 'browser.close failed'), fail('rm', 'docker rm: daemon unavailable'), async () => { ran.push('folder'); }],
    report: error => reports.push(error.message) }), error => error === gate);
  assert.deepEqual(ran, ['context', 'other', 'browser', 'rm', 'folder'], 'every cleanup step still runs');
  assert.deepEqual(reports, ['context.close: Target closed', 'browser.close failed', 'docker rm: daemon unavailable']);
  // A broken reporter cannot replace the check's error either.
  await assert.rejects(checker({ body: () => { throw gate; }, caseSteps: [fail('x', 'x')], checkSteps: [],
    report: () => { throw new Error('report failed'); } }), error => error === gate);
});

test('a cleanup failure after an otherwise passing check fails it', async () => {
  const ran = [];
  const closeFailure = new Error('context.close failed');
  await assert.rejects(checker({ body: async () => { ran.push('body'); },
    caseSteps: [() => { ran.push('context'); throw closeFailure; }, () => { ran.push('other'); }],
    checkSteps: [() => { ran.push('browser'); }], report: () => assert.fail('nothing to report beside a passing check') }),
  error => error === closeFailure);
  assert.deepEqual(ran, ['body', 'context', 'other', 'browser']);
  const first = new Error('browser.close failed'), second = new Error('docker rm failed');
  await assert.rejects(checker({ body: async () => {}, caseSteps: [], checkSteps: [() => { throw first; }, () => { throw second; }] }),
    error => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second);
  const passed = [];
  await checker({ body: async () => {}, caseSteps: [() => passed.push('case')], checkSteps: [() => passed.push('check')] });
  assert.deepEqual(passed, ['case', 'check']);
});

test('the default cleanup report is one bounded line', t => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  reportCleanupFailure(new Error('docker rm: '.padEnd(500, 'x') + '\nsecond line'));
  reportCleanupFailure({ get message() { throw new Error('broken'); } });
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => !line.includes('\n') && line.length < 300));
  assert.match(lines[0], /^cleanup also failed after the check failed: Error: docker rm: x+$/);
  assert.match(lines[1], /unknown$/);
});

test('the checker routes every cleanup through cleanUp', async () => {
  const source = await readFile(new URL('./check-alerts.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/finally \{/g)?.length, 3);
  assert.equal(source.match(/\} catch \(error\) \{ \w*[oO]utcome\.failed = true; throw error; \} finally \{\s*await cleanUp\(\w*[oO]utcome, \[/g)?.length, 3);
});
