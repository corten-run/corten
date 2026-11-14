import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { mountSourceHash } from "./execution-inputs.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const same = (a, b) => assert.ok(isDeepStrictEqual(a, b), "execution evidence differs");
const containerId = /^[a-f0-9]{64}$/, imageId = /^sha256:[a-f0-9]{64}$/;
const label = "run.corten.mixed-production";
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const sources = ["fixture", "api"];
const nullable = (value) => value === undefined ? null : value;
const keys = (value, expected) => { assert.ok(value && typeof value === "object" && !Array.isArray(value)); same(Object.keys(value).sort(), [...expected].sort()); };
const kinds = {
  "container-create": "docker-create-failed", "container-name": "docker-query-failed",
  "participant-created": "docker-inspect-failed", "participant-terminal": "docker-inspect-failed",
  "container-remove": "docker-remove-failed", "container-absence": "docker-query-failed",
  "network-created": "docker-inspect-failed", "network-remove": "docker-remove-failed", "network-absence": "docker-query-failed",
  "image-inspect": "docker-inspect-failed", "image-remove": "docker-remove-failed", "image-tag-inventory": "docker-query-failed",
  "image-tag-absence": "docker-query-failed", "volume-absence": "docker-query-failed",
  ...Object.fromEntries(["container", "network", "image", "volume"].map((type) => [`owned-${type}-inventory`, "docker-query-failed"])),
};

export function bindExecutionParticipant(participants, context, observed) {
  const matches = participants.filter((p) => Object.entries(context).every(([key, value]) => p[key] === value));
  assert.equal(matches.length, 1, "native participant lifecycle missing or ambiguous");
  const actual = matches[0]; same([observed.id, observed.imageId], [actual.id, actual.imageId]);
  if (actual.restartCount === 0) same(observed.startedAt, actual.state.StartedAt);
  return actual.restartCount === 0 && actual.state.Running && actual.state.ExitCode === 0 && !actual.state.Restarting
    && !actual.state.OOMKilled && !actual.state.Dead
    && actual.state.Paused === (["calibration", "steady"].includes(context.stage) && context.role === "app");
}

export function executionWorkerCompleted(participants, context, exitCode) {
  const matches = participants.filter((p) => Object.entries(context).every(([key, value]) => p[key] === value));
  assert.equal(matches.length, 1, "native worker lifecycle missing or ambiguous");
  const { state, restartCount } = matches[0], start = Date.parse(state.StartedAt), finish = Date.parse(state.FinishedAt);
  return state.Status === "exited" && !state.Running && !state.Paused && !state.Restarting && !state.OOMKilled && !state.Dead
    && state.ExitCode === exitCode && restartCount === 0 && start >= 0 && finish >= start;
}

export function executionContext(name, summary) {
  for (const app of summary.inventory) for (const source of sources) {
    const variants = [
      ["functional", null, `${summary.runId}-${app}-${source}`, ["app", "upstream", "capture"], ["", "-upstream", "-capture"]],
      ["qualification", null, `${summary.runId}-q-${app}-${source}`, ["app", "upstream", "qualificationWorker"], ["", "-up", "-worker"]],
      ["calibration", 0, `${summary.runId}-calibration-0-${app}-${source}`, ["app", "upstream", "load"], ["", "-up", "-worker"]],
      ...Array.from({ length: summary.options.passes }, (_, i) => ["steady", i + 1, `${summary.runId}-steady-${i + 1}-${app}-${source}`, ["app", "upstream", "load"], ["", "-up", "-worker"]]),
    ];
    for (const [stage, pass, base, roles, suffixes] of variants) for (const [index, role] of roles.entries())
      if (name === base + suffixes[index]) return { stage, pass, app, source, role };
  }
  if (name === `${summary.runId}-measurement-cpu`) return { stage: "measurement", pass: null, app: null, source: null, role: "cpuReader" };
  throw new Error("unknown native participant");
}

