// Focused production v2 review controls. Each test builds at most one synthetic roster.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { inspect } from "node:util";
import { reader, writer } from "./artifacts.mjs";
import { inspectJson, renderJson } from "./report.mjs";
import { descriptor, loadConfig, runtimeContext } from "./contract.mjs";
import { capturePhase } from "./phase.mjs";
import { phaseFixture, productionFixture } from "./production-fixtures.mjs";
import { replayTimedRun } from "./evidence.mjs";
import { deriveProductionPhase } from "./production.mjs";
import { timedCaseProjection } from "./timed-outcomes.mjs";

const scratch = (t, name) => {
  const folder = mkdtempSync(join(tmpdir(), name));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  return folder;
};

test("saved artifact reference refusals do not reflect keys or digests", async (t) => {
  const folder = scratch(t, "json-v2-artifact-"), load = reader(folder);
  const good = writer(folder)("receipt.json", { ok: true });
  const bytes = { ...good, bytes: Buffer.byteLength(JSON.stringify({ ok: true }, null, 2)) };
  assert.deepEqual(load(good), { ok: true });
  assert.deepEqual(JSON.parse(load.bytes(bytes, 512)), { ok: true });
  const key = "SAVED_ARTIFACT_KEY_CANARY", digest = "f3".repeat(32);
  const malformed = "SAVED_ARTIFACT_TEXT_CANARY";
  writeFileSync(join(folder, "invalid.json"), malformed);
  const invalid = { path: "invalid.json", sha256: createHash("sha256").update(malformed).digest("hex") };
  const stream = { encoding: "identity", bytes: 1, sha256: digest, events: 1, points: 1, metrics: 1, firstNs: "1", lastNs: "1" };
  for (const [label, read, canary, message] of [
    ["JSON key", () => load({ ...good, [key]: true }), key, "artifact reference must bind path and hash"],
    ["byte key", () => load.bytes({ ...bytes, [key]: true }, 512), key, "raw byte reference required"],
    ["stream reference key", () => load.stream({ path: good.path, receipt: stream, [key]: true }), key, "full raw stream reference required"],
    ["JSON digest", () => load({ ...good, sha256: digest }), digest, "raw artifact digest differs"],
    ["malformed JSON", () => load(invalid), malformed, "invalid raw artifact JSON"],
    ["byte digest", () => load.bytes({ ...bytes, sha256: digest }, 512), digest, "raw byte digest differs"],
    ["stream receipt key", () => load.stream({ path: good.path, receipt: { ...stream, [key]: true } }), key, "event fields differ"],
    ["stream receipt digest", () => load.stream({ path: good.path, receipt: { ...stream, sha256: key } }), key, "raw stream receipt hash required"],
  ]) await t.test(label, () => {
    assert.throws(read, (error) => error.message === message && !inspect(error).includes(canary));
  });
});

test("review F2: an expired native command keeps its bounded first-line cause, not a later capture assertion", async (t) => {
  const folder = scratch(t, "json-v2-cause-");
  for (const [stage, message] of [["sat64", "docker start -a json-api-k6: timeout\nstderr tail line"], ["fixed", `docker start -a json-api-k6: timeout ${"x".repeat(2000)}`]]) {
    const f = phaseFixture(stage), options = { duration: 1, warmup: 1, rate: 3 }, saved = new Map(); mkdirSync(join(folder, stage));
    // The shape process.mjs gives an observed-exit timeout: no I/O error, exit.expired true.
    const err = new Error(message); err.exit = { code: 137, signal: null, expired: true, interrupted: false }; err.clock = f.command.clock; err.ioErrors = [];
    const io = { now: () => f.command.clock.finishedAt, reads: async () => ({}), counters: async () => ({}), observe: async () => ({}),
      write(path, value) { saved.set(path, structuredClone(value)); return { path }; }, sample() { return { async stop() { return {}; } }; },
      async execute() { throw err; },
      async copy(source, target) { writeFileSync(target, JSON.stringify(source.includes("summary") ? f.summary : f.clock)); } };
    await assert.rejects(capturePhase({ folder, path: stage, stage, config: loadConfig(options, stage), expected: {}, options, tools: { node: {}, k6: {} }, context: {}, io }), (error) => {
      const raw = saved.get(error.phase.raw.path), cause = raw.captureErrors[0];
      assert.equal(cause, `native command: ${message.split("\n")[0].slice(0, 512)}`, stage);
      assert.ok(cause.length <= 512 + "native command: ".length && !cause.includes("stderr tail"), "cause is bounded to the first line");
      assert.equal(error.message, cause, "the thrown failure is the native cause");
      assert.equal(raw.captureErrors.length, 2, "the provoked capture assertion is kept after the cause");
      assert.deepEqual(raw.command.exit, err.exit); assert.deepEqual(raw.command.ioErrors, []);
      assert.equal(error.phase.metrics, null); assert.equal(raw.targetOutcome, undefined);
      return true;
    });
  }
});

