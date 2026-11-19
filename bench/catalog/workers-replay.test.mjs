import assert from "node:assert/strict";
import test from "node:test";
import { legacyRound, workerRound, indexRound } from "./workers-fixture.mjs";
import { verifyTimedPhase } from "./timed.mjs";
import { loggedReceipt, replayCatalog } from "./raw.mjs";
import { stdoutReceipt } from "./check.mjs";
import { summarizeSamples } from "./stats.mjs";
import { digest, verifyControl } from "./apparatus.mjs";
import { inspectCatalog, renderCatalog } from "./report.mjs";
import { preflightArtifacts, requiredRoundArtifacts, verifyArtifactIndex, verifyPreflight } from "./preflight.mjs";
import { groupDescriptor } from "./group.mjs";

const failure = { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 1 };
const prefix = "api/fastapi/p1-page";
function phase(f, name = "sat256") {
  return verifyTimedPhase(f.summary, { app: "fastapi", source: "api", target: "page", phase: name,
    seconds: f.summary.options.duration, instance: f.reader.readJson(`${prefix}/container.json`) }, {
    readJson: (key) => f.reader.readJson(`${prefix}/${key}`), readText: (key) => f.reader.readText(`${prefix}/${key}`),
  });
}
function stats(f, key, cpu) {
  const file = `${prefix}/sat256-stats.log.json`, value = f.reader.readJson(file);
  for (const row of value.samples[`${f.summary.runId}-${key}`]) row.cpu = cpu;
  value.summary = Object.fromEntries(Object.entries(value.samples).map(([name, rows]) => [name, summarizeSamples(rows)]));
  f.put(file, value);
  f.put(`${prefix}/sat256-stats.log`, Object.entries(value.samples).flatMap(([Name, rows]) => rows.map((v) => JSON.stringify({ Name, CPUPerc: `${v.cpu}%`, MemUsage: "8MiB / 1GiB" }))).join("\n") + "\n");
}

test("safe old-limit reproduction: a 100%-CPU single loop fails despite its two-core allocation", () => {
  const f = legacyRound(failure);
  assert.equal(f.summary.measurement.cpus.api.quota, 2);
  stats(f, "upstream", 100);
  assert.throws(() => phase(f), /busy upstream cannot establish/);
});

test("v4 round replays both positive and attributed negative outcomes with first-host admission and joined report", () => {
  for (const negative of [null, failure]) {
    const f = workerRound(negative), report = replayCatalog(f.summary, f.reader, f.commit);
    assert.equal(report.rawVerified, true); assert.equal(report.apparatusPreflight, "passed");
    assert.equal(report.baseline, !negative); assert.equal(report.attemptComplete, true);
    assert.equal(report.comparisonEligibleApps.includes("fastapi"), !negative);
    assert.equal(inspectCatalog(f.summary, f.commit).attemptComplete, true);
    assert.match(renderCatalog(report), negative ? /not a baseline/ : /COMPLETE/);
  }
});

test("wide generator raw replay checks twelve CPUs for k6, four for checker, and headroom for successful targets", () => {
  const f = workerRound(null, { wideGenerator: true });
  assert.equal(replayCatalog(f.summary, f.reader, f.commit).baseline, true);
  const saved = f.reader.readJson("preflight.json");
  assert.equal(saved.binding.loadLayout, "c16-generator-v1");
  const checkerKey = "fixture/corten/checker.json", checker = f.reader.readJson(checkerKey);
  assert.equal(checker.checker.HostConfig.NanoCpus, 4e9);
  assert.equal(checker.checker.HostConfig.CpusetCpus, "4-7");
  const load = f.reader.readJson(`${prefix}/sat256-boundary.json`).after.load;
  assert.equal(load.budget.NanoCpus, 12e9); assert.equal(load.budget.CpusetCpus, "4-15");
  assert.equal(phase(f).resources[`${f.summary.runId}-k6`].cpuMaxPct, 391.36);
  const checkerText = f.reader.readText(checkerKey);
  checker.checker.HostConfig.NanoCpus = 12e9;
  f.put(checkerKey, checker); indexRound(f);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
  f.put(checkerKey, checkerText);
  const coldKey = `${prefix}/cold-probe.json`, originalCold = f.reader.readText(coldKey);
  for (const [field, value, message] of [["cpuset", "4-15", /probe affinity/], ["quotaNanoCpus", 12e9, /probe quota/]]) {
    f.put(coldKey, { ...JSON.parse(originalCold), [field]: value }); indexRound(f);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), message);
  }
  f.put(coldKey, originalCold);
  const preflightText = f.reader.readText("preflight.json");
  delete saved.binding.loadLayout; f.put("preflight.json", saved); indexRound(f);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /preflight source\/recipe differs/);
  f.put("preflight.json", preflightText); stats(f, "k6", 960); indexRound(f);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /generator.*headroom/);
});

