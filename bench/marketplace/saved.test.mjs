import assert from "node:assert/strict";
import test from "node:test";
import { summaryFixture, writeSavedFixture } from "./saved-fixture.mjs";
import { validateSummary } from "./report.mjs";
import { validateSaved } from "./validate.mjs";
import { evidenceVersion, sourceTree } from "./raw-contract.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { passPlan, stageAggregate, timedProfiles } from "./run-contract.mjs";

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const invalid = (fn) => assert.throws(fn, (e) => e.code === "MARKETPLACE_EVIDENCE_INVALID");
function temporary(t) {
  const folder = mkdtempSync(join(tmpdir(), "marketplace-raw-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test("reproduction: a summary-only native round passes the historical summary reader", () => {
  assert.equal(validateSummary(summaryFixture("a".repeat(40))).complete, true);
});

test("native saved validation rejects summary-only, historical and malformed proof as invalid", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  writeFileSync(join(folder, "summary.json"), JSON.stringify(summaryFixture(commit)));
  invalid(() => validateSaved(args));
  writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...summaryFixture(commit), evidenceVersion })); invalid(() => validateSaved(args));
  writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...summaryFixture(commit), evidenceVersion: "marketplace-raw/v1" })); invalid(() => validateSaved(args));
  writeFileSync(join(folder, "summary.json"), "{"); invalid(() => validateSaved(args));
  unlinkSync(join(folder, "summary.json")); invalid(() => validateSaved(args));
});

test("complete native fixture replays every raw profile, pass, phase, gate and cleanup", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const expected = writeSavedFixture(folder, commit, sourceTree(commit));
  assert.equal(JSON.parse(readFileSync(join(folder, "fixture/corten/check-container.json"))).memoryBytes, 2 * 2 ** 30, "native browser gate uses 2 GiB, not the app's 1 GiB");
  const hashes = () => Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => {
    const path = join(d.parentPath, d.name); return [path, createHash("sha256").update(readFileSync(path)).digest("hex")];
  }));
  const before = hashes();
  assert.deepEqual(validateSaved(args), expected);
  const command = spawnSync(process.execPath, ["bench/marketplace/validate.mjs", folder, "r17", commit], { encoding: "utf8", timeout: 30000 });
  assert.equal(command.status, 0, command.stderr); assert.match(command.stdout, /raw saved evidence valid/);
  assert.deepEqual(hashes(), before, "saved validation must not write evidence");
});

test("hostile saved edits fail replay, even when the summary remains internally plausible", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  writeSavedFixture(folder, commit, sourceTree(commit));
  const base = "fixture/corten/p1-en-US-page", api = "api/corten/p1-neutral-json";
  const change = (path, mutate) => {
    const full = join(folder, path), saved = readFileSync(full);
    try { const value = JSON.parse(saved); mutate(value); writeFileSync(full, JSON.stringify(value)); invalid(() => validateSaved(args)); }
    finally { writeFileSync(full, saved); }
  };
  for (const path of ["source.json", "images.json", "tools.json", "cleanup.json", "fixture.json", "fixture/corten/checks.json", "api/corten/qualification.json", `${base}/cold.log`, `${base}/fixed.json`, `${base}/fixed-clock.json`, `${base}/fixed-cpu.json`, `${base}/fixed-stats.log`, `${base}/fixed-stats.log.json`, `${base}/fixed-receipt.json`]) {
    const full = join(folder, path), saved = readFileSync(full);
    try { unlinkSync(full); invalid(() => validateSaved(args)); writeFileSync(full, saved); truncateSync(full, 1); invalid(() => validateSaved(args)); }
    finally { writeFileSync(full, saved); }
  }
  change(`${base}/fixed-cpu.json`, (v) => { v[Object.keys(v)[0]].usec++; });
  change(`${base}/fixed-stats.log.json`, (v) => { v.samples[Object.keys(v.samples)[0]][0].cpu++; });
  change(`${base}/fixed-stats.log.json`, (v) => { v.summary[Object.keys(v.summary)[0]].cpuAvgPct++; });
  change(`${base}/fixed-receipt.json`, (v) => { v.after[Object.keys(v.after)[0]]++; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.imageId = `sha256:${"c".repeat(64)}`; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.env.MARKETPLACE_SOURCE = "api"; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.cpuset = "4-7"; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.memoryBytes--; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.env.RATE = "1"; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.entrypoint = ["/bin/sh", "-c", "sleep 15"]; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.mounts.push({ type: "bind", source: "/different/load.js", destination: "/bench/marketplace/load.js", readOnly: true }); });
  change("fixture/corten/check-container.json", (v) => { v.mounts.find((m) => m.destination === "/repo").source = "/unrelated-checkout"; });
  change("fixture/corten/check-container.json", (v) => { v.mounts.find((m) => m.destination === "/results").source = "/unrelated-results"; });
  change("fixture/corten/check-container.json", (v) => { v.entrypoint = ["/bin/sh", "-c", "true"]; });
  change("fixture/corten/check-container.json", (v) => { v.memoryBytes = 2 ** 30; });
  change("fixture/corten/check-container.json", (v) => { v.mounts.push({ type: "bind", source: "/other/check.mjs", destination: "/repo/bench/marketplace/check.mjs", readOnly: true }); });
  change("tools.json", (v) => { v.k6.entrypoint = ["/bin/sh"]; });
  change(`${base}/fixed-clock.json`, (v) => { v.testRunDurationMs = 0.0015; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.state.FinishedAt = v.load.state.StartedAt; });
  change(`${base}/fixed-receipt.json`, (v) => { v.cpu.state.StartedAt = "2026-01-01T00:01:00Z"; });
  change(`${api}/fixed-receipt.json`, (v) => { v.upstreamReads.after.answers[503] = 1; });
  change(`${api}/fixed-receipt.json`, (v) => { v.upstreamReads.after = v.upstreamReads.before; });
  change("images.json", (v) => { v.corten.labels["run.corten.marketplace.commit"] = "c".repeat(40); });
  change("source.json", (v) => { v.tree = "c".repeat(40); });
  change("summary.json", (v) => { v.host.cpu = "edited host"; });
  change("summary.json", (v) => { v.options.build = "true"; });
  change("summary.json", (v) => { v.apps.corten.phases["fixture-en-US-page"].fixed.rps.median++; });
  change("summary.json", (v) => { v.apps.corten.runs["fixture-en-US-page"][0].phases.fixed.cpuUsec++; });
  change("summary.json", (v) => {
    const a = v.apps.corten, runs = a.runs["fixture-en-US-page"], p = runs[0].phases.fixed;
    p.cpuUsec *= 2; p.perCpuSecond = p.requests / (p.cpuUsec / 1e6); a.phases["fixture-en-US-page"].fixed = stageAggregate(runs, "fixed", 3);
    validateSummary(v); // Self-consistent edited summary still disagrees with retained counters.
  });
  change("summary.json", (v) => { delete v.apps.corten.runs["api-neutral-json"]; });
  change("fixture/corten/checks.json", (v) => { v.profiles.pop(); });
  change("api/corten/qualification.json", (v) => { v.probes.cap.belowHeld = 503; });
  change("fixture/corten/check-container.json", (v) => { v.state.FinishedAt = "2026-01-01T01:01:00Z"; });
  change("cleanup.json", (v) => { v.removed.pop(); });
  change("cleanup.json", (v) => { v.remaining.containers = "still-running"; });
  change(`${base}/cold.json`, (v) => { v.first200MsFromContainerStart++; });
  invalid(() => validateSaved({ ...args, round: "r18" })); invalid(() => validateSaved({ ...args, commit: "c".repeat(40) }));
  assert.equal(validateSaved(args).complete, true);
});