function expectation(context, summary) {
  const { stage, pass, app, source, role } = context;
  if (role === "cpuReader") return { image: summary.tools.nodeImage, nanoCpus: 1e9, cpuset: "", memory: 128 * 2 ** 20,
    cmd: ["node", "-e", "setInterval(() => {}, 1000)"], network: "none" };
  const functional = stage === "functional", cpu = functional ? { quota: role === "app" ? 1 : 2, cpuset: null }
    : summary.timing?.cpus?.[role === "app" ? "app" : role === "upstream" ? "api" : "load"];
  assert.ok(cpu, "participant CPU policy unavailable");
  const base = functional ? `${summary.runId}-${app}-${source}` : stage === "qualification" ? `${summary.runId}-q-${app}-${source}`
    : `${summary.runId}-${stage}-${pass}-${app}-${source}`;
  const worker = ["capture", "qualificationWorker", "load"].includes(role);
  let cmd = null;
  if (role === "upstream") cmd = ["node", functional ? "bench/mixed-production/upstream.mjs"
    : stage === "qualification" ? "bench/marketplace/upstream.mjs" : "bench/mixed-production/load-upstream.mjs"];
  if (worker) cmd = ["node", `bench/mixed-production/${role === "capture" ? "worker" : role === "load" ? "load-worker" : "qualify-worker"}.mjs`,
    functional ? `/out/${app}/${source}/settings.json` : stage === "qualification" ? `/out/measurement/${app}/${source}/qualification/settings.json`
      : `/out/measurement/${app}/${source}/${stage}-${pass}/settings.json`];
  return { image: role === "app" ? summary.apps[app]?.image?.id : role === "upstream" ? summary.tools.nodeImage : summary.tools.browserImage,
    nanoCpus: cpu.quota * 1e9, cpuset: cpu.cpuset ?? "", memory: role === "upstream" ? 512 * 2 ** 20 : role === "load" ? 2 ** 31 : 2 ** 30,
    shmSize: ["capture", "load"].includes(role) ? 512 * 2 ** 20 : null,
    network: worker ? `container:${base}` : `${summary.runId}-net`, cmd };
}

