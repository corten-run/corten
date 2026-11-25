import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectHeadroom, headroomBounds, phaseHeadroom, renderHeadroom } from "./headroom.mjs";

const t0 = 1795558273850, seconds = 30;
// One synthetic raw phase in the saved json-api-timed-phase/v1 shape, at 500 ms samples.
function raw({ app = "corten", key = "catalog-v1-fixture-neutral-json", pass = 1, phase = "warmup", requests = 600000,
  load = 380, upstream = 0.05, appUs = 22e6, upUs = null, loadPeak = load, upstreamPeak = upstream, stray = null } = {}) {
  const samples = (cpu, peak) => Array.from({ length: 60 }, (_, i) => ({ t: t0 + 250 + i * 500, cpu: i === 30 ? peak : cpu, mem: 40 }));
  const r = {
    schema: "json-api-timed-phase/v1", phase,
    identity: { app, key, pass, cpus: { app: { quota: 1 }, load: { quota: 4 }, api: { quota: 2 } } },
    command: { clock: { startedAt: t0, finishedAt: t0 + seconds * 1000 + 800 } },
    after: { liveness: { load: { startedAt: new Date(t0 + 100).toISOString(), finishedAt: new Date(t0 + seconds * 1000 + 700).toISOString() } } },
    clock: { k6DurationMs: seconds * 1000 },
    samples: { app: samples(70, 85), upstream: samples(upstream, upstreamPeak), load: samples(load, loadPeak) },
    counters: { app: { before: 1000, after: 1000 + appUs }, ...(upUs === null ? {} : { upstream: { before: 50, after: 50 + upUs } }) },
    k6: { metrics: { http_reqs: { count: requests }, http_req_failed: { passes: 0 }, dropped_iterations: { count: 0 }, json_timeout: { count: 0 } } },
    captureErrors: [],
  };
  if (stray !== null) r.samples.load.push({ t: t0 + seconds * 1000 + 790, cpu: stray, mem: 40 });
  return r;
}

test("a closed fixture phase whose generator is at its quota names the generator, not the app", () => {
  const row = phaseHeadroom(raw({ load: 390, loadPeak: 399.3, requests: 649684, appUs: 22.24e6 }));
  assert.equal(row.rps, 21656);
  assert.deepEqual(row.atBound, { load: true, upstreamSampled: false, upstreamCounted: false });
  assert.equal(row.nearestLimit, "generator");
  assert.equal(row.load.maxPct, 399.3); assert.equal(row.load.boundPct, 320);
  assert.equal(row.app.countedPct, 74.1);
  // 21,656 req/s at a 399.3% peak reaches the 320% bound near 17,355 req/s; the app's one
  // core would carry about 29,200, which needs about 6.7 generator cores below the bound.
  assert.equal(row.estimates.rateAtLoadBound, 17355);
  assert.equal(row.estimates.appCapacity, 29212);
  assert.equal(row.estimates.generatorCoresForAppCapacity, 6.73);
  assert.equal(row.estimates.rateAtUpstreamBound, null);
  assert.equal(row.perRequestUs.app, 34.2);
});

test("an API phase separates a sampled upstream peak from its counted average", () => {
  const row = phaseHeadroom(raw({ key: "catalog-v1-api-neutral-json", requests: 213986, load: 185, loadPeak: 201.17,
    upstream: 69, upstreamPeak: 102.3, appUs: 29.79e6, upUs: 21.12e6 }));
  assert.deepEqual(row.atBound, { load: false, upstreamSampled: true, upstreamCounted: false });
  assert.equal(row.upstream.countedPct, 70.4);
  assert.equal(row.nearestLimit, "app");
  assert.equal(row.estimates.rateAtUpstreamBound, 5578);
  assert.equal(row.estimates.headroomRate, 5578);
  assert.equal(row.perRequestUs.upstream, 98.7);
});

