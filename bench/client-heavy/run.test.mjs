import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { options, qualifyAndMeasure, captureComparison, finishRun, serve, run } from "./run.mjs";
import { here, root } from "./build.mjs";
import { Evidence } from "./evidence.mjs";
import { selectedApps } from "../workloads/registry.mjs";

// Unit gate fixture only, never native closure evidence.
const lifecycle = () => ({ close: { returned: true, observed: true }, deadline: { firedAt: null } });

for (const kind of ["invalid-policy", "missing-policy", "missing-manifest"]) test(`policy failure retains every candidate before any build (${kind})`, { timeout: 15000 }, async () => {
  const work = resolve(here, "work");
  await mkdir(work, { recursive: true });
  const scratch = await mkdtemp(join(work, "policy-accounting-")), out = join(scratch, "attempt");
  const input = resolve(root, kind === "missing-manifest" ? "bench/browser/package.json" : "bench/workloads/latest-stable.json");
  const read = fs.readFileSync;
  let reads = 0;
  mock.method(fs, "readFileSync", (path, ...args) => {
    if (resolve(String(path)) !== input) return read(path, ...args);
    reads++;
    if (kind === "invalid-policy") return Buffer.from("{");
    throw Object.assign(new Error("private policy input diagnostic"), { code: "ENOENT" });
  });
  syncBuiltinESMExports();
  // Exercise actual runner finalization without scanning unrelated installed trees.
  mock.method(Evidence.prototype, "source", async function(stage) {
    const value = { commit: null, entries: [], stage };
    await this.save(`evidence/source-${stage}.json`, value);
    return value;
  });
  try {
    const output = await run(["policy-accounting", "--out", out]);
    assert.equal(reads, 1);
    assert.equal(output.failure.reason, "candidate-policy-unavailable");
    assert.equal(output.latestStable, null);
    assert.equal(output.passed, false);
    assert.equal(output.collection.accounting, "complete");
    assert.equal(output.collection.rankingEligible, false);
    assert.deepEqual(output.selectedApps, selectedApps("client-heavy"));
    for (const app of output.selectedApps) {
      assert.equal(output.builds[app].outcome, "not-run");
      assert.equal(output.cells[app].outcome, "not-run");
      assert.equal(output.cells[app].qualification, null);
      assert.equal(output.cells[app].measurement, null);
      assert.equal(output.cells[app].readyForMeasurement, false);
      assert.deepEqual(JSON.parse(await readFile(join(out, `${app}.json`), "utf8")), output.cells[app]);
    }
    const saved = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
    assert.deepEqual(saved, output);
    assert.ok(!JSON.stringify(saved).includes("private policy input diagnostic"));
    assert.ok(output.terminal.resources.every((row) => row.state === "not-created"));
    const subject = JSON.parse(await readFile(join(out, "review-subject.json"), "utf8"));
    for (const app of output.selectedApps) assert.ok(subject.files.some((row) => row.path === `${app}.json`));
    await assert.rejects(run(["policy-accounting", "--out", out]), { code: "EEXIST" });
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    const rel = relative(work, scratch);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "remove only the owned scratch directory");
    await rm(scratch, { recursive: true });
  }
});

test("explicit bounded round/fixture inputs and no contender filter", () => {
  const o = options(["bounded", "--rows", "14", "--large", "194", "--append", "3", "--cards", "8"]);
  assert.equal(o.workload.largeRowCount, 194);
  assert.deepEqual(selectedApps("client-heavy"), ["corten", "react", "vue", "solid", "svelte", "remix"]);
  for (const args of [[], ["../x"], ["x", "--apps", "corten"], ["x", "--rows", "0"], ["x", "--rows", "8", "--rows", "8"], ["x", "--observation-ms", "0"], ["x", "--timeout-ms", "1"], ["x", "--rows"]]) assert.throws(() => options(args));
});

