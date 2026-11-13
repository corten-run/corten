import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { containerBase, startupFailure, writeFixtures } from './compiled-check.mjs';

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
