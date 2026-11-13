// Saved native observations, separate from the historical summary-only report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { aggregate, phases, readLoad } from "./contract.mjs";
import { inspectCatalog, completeChecks } from "./report.mjs";
import { records } from "./fixtures.mjs";
import { qualificationIdentity } from "./group.mjs";
import { verifyRecordAttempt, verifyAttemptWindow } from "./record-attempt.mjs";
import { summarizeSamples, memoryMiB } from "./stats.mjs";
import { verifyK6Provenance } from "../load-tool.mjs";

export const rawSchema = "catalog-saved-evidence/v2";
export const upstreamImage = "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1";
export const checkerImage = `mcr.microsoft.com/playwright:v${JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).devDependencies["@playwright/test"]}-noble`;
// Keep only fields used for replay, never unrelated image environment or health logs.
export function checkBoundaryEvidence(info) {
  return { Id: info.Id, Image: info.Image, RestartCount: info.RestartCount,
    networks: Object.keys(info.NetworkSettings?.Networks ?? {}).sort(),
    mounts: info.Mounts.map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW })),
    State: Object.fromEntries(["Status", "Running", "OOMKilled", "Dead", "Paused", "Restarting", "ExitCode", "Error", "StartedAt", "FinishedAt"].map((key) => [key, info.State[key]])),
    HostConfig: Object.fromEntries(["NanoCpus", "CpusetCpus", "Memory", "NetworkMode"].map((key) => [key, info.HostConfig[key]])),
    Config: { Cmd: info.Config.Cmd, Labels: { "run.corten.catalog": info.Config.Labels?.["run.corten.catalog"] },
      Env: info.Config.Env?.filter((e) => ["CATALOG_SOURCE", "CATALOG_FIXTURE_PATH", "API_BASE"].includes(e.split("=")[0])) ?? [] } };
}
export function containerEvidence(info) {
  return { id: info.Id, imageId: info.Image, startedAt: info.State.StartedAt,
    quotaNanoCpus: info.HostConfig.NanoCpus, cpuset: info.HostConfig.CpusetCpus,
    memoryBytes: info.HostConfig.Memory,
    source: info.Config.Env.find((s) => s.startsWith("CATALOG_SOURCE="))?.slice(15),
    runId: info.Config.Labels?.["run.corten.catalog"] };
}

// Called by both the producer and saved replay. An assertion string is not proof.
export function verifyFailedCheck(attempt, source) {
  assert.equal(attempt.source, source);
  verifyRecordAttempt(attempt, records(), "/api/catalog");
  assert.equal(attempt.control?.reset?.method, "POST"); assert.equal(attempt.control.reset.path, "/__catalog/control");
  assert.deepEqual(attempt.control.reset.value, {});
  assert.equal(attempt.control?.reset?.status, 200); JSON.parse(attempt.control.reset.body);
  assert.equal(attempt.control?.observed?.status, 200);
  assert.deepEqual(JSON.parse(attempt.control.observed.body).requests, source === "api"
    ? Object.fromEntries(attempt.requests.map((r) => [r.id, 1])) : {}, "failed sweep upstream reads differ");
}

