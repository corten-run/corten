import assert from "node:assert/strict";
import { executionParticipant } from "../mixed-production/execution-evidence.mjs";
import { definition } from "../workloads/registry.mjs";
import { candidates } from "./contract.mjs";
import { encoded, exact, sha256 } from "./native-evidence.mjs";

const kinds = ["container", "network", "image", "volume"];
const idPattern = { container: /^[a-f0-9]{64}$/, network: /^[a-f0-9]{64}$/, image: /^sha256:[a-f0-9]{64}$/, volume: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/ };
const cases = definition("fullstack-browser").cases.map((c) => c.key);
function time(at) { assert.ok(Number.isFinite(at) && at >= 0); }
function id(kind, value) { assert.ok(kinds.includes(kind)); assert.match(value, idPattern[kind]); }
export function participantSnapshot(info, image) {
  const value = executionParticipant(info, image);
  value.owner = { agent: info.Config?.Labels?.["agent.owner"] ?? null, task: info.Config?.Labels?.["agent.task"] ?? null };
  return value;
}
/** Fixed, read-only Docker commands. docker returns {code,stdout}; no diagnostics retained. */
export async function collectDockerInventory(docker, kind, task, scope) {
  assert.ok(kinds.includes(kind)); assert.match(task, /^browser-[a-f0-9-]+$/); assert.ok(["all", "owned"].includes(scope));
  const args = kind === "container" ? ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"]
    : kind === "network" ? ["network", "ls", "--no-trunc", "--format", "{{.ID}}"]
      : kind === "image" ? ["image", "ls", "--no-trunc", "--quiet"] : ["volume", "ls", "--quiet"];
  if (scope === "owned") args.push("--filter", "label=agent.owner=codex", "--filter", `label=agent.task=${task}`);
  const answer = await docker(args);
  assert.ok(Number.isInteger(answer.code) && typeof answer.stdout === "string" && Buffer.byteLength(answer.stdout) <= 1024 ** 2);
  const ids = answer.code === 0 ? [...new Set(answer.stdout.trim().split(/\r?\n/).filter(Boolean))].sort() : [];
  ids.forEach((value) => id(kind, value));
  return { kind, scope, code: answer.code, ids };
}

