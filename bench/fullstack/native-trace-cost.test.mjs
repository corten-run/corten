import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { Agent, createServer, request } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { cleanupResources, controlProcess, createOwnedContainer, dumpInstructions, instructions, perRequest, summarize } from './native-trace-cost.mjs';

const dump = 'positions: line\nevents: Ir\nsummary: 12345\nfn=(1) handler\n0 10000\ncalls=1 0\n0 99999\n+1 2345\ntotals: 12345\n';

test('requires a complete Ir dump and verifies exclusive costs against its footer', () => {
  assert.equal(instructions(dump), 12345);
  for (const text of ['', 'events: Ir\nsummary: 12345\n', dump.replace('events: Ir', 'events: Ir Dr'),
    dump.replace('summary: 12345', 'summary: 0'), dump.replace('summary: 12345', 'summary: 999999999999999999'),
    dump.replace('totals: 12345', 'totals: 1'), dump.replace('totals: 12345', ''), dump + 'summary: 12345\n']) {
    assert.throws(() => instructions(text));
  }
  assert.deepEqual(dumpInstructions(dump.replace('summary: 12345', 'summary: 12000')),
    { summary: 12000, total: 12345, self: 12345, difference: 345 });
});

test('subtracts two counted batches without rounding away overhead', () => {
  assert.equal(perRequest(2000, 12001, 200, 1200), 10.001);
  assert.throws(() => perRequest(1200, 200, 200, 1200));
  assert.throws(() => perRequest(200, 1200, 1200, 200));
  assert.deepEqual(summarize([11, 9, 10]), { median: 10, min: 9, max: 11 });
  assert.throws(() => summarize([1, NaN, 3]));
});

function child() {
  const result = new EventEmitter();
  result.stdout = new PassThrough(); result.stderr = new PassThrough();
  result.killed = false;
  result.kill = () => { result.killed = true; result.emit('exit', 1); };
  return result;
}

test('controller failure before waking is awaited and reaches caller cleanup', async () => {
  for (const event of ['error', 'exit']) {
    const process = child();
    let cleaned = false;
    queueMicrotask(() => event === 'error' ? process.emit('error', new Error('spawn failed')) : process.emit('exit', 1));
    await assert.rejects(async () => {
      try { await controlProcess(process, () => assert.fail('must not wake after exit')); }
      finally { cleaned = true; }
    }, /spawn failed|control exit 1/);
    assert.equal(cleaned, true);
  }
});

test('wake failure terminates and awaits the controller before propagating', async () => {
  const process = child();
  await assert.rejects(controlProcess(process, () => { throw new Error('wake failed'); }, async () => {}), /wake failed/);
  assert.equal(process.killed, true);
});

test('an unresponsive controller has a bounded kill wait and retains the interruption', async () => {
  const process = child(), shutdown = new AbortController(), original = new Error('SIGTERM interruption');
  process.kill = signal => { assert.equal(signal, 'SIGKILL'); return true; };
  shutdown.abort(original);
  await assert.rejects(controlProcess(process, () => assert.fail('must not wake'), async () => {}, shutdown.signal), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, original);
    assert.equal(error.errors[0], original);
    assert.match(error.errors[1].message, /did not exit after SIGKILL/);
    return true;
  });
});

test('driver attempts both container removals and retains the original controller failure', async () => {
  const fixture = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import http from 'node:http';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { syncBuiltinESMExports } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const read = fs.readFileSync, create = http.createServer;
    const app = create((req, res) => res.end('same body'));
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const servers = [app], live = new Set(), removals = [];
    let controls = 0;
    const manifest = { runtimeImage: 'mock', apps: { gin: { before: 'virtual-before', after: 'virtual-after' } } };
    fs.readFileSync = (path, ...args) => String(path) === '/virtual/manifest.json' ? JSON.stringify(manifest)
      : /[\\\\/]server$/.test(String(path)) ? Buffer.from('binary') : read(path, ...args);
    fs.mkdirSync = () => {}; fs.readdirSync = () => [];
    fs.writeFileSync = () => {}; fs.appendFileSync = () => {};
    http.createServer = (...args) => { const server = create(...args); servers.push(server); return server; };
    cp.execFileSync = (file, args) => {
      assert.equal(file, 'docker');
      if (args[0] === 'image') return 'id';
      if (args[0] === 'create') { const id = (live.size + 1).toString(16).padStart(64, '0'); live.add(id); return id; }
      if (args[0] === 'start') return args[1];
      if (args[0] === 'port') return '127.0.0.1:' + app.address().port;
      if (args[0] === 'logs') return '';
      if (args[0] === 'rm') {
        const name = args.at(-1); removals.push(name);
        if (removals.length === 1) throw new Error('first removal failed');
        live.delete(name); return name;
      }
      throw new Error('unexpected docker call ' + args);
    };
    cp.spawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('exit', 1);
      const index = ++controls;
      queueMicrotask(() => index <= 2 ? child.emit('exit', 0) : child.emit('error', new Error('original controller failure')));
      return child;
    };
    syncBuiltinESMExports();
    const target = ${JSON.stringify(new URL('./native-trace-cost.mjs', import.meta.url).href)};
    process.argv = [process.execPath, 'fixture', '/virtual/manifest.json', '/virtual/output', 'gin'];
    try {
      const { run } = await import(target);
      await assert.rejects(run(), error => {
        assert.equal(removals.length, 2, 'every started container needs a removal attempt');
        assert.equal(live.size, 1, 'only the deliberately failed removal may remain');
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause.message, 'original controller failure');
        assert.deepEqual(error.errors.map(error => error.message), ['original controller failure', 'first removal failed']);
        assert.equal(servers[1].listening, false, 'upstream must close despite removal errors');
        return true;
      });
    } finally {
      for (const server of servers) if (server.listening) {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
    }
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', fixture], { timeout: 15_000 });
});

