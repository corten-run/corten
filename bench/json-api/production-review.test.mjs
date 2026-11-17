// Focused production v2 review controls. Each test builds at most one synthetic roster.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { inspectJson, renderJson } from "./report.mjs";
import { descriptor, loadConfig, runtimeContext } from "./contract.mjs";
import { capturePhase } from "./phase.mjs";
import { phaseFixture, productionFixture } from "./production-fixtures.mjs";
import { replayTimedRun } from "./evidence.mjs";

const scratch = (t, name) => {
  const folder = mkdtempSync(join(tmpdir(), name));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  return folder;
};

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
