import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { allApps } from "../fullstack/apps.mjs";
import { aggregate, cpuSettings, expectedPageChecks, parseArgs, phases, readLoad, sources, targets } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { groupDescriptor, groupResultSchema, qualificationIdentity, timingPlan } from "./group.mjs";
import { inspectCatalog } from "./report.mjs";
import { rawSchema, replayCatalog, containerEvidence, upstreamImage, checkerImage } from "./raw.mjs";
import { recordAttemptSchema } from "./record-attempt.mjs";
import { inspectNative } from "../workloads/isolated/native-replay.mjs";
import { sampleStats, summarizeSamples } from "./stats.mjs";
import { validateSaved } from "./verify.mjs";
import { k6Image, k6Provenance } from "../load-tool.mjs";

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
  summary.tools.k6 = k6Provenance({ Id: imageId, RepoDigests: [k6Image], Os: "linux", Architecture: "amd64" },
    "k6 v2.4.0 (synthetic test executable, not a native measurement)");
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
        const index = phases.indexOf(phase), before = 100 + index * 60000000;
        const startedAt = Date.parse("2026-11-07T16:00:01Z") + index * 70000;
        const finishedAt = startedAt + 60000;
        const samples = Object.fromEntries(names.map((name) => [name, [{ t: startedAt + 100, cpu: 99, mem: 8 }, { t: startedAt + 101, cpu: 99, mem: 8 }]]));
        const stats = Object.fromEntries(names.map((name) => [name, summarizeSamples(samples[name])]));
        put(`${raw}/${phase}-stats.log.json`, { samples, summary: stats });
        put(`${raw}/${phase}-stats.log`, names.flatMap((Name) => samples[Name].map(() => JSON.stringify({ Name, CPUPerc: "99%", MemUsage: "8MiB / 1GiB" }))).join("\n") + "\n");
        put(`${raw}/${phase}-cpu.json`, Object.fromEntries(names.map((n) => [n, { usec: 55000000 }])));
        put(`${raw}/${phase}-cpu-counters.json`, { ids: Object.fromEntries(names.map((n) => [n, "c".repeat(64)])),
          startedAt, finishedAt, before: Object.fromEntries(names.map((n) => [n, before])), after: Object.fromEntries(names.map((n) => [n, before + 55000000])) });
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

function failedFixture() {
  const f = fixture(), s = f.summary, app = s.group.apps[0], source = "fixture", start = Date.parse(s.startedAt);
  s.host = { checkout: "/synthetic/checkout" };
  s.complete = false; s.checksPassed = false; s.timingDisposition = "gated-functional";
  s.tools.upstream.image = upstreamImage; s.tools.checker.image = checkerImage; f.put("tools.json", s.tools);
  const requests = Object.keys(records()).slice(0, 8).map((id, index) => ({ id, index, path: `/api/catalog/${id}`, startedOrder: index,
    finishedOrder: index + 8, startedAt: start, finishedAt: start + 1, response: { status: 500, type: "application/json", body: "{}" } }));
  const failure = { schema: recordAttemptSchema, recordsSha256: createHash("sha256").update(JSON.stringify(records())).digest("hex"), requests, source,
    control: { reset: { method: "POST", path: "/__catalog/control", value: {}, status: 200, body: "{}" }, observed: { status: 200, body: '{"requests":{}}' } } };
  const checked = { failure, qualification: qualificationIdentity(s.group, app, source, s.apps[app].imageId) };
  s.apps[app].checks[source] = checked;
  f.put(`${source}/${app}/qualification.json`, checked); f.put(`${source}/${app}/checks.json`, { failure }); f.put(`${source}/${app}/checks.json.failure.json`, failure);
  // No timing was performed after this functional gate. Remove synthetic timing files.
  for (const path of f.files.keys()) if (/\/p\d+-/.test(path)) f.files.delete(path);
  for (const [name, entry] of Object.entries(s.apps)) {
    entry.runs = {}; entry.phases = {};
    for (const src of s.group.sources) {
      const running = (image, role, memory, cmd = []) => ({ Id: (role === "api" ? "d" : "c").repeat(64), Image: image,
        RestartCount: 0,
        State: { Status: "running", Running: true, OOMKilled: false, Dead: false, Paused: false, Restarting: false,
          ExitCode: 0, Error: "", StartedAt: s.startedAt },
        HostConfig: { NanoCpus: s.measurement.cpus[role].quota * 1e9, CpusetCpus: s.measurement.cpus[role].cpuset ?? "", Memory: memory },
        Config: { Cmd: cmd, Env: [`CATALOG_SOURCE=${src}`, "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", `API_BASE=http://${s.runId}-upstream:8080`], Labels: { "run.corten.catalog": s.runId } } });
      const runtime = running(entry.imageId, "app", 2 ** 30), upstream = running(s.tools.upstream.imageId, "api", 512 * 2 ** 20, ["node", "/bench/catalog/upstream.mjs"]);
      const negative = name === app && src === source;
      const checker = { ...running(s.tools.checker.imageId, "load", 2 ** 31), Id: "e".repeat(64), RestartCount: 0,
        State: { Status: "exited", Running: false, OOMKilled: false, Dead: false, Paused: false, Restarting: false, ExitCode: negative ? 1 : 0,
          Error: "", StartedAt: s.startedAt, FinishedAt: new Date(start + 2).toISOString() } };
      checker.HostConfig.NetworkMode = `container:${runtime.Id}`;
      checker.Config.Cmd = ["node", "/repo/bench/catalog/check.mjs", "http://127.0.0.1:8080", src, `http://${s.runId}-upstream:8080`, "/results/checks.json"];
      const mount = (Source, Destination, RW = false) => ({ Type: "bind", Source, Destination, RW });
      for (const info of [runtime, upstream]) { info.networks = [`${s.runId}-net`]; info.mounts = [mount(`${s.host.checkout}/bench/catalog/fixtures`, "/fixtures")]; }
      upstream.mounts.push(mount(`${s.host.checkout}/bench`, "/bench"));
      checker.mounts = [mount(s.host.checkout, "/repo"), mount(`${s.host.checkout}/bench/catalog/results/${s.round}/${src}/${name}`, "/results", true)];
      f.put(`${src}/${name}/checker.json`, { runtime, upstream, checker, exit: { code: negative ? 1 : 0, signal: null, expired: false, interrupted: false } });
    }
  }
  f.put("summary.json", s); return f;
}

