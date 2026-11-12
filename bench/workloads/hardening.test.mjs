import assert from "node:assert/strict";
import { test } from "node:test";
import { hardeningCaptureSchema, hardeningContract, validateHardeningComparison, validateHardeningOutcome } from "./hardening.mjs";

// Synthetic oracle fixtures, not measurements or a reviewed production attack profile.
function fixture(mode = "direct") {
  const deployment = { mode, countAllProcesses: true, processes: [{ id: "app", role: "application", count: 1 }] };
  if (mode === "deployed-edge") deployment.processes.push({ id: "edge", role: "proxy", count: 1 });
  const settings = { review: "fixture-only", case: mode, phase: "slow-headers", deployment,
    effectiveBudgets: JSON.stringify({ attack: { scheduledAtMs: [10, 13, 16] }, legitimate: {
      before: { startMs: 0, endMs: 10, scheduledAtMs: [1, 3, 5, 7] },
      during: { startMs: 10, endMs: 20, scheduledAtMs: [11, 13, 15, 17] },
      after: { startMs: 20, endMs: 30, scheduledAtMs: [21, 23, 25, 27] },
    }, timing: { maxStartLagMs: 1, maxWindowDriftMs: 0 },
      resources: { cpuCoresTotal: 1, memoryBytesTotal: 4096, observation: "all-processes" }, recovery: { attempts: 1 }, cleanup: { owned: "all" } }) };
  const observed = (startMs, endMs) => ({ startMs, endMs, counts: { sent: 4, ok: 4, errors: 0 },
    startedAtMs: [1, 3, 5, 7].map((at) => startMs + at),
    latency: { p50Ms: 1, p99Ms: 2, maxMs: 3 }, evidence: "raw/legitimate" });
  const resource = (atMs) => deployment.processes.map((p) => ({ id: p.id, count: p.count, atMs,
    running: true, oomKilled: false, cpuSeconds: 1, memoryBytes: 1024, evidence: "raw/resources" }));
  const capture = { schema: hardeningCaptureSchema, contract: hardeningContract,
    case: mode, phase: settings.phase, deployment: structuredClone(deployment), effectiveBudgets: settings.effectiveBudgets,
    parity: { status: "passed", contract: "fixture-functional/v1", evidence: "raw/parity" },
    provenance: deployment.processes.map((p) => ({ id: p.id, source: "fixture-source", image: "fixture-image-digest", config: "fixture-config-digest" })),
    apparatus: {
      injector: { healthy: true, scheduled: 3, attempted: 3, errors: 0, dropped: 0, evidence: "raw/injector" },
      host: { healthy: true, evidence: "raw/host" },
      controls: { attackValid: true, legitimateValid: true, evidence: "raw/controls" },
      artifacts: { complete: true, evidence: "raw/artifacts" },
      cleanup: { complete: true, atMs: 31, connections: 0, processes: 0, tasks: 0, evidence: "raw/cleanup" },
    },
    attack: { attempted: 3, established: 3, failed: 0, closed: 3, held: 0, startedAtMs: [10, 13, 16], evidence: "raw/attack" },
    legitimate: { before: observed(0, 10), during: observed(10, 20), after: observed(20, 30) },
    resources: { before: resource(5), during: resource(15), after: resource(30) },
    recovery: { attempted: true, startMs: 20, endMs: 30, disposition: "recovered", evidence: "raw/recovery" },
    defense: { protection: "observed", reason: "fixture connections closed", attribution: [
      { layer: mode === "direct" ? "server" : "proxy", mechanism: "fixture header limit", evidence: "raw/defense" },
    ] },
  };
  return { settings, capture };
}

const unavailable = { status: "unavailable", reason: "no successful request latency samples" };
const validate = ({ capture, settings }) => validateHardeningOutcome(capture, settings);
const invalid = (mutate, kind = "evidence") => {
  const f = fixture(); mutate(f.capture, f.settings);
  assert.throws(() => validate(f), (e) => e.kind === kind && e.message.startsWith(`hardening ${kind}:`));
};

