import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { attemptKey, CleanupError, cleanUp, cleanupCodes, closeServer, containerBase, DockerCommandError, dockerCommand, ownedContainers,
  ownerKey, recordedFirst, reportCleanupFailure, startupFailure, writeFixtures } from './compiled-check.mjs';
import { checkAlerts } from './check-alerts.mjs';
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
  error => error instanceof CleanupError && error.cause === undefined
    && assert.deepEqual(error.failures, [{ step: 'context', errorClass: 'Error', code: 'none' }]) === undefined);
  assert.deepEqual(ran, ['body', 'context', 'other', 'browser']);
  const first = new Error('browser.close failed'), second = new DockerCommandError('rm', 'ERR_DOCKER_EXIT', 1);
  await assert.rejects(checker({ body: async () => {}, caseSteps: [], checkSteps: [['browser', () => { throw first; }], ['rm', () => { throw second; }]] }),
    error => error instanceof CleanupError && error.message === 'cleanup failed: step=browser class=Error code=none; step=rm class=DockerCommandError code=ERR_DOCKER_EXIT');
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
  // A code with the right shape that is not on the list is not printed either.
  reportCleanupFailure(Object.assign(new Error('x'), { code: 'ERR_HOST_CANARY_TOKEN' }), 'browser.close');
  reportCleanupFailure(new CleanupError([{ step: 'container.rm', errorClass: 'DockerCommandError', code: 'ERR_DOCKER_EXIT' },
    { step: 'fixtures.rm', errorClass: 'Error', code: 'EBUSY' }]), 'cleanup');
  assert.deepEqual(lines, [
    'cleanup also failed after the check failed: step=container.rm class=AssertionError code=ERR_ASSERTION',
    'cleanup also failed after the check failed: step=upstream.close class=Error code=ERR_SERVER_NOT_RUNNING',
    'cleanup also failed after the check failed: step=unknown class=unknown code=other',
    'cleanup also failed after the check failed: step=browser.close class=unknown code=other',
    'cleanup also failed after the check failed: step=unknown class=unknown code=none',
    'cleanup also failed after the check failed: step=browser.close class=Error code=other',
    'cleanup also failed after the check failed: step=container.rm class=DockerCommandError code=ERR_DOCKER_EXIT',
    'cleanup also failed after the check failed: step=fixtures.rm class=Error code=EBUSY',
  ]);
  for (const line of lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f]|host-canary|HOST_CANARY|daemon|a{64}/);
  // The list is literal: every entry is printed as written and nothing else is.
  assert.ok(cleanupCodes.every(code => /^[A-Z][A-Z0-9_]+$/.test(code)));
  assert.ok(!cleanupCodes.includes('ERR_HOST_CANARY_TOKEN'));
});

// A stand-in docker client: 'fail' writes Docker-like stderr with a canary and exits 3, 'ok'
// prints its arguments, 'hang' never answers.
const dockerClient = `const [mode, ...args] = process.argv.slice(2);
if (mode === 'fail') { process.stderr.write('Error response from daemon: stderr-canary ' + 'a'.repeat(64) + '\\n'); process.exit(3); }
if (mode === 'ok') { process.stdout.write('  ' + args.join(' ') + '\\n'); process.stderr.write('log-err'); process.exit(0); }
setTimeout(() => {}, 30_000);
`;