export function verifyCheckBoundary(proof, summary, app, source, failed) {
  const { runtime, checker, upstream } = proof;
  assert.deepEqual(proof.exit, { code: failed ? 1 : 0, signal: null, expired: false, interrupted: false }, "checker client lifetime incomplete");
  const entry = summary.apps[app], budget = summary.measurement.cpus;
  const checkout = summary.host?.checkout;
  assert.ok(typeof checkout === "string" && checkout.startsWith("/") && !checkout.endsWith("/") && !checkout.includes(".."), "native Linux checkout binding missing");
  const mount = (info, destination, sourcePath, writable = false) => {
    assert.deepEqual(info.mounts.filter((m) => m.Destination === destination), [{ Type: "bind", Source: sourcePath, Destination: destination, RW: writable }], "native mount differs");
  };
  const running = (info, imageId, role, memory) => {
    assert.match(info.Id, /^[a-f0-9]{64}$/); assert.equal(info.Image, imageId);
    assert.equal(info.Config.Labels?.["run.corten.catalog"], summary.runId);
    assert.equal(info.HostConfig.NanoCpus, budget[role].quota * 1e9);
    assert.equal(info.HostConfig.CpusetCpus, budget[role].cpuset ?? ""); assert.equal(info.HostConfig.Memory, memory);
    assert.equal(info.State.Running, true); assert.equal(info.State.OOMKilled, false); assert.equal(info.State.Dead, false);
    assert.ok(Date.parse(info.State.StartedAt) >= Date.parse(summary.startedAt));
  };
  running(runtime, entry.imageId, "app", 2 ** 30);
  assert.deepEqual(runtime.networks, [`${summary.runId}-net`]);
  mount(runtime, "/fixtures", `${checkout}/bench/catalog/fixtures`);
  assert.equal(containerEvidence(runtime).source, source);
  assert.ok(runtime.Config.Env.includes("CATALOG_FIXTURE_PATH=/fixtures/catalog.json"));
  assert.ok(runtime.Config.Env.includes(`API_BASE=http://${summary.runId}-upstream:8080`));
  running(upstream, summary.tools.upstream.imageId, "api", 512 * 2 ** 20);
  assert.deepEqual(upstream.networks, [`${summary.runId}-net`]);
  mount(upstream, "/fixtures", `${checkout}/bench/catalog/fixtures`); mount(upstream, "/bench", `${checkout}/bench`);
  assert.equal(upstream.Config.Cmd.at(-1), "/bench/catalog/upstream.mjs");
  assert.match(checker.Id, /^[a-f0-9]{64}$/); assert.equal(checker.Image, summary.tools.checker.imageId);
  assert.equal(checker.Config.Labels?.["run.corten.catalog"], summary.runId);
  assert.equal(checker.HostConfig.NanoCpus, budget.load.quota * 1e9);
  assert.equal(checker.HostConfig.CpusetCpus, budget.load.cpuset ?? ""); assert.equal(checker.HostConfig.Memory, 2 ** 31);
  assert.ok([`container:${runtime.Id}`, `container:${summary.runId}-${app}`].includes(checker.HostConfig.NetworkMode));
  mount(checker, "/repo", checkout); mount(checker, "/results", `${checkout}/bench/catalog/results/${summary.round}/${source}/${app}`, true);
  assert.deepEqual(checker.Config.Cmd, ["node", "/repo/bench/catalog/check.mjs", "http://127.0.0.1:8080", source, `http://${summary.runId}-upstream:8080`, "/results/checks.json"]);
  assert.equal(checker.State.Status, "exited"); assert.equal(checker.State.Running, false);
  for (const key of ["OOMKilled", "Dead", "Paused", "Restarting"]) assert.equal(checker.State[key], false);
  assert.equal(checker.State.ExitCode, failed ? 1 : 0); assert.equal(checker.State.Error, "");
  assert.equal(checker.RestartCount, 0);
  const start = Date.parse(checker.State.StartedAt), end = Date.parse(checker.State.FinishedAt);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start >= Date.parse(summary.startedAt) && end >= start
    && end <= (summary.finishedAt ? Date.parse(summary.finishedAt) : Date.now()), "checker lifetime differs");
  assert.ok([runtime, upstream].every((info) => Date.parse(info.State.StartedAt) <= start), "participant started after its checker");
  assert.equal(new Set([runtime.Id, upstream.Id, checker.Id]).size, 3, "checker/participant identities overlap");
}