test("historical successful phases above 320% remain replayable after a valid four-core preflight", () => {
  const f = workerRound(); stats(f, "k6", 391.36); indexRound(f);
  assert.equal(replayCatalog(f.summary, f.reader, f.commit).baseline, true);
});

test("native document header evidence cannot be relabeled, omitted, weakened or detached from checker execution", () => {
  const current = groupDescriptor("catalog-page"), historical = groupDescriptor("catalog-page", { historical: true });
  const old = workerRound(null, { historical: true });
  assert.equal(replayCatalog(old.summary, old.reader, old.commit, historical.contractSha256).group.documentHeaders, undefined);
  assert.throws(() => replayCatalog(old.summary, old.reader, old.commit, current.contractSha256), /requested contract/);
  const f = workerRound();
  assert.equal(replayCatalog(f.summary, f.reader, f.commit, current.contractSha256).group.documentHeaders, current.documentHeaders);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit, historical.contractSha256), /requested contract/);
  const app = "express", source = "api", base = `${source}/${app}`;
  const original = structuredClone(f.summary.apps[app].checks[source]);
  const putCheck = (check) => {
    const { qualification, ...native } = check;
    f.summary.apps[app].checks[source] = check;
    f.put(`${base}/qualification.json`, check);
    f.put(`${base}/checks.json`, native);
    f.put(`${base}/checks.log`, `${stdoutReceipt(native)}\n`);
    indexRound(f);
  };
  for (const mutate of [
    (check) => { check.documentHeaders = true; },
    (check) => { check.documentHeaders.pop(); },
    (check) => { check.documentHeaders[0].path = "/api/catalog/record_1"; },
    (check) => { check.documentHeaders.at(-1).headers.find((h) => h.name === "referrer-policy").value = "no-referrer, unsafe-url"; },
  ]) {
    const check = structuredClone(original); mutate(check); putCheck(check);
    assert.match(inspectCatalog(f.summary).warnings.join("\n"), /express api: missing or invalid document header observations/);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /not complete/);
  }
  putCheck(structuredClone(original));
  const log = loggedReceipt(f.reader.readText(`${base}/checks.log`));
  log.documentHeaders[0].headers.find((h) => h.name === "cache-control").value = "private, no-cache";
  f.put(`${base}/checks.log`, `${stdoutReceipt(log)}\n`); indexRound(f);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /checker stdout receipt differs/);
  putCheck(structuredClone(original));
  const key = `${base}/checker.json`;
  const boundary = f.reader.readJson(key);
  boundary.checker.Config.Cmd.pop(); boundary.checker.Args.pop();
  f.put(key, boundary); indexRound(f);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /command differs/);
});

test("native stdout receipt is found among the checker's own log lines and is never guessed at", () => {
  const retry = "retry goto: net::ERR_NETWORK_CHANGED (#497)", skip = "skip console error: Failed to load resource: net::ERR_NETWORK_CHANGED (#904)";
  const base = "api/express", key = `${base}/checks.log`;
  const f = workerRound(), native = f.reader.readJson(`${base}/checks.json`), receipt = stdoutReceipt(native);
  const report = replayCatalog(f.summary, f.reader, f.commit);
  const replay = (log) => { f.put(key, log); indexRound(f); return replayCatalog(f.summary, f.reader, f.commit); };
  for (const log of [`${retry}\n${receipt}\n`, `${receipt}\n${skip}\n`, `${retry}\n${skip}\r\n${receipt}\r\n${retry}\n`, receipt]) {
    assert.deepEqual(replay(log), report);
    assert.equal(f.reader.readText(key), log, "diagnostic lines are kept as logged");
  }
  const changed = structuredClone(native); changed.documentHeaders[0].status = 500;
  const failed = { failure: { schema: "synthetic" } };
  for (const [log, error] of [
    ["", /receipt missing/],
    [`${retry}\n${skip}\n`, /receipt missing/],
    [`${JSON.stringify(native, null, 2)}\n`, /receipt missing/],
    [`${retry}\n${JSON.stringify(native)}\n`, /receipt missing/],
    [`${receipt}\n${retry}\n${receipt}\n`, /receipt repeated/],
    [`${receipt}\n${stdoutReceipt(changed)}\n`, /receipt repeated/],
    [`${retry} ${receipt}\n`, /not framed on its own line/],
    [`${receipt}${skip}\n`, /JSON/],
    [`${receipt.slice(0, -1)}\n`, /JSON/],
    [`${stdoutReceipt(changed)}\n`, /checker stdout receipt differs/],
    [`${stdoutReceipt(failed)}\n`, /checker stdout receipt differs/],
    [`${stdoutReceipt({ ...native, extra: true })}\n`, /checker stdout receipt differs/],
  ]) assert.throws(() => replay(log), error, JSON.stringify(log.slice(0, 80)));
  assert.equal(loggedReceipt(`${retry}\n${receipt}\n${skip}\n`).documentHeaders.length, native.documentHeaders.length);
  const old = workerRound(null, { historical: true }), historical = groupDescriptor("catalog-page", { historical: true }).contractSha256;
  const oldReport = replayCatalog(old.summary, old.reader, old.commit, historical);
  for (const log of ["synthetic checks\n", `${receipt}\n${receipt}\n`, "{"]) {
    old.put(key, log); indexRound(old);
    assert.deepEqual(replayCatalog(old.summary, old.reader, old.commit, historical), oldReport, "historical checks.log stays a diagnostic");
  }
});

