import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bindExecution } from "./contract.mjs";
import { bindCampaign, campaignRounds, jsonPhase, mixedPhase, productionRecipes, validateCampaign } from "./campaign-contract.mjs";
import { groupNames, selectedApps } from "../registry.mjs";
import { parseArgs as mixedOptions } from "../../mixed-production/run.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8",
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }).trim();
test("official rounds are one fixed mapping with disjoint preparation and timing", () => {
  const rounds = campaignRounds("r17");
  assert.equal(rounds["catalog-page"], "c17"); assert.equal(rounds["json-api"], "j35");
  assert.equal(rounds["mixed-production"], "w17"); assert.equal(rounds["client-heavy"], "w17");
  assert.equal(rounds["live-delivery"], "r17"); assert.equal(rounds["recoverable-live"], "r17");
  for (const bad of ["r16", "r0", "r017", "r1000000001", ["r17"], "r17/escape", 17]) assert.throws(() => campaignRounds(bad));
});
test("full campaign binds real committed procedures, all groups, exact native defaults and honest unknown gates", () => {
  const plan = bindCampaign({ round: "r17", commit });
  assert.deepEqual(plan.order, groupNames); assert.equal(plan.bindings.length, 9); assert.equal(plan.procedures.length, 9);
  assert.equal(plan.ready, false); assert.equal(plan.executionAuthorized, false);
  for (const binding of plan.bindings) {
    assert.deepEqual(binding.selection.apps, selectedApps(binding.request.group)); assert.equal(binding.status.ready, false);
    assert.ok(binding.coverage.cells.every((r) => r.parity === "not-run" && r.measurement === "not-run"));
  }
  assert.ok(plan.procedures.every((p) => plan.bindings[0].sources.files.some((s) => s.path === p.path && s.sha256 === p.sha256)));
  assert.equal(productionRecipes["localized-marketplace"], "marketplace-short-window");
  const mixed = plan.bindings.find((b) => b.request.group === "mixed-production");
  assert.equal(mixed.execution.nativeDefaults.profile, "defaults"); assert.equal(mixed.execution.effectiveOptions.profile, "matched");
  assert.equal(mixed.execution.effectiveOptions.measure, true);
  const expected = mixedOptions(mixed.execution.invocation.argv.slice(1)); expected.apps = selectedApps("mixed-production");
  assert.deepEqual(mixed.execution.effectiveOptions, expected);
  const mixedTiming = mixedPhase(plan, "r17-0123456789abcdef");
  assert.deepEqual(mixedTiming.execution.invocation.argv, [...mixed.execution.invocation.argv,
    "--native-audits", "/bench/campaign/r17-0123456789abcdef/mixed-native-audits.json"]);
  assert.equal(mixed.execution.effectiveOptions.nativeAudits, null, "declarative defaults stay unchanged");
  const auditedOptions = mixedOptions(mixedTiming.execution.invocation.argv.slice(1)); auditedOptions.apps = selectedApps("mixed-production");
  assert.deepEqual(mixedTiming.execution.effectiveOptions, auditedOptions);
  assert.deepEqual(mixedTiming.selection, mixed.selection);
  for (const id of ["r18-0123456789abcdef", "r17-0123456789abcde", "r17-0123456789abcdef/foreign", ["r17-0123456789abcdef"]])
    assert.throws(() => mixedPhase(plan, id));
  const old = bindExecution({ group: "mixed-production", round: "w17", commit, recipe: "mixed-measure", review: null });
  assert.equal(old.execution.effectiveOptions.profile, "defaults"); assert.ok(!old.execution.invocation.argv.includes("--profile"));
  for (const key of ["passes", "duration", "warmup", "calibration", "seed", "clients", "repetitions"]) {
    assert.equal(mixed.execution.effectiveOptions[key], old.execution.effectiveOptions[key]);
  }
  const prep = jsonPhase(plan, "prepare"), timing = jsonPhase(plan, "timing", "/bench/campaign/owned/json-native-audits.json");
  assert.equal(prep.request.round, "j34"); assert.equal(prep.execution.effectiveOptions.build, true); assert.equal(prep.execution.effectiveOptions.checkOnly, true);
  assert.equal(timing.request.round, "j35"); assert.equal(timing.execution.effectiveOptions.build, false); assert.equal(timing.execution.effectiveOptions.checkOnly, false);
  assert.equal(timing.execution.effectiveOptions.receipts, "/bench/campaign/owned/json-native-audits.json");
  for (const key of ["passes", "duration", "warmup", "rate", "startupTimeout"]) assert.equal(prep.execution.effectiveOptions[key], timing.execution.effectiveOptions[key]);
  const bad = structuredClone(plan); bad.bindings[0].execution.invocation.argv.push("--apps", "corten");
  assert.throws(() => validateCampaign(bad), /differs from fixed native/);
  assert.throws(() => bindCampaign({ round: "r17", commit, groups: ["catalog-page"] }));
});