export function replayCatalog(summary, { readJson, readText }, commit) {
  assert.equal(summary.savedEvidence?.schema, rawSchema, "native raw evidence version missing");
  assert.equal(summary.options?.group, "catalog-page", "raw group validation requires catalog-page");
  const report = inspectCatalog(summary, commit);
  const gated = summary.timingDisposition === "gated-functional";
  assert.ok(summary.timingDisposition === undefined || gated, "unknown timing disposition");
  if (!gated) assert.ok(report.baseline, "native summary is not complete");
  else {
    assert.ok(Object.values(report.attemptGates).every((v) => v === true), "negative attempt identity/configuration incomplete");
    assert.equal(summary.dirty, false); assert.equal(summary.complete, false); assert.equal(summary.checksPassed, false);
    assert.notEqual(summary.options.checkOnly, true); assert.deepEqual(summary.failures, []); assert.deepEqual(summary.cleanupFailures, []);
    assert.equal(summary.measurement.appMemoryBytes, 2 ** 30);
    assert.equal(summary.tools?.upstream?.image, upstreamImage); assert.equal(summary.tools?.checker?.image, checkerImage);
  }
  assert.equal(summary.commitAfter, commit);
  assert.equal(summary.dirtyAfter, false);
  assert.equal(summary.options.build, true, "image must have been built in this native run");
  const fixture = readText("fixture.json");
  assert.equal(summary.fixtureSha256, summary.savedEvidence.fixtureSha256);
  assert.equal(summary.savedEvidence.fixtureSha256, createHash("sha256").update(fixture).digest("hex"));
  const cleanup = readJson("cleanup.json");
  assert.deepEqual(cleanup, { runId: summary.runId, containers: [], networks: [] }, "owned resources remain or cleanup proof differs");
  assert.deepEqual(readJson("tools.json"), summary.tools, "tool observations differ");
  if (!gated || summary.tools.k6 !== undefined) verifyK6Provenance(summary.tools.k6);
  for (const name of ["upstream", "checker", ...(gated ? [] : ["k6"])]) assert.match(summary.tools?.[name]?.imageId, /^sha256:[a-f0-9]{64}$/);
  const outcomes = [];
  let negative = false;
  let upstreamId;
  for (const [app, entry] of Object.entries(summary.apps)) {
    let failed = false;
    if (gated) assert.deepEqual(entry.failures ?? [], []);
    assert.match(entry.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.imageBytes) && entry.imageBytes > 0);
    assert.deepEqual(readJson(`image-${app}.json`), { imageId: entry.imageId, imageBytes: entry.imageBytes, commit, built: true });
    assert.ok(readText(`build-${app}.log`).length, "missing native build log");
    for (const source of summary.group.sources) {
      const base = `${source}/${app}`;
      const checked = readJson(`${base}/qualification.json`);
      assert.deepEqual(checked, entry.checks[source], "saved checks differ");
      const { qualification, ...nativeCheck } = checked;
      assert.deepEqual(readJson(`${base}/checks.json`), nativeCheck, "native checker receipt differs");
      readText(`${base}/checks.log`);
      readText(`${base}/app.log`);
      if (gated) {
        assert.deepEqual(qualification, qualificationIdentity(summary.group, app, source, entry.imageId));
        const boundary = readJson(`${base}/checker.json`);
        verifyCheckBoundary(boundary, summary, app, source, !!checked.failure);
        upstreamId ??= boundary.upstream.Id;
        assert.equal(boundary.upstream.Id, upstreamId, "upstream identity changed across functional checks");
        if (checked.failure !== undefined) {
          assert.deepEqual(Object.keys(nativeCheck), ["failure"], "contradictory positive/negative checker receipt");
          assert.deepEqual(readJson(`${base}/checks.json.failure.json`), checked.failure);
          verifyFailedCheck(checked.failure, source); failed = negative = true;
          verifyAttemptWindow(checked.failure, { startedAt: Date.parse(boundary.checker.State.StartedAt), finishedAt: Date.parse(boundary.checker.State.FinishedAt) });
        } else assert.ok(completeChecks(checked, source), "positive peer correctness incomplete");
        for (const profile of summary.group.cases.filter((c) => c.source === source)) {
          const key = `${source}-${profile.target}`;
          assert.deepEqual(entry.runs[key] ?? [], [], "timing started despite parity failure");
          assert.deepEqual(entry.phases[key] ?? {}, {}, "aggregates present despite parity failure");
        }
        continue;
      }
      assert.equal(checked.failure, undefined, "negative checker receipt without global timing gate");
      for (const profile of summary.group.cases.filter((c) => c.source === source)) {
        const key = `${source}-${profile.target}`;
        for (const run of entry.runs[key]) {
          const raw = `${base}/p${run.pass}-${profile.target}`;
          const cold = readJson(`${raw}/cold.json`);
          assert.deepEqual(cold, run.cold, "cold summary differs");
          const probe = JSON.parse(readText(`${raw}/cold.log`).split("\n").findLast((line) => line.startsWith("{")));
          const { first200MsFromContainerStart, containerStartedAt, clock, measuredBeforeReadinessOrWarmup, ...observedCold } = cold;
          assert.deepEqual(observedCold, probe, "cold probe differs");
          const instance = readJson(`${raw}/container.json`);
          assert.equal(instance.imageId, entry.imageId);
          assert.equal(instance.source, source);
          assert.equal(instance.runId, summary.runId);
          assert.equal(instance.startedAt, containerStartedAt);
          assert.match(instance.id, /^[a-f0-9]{64}$/);
          assert.equal(instance.quotaNanoCpus, summary.measurement.cpus.app.quota * 1e9);
          assert.equal(instance.cpuset, summary.measurement.cpus.app.cpuset ?? "");
          assert.equal(instance.memoryBytes, summary.measurement.appMemoryBytes);
          readText(`${raw}/app.log`);
          let previousCounters = {};
          let previousFinishedAt = Date.parse(cold.first200At);
          for (const phase of ["warmup", ...phases]) {
            const metrics = readLoad(readJson(`${raw}/${phase}.json`));
            readText(`${raw}/${phase}.log`);
            if (phase !== "warmup") {
              const proof = readJson(`${raw}/${phase}-cpu-counters.json`);
              assert.ok(Number.isSafeInteger(proof.startedAt) && Number.isSafeInteger(proof.finishedAt)
                && proof.startedAt >= previousFinishedAt && proof.finishedAt >= proof.startedAt
                && proof.startedAt >= Date.parse(summary.startedAt) && proof.finishedAt <= Date.parse(summary.finishedAt), "invalid measured phase clock");
              previousFinishedAt = proof.finishedAt;
              const deltas = readJson(`${raw}/${phase}-cpu.json`);
              const appName = `${summary.runId}-${app}`;
              const upstreamName = `${summary.runId}-upstream`;
              const names = [appName, ...(source === "api" ? [upstreamName] : [])];
              for (const field of ["before", "after", "ids"]) assert.deepEqual(Object.keys(proof[field]).sort(), [...names].sort());
              assert.equal(proof.ids[appName], instance.id);
              if (source === "api") {
                upstreamId ??= proof.ids[upstreamName];
                assert.equal(proof.ids[upstreamName], upstreamId, "upstream container identity changed during the round");
              }
              assert.deepEqual(Object.keys(deltas).sort(), [...names].sort());
              const stats = readJson(`${raw}/${phase}-stats.log.json`);
              assert.deepEqual(Object.keys(stats.samples).sort(), [...names].sort());
              const rawStats = Object.fromEntries(names.map((name) => [name, []]));
              const statsText = readText(`${raw}/${phase}-stats.log`);
              assert.ok(statsText.endsWith("\n"), "incomplete stats record");
              for (const line of statsText.split("\n").filter((line) => line.trim())) {
                const s = JSON.parse(line);
                assert.ok(Object.hasOwn(rawStats, s.Name), "unexpected raw stats container");
                rawStats[s.Name].push({ cpu: parseFloat(s.CPUPerc), mem: memoryMiB(s.MemUsage.split("/")[0]) });
              }
              const derived = {};
              for (const name of names) {
                assert.match(proof.ids[name], /^[a-f0-9]{64}$/);
                assert.ok(Number.isSafeInteger(proof.before[name]) && proof.before[name] >= 0);
                assert.ok(Number.isSafeInteger(proof.after[name]) && proof.after[name] > proof.before[name]);
                assert.ok(previousCounters[name] === undefined || proof.before[name] >= previousCounters[name], "cumulative CPU counter moved backwards between phases");
                assert.deepEqual(deltas[name], { usec: proof.after[name] - proof.before[name] });
                const samples = stats.samples[name];
                assert.ok(samples.every((s) => s.cpu >= 0 && s.mem >= 0), "negative native sample");
                assert.deepEqual(samples.map(({ cpu, mem }) => ({ cpu, mem })), rawStats[name], "raw memory/CPU samples differ");
                assert.ok(samples.every((s, i) => Number.isSafeInteger(s.t) && s.t >= proof.startedAt && s.t <= proof.finishedAt && (!i || s.t >= samples[i - 1].t)), "native sample outside measured clock window");
                derived[name] = summarizeSamples(samples);
              }
              assert.deepEqual(stats.summary, derived, "sample aggregates differ");
              previousCounters = proof.after;
              Object.assign(metrics, derived[appName], { cpuUsec: deltas[appName].usec,
                perCpuSecond: metrics.requests / (deltas[appName].usec / 1e6),
                upstream: source === "api" ? { ...derived[upstreamName], cpuUsec: deltas[upstreamName].usec,
                  highCpu: derived[upstreamName].cpuAvgPct >= 80,
                  interpretation: "single-process upstream; a busy API may be the throughput limit, not the app" } : null });
            }
            assert.deepEqual(phase === "warmup" ? run.warmup : run.phases[phase], metrics, "load metrics differ from raw observations");
          }
        }
        for (const phase of phases) assert.deepEqual(entry.phases[key][phase], {
          ...aggregate(entry.runs[key].map((r) => r.phases[phase])), asked: summary.options.passes,
        });
      }
    }
    outcomes.push({ app, outcome: failed ? "failed" : "passed" });
  }
  if (gated) assert.ok(negative, "global gate lacks replayed target violation");
  return { ...report, ...(gated ? { status: "COMPLETE ATTEMPT: functional failure; not a baseline" } : {}),
    attemptComplete: true, outcomes, comparisonEligibleApps: gated ? [] : [...summary.group.apps] };
}
