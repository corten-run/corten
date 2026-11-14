import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { budgets, matrix, parseArgs, registryDigest } from "../../../hardening/plan.mjs";
import { selectedApps } from "../../registry.mjs";

// Composition/apparatus fixtures only. Native socket/semantic replay is mocked,
// not replaced in production and not claimed as benchmark qualification.
const root = mkdtempSync(join(tmpdir(), "hardening-adapter-")), commit = "a".repeat(40), subject = "b".repeat(64);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const apps = selectedApps("hardening"), budget = budgets();
const options = parseArgs(["w17", "--build", "--review", subject]);
const files = ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "bench/hardening/run.mjs", "bench/hardening/verify.mjs",
  ...apps.map((a) => a === "corten" ? "bench/marketplace/corten/Dockerfile" : `bench/fullstack/apps/${a}/Dockerfile`)]
  .map((path) => ({ path, sha256: hash(path) }));
const originalBinding = { request: { group: "hardening", round: "w17", commit, recipe: "native-defaults" }, subjectSha256: subject,
  selection: { group: "hardening", apps, contractSha256: registryDigest }, sources: { commit, files },
  execution: { invocation: { executable: "node", argv: ["bench/hardening/run.mjs", "w17", "--build", "--review", subject], cwd: "repository-root", shell: false },
    effectiveOptions: options, settings: budget }, resources: { budget: budget.resources }, review: { state: "unknown" } };
const summaryBase = { schema: "native-hardening-run/v1", registryDigest, commit, options, budget, semanticReceiptsVersion: 2, lifecycleVersion: 4,
  nativeControlsVersion: 1, deploymentQualificationVersion: 1, complete: true, groupReady: true, failures: [], cleanupFailures: [],
  finishedAt: "2026-11-13T12:00:00Z", tools: Object.fromEntries(["node", "checker", "edge", "cert"].map((k) => [k, { Id: `sha256:${hash(k)}` }])),
  cells: matrix().map((c) => ({ ...c, status: "observed", nativeAssessment: { productionQualified: true },
    ...(c.mode === "deployed-edge" ? { edgeAssessment: { productionQualified: true } } : {}), targetOutcome: { classification: "service-preserved" } })) };
