import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { contractSha256, definition, groupNames, retainedFamilies, selectedApps } from "./registry.mjs";
import { groupApps, scheduledGroup } from "../marketplace/groups.mjs";
import { cpuSettings as catalogCpus, parseArgs as catalogOptions } from "../catalog/contract.mjs";
import { cpuSettings as jsonCpus, parseArgs as jsonOptions } from "../json-api/contract.mjs";
import { cpuSettings as marketplaceCpus, parseArgs as marketplaceOptions } from "../marketplace/run-contract.mjs";
import { deploymentCli, deploymentDescriptor, deploymentPlan, deploymentSha256, fixedSelection, outcomeKinds, receiptSchema, reservationSchema, screenDeployment, validateDeploymentBudget, verifyPhaseSelection } from "./deployments.mjs";

const commit = "38301e17051b1b43901b63f66b150886d2097c29";
// Synthetic fixtures test validation, not a qualification receipt or measured result.
function nativeBudget(group = "catalog-page", env = {}) {
  const native = { "catalog-page": [catalogOptions, catalogCpus, "c3", "catalog"], "json-api": [jsonOptions, jsonCpus, "j3", "json-api"],
    "localized-marketplace": [marketplaceOptions, marketplaceCpus, "w3", "marketplace"] }[group];
  assert.ok(native, "test needs an integrated native reservation");
  const [parse, cpuSettings, round, area] = native;
  const options = parse([round, "--group", group, "--passes", "3", "--duration", "60", "--warmup", "30", "--rate", "150", "--startup-timeout", "120"], Object.fromEntries(selectedApps(group).map((app) => [app, {}])));
  const cpus = cpuSettings(env), container = (cpu, memoryBytes, sharedMemoryBytes = null) => ({ cpu, memoryBytes, sharedMemoryBytes, processes: "all-container-descendants" });
  return { schema: reservationSchema, group, runner: `bench/${area}/run.mjs`, options, cpus,
    resources: { app: container(cpus.app, 2 ** 30), upstream: container(cpus.api, 512 * 2 ** 20), load: container(cpus.load, 2 ** 31),
      cold: container(cpus.load, 256 * 2 ** 20), sampler: container({ ...cpus.load, quota: 1, args: ["--cpus", "1", ...(cpus.load.cpuset ? ["--cpuset-cpus", cpus.load.cpuset] : [])] }, 128 * 2 ** 20),
      ...(group === "json-api" ? {} : { checker: container(cpus.load, 2 ** 31, 2 ** 30) }),
      ...(group === "localized-marketplace" ? { transportChecker: container(cpus.load, 512 * 2 ** 20) } : {}) },
    host: { isolation: "none", cpu: null, memoryBytes: null, processes: group === "json-api" ? ["driver", "functional-checker"] : ["driver"] }, edge: null };
}
const budget = nativeBudget();
// Rehashed saved input deliberately bypasses the constructor, like an untrusted file.
function uncheckedBinding(original, fields) {
  const { descriptorSha256, bindingSha256, evidence, ...subject } = original;
  const next = { ...subject, ...fields };
  const body = { ...next, bindingSha256: deploymentSha256(next), evidence };
  return { ...body, descriptorSha256: deploymentSha256(body) };
}
const emptyEvidence = () => Object.fromEntries(["implementation", "native-parity", "performance", "independent-review"].map((kind) => [kind, null]));
function binding(configuration, evidence = emptyEvidence(), group = "catalog-page") {
  return { commit, images: Object.fromEntries(Object.keys(configuration.builds).map((key) => [key, `sha256:${"a".repeat(64)}`])), configuration, budget: nativeBudget(group), evidence };
}
const manifest = (group, app) => deploymentPlan(group).apps.find((row) => row.app === app).deployments[0];
function descriptor(group = "catalog-page", app = "express") {
  const entry = manifest(group, app);
  return deploymentDescriptor(group, app, entry.id, binding(entry.configuration, emptyEvidence(), group));
}
function fixture(original = descriptor(), { status = "complete", mutate = () => {}, baseline } = {}) {
  const files = new Map();
  const save = (path, value) => {
    const bytes = Buffer.from(JSON.stringify(value)); files.set(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const raw = save(`${original.deployment}/raw.json`, { synthetic: true });
  const common = { schema: receiptSchema, bindingSha256: original.bindingSha256, author: "producer", reason: "Synthetic validation fixture only", status };
  const receipts = {
    implementation: { ...common, kind: "implementation", artifacts: [raw] },
    "native-parity": { ...common, kind: "native-parity", cases: original.cases, artifacts: [raw] },
    performance: { ...common, kind: "performance", cases: original.cases, artifacts: [raw],
      runs: ["first", "second"].map((repeat) => ({ repeat, cases: original.cases.map((row) => ({ key: row.key, artifact: raw,
        metrics: { cpuUsec: 10, memoryBytes: 100, startupMs: 5, p95Ms: 2 } })) })),
      ...(baseline ? { baseline, baselineBindingSha256: baseline.bindingSha256 } : {}) },
  };
  const review = { ...common, kind: "independent-review", author: "independent reviewer", scope: "entire-group",
    ...(baseline ? { baselineBindingSha256: baseline.bindingSha256, tradeoff: "Synthetic repeated all-matrix CPU/memory/startup/latency comparison reviewed, not a measured claim" } : {}) };
  mutate(receipts, review);
  const evidence = Object.fromEntries(Object.entries(receipts).map(([kind, r]) => [kind, save(`${original.deployment}/${kind}.json`, r)]));
  evidence["independent-review"] = save(`${original.deployment}/review.json`, { ...review, reviewed: { ...evidence } });
  const d = deploymentDescriptor(original.group, original.app, original.deployment, { commit: original.commit, configuration: original.configuration,
    budget: original.budget, images: original.images, evidence });
  return { descriptor: d, files, validators: { readArtifact: (path) => { assert.ok(files.has(path), `missing ${path}`); return files.get(path); },
    verifyNative: () => true, verifyPerformance: () => true } };
}

test("all nine exact groups, cases, contenders and retained families survive without legacy hash changes", () => {
  const hashes = {
    "catalog-page": "c267655acacf8083ce51cbd92d80cbfafbe5fe8f5f56141d4ef1d12a48ac89ee",
    "json-api": "b0015ffc90e28f85823f1e7a392e8ed5a97f2f2a6e56cf6c9287934589325fb9",
    "localized-marketplace": "ab61f28221d8abe1225f13816c438b90f79bd0d50a379eae7b1b5fb9275366b7",
    "mixed-production": "65b1b953d9524aa7e72aaa4e04b8e5d2ce350930f46de874395a24ccbeea2676",
    "fullstack-browser": "d4c219c71546b7c8cfdeb8b0e9b4c44cacc30cd42837dcfa5580db9d125f62d4",
    "client-heavy": "29842bba6ec897e5a86a42cc7f8f777ac69f64b89f41d7c6f6774f9c067486d1",
    "live-delivery": "ca5d6010d1a3ea088849d5ac40ec9aa8d41791c4e316f47a86233ce829b33328",
    "recoverable-live": "b6d91c14ed20babdc0e56719826a6d01bb993de6b16224f5f9b0e2544f3e9eff",
    hardening: "8108f22eaa5d2445d9bd0700faebbc5638f8ddc23c54ea9929ba3532f5e00f0a",
  };
  assert.equal(groupNames.length, 9);
  for (const group of groupNames) {
    const p = deploymentPlan(group);
    assert.equal(p.contractSha256, hashes[group]); assert.equal(contractSha256(group), hashes[group]);
    assert.deepEqual(p.selected, selectedApps(group)); assert.deepEqual(p.cases, definition(group).cases);
    assert.deepEqual(p.capabilities, definition(group).capabilities); assert.deepEqual(p.retainedFamilies, retainedFamilies);
    assert.deepEqual(p.apps.map((row) => row.app), p.selected);
    for (const row of p.apps) {
      assert.equal(row.deployments[0].id, row.representative);
      assert.equal(new Set(row.deployments.map((d) => d.id)).size, row.deployments.length);
      assert.ok(row.deployments.every((d) => d.qualification === "pending" && d.evidence.length === 0));
      const representative = row.deployments[0];
      if (representative.configuration) {
        const present = representative.configuration.sourceRefs.every((ref) => existsSync(new URL(`../../${ref}`, import.meta.url)));
        assert.equal(representative.implementation, present ? "source-present" : "pending-integration");
      } else assert.equal(representative.implementation, "pending-implementation");
    }
    assert.throws(() => p.apps.pop());
  }
  assert.equal(scheduledGroup("r21"), "production");
  assert.deepEqual(groupApps("production"), ["corten", "nextjs", "aspnet", "fastapi", "express", "topcoat", "leptos"]);
});

test("actual launch topologies stay distinct, without a framework replacement or invented compiler pass", () => {
  assert.ok(!deploymentPlan("catalog-page").apps.some((row) => row.app === "django"));
  const n = manifest("catalog-page", "express").configuration;
  const dockerfile = readFileSync(new URL("../fullstack/apps/express/Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes(JSON.stringify(n.command).replaceAll(",", ", ")));
  assert.equal(n.framework, "Express + EJS"); assert.equal(n.runtime, "Node 24");
});

test("native profile facts and pending alternatives are concrete and group-scoped", () => {
  assert.match(manifest("localized-marketplace", "django").configuration.server, /Granian WSGI/);
  assert.deepEqual(manifest("localized-marketplace", "django").configuration.builds.app.args, { PROFILE: "matched" });
  assert.equal(manifest("json-api", "fastapi").configuration.environment.PROFILE, "");
  assert.equal(manifest("mixed-production", "fastapi").configuration.environment.PROFILE, "matched");
  assert.match(manifest("fullstack-browser", "laravel").configuration.workers, /two explicitly/);
  const json = deploymentPlan("json-api");
  assert.ok(json.apps.some((r) => r.app === "aspnet")); assert.ok(json.apps.some((r) => r.app === "aspnet-aot"));
  assert.match(manifest("json-api", "aspnet-aot").configuration.framework, /JSON only/);
  assert.ok(!deploymentPlan("catalog-page").selected.includes("aspnet-aot"));
  const express = json.apps.find((r) => r.app === "express").deployments;
  assert.deepEqual(express.slice(1).map((d) => d.id), ["express-bun", "express-bun-packaged", "express-bun-bytecode", "express-bun-machine-aot"]);
  assert.ok(express.slice(1).every((d) => /Express/.test(d.change.framework) && d.qualification === "pending"));
  assert.match(express[2].change.buildMode, /not machine AOT/);
  assert.match(express[3].change.buildMode, /not machine AOT/);
  assert.match(express[4].change.buildMode, /experimental/);
  assert.ok(json.apps.find((r) => r.app === "fastapi").deployments.some((d) => d.id === "fastapi-nuitka"));
  assert.ok(deploymentPlan("fullstack-browser").apps.find((r) => r.app === "laravel").deployments.some((d) => d.id === "laravel-frankenphp-jit"));
});

test("live representatives use dispatched native ports and missing recovery ports stay pending", () => {
  for (const group of ["live-delivery", "recoverable-live"]) {
    const aspnet = manifest(group, "aspnet");
    assert.deepEqual(aspnet.configuration.command, ["dotnet", "LiveParity.dll"]);
    assert.equal(aspnet.configuration.builds.app.context, "bench/live/apps/aspnet");
    assert.equal(aspnet.configuration.builds.app.dockerfile, "bench/live/apps/aspnet/Dockerfile");
    assert.ok(aspnet.configuration.sourceRefs.includes("bench/live/apps/aspnet/LiveParity.csproj"));
    assert.match(aspnet.configuration.middleware, /ServerSentEvents/);
    assert.throws(() => deploymentDescriptor(group, "aspnet", aspnet.id, binding(aspnet.configuration)), /implementation.*source-present|reservation adapter not integrated/);
    for (const row of deploymentPlan(group).apps) {
      const entry = row.deployments[0];
      assert.ok(!JSON.stringify(entry).includes("bench/fullstack/apps/"), `${group}/${row.app} borrows an unrelated app`);
      if (entry.configuration) assert.ok(entry.configuration.sourceRefs.some((path) => path.startsWith(`bench/live/apps/${row.app}/`)));
      else {
        assert.equal(entry.implementation, "pending-implementation");
        assert.equal(entry.expectedSourceRoot, `bench/live/apps/${row.app}`);
        assert.throws(() => deploymentDescriptor(group, row.app, entry.id, binding(manifest("catalog-page", "express").configuration)), /implementation.*source-present/);
      }
    }
  }
  const express = manifest("live-delivery", "express").configuration;
  assert.deepEqual(express.command, ["node", "server.mjs"]);
  assert.equal(express.builds.app.context, "bench/live/apps/express");
  assert.match(express.framework, /Express.*SSE/);
  assert.ok(!deploymentPlan("live-delivery").apps.find((row) => row.app === "express").deployments[1].configurationTemplate, "fullstack Bun template cannot describe the native live application");
  const gin = manifest("live-delivery", "gin").configuration;
  assert.deepEqual(gin.command, ["./server"]);
  assert.equal(gin.builds.app.context, "bench/live/apps/gin");
  assert.match(gin.runtime, /Go 1\.27\.3/);
  assert.equal(manifest("recoverable-live", "laravel").implementation, "pending-implementation");
  assert.throws(() => deploymentDescriptor("recoverable-live", "laravel", "laravel-frankenphp-jit", binding(manifest("fullstack-browser", "laravel").configuration)), /implementation.*source-present/);
  assert.equal(manifest("recoverable-live", "topcoat").configuration, null);
  const corten = manifest("recoverable-live", "corten");
  assert.equal(corten.configuration, null); assert.equal(corten.implementation, "pending-implementation");
  assert.equal(corten.configurationTemplate.dockerfile, "bench/live/apps/corten/Dockerfile.parity");
  assert.equal(corten.configurationTemplate.context, ".");
  assert.deepEqual(corten.configurationTemplate.command, ["/app/server"]);
  assert.equal(corten.configurationTemplate.environment.LIVE_PARITY, "1");
  assert.match(corten.configurationTemplate.requiredProfile, /native-feed/);
});

test("client-heavy manifests describe the current native builder, driver and generator", () => {
  const entries = deploymentPlan("client-heavy").apps.map((row) => row.deployments[0]);
  for (const entry of entries) {
    const c = entry.configuration;
    assert.deepEqual(c.command, ["node", "bench/client-heavy/run.mjs"]);
    assert.ok(c.sourceRefs.includes("bench/client-heavy/build.mjs"));
    assert.ok(c.sourceRefs.includes("bench/client-heavy/run.mjs"));
    assert.ok(c.sourceRefs.includes("bench/client-heavy/observer.mjs"));
    assert.match(c.server, /run\.mjs.*static/);
    assert.doesNotMatch(JSON.stringify(c), /bench\/browser\/(?:build\.mjs|serve\.mjs|apps\/state)/);
    assert.throws(() => deploymentDescriptor("client-heavy", entry.app, entry.id, binding(c)), /implementation.*source-present|reservation adapter not integrated/);
  }
  const corten = entries.find((e) => e.app === "corten").configuration;
  assert.ok(corten.sourceRefs.includes("bench/browser/gen/src/bin/client.rs"));
  assert.ok(corten.sourceRefs.includes("bench/browser/gen/src/bin/client.js"));
  assert.ok(entries.find((e) => e.app === "react").configuration.sourceRefs.includes("bench/client-heavy/apps/react.jsx"));
  assert.ok(entries.find((e) => e.app === "svelte").configuration.sourceRefs.includes("bench/client-heavy/apps/svelte.svelte"));
  assert.ok(entries.find((e) => e.app === "vue").configuration.sourceRefs.includes("bench/client-heavy/apps/vue.vue"));
});

test("new descriptor binds exact commit/images/config/work/budgets and evidence without touching registry identity", () => {
  const d = descriptor();
  assert.match(d.descriptorSha256, /^[a-f0-9]{64}$/); assert.equal(screenDeployment(d).status, "pending");
  const b = binding(d.configuration);
  for (const modified of [{ ...b, commit: "b".repeat(40) }, { ...b, images: { app: `sha256:${"b".repeat(64)}` } },
    { ...b, budget: { ...budget, options: { ...budget.options, rate: 151 } } }, { ...b, evidence: { ...b.evidence, implementation: { path: "receipt.json", sha256: "b".repeat(64) } } }]) {
    const next = deploymentDescriptor(d.group, d.app, d.deployment, modified);
    assert.notEqual(next.descriptorSha256, d.descriptorSha256); assert.equal(next.contractSha256, d.contractSha256);
  }
  assert.equal(deploymentSha256({ a: 1, b: 2 }), deploymentSha256({ b: 2, a: 1 }));
  for (const bad of [undefined, NaN, Infinity, { value: undefined }]) assert.throws(() => deploymentSha256(bad));
  assert.throws(() => deploymentDescriptor(d.group, d.app, "unknown", b), /unknown deployment/);
  assert.throws(() => deploymentDescriptor(d.group, d.app, d.deployment, { ...b, images: { app: "image:tag" } }), /immutable image/);
  assert.throws(() => deploymentDescriptor(d.group, d.app, d.deployment, { ...b, commit: "38301e1" }), /exact commit/);
  assert.throws(() => deploymentDescriptor(d.group, d.app, d.deployment, { ...b, configuration: { ...d.configuration, workers: "two" } }), /silently changed/);
  assert.throws(() => deploymentDescriptor(d.group, d.app, "express-bun", { ...b, configuration: null }), /implementation.*source-present/);
  const alternative = deploymentPlan("localized-marketplace").apps.find((row) => row.app === "django").deployments.find((d) => d.id === "django-gunicorn-sync");
  assert.throws(() => deploymentDescriptor("localized-marketplace", "django", alternative.id, binding({ ...alternative.configuration, framework: "Bun.serve" }, emptyEvidence(), "localized-marketplace")), /retain the native framework/);
  for (const path of ["../escape.json", "C:/escape.json", "/absolute.json", "https://example.com/receipt.json", "folder\\receipt.json", "receipt.json:stream", "folder/./receipt.json", "folder//receipt.json"]) {
    assert.throws(() => deploymentDescriptor(d.group, d.app, d.deployment, { ...b, evidence: { ...b.evidence, implementation: { path, sha256: "a".repeat(64) } } }), /relative local/);
  }
});

test("all visible receipt outcomes fail closed and references or saved flags alone never assert a full pass", () => {
  for (const status of ["failed", "unsupported", "pending"]) {
    const f = fixture(descriptor(), { status });
    assert.equal(screenDeployment(f.descriptor, f.validators).status, status);
  }
  const f = fixture();
  assert.equal(screenDeployment(f.descriptor).status, "pending");
  assert.equal(screenDeployment(f.descriptor, { readArtifact: f.validators.readArtifact }).status, "pending-independent-validation");
  const checked = screenDeployment(f.descriptor, f.validators);
  assert.equal(checked.status, "reviewed-for-selection"); assert.equal(checked.certified, false); assert.equal(checked.executionAuthorized, false);
  const failed = fixture(descriptor(), { status: "failed" });
  const partial = deploymentDescriptor(failed.descriptor.group, failed.descriptor.app, failed.descriptor.deployment,
    { ...binding(failed.descriptor.configuration), evidence: { ...emptyEvidence(), implementation: failed.descriptor.evidence.implementation } });
  assert.equal(screenDeployment(partial, failed.validators).status, "failed", "missing later receipts must not hide a known failure");
  for (const validator of ["verifyNative", "verifyPerformance"]) assert.throws(() => screenDeployment(f.descriptor, { ...f.validators, [validator]: () => false }), /did not pass/);
  const changed = structuredClone(f.descriptor); changed.configuration.workers = "two";
  assert.throws(() => screenDeployment(changed, f.validators), /descriptor changed/);
  f.files.set(`${f.descriptor.deployment}/raw.json`, Buffer.from("{}")); assert.throws(() => screenDeployment(f.descriptor, f.validators), /artifact bytes differ/);
});

test("exact whole matrix, independent review, raw captures and repeated CPU/memory/startup/latency evidence are mandatory", () => {
  const invalid = [
    (r) => { r["native-parity"].bindingSha256 = "b".repeat(64); },
    (r) => { r["native-parity"].cases = r["native-parity"].cases.slice(1); },
    (r) => { r.performance.cases = r.performance.cases.slice(1); },
    (r, review) => { review.author = "producer"; },
    (r, review) => { review.scope = "one-row"; },
    (r) => { r.implementation.artifacts = []; },
    (r) => { r.performance.runs.pop(); },
    (r) => { r.performance.runs[1].repeat = "first"; },
    (r) => { r.performance.runs[0].cases.pop(); },
    (r) => { delete r.performance.runs[0].cases[0].metrics.memoryBytes; },
    (r) => { r.performance.runs[0].cases[0].metrics.cpuUsec = -1; },
  ];
  for (const mutate of invalid) {
    const f = fixture(descriptor(), { mutate });
    assert.throws(() => screenDeployment(f.descriptor, f.validators));
  }
});

test("fixed selection preserves all apps and phases, equal budgets and complete candidate visibility", () => {
  const group = "catalog-page", descriptors = selectedApps(group).map((app) => descriptor(group, app));
  const selection = fixedSelection(group, descriptors);
  assert.equal(selection.executionAuthorized, false); assert.deepEqual(selection.cases, definition(group).cases);
  assert.deepEqual(selection.selected.map((row) => row.app), selectedApps(group));
  assert.deepEqual(selection.deployments, deploymentPlan(group).apps); assert.deepEqual(selection.retainedFamilies, retainedFamilies);
  const observed = { app: descriptors[0].app, case: selection.cases[0].key, descriptorSha256: descriptors[0].descriptorSha256, selectionSha256: selection.selectionSha256 };
  assert.equal(verifyPhaseSelection(selection, selection.selectionSha256, observed), true);
  assert.throws(() => verifyPhaseSelection(selection, selection.selectionSha256, { ...observed, descriptorSha256: "b".repeat(64) }), /switched mid-round/);
  assert.throws(() => verifyPhaseSelection(selection, "b".repeat(64), observed), /changed after reservation/);
  assert.throws(() => verifyPhaseSelection({ ...selection, budget: { ...budget, options: { ...budget.options, rate: 151 } } }, selection.selectionSha256, observed), /content changed/);
  assert.throws(() => verifyPhaseSelection({ ...selection, budget: { unrelated: true } }, selection.selectionSha256, observed), /reservation/);
  assert.throws(() => fixedSelection(group, descriptors.slice(1)), /all registry apps/);
  assert.throws(() => fixedSelection(group, [descriptors[0], descriptors[0], ...descriptors.slice(2)]), /all registry apps/);
  const changed = [...descriptors];
  const d = descriptors[1];
  changed[1] = deploymentDescriptor(group, d.app, d.deployment, { ...binding(d.configuration), budget: { ...budget, options: { ...budget.options, rate: 151 } } });
  assert.throws(() => fixedSelection(group, changed), /equal total deployment budgets/);
  changed[1] = deploymentDescriptor(group, d.app, d.deployment, { ...binding(d.configuration), commit: "b".repeat(40) });
  assert.throws(() => fixedSelection(group, changed), /fixed round commit/);
  const i = descriptors.findIndex((d) => d.app === "express"), current = descriptors[i];
  changed.splice(0, changed.length, ...descriptors);
  assert.throws(() => deploymentDescriptor(group, "express", "express-bun", binding({ ...current.configuration, runtime: "Bun", command: ["bun", "server.mjs"] })), /implementation.*source-present/);
});

test("an alternative needs a replayed representative comparison and independently reviewed whole-group tradeoff", () => {
  const base = fixture(descriptor("localized-marketplace", "django")), current = base.descriptor;
  const alternative = deploymentPlan(current.group).apps.find((row) => row.app === current.app).deployments.find((d) => d.id === "django-gunicorn-sync");
  const candidate = deploymentDescriptor(current.group, current.app, alternative.id, binding(alternative.configuration, emptyEvidence(), current.group));
  const alt = fixture(candidate, { baseline: current });
  const files = new Map([...base.files, ...alt.files]);
  const validators = { ...alt.validators, readArtifact: (path) => { assert.ok(files.has(path), `missing ${path}`); return files.get(path); } };
  assert.equal(screenDeployment(alt.descriptor, validators).status, "reviewed-for-selection");
  const descriptors = selectedApps(current.group).map((app) => app === current.app ? alt.descriptor : descriptor(current.group, app));
  assert.equal(fixedSelection(current.group, descriptors, validators).selected.find((row) => row.app === current.app).deployment, alternative.id);
  const pending = [...descriptors]; pending[pending.findIndex((d) => d.app === current.app)] = candidate;
  assert.throws(() => fixedSelection(current.group, pending), /complete independent group qualification/);
  assert.equal(screenDeployment(alt.descriptor, { readArtifact: validators.readArtifact }).status, "pending");
  for (const mutate of [
    (r) => { delete r.performance.baseline; },
    (r) => { r.performance.baselineBindingSha256 = "b".repeat(64); },
    (r, review) => { review.baselineBindingSha256 = "b".repeat(64); },
    (r, review) => { review.tradeoff = ""; },
  ]) {
    const broken = fixture(candidate, { baseline: current, mutate });
    const brokenFiles = new Map([...base.files, ...broken.files]);
    assert.throws(() => screenDeployment(broken.descriptor, { ...validators, readArtifact: (path) => brokenFiles.get(path) }));
  }
  assert.throws(() => screenDeployment(alt.descriptor, { ...validators, verifyNative: ({ descriptor }) => descriptor.deployment === alternative.id }), /native implementation\/parity validation did not pass/);
});

test("CLI has only read-only inventory, no execution, tuning, receipt-promotion or app-subset flags", () => {
  assert.equal(deploymentCli(["--all"]).length, 9); assert.equal(deploymentCli(["json-api"]).apps.length, 9);
  for (const args of [[], ["--run"], ["catalog-page", "--qualified"], ["catalog-page", "--apps", "express"], ["catalog-page", "--memory", "2g"]]) assert.throws(() => deploymentCli(args));
  assert.deepEqual(Object.keys(outcomeKinds), ["app-capacity", "harness-failure", "functional-failure"]);
  const source = readFileSync(new URL("deployments.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bfetch\(|\bwriteFileSync\(|\bspawn\(/);
});

test("pending source integration and implementation cannot bind representatives, candidates or fixed selections", () => {
  const base = descriptor(); let pending = 0;
  for (const group of groupNames) for (const row of deploymentPlan(group).apps) for (const entry of row.deployments) {
    if (entry.implementation === "source-present") continue;
    const configuration = entry.configuration ?? row.deployments[0].configuration ?? manifest("catalog-page", "express").configuration;
    assert.throws(() => deploymentDescriptor(group, row.app, entry.id, binding(configuration)), /implementation.*source-present/);
    const forged = uncheckedBinding(base, { group, app: row.app, deployment: entry.id, contractSha256: contractSha256(group), cases: definition(group).cases, configuration });
    assert.throws(() => screenDeployment(forged), /implementation.*source-present/);
    pending++;
  }
  assert.ok(pending > 0, "pending candidates must remain in the catalog");
  const catalog = selectedApps("catalog-page").map((app) => descriptor("catalog-page", app));
  catalog[catalog.findIndex((d) => d.app === "express")] = uncheckedBinding(base, { deployment: "express-bun" });
  assert.throws(() => fixedSelection("catalog-page", catalog), /implementation.*source-present/);
  assert.throws(() => fixedSelection("client-heavy", selectedApps("client-heavy").map((app) => {
    const entry = manifest("client-heavy", app);
    return deploymentDescriptor("client-heavy", app, entry.id, binding(entry.configuration));
  })), /implementation.*source-present|reservation adapter not integrated/);
  const savedClient = selectedApps("client-heavy").map((app) => {
    const entry = manifest("client-heavy", app);
    return uncheckedBinding(base, { group: "client-heavy", app, deployment: entry.id, configuration: entry.configuration,
      images: { screen: `sha256:${"a".repeat(64)}` }, cases: definition("client-heavy").cases, contractSha256: contractSha256("client-heavy") });
  });
  assert.throws(() => fixedSelection("client-heavy", savedClient), /implementation.*source-present|reservation adapter not integrated/, "six rehashed saved descriptors cannot bypass the implementation/reservation gates");
});

test("truthy or incomplete budgets cannot bind even a complete equal catalog selection", () => {
  const entry = manifest("catalog-page", "express");
  for (const bad of ["x", ["x"], { cpus: -1 }, { unrelated: true }]) {
    assert.throws(() => deploymentDescriptor("catalog-page", "express", entry.id, { ...binding(entry.configuration), budget: bad }), /reservation/);
    assert.throws(() => fixedSelection("catalog-page", selectedApps("catalog-page").map((app) => {
      const current = manifest("catalog-page", app);
      return deploymentDescriptor("catalog-page", app, current.id, { ...binding(current.configuration), budget: bad });
    })), /reservation/);
    const forged = selectedApps("catalog-page").map((app) => uncheckedBinding(descriptor("catalog-page", app), { budget: bad }));
    assert.throws(() => fixedSelection("catalog-page", forged), /reservation/);
    assert.throws(() => screenDeployment(forged[0]), /reservation/);
  }
});

test("native reservations validate actual work, all container resources, process scope, placement and edge before comparison", () => {
  for (const group of ["catalog-page", "json-api", "localized-marketplace"]) {
    const valid = nativeBudget(group);
    assert.equal(validateDeploymentBudget(group, valid), valid);
    const prefix = { "catalog-page": "CATALOG", "json-api": "JSON_API", "localized-marketplace": "MARKETPLACE" }[group];
    const pinned = nativeBudget(group, { [`${prefix}_APP_CPUS`]: "1", [`${prefix}_API_CPUS`]: "2-3", [`${prefix}_LOAD_CPUS`]: "4-7" });
    assert.equal(validateDeploymentBudget(group, pinned), pinned);
    const invalid = [
      (b) => { b.schema = "unknown"; }, (b) => { b.group = "hardening"; }, (b) => { b.runner = "bench/live/run.mjs"; },
      (b) => { delete b.options.duration; }, (b) => { b.options.rate = "150"; }, (b) => { b.options.passes = 2; },
      (b) => { b.options.duration = 301; }, (b) => { b.options.startupTimeout = -1; }, (b) => { b.options.checkOnly = true; },
      (b) => { b.options.apps.pop(); }, (b) => { b.options.unrelated = true; },
      (b) => { b.cpus.app.quota = -1; }, (b) => { b.cpus.app.quota = 2; }, (b) => { b.cpus.app.cpuset = "0"; b.cpus.api.cpuset = "0"; },
      (b) => { delete b.resources.upstream; }, (b) => { b.resources.app.memoryBytes = -1; }, (b) => { b.resources.app.memoryBytes *= 2; },
      (b) => { b.resources.app.processes = "main-process-only"; }, (b) => { b.resources.load.sharedMemoryBytes = 123; },
      (b) => { delete b.resources.sampler; }, (b) => { b.host.cpu = 1; }, (b) => { b.host.processes = []; },
      (b) => { b.edge = { cpu: 1, memoryBytes: 100 }; }, (b) => { b.unrelated = true; },
    ];
    for (const mutate of invalid) {
      const bad = structuredClone(valid); mutate(bad);
      assert.throws(() => validateDeploymentBudget(group, bad));
    }
    const i = manifest(group, "aspnet"), d = deploymentDescriptor(group, i.app, i.id, binding(i.configuration, emptyEvidence(), group));
    for (const mutate of invalid) {
      const bad = structuredClone(valid); mutate(bad);
      assert.throws(() => deploymentDescriptor(group, i.app, i.id, { ...binding(i.configuration, emptyEvidence(), group), budget: bad }));
      assert.throws(() => fixedSelection(group, selectedApps(group).map((app) => uncheckedBinding(descriptor(group, app), { budget: bad }))));
    }
    assert.equal(screenDeployment(d).status, "pending", "valid reservation is not qualification");
  }
  for (const group of groupNames.filter((group) => !["catalog-page", "json-api", "localized-marketplace"].includes(group))) assert.throws(() => validateDeploymentBudget(group, budget), /reservation adapter not integrated/);
  const alternative = deploymentPlan("localized-marketplace").apps.find((row) => row.app === "django").deployments.find((d) => d.id === "django-gunicorn-sync");
  assert.throws(() => deploymentDescriptor("localized-marketplace", "django", alternative.id, binding({ ...alternative.configuration, edge: "unbudgeted reverse proxy" }, emptyEvidence(), "localized-marketplace")), /edge topology/);
});