test("catalog negative raw replay retains every selected app without timing or baseline promotion", () => {
  const f = failedFixture(), report = replayCatalog(f.summary, f.reader, f.commit);
  assert.equal(report.baseline, false); assert.equal(report.attemptComplete, true);
  assert.deepEqual(report.outcomes, f.summary.group.apps.map((app, i) => ({ app, outcome: i ? "passed" : "failed" })));
  assert.deepEqual(report.comparisonEligibleApps, []);
  for (const [path, bytes] of f.files) if (path.endsWith("/checker.json")) {
    const proof = JSON.parse(bytes);
    for (const role of ["runtime", "upstream", "checker"]) proof[role].mounts.reverse();
    f.put(path, proof);
  }
  assert.deepEqual(replayCatalog(f.summary, f.reader, f.commit), report, "Docker mount enumeration order is not semantic");
});

const boundaryFile = "fixture/corten/checker.json";
const overlays = [
  ["checker", "/repo/bench/catalog/check.mjs"], ["runtime", "/app"], ["upstream", "/bench/catalog/upstream.mjs"],
].map(([role, Destination]) => ({ name: `${role} source overlay`, mutate: (p) => {
  p[role].mounts.push({ Type: "bind", Source: "/unreviewed/source", Destination, RW: false });
} }));
const participantStates = ["runtime", "upstream"].flatMap((role) => [
  ["restart count", (info) => { info.RestartCount = 1; }],
  ["restarting", (info) => { info.State.Restarting = true; info.State.Status = "restarting"; }],
  ["paused", (info) => { info.State.Paused = true; info.State.Status = "paused"; }],
  ["restarting flag alone", (info) => { info.State.Restarting = true; }],
  ["paused flag alone", (info) => { info.State.Paused = true; }],
  ["status", (info) => { info.State.Status = "created"; }],
  ["exit code", (info) => { info.State.ExitCode = 137; }],
  ["error", (info) => { info.State.Error = "runtime failure"; }],
  ["missing restart count", (info) => { delete info.RestartCount; }],
  ["missing paused state", (info) => { delete info.State.Paused; }],
].map(([name, mutate]) => ({ name: `${role} ${name}`, mutate: (p) => mutate(p[role]) })));

