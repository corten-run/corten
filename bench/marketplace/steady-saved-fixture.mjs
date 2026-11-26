// Synthetic saved convergence and soak passes for validator and report tests only, never benchmark
// results: every field a convergence v8 or soak v10 summary.json saves, with values that match their saved patterns.
import { cpuSettings } from "./run-contract.mjs";
import { cellCreates, containerChecks, convergenceSchema, cpuModelDigest, flattenRule, passCreates, passScope, savedOptions, soakMemoryClock, soakSchema, timedStartup, windowClock } from "./steady-contract.mjs";

export const pinnedEnv = Object.freeze({ MARKETPLACE_APP_CPUS: "1", MARKETPLACE_LOAD_CPUS: "4-7", MARKETPLACE_API_CPUS: "2-3" });
/**
 * A complete saved pass for parseSteadyArgs `options`, with `cells` and any field replaced by
 * `overrides` (host, tools and measurement are merged into their defaults). Adapter image IDs are
 * sha256:1..., sha256:2... in the options' order. Its cleanup created and removed what every cell
 * would have made had it been measured (passCreates, cellCreates).
 */
export function savedPass(options, cells, { commit = "c".repeat(40), host = {}, tools = {}, measurement = {}, ...overrides } = {}) {
  const saved = savedOptions(options), kind = saved.kind, created = passCreates + cells.length * cellCreates[kind];
  return { schema: kind === "convergence" ? convergenceSchema : soakSchema, name: saved.name, runId: `marketplace-${kind}-${saved.name}-0123456789`, options: saved,
    ...(kind === "convergence" ? { rule: flattenRule } : {}), startedAt: "2026-11-20T00:00:00.000Z", finishedAt: "2026-11-20T01:00:00.000Z", complete: true, failures: [],
    cleanup: { complete: true, remaining: { containers: 0, networks: 0 }, created, removed: created, recovered: 0, failures: 0, unacknowledged: [] }, cells, admission: null, startup: timedStartup,
    host: { platform: "linux", release: "6.8.0-test", node: "v26.13.1", docker: "27.5.1", kernel: "6.8.0-test", cpuModelSha256: cpuModelDigest("Synthetic test only"), onlineCpus: "0-7", ...host },
    scope: passScope[kind],
    measurement: { cpus: cpuSettings(pinnedEnv), appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, encoding: "identity", clock: windowClock, containerChecks, ...(kind === "soak" ? { memoryClock: soakMemoryClock } : {}), ...measurement },
    commit, finishedCommit: commit, dirty: false, fixtureSha256: "f".repeat(64),
    images: Object.fromEntries(saved.apps.map((app, i) => [app, `sha256:${(i + 1).toString(16).repeat(64)}`])),
    tools: { upstream: { imageId: `sha256:${"4".repeat(64)}` }, k6: { imageId: `sha256:${"5".repeat(64)}`, version: "2.4.0" }, ...tools }, ...overrides };
}