test("v4 phase accepts proven aggregate under 160 but not a busy worker, coordinator or generator", () => {
  const f = workerRound(failure); stats(f, "upstream", 120);
  assert.equal(phase(f).metrics.outcome, "failed");
  const file = `${prefix}/sat256-workers.json`, original = f.reader.readText(file);
  for (const index of [0, 1, 2]) {
    const e = JSON.parse(original), rows = e.processes[index].samples, start = rows[0].wallMs, counter = rows[0].cpuUsec;
    for (const row of rows) row.cpuUsec = counter + (row.wallMs - start) * 800;
    f.put(file, e); assert.throws(() => phase(f), /busy upstream worker\/coordinator/);
  }
  f.put(file, original); stats(f, "upstream", 160); assert.throws(() => phase(f), /busy upstream container/);
  stats(f, "upstream", 120); stats(f, "k6", 320); assert.throws(() => phase(f), /generator.*headroom/);
});

test("v4 phase fails closed on missing epochs, lost counts/workers, source, identity, counter and sample gaps", () => {
  const f = workerRound(failure), file = `${prefix}/sat256-workers.json`, original = f.reader.readText(file);
  const mutations = [
    [(e) => { delete e.before.epoch; }, /epoch missing/],
    [(e) => { e.before.workers[1].epoch++; }, /epoch acknowledgement/],
    [(e) => { e.before.workers[1].configuration = "f".repeat(64); }, /override\/status acknowledgement/],
    [(e) => { e.after.workers[0].requests.record_1 = 4; }, /aggregate counts/],
    [(e) => { e.after.workers.pop(); }, /acknowledgements missing/],
    [(e) => { e.processes.pop(); }, /inventory incomplete/],
    [(e) => { e.binding.sourceSha256 = "f".repeat(64); }, /binding differs/],
    [(e) => { e.binding.container = "f".repeat(64); }, /binding differs/],
    [(e) => { e.binding.source = "fixture"; }, /binding differs/],
    [(e) => { e.processes[1].identity.start = "88"; }, /identity differs/],
    [(e) => { e.processes[1].samples[1].cpuUsec = 0; }, /counter reversed/],
    [(e) => { e.processes[2].samples.splice(1, 5); }, /sample gap/],
    [(e) => { e.processes[0].samples.pop(); }, /window incomplete/],
    [(e) => { e.processes[1].samples[1].endNs = "0"; }, /read window invalid/],
    [(e) => { e.processes[1].identity.native = false; }, /identity differs|not native/],
  ];
  for (const [mutate, expected] of mutations) { const evidence = JSON.parse(original); mutate(evidence); f.put(file, evidence); assert.throws(() => phase(f), expected); }
});

test("whole-round v4 replay requires the exact source closure, first-host preflight, unchanged recipe and empty cleanup", () => {
  const f = workerRound(), originals = new Map(f.files), summary = structuredClone(f.summary);
  const mutations = [
    () => f.files.delete("apparatus-source.json"),
    () => { const v = f.reader.readJson("apparatus-source.json"); delete v.files[Object.keys(v.files)[0]]; f.put("apparatus-source.json", v); f.summary.savedEvidence.apparatusSourceSha256 = digest(f.reader.readText("apparatus-source.json")); },
    () => f.files.delete("preflight/api/sat256-workers.json"),
    () => { const p = f.reader.readJson("preflight.json"); p.passed = false; f.put("preflight.json", p); },
    () => { const p = f.reader.readJson("preflight.json"); p.binding.duration--; f.put("preflight.json", p); },
    () => { const p = f.reader.readJson("preflight.json"); p.cleanup.containers.push("survivor"); f.put("preflight.json", p); },
    () => f.put("cleanup.json", { runId: f.summary.runId, containers: ["survivor"], networks: [] }),
    () => { f.summary.measurement.apparatus.workers = 3; },
  ];
  for (const mutate of mutations) {
    f.files.clear(); for (const [k, v] of originals) f.files.set(k, v); f.summary = structuredClone(summary);
    mutate();
    if (requiredRoundArtifacts(f.summary).every((key) => f.files.has(key))) indexRound(f);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit));
  }
});

