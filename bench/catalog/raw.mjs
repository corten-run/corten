// Saved native observations, separate from the historical summary-only report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { aggregate, phases, readLoad } from "./contract.mjs";
import { inspectCatalog } from "./report.mjs";
import { summarizeSamples, memoryMiB } from "./stats.mjs";

export const rawSchema = "catalog-saved-evidence/v1";
export function containerEvidence(info) {
  return { id: info.Id, imageId: info.Image, startedAt: info.State.StartedAt,
    quotaNanoCpus: info.HostConfig.NanoCpus, cpuset: info.HostConfig.CpusetCpus,
    memoryBytes: info.HostConfig.Memory,
    source: info.Config.Env.find((s) => s.startsWith("CATALOG_SOURCE="))?.slice(15),
    runId: info.Config.Labels?.["run.corten.catalog"] };
}

export function replayCatalog(summary, { readJson, readText }, commit) {
  assert.equal(summary.savedEvidence?.schema, rawSchema, "native raw evidence version missing");
  assert.equal(summary.options?.group, "catalog-page", "raw group validation requires catalog-page");
  const report = inspectCatalog(summary, commit);
  assert.ok(report.baseline, "native summary is not complete");
  assert.equal(summary.commitAfter, commit);
  assert.equal(summary.dirtyAfter, false);
  assert.equal(summary.options.build, true, "image must have been built in this native run");
  const fixture = readText("fixture.json");
  assert.equal(summary.fixtureSha256, summary.savedEvidence.fixtureSha256);
  assert.equal(summary.savedEvidence.fixtureSha256, createHash("sha256").update(fixture).digest("hex"));
  const cleanup = readJson("cleanup.json");
  assert.deepEqual(cleanup, { runId: summary.runId, containers: [], networks: [] }, "owned resources remain or cleanup proof differs");
  assert.deepEqual(readJson("tools.json"), summary.tools, "tool observations differ");
  for (const name of ["upstream", "checker", "k6"]) assert.match(summary.tools?.[name]?.imageId, /^sha256:[a-f0-9]{64}$/);
  for (const [app, entry] of Object.entries(summary.apps)) {
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
  }
  return report;
}
