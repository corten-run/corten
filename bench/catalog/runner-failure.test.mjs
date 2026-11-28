import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { upstreamImage } from "./raw.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
// The fake daemon's immutable container ID for a name.
const idOf = (name) => createHash("sha256").update(name).digest("hex");

for (const [index, mode] of ["cached", "absent", "wrong platform", "daemon error", "registry error", "start error", "prepare timeout",
  "app start stall", "app start held", "app logs stall", "app logs receipt unwritable", "startup logs stall twice", "app logs replaced"].entries()) {
  test(`runner upstream image: ${mode}`, () => run(mode, index));
}

test("upstream logs take the same single ownership check as every other log collection", () => {
  const source = readFileSync(join(here, "run.mjs"), "utf8");
  assert.ok(source.includes('try { await collectLogs(upstreamName, join(folder, "upstream.log"), "upstream logs", { cleanup: true }); }'));
  assert.doesNotMatch(source, /inspect\(upstreamName, true\)/, "no separate refusal before the receipt path");
});

// A real local client stands in for one Docker command: the deadline is shortened, but the
// runner's own helper, receipt and cleanup run unchanged. `at` lists which of the matching
// commands stall, counted from zero.
const logsStall = { command: "logs", source: "api", receipt: "api/gin/app.log.failure.json", stage: "app logs", ms: 1500, at: [0],
  script: (name, pidFile, n) => `process.stdout.write('[GIN] ${n} 200 | GET /catalog/record_1\\n'.repeat(2000));setInterval(()=>{},1000)` };
const stalls = {
  "app start stall": { command: "run", source: "fixture", receipt: "fixture/gin/app-start.failure.json", stage: "checks", ms: 1500, at: [0],
    script: (name) => `console.log(${JSON.stringify(name)});setInterval(()=>{},1000)` },
  // The client prints the ID and exits 0, but a detached process it started still holds its pipes.
  "app start held": { command: "run", source: "fixture", receipt: "fixture/gin/app-start.failure.json", stage: "checks", ms: 2500, held: true, at: [0],
    script: (name, pidFile) => {
      const holder = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},30000)`;
      return `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{detached:true,stdio:['ignore','inherit','inherit']});c.unref();console.log(${JSON.stringify(name)})`;
    } },
  "app logs stall": logsStall,
  // Neither the receipt nor its log line can be written; the original failure must survive.
  "app logs receipt unwritable": { ...logsStall, unwritable: true },
  // Both sources' apps stop after starting, and both startup log collections stall. The app
  // logs collected in between (the second matching command) do not.
  "startup logs stall twice": { ...logsStall, source: null, stage: "checks", startup: true, at: [0, 2] },
  // While the logs of container A stall, A is removed and B takes its name and this run's label.
  "app logs replaced": { ...logsStall, replace: true },
};

function run(mode, index) {
  const round = `c${Date.now()}${process.pid}${index}`;
  const folder = join(here, "results", round);
  const scratch = mkdtempSync(join(tmpdir(), "catalog-runner-errors-"));
  const hook = join(scratch, "docker.mjs");
  const timers = join(scratch, "upstream-timers.json");
  const journal = join(scratch, "docker-journal.json");
  const holder = join(scratch, "holder.pid");
  const stall = stalls[mode];
  // Exercise the real runner's artifacts, gating and cleanup with external commands
  // and readiness replaced. No fake negative receipt makes the browser assertion pass.
  writeFileSync(hook, `
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { records } from ${JSON.stringify(pathToFileURL(join(here, "fixtures.mjs")).href)};
const spawn = cp.spawn, read = fs.readFileSync, write = fs.writeFileSync, append = fs.appendFileSync, containers = new Map();
const imageId = 'sha256:' + 'a'.repeat(64);
const upstreamImage = ${JSON.stringify(upstreamImage)}, mode = ${JSON.stringify(mode)};
const stall = ${JSON.stringify(stall ? { command: stall.command, source: stall.source, ms: stall.ms, at: stall.at, startup: !!stall.startup, unwritable: !!stall.unwritable,
  replace: !!stall.replace } : null)};
