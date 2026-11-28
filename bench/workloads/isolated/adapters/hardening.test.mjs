import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assessBoundedRequests } from "../../../hardening/bounded-requests.mjs";
import * as plan from "../../../hardening/plan.mjs";
import { assessRecovery, recoveryProfile, recoverySchedule } from "../../../hardening/dependency-recovery-contract.mjs";
import { selectedApps } from "../../registry.mjs";

// Composition/apparatus fixtures only. Native raw receipt replay is mocked,
// not replaced in production and not claimed as benchmark qualification.
const root = mkdtempSync(join(tmpdir(), "hardening-adapter-")), commit = "a".repeat(40), subject = "b".repeat(64);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const { budgets, parseArgs, registryDigest } = plan;
const phase = "dependency-recovery";
const boundedRequestsVersion = "bounded-requests/v1";
const apps = selectedApps("hardening"), budget = budgets();
const fixtureMatrix = apps.flatMap((app) => ["fixture", "api"].flatMap((source) =>
  ["direct", "deployed-edge"].flatMap((mode) => ["request-timeout", "request-limit", phase].map((phase) =>
    ({ key: `${app}/${source}/${mode}/${phase}`, app, source, mode, phase })))));
const restoredAtMs = recoveryProfile.beforeMs + recoveryProfile.duringMs;
const recoveryLedger = (source, healthy = () => true, schedule = recoverySchedule) => ({
  type: phase, restoredAtMs: source === "api" ? restoredAtMs : null,
  samples: schedule.map((scheduledMs) => ({ scheduledMs, startMs: scheduledMs, endMs: scheduledMs + 10, ok: healthy(scheduledMs) })),
});
const replayAssessment = (source, { samples, restoredAtMs }) => assessRecovery(samples, { source, restoredAtMs });
const boundedAssessment = (c) => ({ version: boundedRequestsVersion, source: c.source, phase: c.phase, completeAtMs: 200,
  healthy: true, status: c.phase === "request-limit" ? "rejected" : c.source === "api" ? "client-deadline" : "fixture-control" });
const options = parseArgs(["w17", "--build", "--review", subject]);
const files = ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "bench/hardening/plan.mjs",
  "bench/hardening/evidence.mjs", "bench/hardening/qualification.mjs", "bench/hardening/run.mjs", "bench/hardening/verify.mjs",
  "bench/hardening/bounded-requests-probe.mjs", "bench/hardening/bounded-requests.mjs", "bench/hardening/request-capture.mjs",
  "bench/hardening/dependency-recovery-probe.mjs", "bench/hardening/dependency-recovery-upstream.mjs",
  "bench/hardening/dependency-recovery-contract.mjs", "bench/marketplace/upstream.mjs",
  ...apps.map((a) => a === "corten" ? "bench/marketplace/corten/Dockerfile" : `bench/fullstack/apps/${a}/Dockerfile`)]
  .map((path) => ({ path, sha256: hash(path) }));
const originalBinding = { request: { group: "hardening", round: "w17", commit, recipe: "native-defaults" }, subjectSha256: subject,
  selection: { group: "hardening", apps, contractSha256: registryDigest }, sources: { commit, files },
  execution: { invocation: { executable: "node", argv: ["bench/hardening/run.mjs", "w17", "--build", "--review", subject], cwd: "repository-root", shell: false },
    effectiveOptions: options, settings: budget }, resources: { budget: budget.resources }, review: { state: "unknown" } };
const summaryBase = { schema: "native-hardening-run/v3", registryDigest, commit, options, budget, boundedRequestsVersion,
  savedProofVersion: 2, lifecycleVersion: 4, nativeControlsVersion: 1, deploymentQualificationVersion: 2,
  complete: true, groupReady: true, failures: [], cleanupFailures: [],
  finishedAt: "2026-11-13T12:00:00Z", tools: Object.fromEntries(["node", "checker", "edge", "cert"].map((k) => [k, { Id: `sha256:${hash(k)}` }])),
  cells: fixtureMatrix.map((c) => ({ ...c, status: "observed",
    ...(c.phase === phase ? { dependencyRecovery: replayAssessment(c.source, recoveryLedger(c.source)), dependencyTerminalHealthy: true }
      : { boundedRequests: boundedAssessment(c), boundedTerminalHealthy: true }) })) };
