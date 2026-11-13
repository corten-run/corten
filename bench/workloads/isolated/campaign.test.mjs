// Test module substitution is confined to this process. Production has no injected
// runners/validators/probes. Real filesystem sealing and real IPC supervision remain.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import * as evidence from "./evidence.mjs";
import * as contracts from "./campaign-contract.mjs";
import { groupNames } from "../registry.mjs";
import { fakeChild } from "./test-fixtures/process.mjs";
import * as audit from "./test-fixtures/campaign-audit.mjs";
import * as nativeReplay from "./native-replay.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = mkdtempSync(join(os.tmpdir(), "isolated-campaign-test-"));
let root, mode = "normal", expectedPlan, currentInvocation, calls = [], observations = 0, authorizations = [], release, abort, auditComplete = true, lifetimeFailure, replayLifetimeFailure;
const cpu = { app: { cpuset: "1", quota: 1 } };
mock.module("./evidence.mjs", { namedExports: { ...evidence,
  physical: (path, ...rest) => evidence.physical(path === "/bench/campaign" ? root : path, ...rest),
  inspectEvidence(binding, path) {
    evidence.tree(path); assert.ok(existsSync(join(path, "summary.json")));
    return { qualification: "blocked", rawCompleteness: "not-established" };
  },
} });
mock.module("./worker.mjs", { namedExports: {
  verifyWorkingSources(binding) { assert.deepEqual(binding, expectedPlan.bindings[0]); if (mode === "source-changed") throw new Error("working source differs"); },
  matchesWorkingSource: () => true,
} });
function jsonPhase(plan, phase, receiptPath) {
  if (receiptPath?.startsWith("/bench/campaign/")) receiptPath = join(root, ...receiptPath.split("/").slice(3));
  const b = structuredClone(plan.bindings.find((b) => b.request.group === "json-api"));
  b.request.round = phase === "prepare" ? "j34" : "j35";
  b.execution.invocation.argv = ["bench/json-api/run.mjs", b.request.round, "--group", "json-api",
    ...(phase === "prepare" ? ["--build", "--check-only"] : ["--receipts", receiptPath])];
  b.validation.artifactRoot = relative(repo, join(temporary, `native-${expectedPlan.round}`, `json-${phase}`)).replaceAll("\\", "/");
  return b;
}
mock.module("./campaign-contract.mjs", { namedExports: { ...contracts,
  validateCampaign(plan) { assert.deepEqual(plan, expectedPlan); }, jsonPhase,
  mixedPhase(plan, id) {
    const b = structuredClone(plan.bindings.find((b) => b.request.group === "mixed-production"));
    b.execution.invocation.argv.push("--native-audits", join(root, id, "mixed-native-audits.json")); return b;
  },
} });
mock.module("./mixed-staging.mjs", { exports: {
  prepareMixedAudit(plan, repo, directory) {
    const sourcesManifest = audit.snapshotSources(plan.bindings[0], repo, directory);
    const body = { schema: "synthetic-mixed-subject", campaignSha256: plan.campaignSha256, commit: plan.commit, sourcesManifest };
    return { ...body, subjectSha256: evidence.digest(JSON.stringify(body)) };
  },
  replayMixedSubject(plan, subject, repo, directory) {
    const { subjectSha256, ...body } = subject; assert.equal(subjectSha256, evidence.digest(JSON.stringify(body)));
    assert.equal(subject.commit, plan.commit); assert.deepEqual(subject.sourcesManifest.snapshot, evidence.tree(directory)); return subject;
  },
  validateMixedDelivery(delivery, subject) {
    assert.deepEqual(delivery, mixedDelivery(subject.subjectSha256)); return delivery;
  },
  validateMixedRun() { return mode === "complete"; },
} });
const host = () => ({ hostname: "test-host", bootId: "boot", containers: [], networks: ["bridge"], processes: [] });
mock.module("./host-observation.mjs", { namedExports: {
  observeHost() { observations++; const value = host(); if (mode === "leak" && observations > 2) value.containers = ["leak"]; return value; },
  verifyHostBoundary(before, after) { assert.deepEqual(after, before, "host cleanup uncertain"); return { cleanup: "observed-boundary-matched", isolation: "unverified" }; },
} });
mock.module("./host-lifetime.mjs", { exports: {
  beginLifetime({ directory, command }) {
    mkdirSync(directory); writeFileSync(join(directory, "raw.json"), "{}");
    return { attach() {}, finish(result) {
      const checks = { accounting: true, terminal: result.terminal, empty: true, observer: true,
        unforced: !result.cancelled && !result.forced, leader: true };
      if (lifetimeFailure?.command === command) Object.assign(checks, lifetimeFailure.checks);
      writeFileSync(join(directory, "terminal.json"), JSON.stringify(checks)); return evidence.tree(directory);
    } };
  },
  inspectLifetime(binding, invocation, directory, expected) {
    const checks = JSON.parse(readFileSync(join(directory, "terminal.json")));
    if (replayLifetimeFailure === expected.command) checks.accounting = false;
    const complete = Object.values(checks).every(Boolean);
    return { status: complete ? "verified" : "blocked", cleanupComplete: complete, checks,
      context: { bootId: "boot" }, manifestSha256: evidence.tree(directory).sha256 };
  },
  composeHostProof() { return { resources: mode === "complete" ? "verified" : "blocked", cleanupComplete: mode === "complete" }; },
} });
mock.module("./native-replay.mjs", { exports: { ...nativeReplay,
  async inspectNative(binding, native) {
    evidence.tree(native);
    if (mode === "complete") return { status: binding.request.group === "live-delivery" ? "failed" : "verified",
      attemptComplete: true, cleanupComplete: true, resources: "verified",
      outcomes: binding.selection.apps.map((app, i) => ({ app, outcome: binding.request.group === "live-delivery" && i === 1 ? "failed" : "passed" })), blockers: [] };
    return { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
      outcomes: binding.selection.apps.map((app) => ({ app, outcome: "not-run" })), blockers: [] };
  },
} });
mock.module("./json-staging.mjs", { namedExports: {
  ...audit,
  inspectPreparation: () => ({ summary: { actualBuilt: true }, report: { baseline: false } }),
  imageProof() { if (mode === "image-changed") throw new Error("built image changed"); return [{ imageId: "sha256:actual-mocked-image" }]; },
  validateTimingAudit(...args) {
    if (mode === "audit-mismatch") throw new Error("SYNTHETIC_PRIVATE_SENTINEL");
    if (mode === "complete") return { complete: auditComplete };
    return audit.validateTimingAudit(...args);
  },
} });
mock.method(os, "platform", () => "linux"); mock.method(os, "availableParallelism", () => 8);
mock.method(childProcess, "spawn", (binary, args, options) => {
  assert.equal(binary, process.execPath); assert.equal(options.shell, false);
  assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1"); assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
  const invocation = args.slice(1); calls.push(invocation); currentInvocation = invocation;
  assert.ok(!invocation[0].endsWith("report.mjs"), "never run a report against producer tree");
  return fakeChild((child) => {
    const native = !invocation[0].endsWith("fixtures.mjs");
    const finish = () => {
      if (native) {
        const group = expectedPlan.bindings.find((b) => b.execution.invocation.argv[0] === invocation[0]).request.group;
        const binding = group === "json-api" ? jsonPhase(expectedPlan, invocation.includes("--check-only") ? "prepare" : "timing", invocation.at(-1))
          : expectedPlan.bindings.find((b) => b.request.group === group);
        const output = join(repo, binding.validation.artifactRoot); mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "raw.log"), "all fake native bytes\n");
        if (mode === "unsafe") linkSync(join(output, "raw.log"), join(output, "summary.json"));
        else writeFileSync(join(output, "summary.json"), "{}");
      }
      if (mode === "abort-native" && native) abort.abort();
      const group = expectedPlan.bindings.find((b) => b.execution.invocation.argv[0] === invocation[0])?.request.group;
      child.close(invocation.includes("--check-only") ? 1 : mode === "process-fails" && native ? 9
        : mode === "complete" && group === "client-heavy" ? 2 : mode === "complete" && group === "live-delivery" ? 1 : 0);
    };
    if (mode === "pending") release = finish; else finish();
  });
});
const { createCampaign } = await import("./campaign.mjs");
const { validateCampaign: validateSavedCampaign } = await import("./campaign-verify.mjs");
let round = 100;
function setup(policy = () => true) {
  round++; mode = "normal"; calls = []; observations = 0; authorizations = []; auditComplete = true; lifetimeFailure = null; replayLifetimeFailure = null;
  root = join(temporary, `state-${round}`); mkdirSync(root, { mode: 0o700 });
  expectedPlan = { round: `r${round}`, commit: "a".repeat(40), campaignSha256: `plan-${round}`, order: [...groupNames],
    bindings: groupNames.map((group) => ({ request: { group, round: `test${round}`, commit: "a".repeat(40) }, selection: { apps: ["corten", "selected-failure"] },
      execution: { invocation: { executable: "node", argv: [`bench/${group === "catalog-page" ? "catalog" : group === "localized-marketplace" ? "marketplace" : group}/run.mjs`, `test${round}`] } },
      preparation: { fixtures: [{ executable: "node", argv: ["bench/catalog/fixtures.mjs"] }] }, resources: { requestedCpuEnv: {}, expectedCpus: cpu },
      validation: { artifactRoot: relative(repo, join(temporary, `native-r${round}`, group)).replaceAll("\\", "/") },
      coverage: { cells: [{ parity: "not-run", measurement: "not-run" }] }, status: { blockers: ["native gates unknown"] }, sources: { files: [audit.sourceFile] } })),
  };
  const campaign = createCampaign({ authorize(subject) { authorizations.push(subject); return policy(subject); } });
  return { campaign, plan: expectedPlan };
}
const begin = ({ campaign, plan }) => campaign.begin(plan, { stateRoot: "/bench/campaign" });
const delivery = (handle) => audit.auditDelivery(JSON.parse(readFileSync(join(handle.directory, "json-audit-subject.json"))).subjectSha256);
const mixedDelivery = (subjectSha256) => ({ schema: "benchmark-mixed-audit-delivery/v1", subjectSha256,
  review: { reviewer: "independent", reviewedAt: "2026-11-13T12:00:00Z", subjectSha256, findings: [], decision: "approved" },
  bundle: { schema: "mixed-native-source-audits/v1", receipts: [] } });
