import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { composePhase } from "./composition.mjs";
import { evaluateLatestStable, latestStableSchema, latestStableSources, candidateLatestStableSchema, unsupportedSolidReason } from "../latest-stable.mjs";
import { selectedApps } from "../registry.mjs";
import { readLatestStable } from "../../client-heavy/build.mjs";
import { comparisonProfile } from "../../client-heavy/contract.mjs";
const policy = (group, status = "not-applicable") => ({ schema: latestStableSchema, group, valid: true, status, groupComparisonEligible: status === "not-applicable" ? null : false });
const binding = { request: { group: "live-delivery" }, latestStable: policy("live-delivery"), preparation: { fixtures: [] }, selection: { apps: ["a", "b", "c"] } };
const native = { status: "failed", attemptComplete: true, cleanupComplete: true, resources: "verified",
  outcomes: [{ app: "a", outcome: "passed" }, { app: "b", outcome: "failed" }, { app: "c", outcome: "unsupported" }] };
const command = { terminal: true, code: 1, error: null, cancelled: false, forced: false, success: false };
test("complete observed failures stay selected; apparatus completion is not a successful baseline", () => {
  const result = composePhase(binding, native, { cleanupComplete: true, resources: "verified" }, [command]);
  assert.equal(result.outcome, "native-validated"); assert.deepEqual(result.appOutcomes.map((r) => r.comparisonEligible), [true, false, false]);
});

const hardeningApps = selectedApps("hardening");
const hardeningBinding = { ...binding, request: { group: "hardening" }, latestStable: policy("hardening"),
  selection: { apps: hardeningApps } };
const hardeningNative = { ...native, blockers: [], comparisonEligibleApps: [],
  outcomes: hardeningApps.map((app, i) => ({ app, outcome: i === 0 ? "failed" : i === 1 ? "unsupported" : "passed" })) };
const hardeningHost = { cleanupComplete: true, resources: "verified" };
const exitedZero = { ...command, code: 0, signal: null, success: true };
const hardeningCommands = [exitedZero];

test("hardening exit zero preserves replayed app dispositions without qualifying any comparison", () => {
  const verified = { ...hardeningNative, status: "verified",
    outcomes: hardeningNative.outcomes.map((row) => ({ ...row, outcome: row.outcome === "failed" ? "passed" : row.outcome })) };
  const allPassed = { ...verified, outcomes: hardeningApps.map((app) => ({ app, outcome: "passed" })) };
  for (const n of [hardeningNative, verified, allPassed]) {
    const result = composePhase(hardeningBinding, n, hardeningHost, hardeningCommands);
    assert.equal(result.outcome, "native-validated"); assert.equal(result.nativeStatus, n.status);
    assert.equal(result.report.qualification, "native-replay-passed");
    assert.deepEqual(result.appOutcomes, n.outcomes.map((row) => ({ ...row, comparisonEligible: false })));
  }
});

test("hardening contradictions or incomplete proof never qualify the run or a comparison", () => {
  const run = (n = hardeningNative, h = hardeningHost, c = hardeningCommands, audit = true) => {
    const result = composePhase(hardeningBinding, n, h, c, audit);
    assert.notEqual(result.outcome, "native-validated");
    assert.equal(result.report.qualification, "blocked");
    assert.ok(result.appOutcomes.every((row) => !row.comparisonEligible));
  };
  for (const patch of [
    { status: "blocked" }, { status: "invalid" }, { status: "verified" },
    { outcomes: hardeningNative.outcomes.map((row) => ({ ...row, outcome: "passed" })) },
    { outcomes: hardeningNative.outcomes.map((row) => row === hardeningNative.outcomes[0] ? { ...row, outcome: "not-run" } : row) },
    { attemptComplete: false }, { cleanupComplete: false }, { resources: "blocked" }, { resources: "invalid" },
    { blockers: ["hardening-native-group-not-ready"] },
    { comparisonEligibleApps: undefined }, { comparisonEligibleApps: "all" }, { comparisonEligibleApps: [hardeningApps.at(-1)] },
  ]) run({ ...hardeningNative, ...patch });
  for (const patch of [
    { code: 1, success: false }, { code: 2, success: false }, { code: 137, success: false }, { code: null, success: false }, { code: "0" },
    { terminal: false }, { signal: "SIGTERM" }, { cancelled: true }, { forced: true }, { error: "spawn error" }, { success: false },
  ]) run(undefined, undefined, [{ ...exitedZero, ...patch }]);
  run(undefined, undefined, []);
  run(undefined, undefined, [exitedZero, exitedZero]);
  run(undefined, { ...hardeningHost, cleanupComplete: false });
  run(undefined, { ...hardeningHost, resources: "invalid" });
  run(undefined, undefined, undefined, false);
});

