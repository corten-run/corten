// Opt-in native source diagnostic, not a workload qualification or framework ranking.
// Build both revisions with the same optimized toolchain first. The manifest names a
// valgrind runtime image and before/after app directories containing server + its assets.
// Usage: node native-trace-cost.mjs MANIFEST.json OUTPUT_DIRECTORY [gin,drogon,topcoat]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { records } from '../marketplace/fixtures.mjs';

export function instructions(text) {
  return dumpInstructions(text).total;
}

export function dumpInstructions(text) {
  assert.match(text, /^events: Ir\s*$/m, 'expected callgrind Ir events only');
  assert.match(text, /^positions: line\s*$/m, 'expected line positions');
  const values = [...text.matchAll(/^summary: (\d+)\s*$/gm)];
  assert.equal(values.length, 1, 'expected one complete summary');
  const summary = Number(values[0][1]);
  assert.ok(Number.isSafeInteger(summary) && summary > 0, 'invalid summary');
  assert.equal([...text.matchAll(/^totals:/gm)].length, 1, 'expected one totals footer');
  const footer = /\ntotals: (\d+)\s*$/.exec(text);
  assert.ok(footer, 'incomplete callgrind dump: missing totals footer');
  const total = Number(footer[1]);
  assert.ok(Number.isSafeInteger(total) && total > 0, 'invalid totals');
  let self = 0, call = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('calls=')) { assert.equal(call, false); call = true; }
    const cost = /^(?:\d+|[+-]\d+|\*) (\d+)$/.exec(line);
    if (cost) { if (!call) self += Number(cost[1]); call = false; }
  }
  assert.equal(call, false, 'incomplete call edge');
  assert.ok(Number.isSafeInteger(self));
  assert.equal(self, total, 'totals must equal all exclusive Ir cost lines');
  return { summary, total, self, difference: total - summary };
}

// Resolve the child outcome immediately, even when it fails before the first
// wake request. Throwing only after awaiting it lets the caller's finally run.
export async function controlProcess(child, wake, pause = sleep, signal) {
  let done = false, error, stderr = '', wakes = 0;
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => {
    child.once('error', failure => { error = failure; done = true; resolve(); });
    child.once('exit', code => {
      if (code !== 0) error ??= new Error(stderr || `callgrind control exit ${code}`);
      done = true; resolve();
    });
  });
  try {
    for (let i = 0; !done && i < 100; i++) {
      await pause(100, undefined, { signal });
      signal?.throwIfAborted();
      if (!done) { await wake(); wakes++; }
    }
    assert.ok(done, 'callgrind control timeout');
    await exited;
    if (error) throw error;
    return wakes;
  } catch (failure) {
    error = signal?.aborted && failure?.name === 'AbortError' && failure.cause === signal.reason ? signal.reason : failure;
    throw error;
  } finally {
    if (!done) {
      child.kill('SIGKILL');
      let timer;
      try {
        await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new AggregateError([error, new Error('controller did not exit after SIGKILL')].filter(Boolean),
            'Native trace controller cleanup failed', { cause: error })), 2000);
        })]);
      } finally { clearTimeout(timer); }
    }
  }
}

export function createOwnedContainer(docker, active, name, args) {
  const token = randomUUID();
  try {
    const id = docker('create', '--name', name, '--label', 'agent.run=' + token, ...args);
    assert.match(id, /^[0-9a-f]{64}$/, 'docker create must return an immutable container ID');
    active.add(id);
    return id;
  } catch (original) {
    // A daemon may create the container before the client reports a failure.
    // A name alone (even with our usual task labels) never proves ownership.
    let container;
    try { container = JSON.parse(docker('inspect', '--format', '{{json .}}', name)); } catch {}
    if (container?.Name === '/' + name && container.Config?.Labels?.['agent.run'] === token && /^[0-9a-f]{64}$/.test(container.Id)) {
      active.add(container.Id);
    }
    throw original;
  }
}

export async function cleanupResources(active, remove, agents, upstream, original, finalizers = []) {
  const errors = [];
  const attempt = async work => { try { await work(); } catch (error) { errors.push(error); } };
  for (const name of active) await attempt(async () => { await remove(name); active.delete(name); });
  for (const agent of agents) await attempt(() => agent.destroy());
  await attempt(() => upstream.closeAllConnections());
  await attempt(() => new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())));
  for (const finalize of finalizers) await attempt(finalize);
  if (errors.length) throw new AggregateError(original === undefined ? errors : [original, ...errors],
    'Native trace cost cleanup failed', { cause: original });
}

