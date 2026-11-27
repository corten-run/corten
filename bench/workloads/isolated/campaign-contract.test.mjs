import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bindExecution, clientComparisonRecipe } from "./contract.mjs";
import { catalogFleetPlacement, jsonFleetPlacement, providerCreateHost } from "../cloud-contract.mjs";
import { c16Env, placementCpus } from "../../json-api/placement.mjs";
import { bindCampaign, campaignRounds, jsonPhase, mixedPhase, productionRecipes, validateCampaign } from "./campaign-contract.mjs";
import { groupNames, selectedApps } from "../registry.mjs";
import { parseArgs as mixedOptions } from "../../mixed-production/run.mjs";
import * as campaigns from "./campaign-contract.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { isDeepStrictEqual } from "node:util";
import { parseCampaignArgs } from "./campaign-entry.mjs";
import { apparatusProof, nativeControlPartition } from "./control-stream.mjs";
import { hardeningCpuGate } from "./native-roles.mjs";
import { binding as controlBinding, registration } from "../test-fixtures/control-stream-fixture.mjs";
import { inspectCampaign } from "../cloud-validation.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8",
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }).trim();
test("the official r24 browser plan opens the CPU0 control proof with actual browser roles", (t) => {
  const { round, group } = parseCampaignArgs(["r24", "--commit", commit, "--state-dir", "/bench/campaign", "--group", "fullstack-browser"]);
  const plan = campaigns.bindGroupCampaign({ round, group, commit });
  validateCampaign(plan);
  const [b] = plan.bindings, sample = { ...registration, monoNs: "2000000" }, { cpus, roles } = nativeControlPartition(b);
  assert.deepEqual(b.execution.invocation.argv, ["bench/fullstack-browser/run.mjs", "w24", "--build", "--out", "bench/fullstack-browser/work/w24", "--isolated"]);
  assert.deepEqual(cpus, { application: "1", upstream: "2-3", browser: "4-7" });
  assert.equal(apparatusProof(controlBinding, registration, sample, cpus, roles).cpu, 0);
  assert.equal(b.status.ready, false);
  t.diagnostic(`official ${round}/${group}: ${JSON.stringify(cpus)}; CPU0 apparatus separate; readiness remains false`);
  for (const [browserCpus, message] of [
    [undefined, /native CPU partition absent/],
    [{ ...cpus, browser: "0,4-7" }, /CPU0 overlaps/],
    [{ ...cpus, upstream: "1-3" }, /roles overlap/],
    [{ app: "1", api: "2-3", load: "4-7" }, /native CPU partition absent/],
  ]) assert.throws(() => nativeControlPartition({ ...b, resources: { ...b.resources, browserCpus } }), message);
});
test("the official r24 mixed timing phase supplies the same measured CPU roles at open and replay", (t) => {
  const plan = campaigns.bindGroupCampaign({ round: "r24", group: "mixed-production", commit });
  const b = mixedPhase(plan, "r24-0123456789abcdef"), replay = mixedPhase(structuredClone(plan), "r24-0123456789abcdef");
  const { cpus, roles } = nativeControlPartition(b), sample = { ...registration, monoNs: "2000000" };
  assert.deepEqual(nativeControlPartition(replay), { cpus, roles });
  assert.deepEqual(cpus, { app: "1", load: "4-7", api: "2-3" });
  assert.equal(apparatusProof(controlBinding, registration, sample, cpus, roles).cpu, 0);
  const missing = structuredClone(replay); delete missing.resources.measurement.cpu.load;
  assert.throws(() => nativeControlPartition(missing), /native CPU partition absent/);
  t.diagnostic("official r24/mixed-production: measured app=1 api=2-3 load=4-7; no functional-capture CPU proof");
});
test("dedicated Mixed binds its Django ASGI deployment and rejects a rehashed WSGI downgrade", () => {
  const group = "mixed-production", round = "r25", plan = campaigns.bindGroupCampaign({ group, round, commit });
  const [binding] = plan.bindings;
  assert.equal(productionRecipes[group], "mixed-production-measure");
  assert.equal(binding.request.recipe, "mixed-production-django-asgi");
  assert.equal(plan.recipes[group], binding.request.recipe);
  assert.deepEqual(binding.execution.invocation.argv, ["bench/mixed-production/run.mjs", "w25", "--build", "--measure", "--profile", "matched",
    "--django-deployment", "django-granian-asgi"]);
  const previous = bindExecution({ ...binding.request, recipe: productionRecipes[group], review: null }, binding.campaignMode);
  assert.deepEqual(previous.resources, binding.resources);
  const { djangoDeployment, ...remainingOptions } = binding.execution.effectiveOptions;
  assert.equal(djangoDeployment, "django-granian-asgi");
  assert.deepEqual(remainingOptions, previous.execution.effectiveOptions);
  const phase = mixedPhase(plan, "r25-0123456789abcdef");
  assert.equal(phase.execution.effectiveOptions.djangoDeployment, djangoDeployment);
  assert.deepEqual(phase.execution.invocation.argv.slice(-2), ["--native-audits", "/bench/campaign/r25-0123456789abcdef/mixed-native-audits.json"]);
  validateCampaign(plan);
  const { campaignSha256, ...body } = plan;
  const downgraded = { ...body, bindings: [previous], recipes: { ...plan.recipes, [group]: productionRecipes[group] } };
  assert.notEqual(deploymentSha256(downgraded), campaignSha256);
  assert.throws(() => validateCampaign({ ...downgraded, campaignSha256: deploymentSha256(downgraded) }), /fixed native bindings/);
});
test("captured pre-create worker uses the real committed placements including bounded hardening", async () => {
  const check = (group, mode) => inspectCampaign({ action: "actor-role-preflight", round: "r25", commit, group, mode });
  for (const [group, mode, blockers] of [
    ["catalog-page", catalogFleetPlacement.loadLayout, []],
    ["json-api", jsonFleetPlacement.loadLayout, []],
    ["json-api", "json-c32-generator-v1", []],
    ["live-delivery", "dedicated-lon1", []],
    ["hardening", "dedicated", []],
  ]) assert.deepEqual(await check(group, mode), blockers);
});
test("the opted-in JSON API c-16 layout widens only k6 and binds only the json-api group", () => {
  const request = { round: "r25", commit, group: "json-api" };
  const [d] = campaigns.bindGroupCampaign(request).bindings;
  const plan = campaigns.bindGroupCampaign(request, jsonFleetPlacement.loadLayout);
  validateCampaign(plan);
  const [b] = plan.bindings;
  assert.equal(b.campaignMode, "json-c16-generator-v1");
  assert.deepEqual(b.host, { ...d.host, size: "c-16", region: "sfo2" });
  assert.deepEqual(b.host, { ...providerCreateHost("json-c16-generator-v1"), allocation: "not-created", isolation: "unverified" });
  for (const key of ["execution", "selection", "validation", "preparation"]) assert.deepEqual(b[key], d[key]);
  // The binding's requested CPU environment is exactly the runner-side opt-in, and its expected CPUs are the placement's.
  assert.deepEqual(b.resources.requestedCpuEnv, c16Env);
  assert.deepEqual(b.resources.expectedCpus, placementCpus(c16Env));
  assert.deepEqual(b.resources, { ...d.resources, requestedCpuEnv: c16Env, expectedCpus: { ...d.resources.expectedCpus,
    load: { ...d.resources.expectedCpus.load, quota: 12, cpuset: "4-15", args: ["--cpus", "12", "--cpuset-cpus", "4-15"] } } });
  assert.deepEqual(d.resources.requestedCpuEnv, { JSON_API_APP_CPUS: "1", JSON_API_API_CPUS: "2-3", JSON_API_LOAD_CPUS: "4-7" });
  assert.deepEqual(nativeControlPartition(b).cpus, { app: "1", load: "4-15", api: "2-3" });
  assert.notEqual(b.subjectSha256, d.subjectSha256);
  for (const change of [(p) => { p.bindings[0].resources = d.resources; }, (p) => { p.bindings[0].host = d.host; },
    (p) => { delete p.bindings[0].resources.requestedCpuEnv.JSON_API_LOAD_LAYOUT; }]) {
    const changed = structuredClone(plan); change(changed);
    assert.throws(() => validateCampaign(changed), /differs from fixed native bindings/);
  }
  for (const group of groupNames.filter((name) => name !== "json-api"))
    assert.throws(() => campaigns.bindGroupCampaign({ ...request, group }, "json-c16-generator-v1"), /unknown group placement/);
  assert.throws(() => campaigns.bindGroupCampaign(request, catalogFleetPlacement.loadLayout), /unknown group placement/);
});
test("only the declared JSON API c-32 arm can bind or replay a c-32 native partition", () => {
  const request = { round: "r25", commit, group: "json-api" }, mode = "json-c32-generator-v1";
  const plan = campaigns.bindGroupCampaign(request, mode), [b] = plan.bindings;
  const [d] = campaigns.bindGroupCampaign(request).bindings;
  validateCampaign(plan);
  assert.deepEqual(b.host, { ...d.host, size: "c-32", region: "sfo2" });
  for (const key of ["execution", "selection", "validation", "preparation"]) assert.deepEqual(b[key], d[key]);
  assert.deepEqual(b.resources.requestedCpuEnv, { ...c16Env, JSON_API_LOAD_LAYOUT: mode, JSON_API_LOAD_CPUS: "4-23" });
  assert.deepEqual(b.resources.expectedCpus, { ...d.resources.expectedCpus,
    load: { ...d.resources.expectedCpus.load, quota: 20, cpuset: "4-23", args: ["--cpus", "20", "--cpuset-cpus", "4-23"] } });
  assert.deepEqual(nativeControlPartition(b).cpus, { app: "1", load: "4-23", api: "2-3" });
  for (const group of groupNames.filter((name) => name !== "json-api"))
    assert.throws(() => campaigns.bindGroupCampaign({ ...request, group }, mode), /unknown group placement/);
  for (const change of [(x) => { delete x.campaignMode; }, (x) => { delete x.host.size; },
    (x) => { x.host.size = "c-16"; }, (x) => { delete x.resources.requestedCpuEnv.JSON_API_LOAD_LAYOUT; },
    (x) => { x.resources.expectedCpus.load.cpuset = "4-31"; }]) {
    const changed = structuredClone(plan); change(changed.bindings[0]);
    assert.throws(() => nativeControlPartition(changed.bindings[0]), /c-32/);
    assert.throws(() => validateCampaign(changed), /differs from fixed native bindings/);
  }
});
test("alternate dedicated placement is replayable and changes neither resources nor native execution", () => {
  const request = { round: "r25", commit, group: "json-api" };
  const [b] = campaigns.bindGroupCampaign(request).bindings;
  assert.equal(b.host.region, "sfo3");
  const subjects = new Set([b.subjectSha256]);
  for (const region of ["sfo2", "lon1", "blr1"]) {
    const mode = `dedicated-${region}`, alternate = campaigns.bindGroupCampaign(request, mode);
    validateCampaign(alternate);
    const [a] = alternate.bindings;
    assert.equal(a.campaignMode, mode);
    assert.deepEqual(a.host, { ...b.host, region });
    for (const key of ["resources", "execution", "selection", "validation"]) assert.deepEqual(a[key], b[key]);
    assert.ok(!subjects.has(a.subjectSha256)); subjects.add(a.subjectSha256);
    assert.throws(() => validateCampaign({ ...alternate, bindings: [{ ...a, host: b.host }] }), /fixed native bindings/);
    assert.throws(() => campaigns.bindGroupCampaign({ ...request, group: "catalog-page" }, mode), /unknown group placement/);
  }
  for (const mode of ["lon1", "dedicated-nyc1", "dedicated-sfo3"])
    assert.throws(() => campaigns.bindGroupCampaign(request, mode), /unknown group placement/);
});
test("official rounds are one fixed mapping with disjoint preparation and timing", () => {
  const rounds = campaignRounds("r17");
  assert.equal(rounds["catalog-page"], "c17"); assert.equal(rounds["json-api"], "j35");
  assert.equal(rounds["mixed-production"], "w17"); assert.equal(rounds["client-heavy"], "w17");
  assert.equal(rounds["live-delivery"], "r17"); assert.equal(rounds["recoverable-live"], "r17");
  for (const bad of ["r16", "r0", "r017", "r1000000001", ["r17"], "r17/escape", 17]) assert.throws(() => campaignRounds(bad));
});

