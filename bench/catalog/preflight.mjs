// One fixed qualification attempt, using the unchanged native warmup/sat256 recipe.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { apparatus, digest, workerHeadroom } from "./apparatus.mjs";
import { verifyTimedPhase } from "./timed.mjs";
import { cpuSettings } from "./contract.mjs";

export const preflightSchema = "catalog-apparatus-preflight/v1";
export const preflightCases = ["fixture", "api"].map((source) => ({ app: "corten", source, target: "page" }));
export const phaseArtifacts = (phase) => [`${phase}.json`, `${phase}.log`, `${phase}-boundary.json`, `${phase}-cpu.json`,
  `${phase}-cpu-counters.json`, `${phase}-stats.log`, `${phase}-stats.log.json`, `${phase}-workers.json`];
export const preflightArtifacts = () => preflightCases.flatMap(({ source }) => ["container.json", ...["warmup", "sat256"].flatMap(phaseArtifacts)]
  .map((key) => `preflight/${source}/${key}`));
export function requiredRoundArtifacts(summary) {
  const gated = summary.timingDisposition === "gated-functional";
  const keys = ["fixture.json", "tools.json", "cleanup.json", "apparatus-source.json", "upstream.log",
    ...(gated ? [] : ["preflight.json", ...preflightArtifacts()])];
  for (const app of summary.group.apps) {
    keys.push(`image-${app}.json`, `build-${app}.log`);
    for (const source of summary.group.sources) {
      const prefix = `${source}/${app}`;
      keys.push(...["checks.json", "qualification.json", "checks.log", "app.log", "checker.json"].map((k) => `${prefix}/${k}`));
      if (summary.apps[app].checks[source].failure) keys.push(`${prefix}/checks.json.failure.json`);
      if (!gated) for (let pass = 1; pass <= summary.options.passes; pass++) {
        const raw = `${prefix}/p${pass}-page`;
        if (summary.measurement.loadLayout === "c16-generator-v1") keys.push(`${raw}/cold-probe.json`);
        keys.push(...["cold.json", "cold.log", "container.json", "app.log",
          ...["warmup", "fixed", "sat64", "sat256"].flatMap(phaseArtifacts)].map((k) => `${raw}/${k}`));
      }
    }
  }
  return keys;
}
export function verifyArtifactIndex(summary, reader) {
  const text = reader.readText("evidence-index.json"), index = JSON.parse(text);
  assert.equal(digest(text), summary.savedEvidence.artifactsSha256, "round artifact index digest differs");
  assert.equal(index.schema, "catalog-artifact-index/v1"); assert.equal(index.commit, summary.commit);
  assert.equal(index.sourceSha256, summary.savedEvidence.apparatusSourceSha256);
  assert.ok(isDeepStrictEqual(Object.keys(index.hashes), requiredRoundArtifacts(summary)), "round artifact inventory differs");
  for (const key of requiredRoundArtifacts(summary)) assert.equal(digest(reader.readText(key)), index.hashes[key], "round artifact digest differs");
}
export const preflightBinding = (s) => ({ commit: s.commit, sourceSha256: s.savedEvidence.apparatusSourceSha256,
  fixtureSha256: s.fixtureSha256, tools: s.tools, imageId: s.apps.corten.imageId, cpus: s.measurement.cpus, apparatus,
  ...(s.measurement.loadLayout === undefined ? {} : { loadLayout: s.measurement.loadLayout }),
  warmup: s.options.warmup, duration: s.options.duration, rate: s.options.rate });
export function admission(summary, observed) {
  assert.equal(observed.metrics.outcome, "passed", "apparatus preflight request/drop failure");
  const { cpus, loadLayout } = summary.measurement;
  const env = Object.fromEntries(["app", "api", "load"].map(role => [`CATALOG_${role.toUpperCase()}_CPUS`, cpus[role].cpuset]));
  const { load } = cpuSettings(env, loadLayout);
  assert.equal(cpus.load.quota, load.quota, "preflight generator quota differs from layout");
  assert.ok(observed.resources[`${summary.runId}-k6`].cpuMaxPct < load.quota * 80, "preflight generator has no headroom");
  workerHeadroom(observed.workerPeaks, observed.resources[`${summary.runId}-upstream`].cpuMaxPct);
}
export function verifyPreflight(summary, reader) {
  const receipt = reader.readJson("preflight.json");
  assert.equal(receipt.schema, preflightSchema); assert.equal(receipt.passed, true, "apparatus preflight not passed");
  assert.ok(isDeepStrictEqual(receipt.binding, preflightBinding(summary)), "preflight source/recipe differs");
  assert.ok(isDeepStrictEqual(receipt.cleanup, { containers: [] }), "preflight app cleanup incomplete");
  assert.ok(isDeepStrictEqual(Object.keys(receipt.hashes), preflightArtifacts()), "preflight artifact inventory differs");
  for (const key of preflightArtifacts()) assert.equal(digest(reader.readText(key)), receipt.hashes[key], "preflight artifact digest differs");
  const observations = [];
  let previous = {};
  for (const subject of preflightCases) {
    const prefix = `preflight/${subject.source}`;
    const instance = reader.readJson(`${prefix}/container.json`);
    for (const phase of ["warmup", "sat256"]) {
      const observed = verifyTimedPhase(summary, { ...subject, phase,
        seconds: phase === "warmup" ? summary.options.warmup : summary.options.duration, instance }, {
        readJson: (key) => reader.readJson(`${prefix}/${key}`), readText: (key) => reader.readText(`${prefix}/${key}`),
      }, previous);
      admission(summary, observed); observations.push(observed); previous = { finishedAt: observed.finishedAt };
    }
  }
  return observations;
}