const submitPending = (campaign, handle, status) => status.auditGroup === "mixed-production"
  ? campaign.submitMixedAudit(handle, mixedDelivery(status.mixedAuditSubjectSha256)) : campaign.submitJsonAudit(handle, delivery(handle));

test("one root, opaque handle, all nine fixed native commands and retained failed outcome", async () => {
  const s = setup(), handle = await begin(s), { campaign } = s;
  assert.throws(() => campaign.status({ ...handle }), /not owned/);
  assert.throws(() => createCampaign({ authorize: () => true }).status(handle), /not owned/);
  await assert.rejects(begin(s), /EEXIST/);
  mode = "process-fails"; let status = await campaign.advance(handle);
  assert.equal(status.outcomes[0].outcome, "failed"); mode = "normal";
  status = await campaign.advance(handle); assert.equal(status.state, "blocked-review-needed");
  assert.ok(currentInvocation.includes("--build") && currentInvocation.includes("--check-only"));
  assert.throws(() => campaign.collect(handle), /not finished/);
  status = await campaign.submitJsonAudit(handle, delivery(handle)); assert.equal(status.state, "active");
  status = await campaign.advance(handle);
  assert.ok(!currentInvocation.includes("--build") && currentInvocation.includes("--receipts"), "timing must not rebuild");
  assert.equal(status.outcomes[1].outcome, "blocked", "blocked proof must not promote a zero process");
  while (["active", "blocked-review-needed"].includes(status.state)) status = status.state === "active"
    ? await campaign.advance(handle) : await submitPending(campaign, handle, status);
  assert.equal(status.state, "finished"); assert.deepEqual(status.outcomes.map((r) => r.group), groupNames);
  assert.equal(status.outcomes.filter((r) => r.outcome === "not-run").length, 0);
  assert.equal(calls.length, 20, "every group executes, plus the separate JSON preparation phase");
  const seals = evidence.tree(handle.directory).entries.filter((e) => /^\d{5}-phase-sealed\.json$/.test(e.path))
    .map((e) => JSON.parse(readFileSync(join(handle.directory, e.path))));
  assert.deepEqual(seals.map((e) => `${e.group}/${e.phase}`), groupNames.flatMap((g) => g === "json-api" ? ["json-api/prepare", "json-api/timing"] : [`${g}/timing`]));
  for (const seal of seals) {
    const index = groupNames.indexOf(seal.group), path = `${String(index).padStart(2, "0")}-${seal.group}-${seal.phase}`;
    assert.equal(seal.nativeManifestSha256, JSON.parse(readFileSync(join(handle.directory, path, "native-manifest.json"))).sha256);
  }
  assert.equal(status.controllerReady, false); assert.equal(campaign.collect(handle).deletionAuthorized, false);
  assert.equal(JSON.parse(readFileSync(join(handle.directory, "campaign-result.json"))).status.outcomes[0].outcome, "failed");
  // The API collection is sealed by the fixed entry, not by collect() itself.
  writeFileSync(join(handle.directory, "collection-manifest.json"), JSON.stringify(campaign.collect(handle)));
  const sealed = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(sealed.status, "failed", JSON.stringify(sealed)); assert.equal(sealed.collectionIntegrity, "manifest-verified");
  assert.equal(sealed.qualified, false); assert.equal(sealed.deletionAuthorized, false);
  assert.equal((await validateSavedCampaign({ folder: root, round: "r17/escape", commit: expectedPlan.commit })).status, "invalid");
  const count = calls.length; await assert.rejects(campaign.advance(handle), /not eligible/); assert.equal(calls.length, count);
  assert.ok(existsSync(join(root, ".host-attempt.json")), "reservation retained after finish");
  appendFileSync(join(handle.directory, "00-catalog-page-timing", "native", "raw.log"), "tamper");
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit })).status, "invalid");
});
test("overlapping advance and semantic retry are refused", async () => {
  const s = setup(), h = await begin(s); mode = "pending";
  const pending = s.campaign.advance(h);
  await assert.rejects(s.campaign.advance(h), /already in progress/);
  mode = "normal"; await new Promise((ok) => setImmediate(ok)); release(); await pending;
  assert.equal(calls.length, 2);
});

