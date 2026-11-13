import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { options, qualifyAndMeasure, finishRun, serve } from "./run.mjs";
import { here } from "./build.mjs";
import { selectedApps } from "../workloads/registry.mjs";

test("explicit bounded round/fixture inputs and no contender filter", () => {
  const o = options(["bounded", "--rows", "14", "--large", "194", "--append", "3", "--cards", "8"]);
  assert.equal(o.workload.largeRowCount, 194);
  assert.deepEqual(selectedApps("client-heavy"), ["corten", "react", "vue", "solid", "svelte", "remix"]);
  for (const args of [[], ["../x"], ["x", "--apps", "corten"], ["x", "--rows", "0"], ["x", "--rows", "8", "--rows", "8"], ["x", "--observation-ms", "0"], ["x", "--timeout-ms", "1"], ["x", "--rows"]]) assert.throws(() => options(args));
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
    const result = await qualifyAndMeasure(async (phase) => { calls.push(phase); return { oracle: { functionalPassed: phase === "qualification" || measuredPass } }; });
    assert.deepEqual(calls, ["qualification", "measurement"]);
    assert.equal(result.readyForMeasurement, measuredPass);
  }
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