const recoveryCells = summaryBase.cells.filter((c) => c.phase === phase);
const recoveryBase = recoveryCells.map(({ key, dependencyRecovery: assessment }) => ({ key, assessment, terminalHealthy: true, terminalDisposition: "recovered" }));
const boundedBase = summaryBase.cells.filter((c) => c.phase !== phase)
  .map(({ key, boundedRequests: assessment }) => ({ key, assessment, terminalHealthy: true, terminalDisposition: "recovered" }));
const recoveryKey = recoveryBase[0].key;
const write = (p, v) => { const path = join(root, p); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v)); };
write("summary.json", summaryBase);
for (const { key, mode, source, dependencyRecovery: assessment } of recoveryCells) {
  write(`${key}/capture.json`, { schema: "native-dependency-recovery-capture/v1", case: mode, phase, assessment,
    terminal: { healthy: true, disposition: "recovered" } });
  write(`${key}/raw.jsonl`, recoveryLedger(source));
}
for (const c of summaryBase.cells) {
  if (c.phase !== phase) {
    write(`${c.key}/capture.json`, { schema: "native-bounded-requests-capture/v1", case: c.mode, phase: c.phase,
      assessment: c.boundedRequests, terminal: { healthy: true, disposition: "recovered" } });
    write(`${c.key}/raw.jsonl`, { type: "bounded-requests", version: boundedRequestsVersion });
  }
  const roles = ["application", "upstream", ...(c.mode === "deployed-edge" ? ["proxy"] : [])];
  const processes = roles.map((role) => ({ id: role, role, count: 2, containerId: hash(c.key + role) }));
  write(`${c.key}/settings.json`, { case: c.mode, phase: c.phase, nativeSource: c.source, review: subject, effectiveBudgets: JSON.stringify(budget),
    deployment: { mode: c.mode, countAllProcesses: true, processes: processes.map(({ containerId, ...p }) => p) } });
  write(`${c.key}/deployment.json`, { processes, network: { Containers: Object.fromEntries(processes.map((p) => [p.containerId, {}])) }, totalBudget: budget.resources });
  for (const p of processes) {
    const b = budget.resources[p.role === "application" ? c.mode === "direct" ? "applicationDirect" : "applicationEdge" : p.role];
    const src = files.filter((f) => c.app === "corten" ? f.path.startsWith("bench/marketplace/corten/") || ["Cargo.toml", "Cargo.lock"].includes(f.path)
      : f.path.startsWith(`bench/fullstack/apps/${c.app}/`)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const info = { Id: p.containerId, Image: p.role === "application" ? `sha256:${hash(c.app)}` : summaryBase.tools[p.role === "upstream" ? "node" : "edge"].Id,
      HostConfig: { NanoCpus: b.cpu * 1e9, Memory: b.memory, MemorySwap: b.memory }, Config: { Labels: {
        "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false", "run.corten.hardening.source": hash(JSON.stringify(src.map((f) => [f.path, f.sha256]))) } } };
    write(`${c.key}/${p.id}-before.json`, { info, top: "PID PPID COMMAND\n1 0 native\n2 1 worker\n" });
    write(`${c.key}/${p.id}-lifecycle.json`, { before: info, after: structuredClone(info) });
  }
  write(`${c.key}/cleanup.json`, { complete: true, containers: [], volumes: [], commandClients: 0, failures: [] });
}
let binding, summary, action, proof, dependencyRecovery, boundedRequests, qualifications, plannedMatrix;
const modified = new Map();
const change = (p, fn) => {
  if (!modified.has(p)) modified.set(p, readFileSync(join(root, p)));
  const v = JSON.parse(readFileSync(join(root, p))); fn(v); write(p, v);
};
const native = mock.fn((folder) => {
  assert.equal(folder, root); action?.();
  return { schema: summary.schema, observed: summary.cells.filter((c) => c.status === "observed").length,
    groupReady: summary.groupReady, notRun: summary.cells.filter((c) => c.status === "not-run").length,
    proof, dependencyRecovery, boundedRequests, qualifications };
});
mock.module(new URL("../../../hardening/plan.mjs", import.meta.url), { exports: { ...plan, matrix: () => plannedMatrix } });
mock.module(new URL("../../../hardening/verify.mjs", import.meta.url), { exports: { verify: native } });
const { inspectSaved } = await import("./hardening.mjs");
beforeEach(() => {
  for (const [p, b] of modified) writeFileSync(join(root, p), b); modified.clear();
  binding = structuredClone(originalBinding); summary = structuredClone(summaryBase); action = null; native.mock.resetCalls(); write("summary.json", summary);
  plannedMatrix = fixtureMatrix; dependencyRecovery = structuredClone(recoveryBase); boundedRequests = structuredClone(boundedBase);
  qualifications = fixtureMatrix.map(({ key }) => ({ key, productionQualified: true }));
  proof = { schema: "native-hardening-saved-proof/v1", resources: "verified", sources: "verified", sourceFiles: structuredClone(files), cleanupComplete: true, blockers: [] };
});
after(() => { mock.restoreAll(); rmSync(root, { recursive: true, force: true }); });
const inspect = () => { write("summary.json", summary); return inspectSaved(binding, root); };

test("complete native composition has an intrinsic verified path without review approval", async () => {
  assert.deepEqual(await inspect(), { status: "verified", attemptComplete: true, cleanupComplete: true, resources: "verified",
    outcomes: apps.map((app) => ({ app, outcome: "passed" })), comparisonEligibleApps: [], blockers: [] });
  assert.equal(native.mock.callCount(), 1);
});

test("isolated hardening cannot reuse a historical verified resource proof without CPU roles", async () => {
  binding.execution.invocation.argv.push("--isolated");
  binding.execution.effectiveOptions.isolated = summary.options.isolated = true;
  binding.resources.actorCpus = { application: "1", upstream: "2", proxy: "3", apparatus: "4-5", command: "6-7" };
  const path = "bench/hardening/cpu-gate.mjs", input = { path, sha256: hash(path) };
  binding.sources.files.push(input);
  proof.sourceFiles.push(input);
  const result = await inspect();
  assert.equal(result.status, "blocked");
  assert.equal(result.resources, "blocked");
  assert.ok(result.blockers.includes("hardening-effective-cpu-role-proof-missing"));
  assert.ok(result.outcomes.every((r) => r.outcome === "passed"), "historical outcomes are not relabelled");
  native.mock.resetCalls();
  delete summary.options.isolated;
  assert.equal((await inspect()).status, "invalid", "official isolation cannot be downgraded to standalone");
  assert.equal(native.mock.callCount(), 0);
});

test("dependency recovery is verified from matching saved and replayed assessments, with no numeric comparison", async () => {
  const result = await inspect();
  assert.equal(result.status, "verified");
  assert.equal(result.attemptComplete, true);
  assert.ok(result.outcomes.every((r) => r.outcome === "passed"));
  assert.deepEqual(result.comparisonEligibleApps, []);
});

for (const mode of ["direct", "deployed-edge"]) test(`dependency recovery preserves replayed ${mode} qualification`, async () => {
  const cell = summary.cells.find((c) => c.phase === phase && c.mode === mode);
  cell.nativeAssessment = { productionQualified: true };
  qualifications.find((row) => row.key === cell.key).productionQualified = false;
  const result = await inspect();
  assert.equal(result.status, "verified"); assert.equal(result.attemptComplete, true);
  assert.deepEqual(result.outcomes.find((r) => r.app === cell.app), { app: cell.app, outcome: "unsupported" });
  assert.deepEqual(result.comparisonEligibleApps, []);
});

function setNonObserved(cell, status) {
  cell.status = status; summary.groupReady = false;
  if (status === "not-run") summary.complete = false;
  dependencyRecovery = dependencyRecovery.filter((row) => row.key !== cell.key);
  boundedRequests = boundedRequests.filter((row) => row.key !== cell.key);
  qualifications = qualifications.filter((row) => row.key !== cell.key);
}

test("an invalid cell cannot be made a target failure by a summary label", async () => {
  const cell = summary.cells.find((c) => c.key === recoveryKey);
  setNonObserved(cell, "invalid"); cell.failureKind = "target-functional-failure";
  const result = await inspect();
  assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome: "not-run" });
  assert.deepEqual(result.comparisonEligibleApps, []);
});