test("stopped profiles replay actual phase/sidecar/event evidence, never invented numeric passes", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const s = writeSavedFixture(folder, commit, sourceTree(commit));
  const a = s.apps.corten, runs = a.runs["api-neutral-json"], run = runs[2], base = "api/corten/p3-neutral-json";
  const volume = { kind: "volume", id: "e".repeat(64), name: "e".repeat(64) };
  // Synthetic image-declared anonymous volume: every snapshot and cleanup must retain it.
  for (const file of ["cold-container.json", ...["warmup", "fixed", "sat64", "sat256"].map((p) => `${p}-receipt.json`)]) {
    const path = join(folder, base, file), v = JSON.parse(readFileSync(path, "utf8"));
    (v.app ?? v).mounts.push({ type: "volume", name: volume.name, source: "/synthetic/volume", destination: "/data", readOnly: false });
    writeFileSync(path, JSON.stringify(v));
  }
  const cleanupPath = join(folder, "cleanup.json"), cleanup = JSON.parse(readFileSync(cleanupPath, "utf8"));
  cleanup.created.push(volume); cleanup.removed.push(volume); writeFileSync(cleanupPath, JSON.stringify(cleanup));
  const path = join(folder, base, "sat64-receipt.json"), raw = JSON.parse(readFileSync(path, "utf8"));
  raw.app.state = { ...raw.app.state, Running: false, OOMKilled: true, ExitCode: 137, FinishedAt: new Date(Date.parse(raw.seen.phaseStart) + 5000).toISOString() };
  raw.seen.app = raw.app.state; raw.after = {};
  raw.seen.sidecars = [raw.cpu, raw.upstream].map((c) => ({ name: c.name, startedAt: c.state.StartedAt, state: c.state }));
  raw.seen.events = [{ action: "oom", ms: Date.parse(raw.app.state.FinishedAt) }];
  run.complete = false; run.stopped = { pass: 3, phase: "sat64", exitCode: 137, oomKilled: true };
  delete run.phases.sat64; delete run.phases.sat256;
  for (const p of ["fixed", "sat64", "sat256"]) a.phases["api-neutral-json"][p] = stageAggregate(runs, p, 3);
  writeFileSync(path, JSON.stringify(raw)); writeFileSync(join(folder, base, "sat64-cpu.json"), "{}");
  writeFileSync(join(folder, "summary.json"), JSON.stringify(s));
  assert.equal(validateSaved(args).complete, true);
  const original = readFileSync(path);
  for (const mutate of [
    (v) => { v.load.state.OOMKilled = true; v.load.state.ExitCode = 137; },
    (v) => { v.load.state.ExitCode = 1; },
    (v) => { v.load.state.Running = true; },
    (v) => { v.load.state.StartedAt = "2025-01-01T00:00:00.000Z"; v.load.state.FinishedAt = "2025-01-01T00:00:00.001Z"; },
    (v) => { v.app.state.FinishedAt = new Date(Date.parse(v.seen.phaseStart) + 1).toISOString(); v.seen.app = v.app.state; v.seen.events[0].ms = Date.parse(v.app.state.FinishedAt); },
  ]) {
    const v = JSON.parse(original); mutate(v); writeFileSync(path, JSON.stringify(v)); invalid(() => validateSaved(args));
    writeFileSync(path, original);
  }
  cleanup.removed.pop(); writeFileSync(cleanupPath, JSON.stringify(cleanup)); invalid(() => validateSaved(args));
  cleanup.removed.push(volume); writeFileSync(cleanupPath, JSON.stringify(cleanup));
  raw.upstreamReads.after.answers[503] = 1; writeFileSync(path, JSON.stringify(raw)); invalid(() => validateSaved(args));
  delete raw.upstreamReads.after.answers[503]; raw.seen.events = [{ action: "kill", ms: Date.parse(raw.app.state.FinishedAt) }];
  writeFileSync(path, JSON.stringify(raw)); invalid(() => validateSaved(args));
});

