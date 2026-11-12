// Offline integrity/replay, not a producer of native qualification evidence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schema, registryDigest, groupReady, nativeGroup } from "./plan.mjs";
import { assemble, verifyArtifacts, digest, targetOutcome } from "./evidence.mjs";
import { assessNative, assessTimedSource } from "./native.mjs";
import { validateQualification } from "../marketplace/feature-contract.mjs";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

export function verify(folder) {
  const summary = read(join(folder, "summary.json")); assert.equal(summary.schema, schema); assert.equal(summary.registryDigest, registryDigest);
  groupReady(summary.cells); // Validate the complete, canonical matrix before following artifact paths.
  if (summary.nativeControlsVersion === 1) assert.deepEqual(summary.nativeGroup, nativeGroup(summary.cells));
  let observed = 0;
  for (const cell of summary.cells) {
    if (cell.status !== "observed") continue;
    const out = join(folder, cell.key), manifest = read(join(out, "manifest.json")); verifyArtifacts(out, manifest);
    const settings = read(join(out, "settings.json")), deployment = read(join(out, "deployment.json"));
    const qualification = validateQualification(read(join(out, "qualification.json"))); assert.deepEqual(qualification.missing, cell.nativeMissingFeatures);
    if (summary.nativeControlsVersion === 1) {
      assert.deepEqual(cell.nativeAssessment, assessNative(read(join(out, "native-controls.json")), qualification));
      assert.notEqual(cell.nativeAssessment.sourceControl, "target-functional-failure");
      if (cell.mode === "deployed-edge") {
        assert.deepEqual(cell.edgeAssessment, assessNative(read(join(out, "edge-native-controls.json")), qualification));
        assert.notEqual(cell.edgeAssessment.sourceControl, "target-functional-failure");
      }
    }
    assert.equal(settings.case, cell.mode); assert.equal(settings.phase, cell.phase); assert.equal(settings.review, summary.options.review);
    assert.deepEqual(JSON.parse(settings.effectiveBudgets), summary.budget);
    assert.deepEqual(settings.deployment.processes, deployment.processes.map(({ containerId, ...p }) => p));
    assert.deepEqual(Object.keys(deployment.network.Containers).sort(), deployment.processes.map((p) => p.containerId).sort());
    const lifecycle = {};
    for (const p of deployment.processes) {
      lifecycle[p.id] = read(join(out, `${p.id}-lifecycle.json`));
      const origin = deployment.provenance.find((o) => o.id === p.id); assert.ok(origin);
      const before = read(join(out, `${p.id}-before.json`));
      assert.equal(origin.image, before.info.Image); assert.equal(origin.config, digest(readFileSync(join(out, `${p.id}-before.json`))));
      assert.equal(before.info.Id, p.containerId); assert.equal(before.top.split("\n").length - 1, p.count);
      assert.deepEqual(before.info, lifecycle[p.id].before);
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
  return { schema, observed, groupReady: ready, notRun: summary.cells.filter((c) => c.status === "not-run").length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verify(resolve(process.argv[2]))));
