// The caller validates the binding and seals/checks the entire physical folder.
// Only this committed native validator may replay evidence. Never import saved code.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { validateSaved } from "../../../client-heavy/verify.mjs";
import { comparisonProfile, sourceRoots } from "../../../client-heavy/contract.mjs";
import { evaluateLatestStable, latestStableSources, candidateLatestStableSchema } from "../../latest-stable.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (value, names) => {
  assert.ok(object(value)); assert.deepEqual(Object.keys(value).sort(), [...names].sort());
};
const missing = new Set(["missing-required-file"]);

/**
 * status describes intrinsic native replay, not operator approval or provider ownership.
 * resources is a separate gate: callers must require it, attemptComplete and cleanupComplete.
 * Native v2 proves browser primitive accounting, not an actual OS process/quota inventory.
 * Producer handoff: retain/replay browser, renderer, server and compiler PID/start identities,
 * actual cgroup/cpuset/memory observations and their terminal state before clearing resources.
 */
export async function inspectSaved(binding, folder) {
  const apps = binding.selection.apps;
  const result = { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
    outcomes: apps.map((app) => ({ app, outcome: "not-run" })), blockers: [] };
  const block = (code) => { if (!result.blockers.includes(code)) result.blockers.push(code); };
  const read = (name) => JSON.parse(readFileSync(join(folder, name), "utf8"));
  try {
    const { group, round, commit } = binding.request;
    assert.equal(group, "client-heavy");
    const native = await validateSaved({ folder, round, commit });
    assert.ok(object(native));
    if (!["client-heavy-saved-verification/v2", "client-heavy-saved-verification/v3", "client-heavy-saved-verification/v4"].includes(native.schema)) {
      // v1 is diagnostic only; it has no source-bound plan, raw clocks or terminal proof.
      assert.equal(native.schema, "client-heavy-saved-verification/v1");
      assert.equal(native.group, group); assert.equal(native.round, round); assert.equal(native.commit, commit);
      assert.ok(Array.isArray(native.errors));
      if (native.errors.length) {
        result.status = "invalid"; result.resources = "invalid"; block("native-proof-contradictory"); return result;
      }
      keys(native.cells, apps);
      for (const row of result.outcomes) {
        assert.ok(["passed", "failed", "unsupported", "not-run"].includes(native.cells[row.app].outcome));
        row.outcome = native.cells[row.app].outcome;
      }
      block("client-heavy-v2-producer-required"); return result;
    }
    assert.equal(native.group, group); assert.equal(native.round, round); assert.equal(native.commit, commit);
    assert.ok(Array.isArray(native.errors) && Array.isArray(native.blockers));
    if (native.errors.length) {
      if (native.errors.every((e) => missing.has(e.reason))) block("native-proof-missing");
      else { result.status = "invalid"; result.resources = "invalid"; block("native-proof-contradictory"); }
      return result;
    }
    const output = read("result.json"), plan = read("plan.json"), effective = binding.execution.effectiveOptions;
    assert.equal(output.schema, native.schema.replace("saved-verification", "native"));
    const comparison = binding.request.recipe === comparisonProfile;
    assert.equal(output.schema === "client-heavy-native/v4", comparison);
    if (output.schema !== "client-heavy-native/v2") {
      result.rankingEligible = false;
      result.comparisonEligibleApps = [];
      assert.deepEqual(output.latestStable, native.latestStable);
    }
    assert.equal(output.group, group); assert.equal(output.round, round); assert.equal(output.provenance.commit, commit);
    assert.equal(plan.schema, "client-heavy-plan/v1"); assert.equal(plan.round, round); assert.equal(plan.commit, commit);
    for (const value of [output, plan, native]) assert.deepEqual(value.selectedApps, apps);
    for (const value of [output, plan]) assert.deepEqual(value.definition, binding.selection.definition);
    assert.deepEqual(plan.invocation.argv, binding.execution.invocation.argv.slice(1));
    assert.ok(["win32", "linux", "darwin"].includes(plan.platform));
    assert.equal(typeof plan.root, "string");
    const paths = plan.platform === "win32" ? win32 : posix;
    assert.ok(paths.isAbsolute(plan.root));
    assert.deepEqual(plan.invocation.effective, {
      rows: effective.rows, large: effective.large, append: effective.append, cards: effective.cards, seed: effective.seed,
      "cleanup-ms": effective.cleanupMs, "observation-ms": effective.observationMs, "timeout-ms": effective.timeoutMs,
      cargo: effective.cargo, out: paths.resolve(plan.root, effective.out),
      ...(comparison ? { profile: comparisonProfile } : {}),
    });
    if (comparison) {
      assert.equal(effective.profile, comparisonProfile);
      assert.deepEqual(plan.measurementOrder, effective.measurementOrder);
    }
    assert.deepEqual(native.invocation, plan.invocation);
    for (const value of [output, plan, native]) {
      assert.deepEqual(value === plan ? value.workload : value.effectiveWorkload, binding.execution.settings);
      assert.deepEqual(value.settings, { maxCleanupMs: effective.cleanupMs, cleanupObservationMs: effective.observationMs });
      assert.equal(value.timeoutMs, effective.timeoutMs);
    }
    keys(output.cells, apps); keys(output.builds, apps); keys(native.cells, apps);
    assert.ok(isDeepStrictEqual(read("native/build.json"), output.builds), "native build evidence differs");
    assert.deepEqual(read("native/workload.json"), binding.execution.settings);
    let contextsClosed = true;
    for (const row of result.outcomes) {
      const raw = output.cells[row.app], replayed = native.cells[row.app];
      assert.ok(["passed", "failed", "unsupported", "not-run"].includes(raw.outcome));
      assert.equal(replayed.outcome, raw.outcome);
      assert.equal(replayed.build?.outcome, output.builds[row.app].outcome);
      const measures = comparison ? raw.measurements : [raw.measurement];
      const replays = comparison ? replayed.measurements : [replayed.measurement];
      assert.equal(measures.length, replays.length);
      const captures = [raw.qualification, ...measures], passes = [replayed.qualification, ...replays];
      for (const [i, pass] of captures.entries()) {
        assert.equal(pass === null, passes[i] === null);
        if (pass !== null) {
          assert.ok(object(passes[i]) && typeof passes[i].closurePassed === "boolean");
          if (pass.lifecycle.contextCreatedAt !== null && !passes[i].closurePassed) contextsClosed = false;
        }
      }
      if (raw.outcome === "passed") {
        assert.equal(replayed.replayPassed, true);
        assert.equal(replayed.qualification?.passed, true);
        assert.equal(replays.length, comparison ? plan.measurementOrder.length : 1);
        assert.ok(replays.every((pass) => pass?.passed === true));
        assert.equal(replayed.build.outcome, "built");
      }
      row.outcome = raw.outcome;
    }
    // Compare the actual replayed input closure with the bound committed source bytes.
    // Native v2 permits Git's CRLF checkout conversion, so hash canonical text, not budgets
    // or a self-consistent review-subject/collection manifest.
    let sourceComplete = true;
    const policyPaths = new Set(Object.values(latestStableSources)), capturedPolicyBytes = new Map(), committedPolicyBytes = new Map();
    if (!native.sources) { sourceComplete = false; block("source-byte-closure-missing"); }
    else {
      const before = read("evidence/source-before.json"), after = read("evidence/source-after.json");
      assert.ok(isDeepStrictEqual(before.entries, after.entries), "native source snapshot mutated");
      assert.ok(isDeepStrictEqual(native.sources.files, before.entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))), "native source files differ");
      const expected = new Map(binding.sources.files.map((f) => [f.path, f]));
      const seen = new Set();
      for (const file of native.sources.files) {
        assert.ok(!seen.has(file.path)); seen.add(file.path);
        const bound = expected.get(file.path);
        if (!bound) { sourceComplete = false; block("source-input-outside-binding"); continue; }
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
        const bytes = readFileSync(join(folder, "evidence", "blobs", file.sha256));
        assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
        const text = bytes.toString("utf8");
        let committedBytes = bytes;
        if (file.sha256 !== bound.sha256) {
          committedBytes = Buffer.from(text.replaceAll("\r\n", "\n"));
          assert.ok(Buffer.from(text).equals(bytes) && !committedBytes.includes(13)
            && Buffer.from(committedBytes.toString().replaceAll("\n", "\r\n")).equals(bytes)
            && hash(committedBytes) === bound.sha256);
        }
        if (policyPaths.has(file.path)) { capturedPolicyBytes.set(file.path, bytes); committedPolicyBytes.set(file.path, committedBytes); }
      }
      for (const file of binding.sources.files.filter((f) => sourceRoots.some((r) => f.path === r || f.path.startsWith(`${r}/`)))) {
        if (!seen.has(file.path)) { sourceComplete = false; block("source-byte-closure-incomplete"); }
      }
    }
    if (output.schema !== "client-heavy-native/v2") {
      if ([...policyPaths].some((path) => !capturedPolicyBytes.has(path))) {
        sourceComplete = false; block("candidate-policy-source-closure-missing");
      } else {
        const evaluate = (bytes) => evaluateLatestStable({ group: "client-heavy", ...Object.fromEntries(
          Object.entries(latestStableSources).map(([key, path]) => [key, bytes.get(path)])) });
        const captured = evaluate(capturedPolicyBytes), committed = evaluate(committedPolicyBytes);
        assert.equal(captured.schema, candidateLatestStableSchema); assert.equal(captured.valid, true);
        assert.deepEqual(native.latestStable, captured);
        assert.deepEqual(binding.latestStable, committed);
      }
    }
    keys(native.intrinsic, ["valid", "complete", "passed", "cleanupPassed"]);
    assert.ok(Object.values(native.intrinsic).every((v) => typeof v === "boolean"));
    assert.equal(native.valid, native.intrinsic.valid);
    assert.equal(native.diagnosticsPassed, native.valid);
    assert.equal(native.status, !native.valid ? "invalid" : !native.intrinsic.complete ? "blocked" : native.intrinsic.passed ? "verified" : "failed");
    if (!native.valid) { result.status = "invalid"; result.resources = "invalid"; block("native-proof-contradictory"); return result; }
    assert.equal(native.intrinsic.complete, native.blockers.length === 0);
    result.attemptComplete = sourceComplete && native.intrinsic.complete;
    result.cleanupComplete = native.intrinsic.cleanupPassed && contextsClosed;
    if (native.intrinsic.passed) {
      assert.ok(result.cleanupComplete && result.outcomes.every((r) => r.outcome === "passed"));
    }
    if (native.blockers.length) block("native-proof-incomplete");
    if (!result.cleanupComplete) block("native-cleanup-incomplete");
    if (result.attemptComplete) result.status = native.intrinsic.passed ? "verified" : "failed";
    if (comparison && result.attemptComplete && result.cleanupComplete) {
      result.comparisons = Object.fromEntries(apps.filter((app) => native.cells[app].comparison)
        .map((app) => [app, native.cells[app].comparison]));
      result.comparisonEligibleApps = Object.keys(result.comparisons);
      result.rankingEligible = result.comparisonEligibleApps.length > 0;
    }
    block("actual-os-resource-inventory-missing");
    return result;
  } catch (error) {
    if (error.code === "ENOENT") block("native-proof-missing");
    else { result.status = "invalid"; result.resources = "invalid"; block("saved-binding-or-proof-contradictory"); }
    result.attemptComplete = false; result.cleanupComplete = false;
    return result;
  }
}
