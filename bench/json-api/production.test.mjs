import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectJson, renderJson } from './report.mjs';
import { descriptor, runtimeContext, loadConfig, deriveLoad, timingPlan, scheduledProducerSchema } from './contract.mjs';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gateFunctionalFixture, productionFixture, phaseFixture } from './production-fixtures.mjs';
import { deriveProductionPhase } from './production.mjs';
import { capturePhase, withPhaseCleanup } from './phase.mjs';
import { readFixedStreamSync } from './fixed-stream.mjs';
import { loadResourceCaptureSchema } from './load-resource-proof.mjs';
import { writer, reader } from './artifacts.mjs';
import { timedCaseProjection } from './timed-outcomes.mjs';
import { replayTimedRun, verifyAggregates } from './evidence.mjs';
import { isDeepStrictEqual } from 'node:util';

test('production v2 dispatch retains missing matrix cells instead of rejecting the schema', () => {
  const group = descriptor();
  const report = inspectJson({ schema: 'json-api-results/v2', group, options: { apps: group.apps, group: 'json-api', round: 'j1', passes: 1 }, round: 'j1' }, { load() { throw new Error('missing'); } });
  assert.equal(report.attemptComplete, false);
  assert.deepEqual(Object.keys(report.apps), group.apps);
  for (const rows of Object.values(report.apps)) for (const row of Object.values(rows)) {
    assert.equal(row.projection.cells.length, 1);
    assert.equal(row.projection.cells[0].phases.fixed.state, 'missing');
  }
});

