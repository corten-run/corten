import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchors, cpuOf, dropletLines, merged, mergedConformance, onePassNoise, partName, partsOf, planOf, ratioCell, readPlan, split } from "./split.mjs";
import { ssrOf } from "./ssr.mjs";

const catalog = ["corten", "nextjs", "tanstack-start", "sveltekit", "leptos", "django", "axum-maud", "gin", "aspnet-aot"];

test("one droplet runs every app; several each run the anchors and a share dealt in catalog order", () => {
  assert.deepEqual(split(catalog, 1), [catalog]);
  assert.deepEqual(split(catalog, 3), [
    ["corten", "nextjs", "leptos", "axum-maud", "aspnet-aot"],
    ["corten", "tanstack-start", "django", "axum-maud"],
    ["corten", "sveltekit", "axum-maud", "gin"],
  ]);
  // Every app other than the anchors is on exactly one droplet.
  const shares = split(catalog, 4).flat().filter((n) => !anchors.includes(n));
  assert.deepEqual([...shares].sort(), catalog.filter((n) => !anchors.includes(n)).sort());
  assert.throws(() => split(["corten", "nextjs", "leptos"], 2), /must include axum-maud/);
  assert.throws(() => split(catalog, 8), /8 droplets need at least 8 apps besides corten and axum-maud/);
  assert.throws(() => split(catalog, 0), /count of droplets/);
});

test("a plan names each droplet's round after the round's, from d1", () => {
  const plan = planOf("r90", "defaults", 3, split(catalog, 2));
  assert.deepEqual(plan.droplets.map((d) => d.round), ["r90-d1", "r90-d2"]);
  assert.equal(partName("m4", 2), "m4-d2");
  assert.equal(plan.passes, 3);
  assert.deepEqual(plan.anchors, anchors);
});

test("the CPU model comes from lscpu's Model name, not the BIOS's", () => {
  const lscpu = "Vendor ID:                               GenuineIntel\nBIOS Vendor ID:                          QEMU\nModel name:                              Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz\nBIOS Model name:                         pc-i440fx-6.1  CPU @ 2.0GHz\n";
  assert.equal(cpuOf(lscpu), "Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz");
  assert.equal(cpuOf("no lscpu here"), null);
});

/** A k6 summary of a 60-second phase. @param {number} rps */
const k6 = (rps) => ({
  metrics: {
    http_reqs: { rate: rps, count: rps * 60 },
    dropped_iterations: { count: 0 },
    http_req_failed: { value: 0 },
    http_req_duration: { "p(50)": 1, "p(95)": 2, "p(99)": 3 },
  },
});

/**
 * A results folder with one round per droplet, each shaped as results/r<n> is after a collect:
 * its raw fixture/ files as run-ssr.mjs writes them, summary.json from them (ssrOf, as
 * summarize.mjs does), host.txt, run.log and conformance.json. `apps` gives each droplet's apps as
 * { app: [rps of each pass] } (one pass, or three with passes.json); every phase runs at that rate
 * with 60 CPU-seconds, so requests per CPU-second equals the rate.
 * @param {Record<string, { cpu?: string, finished?: boolean, imagesFrom?: string, tier?: string, apps: Record<string, number[]> }>} droplets
 * @param {(results: string) => void} body
 */
