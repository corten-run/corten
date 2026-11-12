import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { options, qualifyAndMeasure, checkedBuild } from "./run.mjs";
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

test("native build reuse rejects different fixtures, contenders, sources and artifacts", { skip: !process.env.CLIENT_NATIVE_DIR && "Set CLIENT_NATIVE_DIR to a runner's native build directory" }, async () => {
  const directory = dirname(resolve(process.env.CLIENT_NATIVE_DIR));
  const path = join(directory, "result.json"), previous = JSON.parse(await readFile(path, "utf8"));
  const { effectiveWorkload: workload, provenance: { sources } } = previous;
  assert.equal((await checkedBuild(path, workload, sources)).directory, join(directory, "native"));
  await assert.rejects(checkedBuild(path, { ...workload, seed: workload.seed + 1 }, sources), /workload differs/);
  await assert.rejects(checkedBuild(path, workload, { ...sources, "bench/client-heavy/build.mjs": "changed" }), /stale native source/);
  const temporary = join(directory, `reuse-test-${randomUUID()}.json`);
  try {
    for (const [mutate, message] of [
      [(r) => r.selectedApps.pop(), /contender set differs/],
      [(r) => r.builds.react.inputs[0].sha256 = "changed", /stale native input/],
      [(r) => r.builds.react.artifacts["app.js"] = "changed", /stale native artifact/],
      [(r) => delete r.builds.corten.artifacts["views.js"], /incomplete native artifacts/],
    ]) {
      const changed = structuredClone(previous); mutate(changed);
      await writeFile(temporary, JSON.stringify(changed));
      await assert.rejects(checkedBuild(temporary, workload, sources), message);
    }
  } finally { await rm(temporary, { force: true }); }
});
