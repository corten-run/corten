// Offline integrity/replay, not a producer of native qualification evidence.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schema, registryDigest, groupReady, nativeGroup, matrix, validateBudget, boundedRequestsVersion, deploymentQualificationVersion, connectionFloodResistance } from "./plan.mjs";
import { verifyArtifacts, verifyParity, digest, savedFiles, savedProofVersion, savedIsolation, verifyRunInputs, verifyOwnedReceipts, verifyHardeningCpuRoles, upstreamSourcePath } from "./evidence.mjs";
import { assembleRecovery } from "./dependency-recovery-capture.mjs";
import { assembleBounded, boundedProbeConfig } from "./request-capture.mjs";
import { assessNative } from "./native.mjs";
import { validateBoundedQualification } from "./qualification.mjs";
import { terminalHealthPaths, verifyOwnedCleanup, verifyResourceCleanup } from "./lifecycle.mjs";
import { qualificationSettings, featureProfile } from "../marketplace/feature-contract.mjs";
import { records } from "../marketplace/fixtures.mjs";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

// Preflight may finish with a real HTTP error before parity or timing starts.
// Replay only the named control, never count this cell as observed or complete.
export function verifyFailedControl(folder, cell, paths, summary, receipts) {
  if (cell.status !== "invalid" || cell.failureKind !== "target-functional-failure") return false;
  const edge = cell.failedStage === "edge-native-controls";
  if (!edge && cell.failedStage !== "native-controls") return false;
  if (edge) assert.equal(cell.mode, "deployed-edge");
  const prefix = edge ? "edge-" : "";
  const files = [prefix + "qualification.json", prefix + "native-controls.json", "failure.json"];
  if (!files.every(f => paths.has(cell.key + "/" + f))) return false;
  const [qualification, raw, failure] = files.map(f => read(join(folder, cell.key, f)));
  assert.equal(failure.stage, cell.failedStage); assert.equal(failure.kind, cell.failureKind);
  validateBoundedQualification(qualification); assert.equal(qualification.source, cell.source);
  const assessment = assessNative(raw, qualification, edge ? "deployed-edge" : "direct");
  assert.deepEqual(assessment, edge ? cell.edgeAssessment : cell.nativeAssessment);
  assert.ok(assessment.targetFunctionalFailures?.length || assessment.sourceControl === "target-functional-failure",
    "failed control not corroborated by native responses");
  const base = edge ? "https://localhost:8080" : "http://127.0.0.1:8080";
  const page = base + "/marketplace/en-US/item_1", record = base + "/api/marketplace/item_1";
  let bound = true;
  const request = (row, url, method = "GET", host = new URL(url).host) => {
    for (const [key, expected] of Object.entries({ url, method, host })) {
      if (!Object.hasOwn(row, key)) bound = false;
      else assert.equal(row[key], expected, `preflight request ${key} differs from its deployment`);
    }
  };
  request(raw.host.allowed, page); request(raw.host.denied, page, "GET", "unrecognized.invalid");
  request(raw.liveness.negative, base + "/__hardening_not_a_health_endpoint");
  if (raw.liveness.path) request(raw.liveness.baseline, base + raw.liveness.path);
  for (const { step, response } of raw.api?.responses ?? []) {
    request(response, step === "live-503" ? base + raw.liveness.path : step.includes("page") ? page : record);
  }
  for (const { step, response } of raw.api?.controllers ?? [])
    request(response, `http://${summary.runId}-cell-upstream:8080/__marketplace/control`, step.startsWith("count-") || step === "verify-reset" ? "GET" : "POST");
  for (const row of qualification.probes.liveness) request(row, base + row.path);
  if (!receipts || !summary.builds?.[cell.app]) return false;
  try {
    const list = verifyOwnedReceipts(receipts, summary, folder, cell).get(cell.key);
    const { stdout } = list.find(r => r.intent.step === (edge ? "edge-controls" : "native-controls")).start;
    if (!stdout.trim()) return false;
    assert.deepEqual(JSON.parse(stdout), assessment, "owned control output differs from replay");
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  return bound;
}

export function verifySavedProof(folder, summary, tree = savedFiles(folder)) {
  const proof = { schema: "native-hardening-saved-proof/v1", resources: "blocked", sources: "blocked", cleanupComplete: false, blockers: [] };
  if (summary.savedProofVersion === undefined || summary.savedProofVersion === 1) { proof.blockers.push("historical-capture-missing-execution-proof"); return proof; }
  assert.equal(summary.savedProofVersion, savedProofVersion);
  const isolated = savedIsolation(summary.options);
  let receipts;
  try {
    assert.deepEqual(read(join(folder, "run-manifest.json")), tree.filter((f) => f.path !== "run-manifest.json"), "run-wide saved byte closure differs");
    try {
      const inputs = verifyRunInputs(folder, summary); proof.sources = "verified";
      // A materialized image reservation can be cleaned up even when the build
      // never yielded a successful build record. It is not source closure.
      proof.sourceFiles = inputs.files.map(({ path, sha256 }) => ({ path, sha256 }));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      proof.blockers.push("saved-source-proof-missing");
    }
    const inventory = read(join(folder, "owned-containers.json")); assert.equal(inventory.schema, "native-hardening-owned-containers/v1");
    assert.ok(Array.isArray(inventory.files));
    assert.deepEqual(inventory.files, inventory.files.map((_, i) => `${String(i).padStart(8, "0")}.json`));
    assert.deepEqual(readdirSync(join(folder, "owned-containers")).sort(), inventory.files, "unaccounted native launch receipts");
    receipts = inventory.files.map((file) => read(join(folder, "owned-containers", file)));
    const usedNetworkIds = new Set();
    for (const cell of summary.cells.filter((c) => c.status === "observed")) {
      const { network } = read(join(folder, cell.key, "deployment.json"));
      assert.equal(network.Name, `${summary.runId}-net`); assert.match(network.Id, /^[a-f0-9]{64}$/);
      usedNetworkIds.add(network.Id);
    }
    if (summary.cells.some((c) => c.status !== "observed")) proof.blockers.push("native-matrix-apparatus-incomplete");
    else if (!receipts.length || receipts.some((r) => !r.created || !r.terminal || !r.removed || r.intent?.operation === "create" && !r.start)) {
      proof.blockers.push("owned-container-lifetime-incomplete");
    } else if (proof.sources === "verified") {
      const launches = verifyOwnedReceipts(receipts, summary, folder);
      for (const cell of summary.cells.filter((c) => c.status === "observed")) {
        const deployment = read(join(folder, cell.key, "deployment.json")), list = launches.get(cell.key);
        if (isolated) {
          const out = join(folder, cell.key);
          const raw = readFileSync(join(out, "raw.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
          verifyHardeningCpuRoles(read(join(out, "cpu-roles.json")), cell, list, raw);
        }
        for (const p of deployment.processes) {
          const r = list.find((r) => r.intent.step === p.role); assert.ok(r);
          const before = read(join(folder, cell.key, `${p.id}-before.json`)).info, life = read(join(folder, cell.key, `${p.id}-lifecycle.json`));
          assert.equal(r.created.Id, p.containerId); assert.equal(r.created.Image, before.Image);
          assert.deepEqual(r.created.HostConfig, before.HostConfig); assert.deepEqual(r.created.Config, before.Config);
          assert.equal(r.created.State.StartedAt, before.State.StartedAt);
          assert.equal(r.terminal.State.StartedAt, life.after.State.StartedAt);
          // An exited target is an honest target failure, not missing apparatus.
          if (life.health?.response) {
            const health = list.find((r) => r.intent.step === `${p.role}-health`); assert.ok(health, "missing launched terminal health worker");
            assert.equal(health.intent.healthPath, life.health.path);
          }
        }
      }
      if (isolated) proof.cpuRoles = "verified";
      proof.resources = "verified";
    }
    verifyResourceCleanup(read(join(folder, "resource-cleanup.json")), summary, [...usedNetworkIds]);
    proof.cleanupComplete = verifyOwnedCleanup(read(join(folder, "final-cleanup.json")), summary);
    if (!proof.cleanupComplete) proof.blockers.push("owned-final-cleanup-incomplete");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    proof.blockers.push("saved-execution-proof-missing");
  }
  const paths = new Set(tree.map(f => f.path));
  for (const cell of summary.cells) {
    if (verifyFailedControl(folder, cell, paths, summary, proof.sources === "verified" ? receipts : undefined))
      (proof.failedControls ??= []).push({ key: cell.key, stage: cell.failedStage });
  }
  assert.deepEqual(savedFiles(folder), tree, "saved execution bytes changed during replay");
  return proof;
}

export function verify(folder) {
  const tree = savedFiles(folder);
  const summary = read(join(folder, "summary.json")); assert.equal(summary.schema, schema); assert.equal(summary.registryDigest, registryDigest);
  assert.equal(summary.boundedRequestsVersion, boundedRequestsVersion, "bounded request receipt version differs");
  assert.ok(!Object.hasOwn(summary, "semanticReceiptsVersion"), "legacy pressure receipt version is not part of v3");
  assert.equal(summary.lifecycleVersion, 4, "endpoint/time-bound terminal health receipts required");
  assert.equal(summary.savedProofVersion, savedProofVersion, "saved execution proof required");
  assert.equal(summary.nativeControlsVersion, 1, "native controls required");
  assert.equal(summary.deploymentQualificationVersion, deploymentQualificationVersion, "bounded deployment qualification required");
  validateBudget(summary.budget);
  savedIsolation(summary.options);
  assert.equal(summary.options.profile, summary.budget.profile);
  const fixture = readFileSync(join(folder, "fixtures/marketplace.json"));
  assert.equal(digest(fixture), summary.fixtureSha256, "native fixture bytes changed");
  assert.deepEqual(JSON.parse(fixture), records(), "native fixture differs from the marketplace corpus");
  groupReady(summary.cells); // Validate the complete, canonical matrix before following artifact paths.
  assert.deepEqual(summary.cells.map(({ key, app, source, mode, phase }) => ({ key, app, source, mode, phase })),
    matrix().map(({ status, ...cell }) => cell), "native cell identity differs from its canonical matrix key");
  if (summary.cells.every((c) => c.status === "observed")) {
    assert.deepEqual(summary.ownedNetworks, [`${summary.runId}-net`]);
    assert.deepEqual([...summary.ownedImages].sort(), [...new Set(summary.cells.map((c) => `${summary.runId}-${c.app}`))].sort());
  }
  assert.deepEqual(summary.nativeGroup, nativeGroup(summary.cells));
  let observed = 0;
  const dependencyRecovery = [], boundedRequests = [], qualifications = [];
  for (const cell of summary.cells) {
    const recovery = cell.phase === "dependency-recovery";
    for (const field of ["targetOutcome", "defense", "recovery", "sourceObservation",
      ...(recovery ? ["boundedRequests", "boundedTerminalHealthy"] : ["dependencyRecovery", "dependencyTerminalHealthy"])])
      assert.ok(!Object.hasOwn(cell, field), "legacy or mismatched phase outcome in native v3 cell");
    assert.ok(["observed", "invalid", "not-run"].includes(cell.status));
    if (cell.status !== "observed") continue;
    const out = join(folder, cell.key), manifest = read(join(out, "manifest.json")); verifyArtifacts(out, manifest);
    const settings = read(join(out, "settings.json")), deployment = read(join(out, "deployment.json"));
    const qualification = validateBoundedQualification(read(join(out, "qualification.json"))); assert.deepEqual(qualification.missing, cell.nativeMissingFeatures);
    const edgeQualification = cell.mode === "deployed-edge" ? validateBoundedQualification(read(join(out, "edge-qualification.json"))) : undefined;
    assert.deepEqual(settings.terminalHealthPaths, terminalHealthPaths(qualification, edgeQualification));
    assert.equal(qualification.source, cell.source);
    if (edgeQualification) assert.equal(edgeQualification.source, cell.source);
    assert.deepEqual(deployment.totalBudget, summary.budget.resources);
    verifyParity(read(join(out, "native-parity.json")), cell.source);
    const nativeAssessment = assessNative(read(join(out, "native-controls.json")), qualification);
    assert.deepEqual(cell.nativeAssessment, nativeAssessment);
    assert.notEqual(nativeAssessment.sourceControl, "target-functional-failure");
    assert.ok(!nativeAssessment.targetFunctionalFailures?.length);
    let edgeAssessment;
    if (edgeQualification) {
      assert.deepEqual(edgeQualification.missing, cell.edgeMissingFeatures);
      edgeAssessment = assessNative(read(join(out, "edge-native-controls.json")), edgeQualification, "deployed-edge");
      assert.deepEqual(cell.edgeAssessment, edgeAssessment);
      assert.notEqual(edgeAssessment.sourceControl, "target-functional-failure");
      assert.ok(!edgeAssessment.targetFunctionalFailures?.length);
    }
    assert.equal(settings.case, cell.mode); assert.equal(settings.phase, cell.phase); assert.equal(settings.review, summary.options.review);
    assert.deepEqual(JSON.parse(settings.effectiveBudgets), summary.budget);
    assert.deepEqual(settings.deployment.processes, deployment.processes.map(({ containerId, ...p }) => p));
    assert.deepEqual(Object.keys(deployment.network.Containers).sort(), deployment.processes.map((p) => p.containerId).sort());
    const lifecycle = {};
    for (const p of deployment.processes) {
      assert.ok(["application", "upstream", "proxy"].includes(p.role) && p.id === p.role, "foreign native process filename");
      lifecycle[p.id] = read(join(out, `${p.id}-lifecycle.json`));
      assert.ok(lifecycle[p.id].observation, "missing terminal observation interval");
      const origin = deployment.provenance.find((o) => o.id === p.id); assert.ok(origin);
      const before = read(join(out, `${p.id}-before.json`));
      assert.equal(origin.image, before.info.Image); assert.equal(origin.config, digest(readFileSync(join(out, `${p.id}-before.json`))));
      assert.equal(before.info.Id, p.containerId); assert.equal(before.top.trimEnd().split("\n").length - 1, p.count);
      assert.deepEqual(before.info, lifecycle[p.id].before);
      if (p.role === "application") {
        const labels = before.info.Config.Labels;
        assert.equal(labels["run.corten.marketplace.commit"], summary.commit); assert.equal(labels["run.corten.marketplace.dirty"], "false");
        assert.equal(labels["run.corten.marketplace.profile"], featureProfile);
        assert.equal(origin.source, `${summary.commit}:sha256:${labels["run.corten.hardening.source"]}`);
        assert.match(labels["run.corten.hardening.source"], /^[a-f0-9]{64}$/);
        const env = Object.fromEntries(before.info.Config.Env.map((value) => { const index = value.indexOf("="); return [value.slice(0, index), value.slice(index + 1)]; }));
        assert.equal(env.PROFILE, qualificationSettings.nativeProfile); assert.equal(env.MAX_CONNECTIONS, String(qualificationSettings.maxConnections));
        assert.equal(env.MARKETPLACE_SOURCE, cell.source);
      }
      if (p.role === "upstream") assert.equal(origin.source, `${summary.commit}:${upstreamSourcePath(cell.phase)}`);
      if (p.role === "proxy") assert.equal(origin.source, `${summary.commit}:bench/fullstack/edge.mjs:nginxConf`);
    }
    const raw = readFileSync(join(out, "raw.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    let config;
    if (!recovery) {
      const ca = edgeQualification ? readFileSync(join(out, "cert/cert.pem"), "utf8") : undefined;
      config = boundedProbeConfig(cell, summary.budget, summary.runId, ca);
      assert.deepEqual(read(join(out, "probe.json")), config, "saved bounded configuration differs from the cell");
    }
    const capture = (recovery ? assembleRecovery : assembleBounded)({ settings, raw, config,
      parity: read(join(out, "parity.json")), source: cell.source, cleanup: read(join(out, "cleanup.json")), provenance: deployment.provenance, lifecycle });
    assert.deepEqual(capture, read(join(out, "capture.json")), "saved capture differs from raw observations");
    assert.equal(cell.apparatusValid, true); assert.equal(cell.parity, "passed");
    observed++;
    qualifications.push({ key: cell.key, productionQualified: nativeAssessment.productionQualified && (edgeAssessment?.productionQualified ?? true) });
    const replay = { key: cell.key, assessment: capture.assessment, terminalHealthy: capture.terminal.healthy,
      terminalDisposition: capture.terminal.disposition };
    if (recovery) {
      assert.deepEqual(cell.dependencyRecovery, capture.assessment);
      assert.equal(cell.dependencyTerminalHealthy, capture.terminal.healthy, "saved dependency terminal health differs from replay");
      dependencyRecovery.push(replay);
      continue;
    }
    assert.deepEqual(cell.boundedRequests, capture.assessment);
    assert.equal(cell.boundedTerminalHealthy, capture.terminal.healthy, "saved bounded terminal health differs from replay");
    boundedRequests.push(replay);
  }
  const ready = groupReady(summary.cells) && !Object.keys(summary.options.verify).length && summary.cleanupFailures.length === 0;
  assert.equal(summary.groupReady, ready);
  const proof = verifySavedProof(folder, summary, tree);
  assert.deepEqual(savedFiles(folder), tree, "saved native bytes changed during replay");
  return { schema, observed, connectionFloodResistance, groupReady: ready, notRun: summary.cells.filter((c) => c.status === "not-run").length, proof,
    dependencyRecovery, boundedRequests, qualifications };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verify(resolve(process.argv[2]))));
