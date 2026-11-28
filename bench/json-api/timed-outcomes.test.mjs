// Compact synthetic observations. No native headroom/source/matrix qualification.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { loadConfig } from "./contract.mjs";
import { fixedFixture } from "./fixed-test-fixtures.mjs";
import { readFixedStream } from "./fixed-stream.mjs";
import { deriveTimedObservation, timedCaseProjection, timedPhaseSchema } from "./timed-outcomes.mjs";

const options = { duration: 1, warmup: 1, rate: 3 };
function closedFixture(responses = ["ok", "http429", "http503"], phase = "sat64") {
  const { bytes, entries, ...f } = fixedFixture({ responses });
  const rateLimited = responses.filter((r) => r === "http429").length, serverErrors = responses.filter((r) => r === "http503").length;
  for (const [name, count] of [["json_rate_limited", rateLimited], ["json_server_error", serverErrors]]) {
    f.summary.metrics[name] = { count, rate: count * 1000 / f.clock.k6DurationMs };
    f.clock.metrics[name] = { values: { ...f.summary.metrics[name] } };
  }
  f.clock.schema = "json-api-closed-clock/v1";
  return { schema: timedPhaseSchema, phase, config: loadConfig(options, phase), k6: f.summary, clock: f.clock, command: f.command, logs: f.logs };
}
async function fixedRaw(t, responses = ["ok", "ok", "ok"], drops = 0) {
  const folder = mkdtempSync(join(tmpdir(), "json-timed-observation-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const f = fixedFixture({ responses, drops }), file = join(folder, "events"); writeFileSync(file, f.bytes());
  const stream = await readFixedStream(file);
  f.command.stdoutBytes = stream.receipt.bytes; f.command.stderrBytes = Buffer.byteLength(f.logs);
  return { raw: { schema: timedPhaseSchema, phase: "fixed", config: loadConfig(options, "fixed"), k6: f.summary,
    clock: f.clock, command: f.command, logs: f.logs, events: stream.receipt }, stream };
}

test("normal99 closed failures retain exhaustive counts, not a fatal or qualified target outcome", () => {
  for (const phase of ["sat64", "sat256"]) {
    const raw = closedFixture(["ok", "timeout", "http429", "http503"], phase), observed = deriveTimedObservation(raw, phase, options);
    assert.equal(observed.loadOutcome, "failed"); assert.equal(observed.observationComplete, true);
    assert.equal(observed.failed, 3); assert.equal(observed.counts.rateLimited, 1); assert.equal(observed.counts.serverErrors, 1);
    assert.equal(observed.counts.timeout, 1); assert.equal(observed.counts.ok, 1);
    assert.equal(observed.targetOutcome, null); assert.equal(observed.comparisonEligible, null);
  }
});

for (const [field, edit, message] of [
  ["schema", (raw, value) => { raw.schema = value; }, "versioned timed JSON phase required"],
  ["phase", (raw, value) => { raw.phase = value; }, "timed phase differs"],
  ["clock schema", (raw, value) => { raw.clock.schema = value; }, "closed timed native clock schema differs"],
]) {
  test(`saved phase ${field} is refused without reflecting it`, () => {
    const raw = closedFixture(), canary = "SAVED_PHASE_CANARY";
    edit(raw, canary);
    assert.throws(() => deriveTimedObservation(raw, "sat64", options), (error) => error.message === message && !inspect(error).includes(canary));
  });
}

test("ordinary late fixed starts retain observed extent; no new zero-nanosecond or nominal+one gate", async (t) => {
  for (const count of [3, 4, 5]) {
    const { raw, stream } = await fixedRaw(t, Array(count).fill("ok"));
    const observed = deriveTimedObservation(raw, "fixed", options, { stream });
    assert.equal(observed.loadOutcome, "passed"); assert.equal(observed.observationComplete, true);
    assert.equal(observed.scheduling.observedOffers, count); assert.equal(observed.scheduling.nominalArrivals, 3);
    assert.equal(observed.scheduling.monotonicSchedulerStopObserved, false); assert.equal(observed.scheduling.endpointEligible, null);
    if (count > 3) assert.equal(observed.scheduling.endpointContainedByStartObservations, false);
    assert.equal(observed.targetOutcome, null);
  }
});

test("fixed99 classified response failures complete the load observation, not source/headroom attribution", async (t) => {
  const { raw, stream } = await fixedRaw(t, ["ok", "timeout", "http429"]);
  const observed = deriveTimedObservation(raw, "fixed", options, { stream });
  assert.equal(observed.loadOutcome, "failed"); assert.equal(observed.observationComplete, true);
  assert.equal(observed.counts.rateLimited, 1); assert.equal(observed.failed, 2); assert.equal(observed.targetOutcome, null);
});

test("tail-drop observations never borrow the last start or completion grace to become complete", async (t) => {
  const { raw, stream } = await fixedRaw(t, ["ok", "ok"], 1);
  const observed = deriveTimedObservation(raw, "fixed", options, { stream });
  assert.equal(observed.dropped, 1); assert.equal(observed.scheduling.observedOffers, 3);
  assert.equal(observed.loadOutcome, "failed"); assert.equal(observed.observationComplete, false);
  assert.match(observed.incompleteReasons[0], /last-offer/); assert.equal(observed.targetOutcome, null);
});

test("warmup/abnormal/missing/corrupt/unclassified evidence is invalid, never a target failure", () => {
  const good = closedFixture();
  for (const [name, mutate] of [
    ["historical schema", (r) => r.schema = "json-api-results/v1"],
    ["phase identity", (r) => r.phase = "fixed"],
    ["clock schema", (r) => r.clock.schema = "json-api-fixed-clock/v1"],
    ["config", (r) => r.config.vus = 256],
    ["request", (r) => r.k6.metrics.http_reqs.count--],
    ["iterations", (r) => r.k6.metrics.iterations.count--],
    ["started", (r) => r.k6.metrics.json_started.count++],
    ["fractional classification", (r) => r.k6.metrics.json_ok.count = 0.5],
    ["invalid response", (r) => r.k6.metrics.json_invalid.count = 1],
    ["missing classification", (r) => delete r.k6.metrics.json_timeout],
    ["429/5xx coverage", (r) => r.k6.metrics.json_rate_limited.count++],
    ["HTTP failure count", (r) => r.k6.metrics.http_req_failed.passes--],
    ["named coverage", (r) => r.k6.root_group.checks["JSON status 200"].passes++],
    ["check inventory", (r) => r.k6.root_group.checks.other = { passes: 3, fails: 0 }],
    ["total checks", (r) => r.k6.metrics.checks.passes--],
    ["check rate", (r) => r.k6.metrics.checks.rate++],
    ["counter rate", (r) => r.k6.metrics.http_reqs.rate++],
    ["threshold", (r) => r.k6.metrics.checks.thresholds["rate==1"] = false],
    ["exit0 mismatch", (r) => r.command.exit.code = 0],
    ["signal", (r) => r.command.exit.signal = "SIGTERM"],
    ["expired", (r) => r.command.exit.expired = true],
    ["interrupted", (r) => r.command.exit.interrupted = true],
    ["I/O", (r) => r.command.ioErrors.push("write")],
    ["absent logs", (r) => delete r.logs],
    ["output failure", (r) => r.logs = JSON.stringify({ level: "error", msg: "write broken pipe" }) + "\n"],
    ["duration", (r) => r.clock.k6DurationMs = 999],
    ["grace", (r) => r.clock.k6DurationMs = 11001],
    ["host clock", (r) => r.command.clock.finishedAt = r.command.clock.startedAt],
    ["custom clock counter", (r) => r.clock.metrics.json_ok.values.count++],
    ["custom clock rate", (r) => r.clock.metrics.json_ok.values.rate++],
    ["latency", (r) => r.k6.metrics.http_req_duration["p(95)"] = 100],
  ]) { const raw = structuredClone(good); mutate(raw); assert.throws(() => deriveTimedObservation(raw, "sat64", options), undefined, name); }
  assert.throws(() => deriveTimedObservation(closedFixture(["ok", "http503", "ok"], "warmup"), "warmup", options), /warmup threshold/);
  const warmup = deriveTimedObservation(closedFixture(["ok", "ok", "ok"], "warmup"), "warmup", options);
  assert.equal(warmup.loadOutcome, "passed"); assert.equal(warmup.targetOutcome, null);
});

test("fixed full stream, byte/count/hash and under-offer joins cannot be replaced by summary-only evidence", async (t) => {
  const { raw, stream } = await fixedRaw(t);
  assert.throws(() => deriveTimedObservation(raw, "fixed", options), /full fixed raw stream/);
  for (const mutate of [(r) => r.events.sha256 = "f".repeat(64), (r) => r.command.stdoutBytes++, (r) => r.events.events--]) {
    const bad = structuredClone(raw); mutate(bad); assert.throws(() => deriveTimedObservation(bad, "fixed", options, { stream }));
  }
  const under = await fixedRaw(t, ["ok", "ok"]);
  assert.throws(() => deriveTimedObservation(under.raw, "fixed", options, { stream: under.stream }), /below offered-load floor/);
});

test("closed drops stay invalid even if coherent threshold99 metadata attempts to excuse them", () => {
  const raw = closedFixture(); raw.k6.metrics.dropped_iterations.count = 1;
  raw.k6.metrics.dropped_iterations.rate = 1000 / raw.clock.k6DurationMs;
  raw.k6.metrics.dropped_iterations.thresholds["count==0"] = true;
  assert.throws(() => deriveTimedObservation(raw, "sat64", options), /closed timed phases cannot drop/);
});

test("case projection keeps all requested passes/phases with failure ranges and null missing data", async (t) => {
  const good = deriveTimedObservation(closedFixture(["ok", "ok", "ok"]), "sat64", options);
  const failed = deriveTimedObservation(closedFixture(), "sat64", options);
  const fixed = await fixedRaw(t);
  const observedFixed = deriveTimedObservation(fixed.raw, "fixed", options, { stream: fixed.stream });
  const run = (pass, sat64) => ({ pass, phases: { fixed: observedFixed, sat64, sat256: good } });
  const negative = timedCaseProjection([run(1, good), run(2, failed), run(3, good)], 3);
  assert.equal(negative.loadOutcome, "failed"); assert.deepEqual(negative.byPhase.sat64.failedPasses, [2]);
  assert.equal(negative.byPhase.sat64.ranges.failed.min, 0); assert.equal(negative.byPhase.sat64.ranges.failed.max, 2);
  assert.equal(negative.byPhase.sat64.countRanges.rateLimited.min, 0); assert.equal(negative.byPhase.sat64.countRanges.rateLimited.max, 1);
  assert.equal(negative.targetOutcome, null); assert.equal(negative.comparisonEligible, null);
  const partial = timedCaseProjection([run(1, failed)], 3);
  assert.equal(partial.cells.length, 3); assert.equal(Object.keys(partial.cells[2].phases).length, 3);
  assert.equal(partial.cells[2].phases.sat64.requests, null); assert.equal(partial.cells[2].phases.sat64.counts, null);
  assert.equal(partial.loadOutcome, "incomplete"); assert.equal(partial.byPhase.fixed.present, 1);
  assert.deepEqual(partial.byPhase.sat64.incompletePasses, [2, 3]);
  assert.throws(() => timedCaseProjection([run(1, good), run(1, good)], 3), /duplicate/);
  assert.throws(() => timedCaseProjection([run(4, good)], 3), /foreign/);
  assert.equal(timedCaseProjection([], 3).byPhase.fixed.countRanges.ok, null);
});