// Only public, bounded contract configuration is serialized. No command text,
// arbitrary environment, Docker errors, cookies or control tokens are retained.
export function executionParticipant(info, image) {
  const env = [];
  for (const entry of info.Config?.Env ?? []) {
    const at = entry.indexOf("="); assert.ok(at > 0);
    const key = entry.slice(0, at), value = entry.slice(at + 1);
    if (!new Set(["MARKETPLACE_SOURCE", "PROFILE", "PLAYWRIGHT_BROWSERS_PATH"]).has(key)) continue;
    const allowed = key === "MARKETPLACE_SOURCE" ? sources.includes(value) : key === "PROFILE" ? ["", "matched"].includes(value) : value === "/ms-playwright";
    env.push([key, allowed ? value : { sha256: hash(value) }]);
  }
  const state = info.State ?? {}, host = info.HostConfig ?? {};
  return { id: nullable(info.Id), name: nullable(info.Name?.replace(/^\//, "")), imageId: nullable(info.Image),
    owner: { run: nullable(info.Config?.Labels?.[label]), agent: nullable(info.Config?.Labels?.["agent.owner"]), task: nullable(info.Config?.Labels?.["agent.task"]) },
    restartCount: nullable(info.RestartCount),
    state: Object.fromEntries(["Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "Pid", "ExitCode", "StartedAt", "FinishedAt"].map((key) => [key, nullable(state[key])])),
    limits: Object.fromEntries(["NanoCpus", "CpuQuota", "CpuPeriod", "CpusetCpus", "Memory", "MemorySwap", "ShmSize", "PidsLimit"].map((key) => [key, nullable(host[key])])),
    networkMode: nullable(host.NetworkMode), env,
    commandSha256: info.Config ? digest({ entrypoint: info.Config.Entrypoint ?? null, cmd: info.Config.Cmd ?? null }) : null,
    cmdSha256: info.Config ? digest(info.Config.Cmd ?? null) : null,
    entrypointSha256: info.Config ? digest(info.Config.Entrypoint ?? null) : null,
    image: { id: nullable(image?.Id), commandSha256: image?.Config ? digest({ entrypoint: image.Config.Entrypoint ?? null, cmd: image.Config.Cmd ?? null }) : null,
      entrypointSha256: image?.Config ? digest(image.Config.Entrypoint ?? null) : null },
    mounts: (info.Mounts ?? []).map((mount) => ({ type: nullable(mount.Type), destination: nullable(mount.Destination), readOnly: !mount.RW,
      volume: mount.Type === "volume" ? nullable(mount.Name) : null, sourceSha256: typeof mount.Source === "string" ? mountSourceHash(mount.Source) : null })) };
}

const lines = (raw) => raw === "" ? [] : raw.split(/\r?\n/);
function list(raw, type) {
  assert.equal(typeof raw, "string"); assert.ok(Buffer.byteLength(raw) <= 1024 * 1024);
  const rows = lines(raw);
  assert.ok(rows.every((row) => (type === "volume" ? safeName : type === "image" ? imageId : containerId).test(row)), "invalid Docker inventory");
  assert.equal(new Set(rows).size, rows.length, "duplicate Docker inventory");
  return rows;
}

export function createExecutionEvidence({ folder, summary, docker }) {
  const root = join(folder, "execution"), events = [], attempted = new Set(), observed = new Map(), volumes = new Set();
  const originalIds = new Map(), removals = new Map(), originalNetworks = new Map();
  mkdirSync(join(root, "events"), { recursive: true });
  const manifest = { schema: "mixed-native-execution/v1", round: summary.round, runId: summary.runId,
    commit: null, producerFiles: Object.fromEntries(["execution-evidence.mjs", "execution-inputs.mjs", "immutable-git.mjs"].map((name) =>
      [`bench/mixed-production/${name}`, hash(readFileSync(fileURLToPath(new URL(name, import.meta.url))))])), events, finalizedUnixMs: null };
  const flush = () => {
    manifest.commit = summary.provenance.nativeSource?.commit ?? summary.provenance.commit ?? null;
    writeFileSync(join(root, "manifest.json.tmp"), JSON.stringify(manifest));
    renameSync(join(root, "manifest.json.tmp"), join(root, "manifest.json"));
    summary.executionEvidence = { path: "execution/manifest.json", sha256: hash(readFileSync(join(root, "manifest.json"))) };
  };
  const append = (kind, subject, startedUnixMs, data, failure = null) => {
    assert.equal(manifest.finalizedUnixMs, null); assert.ok(events.length < 20000);
    const event = { schema: "mixed-native-execution-event/v1", sequence: events.length, kind, subject,
      startedUnixMs, receivedUnixMs: Date.now(), data, failure };
    const path = `execution/events/${String(event.sequence).padStart(5, "0")}.json`, body = JSON.stringify(event);
    writeFileSync(join(folder, path), body, { flag: "wx" }); events.push({ path, sha256: hash(body) }); flush();
    return event;
  };
  const query = async (kind, subject, args, type = "container") => {
    const start = Date.now();
    try { const raw = await docker(args, { cleanup: true }); list(raw, type); append(kind, subject, start, { raw }); return lines(raw); }
    catch { append(kind, subject, start, null, "docker-query-failed"); return null; }
  };
  const inspect = async (name, phase, id) => {
    const start = Date.now();
    try {
      const info = JSON.parse(await docker(["inspect", "--type", "container", id], { cleanup: true }))[0];
      same(info.Config?.Labels?.[label], summary.runId); same(info.Config?.Labels?.["agent.task"], summary.runId);
      const image = JSON.parse(await docker(["image", "inspect", info.Image], { cleanup: true }))[0], value = executionParticipant(info, image);
      assert.ok(containerId.test(value.id)); same(value.id, id);
      assert.ok(typeof value.name === "string" && safeName.test(value.name)); if (phase === "created") same(value.name, name);
      append(`participant-${phase}`, name, start, value); observed.set(name, value);
      for (const mount of value.mounts) if (mount.type === "volume") { assert.ok(safeName.test(mount.volume)); volumes.add(mount.volume); }
      return value;
    } catch { append(`participant-${phase}`, name, start, null, "docker-inspect-failed"); return null; }
  };
  const absentContainer = (id) => query("container-absence", id, ["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]);
  const volumeQueries = async (names = volumes) => {
    for (const name of names) await query("volume-absence", name, ["volume", "ls", "--filter", `name=^${name.replaceAll(".", "\\.")}$`, "--format", "{{.Name}}"], "volume");
  };
  return {
    async create(name, operation) {
      executionContext(name, summary); assert.ok(!attempted.has(name)); attempted.add(name);
      const start = Date.now(); let result, error;
      try { result = await operation(); assert.ok(containerId.test(result)); originalIds.set(name, result); append("container-create", name, start, { raw: result }); }
      catch (failure) { error = failure; append("container-create", name, start, null, "docker-create-failed"); }
      const ids = await query("container-name", name, ["ps", "-a", "--no-trunc", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
      if (ids?.length && originalIds.has(name)) await inspect(name, "created", originalIds.get(name));
      if (error) throw error;
      assert.ok(ids?.length === 1 && ids[0] === result && observed.has(name), "actual participant inspection unavailable");
      return result;
    },
    async remove(name) {
      executionContext(name, summary);
      if (removals.has(name)) return removals.get(name);
      const removal = (async () => {
        const id = originalIds.get(name);
        assert.ok(attempted.has(name) && containerId.test(id ?? ""), "refusing cleanup without original create ID");
        const p = await inspect(name, "terminal", id); assert.ok(p && p.id === id);
        const start = Date.now(); let failure;
        try { const raw = await docker(["rm", "-f", "-v", p.id], { cleanup: true }); same(raw, p.id); append("container-remove", p.id, start, { raw }); }
        catch (error) { failure = error; append("container-remove", p.id, start, null, "docker-remove-failed"); }
        await absentContainer(p.id); await volumeQueries(p.mounts.filter((m) => m.type === "volume").map((m) => m.volume)); if (failure) throw failure;
        return p;
      })();
      removals.set(name, removal); return removal;
    },
    async networkCreated(name, id) {
      assert.ok(containerId.test(id) && !originalNetworks.has(name)); originalNetworks.set(name, id); const start = Date.now();
      try {
        const info = JSON.parse(await docker(["network", "inspect", id], { cleanup: true }))[0];
        same([info.Id, info.Name, info.Labels?.[label]], [id, name, summary.runId]);
        append("network-created", name, start, { id, name, run: info.Labels[label] });
      } catch { append("network-created", name, start, null, "docker-inspect-failed"); throw new Error("network inspection unavailable"); }
    },
    async removeNetwork(name) {
      const id = originalNetworks.get(name); assert.ok(containerId.test(id ?? ""), "network cleanup requires original create ID");
      const start = Date.now();
      const info = JSON.parse(await docker(["network", "inspect", id], { cleanup: true }))[0];
      same([info.Id, info.Name, info.Labels?.[label]], [id, name, summary.runId]);
      try { const raw = await docker(["network", "rm", info.Id], { cleanup: true });
        assert.ok([name, info.Id].includes(raw)); append("network-remove", name, start, { id: info.Id, name, run: info.Labels[label], raw }); }
      catch { append("network-remove", name, start, null, "docker-remove-failed"); throw new Error("network cleanup failed"); }
      await query("network-absence", info.Id, ["network", "ls", "--no-trunc", "--filter", `id=${info.Id}`, "--format", "{{.ID}}"]);
    },
    async removeImage(tag) {
      assert.ok(safeName.test(tag) && tag.startsWith(summary.runId + "-"));
      const ids = await query("image-tag-inventory", tag, ["image", "ls", "--no-trunc", "--filter", `reference=${tag}`, "--format", "{{.ID}}"], "image");
      assert.ok(ids && ids.length <= 1, "image inventory unavailable");
      if (ids.length) {
        let info; const start = Date.now();
        try {
          info = JSON.parse(await docker(["image", "inspect", tag], { cleanup: true }))[0];
          same([info.Id, info.Config?.Labels?.["agent.task"], info.Config?.Labels?.["agent.owner"]], [ids[0], summary.runId, "codex"]);
          append("image-inspect", tag, start, { id: info.Id, task: info.Config.Labels["agent.task"] });
        } catch { append("image-inspect", tag, start, null, "docker-inspect-failed"); throw new Error("owned image inspection unavailable"); }
        const removeStart = Date.now();
        try { const raw = await docker(["image", "rm", tag], { cleanup: true });
          // Docker returns only the removed native tag and immutable image IDs.
          assert.ok(raw.split(/\r?\n/).every((line) => line === `Untagged: ${tag}:latest` || line === `Untagged: ${tag}` || /^Deleted: sha256:[a-f0-9]{64}$/.test(line)));
          append("image-remove", tag, removeStart, { id: info.Id, raw });
        } catch { append("image-remove", tag, removeStart, null, "docker-remove-failed"); throw new Error("image cleanup failed"); }
      }
      await query("image-tag-absence", tag, ["image", "ls", "--no-trunc", "--filter", `reference=${tag}`, "--format", "{{.ID}}"], "image");
    },
    async seal() {
      for (const [path, expected] of Object.entries(manifest.producerFiles)) same(hash(readFileSync(fileURLToPath(new URL(path.slice("bench/mixed-production/".length), import.meta.url)))), expected);
      await volumeQueries();
      for (const [type, args, format] of [["container", ["ps", "-a", "--no-trunc"], "{{.ID}}"], ["network", ["network", "ls", "--no-trunc"], "{{.ID}}"],
        ["image", ["image", "ls", "--no-trunc"], "{{.ID}}"], ["volume", ["volume", "ls"], "{{.Name}}"]])
        await query(`owned-${type}-inventory`, summary.runId, [...args, "--filter", `label=${type === "image" ? "agent.task" : label}=${summary.runId}`, "--format", format], type);
      manifest.finalizedUnixMs = Date.now(); flush(); return summary.executionEvidence;
    },
  };
}

export function replayExecution({ manifest, read, summary }) {
  keys(manifest, ["schema", "round", "runId", "commit", "producerFiles", "events", "finalizedUnixMs"]);
  keys(manifest.producerFiles, ["bench/mixed-production/execution-evidence.mjs", "bench/mixed-production/execution-inputs.mjs", "bench/mixed-production/immutable-git.mjs"]);
  for (const value of Object.values(manifest.producerFiles)) assert.match(value, /^[a-f0-9]{64}$/);
  same([manifest.schema, manifest.round, manifest.runId, manifest.commit],
    ["mixed-native-execution/v1", summary.round, summary.runId, summary.provenance.nativeSource.commit]);
  assert.ok(Array.isArray(manifest.events) && manifest.events.length <= 20000);
  const result = { resources: "blocked", cleanupComplete: false, participants: [], blockers: [] };
  const block = (code) => { if (!result.blockers.includes(code)) result.blockers.push(code); };
  const attempts = new Map(), createdIds = new Set(), participants = new Map(), removed = new Set(), absent = new Set(), volumeAbsent = new Set(), volumeNames = new Set();
  const networks = new Map(), networksRemoved = new Set(), networksAbsent = new Set(), final = new Set(), paths = new Set();
  const tags = new Map(), tagInspections = new Map(), tagsRemoved = new Set(), tagsAbsent = new Set(); let received = 0, resourceMissing = false;
  const createdObservations = new Set(), terminalObservations = new Set(), removalAttempts = new Set(), absenceObservations = new Set();
  for (const [index, ref] of manifest.events.entries()) {
    keys(ref, ["path", "sha256"]); assert.match(ref.sha256, /^[a-f0-9]{64}$/);
    const path = `execution/events/${String(index).padStart(5, "0")}.json`; same(ref.path, path);
    assert.ok(!paths.has(path)); paths.add(path); const e = read(ref, path);
    keys(e, ["schema", "sequence", "kind", "subject", "startedUnixMs", "receivedUnixMs", "data", "failure"]);
    same([e.schema, e.sequence], ["mixed-native-execution-event/v1", index]); assert.ok(Object.hasOwn(kinds, e.kind));
    assert.ok(Number.isSafeInteger(e.startedUnixMs) && Number.isSafeInteger(e.receivedUnixMs) && e.startedUnixMs >= 0
      && e.receivedUnixMs >= e.startedUnixMs && e.startedUnixMs >= received); received = e.receivedUnixMs;
    assert.ok(typeof e.subject === "string" && safeName.test(e.subject));
    if (["container-create", "container-name", "participant-created", "participant-terminal"].includes(e.kind)) executionContext(e.subject, summary);
    if (["container-remove", "container-absence", "network-absence"].includes(e.kind)) assert.ok(containerId.test(e.subject));
    if (["network-created", "network-remove"].includes(e.kind)) same(e.subject, `${summary.runId}-net`);
    if (e.kind.startsWith("image-")) assert.ok(e.subject.startsWith(summary.runId + "-"));
    if (e.kind.startsWith("owned-")) same(e.subject, summary.runId);
    if (final.size) assert.ok(e.kind.startsWith("owned-"), "execution after terminal inventory");
    if (["participant-created", "participant-terminal"].includes(e.kind)) {
      assert.ok(attempts.has(e.subject));
      assert.ok(!terminalObservations.has(e.subject), "participant observation after terminal observation");
      const seen = e.kind === "participant-created" ? createdObservations : terminalObservations;
      assert.ok(!seen.has(e.subject), "duplicate participant observation"); seen.add(e.subject);
    }
    if (e.kind === "container-remove") {
      assert.ok(participants.get(e.subject)?.terminal, "removal before terminal inspection");
      assert.ok(!removalAttempts.has(e.subject), "duplicate container removal"); removalAttempts.add(e.subject);
    }
    if (e.kind === "container-absence") {
      assert.ok(removalAttempts.has(e.subject) && !absenceObservations.has(e.subject), "unordered or duplicate container absence");
      absenceObservations.add(e.subject);
    }
    if (e.failure !== null) {
      same(e.failure, kinds[e.kind]);
      same(e.data, null); block("native-execution-command-failed");
      if (["container-create", "participant-created", "participant-terminal"].includes(e.kind)) resourceMissing = true;
      if (e.kind === "container-create") { executionContext(e.subject, summary); assert.ok(!attempts.has(e.subject)); attempts.set(e.subject, null); }
      if (e.kind === "network-created") { assert.ok(!networks.has(e.subject)); networks.set(e.subject, null); }
      continue;
    }
    if (e.kind === "container-create") {
      keys(e.data, ["raw"]);
      executionContext(e.subject, summary); assert.ok(!attempts.has(e.subject) && containerId.test(e.data.raw) && !createdIds.has(e.data.raw));
      createdIds.add(e.data.raw); attempts.set(e.subject, e.data.raw);
    } else if (["participant-created", "participant-terminal"].includes(e.kind)) {
      assert.ok(attempts.has(e.subject)); const p = e.data, context = executionContext(e.subject, summary), expected = expectation(context, summary);
      keys(p, ["id", "name", "imageId", "owner", "restartCount", "state", "limits", "networkMode", "env", "commandSha256", "cmdSha256", "entrypointSha256", "image", "mounts"]);
      keys(p.limits, ["NanoCpus", "CpuQuota", "CpuPeriod", "CpusetCpus", "Memory", "MemorySwap", "ShmSize", "PidsLimit"]);
      keys(p.state, ["Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "Pid", "ExitCode", "StartedAt", "FinishedAt"]);
      keys(p.image, ["id", "commandSha256", "entrypointSha256"]);
      assert.ok(containerId.test(p.id) && imageId.test(p.imageId) && typeof p.name === "string" && safeName.test(p.name));
      if (e.kind === "participant-created") same(p.name, e.subject);
      if (attempts.get(e.subject) !== null) same(p.id, attempts.get(e.subject));
      same(p.owner, { run: summary.runId, agent: "codex", task: summary.runId });
      same(p.imageId, expected.image); same(p.image.id, p.imageId);
      const fact = (actual, expected) => {
        if (actual === null || expected === null) { resourceMissing = true; block("native-participant-inspection-incomplete"); }
        else same(actual, expected);
      };
      fact(p.limits.NanoCpus, expected.nanoCpus); fact(p.limits.Memory, expected.memory); fact(p.limits.CpusetCpus, expected.cpuset);
      if (expected.shmSize !== null && expected.shmSize !== undefined) fact(p.limits.ShmSize, expected.shmSize);
      fact(p.entrypointSha256, p.image.entrypointSha256);
      if (expected.cmd === null) fact(p.commandSha256, p.image.commandSha256); else fact(p.cmdSha256, digest(expected.cmd));
      for (const value of [p.commandSha256, p.cmdSha256, p.entrypointSha256, p.image.commandSha256, p.image.entrypointSha256])
        if (value !== null) assert.match(value, /^[a-f0-9]{64}$/);
      if (p.restartCount === null) { resourceMissing = true; block("native-participant-inspection-incomplete"); }
      if (p.restartCount !== null) assert.ok(Number.isSafeInteger(p.restartCount) && p.restartCount >= 0);
      assert.ok(p.state && ["Running", "Paused", "Restarting", "OOMKilled", "Dead"].every((key) => typeof p.state[key] === "boolean"));
      assert.ok(Number.isSafeInteger(p.state.Pid) && p.state.Pid >= 0 && Number.isInteger(p.state.ExitCode));
      assert.ok(typeof p.state.Status === "string" && ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(p.state.Status));
      if (["running", "paused"].includes(p.state.Status)) {
        same([p.state.Running, p.state.Paused, p.state.Restarting, p.state.Dead, p.state.ExitCode], [true, p.state.Status === "paused", false, false, 0]);
        assert.ok(p.state.Pid > 0);
      } else if (["created", "exited", "dead"].includes(p.state.Status)) {
        same([p.state.Running, p.state.Paused, p.state.Restarting, p.state.Pid], [false, false, false, 0]);
      }
      for (const key of ["StartedAt", "FinishedAt"]) assert.ok(typeof p.state[key] === "string" && Number.isFinite(Date.parse(p.state[key])));
      assert.ok(Array.isArray(p.env) && p.env.every((entry) => Array.isArray(entry) && entry.length === 2
        && ["MARKETPLACE_SOURCE", "PROFILE", "PLAYWRIGHT_BROWSERS_PATH"].includes(entry[0])) && new Set(p.env.map(([key]) => key)).size === p.env.length);
      if (context.role === "app") {
        const env = new Map(p.env); same(env.get("MARKETPLACE_SOURCE"), context.source); same(env.get("PROFILE"), summary.options.profile === "matched" ? "matched" : "");
      }
      assert.ok(Array.isArray(p.mounts));
      for (const mount of p.mounts) {
        keys(mount, ["type", "destination", "readOnly", "volume", "sourceSha256"]);
        assert.ok(["bind", "volume", "tmpfs"].includes(mount.type) && typeof mount.destination === "string" && mount.destination.startsWith("/") && typeof mount.readOnly === "boolean");
        if (mount.type === "volume") { assert.ok(safeName.test(mount.volume)); volumeNames.add(mount.volume); } else same(mount.volume, null);
      }
      if (summary.executionMounts) {
        const wanted = context.role === "app" ? [["/fixtures", summary.executionMounts.output, true]]
          : [["/src", summary.executionMounts.source, true], ["/src/node_modules", summary.executionMounts.dependencies, true], ["/out", summary.executionMounts.output, false],
            ...(context.role === "cpuReader" ? [["/sys/fs/cgroup", mountSourceHash("/sys/fs/cgroup"), true]] : [])];
        same(p.mounts.filter((m) => m.type === "bind").map((m) => [m.destination, m.sourceSha256, m.readOnly]).sort(), wanted.sort());
      } else { resourceMissing = true; block("native-execution-mount-inputs-missing"); }
      if (expected.network.startsWith("container:")) {
        const name = expected.network.slice(10), parent = [...participants.values()].map((v) => v.created ?? v.terminal).find((p) => p.name === name)?.id;
        assert.ok(parent, "network namespace participant missing"); same(p.networkMode, `container:${parent}`);
      } else same(p.networkMode, expected.network);
      const old = participants.get(p.id);
      if (e.kind === "participant-created") { assert.ok(!old); participants.set(p.id, { created: p, terminal: null, context }); }
      else {
        if (!old) { resourceMissing = true; block("native-participant-initial-inspection-missing"); participants.set(p.id, { created: null, terminal: p, context }); }
        else {
          assert.ok(!old.terminal && !removed.has(p.id) && !absent.has(p.id), "duplicate or late terminal ID"); same(context, old.context);
          const first = old.created ?? old.terminal;
          same([p.id, p.imageId, p.limits, p.networkMode, p.env, p.commandSha256, p.mounts],
            [first.id, first.imageId, first.limits, first.networkMode, first.env, first.commandSha256, first.mounts]); old.terminal = p;
        }
      }
    } else if (e.kind === "container-remove") {
      keys(e.data, ["raw"]);
      assert.ok(participants.get(e.subject)?.terminal); same(e.data.raw, e.subject); removed.add(e.subject);
    } else if (e.kind === "network-created") {
      keys(e.data, ["id", "name", "run"]);
      same(e.subject, `${summary.runId}-net`); same([e.data.name, e.data.run], [e.subject, summary.runId]); assert.ok(containerId.test(e.data.id));
      assert.ok(!networks.has(e.subject)); networks.set(e.subject, e.data.id);
    } else if (e.kind === "network-remove") {
      keys(e.data, ["id", "name", "run", "raw"]); same([e.data.name, e.data.run], [e.subject, summary.runId]); assert.ok(containerId.test(e.data.id));
      assert.ok(networks.has(e.subject));
      if (networks.get(e.subject) === null) { block("native-network-creation-proof-missing"); networks.set(e.subject, e.data.id); }
      else same(networks.get(e.subject), e.data.id);
      assert.ok([e.subject, e.data.id].includes(e.data.raw)); networksRemoved.add(e.data.id);
    } else if (e.kind === "image-inspect") {
      keys(e.data, ["id", "task"]); same(tags.get(e.subject), [e.data.id]); same(e.data.task, summary.runId); tagInspections.set(e.subject, e.data.id);
    } else if (e.kind === "image-remove") {
      keys(e.data, ["id", "raw"]); same(tagInspections.get(e.subject), e.data.id);
      assert.ok(typeof e.data.raw === "string" && e.data.raw.length > 0 && e.data.raw.split(/\r?\n/).every((line) => line === `Untagged: ${e.subject}:latest` || line === `Untagged: ${e.subject}` || /^Deleted: sha256:[a-f0-9]{64}$/.test(line)));
      tagsRemoved.add(e.subject);
    } else {
      assert.ok(["container-name", "container-absence", "network-absence", "volume-absence", "image-tag-inventory", "image-tag-absence",
        "owned-container-inventory", "owned-network-inventory", "owned-image-inventory", "owned-volume-inventory"].includes(e.kind));
      keys(e.data, ["raw"]);
      const type = e.kind.includes("volume") ? "volume" : e.kind.includes("image") ? "image" : "container", rows = list(e.data.raw, type);
      if (e.kind === "container-name") {
        executionContext(e.subject, summary); assert.ok(rows.length <= 1);
        if (rows.length) { assert.ok(attempts.has(e.subject)); if (attempts.get(e.subject) !== null) same(rows[0], attempts.get(e.subject)); }
        else if (attempts.get(e.subject)) assert.ok(absent.has(attempts.get(e.subject)), "created participant disappeared before terminal proof");
      }
      if (e.kind === "container-absence") { assert.ok(rows.every((id) => id === e.subject)); if (!rows.length) absent.add(e.subject); else block("native-container-still-observed"); }
      if (e.kind === "network-absence") { assert.ok(networksRemoved.has(e.subject)); assert.ok(rows.every((id) => id === e.subject)); if (!rows.length) networksAbsent.add(e.subject); else block("native-network-still-observed"); }
      if (e.kind === "volume-absence") { assert.ok(volumeNames.has(e.subject)); assert.ok(rows.every((name) => name === e.subject)); if (!rows.length) volumeAbsent.add(e.subject); else volumeAbsent.delete(e.subject); }
      if (e.kind === "image-tag-inventory") { assert.ok(e.subject.startsWith(summary.runId + "-") && !tags.has(e.subject) && rows.length <= 1); tags.set(e.subject, rows); }
      if (e.kind === "image-tag-absence") { assert.ok(tags.has(e.subject) && (!tags.get(e.subject).length || tagsRemoved.has(e.subject))); if (!rows.length) tagsAbsent.add(e.subject); else block("native-image-tag-still-observed"); }
      if (e.kind.startsWith("owned-")) { same(e.subject, summary.runId); assert.ok(!final.has(e.kind)); if (rows.length) block("native-owned-resources-still-observed"); final.add(e.kind); }
    }
  }
  for (const [name, id] of attempts) if (id !== null && !participants.has(id)) { resourceMissing = true; block("native-participant-inspection-incomplete"); }
  for (const [id, p] of participants) {
    if (!p.terminal) { resourceMissing = true; block("native-participant-terminal-inspection-missing"); }
    if (!removed.has(id) || !absent.has(id)) block("native-container-terminal-proof-missing");
    const observed = p.created ?? p.terminal;
    result.participants.push({ id, ...p.context, name: observed.name, imageId: observed.imageId, limits: observed.limits,
      restartCount: p.terminal?.restartCount ?? observed.restartCount, state: p.terminal?.state ?? observed.state });
  }
  for (const id of networks.values()) if (!networksRemoved.has(id) || !networksAbsent.has(id)) block("native-network-terminal-proof-missing");
  if ([...participants.values()].some((p) => p.context.role !== "cpuReader") && networks.size !== 1) block("native-network-creation-proof-missing");
  for (const name of volumeNames) if (!volumeAbsent.has(name)) block("native-volume-terminal-proof-missing");
  for (const tag of tags.keys()) if (!tagsAbsent.has(tag)) block("native-image-terminal-proof-missing");
  if (!["container", "network", "image", "volume"].every((type) => final.has(`owned-${type}-inventory`))) block("native-final-owned-inventory-missing");
  if (!Number.isSafeInteger(manifest.finalizedUnixMs) || manifest.finalizedUnixMs < received) block("native-execution-not-finalized");
  if (!participants.size) { resourceMissing = true; block("native-participants-not-observed"); }
  result.resources = resourceMissing ? "blocked" : "verified";
  result.cleanupComplete = result.blockers.length === 0;
  return result;
}
