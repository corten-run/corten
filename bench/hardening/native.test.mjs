// These loopback controls test the apparatus only, never qualify a native framework.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { qualification, validateQualification } from "../marketplace/feature-contract.mjs";
import { qualificationProbes } from "../marketplace/qualification-fixture.mjs";
import { livePaths } from "../fullstack/conformance.mjs";
import { nativeControls, assessNative, observe } from "./native.mjs";
import { resourceAsync } from "./resource-sample.mjs";
import { matrix, nativeGroup, groupReady, budgets, boundedRequestsVersion } from "./plan.mjs";
import { verifyNativeLimits } from "./evidence.mjs";
import { trackedImageBuild, removeOwnedImage, requireSourceControl, failureKind, terminalRecovery } from "./lifecycle.mjs";

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
      assert.equal(assessNative(raw, q).sourceControl, ["correct", "health-depends"].includes(mode) ? "passed" : "target-functional-failure");
      if (mode === "correct") {
        const interrupted = structuredClone(raw);
        Object.assign(interrupted.api.responses.find(r => r.step === "mutated-json").response, { complete: false, error: "EMFILE" });
        assert.throws(() => assessNative(interrupted, q), /incomplete native API transport/);
      }
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

test("terminal native exit after recovery midpoint blocks recovery and numeric qualification without inventing a sample", () => {
  const processes = [{ id: "application", role: "application" }], samples = [{ id: "application", running: true }];
  const lifecycle = { application: { after: { State: { Running: false, ExitCode: 137, OOMKilled: true, FinishedAt: "2026-11-12T12:00:13.000Z" } } } };
  const recovery = terminalRecovery(true, processes, samples, lifecycle);
  assert.equal(recovery.disposition, "not-recovered"); assert.equal(samples[0].running, true);
  assert.equal(recovery.terminalApplications[0].exitCode, 137); assert.equal(recovery.terminalApplications[0].oomKilled, true);
  assert.equal(recovery.terminalServices[0].healthy, false);
});

test("owned image registration precedes failed/cancelled build and cleanup refuses unrelated tags", async () => {
  const summary = {}, tag = "owned-build", calls = []; let saved = false;
  await assert.rejects(trackedImageBuild(summary, tag, () => { saved = true; }, async () => {
    assert.deepEqual(summary.ownedImages, [tag]); assert.equal(saved, true); throw new Error("cancelled after daemon tagged image");
  }), /cancelled/);
  const docker = async (args, options) => {
    calls.push(args); assert.equal(options.cleanup, true);
    if (args[1] === "ls") return "image-id";
    if (args[1] === "inspect") return JSON.stringify([{ Config: { Labels: { "run.corten.hardening": "owned-run" } } }]);
    return "";
  };
  await removeOwnedImage(summary.ownedImages[0], "owned-run", docker);
  assert.deepEqual(calls.at(-1), ["image", "rm", tag]);
  await assert.rejects(removeOwnedImage(tag, "someone-else", docker), /unowned image/);
  const absent = []; await removeOwnedImage(tag, "owned-run", async (args) => { absent.push(args); return ""; }); assert.equal(absent.length, 1);
});

test("target API functional failures are distinct from broken control apparatus and parity failures", () => {
  for (const stage of ["native-controls", "edge-native-controls"]) {
    let error; try { requireSourceControl({ sourceControl: "target-functional-failure" }, stage); } catch (e) { error = e; }
    assert.equal(failureKind(stage, error), "target-functional-failure");
    assert.equal(failureKind(stage, new Error("control channel failed")), "apparatus-invalid");
  }
  assert.equal(failureKind("edge-parity", new Error("browser differs")), "parity-blocked");
  requireSourceControl({ sourceControl: "passed" }, "native");
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
  try {
    const raw = await nativeControls({ base: url, source: "fixture", qualification: qualified });
    assert.equal(assessNative(raw, qualified).liveness, "inconclusive");
    for (const mutate of [(r) => r.liveness.negative.error = "ECONNRESET", (r) => r.liveness.negative.timedOut = true, (r) => r.liveness.negative.complete = false]) {
      const bad = structuredClone(raw); bad.liveness.negative.status = 404; mutate(bad);
      assert.equal(assessNative(bad, qualified).liveness, "inconclusive", "failed negative health receipt is not observed liveness");
      assert.equal(assessNative(bad, qualified).productionQualified, false);
    }
    raw.liveness.negative.status = 404; raw.host.denied.status = 404;
    assert.equal(assessNative(raw, qualified, "deployed-edge").hostValidation, "observed");
    assert.match(assessNative(raw, qualified, "deployed-edge").productionQualificationScope, /^effective TLS deployment production probes/);
    raw.host.denied.error = "ECONNRESET"; assert.equal(assessNative(raw, qualified).hostValidation, "inconclusive");
  }
  finally { await close(catchAll); }
});