test("browser intrinsic unsupported attempts use only the replayed qualification exit and never gain comparison eligibility", () => {
  const b = { ...binding, request: { group: "fullstack-browser" }, latestStable: policy("fullstack-browser") };
  const n = { ...native, status: "verified", qualificationPassed: false, expectedExitCode: 1, comparisonEligibleApps: [],
    outcomes: native.outcomes.map((row) => ({ ...row, outcome: row.outcome === "failed" ? "unsupported" : row.outcome })) };
  const host = { cleanupComplete: true, resources: "verified" };
  const value = composePhase(b, n, host, [command]);
  assert.equal(value.outcome, "native-validated"); assert.equal(value.nativeStatus, "verified");
  assert.deepEqual(value.appOutcomes.map(({ comparisonEligible, ...row }) => row), n.outcomes);
  assert.ok(value.appOutcomes.every((row) => !row.comparisonEligible));
  for (const code of [0, 2, 137, null]) assert.notEqual(composePhase(b, n, host, [{ ...command, code }]).outcome, "native-validated");
  for (const expectedExitCode of [undefined, null, "1", 2, 137, 0])
    assert.notEqual(composePhase(b, { ...n, expectedExitCode }, host, [command]).outcome, "native-validated");
});

test("mixed complete failures retain healthy functional apps without inventing their gated timing", () => {
  const b = { ...binding, request: { group: "mixed-production" }, latestStable: policy("mixed-production") };
  for (const comparisonEligibleApps of [undefined, null, "a", { 0: "a" }, [], ["unselected"]]) {
    const result = composePhase(b, { ...native, comparisonEligibleApps }, { cleanupComplete: true, resources: "verified" }, [command]);
    assert.equal(result.outcome, "native-validated");
    assert.deepEqual(result.appOutcomes.map(({ comparisonEligible, ...row }) => row), native.outcomes);
    assert.ok(result.appOutcomes.every((row) => !row.comparisonEligible));
  }
});

test("catalog and JSON complete negative attempts retain passed peers without bypassing global timing or accepted audit gates", () => {
  for (const group of ["catalog-page", "json-api"]) {
    const b = { ...binding, request: { group }, latestStable: policy(group) }, n = { ...native,
      outcomes: native.outcomes.map((row) => ({ ...row, outcome: row.outcome === "unsupported" ? "passed" : row.outcome })), comparisonEligibleApps: [] };
    const host = { cleanupComplete: true, resources: "verified" };
    const result = composePhase(b, n, host, [command]);
    assert.equal(result.outcome, "native-validated");
    assert.deepEqual(result.appOutcomes.map(({ comparisonEligible, ...row }) => row), n.outcomes);
    assert.ok(result.appOutcomes.every((r) => !r.comparisonEligible));
    for (const [observation, audit] of [[host, false], [{ ...host, cleanupComplete: false }, true]])
      assert.notEqual(composePhase(b, n, observation, [command], audit).outcome, "native-validated");
    assert.notEqual(composePhase(b, n, host, [{ ...command, code: 0 }]).outcome, "native-validated");
  }
});