function withRound(droplets, body) {
  const results = mkdtempSync(join(tmpdir(), "split-test-"));
  try {
    for (const [round, d] of Object.entries(droplets)) {
      const dir = join(results, round);
      const raw = join(dir, "fixture");
      mkdirSync(raw, { recursive: true });
      const put = (/** @type {string} */ file, /** @type {unknown} */ value) => writeFileSync(join(raw, file), JSON.stringify(value));
      const passes = Math.max(...Object.values(d.apps).map((r) => r.length));
      if (passes > 1) put("passes.json", { passes });
      for (const [app, rates] of Object.entries(d.apps)) {
        rates.forEach((rps, i) => {
          const suffix = i === 0 ? "" : `-p${i + 1}`;
          put(`${app}-startup${suffix}.json`, { firstOkMsFromDockerRun: 100 });
          for (const phase of ["fixed", "sat64", "sat256"]) {
            put(`${app}-${phase}${suffix}.json`, k6(rps));
            put(`${app}-${phase}${suffix}-cpu.json`, { [`fsw-${app}`]: { usec: 60e6 } });
            put(`${app}-${phase}${suffix}-stats.json`, { [`fsw-${app}`]: { cpuAvgPct: 99, memAvgMiB: 10, memMaxMiB: 20 } });
          }
        });
      }
      const names = Object.keys(d.apps);
      const coldStart = Object.fromEntries(names.map((n) => [n, { firstOkMs: { median: 10, min: 9, max: 12 }, memAfterFirstRequest: "1MiB", imageMB: 100 }]));
      const summary = { tier: d.tier ?? "defaults", ssr: ssrOf(dir, names), build: null, dockerRebuild: null, rustAnalyzer: null, coldStart, bytes: null, instructions: Object.fromEntries(names.map((n) => [`${n}/page`, { user: 1000, kernel: 100, runs: 3, failed: 0 }])), browser: {} };
      writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));
      writeFileSync(join(dir, "host.txt"), `Architecture:                            x86_64\nModel name:                              ${d.cpu ?? "Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz"}\nBIOS Model name:                         pc-i440fx-6.1  CPU @ 2.0GHz\n`);
      writeFileSync(join(dir, "run.log"), `2026-11-12T01:00:00.000Z node summarize.mjs ${round}\n${d.finished === false ? "" : "2026-11-12T01:00:05.000Z all done\n"}`);
      writeFileSync(join(dir, "conformance.json"), JSON.stringify({ format: 2, tier: "defaults", commit: null, dirty: null, imagesFrom: d.imagesFrom ?? "abc", date: "2026-11-12T00:00:00.000Z", apps: names, results: Object.fromEntries(names.map((n) => [n, { image: `sha256:${n}`, on: round }])) }));
    }
    body(results);
  } finally {
    rmSync(results, { recursive: true, force: true });
  }
}

/** The plan of droplets r90-d1, r90-d2, ... with the apps withRound gave them. @param {Record<string, { apps: Record<string, number[]> }>} droplets */
const planFor = (droplets) => ({ ...planOf("r90", "defaults", 1, Object.values(droplets).map((d) => catalog.filter((n) => n in d.apps))) });

test("the merged round takes each app from its droplet, the anchors from the first, and gives each a ratio to Corten on its own", () => {
  const droplets = {
    "r90-d1": { apps: { corten: [20000], nextjs: [2000], "axum-maud": [24000] } },
    "r90-d2": { cpu: "Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz", apps: { corten: [25000], leptos: [10000], "axum-maud": [30000] } },
  };
  withRound(droplets, (results) => {
    const parts = partsOf(results, planFor(droplets));
    const s = merged(parts, catalog);
    assert.deepEqual(s.droplets.map((/** @type {any} */ d) => [d.round, d.cpu]), [["r90-d1", "Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz"], ["r90-d2", "Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz"]]);
    // Rows in catalog order; Corten and the anchor are the first droplet's.
    assert.deepEqual(Object.keys(s.ssr.fixture), ["corten", "nextjs", "leptos", "axum-maud"]);
    assert.equal(s.ssr.fixture.corten.sat64.rps, 20000);
    assert.equal(s.ssr.fixture.corten.toCorten, undefined);
    // Raw numbers beside ratios to Corten on the same droplet: leptos ran beside a faster Corten.
    assert.equal(s.ssr.fixture.nextjs.sat64.rps, 2000);
    assert.deepEqual(s.ssr.fixture.nextjs.toCorten, { fixed: { perCpuSecond: 0.1 }, sat64: { rps: 0.1, perCpuSecond: 0.1 }, sat256: { rps: 0.1, perCpuSecond: 0.1 } });
    assert.equal(s.ssr.fixture.leptos.sat64.rps, 10000);
    assert.equal(s.ssr.fixture.leptos.toCorten.sat64.rps, 0.4);
    assert.equal(s.ssr.fixture["axum-maud"].toCorten.sat64.rps, 1.2);
    // The other tables are merged the same way.
    assert.deepEqual(Object.keys(s.coldStart), ["corten", "nextjs", "leptos", "axum-maud"]);
    assert.deepEqual(Object.keys(s.instructions), ["corten/page", "nextjs/page", "leptos/page", "axum-maud/page"]);
    assert.equal(s.build, null);
    // Corten 25% apart in one pass: past caveat 1's 10%, and with two droplets both are flagged.
    const between = s.betweenDroplets.fixture.corten.sat64.rps;
    assert.deepEqual(between.values, { "r90-d1": 20000, "r90-d2": 25000 });
    assert.equal(between.spreadPct, 25);
    assert.deepEqual(between.flagged, ["r90-d1", "r90-d2"]);
    assert.ok(s.flagged.some((/** @type {any} */ f) => f.droplet === "r90-d2" && f.app === "axum-maud" && f.phase === "fixed" && f.key === "perCpuSecond"));
  });
});

