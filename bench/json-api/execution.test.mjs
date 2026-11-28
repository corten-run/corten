// Synthetic Docker observations only. No saved command is executed by these tests.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { descriptor, imageCommandEvidence, loadConfig, participantReceipt, runtimeContext, runtimeReceipt, sha256, verifyImage } from "./contract.mjs";
import { inspectJson } from "./report.mjs";
import { result, runtimeInfo } from "./test-fixtures.mjs";
import { gateFunctionalFixture, productionFixture } from "./production-fixtures.mjs";
import { producerSources } from "./production.mjs";
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
  ["null command", (i) => { i.Config.Cmd = null; }],
  ["empty command", (i) => { i.Config.Cmd = []; }],
  ["malformed command", (i) => { i.Config.Cmd = "node"; }],
  ["null-byte command", (i) => { i.Config.Cmd = ["node\0evil"]; }],
  ["missing configuration", (i) => { delete i.Config; }],
  ["missing effective path", (i) => { delete i.Path; }],
  ["missing effective arguments", (i) => { delete i.Args; }],
];

for (const role of ["app", "upstream", "load", "probe"]) test(`actual JSON ${role} projection rejects substituted execution`, () => {
  const f = result(), p = descriptor().cases[0], expected = f.summary.apps.express.checks[p.key].identity;
  f.summary.apps.express.images[p.payload].execution.Entrypoint = ["/native-entrypoint"];
  const context = { ...runtimeContext(f.summary, p), load: loadConfig(f.summary.options, "fixed") };
  const receive = (i) => role === "app" ? runtimeReceipt(i, expected, context) : participantReceipt(i, expected, context, role);
  assert.ok(receive(runtimeInfo(expected, context, role)), `${role} ordinary control`);
  for (const [name, mutate] of substitutions) {
    const info = runtimeInfo(expected, context, role); mutate(info);
    assert.throws(() => receive(info), `${role}: ${name} must not be discarded by the producer`);
  }
});

test("omitted optional Docker image defaults normalize to null, not an invented command", () => {
  for (const Config of [{ Entrypoint: ["k6"] }, { Entrypoint: ["k6"], Cmd: undefined }, { Entrypoint: ["k6"], Cmd: null },
    { Cmd: ["node"] }, { Entrypoint: undefined, Cmd: ["node"] }, { Entrypoint: null, Cmd: ["node"] }]) {
    const expected = { Entrypoint: Config.Entrypoint ?? null, Cmd: Config.Cmd ?? null };
    assert.deepEqual(imageCommandEvidence({ Config }), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(imageCommandEvidence({ Config }))), expected);
  }
  for (const image of [undefined, {}, { Config: undefined }, { Config: null }, { Config: [] }, { Config: {} },
    { Config: { Entrypoint: null, Cmd: null } }, { Config: { Entrypoint: "k6" } },
    { Config: { Entrypoint: ["k6"], Cmd: "run" } }, { Config: { Entrypoint: ["k6"], Cmd: ["run\0evil"] } }]) {
    assert.throws(() => imageCommandEvidence(image));
  }
});

test("optional Docker container defaults match null only when the inspected image default is empty", () => {
  const f = result(), p = descriptor().cases[0], expected = f.summary.apps.express.checks[p.key].identity;
  for (const [execution, field] of [[{ Entrypoint: null, Cmd: ["/native/app"] }, "Entrypoint"],
    [{ Entrypoint: ["/native/app"], Cmd: null }, "Cmd"]]) {
    f.summary.apps.express.images[p.payload].execution = execution;
    const context = runtimeContext(f.summary, p), info = runtimeInfo(expected, context);
    delete info.Config[field];
    const receipt = runtimeReceipt(info, expected, context);
    assert.equal(receipt.configuration[field === "Cmd" ? "command" : "entrypoint"], null);
    assert.deepEqual(receipt, runtimeReceipt({ ...info, Config: { ...info.Config, [field]: null } }, expected, context));
    info.Config[field] = ["/substituted"];
    assert.throws(() => runtimeReceipt(info, expected, context));
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

let negativeExecution, executionFolder;
test.after(() => {
  if (!executionFolder) return;
  assert.ok(resolve(executionFolder).startsWith(resolve(tmpdir()) + sep)); rmSync(executionFolder, { recursive: true });
});
async function executionFixture() {
  const folder = executionFolder = mkdtempSync(join(tmpdir(), "json-execution-test-"));
  const p = descriptor().cases[0], f = gateFunctionalFixture(await productionFixture(folder, { cells: [] }), "express", p);
  const s = f.summary, checked = s.apps.express.checks[p.key];
  const binding = { request: { group: "json-api", round: s.round, commit: s.commit }, selection: { apps: s.group.apps },
    preparation: { fixtures: [] }, execution: { effectiveOptions: s.options }, resources: { expectedCpus: s.measurement.cpus },
    sources: { commit: s.commit, files: producerSources.map((name) => ({ path: `bench/json-api/${name}`, sha256: sha256(readFileSync(new URL(name, import.meta.url))) })) } };
  const written = new Set();
  const save = () => {
    const checks = Object.values(s.apps).flatMap((e) => Object.values(e.checks));
    for (const ref of [...Object.values(s.fixtures), s.cleanup, s.readTail, ...checks.flatMap((c) => [c.raw, c.native, c.failure])]) {
      if (!ref || written.has(ref.path)) continue;
      writeFileSync(join(folder, ref.path), f.artifacts.get(ref.path)); written.add(ref.path);
    }
    writeFileSync(join(folder, "summary.json"), JSON.stringify(s)); };
  const compose = (native) => composePhase(binding, native, { cleanupComplete: true, resources: "verified" },
    [{ terminal: true, code: 1, error: null, cancelled: false, forced: false, success: false }]);
  save();
  const positive = await inspectNative(binding, folder);
  assert.equal(positive.status, "failed"); assert.equal(positive.attemptComplete, true);
  assert.equal(compose(positive).outcome, "native-validated");
  assert.ok(compose(positive).appOutcomes.every((r) => !r.comparisonEligible));
  return { f, s, checked, binding, save, compose, folder, original: checked.raw };
}
for (const role of ["app", "upstream"]) for (const field of ["command", "entrypoint", "path", "args"])
  test(`saved negative JSON ${role} ${field} substitution cannot become a native-validated failed target`, async () => {
    const { f, s, checked, binding, save, compose, folder, original } = await (negativeExecution ??= executionFixture());
    const raw = f.load(original), receipt = role === "app" ? raw.runtime : raw.participants[role];
    receipt.configuration[field] = field === "path" ? "/unreviewed/node" : ["/unreviewed/node", "--eval", "process.exit(1)"];
    checked.raw = f.put(raw); save();
    const report = inspectJson(s, { load: f.load });
    assert.equal(report.attemptComplete, false, `${role}/${field}`); assert.equal(report.baseline, false);
    const native = await inspectNative(binding, folder);
    assert.equal(native.status, "invalid", `${role}/${field}`); assert.equal(native.attemptComplete, false);
    assert.notEqual(compose(native).outcome, "native-validated");
    checked.raw = original; save(); assert.equal((await inspectNative(binding, folder)).attemptComplete, true);
  });
