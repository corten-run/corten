// Functional direct-native qualification, not a load benchmark. The unchanged
// marketplace probes supply the gates; no adapter imports this test apparatus.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { records } from '../../../marketplace/fixtures.mjs';
import { records as catalogRecords } from '../../../catalog/fixtures.mjs';
import { qualify } from '../../../marketplace/qualify.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
if (!isMainThread) {
  let control = {};
  const stats = { started: 0, completed: 0, cancelled: 0, pending: 0 };
  const fixtures = records();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/__marketplace/control') {
      const chunks = [];
      for await (const data of req) chunks.push(data);
      control = JSON.parse(Buffer.concat(chunks).toString());
      res.end('{}'); return;
    }
    if (path === '/__stats') { res.end(JSON.stringify(stats)); return; }
    stats.started++; stats.pending++;
    let finished = false;
    const finish = cancelled => {
      if (finished) return;
      finished = true;
      stats.pending--;
      stats[cancelled ? 'cancelled' : 'completed']++;
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(!res.writableFinished));
    if (control.hang) return;
    if (control.status) { res.writeHead(control.status); res.end('unavailable'); return; }
    const item = fixtures[decodeURIComponent(path.split('/').at(-1))];
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(item ? 200 : 404);
    res.end(JSON.stringify(item ?? {}));
  });
  server.listen(0, '0.0.0.0', () => parentPort.postMessage(server.address().port));
} else {
  const [image, output] = process.argv.slice(2);
  assert.ok(image && output, 'usage: node check-production.mjs IMAGE OUTPUT_DIRECTORY');
  // A fresh directory prevents replacing a previous observation with a later pass.
  await mkdir(output);
  const docker = (...args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const folder = await mkdtemp(join(tmpdir(), 'gin-production-fixtures-'));
  const worker = new Worker(new URL(import.meta.url));
  let active;
  try {
    const port = await new Promise((done, reject) => {
      worker.once('message', done); worker.once('error', reject);
    });
    const upstream = `http://127.0.0.1:${port}`;
    const json = async (path, options) => {
      const response = await fetch(upstream + path, { ...options, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const control = value => json('/__marketplace/control', { method: 'POST', body: JSON.stringify(value) });
    const stats = () => json('/__stats');
    const until = async (predicate, label) => {
      const end = Date.now() + 5000;
      do { if (await predicate()) return; await sleep(25); } while (Date.now() < end);
      assert.fail(label);
    };
    const identity = {
      image: docker('image', 'inspect', image, '--format', '{{.Id}}'),
      head: git('rev-parse', 'HEAD'), dirty: git('status', '--short'),
      scope: 'direct HTTP functional qualification only; no TLS, load or groupReady claim',
      resources: { cpus: 1, memory: '512m', maxConnections: 1000 },
    };
    await writeFile(join(output, 'identity.json'), JSON.stringify(identity, null, 2));
    await writeFile(join(folder, 'items.json'), '{}');
    await writeFile(join(folder, 'catalog.json'), JSON.stringify(catalogRecords()));
    await writeFile(join(folder, 'marketplace.json'), JSON.stringify(records()));
    for (const source of ['fixture', 'api']) {
      const name = `compiled-gin-production-${source}-${process.pid}`;
      docker('run', '-d', '--name', name, '--cpus', '1', '--memory', '512m',
        '--label', 'agent.owner=codex', '--label', 'agent.task=compiled-alerts',
        '-p', '127.0.0.1::8080', '-v', `${folder}:/fixtures:ro`,
        '-e', 'PROFILE=matched', '-e', 'HOSTS=localhost,127.0.0.1', '-e', 'MAX_CONNECTIONS=1000',
        '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
        '-e', 'CATALOG_SOURCE=fixture', '-e', `MARKETPLACE_SOURCE=${source}`,
        '-e', 'MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json',
        '-e', `API_BASE=http://host.docker.internal:${port}`, image);
      active = name;
      const binding = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['8080/tcp'][0];
      const base = `http://127.0.0.1:${binding.HostPort}`;
      await until(async () => { try { return (await fetch(base + '/health/live')).status === 200; } catch { return false; } }, 'native startup failed');
      const qualification = await qualify({ base, source, upstream });
      await writeFile(join(output, `${source}-qualification.json`), JSON.stringify(qualification, null, 2));
      console.log(`${source}: eligible=${qualification.eligible} missing=${qualification.missing.join(',') || 'none'}`);
      assert.equal(qualification.eligible, true, `${source}: ${qualification.missing}`);
      if (source === 'api') {
        await until(async () => (await stats()).pending === 0, 'deadline left native upstream pending');
        const before = await stats();
        assert.ok(before.cancelled >= 1, 'actual source deadline must close upstream');
        const page = base + '/marketplace/en-US/item_1';
        const body = 'email=native%40example.test&target_price=1.23';
        const accepted = await fetch(page, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        assert.equal(accepted.status, 200);
        const cookie = accepted.headers.get('set-cookie').split(';')[0];
        await accepted.arrayBuffer();
        const read = async () => {
          const result = await fetch(base + '/api/alerts', { headers: { cookie } });
          assert.equal(result.status, 200); return result.json();
        };
        const expected = [{ item_id: 'item_1', email: 'native@example.test', target_minor: 123 }];
        assert.deepEqual(await read(), expected);
        const aborts = [];
        for (const method of ['GET', 'POST']) {
          await control({ hang: true });
          const start = await stats();
          const pending = request(page, { method, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
          pending.on('error', () => {});
          pending.end(method === 'POST' ? body : undefined);
          try {
            await until(async () => (await stats()).started > start.started, 'native source request never started');
          } finally { pending.destroy(); }
          await until(async () => { const now = await stats(); return now.cancelled > start.cancelled && now.pending === 0; }, 'native caller abort left upstream pending');
          assert.deepEqual(await read(), expected, 'aborted source work must not append');
          assert.equal((await fetch(base + '/health/live')).status, 200, 'liveness depended on source');
          aborts.push({ method, before: start, after: await stats() });
        }
        await control({});
        await writeFile(join(output, 'api-cleanup.json'), JSON.stringify({ deadline: before, aborts, readback: await read() }, null, 2));
        console.log('api: real GET/POST aborts closed upstream; deadline cleanup and same-cookie alert readback passed');
      }
      await writeFile(join(output, `${source}-container.log`), docker('logs', name));
      docker('rm', '-f', '-v', name); active = undefined;
    }
    await writeFile(join(output, 'exit-code.txt'), '0\n');
  } catch (error) {
    await writeFile(join(output, 'failure.txt'), String(error.stack ?? error));
    if (active) await writeFile(join(output, 'failed-container.log'), docker('logs', active));
    throw error;
  } finally {
    if (active) docker('rm', '-f', '-v', active);
    await worker.terminate();
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    await rm(folder, { recursive: true, force: true });
  }
}
