// Saved native observations, separate from the historical summary-only report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { aggregate, leanApps, leanProfile, recordedLeanApps, phases, probeCpu, readLoad, verifyDocumentHeaderChecks } from "./contract.mjs";
import { inspectCatalog, completeChecks } from "./report.mjs";
import { records } from "./fixtures.mjs";
import { qualificationIdentity } from "./group.mjs";
import { verifyRecordAttempt, verifyAttemptWindow } from "./record-attempt.mjs";
import { summarizeSamples, memoryMiB } from "./stats.mjs";
import { assertPinned, assertSameEvidence, k6Fields, k6Image, verifyK6Provenance } from "../load-tool.mjs";
import { timedRawSchema, verifyTimedPhase, verifyTimedContinuity } from "./timed.mjs";
import { isDeepStrictEqual } from "node:util";
import { workerAware, workerRawSchema, workerCommand, verifyControl, verifySource, verifyWorkers } from "./apparatus.mjs";
import { verifyArtifactIndex, verifyPreflight } from "./preflight.mjs";
import { receiptPrefix } from "./check.mjs";

export const rawSchema = "catalog-saved-evidence/v2";
export const upstreamImage = "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067";
export const checkerImage = `mcr.microsoft.com/playwright:v${JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).devDependencies["@playwright/test"]}-noble`;
/** The tool and field names run.mjs writes in tools.json. */
const toolFields = ["upstream", "checker", "k6", "k6Execution", "image", "imageId", "execution", "isolation", "Entrypoint", "Cmd", ...k6Fields];
export function imageCommandEvidence(image) {
  assert.ok(image?.Config && typeof image.Config === "object" && !Array.isArray(image.Config), "image configuration missing");
  return { Entrypoint: image.Config.Entrypoint ?? null, Cmd: image.Config.Cmd ?? null };
}
// Keep only fields used for replay, never unrelated image environment or health logs.
export function checkBoundaryEvidence(info) {
  return { Id: info.Id, Image: info.Image, RestartCount: info.RestartCount, Path: info.Path, Args: info.Args,
    networks: Object.keys(info.NetworkSettings?.Networks ?? {}).sort(),
    mounts: info.Mounts.map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW })),
    State: Object.fromEntries(["Status", "Running", "OOMKilled", "Dead", "Paused", "Restarting", "ExitCode", "Error", "StartedAt", "FinishedAt"].map((key) => [key, info.State[key]])),
    HostConfig: Object.fromEntries(["NanoCpus", "CpusetCpus", "Memory", "NetworkMode"].map((key) => [key, info.HostConfig[key]])),
    Config: { Entrypoint: info.Config.Entrypoint ?? null, Cmd: info.Config.Cmd ?? null, Labels: { "run.corten.catalog": info.Config.Labels?.["run.corten.catalog"] },
      Env: info.Config.Env?.filter((e) => ["CATALOG_SOURCE", "CATALOG_FIXTURE_PATH", "API_BASE", "PROFILE"].includes(e.split("=")[0])) ?? [] } };
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

