import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = new URL('./json-http.mjs', import.meta.url);

async function probe(platform, source) {
  const require = createRequire(import.meta.url);
  const child = require('node:child_process'), fs = require('node:fs');
  const http = require('node:http'), events = require('node:events');
  const originals = [];
  const replace = (object, key, value) => {
    const original = object[key];
    originals.push(() => { object[key] = original; });
    object[key] = value;
  };
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const stop = new Error('captured native Docker arguments');
  let captured;
  const server = { listen() {}, address: () => ({ port: 53001 }), close: done => done(), closeAllConnections() {} };
  try {
    Object.defineProperty(process, 'platform', { value: platform });
    process.argv = [process.execPath, fileURLToPath(driver), 'native-drogon-image', source === 'api' ? 'before' : 'after'];
    replace(child, 'execFileSync', (command, args) => {
      assert.equal(command, 'docker');
      assert.equal(args[0], 'run', 'capture the actual first container launch');
      captured = args;
      throw stop;
    });
    for (const name of ['appendFileSync', 'mkdirSync', 'rmSync', 'writeFileSync']) replace(fs, name, () => {});
    replace(fs, 'mkdtempSync', () => '/virtual/drogon-fixture');
    replace(http, 'createServer', () => server);
    replace(events, 'once', async () => []);
    syncBuiltinESMExports();
    await assert.rejects(import(driver.href), error => error === stop);
    assert.ok(captured, 'the real driver reached Docker without starting resources');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    for (const restore of originals.reverse()) restore();
    syncBuiltinESMExports();
  }
  process.stdout.write(JSON.stringify(captured));
}

if (process.argv[2] === '--probe') {
  await probe(process.argv[3], process.argv[4]);
} else {
  for (const platform of ['linux', 'darwin', 'win32']) for (const source of ['fixture', 'api'])
    test(`actual Docker launch arguments on ${platform}/${source}`, () => {
      const args = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--probe', platform, source],
        { encoding: 'utf8', timeout: 10_000 }));
      const mappings = args.flatMap((value, index) => value === '--add-host' ? [index] : []);
      assert.equal(mappings.length, platform === 'linux' ? 1 : 0);
      if (platform === 'linux') {
        assert.equal(args[mappings[0] + 1], 'host.docker.internal:host-gateway');
        args.splice(mappings[0], 2);
      }
      args[args.indexOf('--name') + 1] = '<container>';
      assert.deepEqual(args, ['run', '-d', '--name', '<container>', '--cpus', '1',
        '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-parity-drogon',
        '-p', '127.0.0.1::8080', '-v', '/virtual/drogon-fixture:/fixtures:ro',
        '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
        '-e', `CATALOG_SOURCE=${source}`, '-e', `MARKETPLACE_SOURCE=${source}`,
        '-e', 'API_BASE=http://host.docker.internal:53001', 'native-drogon-image']);
    });
}