test("mixed comparisons require replayed timing eligibility as well as existing policy and apparatus gates", () => {
  const b = { ...binding, request: { group: "mixed-production" }, latestStable: policy("mixed-production") };
  const n = { ...native, status: "verified", outcomes: native.outcomes.map((row) => ({ ...row, outcome: "passed" })), comparisonEligibleApps: ["a", "c"] };
  const host = { cleanupComplete: true, resources: "verified" }, commands = [{ ...command, code: 0, success: true }];
  const result = composePhase(b, n, host, commands);
  assert.equal(result.outcome, "native-validated");
  assert.deepEqual(result.appOutcomes.map((row) => row.comparisonEligible), [true, false, true]);
  for (const [input, observation, audit] of [
    [{ ...b, latestStable: policy("mixed-production", "blocked") }, host, true],
    [b, { ...host, cleanupComplete: false }, true],
    [b, host, false],
  ]) assert.ok(composePhase(input, n, observation, commands, audit).appOutcomes.every((row) => !row.comparisonEligible));
  const failed = composePhase(b, { ...native, comparisonEligibleApps: binding.selection.apps }, host, [command]);
  assert.deepEqual(failed.appOutcomes.map((row) => row.comparisonEligible), [true, false, false]);
});
test("native flags, partial commands, missing OS proof, abort or invalid audit cannot promote a failed process", () => {
  for (const [n, h, c, audit] of [
    [{ ...native, status: "blocked" }, { cleanupComplete: true, resources: "verified" }, [command], true],
    [native, { cleanupComplete: false, resources: "verified" }, [command], true],
    [{ ...native, resources: "blocked" }, { cleanupComplete: true, resources: "blocked" }, [command], true],
    [{ ...native, resources: "invalid" }, { cleanupComplete: true, resources: "verified" }, [command], true],
    [native, { cleanupComplete: true, resources: "verified" }, [{ ...command, cancelled: true }], true],
    [native, { cleanupComplete: true, resources: "verified" }, [{ ...command, code: 99 }], true],
    [native, { cleanupComplete: true, resources: "verified" }, [command], false],
  ]) assert.notEqual(composePhase(binding, n, h, c, audit).outcome, "native-validated");
});
test("client's real diagnostic exit two is not fabricated failure or exit zero", () => {
  const b = { ...binding, request: { group: "client-heavy" }, latestStable: policy("client-heavy", "blocked") }, n = { ...native, status: "verified", outcomes: native.outcomes.map((r) => ({ ...r, outcome: "passed" })) };
  const host = { cleanupComplete: true, resources: "verified" };
  const observed = [{ ...command, code: 2 }];
  assert.equal(composePhase(b, n, host, observed).outcome, "native-validated");
  const probed = composePhase(b, n, host, observed, true, 1);
  assert.equal(probed.outcome, "blocked");
  assert.equal(probed.report.timingBlockedByPreLoginProbes, true);
  assert.ok(probed.appOutcomes.every(({ comparisonEligible }) => !comparisonEligible));
  assert.equal(composePhase(b, n, host, [{ ...command, code: 137 }], true, 1).outcome, "failed");
  assert.notEqual(composePhase(b, n, host, [{ ...command, code: 0, success: true }]).outcome, "native-validated");
});

test("latest-stable blockers preserve complete native outcomes but never qualify comparisons", () => {
  const b = { ...binding, request: { group: "client-heavy" }, latestStable: policy("client-heavy", "blocked") };
  const result = composePhase(b, native, { cleanupComplete: true, resources: "verified" }, [command]);
  assert.equal(result.outcome, "native-validated");
  assert.deepEqual(result.appOutcomes.map(({ comparisonEligible, ...row }) => row), native.outcomes);
  assert.ok(result.appOutcomes.every((row) => !row.comparisonEligible));
  assert.deepEqual(result.report.latestStable, b.latestStable);
  for (const latestStable of [undefined, null, { ...binding.latestStable, valid: false },
    { ...binding.latestStable, group: "json-api" }, { ...binding.latestStable, groupComparisonEligible: true },
    { ...binding.latestStable, schema: "untrusted" }, { ...binding.latestStable, status: "blocked" }]) {
    const invalid = composePhase({ ...binding, latestStable }, native, { cleanupComplete: true, resources: "verified" }, [command]);
    assert.ok(invalid.appOutcomes.every((row) => !row.comparisonEligible));
  }
});