test('production full official matrix retains normal99, continues and independently replays saved outcomes', async (t) => {
  const stage = (label) => { if (process.env.JSON_V2_STAGE_LOG) appendFileSync(process.env.JSON_V2_STAGE_LOG, `${Date.now()} ${label}\n`); };
  stage('fixture-start');
  const folder = mkdtempSync(join(tmpdir(), 'json-v2-production-'));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const group = descriptor(), failure = { app: group.apps[0], key: group.cases[1].key, pass: 2, phase: 'fixed', responses: ['ok', 'http429', 'http503'] };
  const f = await productionFixture(folder, { failure, passes: 3 });
  stage('fixture-done');
  assert.equal(f.captured.length, group.apps.length * group.cases.length * 3 * 4);
  assert.equal(f.captured.filter(c => c.code === 99).length, 1);
  const report = inspectJson(f.summary, { load: f.load });
  stage('negative-report-done');
  assert.equal(report.warnings.length, 0, report.warnings.slice(0, 4).join('\n'));
  assert.equal(report.attemptComplete, true); assert.equal(report.baseline, false);
  assert.equal(report.outcomes.find(o => o.app === failure.app).outcome, 'failed');
  const row = report.apps[failure.app][failure.key];
  assert.equal(row.comparisonEligible, null);
  assert.equal(row.projection.byPhase.fixed.failedPasses.join(','), '2');
  assert.equal(row.projection.byPhase.fixed.ranges.failed.max, 2);
  assert.equal(row.projection.byPhase.fixed.ranges.failed.min, 0);
  assert.equal(row.projection.cells.length, 3);
  assert.equal(row.projection.cells[1].phases.sat256.state, 'passed');
  assert.match(renderJson(report), /Timed Outcomes/);

  const entry = f.summary.apps[failure.app], run = entry.runs[failure.key][1], saved = run.phases.fixed;
  const raw = f.load(saved.raw), profile = group.cases[1], native = f.load(entry.checks[failure.key].native);
  const context = runtimeContext(f.summary, profile), stream = f.load.stream(raw.eventStream);
  const derive = (r, n = native, st = stream) => deriveProductionPhase(r, run.identity, 'fixed', f.summary.options, f.summary.tools, context, { native: n, stream: st });
  for (const [name, mutate] of [
    ['bad99 mismatch', r => r.command.exit.code = 0], ['I/O fault', r => r.command.ioErrors.push('disk write')],
    ['abnormal', r => r.command.exit.signal = 'SIGTERM'], ['expired', r => r.command.exit.expired = true],
    ['stderr truncation', r => r.command.stderrBytes = 67], ['recorded capture fault', r => r.captureErrors.push('sampler')],
    ['source runtime', r => r.before.runtime.source = 'fixture'], ['load execution', r => r.after.participants.load.configuration.args.push('override')],
    ['load budget', r => r.before.participants.load.quota = 1], ['missing generator resources', r => delete r.samples.load],
    ['memory at budget', r => r.samples.app[0].mem = 1024], ['counter missing', r => delete r.counters.app],
    ['counter decrease', r => r.counters.upstream.after = 0], ['lifetime OOM', r => r.after.liveness.app.oomKilled = true],
    ['lifetime restart', r => r.after.liveness.upstream.restartCount = 1], ['lifetime start', r => r.after.liveness.load.startedAt = '2026-11-18T00:00:00Z'],
    ['tail read', r => r.upstreamReads.settled = { synthetic: 99 }], ['missing settle clock', r => delete r.settledAt],
    ['API below successful reads', r => { r.upstreamReads.after = r.after.upstreamReads = r.upstreamReads.settled = r.upstreamReads.before; }],
    ['API unexplained extra reads', r => { const after = { ...r.upstreamReads.before, extra: 9 }; r.upstreamReads.after = r.after.upstreamReads = r.upstreamReads.settled = after; }],
    ['raw receipt', r => r.events.sha256 = 'f'.repeat(64)], ['raw stdout count', r => r.command.stdoutBytes++],
  ]) { const bad = structuredClone(raw); mutate(bad); assert.throws(() => derive(bad), undefined, name); }
  stage('raw-negatives-done');
  for (const mutate of [r => r.samples.load[0].cpu = 320, r => r.samples.upstream[0].cpu = 80,
    r => r.counters.upstream.after = r.counters.upstream.before + 1000000]) {
    const busy = structuredClone(raw); mutate(busy); const observed = derive(busy);
    assert.equal(observed.observationComplete, false); assert.equal(observed.targetOutcome, null);
  }
  // Preserve the fixed stream but give this synthetic wrapper a longer
  // lifetime so multiple independently required load slots fit inside it.
  const scheduled = structuredClone(raw), start = scheduled.command.clock.startedAt, finish = start + 4500;
  const live = scheduled.after.liveness.load;
  live.finishedAt = new Date(finish).toISOString();
  scheduled.command.clock.finishedAt = finish;
  scheduled.after.at = finish + 10;
  scheduled.settledAt = finish + 20;
  delete scheduled.samples.load;
  const participant = { pid: 42, processObject: '1:2', startTicks: '1234', path: `/system.slice/docker-${live.containerId}.scope`,
    mount: '36 27 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup rw', groupObject: '3:4', populated: true };
  scheduled.loadResources = { schema: loadResourceCaptureSchema, live: { id: live.containerId, pid: 42, startedAt: live.startedAt },
    rows: Array.from({ length: 3 }, (_, sequence) => {
      const at = start + 1050 + sequence * 1000;
      return { sequence, begin: { at, monotonic: at - start }, end: { at, monotonic: at - start },
        before: participant, after: participant, usageUsec: sequence * 100000, memoryCurrent: 9 * 2 ** 20, inactiveFile: 2 ** 20 };
    }) };
  const deriveScheduled = (r) => deriveProductionPhase(r, run.identity, 'fixed', f.summary.options, f.summary.tools,
    { ...context, producerSchema: scheduledProducerSchema }, { native, stream });
  const updated = deriveScheduled(scheduled), legacy = derive(raw);
  assert.equal(updated.failed, legacy.failed);
  assert.equal(updated.cpuUsec, legacy.cpuUsec);
  assert.equal(updated.apparatus.load.memMaxBytes, 8 * 2 ** 20);
  assert.equal(updated.apparatus.load.loadHasHeadroom, true);
  assert.throws(() => derive(scheduled), /apparatus resource samples/);
  assert.throws(() => deriveScheduled(raw), /apparatus resource samples/);
  for (const [mutate, message] of [
    [(r) => delete r.loadResources, /load resource evidence differs/],
    [(r) => r.loadResources.rows.pop(), /scheduled load resource coverage/],
    [(r) => r.loadResources.live.startedAt = new Date(start + 1000).toISOString(), /live resource observation differs/],
    [(r) => { const life = r.after.liveness.load; life.finishedAt = [life.finishedAt]; }, /load finish clock invalid/],
    [(r) => { const life = r.after.liveness.load; life.startedAt = [life.startedAt]; }, /participant start clock missing/],
  ]) { const bad = structuredClone(scheduled); mutate(bad); assert.throws(() => deriveScheduled(bad), message); }
  const busy = structuredClone(scheduled);
  busy.loadResources.rows[1].usageUsec = busy.loadResources.rows[2].usageUsec = 3_200_000;
  assert.ok(deriveScheduled(busy).incompleteReasons.includes('load-generator-with-added-stock-output-lacks-observed-headroom'));
  const historicalAudit = structuredClone(native); historicalAudit.receipt.schema = 'json-api-native-audit/v1';
  for (const key of ['atMostOneUpstreamFetch', 'noTransportRetries', 'noBackgroundUpstream', 'responseAfterUpstreamCompletion']) delete historicalAudit.receipt.verified[key];
  delete historicalAudit.receipt.transportSourceFiles;
  assert.equal(derive(raw, historicalAudit).targetOutcome, null);
  const unaudited = structuredClone(native); unaudited.receipt.verified.noTransportRetries = false;
  assert.throws(() => derive(raw, unaudited), /source guarantees/);

  // An actual disk writer/reader also replays the full stream, not a saved reduction.
  const put = writer(folder), disk = reader(folder), diskRef = put('phase.json', raw);
  assert.equal(derive(disk(diskRef), native, disk.stream(raw.eventStream)).failed, 2);
  assert.throws(() => disk.stream({ path: raw.eventStream.path }), /reference/);
  assert.throws(() => disk.stream({ ...raw.eventStream, path: '../outside' }), /unsafe/);
  assert.throws(() => disk.stream({ ...raw.eventStream, receipt: { ...raw.events, events: raw.events.events + 1 } }), /receipt differs/);
  stage('disk-controls-done');

  const drop = phaseFixture('fixed', ['ok', 'ok'], raw.command.clock.startedAt - Date.parse('2026-11-17T00:00:00Z'), 1), dropped = structuredClone(raw), dropFile = join(folder, 'drops.jsonl');
  writeFileSync(dropFile, drop.bytes()); const dropStream = readFixedStreamSync(dropFile);
  dropped.k6 = drop.summary; dropped.clock = drop.clock; dropped.command = { ...drop.command, stdoutBytes: dropStream.receipt.bytes };
  dropped.events = dropStream.receipt;
  const reads = { ...dropped.upstreamReads.before, synthetic: (dropped.upstreamReads.before.synthetic ?? 0) + 2 };
  dropped.upstreamReads.after = dropped.after.upstreamReads = dropped.upstreamReads.settled = reads;
  const unattributed = derive(dropped, native, dropStream);
  assert.equal(unattributed.observationComplete, false); assert.equal(unattributed.targetOutcome, null);
  assert.match(unattributed.incompleteReasons.join(','), /monotonic-last-offer/);
  stage('drop-control-done');

  const savedProjection = entry.projections[failure.key];
  const forgedProjection = structuredClone(savedProjection); forgedProjection.cells[1].phases.fixed.requests++;
  const projection = timedCaseProjection(entry.runs[failure.key].map(r => ({ pass: r.pass,
    phases: Object.fromEntries(Object.entries(r.phases).map(([key, value]) => [key, value.metrics])) })), 3);
  assert.ok(isDeepStrictEqual(projection, savedProjection), 'saved projection must independently derive');
  assert.ok(!isDeepStrictEqual(projection, forgedProjection), 'forged projection cannot match derivation');
  entry.aggregates[failure.key].fixed.passes++;
  assert.throws(() => verifyAggregates(entry.aggregates[failure.key], entry.runs[failure.key], 3), /aggregate differs/);
  entry.aggregates[failure.key].fixed.passes--;
  const tailRef = run.tail, tail = f.load(tailRef); tail.after = { extra: 1 }; run.tail = f.put(tail);
  assert.throws(() => replayTimedRun(run, run.identity, f.summary.options, f.load, f.summary.tools, context, native), /teardown/); run.tail = tailRef;
  const rawRef = saved.raw, truncated = structuredClone(raw); delete truncated.files.clock;
  saved.raw = f.put(truncated);
  assert.throws(() => replayTimedRun(run, run.identity, f.summary.options, f.load, f.summary.tools, context, native), /auxiliary byte references/);
  saved.raw = rawRef;
  const stderrPath = join(folder, raw.files.stderr.path), stderr = readFileSync(stderrPath);
  writeFileSync(stderrPath, 'unretained stderr fault');
  assert.throws(() => replayTimedRun(run, run.identity, f.summary.options, f.load, f.summary.tools, context, native), /raw byte length differs/);
  writeFileSync(stderrPath, stderr);
  assert.throws(() => deriveLoad(raw, run.identity, 'fixed', f.summary.options, f.summary.tools, context), /container identity/);
  // Identically serialized fixture bodies have independent artifact paths/mutations.
  const a = f.put({ marker: 1 }), b = f.put({ marker: 1 });
  assert.notEqual(a.path, b.path); f.artifacts.set(a.path, JSON.stringify({ marker: 2 }));
  assert.equal(f.load(b).marker, 1); assert.throws(() => f.load(a), /digest/);
});

