import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgets, validateBudget, matrix, apps, phases, cases, sources, parseArgs, selected, groupReady } from "./plan.mjs";
import { Connections, controls, inject, legitimate, payload } from "./probe.mjs";
import { artifacts, verifyArtifacts, verifyParity } from "./evidence.mjs";

test("all selected native candidates, sources, deployments and phases remain visible", () => {
  const cells = matrix(); assert.equal(cells.length, apps.length * sources.length * cases.length * phases.length);
  assert.deepEqual(apps, ["corten", "aspnet", "spring", "nextjs", "django", "express", "gin", "drogon", "topcoat"]);
  const o = parseArgs(["w1", "--review", "test-only", "--verify-app", "express", "--verify-case", "direct"]);
  assert.equal(cells.filter((c) => selected(c, o)).length, 12); assert.equal(cells.length, 216);
  assert.equal(groupReady(cells), false); assert.throws(() => groupReady(cells.slice(1)), /matrix/);
  assert.throws(() => parseArgs(["--build"]), /round/);
  assert.throws(() => parseArgs(["r17", "--review", "not-official"]), /round/);
  for (const args of [["--apps", "express"], ["--verify-app", "missing"], ["--profile", "bounded", "--profile", "bounded"], ["--review"]])
    assert.throws(() => parseArgs(["w2", "--review", "test", ...args]));
});

test("immutable effective profiles charge equal total budgets including every native role", () => {
  for (const profile of ["bounded", "sustained"]) assert.equal(validateBudget(budgets(profile)).profile, profile);
  for (const mutate of [(b) => b.attack.maxConnections++, (b) => b.resources.proxy.cpu = 0, (b) => b.attack.scheduledAtMs.pop(), (b) => b.timing.maxStartLagMs = Infinity]) {
    const b = budgets(); mutate(b); assert.throws(() => validateBudget(b));
  }
});

test("same native socket injectors pass independent receiver controls for all six phases", async () => {
  for (const phase of phases) {
    const result = await controls(phase); assert.equal(result.passed, true); assert.equal(result.legitimate.ok, true);
  }
});

test("refused target connections are real target counters, not successful injection or local exhaustion", async () => {
  const server = createServer(); await new Promise((r) => server.listen(0, "127.0.0.1", r)); const port = server.address().port;
  await new Promise((r) => server.close(r));
  const pool = new Connections(), start = performance.now(), seen = [];
  const result = await inject({ phase: "idle-connections", index: 0, target: { host: "127.0.0.1", port, authority: "localhost" }, attack: { connectTimeoutMs: 100 }, form: {}, pool,
    now: () => performance.now() - start, releaseAtMs: 100, emit: (row) => seen.push(row) });
  assert.equal(result.established, false); assert.ok(["ECONNREFUSED", "ECONNRESET"].includes(result.error)); assert.equal(seen.length, 1);
  await pool.close(); assert.equal(pool.sockets.size, 0); assert.deepEqual(pool.errors, []);
});

test("legitimate recorder rejects wrong, truncated and hung responses even with HTTP 200", async () => {
  const server = httpServer((req, res) => {
    if (req.url === "/api/good") res.end('{"id":"native","value":7}');
    else if (req.url === "/api/wrong") res.end('{"id":"native","value":8}');
    else if (req.url === "/api/truncated") { res.writeHead(200, { "Content-Length": 1000 }); res.end("{}"); }
    else res.writeHead(200);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const pool = new Connections();
  try {
    for (const name of ["good", "wrong", "truncated", "hang"]) {
      const row = await legitimate({ target: { host: "127.0.0.1", port: server.address().port, authority: "localhost" }, path: `/api/${name}`,
        expected: { id: "native", value: 7 }, timeoutMs: 150, pool, now: performance.now.bind(performance), emit: () => {}, index: 0, window: "test" });
      assert.equal(row.ok, name === "good");
    }
  } finally { await pool.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("attack payloads bind real form metadata and preserve incomplete heads/bodies and oversized variants", () => {
  const b = budgets(), target = { authority: "native", origin: "http://native" }, form = { path: "/native-action", prefix: "csrf=secret&padding=", cookie: "native-cookie", type: "application/x-www-form-urlencoded" };
  assert.ok(!payload("slow-headers", 0, target, b.attack, form).first.includes("\r\n\r\n"));
  const body = payload("slow-bodies", 0, target, b.attack, form).first;
  assert.ok(body.includes("POST /native-action ") && body.includes("Cookie: native-cookie") && body.endsWith(form.prefix));
  assert.equal(payload("slow-readers", 0, target, b.attack, form).paused, true);
  assert.equal(payload("idle-connections", 0, target, b.attack, form).first, "");
  assert.ok(payload("connection-pressure", 0, target, b.attack, form).first.includes("Connection: close"));
  assert.deepEqual([0, 1, 2].map((i) => payload("oversized-requests", i, target, b.attack, form).variant), ["header-count", "header-size", "body-size"]);
});

test("raw evidence cannot escape the result directory, mutate or disappear after sealing", () => {
  const folder = mkdtempSync(join(tmpdir(), "native-hardening-test-"));
  try {
    writeFileSync(join(folder, "raw.jsonl"), '{"observed":true}\n'); const manifest = artifacts(folder); verifyArtifacts(folder, manifest);
    assert.throws(() => verifyArtifacts(folder, [{ ...manifest[0], path: "../outside" }]), /escaped/);
    assert.throws(() => verifyArtifacts(folder, [{ ...manifest[0], path: resolve(folder, "raw.jsonl") }]));
    writeFileSync(join(folder, "raw.jsonl"), '{"observed":false}\n'); assert.throws(() => verifyArtifacts(folder, manifest), /modified/);
    rmSync(join(folder, "raw.jsonl")); assert.throws(() => verifyArtifacts(folder, manifest), /missing/);
  } finally { assert.ok(resolve(folder).startsWith(resolve(tmpdir()))); rmSync(folder, { recursive: true }); }
});

test("a shared oracle receipt or passing subset is never native parity", () => {
  assert.throws(() => verifyParity({ readyForLoad: true, status: "passed" }, "fixture"));
  assert.throws(() => verifyParity({ workload: "marketplace-v2", source: "fixture", jsonRecords: 500, pages: 264, profiles: [] }, "fixture"));
  assert.throws(() => verifyParity({ workload: "marketplace-v2", source: "fixture", jsonRecords: 500, pages: 264, profiles: Array(12).fill({ locale: "en-US", javaScriptEnabled: true, mobile: false, passed: true }) }, "fixture"));
});
