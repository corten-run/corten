// Synthetic, full-roster production-IO controls. No native/source qualification.
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateFunctional, result, runtimeInfo } from "./test-fixtures.mjs";
import { fixedFixture } from "./fixed-test-fixtures.mjs";
import { capturePhase } from "./phase.mjs";
import { producerProvenance } from "./production.mjs";
import { participantReceipt, runtimeReceipt, runtimeContext, identity, loadConfig, phases, aggregate, timedSchema, timedReceiptSchema, sha256, payloads } from "./contract.mjs";
import { timedCaseProjection } from "./timed-outcomes.mjs";
import { readFixedStreamSync } from "./fixed-stream.mjs";
import { executeMatrix } from "./matrix.mjs";
import { reader } from "./artifacts.mjs";

// Retain exact independent path bytes, compressed ONLY inside the test store.
// get() returns original JSON bytes. No production reader or raw stream is compressed.
export class ByteStore extends Map {
  set(path, bytes) { return super.set(path, gzipSync(bytes)); }
  get(path) { const bytes = super.get(path); return bytes === undefined ? undefined : gunzipSync(bytes).toString(); }
}
export function gateFunctionalFixture(f, app = f.summary.group.apps[0], profile = f.summary.group.cases[0]) {
  gateFunctional(f, app, profile);
  for (const entry of Object.values(f.summary.apps)) for (const p of f.summary.group.cases)
    entry.projections[p.key] = timedCaseProjection([], f.summary.options.passes);
  f.summary.attemptComplete = !f.summary.options.checkOnly && !f.summary.failures.length;
  return f;
}
export function phaseFixture(phase, responses = ["ok", "ok", "ok"], offset = 0, drops = 0) {
  const f = fixedFixture({ responses, drops });
  const base = f.command.clock.startedAt;
  for (const e of f.entries) if (e.type === "Point") {
    e.data.time = new Date(Date.parse(e.data.time) + offset).toISOString();
    if (e.metric === "json_start_scenario_ms") e.data.value += offset;
  }
  for (const doc of [f.summary]) {
    const m = doc.metrics.json_start_scenario_ms;
    if (m) for (const key of ["value", "min", "max"]) m[key] += offset;
  }
  f.command.clock = { startedAt: base + offset, finishedAt: f.command.clock.finishedAt + offset };
  if (phase !== "fixed") {
    for (const doc of [f.summary, f.clock]) for (const name of Object.keys(doc.metrics))
      if (name.startsWith("json_start_") || name === "json_start_capped") delete doc.metrics[name];
    for (const [key, count] of [["rate_limited", responses.filter((r) => r === "http429").length], ["server_error", responses.filter((r) => r === "http503").length]]) {
      const values = { count, rate: count * 1000 / f.clock.k6DurationMs };
      f.summary.metrics[`json_${key}`] = values; f.clock.metrics[`json_${key}`] = { values };
    }
    f.clock.schema = "json-api-closed-clock/v1";
  }
  return f;
}