test("in one pass a droplet is flagged when it is more than 10% from every other droplet", () => {
  assert.equal(onePassNoise, 0.1);
  const droplets = {
    "r90-d1": { apps: { corten: [20000], nextjs: [1], "axum-maud": [24000] } },
    "r90-d2": { apps: { corten: [20500], leptos: [1], "axum-maud": [24400] } },
    "r90-d3": { apps: { corten: [17000], gin: [1], "axum-maud": [23000] } },
  };
  withRound(droplets, (results) => {
    const s = merged(partsOf(results, planFor(droplets)), catalog);
    // d3's Corten is 15% under d1's and 17% under d2's; d1 and d2 are 2.5% apart, within noise.
    assert.deepEqual(s.betweenDroplets.fixture.corten.sat64.rps.flagged, ["r90-d3"]);
    // Its anchor is within 10% of both: not flagged.
    assert.deepEqual(s.betweenDroplets.fixture["axum-maud"].sat64.rps.flagged, []);
    assert.deepEqual([...new Set(s.flagged.map((/** @type {any} */ f) => `${f.droplet} ${f.app}`))], ["r90-d3 corten"]);
    const lines = dropletLines(s);
    // One line for the droplet's Corten, naming every number it is apart on.
    assert.deepEqual(lines.filter((l) => l.startsWith("FLAGGED")), ["FLAGGED: r90-d3's corten differs from every other droplet's by more than the noise in 5 numbers: fixture fixed /CPU-s, fixture 64 users /s, fixture 64 users /CPU-s, fixture 256 users /s, fixture 256 users /CPU-s"]);
    // The spread is the range over the median: 3,500 over 20,000.
    assert.ok(lines.includes("| fixture/corten 64 users /s | 20000 | 20500 | 17000 | 17.5% FLAGGED r90-d3 |"), lines.join("\n"));
    assert.ok(lines.includes("| r90-d3 | Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz | corten, axum-maud, gin |"));
  });
});

test("with passes, droplets are within noise when their ranges overlap, whatever their medians", () => {
  const droplets = {
    // Medians 20,000 and 22,500 (12.5% apart), but the ranges overlap: within noise.
    "r90-d1": { apps: { corten: [20000, 18000, 23000], nextjs: [1, 1, 1], "axum-maud": [24000, 24100, 24200] } },
    // The anchor's median is only 4% from d1's, but its passes do not overlap d1's: flagged.
    "r90-d2": { apps: { corten: [22500, 21000, 24000], leptos: [1, 1, 1], "axum-maud": [25000, 25100, 25200] } },
  };
  withRound(droplets, (results) => {
    const s = merged(partsOf(results, planFor(droplets)), catalog);
    const corten = s.betweenDroplets.fixture.corten.sat64.rps;
    assert.deepEqual(corten.values, { "r90-d1": 20000, "r90-d2": 22500 });
    assert.deepEqual(corten.ranges, { "r90-d1": [18000, 23000], "r90-d2": [21000, 24000] });
    assert.deepEqual(corten.flagged, []);
    assert.deepEqual(s.betweenDroplets.fixture["axum-maud"].sat64.rps.flagged, ["r90-d1", "r90-d2"]);
    // Each droplet's own ~ against its own Corten is kept.
    assert.equal(s.ssr.fixture.leptos.sat64.withinNoiseOfCorten.rps, false);
    assert.ok(dropletLines(s).includes("| fixture/corten 64 users /s | 20000 (18000-23000) | 22500 (21000-24000) | 12.5% |"));
  });
});