test("versioned direct and edge captures preserve outcomes without mutating input or creating timers", () => {
  for (const mode of ["direct", "deployed-edge"]) {
    const f = fixture(mode), before = structuredClone(f);
    const result = validate(f);
    assert.equal(result.measurement, "complete");
    assert.equal(result.contract, hardeningContract);
    assert.deepEqual(result.legitimate, f.capture.legitimate);
    assert.deepEqual(result.resources, f.capture.resources);
    assert.deepEqual(result.defense, f.capture.defense);
    assert.deepEqual(f, before);
    result.defense.protection = "missing";
    assert.equal(f.capture.defense.protection, "observed", "result must not alias saved evidence");
  }
});

test("zero useful service, exhaustion and a stopped app are visible measured outcomes, not apparatus errors", () => {
  const f = fixture();
  for (const key of ["during", "after"]) {
    f.capture.legitimate[key].counts = { sent: 4, ok: 0, errors: 4 };
    f.capture.legitimate[key].latency = unavailable;
    f.capture.resources[key][0].running = false;
    f.capture.resources[key][0].oomKilled = true;
  }
  f.capture.recovery.disposition = "stopped";
  f.capture.defense.protection = "missing";
  const result = validate(f);
  assert.equal(result.measurement, "complete");
  assert.equal(result.legitimate.during.counts.ok, 0);
  assert.equal(result.recovery.disposition, "stopped");
  assert.equal(result.defense.protection, "missing");
  const peer = fixture();
  assert.equal(validateHardeningComparison([f, peer]).length, 2, "bad defenses must not filter a comparison");
});

test("missing, unsupported and inconclusive protection stays visible independently of healthy service", () => {
  for (const protection of ["missing", "unsupported", "inconclusive"]) {
    const f = fixture(); f.capture.defense.protection = protection;
    assert.equal(validate(f).defense.protection, protection);
  }
});

test("explicit unavailable counts, latency and CPU/memory are retained, never converted to zero", () => {
  const f = fixture();
  f.capture.legitimate.during.counts = { status: "unavailable", reason: "client recorder lost its counter export" };
  f.capture.legitimate.during.latency = unavailable;
  f.capture.resources.after[0].cpuSeconds = { status: "unavailable", reason: "process exited before CPU read" };
  f.capture.resources.after[0].memoryBytes = { status: "unavailable", reason: "process exited before memory read" };
  assert.deepEqual(validate(f).legitimate.during, f.capture.legitimate.during);
  f.capture.legitimate.during.counts = { sent: 4, ok: 0, errors: 4 };
  assert.equal(validate(f).legitimate.during.counts.ok, 0);
});

test("functional parity is a prerequisite, not a protection requirement or a hidden row filter", () => {
  for (const status of ["failed", "unsupported", "not-run"]) {
    const f = fixture(); f.capture.parity.status = status;
    assert.equal(validate(f).measurement, "parity-blocked");
    assert.equal(validate(f).parity.status, status);
    assert.throws(() => validateHardeningComparison([f, fixture()]), (e) => e.kind === "parity");
  }
});

test("injector, host, controls, artifact and cleanup failures cannot become defense failures", () => {
  for (const mutate of [
    (c) => { c.apparatus.injector.healthy = false; },
    (c) => { c.apparatus.injector.errors = 1; },
    (c) => { c.apparatus.injector.dropped = 1; },
    (c) => { c.apparatus.injector.attempted = 2; },
    (c) => { c.apparatus.host.healthy = false; },
    (c) => { c.apparatus.controls.attackValid = false; },
    (c) => { c.apparatus.controls.legitimateValid = false; },
    (c) => { delete c.apparatus.controls.evidence; },
    (c) => { c.apparatus.cleanup.complete = false; },
    (c) => { c.apparatus.cleanup.connections = 1; },
    (c) => { c.apparatus.cleanup.processes = 1; },
    (c) => { c.apparatus.cleanup.tasks = 1; },
    (c) => { c.apparatus.cleanup.atMs = 25; },
  ]) invalid(mutate, "harness");
  invalid((c) => { c.apparatus.artifacts.complete = false; });
  invalid((c) => { delete c.apparatus.artifacts.evidence; });
});

