import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { allApps, catalogPeers } from "../fullstack/inventory.mjs";
import { aggregate, cpuSettings, expectedPageChecks, leanApps, leanProfile, parseArgs, phases, readLoad, sources, targets } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { groupDescriptor, groupResultSchema, qualificationIdentity, timingPlan } from "./group.mjs";
import { inspectCatalog, renderCatalog } from "./report.mjs";
import { rawSchema, replayCatalog, containerEvidence, upstreamImage, checkerImage, imageCommandEvidence, checkBoundaryEvidence, verifyCheckBoundary } from "./raw.mjs";
import { recordAttemptSchema } from "./record-attempt.mjs";
import { inspectNative } from "../workloads/isolated/native-replay.mjs";
import { sampleStats, summarizeSamples } from "./stats.mjs";
import { validateSaved } from "./verify.mjs";
import { ImagePinRefusal, k6Image, k6Provenance } from "../load-tool.mjs";
import { inspect } from "node:util";
import { collectTimedPhase, readFailureClasses, readTimedLoad, verifyTimedPhase } from "./timed.mjs";
import { composePhase } from "../workloads/isolated/composition.mjs";
import { latestStableSchema } from "../workloads/latest-stable.mjs";
import { loadSummary, timedFixture } from "./timed-fixture.mjs";
import { failureClass, requestOutcome } from "./load-outcome.js";
import { phaseEnd, statsPhaseErrors } from "../marketplace/run-contract.mjs";

// Synthetic verifier fixtures, never measured performance or qualification receipts.
function fixture(passes = 1) {
  const files = new Map();
  const put = (key, value) => files.set(key, typeof value === "string" ? value : JSON.stringify(value));
  const group = groupDescriptor("catalog-page", { historical: true });
  const options = parseArgs(["c1", "--group", "catalog-page", "--passes", String(passes), "--build"], { ...allApps, ...catalogPeers });
  options.apps = group.apps;
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
  for (const { app, pass, ...profile } of timingPlan(options, sources, targets, group.contractSha256)) {
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
  s.tools.upstream.image = upstreamImage; s.tools.checker.image = checkerImage;
  s.tools.upstream.execution = { Entrypoint: ["docker-entrypoint.sh"], Cmd: ["node"] };
  s.tools.checker.execution = { Entrypoint: null, Cmd: ["/bin/bash"] };
  f.put("tools.json", s.tools);
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
    entry.imageExecution = { Entrypoint: ["/synthetic-image-entrypoint"], Cmd: ["/synthetic-app"] };
    f.put(`image-${name}.json`, { imageId: entry.imageId, imageBytes: entry.imageBytes, commit: f.commit, built: true, execution: entry.imageExecution });
    entry.runs = {}; entry.phases = {};
    for (const src of s.group.sources) {
      const running = (image, role, memory, cmd = []) => ({ Id: (role === "api" ? "d" : "c").repeat(64), Image: image,
        RestartCount: 0,
        State: { Status: "running", Running: true, OOMKilled: false, Dead: false, Paused: false, Restarting: false,
          ExitCode: 0, Error: "", StartedAt: s.startedAt },
        HostConfig: { NanoCpus: s.measurement.cpus[role].quota * 1e9, CpusetCpus: s.measurement.cpus[role].cpuset ?? "", Memory: memory },
        Config: { Cmd: cmd, Env: [`CATALOG_SOURCE=${src}`, "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", `API_BASE=http://${s.runId}-upstream:8080`], Labels: { "run.corten.catalog": s.runId } } });
      const runtime = running(entry.imageId, "app", 2 ** 30, entry.imageExecution.Cmd), upstream = running(s.tools.upstream.imageId, "api", 512 * 2 ** 20, ["node", "/bench/catalog/upstream.mjs"]);
      const negative = name === app && src === source;
      const checker = { ...running(s.tools.checker.imageId, "load", 2 ** 31), Id: "e".repeat(64), RestartCount: 0,
        State: { Status: "exited", Running: false, OOMKilled: false, Dead: false, Paused: false, Restarting: false, ExitCode: negative ? 1 : 0,
          Error: "", StartedAt: s.startedAt, FinishedAt: new Date(start + 2).toISOString() } };
      checker.HostConfig.NetworkMode = `container:${runtime.Id}`;
      checker.Config.Cmd = ["node", "/repo/bench/catalog/check.mjs", "http://127.0.0.1:8080", src, `http://${s.runId}-upstream:8080`, "/results/checks.json"];
      for (const [info, image] of [[runtime, entry.imageExecution], [upstream, s.tools.upstream.execution], [checker, s.tools.checker.execution]]) {
        info.Config.Entrypoint = image.Entrypoint;
        const argv = [...(image.Entrypoint ?? []), ...(info.Config.Cmd ?? [])];
        info.Path = argv[0]; info.Args = argv.slice(1);
      }
      const mount = (Source, Destination, RW = false) => ({ Type: "bind", Source, Destination, RW });
      for (const info of [runtime, upstream]) { info.networks = [`${s.runId}-net`]; info.mounts = [mount(`${s.host.checkout}/bench/catalog/fixtures`, "/fixtures")]; }
      upstream.mounts.push(mount(`${s.host.checkout}/bench`, "/bench"));
      checker.mounts = [mount(s.host.checkout, "/repo"), mount(`${s.host.checkout}/bench/catalog/results/${s.round}/${src}/${name}`, "/results", true)];
      f.put(`${src}/${name}/checker.json`, { runtime, upstream, checker, exit: { code: negative ? 1 : 0, signal: null, expired: false, interrupted: false } });
    }
  }
  f.put("summary.json", s); return f;
}

test("timed threshold outcomes retain every pass, failed requests and healthy peers without baseline promotion", () => {
  const f = timedFixture(fixture(3)), report = replayCatalog(f.summary, f.reader, f.commit);
  assert.equal(report.attemptComplete, true); assert.equal(report.baseline, false);
  assert.equal(report.outcomes.find((r) => r.app === "fastapi").outcome, "failed");
  assert.equal(report.comparisonEligibleApps.length, 6); assert.ok(!report.comparisonEligibleApps.includes("fastapi"));
  const cell = report.timedCells.find((c) => c.app === "fastapi" && c.profile === "api-page" && c.phase === "sat256");
  assert.equal(cell.passes, 3); assert.equal(cell.asked, 3); assert.equal(cell.outcomes.failed, 1);
  assert.equal(cell.failed.max, 6); assert.equal(cell.successfulRps.min, 9.4); assert.equal(cell.rps.min, 10);
  assert.match(renderCatalog(report), /observed load\/request failure/); assert.match(renderCatalog(report), /2 \/ 1 \/ 3/);
  for (const entry of Object.values(f.summary.apps)) for (const runs of Object.values(entry.runs)) assert.equal(runs.length, 3);
});

test("lean v3 replay binds every functional and timed contender to the same exact profile", () => {
  for (const failure of [null, { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 1 }]) {
    const f = timedFixture(fixture(), failure);
    f.summary.measurement.leanProfile = { name: leanProfile, apps: f.summary.group.apps };
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /runtime lean profile differs/);
    for (const path of f.files.keys()) {
      if (path.endsWith("/checker.json")) {
        const receipt = f.reader.readJson(path);
        receipt.runtime.Config.Env.push(`PROFILE=${leanProfile}`);
        f.put(path, receipt);
      } else if (path.endsWith("-boundary.json")) {
        const receipt = f.reader.readJson(path);
        for (const edge of ["before", "after"]) receipt[edge].runtime.env.push(`PROFILE=${leanProfile}`);
        for (const edge of ["before", "after"]) receipt[edge].runtime.env.sort();
        f.put(path, receipt);
      }
    }
    assert.equal(replayCatalog(f.summary, f.reader, f.commit).attemptComplete, true);
    for (const phase of ["warmup", ...phases]) for (const edge of ["before", "after"]) {
      const path = `fixture/corten/p1-page/${phase}-boundary.json`, original = f.files.get(path);
      for (const badProfile of [null, "PROFILE=matched", `PROFILE=${leanProfile}`, "PROFILE=defaults"]) {
        const receipt = JSON.parse(original);
        if (badProfile === `PROFILE=${leanProfile}`) receipt[edge].runtime.env.push(badProfile);
        else receipt[edge].runtime.env = receipt[edge].runtime.env.filter((value) => !value.startsWith("PROFILE="))
          .concat(badProfile === null ? [] : [badProfile]).sort();
        f.put(path, receipt);
        assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /timed source environment differs/);
      }
      f.files.set(path, original);
    }
  }
});

test("timed successful v3 replay still establishes only a fully successful baseline", () => {
  const f = timedFixture(fixture(), null), report = replayCatalog(f.summary, f.reader, f.commit);
  assert.equal(report.baseline, true); assert.equal(report.attemptComplete, true); assert.equal(report.comparisonEligibleApps.length, 7);
});