const write = (p, v) => { const path = join(root, p); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v)); };
write("summary.json", summaryBase);
for (const c of summaryBase.cells) {
  const roles = ["application", "upstream", ...(c.mode === "deployed-edge" ? ["proxy"] : [])];
  const processes = roles.map((role) => ({ id: role, role, count: 2, containerId: hash(c.key + role) }));
  write(`${c.key}/settings.json`, { case: c.mode, phase: c.phase, nativeSource: c.source, review: subject, effectiveBudgets: JSON.stringify(budget),
    deployment: { mode: c.mode, countAllProcesses: true, processes: processes.map(({ containerId, ...p }) => p) } });
  write(`${c.key}/deployment.json`, { processes, network: { Containers: Object.fromEntries(processes.map((p) => [p.containerId, {}])) }, totalBudget: budget.resources });
  for (const p of processes) {
    const b = budget.resources[p.role === "application" ? c.mode === "direct" ? "applicationDirect" : "applicationEdge" : p.role];
    const src = files.filter((f) => c.app === "corten" ? f.path.startsWith("bench/marketplace/corten/") || ["Cargo.toml", "Cargo.lock"].includes(f.path)
      : f.path.startsWith(`bench/fullstack/apps/${c.app}/`)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const info = { Id: p.containerId, Image: p.role === "application" ? `sha256:${hash(c.app)}` : summaryBase.tools[p.role === "upstream" ? "node" : "edge"].Id,
      HostConfig: { NanoCpus: b.cpu * 1e9, Memory: b.memory, MemorySwap: b.memory }, Config: { Labels: {
        "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false", "run.corten.hardening.source": hash(JSON.stringify(src.map((f) => [f.path, f.sha256]))) } } };
    write(`${c.key}/${p.id}-before.json`, { info, top: "PID PPID COMMAND\n1 0 native\n2 1 worker\n" });
    write(`${c.key}/${p.id}-lifecycle.json`, { before: info, after: structuredClone(info) });
  }
  write(`${c.key}/cleanup.json`, { complete: true, containers: [], volumes: [], commandClients: 0, failures: [] });
}
let binding, summary, action, proof;
const modified = new Map();
const change = (p, fn) => {
  if (!modified.has(p)) modified.set(p, readFileSync(join(root, p)));
  const v = JSON.parse(readFileSync(join(root, p))); fn(v); write(p, v);
};
const native = mock.fn((folder) => {
  assert.equal(folder, root); action?.();
  return { schema: summary.schema, observed: summary.cells.filter((c) => c.status === "observed").length,
    groupReady: summary.groupReady, notRun: summary.cells.filter((c) => c.status === "not-run").length, proof };
});
mock.module(new URL("../../../hardening/verify.mjs", import.meta.url), { exports: { verify: native } });
const { inspectSaved } = await import("./hardening.mjs");
beforeEach(() => {
  for (const [p, b] of modified) writeFileSync(join(root, p), b); modified.clear();
  binding = structuredClone(originalBinding); summary = structuredClone(summaryBase); action = null; native.mock.resetCalls(); write("summary.json", summary);
  proof = { schema: "native-hardening-saved-proof/v1", resources: "verified", sources: "verified", sourceFiles: structuredClone(files), cleanupComplete: true, blockers: [] };
});
after(() => { mock.restoreAll(); rmSync(root, { recursive: true, force: true }); });
const inspect = () => { write("summary.json", summary); return inspectSaved(binding, root); };

test("complete native composition has an intrinsic verified path without review approval", async () => {
  assert.deepEqual(await inspect(), { status: "verified", attemptComplete: true, cleanupComplete: true, resources: "verified",
    outcomes: apps.map((app) => ({ app, outcome: "passed" })), blockers: [] });
  assert.equal(native.mock.callCount(), 1);
});

test("deployment default OOM representation changes do not discard complete target failures", async () => {
  const cell = summary.cells[0]; cell.targetOutcome.classification = "target-capacity-failure";
  summary.groupReady = false;
  change(`${cell.key}/application-before.json`, (v) => v.info.HostConfig.OomKillDisable = false);
  change(`${cell.key}/application-lifecycle.json`, (v) => {
    v.before.HostConfig.OomKillDisable = false; v.after.HostConfig.OomKillDisable = null;
  });
  const result = await inspect();
  assert.equal(result.status, "failed"); assert.equal(result.attemptComplete, true);
  assert.equal(result.resources, "verified"); assert.equal(result.cleanupComplete, true);
  assert.deepEqual(result.outcomes[0], { app: cell.app, outcome: "failed" });
});

for (const [name, mutate] of [
  ["group", (b) => b.request.group = "mixed-production"], ["round", (b) => b.request.round = "w18"],
  ["commit", (b) => b.request.commit = "c".repeat(40)], ["selected apps", (b) => b.selection.apps.pop()],
  ["filter", (b) => b.execution.effectiveOptions.verify.app = "express"], ["settings", (b) => b.execution.settings.resources.upstream.cpu++],
  ["command", (b) => b.execution.invocation.argv.push("--verify-app", "express")],
]) test(`rejects binding ${name} drift`, async () => { mutate(binding); assert.equal((await inspect()).status, "invalid"); assert.equal(native.mock.callCount(), 0); });

for (const [name, mutate] of [
  ["round", (s) => s.options.round = "w18"], ["commit", (s) => s.commit = "c".repeat(40)],
  ["dropped matrix", (s) => s.cells.pop()], ["source relabel", (s) => s.cells[0].source = "api"],
  ["edge relabel", (s) => s.cells[0].mode = "deployed-edge"], ["budget", (s) => s.budget.resources.upstream.cpu++],
]) test(`rejects saved ${name} drift`, async () => { mutate(summary); assert.equal((await inspect()).status, "invalid"); });

for (const field of ["semanticReceiptsVersion", "lifecycleVersion"]) test(`old ${field} is blocked`, async () => {
  summary[field]--; const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false); assert.equal(native.mock.callCount(), 0);
});