test('production healthy full roster and explicit missing passes use saved-replay report gates', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'json-v2-positive-'));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const f = await productionFixture(folder);
  const healthy = inspectJson(f.summary, { load: f.load });
  assert.equal(healthy.baseline, true, healthy.warnings.slice(0, 4).join('\n'));
  assert.deepEqual(healthy.comparisonEligibleApps, descriptor().apps);
  f.summary.options.passes = 3; f.summary.timingPlan = timingPlan(f.summary.options);
  f.summary.attemptComplete = false; f.summary.complete = false;
  const partial = inspectJson(f.summary, { load: f.load });
  assert.equal(partial.attemptComplete, false);
  for (const rows of Object.values(partial.apps)) for (const row of Object.values(rows)) {
    assert.equal(row.projection.cells.length, 3);
    assert.equal(row.projection.cells[2].phases.fixed.state, 'missing');
    assert.equal(row.projection.byPhase.fixed.present, 1);
    assert.ok(row.projection.cells[0].phases.fixed.requests > 0);
  }
  // Existing functional-negative policy still gates ALL v2 timings globally.
  gateFunctionalFixture(f, "corten", f.summary.group.cases[0]);
  const gated = inspectJson(f.summary, { load: f.load });
  assert.equal(gated.attemptComplete, true, gated.warnings.slice(0, 3).join('\n')); assert.equal(gated.baseline, false);
});