test("review F1: a coherent timed target failure leaves only independently complete peers comparable", async (t) => {
  const group = descriptor(), failure = { app: group.apps[0], key: group.cases[1].key, pass: 1, phase: "fixed", responses: ["ok", "http429", "http503"] };
  const f = await productionFixture(scratch(t, "json-v2-peers-"), { failure });
  const report = inspectJson(f.summary, { load: f.load });
  assert.equal(report.warnings.length, 0, report.warnings.slice(0, 4).join("\n"));
  assert.equal(report.attemptComplete, true); assert.equal(report.baseline, false);
  const peers = group.apps.filter((app) => app !== failure.app);
  assert.deepEqual(report.comparisonEligibleApps, peers);
  assert.deepEqual(report.outcomes, group.apps.map((app) => ({ app, outcome: app === failure.app ? "failed" : "passed" })));
  for (const [app, rows] of Object.entries(report.apps)) for (const row of Object.values(rows)) {
    assert.equal(row.comparisonEligible, app === failure.app ? null : true, app);
    assert.equal(row.rps.unverifiedPartial, app === failure.app, app);
  }
  assert.equal(report.apps[failure.app][failure.key].timedOutcome, "failed");
  assert.match(report.status, new RegExp(`^COMPLETE ATTEMPT: timed target failure \\(${failure.app}\\); not a baseline; comparison eligible only for independently complete apps \\(${peers.join(", ")}\\)$`));
  assert.match(renderJson(report), new RegExp(`Comparison-eligible apps: ${peers.join(", ")}\\.`));
  // Any failed source/native audit gate, even on a peer, qualifies no peer.
  const checked = f.summary.apps[peers[0]].checks[group.cases[0].key];
  checked.nativeSourceVerified = false;
  const audit = inspectJson(f.summary, { load: f.load });
  assert.equal(audit.attemptComplete, false); assert.deepEqual(audit.comparisonEligibleApps, []);
  assert.ok(Object.values(audit.apps).every((rows) => Object.values(rows).every((r) => r.comparisonEligible === null && r.rps.unverifiedPartial)));
  assert.equal(audit.status, "INCOMPLETE: not a baseline");
  assert.ok(audit.outcomes.every((o) => o.outcome === "incomplete"));
  assert.equal(audit.apps[failure.app][failure.key].timedOutcome, "incomplete");
  assert.deepEqual(audit.apps[failure.app][failure.key].projection.byPhase.fixed.failedPasses, [1]);
});

test("check-only replays all qualification attempts and no executed timing", async (t) => {
  const f = await productionFixture(scratch(t, "json-v2-prep-"), { cells: [] }), s = f.summary;
  Object.assign(s.options, { checkOnly: true, build: true }); s.checksPassed = false;
  for (const [app, entry] of Object.entries(s.apps)) for (const [key, checked] of Object.entries(entry.checks)) {
    delete checked.native; checked.nativeSourceVerified = checked.nativeSerializationVerified = false;
    s.failures.push({ app, key, stage: "JSON qualification", error: "exactly one independently audited native receipt required" });
    entry.projections[key] = timedCaseProjection([], 1);
  }
  const inspect = () => inspectJson(s, { load: f.load }), prep = inspect();
  assert.equal(prep.functionalAttemptComplete, true); assert.equal(prep.baseline, false); assert.equal(prep.attemptComplete, false);
  assert.ok(Object.values(prep.apps).every((rows) => Object.values(rows).every((r) => r.functional && r.functionalComplete
    && !r.nativeQualified && !r.passes && r.timedOutcome === "not-run-check-only")));
  assert.ok(prep.warnings.every((w) => / native audit:|^suite outcome:/.test(w)), prep.warnings.join("\n"));
  const app = s.apps.corten, key = s.group.cases[0].key;
  app.runs[key].push({ pass: 1 }); app.checks[key].functional.jsonRecords = 0;
  const bad = inspect(); assert.equal(bad.functionalAttemptComplete, false);
  assert.ok(bad.warnings.some((w) => /timing started despite/.test(w)));
  assert.equal(bad.apps.corten[key].functionalComplete, false);
});