test("counter corruption, omitted measurements, invalid clocks and unsupported versions fail closed", () => {
  for (const mutate of [
    (c) => { c.schema = "hardening-capture/v0"; },
    (c) => { c.contract = "hardening-outcome/v2"; },
    (c) => { c.attack.attempted = 4; },
    (c) => { c.attack.established = -1; },
    (c) => { c.attack.closed = 4; },
    (c) => { c.attack.held = 0.5; },
    (c) => { c.legitimate.during.counts.errors = 1; },
    (c) => { c.legitimate.during.counts.ok = NaN; },
    (c) => { c.legitimate.during.latency.p99Ms = Infinity; },
    (c) => { c.legitimate.during.latency.maxMs = 0; },
    (c) => { c.legitimate.during.latency = null; },
    (c) => { delete c.legitimate.after.counts; },
    (c) => { c.legitimate.during.startMs = 9; },
    (c) => { c.resources.during = []; },
    (c) => { c.resources.during[0] = null; },
    (c) => { c.resources.during[0].count = 2; },
    (c) => { c.resources.during[0].atMs = 25; },
    (c) => { c.resources.during[0].memoryBytes = -1; },
    (c) => { c.resources.during[0].cpuSeconds = {}; },
    (c) => { c.resources.during[0].oomKilled = true; },
    (c) => { c.provenance = []; },
    (c) => { c.provenance[0] = null; },
    (c) => { delete c.provenance[0].config; },
    (c) => { c.recovery.attempted = false; },
    (c) => { c.recovery.disposition = "pending"; },
    (c) => { c.recovery.disposition = "stopped"; },
    (c) => { c.recovery.disposition = "terminated"; },
    (c) => { c.recovery.startMs = 19; },
    (c) => { c.recovery.endMs = 31; },
    (c) => { c.legitimate.after.counts = { sent: 4, ok: 0, errors: 4 }; c.legitimate.after.latency = unavailable; },
    (c) => { c.defense.attribution = []; },
    (c) => { c.defense.attribution[0] = null; },
    (c) => { c.defense.attribution[0].layer = "proxy"; },
    (c) => { c.parity.status = "ready"; },
  ]) invalid(mutate);
});

test("valid refused attack connections are not mistaken for a broken injector", () => {
  const f = fixture();
  f.capture.attack = { ...f.capture.attack, attempted: 3, established: 0, failed: 3, closed: 0, held: 0, evidence: "raw/refusals" };
  assert.equal(validate(f).measurement, "complete");
});

test("comparison permits different fully charged native inventories within the same deployment mode and total budgets", () => {
  for (const mode of ["direct", "deployed-edge"]) {
    const first = fixture(mode), native = fixture(mode);
    const processes = [{ id: "php-workers", role: "application", count: 2 }, { id: "php-manager", role: "application", count: 1 }];
    if (mode === "deployed-edge") processes.push({ id: "native-proxy", role: "proxy", count: 2 });
    native.settings.deployment.processes = structuredClone(processes);
    native.capture.deployment.processes = structuredClone(processes);
    native.capture.provenance = processes.map((p) => ({ ...native.capture.provenance[0], id: p.id }));
    for (const samples of Object.values(native.capture.resources)) {
      const sample = samples[0];
      samples.splice(0, samples.length, ...processes.map((p) => ({ ...sample, id: p.id, count: p.count })));
    }
    assert.equal(validateHardeningComparison([first, native]).length, 2);
    assert.equal(native.capture.effectiveBudgets, first.capture.effectiveBudgets);
    native.capture.resources.during.pop();
    assert.throws(() => validate(native), /every process/, "native inventories must still charge every process");
  }
});