for (const [name, command, checks] of [
  ["fixture descendants remain", 0, { terminal: false, empty: false }],
  ["native descendants remain", 1, { terminal: false, empty: false }],
  ["fixture resource observation incomplete", 0, { accounting: false }],
]) test(`${name}: no later command or qualification can follow an unproven lifetime`, async () => {
  const s = setup(), h = await begin(s); mode = "complete"; lifetimeFailure = { command, checks };
  await assert.rejects(s.campaign.advance(h), /lifetime|cleanup/);
  assert.equal(calls.length, command + 1);
  const status = s.campaign.status(h); assert.equal(status.state, "preserved-uncertain");
  assert.equal(status.outcomes[0].outcome, "preserved-uncertain");
  assert.ok(status.outcomes.every((o) => o.outcome !== "native-validated"));
  assert.equal(status.uncollectedNativeRoots.length, 1);
  assert.equal(existsSync(join(h.directory, "00-catalog-page-timing", "native-manifest.json")), false);
  assert.equal(existsSync(join(repo, expectedPlan.bindings[0].validation.artifactRoot, "raw.log")), command === 1,
    "native originals remain retained when native execution occurred");
  const exits = evidence.tree(h.directory).entries.filter((e) => /^\d{5}-command-exited\.json$/.test(e.path))
    .map((e) => JSON.parse(readFileSync(join(h.directory, e.path))));
  assert.equal(exits.at(-1).success, true, "retain the actual leader exit, not a fabricated failure/terminal claim");
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.equal(saved.status, "blocked", JSON.stringify(saved)); assert.equal(saved.collectionIntegrity, "unsealed-partial");
  await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, command + 1);
});