const stallScript = ${stall ? stall.script.toString() : "null"};
const holder = ${JSON.stringify(holder)};
const journal = [], stallDeadlines = [];
let matched = 0, stallTimer = false;
// A replaced container keeps its name but gets a new immutable ID.
const idOf = name => createHash('sha256').update(name + (containers.get(name)?.replaced ? '#replaced' : '')).digest('hex');
// Docker resolves a container by its name or its ID.
const resolve = key => containers.has(key) ? key : [...containers.keys()].find(name => idOf(name) === key);
const localPlatform = mode === 'wrong platform' ? 'linux/arm64' : ['absent', 'registry error'].includes(mode) ? null : 'linux/amd64';
const deadlines = [], setTimer = globalThis.setTimeout;
let upstreamCommand;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (stallTimer) { stallDeadlines.push(ms); ms = stall.ms; stallTimer = false; }
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
if (stall?.unwritable) {
  const denied = () => Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
  fs.writeFileSync = (path, ...args) => { if (String(path).endsWith('.failure.json')) throw denied(); return write(path, ...args); };
  fs.appendFileSync = (path, data, ...args) => { if (String(data).includes('failure receipt')) throw denied(); return append(path, data, ...args); };
}
globalThis.fetch = async () => ({ status: 200, ok: true, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) });
const info = name => {
  const row = containers.get(name), running = row.source !== 'fixture' && !name.endsWith('-check') && !(stall?.startup && name.endsWith('-gin'));
  return { Id: idOf(name), Name: '/' + name, Image: imageId, Path: 'node', Args: [], RestartCount: 0, Mounts: [],
    State: { Running: running, Status: running ? 'running' : 'exited', ExitCode: running ? 0 : 1 },
    Config: { Labels: { 'run.corten.catalog': runId }, Env: [], Entrypoint: null, Cmd: [] }, HostConfig: {},
    NetworkSettings: { Networks: { [network]: {} }, Ports: running ? { '8080/tcp': [{ HostPort: '18480' }] } : {} } };
};
cp.spawn = (binary, args, options) => {
  if (!['docker', 'git'].includes(binary)) return spawn(binary, args, options);
  if (binary === 'docker') journal.push(args);
  if (stall && binary === 'docker' && args[0] === stall.command) {
    const name = stall.command === 'run' ? args[2] : resolve(args[1]);
    const source = stall.command === 'run' ? args.find(a => a.startsWith('CATALOG_SOURCE='))?.split('=')[1] : containers.get(resolve(name))?.source;
    if (name === runId + '-gin' && (stall.source === null || source === stall.source) && stall.at.includes(matched++)) {
      stallTimer = true;
      if (stall.command === 'run') containers.set(name, { source }); // The daemon created it; its client stalls.
      if (stall.replace) containers.get(name).replaced = true;
      return spawn(process.execPath, ['-e', stallScript(name, holder, matched)], options);
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
    } else if (args[0] === 'inspect') {
      const name = resolve(args.at(-1));
      if (name) output = JSON.stringify([info(name)]); else { code = 1; error = 'Error: No such container: ' + args.at(-1); }
    } else if (args[0] === 'events') {
      const id = args[args.indexOf('--filter') + 1].slice('container='.length);
      output = JSON.stringify({ Type: 'container', Action: 'create', Actor: { ID: id, Attributes: { name: resolve(id) } }, time: Math.floor(Number(args[2])) + 60 });
    }
    else if (args[0] === 'start' && args[1] === runId + '-upstream' && containers.has(args[1])) {
      if (mode === 'start error') { code = 1; error = 'failed to start upstream process'; }
    } else if (args[0] === 'start') { code = 1; error = 'AssertionError: desktop-light js=false record_1: article styles at 0'; }
    else if (args[0] === 'logs') { if (containers.get(resolve(args[1])).source === 'fixture') error = 'open /fixtures/catalog.json: permission denied'; }
    else if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      output = [...containers.keys()].filter(name => !filter.startsWith('name=') || filter === 'name=^/' + name + '$').join('\\n');
    } else if (args[0] === 'rm') containers.delete(resolve(args.at(-1)));
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
    if (!stall?.startup) {
      assert.match(failure("api"), /AssertionError: desktop-light js=false record_1: article styles at 0\nFailed-check evidence unavailable or invalid: ENOENT/);
      if (stall?.command !== "run") assert.match(failure("fixture"), /native startup failed.*\nopen \/fixtures\/catalog.json: permission denied/);
    }
    assert.equal(summary.checksPassed, false);
    const trace = stall && JSON.parse(readFileSync(journal, "utf8"));
    if (stall?.startup) verifyStartupStalls(stall, summary, folder, trace);
    else if (stall?.unwritable) verifyUnwritable(summary, folder, trace);
    else if (stall?.replace) verifyReplaced(summary, folder, trace);
    else if (stall) verifyStall(stall, summary, folder, trace);
  } finally {
    if (existsSync(holder)) try { process.kill(Number(readFileSync(holder, "utf8"))); } catch {}
    assert.equal(dirname(folder), join(here, "results")); rmSync(folder, { recursive: true, force: true });
    assert.equal(dirname(scratch), tmpdir()); rmSync(scratch, { recursive: true, force: true });
  }
}

