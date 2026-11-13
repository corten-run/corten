import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bindExecution, captureSources, recipes, reviewSubject, validateArtifactPaths, validateBinding } from "./contract.mjs";
import { contractSha256, definition, groupNames, selectedApps } from "../registry.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { invocation } from "../run.mjs";
import { parseArgs as catalogOptions } from "../../catalog/contract.mjs";
import { parseArgs as jsonOptions } from "../../json-api/contract.mjs";
import { parseArgs as marketplaceOptions } from "../../marketplace/run-contract.mjs";
import { parseArgs as mixedOptions } from "../../mixed-production/run.mjs";
import { parseOptions as browserOptions } from "../../fullstack-browser/contract.mjs";
import { parseArgs as hardeningOptions } from "../../hardening/plan.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const roundFor = (group) => group === "catalog-page" ? "c2" : group === "json-api" ? "j1" : "w1";
const requestFor = (group, recipe = "native-defaults") => ({ group, round: roundFor(group), commit, recipe });
const bind = (group, recipe = "native-defaults") => bindExecution({ ...requestFor(group, recipe), review: null });
const reseal = (binding) => {
  const { bindingSha256, ...body } = binding;
  return { ...body, bindingSha256: deploymentSha256(body) };
};
const approve = (input) => ({ schema: "benchmark-isolated-review/v1", subjectSha256: reviewSubject(input), reviewer: "independent-reviewer", decision: "approved" });

test("real committed sources include native implementations, locks, registry and this contract", () => {
  const sources = captureSources(commit);
  assert.ok(Object.isFrozen(sources.files));
  for (const path of ["bench/workloads/registry.mjs", "bench/workloads/isolated/contract.mjs", "bench/workloads/isolated/contract.test.mjs",
    "bench/client-heavy/run.mjs", "bench/live/parity.mjs", "bench/live/native-http.mjs", "bench/live/apps/laravel/wire.mjs",
    "bench/live/apps/rails/wire.mjs", "bench/live/apps/phoenix/wire.mjs", "crates/corten/src/lib.rs", "package-lock.json", "bench/browser/package-lock.json"]) {
    const actual = execFileSync("git", ["show", `${commit}:${path}`], { cwd: root });
    assert.equal(sources.files.find((f) => f.path === path)?.sha256, createHash("sha256").update(actual).digest("hex"), path);
  }
  assert.equal(sources.sha256, deploymentSha256(sources.files));
  assert.ok(sources.files.every((f) => !f.path.split("/").some((part) => ["results", "evidence", "work", "node_modules", "target"].includes(part))));
});

for (const group of groupNames) test(`${group}: binds complete registry, fixed native invocation and unknown evidence`, () => {
  const binding = bind(group), e = binding.execution;
  assert.deepEqual(binding.selection.apps, selectedApps(group));
  assert.deepEqual(binding.selection.definition, definition(group));
  assert.equal(binding.selection.contractSha256, contractSha256(group));
  assert.equal(binding.latestStable.group, group);
  assert.equal(binding.latestStable.valid, true);
  assert.equal(binding.latestStable.status, group === "client-heavy" ? "blocked" : "not-applicable");
  assert.equal(binding.latestStable.groupComparisonEligible, group === "client-heavy" ? false : null);
  for (const source of Object.values(binding.latestStable.sources)) {
    assert.equal(binding.sources.files.find((file) => file.path === source.path)?.sha256, source.sha256);
  }
  assert.equal(binding.coverage.cells.length, selectedApps(group).length * definition(group).cases.length);
  assert.ok(binding.coverage.cells.every((c) => c.implementation === "unknown" && c.parity === "not-run" && c.measurement === "not-run" && c.metrics === undefined));
  assert.equal(e.invocation.executable, "node");
  assert.equal(e.invocation.shell, false);
  const base = invocation([group, roundFor(group)]).args;
  assert.deepEqual(e.invocation.argv.slice(0, base.length), base);
  assert.deepEqual(e.requestedOverrides, []);
  assert.equal(e.operationalOptions.freshDirectoryRequired, true);
  assert.ok(binding.validation.requirements.every((g) => g.state === "unknown"));
  assert.equal(binding.status.nativeEvidence, "unknown");
  assert.equal(binding.status.ready, false);
  assert.equal(binding.status.executionAuthorized, false);
  assert.ok(binding.status.blockers.length >= 4);
  assert.equal(validateBinding(JSON.parse(JSON.stringify(binding))).binding, "verified-offline");
  assert.equal(validateBinding(binding).ready, false);
  assert.ok(Object.isFrozen(e.invocation.argv));
  assert.throws(() => { e.invocation.argv.push("--apps"); }, TypeError);
  assert.throws(() => { binding.selection.apps.pop(); }, TypeError);
});