test("mixed source review waits before any native spawn; only separate operator authorization stages the fixed bundle", async () => {
  const s = setup((subject) => subject.action !== "stage-mixed-audit"), h = await begin(s);
  let current = s.campaign.status(h);
  while (current.nextGroup !== "mixed-production") current = current.state === "active"
    ? await s.campaign.advance(h) : await submitPending(s.campaign, h, current);
  const count = calls.length; current = await s.campaign.advance(h);
  assert.equal(current.state, "blocked-review-needed"); assert.equal(current.auditGroup, "mixed-production"); assert.equal(calls.length, count);
  const d = mixedDelivery(current.mixedAuditSubjectSha256);
  await assert.rejects(s.campaign.submitMixedAudit(h, d), /did not authorize/);
  assert.equal(calls.length, count); assert.equal(s.campaign.status(h).state, "preserved-uncertain");
  assert.ok(existsSync(join(h.directory, "mixed-audit-delivery-retained.json")));
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.ok(["blocked", "failed"].includes(saved.status), JSON.stringify(saved));
});

for (const progress of ["intent", "started", "exited"]) test(`saved pending command ${progress} cannot advance past blocked fixture cleanup`, async () => {
  const s = setup(), h = await begin(s); mode = "complete";
  lifetimeFailure = { command: 0, checks: { terminal: false, empty: false } };
  await assert.rejects(s.campaign.advance(h), /lifetime|cleanup/);
  const input = { folder: root, round: expectedPlan.round, commit: expectedPlan.commit };
  assert.equal((await validateSavedCampaign(input)).status, "blocked", "a halted fixture alone remains an honest partial");
  const files = evidence.tree(h.directory).entries.filter((e) => /^\d{5}-[a-z-]+\.json$/.test(e.path));
  const rows = files.map((e) => JSON.parse(readFileSync(join(h.directory, e.path))));
  const fixtureExit = rows.find((e) => e.kind === "command-exited");
  const metadata = Object.fromEntries(["schema", "campaign", "round", "campaignSha256", "at", "status"]
    .map((key) => [key, structuredClone(fixtureExit[key])]));
  const additional = [{ ...metadata, kind: "command-intent", group: "catalog-page", invocation: expectedPlan.bindings[0].execution.invocation }];
  if (progress !== "intent") additional.push({ ...metadata, kind: "command-started", pid: 1234 });
  if (progress === "exited") additional.push({ ...metadata, kind: "command-exited", terminal: true, code: 0,
    signal: null, success: true, cancelled: false, forced: false, error: null });
  rows.splice(-1, 0, ...additional);
  for (const file of files) rmSync(join(h.directory, file.path));
  const saveRows = () => rows.forEach((row, sequence) => {
    row.sequence = sequence;
    writeFileSync(join(h.directory, `${String(sequence).padStart(5, "0")}-${row.kind}.json`), JSON.stringify(row));
  });
  saveRows(); writeFileSync(join(h.directory, "00-catalog-page-timing", "command-1.log"), "pending native command\n");
  const invalid = await validateSavedCampaign(input);
  assert.equal(invalid.status, "invalid", JSON.stringify(invalid));
  assert.equal(invalid.error, "saved-campaign-invalid");
  if (progress !== "exited") {
    const host = join(h.directory, "00-catalog-page-timing", "command-0-host");
    const terminalPath = join(host, "terminal.json"), checks = JSON.parse(readFileSync(terminalPath));
    checks.terminal = true; checks.empty = true; writeFileSync(terminalPath, JSON.stringify(checks));
    fixtureExit.hostManifestSha256 = evidence.tree(host).sha256; saveRows();
    const validPartial = await validateSavedCampaign(input);
    assert.equal(validPartial.status, "blocked", JSON.stringify(validPartial));
    assert.equal(validPartial.commandLifecycle, "incomplete-preserved");
    assert.equal(validPartial.collectionIntegrity, "unsealed-partial");
    assert.equal(validPartial.qualified, false); assert.equal(validPartial.deletionAuthorized, false);
  }
});