test('a failed Docker command names its subcommand and status, never Docker\'s stderr', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'docker-client-'));
  try {
    const client = join(folder, 'docker.mjs');
    await writeFile(client, dockerClient);
    const run = (mode, args, options = {}) => dockerCommand(args, { command: process.execPath, prefix: [client, mode], ...options });
    assert.equal(run('ok', ['ps', '-a']), 'ps -a');
    assert.equal(run('ok', ['logs', 'x'], { combined: true }), 'logs x\nlog-err');
    let failure;
    try { run('fail', ['rm', '-f', '-v', 'x']); } catch (error) { failure = error; }
    assert.ok(failure instanceof DockerCommandError);
    assert.equal(failure.message, 'docker rm: exit 3');
    assert.deepEqual([failure.code, failure.status, failure.sent, failure.cause], ['ERR_DOCKER_EXIT', 3, true, undefined]);
    assert.doesNotMatch(inspect(failure) + failure.stack, /stderr-canary|daemon|a{64}/);
    assert.throws(() => run('hang', ['ps'], { timeout: 300 }), error => error.code === 'ERR_DOCKER_TIMEOUT' && error.sent === true
      && error.message === 'docker ps: timed out');
    assert.throws(() => dockerCommand(['ps'], { command: join(folder, 'missing-docker') }),
      error => error.code === 'ENOENT' && error.sent === false && error.message === 'docker ps: not found');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a cleanup failure after a passing check reaches Node\'s uncaught output without any error text', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cleanup-uncaught-'));
  try {
    const client = join(folder, 'docker.mjs');
    await writeFile(client, dockerClient);
    const module = new URL('./compiled-check.mjs', import.meta.url).href;
    // The check passed; both cleanup steps fail with Docker's stderr, or a message, carrying a canary.
    const script = `const { cleanUp, dockerCommand } = await import(${JSON.stringify(module)});
await cleanUp({ failed: false }, [
  ['container.rm', () => dockerCommand(['rm', '-f', '-v', 'x'], { command: process.execPath, prefix: [${JSON.stringify(client)}, 'fail'] })],
  ['browser.close', () => { throw Object.assign(new Error('Target closed: message-canary'), { code: 'ERR_MESSAGE_CANARY' }); }],
]);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 1, child.error?.message);
    assert.match(child.stderr, /CleanupError: cleanup failed: step=container\.rm class=DockerCommandError code=ERR_DOCKER_EXIT; step=browser\.close class=Error code=other/);
    assert.doesNotMatch(child.stderr + child.stdout, /canary|CANARY|daemon|a{64}|Target closed/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// An in-memory Docker daemon for the owned-container helper and the driver: containers by ID
// with a name and labels, the `run`, `ps`, `container inspect`, `logs` and `rm` shapes those
// use, and every call recorded. `runFails` makes a run fail ('before-create' or 'after-create',
// like a start failure after the daemon made the container); `rmFails` fails that many removals.
function fakeDaemon({ runFails, rmFails = 0 } = {}) {
  const containers = new Map(), calls = [];
  let next = 0;
  const exit = (op, status = 1) => { throw new DockerCommandError(op, 'ERR_DOCKER_EXIT', status); };
  const add = (name, labels = {}, id = (++next).toString(16).padStart(64, '0')) => { containers.set(id, { name, labels }); return id; };
  const docker = args => {
    calls.push(args);
    const [op] = args;
    if (op === 'run') {
      const name = args[args.indexOf('--name') + 1], labels = {};
      args.forEach((arg, i) => { if (arg === '--label') { const at = args[i + 1].indexOf('='); labels[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1); } });
      if ([...containers.values()].some(container => container.name === name)) exit('run', 125);
      if (runFails === 'before-create') exit('run', 125);
      const id = add(name, labels);
      if (runFails === 'after-create') exit('run', 125);
      return id;
    }
    if (op === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      if (filter.startsWith('id=')) return containers.has(filter.slice(3)) ? filter.slice(3) : '';
      const [key, value] = [filter.slice(6, filter.indexOf('=', 6)), filter.slice(filter.indexOf('=', 6) + 1)];
      return [...containers].filter(([, container]) => container.labels[key] === value).map(([id]) => id).join('\n');
    }
    if (op === 'container' && args[1] === 'inspect') {
      const container = containers.get(args[2]) ?? exit('container', 1);
      return JSON.stringify([{ Id: args[2], Name: `/${container.name}`, Config: { Labels: container.labels },
        State: { Running: true }, NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '18080' }] } } }]);
    }
    if (op === 'logs') return containers.has(args[1]) ? 'app log' : exit('logs', 1);
    if (op === 'rm') {
      const id = args.at(-1);
      if (rmFails > 0) { rmFails--; exit('rm', 1); }
      if (!containers.delete(id)) exit('rm', 1);
      return id;
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return { docker, calls, containers, add };
}
// A clock the reconciliation window runs on, advanced by each wait.
const fakeClock = () => {
  let clock = 0;
  return { now: () => clock, wait: async milliseconds => { clock += milliseconds; } };
};
const ops = calls => calls.map(args => (args[0] === 'container' ? args.slice(0, 2) : args.slice(0, 1)).join(' '));

test('caller labels in the owner namespace are refused before any Docker command; ordinary labels are kept', () => {
  for (const labels of [[`${ownerKey}=x`], [`${attemptKey}=x`], [`${ownerKey}.other=x`], ['not a label'], ['a=b c']]) {
    const daemon = fakeDaemon();
    assert.throws(() => ownedContainers({ docker: daemon.docker, runId: 'run-1', labels }), assert.AssertionError);
    assert.deepEqual(daemon.calls, [], `${labels}: no Docker command`);
  }
  const daemon = fakeDaemon();
  const owned = ownedContainers({ docker: daemon.docker, runId: 'run-1', labels: ['agent.owner=codex', `${ownerKey}-other=x`] });
  assert.throws(() => owned.run({ labels: [`${ownerKey}=other`] }, 'image', 'n'), /unknown docker run option labels/);
  assert.deepEqual(daemon.calls, []);
  const id = owned.run({}, 'image', 'compiled-alerts-test');
  assert.deepEqual(daemon.containers.get(id).labels, { 'agent.owner': 'codex', [`${ownerKey}-other`]: 'x', [ownerKey]: 'run-1', [attemptKey]: 'run-1-1' });
});

test('docker run options are a structured object: an unknown key, a wrong type or an option-like image makes no Docker call', () => {
  const daemon = fakeDaemon();
  const owned = ownedContainers({ docker: daemon.docker, runId: 'run-1' });
  // The old argv form, a string and anything that is not a plain object.
  for (const options of [[], ['--', 'alpine:substitute'], '--cpus 1', null, undefined, Object.create(null)]) {
    assert.throws(() => owned.run(options, 'image', 'n'), /options are a plain object/, inspect(options));
  }
  for (const key of ['labels', 'label', 'labelFile', 'args', 'entrypoint', 'image', '--']) {
    assert.throws(() => owned.run({ [key]: ['x'] }, 'image', 'n'), new RegExp(`unknown docker run option ${key.replace(/-/g, '\\-')}`), key);
  }
  for (const options of [{ cpus: 1 }, { cpus: '1 --label x' }, { cpus: '' }, { memory: 512 }, { memory: '512m --label=x' },
    { publish: '127.0.0.1::8080' }, { publish: [''] }, { publish: [8080] }, { volumes: ['/a:/b\n--label=x'] }, { addHosts: 'h:1' },
    { env: [['A', 'b']] }, { env: { 'A B': 'x' } }, { env: { '': 'x' } }, { env: { A: 1 } }, { env: { A: 'x\ny' } }, { env: 'A=b' }]) {
    assert.throws(() => owned.run(options, 'image', 'n'), assert.AssertionError, JSON.stringify(options));
  }
  for (const image of ['', '-', '-limage', '--label=x', '--', undefined, 1, ['image']]) {
    assert.throws(() => owned.run({}, image, 'n'), /the image is a non-empty argument that is not an option/, String(image));
  }
  assert.deepEqual(daemon.calls, [], 'no Docker command');
  assert.deepEqual(owned.record.unacknowledged, [], 'nothing was attempted');
});

test('the helper writes the run argv: labels first, the built options, then -- and the image as the last argument', () => {
  const daemon = fakeDaemon();
  const owned = ownedContainers({ docker: daemon.docker, runId: 'run-1', labels: ['agent.owner=codex', 'agent.task=compiled-alerts'] });
  const labels = ['--label', 'agent.owner=codex', '--label', 'agent.task=compiled-alerts'];
  // The driver's shape. A value that looks like an option stays its flag's separate argument.
  const image = 'registry.local/app:1@sha256:' + 'a'.repeat(64);
  const id = owned.run({ cpus: '1', memory: '512m', addHosts: ['host.docker.internal:host-gateway'], publish: ['127.0.0.1::8080'],
    volumes: ['/tmp/l:/fixtures:ro'], env: { PROFILE: 'defaults', MARKETPLACE_SOURCE: 'api', NOTE: '--label=x' } }, image, 'compiled-alerts-test');
  assert.deepEqual(daemon.calls[0], ['run', '-d', '--name', 'compiled-alerts-test', ...labels,
    '--label', `${ownerKey}=run-1`, '--label', `${attemptKey}=run-1-1`,
    '--cpus', '1', '--memory', '512m', '--add-host', 'host.docker.internal:host-gateway', '--publish', '127.0.0.1::8080',
    '--volume', '/tmp/l:/fixtures:ro', '--env', 'PROFILE=defaults', '--env', 'MARKETPLACE_SOURCE=api', '--env', 'NOTE=--label=x', '--', image]);
  assert.deepEqual(daemon.containers.get(id).labels, { 'agent.owner': 'codex', 'agent.task': 'compiled-alerts', [ownerKey]: 'run-1', [attemptKey]: 'run-1-1' });
  // Reference syntax is Docker's: an IPv6 registry is passed through unchanged after --.
  owned.run({}, '[::1]:5000/alpine:expected', 'compiled-alerts-ipv6');
  assert.deepEqual(daemon.calls[1], ['run', '-d', '--name', 'compiled-alerts-ipv6', ...labels,
    '--label', `${ownerKey}=run-1`, '--label', `${attemptKey}=run-1-2`, '--', '[::1]:5000/alpine:expected']);
});

test("the argv is built from copies read once, so a caller array's own methods, iterator or getters cannot add flags or change the image", () => {
  const substitute = ['--label', `${ownerKey}=other`, '--label', `${attemptKey}=other`, '--', 'alpine:substitute'];
  // An array whose methods and iterator are replaced, and whose element is a getter that answers
  // differently after the first read.
  const hostile = (first, later) => {
    const array = [];
    let reads = 0;
    Object.defineProperty(array, 0, { get: () => (++reads === 1 ? first : later), enumerable: true, configurable: true });
    for (const method of ['every', 'flatMap', 'map', 'forEach', 'some', 'filter', 'slice', 'concat'])
      Object.defineProperty(array, method, { value: () => substitute });
    Object.defineProperty(array, Symbol.iterator, { value: function* () { yield* substitute; } });
    return array;
  };
  const daemon = fakeDaemon();
  const owned = ownedContainers({ docker: daemon.docker, runId: 'run-1', labels: hostile('agent.owner=codex', `${ownerKey}=other`) });
  owned.run({ volumes: hostile('/tmp/l:/fixtures:ro', '/:/host'), publish: hostile('127.0.0.1::8080', '0.0.0.0:80:8080') }, 'image', 'n');
  assert.deepEqual(daemon.calls[0], ['run', '-d', '--name', 'n', '--label', 'agent.owner=codex',
    '--label', `${ownerKey}=run-1`, '--label', `${attemptKey}=run-1-1`,
    '--publish', '127.0.0.1::8080', '--volume', '/tmp/l:/fixtures:ro', '--', 'image']);
  // A getter on the options object is read once too.
  let reads = 0;
  owned.run({ get cpus() { return ++reads === 1 ? '1' : '1 --label x'; } }, 'image', 'm');
  assert.deepEqual(daemon.calls[1].slice(-4), ['--cpus', '1', '--', 'image']);
  assert.equal(reads, 1);
  // A list that shrinks or grows while it is copied is refused, not cut short or extended.
  const resizing = (items, change) => {
    const array = [...items];
    Object.defineProperty(array, 0, { get() { change(array); return items[0]; }, enumerable: true, configurable: true });
    return array;
  };
  for (const publish of [resizing(['127.0.0.1::8080', '127.0.0.1::9090'], array => { array.length = 1; }),
    resizing(['127.0.0.1::8080'], array => { if (array.length < 3) array.push('0.0.0.0:80:8080'); })]) {
    const calls = daemon.calls.length;
    assert.throws(() => owned.run({ publish }, 'image', 'resized'), /--publish values are non-empty strings/);
    assert.equal(daemon.calls.length, calls, 'no Docker command');
  }
  // A label that is not a string is refused before any Docker command.
  const none = fakeDaemon();
  assert.throws(() => ownedContainers({ docker: none.docker, runId: 'run-1', labels: [{ toString: () => 'a=b' }] }), /labels are key=value strings/);
  assert.deepEqual(none.calls, []);
});

test('an error class is read once, so a getter that changes cannot pass the allowlist and print other text', async t => {
  const id = 'b'.repeat(64);
  const changing = () => {
    let reads = 0;
    return { get name() { return ++reads === 1 ? 'Error' : `Evil\n${id} host-canary`; }, code: 'EBUSY' };
  };
  await assert.rejects(cleanUp({ failed: false }, [['fixtures.rm', () => { throw changing(); }]]),
    error => error instanceof CleanupError && error.message === 'cleanup failed: step=fixtures.rm class=Error code=EBUSY');
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  await cleanUp({ failed: true }, [['fixtures.rm', () => { throw changing(); }]]);
  reportCleanupFailure(changing(), 'browser.close');
  assert.deepEqual(lines, ['cleanup also failed after the check failed: step=fixtures.rm class=Error code=EBUSY',
    'cleanup also failed after the check failed: step=browser.close class=Error code=EBUSY']);
});

test('a name collision never inspects or removes the container that holds the name', async () => {
  const daemon = fakeDaemon(), clock = fakeClock();
  const foreign = daemon.add('compiled-alerts-gin-fixture', { 'agent.owner': 'someone-else' }, 'f'.repeat(64));
  const owned = ownedContainers({ docker: daemon.docker, runId: 'run-1', window: 1000, ...clock });
  assert.throws(() => owned.run({}, 'image', 'compiled-alerts-gin-fixture'), error => error.code === 'ERR_DOCKER_EXIT' && error.status === 125);
  const record = await owned.teardown();
  assert.equal(record.complete, false, 'an unacknowledged create is reported, not assumed absent');
  assert.equal(record.unacknowledged[0].outcome, 'unconfirmed');
  assert.deepEqual(record.failures.at(-1).code, 'ERR_CLEANUP_UNCONFIRMED');
  assert.ok(daemon.containers.has(foreign), 'the foreign container is untouched');
  assert.deepEqual([...new Set(ops(daemon.calls))], ['run', 'ps'], 'no inspect, log read or removal');
  assert.equal(daemon.calls.filter(args => args.includes('compiled-alerts-gin-fixture')).length, 1, 'the name is only ever passed to run');
});

test('a name reused after removal is never removed by name, and an ID that lost its owner label is refused', async () => {
  const daemon = fakeDaemon();
  const owned = ownedContainers({ docker: daemon.docker, runId: 'run-1' });
  const id = owned.run({}, 'image', 'compiled-alerts-gin-fixture');
  // Someone else removes it and starts a container under the same name.
  daemon.containers.delete(id);
  const foreign = daemon.add('compiled-alerts-gin-fixture', {}, 'e'.repeat(64));
  owned.remove(id);
  const record = await owned.teardown();
  assert.equal(record.complete, true);
  assert.deepEqual(record.removed, [id]);
  assert.ok(daemon.containers.has(foreign));
  assert.equal(daemon.calls.filter(args => args[0] === 'rm').length, 0, 'nothing was removed');
  assert.equal(daemon.calls.filter(args => args.includes('compiled-alerts-gin-fixture')).length, 1);
  // An ID whose owner label is not this run's is never removed, and teardown says so.
  const other = fakeDaemon();
  const second = ownedContainers({ docker: other.docker, runId: 'run-2' });
  const relabelled = second.run({}, 'image', 'n');
  other.containers.get(relabelled).labels[ownerKey] = 'someone-else';
  assert.throws(() => second.inspect(relabelled), /refusing unowned container/);
  assert.throws(() => second.remove(relabelled), /refusing unowned container/);
  const incomplete = await second.teardown();
  assert.equal(incomplete.complete, false);
  assert.ok(other.containers.has(relabelled));
  assert.equal(other.calls.filter(args => args[0] === 'rm').length, 0);
});

test('a run that failed after the daemon made its container is found by its attempt label and removed by ID', async () => {
  const daemon = fakeDaemon({ runFails: 'after-create' }), clock = fakeClock();
  const owned = ownedContainers({ docker: daemon.docker, runId: 'run-1', window: 1000, ...clock });
  assert.throws(() => owned.run({}, 'image', 'n'), error => error.code === 'ERR_DOCKER_EXIT');
  const record = await owned.teardown();
  assert.equal(record.complete, true);
  assert.equal(record.unacknowledged[0].outcome, 'removed');
  assert.equal(daemon.containers.size, 0);
  const [rmCall] = daemon.calls.filter(args => args[0] === 'rm');
  assert.match(rmCall.at(-1), /^[0-9a-f]{64}$/, 'removed by its ID');
});

// Browser, context and page stand-ins for the driver's money pass: each confirmation names no
// email, so every paired check records a money regression.
function moneyBrowser() {
  const page = { setContent: async () => {}, locator: () => ({ innerText: async () => 'Alert saved' }) };
  const context = { newPage: async () => page, close: async () => {},
    request: { post: async () => ({ status: () => 200, text: async () => '<p class="marketplace__message">Alert saved</p>' }),
      get: async () => ({ status: () => 200, text: async () => '[]' }) } };
  return { launch: async () => ({ newContext: async () => context, close: async () => {} }) };
}
const driver = (daemon, reports, overrides = {}) => checkAlerts({ app: 'gin', image: 'cb-catalog-gin', focus: 'money', docker: daemon.docker,
  browserType: moneyBrowser(), fetch: async () => ({ ok: true }), runId: 'compiled-alerts-test', dockerEvents: undefined,
  report: (error, step) => reports.push([step, error]), log: () => {}, window: 1000, ...fakeClock(), ...overrides });

test('the driver throws recorded money regressions ahead of a failed removal between sources', async () => {
  const daemon = fakeDaemon({ rmFails: 1 }), reports = [];
  await assert.rejects(driver(daemon, reports), error => error instanceof assert.AssertionError
    && error.message.includes('native money confirmation/readback regressions') && error.message.includes('gin fixture en-US 1.005'));
  // The failed removal was classified as a cleanup failure and reported; teardown removed the container.
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'cleanup');
  assert.deepEqual(reports[0][1].failures, [{ step: 'container.rm', errorClass: 'DockerCommandError', code: 'ERR_DOCKER_EXIT' }]);
  const removals = daemon.calls.filter(args => args[0] === 'rm');
  assert.equal(removals.length, 2, 'the between-source removal failed, the teardown removal succeeded');
  assert.equal(removals[0].at(-1), removals[1].at(-1));
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.calls.filter(args => args[0] === 'run').length, 1, 'the api source did not start');
  // The driver's own options become exactly this argv, with the image last after --.
  const [run] = daemon.calls.filter(args => args[0] === 'run');
  const at = run.indexOf('--cpus');
  assert.deepEqual(run.slice(0, at), ['run', '-d', '--name', 'compiled-alerts-test-gin-fixture', '--label', 'agent.owner=codex',
    '--label', 'agent.task=compiled-alerts', '--label', `${ownerKey}=compiled-alerts-test`, '--label', `${attemptKey}=compiled-alerts-test-1`]);
  const volume = run[run.indexOf('--volume') + 1], api = run.find(arg => arg.startsWith('API_BASE='));
  assert.match(volume, /compiled-alerts-.+:\/fixtures:ro$/);
  assert.match(api, /^API_BASE=http:\/\/host\.docker\.internal:\d+$/);
  assert.deepEqual(run.slice(at), ['--cpus', '1', '--memory', '512m',
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '--publish', '127.0.0.1::8080', '--volume', volume, '--env', 'PROFILE=defaults', '--env', 'ITEM_SOURCE=fixture',
    '--env', 'FIXTURE_PATH=/fixtures/items.json', '--env', 'CATALOG_SOURCE=fixture', '--env', 'MARKETPLACE_SOURCE=fixture',
    '--env', 'MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json', '--env', api, '--', 'cb-catalog-gin']);
});

test('the driver never touches a container that already holds its name', async t => {
  t.mock.method(console, 'error', () => {});
  const daemon = fakeDaemon(), reports = [];
  const foreign = daemon.add('compiled-alerts-test-gin-fixture', {}, 'f'.repeat(64));
  await assert.rejects(driver(daemon, reports), error => error instanceof DockerCommandError && error.status === 125);
  assert.ok(daemon.containers.has(foreign));
  assert.deepEqual([...new Set(ops(daemon.calls))], ['run', 'ps'], 'no inspect, log read or removal');
  assert.deepEqual(reports.map(([step, error]) => [step, error.code]), [['container.teardown', 'ERR_CLEANUP_UNCONFIRMED']]);
});

test('the upstream close adapter fails a passing check and is reported after a failed one', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // A listening server closes cleanly through cleanUp.
  await checker({ body: async () => {}, caseSteps: [], checkSteps: [['upstream.close', () => closeServer(server)]] });
  assert.equal(server.listening, false);
  // A second close reports ERR_SERVER_NOT_RUNNING to its callback, which now rejects.
  await assert.rejects(checker({ body: async () => {}, caseSteps: [], checkSteps: [['upstream.close', () => closeServer(server)]],
    report: () => assert.fail('nothing to report beside a passing check') }),
  error => error instanceof CleanupError && error.failures[0].step === 'upstream.close' && error.failures[0].code === 'ERR_SERVER_NOT_RUNNING');
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
  assert.equal(reports.length, 1, 'the cleanup failure is reported, not lost');
  assert.equal(reports[0][0], 'cleanup');
  assert.deepEqual(reports[0][1].failures, [{ step: 'money-context.close', errorClass: 'Error', code: 'other' }]);
  // The cleanup failure stays primary when nothing was recorded.
  await assert.rejects(checker({ body: async () => {}, caseSteps: [['money-context.close', () => { throw closeFailure; }]], checkSteps: [],
    report: () => assert.fail('nothing else failed') }), error => error instanceof CleanupError && error.failures[0].step === 'money-context.close');
  // A gate's own error is not a cleanup failure and stays the identical object thrown.
  const gate = new Error('page.waitForFunction: Timeout 30000ms exceeded.');
  await assert.rejects(checker({ body: () => { throw gate; }, caseSteps: [], checkSteps: [], recorded,
    report: () => assert.fail('nothing to report') }), error => error === gate);
  // With no cleanup failure the recorded assertion is the check's own failure, as before.
  await assert.rejects(checker({ body: async () => {}, caseSteps: [], checkSteps: [], recorded }),
    error => error instanceof assert.AssertionError && error.message.includes('recorded regressions'));
});

test('the checker routes every cleanup through cleanUp and surfaces recorded money regressions first', async () => {
  const source = await readFile(new URL('./check-alerts.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/finally \{/g)?.length, 3);
  // The money context and each JS case rethrow their own error and clean up with named steps.
  assert.equal(source.match(/\} catch \(error\) \{ (moneyOutcome|caseOutcome)\.failed = true; throw error; \} finally \{\s*await cleanUp\(\1, \[\s*\['[a-z.-]+', /g)?.length, 2);
  // The outer catch rethrows through recordedFirst, so recorded money regressions outrank a cleanup failure.
  assert.equal(source.match(/\} catch \(error\) \{ outcome\.failed = true; throw recordedFirst\(error, moneyFailures, moneyMessage, report\); \} finally \{\s*await cleanUp\(outcome, \[\s*\['browser\.close', /g)?.length, 1);
  assert.doesNotMatch(source, /throw error; \} finally \{\s*await cleanUp\(outcome,/);
  // The removal between sources is a cleanup step too; no container is removed or read by name.
  assert.match(source, /await cleanUp\(\{ failed: false \}, \[\['container\.rm', \(\) => owned\.remove\(id\)\]\], report\);/);
  assert.doesNotMatch(source, /docker\('rm'|\['rm',|docker\('inspect'|docker\('logs'/);
  assert.match(source, /\['upstream\.close', \(\) => closeServer\(upstream\)\]/);
  assert.doesNotMatch(source, /upstream\.close\(resolve\)/);
});
