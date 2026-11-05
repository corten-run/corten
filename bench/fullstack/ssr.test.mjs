import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ssrOf } from "./ssr.mjs";

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
