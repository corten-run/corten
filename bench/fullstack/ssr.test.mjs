import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { edgeOf, ssrOf } from "./ssr.mjs";

/** A raw folder of fixture results, removed after `body`. @param {(raw: string, put: (file: string, value: unknown) => void) => void} body */
function withRaw(body) {
  const raw = mkdtempSync(join(tmpdir(), "ssr-test-"));
  try {
    mkdirSync(join(raw, "fixture"));
    body(raw, (file, value) => writeFileSync(join(raw, "fixture", file), JSON.stringify(value)));
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
}

/** A k6 summary of a 60-second phase. @param {number} rps @param {number} [dropped] @param {number} [failed] */
const k6 = (rps, dropped = 0, failed = 0) => ({
  metrics: {
    http_reqs: { rate: rps, count: rps * 60 },
    dropped_iterations: { count: dropped },
    http_req_failed: { value: failed },
    http_req_duration: { "p(50)": 1, "p(95)": 2, "p(99)": 3 },
  },
});

/** One pass of an app: every phase at `rps`, its CPU counted at `cpuS` seconds a phase. */
function pass(/** @type {(f: string, v: unknown) => void} */ put, /** @type {string} */ app, /** @type {string} */ suffix, /** @type {number} */ rps, /** @type {number} */ cpuS) {
  put(`${app}-startup${suffix}.json`, { firstOkMsFromDockerRun: 100 });
  for (const phase of ["fixed", "sat64", "sat256"]) {
    put(`${app}-${phase}${suffix}.json`, k6(rps));
    put(`${app}-${phase}${suffix}-cpu.json`, { [`fsw-${app}`]: { usec: cpuS * 1e6 } });
    put(`${app}-${phase}${suffix}-stats.json`, { [`fsw-${app}`]: { cpuAvgPct: 99, memAvgMiB: 10, memMaxMiB: 20 } });
  }
}

test("one pass reads as a round of one pass always has: no passes, no range", () => {
  withRaw((raw, put) => {
    pass(put, "corten", "", 300, 12);
    const corten = ssrOf(raw, ["corten"]).fixture.corten;
    assert.equal(corten.fixed.rps, 300);
    assert.equal(corten.fixed.passes, undefined);
    assert.equal(corten.failed, undefined);
    // 12 CPU-seconds over 60 seconds is 20% of a CPU, counted; the sample said 99%.
    assert.equal(corten.fixed.cpuUsedPct, 20);
    assert.equal(corten.fixed.cpuPct, 99);
  });
});

test("through the edge: its counted CPU is the edge's numbers, and its samples are never read as the item API's", () => {
  withRaw((raw, put) => {
    pass(put, "corten", "", 300, 12);
    // The same phase reached through the edge: the edge counted at 6 CPU-seconds, sampled beside the app.
    put("corten-sat64-cpu.json", { "fsw-corten": { usec: 12e6 }, "fsw-edge": { usec: 6e6 } });
    put("corten-sat64-stats.json", { "fsw-corten": { cpuAvgPct: 99, memAvgMiB: 10, memMaxMiB: 20 }, "fsw-edge": { cpuAvgPct: 10, memAvgMiB: 5, memMaxMiB: 6 } });
    const corten = ssrOf(raw, ["corten"]).fixture.corten;
    // 18,000 requests over 6 CPU-seconds, 10% of a CPU over the 60-second phase.
    assert.equal(corten.sat64.edgePerCpuSecond, 3000);
    assert.equal(corten.sat64.edgeCpuUsedPct, 10);
    assert.equal(corten.sat64.apiCpuPct, null, "the edge's samples are not the item API's");
    assert.equal(corten.fixed.edgePerCpuSecond, null, "a phase reached directly has no edge numbers");
    assert.equal(corten.sat64.edgeBound, null, "with no edge.json, whether it was bound is not known");
    // The edge had one core and used 10% of a CPU: not bound. Then 95% of it: bound.
    put("edge.json", { cores: 1 });
    assert.equal(ssrOf(raw, ["corten"]).fixture.corten.sat64.edgeBound, false);
    put("corten-sat64-cpu.json", { "fsw-corten": { usec: 12e6 }, "fsw-edge": { usec: 57e6 } });
    assert.equal(ssrOf(raw, ["corten"]).fixture.corten.sat64.edgeBound, true);
    put("corten-sat64-cpu.json", { "fsw-corten": { usec: 12e6 }, "fsw-edge": { usec: 6e6 } });
    // With the item API sampled too, it is still the entry that is neither the app nor the edge.
    put("corten-sat64-stats.json", { "fsw-corten": { cpuAvgPct: 99 }, "fsw-edge": { cpuAvgPct: 10 }, "item-api": { cpuAvgPct: 40 } });
    assert.equal(ssrOf(raw, ["corten"]).fixture.corten.sat64.apiCpuPct, 40);
  });
});

test("through the edge, a phase whose app was not busy is marked, and so is one k6 limited", () => {
  withRaw((raw, put) => {
    pass(put, "corten", "", 300, 12);
    assert.equal(edgeOf(raw), false, "a round reached directly has no edge.json");
    put("edge.json", { cores: 6 });
    // 18,000 requests in 60 s; the app counted at 36 CPU-seconds is 60% of its core.
    put("corten-sat64-cpu.json", { "fsw-corten": { usec: 36e6 }, "fsw-edge": { usec: 60e6 }, k6: { usec: 30e6, cores: 6 } });
    let sat64 = ssrOf(raw, ["corten"]).fixture.corten.sat64;
    assert.equal(sat64.appIdle, true);
    assert.equal(sat64.edgeBound, false);
    assert.equal(sat64.k6CpuUsedPct, 50);
    assert.equal(sat64.loadBound, false);
    // The app at 95% of its core is not idle; k6 at 5.5 of its 6 cores set the rate.
    put("corten-sat64-cpu.json", { "fsw-corten": { usec: 57e6 }, "fsw-edge": { usec: 60e6 }, k6: { usec: 330e6, cores: 6 } });
    sat64 = ssrOf(raw, ["corten"]).fixture.corten.sat64;
    assert.equal(sat64.appIdle, false);
    assert.equal(sat64.loadBound, true);
    // Reached directly, an app that was not busy is not said to be idle: only the edge's tier says it.
    put("corten-sat64-cpu.json", { "fsw-corten": { usec: 36e6 } });
    assert.equal(ssrOf(raw, ["corten"]).fixture.corten.sat64.appIdle, null);
    // The fixed rate's app is meant to be idle, so through the edge too it is not said.
    put("corten-fixed-cpu.json", { "fsw-corten": { usec: 6e6 }, "fsw-edge": { usec: 12e6 } });
    assert.equal(ssrOf(raw, ["corten"]).fixture.corten.fixed.appIdle, null);
    // The round went through the edge: a load folder has edge.json (the fixture one, here).
    assert.equal(edgeOf(raw), true);
  });
});

test("every pass asked for is read: one that did not start fails the app, and the passes after it still count", () => {
  withRaw((raw, put) => {
    put("passes.json", { passes: 3 });
    for (const [suffix, rps] of [["", 300], ["-p2", 310], ["-p3", 290]]) pass(put, "corten", /** @type {string} */ (suffix), /** @type {number} */ (rps), 12);
    pass(put, "other", "", 200, 12);
    put("other-startup-p2.json", { failed: "never answered /items/1 within a minute" });
    pass(put, "other", "-p3", 220, 12);
    const ssr = ssrOf(raw, ["corten", "other"]).fixture;
    assert.equal(ssr.corten.fixed.passes, 3);
    assert.equal(ssr.corten.fixed.asked, undefined);
    assert.deepEqual(ssr.corten.sat64.range.rps, [290, 310]);
    assert.equal(ssr.other.failed, "never answered /items/1 within a minute (pass 2)");
    assert.equal(ssr.other.sat64.passes, 2);
    assert.equal(ssr.other.sat64.asked, 3);
    assert.deepEqual(ssr.other.sat64.range.rps, [200, 220]);
  });
});

test("a pass that could not hold the fixed rate fails the app, said with that pass's own numbers", () => {
  withRaw((raw, put) => {
    put("passes.json", { passes: 3 });
    for (const suffix of ["", "-p2", "-p3"]) pass(put, "corten", suffix, 300, 12);
    // Pass 3 sent a fifth fewer; its median rate is pass 1's.
    put("corten-fixed-p3.json", k6(240, 4500));
    const corten = ssrOf(raw, ["corten"]).fixture.corten;
    assert.equal(corten.fixed.rps, 300);
    assert.equal(corten.failed, "served 240/s of the fixed rate, 23.81% never sent (pass 3)");
  });
});

test("within noise of Corten is said where both have passes, and not of the rate at the fixed rate", () => {
  withRaw((raw, put) => {
    put("passes.json", { passes: 3 });
    for (const [suffix, a, b] of [["", 300, 305], ["-p2", 310, 330], ["-p3", 290, 320]]) {
      pass(put, "corten", /** @type {string} */ (suffix), /** @type {number} */ (a), 12);
      pass(put, "other", /** @type {string} */ (suffix), /** @type {number} */ (b), 12);
    }
    const other = ssrOf(raw, ["corten", "other"]).fixture.other;
    assert.equal(other.sat64.withinNoiseOfCorten.rps, true);
    assert.equal("rps" in other.fixed.withinNoiseOfCorten, false);
  });
});