test("timed v3 positive checker participants require known no-termination state", async (t) => {
  for (const failure of [null, { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 6 }]) {
    const f = timedFixture(fixture(), failure), path = "fixture/corten/checker.json", original = f.files.get(path);
    for (const role of ["runtime", "upstream"]) for (const finishedAt of ["2026-11-07T21:59:00.000Z", undefined, null, "invalid", ""]) {
      await t.test(`${failure ? "failed" : "successful"} attempt ${role} FinishedAt ${String(finishedAt)}`, () => {
        const boundary = JSON.parse(original);
        boundary[role].State.FinishedAt = finishedAt; f.put(path, boundary);
        assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /termination|lifetime|state|participant/);
      });
    }
  }
});

test("timed v3 full participant lifetime must agree across functional and timed observations", async (t) => {
  for (const scope of ["functional peer", "functional to timed", "timed phases"]) await t.test(scope, () => {
    const f = timedFixture(fixture(), null);
    const paths = scope === "functional peer" ? ["fixture/corten/checker.json"]
      : scope === "functional to timed" ? [...f.files.keys()].filter((path) => path.endsWith("/checker.json"))
      : ["fixture/corten/p1-page/sat256-boundary.json"];
    for (const path of paths) {
      const boundary = f.reader.readJson(path);
      // Both dates pass a per-observation <= 0 check, but the retained state changed.
      if (path.endsWith("/checker.json")) boundary.upstream.State.FinishedAt = "1970-01-01T00:00:00Z";
      else for (const edge of ["before", "after"]) boundary[edge].upstream.state.FinishedAt = "1970-01-01T00:00:00Z";
      f.put(path, boundary);
    }
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /lifetime changed across attempt/);
  });
});

test("timed v3 saved verifier rejects positive checker prior termination without rewriting evidence", () => {
  const f = timedFixture(fixture(), null), path = "fixture/corten/checker.json";
  const folder = mkdtempSync(join(tmpdir(), "catalog-positive-lifetime-"));
  try {
    for (const [key, bytes] of f.files) { mkdirSync(dirname(join(folder, key)), { recursive: true }); writeFileSync(join(folder, key), bytes); }
    assert.equal(validateSaved({ folder, round: "c1", commit: f.commit }).status, "verified");
    for (const role of ["runtime", "upstream"]) {
      const boundary = f.reader.readJson(path); boundary[role].State.FinishedAt = f.summary.finishedAt;
      const bytes = JSON.stringify(boundary); writeFileSync(join(folder, path), bytes);
      const saved = validateSaved({ folder, round: "c1", commit: f.commit });
      assert.equal(saved.status, "invalid", role); assert.equal(saved.complete, false);
      assert.equal(readFileSync(join(folder, path), "utf8"), bytes);
    }
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
});

test("timed v3 summary reports require an exact retained-phase failure disposition", async (t) => {
  const invented = { app: "fastapi", source: "api", target: "page", pass: 1, phase: "sat256", failed: 1, timeouts: 1, httpErrors: 0, dropped: 0 };
  const cases = [
    ["missing ledger", (s) => { delete s.targetFailures; }],
    ["null ledger", (s) => { s.targetFailures = null; }],
    ["invented ledger", (s) => { s.targetFailures = [invented]; }],
    ["invented completion failure", (s) => { s.complete = false; }],
    ["missing completion", (s) => { delete s.complete; }],
  ];
  for (const failure of [null, { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 6 }]) {
    const f = timedFixture(fixture(), failure), original = structuredClone(f.summary);
    const changes = failure ? [...cases,
      ["omitted failure", (s) => { s.targetFailures = []; }],
      ["duplicate failure", (s) => { s.targetFailures.push({ ...s.targetFailures[0] }); }],
      ["wrong failed phase", (s) => { s.targetFailures[0].phase = "sat64"; }],
      ["wrong failed app", (s) => { s.targetFailures[0].app = "corten"; }],
      ["wrong failure count", (s) => { s.targetFailures[0].failed++; }],
      ["extra failure field", (s) => { s.targetFailures[0].invented = true; }],
      ["contradictory baseline", (s) => { s.complete = true; }],
    ].filter(([name]) => name !== "invented completion failure") : cases;
    for (const [name, mutate] of changes) await t.test(`${failure ? "failed" : "successful"} attempt ${name}`, () => {
      const summary = structuredClone(original); mutate(summary);
      const before = structuredClone(summary), report = inspectCatalog(summary, f.commit);
      assert.equal(report.attemptComplete, false); assert.equal(report.baseline, false);
      assert.equal(report.status, "FAILED OR INCOMPLETE: not a baseline");
      assert.doesNotMatch(renderCatalog(report), /COMPLETE ATTEMPT: observed load\/request failure/);
      assert.deepEqual(summary, before, "reporting must not repair or rewrite the summary");
      assert.throws(() => replayCatalog(summary, f.reader, f.commit));
    });
  }
});

test("timed v3 summary-only CLI cannot call missing or invented ledgers completed failures", () => {
  const f = timedFixture(fixture(), null), folder = mkdtempSync(join(tmpdir(), "catalog-report-disposition-"));
  try {
    for (const missing of [true, false]) {
      const summary = structuredClone(f.summary); summary.complete = false;
      if (missing) delete summary.targetFailures;
      else summary.targetFailures = [{ app: "fastapi", source: "api", target: "page", pass: 1, phase: "sat256", failed: 1, timeouts: 1, httpErrors: 0, dropped: 0 }];
      const path = join(folder, "summary.json"); writeFileSync(path, JSON.stringify(summary));
      const cli = childProcess.spawnSync(process.execPath, ["--max-old-space-size=384", fileURLToPath(new URL("./report.mjs", import.meta.url)), path,
        "--commit", f.commit, "--require-complete"], { encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.equal(cli.error, undefined); assert.equal(cli.signal, null); assert.equal(cli.status, 1);
      assert.match(cli.stdout, /FAILED OR INCOMPLETE: not a baseline/);
      assert.doesNotMatch(cli.stdout, /COMPLETE ATTEMPT: observed load\/request failure/);
    }
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
});

test("timed v3 requires every positive checker boundary for both successful and failed attempts", () => {
  for (const failure of [null, { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 6 }]) {
    const f = timedFixture(fixture(), failure), saved = new Map();
    for (const app of f.summary.group.apps) for (const source of f.summary.group.sources) {
      const path = `${source}/${app}/checker.json`, bytes = f.files.get(path);
      saved.set(path, bytes); f.files.delete(path);
      assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), undefined, `missing ${path}`);
      f.files.set(path, bytes);
    }
    for (const path of saved.keys()) f.files.delete(path);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
    for (const [path, bytes] of saved) {
      const boundary = JSON.parse(bytes);
      boundary.exit.code = 137; boundary.exit.expired = true; boundary.runtime.State.OOMKilled = true;
      f.put(path, boundary);
    }
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /checker client lifetime/);
  }
});

test("timed v3 rejects contradictory functional checker execution and lifecycle evidence", () => {
  const f = timedFixture(fixture(), null), path = "api/fastapi/checker.json", original = f.files.get(path);
  for (const mutate of [
    (b) => { b.exit.expired = true; },
    (b) => { b.exit.code = 137; },
    (b) => { b.exit.interrupted = true; },
    (b) => { b.exit.signal = "SIGTERM"; },
    (b) => { b.runtime.State.OOMKilled = true; },
    (b) => { b.upstream.State.OOMKilled = true; },
    (b) => { b.checker.State.ExitCode = 137; },
    (b) => { b.runtime.Path = "/unreviewed/app"; },
    (b) => { b.checker.Args.push("--skip-content"); },
    (b) => { b.upstream.mounts = []; },
    (b) => { b.runtime.Config.Env = b.runtime.Config.Env.filter((v) => !v.startsWith("CATALOG_SOURCE=")); },
    (b) => { b.upstream.Id = "f".repeat(64); },
    (b) => { b.upstream.State.StartedAt = new Date(Date.parse(f.summary.startedAt) + 1).toISOString(); },
  ]) {
    const boundary = JSON.parse(original); mutate(boundary); f.put(path, boundary);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
  }
});

test("timed v3 CPU chronology follows observation clocks across rotated passes, not summary traversal", () => {
  const f = timedFixture(fixture(3), null), s = f.summary;
  const [first, second] = s.group.apps;
  const time = (app, pass) => f.reader.readJson(`api/${app}/p${pass}-page/warmup-cpu-counters.json`).startedAt;
  assert.ok(time(first, 3) > time(second, 1), "fixture must differ from app-grouped summary traversal");
  for (const entry of Object.values(s.apps)) for (const runs of Object.values(entry.runs)) runs.reverse();
  s.apps = Object.fromEntries(Object.entries(s.apps).reverse());
  const report = replayCatalog(s, f.reader, f.commit);
  assert.equal(report.attemptComplete, true); assert.equal(report.baseline, true);
  assert.equal(report.comparisonEligibleApps.length, 7);
});

function shiftFixtureRun(f, app, pass, delta) {
  const root = `fixture/${app}/p${pass}-page`, run = f.summary.apps[app].runs["fixture-page"].find((r) => r.pass === pass);
  const shift = (value) => new Date(Date.parse(value) + delta).toISOString();
  const change = (path, mutate) => { const value = f.reader.readJson(path); mutate(value); f.put(path, value); };
  run.cold.containerStartedAt = shift(run.cold.containerStartedAt); run.cold.first200At = shift(run.cold.first200At);
  f.put(`${root}/cold.json`, run.cold);
  const { first200MsFromContainerStart, containerStartedAt, clock, measuredBeforeReadinessOrWarmup, ...probe } = run.cold;
  f.put(`${root}/cold.log`, `catalog-probe-ready\n${JSON.stringify(probe)}\n`);
  change(`${root}/container.json`, (v) => { v.startedAt = shift(v.startedAt); });
  for (const phase of ["warmup", ...phases]) {
    change(`${root}/${phase}-boundary.json`, (b) => {
      b.observedAt += delta;
      for (const edge of ["before", "after"]) b[edge].runtime.state.StartedAt = shift(b[edge].runtime.state.StartedAt);
      for (const key of ["StartedAt", "FinishedAt"]) b.after.load.state[key] = shift(b.after.load.state[key]);
    });
    change(`${root}/${phase}-cpu-counters.json`, (p) => { p.startedAt += delta; p.finishedAt += delta; });
    change(`${root}/${phase}-stats.log.json`, (stats) => { for (const rows of Object.values(stats.samples)) for (const row of rows) row.t += delta; });
  }
}

function reverseTimedRuns(summary) {
  summary.apps = Object.fromEntries(Object.entries(summary.apps).reverse());
  for (const entry of Object.values(summary.apps)) for (const runs of Object.values(entry.runs)) runs.reverse();
}

for (const [label, failure] of [["successful", null], ["timed-failed", { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 6 }]]) {
  test(`timed v3 ${label} serial loads follow native clocks, not summary order or CPU envelopes`, () => {
    const f = timedFixture(fixture(3), failure), [first, second] = f.summary.group.apps;
    const check = () => {
      const report = replayCatalog(f.summary, f.reader, f.commit);
      assert.equal(report.attemptComplete, true); assert.equal(report.baseline, failure === null);
      assert.equal(report.comparisonEligibleApps.length, failure === null ? 7 : 6);
    };
    check(); reverseTimedRuns(f.summary); check();
    const end = Date.parse(f.reader.readJson(`fixture/${first}/p1-page/sat256-boundary.json`).after.load.state.FinishedAt);
    const start = Date.parse(f.reader.readJson(`fixture/${second}/p1-page/warmup-boundary.json`).after.load.state.StartedAt);
    shiftFixtureRun(f, second, 1, end - start);
    const before = f.reader.readJson(`fixture/${first}/p1-page/sat256-cpu-counters.json`);
    const after = f.reader.readJson(`fixture/${second}/p1-page/warmup-cpu-counters.json`);
    assert.ok(after.startedAt < before.finishedAt, "CPU observation envelopes must overlap while native load lifetimes only touch");
    check(); reverseTimedRuns(f.summary); check();
  });

  test(`timed v3 ${label} rejects overlapping native load lifetimes across runs`, async (t) => {
    for (const scope of ["app", "pass"]) for (const overlap of ["complete", "one millisecond"]) await t.test(`${scope}: ${overlap}`, () => {
      const f = timedFixture(fixture(3), failure), [first, second] = f.summary.group.apps;
      const app = scope === "app" ? second : first, pass = scope === "pass" ? 2 : 1;
      const phase = overlap === "complete" ? "warmup" : "sat256";
      const a = f.reader.readJson(`fixture/${first}/p1-page/${phase}-boundary.json`).after.load;
      const b = f.reader.readJson(`fixture/${app}/p${pass}-page/warmup-boundary.json`).after.load;
      const delta = Date.parse(a.state[overlap === "complete" ? "StartedAt" : "FinishedAt"]) - Date.parse(b.state.StartedAt)
        - (overlap === "complete" ? 0 : 1);
      shiftFixtureRun(f, app, pass, delta);
      const shifted = f.reader.readJson(`fixture/${app}/p${pass}-page/warmup-boundary.json`).after.load;
      assert.equal(a.name, shifted.name); assert.notEqual(a.id, shifted.id);
      assert.ok(Date.parse(shifted.state.StartedAt) < Date.parse(a.state.FinishedAt)
        && Date.parse(shifted.state.FinishedAt) > Date.parse(a.state.StartedAt));
      assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /timed load lifetimes overlap across attempt/);
      reverseTimedRuns(f.summary);
      assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /timed load lifetimes overlap across attempt/);
    });
  });

  test(`timed v3 ${label} saved verifier rejects overlapping loads without rewriting evidence`, () => {
    const f = timedFixture(fixture(), failure), [first, second] = f.summary.group.apps;
    const delta = Date.parse(f.summary.apps[first].runs["fixture-page"][0].cold.containerStartedAt)
      - Date.parse(f.summary.apps[second].runs["fixture-page"][0].cold.containerStartedAt);
    const folder = mkdtempSync(join(tmpdir(), "catalog-load-overlap-"));
    try {
      for (const [key, bytes] of f.files) { mkdirSync(dirname(join(folder, key)), { recursive: true }); writeFileSync(join(folder, key), bytes); }
      const original = validateSaved({ folder, round: "c1", commit: f.commit });
      assert.equal(original.status, "verified"); assert.equal(original.complete, true); assert.equal(original.report.baseline, failure === null);
      shiftFixtureRun(f, second, 1, delta);
      for (const reordered of [false, true]) {
        if (reordered) reverseTimedRuns(f.summary);
        f.put("summary.json", f.summary);
        for (const [key, bytes] of f.files) writeFileSync(join(folder, key), bytes);
        const saved = validateSaved({ folder, round: "c1", commit: f.commit });
        assert.equal(saved.status, "invalid"); assert.equal(saved.complete, false);
        for (const [key, bytes] of f.files) assert.equal(readFileSync(join(folder, key), "utf8"), bytes, key);
      }
    } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
  });
}

