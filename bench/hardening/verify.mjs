// Offline integrity/replay, not a producer of native qualification evidence.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schema, registryDigest, groupReady, nativeGroup } from "./plan.mjs";
import { assemble, verifyArtifacts, verifyParity, digest, targetOutcome, savedFiles, savedProofVersion, verifyRunInputs, verifyOwnedReceipts } from "./evidence.mjs";
import { assessNative, assessTimedSource } from "./native.mjs";
import { terminalHealthPaths, verifyOwnedCleanup, verifyResourceCleanup } from "./lifecycle.mjs";
import { validateQualification, qualificationSettings } from "../marketplace/feature-contract.mjs";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

export function verifySavedProof(folder, summary, tree = savedFiles(folder)) {
  const proof = { schema: "native-hardening-saved-proof/v1", resources: "blocked", sources: "blocked", cleanupComplete: false, blockers: [] };
  if (summary.savedProofVersion === undefined || summary.savedProofVersion === 1) { proof.blockers.push("historical-capture-missing-execution-proof"); return proof; }
  assert.equal(summary.savedProofVersion, savedProofVersion);
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
    const receipts = inventory.files.map((file) => read(join(folder, "owned-containers", file)));
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
      proof.resources = "verified";
    }
    verifyResourceCleanup(read(join(folder, "resource-cleanup.json")), summary, [...usedNetworkIds]);
    proof.cleanupComplete = verifyOwnedCleanup(read(join(folder, "final-cleanup.json")), summary);
    if (!proof.cleanupComplete) proof.blockers.push("owned-final-cleanup-incomplete");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    proof.blockers.push("saved-execution-proof-missing");
  }
  assert.deepEqual(savedFiles(folder), tree, "saved execution bytes changed during replay");
  return proof;
}

export function verify(folder) {
  const tree = savedFiles(folder);
  const summary = read(join(folder, "summary.json")); assert.equal(summary.schema, schema); assert.equal(summary.registryDigest, registryDigest);
  assert.equal(summary.semanticReceiptsVersion, 2, "historical capture predates full-duration pressure and response deadline gates; do not backfill or promote it");
  assert.equal(summary.lifecycleVersion, 4, "historical capture predates endpoint/time-bound terminal health receipts and exit-race handling; do not backfill or qualify it");
  assert.equal(digest(readFileSync(join(folder, "fixtures/marketplace.json"))), summary.fixtureSha256, "native fixture bytes changed");
  groupReady(summary.cells); // Validate the complete, canonical matrix before following artifact paths.
  if (summary.savedProofVersion === savedProofVersion && summary.cells.every((c) => c.status === "observed")) {
    assert.deepEqual(summary.ownedNetworks, [`${summary.runId}-net`]);
    assert.deepEqual([...summary.ownedImages].sort(), [...new Set(summary.cells.map((c) => `${summary.runId}-${c.app}`))].sort());
  }
  if (summary.nativeControlsVersion === 1) assert.deepEqual(summary.nativeGroup, nativeGroup(summary.cells));
  let observed = 0;
  for (const cell of summary.cells) {
    if (cell.status !== "observed") continue;
    const out = join(folder, cell.key), manifest = read(join(out, "manifest.json")); verifyArtifacts(out, manifest);
    const settings = read(join(out, "settings.json")), deployment = read(join(out, "deployment.json"));
    const qualification = validateQualification(read(join(out, "qualification.json"))); assert.deepEqual(qualification.missing, cell.nativeMissingFeatures);
    assert.deepEqual(settings.terminalHealthPaths, terminalHealthPaths(qualification,
      cell.mode === "deployed-edge" ? validateQualification(read(join(out, "edge-qualification.json"))) : undefined));
    if (summary.deploymentQualificationVersion === 1) verifyParity(read(join(out, "native-parity.json")), cell.source);
    if (summary.nativeControlsVersion === 1) {
      assert.deepEqual(cell.nativeAssessment, assessNative(read(join(out, "native-controls.json")), qualification));
      assert.notEqual(cell.nativeAssessment.sourceControl, "target-functional-failure");
      assert.ok(!cell.nativeAssessment.targetFunctionalFailures?.length);
      if (cell.mode === "deployed-edge") {
        const effective = summary.deploymentQualificationVersion === 1 ? validateQualification(read(join(out, "edge-qualification.json"))) : qualification;
        if (summary.deploymentQualificationVersion === 1) assert.deepEqual(effective.missing, cell.edgeMissingFeatures);
        assert.deepEqual(cell.edgeAssessment, assessNative(read(join(out, "edge-native-controls.json")), effective, summary.deploymentQualificationVersion === 1 ? "deployed-edge" : "direct"));
        assert.notEqual(cell.edgeAssessment.sourceControl, "target-functional-failure");
        assert.ok(!cell.edgeAssessment.targetFunctionalFailures?.length);
      }
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
        assert.equal(labels["run.corten.marketplace.profile"], qualification.profile);
        assert.equal(origin.source, `${summary.commit}:sha256:${labels["run.corten.hardening.source"]}`);
        const env = Object.fromEntries(before.info.Config.Env.map((value) => { const index = value.indexOf("="); return [value.slice(0, index), value.slice(index + 1)]; }));
        assert.equal(env.PROFILE, qualificationSettings.nativeProfile); assert.equal(env.MAX_CONNECTIONS, String(qualificationSettings.maxConnections));
        assert.equal(env.MARKETPLACE_SOURCE, cell.source);
      }
    }
    const raw = readFileSync(join(out, "raw.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const capture = assemble({ settings, raw,
      parity: read(join(out, "parity.json")), source: cell.source, cleanup: read(join(out, "cleanup.json")), provenance: deployment.provenance, lifecycle });
    assert.deepEqual(capture, read(join(out, "capture.json")), "saved capture differs from raw observations");
    assert.equal(cell.apparatusValid, true); assert.equal(cell.parity, "passed");
    assert.equal(cell.defense, capture.defense.protection); assert.equal(cell.recovery, capture.recovery.disposition); observed++;
    if (summary.nativeControlsVersion === 1) {
      if (cell.source === "api") { assert.equal(settings.nativeSource, "api"); assert.deepEqual(cell.sourceObservation, assessTimedSource(raw)); }
      assert.deepEqual(cell.targetOutcome, targetOutcome(capture, cell.edgeAssessment ?? cell.nativeAssessment, cell.sourceObservation));
    }
  }
  const ready = groupReady(summary.cells) && !Object.keys(summary.options.verify).length && summary.cleanupFailures.length === 0;
  assert.equal(summary.groupReady, ready);
  const proof = verifySavedProof(folder, summary, tree);
  assert.deepEqual(savedFiles(folder), tree, "saved native bytes changed during replay");
  return { schema, observed, groupReady: ready, notRun: summary.cells.filter((c) => c.status === "not-run").length, proof };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verify(resolve(process.argv[2]))));