test("a launch-bound preflight failure fails the app without completing timing", async () => {
  const cell = summary.cells[0]; setNonObserved(cell, "invalid");
  cell.failedStage = "native-controls"; cell.failureKind = "target-functional-failure";
  proof.failedControls = [{ key: cell.key, stage: cell.failedStage }];
  const result = await inspect();
  assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome: "failed" });
  proof.sources = "blocked";
  assert.equal((await inspect()).status, "invalid");
});

for (const version of [1, 2]) test(`native aggregate v${version} cannot qualify as v3`, async () => {
  summary.schema = `native-hardening-run/v${version}`;
  const historical = await inspect();
  assert.equal(historical.status, "blocked"); assert.equal(historical.attemptComplete, false);
  assert.deepEqual(historical.comparisonEligibleApps, []);
  assert.ok(historical.blockers.includes("hardening-bounded-v3-required"));
  assert.equal(native.mock.callCount(), 0);
});

test("native plan itself must expose exactly the official v3 matrix", async () => {
  assert.equal(plan.schema, "native-hardening-run/v3");
  assert.deepEqual(plan.matrix().map(({ status, ...cell }) => cell), fixtureMatrix);
  plannedMatrix = fixtureMatrix.filter((c) => c.phase !== phase);
  const result = await inspect();
  assert.equal(result.status, "invalid"); assert.equal(result.attemptComplete, false);
  assert.equal(native.mock.callCount(), 0);
});