test("budget intent cannot override actual target CPU or undeclared processes", async () => {
  change(`${summary.cells[0].key}/application-before.json`, (v) => v.info.HostConfig.NanoCpus++);
  const r = await inspect(); assert.equal(r.status, "invalid"); assert.equal(r.resources, "invalid");
});
test("an uncharged edge process is invalid", async () => {
  const c = summary.cells.find((c) => c.mode === "deployed-edge");
  change(`${c.key}/deployment.json`, (d) => d.processes.pop()); assert.equal((await inspect()).status, "invalid");
});
test("native process path escapes are rejected before following native filenames", async () => {
  change(`${summary.cells[0].key}/deployment.json`, (d) => d.processes[0].id = "../../outside");
  assert.equal((await inspect()).status, "invalid"); assert.equal(native.mock.callCount(), 0);
});
test("source labels must bind exact source and dependency hashes", async () => {
  binding.sources.files.find((f) => f.path === "Cargo.lock").sha256 = "d".repeat(64);
  assert.equal((await inspect()).status, "invalid");
});
test("missing cleanup proof is blocked, not a target failure", async () => {
  const p = `${summary.cells[0].key}/cleanup.json`, b = readFileSync(join(root, p));
  rmSync(join(root, p)); try { assert.equal((await inspect()).status, "blocked"); } finally { writeFileSync(join(root, p), b); }
});
test("native target failure remains failed and retains all frameworks", async () => {
  summary.cells[0].targetOutcome.classification = "target-capacity-failure";
  const r = await inspect(); assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true);
  assert.deepEqual(r.outcomes[0], { app: "corten", outcome: "failed" }); assert.equal(r.outcomes.length, apps.length);
});

for (const ack of ["creation", "removal", "absence", "start", "build", "resource-removal", "final-inventory"]) test(`missing ${ack} proof blocks qualification without erasing target capacity outcomes`, async () => {
  summary.cells[0].targetOutcome.classification = "target-capacity-failure";
  proof.resources = ["resource-removal", "final-inventory"].includes(ack) ? "verified" : "blocked";
  proof.sources = ack === "build" ? "blocked" : "verified";
  proof.cleanupComplete = ack === "build"; proof.blockers.push(ack === "build" ? "saved-source-proof-missing" : "saved-execution-proof-missing");
  const result = await inspect();
  assert.equal(result.status, "blocked"); assert.equal(result.resources, proof.resources); assert.equal(result.cleanupComplete, proof.cleanupComplete);
  assert.deepEqual(result.outcomes[0], { app: "corten", outcome: "failed" });
  assert.deepEqual(result.outcomes.map((row) => row.app), apps);
});
test("a retained harness failure blocks even when a target failed", async () => {
  summary.cells[0].targetOutcome.classification = "target-capacity-failure"; summary.failures.push({ stage: "apparatus" });
  const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.outcomes[0].outcome, "failed");
});
test("missing defense is an unsupported target, not a review gate", async () => {
  summary.cells[0].nativeAssessment.productionQualified = false;
  const r = await inspect(); assert.equal(r.status, "verified"); assert.equal(r.outcomes[0].outcome, "unsupported");
});
test("a not-run cell blocks full completion", async () => {
  summary.cells[0].status = "not-run"; summary.complete = false; summary.groupReady = false;
  const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false); assert.equal(r.outcomes[0].outcome, "not-run");
});

test("historical native replay lacks positive apparatus and finalizer proof", async () => {
  proof = undefined; const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.resources, "blocked"); assert.equal(r.cleanupComplete, false);
});
test("native input replay must bind the complete requested source closure", async () => {
  proof.sourceFiles.find((f) => f.path === "package-lock.json").sha256 = "f".repeat(64);
  assert.equal((await inspect()).status, "invalid");
});
test("missing apparatus or parity is blocked, not a framework failure", async () => {
  summary.cells[0].status = "invalid"; summary.cells[0].failureKind = "parity-blocked"; summary.groupReady = false;
  proof.resources = "blocked"; proof.blockers.push("native-matrix-apparatus-incomplete");
  const r = await inspect(); assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false); assert.equal(r.outcomes[0].outcome, "not-run");
});
test("replay mutation is invalid and native diagnostics are not exposed", async () => {
  action = () => change(`${summary.cells[0].key}/cleanup.json`, (v) => v.complete = false);
  const r = await inspect(); assert.equal(r.status, "invalid"); assert.ok(r.blockers.includes("hardening-saved-tree-changed"));
});
test("native assertion errors never expose saved payloads", async () => {
  action = () => { throw new Error("SENSITIVE-TEST-PAYLOAD"); };
  const r = await inspect(); assert.equal(r.status, "invalid"); assert.ok(!JSON.stringify(r).includes("SENSITIVE"));
});
test("unreferenced hardlinks are rejected before native replay", async () => {
  const path = join(root, "unreferenced.json"); linkSync(join(root, "summary.json"), path);
  try { assert.equal((await inspectSaved(binding, root)).status, "invalid"); assert.equal(native.mock.callCount(), 0); } finally { rmSync(path); }
});