test("bounds compare as production.mjs does: at the bound is out of headroom", () => {
  for (const [peak, expected] of [[319.99, false], [320, true]]) assert.equal(phaseHeadroom(raw({ load: 200, loadPeak: peak })).atBound.load, expected);
  const api = (peak, upUs) => phaseHeadroom(raw({ key: "marketplace-v2-api-neutral-json", upstream: 40, upstreamPeak: peak, upUs })).atBound;
  assert.equal(api(79.99, 1e6).upstreamSampled, false); assert.equal(api(80, 1e6).upstreamSampled, true);
  assert.equal(api(10, 23.99e6).upstreamCounted, false); assert.equal(api(10, 24e6).upstreamCounted, true);
  // A fixture phase is never held to the upstream bounds, however busy its idle upstream looks.
  assert.deepEqual(phaseHeadroom(raw({ upstream: 90, upstreamPeak: 95 })).atBound, { load: true, upstreamSampled: false, upstreamCounted: false });
});

test("generator samples outside the native k6 lifetime do not count, as in production.mjs", () => {
  const row = phaseHeadroom(raw({ load: 200, loadPeak: 210, stray: 399 }));
  assert.equal(row.load.maxPct, 210); assert.equal(row.atBound.load, false);
});

test("the bounds mirror production.mjs", () => {
  const source = readFileSync(new URL("./production.mjs", import.meta.url), "utf8");
  assert.ok(source.includes(`stats.load.cpuMaxPct >= expected.cpus.load.quota * ${headroomBounds.loadPctOfQuotaCore}`));
  assert.ok(source.includes(`stats.upstream.cpuMaxPct >= ${headroomBounds.upstreamPctOfOneCore}`));
  assert.ok(source.includes(`/ (raw.clock.k6DurationMs * 10) >= ${headroomBounds.upstreamPctOfOneCore}`));
});

test("a timing folder reports only phases of this checkout's matrix at their own path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "json-headroom-"));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const put = (parts, value) => { mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true }); writeFileSync(join(root, ...parts), JSON.stringify(value)); };
  put(["corten", "catalog-v1-fixture-neutral-json", "p1", "warmup.json"], raw({ loadPeak: 399 }));
  put(["drogon", "catalog-v1-fixture-neutral-json", "p2", "sat64.json"], raw({ app: "drogon", pass: 2, phase: "sat64", load: 150 }));
  const canary = "Zq7canaryValue";
  put([canary, "catalog-v1-fixture-neutral-json", "p1", "warmup.json"], raw({ app: canary }));
  put(["corten", "catalog-v1-fixture-neutral-json", "p3", "warmup.json"], raw({ pass: 1 }));
  put(["corten", "catalog-v1-fixture-neutral-json", "p2", "warmup.json"], { ...raw({ pass: 2 }), schema: canary });
  put(["corten", "catalog-v1-fixture-neutral-json", "p4", "fixed.json"], "{not json");
  const result = collectHeadroom(root);
  assert.equal(result.rows.length, 2); assert.equal(result.refusedFiles, 4);
  assert.deepEqual(result.rows.map((r) => [r.identity.app, r.identity.phase, r.atBound.load]), [["corten", "warmup", true], ["drogon", "sat64", false]]);
  const markdown = renderHeadroom(result);
  assert.match(markdown, /\| corten \| catalog-v1-fixture-neutral-json \| 1 \| warmup \| 20000 \| 399\/380\.4 \(320\) \|/);
  assert.match(markdown, /4 file\(s\) were not phases/);
  assert.ok(!markdown.includes(canary));

  const cli = fileURLToPath(new URL("./headroom.mjs", import.meta.url));
  const json = spawnSync(process.execPath, [cli, root, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).schema, "json-api-headroom/v1");
  assert.ok(!json.stdout.includes(canary));
  const bad = spawnSync(process.execPath, [cli, root, "--write"], { encoding: "utf8" });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /only --json/);
});
