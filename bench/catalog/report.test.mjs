import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allApps } from "../fullstack/apps.mjs";
import { aggregate, phases } from "./contract.mjs";
import { groupDescriptor, groupResultSchema, qualificationIdentity } from "./group.mjs";
import { records } from "./fixtures.mjs";
import { inspectCatalog, renderCatalog } from "./report.mjs";
import { expectedDocumentHeaderPaths, leanProfile } from "./contract.mjs";
import { originalCatalogApps as leanApps } from "./group.mjs";

function result() {
  const names = Object.keys(allApps).filter((name) => allApps[name].pages !== false);
  const phase = { rps: 200, perCpuSecond: 220, cpuAvgPct: 99, memMaxMiB: 8, p95: 2, failed: 0, dropped: 0, upstream: { cpuAvgPct: 50, highCpu: false } };
  const check = { jsonRecords: 500, pages: 120, profiles: [false, true].flatMap((javaScriptEnabled) => ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].map((profile) => ({ profile, javaScriptEnabled, forms: true, related: true, styles: true }))),
    upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } };
  return { workload: "catalog-v1", round: "c1", commit: "a".repeat(40), dirty: false, complete: true, checksPassed: true,
    fixtureSha256: createHash("sha256").update(`${JSON.stringify(records())}\n`).digest("hex"),
    startedAt: "2026-11-07T16:00:00Z", finishedAt: "2026-11-07T22:00:00Z", failures: [], cleanupFailures: [], options: { apps: names, passes: 3, duration: 60, warmup: 30, rate: 150 },
    measurement: { encoding: "identity", fixedRate: 150, cpus: { app: { quota: 1, cpuset: "0" }, load: { quota: 4, cpuset: "4-7" }, api: { quota: 2, cpuset: "2-3" } } },
    apps: Object.fromEntries(names.map((app) => [app, { checks: { fixture: structuredClone(check), api: structuredClone(check) }, runs: Object.fromEntries(["fixture-page", "fixture-json", "api-page", "api-json"].map((key) => [key,
      [1, 2, 3].map((pass) => ({ pass, complete: true, phases: { sat64: { ...structuredClone(phase), rps: 100 * pass } } }))])) }])) };
}

test("a clean complete result requires all twenty apps and requested passes", () => {
  const report = inspectCatalog(result(), "a".repeat(40));
  assert.equal(report.baseline, true);
  assert.equal(Object.keys(report.apps).length, 20);
  assert.deepEqual(report.apps.corten["fixture-page"].rps, { median: 200, min: 100, max: 300 });
  assert.match(renderCatalog(report), /200 \[100, 300\] \(3\/3\)/);
});

test("reports preserve the exact new lean configuration without relabeling historical evidence", () => {
  const s = result();
  assert.ok(!renderCatalog(inspectCatalog(s)).includes("Speed configuration:"));
  s.measurement.leanProfile = { name: leanProfile, apps: [...leanApps] };
  assert.match(renderCatalog(inspectCatalog(s)), /Speed configuration: `catalog-lean`/);
  s.measurement.leanProfile.apps.pop();
  assert.throws(() => inspectCatalog(s), /catalog lean configuration differs/);
});