test("timed HTTP defaults and effective build options come from their native parsers", () => {
  for (const [group, parse] of [["catalog-page", catalogOptions], ["json-api", jsonOptions], ["localized-marketplace", marketplaceOptions]]) {
    const e = bind(group).execution, available = Object.fromEntries(selectedApps(group).map((app) => [app, {}]));
    assert.deepEqual(e.nativeDefaults, parse([roundFor(group), "--group", group], available));
    assert.deepEqual(e.effectiveOptions, parse(e.invocation.argv.slice(1), available));
    assert.equal(e.nativeDefaults.build, false); assert.equal(e.effectiveOptions.build, true);
    assert.equal(e.effectiveOptions.passes, 3); assert.equal(e.effectiveOptions.duration, 60);
    assert.equal(e.effectiveOptions.warmup, 30); assert.equal(e.effectiveOptions.rate, 150);
  }
});

test("mixed keeps native functional defaults separate from explicit measurement", () => {
  const ordinary = bind("mixed-production"), measured = bind("mixed-production", "mixed-measure");
  const expected = mixedOptions(ordinary.execution.invocation.argv.slice(1)); expected.apps = selectedApps("mixed-production");
  assert.deepEqual(ordinary.execution.effectiveOptions, expected);
  assert.equal(ordinary.execution.effectiveOptions.measure, false);
  assert.equal(ordinary.resources.measurement, null);
  assert.equal(ordinary.resources.functional.capture.cpu, 2);
  assert.equal(measured.execution.effectiveOptions.measure, true);
  for (const [key, value] of Object.entries({ profile: "defaults", seed: 42, clients: 2, repetitions: 1, passes: 3, duration: 120,
    warmup: 15, calibration: 30, tailSeconds: 120, maxCycles: 16, slowDelayMs: 40000, requestTimeoutMs: 60000 })) {
    assert.equal(measured.execution.effectiveOptions[key], value, key);
  }
  assert.equal(measured.resources.measurement.cpu.load.cpuset, "4-7");
  assert.equal(measured.resources.measurement.memoryBytes.qualificationWorker, 2 ** 30);
  assert.equal(measured.resources.measurement.memoryBytes.load, 2 ** 31);
  assert.equal(measured.resources.measurement.loadSharedMemoryBytes, 512 * 2 ** 20);
});

test("browser recipe supplies only required build/output options, not subset or target manifests", () => {
  const b = bind("fullstack-browser"), e = b.execution;
  assert.deepEqual(e.effectiveOptions, browserOptions(e.invocation.argv.slice(1)));
  assert.equal(e.effectiveOptions.apps.length, 10); assert.equal(e.effectiveOptions.cases, null);
  assert.equal(e.effectiveOptions.targets, null); assert.equal(b.coverage.cells.length, 240);
  assert.equal(e.settings.profiles.mobile.cpu, 4); assert.equal(e.settings.actionTimeoutMs, 15000);
  assert.equal(b.validation.validator, null);
  assert.ok(b.validation.requirements.some((g) => g.requirement.includes("summary qualification")));
});

test("client-heavy keeps bounded sizes, fresh native generation and no --build/cargo override", () => {
  const b = bind("client-heavy"), e = b.execution;
  assert.deepEqual(e.nativeDefaults, { rows: 14, large: 110, append: 7, cards: 24, seed: 7, cleanupMs: 2000, observationMs: 100, timeoutMs: 30000, cargo: "cargo" });
  assert.deepEqual(e.invocation.argv, ["bench/client-heavy/run.mjs", "w1", "--out", "bench/client-heavy/work/w1"]);
  assert.equal(b.resources.app, null); assert.equal(b.resources.state, "blocked");
  assert.deepEqual(b.validation.required, ["result.json", "native/build.json"]);
});

