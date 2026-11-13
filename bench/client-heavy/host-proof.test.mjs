import assert from "node:assert/strict";
import test from "node:test";
import { verifyHostProof } from "./host-proof.mjs";
import { hostFixture } from "./host-fixture.mjs";
const replay = { commit: "a".repeat(40), round: "unit", subjectSha256: "b".repeat(64), files: [], toolIdentities: { node: "c".repeat(64), browser: "d".repeat(64) },
  executionWindow: { startedAt: 100, endedAt: 1000 }, processWindows: [{ kind: "compiler", startedAt: 200, endedAt: 300 }, { kind: "browser", startedAt: 400, endedAt: 900 }] };
test("worker OS composition requires actual live identities and raw limits", () => {
  const { context, proof } = hostFixture(replay);
  assert.equal(verifyHostProof(replay, context, proof).resources, "observed");
});
for (const [name, mutate, reason] of [
  ["quota intent instead of OS quota", (p) => { p.samples[1].groups[0].cpuMax = "max 100000\n"; }, "actual-cpu-quota"],
  ["nonexclusive cpuset", (p) => { p.samples[1].groups[0].cpuPartition = "member\n"; }, "not-observed-exclusive"],
  ["memory intent", (p) => { p.samples[1].groups[0].memoryMax = "max\n"; }, "actual-memory"],
  ["unaccounted process", (p) => { p.samples[1].groups[0].procs += "7\n"; }, "incomplete-unit-process"],
  ["PID moved outside unit", (p) => { p.samples[1].processes[0].cgroup = "0::/other\n"; }, "process-outside"],
  ["missing live compiler", (p) => { p.samples.splice(1, 1); }, "missing-live-native"],
  ["terminal leak", (p) => { p.samples.at(-1).groups[0].procs = "99\n"; }, "incomplete-unit-process"],
  ["OOM", (p) => { p.samples.at(-1).groups[0].memoryEvents = "max 0\noom 1\noom_kill 1\n"; }, "unit-memory-limit-hit"],
  ["different subject", (p) => { p.subjectSha256 = "e".repeat(64); }, "host-proof-binding"],
]) test(`worker OS composition rejects ${name}`, () => {
  const { context, proof } = hostFixture(replay); mutate(proof); assert.throws(() => verifyHostProof(replay, context, proof), new RegExp(reason));
});