// The checker's stdout receipt: the one line that starts with `receiptPrefix`. Other lines
// (`steady`'s retries and skipped console errors) are kept in checks.log as diagnostics; a
// missing, repeated or embedded receipt is not guessed at.
export function loggedReceipt(log) {
  const framed = log.split(/\r?\n/).filter((line) => line.includes(receiptPrefix.trim()));
  assert.ok(framed.length, "checker stdout receipt missing");
  assert.equal(framed.length, 1, "checker stdout receipt repeated");
  assert.ok(framed[0].startsWith(receiptPrefix), "checker stdout receipt is not framed on its own line");
  return JSON.parse(framed[0].slice(receiptPrefix.length));
}
export function verifyCheckBoundary(proof, summary, app, source, failed) {
  const { runtime, checker, upstream } = proof;
  assert.deepEqual(proof.exit, { code: failed ? 1 : 0, signal: null, expired: false, interrupted: false }, "checker client lifetime incomplete");
  const entry = summary.apps[app], budget = summary.measurement.cpus;
  const checkout = summary.host?.checkout;
  assert.ok(typeof checkout === "string" && checkout.startsWith("/") && !checkout.endsWith("/") && !checkout.includes(".."), "native Linux checkout binding missing");
  const mount = (Source, Destination, RW = false) => ({ Type: "bind", Source, Destination, RW });
  const mounts = (info, expected) => {
    const ordered = (values) => [...values].sort((a, b) => a.Destination.localeCompare(b.Destination));
    assert.deepEqual(ordered(info.mounts), ordered(expected), "native mount set differs");
  };
  const running = (info, imageId, role, memory) => {
    assert.match(info.Id, /^[a-f0-9]{64}$/); assert.equal(info.Image, imageId);
    assert.equal(info.Config.Labels?.["run.corten.catalog"], summary.runId);
    assert.equal(info.HostConfig.NanoCpus, budget[role].quota * 1e9);
    assert.equal(info.HostConfig.CpusetCpus, budget[role].cpuset ?? ""); assert.equal(info.HostConfig.Memory, memory);
    assert.equal(info.RestartCount, 0); assert.equal(info.State.Status, "running"); assert.equal(info.State.Running, true);
    for (const key of ["OOMKilled", "Dead", "Paused", "Restarting"]) assert.equal(info.State[key], false);
    assert.equal(info.State.ExitCode, 0); assert.equal(info.State.Error, "");
    assert.ok(Date.parse(info.State.StartedAt) >= Date.parse(summary.startedAt));
    if (workerAware(summary) || summary.savedEvidence?.schema === timedRawSchema) assert.ok(typeof info.State.FinishedAt === "string"
      && Number.isFinite(Date.parse(info.State.FinishedAt)) && Date.parse(info.State.FinishedAt) <= 0,
      "participant has an unknown prior termination");
  };
  const execution = (info, image, command = image?.Cmd) => {
    assert.ok(image && typeof image === "object" && !Array.isArray(image), "image execution observation missing");
    assert.deepEqual(Object.keys(image).sort(), ["Cmd", "Entrypoint"]);
    for (const value of [image.Entrypoint, image.Cmd, command]) assert.ok(value === null
      || Array.isArray(value) && value.every((s) => typeof s === "string" && !s.includes("\0")), "invalid image command observation");
    assert.deepEqual(info.Config.Entrypoint, image.Entrypoint, "container entrypoint differs from inspected image");
    assert.deepEqual(info.Config.Cmd, command, "native command differs");
    const argv = [...(image.Entrypoint ?? []), ...(command ?? [])];
    assert.ok(argv.length && argv[0].length, "image executable missing");
    assert.equal(info.Path, argv[0], "container executable differs");
    assert.deepEqual(info.Args, argv.slice(1), "container executable arguments differ");
  };
  running(runtime, entry.imageId, "app", 2 ** 30);
  execution(runtime, entry.imageExecution);
  assert.deepEqual(runtime.networks, [`${summary.runId}-net`]);
  mounts(runtime, [mount(`${checkout}/bench/catalog/fixtures`, "/fixtures")]);
  assert.equal(containerEvidence(runtime).source, source);
  assert.ok(runtime.Config.Env.includes("CATALOG_FIXTURE_PATH=/fixtures/catalog.json"));
  assert.ok(runtime.Config.Env.includes(`API_BASE=http://${summary.runId}-upstream:8080`));
  if (summary.measurement.leanProfile !== undefined) {
    assert.deepEqual(summary.measurement.leanProfile, { name: leanProfile, apps: recordedLeanApps(summary) }, "catalog lean configuration differs");
    assert.deepEqual(runtime.Config.Env.filter((value) => value.startsWith("PROFILE=")),
      leanApps.includes(app) ? [`PROFILE=${leanProfile}`] : [], "catalog runtime lean profile differs");
  }
  running(upstream, summary.tools.upstream.imageId, "api", 512 * 2 ** 20);
  assert.deepEqual(upstream.networks, [`${summary.runId}-net`]);
  mounts(upstream, [mount(`${checkout}/bench/catalog/fixtures`, "/fixtures"), mount(`${checkout}/bench`, "/bench")]);
  execution(upstream, summary.tools.upstream.execution, workerAware(summary) ? workerCommand : ["node", "/bench/catalog/upstream.mjs"]);
  if (workerAware(summary)) {
    assert.ok(isDeepStrictEqual(verifyControl(proof.workerBefore, true), verifyControl(proof.workerAfter, true)), "checker worker identities changed");
    assert.ok(proof.workerAfter.epoch >= proof.workerBefore.epoch, "checker worker epoch reversed");
  }
  assert.match(checker.Id, /^[a-f0-9]{64}$/); assert.equal(checker.Image, summary.tools.checker.imageId);
  assert.equal(checker.Config.Labels?.["run.corten.catalog"], summary.runId);
  const checkerCpu = probeCpu(summary.measurement);
  assert.equal(checker.HostConfig.NanoCpus, checkerCpu.quota * 1e9);
  assert.equal(checker.HostConfig.CpusetCpus, checkerCpu.cpuset ?? ""); assert.equal(checker.HostConfig.Memory, 2 ** 31);
  assert.ok([`container:${runtime.Id}`, `container:${summary.runId}-${app}`].includes(checker.HostConfig.NetworkMode));
  mounts(checker, [mount(checkout, "/repo"), mount(`${checkout}/bench/catalog/results/${summary.round}/${source}/${app}`, "/results", true)]);
  const headersChecked = summary.group ? !!summary.group.documentHeaders : leanApps.includes(app);
  execution(checker, summary.tools.checker.execution, ["node", "/repo/bench/catalog/check.mjs", "http://127.0.0.1:8080", source,
    `http://${summary.runId}-upstream:8080`, "/results/checks.json", ...(headersChecked ? [app] : [])]);
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

export function replayCatalog(summary, { readJson, readText }, commit, expectedContractSha256) {
  assert.ok([rawSchema, timedRawSchema, workerRawSchema].includes(summary.savedEvidence?.schema), "native raw evidence version missing");
  assert.equal(summary.options?.group, "catalog-page", "raw group validation requires catalog-page");
  const report = inspectCatalog(summary, commit);
  if (expectedContractSha256 !== undefined) assert.equal(report.group.contractSha256, expectedContractSha256, "native catalog contract differs from requested contract");
  const gated = summary.timingDisposition === "gated-functional";
  const workers = workerAware(summary);
  const documentHeaders = report.group.documentHeaders;
  if (documentHeaders) assert.ok(workers, "document-header contract requires worker-aware native evidence");
  if (workers) { verifySource(summary, { readJson, readText }); verifyArtifactIndex(summary, { readJson, readText }); }
  const timed = (workers || summary.savedEvidence.schema === timedRawSchema) && !gated;
  assert.ok(summary.timingDisposition === undefined || gated, "unknown timing disposition");
  if (timed) {
    assert.equal(report.attemptComplete, true, "timed native attempt is not complete");
    assert.ok(Array.isArray(summary.targetFailures), "timed target dispositions missing");
    assert.equal(summary.complete, summary.targetFailures.length === 0, "timed baseline disposition differs");
  } else if (!gated) assert.ok(report.baseline, "native summary is not complete");
  else {
    assert.ok(Object.values(report.attemptGates).every((v) => v === true), "negative attempt identity/configuration incomplete");
    assert.equal(summary.dirty, false); assert.equal(summary.complete, false); assert.equal(summary.checksPassed, false);
    assert.notEqual(summary.options.checkOnly, true); assert.deepEqual(summary.failures, []); assert.deepEqual(summary.cleanupFailures, []);
    assert.equal(summary.measurement.appMemoryBytes, 2 ** 30);
    // Image pins are this checkout's, so saved evidence replays from a checkout of its measured commit.
    for (const [tool, pin] of [["upstream", upstreamImage], ["checker", checkerImage]]) assertPinned(summary.tools?.[tool]?.image, pin, { tool, verb: "verify", commit });
  }
  assert.equal(summary.commitAfter, commit);
  assert.equal(summary.dirtyAfter, false);
  assert.equal(summary.options.build, true, "image must have been built in this native run");
  const fixture = readText("fixture.json");
  assert.equal(summary.fixtureSha256, summary.savedEvidence.fixtureSha256);
  assert.equal(summary.savedEvidence.fixtureSha256, createHash("sha256").update(fixture).digest("hex"));
  const catalog = documentHeaders ? JSON.parse(fixture) : null;
  const cleanup = readJson("cleanup.json");
  assert.deepEqual(cleanup, { runId: summary.runId, containers: [], networks: [] }, "owned resources remain or cleanup proof differs");
  const tools = readJson("tools.json"), k6Checked = !gated || summary.tools?.k6 !== undefined;
  // The sidecar must equal the summary, so its pins hold wherever the summary's do; checking them
  // first names the pin, not the saved text.
  if (k6Checked) verifyK6Provenance(summary.tools?.k6, { verb: "verify", commit });
  for (const [tool, pin, pinned] of [["upstream", upstreamImage, gated], ["checker", checkerImage, gated], ["k6", k6Image, k6Checked]]) {
    if (pinned) assertPinned(tools?.[tool]?.image, pin, { tool, verb: "verify", commit });
  }
  // Both are saved: only the tool and field names this checkout writes are printed.
  assertSameEvidence(tools, summary.tools, "tool observations differ", "", toolFields);
  for (const name of ["upstream", "checker", ...(gated ? [] : ["k6"])]) {
    const id = summary.tools?.[name]?.imageId;
    assert.ok(typeof id === "string" && /^sha256:[a-f0-9]{64}$/.test(id), `missing/malformed ${name} tool image ID`);
  }
  const outcomes = [];
  const targetFailures = [];
  const timedIds = new Set();
  const timedParticipants = [];
  const workerWindows = [];
  const workerChecks = [];
  let lastCheckFinishedAt = -Infinity, firstColdAt = Infinity;
  let negative = false;
  let upstreamId;
  for (const [app, entry] of Object.entries(summary.apps)) {
    let failed = false;
    if (gated || timed) assert.ok(isDeepStrictEqual(entry.failures ?? [], []), "app apparatus failures retained");
    assert.match(entry.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.imageBytes) && entry.imageBytes > 0);
    assert.deepEqual(readJson(`image-${app}.json`), { imageId: entry.imageId, imageBytes: entry.imageBytes, commit, built: true,
      ...(entry.imageExecution === undefined ? {} : { execution: entry.imageExecution }) });
    assert.ok(readText(`build-${app}.log`).length, "missing native build log");
    for (const source of summary.group.sources) {
      const base = `${source}/${app}`;
      const checked = readJson(`${base}/qualification.json`);
      assert.deepEqual(checked, entry.checks[source], "saved checks differ");
      const { qualification, ...nativeCheck } = checked;
      assert.deepEqual(readJson(`${base}/checks.json`), nativeCheck, "native checker receipt differs");
      const checksLog = readText(`${base}/checks.log`);
      if (documentHeaders && !checked.failure) {
        verifyDocumentHeaderChecks(nativeCheck.documentHeaders, catalog, source);
        assert.ok(isDeepStrictEqual(loggedReceipt(checksLog), nativeCheck), "checker stdout receipt differs");
      }
      readText(`${base}/app.log`);
      let boundary;
      if (gated || timed) {
        assert.deepEqual(qualification, qualificationIdentity(summary.group, app, source, entry.imageId));
        boundary = readJson(`${base}/checker.json`);
        verifyCheckBoundary(boundary, summary, app, source, !!checked.failure);
        if (workers) workerChecks.push(boundary);
        if (timed) lastCheckFinishedAt = Math.max(lastCheckFinishedAt, Date.parse(boundary.checker.State.FinishedAt));
        upstreamId ??= boundary.upstream.Id;
        assert.equal(boundary.upstream.Id, upstreamId, "upstream identity changed across functional checks");
        if (timed) for (const info of [boundary.runtime, boundary.upstream])
          timedParticipants.push({ id: info.Id, lifetime: { restarts: info.RestartCount, state: info.State } });
      }
      if (gated) {
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
          if (timed) firstColdAt = Math.min(firstColdAt, Date.parse(cold.containerStartedAt));
          assert.deepEqual(cold, run.cold, "cold summary differs");
          const probe = JSON.parse(readText(`${raw}/cold.log`).split("\n").findLast((line) => line.startsWith("{")));
          const { first200MsFromContainerStart, containerStartedAt, clock, measuredBeforeReadinessOrWarmup, ...observedCold } = cold;
          assert.deepEqual(observedCold, probe, "cold probe differs");
          if (summary.measurement.loadLayout === "c16-generator-v1") {
            const client = readJson(`${raw}/cold-probe.json`), appName = `${summary.runId}-${app}`;
            assert.match(client.id, /^[a-f0-9]{64}$/);
            assert.ok(!timedIds.has(client.id), "cold probe container reused"); timedIds.add(client.id);
            assert.equal(client.runId, summary.runId); assert.equal(client.name, `/${appName}-probe`);
            assert.equal(client.imageId, summary.tools.upstream.imageId);
            assert.deepEqual(client.command, ["node", "/bench/catalog/cold.mjs", `http://${appName}:8080`,
              "/catalog/record_1", String(summary.options.startupTimeout)]);
            const clientCpu = probeCpu(summary.measurement);
            assert.equal(client.quotaNanoCpus, clientCpu.quota * 1e9, "cold probe quota differs");
            assert.equal(client.cpuset, clientCpu.cpuset, "cold probe affinity differs");
            assert.equal(client.memoryBytes, 256 * 2 ** 20);
            assert.ok(Date.parse(client.startedAt) <= Date.parse(containerStartedAt)
              && Date.parse(client.finishedAt) >= Date.parse(cold.first200At), "cold probe lifetime differs");
          }
          const instance = readJson(`${raw}/container.json`);
          assert.equal(instance.imageId, entry.imageId);
          assert.equal(instance.source, source);
          assert.equal(instance.runId, summary.runId);
          assert.equal(instance.startedAt, containerStartedAt);
          assert.match(instance.id, /^[a-f0-9]{64}$/);
          if (timed) { assert.ok(!timedIds.has(instance.id), "timed app container reused across runs"); timedIds.add(instance.id); }
          assert.equal(instance.quotaNanoCpus, summary.measurement.cpus.app.quota * 1e9);
          assert.equal(instance.cpuset, summary.measurement.cpus.app.cpuset ?? "");
          assert.equal(instance.memoryBytes, summary.measurement.appMemoryBytes);
          readText(`${raw}/app.log`);
          let previousCounters = {};
          let previousFinishedAt = Date.parse(cold.first200At);
          for (const phase of ["warmup", ...phases]) {
            if (timed) {
              const observed = verifyTimedPhase(summary, { app, source, target: profile.target, phase,
                seconds: phase === "warmup" ? summary.options.warmup : summary.options.duration, instance }, {
                readJson: (key) => readJson(`${raw}/${key}`), readText: (key) => readText(`${raw}/${key}`),
              }, { counters: previousCounters, finishedAt: previousFinishedAt });
              assert.ok(isDeepStrictEqual(phase === "warmup" ? run.warmup : run.phases[phase], observed.metrics), "timed metrics differ from raw");
              previousCounters = observed.counters; previousFinishedAt = observed.finishedAt;
              assert.ok(!timedIds.has(observed.loadId), "timed load container reused across phases"); timedIds.add(observed.loadId);
              upstreamId ??= observed.upstreamId; assert.equal(observed.upstreamId, upstreamId, "timed upstream identity changed");
              timedParticipants.push(...observed.participants);
              if (workers) workerWindows.push(observed);
              if (observed.metrics.outcome === "failed") {
                failed = true;
                targetFailures.push({ app, source, target: profile.target, pass: run.pass, phase, failed: observed.metrics.failed,
                  timeouts: observed.metrics.timeouts, httpErrors: observed.metrics.httpErrors, dropped: observed.metrics.dropped });
              }
              continue;
            }
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
  if (timed) {
    assert.ok(Number.isFinite(lastCheckFinishedAt) && Number.isFinite(firstColdAt) && lastCheckFinishedAt <= firstColdAt,
      "all positive checks must finish before cold timing begins");
    if (workers) {
      const preflight = verifyPreflight(summary, { readJson, readText });
      for (const observed of preflight) assert.equal(observed.upstreamId, upstreamId, "preflight upstream identity changed");
      workerWindows.push(...preflight);
      timedParticipants.push(...preflight.flatMap((o) => o.participants));
      const starts = preflight.map((o) => o.workerEvidence.processes[0].samples[0].wallMs);
      const ends = preflight.map((o) => o.finishedAt);
      assert.ok(Math.min(...starts) >= lastCheckFinishedAt && Math.max(...ends) <= firstColdAt,
        "preflight must follow correctness and precede official timing");
      workerWindows.sort((a, b) => a.workerEvidence.processes[0].samples[0].wallMs - b.workerEvidence.processes[0].samples[0].wallMs);
      let previous;
      for (const observed of workerWindows) {
        const e = observed.workerEvidence;
        const boundary = { id: e.binding.container, image: e.binding.image, state: { StartedAt: e.binding.startedAt }, budget: e.binding.budget };
        verifyWorkers(summary, e.binding, e, { ...observed.workerWindow, container: boundary, previous });
        previous = e;
      }
    }
    verifyTimedContinuity(timedParticipants);
    const ordered = (rows) => [...rows].sort((a, b) => `${a.app}/${a.source}/${a.target}/${a.pass}/${a.phase}`.localeCompare(`${b.app}/${b.source}/${b.target}/${b.pass}/${b.phase}`));
    assert.ok(isDeepStrictEqual(ordered(summary.targetFailures), ordered(targetFailures)), "timed target failure ledger differs from raw");
  }
  if (workers) {
    workerChecks.sort((a, b) => Date.parse(a.checker.State.StartedAt) - Date.parse(b.checker.State.StartedAt));
    let prior;
    for (const proof of workerChecks) {
      const ids = verifyControl(proof.workerBefore);
      if (prior) {
        assert.ok(isDeepStrictEqual(ids, verifyControl(prior.workerAfter)), "worker identity changed across checks");
        assert.equal(proof.workerBefore.epoch, prior.workerAfter.epoch, "worker check epoch changed between checkers");
      }
      prior = proof;
    }
    if (workerWindows.length) {
      assert.ok(isDeepStrictEqual(verifyControl(prior.workerAfter), verifyControl(workerWindows[0].workerEvidence.before)), "worker identity changed after correctness");
      assert.equal(workerWindows[0].workerEvidence.before.epoch, prior.workerAfter.epoch + 1, "preflight reset epoch missing");
    }
  }
  return { ...report, ...(gated ? { status: "COMPLETE ATTEMPT: functional failure; not a baseline" } : {}),
    ...(workers ? { rawVerified: true, apparatusPreflight: gated ? "not run: functional gate" : "passed" } : {}),
    attemptComplete: true, outcomes, comparisonEligibleApps: gated ? [] : outcomes.filter((r) => r.outcome === "passed").map((r) => r.app) };
}