function verifyStall(stall, summary, folder, { journal, stallDeadlines }) {
  const name = `${summary.runId}-gin`, id = idOf(name);
  assert.deepEqual(stallDeadlines, [30000], "the runner keeps its 30-second command bound");
  const found = summary.failures.filter((f) => f.app === "gin" && f.source === stall.source && f.stage === stall.stage);
  assert.equal(found.length, 1, JSON.stringify(summary.failures));
  // Logs are read by the owned container's immutable ID, not its name.
  assert.match(found[0].error, new RegExp(stall.command === "run" ? `docker run --name ${name}` : `docker logs ${id}:`));
  // The fake shortens only the timer; the runner still reports its configured bound.
  assert.match(found[0].error, /timeout after 30000 ms/);
  const receipt = JSON.parse(readFileSync(join(folder, stall.receipt), "utf8"));
  assert.equal(receipt.schema, "catalog-command-failure/v1");
  assert.equal(receipt.container, name);
  assert.deepEqual(receipt.exit, { code: receipt.exit.code, signal: receipt.exit.signal, expired: true, interrupted: false });
  const life = receipt.lifetime;
  assert.equal(life.command[0], "docker"); assert.equal(life.timeoutMs, 30000); assert.equal(life.stopped, "deadline");
  assert.ok(life.stdout.bytes > 0 && life.stdout.firstMs !== null && life.stdout.lastMs <= life.stoppedMs, "output preceded the stall");
  assert.ok(life.stoppedMs >= stall.ms - 100, "stopped at the deadline");
  if (stall.held) {
    assert.match(found[0].error, /timeout after 30000 ms; the client exited 0 at \d+ ms but its output stayed open/);
    assert.equal(life.exitCode, 0); assert.ok(life.exitMs < life.stoppedMs, "the client exited before the deadline");
    assert.ok(life.releasedMs >= life.stoppedMs && life.settledMs >= life.releasedMs, "the runner stopped reading the held pipes");
  } else {
    assert.ok(life.exitMs >= life.stoppedMs && life.closeMs >= life.exitMs && life.settledMs >= life.closeMs, "the client ran until stopped");
    assert.equal(life.releasedMs, null);
  }
  assert.deepEqual(receipt.diagnosticErrors, []);
  assert.equal(receipt.refusal, null); assert.equal(receipt.inspect.id, id);
  assert.equal(typeof receipt.inspect.state.running, "boolean");
  assert.equal(receipt.events.total, 1); assert.equal(receipt.events.recent[0].action, "create");
  if (stall.command === "logs") {
    const bytes = readFileSync(join(folder, "api/gin/app.log"));
    assert.ok(bytes.length > 0);
    assert.deepEqual(life.file, { offset: 0, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    assert.equal(life.stdout.bytes, bytes.length);
  } else assert.equal(life.file, null);
  // The receipt is taken while the container still exists, before owned cleanup removes it.
  // Both sources reuse the app name, so look for the removal that follows the probes.
  const find = (from, match) => { const i = journal.slice(from).findIndex(match); return i < 0 ? -1 : from + i; };
  const state = find(0, (args) => ["inspect", "--type", "container", name].every((arg, i) => args[i] === arg));
  const events = find(0, (args) => args[0] === "events" && args.includes(`container=${id}`));
  // remove() deletes by the inspected ID.
  const removal = find(Math.max(state, events), (args) => args[0] === "rm" && args.at(-1) === id);
  assert.ok(state >= 0 && events >= 0 && removal > Math.max(state, events), JSON.stringify(journal));
  assert.equal(journal.filter((args) => args[0] === "events").length, 1, "exactly one receipt was taken");
  // A detached start's receipt reuses its one ownership check's snapshot: the container is never inspected by ID.
  if (stall.command === "run") assert.equal(journal.filter((args) => args[0] === "inspect" && args.at(-1) === id).length, 0, JSON.stringify(journal));
  if (stall.command === "logs") {
    const logs = journal.filter((args) => args[0] === "logs");
    assert.ok(logs.length > 0 && logs.every((args) => /^[0-9a-f]{64}$/.test(args[1])), JSON.stringify(logs));
  }
}

// Neither a receipt write nor its log line replaces the timeout that failed the collection.
function verifyUnwritable(summary, folder, { stallDeadlines }) {
  assert.deepEqual(stallDeadlines, [30000]);
  const found = summary.failures.filter((f) => f.app === "gin" && f.source === "api" && f.stage === "app logs");
  assert.equal(found.length, 1, JSON.stringify(summary.failures));
  assert.match(found[0].error, new RegExp(`^Error: docker logs ${idOf(`${summary.runId}-gin`)}: timeout after 30000 ms`));
  assert.equal(existsSync(join(folder, "api/gin/app.log.failure.json")), false);
  assert.doesNotMatch(readFileSync(join(folder, "run.log"), "utf8"), /failure receipt/);
}

// The receipt describes the container whose logs were read, A, by its ID; it neither reads B,
// which took the name and label meanwhile, nor queries events once A is gone.
function verifyReplaced(summary, folder, { journal, stallDeadlines }) {
  const name = `${summary.runId}-gin`, a = idOf(name), b = createHash("sha256").update(`${name}#replaced`).digest("hex");
  assert.deepEqual(stallDeadlines, [30000]);
  const found = summary.failures.filter((f) => f.app === "gin" && f.source === "api" && f.stage === "app logs");
  assert.equal(found.length, 1, JSON.stringify(summary.failures));
  assert.match(found[0].error, new RegExp(`^Error: docker logs ${a}: timeout after 30000 ms`));
  const bytes = readFileSync(join(folder, "api/gin/app.log")), text = readFileSync(join(folder, "api/gin/app.log.failure.json"), "utf8");
  const receipt = JSON.parse(text);
  assert.ok(!text.includes(b), "nothing of the replacement");
  const logs = journal.findLastIndex((args) => args[0] === "logs" && args[1] === a);
  assert.deepEqual(journal[logs + 1], ["inspect", "--type", "container", a], "the receipt's only probe is the verified ID");
  assert.equal(journal.filter((args) => args[0] === "events").length, 0, "no events once the verified container is gone");
  assert.equal(receipt.container, name); assert.equal(receipt.id, a);
  assert.equal(receipt.refusal, "verified container gone"); assert.equal(receipt.inspect, null); assert.equal(receipt.events, null);
  assert.deepEqual(receipt.diagnosticErrors, ["inspect: docker inspect --type container: exit 1"]);
  assert.deepEqual(receipt.lifetime.file, { offset: 0, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  // Cleanup then removes the replacement, which carries this run's label, by its own ID.
  assert.ok(journal.slice(logs + 2).some((args) => args[0] === "rm" && args.at(-1) === b), JSON.stringify(journal.slice(logs)));
}

// Two startup log collections for one reused container name keep two logs and two receipts,
// each matching its own file.
function verifyStartupStalls(stall, summary, folder, { journal, stallDeadlines }) {
  const name = `${summary.runId}-gin`;
  assert.deepEqual(stallDeadlines, [30000, 30000]);
  for (const [attempt, source] of [[1, "fixture"], [2, "api"]]) {
    const found = summary.failures.filter((f) => f.app === "gin" && f.source === source && f.stage === "checks");
    assert.equal(found.length, 1, JSON.stringify(summary.failures));
    assert.match(found[0].error, new RegExp(`docker logs ${idOf(name)}: timeout after 30000 ms`));
    const log = join(folder, `${name}-startup-${attempt}.log`), bytes = readFileSync(log);
    assert.ok(bytes.toString().startsWith(`[GIN] ${attempt === 1 ? 1 : 3} 200`), "each attempt's log holds only its own output");
    const receipt = JSON.parse(readFileSync(`${log}.failure.json`, "utf8"));
    assert.equal(receipt.stage, "startup logs"); assert.equal(receipt.container, name);
    assert.deepEqual(receipt.lifetime.file, { offset: 0, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    assert.equal(receipt.inspect.id, idOf(name)); assert.equal(receipt.inspect.state.running, false);
  }
  assert.equal(journal.filter((args) => args[0] === "events").length, 2, "one receipt per failed attempt");
}