test("dedicated client-heavy campaign binds the fixed comparison profile and rejects a downgrade", () => {
  const plan = campaigns.bindGroupCampaign({ round: "r17", commit, group: "client-heavy" });
  const [binding] = plan.bindings;
  assert.equal(productionRecipes["client-heavy"], "native-defaults");
  assert.equal(binding.request.recipe, clientComparisonRecipe);
  assert.deepEqual(binding.execution.invocation.argv.slice(-2), ["--profile", clientComparisonRecipe]);
  assert.equal(binding.execution.effectiveOptions.measurementOrder.length, 3);
  assert.deepEqual(campaigns.campaignRoleBlockers(plan), []);
  const downgraded = structuredClone(plan);
  downgraded.recipes["client-heavy"] = downgraded.bindings[0].request.recipe = "native-defaults";
  const { campaignSha256, ...body } = downgraded;
  assert.notEqual(campaignSha256, deploymentSha256(body));
  assert.throws(() => validateCampaign({ ...body, campaignSha256: deploymentSha256(body) }), /fixed native bindings/);
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
  assert.deepEqual(nativeControlPartition(mixed).cpus, { app: "1", api: "2-3", load: "4-7" });
  assert.equal(mixed.resources.functional.pinning, "not available in functional capture");
  assert.deepEqual(campaigns.campaignRoleBlockers(plan), []);
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
  assert.throws(() => validateCampaign(bad), (error) => {
    assert.match(error.message, /differs from fixed native/);
    assert.ok(error.message.length < 256, "rejection must not format the complete campaign");
    assert.equal(error.actual, false); assert.equal(error.expected, true);
    return true;
  });
  assert.throws(() => bindCampaign({ round: "r17", commit, groups: ["catalog-page"] }));
});
test("group campaigns bind the entire exact native group with stable all-group provenance", () => {
  const all = bindCampaign({ round: "r17", commit });
  const dedicatedRecipes = {
    ...productionRecipes,
    "client-heavy": clientComparisonRecipe,
    "mixed-production": "mixed-production-django-asgi",
  };
  const expected = {
    "catalog-page": { app: "1", api: "2-3", load: "4-7" },
    "json-api": { app: "1", api: "2-3", load: "4-7" },
    "localized-marketplace": { app: "1", api: "2-3", load: "4-7" },
    "mixed-production": { app: "1", api: "2-3", load: "4-7" },
    "fullstack-browser": { application: "1", upstream: "2-3", browser: "4-7" },
    "client-heavy": { client: "4-7" },
    "live-delivery": { application: "1", browser: "4-7" },
    "recoverable-live": { application: "1", browser: "4-7" },
    hardening: { application: "1", upstream: "2", proxy: "3", apparatus: "4-5", command: "6-7" },
  };
  for (const b of all.bindings) assert.equal(b.host.region, providerCreateHost("legacy").region);
  for (const path of ["campaign-contract.mjs", "campaign-entry.mjs", "campaign.mjs", "campaign-verify.mjs"])
    assert.ok(all.bindings[0].sources.files.some((f) => f.path === `bench/workloads/isolated/${path}`), "campaign modules must be source-bound");
  assert.equal(typeof campaigns.bindGroupCampaign, "function");
  for (const group of groupNames) {
    const plan = campaigns.bindGroupCampaign({ round: "r17", commit, group });
    assert.equal(plan.schema, "benchmark-isolated-group-campaign/v1");
    assert.deepEqual(plan.order, [group]);
    const legacy = all.bindings.find((b) => b.request.group === group);
    assert.equal(legacy.request.recipe, productionRecipes[group]);
    const recipe = dedicatedRecipes[group];
    const dedicated = bindExecution({ ...legacy.request, recipe, review: null }, "dedicated");
    assert.ok(isDeepStrictEqual(plan.bindings, [dedicated]), `${group}: dedicated group binding differs`);
    assert.equal(dedicated.host.region, providerCreateHost("dedicated").region);
    assert.notEqual(dedicated.subjectSha256, legacy.subjectSha256);
    for (const field of ["procedures", "ready", "executionAuthorized"])
      assert.deepEqual(plan[field], all[field]);
    assert.equal(dedicated.sources.sha256, legacy.sources.sha256);
    assert.equal(plan.sourceSha256, group === "hardening" ? dedicated.sources.sha256 : all.sourceSha256);
    assert.deepEqual(plan.recipes, { ...all.recipes, [group]: recipe });
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.bindings[0].selection.apps));
    if (group === "hardening") {
      assert.ok(dedicated.sources.files.some((f) => f.path === hardeningCpuGate));
      assert.throws(() => nativeControlPartition({ ...dedicated, execution: { ...dedicated.execution,
        effectiveOptions: { ...dedicated.execution.effectiveOptions, isolated: false } } }), /isolation must be enabled/);
      assert.throws(() => nativeControlPartition({ ...dedicated, sources: { ...dedicated.sources,
        files: dedicated.sources.files.filter((f) => f.path !== hardeningCpuGate) } }), /CPU gate absent/);
    }
    {
      assert.deepEqual(campaigns.campaignRoleBlockers(plan), []);
      const { cpus, roles } = nativeControlPartition(dedicated);
      assert.deepEqual(cpus, expected[group]);
      const replay = JSON.parse(JSON.stringify(plan));
      assert.deepEqual(nativeControlPartition(replay.bindings[0]), { cpus, roles });
      assert.equal(apparatusProof(controlBinding, registration, { ...registration, monoNs: "2000000" }, cpus, roles).cpu, 0);
      const resources = replay.bindings[0].resources;
      const declared = resources.actorCpus ?? resources.browserCpus ?? resources.measurement?.cpu ?? resources.expectedCpus;
      const role = roles.at(-1), value = declared[role];
      delete declared[role];
      assert.throws(() => nativeControlPartition(replay.bindings[0]), /partition absent/);
      declared[role] = typeof value === "string" ? "0" : { ...value, cpuset: "0" };
      assert.throws(() => nativeControlPartition(replay.bindings[0]), /CPU0 overlaps/);
      assert.equal(campaigns.campaignRoleBlockers(replay).length, 1);
    }
    const { campaignSha256, ...body } = plan; assert.equal(campaignSha256, deploymentSha256(body));
    validateCampaign(plan);
    if (group === "catalog-page") {
      const wide = campaigns.bindGroupCampaign({ round: "r17", commit, group }, "c16-generator-v1");
      validateCampaign(wide);
      const binding = wide.bindings[0];
      assert.deepEqual(binding.host, { ...dedicated.host, size: "c-16", region: "sfo2" });
      assert.deepEqual(binding.execution, dedicated.execution);
      assert.deepEqual(binding.selection, dedicated.selection);
      assert.deepEqual(binding.validation, dedicated.validation);
      assert.deepEqual(binding.resources, { ...dedicated.resources,
        requestedCpuEnv: { ...dedicated.resources.requestedCpuEnv, CATALOG_LOAD_CPUS: "4-15", CATALOG_LOAD_LAYOUT: "c16-generator-v1" },
        expectedCpus: { ...dedicated.resources.expectedCpus, load: { ...dedicated.resources.expectedCpus.load,
          quota: 12, cpuset: "4-15", args: ["--cpus", "12", "--cpuset-cpus", "4-15"] } },
      });
      const downgraded = structuredClone(wide);
      downgraded.bindings[0].resources = dedicated.resources;
      assert.throws(() => validateCampaign(downgraded), /differs from fixed native bindings/);
    } else {
      assert.throws(() => campaigns.bindGroupCampaign({ round: "r17", commit, group }, "c16-generator-v1"), /unknown group placement/);
    }
  }
  validateCampaign(all); assert.equal(all.schema, "benchmark-isolated-campaign/v1");
  for (const group of ["unknown", "", ["catalog-page"], undefined]) assert.throws(() => campaigns.bindGroupCampaign({ round: "r17", commit, group }));
  for (const extra of [{ apps: ["corten"] }, { selection: {} }, { recipe: "native-defaults" }, { options: {} }, { groups: groupNames }])
    assert.throws(() => campaigns.bindGroupCampaign({ round: "r17", commit, group: "catalog-page", ...extra }));
  const original = campaigns.bindGroupCampaign({ round: "r17", commit, group: "catalog-page" });
  for (const change of [
    (p) => { p.bindings[0].selection.apps.pop(); },
    (p) => { p.bindings[0].execution.invocation.argv.push("--apps", "corten"); },
    (p) => { p.bindings[0].execution.effectiveOptions.duration = 1; },
    (p) => { p.recipes["catalog-page"] = "marketplace-short-window"; },
    (p) => { p.schema = "benchmark-isolated-campaign/v1"; },
    (p) => { p.order = []; }, (p) => { p.order = ["json-api"]; },
    (p) => { p.bindings.push(all.bindings[1]); },
    (p) => { p.schema = "unknown"; },
  ]) {
    const edited = structuredClone(original); change(edited);
    const { campaignSha256, ...body } = edited; edited.campaignSha256 = deploymentSha256(body);
    assert.throws(() => validateCampaign(edited), (error) => {
      assert.match(error.message, /campaign differs from fixed native bindings|unknown registry group/);
      assert.ok(error.message.length < 256, "refusal must not render the complete campaign source manifests");
      return true;
    });
  }
});