function eventShape(e) {
  const keys = { participant: ["phase", "role", "app", "case", "snapshot"],
    created: ["kind", "id", "owned"], remove: ["kind", "id", "code"], inventory: ["kind", "scope", "code", "ids"],
    command: ["operation", "role", "app", "case", "id", "code"],
    "browser-window": ["app", "case", "startedAt", "endedAt"] }[e.event];
  assert.ok(keys, "unknown native execution event"); exact(e, ["event", "seq", "at", ...keys]);
  time(e.at);
  if (e.event === "command") {
    assert.ok(["create", "start", "build", "copy"].includes(e.operation));
    assert.ok(["application", "upstream", "artifact"].includes(e.role));
    assert.ok(e.role === "upstream" ? e.app === null && e.case === null : candidates.includes(e.app) && (e.role === "artifact" ? e.case === null : cases.includes(e.case)));
    assert.ok(Number.isInteger(e.code));
    if (e.id !== null) id(e.operation === "build" ? "image" : "container", e.id);
    return;
  }
  if (e.event === "browser-window") {
    assert.ok(candidates.includes(e.app) && cases.includes(e.case)); time(e.startedAt); time(e.endedAt);
    assert.ok(e.startedAt <= e.endedAt && e.endedAt <= e.at); return;
  }
  if (e.event === "participant") {
    assert.ok(["created", "running", "terminal"].includes(e.phase));
    assert.ok(["application", "upstream", "artifact"].includes(e.role));
    assert.ok(e.role === "application" ? candidates.includes(e.app) && cases.includes(e.case)
      : e.role === "artifact" ? candidates.includes(e.app) && e.case === null : e.app === null && e.case === null);
    id("container", e.snapshot.id); id("image", e.snapshot.imageId);
    exact(e.snapshot, ["id", "name", "imageId", "owner", "restartCount", "state", "limits", "networkMode", "env", "commandSha256", "cmdSha256", "entrypointSha256", "image", "mounts"]);
    exact(e.snapshot.owner, ["agent", "task"]);
    exact(e.snapshot.state, ["Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "Pid", "ExitCode", "StartedAt", "FinishedAt"]);
    exact(e.snapshot.limits, ["NanoCpus", "CpuQuota", "CpuPeriod", "CpusetCpus", "Memory", "MemorySwap", "ShmSize", "PidsLimit"]);
    exact(e.snapshot.image, ["id", "commandSha256", "entrypointSha256"]);
    for (const key of ["Running", "Paused", "Restarting", "OOMKilled", "Dead"]) assert.equal(typeof e.snapshot.state[key], "boolean");
    for (const key of ["Pid", "ExitCode"]) assert.ok(Number.isSafeInteger(e.snapshot.state[key]) && e.snapshot.state[key] >= 0);
    assert.ok(Number.isSafeInteger(e.snapshot.restartCount) && e.snapshot.restartCount >= 0);
    for (const key of ["commandSha256", "cmdSha256", "entrypointSha256"]) assert.match(e.snapshot[key], /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(e.snapshot.mounts) && e.snapshot.mounts.length <= 1000);
    for (const m of e.snapshot.mounts) exact(m, ["type", "destination", "readOnly", "volume", "sourceSha256"]);
    assert.ok(Array.isArray(e.snapshot.env) && e.snapshot.env.length <= 3);
    assert.equal(new Set(e.snapshot.env.map(([key]) => key)).size, e.snapshot.env.length);
    for (const entry of e.snapshot.env) {
      assert.ok(Array.isArray(entry) && entry.length === 2 && ["MARKETPLACE_SOURCE", "PROFILE", "PLAYWRIGHT_BROWSERS_PATH"].includes(entry[0]));
      if (typeof entry[1] === "string") assert.ok(entry[0] === "MARKETPLACE_SOURCE" ? ["fixture", "api"].includes(entry[1])
        : entry[0] === "PROFILE" ? ["", "matched"].includes(entry[1]) : entry[1] === "/ms-playwright");
      else { exact(entry[1], ["sha256"]); assert.match(entry[1].sha256, /^[a-f0-9]{64}$/); }
    }
    return;
  }
  assert.ok(kinds.includes(e.kind));
  if (e.event === "inventory") {
    assert.ok(["all", "owned"].includes(e.scope)); assert.ok(Array.isArray(e.ids) && e.ids.length <= 10000);
    assert.deepEqual(e.ids, [...new Set(e.ids)].sort()); e.ids.forEach((value) => id(e.kind, value));
  } else id(e.kind, e.id);
  if (e.event === "created") assert.equal(typeof e.owned, "boolean"); else assert.ok(Number.isInteger(e.code));
}
export class ExecutionLedger {
  constructor(store, { task, commit, startedAt }) {
    assert.match(task, /^browser-[a-f0-9-]+$/); assert.match(commit, /^[a-f0-9]{40}$/); time(startedAt);
    this.store = store; this.value = { schema: "native-browser-execution/v2", task, commit, startedAt, endedAt: null, events: [] }; this.closed = false;
  }
  append(event) {
    assert.equal(this.closed, false); assert.ok(this.value.events.length < 10000);
    const e = structuredClone({ ...event, seq: this.value.events.length }); eventShape(e);
    assert.ok(e.at >= (this.value.events.at(-1)?.at ?? this.value.startedAt));
    this.value.events.push(e); return e;
  }
  finish({ endedAt }) {
    assert.equal(this.closed, false); time(endedAt); assert.ok(endedAt >= (this.value.events.at(-1)?.at ?? this.value.startedAt));
    this.value.endedAt = endedAt; this.closed = true; return this.store.record("execution", this.value);
  }
}
function config(snapshot, role) {
  if (role === "artifact") return snapshot.state.Running === false && snapshot.state.Pid === 0;
  const l = snapshot.limits;
  return l.NanoCpus === 1000000000 && l.Memory === (role === "upstream" ? 256 : 1024) * 1024 ** 2
    && l.CpusetCpus === "" && l.CpuQuota === 0 && l.CpuPeriod === 0;
}
export function replayExecution(reader, receipt) {
  const value = reader.json(receipt); exact(value, ["schema", "task", "commit", "startedAt", "endedAt", "events"]);
  assert.equal(value.schema, "native-browser-execution/v2"); assert.match(value.task, /^browser-[a-f0-9-]+$/); assert.match(value.commit, /^[a-f0-9]{40}$/);
  time(value.startedAt); time(value.endedAt); assert.ok(value.endedAt >= value.startedAt);
  assert.ok(Array.isArray(value.events) && value.events.length <= 10000);
  const resources = new Map(), participants = new Map(), blocked = [], processWindows = [], inventories = new Map(), commands = [];
  const block = (why) => { if (!blocked.includes(why)) blocked.push(why); };
  let at = value.startedAt;
  value.events.forEach((e, seq) => {
    eventShape(e); assert.equal(e.seq, seq); assert.ok(e.at >= at && e.at <= value.endedAt); at = e.at;
    if (e.event === "command") {
      if (["start", "copy"].includes(e.operation)) {
        const p = participants.get(e.id); assert.ok(p && !p.terminal);
        assert.deepEqual([p.role, p.app, p.case], [e.role, e.app, e.case]);
      }
      commands.push(e); return;
    }
    if (e.event === "browser-window") {
      assert.ok(e.startedAt >= value.startedAt); assert.ok(!processWindows.some((p) => p.app === e.app && p.case === e.case));
      processWindows.push({ kind: "browser", app: e.app, case: e.case, startedAt: e.startedAt, endedAt: e.endedAt }); return;
    }
    if (e.event === "participant") {
      const s = e.snapshot, key = `container/${s.id}`;
      assert.deepEqual(s.owner, { agent: "codex", task: value.task }); assert.equal(s.image.id, s.imageId);
      if (e.phase === "created") {
        assert.ok(!participants.has(s.id));
        participants.set(s.id, { id: s.id, role: e.role, app: e.app, case: e.case, imageId: s.imageId, createdAt: e.at, snapshots: [] });
        assert.ok(!resources.has(key)); resources.set(key, { kind: "container", id: s.id, owned: true, createdAt: e.at, removedAt: null, absentAt: null });
      }
      const p = participants.get(s.id); assert.ok(p && !p.terminal);
      assert.deepEqual([p.role, p.app, p.case, p.imageId], [e.role, e.app, e.case, s.imageId]);
      if (!config(s, p.role)) block("participant-configuration-mismatch");
      if (e.phase === "running") {
        assert.ok(p.role !== "artifact" && !p.runningAt); p.runningAt = e.at;
        if (!commands.some((c) => c.operation === "start" && c.id === p.id && c.code === 0)) block("running-before-start-acknowledgement");
        if (!(s.state.Running === true && s.state.Pid > 0 && s.restartCount === 0)) block("participant-running-observation-incomplete");
      }
      if (e.phase === "terminal") {
        p.terminal = s; p.terminalAt = e.at;
        if (p.role === "artifact" && s.state.Running) block("artifact-executed");
      }
      if (p.snapshots.length && [s.commandSha256, s.entrypointSha256, s.cmdSha256].join() !== [p.snapshots[0].commandSha256, p.snapshots[0].entrypointSha256, p.snapshots[0].cmdSha256].join()) block("participant-command-changed");
      p.snapshots.push(s);
      for (const m of s.mounts) if (m.type === "volume") {
        id("volume", m.volume); const k = `volume/${m.volume}`;
        if (!/^[a-f0-9]{64}$/.test(m.volume)) block("non-native-named-volume-ownership-missing");
        if (!resources.has(k)) resources.set(k, { kind: "volume", id: m.volume, owned: true, createdAt: e.at, removedAt: null, absentAt: null });
      }
      return;
    }
    if (e.event === "created") {
      assert.ok(e.kind !== "container" && e.kind !== "volume"); const key = `${e.kind}/${e.id}`; assert.ok(!resources.has(key));
      resources.set(key, { kind: e.kind, id: e.id, owned: e.owned, createdAt: e.at, removedAt: null, absentAt: null }); return;
    }
    if (e.event === "remove") {
      const r = resources.get(`${e.kind}/${e.id}`); assert.ok(r && r.owned && !r.removedAt);
      if (e.kind === "container" && !participants.get(e.id).terminal) block("participant-pre-removal-observation-missing");
      if (e.code === 0) {
        r.removedAt = e.at;
        if (e.kind === "container") for (const mount of participants.get(e.id).terminal?.mounts ?? []) {
          // Native removal is fixed rm -f -v. Its acknowledgement also covers
          // associated anonymous volumes, but each still needs positive absence.
          if (mount.type === "volume" && /^[a-f0-9]{64}$/.test(mount.volume)) resources.get(`volume/${mount.volume}`).removedAt = e.at;
        }
      } else block("owned-removal-unacknowledged"); return;
    }
    inventories.set(`${e.kind}/${e.scope}`, e);
    if (e.code !== 0) { block("docker-inventory-command-failed"); return; }
    if (e.scope === "all") for (const r of resources.values()) {
      if (r.kind === e.kind && r.owned && r.removedAt !== null && !e.ids.includes(r.id)) r.absentAt = e.at;
    }
  });
  const terminalBlocked = [];
  for (const r of resources.values()) if (r.owned && (r.removedAt === null || r.absentAt === null)) terminalBlocked.push("original-id-removal-or-absence-missing");
  const lastRemoval = Math.max(value.startedAt, ...[...resources.values()].map((r) => r.removedAt ?? value.startedAt));
  for (const kind of kinds) {
    const inv = inventories.get(`${kind}/owned`);
    if (!inv || inv.code !== 0 || inv.ids.length || inv.at < lastRemoval) terminalBlocked.push("final-owned-inventory-incomplete");
  }
  for (const p of participants.values()) if (!p.terminal) terminalBlocked.push("participant-pre-removal-observation-missing");
  for (const p of participants.values()) if (p.role !== "artifact") {
    const starts = commands.filter((e) => e.operation === "start" && e.id === p.id);
    if (starts.length !== 1) block("participant-start-acknowledgement-missing-or-duplicate");
    if (starts.length === 1 && starts[0].code !== 0 && p.snapshots.some((s) => s.state.Running || s.state.Pid > 0)) block("failed-start-has-running-observation");
  }
  for (const reason of terminalBlocked) block(reason);
  return { executionWindow: { startedAt: value.startedAt, endedAt: value.endedAt }, processWindows,
    participants: [...participants.values()].map((p) => ({ id: p.id, role: p.role, app: p.app, case: p.case, imageId: p.imageId,
      // Cover the pre-start boundary too, not just the first post-start poll.
      window: p.role === "artifact" || commands.some((e) => e.operation === "start" && e.id === p.id && e.code !== 0)
        && p.terminal?.state.Running === false && p.terminal.state.Pid === 0 && !p.runningAt
        ? null : { startedAt: p.createdAt, endedAt: p.terminalAt ?? value.endedAt }, terminal: p.terminal ?? null })),
    commands, cleanupComplete: terminalBlocked.length === 0, blocked, subjectSha256: sha256(encoded(value)) };
}
