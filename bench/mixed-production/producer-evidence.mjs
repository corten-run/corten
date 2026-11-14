import assert from "node:assert/strict";

const roles = ["app", "upstream", "load"];
const idPattern = /^[a-f0-9]{64}$/;

// Persist the original response before parsing it, including unsuccessful reads.
export async function cpuBoundary({ docker, reader, participants, phase, onReceipt }) {
  assert.ok(["before", "after"].includes(phase));
  assert.deepEqual(Object.keys(participants).sort(), [...roles].sort());
  const ids = roles.map((role) => participants[role].id);
  assert.ok(ids.every((id) => idPattern.test(id)) && new Set(ids).size === roles.length);
  const receipt = { schema: "mixed-native-cpu-boundary/v1", phase,
    participantIds: Object.fromEntries(roles.map((role) => [role, participants[role].id])),
    startedUnixMs: Date.now(), receivedUnixMs: null, raw: null, failure: null };
  try {
    receipt.raw = await docker(["exec", reader, "node", "/src/bench/catalog/cgroup.mjs", ...ids]);
  } catch {
    receipt.failure = "cgroup-command-failed";
  }
  receipt.receivedUnixMs = Date.now();
  onReceipt(receipt);
  return replayCpuBoundary(receipt, participants, phase);
}

export function replayCpuBoundary(receipt, participants, phase) {
  assert.equal(receipt.schema, "mixed-native-cpu-boundary/v1");
  assert.equal(receipt.phase, phase);
  assert.deepEqual(Object.keys(participants).sort(), [...roles].sort());
  const expected = Object.fromEntries(roles.map((role) => [role, participants[role].id]));
  assert.ok(Object.values(expected).every((id) => idPattern.test(id)) && new Set(Object.values(expected)).size === roles.length);
  assert.deepEqual(receipt.participantIds, expected, "cgroup response participant identity changed");
  assert.ok(Number.isSafeInteger(receipt.startedUnixMs) && Number.isSafeInteger(receipt.receivedUnixMs)
    && receipt.receivedUnixMs >= receipt.startedUnixMs, "cgroup boundary clock invalid");
  assert.equal(receipt.failure, null, "cgroup boundary command failed");
  assert.ok(typeof receipt.raw === "string" && Buffer.byteLength(receipt.raw) <= 16384, "cgroup response missing/oversize");
  const values = JSON.parse(receipt.raw);
  assert.ok(values && !Array.isArray(values) && typeof values === "object");
  // JSON.parse alone silently accepts duplicate object members. The collector's
  // flat, ID-keyed numeric response has no other string values or nesting.
  assert.match(receipt.raw, /^\s*\{\s*"[a-f0-9]{64}"\s*:\s*\d+(?:\s*,\s*"[a-f0-9]{64}"\s*:\s*\d+)*\s*\}\s*$/);
  const keys = [...receipt.raw.matchAll(/"([a-f0-9]{64})"\s*:/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, "duplicate cgroup participant");
  assert.deepEqual(keys.toSorted(), Object.values(expected).toSorted(), "missing/extra cgroup participant");
  assert.ok(Object.values(values).every((value) => Number.isSafeInteger(value) && value >= 0), "invalid CPU counter");
  return Object.fromEntries(roles.map((role) => [role, values[expected[role]]]));
}

export async function participantEvidence({ inspect, name, imageId, role, paused = false, onReceipt }) {
  const info = await inspect(name);
  const evidence = { schema: "mixed-native-participant-boundary/v1", role, id: info.Id, imageId: info.Image,
    startedAt: info.State?.StartedAt, restartCount: info.RestartCount,
    running: info.State?.Running, oomKilled: info.State?.OOMKilled, paused: info.State?.Paused };
  // A failed participant remains evidence rather than disappearing at an assert.
  onReceipt(evidence);
  assert.ok(idPattern.test(evidence.id));
  assert.equal(evidence.imageId, imageId, "native participant image changed");
  assert.ok(evidence.running === true && evidence.oomKilled === false && evidence.restartCount === 0,
    "native participant stopped/restarted/OOM");
  assert.equal(evidence.paused, paused, "native participant pause state changed");
  assert.ok(typeof evidence.startedAt === "string" && Number.isFinite(Date.parse(evidence.startedAt)));
  const environment = info.Config.Env.filter((value) => /^(?:MARKETPLACE_SOURCE=(?:fixture|api)|PROFILE=(?:matched)?|PORT=8080|PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright)$/.test(value));
  return { role, id: info.Id, imageId: info.Image, startedAt: info.State.StartedAt,
    state: Object.fromEntries(["Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "Pid", "ExitCode", "StartedAt", "FinishedAt"].filter((key) => info.State[key] !== undefined).map((key) => [key, info.State[key]])),
    config: { env: environment, memory: info.HostConfig.Memory,
      nanoCpus: info.HostConfig.NanoCpus, cpuset: info.HostConfig.CpusetCpus, networkMode: info.HostConfig.NetworkMode } };
}
