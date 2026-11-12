import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { apps, locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { aggregate, appStop, cpuSettings, phases, resultSchema, sources, stageAggregate, timedProfiles } from "./run-contract.mjs";
import { report, validateSummary } from "./report.mjs";
import { compare, comparisonKey } from "./compare.mjs";
import { groupApps } from "./groups.mjs";
import { featureProfile, qualification, qualificationSettings } from "./feature-contract.mjs";
import { qualificationProbes } from "./qualification-fixture.mjs";
function synthetic() {
  const s = { schema: resultSchema, workload, round: "r17", commit: "a".repeat(40), dirty: false, complete: true, checksPassed: true,
    failures: [], cleanupFailures: [], finishedCommit: "a".repeat(40), finishedDirty: false,
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T01:00:00Z", options: { round: "r17", build: true, apps, checkOnly: false, passes: 3, duration: 60, warmup: 30, rate: 150, startupTimeout: 120 }, apps: {},
    host: { cpu: "Synthetic test only", onlineCpus: "0-7", platform: "test", release: "test", node: "test", docker: "test" }, tools: Object.fromEntries(["upstream", "checker", "k6"].map((k) => [k, { imageId: `sha256:${"b".repeat(64)}` }])),
    fixtureSha256: createHash("sha256").update(JSON.stringify(records())).digest("hex"), measurement: { profiles: timedProfiles, upstream: "Synthetic test only", cpuWindow: "Not measured", coldClock: "Synthetic test only", cpus: cpuSettings({}), encoding: "identity", fixedRate: 150, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20 } };
  for (const app of apps) {
    const a = s.apps[app] = { label: app, imageId: `sha256:${"b".repeat(64)}`, builtCommit: s.commit, builtDirty: false, checks: {}, runs: {}, phases: {} };
    for (const source of sources) {
      a.checks[source] = { workload, source, jsonRecords: 500, pages: 264, profiles: locales.flatMap((locale) => [false, true].flatMap((javaScriptEnabled) => [false, true].map((mobile) => ({ locale, javaScriptEnabled, mobile, passed: true })))),
        upstream: source === "api" ? { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } : null };
      for (const { key, locale, target } of timedProfiles.filter((p) => p.source === source)) {
        const metric = { requests: 1000, rps: 1000, p50: 1, p95: 2, p99: 3, failed: 0, failedRate: 0, dropped: 0, checksFailed: 0, appOutcome: false };
        const stats = { cpuUsec: 1000000, samples: 3, cpuAvgPct: 100, cpuMaxPct: 110, memAvgMiB: 10, memMaxMiB: 11 };
        a.runs[key] = [1, 2, 3].map((pass) => ({ pass, locale, complete: true, startedAt: "2026-01-01T00:01:00Z", finishedAt: "2026-01-01T00:03:00Z",
          cold: { containerStartedAt: "2026-01-01T00:02:00Z", first200At: "2026-01-01T00:02:01Z", first200MsFromContainerStart: 1000, measuredBeforeReadinessOrWarmup: true, path: target === "json" ? "/api/marketplace/item_1" : `/marketplace/${locale}/item_1`, attempts: 1, bytes: 100, successfulRequestMs: 1 },
          warmup: metric, phases: Object.fromEntries(phases.map((p) => [p, { ...metric, ...stats, requests: 1000 + pass, rps: 1000 + pass, perCpuSecond: 1000 + pass, upstream: source === "api" ? { ...stats, highCpu: true } : null }])) }));
        a.phases[key] = Object.fromEntries(phases.map((p) => [p, stageAggregate(a.runs[key], p, 3)]));
      }
    }
  }
  return s;
}

test("named groups require exact evidence and compare only with the same group", () => {
  const grouped = (group, round) => {
    const s = synthetic(); s.round = round; s.options.round = round;
    s.options.group = group; s.options.apps = groupApps(group);
    s.apps = Object.fromEntries(s.options.apps.map((a) => [a, s.apps[a]]));
    s.measurement.featureProfile = featureProfile;
    s.measurement.qualificationSettings = qualificationSettings;
    for (const a of Object.values(s.apps)) a.qualification = Object.fromEntries(sources.map((source) => [source, qualification(qualificationProbes(), source)]));
    return s;
  };
  const s = grouped("production", "r24"); validateSummary(s);
  assert.match(report(s), /Group: production/);
  assert.equal(compare(s, grouped("production", "r20"), { unchangedApps: ["aspnet"] }).compatible, true);
  assert.equal(compare(s, grouped("production-performant", "r22")).compatible, false);
  assert.equal(compare(s, grouped("production", "r20"), { unchangedApps: ["axum-maud"] }).compatible, false);
  for (const mutate of [
    (v) => { delete v.apps.nextjs; },
    (v) => { v.options.group = "full"; },
    (v) => { delete v.options.group; },
    (v) => { v.options.apps = ["corten"]; },
  ]) { const v = structuredClone(s); mutate(v); assert.throws(() => validateSummary(v)); }
  const oldSchema = structuredClone(s); oldSchema.schema = "marketplace-results/v4";
  assert.throws(() => validateSummary(oldSchema));
  const excluded = structuredClone(s);
  const unsupported = qualificationProbes(); delete unsupported.page.headers["content-security-policy"];
  excluded.apps.nextjs.qualification.api = qualification(unsupported, "api");
  excluded.apps.nextjs.runs = {}; excluded.apps.nextjs.phases = {};
  validateSummary(excluded);
  assert.match(report(excluded), /excluded, not timed/);
  const loss = compare({ ...excluded, round: "r25", options: { ...excluded.options, round: "r25" } }, s);
  assert.equal(loss.compatible, false);
  assert.equal(loss.qualificationLosses[0].app, "nextjs");
  const forged = structuredClone(excluded); forged.apps.nextjs.qualification.api.eligible = true;
  assert.throws(() => validateSummary(forged));
  const lone = structuredClone(s);
  for (const [name, a] of Object.entries(lone.apps)) if (name !== "corten") { a.qualification.api = qualification(unsupported, "api"); a.runs = {}; a.phases = {}; }
  assert.throws(() => validateSummary(lone));
  const missingEvidence = structuredClone(excluded); missingEvidence.apps.nextjs.qualification.api = qualification({}, "api");
  assert.throws(() => validateSummary(missingEvidence));
});
test("read-only reporter requires every app, locale, source and three complete passes", () => {
  const s = synthetic(); validateSummary(s);
  const text = report(s); for (const locale of locales) assert.ok(text.includes(`## ${locale}`));
  for (const change of [(v) => { v.dirty = true; }, (v) => { delete v.apps.drogon; }, (v) => { v.options.checkOnly = true; }, (v) => { v.apps.corten.runs["fixture-fr-FR-page"].pop(); },
    (v) => { v.apps.corten.checks.api.profiles[1] = v.apps.corten.checks.api.profiles[0]; }, (v) => { v.apps.corten.phases["fixture-en-US-page"].sat64.rps.median++; }, (v) => { v.failures.push("broken"); },
    (v) => { v.apps.corten.builtDirty = true; }, (v) => { delete v.apps.corten.builtDirty; },
    (v) => { v.apps.corten.runs["fixture-en-US-page"][0].failed = "broken"; }, (v) => { delete v.finishedAt; }, (v) => { delete v.measurement.cpus; }, (v) => { delete v.apps.corten.runs["api-en-US-page"][0].phases.sat64.upstream; }, (v) => { delete v.apps.corten.runs["fixture-en-US-page"][0].phases.fixed.p95; }]) {
    const bad = structuredClone(s); change(bad); assert.throws(() => validateSummary(bad));
  }
});

test("strict report rejects missing or duplicate JSON runs, profiles, phases and parity evidence", () => {
  const s = synthetic();
  for (const change of [
    (v) => { delete v.schema; },
    (v) => { v.schema = "marketplace-results/v1"; },
    (v) => { v.round = "r16"; },
    (v) => { v.round = "r017"; },
    (v) => { v.measurement.profiles.pop(); },
    (v) => { v.measurement.profiles.push({ key: "fixture-en-US-json", source: "fixture", locale: "en-US", target: "json" }); },
    (v) => { v.measurement.profiles[3] = v.measurement.profiles[0]; },
    (v) => { delete v.apps.corten.runs["fixture-neutral-json"]; },
    (v) => { delete v.apps.corten.phases["api-neutral-json"]; },
    (v) => { v.apps.corten.runs["api-neutral-json"].pop(); },
    (v) => { v.apps.corten.runs["api-neutral-json"][0].locale = "en-US"; },
    (v) => { v.apps.corten.runs["api-en-US-json"] = v.apps.corten.runs["api-neutral-json"]; },
    (v) => { v.apps.corten.phases["api-fr-FR-json"] = v.apps.corten.phases["api-neutral-json"]; },
    (v) => { v.apps.corten.runs["api-neutral-json"][2].pass = 2; },
    (v) => { delete v.apps.corten.runs["api-neutral-json"][0].phases.sat256; },
    (v) => { v.apps.corten.runs["api-neutral-json"][0].phases.extra = {}; },
    (v) => { delete v.apps.corten.checks.fixture; },
    (v) => { v.apps.corten.checks.fixture.pages--; },
    (v) => { v.apps.corten.checks.api.jsonRecords--; },
    (v) => { v.apps.corten.checks.api.upstream.jsonReserialized = false; },
    (v) => { v.apps.corten.runs["api-neutral-json"][0].phases.fixed.dropped = 1; },
    (v) => { v.apps.corten.runs["api-neutral-json"][0].phases.fixed.failed = 0.01; },
    (v) => { v.apps.corten.phases["api-neutral-json"].fixed.cpuAvgPct.median++; },
    (v) => { v.apps.corten.phases["api-neutral-json"].fixed.cpuPerRequestUsec.median++; },
  ]) {
    const bad = structuredClone(s); change(bad); assert.throws(() => validateSummary(bad));
  }
});

test("report shows all phases and cost/latency ranges without locale-duplicated JSON tables", () => {
  const s = synthetic();
  const text = report(s);
  assert.equal(text.match(/^## Locale-neutral JSON$/gm).length, 1);
  assert.equal(text.match(/^### (Memory|HTTP) source$/gm).length, 8);
  assert.equal(text.match(/^#### Cold start$/gm).length, 8);
  assert.ok(text.includes("First 200 from container start ms"));
  assert.ok(text.includes("1000.00 [1000.00-1000.00]"));
  assert.equal(text.match(/^#### Fixed 150 req\/s$/gm).length, 8);
  for (const users of [64, 256]) assert.equal(text.match(new RegExp(`^#### ${users}-user closed loop$`, "gm")).length, 8);
  for (const heading of ["p50 ms", "p95 ms", "p99 ms", "CPU %", "CPU us/request", "Steady MiB", "Peak MiB", "Requests/CPU-second"]) assert.ok(text.includes(heading));
  assert.ok(text.includes("1002.00 [1001.00-1003.00]"));
  assert.ok(text.includes("busy single-process upstream"));
  assert.ok(text.includes("not proven maximum capacity"));
  assert.ok(text.includes("do not measure browser interactivity"));
  for (const locale of locales) {
    const section = text.split(`## ${locale}\n`)[1].split("\n## ")[0];
    assert.doesNotMatch(section, /neutral-json/);
  }
  s.round = s.options.round = "w1";
  assert.match(report(s), /^# Marketplace v2 w1 \(development\)/);
});

test("counted CPU cost is aggregated per pass, not derived by dividing medians", () => {
  const runs = [{ requests: 2, cpuUsec: 10 }, { requests: 10, cpuUsec: 20 }, { requests: 20, cpuUsec: 100 }];
  assert.deepEqual(aggregate(runs).cpuPerRequestUsec, { median: 5, min: 2, max: 5 });
});

test("compatible official rounds always compare Corten, with optional caller-attested references", () => {
  const old = synthetic(), current = synthetic(); current.round = current.options.round = "r18";
  current.options.build = false;
  const result = compare(current, old, { unchangedApps: ["corten"] });
  assert.equal(result.compatible, true);
  assert.equal(result.rows.length, 8 * 3);
  assert.ok(result.rows.every((r) => r.app === "corten"));
  assert.equal(result.rows.filter((r) => r.profile.endsWith("json")).length, 2 * 3);
  assert.equal(result.rows[0].metrics.rps.percentChange, 0);
  assert.equal(result.rows[0].metrics.rps.rangesOverlap, true);
  assert.deepEqual(result.rows[0].metrics.rps.current, { median: 1002, min: 1001, max: 1003 });
  assert.ok(result.warnings.some((w) => w.includes("Caller-attested")));
  assert.ok(result.warnings.some((w) => w.includes("not declared unchanged")));
  assert.ok(result.rows.some((r) => r.warnings.some((w) => w.includes("busy upstream"))));
  const subjectOnly = compare(current, old);
  assert.equal(subjectOnly.rows.length, 8 * 3);
  assert.equal(subjectOnly.cold.length, 8);
  assert.ok(subjectOnly.rows.every((r) => r.app === "corten"));
  assert.deepEqual(subjectOnly.cohort, { apps: [], rows: [], cold: [] });
  assert.equal(compare(current, null, { unchangedApps: ["corten"] }).compatible, false);
});

test("changed Corten remains the subject; reference context is the median of non-Corten percentage changes", () => {
  const old = synthetic(), current = synthetic(); current.round = current.options.round = "r18";
  current.commit = current.finishedCommit = "c".repeat(40);
  for (const a of Object.values(current.apps)) a.builtCommit = current.commit;
  for (const [app, factor, coldDelay] of [["corten", 0.8, 2000], ["nextjs", 1.1, 1000], ["rails", 1.3, 3000]]) {
    for (const run of current.apps[app].runs["fixture-en-US-page"]) {
      run.phases.sat64.rps *= factor;
      run.cold.first200MsFromContainerStart += coldDelay;
      run.cold.first200At = new Date(Date.parse(run.cold.containerStartedAt) + run.cold.first200MsFromContainerStart).toISOString();
    }
    current.apps[app].phases["fixture-en-US-page"].sat64 = stageAggregate(current.apps[app].runs["fixture-en-US-page"], "sat64", 3);
  }
  for (const run of old.apps.nextjs.runs["fixture-en-US-page"]) run.phases.sat64.p50 = 0;
  old.apps.nextjs.phases["fixture-en-US-page"].sat64 = stageAggregate(old.apps.nextjs.runs["fixture-en-US-page"], "sat64", 3);
  const result = compare(current, old, { unchangedApps: ["nextjs", "rails"] });
  assert.equal(result.compatible, true);
  assert.equal(result.subject, "corten");
  assert.deepEqual(result.cohort.apps, ["nextjs", "rails"]);
  assert.equal(result.rows.length, 3 * 8 * 3);
  assert.equal(result.cold.length, 3 * 8);
  assert.equal(result.cohort.rows.length, 8 * 3);
  assert.equal(result.cohort.cold.length, 8);
  assert.ok(result.rows.every((r) => ["corten", "nextjs", "rails"].includes(r.app)));
  const subject = result.rows.find((r) => r.app === "corten" && r.profile === "fixture-en-US-page" && r.phase === "sat64");
  assert.ok(Math.abs(subject.metrics.rps.percentChange - -20) < 1e-10);
  const context = result.cohort.rows.find((r) => r.profile === "fixture-en-US-page" && r.phase === "sat64");
  assert.equal(context.metrics.rps.apps, 2);
  assert.ok(Math.abs(context.metrics.rps.medianPercentChange - 20) < 1e-10);
  assert.ok(Math.abs(context.metrics.rps.minPercentChange - 10) < 1e-10);
  assert.ok(Math.abs(context.metrics.rps.maxPercentChange - 30) < 1e-10);
  assert.deepEqual(context.metrics.p50, { apps: 1, excludedApps: ["nextjs"], medianPercentChange: 0, minPercentChange: 0, maxPercentChange: 0 });
  const cold = result.cold.find((r) => r.app === "corten" && r.profile === "fixture-en-US-page");
  assert.equal(cold.metrics.first200MsFromContainerStart.percentChange, 200);
  assert.deepEqual(cold.metrics.first200MsFromContainerStart.current, { median: 3000, min: 3000, max: 3000 });
  const coldContext = result.cohort.cold.find((r) => r.profile === "fixture-en-US-page");
  assert.equal(coldContext.metrics.first200MsFromContainerStart.medianPercentChange, 200);
  assert.equal(coldContext.metrics.first200MsFromContainerStart.minPercentChange, 100);
  assert.equal(coldContext.metrics.first200MsFromContainerStart.maxPercentChange, 300);
  assert.ok(result.warnings.some((w) => w.includes("Caller-attested")));
  assert.ok(result.warnings.some((w) => w.includes("context only")));
});

test("comparison reports measured median direction and null for a zero baseline, with both ranges", () => {
  const old = synthetic(), current = synthetic(); current.round = current.options.round = "r18";
  for (const run of old.apps.corten.runs["fixture-en-US-page"]) run.phases.sat64.p50 = 0;
  old.apps.corten.phases["fixture-en-US-page"].sat64 = stageAggregate(old.apps.corten.runs["fixture-en-US-page"], "sat64", 3);
  for (const run of current.apps.corten.runs["fixture-en-US-page"]) run.phases.sat64.rps *= 2;
  current.apps.corten.phases["fixture-en-US-page"].sat64 = stageAggregate(current.apps.corten.runs["fixture-en-US-page"], "sat64", 3);
  const result = compare(current, old, { unchangedApps: ["corten"] });
  assert.equal(result.compatible, true);
  const row = result.rows.find((r) => r.profile === "fixture-en-US-page" && r.phase === "sat64");
  assert.equal(row.metrics.rps.percentChange, 100);
  assert.equal(row.metrics.rps.rangesOverlap, false);
  assert.equal(row.metrics.p50.percentChange, null);
  assert.deepEqual(row.metrics.rps.baseline, { median: 1002, min: 1001, max: 1003 });
  assert.deepEqual(row.metrics.rps.current, { median: 2004, min: 2002, max: 2006 });
});

test("incompatible, incomplete, development and cross-workload baselines never produce deltas", () => {
  const current = synthetic(); current.round = current.options.round = "r18";
  for (const change of [
    (v) => { v.round = "r16"; },
    (v) => { v.round = v.options.round = "r18"; },
    (v) => { v.round = v.options.round = "r19"; },
    (v) => { v.round = v.options.round = "w1"; },
    (v) => { v.round = "c1"; v.workload = "catalog-v1"; },
    (v) => { v.workload = "marketplace"; },
    (v) => { delete v.schema; },
    (v) => { v.fixtureSha256 = "c".repeat(64); },
    (v) => { v.options.duration++; },
    (v) => { v.options.futureMeasurementOption = true; },
    (v) => { v.options.warmup++; },
    (v) => { v.options.startupTimeout++; },
    (v) => { v.options.rate++; v.measurement.fixedRate++; },
    (v) => { v.measurement.cpus = cpuSettings({ MARKETPLACE_APP_CPUS: "0" }); },
    (v) => { v.measurement.coldClock += " changed"; },
    (v) => { v.host.cpu += " different"; },
    (v) => { v.host.onlineCpus = "0-15"; },
    (v) => { delete v.host.node; },
    (v) => { v.host.docker += " different"; },
    (v) => { v.tools.k6.imageId = `sha256:${"d".repeat(64)}`; },
    (v) => { v.tools.upstream.imageId = `sha256:${"d".repeat(64)}`; },
    (v) => { v.apps.corten.runs["api-neutral-json"].pop(); },
    (v) => { v.apps.corten.checks.fixture.profiles.pop(); },
  ]) {
    const old = synthetic(); change(old);
    const result = compare(current, old, { unchangedApps: ["corten"] });
    assert.equal(result.compatible, false, result.warnings.join("\n"));
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.cold, []);
    assert.deepEqual(result.cohort.rows, []);
    assert.ok(result.warnings.length > 0);
  }
  for (const unchangedApps of ["corten", ["unknown"], ["corten", "corten"]]) {
    const result = compare(current, synthetic(), { unchangedApps });
    assert.equal(result.compatible, false); assert.deepEqual(result.rows, []);
  }
});

test("nightly short-window pinned matrix validates, but has a different comparison key from manual defaults", () => {
  const nightly = (round) => {
    const s = synthetic();
    s.round = s.options.round = round;
    Object.assign(s.options, { duration: 15, warmup: 10 });
    s.measurement.cpus = cpuSettings({ MARKETPLACE_APP_CPUS: "1", MARKETPLACE_API_CPUS: "2-3", MARKETPLACE_LOAD_CPUS: "4-7" });
    return s;
  };
  const old = nightly("r17"), current = nightly("r18");
  validateSummary(current);
  const runs = Object.values(current.apps).flatMap((a) => Object.values(a.runs).flat());
  assert.equal(runs.length, 20 * 8 * 3);
  assert.equal(runs.filter((r) => r.locale === null).length, 20 * 2 * 3);
  assert.match(report(current), /Short 15s phase windows \(10s warmup\)/);
  const key = comparisonKey(old);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(comparisonKey(current), key);
  const compatible = compare(current, old, { unchangedApps: ["corten"] });
  assert.equal(compatible.compatible, true);
  assert.deepEqual(compatible.comparisonKeys, { current: key, baseline: key });
  const reordered = structuredClone(current);
  reordered.options = Object.fromEntries(Object.entries(reordered.options).reverse());
  reordered.measurement = Object.fromEntries(Object.entries(reordered.measurement).reverse());
  assert.equal(comparisonKey(reordered), key, "JSON object property order is not a measurement difference");
  const manual = synthetic();
  manual.measurement.cpus = structuredClone(current.measurement.cpus);
  assert.notEqual(comparisonKey(manual), key, "60s/30s manual windows must not share the nightly key");
  const incompatible = compare(current, manual, { unchangedApps: ["corten"] });
  assert.equal(incompatible.compatible, false);
  assert.deepEqual(incompatible.rows, []);
  assert.ok(incompatible.warnings.some((w) => w.includes("measurement options")));
  const moved = structuredClone(old);
  moved.measurement.cpus = cpuSettings({ MARKETPLACE_APP_CPUS: "0", MARKETPLACE_API_CPUS: "2-3", MARKETPLACE_LOAD_CPUS: "4-7" });
  assert.notEqual(comparisonKey(moved), key);
  assert.equal(compare(current, moved, { unchangedApps: ["corten"] }).compatible, false);
});

test("an app that cannot serve a phase is recorded and marked, and the round still validates (#1128)", () => {
  const s = synthetic();
  const runs = s.apps.rails.runs["fixture-en-US-page"];
  for (const [i, phase] of [[0, "fixed"], [1, "sat256"]]) Object.assign(runs[i].phases[phase], { failed: 50, failedRate: 50 / runs[i].phases[phase].requests, dropped: phase === "fixed" ? 300 : 0, checksFailed: 50, appOutcome: true });
  for (const phase of ["fixed", "sat256"]) s.apps.rails.phases["fixture-en-US-page"][phase] = stageAggregate(runs, phase, 3);
  validateSummary(s);
  const text = report(s);
  assert.ok(text.includes("| rails * (1 of 3 passes) |"), "the stage is marked in its table");
  assert.ok(text.includes("App outcome: rails fixture-en-US-page fixed pass 1: 50 of 1001 requests failed (5.00%), 300 fixed-rate iterations dropped, 50 checks failed."));
  assert.equal(s.apps.rails.phases["fixture-en-US-page"].fixed.appOutcomes, 1);
  Object.assign(s.apps.rails.runs["fixture-en-US-page"][2].warmup, { failed: 5, failedRate: 0.005, checksFailed: 5, appOutcome: true });
  assert.ok(report(s).includes("App outcome in warmup (not measured): rails fixture-en-US-page pass 3: 5 of 1000 requests failed (0.50%)"));
  for (const change of [
    (v) => { v.apps.rails.runs["fixture-en-US-page"][0].phases.fixed.appOutcome = false; },
    (v) => { v.apps.corten.runs["fixture-en-US-page"][0].phases.fixed.appOutcome = true; },
    (v) => { v.apps.rails.runs["fixture-en-US-page"][0].phases.fixed.failedRate = 0.5; },
    (v) => { Object.assign(v.apps.rails.runs["fixture-en-US-page"][0].phases.fixed, { failed: 1001, failedRate: 1 }); },
    (v) => { v.apps.rails.phases["fixture-en-US-page"].fixed.appOutcomes = 0; },
    (v) => { v.apps.rails.runs["fixture-en-US-page"][0].phases.fixed.checksFailed = 100; },
  ]) { const bad = structuredClone(s); change(bad); assert.throws(() => validateSummary(bad)); }
});

test("a stage that fails requests now and failed none before is a new outcome, and saturated references leave the cohort (#1128)", () => {
  const old = synthetic(), current = synthetic(); current.round = current.options.round = "r18";
  current.options.build = false;
  const outcome = (s, app, key, phase) => {
    const runs = s.apps[app].runs[key];
    Object.assign(runs[0].phases[phase], { failed: 10, failedRate: 10 / runs[0].phases[phase].requests, checksFailed: 10, appOutcome: true });
    s.apps[app].phases[key][phase] = stageAggregate(runs, phase, 3);
  };
  outcome(current, "corten", "fixture-en-US-page", "sat256");
  outcome(current, "rails", "fixture-en-US-page", "sat64");
  const result = compare(current, old, { unchangedApps: ["rails", "nextjs"] });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.newOutcomes.map((o) => [o.app, o.profile, o.phase]), [["corten", "fixture-en-US-page", "sat256"], ["rails", "fixture-en-US-page", "sat64"]]);
  const group = result.cohort.rows.find((g) => g.profile === "fixture-en-US-page" && g.phase === "sat64");
  assert.deepEqual(group.outcomeApps, ["rails"]);
  assert.equal(group.metrics.rps.apps, 1, "only nextjs is in the cohort for that stage");
  // above a baseline that already failed, only a range wholly above it is new
  const again = compare(current, current, { unchangedApps: [] });
  assert.equal(again.compatible, false, "a round is not its own baseline");
  const later = structuredClone(current); later.round = later.options.round = "r19";
  const runs = later.apps.corten.runs["fixture-en-US-page"];
  runs[1].phases.sat256 = { ...runs[1].phases.sat256, failed: 11, failedRate: 11 / runs[1].phases.sat256.requests, checksFailed: 11, appOutcome: true };
  later.apps.corten.phases["fixture-en-US-page"].sat256 = stageAggregate(runs, "sat256", 3);
  assert.ok(compare(later, current).newOutcomes.some((o) => o.app === "corten"), "one more pass with an outcome is new");
  const higher = structuredClone(current); higher.round = higher.options.round = "r19";
  const same = higher.apps.corten.runs["fixture-en-US-page"];
  same[0].phases.sat256 = { ...same[0].phases.sat256, failed: 12, failedRate: 12 / same[0].phases.sat256.requests, checksFailed: 12 };
  higher.apps.corten.phases["fixture-en-US-page"].sat256 = stageAggregate(same, "sat256", 3);
  assert.ok(!compare(higher, current).newOutcomes.some((o) => o.app === "corten"), "a higher failure in ranges that overlap, with the same passes, is not new");
  const failing = (s, round, n) => {
    const v = structuredClone(s); v.round = v.options.round = round;
    for (const r of v.apps.corten.runs["fixture-en-US-page"]) r.phases.sat256 = { ...r.phases.sat256, failed: n, failedRate: n / r.phases.sat256.requests, checksFailed: n, appOutcome: true };
    v.apps.corten.phases["fixture-en-US-page"].sat256 = stageAggregate(v.apps.corten.runs["fixture-en-US-page"], "sat256", 3);
    return v;
  };
  const base = failing(current, "r19", 10);
  assert.ok(compare(failing(current, "r20", 20), base).newOutcomes.some((o) => o.app === "corten"), "with the same passes, a range wholly above the baseline's is new");
  assert.ok(!compare(failing(current, "r20", 10), base).newOutcomes.some((o) => o.app === "corten"), "the same failures are not new");
  assert.deepEqual(compare(current, null).newOutcomes, [], "missing evidence has none");
});

// The app's container stopped in this pass and phase: the run keeps the phases before it, and no
// later pass of the profile ran, as run.mjs records it.
function stopProfile(s, app, key, pass, phase, state) {
  const runs = s.apps[app].runs[key];
  runs.length = pass;
  const run = runs[pass - 1];
  run.complete = false;
  if (phase === "warmup") delete run.warmup;
  run.phases = Object.fromEntries(phases.slice(0, Math.max(0, phases.indexOf(phase))).map((p) => [p, run.phases[p]]));
  run.stopped = appStop(state, pass, phase);
  for (const p of phases) s.apps[app].phases[key][p] = stageAggregate(runs, p, 3);
}
const oom = { Running: false, OOMKilled: true, ExitCode: 137 };

test("an app whose container stops under load is that app's recorded outcome, and the round still validates (#1128)", () => {
  const s = synthetic();
  stopProfile(s, "rails", "fixture-en-US-page", 2, "sat64", oom);
  stopProfile(s, "phoenix", "api-neutral-json", 1, "warmup", { Running: false, OOMKilled: false, ExitCode: 1 });
  validateSummary(s);
  assert.equal(s.complete, true);
  const p = s.apps.rails.phases["fixture-en-US-page"];
  assert.deepEqual([p.fixed.passes, p.sat64.passes, p.sat256.passes], [2, 1, 1]);
  assert.deepEqual(p.sat64.stopped, { pass: 2, phase: "sat64", exitCode: 137, oomKilled: true });
  const text = report(s);
  const en = text.split("## en-US\n")[1].split("\n## ")[0];
  // fewer than three passes say what the number is: of two the lower value in each column on its
  // own (spread), so not one pass's numbers; of one, that pass
  assert.ok(en.includes("| rails (stopped: 2 of 3 passes; the lower of two values per column, not a median) | 1000.00 [1000.00-1000.00] |"), "the cold starts keep the passes before the stop, marked");
  assert.ok(en.includes("| rails (stopped: 2 of 3 passes; the lower of two values per column, not a median) | 1001.00 [1001.00-1002.00] |"), "so does the fixed stage");
  assert.doesNotMatch(text, /lower pass/, "the mark does not say the numbers come from one pass");
  assert.ok(text.includes("of two passes each number is the lower of the two values in its column"));
  assert.ok(en.includes("| rails (stopped: 1 of 3 passes; one pass, no range) | 1001.00 [1001.00-1001.00] |"));
  assert.ok(text.includes("except in a row marked stopped, which has fewer"), "the header does not call every number a three-pass median");
  assert.ok(en.includes("App stopped: rails fixture-en-US-page sat64: its container was OOM-killed (exit code 137) during sat64 in pass 2."));
  assert.doesNotMatch(text, /GiB limit/, "OOMKilled does not say whose limit was hit");
  assert.equal(en.match(/^App stopped: rails /gm).length, 3, "every stage that lost a pass names the stop");
  assert.doesNotMatch(en, /\| (corten|nextjs|phoenix)[^|]*stopped/, "other apps keep their results unmarked");
  assert.doesNotMatch(text.split("## fr-FR\n")[1].split("\n## ")[0], /stopped:/, "the app's other profiles still ran");
  assert.ok(text.includes("| phoenix (stopped: 0 of 3 passes) | - | - | - | - | - | - | - | - | - | - |"), "a stage with no pass shows no number");
  assert.ok(text.includes("App stopped: phoenix api-neutral-json fixed: its container exited with code 1 during warmup in pass 1."));
  const runs = (v) => v.apps.rails.runs["fixture-en-US-page"];
  for (const change of [
    (v) => { v.apps.rails.phases["fixture-en-US-page"].sat64.stopped = null; },
    (v) => { v.apps.corten.phases["fixture-en-US-page"].fixed.stopped = structuredClone(p.sat64.stopped); },
    (v) => { runs(v)[1].stopped.pass = 1; },
    (v) => { runs(v)[1].stopped.phase = "sat256"; },
    (v) => { runs(v)[1].stopped.reason = "killed"; },
    (v) => { Object.assign(runs(v)[1].stopped, { exitCode: null, oomKilled: false }); },
    (v) => { delete runs(v)[1].stopped; },
    (v) => { runs(v)[1].complete = true; },
    (v) => { runs(v)[1].failed = "broken"; },
    (v) => { runs(v)[1].phases.sat64 = runs(v)[1].phases.fixed; },
    (v) => { runs(v).push({ ...structuredClone(v.apps.corten.runs["fixture-en-US-page"][2]) }); },
    (v) => { v.apps.phoenix.runs["api-neutral-json"][0].warmup = structuredClone(v.apps.corten.runs["api-neutral-json"][0].warmup); },
    (v) => { v.apps.rails.failures = [{ stage: "load page pass 2" }]; },
  ]) { const bad = structuredClone(s); change(bad); assert.throws(() => validateSummary(bad)); }
});

test("a stage the app stopped in is an outcome, not a comparable number, and new when the baseline's had no stop (#1128)", () => {
  const old = synthetic(), current = synthetic(); current.round = current.options.round = "r18";
  stopProfile(current, "corten", "fixture-en-US-page", 3, "sat256", oom);
  stopProfile(current, "rails", "fixture-en-US-page", 3, "sat256", { Running: false, OOMKilled: false, ExitCode: 1 });
  const result = compare(current, old, { unchangedApps: ["rails", "nextjs"] });
  assert.equal(result.compatible, true, result.warnings.join("\n"));
  assert.deepEqual(result.newOutcomes.map((o) => [o.app, o.profile, o.phase]), [["corten", "fixture-en-US-page", "sat256"], ["rails", "fixture-en-US-page", "sat256"]]);
  assert.deepEqual(result.newOutcomes[0].stopped, { baseline: null, current: { pass: 3, phase: "sat256", exitCode: 137, oomKilled: true } });
  const row = (r, app, phase) => r.rows.find((x) => x.app === app && x.profile === "fixture-en-US-page" && x.phase === phase);
  assert.equal(row(result, "corten", "sat256").metrics, null, "no delta from the passes before a stop");
  assert.ok(row(result, "corten", "sat256").warnings.some((w) => w.includes("current pass 3: app container OOM-killed during sat256")));
  assert.equal(row(result, "corten", "sat64").metrics.rps.percentChange, 0, "the stages it served in every pass still compare");
  const group = result.cohort.rows.find((g) => g.profile === "fixture-en-US-page" && g.phase === "sat256");
  assert.deepEqual(group.outcomeApps, ["rails"]); assert.equal(group.metrics.rps.apps, 1);
  // a pass-3 stop came after all three cold starts were measured: the cold rows still compare
  const cold = (r, app) => r.cold.find((c) => c.app === app && c.profile === "fixture-en-US-page");
  assert.deepEqual(cold(result, "corten").stopped, { baseline: null, current: null });
  assert.equal(cold(result, "corten").metrics.first200MsFromContainerStart.percentChange, 0);
  const coldGroup = (r) => r.cohort.cold.find((g) => g.profile === "fixture-en-US-page");
  assert.equal(coldGroup(result).outcomeApps, undefined); assert.equal(coldGroup(result).metrics.first200MsFromContainerStart.apps, 2);
  // a pass-2 stop lost the third cold start: no cold number, for Corten and the cohort alike
  const earlier = structuredClone(old); earlier.round = earlier.options.round = "r18";
  stopProfile(earlier, "corten", "fixture-en-US-page", 2, "fixed", oom);
  stopProfile(earlier, "rails", "fixture-en-US-page", 2, "fixed", oom);
  const lost = compare(earlier, old, { unchangedApps: ["rails", "nextjs"] });
  assert.deepEqual(cold(lost, "corten").stopped.current, { pass: 2, phase: "fixed", exitCode: 137, oomKilled: true });
  assert.equal(cold(lost, "corten").metrics, null);
  assert.deepEqual(coldGroup(lost).outcomeApps, ["rails"]); assert.equal(coldGroup(lost).metrics.first200MsFromContainerStart.apps, 1);
  // the same stop in the baseline is not new; a stop only in the baseline is neither new nor a number
  const later = structuredClone(current); later.round = later.options.round = "r19";
  const again = compare(later, current);
  assert.ok(!again.newOutcomes.some((o) => o.app === "corten"));
  assert.equal(row(again, "corten", "sat256").metrics, null);
  const clean = synthetic(); clean.round = clean.options.round = "r19";
  const recovered = compare(clean, current);
  assert.ok(!recovered.newOutcomes.some((o) => o.app === "corten")); assert.equal(row(recovered, "corten", "sat256").metrics, null);
  // a stop where the baseline only failed requests is new, whatever the failure counts
  const failing = structuredClone(old); failing.round = failing.options.round = "r19";
  for (const r of failing.apps.corten.runs["fixture-en-US-page"]) Object.assign(r.phases.fixed, { failed: 10, failedRate: 10 / r.phases.fixed.requests, checksFailed: 10, appOutcome: true });
  failing.apps.corten.phases["fixture-en-US-page"].fixed = stageAggregate(failing.apps.corten.runs["fixture-en-US-page"], "fixed", 3);
  const dies = structuredClone(old); dies.round = dies.options.round = "r20";
  stopProfile(dies, "corten", "fixture-en-US-page", 1, "warmup", oom);
  assert.deepEqual(compare(dies, failing).newOutcomes.map((o) => o.phase), ["fixed", "sat64", "sat256"]);
});

test("a stop earlier than the baseline's is a new outcome; the same or a later one is not (#1128)", () => {
  const round = (name, pass, phase) => { const v = synthetic(); v.round = v.options.round = name; if (pass) stopProfile(v, "corten", "fixture-en-US-page", pass, phase, oom); return v; };
  const news = (current, baseline) => compare(current, baseline).newOutcomes.filter((o) => o.app === "corten").map((o) => o.phase);
  const base = round("r19", 3, "sat256");
  assert.deepEqual(news(round("r20", 3, "sat256"), base), [], "the same stop");
  assert.deepEqual(news(round("r20", 3, "sat64"), base), ["sat64", "sat256"], "an earlier phase in the same pass: sat64 newly stopped, sat256 stopped earlier");
  assert.deepEqual(news(round("r20", 2, "sat256"), base), ["fixed", "sat64", "sat256"], "an earlier pass: every stage lost more passes");
  assert.deepEqual(news(round("r20", 1, "warmup"), round("r19", 1, "sat64")), ["fixed", "sat64", "sat256"], "same pass, earlier phase, even where both stages have no pass");
  assert.deepEqual(news(round("r20", 3, "sat256"), round("r19", 2, "sat64")), [], "a later stop is not new");
  assert.deepEqual(news(round("r20"), base), [], "no stop now is not new");
});

// A summary as a v3 round (r19, at main 25acd6a7) writes it: no stop records, and aggregates
// without the stopped field.
function asV3(s, round) {
  const v = structuredClone(s);
  v.schema = "marketplace-results/v3"; v.round = v.options.round = round;
  for (const a of Object.values(v.apps)) for (const stages of Object.values(a.phases)) for (const p of Object.values(stages)) delete p.stopped;
  return v;
}

test("a v3 summary is read as v4 with no stop records: it validates and reports with no stop lines", () => {
  const s = asV3(synthetic(), "r19");
  validateSummary(s);
  const text = report(s);
  assert.ok(text.includes("Schema: `marketplace-results/v3` (read as v4"));
  assert.doesNotMatch(text, /^App stopped:/m, "no stop line");
  assert.doesNotMatch(text, /^\| [^|]+\(stopped:/m, "no stopped mark beside any numbers");
  assert.equal(text.match(/^#### Fixed 150 req\/s$/gm).length, 8);
  const stopped = synthetic(); stopProfile(stopped, "rails", "fixture-en-US-page", 2, "sat64", oom);
  for (const bad of [
    asV3(stopped, "r19"),
    (() => { const v = structuredClone(s); v.apps.corten.phases["fixture-en-US-page"].fixed.stopped = null; return v; })(),
    (() => { const v = structuredClone(s); v.apps.corten.runs["fixture-en-US-page"].pop(); return v; })(),
    { ...s, schema: "marketplace-results/v2" },
    { ...s, schema: "marketplace-results/v5" },
    { ...synthetic(), schema: "marketplace-results/v3" },
  ]) assert.throws(() => validateSummary(bad));
});

test("a v3 baseline compares with a v4 round, and a stop in the v4 round is a new outcome", () => {
  const baseline = asV3(synthetic(), "r19");
  const current = synthetic(); current.round = current.options.round = "r20";
  stopProfile(current, "corten", "fixture-en-US-page", 3, "sat256", oom);
  stopProfile(current, "rails", "api-de-DE-page", 1, "warmup", { Running: false, OOMKilled: false, ExitCode: 1 });
  const result = compare(current, baseline, { unchangedApps: ["rails", "nextjs"] });
  assert.equal(result.compatible, true, result.warnings.join("\n"));
  assert.equal(result.comparisonKeys.current, result.comparisonKeys.baseline, "the same measurement read as v4 has one key");
  assert.deepEqual(result.newOutcomes.map((o) => [o.app, o.profile, o.phase]), [
    ["corten", "fixture-en-US-page", "sat256"], ["rails", "api-de-DE-page", "fixed"], ["rails", "api-de-DE-page", "sat64"], ["rails", "api-de-DE-page", "sat256"]]);
  assert.deepEqual(result.newOutcomes[0].stopped, { baseline: null, current: { pass: 3, phase: "sat256", exitCode: 137, oomKilled: true } });
  const row = (app, profile, phase) => result.rows.find((r) => r.app === app && r.profile === profile && r.phase === phase);
  assert.equal(row("corten", "fixture-en-US-page", "sat256").metrics, null);
  assert.deepEqual(row("corten", "fixture-en-US-page", "sat64").stopped, { baseline: null, current: null });
  assert.equal(row("corten", "fixture-en-US-page", "sat64").metrics.rps.percentChange, 0);
  assert.equal(compare(asV3(synthetic(), "r20"), baseline).compatible, true, "two v3 rounds still compare");
});
