import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { upstreamImage } from "./raw.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");

for (const [index, mode] of ["cached", "absent", "wrong platform", "daemon error", "registry error", "start error", "prepare timeout",
  "app start stall", "app logs stall"].entries()) {
  test(`runner upstream image: ${mode}`, () => run(mode, index));
}

// A real local client stands in for one Docker command: the deadline is shortened, but the
// runner's own helper, receipt and cleanup run unchanged.
const stalls = {
  "app start stall": { command: "run", source: "fixture", receipt: "fixture/gin/app-start.failure.json", stage: "checks",
    script: (name) => `console.log(${JSON.stringify(name)});setInterval(()=>{},1000)` },
  "app logs stall": { command: "logs", source: "api", receipt: "api/gin/app.log.failure.json", stage: "app logs",
    script: () => "process.stdout.write('[GIN] 200 | GET /catalog/record_1\\n'.repeat(2000));setInterval(()=>{},1000)" },
};

function run(mode, index) {
  const round = `c${Date.now()}${process.pid}${index}`;
  const folder = join(here, "results", round);
  const scratch = mkdtempSync(join(tmpdir(), "catalog-runner-errors-"));
  const hook = join(scratch, "docker.mjs");
  const timers = join(scratch, "upstream-timers.json");
  const journal = join(scratch, "docker-journal.json");
  const stall = stalls[mode];
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
const upstreamImage = ${JSON.stringify(upstreamImage)}, mode = ${JSON.stringify(mode)};
const stall = ${JSON.stringify(stall ? { command: stall.command, source: stall.source } : null)};
const stallScript = ${stall ? stall.script.toString() : "null"};
const journal = [], stallDeadlines = [];
let stalled = false, stallTimer = false;
const localPlatform = mode === 'wrong platform' ? 'linux/arm64' : ['absent', 'registry error'].includes(mode) ? null : 'linux/amd64';
const deadlines = [], setTimer = globalThis.setTimeout;
let upstreamCommand;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (stallTimer) { stallDeadlines.push(ms); ms = 1500; stallTimer = false; }
  if (upstreamCommand) {
    deadlines.push([upstreamCommand, ms]);
    if (upstreamCommand === 'create' && mode === 'prepare timeout') ms = 100;
    upstreamCommand = undefined;
  }
  return setTimer(callback, ms, ...args);
};
process.on('exit', () => {
  fs.writeFileSync(${JSON.stringify(timers)}, JSON.stringify(deadlines));
  fs.writeFileSync(${JSON.stringify(journal)}, JSON.stringify({ journal, stallDeadlines }));
});
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
  if (binary === 'docker') journal.push(args);
  if (stall && !stalled && binary === 'docker' && args[0] === stall.command) {
    const name = stall.command === 'run' ? args[2] : args[1];
    const source = stall.command === 'run' ? args.find(a => a.startsWith('CATALOG_SOURCE='))?.split('=')[1] : containers.get(name)?.source;
    if (name === runId + '-gin' && source === stall.source) {
      stalled = true; stallTimer = true;
      if (stall.command === 'run') containers.set(name, { source }); // The daemon created it; its client stalls.
      return spawn(process.execPath, ['-e', stallScript(name)], options);
    }
  }
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  if (binary === 'docker' && ['create', 'start', 'run'].includes(args[0]) && args.includes(runId + '-upstream')) upstreamCommand = args[0];
  if (upstreamCommand === 'create' && mode === 'prepare timeout') {
    containers.set(runId + '-upstream', {}); // The daemon created it, but its client stalls.
    return spawn(process.execPath, ['-e', 'setTimeout(() => console.log("uninterrupted client exit"), 5000)'], options);
  }
  queueMicrotask(() => {
    let output = '', error = '', code = 0;
    if (binary === 'git') {
      if (args[0] === 'rev-parse') output = 'b'.repeat(40);
      else if (args[0] !== 'status') throw Error('unhandled fake Git command');
    } else if (args[0] === 'version') output = 'test';
    else if (args[0] === 'image' && args[1] === 'inspect') {
      output = JSON.stringify([{ Id: imageId, Size: 1, Config: { Entrypoint: null, Cmd: [] } }]);
      if (args[2] === upstreamImage) { code = 1; error = 'unexpected separate image lookup'; }
    } else if (args[0] === 'network') {
      if (args[1] === 'create') { network = args.at(-1); runId = network.slice(0, -4); }
      else if (args[1] === 'ls') output = network ? network : '';
      else if (args[1] === 'inspect') output = JSON.stringify([{ Id: network, Labels: { 'run.corten.catalog': runId } }]);
      else if (args[1] === 'rm') network = null;
    } else if (['run', 'create'].includes(args[0])) {
      const name = args[args.indexOf('--name') + 1];
      containers.set(name, { source: args.find(a => a.startsWith('CATALOG_SOURCE='))?.split('=')[1] }); output = name;
      if (name.endsWith('-upstream')) {
        const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : process.env.DOCKER_DEFAULT_PLATFORM;
        if (args[0] !== 'create' || !args.includes('--pull=missing') || !args.includes(upstreamImage)
            || args[args.indexOf('--network') + 1] !== network || !args.includes('run.corten.catalog=' + runId)) {
          code = 1; error = 'expected owned platform-aware create of the pinned upstream';
        } else if (mode === 'daemon error') {
          code = 1; error = 'daemon lost the create response'; // Created, but not acknowledged.
        } else if (localPlatform !== platform) {
          if (mode === 'registry error') { containers.delete(name); code = 1; error = 'registry denied the pinned image pull'; }
          else error = 'pulled pin for ' + platform;
        }
      }
    } else if (args[0] === 'inspect') output = JSON.stringify([info(args.at(-1))]);
    else if (args[0] === 'events') {
      const name = args[args.indexOf('--filter') + 1].slice('container='.length);
      output = JSON.stringify({ status: 'create', id: name, Actor: { Attributes: { name } }, time: Math.floor(Number(args[2])) + 60 });
    }
    else if (args[0] === 'start' && args[1] === runId + '-upstream' && containers.has(args[1])) {
      if (mode === 'start error') { code = 1; error = 'failed to start upstream process'; }
    } else if (args[0] === 'start') { code = 1; error = 'AssertionError: desktop-light js=false record_1: article styles at 0'; }
    else if (args[0] === 'logs') { if (containers.get(args[1]).source === 'fixture') error = 'open /fixtures/catalog.json: permission denied'; }
    else if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      output = [...containers.keys()].filter(name => !filter.startsWith('name=') || filter === 'name=^/' + name + '$').join('\\n');
    } else if (args[0] === 'rm') containers.delete(args.at(-1));
    else throw Error('unhandled fake Docker command: ' + args.join(' '));
    child.stdout.end(output); child.stderr.end(error); child.exitCode = code; child.signalCode = null; child.emit('close', code, null);
  });
  return child;
};
syncBuiltinESMExports();
`);
  try {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, join(here, "run.mjs"), round, "--apps", "gin", "--check-only"], {
      cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, DOCKER_DEFAULT_PLATFORM: "linux/amd64" },
    });
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"));
    const createFailed = ["daemon error", "registry error", "prepare timeout"].includes(mode);
    assert.deepEqual(JSON.parse(readFileSync(timers, "utf8")), createFailed ? [["create", 600000]] : [["create", 600000], ["start", 30000]]);
    const preparation = readFileSync(join(folder, "prepare-upstream.log"), "utf8");
    assert.equal(summary.complete, false);
    assert.deepEqual(summary.apps.gin.checks, {}); assert.deepEqual(summary.apps.gin.runs, {});
    assert.deepEqual(summary.cleanupFailures, []);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "cleanup.json"), "utf8")), { runId: summary.runId, containers: [], networks: [] });
    if (createFailed || mode === "start error") {
      assert.equal(summary.failures.length, 1);
      assert.equal(summary.failures[0].stage, createFailed ? "upstream preparation" : "upstream startup");
      const nativeError = { "daemon error": /daemon lost the create response/, "registry error": /registry denied the pinned image pull/,
        "prepare timeout": /timeout after 600000 ms/, "start error": /failed to start upstream process/ }[mode];
      assert.match(summary.failures[0].error, nativeError);
      if (mode === "prepare timeout") assert.doesNotMatch(preparation, /uninterrupted client exit/);
      if (createFailed && mode !== "prepare timeout") assert.match(preparation, nativeError);
      assert.equal(summary.tools, undefined);
      return;
    }
    if (mode === "cached" || stall) assert.doesNotMatch(preparation, /pulled pin/);
    else assert.match(preparation, /pulled pin for linux\/amd64/);
    assert.equal(summary.tools.upstream.image, upstreamImage);
    const failure = (source) => {
      const found = summary.failures.find((f) => f.app === "gin" && f.source === source && f.stage === "checks");
      assert.ok(found, JSON.stringify(summary.failures)); return found.error;
    };
    assert.match(failure("api"), /AssertionError: desktop-light js=false record_1: article styles at 0\nFailed-check evidence unavailable or invalid: ENOENT/);
    if (stall?.command !== "run") assert.match(failure("fixture"), /native startup failed.*\nopen \/fixtures\/catalog.json: permission denied/);
    assert.equal(summary.checksPassed, false);
    if (stall) verifyStall(stall, summary, folder, JSON.parse(readFileSync(journal, "utf8")));
  } finally {
    assert.equal(dirname(folder), join(here, "results")); rmSync(folder, { recursive: true, force: true });
    assert.equal(dirname(scratch), tmpdir()); rmSync(scratch, { recursive: true, force: true });
  }
}

function verifyStall(stall, summary, folder, { journal, stallDeadlines }) {
  const name = `${summary.runId}-gin`;
  assert.deepEqual(stallDeadlines, [30000], "the runner keeps its 30-second command bound");
  const found = summary.failures.filter((f) => f.app === "gin" && f.source === stall.source && f.stage === stall.stage);
  assert.equal(found.length, 1, JSON.stringify(summary.failures));
  assert.match(found[0].error, new RegExp(`docker ${stall.command} --name|docker logs ${name}`));
  // The fake shortens only the timer; the runner still reports its configured bound.
  assert.match(found[0].error, /timeout after 30000 ms/);
  const receipt = JSON.parse(readFileSync(join(folder, stall.receipt), "utf8"));
  assert.equal(receipt.schema, "catalog-command-failure/v1");
  assert.equal(receipt.container, name);
  assert.deepEqual(receipt.exit, { code: receipt.exit.code, signal: receipt.exit.signal, expired: true, interrupted: false });
  const life = receipt.lifetime;
  assert.equal(life.command[0], "docker"); assert.equal(life.timeoutMs, 30000); assert.equal(life.stopped, "deadline");
  assert.ok(life.stdout.bytes > 0 && life.stdout.firstMs !== null && life.stdout.lastMs <= life.stoppedMs, "output preceded the stall");
  assert.ok(life.stoppedMs >= 1400 && life.exitMs >= life.stoppedMs && life.closeMs >= life.exitMs, "the client ran until stopped");
  assert.ok(life.settledMs >= life.closeMs);
  assert.deepEqual(receipt.diagnosticErrors, []);
  assert.equal(receipt.inspect.owned, true); assert.equal(typeof receipt.inspect.state.Running, "boolean");
  assert.equal(receipt.events.total, 1); assert.equal(receipt.events.recent[0].id, name);
  if (stall.command === "logs") {
    const bytes = readFileSync(join(folder, "api/gin/app.log"));
    assert.ok(bytes.length > 0);
    assert.deepEqual(life.file, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    assert.equal(life.stdout.bytes, bytes.length);
  } else assert.equal(life.file, null);
  // The receipt is taken while the container still exists, before owned cleanup removes it.
  // Both sources reuse the app name, so look for the removal that follows the probes.
  const find = (from, match) => { const i = journal.slice(from).findIndex(match); return i < 0 ? -1 : from + i; };
  const state = find(0, (args) => ["inspect", "--type", "container", name].every((arg, i) => args[i] === arg));
  const events = find(0, (args) => args[0] === "events" && args.includes(`container=${name}`));
  const removal = find(Math.max(state, events), (args) => args[0] === "rm" && args.at(-1) === name);
  assert.ok(state >= 0 && events >= 0 && removal > Math.max(state, events), JSON.stringify(journal));
  assert.equal(journal.filter((args) => args[0] === "events").length, 1, "exactly one receipt was taken");
}
