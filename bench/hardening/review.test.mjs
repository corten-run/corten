import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { qualification } from "../marketplace/feature-contract.mjs";
import { qualificationProbes } from "../marketplace/qualification-fixture.mjs";
import { nativeControls, assessNative } from "./native.mjs";
import { trackedNetworkCreate, removeOwnedNetwork, requireSourceControl, failureKind, terminalRecovery, observeTerminalHealth, collectTerminalHealth } from "./lifecycle.mjs";

test("completed native baseline HTTP failures remain target-functional, broken transport remains apparatus-invalid", async () => {
  const q = qualification(qualificationProbes(), "fixture"), live = q.probes.live.path;
  let mode = "healthy";
  const app = createServer((req, res) => {
    if (req.headers.host === "unrecognized.invalid") { res.writeHead(421); return res.end(); }
    const baseline = req.url === live ? "liveness" : req.url.includes("item_1") ? "host" : "negative";
    if (mode === `${baseline}-reset`) return req.socket.destroy();
    res.writeHead(mode === `${baseline}-503` ? 503 : baseline === "negative" ? 404 : 200); res.end("native control");
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    for (mode of ["host-503", "liveness-503", "host-reset", "liveness-reset", "negative-reset", "healthy"]) {
      const raw = await nativeControls({ base, source: "fixture", qualification: q });
      if (mode.endsWith("503")) {
        const result = assessNative(raw, q);
        assert.equal(result.productionQualified, false);
        assert.equal(result.targetFunctionalFailures[0].status, 503);
        assert.throws(() => requireSourceControl(result, "native"), (error) => failureKind("native-controls", error) === "target-functional-failure");
        // The sidecar's JSON wire must preserve the classification for its caller.
        assert.throws(() => requireSourceControl(JSON.parse(JSON.stringify(result)), "edge"), (error) => failureKind("edge-native-controls", error) === "target-functional-failure");
      } else if (mode.endsWith("reset") && mode !== "negative-reset") {
        assert.throws(() => assessNative(raw, q), (error) => failureKind("native-controls", error) === "apparatus-invalid");
      } else {
        const result = assessNative(raw, q);
        assert.equal(result.productionQualified, mode === "healthy");
        assert.equal(result.liveness, mode === "healthy" ? "observed" : "inconclusive");
      }
    }
  } finally { app.closeAllConnections(); await new Promise((r) => app.close(r)); }
});

test("network ownership survives daemon success before cancelled acknowledgement; cleanup reconciles exact names and labels", async () => {
  const summary = {}, name = "owned-net", calls = [], networks = new Map(); let persisted = false;
  await assert.rejects(trackedNetworkCreate(summary, name, () => { persisted = summary.ownedNetworks.includes(name); }, async () => {
    assert.equal(persisted, true);
    networks.set("owned-id", { Id: "owned-id", Name: name, Labels: { "run.corten.hardening": "run", "agent.owner": "codex", "agent.task": "run" }, Containers: {} });
    networks.set("unrelated-id", { Id: "unrelated-id", Name: "owned-net-other", Labels: {}, Containers: {} });
    throw new Error("SIGINT before daemon acknowledgement");
  }), /SIGINT/);
  const docker = async (args, opts) => {
    calls.push(args); assert.equal(opts.cleanup, true);
    if (args[1] === "ls") return [...networks.keys()].join("\n");
    if (args[1] === "inspect") return JSON.stringify([networks.get(args[2])]);
    assert.equal(args[1], "rm"); networks.delete(args[2]); return "";
  };
  await removeOwnedNetwork(summary.ownedNetworks[0], "run", docker);
  assert.equal(networks.has("owned-id"), false); assert.equal(networks.has("unrelated-id"), true);
  assert.deepEqual(calls.filter((r) => r[1] === "rm"), [["network", "rm", "owned-id"]]);
  // An absent reservation is safe; a name collision or attached service is not.
  await removeOwnedNetwork(name, "run", async () => "");
  const collide = networks.get("unrelated-id"); collide.Name = name;
  await assert.rejects(removeOwnedNetwork(name, "run", docker), /unowned network/);
  collide.Labels = { "run.corten.hardening": "run", "agent.owner": "codex", "agent.task": "run" }; collide.Containers = { foreign: {} };
  await assert.rejects(removeOwnedNetwork(name, "run", docker), /attached processes/);
  assert.equal(networks.has("unrelated-id"), true);
  const uncertain = {}, timeout = new Error("create deadline"); timeout.daemonOutcomeUnknown = true;
  await assert.rejects(trackedNetworkCreate(uncertain, "uncertain-net", () => {}, async () => { throw timeout; }), /deadline/);
  assert.deepEqual(uncertain.ownedNetworks, ["uncertain-net"]);
  assert.match(uncertain.cleanupFailures[0], /cannot certify cleanup/);
});

test("every service-critical terminal role is required; fixture upstream remains apparatus", () => {
  const processes = ["application", "proxy", "upstream"].map((role) => ({ id: role, role }));
  const resources = processes.map(({ id }) => ({ id, running: true }));
  const lifecycle = Object.fromEntries(processes.map(({ id }) => [id, { after: { State: { Running: true, ExitCode: 0, OOMKilled: false } } }]));
  for (const { id } of processes) {
    const changed = structuredClone(lifecycle); Object.assign(changed[id].after.State, { Running: false, OOMKilled: true, ExitCode: 137 });
    const result = terminalRecovery(true, processes, resources, changed, "api");
    assert.equal(result.disposition, "not-recovered"); assert.equal(result.terminalServices.find((p) => p.id === id).oomKilled, true);
    if (id === "upstream") assert.throws(() => terminalRecovery(true, processes, resources, changed, "fixture"), /apparatus upstream exited/);
  }
});

test("terminal native liveness and Docker health must both recover in every critical role", async () => {
  let status = 200;
  const app = createServer((req, res) => { res.writeHead(status); res.end("native health"); });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${app.address().port}`, paths = { application: "/health/live", proxy: "/health/live", upstream: "/health" };
    const processes = Object.keys(paths).map((role) => ({ id: role, role })), resources = processes.map(({ id }) => ({ id, running: true }));
    const lifecycle = {}, startNs = String(process.hrtime.bigint()), endpoints = Object.fromEntries(Object.entries(paths).map(([role, path]) => [role, base + path]));
    for (const { id } of processes) lifecycle[id] = { after: { State: { Running: true, Health: { Status: "healthy" } } }, health: await observeTerminalHealth(base, paths[id], 600) };
    const observation = { start: { bootId: lifecycle.application.health.bootId, monotonicNs: startNs },
      end: { bootId: lifecycle.application.health.bootId, monotonicNs: String(process.hrtime.bigint()) } };
    for (const p of Object.values(lifecycle)) p.observation = observation;
    const recovery = (value, source = "api") => terminalRecovery(true, processes, resources, value, source, paths, endpoints);
    assert.equal(recovery(lifecycle).disposition, "recovered");
    status = 503;
    const failed = {};
    for (const { id } of processes) failed[id] = await observeTerminalHealth(base, paths[id], 600);
    assert.equal(failed.application.response.status, 503); assert.equal(failed.application.response.complete, true);
    observation.end.monotonicNs = String(process.hrtime.bigint());
    for (const { id } of processes) {
      for (const corrupt of [(p) => p.after.State.Health.Status = "unhealthy", (p) => p.after.State.Health.Status = "starting",
        (p) => { p.health = failed[id]; }, (p) => { delete p.health; },
        (p) => { p.health.response.timedOut = true; }, (p) => { p.health.response.complete = false; },
        (p) => { p.health.response.error = "ECONNRESET"; }, (p) => { p.health.response.ms = 601; }, (p) => { p.after.State.Paused = true; },
        (p) => { delete p.after.State.Health; p.after.Config = { Healthcheck: { Test: ["CMD", "health"] } }; }]) {
        const changed = structuredClone(lifecycle); corrupt(changed[id]);
        const terminal = recovery(changed);
        assert.equal(terminal.disposition, "not-recovered", id);
        assert.ok(terminal.terminalServices.some((service) => !service.healthy || service.liveness !== "observed"));
      }
    }
    const wrong = structuredClone(lifecycle); wrong.application.health.path = "/invented";
    assert.throws(() => recovery(wrong), /health path/);
    const corrupt = structuredClone(lifecycle); corrupt.application.health.response.body = "different";
    assert.throws(() => recovery(corrupt));
    const fixture = structuredClone(lifecycle); fixture.upstream.health = failed.upstream;
    assert.throws(() => recovery(fixture, "fixture"), /apparatus upstream unhealthy/);
    const missing = structuredClone(lifecycle); missing.application.health = { path: null, response: null };
    const missingPath = () => terminalRecovery(true, processes, resources, missing, "api", { ...paths, application: null }, endpoints);
    assert.equal(missingPath().disposition, "missing-liveness");
    missing.proxy.health = failed.proxy;
    assert.equal(missingPath().disposition, "not-recovered");
    missing.proxy.health = lifecycle.proxy.health;
    missing.application.after.State.Running = false;
    assert.equal(missingPath().disposition, "not-recovered");
  } finally { app.closeAllConnections(); await new Promise((r) => app.close(r)); }
});

test("terminal HTTP receipts reject preflight, stale acquisition and wrong actual URL/Host/method for every critical role", async () => {
  const app = createServer((req, res) => res.end("native endpoint or page"));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const preflight = await observeTerminalHealth(base, "/marketplace/en-US/item_1", 600);
    for (const role of ["application", "proxy", "upstream"]) {
      const path = role === "upstream" ? "/health" : "/health/live", start = String(process.hrtime.bigint());
      const health = await observeTerminalHealth(base, path, 600);
      const observation = { start: { bootId: health.bootId, monotonicNs: start }, end: { bootId: health.bootId, monotonicNs: String(process.hrtime.bigint()) } };
      const lifecycle = { [role]: { after: { State: { Running: true } }, health, observation } };
      const recovery = (value) => terminalRecovery(true, [{ id: role, role }], [{ id: role, running: true }], value, "api", { [role]: path }, { [role]: base + path });
      assert.equal(recovery(lifecycle).disposition, "recovered");
      for (const corrupt of [(p) => { p.health.response = preflight.response; },
        (p) => { p.health.response.url = base + "/marketplace/en-US/item_1"; },
        (p) => { p.health.response.url = "https://elsewhere.invalid" + path; },
        (p) => { p.health.response.host = "elsewhere.invalid"; }, (p) => { p.health.response.method = "POST"; },
        (p) => { p.health.response.startedNs = preflight.response.startedNs; p.health.response.endedNs = preflight.response.endedNs; },
        (p) => { delete p.health.response.startedNs; }, (p) => { p.health.bootId = "other-boot"; },
        (p) => { p.health.response.endedNs = String(BigInt(observation.end.monotonicNs) + 1n); }]) {
        const changed = structuredClone(lifecycle); corrupt(changed[role]);
        assert.throws(() => recovery(changed), /terminal/, role);
      }
    }
  } finally { app.closeAllConnections(); await new Promise((r) => app.close(r)); }
});

test("observer failure retains only an unchanged, verified critical target exit; live/changed/fixture targets stay apparatus failures", async () => {
  const before = { Id: "native-id", State: { Running: true, StartedAt: "2026-11-12T00:00:00Z" } };
  const exited = { Id: before.Id, State: { ...before.State, Running: false, Status: "exited", ExitCode: 0, Error: "", FinishedAt: "2026-11-12T00:01:00Z" } };
  const failure = new Error("cannot join network namespace of a non running container");
  for (const role of ["application", "proxy", "upstream"]) {
    const collect = async (after, source = "api") => {
      let calls = 0;
      return collectTerminalHealth({ role, source, path: "/health", inspect: async () => calls++ ? after : before, observe: async () => { throw failure; } });
    };
    const result = await collect(exited);
    assert.equal(result.after, exited); assert.equal(result.health.response, null); assert.equal(result.health.observerError, failure.message);
    const recovery = terminalRecovery(true, [{ id: role, role }], [{ id: role, running: true }], { [role]: result }, "api", { [role]: "/health" });
    assert.equal(recovery.disposition, "not-recovered");
    assert.equal(recovery.terminalServices[0].healthy, false);
    for (const corrupt of [(p) => { p.State.Running = true; }, (p) => { p.Id = "different-id"; },
      (p) => { p.State.StartedAt = "2026-11-12T00:00:10Z"; }, (p) => { p.State.Error = "daemon failure"; },
      (p) => { p.State.FinishedAt = "not a time"; }, (p) => { p.State.Dead = true; }]) {
      const changed = structuredClone(exited); corrupt(changed);
      await assert.rejects(collect(changed), (error) => error === failure);
    }
    if (role === "upstream") await assert.rejects(collect(exited, "fixture"), (error) => error === failure);
  }
});
