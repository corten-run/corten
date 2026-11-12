// These loopback controls test the apparatus only, never qualify a native framework.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { qualification, validateQualification } from "../marketplace/feature-contract.mjs";
import { qualificationProbes } from "../marketplace/qualification-fixture.mjs";
import { livePaths } from "../fullstack/conformance.mjs";
import { nativeControls, assessNative, assessTimedSource, observe } from "./native.mjs";
import { resourceAsync } from "./probe.mjs";
import { matrix, nativeGroup, groupReady, budgets } from "./plan.mjs";
import { targetOutcome, verifyNativeLimits } from "./evidence.mjs";

const listen = async (server) => { await new Promise((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${server.address().port}`; };
const close = async (server) => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
test("real API control receipts detect cache, double reads, passthrough and swallowed faults, and reset independently", async () => {
  const fixture = records(), upstreamServer = marketplaceServer(fixture), upstream = await listen(upstreamServer);
  let mode = "correct";
  const app = createServer(async (req, res) => {
    if (req.headers.host === "unrecognized.invalid") { res.writeHead(421); return res.end(); }
    if (req.url === "/health/live") {
      if (mode === "health-depends") { const upstreamState = await observe(upstream + "/marketplace/records/item_1"); res.writeHead(upstreamState.status); }
      return res.end("live");
    }
    if (!req.url.includes("item_1")) { res.writeHead(404); return res.end(); }
    const raw = await observe(upstream + "/marketplace/records/item_1");
    if (mode === "double") await observe(upstream + "/marketplace/records/item_1");
    if (raw.status !== 200 && mode !== "swallow") { res.writeHead(503); return res.end("unavailable"); }
    const value = mode === "cache" || mode === "swallow" ? fixture.item_1 : JSON.parse(raw.body);
    res.end(req.url.startsWith("/api/") ? mode === "passthrough" ? raw.body : JSON.stringify(value) : `<h1>${value.title}</h1>`);
  });
  const base = await listen(app), q = validateQualification(qualification(qualificationProbes(), "api"));
  try {
    for (mode of ["correct", "cache", "double", "passthrough", "swallow", "health-depends"]) {
      const raw = await nativeControls({ base, source: "api", upstream, qualification: q, original: fixture.item_1 });
      if (mode === "double") assert.throws(() => assessNative(raw, q), /exactly once/);
      else assert.equal(assessNative(raw, q).sourceControl, ["correct", "health-depends"].includes(mode) ? "passed" : "target-functional-failure");
      if (mode === "health-depends") { assert.equal(assessNative(raw, q).livenessDuringUpstreamFailure, "not-live"); assert.equal(assessNative(raw, q).productionQualified, false); }
      const restored = JSON.parse((await observe(upstream + "/marketplace/records/item_1")).body); assert.deepEqual(restored, fixture.item_1);
      if (mode === "correct") {
        assert.equal(assessNative(raw, q).hostValidation, "observed"); assert.equal(assessNative(raw, q).livenessDuringUpstreamFailure, "observed");
        for (const mutate of [(v) => v.api.responses.pop(), (v) => v.api.controllers.pop(), (v) => v.api.controllers[0].response.sha256 = "invented",
          (v) => v.api.responses[0].response.body = "{}", (v) => v.liveness.path = "/invented"]) {
          const bad = structuredClone(raw); mutate(bad); assert.throws(() => assessNative(bad, q));
        }
      }
    }
  } finally { await close(app); await close(upstreamServer); }
});

test("timed API receipts preserve independent actual read totals and explicit unavailability", async () => {
  const server = marketplaceServer(records()), base = await listen(server);
  const raw = [{ type: "upstream-control-before", response: await observe(base + "/__marketplace/control", { method: "POST", body: "{}" }) }];
  try {
    await observe(base + "/marketplace/records/item_1"); await observe(base + "/marketplace/records/item_1");
    raw.push({ type: "upstream-control-after", response: await observe(base + "/__marketplace/control") });
    assert.deepEqual(assessTimedSource(raw).counts, { requests: { item_1: 2 }, status: 200, answers: { 200: 2 } });
    for (const mutate of [(r) => r.pop(), (r) => r.push(r[0]), (r) => r[1].response.sha256 = "invented"]) {
      const bad = structuredClone(raw); mutate(bad); assert.throws(() => assessTimedSource(bad));
    }
  } finally { await close(server); }
  raw[1].response = await observe(base + "/__marketplace/control");
  const result = assessTimedSource(raw); assert.equal(result.state, "unavailable"); assert.equal(result.counts, null);
});

test("missing native host and liveness remain observed gaps, while a catch-all 200 health is inconclusive", async () => {
  const probes = qualificationProbes(); probes.badHost.status = 200; delete probes.live;
  probes.liveness = livePaths.map((path) => ({ status: 404, headers: {}, bodyLength: 0, ms: 1, path }));
  const q = validateQualification(qualification(probes, "fixture"));
  const app = createServer((req, res) => { res.writeHead(req.url.startsWith("/marketplace/") ? 200 : 404); res.end("native"); });
  const base = await listen(app);
  try {
    const raw = await nativeControls({ base, source: "fixture", qualification: q }); const assessment = assessNative(raw, q);
    assert.equal(assessment.productionQualified, false); assert.equal(assessment.hostValidation, "missing"); assert.equal(assessment.liveness, "missing");
    assert.deepEqual(assessment.missingProductionFeatures, ["host", "live"]);
    assert.equal(assessment.qualificationPurpose, "explicit-native-defense-gap-observation-not-qualified-performance");
  } finally { await close(app); }
  const catchAll = createServer((req, res) => res.end("same page")), url = await listen(catchAll), qualified = qualification(qualificationProbes(), "fixture");
  try { const raw = await nativeControls({ base: url, source: "fixture", qualification: qualified }); assert.equal(assessNative(raw, qualified).liveness, "inconclusive"); }
  finally { await close(catchAll); }
});

test("capacity failure is an observed target outcome, not apparatus success or numeric service evidence", () => {
  const capture = { legitimate: Object.fromEntries(["before", "during", "after"].map((key) => [key, { counts: { sent: 4, ok: 0, errors: 4 } }])), recovery: { disposition: "stopped" }, measurement: "unavailable" };
  assert.equal(targetOutcome(capture, { productionQualified: true }).classification, "target-capacity-failure");
  assert.equal(targetOutcome(capture, { productionQualified: true }).numericComparisonQualified, false);
  const cells = matrix(); assert.equal(nativeGroup(cells).length, 9); assert.ok(nativeGroup(cells).every((a) => a.productionQualification === "not-established"));
  for (const cell of cells) Object.assign(cell, { status: "observed", parity: "passed", apparatusValid: true });
  assert.equal(groupReady(cells), false, "shared oracle flags cannot replace native assessment");
});

test("asynchronous resource reads retain real counters, PID inventory and collection interval", async () => {
  const folder = mkdtempSync(join(tmpdir(), "hardening-cgroup-"));
  try {
    for (const [file, value] of Object.entries({ "cpu.stat": "usage_usec 7000000\n", "memory.current": "1024\n", "memory.events": "oom_kill 0\n", "cgroup.procs": "17\n29\n" })) writeFileSync(join(folder, file), value);
    const sample = await resourceAsync(folder); assert.equal(sample.cpuSeconds, 7); assert.equal(sample.memoryBytes, 1024); assert.deepEqual(sample.procs, ["17", "29"]);
    assert.ok(BigInt(sample.endedNs) >= BigInt(sample.startedNs));
    rmSync(join(folder, "cpu.stat")); assert.ok((await resourceAsync(folder)).unavailable);
  } finally { assert.ok(resolve(folder).startsWith(resolve(tmpdir()))); rmSync(folder, { recursive: true }); }
});

test("actual native container budgets cannot be weakened while the declared profile stays unchanged", () => {
  for (const mode of ["direct", "deployed-edge"]) {
    const b = budgets(), roles = ["application", "upstream", ...(mode === "deployed-edge" ? ["proxy"] : [])];
    const settings = { case: mode, effectiveBudgets: JSON.stringify(b), deployment: { processes: roles.map((role) => ({ id: role, role, count: 1 })) } };
    const lifecycle = Object.fromEntries(roles.map((role) => {
      const limit = role === "application" ? b.resources[mode === "direct" ? "applicationDirect" : "applicationEdge"] : b.resources[role];
      const before = { HostConfig: { NanoCpus: limit.cpu * 1e9, Memory: limit.memory, MemorySwap: limit.memory, PidsLimit: 512,
        Ulimits: [{ Name: "nofile", Hard: 65536, Soft: 65536 }], RestartPolicy: { Name: "no" }, Privileged: false, PortBindings: {} } };
      return [role, { before, after: structuredClone(before), events: [] }];
    }));
    verifyNativeLimits(settings, lifecycle);
    for (const mutate of [(c) => c.NanoCpus *= 2, (c) => c.Memory *= 2, (c) => c.MemorySwap *= 2, (c) => c.PidsLimit = 4096,
      (c) => c.Ulimits[0].Hard++, (c) => c.RestartPolicy.Name = "always", (c) => c.Privileged = true, (c) => c.PortBindings = { "8080/tcp": [{ HostPort: "8080" }] }]) {
      const changed = structuredClone(lifecycle); mutate(changed.application.before.HostConfig); mutate(changed.application.after.HostConfig);
      assert.throws(() => verifyNativeLimits(settings, changed));
    }
    const changed = structuredClone(lifecycle); changed.application.events.push({ Action: "update" }); assert.throws(() => verifyNativeLimits(settings, changed));
    assert.throws(() => verifyNativeLimits({ ...settings, deployment: { processes: settings.deployment.processes.slice(1) } }, lifecycle));
  }
});