test("timed v3 binds the shared functional upstream identity and lifetime to timing", () => {
  for (const change of ["identity", "lifetime"]) {
    const f = timedFixture(fixture(), null);
    for (const app of f.summary.group.apps) for (const source of f.summary.group.sources) {
      const path = `${source}/${app}/checker.json`, boundary = f.reader.readJson(path);
      if (change === "identity") boundary.upstream.Id = "f".repeat(64);
      else boundary.upstream.State.StartedAt = new Date(Date.parse(f.summary.startedAt) + 1).toISOString();
      f.put(path, boundary);
    }
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), change === "identity" ? /timed upstream identity changed/ : /lifetime changed across attempt/);
  }
});

test("timed v3 does not retrofit legacy v2 checks or partial metrics into new proof", () => {
  const f = fixture();
  assert.ok(![...f.files.keys()].some((path) => path.endsWith("/checker.json")));
  assert.equal(replayCatalog(f.summary, f.reader, f.commit).baseline, true, "v2 positive-check semantics stay unchanged");
  f.summary.savedEvidence.schema = "catalog-saved-evidence/v3";
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /timed native attempt is not complete/);
  f.summary.attemptComplete = true; f.summary.targetFailures = [];
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /timed native attempt is not complete/);
});

for (const scope of ["app", "source", "pass"]) for (const change of ["lifetime", "counter", "both"]) {
  if (scope === "source" && change !== "lifetime") continue; // Fixture-source upstream has no CPU samples.
  test(`timed v3 rejects upstream ${change} discontinuity across ${scope} runs`, () => {
    const f = timedFixture(fixture(scope === "pass" ? 3 : 1), null), s = f.summary;
    const app = s.group.apps[scope === "app" ? 1 : 0], source = scope === "source" ? "fixture" : "api", pass = scope === "pass" ? 2 : 1;
    const raw = `${source}/${app}/p${pass}-page`, name = `${s.runId}-upstream`;
    for (const phase of ["warmup", ...phases]) {
      if (change !== "lifetime" && source === "api") {
        const path = `${raw}/${phase}-cpu-counters.json`, p = f.reader.readJson(path);
        p.before[name] -= 1e6; p.after[name] -= 1e6; f.put(path, p);
      }
      if (change !== "counter") {
        const path = `${raw}/${phase}-boundary.json`, b = f.reader.readJson(path);
        for (const edge of ["before", "after"]) b[edge].upstream.state.StartedAt = s.apps[app].runs[`${source}-page`].find((r) => r.pass === pass).cold.containerStartedAt;
        f.put(path, b);
      }
    }
    assert.throws(() => replayCatalog(s, f.reader, f.commit), change === "counter" ? /CPU counter moved backwards across attempt/ : /lifetime changed across attempt/);
  });
}

