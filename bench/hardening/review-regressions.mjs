// Explicit replay of retained native bytes. Mutations stay in memory; no captures are written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemble, verifyArtifacts, targetOutcome, digest } from "./evidence.mjs";
import { terminalHealthPaths } from "./lifecycle.mjs";

assert.ok(process.argv[2], "retained native cell directory required");
const folder = resolve(process.argv[2]);
const read = (name) => JSON.parse(readFileSync(join(folder, name), "utf8"));
verifyArtifacts(folder, read("manifest.json"));
const deployment = read("deployment.json"), settings = read("settings.json");
const input = { settings, raw: readFileSync(join(folder, "raw.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
  parity: read("parity.json"), source: read("qualification.json").source, cleanup: read("cleanup.json"),
  provenance: deployment.provenance, lifecycle: Object.fromEntries(deployment.processes.map((p) => [p.id, read(`${p.id}-lifecycle.json`)])) };
const tests = []; let total = 0;
const check = (name, fn) => { total++; try { fn(); console.log(`PASS ${name}`); } catch (error) { tests.push(name); console.error(`FAIL ${name}: ${error.message}`); } };
check("unmodified native raw evidence replays without rewriting qualification", () => {
  const capture = assemble(input);
  assert.equal(capture.recovery.disposition, "not-recovered", "historical bytes cannot invent terminal liveness");
  assert.equal(targetOutcome(capture, { productionQualified: true }, { state: "observed" }).numericComparisonQualified, false);
});
check("client release after only 10 ms is not retained native pressure", () => {
  const changed = structuredClone(input);
  for (const row of changed.raw.filter((r) => r.type === "attack" && r.releasedAtMs !== null)) {
    row.releasedAtMs = row.connectedAtMs + 10; row.endedAtMs = row.releasedAtMs + 1;
    row.drips = 0; row.dripAtMs = []; row.writes = 1; row.bytesQueued = row.firstBytes;
  }
  assert.throws(() => assemble(changed), /release deadline/);
});
check("one honest trickle cannot establish the full retained interval", () => {
  const changed = structuredClone(input);
  for (const row of changed.raw.filter((r) => r.type === "attack" && r.drips > 1)) {
    row.drips = 1; row.dripAtMs = row.dripAtMs.slice(0, 1); row.writes = 2;
    row.bytesQueued = row.firstBytes + settings.emissionPlan[row.index].dripBytes;
  }
  assert.throws(() => assemble(changed), /trickle/);
});
check("target closure cannot extend pressure past mandatory client release", () => {
  const changed = structuredClone(input), b = JSON.parse(settings.effectiveBudgets);
  for (const row of changed.raw.filter((r) => r.type === "attack" && r.established)) {
    row.targetClosedAtMs = b.attack.releaseAtMs + 1000; row.releasedAtMs = null; row.endedAtMs = row.targetClosedAtMs + 1;
    row.drips = Math.floor((row.targetClosedAtMs - row.connectedAtMs) / b.attack.everyMs);
    row.dripAtMs = Array.from({ length: row.drips }, (_, i) => row.connectedAtMs + (i + 1) * b.attack.everyMs);
    row.writes = 1 + row.drips; row.bytesQueued = row.firstBytes + row.drips * settings.emissionPlan[row.index].dripBytes;
  }
  assert.throws(() => assemble(changed), /release deadline/);
});
check("late establishment cannot erase mandatory trickles", () => {
  const changed = structuredClone(input);
  for (const row of changed.raw.filter((r) => r.type === "attack" && r.established)) {
    row.connectedAtMs = row.releasedAtMs - 10; row.drips = 0; row.dripAtMs = []; row.writes = 1; row.bytesQueued = row.firstBytes;
  }
  assert.throws(() => assemble(changed), /connect deadline/);
});
for (const role of ["application", "proxy", "upstream"]) for (const fault of ["Docker unhealthy", "HTTP 503", "both"]) check(`running ${role} with terminal ${fault} is not recovered`, () => {
  const changed = structuredClone(input), process = deployment.processes.find((p) => p.role === role);
  assert.ok(process, `real replay needs ${role}`);
  changed.settings.terminalHealthPaths = terminalHealthPaths(read("qualification.json"), read("edge-qualification.json"));
  // Hypothetical terminal metadata only, never saved or promoted as native evidence.
  // Start from otherwise healthy terminals so unavailable sibling receipts cannot mask a fault.
  for (const p of deployment.processes) {
    const body = "hypothetical terminal";
    changed.lifecycle[p.id].health = { path: changed.settings.terminalHealthPaths[p.role],
      response: { status: 200, complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body), ms: 1 } };
  }
  assert.equal(assemble(changed).recovery.disposition, "recovered");
  if (fault !== "HTTP 503") changed.lifecycle[process.id].after.State.Health = { Status: "unhealthy" };
  if (fault !== "Docker unhealthy") changed.lifecycle[process.id].health.response.status = 503;
  const capture = assemble(changed), outcome = targetOutcome(capture, { productionQualified: true }, { state: "observed" });
  assert.equal(capture.recovery.disposition, "not-recovered");
  assert.equal(outcome.classification, "target-capacity-failure"); assert.equal(outcome.numericComparisonQualified, false);
});
for (const role of ["proxy", "upstream"]) check(`late ${role} OOM is target-capacity-failure`, () => {
  const changed = structuredClone(input), process = deployment.processes.find((p) => p.role === role);
  assert.ok(process, `real replay needs ${role}`);
  const state = changed.lifecycle[process.id].after.State;
  Object.assign(state, { Running: false, OOMKilled: true, ExitCode: 137,
    FinishedAt: new Date(Date.parse(changed.raw.find((r) => r.type === "clock").wallAtStart) + 13400).toISOString() });
  const capture = assemble(changed), outcome = targetOutcome(capture, { productionQualified: true }, { state: "observed" });
  assert.equal(capture.recovery.disposition, "not-recovered");
  assert.equal(outcome.classification, "target-capacity-failure"); assert.equal(outcome.numericComparisonQualified, false);
});
check("during requests cannot complete at 13 s outside their 600 ms deadline", () => {
  const changed = structuredClone(input);
  for (const row of changed.raw.filter((r) => r.type === "legitimate" && r.window === "during")) {
    row.endedAtMs = 13000; row.latencyMs = row.endedAtMs - row.startedAtMs;
  }
  assert.throws(() => assemble(changed), /request deadline/);
});
verifyArtifacts(folder, read("manifest.json"));
console.log(`${total - tests.length}/${total} retained-evidence review regressions passed; historical qualification unchanged`);
if (tests.length) process.exitCode = 1;
