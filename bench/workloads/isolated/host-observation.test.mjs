import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerRead, verifyHostBoundary } from "./host-observation.mjs";

const before = { bootId: "boot", hostname: "host", containers: [], networks: ["bridge"], processes: [{ pid: 1, startTicks: "10", cgroup: "/" }] };
test("host probes cannot become an arbitrary Docker command API", () => {
  for (const args of [["run", "anything"], ["image", "inspect", "--format=anything"], ["image", "inspect", "sha256:bad"],
    ["network", "rm", "bridge"], ["ps", "-aq", "--no-trunc", "--filter", "label=anything"]]) assert.throws(() => dockerRead(args), /fixed read-only/);
});
test("boundary observations never claim verified isolation or resource peak evidence", () => {
  assert.deepEqual(verifyHostBoundary(before, structuredClone(before)), { cleanup: "observed-boundary-matched", isolation: "unverified" });
  for (const mutate of [(v) => { v.bootId = "reboot"; }, (v) => { v.hostname = "other"; }, (v) => v.containers.push("leak"),
    (v) => v.networks.push("leak"), (v) => { v.processes[0].startTicks = "20"; }, (v) => v.processes.push({ pid: 2, startTicks: "30" })]) {
    const after = structuredClone(before); mutate(after); assert.throws(() => verifyHostBoundary(before, after));
  }
});