for (const [name, remove] of [
  ["replay", () => dependencyRecovery = undefined],
  ["coverage", () => dependencyRecovery.shift()],
  ["summary assessment", () => delete summary.cells.find((c) => c.key === recoveryKey).dependencyRecovery],
  ["persisted assessment", () => change(`${recoveryKey}/capture.json`, (v) => delete v.assessment)],
  ["replayed terminal flag", () => delete dependencyRecovery[0].terminalHealthy],
  ["summary terminal flag", () => delete summary.cells.find((c) => c.key === recoveryKey).dependencyTerminalHealthy],
  ["persisted terminal flag", () => change(`${recoveryKey}/capture.json`, (v) => delete v.terminal.healthy)],
  ["replayed terminal disposition", () => delete dependencyRecovery[0].terminalDisposition],
  ["persisted terminal disposition", () => change(`${recoveryKey}/capture.json`, (v) => delete v.terminal.disposition)],
]) test(`dependency recovery missing ${name} is blocked, not success or target failure`, async () => {
  remove();
  const result = await inspect();
  assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.deepEqual(result.comparisonEligibleApps, []);
  assert.equal(result.outcomes[0].outcome, "not-run");
  assert.ok(result.blockers.includes("hardening-dependency-recovery-proof-missing"));
});

for (const file of ["capture.json", "raw.jsonl"]) test(`dependency recovery missing ${file} cannot be supplied by the replay result`, async () => {
  const path = join(root, recoveryKey, file), original = readFileSync(path);
  rmSync(path);
  try {
    const result = await inspect();
    assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
    assert.deepEqual(result.comparisonEligibleApps, []);
  } finally { writeFileSync(path, original); }
});

test("dependency recovery capture and summary agreeing is insufficient if ledger replay disagrees", async () => {
  const cell = summary.cells.find((c) => c.key === recoveryKey);
  const assessment = replayAssessment(cell.source, recoveryLedger(cell.source, (ms) => ms < restoredAtMs));
  cell.dependencyRecovery = assessment;
  change(`${recoveryKey}/capture.json`, (v) => v.assessment = assessment);
  const result = await inspect();
  assert.equal(result.status, "invalid"); assert.deepEqual(result.comparisonEligibleApps, []);
});

