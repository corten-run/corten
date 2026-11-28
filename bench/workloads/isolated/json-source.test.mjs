// Synthetic controller seam only; the JSON raw/native verifier is not qualified here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mock, test } from "node:test";
import { inspect } from "node:util";

const target = new URL("../../json-api/report.mjs", import.meta.url).href;
const stub = "data:text/javascript,export function inspectBoundJson(){}";
const hooks = registerHooks({ resolve(specifier, context, next) {
  return new URL(specifier, context.parentURL ?? import.meta.url).href === target
    ? { url: stub, shortCircuit: true } : next(specifier, context);
} });
mock.module(stub, { exports: { inspectBoundJson: (summary, { commit, verifyBoundProducer }) => {
  assert.equal(summary.commit, commit);
  verifyBoundProducer(summary);
  return { attemptComplete: true, outcomes: [] };
} } });
const { inspectEvidence, verifyJsonProducer } = await import("./evidence.mjs");
const { producerProvenance } = await import("../../json-api/production.mjs");

test("JSON v2 producer assets must match the bound commit even when local producer hashes are coherent", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "isolated-json-source-"));
  t.after(() => {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    rmSync(folder, { recursive: true }); hooks.deregister();
  });
  const commit = "a".repeat(40), producer = producerProvenance();
  const summary = { schema: "json-api-results/v2", round: "w17", commit, options: {}, measurement: { cpus: {} }, producer };
  const binding = { request: { group: "json-api", round: summary.round, commit }, execution: { effectiveOptions: {} },
    resources: { expectedCpus: {} }, sources: { commit,
      files: Object.entries(producer.sources).map(([name, sha256]) => ({ path: `bench/json-api/${name}`, sha256 })) } };
  const save = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(summary));
  save(); assert.equal(inspectEvidence(binding, folder).attemptComplete, true);
  const scheduled = producerProvenance("json-api-producer/v3");
  const withSchedule = structuredClone(binding);
  withSchedule.sources.files = Object.entries(scheduled.sources).map(([name, sha256]) => ({ path: `bench/json-api/${name}`, sha256 }));
  verifyJsonProducer(withSchedule, { ...summary, producer: scheduled });
  const canary = "SAVED_PRODUCER_FIELD_CANARY", unexpected = structuredClone(scheduled);
  unexpected.sources[canary] = "c".repeat(64);
  assert.throws(() => verifyJsonProducer(withSchedule, { ...summary, producer: unexpected }),
    (error) => error.message === "JSON producer inventory differs" && !inspect(error).includes(canary));
  assert.throws(() => verifyJsonProducer(withSchedule, summary), /cannot downgrade/);
  assert.throws(() => verifyJsonProducer(binding, { ...summary, producer: scheduled }), /missing from bound commit/);
  for (const mutate of [
    (value) => { value.sources.files[0].sha256 = createHash("sha256").update("different committed producer").digest("hex"); },
    (value) => { value.sources.files.pop(); },
    (value) => { value.sources.files.push({ ...value.sources.files[0] }); },
    (value) => { value.sources.commit = "b".repeat(40); },
    (value) => { delete value.sources; },
  ]) {
    const changed = structuredClone(binding); mutate(changed);
    assert.throws(() => inspectEvidence(changed, folder), undefined, "unbound producer must not qualify");
  }
  for (const mutate of [
    (value) => { value.producer.sources.extra = "b".repeat(64); },
    (value) => { delete value.producer.sources[Object.keys(producer.sources)[0]]; },
    (value) => { value.producer.schema = "json-api-producer/v3"; },
    (value) => { delete value.producer; },
  ]) {
    const changed = structuredClone(summary); mutate(changed);
    writeFileSync(join(folder, "summary.json"), JSON.stringify(changed));
    assert.throws(() => inspectEvidence(binding, folder));
  }
  for (const schema of ["json-api-results/v1", "json-api-results/v3", undefined]) {
    summary.schema = schema; save();
    assert.throws(() => inspectEvidence(binding, folder), /current JSON campaign requires v2 evidence/);
    assert.throws(() => inspectEvidence({ ...binding, sources: undefined }, folder), /current JSON campaign requires v2 evidence/);
  }
});