test("live preserves historical-mode guard, unchanged defaults, registered ports and explicit equal native-feed profile", () => {
  for (const group of ["live-delivery", "recoverable-live"]) {
    const ordinary = bind(group), measured = bind(group, "native-feed-measure");
    assert.equal(ordinary.execution.effectiveOptions.profile, "bounded");
    assert.equal(ordinary.execution.effectiveOptions.measure, false);
    assert.ok(ordinary.status.blockers.includes("native port incompatible with selected profile: corten"));
    assert.equal(measured.execution.nativeDefaults.profile, "bounded");
    assert.deepEqual(measured.execution.nativeDefaults, { apps: selectedApps(group), build: false, profile: "bounded", measure: false });
    assert.deepEqual(measured.execution.effectiveOptions, { apps: selectedApps(group), build: true, profile: "native-feed", measure: true });
    assert.deepEqual(measured.execution.invocation.argv, [group === "live-delivery" ? "bench/live/run.mjs" : "bench/recoverable-live/run.mjs", "w1",
      ...(group === "live-delivery" ? ["--group", group] : []), "--build", "--profile", "native-feed", "--measure"]);
    assert.equal(measured.execution.settings.workload.seed, 17);
    assert.equal(measured.execution.settings.workload.initial.length, 5);
    assert.equal(measured.execution.settings.workload.eventCount, 1044);
    assert.ok(measured.execution.settings.settings.every((s) => s.queueLimit === 1024 && s.historyLimit === 1025 && s.maxRecoveryMs === 10000));
    assert.deepEqual(measured.execution.settings.measurement.clients, [1, 2, 4]);
    assert.equal(measured.execution.settings.scenarios.length, group === "live-delivery" ? 2 : 6);
    assert.deepEqual(measured.execution.settings.inventory.map((entry) => entry.app), selectedApps(group));
    assert.ok(measured.execution.settings.inventory.every((entry) => entry.implementation === "implemented"));
    assert.ok(!measured.status.blockers.some((s) => s.startsWith("missing native registration:") || s.startsWith("native port incompatible")));
    if (group === "recoverable-live") assert.equal(measured.execution.settings.inventory.find((entry) => entry.app === "laravel").topology,
      "FrankenPHP Octane two workers and Reverb; file cache and native broker HTTP; no shared renderer");
    if (group === "live-delivery") assert.ok(measured.execution.invocation.argv.includes("--group"));
    assert.equal(measured.status.ready, false);
  }
});

test("reviewed live CLI parser bytes and explicit rejection semantics remain unchanged", async () => {
  const source = readFileSync(join(root, "bench/live/parity.mjs"), "utf8").replaceAll("\r\n", "\n");
  const parser = source.slice(source.indexOf("export async function main("));
  assert.equal(createHash("sha256").update(parser).digest("hex"), "634281d26c75390cade87f7046ee04db5999b1b360bfeeaca8c36f9424ee02de");
  assert.ok(source.includes('export async function run({ group, out, apps: requested, build = false, round, profile = "bounded", measure = false })'));
  const { runRound } = await import("../../live/parity.mjs");
  for (const group of ["live-delivery", "recoverable-live"]) {
    await assert.rejects(runRound(group, ["w1", "--duration", "1"]), /unknown argument/);
    await assert.rejects(runRound(group, ["w1", "--profile"]), /needs a value/);
    await assert.rejects(runRound(group, ["../escape"]), /safe round/);
  }
});

test("live rebinding rejects rehashed HTTP source, profile and registered topology substitutions", () => {
  const binding = bind("recoverable-live", "native-feed-measure");
  for (const mutate of [
    (b) => { b.sources.files.find((file) => file.path === "bench/live/native-http.mjs").sha256 = "b".repeat(64); b.sources.sha256 = deploymentSha256(b.sources.files); },
    (b) => { b.execution.effectiveOptions.profile = "bounded"; },
    (b) => { b.execution.settings.inventory.find((entry) => entry.app === "laravel").topology = "one process"; },
    (b) => { b.execution.settings.settings[0].queueLimit = 2; },
  ]) {
    const changed = structuredClone(binding); mutate(changed);
    assert.throws(() => validateBinding(reseal(changed)), /binding differs/);
  }
});

test("hardening binds native reviewed-profile reference without treating the string as approval", () => {
  const b = bind("hardening"), e = b.execution;
  assert.deepEqual(e.effectiveOptions, hardeningOptions(e.invocation.argv.slice(1)));
  assert.equal(e.nativeDefaults.review, null); assert.equal(e.effectiveOptions.review, b.subjectSha256);
  assert.deepEqual(e.effectiveOptions.verify, {}); assert.equal(e.effectiveOptions.profile, "bounded");
  assert.equal(e.settings.attack.maxConnections, 12); assert.equal(e.settings.resources.cpuCoresTotal, 1.5);
  assert.equal(b.review.state, "unknown"); assert.equal(b.status.executionAuthorized, false);
});

