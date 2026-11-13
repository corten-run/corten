import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { allApps } from "../fullstack/apps.mjs";
import { aggregate, cpuSettings, expectedPageChecks, parseArgs, phases, readLoad, sources, targets } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { groupDescriptor, groupResultSchema, qualificationIdentity, timingPlan } from "./group.mjs";
import { inspectCatalog } from "./report.mjs";
import { rawSchema, replayCatalog, containerEvidence } from "./raw.mjs";
import { summarizeSamples } from "./stats.mjs";
import { validateSaved } from "./verify.mjs";

// Synthetic verifier fixtures, never measured performance or qualification receipts.
function fixture() {
  const files = new Map();
  const put = (key, value) => files.set(key, typeof value === "string" ? value : JSON.stringify(value));
  const group = groupDescriptor("catalog-page");
  const options = parseArgs(["c1", "--group", "catalog-page", "--passes", "1", "--build"], allApps);
  const commit = "a".repeat(40), imageId = `sha256:${"b".repeat(64)}`;
  const catalog = records(), fixtureText = `${JSON.stringify(catalog)}\n`;
  const fixtureSha256 = createHash("sha256").update(fixtureText).digest("hex");
  const summary = { schema: groupResultSchema, group, options, workload: "catalog-v1", round: "c1", runId: "catalog-c1-test", commit,
    dirty: false, commitAfter: commit, dirtyAfter: false, complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    startedAt: "2026-11-07T16:00:00Z", finishedAt: "2026-11-07T22:00:00Z", fixtureSha256,
    savedEvidence: { schema: rawSchema, fixtureSha256 }, measurement: { encoding: "identity", fixedRate: options.rate, cpus: cpuSettings({}), appMemoryBytes: 2 ** 30 }, apps: {} };
  summary.tools = Object.fromEntries(["upstream", "checker", "k6"].map((name) => [name, { imageId }]));
  put("tools.json", summary.tools);
  put("fixture.json", fixtureText);
  put("cleanup.json", { runId: summary.runId, containers: [], networks: [] });
  const check = { jsonRecords: 500, pages: expectedPageChecks(catalog), profiles: [false, true].flatMap((javaScriptEnabled) =>
    ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].map((profile) => ({ profile, javaScriptEnabled, forms: true, related: true, styles: true }))),
    upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } };
  for (const app of group.apps) {
    const entry = summary.apps[app] = { imageId, imageBytes: 1234, checks: {}, runs: {}, phases: {} };
    put(`image-${app}.json`, { imageId, imageBytes: 1234, commit, built: true });
    put(`build-${app}.log`, "native build completed\n");
    for (const source of sources) {
      const checked = { ...structuredClone(check), qualification: qualificationIdentity(group, app, source, imageId) };
      entry.checks[source] = checked;
      put(`${source}/${app}/checks.json`, check);
      put(`${source}/${app}/qualification.json`, checked);
      put(`${source}/${app}/checks.log`, "checks completed\n"); put(`${source}/${app}/app.log`, "");
    }
  }
  for (const { app, pass, ...profile } of timingPlan(options, sources, targets)) {
    const raw = `${profile.source}/${app}/p${pass}-page`, appName = `${summary.runId}-${app}`, upstreamName = `${summary.runId}-upstream`;
    const names = [appName, ...(profile.source === "api" ? [upstreamName] : [])];
    const probe = { path: "/catalog/record_1", first200At: "2026-11-07T16:00:00.200Z", successfulRequestMs: 2, bytes: 1000, attempts: 2 };
    const cold = { ...probe, containerStartedAt: "2026-11-07T16:00:00.000Z", first200MsFromContainerStart: 200,
      measuredBeforeReadinessOrWarmup: true, clock: "Docker host wall clock; container start, not process exec; polling interval 10ms" };
    const run = { pass, evidence: { app, ...profile, imageId }, cold, complete: true, phases: {} };
    (summary.apps[app].runs[`${profile.source}-page`] ??= []).push(run);
    put(`${raw}/cold.json`, cold); put(`${raw}/cold.log`, `catalog-probe-ready\n${JSON.stringify(probe)}\n`);
    put(`${raw}/container.json`, { id: "c".repeat(64), imageId, startedAt: cold.containerStartedAt,
      quotaNanoCpus: 1e9, cpuset: "", memoryBytes: 2 ** 30, source: profile.source, runId: summary.runId });
    put(`${raw}/app.log`, "");
    const load = { metrics: { http_reqs: { count: 6000, rate: 100 }, http_req_duration: { avg: 1, "p(50)": 1, "p(95)": 2, "p(99)": 3, max: 4 },
      http_req_failed: { value: 0 }, checks: { passes: 6000, fails: 0 } } };
    for (const phase of ["warmup", ...phases]) {
      put(`${raw}/${phase}.json`, load); put(`${raw}/${phase}.log`, "");
      const metrics = readLoad(load);
      if (phase !== "warmup") {
        const samples = Object.fromEntries(names.map((name) => [name, [{ t: 100, cpu: 99, mem: 8 }, { t: 101, cpu: 99, mem: 8 }]]));
        const stats = Object.fromEntries(names.map((name) => [name, summarizeSamples(samples[name])]));
        put(`${raw}/${phase}-stats.log.json`, { samples, summary: stats });
        put(`${raw}/${phase}-stats.log`, names.flatMap((Name) => samples[Name].map(() => JSON.stringify({ Name, CPUPerc: "99%", MemUsage: "8MiB / 1GiB" }))).join("\n") + "\n");
        put(`${raw}/${phase}-cpu.json`, Object.fromEntries(names.map((n) => [n, { usec: 55000000 }])));
        put(`${raw}/${phase}-cpu-counters.json`, { ids: Object.fromEntries(names.map((n) => [n, "c".repeat(64)])),
          before: Object.fromEntries(names.map((n) => [n, 100])), after: Object.fromEntries(names.map((n) => [n, 55000100])) });
        Object.assign(metrics, stats[appName], { cpuUsec: 55000000, perCpuSecond: 6000 / 55, upstream: profile.source === "api"
          ? { ...stats[upstreamName], cpuUsec: 55000000, highCpu: true, interpretation: "single-process upstream; a busy API may be the throughput limit, not the app" } : null });
      }
      if (phase === "warmup") run.warmup = metrics; else run.phases[phase] = metrics;
    }
  }
  for (const entry of Object.values(summary.apps)) for (const [key, runs] of Object.entries(entry.runs))
    entry.phases[key] = Object.fromEntries(phases.map((p) => [p, { ...aggregate(runs.map((r) => r.phases[p])), asked: options.passes }]));
  put("summary.json", summary);
  return { files, summary, put, reader: { readJson: (key) => JSON.parse(files.get(key)), readText: (key) => {
    assert.ok(files.has(key), `missing ${key}`); return files.get(key);
  } }, commit };
}