test("timed summary reporting cannot hide request failures behind passing flags or incomplete attempts", () => {
  const f = timedFixture(fixture()), s = f.summary, run = s.apps.fastapi.runs["api-page"][0];
  run.phases.sat256.failed = 0; run.phases.sat256.outcome = "passed"; run.outcome = "passed";
  s.complete = true; s.targetFailures = [];
  s.apps.fastapi.phases["api-page"].sat256 = { ...aggregate([run.phases.sat256]), asked: 1 };
  assert.equal(inspectCatalog(s).baseline, false); assert.equal(inspectCatalog(s).attemptComplete, false);
  const good = timedFixture(fixture(), null).summary; good.attemptComplete = false;
  assert.equal(inspectCatalog(good).baseline, false);
});

test("timed parser rejects unclassified/content failures and contradictory counts or thresholds", () => {
  assert.equal(readTimedLoad(loadSummary({ timeouts: 6 })).failed, 6);
  assert.equal(readTimedLoad(loadSummary({ httpErrors: 2 })).httpErrors, 2);
  assert.equal(readTimedLoad(loadSummary({ dropped: 3 })).dropped, 3);
  for (const mutate of [
    (s) => { s.metrics.catalog_invalid_responses.count = 1; },
    (s) => { delete s.metrics.catalog_timeouts; },
    (s) => { s.metrics.http_req_failed.passes++; },
    (s) => { s.metrics.http_req_failed.value = 0; },
    (s) => { s.metrics.checks.fails++; },
    (s) => { s.metrics.checks.value = 1; },
    (s) => { s.root_group.checks["catalog content type"].fails++; },
    (s) => { s.metrics.iterations.count--; },
    (s) => { s.metrics.http_req_failed.thresholds["rate==0"] = false; },
    (s) => { delete s.metrics.dropped_iterations; },
    (s) => { s.metrics.dropped_iterations.count = -1; },
    (s) => { s.metrics.http_req_duration["p(95)"] = null; },
    (s) => { s.metrics.http_req_duration["p(95)"] = 10001; },
  ]) { const summary = loadSummary({ timeouts: 6 }); mutate(summary); assert.throws(() => readTimedLoad(summary)); }
  assert.throws(() => readTimedLoad(loadSummary({ invalid: 1 })), /corrupt response/);
});

test("timed parser checks failure classes when a producer wrote them and reads the same metrics either way", () => {
  const classes = { http_429: 1, http_502: 2, http_503: 3, http_5xx: 4 };
  const split = readTimedLoad(loadSummary({ httpErrors: 10, classes }));
  assert.deepEqual(split, readTimedLoad(loadSummary({ httpErrors: 10 })));
  assert.equal(split.httpErrors, 10); assert.equal(split.failed, 10); assert.equal(split.outcome, "failed");
  assert.deepEqual(readFailureClasses(loadSummary({ httpErrors: 10, classes }), { http_errors: 10, invalid_responses: 0 }),
    { ...classes, transport: 0, other: 0 });
  // No class series: a run without failures, or a producer from before the split. Unknown, not zero.
  assert.equal(readFailureClasses(loadSummary({ httpErrors: 10 }), { http_errors: 10, invalid_responses: 0 }), null);
  assert.deepEqual(readTimedLoad(loadSummary()), readTimedLoad(loadSummary({ classes: {} })));
  for (const bad of [{ ...classes, http_502: 1 }, { ...classes, http_5xx: 5 }, { ...classes, http_429: 0 }, { ...classes, http_503: -1 },
    { ...classes, other: 1 }, { http_502: 10, transport: 0 }])
    assert.throws(() => readTimedLoad(loadSummary({ httpErrors: 10, classes: bad })), /failure class/);
  assert.throws(() => readTimedLoad(loadSummary({ invalid: 1, classes: { transport: 1 } })), /k6 transport error without an app response/);
  assert.throws(() => readTimedLoad(loadSummary({ invalid: 1, classes: { other: 1 } })), /corrupt response/);
  assert.throws(() => readTimedLoad(loadSummary({ invalid: 1 })), /corrupt response/);
});

test("timed parser refuses an unknown series under the failure-class prefix, alone or beside a counted class", () => {
  const counts = { http_errors: 10, invalid_responses: 0 };
  // Alone: a misspelled class must not read as a summary from before the split.
  const unknown = (error) => error.message === "unknown timed failure class series" && !inspect(error).includes("catalog_failed_http_50x");
  assert.throws(() => readFailureClasses(loadSummary({ httpErrors: 10, classes: { http_50x: 10 } }), counts), unknown);
  assert.throws(() => readTimedLoad(loadSummary({ httpErrors: 10, classes: { http_50x: 10 } })), /unknown timed failure class/);
  // Beside a valid class that already accounts for every HTTP error.
  assert.throws(() => readFailureClasses(loadSummary({ httpErrors: 10, classes: { http_5xx: 10, http_50x: 1 } }), counts), unknown);
  assert.throws(() => readTimedLoad(loadSummary({ httpErrors: 10, classes: { http_5xx: 10, http_50x: 1 } })), /unknown timed failure class/);
  // An empty suffix is not a class either.
  assert.throws(() => readFailureClasses(loadSummary({ classes: { "": 1 } }), { http_errors: 0, invalid_responses: 0 }), /unknown timed failure class/);
  // A legacy summary with no class series stays valid and its split stays unknown.
  assert.equal(readFailureClasses(loadSummary({ httpErrors: 10 }), counts), null);
  assert.equal(readTimedLoad(loadSummary({ httpErrors: 10 })).httpErrors, 10);
  assert.deepEqual(readFailureClasses(loadSummary({ httpErrors: 10, classes: { http_5xx: 10 } }), counts),
    { http_429: 0, http_502: 0, http_503: 0, http_5xx: 10, transport: 0, other: 0 });
});

test("timed request classification does not turn bad content types or arbitrary transport errors into target outcomes", () => {
  const response = (status, type = "text/html", error_code = 0) => ({ status, headers: { "Content-Type": type }, error_code });
  assert.equal(requestOutcome(response(200), "page"), "successes");
  assert.equal(requestOutcome(response(0, "", 1050), "page"), "timeouts");
  for (const status of [429, 500, 502, 503, 504]) for (const type of ["text/html", "application/json", "application/problem+json", "text/plain", ""])
    for (const target of ["page", "json"]) assert.equal(requestOutcome(response(status, type), target), "http_errors");
  for (const r of [response(200, "application/json"), response(404), response(302), response(0, "", 1000), response(0, "", 1210)])
    assert.equal(requestOutcome(r, "page"), "invalid_responses");
  // A k6 transport error is told apart from another invalid response, and a replay still refuses both.
  assert.equal(failureClass(response(0, "", 1210)), "transport");
  assert.equal(failureClass(response(0, "", 1020)), "other");
});

test("timed HTTP error accounting retains errors whose media type differs from a successful page", () => {
  const native = loadSummary({ httpErrors: 2 });
  native.root_group.checks["catalog content type"].passes -= 2;
  native.root_group.checks["catalog content type"].fails += 2;
  native.metrics.checks.passes -= 2;
  native.metrics.checks.fails += 2;
  native.metrics.checks.value = native.metrics.checks.passes / 200;
  assert.equal(readTimedLoad(native).httpErrors, 2);
  assert.equal(readTimedLoad(native).outcome, "failed");
  for (const passes of [97, 101]) {
    const changed = structuredClone(native);
    changed.root_group.checks["catalog content type"].passes = passes;
    assert.throws(() => readTimedLoad(changed), /content checks/);
  }
  const f = timedFixture(fixture(3), { app: "drogon", source: "api", pass: 2, phase: "sat64", httpErrors: 1, httpErrorType: false });
  const report = replayCatalog(f.summary, f.reader, f.commit);
  assert.equal(report.baseline, false); assert.equal(report.attemptComplete, true);
  assert.equal(report.outcomes.find((row) => row.app === "drogon").outcome, "failed");
  assert.ok(!report.comparisonEligibleApps.includes("drogon"));
});