function saveRecovery(cell, ledger) {
  const assessment = replayAssessment(cell.source, ledger);
  cell.dependencyRecovery = assessment;
  dependencyRecovery.find((row) => row.key === cell.key).assessment = assessment;
  change(`${cell.key}/capture.json`, (v) => v.assessment = assessment);
  change(`${cell.key}/raw.jsonl`, (v) => Object.assign(v, ledger));
}

for (const [name, source, ledger, status, outcome] of [
  ["unrecovered", "api", recoveryLedger("api", (ms) => ms < restoredAtMs), "failed", "failed"],
  ["degraded fixture control", "fixture", recoveryLedger("fixture", (ms) => ms < restoredAtMs), "failed", "failed"],
  ["incomplete", "api", recoveryLedger("api", undefined, recoverySchedule.slice(1)), "blocked", "not-run"],
  ["fully observed failed baseline", "fixture", recoveryLedger("fixture", (ms) => ms > 0), "failed", "failed"],
  ["invalid", "api", recoveryLedger("api", undefined, [1]), "invalid", "not-run"],
]) test(`dependency recovery distinguishes ${name}`, async () => {
  const cell = summary.cells.find((c) => c.phase === phase && c.source === source);
  saveRecovery(cell, ledger);
  summary.groupReady = false;
  const result = await inspect();
  assert.equal(result.status, status);
  assert.equal(result.attemptComplete, status === "failed");
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome });
  assert.deepEqual(result.comparisonEligibleApps, []);
});

test("dependency recovery failed baseline requires verified source proof", async () => {
  const cell = summary.cells.find((c) => c.key === recoveryKey);
  saveRecovery(cell, recoveryLedger(cell.source, (ms) => ms > 0));
  summary.groupReady = false; proof.sources = "blocked";
  const result = await inspect();
  assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome: "not-run" });
});

for (const corroborated of [true, false]) test(`dependency recovery terminal unhealthy is ${corroborated ? "a target failure" : "invalid if contradicted"}`, async () => {
  const cell = summary.cells.find((c) => c.phase === phase && c.source === "api");
  assert.equal(cell.dependencyRecovery.status, "recovered");
  Object.assign(dependencyRecovery.find((row) => row.key === cell.key), { terminalHealthy: false, terminalDisposition: "not-recovered" });
  if (corroborated) {
    cell.dependencyTerminalHealthy = false;
    change(`${cell.key}/capture.json`, (v) => { v.terminal = { healthy: false, disposition: "not-recovered" }; });
  }
  const result = await inspect();
  assert.equal(result.status, corroborated ? "failed" : "invalid");
  assert.equal(result.attemptComplete, corroborated);
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome: corroborated ? "failed" : "not-run" });
  assert.deepEqual(result.comparisonEligibleApps, []);
});

function saveBounded(cell, status = "target-failure", terminalDisposition = "recovered") {
  const terminalHealthy = terminalDisposition === "recovered";
  const assessment = { ...cell.boundedRequests, status, healthy: status !== "target-failure" };
  cell.boundedRequests = assessment; cell.boundedTerminalHealthy = terminalHealthy;
  Object.assign(boundedRequests.find((row) => row.key === cell.key), { assessment, terminalHealthy, terminalDisposition });
  change(`${cell.key}/capture.json`, (v) => { v.assessment = assessment; v.terminal = { healthy: terminalHealthy, disposition: terminalDisposition }; });
}