test("catalog replay rejects every extra mount and unhealthy participant boundary", async (t) => {
  const mounts = ["checker", "runtime", "upstream"].flatMap((role) => [
    { name: `${role} image volume`, mutate: (p) => p[role].mounts.push({ Type: "volume", Source: "/docker/volume", Destination: "/unexpected", RW: true }) },
    { name: `${role} duplicate mount`, mutate: (p) => p[role].mounts.push({ ...p[role].mounts[0] }) },
    { name: `${role} missing mount`, mutate: (p) => p[role].mounts.pop() },
  ]);
  for (const { name, mutate } of [...overlays, ...mounts, ...participantStates]) await t.test(name, () => {
    const f = failedFixture(), proof = JSON.parse(f.files.get(boundaryFile));
    mutate(proof); f.put(boundaryFile, proof);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
  });
});

test("catalog saved API and isolated bridge reject source overlays and interrupted participants", async (t) => {
  for (const { name, mutate } of [...overlays, ...participantStates]) await t.test(name, async () => {
    const f = failedFixture(), proof = JSON.parse(f.files.get(boundaryFile));
    mutate(proof); f.put(boundaryFile, proof);
    const folder = mkdtempSync(join(tmpdir(), "catalog-invalid-boundary-"));
    try {
      for (const [path, bytes] of f.files) { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), bytes); }
      const saved = validateSaved({ folder, round: f.summary.round, commit: f.commit });
      assert.equal(saved.status, "invalid"); assert.equal(saved.complete, false);
      const b = { request: { group: "catalog-page", round: f.summary.round, commit: f.commit }, selection: { apps: f.summary.group.apps },
        execution: { effectiveOptions: f.summary.options }, resources: { expectedCpus: f.summary.measurement.cpus } };
      const report = await inspectNative(b, folder);
      assert.equal(report.status, "invalid"); assert.equal(report.attemptComplete, false);
      assert.ok(report.outcomes.every((row) => row.outcome === "not-run"));
    } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
  });
});

test("the real catalog saved API feeds the fixed isolated replay for positive and failed attempts", async () => {
  for (const f of [fixture(), failedFixture()]) {
    const folder = mkdtempSync(join(tmpdir(), "catalog-core-attempt-"));
    try {
      for (const [path, bytes] of f.files) { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), bytes); }
      const b = { request: { group: "catalog-page", round: f.summary.round, commit: f.commit }, selection: { apps: f.summary.group.apps },
        execution: { effectiveOptions: f.summary.options }, resources: { expectedCpus: f.summary.measurement.cpus } };
      const report = await inspectNative(b, folder), failed = !!f.summary.timingDisposition;
      assert.equal(report.status, failed ? "failed" : "verified"); assert.equal(report.attemptComplete, true);
      assert.deepEqual(report.comparisonEligibleApps, failed ? [] : b.selection.apps);
      if (failed) {
        rmSync(join(folder, "api/gin/checker.json"));
        assert.equal((await inspectNative(b, folder)).status, "blocked", "missing raw proof is not a complete target failure");
      }
    } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
  }
});

test("catalog negative replay requires normal checker exit, full prefixes, runtime/source/tools and cleanup", () => {
  const mutateFile = (f, path, fn) => { const v = JSON.parse(f.files.get(path)); fn(v); f.put(path, v); };
  for (const mutate of [
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.checker.State.OOMKilled = true; }),
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.checker.State.ExitCode = 137; }),
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.exit.expired = true; }),
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.runtime.Image = `sha256:${"e".repeat(64)}`; }),
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.runtime.HostConfig.NanoCpus++; }),
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.runtime.mounts[0].RW = true; }),
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.upstream.mounts[0].Source = "/wrong-fixture"; }),
    (f) => mutateFile(f, "fixture/corten/checker.json", (p) => { p.upstream.State.Running = false; }),
    (f) => f.files.delete("api/gin/checker.json"),
    (f) => f.files.delete("fixture/corten/checks.json.failure.json"),
    (f) => { f.summary.apps.corten.checks.fixture.failure.requests[0].response = undefined; },
    (f) => { f.summary.apps.corten.checks.fixture.failure.control.reset.value = { status: 503 }; },
    (f) => { f.summary.apps.gin.runs["fixture-page"] = [{ pass: 1 }]; },
    (f) => { f.summary.apps.gin.phases["fixture-page"] = { fixed: {} }; },
    (f) => { f.summary.tools.checker.image = "unbound:tool"; f.put("tools.json", f.summary.tools); },
    (f) => { f.summary.dirtyAfter = true; },
    (f) => { f.summary.failures.push({ stage: "harness" }); },
    (f) => { f.summary.cleanupFailures.push({ resource: "leftover" }); },
    (f) => f.put("cleanup.json", { runId: f.summary.runId, containers: ["leftover"], networks: [] }),
    (f) => { delete f.summary.apps.gin; },
    (f) => { f.summary.apps.gin.checks.api.profiles.pop(); f.put("api/gin/qualification.json", f.summary.apps.gin.checks.api); const { qualification, ...check } = f.summary.apps.gin.checks.api; f.put("api/gin/checks.json", check); },
  ]) { const f = failedFixture(); mutate(f); assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), undefined, mutate.toString()); }
});

