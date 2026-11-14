// Synthetic native validator data only, never benchmark measurements.
import { locales, workload } from "../../../marketplace/contract.mjs";
import { records } from "../../../marketplace/fixtures.mjs";
import { phases, resultSchema, sources, stageAggregate, timedProfiles } from "../../../marketplace/run-contract.mjs";
import { featureProfile, qualification, qualificationSettings } from "../../../marketplace/feature-contract.mjs";
import { qualificationProbes } from "../../../marketplace/qualification-fixture.mjs";
import { digest } from "../evidence.mjs";

export function marketplaceResult(binding) {
  const options = structuredClone(binding.execution.effectiveOptions), commit = binding.request.commit;
  const s = { schema: resultSchema, workload, round: options.round, commit, dirty: false, complete: true, checksPassed: true,
    failures: [], cleanupFailures: [], finishedCommit: commit, finishedDirty: false,
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T01:00:00Z", options, apps: {},
    host: { cpu: "Synthetic test only", onlineCpus: "0-7" }, tools: Object.fromEntries(["upstream", "checker", "k6"].map((k) => [k, { imageId: `sha256:${"b".repeat(64)}` }])),
    fixtureSha256: digest(JSON.stringify(records())), measurement: { profiles: timedProfiles, upstream: "Synthetic test only", cpuWindow: "Not measured", coldClock: "Synthetic test only",
      cpus: binding.resources.expectedCpus, encoding: "identity", fixedRate: options.rate, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, featureProfile, qualificationSettings } };
  for (const app of options.apps) {
    const a = s.apps[app] = { label: app, imageId: `sha256:${"b".repeat(64)}`, builtCommit: commit, builtDirty: false, checks: {}, runs: {}, phases: {},
      qualification: Object.fromEntries(sources.map((source) => [source, qualification(qualificationProbes(), source)])) };
    for (const source of sources) {
      a.checks[source] = { workload, source, jsonRecords: 500, pages: 264,
        profiles: locales.flatMap((locale) => [false, true].flatMap((javaScriptEnabled) => [false, true].map((mobile) => ({ locale, javaScriptEnabled, mobile, passed: true })))),
        upstream: source === "api" ? { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } : null };
      for (const { key, locale, target } of timedProfiles.filter((p) => p.source === source)) {
        const metric = { requests: 1000, rps: 1000, p50: 1, p95: 2, p99: 3, failed: 0, failedRate: 0, dropped: 0, checksFailed: 0, appOutcome: false };
        const stats = { cpuUsec: 1000000, samples: 3, cpuAvgPct: 100, cpuMaxPct: 110, memAvgMiB: 10, memMaxMiB: 11 };
        a.runs[key] = [1, 2, 3].map((pass) => ({ pass, locale, complete: true, startedAt: "2026-01-01T00:01:00Z", finishedAt: "2026-01-01T00:03:00Z",
          cold: { containerStartedAt: "2026-01-01T00:02:00Z", first200At: "2026-01-01T00:02:01Z", first200MsFromContainerStart: 1000,
            measuredBeforeReadinessOrWarmup: true, path: target === "json" ? "/api/marketplace/item_1" : `/marketplace/${locale}/item_1`, attempts: 1, bytes: 100, successfulRequestMs: 1 },
          warmup: metric, phases: Object.fromEntries(phases.map((p) => [p, { ...metric, ...stats, requests: 1000 + pass, rps: 1000 + pass, perCpuSecond: 1000 + pass,
            upstream: source === "api" ? { ...stats, highCpu: true } : null }])) }));
        a.phases[key] = Object.fromEntries(phases.map((p) => [p, stageAggregate(a.runs[key], p, 3)]));
      }
    }
  }
  return s;
}
