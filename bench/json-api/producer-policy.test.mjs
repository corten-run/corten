import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fixtureGitEnv } from "../../scripts/fixture-git.mjs";
import { scheduledProducerMarker, scheduledProducerSchema } from "./contract.mjs";
import { gateFunctionalFixture, productionFixture } from "./production-fixtures.mjs";
import { legacyProducerSchema, producerProvenance } from "./production.mjs";
import { inspectJson, producerPolicyAtCommit, verifyProducerAtCommit } from "./report.mjs";
import { settleJsonRun } from "./run.mjs";
import { result } from "./test-fixtures.mjs";
import { timedSummarySchema } from "./timed-outcomes.mjs";

test("terminal receipt ENOSPC cannot skip owned cleanup or disposal", async () => {
  const events = [], failures = [];
  const disk = Object.assign(new Error("no space left"), { code: "ENOSPC" });
  await assert.rejects(settleJsonRun({
    observeTail() { events.push("tail"); throw disk; },
    cleanup() { events.push("remove containers", "remove network", "check absence"); },
    checkProvenance() { events.push("provenance"); },
    recordFailure(stage, error) { failures.push({ stage, error }); },
    publish() { events.push("publish"); throw disk; },
    dispose() { events.push("dispose"); },
  }), (error) => error === disk);
  assert.deepEqual(failures, [{ stage: "terminal upstream observation", error: disk }]);
  assert.deepEqual(events, ["tail", "remove containers", "remove network", "check absence", "provenance", "publish", "dispose"]);
});

test("terminal provenance failure is recorded after cleanup and before publish", async () => {
  const events = [], fault = new Error("HEAD changed");
  await settleJsonRun({
    observeTail() { events.push("tail"); },
    cleanup() { events.push("cleanup"); },
    checkProvenance() { throw fault; },
    recordFailure(stage, error) { events.push(stage); assert.equal(error, fault); },
    publish() { events.push("publish"); },
    dispose() { events.push("dispose"); },
  });
  assert.deepEqual(events, ["tail", "cleanup", "tree provenance", "publish", "dispose"]);
});

test("strict JSON replay reads the producer policy and blobs from the exact commit, not the working tree or saved schema", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "json-producer-policy-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true });
  });
  const noHooks = join(root, "empty-hooks"); mkdirSync(noHooks);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${noHooks}`, ...args], { cwd: root, env: fixtureGitEnv(),
    timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  const path = join(root, scheduledProducerMarker);
  mkdirSync(dirname(path), { recursive: true });
  const writeSources = (producer) => {
    for (const name of Object.keys(producer.sources))
      writeFileSync(join(dirname(path), name), readFileSync(new URL(name, import.meta.url)));
    git("add", "--", "bench/json-api");
  };
  writeSources(producerProvenance());
  git("commit", "-qm", "legacy producer");
  const old = git("rev-parse", "HEAD");
  writeFileSync(path, "source marker\n");
  assert.equal(producerPolicyAtCommit(old, root), legacyProducerSchema, "untracked marker does not alter legacy");
  git("add", "--", scheduledProducerMarker);
  git("commit", "-qm", "scheduled producer");
  const current = git("rev-parse", "HEAD");
  rmSync(path);
  assert.equal(producerPolicyAtCommit(current, root), scheduledProducerSchema, "uncommitted deletion cannot downgrade");
  assert.throws(() => producerPolicyAtCommit("0".repeat(40), root), /cannot read strict JSON producer policy/);
  const cwd = t.mock.method(process, "cwd", () => root);
  try {
    const f = result([], { commit: current });
    const report = inspectJson(f.summary, { load: f.load, commit: current });
    assert.equal(report.baseline, false);
    assert.equal(report.attemptComplete, false);
    assert.deepEqual(report.comparisonEligibleApps, []);
    const policyWarning = /differs from the measured commit policy/;
    assert.match(report.warnings.join("\n"), policyWarning, "legacy result schema may not downgrade");
    assert.equal(inspectJson(f.summary, { load: f.load }).baseline, true, "report-only inspection has no Git source gate");
    assert.match(inspectJson({ ...f.summary, schema: timedSummarySchema, producer: producerProvenance() },
      { load: f.load, commit: current }).warnings.join("\n"), policyWarning, "legacy timed producer may not downgrade");
    const historical = gateFunctionalFixture(await productionFixture(root, { cells: [], commit: old }));
    const legacy = inspectJson(historical.summary, { load: historical.load, commit: old });
    assert.equal(legacy.attemptComplete, true, legacy.warnings.join("\n"));
    assert.equal(legacy.baseline, false, "the historical producer is valid, but this fixture has a functional failure");
    assert.match(inspectJson({ ...historical.summary, producer: producerProvenance(scheduledProducerSchema) },
      { load: historical.load, commit: old }).warnings.join("\n"), policyWarning);
  } finally { cwd.mock.restore(); }

  const producer = producerProvenance(scheduledProducerSchema);
  assert.ok(producer.sources["process.mjs"], "the command clock and output bounds belong to the producer");
  writeSources(producer);
  git("commit", "-qm", "exact producer sources");
  const measured = git("rev-parse", "HEAD");
  verifyProducerAtCommit(producer, measured, root);
  writeFileSync(join(dirname(path), "process.mjs"), "different command process source\n");
  git("add", "--", "bench/json-api/process.mjs");
  git("commit", "-qm", "different producer bytes under same policy");
  const other = git("rev-parse", "HEAD");
  assert.equal(producerPolicyAtCommit(other, root), scheduledProducerSchema);
  assert.throws(() => verifyProducerAtCommit(producer, other, root), /differs from measured commit: process\.mjs/);
  verifyProducerAtCommit(producer, measured, root);
  // Local producer hashes alone match the verifier and therefore cannot reveal this substitution.
  const f = result([], { commit: other });
  const summary = { ...f.summary, schema: timedSummarySchema, producer };
  const useRepo = t.mock.method(process, "cwd", () => root);
  try {
    const strict = inspectJson(summary, { load: f.load, commit: other });
    assert.match(strict.warnings.join("\n"), /JSON producer differs from measured commit: process\.mjs/);
    assert.equal(strict.attemptComplete, false);
    assert.doesNotMatch(inspectJson(summary, { load: f.load }).warnings.join("\n"), /producer provenance:/);
  } finally { useRepo.mock.restore(); }
});