test("comparison profile is fixed and does not change diagnostic defaults", () => {
  const diagnostic = options(["diagnostic"]);
  const comparison = options(["comparison", "--profile", "client-heavy-comparison-v1"]);
  assert.equal(diagnostic.workload.rowCount, 14);
  assert.equal(comparison.workload.rowCount, 100);
  assert.equal(comparison.workload.largeRowCount, 1000);
  assert.equal(comparison.workload.appendCount, 100);
  assert.equal(comparison.workload.dashboardCount, 200);
  for (const override of [["--rows", "14"], ["--seed", "99"], ["--timeout-ms", "60000"], ["--cargo", "other"]])
    assert.throws(() => options(["comparison", "--profile", "client-heavy-comparison-v1", ...override]));
});

test("comparison completes qualification first, rotates the full roster and never retries a failed sample", async () => {
  const apps = selectedApps("client-heavy"), { measurementOrder } = options(["comparison", "--profile", "client-heavy-comparison-v1"]);
  assert.deepEqual(measurementOrder, [apps, [...apps.slice(2), ...apps.slice(0, 2)], [...apps.slice(4), ...apps.slice(0, 4)]]);
  const output = { selectedApps: apps, builds: Object.fromEntries(apps.map((app) => [app, { outcome: app === "solid" ? "not-run" : "built" }])),
    cells: { solid: { outcome: "unsupported", measurements: [] } } }, calls = [];
  await captureComparison(output, measurementOrder, async (app, phase) => {
    calls.push({ app, phase });
    return { oracle: { functionalPassed: !(app === "vue" && phase === "qualification") },
      lifecycle: { ...lifecycle(), contextCreatedAt: calls.length, deadline: { firedAt: app === "react" && calls.length === 7 ? 1 : null } } };
  }, () => {});
  assert.deepEqual(calls, [
    ...apps.filter((app) => app !== "solid").map((app) => ({ app, phase: "qualification" })),
    ...measurementOrder.flat().filter((app) => app !== "solid" && app !== "vue").map((app) => ({ app, phase: "measurement" })),
  ]);
  assert.equal(output.cells.vue.measurements.length, 0);
  assert.equal(output.cells.react.measurements.length, 3); assert.equal(output.cells.react.outcome, "failed");
  assert.equal(output.cells.corten.measurements.length, 3); assert.equal(output.cells.corten.outcome, "passed");
  assert.equal(output.cells.solid.outcome, "unsupported");
});

test("comparison retains an unclosed sample and does not start another context", async () => {
  const apps = selectedApps("client-heavy"), { measurementOrder } = options(["comparison", "--profile", "client-heavy-comparison-v1"]);
  const output = { selectedApps: apps, builds: Object.fromEntries(apps.map((app) => [app, { outcome: "built" }])), cells: {} };
  const closed = { ...lifecycle(), contextCreatedAt: 1 };
  let measured = 0;
  await assert.rejects(captureComparison(output, measurementOrder, async (_app, phase) => ({
    oracle: { functionalPassed: true }, lifecycle: phase === "qualification" ? closed
      : { ...closed, contextCreatedAt: ++measured, close: { returned: true, observed: false } },
  }), () => {}), /native-context-not-closed/);
  assert.equal(measured, 1);
  assert.equal(output.cells[apps[0]].measurements.length, 1);
  assert.equal(output.cells[apps[0]].readyForMeasurement, false);
});

test("unqualified native journey is never measured", async () => {
  for (const functionalPassed of [false, null]) {
    const calls = [];
    const result = await qualifyAndMeasure(async (phase) => { calls.push(phase); return { oracle: { functionalPassed } }; });
    assert.deepEqual(calls, ["qualification"]);
    assert.equal(result.measurement, null);
    assert.equal(result.readyForMeasurement, false);
  }
});

test("measurement happens only after qualification and must pass its own oracle", async () => {
  for (const measuredPass of [false, true]) {
    const calls = [];
    const result = await qualifyAndMeasure(async (phase) => { calls.push(phase); return { oracle: { functionalPassed: phase === "qualification" || measuredPass }, lifecycle: lifecycle() }; });
    assert.deepEqual(calls, ["qualification", "measurement"]);
    assert.equal(result.readyForMeasurement, measuredPass);
  }
});