test("load lifetime encloses measured nanoseconds, fixed events and active generator samples; upstream is continuous", async (t) => {
  const group = descriptor(), app = group.apps[0], profile = group.cases.find((p) => p.source === "api"), key = profile.key;
  const f = await productionFixture(scratch(t, "json-v2-life-"), { cells: [`${app}/${key}`],
    failure: { app, key, pass: 1, phase: "fixed", responses: ["ok", "http429", "http503"] } });
  const entry = f.summary.apps[app], run = entry.runs[key][0], native = f.load(entry.checks[key].native);
  const args = [f.summary.options, f.summary.tools, runtimeContext(f.summary, profile)];
  const saved = run.phases.fixed, ref = saved.raw, raw = f.load(ref), stream = f.load.stream(raw.eventStream);
  const replay = () => replayTimedRun(run, run.identity, args[0], f.load, args[1], args[2], native);
  const derive = (r) => deriveProductionPhase(r, run.identity, "fixed", ...args, { stream, native });
  assert.equal(replay().phases.fixed.targetOutcome, "failed");
  for (const [role, field, keys] of [["load", "startedAt", ["before"]], ["load", "finishedAt", ["before"]],
    ["app", "finishedAt", ["before", "after"]], ["upstream", "finishedAt", ["before", "after"]]]) {
    for (const value of ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000000000Z", ["0001-01-01T00:00:00Z"],
      "not a Docker timestamp", "0001-01-01T00:00:00.000000001Z", raw.after.liveness.load.finishedAt]) {
      const bad = structuredClone(raw);
      for (const key of keys) bad[key].liveness[role][field] = value;
      if (value === "0001-01-01T00:00:00Z" || value === "0001-01-01T00:00:00.000000000Z")
        assert.equal(derive(bad).targetOutcome, "failed");
      else assert.throws(() => derive(bad), /clock (?:missing|must be unset)|RFC3339 nanosecond event timestamp required/, `${role} ${field}`);
    }
  }
  for (const change of [(s) => { s.liveness.upstream.containerId = s.participants.upstream.containerId = "9".repeat(64); },
    (s) => { s.liveness.upstream.startedAt = new Date(Date.parse(s.liveness.upstream.startedAt) + 1).toISOString(); }]) {
    const bad = structuredClone(raw); change(bad.before); change(bad.after); saved.raw = f.put(bad);
    assert.throws(replay, /upstream replaced\/restarted/);
  }
  saved.raw = ref;
  const start = raw.command.clock.startedAt, duration = raw.clock.k6DurationMs;
  const ns = (ms, fraction = "000000") => new Date(start + ms).toISOString().replace("Z", fraction + "Z");
  const r = structuredClone(raw), life = r.after.liveness.load;
  life.startedAt = ns(0, "123456"); life.finishedAt = ns(duration, "123456"); assert.equal(derive(r).targetOutcome, "failed");
  life.finishedAt = ns(duration, "123455"); assert.throws(() => derive(r), /shorter than measured/);
  life.startedAt = life.finishedAt = ns(100); r.samples.load.at(-1).cpu = 399; assert.throws(() => derive(r), /shorter than measured/);
  life.startedAt = ns(11); life.finishedAt = ns(11 + duration); assert.throws(() => derive(r), /fixed event outside/);
  life.startedAt = ns(1); life.finishedAt = ns(1 + duration);
  assert.equal(derive(r).targetOutcome, null, "399% generator remains an apparatus limit");
  r.samples.load[0].t = start; assert.throws(() => derive(r), /active load resource sample outside/);
  for (const change of [(s) => { s.completed[200]--; s.completed[503] = 1; }, (s) => s.completed[200]--,
    (s) => s.aborted++, (s) => { s.status = 503; }, (s) => { delete s.completed; }]) {
    const bad = structuredClone(raw); change(bad.after.upstreamResponses); change(bad.settledResponses);
    const observation = derive(bad); assert.equal(observation.failed, 2); assert.equal(observation.targetOutcome, null);
    assert.match(observation.incompleteReasons.join(","), /upstream-not-observed/);
  }
  const partial = structuredClone(raw);
  partial.after.upstreamReads.synthetic--; partial.upstreamReads.after.synthetic--; partial.upstreamReads.settled.synthetic--;
  partial.after.upstreamResponses.completed[200]--; partial.settledResponses.completed[200]--;
  assert.match(derive(partial).incompleteReasons.join(","), /without-observed-upstream-completion/);
});

