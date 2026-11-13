// The caller validates the binding and seals/checks the entire physical folder.
// Only this committed native validator may replay evidence. Never import saved code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { validateSaved } from "../../../client-heavy/verify.mjs";
import { sourceRoots } from "../../../client-heavy/contract.mjs";

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
    if (native.schema !== "client-heavy-saved-verification/v2") {
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
    assert.equal(output.schema, "client-heavy-native/v2");
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
    });
    assert.deepEqual(native.invocation, plan.invocation);
    for (const value of [output, plan, native]) {
      assert.deepEqual(value === plan ? value.workload : value.effectiveWorkload, binding.execution.settings);
      assert.deepEqual(value.settings, { maxCleanupMs: effective.cleanupMs, cleanupObservationMs: effective.observationMs });
      assert.equal(value.timeoutMs, effective.timeoutMs);
    }
    keys(output.cells, apps); keys(output.builds, apps); keys(native.cells, apps);
    assert.deepEqual(read("native/build.json"), output.builds);
    assert.deepEqual(read("native/workload.json"), binding.execution.settings);
    let contextsClosed = true;
    for (const row of result.outcomes) {
      const raw = output.cells[row.app], replayed = native.cells[row.app];
      assert.ok(["passed", "failed", "unsupported", "not-run"].includes(raw.outcome));
      assert.equal(replayed.outcome, raw.outcome);
      assert.equal(replayed.build?.outcome, output.builds[row.app].outcome);
      for (const phase of ["qualification", "measurement"]) {
        assert.equal(raw[phase] === null, replayed[phase] === null);
        if (raw[phase] !== null) {
          assert.ok(object(replayed[phase]) && typeof replayed[phase].closurePassed === "boolean");
          if (raw[phase].lifecycle.contextCreatedAt !== null && !replayed[phase].closurePassed) contextsClosed = false;
        }
      }
      if (raw.outcome === "passed") {
        assert.equal(replayed.replayPassed, true);
        assert.equal(replayed.qualification?.passed, true); assert.equal(replayed.measurement?.passed, true);
        assert.equal(replayed.build.outcome, "built");
      }
      row.outcome = raw.outcome;
    }
    // Compare the actual replayed input closure with the bound committed source bytes.
    // Native v2 permits Git's CRLF checkout conversion, so hash canonical text, not budgets
    // or a self-consistent review-subject/collection manifest.
    let sourceComplete = true;
    if (!native.sources) { sourceComplete = false; block("source-byte-closure-missing"); }
    else {
      const before = read("evidence/source-before.json"), after = read("evidence/source-after.json");
      assert.deepEqual(before.entries, after.entries);
      assert.deepEqual(native.sources.files, before.entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
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
        assert.ok(file.sha256 === bound.sha256 || (Buffer.from(text).equals(bytes)
          && hash(Buffer.from(text.replaceAll("\r\n", "\n"))) === bound.sha256));
      }
      for (const file of binding.sources.files.filter((f) => sourceRoots.some((r) => f.path === r || f.path.startsWith(`${r}/`)))) {
        if (!seen.has(file.path)) { sourceComplete = false; block("source-byte-closure-incomplete"); }
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
    block("actual-os-resource-inventory-missing");
    return result;
  } catch (error) {
    if (error.code === "ENOENT") block("native-proof-missing");
    else { result.status = "invalid"; result.resources = "invalid"; block("saved-binding-or-proof-contradictory"); }
    result.attemptComplete = false; result.cleanupComplete = false;
    return result;
  }
}
