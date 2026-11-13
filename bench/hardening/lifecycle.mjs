import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { observe } from "./native.mjs";

export const terminalHealthPaths = (qualification, edgeQualification) => ({ application: qualification.probes.live?.path ?? null,
  upstream: "/health", ...(edgeQualification ? { proxy: edgeQualification.probes.live?.path ?? null } : {}) });

export async function observeTerminalHealth(base, path, timeoutMs, request = observe) {
  return { path, response: path === null ? null : await request(base + path, { timeoutMs }) };
}

function liveness(health, path) {
  if (!health) return "unavailable"; // Historical captures have no terminal HTTP observation.
  assert.equal(health.path, path, "terminal health path differs from native qualification");
  if (path === null) { assert.equal(health.response, null); return "missing"; }
  assert.ok(typeof path === "string" && path.startsWith("/"));
  if (health.response === null) { assert.equal(health.unavailable, "not-running"); return "unavailable"; }
  const row = health.response;
  assert.ok(typeof row.body === "string" && typeof row.complete === "boolean" && Number.isFinite(row.ms) && row.ms >= 0);
  assert.equal(row.bytes, Buffer.byteLength(row.body));
  assert.equal(row.sha256, createHash("sha256").update(row.body).digest("hex"), "terminal health bytes differ");
  assert.ok(!["EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(row.error), "local terminal health client failure");
  return row.complete && !row.error && !row.timedOut && row.status === 200 && row.ms <= 600 ? "observed" : "failed";
}

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
  try { return await create(); }
  catch (error) {
    if (error.daemonOutcomeUnknown) {
      summary.cleanupFailures ??= [];
      summary.cleanupFailures.push(`${name}: network-create failure left daemon completion unacknowledged; reconciliation cannot certify cleanup`);
      save();
    }
    throw error;
  }
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

export function terminalRecovery(recovered, processes, resources, lifecycle, source = "fixture", paths = {}) {
  const applications = processes.filter((p) => p.role === "application");
  const critical = processes.filter((p) => p.role === "application" || p.role === "proxy" || p.role === "upstream" && source === "api");
  const terminalServices = critical.map((p) => {
    const state = lifecycle[p.id].after.State;
    assert.equal(typeof state.Running, "boolean");
    const configured = lifecycle[p.id].after.Config?.Healthcheck?.Test;
    const dockerHealth = state.Health?.Status ?? (configured?.length && configured[0] !== "NONE" ? "unavailable" : "not-configured");
    assert.ok(["healthy", "unhealthy", "starting", "unavailable", "not-configured"].includes(dockerHealth));
    return { id: p.id, role: p.role, running: state.Running, finishedAt: state.FinishedAt, exitCode: state.ExitCode, oomKilled: state.OOMKilled,
      dockerHealth, liveness: liveness(lifecycle[p.id].health, paths[p.role]),
      healthy: state.Running && !state.Paused && !state.Restarting && !state.Dead && !state.OOMKilled
        && ["healthy", "not-configured"].includes(dockerHealth), evidence: `${p.id}-lifecycle.json` };
  });
  for (const p of processes.filter((p) => p.role === "upstream" && source === "fixture")) {
    assert.equal(lifecycle[p.id].after.State.Running, true, "fixture apparatus upstream exited");
    if (paths.upstream) assert.equal(liveness(lifecycle[p.id].health, paths.upstream), "observed", "fixture apparatus upstream unhealthy");
  }
  const terminalApplications = terminalServices.filter((p) => p.role === "application").map(({ role, ...p }) => p);
  const sampledRunning = resources.filter((r) => applications.some((p) => p.id === r.id)).every((r) => r.running);
  const terminalRunning = terminalServices.every((r) => r.healthy && r.liveness === "observed")
    && resources.filter((r) => critical.some((p) => p.id === r.id)).every((r) => r.running);
  // A midpoint sample cannot override a later terminal exit. Preserve its real timestamp
  // instead of moving the Docker observation into an earlier oracle sample/window.
  return { disposition: !sampledRunning ? "stopped" : !terminalRunning ? "not-recovered" : recovered ? "recovered" : "not-recovered", terminalApplications, terminalServices };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await observeTerminalHealth(process.argv[2], process.argv[3], Number(process.argv[4]))));
}