test("timed positive checks must finish globally before the first cold timing", () => {
  for (const failure of [null, { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 6 }]) {
    const f = timedFixture(fixture(), failure);
    const firstCold = Math.min(...Object.values(f.summary.apps).flatMap((app) => Object.values(app.runs).flatMap((runs) => runs.map((run) => Date.parse(run.cold.containerStartedAt)))));
    const lastPhase = Math.max(...[...f.files.keys()].filter((key) => key.endsWith("-boundary.json")).map((key) => f.reader.readJson(key).observedAt));
    const path = "api/fastapi/checker.json", original = f.files.get(path);
    for (const end of [firstCold + 1, lastPhase + 2000]) {
      const boundary = JSON.parse(original);
      boundary.checker.State.StartedAt = new Date(end - 1).toISOString();
      boundary.checker.State.FinishedAt = new Date(end).toISOString();
      f.put(path, boundary);
      assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /before.*timing/);
    }
  }
});

test("timed HTTP errors and pressure-bound fixed drops are failed observed outcomes, not successful throughput", () => {
  for (const failure of [{ phase: "sat64", httpErrors: 2 }, { phase: "fixed", dropped: 3 }, { phase: "sat256", timeouts: 100 }]) {
    const f = timedFixture(fixture(), { app: "fastapi", source: "api", pass: 1, ...failure });
    const report = replayCatalog(f.summary, f.reader, f.commit);
    assert.equal(report.baseline, false); assert.equal(report.attemptComplete, true);
    assert.ok(!report.comparisonEligibleApps.includes("fastapi"));
    assert.equal(report.outcomes.find((r) => r.app === "fastapi").outcome, "failed");
    if (failure.timeouts === 100) assert.equal(report.timedCells.find((c) => c.app === "fastapi" && c.profile === "api-page" && c.phase === "sat256").successfulRps.max, 0);
  }
});

test("timed resource proof rejects internally consistent busy, exhausted or incomplete participant observations", () => {
  const f = timedFixture(fixture()), root = "api/fastapi/p1-page", file = `${root}/sat256-stats.log.json`;
  const original = f.files.get(file), app = `${f.summary.runId}-fastapi`, load = `${f.summary.runId}-k6`, upstream = `${f.summary.runId}-upstream`;
  const subject = { app: "fastapi", source: "api", target: "page", phase: "sat256", seconds: 60, instance: f.reader.readJson(`${root}/container.json`) };
  const reader = { readJson: (key) => f.reader.readJson(`${root}/${key}`), readText: (key) => f.reader.readText(`${root}/${key}`) };
  const statsLog = `${root}/sat256-stats.log`;
  const completeLog = f.reader.readText(statsLog);
  assert.doesNotThrow(() => verifyTimedPhase(f.summary, subject, reader));
  f.put(statsLog, "\u00a0" + completeLog);
  assert.doesNotThrow(() => verifyTimedPhase(f.summary, subject, reader), "surrounding raw row whitespace matches capture");
  f.put(statsLog, completeLog.replace(/ \/ [^"\n]+/g, ""));
  assert.throws(() => verifyTimedPhase(f.summary, subject, reader), /memory display missing its limit/);
  f.put(statsLog, completeLog);
  for (const [mutate, message] of [
    [(s) => { for (const v of s[load]) v.cpu = 320; }, /generator.*headroom/],
    [(s) => { for (const v of s[upstream]) v.cpu = 80; }, /busy upstream/],
    [(s) => { for (const v of s[app]) v.mem = 1024; }, /invalid timed sample/],
    [(s) => { s[load].splice(10, 4); }, /invalid timed sample/],
    [(s) => { s[load].splice(0, 4); }, /window incomplete/],
    [(s) => { s[load].splice(-4); }, /window incomplete/],
    [(s) => { for (const v of s[load]) v.cpu = 0; }, /observations incomplete/],
  ]) {
    const stats = JSON.parse(original); mutate(stats.samples);
    stats.summary = Object.fromEntries(Object.entries(stats.samples).map(([name, rows]) => [name, summarizeSamples(rows)]));
    f.put(file, stats);
    f.put(`${root}/sat256-stats.log`, Object.entries(stats.samples).flatMap(([Name, rows]) => rows.map((v) => JSON.stringify({ Name, CPUPerc: `${v.cpu}%`, MemUsage: `${v.mem}MiB / 2GiB` }))).join("\n") + "\n");
    assert.throws(() => verifyTimedPhase(f.summary, subject, reader), message);
  }
  const dropped = timedFixture(fixture(), { app: "fastapi", source: "api", pass: 1, phase: "fixed", dropped: 3 });
  const stats = dropped.reader.readJson(`${root}/fixed-stats.log.json`);
  for (const v of stats.samples[app]) v.cpu = 94;
  stats.summary[app] = summarizeSamples(stats.samples[app]); dropped.put(`${root}/fixed-stats.log.json`, stats);
  dropped.put(`${root}/fixed-stats.log`, Object.entries(stats.samples).flatMap(([Name, rows]) => rows.map((v) => JSON.stringify({ Name, CPUPerc: `${v.cpu}%`, MemUsage: `${v.mem}MiB / 2GiB` }))).join("\n") + "\n");
  assert.throws(() => verifyTimedPhase(dropped.summary, { ...subject, phase: "fixed" }, {
    readJson: (key) => dropped.reader.readJson(`${root}/${key}`), readText: (key) => dropped.reader.readText(`${root}/${key}`),
  }), /lacks observed target pressure/);
  assert.throws(() => timedFixture(fixture(), { app: "fastapi", source: "api", pass: 1, phase: "warmup", timeouts: 1 }), /failed warmup/);
});

test("timed producer preserves normal threshold exit99 and all secondary sampler/counter/copy/cleanup errors", async () => {
  const f = timedFixture(fixture()), prefix = "api/fastapi/p1-page", phase = "sat256";
  const proof = f.reader.readJson(`${prefix}/${phase}-cpu-counters.json`), receipt = f.reader.readJson(`${prefix}/${phase}-boundary.json`);
  const restore = Date.now;
  const dockerInfo = (p) => ({ Id: p.id, Name: p.name, Image: p.image, RestartCount: p.restarts, Path: p.path, Args: p.args, State: p.state, HostConfig: p.budget,
    Config: { Entrypoint: p.entrypoint, Cmd: p.command, Env: p.env, Labels: { "run.corten.catalog": p.owner } },
    NetworkSettings: { Networks: Object.fromEntries(p.networks.map((name) => [name, {}])) }, Mounts: p.mounts });
  for (const sideErrors of [false, true]) {
    const raw = mkdtempSync(join(tmpdir(), "catalog-timed-producer-"));
    let clock = proof.startedAt, started = false, cpuReads = 0, removed = false;
    Date.now = () => clock;
    const context = { summary: f.summary, raw, cpus: f.summary.measurement.cpus, k6Image, mount: [],
      owned: async () => {},
      inspect: async (name) => dockerInfo(receipt[started ? "after" : "before"][name.endsWith("-k6") ? "load" : name.endsWith("-upstream") ? "upstream" : "runtime"]),
      cpu: async () => {
        if (++cpuReads > 1 && sideErrors) throw new Error("counter unavailable");
        return { ids: proof.ids, values: cpuReads === 1 ? proof.before : proof.after };
      },
      sampleStats: () => ({ stop: async () => {
        for (const key of [`${phase}-stats.log`, `${phase}-stats.log.json`]) writeFileSync(join(raw, key), f.files.get(`${prefix}/${key}`));
        if (sideErrors) throw new Error("sampler incomplete");
      } }),
      docker: async (args) => {
        if (args[0] === "start") {
          started = true; clock = proof.finishedAt;
          writeFileSync(join(raw, `${phase}.log`), "synthetic native threshold exit99\n");
          throw Object.assign(new Error("exit 99"), { exit: receipt.exit });
        }
        assert.equal(args[0], "cp");
        if (sideErrors) throw new Error("copy failed");
        writeFileSync(join(raw, `${phase}.json`), f.files.get(`${prefix}/${phase}.json`));
      },
      remove: async () => { removed = true; if (sideErrors) throw new Error("cleanup failed"); },
    };
    const subject = { app: "fastapi", source: "api", target: "page", phase, seconds: 60, instance: f.reader.readJson(`${prefix}/container.json`) };
    try {
      if (sideErrors) {
        await assert.rejects(collectTimedPhase(context, subject), /apparatus failed/);
        const saved = JSON.parse(readFileSync(join(raw, `${phase}-boundary.json`)));
        assert.equal(saved.exit.code, 99);
        assert.ok(["sampler stop", "after CPU", "summary copy", "CPU artifacts", "load cleanup"].every((stage) => saved.errors.some((e) => e.stage === stage)));
      } else {
        const metrics = await collectTimedPhase(context, subject);
        assert.equal(metrics.outcome, "failed"); assert.equal(metrics.failed, 6); assert.equal(metrics.successfulRps, 9.4);
        for (const key of [`${phase}.json`, `${phase}.log`, `${phase}-cpu.json`, `${phase}-cpu-counters.json`, `${phase}-boundary.json`, `${phase}-stats.log`, `${phase}-stats.log.json`])
          f.put(`${prefix}/${key}`, readFileSync(join(raw, key), "utf8"));
        assert.equal(replayCatalog(f.summary, f.reader, f.commit).attemptComplete, true);
      }
      assert.equal(removed, true);
    } finally { Date.now = restore; assert.equal(dirname(raw), tmpdir()); rmSync(raw, { recursive: true, force: true }); }
  }
});

test("timed saved native replay composes failed apps with exit1, never exit99 or missing cleanup", async () => {
  const f = timedFixture(fixture()), folder = mkdtempSync(join(tmpdir(), "catalog-timed-native-"));
  try {
    for (const [path, bytes] of f.files) { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), bytes); }
    const binding = { request: { group: "catalog-page", round: f.summary.round, commit: f.commit },
      selection: { apps: f.summary.group.apps, contractSha256: f.summary.group.contractSha256 },
      execution: { effectiveOptions: f.summary.options }, resources: { requestedCpuEnv: {}, expectedCpus: f.summary.measurement.cpus }, preparation: { fixtures: [] },
      latestStable: { schema: latestStableSchema, group: "catalog-page", valid: true, status: "not-applicable", groupComparisonEligible: null } };
    const saved = validateSaved({ folder, round: f.summary.round, commit: f.commit });
    assert.equal(saved.status, "verified"); assert.equal(saved.report.baseline, false);
    const native = await inspectNative(binding, folder);
    assert.equal(native.status, "failed"); assert.equal(native.attemptComplete, true);
    const host = { resources: "verified", cleanupComplete: true }, command = { terminal: true, code: 1, signal: null, error: null, cancelled: false, forced: false, success: false };
    const composed = composePhase(binding, native, host, [command]);
    assert.equal(composed.outcome, "native-validated");
    assert.ok(composed.appOutcomes.every((r) => r.app === "fastapi" ? r.outcome === "failed" && !r.comparisonEligible : r.outcome === "passed" && r.comparisonEligible));
    for (const code of [0, 2, 99]) assert.notEqual(composePhase(binding, native, host, [{ ...command, code }]).outcome, "native-validated");
    assert.notEqual(composePhase(binding, native, { ...host, cleanupComplete: false }, [command]).outcome, "native-validated");
    rmSync(join(folder, "api/fastapi/p1-page/sat256-boundary.json"));
    assert.notEqual((await inspectNative(binding, folder)).status, "failed");
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
});

test("timed raw replay refuses exit99 without attributable complete native evidence", () => {
  const root = "api/fastapi/p1-page", boundary = `${root}/sat256-boundary.json`;
  const changes = [
    (f) => { const r = f.reader.readJson(boundary); r.exit.code = 1; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.exit.expired = true; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.exit.interrupted = true; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.exit.signal = "SIGTERM"; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.errors.push({ stage: "sampler stop", message: "incomplete" }); f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.errors.push({ stage: "summary copy", message: "failed" }); f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.after.load.state.OOMKilled = true; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.after.runtime.restarts = 1; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); delete r.after.runtime.state.Paused; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.after.upstream.state.Running = false; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.after.load.state.FinishedAt = r.after.load.state.StartedAt; f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(boundary); r.after.load.command.push("--no-thresholds"); f.put(boundary, r); },
    (f) => { const r = f.reader.readJson(`${root}/sat256-cpu-counters.json`); r.after[`${f.summary.runId}-fastapi`] = 0; f.put(`${root}/sat256-cpu-counters.json`, r); },
    (f) => { const r = f.reader.readJson(`${root}/sat256-stats.log.json`); r.samples[`${f.summary.runId}-k6`][0].cpu = 400; f.put(`${root}/sat256-stats.log.json`, r); },
    (f) => { f.put(`${root}/sat256-stats.log`, '{"Name":'); },
    (f) => { f.put(`${root}/sat256-stats.log`, f.reader.readText(`${root}/sat256-stats.log`).replace('"50%"', '"50garbage%"')); },
    (f) => { f.files.delete(boundary); },
    (f) => { f.files.delete(`${root}/sat256.json`); },
    (f) => { f.summary.apps.fastapi.phases["api-page"].sat256.failed.max++; },
    (f) => { f.summary.apps.fastapi.runs["api-page"].pop(); },
    (f) => { f.summary.targetFailures = []; },
    (f) => { f.summary.complete = true; },
    (f) => { f.summary.apps.fastapi.checks.api.jsonRecords = 499; },
    (f) => { f.summary.cleanupFailures.push({ resource: "app", error: "retained" }); },
    (f) => { f.summary.apps.fastapi.failures = [{ stage: "app logs", error: "incomplete" }]; },
    (f) => { f.put("cleanup.json", { runId: f.summary.runId, containers: ["still-owned"], networks: [] }); },
    (f) => { f.summary.savedEvidence.schema = "catalog-saved-evidence/v2"; },
  ];
  for (const [index, mutate] of changes.entries()) {
    const f = timedFixture(fixture()); mutate(f);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), undefined, `negative ${index}`);
  }
});

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