// `fault` makes one phase's native command time out as process.mjs reports it, saved as
// run.mjs saves it. `cells` limits timing to "app/key" cells so multi-pass controls stay small.
// `loadCpu(stage)` sets the sampled k6 CPU percent per phase; without it every sample is 10.
export async function productionFixture(folder, { failure, fault, passes = 1, cells, commit, placement, loadCpu = () => 10 } = {}) {
  const f = result(["--duration", "1", "--warmup", "1", "--rate", "3"], { artifacts: new ByteStore(), commit, ...(placement ? { placement } : {}) }), s = f.summary;
  s.schema = timedSchema; s.producer = producerProvenance(); s.options.passes = passes;
  s.finishedAt = "2026-11-18T00:00:00Z";
  const { timingPlan } = await import("./contract.mjs"); s.timingPlan = timingPlan(s.options);
  f.load.stream = (ref) => readFixedStreamSync(join(folder, ref.path), ref.receipt);
  f.load.bytes = reader(folder).bytes;
  const captured = [], upstreamCounters = Object.fromEntries(s.group.payloads.map(p => [p, {}])); let sequence = 0;
  for (const entry of Object.values(s.apps)) {
    entry.projections = Object.fromEntries(s.group.cases.map((p) => [p.key, timedCaseProjection([], passes)]));
    for (const p of s.group.cases) {
      const native = f.load(entry.checks[p.key].native);
      native.receipt.schema = timedReceiptSchema;
      Object.assign(native.receipt.verified, { atMostOneUpstreamFetch: true, noTransportRetries: true, noBackgroundUpstream: true, responseAfterUpstreamCompletion: true });
      native.receipt.transportSourceFiles = native.receipt.sourceFiles.map((s) => s.path);
      entry.checks[p.key].native = f.put(native);
    }
  }
  const originals = new Map(Object.entries(s.apps).flatMap(([app, entry]) => s.group.cases.map((p) => [`${app}/${p.key}`, entry.runs[p.key][0].cold])));
  for (const entry of Object.values(s.apps)) for (const p of s.group.cases) { entry.runs[p.key] = []; entry.aggregates[p.key] = {}; }
  await executeMatrix(s.options, {
    async prepare() {}, async check() { return true; }, async gate() {}, async failure(_app, _key, _stage, error) { throw error; },
    async measure({ app, profile, pass }) {
      if (cells && !cells.includes(`${app}/${profile.key}`)) return;
      const entry = s.apps[app], expected = { ...identity(s, app, profile), pass }, context = runtimeContext(s, profile);
      const baseOffset = sequence++ * 20000, epoch = Date.parse("2026-11-17T00:00:00Z"), appId = sha256(`app/${app}/${profile.key}/${pass}`), upId = sha256(`upstream/${profile.payload}`);
      const cold = structuredClone(originals.get(`${app}/${profile.key}`));
      cold.result.containerStartedAt = new Date(epoch + baseOffset - 2200).toISOString(); cold.result.first200At = new Date(epoch + baseOffset - 2000).toISOString();
      const coldRaw = f.load(cold.raw); coldRaw.identity = expected; coldRaw.result = cold.result;
      coldRaw.runtime.containerId = appId;
      const coldCtx = { ...context, cold: true }, coldUpstream = runtimeInfo(expected, coldCtx, "upstream");
      coldUpstream.Id = upId; coldRaw.participants.upstream = participantReceipt(coldUpstream, expected, coldCtx, "upstream");
      coldRaw.upstreamLife = { containerId: upId, startedAt: s.startedAt, finishedAt: "0001-01-01T00:00:00Z",
        status: "running", running: true, oomKilled: false, dead: false, paused: false, restarting: false, restartCount: 0, exitCode: 0, error: "" };
      const before = structuredClone(upstreamCounters[profile.payload]), after = structuredClone(before), first = payloads[profile.payload].first;
      if (profile.source === "api") after[first] = (after[first] ?? 0) + 1;
      coldRaw.upstreamReads = { before, after }; cold.raw = f.put(coldRaw);
      const run = { pass, identity: expected, complete: false, phases: {}, cold };
      entry.runs[profile.key].push(run);
      let reads = structuredClone(coldRaw.upstreamReads.after), counter = 1000000, offset = baseOffset, priorTailUnobserved = false;
      try { for (const stage of ["warmup", ...phases]) {
        const faulted = fault?.app === app && fault?.key === profile.key && fault?.pass === pass && fault?.phase === stage;
        const negative = failure?.app === app && failure?.key === profile.key && failure?.pass === pass && failure?.phase === stage;
        const synthetic = phaseFixture(stage, negative ? failure.responses : undefined, offset), config = loadConfig(s.options, stage);
        const path = `${app}/${profile.key}/p${pass}`; mkdirSync(join(folder, path), { recursive: true });
        const ctx = { ...context, load: config }, beforeReads = structuredClone(reads);
        const afterReads = profile.source === "api" ? { ...reads, synthetic: (reads.synthetic ?? 0) + synthetic.summary.metrics.http_reqs.count } : reads;
        const upstream = (reads) => {
          const n = Object.values(reads).reduce((a, b) => a + b, 0);
          return { upstreamReads: reads, upstreamResponses: { status: 200, completed: n ? { 200: n } : {}, aborted: 0 } };
        };
        const infos = Object.fromEntries(["app", "upstream", "load"].map((role) => [role, runtimeInfo(expected, ctx, role)]));
        infos.app.Id = appId; infos.upstream.Id = upId;
        infos.load.Id = sha256(`${app}/${profile.key}/${pass}/${stage}`);
        let observed = 0, counted = 0, saved;
        try { saved = await capturePhase({ folder, path, stage, config, expected, options: s.options, tools: s.tools, context,
          native: f.load(entry.checks[profile.key].native), priorTailUnobserved, io: {
            write: (_path, value) => f.put(value), reads: async () => upstream(afterReads), now: () => synthetic.command.clock.finishedAt + 20,
            async execute(opts) {
              // Assert the production command capture asks for the actual 99 path.
              if (!opts.observeExit) throw new Error("normal99 capture not enabled");
              if (faulted) {
                const error = new Error("docker start -a json-api-k6: timeout\nsecret-free stderr tail");
                error.exit = { code: 137, signal: null, expired: true, interrupted: false }; error.clock = synthetic.command.clock; error.ioErrors = [];
                throw error;
              }
              writeFileSync(opts.stdoutFile, stage === "fixed" ? synthetic.bytes() : ""); writeFileSync(opts.stderrFile, synthetic.logs);
              return { ...synthetic.command, stdoutBytes: stage === "fixed" ? synthetic.bytes().length : 0, stderrBytes: Buffer.byteLength(synthetic.logs) };
            },
            async copy(source, target) { writeFileSync(target, JSON.stringify(source.includes("summary") ? synthetic.summary : synthetic.clock)); },
            async counters() { const value = counter + counted++ * 100000; return Object.fromEntries((profile.source === "api" ? ["app", "upstream"] : ["app"]).map((r) => [r, value])); },
            sample() { return { async stop() { return Object.fromEntries(["app", "upstream", "load"].map((r) => [r, [100, 800].map((t) => ({ t: synthetic.command.clock.startedAt + t, cpu: r === "load" ? loadCpu(stage) : 10, mem: 8 }))])); } }; },
            async observe() {
              const before = observed++ === 0, at = before ? synthetic.command.clock.startedAt - 10 : synthetic.command.clock.finishedAt + 10;
              const liveness = Object.fromEntries(Object.entries(infos).map(([role, info]) => [role, {
                containerId: info.Id, startedAt: role === "load" ? before ? "0001-01-01T00:00:00Z" : new Date(synthetic.command.clock.startedAt).toISOString()
                  : role === "app" ? cold.result.containerStartedAt : s.startedAt,
                finishedAt: role === "load" && !before ? new Date(synthetic.command.clock.finishedAt).toISOString() : "0001-01-01T00:00:00Z",
                status: role === "load" ? before ? "created" : "exited" : "running", running: role !== "load", oomKilled: false, dead: false, paused: false,
                restarting: false, restartCount: 0, exitCode: role === "load" && !before ? synthetic.command.exit.code : 0, error: "" }]));
              return { at, runtime: runtimeReceipt(infos.app, expected, ctx),
                participants: Object.fromEntries(["upstream", "load"].map((r) => [r, participantReceipt(infos[r], expected, ctx, r)])),
                liveness, ...upstream(before ? beforeReads : afterReads) };
            },
          } }); } catch (error) {
          if (error.phase) { if (stage === "warmup") run.warmup = error.phase; else run.phases[stage] = error.phase; }
          throw error;
        }
        if (stage === "warmup") run.warmup = saved; else run.phases[stage] = saved;
        captured.push({ app, key: profile.key, pass, stage, code: synthetic.command.exit.code });
        reads = afterReads; counter += 200000; offset += 3000; priorTailUnobserved ||= saved.metrics.counts.timeout > 0;
      }
      run.complete = true;
      } catch (error) { run.failed = error.message; s.failures.push({ app, key: profile.key, stage: `timing pass ${pass}`, error: error.message }); }
      finally {
        run.tail = f.put({ before: reads, after: reads, beforeStopAt: epoch + baseOffset + 15000, afterStopAt: epoch + baseOffset + 15010 });
        upstreamCounters[profile.payload] = reads;
        // The same saved-metrics reductions run.mjs writes, including a faulted run's earlier phases.
        for (const stage of phases) entry.aggregates[profile.key][stage] = { ...aggregate(entry.runs[profile.key].filter((r) => r.phases[stage]?.metrics).map((r) => r.phases[stage].metrics)), asked: passes };
        entry.projections[profile.key] = timedCaseProjection(entry.runs[profile.key].map((r) => ({ pass: r.pass,
          phases: Object.fromEntries(phases.filter((p) => r.phases[p]?.metrics).map((p) => [p, r.phases[p].metrics])) })), passes);
      }
    },
  }, s.timingPlan);
  s.cleanup = f.put({ runId: s.runId, containers: [], networks: [] });
  s.readTail = f.put({ at: Date.parse("2026-11-17T00:00:00Z") + sequence * 20000, reads: upstreamCounters });
  s.attemptComplete = s.failures.length === 0 && Object.values(s.apps).every((a) => s.group.cases.every((p) => a.runs[p.key].length === passes
    && a.runs[p.key].every((r) => r.complete && phases.every((stage) => r.phases[stage]?.metrics?.observationComplete))));
  s.complete = s.attemptComplete && !failure;
  return { ...f, captured };
}