test("explicit short windows bind exact review subject, never overwrite native defaults", () => {
  const input = requestFor("localized-marketplace", "marketplace-short-window");
  const b = bindExecution({ ...input, review: approve(input) });
  assert.equal(b.execution.nativeDefaults.duration, 60); assert.equal(b.execution.nativeDefaults.warmup, 30);
  assert.equal(b.execution.effectiveOptions.duration, 15); assert.equal(b.execution.effectiveOptions.warmup, 10);
  assert.equal(b.execution.effectiveOptions.rate, 150); assert.equal(b.execution.effectiveOptions.passes, 3);
  assert.equal(b.review.state, "declared-not-authenticated");
  assert.equal(b.status.ready, false); assert.equal(validateBinding(b).executionAuthorized, false);
  for (const changed of [{ round: "w2" }, { recipe: "native-defaults" }, { group: "mixed-production", recipe: "mixed-measure" }]) {
    assert.throws(() => bindExecution({ ...input, ...changed, review: b.review.declaration }), /review belongs/);
  }
  assert.throws(() => bindExecution({ ...input, review: { ...b.review.declaration, decision: "rejected" } }), /does not approve/);
  assert.throws(() => bindExecution({ ...input, review: { ...b.review.declaration, reviewer: "reviewer\n--collect" } }), /named reviewer/);
});

test("request accepts no arbitrary commands, flags, subsets, paths, environments or measurements", () => {
  const input = { ...requestFor("catalog-page"), review: null };
  for (const [key, value] of Object.entries({ command: "sh", args: ["-c", "true"], apps: ["corten"], cases: [], part: "1/2", out: "elsewhere",
    stateDir: "elsewhere", images: {}, receipts: "external.json", env: {}, duration: 1, source: "fixture", ready: true })) {
    assert.throws(() => bindExecution({ ...input, [key]: value }), /unexpected fields/, key);
  }
  for (const group of groupNames) for (const recipe of Object.keys(recipes)) if (!recipes[recipe].includes(group)) {
    assert.throws(() => bindExecution({ ...requestFor(group, recipe), review: null }), /not supported/);
  }
  for (const round of ["c1", "c0", "c02", "../c2", "c2/child", "c2\\child", "c2;true", "c2\n", "c2 --apps corten"]) {
    assert.throws(() => bindExecution({ ...input, round }), /round|reserved/);
  }
  for (const round of ["con", "LPT1", "name.with.dot", "x".repeat(65)]) {
    assert.throws(() => bindExecution({ ...requestFor("client-heavy"), review: null, round }), /round|reserved/);
  }
  for (const round of ["r16", "r017", "r0"]) assert.throws(() => bindExecution({ ...requestFor("localized-marketplace"), round, review: null }));
  const official = bindExecution({ ...requestFor("localized-marketplace"), round: "r17", review: null });
  assert.equal(official.execution.effectiveOptions.round, "r17");
  assert.equal(official.status.executionAuthorized, false);
});

test("JSON-roundtripped recipe arrays cannot select overrides by object-key coercion", () => {
  for (const [group, recipe] of [["mixed-production", "mixed-measure"],
    ["localized-marketplace", "marketplace-short-window"], ["live-delivery", "native-feed-measure"],
    ["recoverable-live", "native-feed-measure"]]) {
    const input = JSON.parse(JSON.stringify({ ...requestFor(group, recipe), recipe: [recipe], review: null }));
    assert.throws(() => bindExecution(input), /recipe must be a string/, `${group}: bindExecution`);
    const { review, ...subject } = input;
    assert.throws(() => reviewSubject(subject), /recipe must be a string/, `${group}: reviewSubject`);
  }
});

