import assert from "node:assert/strict";
import test from "node:test";
import { options, qualifyAndMeasure } from "./run.mjs";
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
