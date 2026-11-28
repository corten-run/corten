import assert from "node:assert/strict";
import { selectedApps, contractSha256 } from "../workloads/registry.mjs";

import { recoveryProfile } from "./dependency-recovery-contract.mjs";
import { boundedRequestProfile } from "./bounded-requests.mjs";

export const schema = "native-hardening-run/v3";
export const connectionFloodResistance = "Connection-flood resistance: not measured.";
export const boundedRequestsVersion = boundedRequestProfile.version;
export const deploymentQualificationVersion = 2;
export const phases = ["request-timeout", "request-limit", "dependency-recovery"];
export const cases = ["direct", "deployed-edge"];
export const sources = ["fixture", "api"];
export const apps = selectedApps("hardening");
export const appSourcePath = (app, path) => app === "corten"
  ? path === "Cargo.toml" || path === "Cargo.lock" || path.startsWith("crates/") || path.startsWith("bench/marketplace/corten/")
  : path.startsWith(`bench/fullstack/apps/${app}/`);
export const appSourceRows = (app, files) => files.filter(({ path }) => appSourcePath(app, path))
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, sha256 }) => [path, sha256]);
export const matrix = () => apps.flatMap((app) => sources.flatMap((source) => cases.flatMap((mode) => phases.map((phase) =>
  ({ key: `${app}/${source}/${mode}/${phase}`, app, source, mode, phase, status: "not-run" })))));
export function budgets(profile = "bounded") {
  assert.equal(profile, "bounded", "only the bounded profile is supported");
  return {
    profile,
    boundedRequests: boundedRequestProfile,
    dependencyRecovery: recoveryProfile,
    timing: { maxStartLagMs: 200 },
    resources: { cpuCoresTotal: 1.5, memoryBytesTotal: 1536 * 2 ** 20, applicationDirect: { cpu: 1, memory: 1024 * 2 ** 20 },
      applicationEdge: { cpu: 0.75, memory: 768 * 2 ** 20 }, proxy: { cpu: 0.25, memory: 256 * 2 ** 20 }, upstream: { cpu: 0.5, memory: 512 * 2 ** 20 },
      apparatus: { cpu: 2, memory: 1024 * 2 ** 20 }, qualification: { cpu: 2, memory: 2 * 2 ** 30 },
      observation: "native Docker limits and process inventories; dependency recovery adds sampled cgroup-v2 counters; no peak claim" },
    recovery: { requestTimeoutMs: 600, attempts: "terminal liveness observations; no target restart" },
    cleanup: { timeoutMs: 15000, scope: "all owned sockets, timers, command clients, containers including volumes, network" },
  };
}

export function validateBudget(b) {
  assert.deepEqual(b, budgets(b?.profile), "use an exact versioned profile; no unreviewed schedule/budget overrides");
  for (const mode of cases) {
    const app = b.resources[mode === "direct" ? "applicationDirect" : "applicationEdge"];
    const roles = [app, b.resources.upstream, ...(mode === "deployed-edge" ? [b.resources.proxy] : [])];
    assert.equal(roles.reduce((n, r) => n + r.cpu, 0), b.resources.cpuCoresTotal);
    assert.equal(roles.reduce((n, r) => n + r.memory, 0), b.resources.memoryBytesTotal);
  }
  return b;
}

export function parseArgs(args) {
  assert.match(args[0] ?? "", /^w[1-9]\d*$/, "explicit local development round wN required");
  const o = { round: args[0], profile: "bounded", review: null, build: false, verify: {}, out: `bench/hardening/results/${args[0]}`, nodeModules: "node_modules" };
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    assert.ok(!seen.has(key), `duplicate option ${key}`); seen.add(key);
    if (key === "--build") { assert.equal(o.build, false, "duplicate --build"); o.build = true; continue; }
    if (key === "--isolated") { o.isolated = true; continue; }
    assert.ok(["--out", "--profile", "--review", "--node-modules", "--verify-app", "--verify-source", "--verify-case", "--verify-phase"].includes(key), `unknown argument ${key}`);
    const value = args[++i]; assert.ok(value && !value.startsWith("--"), `${key} needs a value`);
    if (key.startsWith("--verify-")) { const name = key.slice(9); assert.equal(o.verify[name], undefined, "duplicate verification filter"); o.verify[name] = value; }
    else o[key === "--node-modules" ? "nodeModules" : key.slice(2)] = value;
  }
  assert.ok(o.out && o.review?.trim(), "--out and --review are required; review identifies the approved effective profile");
  for (const [key, choices] of Object.entries({ app: apps, source: sources, case: cases, phase: phases })) {
    if (o.verify[key]) assert.ok(choices.includes(o.verify[key]), `unknown ${key}`);
  }
  validateBudget(budgets(o.profile));
  return o;
}
export const selected = (cell, o) => Object.entries(o.verify).every(([key, value]) => cell[key === "case" ? "mode" : key] === value);
export const registryDigest = contractSha256("hardening");

