import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { apps, locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { aggregate, cpuSettings, phases, sources, targets } from "./run-contract.mjs";
import { report, validateSummary } from "./report.mjs";
function synthetic() {
  const s = { workload, round: "w1", commit: "a".repeat(40), dirty: false, complete: true, checksPassed: true,
    failures: [], cleanupFailures: [], finishedCommit: "a".repeat(40), finishedDirty: false,
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T01:00:00Z", options: { apps, checkOnly: false, passes: 3, duration: 60, warmup: 30, rate: 150, startupTimeout: 120 }, apps: {},
    host: { cpu: "Synthetic test only" }, tools: Object.fromEntries(["upstream", "checker", "k6"].map((k) => [k, { imageId: `sha256:${"b".repeat(64)}` }])),
    fixtureSha256: createHash("sha256").update(JSON.stringify(records())).digest("hex"), measurement: { upstream: "Synthetic test only", cpuWindow: "Not measured", coldClock: "Synthetic test only", cpus: cpuSettings({}), encoding: "identity", fixedRate: 150, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20 } };
  for (const app of apps) {
    const a = s.apps[app] = { label: app, imageId: `sha256:${"b".repeat(64)}`, builtCommit: s.commit, builtDirty: false, checks: {}, runs: {}, phases: {} };
    for (const source of sources) {
      a.checks[source] = { workload, source, jsonRecords: 500, pages: 264, profiles: locales.flatMap((locale) => [false, true].flatMap((javaScriptEnabled) => [false, true].map((mobile) => ({ locale, javaScriptEnabled, mobile, passed: true })))),
        upstream: source === "api" ? { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } : null };
      for (const locale of locales) for (const target of targets) {
        const key = `${source}-${locale}-${target}`;
        const metric = { requests: 1000, rps: 1000, p50: 1, p95: 2, p99: 3, failed: 0, dropped: 0 };
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