test("raw replay accepts the complete synthetic native matrix, not summary-only evidence", () => {
  const f = fixture();
  assert.equal(replayCatalog(f.summary, f.reader, f.commit).baseline, true);
  assert.equal(inspectCatalog(f.summary, f.commit).baseline, true, "historical report still inspects summaries");
  f.files.clear(); assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
});

test("raw counter, samples, checks, cold, container, cleanup and exact aggregates cannot contradict the summary", () => {
  const root = "fixture/corten/p1-page";
  const changes = [
    (f) => f.put(`${root}/sat64.json`, { metrics: {} }),
    (f) => { const p = JSON.parse(f.files.get(`${root}/sat64-cpu-counters.json`)); p.after[`${f.summary.runId}-corten`]++; f.put(`${root}/sat64-cpu-counters.json`, p); },
    (f) => { const p = JSON.parse(f.files.get(`${root}/sat64-stats.log.json`)); p.samples[`${f.summary.runId}-corten`][0].mem++; f.put(`${root}/sat64-stats.log.json`, p); },
    (f) => f.put(`${root}/sat64-stats.log`, ""),
    (f) => f.put("fixture/corten/checks.json", {}),
    (f) => f.put(`${root}/cold.log`, "{}\n"),
    (f) => { const p = JSON.parse(f.files.get(`${root}/container.json`)); p.imageId = `sha256:${"e".repeat(64)}`; f.put(`${root}/container.json`, p); },
    (f) => f.put("cleanup.json", { runId: f.summary.runId, containers: ["leftover"], networks: [] }),
    (f) => { f.summary.apps.corten.phases["fixture-page"].sat64.rps.median++; },
    (f) => { f.summary.options.build = false; },
    (f) => f.put("fixture.json", "{}"),
  ];
  for (const mutate of changes) { const f = fixture(); mutate(f); assert.throws(() => replayCatalog(f.summary, f.reader, f.commit)); }
});

test("filesystem validator is offline/read-only, blocks missing observations, rejects malformed present evidence", () => {
  const f = fixture(), folder = mkdtempSync(join(tmpdir(), "catalog-native-proof-"));
  try {
    for (const [key, value] of f.files) { mkdirSync(dirname(join(folder, key)), { recursive: true }); writeFileSync(join(folder, key), value); }
    const input = { folder, round: "c1", commit: f.commit };
    assert.equal(validateSaved(input).status, "verified");
    assert.equal(readFileSync(join(folder, "summary.json"), "utf8"), f.files.get("summary.json"));
    rmSync(join(folder, "cleanup.json")); assert.equal(validateSaved(input).status, "blocked");
    writeFileSync(join(folder, "cleanup.json"), "{"); assert.equal(validateSaved(input).status, "invalid");
    writeFileSync(join(folder, "cleanup.json"), f.files.get("cleanup.json"));
    linkSync(join(folder, "cleanup.json"), join(folder, "linked.json")); assert.equal(validateSaved(input).status, "invalid");
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
});

test("historical summary without raw version is blocked and invalid identity is not echoed", () => {
  const folder = mkdtempSync(join(tmpdir(), "catalog-legacy-proof-"));
  try {
    const f = fixture(); delete f.summary.savedEvidence; writeFileSync(join(folder, "summary.json"), JSON.stringify(f.summary));
    assert.equal(validateSaved({ folder, round: "c1", commit: f.commit }).status, "blocked");
    assert.deepEqual(validateSaved({ folder: "//host/share", round: "c1\n", commit: f.commit }), { status: "invalid", complete: false, errors: ["invalid catalog identity"] });
    assert.equal(validateSaved({ folder: "/\\host\\share", round: "c1", commit: f.commit }).status, "invalid");
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
});

test("native container receipt retains measured identity/configuration but no unrelated environment", () => {
  assert.deepEqual(containerEvidence({ Id: "id", Image: "image", State: { StartedAt: "start" }, HostConfig: { NanoCpus: 1e9, CpusetCpus: "0", Memory: 1024 },
    Config: { Env: ["CATALOG_SOURCE=fixture", "UNRELATED=private"], Labels: { "run.corten.catalog": "run" } } }),
  { id: "id", imageId: "image", startedAt: "start", quotaNanoCpus: 1e9, cpuset: "0", memoryBytes: 1024, source: "fixture", runId: "run" });
});