test("unavailable counters or no successful baseline remain outcomes, never numeric comparative claims", () => {
  for (const key of ["before", "during", "after"]) {
    const f = fixture();
    f.capture.legitimate[key].counts = { status: "unavailable", reason: "counter observation unavailable" };
    f.capture.legitimate[key].latency = unavailable;
    if (key === "after") f.capture.recovery.disposition = "not-recovered";
    assert.equal(validate(f).measurement, "unavailable");
    assert.throws(() => validateHardeningComparison([fixture(), f]), /baseline|counts/);
  }
  const f = fixture();
  f.capture.legitimate.before.counts = { sent: 4, ok: 0, errors: 4 };
  f.capture.legitimate.before.latency = unavailable;
  assert.equal(validate(f).measurement, "unavailable");
  assert.throws(() => validateHardeningComparison([fixture(), f]), /baseline/);
});

test("comparison requires matching direct/edge mode and serialized budgets, each capture its own reviewed inventory", () => {
  assert.equal(validateHardeningComparison([fixture(), fixture()]).length, 2);
  assert.throws(() => validateHardeningComparison([null, fixture()]), (e) => e.kind === "evidence");
  for (const mutate of [
    (f) => { const budgets = JSON.parse(f.capture.effectiveBudgets); budgets.resources.cpuCoresTotal = 2;
      f.settings.effectiveBudgets = f.capture.effectiveBudgets = JSON.stringify(budgets); },
    (f) => { f.settings.effectiveBudgets = f.capture.effectiveBudgets = JSON.stringify(JSON.parse(f.capture.effectiveBudgets), null, 2); },
    (f) => { f.settings.phase = f.capture.phase = "slow-bodies"; },
    (f) => { f.capture.parity.contract = "another-functional/v1"; },
  ]) {
    const other = fixture(); mutate(other);
    validate(other);
    assert.throws(() => validateHardeningComparison([fixture(), other]), /incomparable/);
  }
  assert.throws(() => validateHardeningComparison([fixture(), fixture("deployed-edge")]), /incomparable/);
  invalid((c) => { c.deployment.countAllProcesses = false; });
  invalid((c) => { c.deployment.processes[0].id = "unreviewed-id"; });
  invalid((c) => { c.deployment.processes[0].count = 2; });
  invalid((c, s) => { c.deployment.countAllProcesses = s.deployment.countAllProcesses = false; });
  invalid((c) => { c.effectiveBudgets = "{}"; });
  invalid((c, s) => { c.effectiveBudgets = s.effectiveBudgets = "{}"; });
  invalid((c, s) => { c.effectiveBudgets = s.effectiveBudgets = "{"; });
  invalid((c, s) => { delete s.review; });
  const edge = fixture("deployed-edge"); edge.capture.resources.during.pop();
  assert.throws(() => validate(edge), /every process/);
});

test("P1: one attack cannot substitute for three under the same serialized reviewed schedule", () => {
  const f = fixture();
  Object.assign(f.capture.apparatus.injector, { scheduled: 1, attempted: 1 });
  Object.assign(f.capture.attack, { attempted: 1, established: 1, closed: 1, startedAtMs: [10] });
  assert.throws(() => validate(f), (e) => e.kind === "harness");
  assert.throws(() => validateHardeningComparison([fixture(), f]), (e) => e.kind === "harness");
});

test("P1: zero legitimate attempts cannot substitute for four during attack", () => {
  const f = fixture();
  f.capture.legitimate.during.counts = { sent: 0, ok: 0, errors: 0 };
  f.capture.legitimate.during.startedAtMs = [];
  f.capture.legitimate.during.latency = unavailable;
  assert.throws(() => validate(f), (e) => e.kind === "harness");
  assert.throws(() => validateHardeningComparison([fixture(), f]), (e) => e.kind === "harness");
});

