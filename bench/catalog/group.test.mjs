import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { allApps } from "../fullstack/apps.mjs";
import { contractSha256, definition, registrySchema, selectedApps } from "../workloads/registry.mjs";
import { aggregate, parseArgs, phases, sources, targets } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { groupDescriptor, groupResultSchema, qualificationIdentity, timingPlan } from "./group.mjs";
import { inspectCatalog, renderCatalog } from "./report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const inventory = Object.fromEntries(Object.entries(allApps).filter(([, app]) => app.pages !== false));
const names = ["corten", "aspnet", "express", "fastapi", "axum-maud", "drogon", "gin"];
const imageId = `sha256:${"b".repeat(64)}`;

// Synthetic evidence for validator tests, not measurements or qualification claims.
function result() {
  const group = groupDescriptor("catalog-page");
  const options = parseArgs(["c1", "--group", "catalog-page"], inventory);
  const phase = { requests: 6000, rps: 100, p50: 1, p95: 2, p99: 3, failed: 0, dropped: 0,
    perCpuSecond: 110, cpuUsec: 55000000, cpuAvgPct: 99, memMaxMiB: 8, upstream: { cpuAvgPct: 50, highCpu: false } };
  const check = { jsonRecords: 500, pages: 120, profiles: [false, true].flatMap((javaScriptEnabled) =>
    ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].map((profile) => ({ profile, javaScriptEnabled, forms: true, related: true, styles: true }))),
  upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } };
  const summary = { schema: groupResultSchema, group, options, workload: "catalog-v1", round: "c1", commit: "a".repeat(40),
    dirty: false, commitAfter: "a".repeat(40), dirtyAfter: false, complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    startedAt: "2026-11-07T16:00:00Z", finishedAt: "2026-11-07T22:00:00Z",
    fixtureSha256: createHash("sha256").update(`${JSON.stringify(records())}\n`).digest("hex"),
    measurement: { encoding: "identity", fixedRate: 150, cpus: { app: { quota: 1, cpuset: "0" }, load: { quota: 4, cpuset: "4-7" }, api: { quota: 2, cpuset: "2-3" } } },
    apps: Object.fromEntries(names.map((app) => [app, { imageId, checks: Object.fromEntries(sources.map((source) =>
      [source, { ...structuredClone(check), qualification: qualificationIdentity(group, app, source, imageId) }])), runs: {} }])) };
  for (const { app, pass, ...profile } of timingPlan(options, sources, targets)) {
    const key = `${profile.source}-${profile.target}`;
    (summary.apps[app].runs[key] ??= []).push({ pass, evidence: { app, ...profile, imageId }, complete: true,
      cold: { path: "/catalog/record_1", first200At: "2026-11-07T16:00:00.200Z", containerStartedAt: "2026-11-07T16:00:00.000Z",
        first200MsFromContainerStart: 200, measuredBeforeReadinessOrWarmup: true, attempts: 2, bytes: 1000, successfulRequestMs: 2 },
      warmup: structuredClone(phase), phases: Object.fromEntries(phases.map((p) => [p, structuredClone(phase)])) });
  }
  for (const entry of Object.values(summary.apps)) entry.phases = Object.fromEntries(Object.entries(entry.runs).map(([key, runs]) =>
    [key, Object.fromEntries(phases.map((phase) => [phase, { ...aggregate(runs.map((r) => r.phases[phase])), asked: options.passes }]))]));
  return summary;
}

test("explicit catalog-page selection is exactly the approved registry seven, not a default or subset", () => {
  const descriptor = groupDescriptor("catalog-page");
  assert.deepEqual(descriptor.apps, names);
  assert.deepEqual(descriptor.apps, selectedApps("catalog-page"));
  assert.deepEqual(descriptor.cases, definition("catalog-page").cases);
  assert.equal(descriptor.registrySchema, registrySchema);
  assert.equal(descriptor.contractSha256, contractSha256("catalog-page"));
  assert.deepEqual(descriptor.targets, ["page"]);
  assert.deepEqual(descriptor.sources, sources);
  assert.deepEqual(descriptor.correctnessTargets, ["page", "json"]);
  assert.deepEqual(parseArgs(["c1", "--group", "catalog-page"], inventory).apps, names);
  assert.equal(parseArgs(["c1"], inventory).group, undefined);
  assert.equal(parseArgs(["c1"], inventory).apps.length, 20);
  assert.deepEqual(parseArgs(["c1", "--apps", "gin"], inventory).apps, ["gin"]);
  descriptor.apps.pop();
  assert.deepEqual(groupDescriptor("catalog-page").apps, names, "caller mutation cannot change selection");
});

