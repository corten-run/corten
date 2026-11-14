import assert from "node:assert/strict";
import test from "node:test";
import { replayStatsClient } from "./stats.mjs";

test("stats child closure is an exclusive, bounded OS process receipt", () => {
  const names = ["actual-app", "actual-upstream", "actual-load"], hash = "a".repeat(64);
  const receipt = { schema: "mixed-native-stats-client/v1", names, startedUnixMs: 100, pid: 123,
    spawnedUnixMs: 101, stopRequestedUnixMs: 501, closedUnixMs: 502, exitCode: null, signal: "SIGTERM", rawSha256: hash, failures: [] };
  const window = { startedUnixMs: 200, finishedUnixMs: 500 };
  replayStatsClient(receipt, names, hash, window);
  for (const mutate of [
    (v) => { v.spawnedUnixMs = 201; }, (v) => { v.stopRequestedUnixMs = 499; },
    (v) => { v.closedUnixMs = 500; }, (v) => { v.exitCode = 0; },
    (v) => { v.pid = null; }, (v) => { v.rawSha256 = "b".repeat(64); },
    (v) => { v.names.push(v.names[0]); }, (v) => { v.names = 42; },
    (v) => { v.failures.push("stats-row-invalid"); }, (v) => { v.unknown = true; },
  ]) { const v = structuredClone(receipt); mutate(v); assert.throws(() => replayStatsClient(v, names, hash, window)); }
});