test("matching all summary/failure copies cannot disguise a fabricated or incomplete negative prefix", () => {
  for (const mutate of [
    (p) => { delete p.requests[0].response; },
    (p) => { p.requests[0].id = "record_499"; },
    (p) => { p.requests[0].startedAt = 1; },
    (p) => { p.requests[0].finishedOrder = p.requests[0].startedOrder; },
    (p) => { p.requests[0].path = "/wrong"; },
    (p) => { p.control.reset.value = { status: 503 }; },
    (p) => { p.control.observed.body = '{"requests":{"unexpected":1}}'; },
    (p) => { for (const r of p.requests) r.response = { status: 200, type: "application/json", body: JSON.stringify(records()[r.id]) }; },
  ]) {
    const f = failedFixture(), checked = f.summary.apps.corten.checks.fixture;
    mutate(checked.failure); f.put("fixture/corten/qualification.json", checked); f.put("fixture/corten/checks.json", { failure: checked.failure });
    f.put("fixture/corten/checks.json.failure.json", checked.failure);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), undefined, mutate.toString());
  }
});

test("raw replay accepts the complete synthetic native matrix, not summary-only evidence", () => {
  const f = fixture();
  assert.equal(replayCatalog(f.summary, f.reader, f.commit).baseline, true);
  assert.equal(inspectCatalog(f.summary, f.commit).baseline, true, "historical report still inspects summaries");
  f.files.clear(); assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
});

test("native catalog qualification cannot invent a missing load-tool identity", () => {
  for (const field of ["version", "versionOutput", "repoDigests", "platform", "image"]) {
    const f = fixture();
    delete f.summary.tools.k6[field];
    f.put("tools.json", f.summary.tools);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), undefined, field);
  }
  const f = fixture(); f.summary.savedEvidence.schema = "catalog-saved-evidence/v1";
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /native raw evidence version/);
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

test("native cumulative counters and sample clocks retain cross-phase chronology", () => {
  const root = "fixture/corten/p1-page";
  const f = fixture();
  const counter = JSON.parse(f.files.get(`${root}/sat64-cpu-counters.json`));
  for (const name of Object.keys(counter.before)) { counter.before[name] += 1e12; counter.after[name] += 1e12; }
  f.put(`${root}/sat64-cpu-counters.json`, counter);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), "same container's cumulative CPU cannot move backwards in the following phase");
  const g = fixture();
  const samples = JSON.parse(g.files.get(`${root}/sat64-stats.log.json`));
  for (const rows of Object.values(samples.samples)) for (const row of rows) row.t = 1;
  g.put(`${root}/sat64-stats.log.json`, samples);
  assert.throws(() => replayCatalog(g.summary, g.reader, g.commit), "sample time outside measured window cannot verify");
});

test("native upstream identity is continuous across phases and candidates", () => {
  for (const [app, pass, changedPhases] of [
    ["corten", 1, ["sat64"]],
    ["corten", 1, ["sat64", "sat256"]],
    ["aspnet", 1, phases],
  ]) {
    const f = fixture();
    for (const phase of changedPhases) {
      const path = `api/${app}/p${pass}-page/${phase}-cpu-counters.json`;
      const proof = JSON.parse(f.files.get(path));
      proof.ids[`${f.summary.runId}-upstream`] = "d".repeat(64);
      f.put(path, proof);
    }
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /upstream.*identity/);
  }
});

test("native sampler rejects a trailing incomplete record and retains its bytes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "catalog-stats-framing-"));
  const old = childProcess.spawn;
  const fake = new EventEmitter(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  fake.kill = () => { setImmediate(() => fake.emit("close", 0)); return true; };
  childProcess.spawn = () => fake; syncBuiltinESMExports();
  try {
    const path = join(folder, "stats.log");
    const sampler = sampleStats(["app"], path, 10);
    fake.stdout.write('{"Name":"app","CPUPerc":"50%","MemUsage":"8MiB / 1GiB"}\n{"Name":');
    await assert.rejects(sampler.stop(), /incomplete.*record/);
    assert.ok(readFileSync(path, "utf8").endsWith('{"Name":'), "failed evidence is retained");
  } finally {
    childProcess.spawn = old; syncBuiltinESMExports();
    assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true });
  }
});