test('production capture saves abnormal, I/O and bad99 evidence before rejecting, never target blame', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'json-v2-capture-'));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const f = phaseFixture('sat64'), options = { duration: 1, warmup: 1, rate: 3 }, saved = new Map();
  for (const kind of ['I/O', 'abnormal', 'bad99', 'copy', 'sampler']) {
    const path = kind.replace('/', '-'); mkdirSync(join(folder, path));
    const err = new Error(kind); err.exit = { code: 2, signal: null, expired: false, interrupted: false }; err.clock = f.command.clock; err.ioErrors = kind === 'I/O' ? ['write'] : [];
    const io = { now: () => f.command.clock.finishedAt, reads: async () => ({}), counters: async () => ({}), observe: async () => ({}),
      write(path, value) { saved.set(path, value); return { path }; },
      sample() { return { async stop() { if (kind === 'sampler') throw err; return {}; } }; },
      async execute() { if (['I/O', 'abnormal'].includes(kind)) throw err; return { ...f.command, exit: { ...f.command.exit, code: 99 }, stdoutBytes: 0 }; },
      async copy(source, target) { if (kind === 'copy') throw err; writeFileSync(target, JSON.stringify(source.includes('summary') ? f.summary : f.clock)); } };
    await assert.rejects(capturePhase({ folder, path, stage: 'sat64', config: loadConfig(options, 'sat64'), expected: {}, options, tools: { node: {}, k6: {} }, context: {}, io }), error => {
      const raw = saved.get(error.phase?.raw.path);
      assert.ok(raw?.captureErrors.length > 0); assert.equal(error.phase.metrics, null); assert.equal(raw.targetOutcome, undefined);
      if (kind === 'bad99') assert.match(error.message, /exit\/threshold mismatch/);
      return true;
    });
  }
});

