import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fixtureGitEnv } from "../../scripts/fixture-git.mjs";
import { scheduledProducerMarker, scheduledProducerSchema } from "./contract.mjs";
import { legacyProducerSchema, producerProvenance } from "./production.mjs";
import { inspectJson, producerPolicyAtCommit } from "./report.mjs";
import { result } from "./test-fixtures.mjs";
import { timedSummarySchema } from "./timed-outcomes.mjs";

test("strict JSON replay reads the producer policy from the exact commit, not the working tree or saved schema", (t) => {
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
  git("commit", "--allow-empty", "-qm", "legacy producer");
  const old = git("rev-parse", "HEAD");
  const path = join(root, scheduledProducerMarker);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "source marker\n");
  assert.equal(producerPolicyAtCommit(old, root), legacyProducerSchema, "untracked marker does not alter legacy");
  git("add", "--", scheduledProducerMarker);
  git("commit", "-qm", "scheduled producer");
  const current = git("rev-parse", "HEAD");
  rmSync(path);
  assert.equal(producerPolicyAtCommit(current, root), scheduledProducerSchema, "uncommitted deletion cannot downgrade");
  assert.throws(() => producerPolicyAtCommit("0".repeat(40), root), /cannot read strict JSON producer policy/);
  const f = result(), summary = { ...f.summary, schema: timedSummarySchema, producer: producerProvenance() };
  const required = (commit) => ({ load: f.load, requiredProducer: producerPolicyAtCommit(commit, root) });
  const different = (s, options) => inspectJson(s, options).warnings.some((w) => w.includes("differs from the measured commit policy"));
  assert.equal(different(summary, required(current)), true, "legacy timed summary may not downgrade");
  assert.equal(different(f.summary, required(current)), true, "older result schema may not downgrade");
  assert.equal(different(summary, required(old)), false, "historical producer policy remains readable");
  assert.equal(different({ ...summary, producer: producerProvenance(scheduledProducerSchema) }, required(old)), true);
});