test("an oracle pass without positive context closure cannot start or qualify measurement", async () => {
  for (const bad of [undefined, { close: { returned: true, observed: null }, deadline: { firedAt: null } },
    { close: { returned: false, observed: true }, deadline: { firedAt: null } },
    { close: { returned: true, observed: true }, deadline: { firedAt: 1 } }]) {
    const calls = [];
    const result = await qualifyAndMeasure(async (phase) => { calls.push(phase); return { oracle: { functionalPassed: true }, lifecycle: bad }; });
    assert.deepEqual(calls, ["qualification"]); assert.equal(result.readyForMeasurement, false);
    assert.equal(result.measurement, null);
  }
  const result = await qualifyAndMeasure(async (phase) => ({ oracle: { functionalPassed: true }, lifecycle: phase === "qualification" ? lifecycle() : undefined }));
  assert.equal(result.readyForMeasurement, false);
});

test("external build receipts and source-unbound generator binaries cannot qualify apps", () => {
  for (const flag of ["--built", "--generator"]) assert.throws(() => options(["forged", flag, "forged.json"]), /unknown/);
});

for (const interrupted of [false, true]) test(`failed browser cleanup still closes the server and saves evidence (${interrupted ? "interrupted" : "normal"})`, async () => {
  const work = resolve(here, "work");
  await mkdir(work, { recursive: true });
  const out = await mkdtemp(join(work, "cleanup-test-")), server = await serve(out);
  const failure = new Error("private browser cleanup diagnostic"), cells = { corten: { outcome: "passed" } };
  const output = { selectedApps: ["corten", "react"], cells, passed: true };
  let serverClosed = false, browserCloses = 0;
  const interruptCleanup = interrupted ? Promise.reject(failure) : undefined; interruptCleanup?.catch(() => {});
  try {
    await finishRun(output, out, { browser: { async close() { browserCloses++; throw failure; } },
      server: { async close() { await server.close(); serverClosed = true; } }, interruptCleanup, isInterrupted: () => interrupted });
    assert.equal(serverClosed, true);
    assert.equal(browserCloses, 1);
    await assert.rejects(fetch(server.url));
    const saved = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
    assert.equal(saved.passed, false);
    assert.equal(saved.cells.corten.outcome, "passed");
    assert.equal(saved.cells.react.reason, interrupted ? "native-runner-interrupted" : "runner-failed-before-adapter");
    assert.deepEqual(saved.cleanupFailures.map((f) => f.resource), interrupted ? ["browser-interrupt", "browser"] : ["browser"]);
    assert.ok(saved.cleanupFailures.every((f) => f.name === "Error" && /^[a-f0-9]{64}$/.test(f.diagnosticSha256)));
    assert.ok(!JSON.stringify(saved).includes(failure.message));
  } finally {
    if (!serverClosed) await server.close();
    const rel = relative(work, out);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "remove only the owned scratch directory");
    await rm(out, { recursive: true });
  }
});

test("server cleanup failure is saved and makes an otherwise passing run fail", async () => {
  const work = resolve(here, "work");
  await mkdir(work, { recursive: true });
  const out = await mkdtemp(join(work, "cleanup-test-"));
  const output = { selectedApps: [], cells: {}, passed: true };
  let browserClosed = false;
  try {
    await finishRun(output, out, { browser: { async close() { browserClosed = true; } },
      server: { async close() { throw new Error("server cleanup failed"); } }, isInterrupted: () => false });
    assert.equal(browserClosed, true);
    const saved = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
    assert.equal(saved.passed, false);
    assert.deepEqual(saved.cleanupFailures.map((f) => f.resource), ["server"]);
  } finally {
    const rel = relative(work, out);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    await rm(out, { recursive: true });
  }
});