test("a round is merged only once every droplet has finished", () => {
  const droplets = {
    "r90-d1": { apps: { corten: [20000], nextjs: [2000], "axum-maud": [24000] } },
    "r90-d2": { finished: false, apps: { corten: [20000], leptos: [2000], "axum-maud": [24000] } },
  };
  withRound(droplets, (results) => {
    assert.throws(() => partsOf(results, planFor(droplets)), /round r90 has not finished: r90-d2 has not finished here/);
    rmSync(join(results, "r90-d1"), { recursive: true });
    assert.throws(() => partsOf(results, planFor(droplets)), /r90-d1, r90-d2 have not finished/);
  });
});

test("droplets of different tiers, an app on two droplets or images of two trees are not one round", () => {
  const tiers = {
    "r90-d1": { apps: { corten: [1], nextjs: [1], "axum-maud": [1] } },
    "r90-d2": { tier: "matched", apps: { corten: [1], leptos: [1], "axum-maud": [1] } },
  };
  withRound(tiers, (results) => assert.throws(() => merged(partsOf(results, planFor(tiers))), /differ in tier/));
  const twice = {
    "r90-d1": { apps: { corten: [1], nextjs: [1], "axum-maud": [1] } },
    "r90-d2": { apps: { corten: [1], nextjs: [1], "axum-maud": [1] } },
  };
  withRound(twice, (results) => assert.throws(() => merged(partsOf(results, planFor(twice))), /nextjs ran on r90-d1 and r90-d2/));
  const trees = {
    "r90-d1": { apps: { corten: [1], nextjs: [1], "axum-maud": [1] } },
    "r90-d2": { imagesFrom: "def", apps: { corten: [1], leptos: [1], "axum-maud": [1] } },
  };
  withRound(trees, (results) => assert.throws(() => mergedConformance(partsOf(results, planFor(trees))), /built from different trees/));
});

test("the merged feature matrix has every app once, the anchors from the first droplet", () => {
  const droplets = {
    "r90-d1": { apps: { corten: [1], nextjs: [1], "axum-maud": [1] } },
    "r90-d2": { apps: { corten: [1], leptos: [1], "axum-maud": [1] } },
  };
  withRound(droplets, (results) => {
    const c = /** @type {any} */ (mergedConformance(partsOf(results, planFor(droplets)), catalog));
    assert.deepEqual(c.apps, ["corten", "nextjs", "leptos", "axum-maud"]);
    assert.equal(c.imagesFrom, "abc");
    assert.equal(c.results.corten.on, "r90-d1");
    assert.equal(c.results.leptos.on, "r90-d2");
  });
});

test("a round with no plan is a round of one droplet", () => {
  const dir = mkdtempSync(join(tmpdir(), "split-plan-"));
  try {
    assert.equal(readPlan(dir), null);
    writeFileSync(join(dir, "droplets.json"), JSON.stringify(planOf("r90", "defaults", 1, split(catalog, 2))));
    assert.deepEqual(readPlan(dir)?.droplets.map((d) => d.round), ["r90-d1", "r90-d2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an SSR row's ratio cell", () => {
  assert.equal(ratioCell({}), "");
  assert.equal(ratioCell({ toCorten: { fixed: { perCpuSecond: 0.5 }, sat64: { rps: 0.4, perCpuSecond: null } } }), "to corten: fixed 0.5x /CPU-s, 64 users 0.4x /s - /CPU-s, 256 users - /s");
});