test("P1: a 19990ms window cannot substitute for a planned 10ms observation", () => {
  const f = fixture(), c = f.capture;
  c.legitimate.during.endMs = 20000;
  c.legitimate.after.startMs = 20000; c.legitimate.after.endMs = 20010;
  c.legitimate.after.startedAtMs = [20001, 20003, 20005, 20007];
  c.resources.after[0].atMs = 20010;
  c.recovery.startMs = 20000; c.recovery.endMs = 20010;
  c.apparatus.cleanup.atMs = 20011;
  assert.throws(() => validate(f), (e) => e.kind === "harness");
  assert.throws(() => validateHardeningComparison([fixture(), f]), (e) => e.kind === "harness");
});

test("attempt records and counters independently prove all scheduled work within reviewed timing bounds", () => {
  for (const mutate of [
    (c) => { delete c.attack.startedAtMs; },
    (c) => { c.attack.startedAtMs.pop(); },
    (c) => { c.attack.startedAtMs.push(18); },
    (c) => { c.attack.startedAtMs[1] = 12; },
    (c) => { c.attack.startedAtMs[1] = 15; },
    (c) => { c.attack.startedAtMs[1] = NaN; },
    (c) => { c.legitimate.during.startedAtMs = []; },
    (c) => { c.legitimate.during.startedAtMs[0] = 13; },
    (c) => { c.legitimate.during.startedAtMs[0] = 10; },
    (c) => { c.legitimate.during.counts = { sent: 0, ok: 0, errors: 0 }; c.legitimate.during.latency = unavailable; },
  ]) invalid(mutate, "harness");
  for (const key of ["before", "during", "after"]) {
    invalid((c) => { c.legitimate[key].startedAtMs.pop(); }, "harness");
  }
});

test("reviewed timing tolerance permits bounded observation drift and start lag, not incomplete work", () => {
  const f = fixture(), c = f.capture, plan = JSON.parse(f.settings.effectiveBudgets);
  plan.timing.maxWindowDriftMs = 1;
  f.settings.effectiveBudgets = c.effectiveBudgets = JSON.stringify(plan);
  c.attack.startedAtMs = c.attack.startedAtMs.map((at) => at + 1);
  for (const key of ["before", "during", "after"]) {
    c.legitimate[key].startMs += 1; c.legitimate[key].endMs += 1;
    c.legitimate[key].startedAtMs = c.legitimate[key].startedAtMs.map((at) => at + 1);
    for (const sample of c.resources[key]) sample.atMs += 1;
  }
  c.recovery.startMs += 1; c.recovery.endMs += 1; c.apparatus.cleanup.atMs += 1;
  assert.equal(validate(f).measurement, "complete");
  c.legitimate.after.endMs += 1; c.apparatus.cleanup.atMs += 1;
  assert.throws(() => validate(f), (e) => e.kind === "harness");
});

test("deterministic nonempty schedules and timing bounds must come from the reviewed plan", () => {
  for (const mutate of [
    (p) => { delete p.timing; },
    (p) => { p.timing.maxStartLagMs = -1; },
    (p) => { p.timing.maxWindowDriftMs = null; },
    (p) => { delete p.attack.scheduledAtMs; },
    (p) => { p.attack.scheduledAtMs = []; },
    (p) => { p.attack.scheduledAtMs = [16, 13, 10]; },
    (p) => { p.attack.scheduledAtMs = [9, 13, 16]; },
    (p) => { p.legitimate.during.scheduledAtMs = []; },
    (p) => { p.legitimate.before.scheduledAtMs[0] = null; },
    (p) => { p.legitimate.during.endMs = p.legitimate.during.startMs; },
    (p) => { p.legitimate.after.startMs = 19; },
  ]) {
    const f = fixture(), plan = JSON.parse(f.settings.effectiveBudgets); mutate(plan);
    f.settings.effectiveBudgets = f.capture.effectiveBudgets = JSON.stringify(plan);
    assert.throws(() => validate(f), (e) => e.kind === "evidence");
  }
});