test("catalog negative replay binds retained tool images to the checkout of its measured commit", () => {
  const f = failedFixture();
  assert.equal(replayCatalog(f.summary, f.reader, f.commit).attemptComplete, true, "the measuring checkout replays its own evidence");
  // The same evidence as a checkout still pinned to the Debian 12 upstream image wrote it.
  const earlier = "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1";
  f.summary.tools.upstream.image = earlier; f.put("tools.json", f.summary.tools);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), (e) => e.message.includes(
    `retained upstream image is not this checkout's pin ${upstreamImage}; verify from a checkout of the measured commit ${f.commit}`)
    && !e.message.includes(earlier));
});

// Each case changes only an image reference: the refusal names the pin and hint, never the saved text.
const savedImage = "node:SAVED-IMAGE-CANARY";
const pinRefusal = (tool, pin, commit) => (e) => e instanceof ImagePinRefusal
  && e.message === `retained ${tool} image is not this checkout's pin ${pin}; verify from a checkout of the measured commit ${commit}`
  && !inspect(e).includes(savedImage);
const editTools = (f, edit) => { const tools = structuredClone(f.summary.tools); edit(tools); f.put("tools.json", tools); };
test("catalog replay refuses a retained tool image other than the pin by the pin and hint, not the saved text", () => {
  const complete = () => { const f = fixture(); assert.equal(replayCatalog(f.summary, f.reader, f.commit).baseline, true); return f; };
  let f = complete();
  f.summary.tools.k6.image = savedImage; f.put("tools.json", f.summary.tools);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), pinRefusal("k6", k6Image, f.commit), "k6 in the summary and its sidecar");
  f = complete(); editTools(f, (tools) => { tools.k6.image = savedImage; });
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), pinRefusal("k6", k6Image, f.commit), "k6 in the sidecar only");
  for (const [tool, pin] of [["upstream", upstreamImage], ["checker", checkerImage]]) {
    f = failedFixture(); assert.equal(replayCatalog(f.summary, f.reader, f.commit).attemptComplete, true);
    editTools(f, (tools) => { tools[tool].image = savedImage; });
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), pinRefusal(tool, pin, f.commit), `${tool} in a gated attempt's sidecar only`);
  }
});

test("catalog replay still refuses a non-pin tool sidecar difference, naming the field and not the saved text", () => {
  for (const [make, edit, field] of [[fixture, (tools) => { tools.upstream.imageId = savedImage; }, "upstream.imageId"],
    [fixture, (tools) => { tools.k6.note = savedImage; }, "k6.(unexpected field)"],
    [fixture, (tools) => { tools.SAVEDKEYCANARY = { image: 1 }; }, "(unexpected field)"],
    [fixture, (tools) => { tools.k6.SAVEDKEYCANARY = 1; }, "k6.(unexpected field)"],
    [failedFixture, (tools) => { tools.checker.execution.Cmd = [savedImage]; }, "checker.execution.Cmd"]]) {
    const f = make(); editTools(f, edit);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), (e) => !(e instanceof ImagePinRefusal)
      && e.message === `tool observations differ at ${field}` && !inspect(e).includes(savedImage) && !inspect(e).includes("SAVEDKEYCANARY"), field);
  }
});

