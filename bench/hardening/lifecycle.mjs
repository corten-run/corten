import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { observe } from "./native.mjs";
import { nativeClock } from "./clock.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const now = () => new Date().toISOString();
const creationArgs = (name, args, runId) => [args[0], "--name", name,
  "--label", `run.corten.hardening=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`, ...args.slice(1)];
const ownedLabels = (info, runId) => {
  const labels = info.Config?.Labels;
  assert.equal(labels?.["run.corten.hardening"], runId, "refusing unowned container operation");
  assert.equal(labels?.["agent.owner"], "codex"); assert.equal(labels?.["agent.task"], runId);
};

// The runner and opt-in OS control use the same producer, not a parallel mock
// collector. Reserve ownership before the daemon call and never remove by name
// after an original immutable ID has been observed.
export function ownedContainerRecorder({ folder, runId, command, cell, tools }) {
  const records = [], active = new Set(), byName = new Map(), directory = join(folder, "owned-containers");
  mkdirSync(directory);
  const file = (r) => `${String(r.index).padStart(8, "0")}.json`;
  const save = (r) => writeFileSync(join(directory, file(r)), JSON.stringify(r, null, 2) + "\n");
  const call = async (args, options, receipt) => {
    Object.assign(receipt, { args, startedAt: now(), exitCode: null, timedOut: false, interrupted: false });
    try {
      receipt.stdout = await command(args, { ...options, receipt });
      // A resolved fixed command means an acknowledged successful CLI exit.
      receipt.exitCode = 0; return receipt.stdout;
    } catch (error) {
      receipt.exitCode ??= Number.isInteger(error.code) ? error.code : null;
      for (const field of ["stdout", "stderr"]) {
        if (typeof error[field] === "string" || Buffer.isBuffer(error[field])) receipt[field] ??= error[field].toString().trim();
      }
      receipt.timedOut ||= error.killed === true; receipt.failed = true; throw error;
    } finally { receipt.finishedAt = now(); }
  };
  const docker = async (args, options = {}) => {
    const record = args[0] === "start" && args.includes("-a") ? byName.get(args.at(-1)) : null;
    if (!record) return command(args, options);
    assert.ok(record.created, "cannot start an unobserved container");
    record.start = {}; save(record);
    try { return await call([...args.slice(0, -1), record.created.Id], options, record.start); }
    finally { save(record); }
  };
  const inspect = async (id) => JSON.parse(await command(["inspect", id], { cleanup: true }))[0];
  const owned = async (name, args) => {
    assert.ok(!active.has(name)); const current = cell(), images = tools();
    const step = name === `${runId}-ready` ? "ready" : name.slice(`${runId}-cell-`.length);
    const role = step === "app" ? current.mode === "direct" ? "applicationDirect" : "applicationEdge" : step === "upstream" ? "upstream"
      : step === "edge" ? "proxy" : args.includes(images.checker?.Id) ? "qualification" : "apparatus";
    const tool = role === "qualification" ? "checker" : args.includes(images.cert?.Id) ? "cert" : "node";
    const record = { schema: "native-hardening-container/v2", index: records.length,
      intent: { cell: current?.key ?? null, step: step === "app" ? "application" : step === "edge" ? "proxy" : step,
        name, operation: args[0], role, tool, args,
        ...(/-(application|upstream|proxy)-health$/.test(name) ? { healthPath: args.at(-2) } : {}) }, created: null, terminal: null, removed: false, creation: {} };
    records.push(record); byName.set(name, record); active.add(name); save(record);
    try {
      const id = (await call(creationArgs(name, args, runId), { settleOnInterrupt: true }, record.creation)).trim();
      assert.match(id, /^[a-f0-9]{64}$/); record.created = await inspect(id); ownedLabels(record.created, runId);
      assert.equal(record.created.Id, id); assert.equal(record.created.Name, "/" + name);
      const network = record.created.HostConfig.NetworkMode;
      if (network.startsWith("container:")) record.namespace = await inspect(network.slice("container:".length));
      return record.created;
    } finally { save(record); }
  };
  const remove = async (name) => {
    const record = byName.get(name); assert.ok(record, "no owned creation reservation");
    let id = record.created?.Id;
    if (!id) {
      // Reconcile an ambiguous creation only for cleanup. This does not backfill
      // a successful creation receipt or establish positive apparatus proof.
      const ids = await command(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`], { cleanup: true });
      if (ids) { const info = await inspect(ids.trim()); ownedLabels(info, runId); assert.equal(info.Name, "/" + name); id = info.Id; }
    }
    if (id) {
      const present = await command(["ps", "-aq", "--no-trunc", "--filter", `id=${id}`], { cleanup: true });
      if (present) {
        assert.equal(present.trim(), id); const info = await inspect(id); ownedLabels(info, runId); assert.equal(info.Id, id);
        record.terminal = info; record.removal = {}; save(record);
        try { await call(["rm", "-f", "-v", id], { cleanup: true, settleOnInterrupt: true }, record.removal); }
        finally { save(record); }
      }
      record.absence = {}; save(record);
      try { await call(["ps", "-aq", "--no-trunc", "--filter", `id=${id}`], { cleanup: true }, record.absence); }
      finally { save(record); }
      assert.equal(record.absence.stdout.trim(), "", "owned container remains after removal");
    }
    record.removed = !!record.removal && record.removal.exitCode === 0 && !!record.absence && !record.absence.stdout.trim();
    record.removedAt = now(); save(record); active.delete(name); byName.delete(name);
  };
  const seal = () => writeFileSync(join(folder, "owned-containers.json"), JSON.stringify({ schema: "native-hardening-owned-containers/v1", files: records.map(file) }, null, 2) + "\n");
  return { owned, remove, docker, active, records, seal };
}

export function requireCommandAcknowledgement(row, extra = []) {
  const fields = ["args", "exitCode", "startedAt", "finishedAt", ...extra];
  if (row != null) assert.ok(typeof row === "object" && !Array.isArray(row));
  if (row == null || fields.some((field) => row[field] == null)) {
    throw Object.assign(new Error("missing daemon command acknowledgement"), { code: "ENOENT" });
  }
  assert.ok(Array.isArray(row.args)); assert.ok(Number.isSafeInteger(row.exitCode));
  assert.equal(typeof row.startedAt, "string"); assert.equal(typeof row.finishedAt, "string");
  assert.ok(Number.isFinite(Date.parse(row.startedAt)) && Date.parse(row.finishedAt) >= Date.parse(row.startedAt));
  if (extra.includes("stdout")) assert.equal(typeof row.stdout, "string");
  for (const field of ["timedOut", "interrupted"]) if (extra.includes(field)) assert.equal(typeof row[field], "boolean");
  return row;
}

export function verifyContainerCommands(record, runId) {
  const id = record.created.Id;
  if (record.intent.args === undefined) throw Object.assign(new Error("native creation arguments missing"), { code: "ENOENT" });
  assert.ok(Array.isArray(record.intent.args) && record.intent.args.length > 1);
  assert.equal(record.intent.args[0], record.intent.operation); assert.ok(["create", "run"].includes(record.intent.operation));
  assert.equal(typeof runId, "string"); assert.ok(runId.length);
  for (const [key, args] of [["creation", creationArgs(record.intent.name, record.intent.args, runId)], ["removal", ["rm", "-f", "-v", id]],
    ["absence", ["ps", "-aq", "--no-trunc", "--filter", `id=${id}`]]]) {
    const row = requireCommandAcknowledgement(record[key], ["stdout", "timedOut", "interrupted"]);
    assert.equal(row.exitCode, 0); assert.notEqual(row.failed, true); assert.equal(row.timedOut, false); assert.equal(row.interrupted, false);
    assert.ok(Date.parse(row.finishedAt) >= Date.parse(row.startedAt));
    if (args) assert.deepEqual(row.args, args);
  }
  assert.equal(record.creation.stdout.trim(), id); assert.equal(record.removal.stdout.trim(), id); assert.equal(record.absence.stdout.trim(), "");
  assert.ok(Date.parse(record.removal.startedAt) >= Date.parse(record.creation.finishedAt));
  assert.ok(Date.parse(record.absence.startedAt) >= Date.parse(record.removal.finishedAt));
  assert.ok(Date.parse(record.removedAt) >= Date.parse(record.absence.finishedAt));
  if (record.start) {
    requireCommandAcknowledgement(record.start, ["stdout", "timedOut", "interrupted"]);
    assert.deepEqual(record.start.args, ["start", "-a", id]);
  }
}

export async function ownedResourceCleanup(kind, name, runId, docker) {
  assert.ok(["image", "network"].includes(kind));
  const receipt = { schema: "native-hardening-resource-cleanup/v1", kind, name, commands: [] };
  const call = async (args) => {
    const row = { args, startedAt: now() }; receipt.commands.push(row);
    row.stdout = await docker(args, { cleanup: true, settleOnInterrupt: true }); row.exitCode = 0; row.finishedAt = now(); return row.stdout;
  };
  const ids = await call(kind === "image" ? ["image", "ls", "-q", "--no-trunc", name]
    : ["network", "ls", "--no-trunc", "--filter", `name=${name}`, "-q"]);
  for (const id of [...new Set(ids.split(/\s+/).filter(Boolean))]) {
    const info = JSON.parse(await call([kind, "inspect", id]))[0];
    if (kind === "network" && info.Name !== name) continue;
    const labels = kind === "image" ? info.Config?.Labels : info.Labels;
    assert.equal(labels?.["run.corten.hardening"], runId, "refusing unowned resource cleanup");
    assert.equal(labels?.["agent.owner"], "codex"); assert.equal(labels?.["agent.task"], runId);
    if (kind === "network") assert.deepEqual(info.Containers, {}, "owned network still has processes");
    else assert.deepEqual(info.RepoTags, [`${name}:latest`], "owned image acquired another tag; do not remove a shared image");
    await call([kind, "rm", info.Id]);
  }
  return receipt;
}

export function verifyResourceCleanup(receipts, summary, usedNetworkIds = []) {
  assert.ok(Array.isArray(receipts));
  const missing = () => { throw Object.assign(new Error("resource removal acknowledgement missing"), { code: "ENOENT" }); };
  const expected = [...(summary.ownedNetworks ?? []).map((name) => ["network", name]), ...(summary.ownedImages ?? []).map((name) => ["image", name])];
  for (const app of Object.keys(summary.builds ?? {})) if (!summary.ownedImages?.includes(`${summary.runId}-${app}`)) missing();
  if (summary.cells?.some((c) => c.status === "observed") && !summary.ownedNetworks?.includes(`${summary.runId}-net`)) missing();
  if (receipts.length < expected.length) missing();
  assert.deepEqual(receipts.map((r) => [r.kind, r.name]), expected);
  for (const r of receipts) {
    assert.equal(r.schema, "native-hardening-resource-cleanup/v1");
    if (r.commands == null || Array.isArray(r.commands) && r.commands.length < 3) missing();
    assert.ok(Array.isArray(r.commands));
    let previous = Date.parse(summary.startedAt);
    for (const row of r.commands) {
      requireCommandAcknowledgement(row, ["stdout"]);
      assert.equal(row.exitCode, 0); assert.ok(Date.parse(row.startedAt) >= previous && Date.parse(row.finishedAt) >= Date.parse(row.startedAt));
      previous = Date.parse(row.finishedAt);
    }
    assert.ok(previous <= Date.parse(summary.finishedAt));
    const [query, inspect, removal] = r.commands;
    assert.ok(query); assert.deepEqual(query.args, r.kind === "image" ? ["image", "ls", "-q", "--no-trunc", r.name]
      : ["network", "ls", "--no-trunc", "--filter", `name=${r.name}`, "-q"]);
    // Absence cannot distinguish an unmaterialized reservation from an external
    // disappearance. A final empty inventory cannot replace owned removal.
    if (!inspect || !removal) missing();
    assert.equal(r.commands.length, 3); assert.ok(inspect && removal);
    const [info] = JSON.parse(inspect.stdout), labels = r.kind === "image" ? info.Config.Labels : info.Labels;
    assert.equal(labels["run.corten.hardening"], summary.runId); assert.equal(labels["agent.owner"], "codex"); assert.equal(labels["agent.task"], summary.runId);
    assert.equal(query.stdout.trim(), info.Id); assert.deepEqual(inspect.args, [r.kind, "inspect", info.Id]);
    assert.deepEqual(removal.args, [r.kind, "rm", info.Id]);
    if (r.kind === "network") {
      assert.match(info.Id, /^[a-f0-9]{64}$/); assert.equal(info.Name, r.name); assert.deepEqual(info.Containers, {});
      for (const id of usedNetworkIds) assert.equal(info.Id, id, "removed network differs from the observed deployment network");
    }
    else {
      assert.deepEqual(info.RepoTags, [`${r.name}:latest`]);
      assert.match(info.Id, /^sha256:[a-f0-9]{64}$/);
      const app = r.name.slice(summary.runId.length + 1), build = summary.builds?.[app];
      if (build) assert.equal(info.Id, build.imageId);
    }
  }
  // The separate final owned inventories must also be empty. These command
  // acknowledgements alone do not establish post-removal absence.
}

export const terminalHealthPaths = (qualification, edgeQualification) => ({ application: qualification.probes.live?.path ?? null,
  upstream: "/health", ...(edgeQualification ? { proxy: edgeQualification.probes.live?.path ?? null } : {}) });
export const terminalHealthEndpoints = (paths) => Object.fromEntries(Object.entries(paths).map(([role, path]) => [role,
  path === null ? null : (role === "proxy" ? "https://localhost:8080" : "http://127.0.0.1:8080") + path]));

export async function observeTerminalHealth(base, path, timeoutMs, request = observe) {
  const bootId = process.platform === "linux" ? nativeClock().bootId : null;
  return { path, bootId, response: path === null ? null : await request(base + path, { timeoutMs }) };
}

export async function collectTerminalHealth({ role, source, path, inspect, observe }) {
  const before = await inspect();
  let health;
  if (!before.State.Running) health = { path, response: null, unavailable: "not-running" };
  else if (path === null) health = { path, response: null };
  else {
    try { health = await observe(); }
    catch (error) {
      const after = await inspect(), state = after.State;
      const critical = ["application", "proxy"].includes(role) || role === "upstream" && source === "api";
      const exited = !state.Running && state.Status === "exited" && !state.Error && !state.Dead
        && Number.isInteger(state.ExitCode) && Number.isFinite(Date.parse(state.FinishedAt))
        && Date.parse(state.FinishedAt) >= Date.parse(before.State.StartedAt);
      if (!critical || !exited || after.Id !== before.Id || state.StartedAt !== before.State.StartedAt) throw error;
      // Replay still rejects external stop/kill/restart events. Do not manufacture a health response.
      return { after, health: { path, response: null, unavailable: "not-running", observerError: error.message } };
    }
  }
  return { after: await inspect(), health };
}

function liveness(health, path, observation, endpoint) {
  if (!health) return "unavailable"; // Historical captures have no terminal HTTP observation.
  assert.equal(health.path, path, "terminal health path differs from native qualification");
  if (path === null) { assert.equal(health.response, null); return "missing"; }
  assert.ok(typeof path === "string" && path.startsWith("/"));
  if (health.response === null) { assert.equal(health.unavailable, "not-running"); return "unavailable"; }
  const row = health.response;
  assert.ok(observation, "missing terminal observation interval");
  assert.equal(health.bootId, observation.start.bootId, "terminal health clock boot differs");
  assert.equal(observation.end.bootId, observation.start.bootId, "terminal observation clock boot differs");
  for (const ns of [row.startedNs, row.endedNs, observation.start.monotonicNs, observation.end.monotonicNs]) assert.match(ns, /^\d+$/, "missing terminal acquisition time");
  assert.ok(BigInt(row.startedNs) >= BigInt(observation.start.monotonicNs)
    && BigInt(row.endedNs) >= BigInt(row.startedNs) && BigInt(row.endedNs) <= BigInt(observation.end.monotonicNs),
  "terminal health acquisition escaped terminal observation interval");
  assert.equal(row.url, new URL(endpoint).href, "terminal health actual URL differs from native endpoint");
  assert.equal(row.method, "GET", "terminal health actual method differs");
  assert.equal(row.host, new URL(endpoint).host, "terminal health actual Host differs");
  assert.ok(typeof row.body === "string" && typeof row.complete === "boolean" && Number.isFinite(row.ms) && row.ms >= 0);
  assert.equal(row.bytes, Buffer.byteLength(row.body));
  assert.equal(row.sha256, createHash("sha256").update(row.body).digest("hex"), "terminal health bytes differ");
  assert.ok(!["EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(row.error), "local terminal health client failure");
  return row.complete && !row.error && !row.timedOut && row.status === 200 && row.ms <= 600
    && BigInt(row.endedNs) - BigInt(row.startedNs) <= 600_000_000n ? "observed" : "failed";
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

// Save raw, acknowledged daemon inventories after all owned removals. Empty
// intent lists or a successful `rm` alone do not establish terminal cleanup.
export async function ownedCleanupObservation(docker, runId, commandClients, activeContainers) {
  const commands = [
    ["ps", "-aq", "--no-trunc"], ["volume", "ls", "-q"],
    ["network", "ls", "-q", "--no-trunc"], ["image", "ls", "-aq", "--no-trunc"],
  ];
  const inventories = [];
  for (const args of commands) {
    const startedAt = new Date().toISOString();
    const stdout = await docker([...args, "--filter", `label=run.corten.hardening=${runId}`], { cleanup: true });
    inventories.push({ args: [...args, "--filter", `label=run.corten.hardening=${runId}`], stdout,
      exitCode: 0, startedAt, finishedAt: new Date().toISOString() });
  }
  return { schema: "native-hardening-final-cleanup/v1", runId, commandClients, activeContainers, inventories };
}

export function verifyOwnedCleanup(receipt, summary) {
  assert.equal(receipt.schema, "native-hardening-final-cleanup/v1"); assert.equal(receipt.runId, summary.runId);
  assert.ok(Number.isSafeInteger(receipt.commandClients) && receipt.commandClients >= 0);
  assert.ok(Number.isSafeInteger(receipt.activeContainers) && receipt.activeContainers >= 0);
  if (receipt.inventories == null || Array.isArray(receipt.inventories) && receipt.inventories.length < 4) {
    throw Object.assign(new Error("missing final inventory acknowledgements"), { code: "ENOENT" });
  }
  assert.ok(Array.isArray(receipt.inventories));
  for (const row of receipt.inventories) requireCommandAcknowledgement(row, ["stdout"]);
  assert.deepEqual(receipt.inventories.map((r) => r.args), [
    ["ps", "-aq", "--no-trunc"], ["volume", "ls", "-q"],
    ["network", "ls", "-q", "--no-trunc"], ["image", "ls", "-aq", "--no-trunc"],
  ].map((args) => [...args, "--filter", `label=run.corten.hardening=${summary.runId}`]));
  let previous = Date.parse(summary.startedAt);
  for (const row of receipt.inventories) {
    assert.equal(row.exitCode, 0); assert.equal(typeof row.stdout, "string");
    assert.ok(Date.parse(row.startedAt) >= previous && Date.parse(row.finishedAt) >= Date.parse(row.startedAt));
    previous = Date.parse(row.finishedAt);
  }
  assert.ok(previous <= Date.parse(summary.finishedAt));
  return receipt.commandClients === 0 && receipt.activeContainers === 0 && receipt.inventories.every((r) => !r.stdout.trim())
    && summary.cleanupFailures.length === 0 && summary.daemonOutcomeUnknown !== true;
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

export function terminalRecovery(recovered, processes, resources, lifecycle, source = "fixture", paths = {}, endpoints = terminalHealthEndpoints(paths)) {
  const applications = processes.filter((p) => p.role === "application");
  const critical = processes.filter((p) => p.role === "application" || p.role === "proxy" || p.role === "upstream" && source === "api");
  const terminalServices = critical.map((p) => {
    const state = lifecycle[p.id].after.State;
    assert.equal(typeof state.Running, "boolean");
    const configured = lifecycle[p.id].after.Config?.Healthcheck?.Test;
    const dockerHealth = state.Health?.Status ?? (configured?.length && configured[0] !== "NONE" ? "unavailable" : "not-configured");
    assert.ok(["healthy", "unhealthy", "starting", "unavailable", "not-configured"].includes(dockerHealth));
    return { id: p.id, role: p.role, running: state.Running, finishedAt: state.FinishedAt, exitCode: state.ExitCode, oomKilled: state.OOMKilled,
      dockerHealth, liveness: liveness(lifecycle[p.id].health, paths[p.role], lifecycle[p.id].observation, endpoints[p.role]),
      healthy: state.Running && !state.Paused && !state.Restarting && !state.Dead && !state.OOMKilled
        && ["healthy", "not-configured"].includes(dockerHealth), evidence: `${p.id}-lifecycle.json` };
  });
  for (const p of processes.filter((p) => p.role === "upstream" && source === "fixture")) {
    assert.equal(lifecycle[p.id].after.State.Running, true, "fixture apparatus upstream exited");
    if (paths.upstream) assert.equal(liveness(lifecycle[p.id].health, paths.upstream, lifecycle[p.id].observation, endpoints.upstream), "observed", "fixture apparatus upstream unhealthy");
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
