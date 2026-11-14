import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");

test("runner retains native startup and browser errors without promoting missing failure artifacts", () => {
  const round = `c${Date.now()}${process.pid}`;
  const folder = join(here, "results", round);
  const scratch = mkdtempSync(join(tmpdir(), "catalog-runner-errors-"));
  const hook = join(scratch, "docker.mjs");
  // Exercise the real runner's artifacts, gating and cleanup with external commands
  // and readiness replaced. No fake negative receipt makes the browser assertion pass.
  writeFileSync(hook, `
import cp from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { records } from ${JSON.stringify(pathToFileURL(join(here, "fixtures.mjs")).href)};
const spawn = cp.spawn, read = fs.readFileSync, containers = new Map();
const imageId = 'sha256:' + 'a'.repeat(64);
let network, runId;
fs.readFileSync = (path, ...args) => String(path).replaceAll('\\\\', '/').endsWith('/bench/catalog/fixtures/catalog.json') ? Buffer.from(JSON.stringify(records())) : read(path, ...args);
globalThis.fetch = async () => ({ status: 200, ok: true, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) });
const info = name => {
  const row = containers.get(name), running = row.source !== 'fixture' && !name.endsWith('-check');
  return { Id: name, Image: imageId, Path: 'node', Args: [], RestartCount: 0, Mounts: [],
    State: { Running: running, Status: running ? 'running' : 'exited', ExitCode: running ? 0 : 1 },
    Config: { Labels: { 'run.corten.catalog': runId }, Env: [], Entrypoint: null, Cmd: [] }, HostConfig: {},
    NetworkSettings: { Networks: { [network]: {} }, Ports: running ? { '8080/tcp': [{ HostPort: '18480' }] } : {} } };
};
cp.spawn = (binary, args, options) => {
  if (!['docker', 'git'].includes(binary)) return spawn(binary, args, options);
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  queueMicrotask(() => {
    let output = '', error = '', code = 0;
    if (binary === 'git') {
      if (args[0] === 'rev-parse') output = 'b'.repeat(40);
      else if (args[0] !== 'status') throw Error('unhandled fake Git command');
    } else if (args[0] === 'version') output = 'test';
    else if (args[0] === 'image') output = JSON.stringify([{ Id: imageId, Size: 1, Config: { Entrypoint: null, Cmd: [] } }]);
    else if (args[0] === 'network') {
      if (args[1] === 'create') { network = args.at(-1); runId = network.slice(0, -4); }
      else if (args[1] === 'ls') output = network ? network : '';
      else if (args[1] === 'inspect') output = JSON.stringify([{ Id: network, Labels: { 'run.corten.catalog': runId } }]);
      else if (args[1] === 'rm') network = null;
    } else if (['run', 'create'].includes(args[0])) {
      const name = args[args.indexOf('--name') + 1];
      containers.set(name, { source: args.find(a => a.startsWith('CATALOG_SOURCE='))?.split('=')[1] }); output = name;
    } else if (args[0] === 'inspect') output = JSON.stringify([info(args[1])]);
    else if (args[0] === 'start') { code = 1; error = 'AssertionError: desktop-light js=false record_1: article styles at 0'; }
    else if (args[0] === 'logs') { if (containers.get(args[1]).source === 'fixture') error = 'open /fixtures/catalog.json: permission denied'; }
    else if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      output = [...containers.keys()].filter(name => !filter.startsWith('name=') || filter === 'name=^/' + name + '$').join('\\n');
    } else if (args[0] === 'rm') containers.delete(args.at(-1));
    else throw Error('unhandled fake Docker command: ' + args.join(' '));
    child.stdout.end(output); child.stderr.end(error); child.exitCode = code; child.signalCode = null; child.emit('close', code, null);
  }); return child;
};
syncBuiltinESMExports();
`);
  try {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, join(here, "run.mjs"), round, "--apps", "gin", "--check-only"], {
      cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"));
    const failure = (source) => {
      const found = summary.failures.find((f) => f.app === "gin" && f.source === source && f.stage === "checks");
      assert.ok(found, JSON.stringify(summary.failures)); return found.error;
    };
    assert.match(failure("api"), /AssertionError: desktop-light js=false record_1: article styles at 0\nFailed-check evidence unavailable or invalid: ENOENT/);
    assert.match(failure("fixture"), /native startup failed.*\nopen \/fixtures\/catalog.json: permission denied/);
    assert.equal(summary.complete, false); assert.equal(summary.checksPassed, false);
    assert.deepEqual(summary.apps.gin.checks, {}); assert.deepEqual(summary.apps.gin.runs, {});
    assert.deepEqual(summary.cleanupFailures, []);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "cleanup.json"), "utf8")), { runId: summary.runId, containers: [], networks: [] });
  } finally {
    assert.equal(dirname(folder), join(here, "results")); rmSync(folder, { recursive: true, force: true });
    assert.equal(dirname(scratch), tmpdir()); rmSync(scratch, { recursive: true, force: true });
  }
});
