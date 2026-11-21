import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyHardeningCpuRoles } from "./evidence.mjs";

function fixture(mode, phase) {
  const cell = { mode, phase };
  const wall = Date.parse("2026-11-21T12:00:01Z");
  const iso = (delta) => new Date(wall + delta).toISOString();
  const roles = ["application", "upstream", ...(mode === "deployed-edge" ? ["proxy"] : []), "probe"];
  const cpus = { application: "1", upstream: "2", proxy: "3", probe: "4-5" };
  const evidence = { schema: "native-hardening-cpu-roles/v1", before: {}, after: {} };
  const launches = roles.map((step, i) => {
    const Id = (i + 1).toString().repeat(64), Image = "sha256:" + "b".repeat(64), Pid = i + 200;
    const path = "/system.slice/docker-" + Id + ".scope", StartedAt = iso(-300);
    evidence.before[step] = { id: Id, imageId: Image, pid: Pid, startedAt: StartedAt, startTicks: "123456", path, atMs: wall - 10, groups: [
      { path, files: { "cgroup.procs": Pid + "\n", "cpuset.cpus.effective": cpus[step] + "\n" } },
      { path: path + "/worker", files: { "cgroup.procs": Pid + 100 + "\n", "cpuset.cpus.effective": cpus[step][0] + "\n" } },
    ] };
    evidence.after[step] = { ...structuredClone(evidence.before[step]), atMs: wall + 120 };
    const role = step === "probe" ? "apparatus" : step === "application"
      ? mode === "direct" ? "applicationDirect" : "applicationEdge" : step;
    return { intent: { role, step }, created: { Id, Image, State: { Pid: step === "probe" ? 0 : Pid } },
      terminal: { State: { StartedAt, FinishedAt: iso(150), Status: step === "probe" ? "exited" : "running" } } };
  });
  const raw = [{ type: "clock", wallAtStart: iso(0) }, phase === "dependency-recovery"
    ? { type: phase, upstream: { after: { observedAtMs: 100 } } } : { type: "bounded-requests", completeAtMs: 100 }];
  return { cell, evidence, launches, raw };
}

test("saved bounded CPU proof covers direct and edge across all three phases", () => {
  for (const mode of ["direct", "deployed-edge"]) for (const phase of ["request-limit", "request-timeout", "dependency-recovery"]) {
    const { evidence, cell, launches, raw } = fixture(mode, phase);
    assert.doesNotThrow(() => verifyHardeningCpuRoles(evidence, cell, launches, raw));
  }
});

test("saved Linux CPU proof rejects missing actors, substituted lifetimes and CPU0 in an occupied child", () => {
  for (const mutate of [
    ({ evidence }) => { delete evidence.after.proxy; },
    ({ evidence }) => { evidence.before.application.id = evidence.before.upstream.id; },
    ({ evidence }) => { evidence.after.probe.startTicks = "998"; },
    ({ evidence }) => { evidence.after.probe.atMs = evidence.before.probe.atMs; },
    ({ evidence }) => { evidence.before.application.pid = 987; },
    ({ evidence }) => { evidence.after.probe.groups[1].files["cpuset.cpus.effective"] = "0,4\n"; },
    ({ evidence }) => { evidence.before.upstream.groups[1].files["cpuset.cpus.effective"] = "0,2\n"; },
    ({ evidence }) => { evidence.after.application.groups[0].files["cgroup.procs"] = ""; },
  ]) {
    const input = fixture("deployed-edge", "dependency-recovery"); mutate(input);
    const { evidence, cell, launches, raw } = input;
    assert.throws(() => verifyHardeningCpuRoles(evidence, cell, launches, raw));
  }
});

test("an actual service exit corroborated by the owned lifetime does not invent a post-exit cgroup", () => {
  const { evidence, cell, launches, raw } = fixture("direct", "request-timeout");
  const { id, imageId, startedAt, atMs } = evidence.after.application;
  const finishedAt = new Date(atMs - 10).toISOString();
  evidence.after.application = { id, imageId, startedAt, atMs, finishedAt };
  const app = launches.find((r) => r.intent.step === "application");
  assert.throws(() => verifyHardeningCpuRoles(evidence, cell, launches, raw));
  Object.assign(app.terminal.State, { Status: "exited", FinishedAt: finishedAt });
  assert.doesNotThrow(() => verifyHardeningCpuRoles(evidence, cell, launches, raw));
});