test("source lookup ignores inherited Git redirects/config and never admits an absent local object", () => {
  const expected = sourceTree(commit);
  const edits = { GIT_DIR: "does-not-exist", GIT_WORK_TREE: "does-not-exist", GIT_REPLACE_REF_BASE: "refs/hostile/", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" };
  const before = Object.fromEntries(Object.keys(edits).map((k) => [k, process.env[k]]));
  try { Object.assign(process.env, edits); assert.equal(sourceTree(commit), expected); assert.throws(() => sourceTree("f".repeat(40))); }
  finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test("native run windows follow the serial rotated pass plan and cannot overlap", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const s = writeSavedFixture(folder, commit, sourceTree(commit));
  const plan = [...passPlan(s.options.passes, s.options.apps, timedProfiles, () => [])];
  const runs = plan.map(({ app, profile, pass }) => s.apps[app].runs[profile.key].find((r) => r.pass === pass));
  assert.equal(new Set(runs.map((r) => r.startedAt)).size, runs.length, "fixture must model distinct serial runs");
  for (let i = 1; i < runs.length; i++) assert.ok(Date.parse(runs[i].startedAt) >= Date.parse(runs[i - 1].finishedAt));
  runs[1].startedAt = runs[0].startedAt;
  writeFileSync(join(folder, "summary.json"), JSON.stringify(s)); invalid(() => validateSaved(args));
});

test("coherent summary aggregates cannot hide a k6 count/rate/elapsed contradiction", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const s = writeSavedFixture(folder, commit, sourceTree(commit));
  const path = join(folder, "fixture/corten/p1-en-US-page/fixed.json"), raw = JSON.parse(readFileSync(path));
  raw.metrics.http_reqs.rate = 1e9; writeFileSync(path, JSON.stringify(raw));
  const a = s.apps.corten, runs = a.runs["fixture-en-US-page"];
  runs[0].phases.fixed.rps = 1e9; a.phases["fixture-en-US-page"].fixed = stageAggregate(runs, "fixed", 3);
  validateSummary(s); writeFileSync(join(folder, "summary.json"), JSON.stringify(s)); invalid(() => validateSaved(args));
});

test("safe entry rejects UNC, links, hardlinks, oversized files and deep trees", (t) => {
  for (const folder of ["\\\\server\\share", "//server/share", "\\\\?\\C:\\proof", "https://example.com/proof", "C:\\proof:stream"]) invalid(() => validateSaved({ folder, round: "r17", commit }));
  const root = temporary(t), folder = join(root, "evidence"); mkdirSync(folder);
  const outside = join(root, "outside.json"); writeFileSync(outside, "{}");
  linkSync(outside, join(folder, "summary.json")); invalid(() => validateSaved({ folder, round: "r17", commit })); unlinkSync(join(folder, "summary.json"));
  // Junction creation works without Windows symlink privilege.
  symlinkSync(folder, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  invalid(() => validateSaved({ folder: join(root, "linked"), round: "r17", commit }));
  symlinkSync(root, join(folder, "escape"), process.platform === "win32" ? "junction" : "dir");
  invalid(() => validateSaved({ folder, round: "r17", commit })); unlinkSync(join(folder, "escape"));
  writeFileSync(join(folder, "summary.json"), "{}"); truncateSync(join(folder, "summary.json"), 32 * 2 ** 20 + 1);
  invalid(() => validateSaved({ folder, round: "r17", commit }));
  const deep = join(folder, ...Array(10).fill("deep")); mkdirSync(deep, { recursive: true }); invalid(() => validateSaved({ folder, round: "r17", commit }));
});
