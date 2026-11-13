import assert from "node:assert/strict";

export async function trackedImageBuild(summary, tag, save, build) {
  summary.ownedImages ??= [];
  assert.ok(!summary.ownedImages.includes(tag));
  summary.ownedImages.push(tag);
  save(); // Ownership must survive a failed/cancelled build or post-build inspect.
  return build();
}

export async function removeOwnedImage(tag, runId, docker) {
  const ids = await docker(["image", "ls", "-q", tag], { cleanup: true });
  if (!ids) return; // Cancellation before the daemon creates a tag is not a leak.
  const image = JSON.parse(await docker(["image", "inspect", tag], { cleanup: true }))[0];
  assert.equal(image.Config.Labels?.["run.corten.hardening"], runId, "refusing unowned image cleanup");
  await docker(["image", "rm", tag], { cleanup: true });
}

export async function trackedNetworkCreate(summary, name, save, create) {
  summary.ownedNetworks ??= [];
  assert.ok(!summary.ownedNetworks.includes(name));
  summary.ownedNetworks.push(name);
  save(); // Reserve before asking the daemon, including cancellation before acknowledgement.
  return create();
}

export async function removeOwnedNetwork(name, runId, docker) {
  const ids = await docker(["network", "ls", "--no-trunc", "--filter", `name=${name}`, "-q"], { cleanup: true });
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const network = JSON.parse(await docker(["network", "inspect", id], { cleanup: true }))[0];
    if (network.Name !== name) continue; // Docker's name filter is not exact.
    assert.equal(network.Labels?.["run.corten.hardening"], runId, "refusing unowned network cleanup");
    assert.equal(network.Labels?.["agent.owner"], "codex", "refusing unowned network cleanup");
    assert.equal(network.Labels?.["agent.task"], runId, "refusing unowned network cleanup");
    assert.deepEqual(network.Containers, {}, "owned network still has attached processes");
    await docker(["network", "rm", network.Id], { cleanup: true });
  }
}

export function requireSourceControl(assessment, label) {
  if (assessment.sourceControl !== "target-functional-failure" && !assessment.targetFunctionalFailures?.length) return;
  const error = new Error(`${label} native functional controls failed; no attack qualification`);
  error.failureKind = "target-functional-failure";
  throw error;
}

export function failureKind(stage, error) {
  if (error.failureKind === "target-functional-failure") return error.failureKind;
  return ["native-parity", "edge-parity", "native-form"].includes(stage) ? "parity-blocked" : "apparatus-invalid";
}

export function terminalRecovery(recovered, processes, resources, lifecycle, source = "fixture") {
  const applications = processes.filter((p) => p.role === "application");
  const critical = processes.filter((p) => p.role === "application" || p.role === "proxy" || p.role === "upstream" && source === "api");
  const terminalServices = critical.map((p) => {
    const state = lifecycle[p.id].after.State;
    assert.equal(typeof state.Running, "boolean");
    return { id: p.id, role: p.role, running: state.Running, finishedAt: state.FinishedAt, exitCode: state.ExitCode, oomKilled: state.OOMKilled, evidence: `${p.id}-lifecycle.json` };
  });
  for (const p of processes.filter((p) => p.role === "upstream" && source === "fixture")) assert.equal(lifecycle[p.id].after.State.Running, true, "fixture apparatus upstream exited");
  const terminalApplications = terminalServices.filter((p) => p.role === "application").map(({ role, ...p }) => p);
  const sampledRunning = resources.filter((r) => applications.some((p) => p.id === r.id)).every((r) => r.running);
  const terminalRunning = terminalServices.every((r) => r.running)
    && resources.filter((r) => critical.some((p) => p.id === r.id)).every((r) => r.running);
  // A midpoint sample cannot override a later terminal exit. Preserve its real timestamp
  // instead of moving the Docker observation into an earlier oracle sample/window.
  return { disposition: !sampledRunning ? "stopped" : !terminalRunning ? "not-recovered" : recovered ? "recovered" : "not-recovered", terminalApplications, terminalServices };
}