test("all-nine intrinsic completion is reachable without claiming every framework passed or external authority", async () => {
  const s = setup(), h = await begin(s); mode = "complete";
  let current = s.campaign.status(h);
  while (current.state === "active" || current.state === "blocked-review-needed") {
    current = current.state === "active" ? await s.campaign.advance(h) : await submitPending(s.campaign, h, current);
  }
  assert.equal(calls.length, 20); assert.ok(current.outcomes.every((r) => r.outcome === "native-validated"));
  writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(h)));
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.equal(saved.status, "verified", JSON.stringify(saved)); assert.equal(saved.scope, "intrinsic-evidence");
  assert.equal(saved.groups.length, 9); assert.equal(Object.hasOwn(saved, "qualified"), false);
  replayLifetimeFailure = 0;
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit })).status, "invalid",
    "a valid last command proof cannot excuse an unproven earlier fixture");
  replayLifetimeFailure = null;
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit })).status, "verified");
  const live = saved.groups.find((g) => g.group === "live-delivery");
  assert.deepEqual(live.appOutcomes[1], { app: "selected-failure", outcome: "failed", comparisonEligible: false });
  for (const target of ["00-catalog-page-timing/host-before.json", "00-catalog-page-timing/command-0-host/raw.json",
    "mixed-audit-subject.json", "mixed-audit-delivery-retained.json", "mixed-native-audits.json",
    `mixed-audit-sources/blobs/${audit.sourceFile.sha256}`]) {
    const path = join(h.directory, target), original = readFileSync(path); writeFileSync(path, '{"changed":true}');
    const entries = evidence.tree(h.directory).entries.filter((e) => e.path !== "collection-manifest.json");
    const collection = JSON.parse(readFileSync(join(h.directory, "collection-manifest.json")));
    collection.manifest = { entries, sha256: (await import("../deployments.mjs")).deploymentSha256(entries) };
    writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify(collection));
    const inspection = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
    assert.equal(inspection.status, "invalid", target);
    assert.ok(!JSON.stringify(inspection).includes('"changed"'));
    writeFileSync(path, original);
  }
});
test("a drained cancellation latches the public API even without the original signal", async () => {
  const s = setup(), h = await begin(s); abort = new AbortController(); mode = "abort-native";
  const status = await s.campaign.advance(h, { signal: abort.signal });
  assert.equal(status.state, "preserved-uncertain"); assert.equal(status.outcomes.length, 9);
  assert.equal(status.outcomes[0].outcome, "preserved-uncertain");
  assert.equal(status.outcomes.slice(1).every((r) => r.outcome === "not-run"), true);
  assert.equal(status.uncollectedNativeRoots.length, 0, "drained cancelled evidence is still collected");
  assert.equal(calls.length, 2); mode = "normal";
  await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, 2);
  assert.ok(existsSync(join(h.directory, "00-catalog-page-timing", "native", "raw.log")));
  const saved = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(saved.status, "failed"); assert.equal(saved.qualified, false);
});