for (const probe of ["request-timeout", "request-limit", phase]) test(`${probe} distinguishes absent liveness from a measured target failure`, async () => {
  const cell = summary.cells.find((c) => c.phase === probe && c.source === "api" && c.mode === "deployed-edge");
  const recovery = probe === phase;
  const row = (recovery ? dependencyRecovery : boundedRequests).find((row) => row.key === cell.key);
  row.terminalHealthy = false;
  row.terminalDisposition = "missing-liveness";
  cell[recovery ? "dependencyTerminalHealthy" : "boundedTerminalHealthy"] = false;
  change(`${cell.key}/capture.json`, (v) => { v.terminal = { healthy: false, disposition: row.terminalDisposition }; });
  qualifications.find((row) => row.key === cell.key).productionQualified = false;
  const unsupported = await inspect();
  assert.equal(unsupported.status, "verified");
  assert.equal(unsupported.attemptComplete, true);
  assert.deepEqual(unsupported.outcomes[0], { app: cell.app, outcome: "unsupported" });

  if (recovery) saveRecovery(cell, recoveryLedger(cell.source, (ms) => ms < restoredAtMs));
  else saveBounded(cell, "target-failure", "missing-liveness");
  const failed = await inspect();
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.outcomes[0], { app: cell.app, outcome: "failed" });
});

test("a boundary accepted within the bounded profile is an observation, not a target failure", async () => {
  const cell = summary.cells.find((c) => c.phase === "request-limit");
  saveBounded(cell, "accepted");
  const r = await inspect();
  assert.equal(r.status, "verified"); assert.equal(r.outcomes[0].outcome, "passed");
});

test("a bounded observation with failed terminal health stays a measured target failure", async () => {
  const cell = summary.cells.find((c) => c.phase === "request-timeout" && c.source === "api");
  saveBounded(cell, "client-deadline", "not-recovered");
  const r = await inspect();
  assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true);
  assert.deepEqual(r.outcomes[0], { app: cell.app, outcome: "failed" });
});

test("saved missing liveness cannot override a replayed terminal failure with the same health flag", async () => {
  const cell = summary.cells.find((c) => c.phase === "request-limit");
  saveBounded(cell, "rejected", "not-recovered");
  change(`${cell.key}/capture.json`, (v) => v.terminal.disposition = "missing-liveness");
  const result = await inspect();
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome: "not-run" });
});

test("a matched bounded capture and summary cannot override the replayed outcome", async () => {
  const cell = summary.cells[0];
  cell.boundedRequests = { ...cell.boundedRequests, status: "target-failure", healthy: false };
  change(`${cell.key}/capture.json`, (v) => v.assessment = cell.boundedRequests);
  const r = await inspect();
  assert.equal(r.status, "invalid"); assert.equal(r.outcomes[0].outcome, "not-run");
});

test("a timeout replay cannot borrow another source's success disposition", async () => {
  saveBounded(summary.cells[0], "client-deadline");
  const r = await inspect();
  assert.equal(r.status, "invalid"); assert.equal(r.outcomes[0].outcome, "not-run");
});

test("a duplicate bounded replay entry is a contradiction", async () => {
  boundedRequests.push(boundedRequests[0]);
  const r = await inspect();
  assert.equal(r.status, "invalid"); assert.equal(r.attemptComplete, false);
});

test("a legacy raw receipt rejected by the verifier cannot be rescued by a v3 summary", async () => {
  const cell = summary.cells[0];
  change(`${cell.key}/raw.jsonl`, (v) => v.type = "legacy-row");
  action = () => assessBoundedRequests({
    phase: cell.phase, source: cell.source, expected: { id: "item_1" },
    targetOrigin: "http://localhost:8080", upstreamOrigin: "http://hardening-012345abcdef-cell-upstream:8080",
    raw: [{ type: "clock", bootId: "00000000-0000-0000-0000-000000000000", monotonicNs: "1", wallAtStart: summary.finishedAt },
      JSON.parse(readFileSync(join(root, cell.key, "raw.jsonl")))],
  });
  assert.throws(action, /invalid bounded observation fields/);
  const r = await inspect();
  assert.equal(native.mock.callCount(), 1); assert.equal(r.status, "invalid"); assert.equal(r.attemptComplete, false);
});

