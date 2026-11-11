import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { apps, locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { aggregate, cpuSettings, phases, resultSchema, sources, timedProfiles } from "./run-contract.mjs";
import { report, validateSummary } from "./report.mjs";
import { compare, comparisonKey } from "./compare.mjs";
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
        a.phases[key] = Object.fromEntries(phases.map((p) => [p, { ...aggregate(a.runs[key].map((r) => r.phases[p])), asked: 3 }]));
      }
    }
  }
  return s;
}
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
    current.apps[app].phases["fixture-en-US-page"].sat64 = { ...aggregate(current.apps[app].runs["fixture-en-US-page"].map((r) => r.phases.sat64)), asked: 3 };
  }
  for (const run of old.apps.nextjs.runs["fixture-en-US-page"]) run.phases.sat64.p50 = 0;
  old.apps.nextjs.phases["fixture-en-US-page"].sat64 = { ...aggregate(old.apps.nextjs.runs["fixture-en-US-page"].map((r) => r.phases.sat64)), asked: 3 };
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
  old.apps.corten.phases["fixture-en-US-page"].sat64 = { ...aggregate(old.apps.corten.runs["fixture-en-US-page"].map((r) => r.phases.sat64)), asked: 3 };
  for (const run of current.apps.corten.runs["fixture-en-US-page"]) run.phases.sat64.rps *= 2;
  current.apps.corten.phases["fixture-en-US-page"].sat64 = { ...aggregate(current.apps.corten.runs["fixture-en-US-page"].map((r) => r.phases.sat64)), asked: 3 };
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
  for (const phase of ["fixed", "sat256"]) s.apps.rails.phases["fixture-en-US-page"][phase] = { ...aggregate(runs.map((r) => r.phases[phase])), asked: 3 };
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
    s.apps[app].phases[key][phase] = { ...aggregate(runs.map((r) => r.phases[phase])), asked: 3 };
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
  later.apps.corten.phases["fixture-en-US-page"].sat256 = { ...aggregate(runs.map((r) => r.phases.sat256)), asked: 3 };
  assert.ok(compare(later, current).newOutcomes.some((o) => o.app === "corten"), "one more pass with an outcome is new");
  const higher = structuredClone(current); higher.round = higher.options.round = "r19";
  const same = higher.apps.corten.runs["fixture-en-US-page"];
  same[0].phases.sat256 = { ...same[0].phases.sat256, failed: 12, failedRate: 12 / same[0].phases.sat256.requests, checksFailed: 12 };
  higher.apps.corten.phases["fixture-en-US-page"].sat256 = { ...aggregate(same.map((r) => r.phases.sat256)), asked: 3 };
  assert.ok(!compare(higher, current).newOutcomes.some((o) => o.app === "corten"), "a higher failure in ranges that overlap, with the same passes, is not new");
  const failing = (s, round, n) => {
    const v = structuredClone(s); v.round = v.options.round = round;
    for (const r of v.apps.corten.runs["fixture-en-US-page"]) r.phases.sat256 = { ...r.phases.sat256, failed: n, failedRate: n / r.phases.sat256.requests, checksFailed: n, appOutcome: true };
    v.apps.corten.phases["fixture-en-US-page"].sat256 = { ...aggregate(v.apps.corten.runs["fixture-en-US-page"].map((r) => r.phases.sat256)), asked: 3 };
    return v;
  };
  const base = failing(current, "r19", 10);
  assert.ok(compare(failing(current, "r20", 20), base).newOutcomes.some((o) => o.app === "corten"), "with the same passes, a range wholly above the baseline's is new");
  assert.ok(!compare(failing(current, "r20", 10), base).newOutcomes.some((o) => o.app === "corten"), "the same failures are not new");
  assert.deepEqual(compare(current, null).newOutcomes, [], "missing evidence has none");
});
