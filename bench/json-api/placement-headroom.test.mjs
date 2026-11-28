// The opt-in json-c16-generator-v1 layout keeps the load bound at 80% per allocated
// k6 core (issue 2057): quota 12 bounds k6 at 960%, the default quota 4 at 320%.
// Saved results with load CPU in between replay through the real gates.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { runtimeContext, scheduledProducerSchema } from "./contract.mjs";
import { loadResourceCaptureSchema, replayScheduledLoadResources } from "./load-resource-proof.mjs";
import { c16Env, c16Host, runnerPlacement } from "./placement.mjs";
import { productionFixture } from "./production-fixtures.mjs";
import { deriveProductionPhase } from "./production.mjs";
import { inspectJson } from "./report.mjs";

const reason = "load-generator-with-added-stock-output-lacks-observed-headroom";
const wide = () => runnerPlacement(c16Env, c16Host.logicalCpus);
const timedOnly = (pct) => (stage) => stage === "warmup" ? 10 : pct;

async function fixture(t, options) {
  const folder = mkdtempSync(join(tmpdir(), "json-c16-headroom-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  return productionFixture(folder, options);
}

// One saved fixed phase and the inputs replay gives deriveProductionPhase.
function savedPhase(f) {
  const app = f.summary.group.apps[0], profile = f.summary.group.cases[0], entry = f.summary.apps[app], run = entry.runs[profile.key][0];
  const raw = f.load(run.phases.fixed.raw), native = f.load(entry.checks[profile.key].native), stream = f.load.stream(raw.eventStream);
  const context = runtimeContext(f.summary, profile);
  return { run, raw, metrics: run.phases.fixed.metrics,
    legacy: (r) => deriveProductionPhase(r, run.identity, "fixed", f.summary.options, f.summary.tools, context, { native, stream }),
    scheduled: (r) => deriveProductionPhase(r, run.identity, "fixed", f.summary.options, f.summary.tools,
      { ...context, producerSchema: scheduledProducerSchema }, { native, stream }) };
}

// The saved phase as the scheduled producer records it: three 1 s load acquisitions
// whose CPU counter rises by `pct` percent of one core per interval (999 ms elapsed).
function scheduledAt(raw, pct) {
  const scheduled = structuredClone(raw), start = scheduled.command.clock.startedAt, finish = start + 4500;
  const live = scheduled.after.liveness.load;
  live.finishedAt = new Date(finish).toISOString();
  scheduled.command.clock.finishedAt = finish;
  scheduled.after.at = finish + 10;
  scheduled.settledAt = finish + 20;
  delete scheduled.samples.load;
  const participant = { pid: 42, processObject: "1:2", startTicks: "1234", path: `/system.slice/docker-${live.containerId}.scope`,
    mount: "36 27 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup rw", groupObject: "3:4", populated: true };
  scheduled.loadResources = { schema: loadResourceCaptureSchema, live: { id: live.containerId, pid: 42, startedAt: live.startedAt },
    rows: Array.from({ length: 3 }, (_, sequence) => {
      const at = start + 1050 + sequence * 1000;
      return { sequence, begin: { at, monotonic: at - start }, end: { at, monotonic: at - start },
        before: participant, after: participant, usageUsec: sequence * Math.round(pct * 9990), memoryCurrent: 9 * 2 ** 20, inactiveFile: 2 ** 20 };
    }) };
  return scheduled;
}

test("a c-16 result whose k6 peaks at 500% is accepted, and the same samples refuse under the default layout", async (t) => {
  const c16 = await fixture(t, { placement: wide(), loadCpu: () => 500 });
  assert.equal(c16.summary.measurement.cpus.load.quota, 12);
  const accepted = inspectJson(c16.summary, { load: c16.load });
  assert.equal(accepted.baseline, true, accepted.warnings.slice(0, 4).join("\n"));
  const phase = savedPhase(c16);
  assert.equal(phase.metrics.apparatus.load.cpuMaxPct, 500);
  assert.deepEqual(phase.metrics.incompleteReasons, []);
  assert.deepEqual(phase.legacy(phase.raw).incompleteReasons, []);

  const base = await fixture(t, { loadCpu: timedOnly(500) });
  assert.equal(base.summary.measurement.cpus.load.quota, 4);
  const refused = inspectJson(base.summary, { load: base.load });
  assert.equal(refused.baseline, false);
  assert.ok(refused.warnings.some((w) => w.includes(reason)), refused.warnings.slice(0, 4).join("\n"));
  const saved = savedPhase(base);
  assert.equal(saved.metrics.apparatus.load.cpuMaxPct, 500);
  assert.ok(saved.metrics.incompleteReasons.includes(reason));
  // A 500% warmup under the default layout cannot even complete its warmup.
  const warm = await fixture(t, { loadCpu: () => 500 });
  assert.equal(inspectJson(warm.summary, { load: warm.load }).baseline, false);
  assert.ok(warm.summary.failures.some((x) => /warmup apparatus\/source observation incomplete/.test(x.error)), JSON.stringify(warm.summary.failures[0]));

  // Scheduled load resources: the same 500% replays with headroom at quota 12 only.
  const c16Scheduled = scheduledAt(phase.raw, 500), baseScheduled = scheduledAt(saved.raw, 500);
  const derived = phase.scheduled(c16Scheduled);
  assert.equal(derived.apparatus.load.cpuMaxPctUpper, 500);
  assert.equal(derived.apparatus.load.loadHasHeadroom, true);
  assert.deepEqual(derived.incompleteReasons, []);
  const baseDerived = saved.scheduled(baseScheduled);
  assert.equal(baseDerived.apparatus.load.cpuMaxPctUpper, 500);
  assert.equal(baseDerived.apparatus.load.loadHasHeadroom, false);
  assert.ok(baseDerived.incompleteReasons.includes(reason));
  const life = c16Scheduled.after.liveness.load, memoryBytes = c16Scheduled.before.participants.load.memoryBytes;
  assert.equal(replayScheduledLoadResources(c16Scheduled.loadResources, life, { memoryBytes, quota: 12 }).loadHasHeadroom, true);
  assert.equal(replayScheduledLoadResources(c16Scheduled.loadResources, life, { memoryBytes, quota: 4 }).loadHasHeadroom, false);
});

test("a c-16 result whose k6 reaches 960% is refused for load headroom on both sample paths", async (t) => {
  const f = await fixture(t, { placement: wide(), loadCpu: timedOnly(960) });
  const report = inspectJson(f.summary, { load: f.load });
  assert.equal(report.baseline, false);
  assert.ok(report.warnings.some((w) => w.includes(reason)), report.warnings.slice(0, 4).join("\n"));
  const phase = savedPhase(f);
  assert.equal(phase.metrics.apparatus.load.cpuMaxPct, 960);
  assert.ok(phase.metrics.incompleteReasons.includes(reason));
  // The legacy bound is exactly 960%: just below it is accepted.
  const below = structuredClone(phase.raw);
  for (const s of below.samples.load) s.cpu = 959.9;
  assert.deepEqual(phase.legacy(below).incompleteReasons, []);
  // A 960% warmup stops the c-16 run before timing.
  const warm = await fixture(t, { placement: wide(), loadCpu: () => 960 });
  assert.equal(inspectJson(warm.summary, { load: warm.load }).baseline, false);
  assert.ok(warm.summary.failures.some((x) => /warmup apparatus\/source observation incomplete/.test(x.error)), JSON.stringify(warm.summary.failures[0]));

  for (const [pct, headroom] of [[959, true], [960, false], [1000, false]]) {
    const derived = phase.scheduled(scheduledAt(phase.raw, pct));
    assert.equal(derived.apparatus.load.cpuMaxPctUpper, pct);
    assert.equal(derived.apparatus.load.loadHasHeadroom, headroom, `${pct}%`);
    assert.equal(derived.incompleteReasons.includes(reason), !headroom, `${pct}%`);
  }
});

test("c-32 replays k6 above the r93 c-16 fence but still refuses exactly 1600%", async (t) => {
  const c32 = runnerPlacement({ ...c16Env, JSON_API_LOAD_LAYOUT: "json-c32-generator-v1", JSON_API_LOAD_CPUS: "4-23" }, 32);
  const f = await fixture(t, { placement: c32, loadCpu: () => 983.13 });
  const report = inspectJson(f.summary, { load: f.load });
  assert.equal(report.baseline, true, report.warnings.slice(0, 4).join("\n"));
  const phase = savedPhase(f);
  for (const [pct, headroom] of [[983.13, true], [1599.9, true], [1600, false]]) {
    const raw = structuredClone(phase.raw);
    for (const sample of raw.samples.load) sample.cpu = pct;
    assert.equal(phase.legacy(raw).incompleteReasons.includes(reason), !headroom, `legacy ${pct}%`);
    const scheduled = phase.scheduled(scheduledAt(phase.raw, pct));
    assert.ok(Math.abs(scheduled.apparatus.load.cpuMaxPctUpper - pct) < 0.001);
    assert.equal(scheduled.apparatus.load.loadHasHeadroom, headroom, `scheduled ${pct}%`);
    assert.equal(scheduled.incompleteReasons.includes(reason), !headroom, `scheduled ${pct}%`);
  }
});