test('cleanup aggregates every removal and local-resource error', async () => {
  const active = new Set(['before', 'after']), attempted = [];
  const remove = name => { attempted.push(name); throw new Error(name); };
  const agents = [{ destroy() { attempted.push('agent'); throw new Error('agent'); } }];
  const upstream = {
    closeAllConnections() { attempted.push('connections'); throw new Error('connections'); },
    close(done) { attempted.push('server'); done(new Error('server')); },
  };
  await assert.rejects(cleanupResources(active, remove, agents, upstream), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(error => error.message), ['before', 'after', 'agent', 'connections', 'server']);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(attempted, ['before', 'after', 'agent', 'connections', 'server']);
  assert.deepEqual([...active], ['before', 'after']);
});

test('successful cleanup leaves the original failure unchanged', async () => {
  const original = new Error('operation failed'), active = new Set(['before', 'after']), removed = [];
  const upstream = { closeAllConnections() {}, close(done) { done(); } };
  await assert.rejects(async () => {
    try { throw original; }
    finally { await cleanupResources(active, name => removed.push(name), [], upstream, original); }
  }, error => error === original);
  assert.deepEqual(removed, ['before', 'after']);
  assert.equal(active.size, 0);
});

test('native Docker cleanup controls remove both containers and close live HTTP resources',
  { skip: process.env.NATIVE_TRACE_COST_CLEANUP !== '1', timeout: 120_000 }, async () => {
    const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    docker('image', 'inspect', 'alpine:3'); // Local image only; never pull a test prerequisite.
    for (const failFirst of [false, true]) {
      const names = ['before', 'after'].map(version => `native-cost-cleanup-${process.pid}-${Number(failFirst)}-${version}`);
      const active = new Set(), server = createServer((req, res) => res.end('ready'));
      const agent = new Agent({ keepAlive: true });
      const removed = [], ids = [], original = new Error('native control operation failed');
      try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await new Promise((resolve, reject) => {
          const req = request(`http://127.0.0.1:${server.address().port}`, { agent }, res => {
            res.resume(); res.on('error', reject); res.on('end', resolve);
          }); req.on('error', reject); req.end();
        });
        const sockets = Object.values(agent.freeSockets).flat();
        assert.equal(sockets.length, 1, 'control must retain a real keep-alive socket');
        const closed = Promise.all(sockets.map(socket => once(socket, 'close')));
        for (const name of names) {
          const id = createOwnedContainer(docker, active, name, ['--pull=never', '--network', 'none',
            '--label', 'agent.owner=codex', '--label', 'agent.task=native-trace-cost-cleanup-test', 'alpine:3', 'sleep', '120']);
          ids.push(id); docker('start', id);
        }
        const cleanup = cleanupResources(active, name => {
          removed.push(name);
          if (failFirst && name === ids[0]) throw new Error('injected first removal failure');
          docker('rm', '-f', '-v', name);
        }, [agent], server, original);
        if (failFirst) await assert.rejects(cleanup, error => {
          assert.equal(error.cause, original);
          assert.deepEqual(error.errors.map(error => error.message), [original.message, 'injected first removal failure']);
          return true;
        });
        else await cleanup;
        await closed;
        assert.deepEqual(removed, ids);
        assert.equal(server.listening, false);
        assert.equal(Object.values(agent.freeSockets).flat().length, 0);
        assert.deepEqual([...active], failFirst ? [ids[0]] : []);
        const remaining = docker('ps', '-a', '--no-trunc', '--format', '{{.ID}}').split(/\r?\n/).filter(id => ids.includes(id));
        assert.deepEqual(remaining, failFirst ? [ids[0]] : []);
      } finally {
        const errors = [];
        for (const name of active) try { docker('rm', '-f', '-v', name); } catch (error) { errors.push(error); }
        agent.destroy(); server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        if (errors.length) throw new AggregateError(errors, 'Native cleanup control teardown failed');
      }
    }
  });
