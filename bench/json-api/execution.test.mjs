// Synthetic Docker observations only. No saved command is executed by these tests.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { descriptor, imageCommandEvidence, loadConfig, participantReceipt, runtimeContext, runtimeReceipt, verifyImage } from "./contract.mjs";
import { inspectJson } from "./report.mjs";
import { failedResult, result, runtimeInfo } from "./test-fixtures.mjs";
import { inspectNative } from "../workloads/isolated/native-replay.mjs";
import { composePhase } from "../workloads/isolated/composition.mjs";

const substitutions = [
  ["command", (i) => { i.Config.Cmd = ["node", "--eval", "process.exit(1)"]; }],
  ["command prefix", (i) => { i.Config.Cmd = ["node", "--eval", "process.exit(1)", ...(i.Config.Cmd ?? [])]; }],
  ["entrypoint", (i) => { i.Config.Entrypoint = ["/unreviewed/node"]; }],
  ["effective path", (i) => { i.Path = "/unreviewed/node"; }],
  ["effective arguments", (i) => { i.Args = ["--eval", "process.exit(1)"]; }],
  ["missing command", (i) => { delete i.Config.Cmd; }],
  ["missing entrypoint", (i) => { delete i.Config.Entrypoint; }],
  ["missing effective path", (i) => { delete i.Path; }],
  ["missing effective arguments", (i) => { delete i.Args; }],
];

for (const role of ["app", "upstream", "load", "probe"]) test(`actual JSON ${role} projection rejects substituted execution`, () => {
  const f = result(), p = descriptor().cases[0], expected = f.summary.apps.express.checks[p.key].identity;
  const context = { ...runtimeContext(f.summary, p), load: loadConfig(f.summary.options, "fixed") };
  const receive = (i) => role === "app" ? runtimeReceipt(i, expected, context) : participantReceipt(i, expected, context, role);
  assert.ok(receive(runtimeInfo(expected, context, role)), `${role} ordinary control`);
  for (const [name, mutate] of substitutions) {
    const info = runtimeInfo(expected, context, role); mutate(info);
    assert.throws(() => receive(info), `${role}: ${name} must not be discarded by the producer`);
  }
});

test("inspected JSON image defaults are required, parsed exactly and not replaced by runner defaults", () => {
  const f = result(), s = f.summary, p = descriptor().cases[0], saved = s.apps.express.images[p.payload];
  for (const execution of [{ Entrypoint: null, Cmd: ["/native/app", "--production"] },
    { Entrypoint: ["/native/app"], Cmd: null }, { Entrypoint: ["/native/app"], Cmd: [] },
    { Entrypoint: ["/native/entry", "--flag"], Cmd: ["/native/app", "a b"] }]) {
    saved.execution = execution;
    assert.deepEqual(imageCommandEvidence({ Config: execution }), execution);
    verifyImage(saved, s.commit, "express", p.payload);
    const expected = s.apps.express.checks[p.key].identity, context = runtimeContext(s, p);
    assert.ok(runtimeReceipt(runtimeInfo(expected, context), expected, context));
  }
  for (const execution of [undefined, null, [], {}, { Cmd: ["/native/app"] },
    { Entrypoint: null, Cmd: null }, { Entrypoint: [], Cmd: [] },
    { Entrypoint: null, Cmd: [""] }, { Entrypoint: null, Cmd: [1] },
    { Entrypoint: null, Cmd: ["/native/app\0evil"] }, { Entrypoint: "/native/app", Cmd: [] },
    { Entrypoint: null, Cmd: ["/native/app"], extra: true }]) {
    saved.execution = execution; assert.throws(() => verifyImage(saved, s.commit, "express", p.payload));
  }
});

test("saved negative JSON execution substitutions cannot become a native-validated failed target", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "json-execution-test-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); });
  const f = failedResult("express"), s = f.summary, p = descriptor().cases[0], checked = s.apps.express.checks[p.key];
  const binding = { request: { group: "json-api", round: s.round, commit: s.commit }, selection: { apps: s.group.apps },
    preparation: { fixtures: [] }, execution: { effectiveOptions: s.options }, resources: { expectedCpus: s.measurement.cpus } };
  const save = () => { for (const [path, bytes] of f.artifacts) writeFileSync(join(folder, path), bytes);
    writeFileSync(join(folder, "summary.json"), JSON.stringify(s)); };
  const compose = (native) => composePhase(binding, native, { cleanupComplete: true, resources: "verified" },
    [{ terminal: true, code: 1, error: null, cancelled: false, forced: false, success: false }]);
  save();
  const positive = await inspectNative(binding, folder);
  assert.equal(positive.status, "failed"); assert.equal(positive.attemptComplete, true);
  assert.equal(compose(positive).outcome, "native-validated");
  assert.ok(compose(positive).appOutcomes.every((r) => !r.comparisonEligible));
  const original = checked.raw;
  for (const role of ["app", "upstream"]) for (const field of ["command", "entrypoint", "path", "args"]) {
    const raw = f.load(original), receipt = role === "app" ? raw.runtime : raw.participants[role];
    receipt.configuration[field] = field === "path" ? "/unreviewed/node" : ["/unreviewed/node", "--eval", "process.exit(1)"];
    checked.raw = f.put(raw); save();
    const report = inspectJson(s, { load: f.load, commit: s.commit });
    assert.equal(report.attemptComplete, false, `${role}/${field}`); assert.equal(report.baseline, false);
    const native = await inspectNative(binding, folder);
    assert.equal(native.status, "invalid", `${role}/${field}`); assert.equal(native.attemptComplete, false);
    assert.notEqual(compose(native).outcome, "native-validated");
  }
  checked.raw = original; save(); assert.equal((await inspectNative(binding, folder)).attemptComplete, true);
});