test("group CLI rejects other/missing/duplicate groups, overrides and incomplete native inventories", () => {
  for (const args of [
    ["--group"], ["--group", "json-api"], ["--group", "catalog-page", "--group", "catalog-page"],
    ["--group", "catalog-page", "--apps", "corten"], ["--apps", "corten", "--group", "catalog-page"],
  ]) assert.throws(() => parseArgs(["c1", ...args], inventory), args.join(" "));
  const incomplete = { ...inventory }; delete incomplete.fastapi;
  assert.throws(() => parseArgs(["c1", "--group", "catalog-page"], incomplete), /requires every registry app/);
});

test("the consumed timing plan covers both sources and every pass, with no JSON cold/warmup/load timing", () => {
  const options = parseArgs(["c1", "--group", "catalog-page"], inventory);
  const plan = timingPlan(options, sources, targets);
  assert.equal(plan.length, 7 * 2 * 3);
  assert.equal(new Set(plan.map((p) => `${p.app}:${p.key}:${p.pass}`)).size, 42);
  for (const app of names) for (const source of sources) for (const pass of [1, 2, 3]) {
    assert.deepEqual(plan.filter((p) => p.app === app && p.source === source && p.pass === pass),
      [{ app, pass, ...definition("catalog-page").cases.find((c) => c.source === source) }]);
  }
  assert.ok(plan.every((p) => p.target === "page" && p.payload === "catalog-v1" && p.locale === null));
  assert.throws(() => timingPlan({ ...options, apps: ["corten"] }, sources, targets), /exact registry apps/);
  const legacy = timingPlan(parseArgs(["c1", "--apps", "corten", "--passes", "1"], inventory), sources, targets);
  assert.deepEqual(legacy, sources.flatMap((source) => targets.map((target) => ({ app: "corten", pass: 1, source, target }))));
  const runner = readFileSync(join(here, "run.mjs"), "utf8");
  assert.match(runner, /const plan = timingPlan\(options, sources, targets\)/);
  assert.match(runner, /for \(const \{ app, pass, source, target, \.\.\.profile \} of plan\)/);
  assert.match(runner, /coldStart\(name, source, target,/);
  assert.match(runner, /load\(name, target, "warmup",/);
  assert.match(runner, /load\(name, target, phase,/);
  assert.ok(runner.includes("`TARGET=${target}`"), "k6 receives the plan's target");
});

test("complete group evidence reports only seven apps and page columns, disclosing stronger native gates", () => {
  const report = inspectCatalog(result(), "a".repeat(40));
  assert.equal(report.baseline, true);
  assert.deepEqual(Object.keys(report.apps), names);
  assert.deepEqual(Object.keys(report.apps.corten), ["fixture-page", "api-page"]);
  const markdown = renderCatalog(report);
  assert.match(markdown, /catalog-page/);
  assert.ok(markdown.includes(contractSha256("catalog-page")));
  assert.match(markdown, /page AND JSON; JSON is not timed/);
  assert.ok(markdown.includes(`After-run commit: \`${"a".repeat(40)}\`; tree dirty after run: false.`));
  assert.match(markdown, /Memory page req\/s \| HTTP page req\/s/);
  assert.doesNotMatch(markdown, /Memory JSON req\/s|HTTP JSON req\/s/);
});

test("a group requires clean unchanged after-run HEAD/tree provenance", () => {
  for (const change of [
    (s) => { delete s.commitAfter; }, (s) => { delete s.dirtyAfter; },
    (s) => { s.commitAfter = "c".repeat(40); }, (s) => { s.dirtyAfter = true; },
    (s) => { s.commitAfter = "not a commit"; }, (s) => { s.dirtyAfter = "false"; },
  ]) {
    const s = result(); change(s);
    assert.equal(inspectCatalog(s).baseline, false);
  }
});

test("cold evidence cannot exceed the runner startup timeout", () => {
  for (const timeout of [undefined, 0, -1, "120", NaN]) {
    const s = result(); s.options.startupTimeout = timeout;
    assert.equal(inspectCatalog(s).baseline, false);
  }
  const s = result();
  const cold = s.apps.corten.runs["fixture-page"][0].cold;
  cold.first200MsFromContainerStart = s.options.startupTimeout * 1000 + 1;
  cold.first200At = new Date(Date.parse(cold.containerStartedAt) + cold.first200MsFromContainerStart).toISOString();
  assert.equal(inspectCatalog(s).baseline, false);
});

test("runner captures after-run provenance after cleanup and makes provenance failures unsuccessful", () => {
  const runner = readFileSync(join(here, "run.mjs"), "utf8");
  const capture = runner.indexOf('summary.commitAfter = await command("git", ["rev-parse", "HEAD"], { cleanup: true })');
  assert.ok(capture > runner.indexOf('await docker(["network", "rm", info.Id]'), "capture follows owned resource cleanup");
  assert.ok(runner.includes('summary.dirtyAfter = (await command("git", ["status", "--porcelain"], { cleanup: true })).length > 0'));
  assert.match(runner.slice(capture), /assert\.equal\(summary\.commitAfter, summary\.commit,/);
  assert.match(runner.slice(capture), /assert\.equal\(summary\.dirtyAfter, false,/);
  assert.match(runner.slice(capture), /catch \(e\) \{ summary\.complete = false; fail\(null, null, "tree provenance", e\); \}/);
});

test("group aggregates must exactly rederive from every saved phase and requested pass count", () => {
  for (const change of [
    (s) => { delete s.apps.corten.phases; },
    (s) => { delete s.apps.corten.phases["fixture-page"]; },
    (s) => { delete s.apps.corten.phases["fixture-page"].fixed; },
    (s) => { delete s.apps.corten.phases["fixture-page"].fixed.perCpuSecond; },
    (s) => { s.apps.corten.phases["fixture-page"].fixed.perCpuSecond.median *= 2; },
    (s) => { s.apps.corten.phases["fixture-page"].fixed.rps.min = 1; },
    (s) => { s.apps.corten.phases["fixture-page"].sat64.cpuUsec.max = 1; },
    (s) => { s.apps.gin.phases["api-page"].sat256.memMaxMiB.median = 999; },
    (s) => { s.apps.corten.phases["fixture-page"].fixed.asked = 1; },
    (s) => { s.apps.corten.phases["fixture-page"].fixed.passes = 1; },
    (s) => { s.apps.corten.phases["fixture-page"].fixed.extra = 1; },
    (s) => { s.apps.corten.runs["fixture-page"][0].phases.fixed.perCpuSecond *= 2; },
  ]) {
    const s = result(); change(s);
    assert.equal(inspectCatalog(s).baseline, false);
  }
  for (const change of [
    (s) => { s.apps.corten.phases["fixture-page"].warmup = {}; },
    (s) => { s.apps.corten.phases["fixture-json"] = {}; },
    (s) => { s.apps.corten.phases["other-page"] = {}; },
  ]) { const s = result(); change(s); assert.throws(() => inspectCatalog(s)); }
});

test("group rejects schema downgrades, changed contracts, duplicate/wrong selection and extra app evidence", () => {
  for (const change of [
    (s) => { delete s.schema; }, (s) => { delete s.group; }, (s) => { delete s.options.group; },
    (s) => { s.schema = "catalog-group-results/v2"; }, (s) => { s.group.contractSha256 = "0".repeat(64); },
    (s) => { s.group.cases[0].payload = "marketplace-v2"; }, (s) => { s.group.targets.push("json"); },
    (s) => { s.group.sources = ["fixture", "fixture"]; }, (s) => { s.options.apps[1] = "corten"; },
    (s) => { s.options.apps.pop(); }, (s) => { s.apps.nextjs = s.apps.corten; },
  ]) { const s = result(); change(s); assert.throws(() => inspectCatalog(s)); }
});

test("wrong app/source/target/payload/image and duplicate pass/profile evidence cannot certify a group", () => {
  for (const change of [
    (s) => { s.apps.corten.checks.other = s.apps.corten.checks.api; },
    (s) => { s.apps.corten.checks.api = structuredClone(s.apps.corten.checks.fixture); },
    (s) => { s.apps.corten.checks.fixture.qualification.app = "gin"; },
    (s) => { s.apps.corten.checks.api.qualification.targets = ["page", "page"]; },
    (s) => { s.apps.corten.runs["fixture-json"] = s.apps.corten.runs["fixture-page"]; },
    (s) => { s.apps.corten.runs["other-page"] = []; },
    (s) => { s.apps.corten.runs["fixture-page"][1].pass = 1; },
    (s) => { s.apps.corten.runs["fixture-page"][0].evidence.app = "gin"; },
    (s) => { s.apps.corten.runs["fixture-page"][0].evidence.source = "api"; },
    (s) => { s.apps.corten.runs["fixture-page"][0].evidence.target = "json"; },
    (s) => { s.apps.corten.runs["fixture-page"][0].evidence.payload = "marketplace-v2"; },
    (s) => { s.apps.corten.runs["fixture-page"][0].evidence.imageId = `sha256:${"c".repeat(64)}`; },
    (s) => { delete s.apps.corten.imageId; },
    (s) => { s.apps.corten.runs["fixture-page"][0].cold.path = "/api/catalog/record_1"; },
    (s) => { s.apps.corten.phases = { "fixture-json": {} }; },
  ]) { const s = result(); change(s); assert.throws(() => inspectCatalog(s)); }
  const s = result();
  s.apps.corten.checks.fixture.profiles[1] = s.apps.corten.checks.fixture.profiles[0];
  assert.equal(inspectCatalog(s).baseline, false);
});

test("missing evidence and unsuccessful non-sat64 phases stay incomplete despite aggregate success flags", () => {
  for (const change of [
    (s) => { delete s.apps.gin; },
    (s) => { delete s.apps.corten.checks.api; }, (s) => { delete s.apps.corten.checks.api.qualification; },
    (s) => { s.apps.corten.checks.api.upstream.uncachedJson = false; },
    (s) => { delete s.apps.corten.runs["api-page"]; }, (s) => { s.apps.corten.runs["api-page"].pop(); },
    (s) => { delete s.apps.corten.runs["fixture-page"][0].evidence; },
    (s) => { delete s.apps.corten.runs["fixture-page"][0].cold; },
    (s) => { s.apps.corten.runs["fixture-page"][0].cold.first200MsFromContainerStart = -1; },
    (s) => { delete s.apps.corten.runs["fixture-page"][0].warmup; },
    (s) => { delete s.apps.corten.runs["fixture-page"][0].phases.fixed; },
    (s) => { s.apps.corten.runs["fixture-page"][0].phases.sat256.failed = 1; },
    (s) => { s.apps.corten.runs["fixture-page"][0].phases.fixed.cpuUsec = 0; },
    (s) => { s.options.checkOnly = true; }, (s) => { s.dirty = true; },
  ]) {
    const s = result(); change(s);
    assert.equal(inspectCatalog(s).baseline, false);
  }
});

test("strict report CLI accepts complete group evidence and rejects missing evidence without Docker", () => {
  const folder = mkdtempSync(join(tmpdir(), "catalog-group-report-"));
  const file = join(folder, "summary.json");
  const run = () => spawnSync(process.execPath, [join(here, "report.mjs"), file, "--require-complete", "--commit", "a".repeat(40)],
    { encoding: "utf8", windowsHide: true, timeout: 10000 });
  try {
    writeFileSync(file, JSON.stringify(result()));
    const complete = run(); assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /\*\*COMPLETE\*\*/);
    for (const change of [
      (s) => { delete s.apps.gin.runs["api-page"]; }, (s) => { s.dirtyAfter = true; },
      (s) => { s.commitAfter = "c".repeat(40); },
      (s) => { s.apps.corten.phases["fixture-page"].fixed.perCpuSecond.median = 999; },
    ]) {
      const s = result(); change(s);
      writeFileSync(file, JSON.stringify(s));
      const partial = run(); assert.equal(partial.status, 1, partial.stderr);
      assert.match(partial.stdout, /FAILED OR INCOMPLETE/);
    }
  } finally {
    assert.equal(dirname(folder), join(tmpdir(), "."), "cleanup remains in the task temp directory");
    rmSync(folder, { recursive: true, force: true });
  }
});