for (const [name, remove, blocker] of [
  ["bounded result", () => boundedRequests.shift(), "hardening-bounded-requests-proof-missing"],
  ["qualification", () => qualifications.shift(), "hardening-native-qualification-proof-missing"],
]) test(`missing replayed ${name} blocks even when the other receipts agree`, async () => {
  remove();
  const r = await inspect();
  assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false);
  assert.equal(r.outcomes[0].outcome, "not-run"); assert.ok(r.blockers.includes(blocker));
});

test("deployment default OOM representation changes do not discard complete target failures", async () => {
  const cell = summary.cells[0]; saveBounded(cell); summary.groupReady = false;
  change(`${cell.key}/application-before.json`, (v) => v.info.HostConfig.OomKillDisable = false);
  change(`${cell.key}/application-lifecycle.json`, (v) => {
    v.before.HostConfig.OomKillDisable = false; v.after.HostConfig.OomKillDisable = null;
  });
  const result = await inspect();
  assert.equal(result.status, "failed"); assert.equal(result.attemptComplete, true);
  assert.equal(result.resources, "verified"); assert.equal(result.cleanupComplete, true);
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome: "failed" });
});

for (const [name, mutate] of [
  ["group", (b) => b.request.group = "mixed-production"], ["round", (b) => b.request.round = "w18"],
  ["commit", (b) => b.request.commit = "c".repeat(40)], ["selected apps", (b) => b.selection.apps.pop()],
  ["filter", (b) => b.execution.effectiveOptions.verify.app = "express"], ["settings", (b) => b.execution.settings.resources.upstream.cpu++],
  ["profile", (b) => b.execution.effectiveOptions.profile = "sustained"],
  ["command", (b) => b.execution.invocation.argv.push("--verify-app", "express")],
  ["v3 source", (b) => b.sources.files = b.sources.files.filter((f) => f.path !== "bench/hardening/bounded-requests-probe.mjs")],
]) test(`rejects binding ${name} drift`, async () => { mutate(binding); assert.equal((await inspect()).status, "invalid"); assert.equal(native.mock.callCount(), 0); });

for (const [name, mutate] of [
  ["round", (s) => s.options.round = "w18"], ["commit", (s) => s.commit = "c".repeat(40)],
  ["dropped matrix", (s) => s.cells.pop()], ["source relabel", (s) => s.cells[0].source = "api"],
  ["edge relabel", (s) => s.cells[0].mode = "deployed-edge"], ["budget", (s) => s.budget.resources.upstream.cpu++],
  ["historical phase", (s) => { s.cells[0].phase = "slow-headers"; s.cells[0].key = s.cells[0].key.replace(/[^/]+$/, "slow-headers"); }],
  ["reordered phases", (s) => [s.cells[0], s.cells[1]] = [s.cells[1], s.cells[0]]],
]) test(`rejects saved ${name} drift`, async () => {
  mutate(summary); assert.equal((await inspect()).status, "invalid"); assert.equal(native.mock.callCount(), 0);
});

for (const [field, version] of [["boundedRequestsVersion", "bounded-requests/v0"], ["semanticReceiptsVersion", 2],
  ["savedProofVersion", 1], ["lifecycleVersion", 3], ["deploymentQualificationVersion", 1]]) test(`old ${field} is blocked`, async () => {
  summary[field] = version; const r = await inspect();
  assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false); assert.equal(native.mock.callCount(), 0);
});

test("budget intent cannot override actual target CPU or undeclared processes", async () => {
  change(`${summary.cells[0].key}/application-before.json`, (v) => v.info.HostConfig.NanoCpus++);
  const r = await inspect(); assert.equal(r.status, "invalid"); assert.equal(r.resources, "invalid");
});
test("an uncharged edge process is invalid", async () => {
  const c = summary.cells.find((c) => c.mode === "deployed-edge");
  change(`${c.key}/deployment.json`, (d) => d.processes.pop()); assert.equal((await inspect()).status, "invalid");
});
test("native process path escapes are rejected before following native filenames", async () => {
  change(`${summary.cells[0].key}/deployment.json`, (d) => d.processes[0].id = "../../outside");
  assert.equal((await inspect()).status, "invalid"); assert.equal(native.mock.callCount(), 0);
});
test("source labels must bind exact source and dependency hashes", async () => {
  binding.sources.files.find((f) => f.path === "Cargo.lock").sha256 = "d".repeat(64);
  assert.equal((await inspect()).status, "invalid");
});
test("missing cleanup proof is blocked, not a target failure", async () => {
  const p = `${summary.cells[0].key}/cleanup.json`, b = readFileSync(join(root, p));
  rmSync(join(root, p)); try { assert.equal((await inspect()).status, "blocked"); } finally { writeFileSync(join(root, p), b); }
});
test("bounded target failure remains failed and retains all frameworks", async () => {
  saveBounded(summary.cells[0]);
  const r = await inspect(); assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true);
  assert.deepEqual(r.outcomes[0], { app: "corten", outcome: "failed" }); assert.equal(r.outcomes.length, apps.length);
});