export function summarize(values) {
  assert.ok(values.length >= 3 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
}

export function perRequest(small, large, smallN, largeN) {
  assert.ok(Number.isSafeInteger(smallN) && smallN > 0 && Number.isSafeInteger(largeN) && largeN > smallN);
  assert.ok(Number.isSafeInteger(small) && Number.isSafeInteger(large) && large > small);
  return (large - small) / (largeN - smallN);
}

export async function run() {
  const [manifestPath, outputPath, selection = 'gin,drogon,topcoat'] = process.argv.slice(2);
  assert.ok(manifestPath && outputPath, 'MANIFEST.json OUTPUT_DIRECTORY [apps] required');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const [smallN, largeN] = manifest.batches ?? [200, 1200];
  perRequest(smallN, largeN, smallN, largeN); // Validate counts before starting resources.
  const output = resolve(outputPath);
  mkdirSync(output, { recursive: true });
  assert.equal(readdirSync(output).length, 0, 'use a fresh output directory; never overwrite a receipt');
  const fixture = records();
  const bytes = JSON.stringify(fixture.item_1);
  writeFileSync(join(output, 'marketplace.json'), JSON.stringify(fixture));
  writeFileSync(join(output, 'empty.json'), '{}');
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
  const record = row => appendFileSync(join(output, 'raw.ndjson'), JSON.stringify(row) + '\n');
  const parent = '00-11111111111111111111111111111111-1111111111111111-01';
  const state = 'vendor=cost';
  let events = [];
  const upstream = createServer((req, res) => {
    events.push({ path: req.url, parent: req.headers.traceparent ?? null, state: req.headers.tracestate ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(bytes);
  });
  const agents = new Map();
  const active = new Set();
  const shutdown = new AbortController();
  const signals = new Map(['SIGINT', 'SIGTERM'].map((signal, index) => [signal, () => {
    if (!shutdown.signal.aborted) {
      process.exitCode = index === 0 ? 130 : 143;
      shutdown.abort(new Error('Native trace cost interrupted by ' + signal));
    }
  }]));
  const bodyHashes = new Map();
  async function send(base, path, traced) {
    let agent = agents.get(base);
    if (!agent) { agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.set(base, agent); }
    return new Promise((resolve, reject) => {
      const req = request(base + path, { agent, signal: shutdown.signal, headers: traced ? { traceparent: parent, tracestate: state } : {} }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(Buffer.concat(chunks));
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error('native cost request timeout')));
      req.end();
    });
  }
  // Wake an idle server while vgdb delivers the command, without granting ptrace
  // capabilities to the container. These control requests are not source reads.
  async function control(name, base, command) {
    const child = spawn('docker', ['exec', name, 'callgrind_control', command, '1']);
    return controlProcess(child, () => send(base, '/api/alerts', false), sleep, shutdown.signal);
  }
  const results = [];
  let original;
  for (const [signal, handler] of signals) process.on(signal, handler);
  try {
    await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
    shutdown.signal.throwIfAborted();
    record({ kind: 'identity', manifest, driverSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      runtimeImageId: docker('image', 'inspect', '--format', '{{.Id}}', manifest.runtimeImage),
      node: process.version, method: `callgrind Ir, (${largeN} - ${smallN}) / ${largeN - smallN} after warmup; three alternating rounds`,
      qualification: false, profile: 'defaults', workers: 1, goAsyncPreemption: false,
      fixtureSha256: createHash('sha256').update(bytes).digest('hex') });
    for (const app of selection.split(',')) {
      assert.ok(['gin', 'drogon', 'topcoat'].includes(app));
      for (const source of ['fixture', 'api']) {
        const servers = {};
        for (const version of ['before', 'after']) {
          const directory = resolve(manifest.apps[app][version]);
          const binarySha256 = createHash('sha256').update(readFileSync(join(directory, 'server'))).digest('hex');
          shutdown.signal.throwIfAborted();
          const label = `native-trace-cost-${process.pid}-${app}-${source}-${version}`;
          const prefix = `${app}-${source}-${version}`;
          const name = createOwnedContainer(docker, active, label, ['--cpus', '1', '--label', 'agent.owner=codex', '--label', 'agent.task=native-trace-cost',
            ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
            '-p', '127.0.0.1::8080', '-v', `${directory}:/app:ro`, '-v', `${output}:/counts`, '-w', '/app',
            '-e', 'PORT=8080', '-e', 'HOST=0.0.0.0', '-e', 'GIN_MODE=release', '-e', 'GOMAXPROCS=1',
            '-e', 'GODEBUG=asyncpreemptoff=1', '-e', 'TOKIO_WORKER_THREADS=1',
            '-e', 'PROFILE=defaults', '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/counts/empty.json',
            '-e', 'CATALOG_SOURCE=fixture', '-e', 'CATALOG_FIXTURE_PATH=/counts/empty.json',
            '-e', `MARKETPLACE_SOURCE=${source}`, '-e', 'MARKETPLACE_FIXTURE_PATH=/counts/marketplace.json',
            '-e', `API_BASE=http://host.docker.internal:${upstream.address().port}`,
            '--entrypoint', 'valgrind', manifest.runtimeImage, '--tool=callgrind', '--instr-atstart=no', '--cache-sim=no', '--branch-sim=no',
            `--callgrind-out-file=/counts/${prefix}.%p`, `--log-file=/counts/${prefix}.valgrind.log`, '/app/server']);
          docker('start', name);
          const base = 'http://127.0.0.1:' + docker('port', name, '8080/tcp').split(':').at(-1);
          let ready = false;
          for (let i = 0; i < 600; i++) {
            try { await send(base, '/api/alerts', false); ready = true; break; } catch {}
            shutdown.signal.throwIfAborted();
            if (docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') break;
            await sleep(100, undefined, { signal: shutdown.signal });
          }
          assert.ok(ready, `${name} failed startup: ${docker('logs', name)}`);
          await control(name, base, '--instr=on');
          record({ kind: 'binary', app, source, version, binarySha256 });
          servers[version] = { name, base, prefix };
        }
        for (let round = 0; round < 3; round++) {
          for (const version of round % 2 ? ['after', 'before'] : ['before', 'after']) {
            const { name, base, prefix } = servers[version];
            for (const [route, path] of [['json', '/api/marketplace/item_1'], ['page', '/marketplace/en-US/item_1']]) {
              const traced = source === 'api';
              for (let i = 0; i < 50; i++) await send(base, path, traced);
              const counts = [];
              for (const n of [smallN, largeN]) {
                events = [];
                const oldFiles = new Set(readdirSync(output));
                const zeroWakes = await control(name, base, '--zero');
                for (let i = 0; i < n; i++) {
                  const body = await send(base, path, traced);
                  const hash = createHash('sha256').update(body).digest('hex');
                  const key = app + '/' + route;
                  if (!bodyHashes.has(key)) bodyHashes.set(key, hash);
                  assert.equal(hash, bodyHashes.get(key), 'response bytes must match across revisions and sources');
                }
                const dumpWakes = await control(name, base, '--dump');
                const files = readdirSync(output).filter(f => f.startsWith(prefix + '.1.') && !oldFiles.has(f));
                assert.equal(files.length, 1, 'one new callgrind dump required');
                const dump = dumpInstructions(readFileSync(join(output, files[0]), 'utf8'));
                const count = dump.total;
                assert.equal(events.length, source === 'api' ? n : 0);
                for (const event of events) assert.deepEqual(event, { path: '/marketplace/records/item_1',
                  parent: version === 'after' ? parent : null, state: version === 'after' ? state : null });
                record({ kind: 'batch', app, source, version, round, route, n, count, dump, file: files[0], zeroWakes, dumpWakes,
                  bodySha256: bodyHashes.get(app + '/' + route), upstreamRequests: events.length });
                counts.push(count);
              }
              const row = { app, source, version, round, route, instructionsPerRequest: perRequest(counts[0], counts[1], smallN, largeN) };
              results.push(row); record({ kind: 'result', ...row });
              console.log(JSON.stringify(row));
            }
          }
        }
        for (const { name } of Object.values(servers)) { docker('rm', '-f', '-v', name); active.delete(name); }
      }
    }
    const summary = [];
    for (const app of selection.split(',')) for (const source of ['fixture', 'api']) for (const route of ['json', 'page']) {
      const get = version => summarize(results.filter(r => r.app === app && r.source === source && r.route === route && r.version === version).map(r => r.instructionsPerRequest));
      const before = get('before'), after = get('after');
      const delta = after.median - before.median;
      summary.push({ app, source, route, before, after, delta, percent: delta / before.median * 100,
        rangeExceedsDelta: Math.max(before.max - before.min, after.max - after.min) > Math.abs(delta) });
    }
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  } catch (error) {
    original = shutdown.signal.aborted && error?.name === 'AbortError' && error.cause === shutdown.signal.reason ? shutdown.signal.reason : error;
    throw original;
  } finally {
    try { await cleanupResources(active, name => docker('rm', '-f', '-v', name), agents.values(), upstream, original); }
    finally { for (const [signal, handler] of signals) process.off(signal, handler); }
  }
  shutdown.signal.throwIfAborted();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await run(); }
  catch (error) { console.error(error); if (!process.exitCode) process.exitCode = 1; }
}
