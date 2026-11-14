// Opt-in real Docker/PID/cgroup control, not a framework or benchmark qualification.
// Caller creates/owns/removes the fixture container and supplies its original full ID.
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { captureBrowserParticipant, inspectBrowserParticipants, processIdentity } from "./host-lifetime.mjs";

const enabled = process.platform === "linux" && process.env.BROWSER_PARTICIPANT_OS_TESTS === "1";
test("actual owned Docker participant has host-visible PID/start/cgroup and effective controls", {
  skip: !enabled && "requires explicit owned Linux Docker participant fixture", timeout: 15000,
}, async () => {
  const id = process.env.BROWSER_PARTICIPANT_ID;
  assert.match(id, /^[a-f0-9]{64}$/);
  if (process.env.BROWSER_PARTICIPANT_NAMESPACE === "mismatched") {
    assert.throws(() => captureBrowserParticipant(id), (error) =>
      error.code === "ENOENT" && /^\/proc\/[1-9]\d*\/(stat|cgroup|exe)$/.test(error.path ?? "")
      || error.code === "ERR_ASSERTION" && error.message.includes("Docker PID/cgroup namespace correspondence missing"));
    console.log("Actual private-PID namespace mismatch rejected; no OS qualification");
    return;
  }
  const records = [], executables = new Map();
  for (let i = 0; i < 3; i++) { records.push(captureBrowserParticipant(id, executables)); await setTimeout(100); }
  const first = records[0], last = records.at(-1);
  assert.ok(records.every((r) => r.kernel));
  const p = { id, imageId: first.container.imageId, role: "application", app: "fixture", case: "kernel-control",
    window: { startedAt: first.endedAt, endedAt: last.startedAt }, terminal: { id, imageId: first.container.imageId,
      state: last.container.state, limits: { NanoCpus: 1e9, Memory: 2 ** 30, CpusetCpus: "" } } };
  const subject = { schema: "native-browser-host-subject/v2", executionWindow: { startedAt: first.startedAt, endedAt: last.endedAt }, participants: [p] };
  const observation = { context: { bootId: first.kernel.bootId, dockerBaseline: [] },
    samples: records.map((r) => ({ at: r.kernel.at, docker: { inventory: [id], participants: [r], gaps: [] } })) };
  const verified = inspectBrowserParticipants(subject, observation);
  console.log(JSON.stringify({ observations: records.map((r) => ({ duration: r.endedAt - r.startedAt, at: r.kernel.at,
    ancestors: r.kernel.ancestors.map((g) => ({ path: g.path,
      controls: Object.fromEntries(["cpu.max", "cpuset.cpus.effective", "memory.max"].map((k) => [k, g.files[k]])) })) })),
    resourceReplay: verified ? "verified" : "blocked" }));
  assert.equal(verified, true);
  const root = last.kernel.groups.find((g) => g.path === last.kernel.cgroup.trim().slice(3));
  console.log(JSON.stringify({ participant: id, ...processIdentity(first.kernel.stat), cgroup: first.kernel.cgroup.trim(),
    bootId: first.kernel.bootId, samples: records.length,
    controls: Object.fromEntries(["cpu.max", "cpuset.cpus.effective", "memory.max"].map((k) => [k, root.files[k].trim()])),
    resourceReplay: "verified", scope: "actual fixture participant only; not native browser qualification" }));
});
