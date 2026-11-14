import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { phases, readLoad } from "../../catalog/contract.mjs";
import { readOutcome } from "../../marketplace/run-contract.mjs";
import { summarizeSamples } from "../../catalog/stats.mjs";
import { inside, tree } from "./evidence.mjs";
import { inspectRawSupport } from "./raw-support.mjs";

for (const group of ["catalog-page", "localized-marketplace"]) test(`${group}: existing raw load/cold/check/CPU/sample files replay diagnostically, never qualify`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "isolated-raw-support-"));
  t.after(() => { assert.ok(inside(resolve(tmpdir()), resolve(root))); rmSync(root, { recursive: true, force: true }); });
  const marketplace = group === "localized-marketplace", name = "native-corten", samples = [{ cpu: 40, mem: 8 }, { cpu: 60, mem: 10 }];
  const k6 = { metrics: { http_reqs: { values: { count: 100, rate: 10 } }, iterations: { values: { count: 100, rate: 10 } },
    vus_max: { values: { value: 64, min: 64, max: 64 } },
    http_req_duration: { values: { avg: 2, "p(50)": 1, "p(95)": 3, "p(99)": 4, max: 5 } },
    iteration_duration: { values: { avg: 2, "p(50)": 1, "p(95)": 3, "p(99)": 4, max: 5 } },
    http_req_failed: { values: { rate: 0, passes: 0, fails: 100 } }, checks: { values: { rate: 1, passes: 200, fails: 0 } }, dropped_iterations: { values: { count: 0 } } },
    root_group: { checks: { "marketplace status 200": { passes: 100, fails: 0 }, "marketplace content type": { passes: 100, fails: 0 } } } };
  const metric = (marketplace ? readOutcome : readLoad)(k6), stats = summarizeSamples(samples);
  const measured = { ...metric, ...stats, cpuUsec: 1000000, perCpuSecond: 100, upstream: null };
  const probe = { first200At: "2026-11-12T10:00:00Z", successfulRequestMs: 1, bytes: 1000, attempts: 1, path: "/native" };
  const cold = { ...probe, first200MsFromContainerStart: 1, measuredBeforeReadinessOrWarmup: true };
  const check = { checked: "synthetic raw-support unit fixture, not native qualification" };
  const qualification = { eligible: true, synthetic: true };
  const run = { pass: 1, cold, warmup: metric, phases: Object.fromEntries(phases.map((phase) => [phase, measured])) };
  const summary = { runId: "native", options: { apps: ["corten"], build: true }, apps: { corten: {
    checks: { fixture: marketplace ? check : { ...check, qualification: { synthetic: true } } },
    qualification: { fixture: qualification, api: qualification }, runs: { [marketplace ? "fixture-neutral-json" : "fixture-page"]: [run] } } } };
  const inspect = () => inspectRawSupport(group, summary, root, tree(root));
  const required = inspect().required;
  for (const path of required) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
    let value = "native test log";
    if (path.endsWith("checks.json")) value = check;
    else if (path.endsWith("qualification.json")) value = marketplace ? qualification : summary.apps.corten.checks.fixture;
    else if (path.endsWith("cold.json")) value = cold;
    else if (path.endsWith("cold.log")) value = JSON.stringify(probe);
    else if (path.endsWith("-cpu.json")) value = path.endsWith("warmup-cpu.json") ? {} : { [name]: { usec: measured.cpuUsec } };
    else if (path.endsWith("-stats.log.json")) value = { summary: { [name]: stats }, samples: { [name]: samples } };
    else if (path.endsWith(".json")) value = k6;
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  }
  assert.equal(inspect().state, "present-artifacts-diagnostically-replayed");
  assert.equal(inspect().qualification, "blocked"); assert.deepEqual(inspect().missing, []);
  const raw = `fixture/corten/${marketplace ? "p1-neutral-json" : "p1-page"}`;
  for (const [path, change] of [
    [`${raw}/cold.json`, (v) => { v.bytes++; }],
    [`${raw}/fixed.json`, (v) => { v.metrics.http_reqs.values.rate++; }],
    [`${raw}/fixed-cpu.json`, (v) => { v[name].usec++; }],
    [`${raw}/fixed-stats.log.json`, (v) => { v.samples[name][0].cpu++; }],
    ["fixture/corten/checks.json", (v) => { v.checked = "changed"; }],
  ]) {
    const file = join(root, path), before = readFileSync(file), value = JSON.parse(before); change(value);
    writeFileSync(file, JSON.stringify(value)); assert.throws(inspect, /native raw support contradicts summary/); writeFileSync(file, before);
  }
});
