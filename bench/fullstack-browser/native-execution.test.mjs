import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definition } from "../workloads/registry.mjs";
import { EvidenceStore, openEvidence } from "./native-evidence.mjs";
import { participantSnapshot, ExecutionLedger, replayExecution, collectDockerInventory } from "./native-execution.mjs";

const commit = "0972dc632fbfe3b66012d188ecdb30250f2469bc", task = "browser-abcdef", cid = "a".repeat(64), imageId = "sha256:" + "b".repeat(64);
const caseKey = definition("fullstack-browser").cases[0].key;
export function participantFixture() {
  const image = { Id: imageId, Config: { Entrypoint: ["node"], Cmd: ["server.mjs"] } };
  const info = { Id: cid, Name: "/native-case", Image: imageId, Config: { ...image.Config, Env: ["SESSION=do-not-retain", "MARKETPLACE_SOURCE=fixture"], Labels: { "agent.owner": "codex", "agent.task": task } }, RestartCount: 0,
    State: { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, Pid: 0, ExitCode: 0, StartedAt: "", FinishedAt: "" },
    HostConfig: { NanoCpus: 1000000000, CpuQuota: 0, CpuPeriod: 0, CpusetCpus: "", Memory: 1024 ** 3, MemorySwap: 2 * 1024 ** 3, ShmSize: 64 * 1024 ** 2, PidsLimit: null, NetworkMode: "bridge" }, Mounts: [] };
  return { info, image };
}
function replay(t, events) {
  const root = mkdtempSync(join(tmpdir(), "corten-native-execution-")); t.after(() => rmSync(root, { recursive: true }));
  const store = new EvidenceStore(root), ledger = new ExecutionLedger(store, { task, commit, startedAt: 100 });
  for (const event of events) ledger.append(event);
  const ref = ledger.finish({ endedAt: 300 }); store.seal(); const reader = openEvidence(root), result = replayExecution(reader, ref); reader.finish(); return result;
}
function fixture() {
  const { info, image } = participantFixture(), created = participantSnapshot(info, image);
  info.State = { ...info.State, Status: "running", Running: true, Pid: 123, StartedAt: "2026-11-13T01:00:00Z" };
  const running = participantSnapshot(info, image), base = { event: "participant", role: "application", app: "corten", case: caseKey };
  return [
    { ...base, phase: "created", at: 110, snapshot: created },
    { event: "command", operation: "start", role: "application", app: "corten", case: caseKey, id: cid, code: 0, at: 115 },
    { ...base, phase: "running", at: 120, snapshot: running },
    { event: "browser-window", app: "corten", case: caseKey, startedAt: 130, endedAt: 190, at: 190 },
    { ...base, phase: "terminal", at: 200, snapshot: running },
    { event: "remove", at: 210, kind: "container", id: cid, code: 0 },
    { event: "inventory", at: 220, kind: "container", scope: "all", code: 0, ids: [] },
    ...["container", "network", "image", "volume"].map((kind) => ({ event: "inventory", at: 230, kind, scope: "owned", code: 0, ids: [] })),
  ];
}
test("execution ledger binds original ID/configuration and derives terminal cleanup independently", (t) => {
  const result = replay(t, fixture()); assert.deepEqual(result.blocked, []); assert.equal(result.cleanupComplete, true);
  assert.equal(result.participants[0].id, cid); assert.deepEqual(result.participants[0].window, { startedAt: 110, endedAt: 200 });
  assert.equal(result.processWindows[0].kind, "browser"); assert.doesNotMatch(JSON.stringify(result), /do-not-retain/);
  assert.equal("resources" in result, false);
});
test("missing absence/removal/final inventories and failed inventory cannot masquerade as cleanup", (t) => {
  for (const mutate of [
    (e) => e.filter((v) => v.scope !== "all"), (e) => e.filter((v) => v.event !== "remove"),
    (e) => e.filter((v) => !(v.kind === "volume" && v.scope === "owned")),
    (e) => e.map((v) => v.scope === "all" ? { ...v, code: 1 } : v),
    (e) => e.map((v) => v.scope === "all" ? { ...v, ids: [cid] } : v),
    (e) => e.filter((v) => v.phase !== "terminal"),
  ]) assert.equal(replay(t, mutate(fixture())).cleanupComplete, false);
});
test("configuration mismatch cannot relax fixed budgets, but does not invent a cleanup leak", (t) => {
  const e = fixture(); e.find((v) => v.phase === "running").snapshot.limits.Memory = 1;
  const result = replay(t, e); assert.ok(result.blocked.includes("participant-configuration-mismatch")); assert.equal(result.cleanupComplete, true);
});
test("rm -f -v acknowledgement still needs positive original anonymous-volume absence", (t) => {
  const events = fixture(), volume = "f".repeat(64);
  for (const e of events.filter((v) => v.event === "participant")) e.snapshot.mounts.push({ type: "volume", destination: "/data", readOnly: false, volume, sourceSha256: "0".repeat(64) });
  assert.equal(replay(t, events).cleanupComplete, false);
  events.push({ event: "inventory", at: 240, kind: "volume", scope: "all", code: 0, ids: [] });
  assert.equal(replay(t, events).cleanupComplete, true);
});
test("wrong original identity, ownership, event order and unobserved removal are contradictory", (t) => {
  for (const mutate of [
    (e) => { e.find((v) => v.phase === "running").snapshot.owner.task = "browser-other"; },
    (e) => { e.find((v) => v.phase === "running").snapshot.id = "c".repeat(64); },
    (e) => { e[1].at = 1; },
  ]) { const e = fixture(); mutate(e); assert.throws(() => replay(t, e)); }
});
test("read-only native inventory helper fixes commands and retains no Docker error secrets", async () => {
  const calls = [], result = await collectDockerInventory(async (args) => { calls.push(args); return { code: 0, stdout: cid + "\n" }; }, "container", task, "all");
  assert.deepEqual(result.ids, [cid]); assert.deepEqual(calls[0], ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"]);
  const failure = await collectDockerInventory(async () => ({ code: 1, stdout: "private-canary" }), "container", task, "owned");
  assert.deepEqual(failure.ids, []); assert.doesNotMatch(JSON.stringify(failure), /private-canary/);
});
test("short-lived or restarted artifact execution cannot be erased into a stopped null window", (t) => {
  for (const history of ["start-ack", "timestamps", "restart"]) {
    const { info, image } = participantFixture(), base = { event: "participant", role: "artifact", app: "corten", case: null };
    const events = [{ ...base, phase: "created", at: 110, snapshot: participantSnapshot(info, image) }];
    if (history === "start-ack") events.push({ event: "command", operation: "start", role: "artifact", app: "corten", case: null, id: cid, code: 0, at: 120 });
    info.State = { ...info.State, Status: "exited", StartedAt: "2026-11-13T01:00:00Z", FinishedAt: "2026-11-13T01:00:01Z" };
    if (history === "restart") info.RestartCount = 1;
    events.push({ ...base, phase: "terminal", at: 200, snapshot: participantSnapshot(info, image) },
      ...fixture().filter((e) => ["remove", "inventory"].includes(e.event)));
    const result = replay(t, events);
    assert.ok(result.blocked.includes("artifact-executed"), history);
    assert.notEqual(result.participants[0].window, null, history);
    assert.equal(result.cleanupComplete, true);
  }
});
test("successful create/build original IDs retain missing-observation and cleanup obligations", async (t) => {
  for (const operation of ["create", "build"]) await t.test(operation, (t) => {
    const result = replay(t, [
      { event: "command", operation, role: "artifact", app: "corten", case: null, id: operation === "create" ? cid : imageId, code: 0, at: 110 },
      ...fixture().filter((e) => e.scope === "owned"),
    ]);
    assert.equal(result.cleanupComplete, false);
    assert.ok(result.blocked.length > 0);
    if (operation === "create") { assert.equal(result.participants[0].id, cid); assert.notEqual(result.participants[0].window, null); }
  });
});
test("later ALL presence revokes original anonymous-volume absence despite empty owned inventories", (t) => {
  const events = fixture(), volume = "f".repeat(64);
  for (const e of events.filter((v) => v.event === "participant")) e.snapshot.mounts.push({ type: "volume", destination: "/data", readOnly: false, volume, sourceSha256: "0".repeat(64) });
  events.push({ event: "inventory", at: 240, kind: "volume", scope: "all", code: 0, ids: [] });
  assert.equal(replay(t, events).cleanupComplete, true);
  events.push({ event: "inventory", at: 250, kind: "volume", scope: "all", code: 0, ids: [volume] });
  assert.equal(replay(t, events).cleanupComplete, false);
});
test("never-started artifact and matched create/build acknowledgements remain valid", (t) => {
  const { info, image } = participantFixture(), base = { event: "participant", role: "artifact", app: "corten", case: null },
    create = { event: "command", operation: "create", role: "artifact", app: "corten", case: null, id: cid, code: 0, at: 110 };
  for (const commandFirst of [true, false]) {
    const snapshot = { ...base, phase: "created", at: 110, snapshot: participantSnapshot(info, image) };
    const events = [...(commandFirst ? [create, snapshot] : [snapshot, create]),
      { ...base, phase: "terminal", at: 200, snapshot: participantSnapshot(info, image) }, ...fixture().filter((e) => ["remove", "inventory"].includes(e.event))];
    const result = replay(t, events); assert.deepEqual(result.blocked, []); assert.equal(result.cleanupComplete, true); assert.equal(result.participants[0].window, null);
  }
  const result = replay(t, [
    { event: "command", operation: "build", role: "artifact", app: "corten", case: null, id: imageId, code: 0, at: 110 },
    { event: "created", kind: "image", id: imageId, owned: true, at: 120 },
    { event: "remove", kind: "image", id: imageId, code: 0, at: 210 },
    { event: "inventory", kind: "image", scope: "all", ids: [], code: 0, at: 220 }, ...fixture().filter((e) => e.scope === "owned"),
  ]); assert.deepEqual(result.blocked, []); assert.equal(result.cleanupComplete, true);
});
test("unknown successful creation and known IDs on failed commands do not lose cleanup obligations", (t) => {
  for (const [code, id] of [[0, null], [1, cid]]) {
    const result = replay(t, [{ event: "command", operation: "create", role: "artifact", app: "corten", case: null, id, code, at: 110 },
      ...fixture().filter((e) => e.scope === "owned")]);
    assert.equal(result.cleanupComplete, false); assert.ok(result.blocked.length > 0);
  }
});