test("control receipt merge is exact, not a sum that loses one worker or double-counts another", () => {
  const f = workerRound(), control = f.reader.readJson(`${prefix}/sat256-workers.json`).after;
  control.workers[0].requests.record_1 = 7; control.workers[1].requests.record_1 = 9; control.requests.record_1 = 16;
  assert.equal(verifyControl(control).length, 3);
  control.requests.record_1 = 14; assert.throws(() => verifyControl(control), /aggregate counts/);
});

test("internally consistent per-phase worker replacements, counter resets and epoch rollbacks fail round continuity", () => {
  const f = workerRound(), file = `${prefix}/sat256-workers.json`, original = f.reader.readText(file);
  for (const [mutate, expected] of [
    [(e) => {
      for (const edge of ["before", "after"]) e[edge].workers[0].identity.start = "9000";
      e.processes[1].identity.start = "9000";
    }, /identity changed across round/],
    [(e) => { for (const p of e.processes) { const first = p.samples[0].cpuUsec; for (const r of p.samples) r.cpuUsec -= first; } }, /round counter\/window reversed/],
    [(e) => { for (const edge of ["before", "after"]) { e[edge].epoch = 1; for (const w of e[edge].workers) w.epoch = 1; } }, /epoch reset differs across round/],
  ]) {
    const e = JSON.parse(original); mutate(e); f.put(file, e);
    assert.equal(phase(f).metrics.outcome, "passed", "the negative is cross-phase, not malformed within one phase");
    indexRound(f); assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), expected);
  }
});

test("first-host admission enforces headroom even on healthy phases, with self-consistent raw hashes", () => {
  const f = workerRound(), file = "preflight/api/sat256-workers.json", e = f.reader.readJson(file), p = e.processes[1];
  const start = p.samples[0].wallMs, counter = p.samples[0].cpuUsec;
  for (const r of p.samples) r.cpuUsec = counter + (r.wallMs - start) * 800;
  f.put(file, e);
  const receipt = f.reader.readJson("preflight.json");
  receipt.hashes = Object.fromEntries(preflightArtifacts().map((key) => [key, digest(f.reader.readText(key))])); f.put("preflight.json", receipt); indexRound(f);
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /busy upstream worker\/coordinator/);
});

test("each preflight phase must use the correctness and official timing upstream, even after fully rehashing", () => {
  const prefixes = ["fixture", "api"].flatMap((source) => ["warmup", "sat256"].map((phase) => `preflight/${source}/${phase}`));
  for (const replaced of [...prefixes.map((key) => [key]), prefixes]) {
    const f = workerRound(), upstreamName = `${f.summary.runId}-upstream`, other = digest("other upstream container");
    const official = f.reader.readJson("api/corten/p1-page/sat256-boundary.json").after.upstream.id;
    assert.notEqual(other, official);
    for (const prefix of replaced) {
      const boundary = f.reader.readJson(`${prefix}-boundary.json`);
      for (const edge of ["before", "after"]) boundary[edge].upstream.id = other;
      f.put(`${prefix}-boundary.json`, boundary);
      const counters = f.reader.readJson(`${prefix}-cpu-counters.json`);
      counters.ids[upstreamName] = other; f.put(`${prefix}-cpu-counters.json`, counters);
      const workers = f.reader.readJson(`${prefix}-workers.json`);
      workers.binding.container = other; f.put(`${prefix}-workers.json`, workers);
    }
    const receipt = f.reader.readJson("preflight.json");
    receipt.hashes = Object.fromEntries(preflightArtifacts().map((key) => [key, digest(f.reader.readText(key))]));
    f.put("preflight.json", receipt); indexRound(f);
    verifyArtifactIndex(f.summary, f.reader);
    const observations = verifyPreflight(f.summary, f.reader);
    assert.equal(observations.filter((o) => o.upstreamId === other).length, replaced.length,
      "the substituted phases remain internally valid, including their rehashed receipts");
    assert.equal(f.reader.readJson("api/corten/p1-page/sat256-boundary.json").after.upstream.id, official);
    assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /preflight upstream identity changed/, replaced.join(", "));
  }
});