test("historical catalog validation does not acquire group-only provenance or aggregate requirements", () => {
  const s = result();
  assert.equal(s.commitAfter, undefined);
  assert.equal(s.dirtyAfter, undefined);
  assert.equal(s.apps.corten.phases, undefined);
  assert.equal(inspectCatalog(s).baseline, true);
  s.commitAfter = "b".repeat(40);
  s.dirtyAfter = true;
  assert.equal(inspectCatalog(s).baseline, true, "optional new fields do not change legacy validation");
});
// Synthetic header observations that satisfy the document contract; not native evidence.
const headerRows = (source) => expectedDocumentHeaderPaths(records(), source).map((path) => ({ path, status: 200,
  headers: Object.entries({ "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "geolocation=()", "cache-control": "no-store" }).map(([name, value]) => ({ name, value })) }));
const contract = groupDescriptor("catalog-page").documentHeaders;
// A new ungrouped run as run.mjs now writes it: lean contenders header-checked, others not.
function mixedResult({ recorded = true } = {}) {
  const s = result();
  s.measurement.leanProfile = { name: leanProfile, apps: [...leanApps] };
  if (recorded) s.measurement.documentHeaders = { contract, apps: [...leanApps] };
  for (const app of leanApps) for (const source of ["fixture", "api"]) s.apps[app].checks[source].documentHeaders = headerRows(source);
  return s;
}

test("legacy ungrouped reports are unchanged by the document header scope", () => {
  const s = result();
  s.measurement.leanProfile = { name: leanProfile, apps: [...leanApps] };
  const report = inspectCatalog(s), text = renderCatalog(report);
  assert.equal(report.baseline, true); assert.equal(report.status, "COMPLETE");
  assert.equal(report.documentHeaders, undefined);
  assert.ok(!/Document header contract|Mixed correctness|###/.test(text));
  assert.equal(text.match(/^\| Framework \|/gm).length, 1);
});

for (const recorded of [true, false]) test(`new mixed ungrouped runs (${recorded ? "recorded" : "inferred"} scope) are never feature-parity baselines`, () => {
  const s = mixedResult({ recorded }), report = inspectCatalog(s, s.commit), text = renderCatalog(report);
  assert.equal(report.baseline, false);
  assert.equal(report.status, "COMPLETE MIXED-CONTRACT RUN: not a feature-parity baseline");
  assert.deepEqual(report.documentHeaders.checked, Object.keys(s.apps).filter((app) => leanApps.includes(app)));
  assert.equal(report.documentHeaders.checked.length, 7); assert.equal(report.documentHeaders.unchecked.length, 13);
  assert.equal(report.documentHeaders.mixed, true);
  assert.match(report.documentHeaders.scope, recorded ? /recorded/ : /inferred/);
  assert.ok(report.warnings.some((w) => /Mixed correctness contracts: 7 apps .* 13 were not/.test(w)));
  const [checked, unchecked] = text.split("### Not checked against the document header contract");
  assert.match(text, new RegExp(`### Checked against \`${contract}\``));
  assert.match(text, /must not be ranked against each other/);
  for (const app of leanApps) { assert.match(checked, new RegExp(`^\\| ${app} \\|`, "m")); assert.doesNotMatch(unchecked, new RegExp(`^\\| ${app} \\|`, "m")); }
  for (const app of report.documentHeaders.unchecked) assert.match(unchecked, new RegExp(`^\\| ${app} \\|`, "m"));
  const cli = strictReport(s);
  assert.equal(cli.status, 1); assert.equal(cli.stderr, "");
  assert.match(cli.stdout, /COMPLETE MIXED-CONTRACT RUN/);
});

test("mixed runs keep failure statuses and validate header evidence by scope", () => {
  const failed = mixedResult(); failed.failures.push({ app: "gin", stage: "load", error: "timeout" });
  assert.equal(inspectCatalog(failed).status, "FAILED OR INCOMPLETE: not a baseline");
  const broken = mixedResult(); broken.apps.corten.checks.api.documentHeaders.pop();
  let report = inspectCatalog(broken);
  assert.equal(report.status, "FAILED OR INCOMPLETE: not a baseline");
  assert.ok(report.warnings.includes("corten api: missing or invalid document header observations."));
  const missing = mixedResult(); delete missing.apps.gin.checks.fixture.documentHeaders;
  assert.ok(inspectCatalog(missing).warnings.includes("gin fixture: missing or invalid document header observations."));
  const stray = mixedResult(); stray.apps.nextjs.checks.fixture.documentHeaders = headerRows("fixture");
  report = inspectCatalog(stray);
  assert.equal(report.status, "FAILED OR INCOMPLETE: not a baseline");
  assert.ok(report.warnings.some((w) => /nextjs fixture: document header evidence outside/.test(w)));
  const tampered = mixedResult(); tampered.measurement.documentHeaders.apps.pop();
  assert.throws(() => inspectCatalog(tampered), /document header scope differs/);
  const renamed = mixedResult(); renamed.measurement.documentHeaders.contract = "catalog-document-headers/v0";
  assert.throws(() => inspectCatalog(renamed), /document header scope differs/);
});

test("a new ungrouped run of only header-checked apps is uniform but still a subset", () => {
  const s = mixedResult(); s.options.apps = [...leanApps];
  s.apps = Object.fromEntries(leanApps.map((app) => [app, s.apps[app]]));
  const report = inspectCatalog(s), text = renderCatalog(report);
  assert.equal(report.documentHeaders.mixed, false); assert.equal(report.baseline, false);
  assert.equal(report.status, "FAILED OR INCOMPLETE: not a baseline");
  assert.match(text, /not checked for no reported app/); assert.ok(!/###|Mixed correctness/.test(text));
});

// Summary-only synthetic fixtures, not raw evidence or native measurements.
function timedResult(grouped, failed) {
  const s = result(), group = groupDescriptor("catalog-page", { historical: true }), imageId = `sha256:${"b".repeat(64)}`;
  s.savedEvidence = { schema: "catalog-saved-evidence/v3", fixtureSha256: s.fixtureSha256 };
  s.attemptComplete = true; s.targetFailures = [];
  if (grouped) {
    s.schema = groupResultSchema; s.group = group; s.options.group = "catalog-page"; s.options.apps = group.apps;
    s.options.startupTimeout = 30; s.commitAfter = s.commit; s.dirtyAfter = false;
    s.apps = Object.fromEntries(group.apps.map((app) => [app, s.apps[app]]));
  }
  for (const [app, entry] of Object.entries(s.apps)) {
    entry.phases = {};
    if (grouped) {
      entry.imageId = imageId;
      for (const source of group.sources) entry.checks[source].qualification = qualificationIdentity(group, app, source, imageId);
      entry.runs = Object.fromEntries(group.cases.map(({ source, target }) => [`${source}-${target}`, entry.runs[`${source}-${target}`]]));
    }
    for (const [key, runs] of Object.entries(entry.runs)) {
      for (const run of runs) {
        const phase = { ...run.phases.sat64, outcome: "passed", requests: 100, successfulRequests: 100,
          successfulRps: run.phases.sat64.rps, timeouts: 0, httpErrors: 0, p50: 1, p99: 3, cpuUsec: 60000000, memAvgMiB: 8 };
        run.phases = Object.fromEntries(phases.map((p) => [p, structuredClone(phase)]));
        run.warmup = structuredClone(phase); run.outcome = "passed";
        if (grouped) {
          run.evidence = { app, ...group.cases.find(({ source, target }) => key === `${source}-${target}`), imageId };
          run.cold = { path: "/catalog/record_1", containerStartedAt: s.startedAt, first200At: "2026-11-07T16:00:00.200Z",
            first200MsFromContainerStart: 200, measuredBeforeReadinessOrWarmup: true, attempts: 2, bytes: 1000, successfulRequestMs: 2 };
        }
        if (failed && app === "corten" && key === "fixture-page" && run.pass === 1) {
          Object.assign(run.phases.sat64, { outcome: "failed", failed: 1, timeouts: 1, successfulRequests: 99, successfulRps: phase.rps * 99 / 100 });
          run.outcome = "failed";
          s.targetFailures.push({ app, source: "fixture", target: "page", pass: 1, phase: "sat64", failed: 1, timeouts: 1, httpErrors: 0, dropped: 0 });
          s.complete = false;
        }
      }
      entry.phases[key] = Object.fromEntries(phases.map((p) => [p, { ...aggregate(runs.map((r) => r.phases[p])), asked: s.options.passes }]));
    }
  }
  return s;
}

function strictReport(summary) {
  const folder = mkdtempSync(join(tmpdir(), "catalog-report-scope-")), path = join(folder, "summary.json");
  const bytes = JSON.stringify(summary);
  try {
    writeFileSync(path, bytes);
    const cli = spawnSync(process.execPath, ["--max-old-space-size=384", fileURLToPath(new URL("./report.mjs", import.meta.url)),
      path, "--commit", summary.commit, "--require-complete"], { encoding: "utf8" });
    assert.equal(cli.error, undefined); assert.equal(cli.signal, null);
    assert.equal(readFileSync(path, "utf8"), bytes, "reporting must not rewrite its input");
    return cli;
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
}

test("supported grouped v3 summaries preserve successful and failed dispositions through strict CLI", () => {
  for (const failed of [false, true]) {
    const s = timedResult(true, failed), report = inspectCatalog(s, s.commit), cli = strictReport(s);
    assert.equal(report.baseline, !failed); assert.equal(report.attemptComplete, true);
    assert.equal(report.timedCells.find((c) => c.app === "corten" && c.profile === "fixture-page" && c.phase === "sat64").outcomes.failed, failed ? 1 : 0);
    assert.equal(cli.status, failed ? 1 : 0); assert.equal(cli.stderr, "");
    assert.match(cli.stdout, failed ? /COMPLETE ATTEMPT: observed load\/request failure; not a baseline/ : /\*\*COMPLETE\*\*/);
    assert.match(cli.stdout, /Historical contract: the current document header floor was not checked/);
    assert.doesNotMatch(cli.stdout, /MIXED-CONTRACT|Mixed correctness/);
    assert.equal(report.documentHeaders, undefined);
  }
});

test("grouped summaries cannot carry the ungrouped header scope record", () => {
  const s = timedResult(true, false);
  s.measurement.documentHeaders = { contract, apps: [...leanApps] };
  assert.throws(() => inspectCatalog(s, s.commit), /group runs record their document header contract/);
});

for (const failed of [false, true]) for (const scope of ["absent", "legacy schema", "unsupported"]) {
  const input = () => {
    const s = timedResult(false, failed);
    // Preserve the contradictory flags from the reviewed reproduction.
    s.complete = true; s.targetFailures = [];
    if (scope === "legacy schema") s.schema = "catalog-results/v1";
    if (scope === "unsupported") { s.schema = groupResultSchema; s.options.group = "json-api"; }
    return s;
  };
  test(`v3 ${failed ? "failed" : "successful"} summary rejects ${scope} group scope`, () => {
    const s = input(), before = structuredClone(s);
    assert.throws(() => inspectCatalog(s, s.commit), /catalog-page/);
    assert.deepEqual(s, before);
  });
  test(`strict CLI refuses v3 ${failed ? "failed" : "successful"} summary with ${scope} group scope`, () => {
    const cli = strictReport(input());
    assert.equal(cli.status, 1); assert.match(cli.stderr, /catalog-page/); assert.equal(cli.stdout, "");
  });
}

test("unfinished, failed, dirty, check-only, missing checks and subset runs are never baselines", () => {
  for (const change of [
    (s) => { delete s.finishedAt; s.complete = false; },
    (s) => { s.finishedAt = "not a timestamp"; },
    (s) => { s.failures.push({ app: "gin", stage: "load", error: "timeout" }); },
    (s) => { s.cleanupFailures.push({ resource: "owned container", error: "busy" }); },
    (s) => { s.dirty = true; }, (s) => { delete s.dirty; },
    (s) => { s.checksPassed = false; }, (s) => { s.options.checkOnly = true; },
    (s) => { delete s.apps.drogon; }, (s) => { s.options.apps.pop(); },
  ]) {
    const s = result(); change(s);
    assert.equal(inspectCatalog(s).baseline, false);
  }
});
test("partial medians show collected passes without turning missing values into zeros", () => {
  const s = result();
  s.apps.corten.runs["fixture-page"].pop();
  delete s.apps.corten.runs["api-json"];
  const report = inspectCatalog(s);
  assert.equal(report.baseline, false);
  assert.equal(report.apps.corten["fixture-page"].rps.median, 150);
  assert.equal(report.apps.corten["api-json"].rps, null);
  assert.match(renderCatalog(report), /150 \[100, 200\] \(2\/3\)/);
  assert.match(renderCatalog(report), /pending/);
});
test("available sat64 from a failed later phase is explicitly partial", () => {
  const s = result();
  s.apps.corten.runs["fixture-page"][0].complete = false;
  s.apps.corten.runs["fixture-page"][0].failed = "sat256 timeout";
  const report = inspectCatalog(s);
  assert.equal(report.baseline, false);
  assert.equal(report.apps.corten["fixture-page"].passes, 3);
  assert.ok(report.warnings.some((s) => /whole run did not complete/.test(s)));
});
test("low application CPU and a busy single-process upstream are limits, not diagnosed causes", () => {
  const s = result();
  s.apps.corten.runs["fixture-json"][0].phases.sat64.cpuAvgPct = 72;
  s.apps.corten.runs["api-json"][0].phases.sat64.upstream.cpuAvgPct = 85;
  const report = inspectCatalog(s);
  assert.equal(report.baseline, true, "limits qualify measurements, not correctness");
  assert.ok(report.warnings.some((s) => /72.0%.*not proven capacity/.test(s)));
  assert.ok(report.warnings.some((s) => /busy single-process upstream/.test(s)));
});
test("missing or invalid CPU/memory metrics cannot certify a baseline", () => {
  for (const [key, value] of [["rps", 0], ["perCpuSecond", null], ["memMaxMiB", NaN], ["p95", -1], ["failed", 1], ["dropped", 1]]) {
    const s = result();
    s.apps.corten.runs["fixture-page"][0].phases.sat64[key] = value;
    assert.equal(inspectCatalog(s).baseline, false, key);
  }
});
test("wrong identity or duplicate pass numbers are rejected", () => {
  assert.throws(() => inspectCatalog(result(), "b".repeat(40)), /commit differs/);
  for (const change of [(s) => { s.workload = "marketplace-v2"; }, (s) => { s.round = "r17"; },
    (s) => { s.apps.corten.runs["fixture-page"][1].pass = 1; }]) {
    const s = result(); change(s);
    assert.throws(() => inspectCatalog(s));
  }
});
test("aggregate correctness flags cannot override missing or contradictory evidence", () => {
  for (const change of [(s) => { delete s.fixtureSha256; }, (s) => { s.fixtureSha256 = "b".repeat(64); },
    (s) => { delete s.apps.corten.checks.api; }, (s) => { s.apps.nextjs.checks.fixture.jsonRecords = 0; },
    (s) => { s.apps.topcoat.checks.api.profiles.pop(); }, (s) => { s.apps.aspnet.checks.fixture.profiles[0].forms = false; },
    (s) => { s.apps.gin.checks.api.upstream.uncachedJson = false; }, (s) => { s.apps.drogon.checks.fixture.pages = 0; },
    (s) => { s.apps.django.checks.fixture.profiles[0] = s.apps.django.checks.fixture.profiles[1]; },
    (s) => { s.apps.django.checks.fixture.profiles[0].javaScriptEnabled = "false"; },
    (s) => { s.apps.corten.checks.fixture.pages = 96; },
    (s) => { s.apps.corten.checks.api.pages = 119; },
    (s) => { s.apps.corten.failures = [{ stage: "load", error: "timeout" }]; }]) {
    const s = result(); change(s); assert.equal(inspectCatalog(s).baseline, false);
  }
});
test("configuration and every competitor's variability remain visible", () => {
  const a = result();
  const before = renderCatalog(inspectCatalog(a));
  assert.match(before, /duration 60 s; warmup 30 s; fixed rate 150 req\/s/);
  assert.match(before, /load \| 4.0 \| 4-7/);
  a.options.duration = 1; a.options.warmup = 1; a.options.rate = 1; a.measurement.fixedRate = 1;
  const after = renderCatalog(inspectCatalog(a));
  assert.notEqual(before, after);
  assert.match(after, /duration 1 s; warmup 1 s; fixed rate 1 req\/s/);
  a.apps.nextjs.runs["fixture-json"].forEach((r, i) => { r.phases.sat64.rps = [1, 200, 10000][i]; });
  assert.match(renderCatalog(inspectCatalog(a)), /nextjs.*200 \[1, 10,000\]/);
  for (const change of [(s) => { delete s.options.duration; }, (s) => { delete s.measurement.cpus.load; },
    (s) => { s.measurement.fixedRate = 42; }, (s) => { s.startedAt = s.finishedAt; s.finishedAt = "2026-11-07T15:00:00Z"; }]) {
    const s = result(); change(s); assert.equal(inspectCatalog(s).baseline, false);
  }
});
test("CPU placement must satisfy the same range, disjointness and quota rules as the runner", () => {
  for (const change of [(s) => { s.measurement.cpus.load.cpuset = "0"; },
    (s) => { s.measurement.cpus.load.cpuset = "7-4"; },
    (s) => { s.measurement.cpus.load.cpuset = "4,4"; },
    (s) => { s.measurement.cpus.load.cpuset = "4096"; },
    (s) => { s.measurement.cpus.load.cpuset = ""; },
    (s) => { s.measurement.cpus.app.quota = 2; }]) {
    const s = result(); change(s); assert.equal(inspectCatalog(s).baseline, false);
  }
  const s = result();
  for (const role of ["app", "load", "api"]) s.measurement.cpus[role].cpuset = null;
  assert.equal(inspectCatalog(s).baseline, true, "unpinned quota-only mode is an explicit supported configuration");
});
