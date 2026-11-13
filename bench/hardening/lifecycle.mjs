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

export function requireSourceControl(assessment, label) {
  if (assessment.sourceControl !== "target-functional-failure") return;
  const error = new Error(`${label} API-source controls failed; no attack qualification`);
  error.failureKind = "target-functional-failure";
  throw error;
}

export function failureKind(stage, error) {
  if (error.failureKind === "target-functional-failure") return error.failureKind;
  return ["native-parity", "edge-parity", "native-form"].includes(stage) ? "parity-blocked" : "apparatus-invalid";
}

export function terminalRecovery(recovered, processes, resources, lifecycle) {
  const applications = processes.filter((p) => p.role === "application");
  const terminalApplications = applications.map((p) => {
    const state = lifecycle[p.id].after.State;
    assert.equal(typeof state.Running, "boolean");
    return { id: p.id, running: state.Running, finishedAt: state.FinishedAt, exitCode: state.ExitCode, oomKilled: state.OOMKilled, evidence: `${p.id}-lifecycle.json` };
  });
  const sampledRunning = resources.filter((r) => applications.some((p) => p.id === r.id)).every((r) => r.running);
  const terminalRunning = terminalApplications.every((r) => r.running);
  // A midpoint sample cannot override a later terminal exit. Preserve its real timestamp
  // instead of moving the Docker observation into an earlier oracle sample/window.
  return { disposition: !sampledRunning ? "stopped" : !terminalRunning ? "not-recovered" : recovered ? "recovered" : "not-recovered", terminalApplications };
}