const nativeEvidence = (cell, assessment) => assessment?.schema === "native-hardening-assessment/v1"
  && typeof assessment.productionQualified === "boolean"
  && ["observed", "missing", "inconclusive"].includes(assessment.hostValidation)
  && ["observed", "missing", "inconclusive"].includes(assessment.liveness)
  && assessment.sourceControl === (cell.source === "api" ? "passed" : "not-applicable");

const boundedSuccess = (c) => c.phase === "request-limit" ? ["accepted", "rejected"]
  : [c.source === "api" ? "client-deadline" : "fixture-control"];

const phaseObserved = (c) => c.phase === "dependency-recovery"
  ? c.dependencyRecovery?.version === recoveryProfile.version && c.dependencyRecovery.source === c.source &&
    typeof c.dependencyTerminalHealthy === "boolean" &&
    ["baseline-unavailable", ...(c.source === "api" ? ["recovered", "unrecovered"] : ["fixture-control", "fixture-degraded"])].includes(c.dependencyRecovery.status)
  : c.boundedRequests?.version === boundedRequestsVersion && c.boundedRequests.phase === c.phase && c.boundedRequests.source === c.source &&
    typeof c.boundedTerminalHealthy === "boolean" &&
    (c.boundedRequests.status === "target-failure" ? c.boundedRequests.healthy === false
      : c.boundedRequests.healthy === true && boundedSuccess(c).includes(c.boundedRequests.status));

export function groupReady(cells) {
  const expected = matrix();
  assert.deepEqual(cells.map((c) => c.key), expected.map((c) => c.key), "selected group matrix was dropped or reordered");
  return cells.every((c) => c.status === "observed" && c.parity === "passed" && c.apparatusValid === true && phaseObserved(c)
    && nativeEvidence(c, c.nativeAssessment) && (c.mode === "direct" || nativeEvidence(c, c.edgeAssessment)));
}

export function nativeGroup(cells) {
  assert.deepEqual(cells.map((c) => c.key), matrix().map((c) => c.key));
  return apps.map((app) => {
    const selected = cells.filter((c) => c.app === app), assessed = selected.filter((c) => c.nativeAssessment);
    const assessments = selected.flatMap((c) => [c.nativeAssessment, ...(c.mode === "deployed-edge" ? [c.edgeAssessment] : [])]).filter(Boolean);
    const qualified = selected.every((c) => c.status === "observed" && c.parity === "passed" && c.apparatusValid === true && phaseObserved(c)
      && nativeEvidence(c, c.nativeAssessment) && c.nativeAssessment.productionQualified === true
      && (c.mode === "direct" || nativeEvidence(c, c.edgeAssessment) && c.edgeAssessment.productionQualified === true));
    return { app, representative: "existing-native-marketplace-production-matched", alternatives: [],
      cells: selected.length, assessed: assessed.length, observed: selected.filter((c) => c.status === "observed").length,
      productionQualification: !assessed.length ? "not-established" : assessments.some((a) => a.productionQualified === false)
        ? "gaps-observed" : qualified ? "qualified" : "partial",
      missingProductionFeatures: [...new Set(assessments.flatMap((a) => a.missingProductionFeatures))].sort(),
      unmeasuredProductionFeatures: [...new Set(assessments.flatMap((a) => a.unmeasuredProductionFeatures ?? []))].sort(),
      numericComparisonQualified: false };
  });
}
