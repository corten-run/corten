import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgets, validateBudget, matrix, apps, phases, cases, sources, parseArgs, selected, groupReady, schema } from "./plan.mjs";
import { artifacts, verifyArtifacts, verifyParity } from "./evidence.mjs";

test("all selected native candidates, sources, deployments and phases remain visible", () => {
  const cells = matrix(); assert.equal(cells.length, apps.length * sources.length * cases.length * phases.length);
  assert.deepEqual(apps, ["corten", "aspnet", "spring", "nextjs", "django", "express", "gin", "drogon", "topcoat"]);
  assert.equal(schema, "native-hardening-run/v3");
  assert.deepEqual(phases, ["request-timeout", "request-limit", "dependency-recovery"]);
  assert.deepEqual(sources, ["fixture", "api"]);
  assert.deepEqual(cases, ["direct", "deployed-edge"]);
  const o = parseArgs(["w1", "--review", "test-only", "--verify-app", "express", "--verify-case", "direct"]);
  assert.equal(cells.filter((c) => selected(c, o)).length, 6); assert.equal(cells.length, 108);
  assert.equal(groupReady(cells), false); assert.throws(() => groupReady(cells.slice(1)), /matrix/);
  assert.throws(() => parseArgs(["--build"]), /round/);
  assert.throws(() => parseArgs(["r17", "--review", "not-official"]), /round/);
  for (const args of [["--apps", "express"], ["--verify-app", "missing"], ["--profile", "bounded", "--profile", "bounded"], ["--review"],
    ["--verify-phase", "slow-headers"], ["--profile", "sustained"], ["--target", "https://example.invalid"]])
    assert.throws(() => parseArgs(["w2", "--review", "test", ...args]));
});

test("immutable effective profiles charge equal total budgets including every native role", () => {
  assert.equal(validateBudget(budgets()).profile, "bounded");
  assert.throws(() => budgets("sustained"), /only the bounded profile/);
  for (const mutate of [(b) => b.attack = {}, (b) => b.resources.proxy.cpu = 0, (b) => b.boundedRequests = { ...b.boundedRequests, headerValueBytes: 9999 },
    (b) => b.timing.maxStartLagMs = Infinity, (b) => b.dependencyRecovery = { ...b.dependencyRecovery, delayMs: 9999 }]) {
    const b = budgets(); mutate(b); assert.throws(() => validateBudget(b));
  }
});

test("raw evidence cannot escape the result directory, mutate or disappear after sealing", () => {
  const folder = mkdtempSync(join(tmpdir(), "native-hardening-test-"));
  try {
    writeFileSync(join(folder, "raw.jsonl"), '{"observed":true}\n'); const manifest = artifacts(folder); verifyArtifacts(folder, manifest);
    assert.throws(() => verifyArtifacts(folder, [{ ...manifest[0], path: "../outside" }]), /escaped/);
    assert.throws(() => verifyArtifacts(folder, [{ ...manifest[0], path: resolve(folder, "raw.jsonl") }]));
    writeFileSync(join(folder, "raw.jsonl"), '{"observed":false}\n'); assert.throws(() => verifyArtifacts(folder, manifest), /modified/);
    rmSync(join(folder, "raw.jsonl")); assert.throws(() => verifyArtifacts(folder, manifest), /missing/);
  } finally { assert.ok(resolve(folder).startsWith(resolve(tmpdir()))); rmSync(folder, { recursive: true }); }
});

test("a shared oracle receipt or passing subset is never native parity", () => {
  assert.throws(() => verifyParity({ readyForLoad: true, status: "passed" }, "fixture"));
  assert.throws(() => verifyParity({ workload: "marketplace-v2", source: "fixture", jsonRecords: 500, pages: 264, profiles: [] }, "fixture"));
  assert.throws(() => verifyParity({ workload: "marketplace-v2", source: "fixture", jsonRecords: 500, pages: 264, profiles: Array(12).fill({ locale: "en-US", javaScriptEnabled: true, mobile: false, passed: true }) }, "fixture"));
});
