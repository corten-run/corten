// Read saved evidence only. Never builds, runs, collects or changes a benchmark.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { apps, locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { aggregateCold, cpuSettings, loadPhases, phases, resultSchema, roundIdentity, sources, stageAggregate, timedProfiles } from "./run-contract.mjs";
const finite = (n, min = 0) => assert.ok(Number.isFinite(n) && n >= min, "missing/invalid measurement");
const time = (s) => { const n = Date.parse(s); assert.ok(Number.isFinite(n), "missing/invalid timestamp"); return n; };
function loadEvidence(p) {
  assert.ok(Number.isSafeInteger(p.requests) && p.requests > 0);
  finite(p.rps, Number.MIN_VALUE);
  for (const key of ["p50", "p95", "p99"]) finite(p[key]);
  assert.ok(p.p50 <= p.p95 && p.p95 <= p.p99);
  // What the app could not serve is a result (#1128), but it must agree with itself.
  assert.ok(Number.isSafeInteger(p.failed) && p.failed >= 0 && p.failed < p.requests, "failed requests must be counted and leave one served");
  assert.ok(Number.isFinite(p.failedRate) && Math.abs(p.failedRate * p.requests - p.failed) < 1, "failure rate contradicts failed count");
  assert.ok(Number.isSafeInteger(p.dropped) && p.dropped >= 0); assert.ok(Number.isSafeInteger(p.checksFailed) && p.checksFailed >= 0);
  assert.ok(p.checksFailed <= p.failed && p.failed - p.checksFailed <= Math.max(1, p.requests / 100), "failed status checks contradict failed requests");
  assert.equal(p.appOutcome, p.failed > 0 || p.dropped > 0 || p.checksFailed > 0, "appOutcome must mark exactly the phases the app did not fully serve");
}
const outcomeText = (p) => `${p.failed} of ${p.requests} requests failed (${(p.failedRate * 100).toFixed(2)}%), ${p.dropped} fixed-rate iterations dropped, ${p.checksFailed} checks failed`;
// An app container that stopped during a load phase is its outcome (#1128), recorded on the
// profile's last run, which ran only the phases before it. It must agree with itself and the run.
function stopEvidence(run) {
  const stop = run.stopped;
  assert.deepEqual(Object.keys(stop ?? {}).sort(), ["exitCode", "oomKilled", "pass", "phase"], "a stop records its pass, phase, exit code and OOM kill");
  assert.equal(stop.pass, run.pass, "a stop names the pass it ended");
  assert.ok(loadPhases.includes(stop.phase), "a stop names the load phase it ended");
  assert.equal(typeof stop.oomKilled, "boolean");
  assert.ok(stop.exitCode === null ? stop.oomKilled : Number.isSafeInteger(stop.exitCode), "a stop is an exit with its code, or an OOM kill");
  assert.equal(run.complete, false, "a stopped run is not complete");
  assert.equal(run.warmup !== undefined, stop.phase !== "warmup", "a stopped run has warmup evidence only when it stopped after warmup");
  assert.deepEqual(Object.keys(run.phases).sort(), loadPhases.slice(1, loadPhases.indexOf(stop.phase)).sort(), "a stopped run has only the phases before its stop");
}
const stopText = (s) => `its container ${s.oomKilled ? `was OOM-killed at its 1 GiB limit (${s.exitCode === null ? "a process in it; the container kept running" : `exit code ${s.exitCode}`})` : `exited with code ${s.exitCode}`} during ${s.phase} in pass ${s.pass}`;
function statsEvidence(p) {
  finite(p.cpuAvgPct); finite(p.cpuMaxPct); assert.ok(p.cpuMaxPct >= p.cpuAvgPct);
  finite(p.memAvgMiB, Number.MIN_VALUE); finite(p.memMaxMiB, p.memAvgMiB);
  assert.ok(Number.isSafeInteger(p.samples) && p.samples > 0);
  assert.ok(Number.isSafeInteger(p.cpuUsec) && p.cpuUsec > 0);
}
export function validateSummary(s) {
  assert.equal(s.schema, resultSchema); assert.equal(s.workload, workload); roundIdentity(s.round);
  assert.deepEqual(s.measurement.profiles, timedProfiles, "timed profile matrix must contain localized pages and locale-neutral JSON only");
  assert.match(s.commit, /^[a-f0-9]{40}$/); assert.equal(s.dirty, false);
  assert.equal(s.finishedCommit, s.commit); assert.equal(s.finishedDirty, false);
  assert.equal(s.complete, true); assert.equal(s.checksPassed, true);
  assert.deepEqual(s.failures, []); assert.deepEqual(s.cleanupFailures, []);
  assert.equal(s.options.round, s.round, "saved options must name the measured round");
  assert.equal(s.options.checkOnly, false); assert.equal(s.options.passes, 3);
  const start = time(s.startedAt), end = time(s.finishedAt); assert.ok(end > start);
  for (const key of ["duration", "warmup", "rate", "startupTimeout"]) assert.ok(Number.isSafeInteger(s.options[key]) && s.options[key] > 0);
  assert.equal(s.measurement.encoding, "identity"); assert.equal(s.measurement.fixedRate, s.options.rate);
  assert.equal(s.measurement.appMemoryBytes, 2 ** 30); assert.equal(s.measurement.upstreamMemoryBytes, 512 * 2 ** 20);
  const cpus = cpuSettings(Object.fromEntries(["APP", "LOAD", "API"].map((role) => [`MARKETPLACE_${role}_CPUS`, s.measurement.cpus[role.toLowerCase()].cpuset])));
  assert.deepEqual(s.measurement.cpus, cpus);
  for (const key of ["upstream", "cpuWindow", "coldClock"]) assert.ok(typeof s.measurement[key] === "string" && s.measurement[key].length > 0);
  assert.ok(typeof s.host.cpu === "string" && s.host.cpu.length > 0);
  assert.match(s.host.onlineCpus, /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/);
  for (const tool of ["upstream", "checker", "k6"]) assert.match(s.tools[tool].imageId, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual([...s.options.apps].sort(), [...apps].sort());
  assert.deepEqual(Object.keys(s.apps).sort(), [...apps].sort());
  assert.equal(s.fixtureSha256, createHash("sha256").update(JSON.stringify(records())).digest("hex"));
  for (const app of apps) {
    const a = s.apps[app]; assert.match(a.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(a.builtCommit, s.commit);
    assert.equal(a.builtDirty, false);
    assert.ok(!a.failures?.length, "per-app failures contradict complete status");
    for (const field of ["runs", "phases"]) assert.deepEqual(Object.keys(a[field]).sort(), timedProfiles.map((p) => p.key).sort(), `unexpected/missing ${field} profiles`);
    for (const source of sources) {
      const c = a.checks[source]; assert.equal(c.workload, workload); assert.equal(c.source, source);
      assert.equal(c.jsonRecords, 500); assert.equal(c.pages, 264); assert.equal(c.profiles.length, 12);
      assert.deepEqual(c.profiles.map((p) => [p.locale, p.javaScriptEnabled, p.mobile, p.passed]), locales.flatMap((l) => [false, true].flatMap((j) => [false, true].map((m) => [l, j, m, true]))));
      if (source === "api") assert.deepEqual(c.upstream, { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true });
      for (const { key, locale, target } of timedProfiles.filter((p) => p.source === source)) {
        const runs = a.runs[key];
        // Three passes, or fewer when the app stopped: the stop ends the profile (#1128).
        assert.ok(Array.isArray(runs) && runs.length >= 1 && runs.length <= 3); assert.deepEqual(runs.map((r) => r.pass), [1, 2, 3].slice(0, runs.length));
        assert.ok(runs.length === 3 || runs.at(-1).stopped, "a profile has fewer than three passes only when the app stopped");
        for (const run of runs) {
          assert.ok(!run.failed, "failed run contradicts complete status"); assert.equal(run.locale, locale);
          if (run.stopped !== undefined) { assert.equal(run, runs.at(-1), "no pass runs after the app stopped"); stopEvidence(run); }
          else assert.equal(run.complete, true);
          const runStart = time(run.startedAt), runEnd = time(run.finishedAt);
          assert.ok(runStart >= start && runEnd > runStart && runEnd <= end);
          const cold = run.cold, coldStart = time(cold.containerStartedAt), first = time(cold.first200At);
          assert.ok(coldStart >= runStart && first >= coldStart && first <= runEnd);
          assert.equal(cold.first200MsFromContainerStart, first - coldStart);
          assert.equal(cold.measuredBeforeReadinessOrWarmup, true);
          assert.ok(cold.first200MsFromContainerStart <= s.options.startupTimeout * 1000);
          assert.equal(cold.path, target === "json" ? "/api/marketplace/item_1" : `/marketplace/${locale}/item_1`);
          assert.ok(Number.isSafeInteger(cold.attempts) && cold.attempts > 0);
          finite(cold.successfulRequestMs); assert.ok(Number.isSafeInteger(cold.bytes) && cold.bytes > 0);
          if (run.stopped?.phase !== "warmup") loadEvidence(run.warmup);
          if (!run.stopped) assert.deepEqual(Object.keys(run.phases).sort(), [...phases].sort(), "unexpected/missing run phases");
          for (const phase of phases.filter((p) => run.phases[p])) {
            const p = run.phases[phase];
            loadEvidence(p); statsEvidence(p); finite(p.perCpuSecond, Number.MIN_VALUE);
            assert.ok(Math.abs(p.perCpuSecond - p.requests / (p.cpuUsec / 1e6)) < 1e-6, "CPU efficiency contradicts raw counter");
            if (source === "api") { statsEvidence(p.upstream); assert.equal(p.upstream.highCpu, p.upstream.cpuAvgPct >= 80); }
            else assert.equal(p.upstream, null);
          }
        }
        assert.deepEqual(Object.keys(a.phases[key]).sort(), [...phases].sort(), "unexpected/missing aggregate phases");
        // The aggregate's stop mark, like its outcome count, must match the saved passes.
        for (const phase of phases) assert.deepEqual(a.phases[key][phase], stageAggregate(runs, phase, 3), "aggregate must match saved passes");
      }
    }
  }
  return s;
}
export function report(s) {
  validateSummary(s);
  const identity = roundIdentity(s.round);
  const lines = [`# Marketplace v2 ${s.round}${identity.kind === "development" ? " (development)" : ""}`, "",
    `Commit: \`${s.commit}\`. Schema: \`${s.schema}\`. CPU: ${s.host.cpu} (online CPUs ${s.host.onlineCpus}).`,
    "A new localized baseline, not a change from marketplace r16 or catalog c1.", "",
    "Every number is the median [min-max] of three measured passes, not a confidence interval. Overlapping ranges do not establish a speed difference.",
    "Pages cover all three locales; JSON is locale-neutral and timed once per source/pass. All twenty apps pass both sources and twelve browser profiles before any load.",
    `Fixed load asks for ${s.options.rate} requests/second. Closed-loop 64/256-user results are observed throughput and latency, not proven maximum capacity. Warmup ${s.options.warmup}s; each phase ${s.options.duration}s; identity encoding.`,
    "CPU % is sampled app-container usage (100% = one core). CPU us/request and requests/CPU-second use counted whole-container cgroup CPU, not instructions or handler-only time. CPU % and steady memory average the central 15%-95% of samples; peak memory is the sampled maximum, not an unsampled high-water mark.",
    "These load results do not measure browser interactivity, bytes, build cost or instructions.",
    "A stage marked * is the app's measured outcome under this profile: some requests got an answer other than 200 or timed out (10 s), or the fixed rate could not be started. It is recorded, not retried, and the later phases still ran. Its req/s, latency percentiles and requests/CPU-second count every request sent, failed ones included.",
    "A stage marked (stopped: n of 3 passes) is also the app's outcome: its container exited or was OOM-killed during a load phase (warmup included), and the line below the table says when. That profile's later phases and passes were not run, so the stage's numbers come from the n passes before the stop, or none. A 200 of the wrong content type, an app that stopped during its cold start, or an upstream error fails the run instead."];
  const cell = (r, digits = 2) => `${r.median.toFixed(digits)} [${r.min.toFixed(digits)}-${r.max.toFixed(digits)}]`;
  const label = (v) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const warnings = [];
  if (s.options.duration < 60) warnings.push(`Short ${s.options.duration}s phase windows (${s.options.warmup}s warmup): variability and sampling limits matter; not comparable to manual 60s phases with 30s warmup.`);
  if (Object.values(s.measurement.cpus).some((c) => !c.cpuset)) warnings.push("CPU quotas without disjoint pinning do not prove CPU isolation.");
  for (const warning of warnings) lines.push("", `Warning: ${warning}`);
  for (const locale of [...locales, null]) {
    lines.push("", `## ${locale ?? "Locale-neutral JSON"}`);
    for (const { key, source } of timedProfiles.filter((p) => p.locale === locale)) {
      lines.push("", `### ${source === "fixture" ? "Memory source" : "HTTP source"}`);
      lines.push("", "#### Cold start", "", "Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.", "",
        "| Framework | First 200 from container start ms | Successful request ms |", "|---|---:|---:|");
      for (const app of apps) {
        const runs = s.apps[app].runs[key], cold = aggregateCold(runs);
        const mark = runs.length < 3 ? ` (stopped: ${runs.length} of 3 passes)` : "";
        lines.push(`| ${label(s.apps[app].label)}${mark} | ${cell(cold.first200MsFromContainerStart)} | ${cell(cold.successfulRequestMs)} |`);
      }
      for (const app of apps) for (const r of s.apps[app].runs[key]) if (r.warmup?.appOutcome) lines.push("", `App outcome in warmup (not measured): ${app} ${key} pass ${r.pass}: ${outcomeText(r.warmup)}.`);
      for (const phase of phases) {
        lines.push("", `#### ${phase === "fixed" ? `Fixed ${s.options.rate} req/s` : `${phase === "sat64" ? 64 : 256}-user closed loop`}`, "",
          "| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |",
          "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for (const app of apps) {
          const p = s.apps[app].phases[key][phase];
          const mark = (p.appOutcomes ? ` * (${p.appOutcomes} of ${p.passes} passes)` : "") + (p.stopped ? ` (stopped: ${p.passes} of ${p.asked} passes)` : "");
          const metrics = ["rps", "p50", "p95", "p99", "cpuAvgPct", "cpuPerRequestUsec", "memAvgMiB", "memMaxMiB", "perCpuSecond"];
          const failed = p.passes ? { median: p.failedRate.median * 100, min: p.failedRate.min * 100, max: p.failedRate.max * 100 } : null;
          lines.push(`| ${label(s.apps[app].label)}${mark} | ${p.passes ? `${metrics.map((metric) => cell(p[metric])).join(" | ")} | ${cell(failed)}` : Array(metrics.length + 1).fill("-").join(" | ")} |`);
        }
        for (const app of apps) {
          const p = s.apps[app].phases[key][phase];
          if (p.stopped) lines.push("", `App stopped: ${app} ${key} ${phase}: ${stopText(p.stopped)}. The profile's later phases and passes were not run; this stage has ${p.passes} of ${p.asked} passes.`);
        }
        for (const app of apps) for (const r of s.apps[app].runs[key]) {
          const p = r.phases[phase];
          if (!p) continue;
          if (p.appOutcome) lines.push("", `App outcome: ${app} ${key} ${phase} pass ${r.pass}: ${outcomeText(p)}.`);
          if (p.upstream?.highCpu) lines.push("", `Warning: ${app} ${key} ${phase} pass ${r.pass}: busy single-process upstream (${p.upstream.cpuAvgPct.toFixed(1)}% of one core); upstream may limit throughput.`);
          if (phase !== "fixed" && p.cpuAvgPct < 95) lines.push("", `Warning: ${app} ${key} ${phase} pass ${r.pass}: app CPU ${p.cpuAvgPct.toFixed(1)}%; saturation not demonstrated.`);
        }
      }
    }
  }
  lines.push("", "## Limits", "", s.measurement.upstream, s.measurement.cpuWindow);
  return lines.join("\n") + "\n";
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node bench/marketplace/report.mjs summary.json");
  console.log(report(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}