test("client comparison preserves the historical unsupported Solid row and gates each other candidate", () => {
  const solid1Commit = "6f1bbf0553ec3b60c884bf5855fe8786ca25f1c2";
  const inputs = Object.fromEntries(Object.entries(latestStableSources).map(([key, path]) =>
    [key, execFileSync("git", ["show", `${solid1Commit}:${path}`], { cwd: new URL("../../../", import.meta.url) })]));
  const p = evaluateLatestStable({ group: "client-heavy", ...inputs }), apps = p.candidates.map((r) => r.app);
  assert.equal(p.valid, true, JSON.stringify(p.errors));
  const b = { ...binding, request: { group: "client-heavy" }, selection: { apps }, latestStable: p };
  const n = { ...native, outcomes: apps.map((app) => ({ app, outcome: app === "solid" ? "unsupported" : "passed" })), rankingEligible: false, comparisonEligibleApps: apps };
  const host = { cleanupComplete: true, resources: "verified" };
  const current = composePhase(b, n, host, [command]);
  assert.equal(current.outcome, "native-validated"); assert.equal(current.appOutcomes.length, 6);
  assert.ok(current.appOutcomes.every((r) => !r.comparisonEligible));
  const comparisonBinding = { ...b, request: { ...b.request, recipe: comparisonProfile } };
  const qualified = structuredClone(p), react = qualified.candidates.find((r) => r.app === "react");
  Object.assign(react, { status: "satisfied", latestStableEligible: true, blockers: [] });
  assert.equal(composePhase({ ...b, latestStable: qualified }, n, host, [command]).appOutcomes.find((r) => r.app === "react").comparisonEligible, false);
  const comparison = { samples: 3, actions: [{ operation: "unit", kind: "unit", minMs: 1, medianMs: 2, maxMs: 3 }] };
  const replicated = { ...n, rankingEligible: true, comparisonEligibleApps: ["react"], comparisons: { react: comparison } };
  const result = composePhase({ ...comparisonBinding, latestStable: qualified }, replicated, host, [command]);
  assert.deepEqual(result.appOutcomes.map((r) => r.comparisonEligible), [false, true, false, false, false, false]);
  assert.deepEqual(result.appOutcomes.find((r) => r.app === "react").comparison, comparison);
  assert.ok(composePhase(b, replicated, host, [command]).appOutcomes.every((r) => !r.comparisonEligible && !r.comparison));
  // Only comparison-eligible current rows are emitted. Native admission
  // still cannot waive a historical or other candidate freshness blocker.
  const allAdmitted = { ...replicated, comparisonEligibleApps: apps, comparisons: Object.fromEntries(apps.map((app) => [app, comparison])) };
  const fresh = composePhase(comparisonBinding, allAdmitted, host, [command]);
  assert.equal(fresh.appOutcomes.find((r) => r.app === "remix").comparisonEligible, true);
  assert.equal(fresh.appOutcomes.find((r) => r.app === "solid").comparison, undefined);
  const blocked = structuredClone(p);
  Object.assign(blocked.candidates.find((r) => r.app === "remix"), {
    status: "blocked", latestStableEligible: false, blockers: ["incompatible-dependency:node_modules/@remix-run/test:esbuild"],
  });
  const gated = composePhase({ ...comparisonBinding, latestStable: blocked }, allAdmitted, host, [command]);
  const remix = gated.appOutcomes.find((r) => r.app === "remix");
  assert.equal(remix.comparisonEligible, false);
  assert.equal(remix.comparison, undefined);
  assert.equal(gated.appOutcomes.find((r) => r.app === "react").comparisonEligible, true);
  for (const [policy, hostState, audit] of [
    [null, host, true], [undefined, host, true], [{ ...qualified, schema: latestStableSchema }, host, true],
    [{ ...qualified, group: "json-api" }, host, true], [{ ...qualified, valid: false }, host, true],
    [{ ...qualified, candidates: qualified.candidates.slice(1) }, host, true],
    [{ ...qualified, candidates: [...qualified.candidates, react] }, host, true],
    [qualified, { ...host, cleanupComplete: false }, true], [qualified, { ...host, resources: "blocked" }, true], [qualified, host, false],
  ]) assert.ok(composePhase({ ...comparisonBinding, latestStable: policy }, replicated, hostState, [command], audit)
    .appOutcomes.every((r) => !r.comparisonEligible && !r.comparison));
  assert.equal(qualified.schema, candidateLatestStableSchema);
  assert.equal(qualified.candidates.find((r) => r.app === "solid").reason, unsupportedSolidReason);
  for (const edit of [(r) => { r.outcome = "passed"; }, (r) => { r.measurement = {}; }]) {
    const bad = structuredClone(n); edit(bad.outcomes.find((r) => r.app === "solid"));
    assert.throws(() => composePhase(b, bad, host, [command]), /unsupported client/);
  }
});