test("self-rehashed mutations cannot change frozen selection, sources, commands, settings or validation states", () => {
  const good = bind("catalog-page");
  const mutations = [
    (b) => { b.selection.apps.pop(); },
    (b) => { b.selection.definition.cases.pop(); },
    (b) => { b.selection.contractSha256 = "0".repeat(64); },
    (b) => { b.sources.files[0].sha256 = "0".repeat(64); b.sources.sha256 = deploymentSha256(b.sources.files); },
    (b) => { b.sources.files.pop(); b.sources.sha256 = deploymentSha256(b.sources.files); },
    (b) => { b.sources.files.push({ path: "outside/secret", mode: "100644", sha256: "0".repeat(64) }); },
    (b) => { delete b.latestStable; },
    (b) => { b.latestStable.groupComparisonEligible = true; },
    (b) => { b.latestStable.sources.policy.sha256 = "0".repeat(64); },
    (b) => { b.execution.invocation.executable = "sh"; },
    (b) => { b.execution.invocation.argv.push("--apps", "corten"); },
    (b) => { b.execution.effectiveOptions.duration = 1; },
    (b) => { b.execution.operationalOptions.artifactRoot = "bench/catalog/results/c3"; },
    (b) => { b.resources.expectedCpus.app.cpuset = "4-7"; },
    (b) => { b.validation.validator.argv.push("--skip"); },
    (b) => { b.validation.requirements[0].state = "passed"; },
    (b) => { b.validation.outcomePolicy = "failed = 0"; },
    (b) => { b.coverage.cells[0].metrics = { rps: 0 }; },
    (b) => { b.coverage.cells[0].parity = "passed"; },
    (b) => { b.status.ready = true; b.status.executionAuthorized = true; },
    (b) => { b.status.blockers = []; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => validateBinding(reseal(bad)), /binding differs/);
  }
  const extra = { ...good, arbitrary: "command" };
  assert.throws(() => validateBinding(reseal(extra)), /binding differs/);
});

test("stale or shortened commit identities cannot bind or validate", () => {
  for (const bad of [commit.slice(0, 8), "0".repeat(40), commit.toUpperCase(), `${commit}:bench`]) {
    assert.throws(() => bindExecution({ ...requestFor("json-api"), commit: bad, review: null }), /commit|HEAD/);
  }
  const b = structuredClone(bind("json-api")); b.request.commit = "0".repeat(40);
  assert.throws(() => validateBinding(reseal(b)), /HEAD/);
});

test("inherited native selectors cannot silently change the bound execution", () => {
  for (const key of ["BENCH_APPS", "BENCH_TIER", "BENCH_EDGE", "PROFILE"]) {
    const previous = process.env[key];
    try {
      process.env[key] = "untrusted-override";
      assert.throws(() => bind("catalog-page"), /unset legacy selection\/profile overrides/);
      assert.throws(() => captureSources(commit), /unset legacy selection\/profile overrides/);
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  }
});

test("actual dirty source is refused and restoring owned bytes restores binding", () => {
  const path = new URL("./README.md", import.meta.url), original = readFileSync(path);
  const b = bind("catalog-page");
  try {
    writeFileSync(path, Buffer.concat([original, Buffer.from("\nDirty-source rejection test.\n")]));
    assert.throws(() => captureSources(commit), /clean committed checkout/);
    assert.throws(() => validateBinding(b), /clean committed checkout/);
  } finally { writeFileSync(path, original); }
  assert.equal(validateBinding(b).binding, "verified-offline");
});

test("artifact namespace is exact, required, case-safe and never a positive native verdict", () => {
  for (const group of groupNames) {
    const b = bind(group), prefix = `${b.validation.artifactRoot}/`, required = b.validation.required.map((f) => prefix + f);
    const result = validateArtifactPaths(b, [...required, `${prefix}native/raw-observation.json.gz`]);
    assert.deepEqual(result, { namespace: "verified", nativeEvidence: "unknown", ready: false });
    assert.throws(() => validateArtifactPaths(b, []), /required/);
  }
  const b = bind("catalog-page"), prefix = `${b.validation.artifactRoot}/`, required = prefix + "summary.json";
  assert.deepEqual(validateArtifactPaths(b, [required,
    `${prefix}build-source/pages/[locale]/[id].tsx`, `${prefix}build-source/api.$id.ts`,
    `${prefix}build-source/50%.css`, `${prefix}vendor/wasi-0.11.1+snapshot/Cargo.toml`,
    `${prefix}node_modules/@scope/package/package.json`]),
  { namespace: "verified", nativeEvidence: "unknown", ready: false });
  for (const bad of ["/etc/passwd", "D:/other/summary.json", "bench/catalog/results/c20/summary.json", `${prefix}../summary.json`,
    `${prefix}a//b`, `${prefix}a\\b`, `${prefix}a/./b`, `${prefix}CON.txt`, `${prefix}a.`, `${prefix}a\nb`, `${prefix}a:stream`]) {
    assert.throws(() => validateArtifactPaths(b, [required, bad]), /artifact/);
  }
  assert.throws(() => validateArtifactPaths(b, [required, required.toUpperCase().replace("BENCH/CATALOG/RESULTS/C2/", prefix)]), /colliding/);
  assert.throws(() => validateArtifactPaths(b, [`${prefix}raw.json`]), /missing required/);
});