test("cross-cell upstream restart and cleanup suppress public verdicts but retain failed requests", async (t) => {
  const group = descriptor(), app = group.apps[0], profile = group.cases.find((p) => p.source === "api"), key = profile.key;
  const f = await productionFixture(scratch(t, "json-v2-global-"), { failure: { app, key, pass: 1, phase: "fixed", responses: ["ok", "http429", "http503"] } });
  const inspect = (problem) => {
    const report = inspectJson(f.summary, { load: f.load }), row = report.apps[app][key];
    assert.ok(report.warnings.some((w) => w.includes(problem)), report.warnings.slice(0, 3).join("\n"));
    assert.ok(report.outcomes.every((o) => o.outcome === "incomplete")); assert.deepEqual(report.comparisonEligibleApps, []);
    assert.deepEqual(row.projection.byPhase.fixed.failedPasses, [1]); assert.equal(row.projection.byPhase.fixed.ranges.failed.max, 2);
    assert.equal(row.timedOutcome, "incomplete"); assert.doesNotMatch(renderJson(report), /Outcomes:.* (failed|passed)\b/);
  };
  const clean = f.summary.cleanup; f.summary.cleanup = f.put({ runId: f.summary.runId, networks: [], containers: ["leftover"] });
  inspect("owned cleanup"); f.summary.cleanup = clean;
  const run = f.summary.apps[app].runs[key][0], restart = new Date(Date.parse(f.summary.startedAt) + 1).toISOString();
  const cold = f.load(run.cold.raw); cold.upstreamLife.startedAt = restart; run.cold.raw = f.put(cold);
  for (const saved of [run.warmup, ...Object.values(run.phases)]) {
    const raw = f.load(saved.raw); raw.before.liveness.upstream.startedAt = raw.after.liveness.upstream.startedAt = restart; saved.raw = f.put(raw);
  }
  inspect("upstream replaced/restarted between timing cases");
});

test("review F3: an earlier faulted pass keeps its replayed normal99 phases and cannot hide later passes", async (t) => {
  const group = descriptor(), app = group.apps[0], key = group.cases[1].key;
  const f = await productionFixture(scratch(t, "json-v2-passes-"), { passes: 3, cells: [`${app}/${key}`],
    failure: { app, key, pass: 1, phase: "fixed", responses: ["ok", "http429", "http503"] }, fault: { app, key, pass: 1, phase: "sat256" } });
  const run = f.summary.apps[app].runs[key][0];
  assert.equal(run.complete, false); assert.match(run.failed, /^native command: docker start -a json-api-k6: timeout$/);
  assert.equal(run.phases.sat256.metrics, null);
  const context = runtimeContext(f.summary, group.cases[1]), native = f.load(f.summary.apps[app].checks[key].native);
  assert.throws(() => replayTimedRun(run, run.identity, f.summary.options, f.load, f.summary.tools, context, native), /incomplete/);
  const prefix = replayTimedRun(run, run.identity, f.summary.options, f.load, f.summary.tools, context, native, { prefix: true });
  assert.deepEqual(Object.keys(prefix.phases), ["fixed", "sat64"]); assert.equal(prefix.window, null);
  assert.equal(prefix.phases.fixed.loadOutcome, "failed");

  const report = inspectJson(f.summary, { load: f.load }), row = report.apps[app][key];
  assert.equal(report.attemptComplete, false); assert.equal(report.baseline, false); assert.deepEqual(report.comparisonEligibleApps, []);
  assert.equal(report.status, "INCOMPLETE: not a baseline");
  assert.ok(report.warnings.some((w) => w.startsWith(`${app} ${key} timing pass 1: v2 timing run incomplete`)), report.warnings.slice(0, 4).join("\n"));
  assert.ok(report.warnings.some((w) => /recorded runner failures/.test(w)));
  assert.equal(row.passes, 2, "later complete passes replay independently");
  assert.equal(row.timedOutcome, "incomplete"); assert.equal(row.comparisonEligible, null);
  assert.equal(report.outcomes.find((o) => o.app === app).outcome, "incomplete", "faulted evidence never becomes app blame");
  const { byPhase, cells } = row.projection;
  assert.deepEqual(byPhase.fixed.failedPasses, [1]); assert.equal(byPhase.fixed.present, 3);
  assert.equal(byPhase.sat64.present, 3); assert.equal(byPhase.sat256.present, 2);
  assert.deepEqual(byPhase.sat256.incompletePasses, [1]); assert.equal(cells[0].phases.sat256.state, "missing");
  assert.ok(cells.slice(1).every((c) => Object.values(c.phases).every((p) => p.state === "passed")));
  assert.ok(row.rps.unverifiedPartial);
});