test("incomplete timing audit stays blocked in live and saved composition despite complete native flags", async () => {
  const s = setup(); mode = "complete"; const h = await begin(s);
  await s.campaign.advance(h); await s.campaign.advance(h);
  await s.campaign.submitJsonAudit(h, delivery(h)); auditComplete = false;
  const status = await s.campaign.advance(h);
  assert.equal(status.outcomes[1].outcome, "blocked");
  assert.equal(status.outcomes[1].appOutcomes.every((r) => !r.comparisonEligible), true);
  s.campaign.stop(h);
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.equal(saved.status, "blocked"); assert.equal(saved.qualified, false);
});
for (const boundary of ["abort-native", "leak"]) test(`${boundary}: a halted collected phase cannot be replaced by rehashing adjacent manifests`, async () => {
  const s = setup(), h = await begin(s); mode = boundary; abort = new AbortController();
  if (boundary === "abort-native") await s.campaign.advance(h, { signal: abort.signal });
  else await assert.rejects(s.campaign.advance(h));
  const request = { folder: root, round: expectedPlan.round, commit: expectedPlan.commit };
  const original = (await validateSavedCampaign(request)); assert.ok(["failed", "blocked"].includes(original.status), JSON.stringify(original));
  const phase = join(h.directory, "00-catalog-page-timing"), native = join(phase, "native");
  appendFileSync(join(native, "raw.log"), "REPLACED NATIVE BYTES\n");
  writeFileSync(join(phase, "native-manifest.json"), JSON.stringify(evidence.tree(native)));
  const status = JSON.parse(readFileSync(join(h.directory, "campaign-result.json"))).status;
  writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify({ status, manifest: evidence.tree(h.directory) }));
  assert.equal((await validateSavedCampaign(request)).status, "invalid");
});
for (const bad of ["unsafe", "leak", "source-changed"]) test(`${bad} halts with all group outcomes and no further execution`, async () => {
  const s = setup(), h = await begin(s); mode = bad;
  await assert.rejects(s.campaign.advance(h));
  const status = s.campaign.status(h); assert.equal(status.state, "preserved-uncertain"); assert.equal(status.outcomes.length, 9);
  assert.equal(status.outcomes[0].outcome, bad === "source-changed" ? "not-run" : "preserved-uncertain");
  if (bad === "unsafe") assert.equal(status.uncollectedNativeRoots.length, 1, "unsafe original requires host retention");
  if (bad === "leak") {
    assert.equal(status.uncollectedNativeRoots.length, 0);
    assert.ok(existsSync(join(h.directory, "00-catalog-page-timing", "native", "raw.log")), "cleanup failure still seals terminal producer evidence");
  }
  const count = calls.length; await assert.rejects(s.campaign.advance(h)); assert.equal(calls.length, count);
  assert.ok(existsSync(join(h.directory, "campaign-result.json")));
});
test("audit authority is separate; receipt approval cannot authorize itself", async () => {
  const s = setup((subject) => subject.action === "begin-campaign"), h = await begin(s);
  await s.campaign.advance(h); await s.campaign.advance(h);
  await assert.rejects(s.campaign.submitJsonAudit(h, delivery(h)), /did not authorize/);
  assert.equal(s.campaign.status(h).state, "preserved-uncertain"); assert.equal(calls.length, 4);
  assert.ok(existsSync(join(h.directory, "json-audit-delivery-retained.json")));
  const saved = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(saved.status, "blocked", JSON.stringify(saved)); assert.equal(saved.qualified, false);
});
test("audit wait mutation and image replacement halt before timing", async () => {
  for (const bad of ["image-changed", "mutated-copy"]) {
    const s = setup(), h = await begin(s); await s.campaign.advance(h); await s.campaign.advance(h);
    if (bad === "image-changed") mode = bad;
    else appendFileSync(join(h.directory, "01-json-api-prepare", "native", "raw.log"), "mutation");
    await assert.rejects(s.campaign.submitJsonAudit(h, delivery(h))); assert.equal(calls.length, 4);
  }
});
test("a timing audit mismatch halts after sealed collection without leaking native diagnostics", async () => {
  const s = setup(), h = await begin(s); await s.campaign.advance(h); await s.campaign.advance(h);
  await s.campaign.submitJsonAudit(h, delivery(h)); mode = "audit-mismatch";
  await assert.rejects(s.campaign.advance(h), { message: "timing-audit-does-not-match-accepted-subject" });
  const status = s.campaign.status(h); assert.equal(status.state, "preserved-uncertain"); assert.equal(calls.length, 6);
  assert.deepEqual(status.uncollectedNativeRoots, []);
  assert.ok(!JSON.stringify(status).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  assert.ok(evidence.tree(h.directory).entries.some((e) => e.path.endsWith("-phase-sealed.json")
    && JSON.parse(readFileSync(join(h.directory, e.path))).phase === "timing"
    && JSON.parse(readFileSync(join(h.directory, e.path))).group === "json-api"));
});
test("cancellation while awaiting review retains all groups, no new timing or unlock", async () => {
  const s = setup(), h = await begin(s); await s.campaign.advance(h); await s.campaign.advance(h);
  const status = s.campaign.stop(h, "operator cancelled audit wait");
  assert.equal(status.state, "preserved-uncertain"); assert.equal(status.outcomes[1].outcome, "preserved-uncertain");
  assert.equal(status.outcomes.length, 9); assert.equal(calls.length, 4);
  const saved = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(saved.status, "blocked", JSON.stringify(saved)); assert.equal(saved.collectionIntegrity, "unsealed-partial");
  assert.equal(saved.qualified, false); assert.equal(saved.deletionAuthorized, false);
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: "b".repeat(40) })).status, "invalid");
});
test.after(() => {
  assert.ok(evidence.inside(resolve(os.tmpdir()), resolve(temporary))); rmSync(temporary, { recursive: true, force: true });
});
