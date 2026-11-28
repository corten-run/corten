// Replay of results saved under the opt-in json-c16-generator-v1 placement (issue 2057),
// through the real report gates, beside the unchanged default.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { cpuSettings, descriptor } from "./contract.mjs";
import { c16Env, c16Generator, c16Host, c16Layout, runnerPlacement } from "./placement.mjs";
import { productionFixture } from "./production-fixtures.mjs";
import { inspectJson, renderJson } from "./report.mjs";
import { result } from "./test-fixtures.mjs";

const wide = () => runnerPlacement(c16Env, c16Host.logicalCpus);
const configuration = (report) => report.warnings.filter((w) => w.startsWith("configuration:"));

test("a c-16 timed production result replays as a baseline with k6's quota 12 bound and the fixed placement line", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "json-c16-production-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const f = await productionFixture(folder, { placement: wide() });
  assert.equal(f.summary.measurement.loadLayout, c16Layout);
  assert.deepEqual(f.summary.measurement.generatorPlacement, c16Generator);
  assert.deepEqual(f.summary.measurement.cpus.load, { quota: 12, cpuset: "4-15", placement: "explicit logical CPU pinning plus quota",
    args: ["--cpus", "12", "--cpuset-cpus", "4-15"] });
  // App and upstream budgets are the pinned default's.
  const pinned = cpuSettings({ JSON_API_APP_CPUS: "1", JSON_API_API_CPUS: "2-3", JSON_API_LOAD_CPUS: "4-7" });
  for (const role of ["app", "api"]) assert.deepEqual(f.summary.measurement.cpus[role], pinned[role]);
  const report = inspectJson(f.summary, { load: f.load });
  assert.equal(report.baseline, true, report.warnings.slice(0, 4).join("\n"));
  const text = renderJson(report);
  assert.ok(text.includes(`Load layout ${c16Layout}: the untimed cold probe ran on CPUs 4-7 at quota 4; load resource samples are bounded against k6's quota 12 on CPUs 4-15. This is apparatus placement for a 16-CPU host, not a measured speedup.`));
});

test("an unmarked default result replays exactly as before and prints no load layout", () => {
  const f = result();
  assert.equal(Object.hasOwn(f.summary.measurement, "loadLayout"), false);
  assert.equal(Object.hasOwn(f.summary.measurement, "generatorPlacement"), false);
  const report = inspectJson(f.summary, { load: f.load });
  assert.equal(report.baseline, true, report.warnings.slice(0, 4).join("\n"));
  assert.doesNotMatch(renderJson(report), /Load layout/);
});

test("a c-16 result whose marker, CPUs or recorded generator placement disagree is never complete", () => {
  const ok = result([], { placement: wide() });
  assert.equal(inspectJson(ok.summary, { load: ok.load }).baseline, true);
  for (const change of [
    (m) => { delete m.loadLayout; }, (m) => { delete m.generatorPlacement; }, (m) => { delete m.loadLayout; delete m.generatorPlacement; },
    (m) => { m.loadLayout = "c16-generator-v1"; }, (m) => { m.loadLayout = "json-c16-generator-v2"; },
    (m) => { m.cpus = cpuSettings({}); }, (m) => { m.cpus.load.quota = 4; }, (m) => { m.cpus.load.cpuset = "4-7"; },
    (m) => { m.generatorPlacement.coldProbe = { quota: 12, cpuset: "4-15" }; }, (m) => { m.generatorPlacement.loadSampler = { quota: 4, cpuset: "4-7" }; },
    (m) => { m.generatorPlacement.extra = true; },
  ]) {
    const f = result([], { placement: wide() }); change(f.summary.measurement);
    const report = inspectJson(f.summary, { load: f.load });
    assert.equal(report.baseline, false);
    assert.ok(configuration(report).some((w) => w.includes("missing/wrong CPU quotas or placement") || w.includes("measurement settings differ")),
      configuration(report).join("\n"));
  }
  // A default result cannot gain the generator record or the wide CPUs without the marker.
  for (const change of [(m) => { m.generatorPlacement = structuredClone(c16Generator); }, (m) => { m.cpus = wide().cpus; }]) {
    const f = result(); change(f.summary.measurement);
    assert.equal(inspectJson(f.summary, { load: f.load }).baseline, false);
  }
});

test("a c-16 result whose cold probe actually ran on k6's CPUs is refused by its participant receipts", () => {
  // Receipts made with the probe on 4-15, then the summary relabelled with the layout's 4-7 record.
  const placement = wide(), f = result([], { placement: { ...placement,
    generatorPlacement: { ...placement.generatorPlacement, coldProbe: { quota: 12, cpuset: "4-15" } } } });
  f.summary.measurement.generatorPlacement = structuredClone(c16Generator);
  const report = inspectJson(f.summary, { load: f.load });
  assert.equal(report.baseline, false);
  assert.deepEqual(configuration(report), []);
  assert.ok(report.warnings.some((w) => w.includes("participating runtime image/CPU/memory/ownership differs")), report.warnings.slice(0, 4).join("\n"));
  assert.ok(descriptor().apps.length > 0);
});