for (const ack of ["creation", "removal", "absence", "start", "build", "resource-removal", "final-inventory"]) test(`missing ${ack} proof blocks qualification without erasing observed failure`, async () => {
  saveBounded(summary.cells[0]);
  proof.resources = ["resource-removal", "final-inventory"].includes(ack) ? "verified" : "blocked";
  proof.sources = ack === "build" ? "blocked" : "verified";
  proof.cleanupComplete = ack === "build"; proof.blockers.push(ack === "build" ? "saved-source-proof-missing" : "saved-execution-proof-missing");
  const result = await inspect();
  assert.equal(result.status, "blocked"); assert.equal(result.resources, proof.resources); assert.equal(result.cleanupComplete, proof.cleanupComplete);
  assert.deepEqual(result.outcomes[0], { app: "corten", outcome: "failed" });
  assert.deepEqual(result.outcomes.map((row) => row.app), apps);
});
test("a retained harness failure blocks even when a target failed", async () => {
  saveBounded(summary.cells[0]); summary.failures.push({ stage: "apparatus" });
  const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.outcomes[0].outcome, "failed");
});
test("missing defense is an unsupported target, not a review gate", async () => {
  qualifications[0].productionQualified = false;
  const r = await inspect(); assert.equal(r.status, "verified"); assert.equal(r.outcomes[0].outcome, "unsupported");
});
test("a not-run cell blocks full completion", async () => {
  setNonObserved(summary.cells[0], "not-run");
  const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false); assert.equal(r.outcomes[0].outcome, "not-run");
});

test("historical native replay lacks positive apparatus and finalizer proof", async () => {
  proof = undefined; const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.resources, "blocked"); assert.equal(r.cleanupComplete, false);
});
test("native input replay must bind the complete requested source closure", async () => {
  proof.sourceFiles.find((f) => f.path === "package-lock.json").sha256 = "f".repeat(64);
  assert.equal((await inspect()).status, "invalid");
});
test("missing apparatus or parity is blocked, not a framework failure", async () => {
  setNonObserved(summary.cells[0], "invalid"); summary.cells[0].failureKind = "parity-blocked";
  proof.resources = "blocked"; proof.blockers.push("native-matrix-apparatus-incomplete");
  const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false); assert.equal(r.outcomes[0].outcome, "not-run");
});
test("replay mutation is invalid and native diagnostics are not exposed", async () => {
  action = () => change(`${summary.cells[0].key}/cleanup.json`, (v) => v.complete = false);
  const r = await inspect(); assert.equal(r.status, "invalid"); assert.ok(r.blockers.includes("hardening-saved-tree-changed"));
});
test("native assertion errors never expose saved payloads", async () => {
  action = () => { throw new Error("SENSITIVE-TEST-PAYLOAD"); };
  const r = await inspect(); assert.equal(r.status, "invalid"); assert.ok(!JSON.stringify(r).includes("SENSITIVE"));
});
test("unreferenced hardlinks are rejected before native replay", async () => {
  const path = join(root, "unreferenced.json"); linkSync(join(root, "summary.json"), path);
  try { assert.equal((await inspectSaved(binding, root)).status, "invalid"); assert.equal(native.mock.callCount(), 0); } finally { rmSync(path); }
});