test('phase joins both samplers before saving a native command failure', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'json-load-join-'));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  mkdirSync(join(folder, 'joined'));
  const options = { duration: 1, warmup: 1, rate: 3 }, loadId = 'a'.repeat(64);
  const commandFailure = new Error('command deadline\ncommand stderr is not a receipt field');
  let result, appStopped = false, loadStopped = false, stopRequested = false;
  const sampled = { schema: loadResourceCaptureSchema, live: null, rows: [] };
  const io = {
    async observe() { return { participants: { load: { containerId: loadId } } }; },
    async counters() { return {}; },
    sample() { return { async stop() { appStopped = true; throw new Error('app stats failed'); } }; },
    sampleLoad(id) {
      assert.equal(id, loadId);
      return { requestStop() { stopRequested = true; }, async stop() { loadStopped = true; return { capture: sampled }; } };
    },
    async execute({ onExit }) {
      onExit();
      assert.ok(stopRequested && !loadStopped, "child exit requests stop without waiting for the samplers or pipes");
      throw commandFailure;
    },
    async reads() { return {}; },
    async copy() { throw new Error('no command artifacts'); },
    write(path, raw) {
      assert.ok(appStopped && loadStopped);
      result = raw;
      return { path };
    },
  };
  await assert.rejects(capturePhase({ folder, path: 'joined', stage: 'sat64', config: loadConfig(options, 'sat64'),
    expected: {}, options, tools: { node: {}, k6: {} }, context: {}, io }), /^Error: native command: command deadline$/);
  assert.deepEqual(result.captureErrors, ['native command: command deadline', 'app stats failed',
    'load capture lacks the exact clean terminal lifetime', 'no command artifacts']);
  assert.equal(result.loadResources, sampled);
});

test('load sampler failure retains the acquired prefix, terminal observation, k6 summary and clock', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'json-load-failure-'));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  mkdirSync(join(folder, 'partial'));
  const options = { duration: 1, warmup: 1, rate: 3 }, loadId = 'a'.repeat(64), f = phaseFixture('sat64');
  const capture = { schema: loadResourceCaptureSchema, live: { id: loadId, pid: 42 }, rows: [{ sequence: 0 }] };
  const before = { participants: { load: { containerId: loadId } } }, after = { liveness: { load: { containerId: loadId, status: 'exited' } } };
  const order = [];
  let result, observations = 0, counterReads = 0;
  const io = {
    async observe() { return observations++ ? after : before; },
    async counters() { order.push(counterReads++ ? 'CPU after' : 'CPU before'); return {}; },
    sample() { return { async stop() { return { app: [], upstream: [] }; } }; },
    sampleLoad(id) {
      assert.equal(id, loadId);
      return { requestStop() { order.push('request load stop'); }, async stop() {
        await new Promise(setImmediate);
        order.push('load terminal inspect settled');
        return { capture, error: new Error('invalid CPU counter') };
      } };
    },
    async execute({ onExit }) { onExit(); return { ...f.command, exit: { ...f.command.exit, code: 99 }, stdoutBytes: 0 }; },
    async reads() { return {}; },
    async copy(path, target) { writeFileSync(target, JSON.stringify(path.includes('summary') ? f.summary : f.clock)); },
    write(path, raw) { result = raw; return { path }; },
  };
  await assert.rejects(capturePhase({ folder, path: 'partial', stage: 'sat64', config: loadConfig(options, 'sat64'),
    expected: {}, options, tools: { node: {}, k6: {} }, context: {}, io }), (error) => {
    assert.match(error.message, /invalid CPU counter/);
    assert.equal(error.phase.metrics, null);
    return true;
  });
  assert.equal(result.after, after);
  assert.deepEqual(order, ['CPU before', 'request load stop', 'CPU after', 'load terminal inspect settled']);
  assert.equal(result.command.exit.code, 99);
  assert.equal(result.loadResources, capture);
  assert.deepEqual(result.k6, f.summary);
  assert.deepEqual(result.clock, f.clock);
  assert.deepEqual(Object.keys(result.files).sort(), ['clock', 'stderr', 'stdout', 'summary']);
  assert.deepEqual(result.captureErrors, ['invalid CPU counter']);
});