test("catalog verifier passes a pin refusal through with its hint and keeps every other failure generic", () => {
  const folder = mkdtempSync(join(tmpdir(), "catalog-pin-refusal-"));
  try {
    const save = (f) => { for (const [key, value] of f.files) { mkdirSync(dirname(join(folder, key)), { recursive: true }); writeFileSync(join(folder, key), value); } };
    let f = fixture(); save(f);
    const input = { folder, round: "c1", commit: f.commit };
    assert.equal(validateSaved(input).status, "verified");
    f.summary.tools.k6.image = savedImage; f.put("tools.json", f.summary.tools); f.put("summary.json", f.summary); save(f);
    const pinned = validateSaved(input);
    assert.deepEqual(pinned, { status: "invalid", complete: false,
      errors: [`retained k6 image is not this checkout's pin ${k6Image}; verify from a checkout of the measured commit ${f.commit}`] });
    assert.ok(!JSON.stringify(pinned).includes(savedImage));
    f = fixture(); editTools(f, (tools) => { tools.upstream.imageId = savedImage; }); save(f);
    assert.deepEqual(validateSaved(input), { status: "invalid", complete: false, errors: ["native evidence invalid or contradictory"] });
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
});

const boundaryFile = "fixture/corten/checker.json";
test("catalog lean profile is bound to the saved runtime without relabeling historical boundaries", () => {
  const f = failedFixture();
  const original = JSON.parse(f.files.get(boundaryFile));
  verifyCheckBoundary(original, f.summary, "corten", "fixture", true);
  f.summary.measurement.leanProfile = { name: leanProfile, apps: f.summary.group.apps };
  assert.throws(() => verifyCheckBoundary(original, f.summary, "corten", "fixture", true), /lean profile/);
  const lean = structuredClone(original);
  lean.runtime.Config.Env.push(`PROFILE=${leanProfile}`);
  verifyCheckBoundary(lean, f.summary, "corten", "fixture", true);
  const standalone = { ...f.summary, group: undefined };
  assert.throws(() => verifyCheckBoundary(lean, standalone, "corten", "fixture", true), /command differs/);
  const current = structuredClone(lean);
  current.checker.Config.Cmd.push("corten");
  current.checker.Args.push("corten");
  verifyCheckBoundary(current, standalone, "corten", "fixture", true);
  assert.throws(() => verifyCheckBoundary(current, f.summary, "corten", "fixture", true), /command differs/);
  for (const value of ["PROFILE=matched", "PROFILE=default"]) {
    const changed = structuredClone(lean);
    changed.runtime.Config.Env.push(value);
    assert.throws(() => verifyCheckBoundary(changed, f.summary, "corten", "fixture", true), /lean profile/);
  }
  f.summary.measurement.leanProfile = { name: leanProfile, apps: ["corten"] };
  assert.throws(() => verifyCheckBoundary(lean, f.summary, "corten", "fixture", true), /lean configuration/);
});
const overlays = [
  ["checker", "/repo/bench/catalog/check.mjs"], ["runtime", "/app"], ["upstream", "/bench/catalog/upstream.mjs"],
].map(([role, Destination]) => ({ name: `${role} source overlay`, mutate: (p) => {
  p[role].mounts.push({ Type: "bind", Source: "/unreviewed/source", Destination, RW: false });
} }));
const executionOverrides = [
  ...["checker", "runtime", "upstream"].flatMap((role) => [
    { name: `${role} missing required command`, mutate: (p) => { delete p[role].Config.Cmd; } },
    { name: `${role} null required command`, mutate: (p) => { p[role].Config.Cmd = null; } },
    { name: `${role} malformed command`, mutate: (p) => { p[role].Config.Cmd = "node"; } },
    { name: `${role} null-byte command`, mutate: (p) => { p[role].Config.Cmd = ["node\0evil"]; } },
  ]),
  { name: "upstream command prefix", mutate: (p) => { p.upstream.Config.Cmd = ["node", "--eval", "process.exit(1)", "/bench/catalog/upstream.mjs"]; } },
  { name: "upstream matching substituted command and argv", mutate: (p) => {
    p.upstream.Config.Cmd = ["node", "--eval", "process.exit(1)", "/bench/catalog/upstream.mjs"];
    p.upstream.Args = [...p.upstream.Config.Cmd];
  } },
  { name: "runtime substituted image command", mutate: (p) => { p.runtime.Config.Cmd = ["/unreviewed/app"]; p.runtime.Args = ["/unreviewed/app"]; } },
  ...["checker", "runtime", "upstream"].flatMap((role) => [
    { name: `${role} entrypoint override`, mutate: (p) => { p[role].Config.Entrypoint = ["/unreviewed/entrypoint"]; } },
    { name: `${role} executable path`, mutate: (p) => { p[role].Path = "/unreviewed/executable"; } },
    { name: `${role} executable arguments`, mutate: (p) => { p[role].Args = ["--eval", "process.exit(1)"]; } },
  ]),
];

test("catalog boundary projection retains actual image and container execution without unrelated configuration", () => {
  const proof = failedFixture().reader.readJson(boundaryFile);
  const info = proof.upstream;
  const projected = checkBoundaryEvidence({ ...info, Mounts: info.mounts, NetworkSettings: { Networks: { native: {} } },
    Config: { ...info.Config, Env: [...info.Config.Env, "UNRELATED=SYNTHETIC_PRIVATE_SENTINEL"],
      Labels: { ...info.Config.Labels, unrelated: "SYNTHETIC_PRIVATE_SENTINEL" } } });
  assert.equal(projected.Path, info.Path); assert.deepEqual(projected.Args, info.Args);
  assert.deepEqual(projected.Config.Entrypoint, info.Config.Entrypoint); assert.deepEqual(projected.Config.Cmd, info.Config.Cmd);
  assert.deepEqual(imageCommandEvidence({ Config: { ...info.Config, Env: ["SYNTHETIC_PRIVATE_SENTINEL"] } }),
    { Entrypoint: info.Config.Entrypoint, Cmd: info.Config.Cmd });
  assert.ok(!JSON.stringify(projected).includes("SYNTHETIC_PRIVATE_SENTINEL"));
});

test("catalog checker image Config must be an object before optional defaults reach replay", async (t) => {
  const f = failedFixture(), proof = f.reader.readJson(boundaryFile);
  const projectAndReplay = (Config) => {
    f.summary.tools.checker.execution = JSON.parse(JSON.stringify(imageCommandEvidence({ Config })));
    verifyCheckBoundary(proof, f.summary, "corten", "fixture", true);
  };
  for (const Config of [{}, { Entrypoint: null, Cmd: null }]) projectAndReplay(Config);
  for (const Config of [undefined, null, [], "malformed", false, true, 0, 42]) {
    await t.test(`reject ${JSON.stringify(Config) ?? "missing"}`, () => {
      assert.throws(() => projectAndReplay(Config), /image configuration missing/);
    });
  }
});

test("catalog optional Docker defaults are retained as null through projection and replay", () => {
  for (const Config of [{ Entrypoint: ["k6"] }, { Entrypoint: ["k6"], Cmd: null }, { Cmd: ["node"] }, { Entrypoint: null, Cmd: ["node"] }]) {
    assert.deepEqual(JSON.parse(JSON.stringify(imageCommandEvidence({ Config }))),
      { Entrypoint: Config.Entrypoint ?? null, Cmd: Config.Cmd ?? null });
  }
  assert.throws(() => imageCommandEvidence({}));
  const f = failedFixture();
  for (const [path, bytes] of f.files) if (path.endsWith("/checker.json")) {
    const proof = JSON.parse(bytes), info = proof.checker;
    delete info.Config.Entrypoint;
    proof.checker = checkBoundaryEvidence({ ...info, Mounts: info.mounts,
      NetworkSettings: { Networks: Object.fromEntries((info.networks ?? []).map((name) => [name, {}])) } });
    assert.equal(proof.checker.Config.Entrypoint, null);
    f.put(path, proof);
  }
  assert.equal(replayCatalog(f.summary, f.reader, f.commit).attemptComplete, true);
  const proof = f.reader.readJson(boundaryFile);
  delete proof.upstream.Config.Cmd;
  proof.upstream = checkBoundaryEvidence({ ...proof.upstream, Mounts: proof.upstream.mounts,
    NetworkSettings: { Networks: Object.fromEntries(proof.upstream.networks.map((name) => [name, {}])) } });
  assert.equal(proof.upstream.Config.Cmd, null);
  f.put(boundaryFile, proof);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
});
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
  for (const { name, mutate } of [...overlays, ...mounts, ...participantStates, ...executionOverrides]) await t.test(name, () => {
    const f = failedFixture(), proof = JSON.parse(f.files.get(boundaryFile));
    mutate(proof); f.put(boundaryFile, proof);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
  });
});