test("current Solid policy permits comparison only behind the native, recipe and host gates", () => {
  const p = readLatestStable(), apps = selectedApps("client-heavy");
  assert.equal(p.status, "blocked");
  assert.equal(p.groupComparisonEligible, false);
  const row = p.candidates.find((r) => r.app === "solid");
  assert.equal(row.status, "satisfied");
  assert.equal(row.latestStableEligible, true);
  assert.deepEqual(row.blockers, []);
  assert.equal(row.measurements, null);
  const b = { ...binding, request: { group: "client-heavy", recipe: comparisonProfile }, selection: { apps }, latestStable: p };
  const comparison = { samples: 3, actions: [{ operation: "test-only", kind: "test-only", minMs: 1, medianMs: 2, maxMs: 3 }] };
  const n = { ...native, status: "verified", outcomes: apps.map((app) => ({ app, outcome: "passed" })),
    rankingEligible: true, comparisonEligibleApps: ["solid"], comparisons: { solid: comparison } };
  const host = { cleanupComplete: true, resources: "verified" }, commands = [{ ...command, code: 2 }];
  const run = ({ bind = b, replay = n, apparatus = host, exits = commands, audit = true, preLoginProbes = 0 } = {}) =>
    composePhase(bind, replay, apparatus, exits, audit, preLoginProbes);
  const result = run();
  assert.equal(result.outcome, "native-validated");
  assert.deepEqual(result.appOutcomes.filter((r) => r.comparisonEligible),
    [{ app: "solid", outcome: "passed", comparisonEligible: true, comparison }]);
  const blocked = structuredClone(p);
  blocked.candidates.find((r) => r.app === "solid").blockers.push("test-only");
  for (const failure of [
    { bind: { ...b, request: { group: "client-heavy" } } },
    { bind: { ...b, latestStable: blocked } },
    { replay: { ...n, attemptComplete: false } },
    { replay: { ...n, cleanupComplete: false } },
    { replay: { ...n, rankingEligible: false } },
    { replay: { ...n, comparisonEligibleApps: [] } },
    { replay: { ...n, comparisons: {} } },
    { replay: { ...n, outcomes: n.outcomes.map((r) => r.app === "solid" ? { ...r, outcome: "failed" } : r) } },
    { apparatus: { ...host, resources: "blocked" } },
    { apparatus: { ...host, cleanupComplete: false } },
    { exits: [command] },
    { audit: false },
    { preLoginProbes: 1 },
  ]) {
    const observed = run(failure).appOutcomes.find((r) => r.app === "solid");
    assert.equal(observed.comparisonEligible, false);
    assert.equal(observed.comparison, undefined);
  }
});
