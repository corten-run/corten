// Synthetic validator fixture only. Never imported by the worker.
import { aggregate, phases } from "../../../catalog/contract.mjs";
import { records } from "../../../catalog/fixtures.mjs";
import { groupDescriptor, groupResultSchema, qualificationIdentity, timingPlan } from "../../../catalog/group.mjs";
import { digest } from "../evidence.mjs";

export function catalogResult(binding) {
  const options = structuredClone(binding.execution.effectiveOptions), group = groupDescriptor("catalog-page");
  const imageId = `sha256:${"b".repeat(64)}`;
  const phase = { requests: 6000, rps: 100, p50: 1, p95: 2, p99: 3, failed: 0, dropped: 0,
    perCpuSecond: 110, cpuUsec: 55000000, cpuAvgPct: 99, memMaxMiB: 8, upstream: { cpuAvgPct: 50, highCpu: false } };
  const check = { jsonRecords: 500, pages: 120, profiles: [false, true].flatMap((javaScriptEnabled) =>
    ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].map((profile) => ({ profile, javaScriptEnabled, forms: true, related: true, styles: true }))),
    upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } };
  const s = { schema: groupResultSchema, group, options, workload: "catalog-v1", round: binding.request.round, commit: binding.request.commit,
    dirty: false, commitAfter: binding.request.commit, dirtyAfter: false, complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    startedAt: "2026-11-07T16:00:00Z", finishedAt: "2026-11-07T22:00:00Z", fixtureSha256: digest(`${JSON.stringify(records())}\n`),
    measurement: { encoding: "identity", fixedRate: options.rate, cpus: structuredClone(binding.resources.expectedCpus) },
    apps: Object.fromEntries(group.apps.map((app) => [app, { imageId, checks: Object.fromEntries(group.sources.map((source) =>
      [source, { ...structuredClone(check), qualification: qualificationIdentity(group, app, source, imageId) }])), runs: {} }])) };
  for (const { app, pass, ...profile } of timingPlan(options, group.sources, group.targets)) {
    const key = `${profile.source}-${profile.target}`;
    (s.apps[app].runs[key] ??= []).push({ pass, evidence: { app, ...profile, imageId }, complete: true,
      cold: { path: "/catalog/record_1", first200At: "2026-11-07T16:00:00.200Z", containerStartedAt: "2026-11-07T16:00:00.000Z",
        first200MsFromContainerStart: 200, measuredBeforeReadinessOrWarmup: true, attempts: 2, bytes: 1000, successfulRequestMs: 2 },
      warmup: structuredClone(phase), phases: Object.fromEntries(phases.map((p) => [p, structuredClone(phase)])) });
  }
  for (const entry of Object.values(s.apps)) entry.phases = Object.fromEntries(Object.entries(entry.runs).map(([key, runs]) =>
    [key, Object.fromEntries(phases.map((phase) => [phase, { ...aggregate(runs.map((r) => r.phases[phase])), asked: options.passes }]))]));
  return s;
}