test("catalog saved API and isolated bridge reject source overlays and interrupted participants", async (t) => {
  for (const { name, mutate } of [...overlays, ...participantStates, ...executionOverrides]) await t.test(name, async () => {
    const f = failedFixture(), proof = JSON.parse(f.files.get(boundaryFile));
    mutate(proof); f.put(boundaryFile, proof);
    const folder = mkdtempSync(join(tmpdir(), "catalog-invalid-boundary-"));
    try {
      for (const [path, bytes] of f.files) { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), bytes); }
      const saved = validateSaved({ folder, round: f.summary.round, commit: f.commit });
      assert.equal(saved.status, "invalid"); assert.equal(saved.complete, false);
      const b = { request: { group: "catalog-page", round: f.summary.round, commit: f.commit },
        selection: { apps: f.summary.group.apps, contractSha256: f.summary.group.contractSha256 },
        execution: { effectiveOptions: f.summary.options }, resources: { requestedCpuEnv: {}, expectedCpus: f.summary.measurement.cpus } };
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
      const b = { request: { group: "catalog-page", round: f.summary.round, commit: f.commit },
        selection: { apps: f.summary.group.apps, contractSha256: f.summary.group.contractSha256 },
        execution: { effectiveOptions: f.summary.options }, resources: { requestedCpuEnv: {}, expectedCpus: f.summary.measurement.cpus } };
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
  fake.kill = (signal) => { setImmediate(() => fake.emit("close", null, signal)); return true; };
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

test("stats retains its raw prefix and fails when an exited client's pipes never close", async () => {
  const folder = mkdtempSync(join(tmpdir(), "catalog-stats-held-pipe-")), path = join(folder, "stats.log");
  const old = childProcess.spawn;
  const fake = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref() { this.unreferenced = true; } });
  const signals = [];
  fake.kill = (signal) => { signals.push(signal); return true; };
  childProcess.spawn = () => fake; syncBuiltinESMExports();
  let deadline, stopping;
  try {
    const sampler = sampleStats(["app"], path, 10, { termGraceMs: 5, pipeGraceMs: 15 });
    const prefix = '{"Name":"app","CPUPerc":"50%","MemUsage":"8MiB / 1GiB"}\n';
    fake.stdout.write(prefix);
    fake.exitCode = 0;
    fake.emit("exit", 0, null);
    stopping = sampler.stop();
    await assert.rejects(Promise.race([stopping, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("test stop observation expired")), 400);
    })]), (error) => {
      assert.match(error.message, /stats client pipes did not close/);
      assert.equal(error.errors[0].kind, "pipe-release-timeout");
      const errors = statsPhaseErrors(error);
      assert.deepEqual(errors.map(({ step, kind }) => [step, kind]), [["sampler", "pipe-release-timeout"]]);
      const at = Date.parse(errors[0].at);
      const seen = { pass: 1, phase: "fixed", phaseStart: new Date(at - 5000).toISOString(),
        app: { Running: false, OOMKilled: false, ExitCode: 1, FinishedAt: new Date(at - 1000).toISOString() } };
      assert.throws(() => phaseEnd({ ...seen, errors }), /pipes did not close/);
      return true;
    });
    assert.deepEqual(signals, [], "do not signal an already exited child");
    assert.ok(fake.stdout.destroyed && fake.stderr.destroyed && fake.unreferenced);
    assert.equal(readFileSync(path, "utf8"), prefix);
    assert.equal(existsSync(`${path}.json`), false, "do not summarize a prefix even if it ends in a valid row");
  } finally {
    clearTimeout(deadline); fake.emit("close", 0); await stopping?.catch(() => {});
    fake.stdout.destroy(); fake.stderr.destroy();
    childProcess.spawn = old; syncBuiltinESMExports();
    assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true });
  }
});

const samplerStopSignal = process.platform === "win32" ? "SIGTERM" : "SIGHUP";
for (const scenario of ["EOF before stop", "connect during stop", "nonzero during stop", "unsolicited zero exit",
  "same signal observed before stop", "zero exit racing requested signal", "expected shutdown signature", "numeric signal status", "wrong signal"]) {
  test(`stats transport and shutdown: ${scenario}`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "catalog-stats-transport-")), path = join(folder, "stats.log");
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
    const close = (code, signal = null) => { fake.emit("exit", code, signal); fake.emit("close", code, signal); };
    const spawned = t.mock.method(childProcess, "spawn", () => fake);
    syncBuiltinESMExports();
    t.after(() => {
      spawned.mock.restore(); syncBuiltinESMExports();
      fake.stdout.destroy(); fake.stderr.destroy();
      assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true });
    });
    const app = { Running: false, OOMKilled: false, ExitCode: 1, FinishedAt: new Date(Date.now() - 1000).toISOString() };
    const seen = { pass: 1, phase: "fixed", phaseStart: new Date(Date.now() - 5000).toISOString(), app };
    fake.kill = (signal) => {
      assert.equal(signal, samplerStopSignal);
      // The kernel can accept the signal after exit but before Node reports it.
      if (scenario === "zero exit racing requested signal") return true;
      setImmediate(() => {
        if (scenario === "connect during stop") fake.stderr.write("error during connect: synthetic-private-detail\n");
        if (scenario === "nonzero during stop") close(1);
        else if (scenario === "numeric signal status") close(process.platform === "win32" ? 143 : 129);
        else if (scenario === "wrong signal") close(null, "SIGINT");
        else close(null, signal);
      });
      return true;
    };
    const sampler = sampleStats(["app"], path, 10);
    fake.stdout.write('{"Name":"app","CPUPerc":"50%","MemUsage":"8MiB / 1GiB"}\n');
    if (scenario === "EOF before stop") fake.stderr.write("unexpected EOF\n");
    if (scenario === "unsolicited zero exit") close(0);
    if (scenario === "same signal observed before stop") close(null, samplerStopSignal);
    if (scenario === "zero exit racing requested signal") setImmediate(() => close(0));
    const stopping = sampler.stop();
    if (scenario === "expected shutdown signature") {
      assert.equal((await stopping).app.samples, 1);
      assert.deepEqual(phaseEnd(seen), { pass: 1, phase: "fixed", exitCode: 1, oomKilled: false });
    } else {
      await assert.rejects(stopping, (error) => {
        const stderr = scenario === "EOF before stop" || scenario === "connect during stop";
        const errors = statsPhaseErrors(error);
        assert.deepEqual(errors.map(({ step, kind }) => [step, kind]), [["sampler", stderr ? "client-stderr" : "client-process"]]);
        assert.throws(() => phaseEnd({ ...seen, errors }), stderr ? /wrote to stderr/ : /client process failed/);
        assert.doesNotMatch(error.message, /synthetic-private-detail/);
        return true;
      });
      assert.equal(existsSync(`${path}.json`), false);
    }
  });
}

for (const failure of ["stop signal throw", "KILL throw", "emitted signal error", "emitted spawn error", "deadline", "exit race", "forced kill"]) {
  test(`stats sampler refuses ${failure} despite app exit`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "catalog-stats-shutdown-")), path = join(folder, "stats.log");
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
    const prefix = '{"Name":"app","CPUPerc":"50%","MemUsage":"8MiB / 1GiB"}\n';
    const privateDetail = "synthetic-private-process-detail";
    const close = () => setImmediate(() => { fake.emit("exit", 0); fake.emit("close", 0); });
    const spawned = t.mock.method(childProcess, "spawn", () => fake);
    syncBuiltinESMExports();
    t.after(() => {
      spawned.mock.restore(); syncBuiltinESMExports();
      fake.stdout.destroy(); fake.stderr.destroy();
      assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true });
    });
    let allowDeadline;
    const startStop = new Promise((resolve) => { allowDeadline = resolve; });
    fake.kill = (signal) => {
      if ((failure === "KILL throw" || failure === "forced kill") && signal === samplerStopSignal) return true;
      close();
      allowDeadline();
      if (failure === "stop signal throw" || failure === "KILL throw") throw new Error(privateDetail);
      if (failure === "emitted signal error") {
        fake.emit("error", Object.assign(new Error(privateDetail), { syscall: "kill", code: "EPERM" }));
        return false;
      }
      return failure !== "exit race";
    };
    const sampler = sampleStats(["app"], path, failure === "deadline" ? 0 : 10, { termGraceMs: 5, pipeGraceMs: 100 });
    fake.stdout.write(prefix);
    if (failure === "emitted spawn error") fake.emit("error", Object.assign(new Error(privateDetail), { syscall: "spawn docker", code: "ENOENT" }));
    if (failure === "deadline") await startStop;
    await assert.rejects(sampler.stop(), (error) => {
      const errors = statsPhaseErrors(error);
      const at = Date.parse(errors[0].at);
      const seen = { pass: 1, phase: "fixed", phaseStart: new Date(at - 5000).toISOString(),
        app: { Running: false, OOMKilled: false, ExitCode: 1, FinishedAt: new Date(at - 1000).toISOString() }, errors };
      assert.throws(() => phaseEnd(seen), /docker stats client signal failed|docker stats client process failed|stats sampler exceeded its deadline/);
      assert.deepEqual([errors[0].step, errors[0].kind], ["sampler", failure === "deadline" ? "deadline"
        : ["emitted spawn error", "exit race", "forced kill"].includes(failure) ? "client-process" : "shutdown-signal"]);
      assert.doesNotMatch(error.message, /synthetic-private-process-detail/);
      return true;
    });
    assert.equal(existsSync(`${path}.json`), false);
    assert.equal(readFileSync(path, "utf8"), prefix);
  });
}