test('a terminal read failure retains known and unresolved load sampler faults', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'json-load-double-failure-'));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const options = { duration: 1, warmup: 1, rate: 3 }, loadId = 'a'.repeat(64), f = phaseFixture('sat64');
  const capture = { schema: loadResourceCaptureSchema, live: { id: loadId, pid: 42 }, rows: [{ sequence: 0 }] };
  for (const [path, fault] of [
    ['known', { error: new Error('invalid CPU counter') }],
    ['unresolved', { missed: { error: new Error('missing scheduled load acquisition') } }],
  ]) {
    mkdirSync(join(folder, path));
    let result, counterCalls = 0;
    const io = {
      async observe() { return { participants: { load: { containerId: loadId } } }; },
      async counters() { if (counterCalls++) throw new Error('terminal counters failed'); return {}; },
      sample() { return { async stop() { return {}; } }; },
      sampleLoad() { return { async stop() { return { capture, ...fault }; } }; },
      async execute() { return { ...f.command, stdoutBytes: 0 }; },
      write(file, raw) { result = raw; return { path: file }; },
    };
    await assert.rejects(capturePhase({ folder, path, stage: 'sat64', config: loadConfig(options, 'sat64'),
      expected: {}, options, tools: { node: {}, k6: {} }, context: {}, io }), /terminal counters failed/);
    assert.equal(result.loadResources, capture);
    assert.equal(result.command.exit.code, f.command.exit.code);
    assert.deepEqual(result.captureErrors, [(fault.error ?? fault.missed.error).message, 'terminal counters failed']);
  }
});

test('a cleanup failure cannot replace a phase receipt, but still fails an otherwise successful phase', async () => {
  const captured = Object.assign(new Error('capture failure'), { phase: { raw: { path: 'saved.json' }, metrics: null } });
  const cleanup = new Error('owned load removal failed'), recorded = [];
  const remove = async () => { throw cleanup; };
  const record = (error) => recorded.push(error);
  await assert.rejects(withPhaseCleanup(async () => { throw captured; }, remove, record), (error) => error === captured);
  await assert.rejects(withPhaseCleanup(async () => true, remove, record), (error) => error === cleanup);
  assert.deepEqual(recorded, [cleanup, cleanup]);
  assert.equal(await withPhaseCleanup(async () => 'passed', async () => {}, record), 'passed');
});

test('distinct matching fault text and a failed receipt write preserve every causal error', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'json-receipt-write-fault-'));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  mkdirSync(join(folder, 'fault'));
  const options = { duration: 1, warmup: 1, rate: 3 }, loadId = 'a'.repeat(64), saveFault = new Error('no space to save');
  let counters = 0, saved;
  const io = {
    async observe() { return { participants: { load: { containerId: loadId } } }; },
    async counters() { if (counters++) throw new Error('read failed'); return {}; },
    sample() { return { async stop() { return {}; } }; },
    sampleLoad() { return { async stop() { return { capture: {}, error: new Error('read failed') }; } }; },
    async execute() { throw new Error('native clock expired'); },
    write(file, raw) { saved = raw; throw saveFault; },
  };
  await assert.rejects(capturePhase({ folder, path: 'fault', stage: 'sat64', config: loadConfig(options, 'sat64'),
    expected: {}, options, tools: { node: {}, k6: {} }, context: {}, io }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[1], saveFault);
    assert.deepEqual(saved.captureErrors, ['native command: native clock expired', 'read failed', 'read failed']);
    assert.match(error.message, /native clock expired; read failed; read failed; phase receipt write: no space to save/);
    return true;
  });
});
