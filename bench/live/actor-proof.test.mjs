import assert from "node:assert/strict";
import { test } from "node:test";
import { browserDockerGateEnv } from "../workloads/isolated/host-lifetime.mjs";
import { removeOwnedLiveContainer, runLiveAdapters } from "./parity.mjs";
import { liveActorWindow } from "../workloads/isolated/adapters/live-delivery.mjs";

test("cleanup checks the original full container ID and ownership before removing", () => {
  const id = "a".repeat(64), labels = { "agent.owner": "codex", "agent.task": "bench-parity-live" };
  for (const [info, remove] of [
    [{ Id: id, Config: { Labels: labels } }, true],
    [{ Id: "b".repeat(64), Config: { Labels: labels } }, false],
    [{ Id: id, Config: { Labels: { ...labels, "agent.owner": "other" } } }, false],
  ]) {
    const calls = [], docker = (args) => { calls.push(args); return JSON.stringify([info]); };
    if (remove) removeOwnedLiveContainer(docker, id);
    else assert.throws(() => removeOwnedLiveContainer(docker, id));
    assert.deepEqual(calls, [["inspect", id], ...(remove ? [["rm", "-f", "-v", id]] : [])]);
  }
  assert.throws(() => removeOwnedLiveContainer(() => assert.fail("names must not reach Docker"), "parity-live-label"));
});

test("only an isolated native-feed measurement can consume an inherited Docker gate", async (t) => {
  const old = process.env[browserDockerGateEnv];
  process.env[browserDockerGateEnv] = "";
  t.after(() => { if (old === undefined) delete process.env[browserDockerGateEnv]; else process.env[browserDockerGateEnv] = old; });
  for (const group of ["live-delivery", "recoverable-live"]) {
    for (const [isolated, measure, profile] of [[false, true, "native-feed"], [true, false, "native-feed"], [true, true, "bounded"]]) {
      await assert.rejects(runLiveAdapters({ group, isolated, measure, profile }), /Docker gate requires an isolated native-feed measurement/);
    }
    await assert.rejects(runLiveAdapters({ group, isolated: true, measure: true, profile: "native-feed" }), /Docker gate anchor unavailable/);
  }
});

test("functional actor proof requires a real scenario window and a matching browser clock", () => {
  const valid = { schema: "native-live-evidence/v1",
    actorWindow: { startedAt: 10, endedAt: 80, renderer: { startedAt: 20, endedAt: 70 } },
    capture: { records: [{ at: 1 }, { at: 42 }] },
    costs: { timeOrigin: 23, capturedAt: 42 } };
  assert.deepEqual(liveActorWindow(valid, "app"), {
    app: "app", ...valid.actorWindow, renderer: { startedAt: 23, endedAt: 66 },
  });
  for (const a of [
    { ...valid, costs: { timeOrigin: 1, capturedAt: 9 } },
    { ...valid, actorWindow: { ...valid.actorWindow, renderer: null } },
    { ...valid, actorWindow: { startedAt: 50, endedAt: 50, renderer: { startedAt: 50, endedAt: 50 } } },
  ]) assert.throws(() => liveActorWindow(a, "app"));
  const early = { schema: "native-live-failure/v1", actorWindow: { ...valid.actorWindow, renderer: null } };
  assert.equal(liveActorWindow(early, "app").renderer, null);
  assert.throws(() => liveActorWindow({ ...early, network: [{ kind: "response" }] }, "app"));
  const brief = { ...early, actorWindow: { startedAt: 10, endedAt: 12, renderer: { startedAt: 11, endedAt: 11 } } };
  assert.deepEqual(liveActorWindow(brief, "app").renderer, brief.actorWindow.renderer,
    "retain a failed attempt's actual window without claiming it proves placement");
});

test("functional actor proof cannot end before the last retained record on the page clock", () => {
  const a = { schema: "native-live-evidence/v1",
    actorWindow: { startedAt: 10, endedAt: 80, renderer: { startedAt: 20, endedAt: 70 } },
    capture: { records: [{ at: 1 }, { at: 42.25 }] }, costs: { timeOrigin: 23, capturedAt: 42 } };
  assert.throws(() => liveActorWindow(a, "app"), /capture precedes the last page record/);
  a.costs.capturedAt = 42.25;
  assert.doesNotThrow(() => liveActorWindow(a, "app"));
});