test("unknown HTTP Host control cannot replace TLS server identity or fail before reaching HTTP", async () => {
  const peers = new Set(); let hello;
  const server = createTcpServer((socket) => {
    peers.add(socket); socket.once("close", () => peers.delete(socket)); socket.on("error", () => {});
    const chunks = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk); const bytes = Buffer.concat(chunks);
      if (bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt16BE(3)) { hello = bytes; socket.destroy(); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await observe(`https://localhost:${server.address().port}/`, { host: "unrecognized.invalid", timeoutMs: 2000 });
    assert.equal(response.host, "unrecognized.invalid"); assert.equal(response.complete, false);
    assert.ok(hello && hello[0] === 22); assert.ok(hello.includes(Buffer.from("localhost")), "TLS ClientHello must identify the actual certificate host");
    assert.equal(hello.includes(Buffer.from("unrecognized.invalid")), false, "bad HTTP Host must not poison SNI/certificate validation");
  } finally { for (const socket of peers) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
});

test("unbacked observed flags do not constitute native evidence", () => {
  const cells = matrix(); assert.equal(nativeGroup(cells).length, 9); assert.ok(nativeGroup(cells).every((a) => a.productionQualification === "not-established"));
  for (const cell of cells) Object.assign(cell, { status: "observed", parity: "passed", apparatusValid: true });
  assert.equal(groupReady(cells), false, "shared oracle flags cannot replace native assessment");
});

test("checklist-only, failed browser and missing edge receipts cannot label a complete native group qualified", () => {
  const cells = matrix();
  // Ledger-aggregation unit input only. No native captures or measurements are produced.
  for (const c of cells) Object.assign(c, { status: "invalid", parity: "failed", apparatusValid: false,
    nativeAssessment: { schema: "native-hardening-assessment/v1", productionQualified: true, missingProductionFeatures: [],
      hostValidation: "observed", liveness: "observed", sourceControl: c.source === "api" ? "passed" : "not-applicable" } });
  assert.ok(nativeGroup(cells).every((app) => app.productionQualification === "partial" && app.observed === 0));
  assert.equal(groupReady(cells), false);
  for (const c of cells) Object.assign(c, { status: "observed", parity: "passed", apparatusValid: true });
  assert.equal(groupReady(cells), false, "direct receipts cannot qualify deployed-edge cells");
  assert.ok(nativeGroup(cells).every((app) => app.productionQualification === "partial"));
  for (const c of cells.filter((c) => c.mode === "deployed-edge")) c.edgeAssessment = { ...c.nativeAssessment, productionQualified: false, hostValidation: "missing" };
  assert.ok(nativeGroup(cells).every((app) => app.productionQualification === "gaps-observed"));
  assert.equal(groupReady(cells), false, "a protection receipt cannot stand in for dependency recovery");
  for (const c of cells) {
    if (c.phase === "dependency-recovery") {
      c.dependencyRecovery = { version: "dependency-recovery/v1", source: c.source, status: c.source === "api" ? "recovered" : "fixture-control" };
      c.dependencyTerminalHealthy = true;
    } else {
      c.boundedRequests = { version: boundedRequestsVersion, phase: c.phase, source: c.source,
        status: c.phase === "request-limit" ? "accepted" : c.source === "api" ? "client-deadline" : "fixture-control", healthy: true };
      c.boundedTerminalHealthy = true;
    }
  }
  assert.equal(groupReady(cells), true, "complete apparatus evidence may retain observed native defense gaps without qualifying production");
  Object.assign(cells[0].boundedRequests, { status: "target-failure", healthy: false });
  cells[0].boundedTerminalHealthy = false;
  assert.equal(groupReady(cells), true, "an observed target failure is not a missing apparatus result");
  assert.ok(nativeGroup(cells).every((app) => !app.numericComparisonQualified));
  cells[0].nativeAssessment.hostValidation = "unknown"; assert.equal(groupReady(cells), false);
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
