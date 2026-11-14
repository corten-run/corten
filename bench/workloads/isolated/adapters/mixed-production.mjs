// Intrinsic native replay only. Review transport and operator authority remain separate.
import assert from "node:assert/strict";
import { join } from "node:path";
import { validateSaved } from "../../../mixed-production/verify.mjs";
import { parseArgs } from "../../../mixed-production/run.mjs";
import { selectedApps, contractSha256 } from "../../registry.mjs";
import { readRegular, tree } from "../evidence.mjs";

const sources = ["fixture", "api"];
export async function inspectSaved(binding, folder) {
  const apps = selectedApps("mixed-production");
  const result = { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
    outcomes: apps.map((app) => ({ app, outcome: "not-run" })), comparisonEligibleApps: [], blockers: [] };
  let before;
  try {
    const { request, selection, execution } = binding, { invocation, effectiveOptions: options } = execution;
    assert.equal(request.group, "mixed-production"); assert.equal(request.recipe, "mixed-production-measure");
    assert.match(request.round, /^w[1-9]\d*$/); assert.match(request.commit, /^[a-f0-9]{40}$/);
    assert.equal(selection.group, request.group); assert.deepEqual(selection.apps, apps);
    assert.equal(selection.contractSha256, contractSha256(request.group)); assert.equal(binding.sources.commit, request.commit);
    const argv = ["bench/mixed-production/run.mjs", request.round, "--build", "--measure", "--profile", "matched"];
    if (options.nativeAudits !== null) {
      const round = `r${request.round.slice(1)}`;
      assert.match(options.nativeAudits, new RegExp(`^/bench/campaign/${round}-[a-f0-9]{16}/mixed-native-audits\\.json$`));
      argv.push("--native-audits", options.nativeAudits);
    }
    assert.deepEqual(invocation, { executable: "node", argv, cwd: "repository-root", shell: false });
    const expected = parseArgs(argv.slice(1)); expected.apps = apps;
    assert.deepEqual(options, expected);
    before = tree(folder);
    const summary = JSON.parse(readRegular(join(folder, "summary.json"))), plan = JSON.parse(readRegular(join(folder, "plan.json")));
    assert.deepEqual([summary.schema, summary.group, summary.round, summary.inventory, summary.contractSha256],
      ["mixed-native-run/v1", request.group, request.round, apps, selection.contractSha256]);
    assert.deepEqual(summary.options, options); assert.deepEqual(Object.keys(summary.apps).sort(), [...apps].sort());
    assert.deepEqual([summary.provenance.commit, summary.provenance.dirty, summary.provenance.nativeSource.commit, summary.provenance.nativeSource.dirty],
      [request.commit, "", request.commit, false]);
    const native = await validateSaved({ folder, round: request.round, commit: request.commit });
    assert.equal(native.schema, "mixed-native-saved-verification/v1");
    assert.deepEqual([native.round, native.commit], [request.round, request.commit]);
    assert.ok(["verified", "blocked", "failed"].includes(native.verdict));
    assert.ok(Array.isArray(native.issues) && native.issues.every((i) => ["blocked", "failed", "target-failed"].includes(i.kind)));
    // This API's failed verdict denotes invalid replay, not an observed target loss.
    if (native.verdict === "failed" || native.issues.some((i) => i.kind === "failed")) {
      result.status = "invalid"; result.blockers = ["mixed-native-replay-invalid"]; return result;
    }
    assert.deepEqual(Object.keys(native.apps).sort(), [...apps].sort());
    assert.ok(Array.isArray(plan.requests) && plan.requests.length > 0);
    const cells = sources.flatMap((source) => plan.requests.filter((r) => r.source === source).map((r) => [r.id, source]));
    assert.equal(new Set(plan.requests.map((r) => r.id)).size, plan.requests.length);
    assert.equal(cells.length, plan.requests.length); assert.ok(sources.every((s) => cells.some((c) => c[1] === s)));
    result.outcomes = apps.map((app) => {
      const value = native.apps[app]; assert.deepEqual(value.cells.map((c) => [c.requestId, c.source]), cells);
      assert.ok(value.cells.every((c) => typeof c.passed === "boolean" && Array.isArray(c.reasons)));
      let outcome = value.cells.some((c) => c.outcome === "not-run") ? "not-run"
        : value.cells.some((c) => !c.passed) || value.oracle?.result?.functionalPassed !== true ? "failed" : "passed";
      if (native.measurement) {
        assert.deepEqual(Object.keys(native.measurement.cells).sort(), [...apps].sort());
        const measured = native.measurement.cells[app]; assert.deepEqual(Object.keys(measured).sort(), [...sources].sort());
        if (sources.some((source) => measured[source].qualification?.eligible === false || measured[source].calibration?.eligible === false
          || measured[source].passes.some((pass) => pass?.eligible === false))) outcome = "failed";
      }
      return { app, outcome };
    });
    if (summary.timing) assert.deepEqual(summary.timing.cpus, binding.resources.measurement.cpu);
    const proof = native.proof; assert.equal(proof.schema, "mixed-native-saved-proof/v1");
    assert.ok(["verified", "blocked"].includes(proof.sources) && ["verified", "blocked"].includes(proof.resources));
    assert.equal(typeof proof.cleanupComplete, "boolean"); assert.ok(Array.isArray(proof.blockers));
    if (proof.sources === "verified") {
      const actual = new Map(proof.sourceFiles.map((f) => [f.path, f.sha256])); assert.equal(actual.size, proof.sourceFiles.length);
      for (const f of binding.sources.files) assert.equal(actual.get(f.path), f.sha256);
    }
    assert.equal(typeof native.attemptComplete, "boolean"); assert.equal(typeof native.complete, "boolean");
    result.resources = proof.resources; result.cleanupComplete = proof.cleanupComplete;
    assert.ok(Array.isArray(summary.failures) && Array.isArray(summary.cleanupFailures));
    if (result.cleanupComplete) { assert.deepEqual(summary.cleanupFailures, []); assert.ok(Number.isFinite(Date.parse(summary.finishedAt))); }
    const complete = native.verdict === "verified" && native.attemptComplete && native.complete
      && proof.sources === "verified" && proof.resources === "verified" && proof.cleanupComplete
      && proof.blockers.length === 0 && !native.issues.some((i) => i.kind !== "target-failed")
      && summary.failures.length === 0 && summary.cleanupFailures.length === 0;
    result.attemptComplete = complete && result.outcomes.every((r) => r.outcome !== "not-run");
    if (result.attemptComplete) {
      assert.ok(native.dispositions && [null, "native-functional", "native-qualification", "native-calibration", "native-steady"].includes(native.dispositions.gate));
      const failed = result.outcomes.some((r) => r.outcome === "failed");
      if (native.dispositions.gate !== null) assert.equal(failed, true);
      result.status = failed ? "failed" : "verified";
      if (native.comparisonEligible === true && native.dispositions.gate === null && native.measurement?.complete === true)
        result.comparisonEligibleApps = result.outcomes.filter((r) => r.outcome === "passed").map((r) => r.app);
    } else result.blockers = ["mixed-native-apparatus-or-attempt-incomplete"];
  } catch (error) {
    result.status = error?.code === "ENOENT" ? "blocked" : "invalid";
    result.attemptComplete = false; result.cleanupComplete = false; result.comparisonEligibleApps = [];
    result.blockers = ["mixed-native-proof-missing-or-contradictory"];
  } finally {
    if (before) assert.deepEqual(tree(folder), before, "native-evidence-mutated-or-invalid");
  }
  return result;
}
