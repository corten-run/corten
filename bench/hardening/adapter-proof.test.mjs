import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSaved } from "../workloads/isolated/adapters/hardening.mjs";
import { budgets, matrix, nativeGroup, parseArgs, registryDigest, apps, phases, schema, boundedRequestsVersion, deploymentQualificationVersion } from "./plan.mjs";
import { committedInputs, sourceGit, digest, savedFiles, savedProofVersion, phaseInputs } from "./evidence.mjs";
import { records } from "../marketplace/fixtures.mjs";

test("fixed hardening adapter composes with actual native replay and never promotes incomplete proof", async () => {
  // No module mocks or validator injection. This partial diagnostic is not a
  // successful native attempt, even with current semantic/version declarations.
  const folder = mkdtempSync(join(tmpdir(), "hardening-native-adapter-")), repository = fileURLToPath(new URL("../../", import.meta.url));
  try {
    const commit = sourceGit(repository, ["rev-parse", "HEAD"]).toString().trim(), subjectSha256 = "b".repeat(64);
    const options = parseArgs(["w17", "--build", "--review", subjectSha256]), budget = budgets(), cells = matrix();
    const fixture = JSON.stringify(records()); mkdirSync(join(folder, "fixtures")); writeFileSync(join(folder, "fixtures/marketplace.json"), fixture);
    const summary = { schema, registryDigest, commit, options, budget, boundedRequestsVersion, lifecycleVersion: 4,
      savedProofVersion, nativeControlsVersion: 1, deploymentQualificationVersion, complete: false, groupReady: false, failures: [], cleanupFailures: [],
      cells, nativeGroup: nativeGroup(cells), fixtureSha256: digest(fixture), tools: Object.fromEntries(["node", "checker", "edge", "cert"].map((k) => [k, { Id: `sha256:${digest(k)}` }])) };
    writeFileSync(join(folder, "summary.json"), JSON.stringify(summary));
    writeFileSync(join(folder, "run-manifest.json"), JSON.stringify(savedFiles(folder)));
    const files = committedInputs(repository, commit), paths = new Set(files.map((f) => f.path));
    // This fixture intentionally lacks native source closure. It tests blocked
    // replay even before the v3 worker files are committed in the checkout.
    for (const path of new Set(phases.flatMap(phaseInputs))) if (!paths.has(path)) files.push({ path, sha256: digest(path) });
    const binding = { request: { group: "hardening", round: "w17", commit, recipe: "native-defaults" }, subjectSha256,
      selection: { group: "hardening", apps, contractSha256: registryDigest }, sources: { commit, files },
      execution: { invocation: { executable: "node", argv: ["bench/hardening/run.mjs", "w17", "--build", "--review", subjectSha256], cwd: "repository-root", shell: false },
        effectiveOptions: options, settings: budget }, resources: { budget: budget.resources } };
    const before = savedFiles(folder), result = await inspectSaved(binding, folder);
    assert.equal(result.status, "blocked"); assert.equal(result.resources, "blocked"); assert.equal(result.cleanupComplete, false); assert.equal(result.attemptComplete, false);
    assert.deepEqual(result.outcomes, apps.map((app) => ({ app, outcome: "not-run" }))); assert.deepEqual(savedFiles(folder), before);
    summary.cells.pop(); writeFileSync(join(folder, "summary.json"), JSON.stringify(summary));
    assert.equal((await inspectSaved(binding, folder)).status, "invalid");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
