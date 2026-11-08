// Read saved evidence only. Never builds, runs, collects or changes a benchmark.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { apps, locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { aggregate, cpuSettings, phases, sources, targets } from "./run-contract.mjs";
const finite = (n, min = 0) => assert.ok(Number.isFinite(n) && n >= min, "missing/invalid measurement");
const time = (s) => { const n = Date.parse(s); assert.ok(Number.isFinite(n), "missing/invalid timestamp"); return n; };
function loadEvidence(p) {
  assert.ok(Number.isSafeInteger(p.requests) && p.requests > 0);
  finite(p.rps, Number.MIN_VALUE);
  for (const key of ["p50", "p95", "p99"]) finite(p[key]);
  assert.ok(p.p50 <= p.p95 && p.p95 <= p.p99);
  assert.equal(p.failed, 0); assert.equal(p.dropped, 0);
}
function statsEvidence(p) {
  finite(p.cpuAvgPct); finite(p.cpuMaxPct); assert.ok(p.cpuMaxPct >= p.cpuAvgPct);
  finite(p.memAvgMiB, Number.MIN_VALUE); finite(p.memMaxMiB, p.memAvgMiB);
  assert.ok(Number.isSafeInteger(p.samples) && p.samples > 0);
  assert.ok(Number.isSafeInteger(p.cpuUsec) && p.cpuUsec > 0);
}
export function validateSummary(s) {
  assert.equal(s.workload, workload); assert.match(s.round, /^w[1-9]\d*$/);
  assert.match(s.commit, /^[a-f0-9]{40}$/); assert.equal(s.dirty, false);
  assert.equal(s.finishedCommit, s.commit); assert.equal(s.finishedDirty, false);
  assert.equal(s.complete, true); assert.equal(s.checksPassed, true);
  assert.deepEqual(s.failures, []); assert.deepEqual(s.cleanupFailures, []);
  assert.equal(s.options.checkOnly, false); assert.equal(s.options.passes, 3);
  const start = time(s.startedAt), end = time(s.finishedAt); assert.ok(end > start);
  for (const key of ["duration", "warmup", "rate", "startupTimeout"]) assert.ok(Number.isSafeInteger(s.options[key]) && s.options[key] > 0);
  assert.equal(s.measurement.encoding, "identity"); assert.equal(s.measurement.fixedRate, s.options.rate);
  assert.equal(s.measurement.appMemoryBytes, 2 ** 30); assert.equal(s.measurement.upstreamMemoryBytes, 512 * 2 ** 20);
  const cpus = cpuSettings(Object.fromEntries(["APP", "LOAD", "API"].map((role) => [`MARKETPLACE_${role}_CPUS`, s.measurement.cpus[role.toLowerCase()].cpuset])));
  assert.deepEqual(s.measurement.cpus, cpus);
  for (const key of ["upstream", "cpuWindow", "coldClock"]) assert.ok(typeof s.measurement[key] === "string" && s.measurement[key].length > 0);
  assert.ok(typeof s.host.cpu === "string" && s.host.cpu.length > 0);
  for (const tool of ["upstream", "checker", "k6"]) assert.match(s.tools[tool].imageId, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual([...s.options.apps].sort(), [...apps].sort());
  assert.deepEqual(Object.keys(s.apps).sort(), [...apps].sort());
  assert.equal(s.fixtureSha256, createHash("sha256").update(JSON.stringify(records())).digest("hex"));
  for (const app of apps) {
    const a = s.apps[app]; assert.match(a.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(a.builtCommit, s.commit);
    assert.equal(a.builtDirty, false);
    assert.ok(!a.failures?.length, "per-app failures contradict complete status");
    for (const source of sources) {
      const c = a.checks[source]; assert.equal(c.workload, workload); assert.equal(c.source, source);
      assert.equal(c.jsonRecords, 500); assert.equal(c.pages, 264); assert.equal(c.profiles.length, 12);
      assert.deepEqual(c.profiles.map((p) => [p.locale, p.javaScriptEnabled, p.mobile, p.passed]), locales.flatMap((l) => [false, true].flatMap((j) => [false, true].map((m) => [l, j, m, true]))));
      if (source === "api") assert.deepEqual(c.upstream, { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true });
      for (const locale of locales) for (const target of targets) {
        const key = `${source}-${locale}-${target}`, runs = a.runs[key];
        assert.equal(runs.length, 3); assert.deepEqual(runs.map((r) => r.pass), [1, 2, 3]);
        for (const run of runs) {
          assert.equal(run.complete, true); assert.ok(!run.failed, "failed run contradicts complete status"); assert.equal(run.locale, locale);
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
          loadEvidence(run.warmup);
          for (const phase of phases) {
            const p = run.phases[phase];
            loadEvidence(p); statsEvidence(p); finite(p.perCpuSecond, Number.MIN_VALUE);
            assert.ok(Math.abs(p.perCpuSecond - p.requests / (p.cpuUsec / 1e6)) < 1e-6, "CPU efficiency contradicts raw counter");
            if (source === "api") { statsEvidence(p.upstream); assert.equal(p.upstream.highCpu, p.upstream.cpuAvgPct >= 80); }
            else assert.equal(p.upstream, null);
          }
        }
        for (const phase of phases) assert.deepEqual(a.phases[key][phase], { ...aggregate(runs.map((r) => r.phases[phase])), asked: 3 }, "aggregate must match saved passes");
      }
    }
  }
  return s;
}
export function report(s) {
  validateSummary(s);
  const lines = [`# Marketplace v2 ${s.round}`, "", `Commit: \`${s.commit}\`. CPU: ${s.host.cpu}. A new localized baseline, not a change from marketplace r16 or catalog c1.`, "", "64-user requests/second, median [min–max] of three passes. Memory and HTTP sources are separate. Overlapping ranges do not establish a speed difference."];
  const warnings = [];
  for (const locale of locales) {
    lines.push("", `## ${locale}`, "", "| Framework | Memory page | Memory JSON | HTTP page | HTTP JSON |", "|---|---:|---:|---:|---:|");
    const value = (app, source, target) => s.apps[app].phases[`${source}-${locale}-${target}`].sat64.rps.median;
    for (const app of [...apps].sort((a, b) => value(b, "fixture", "page") - value(a, "fixture", "page"))) {
      lines.push(`| ${s.apps[app].label} | ${sources.flatMap((source) => targets.map((target) => { const r = s.apps[app].phases[`${source}-${locale}-${target}`].sat64.rps; return `${r.median.toFixed(0)} [${r.min.toFixed(0)}–${r.max.toFixed(0)}]`; })).join(" | ")} |`);
    }
    lines.push("", "Corten efficiency and pass variability:", "", "| Source/target | Requests/CPU-second | Peak MiB | req/s min–max |", "|---|---:|---:|---:|");
    for (const source of sources) for (const target of targets) {
      const p = s.apps.corten.phases[`${source}-${locale}-${target}`].sat64;
      lines.push(`| ${source}/${target} | ${p.perCpuSecond.median.toFixed(0)} | ${p.memMaxMiB.median.toFixed(2)} | ${p.rps.min.toFixed(0)}–${p.rps.max.toFixed(0)} |`);
    }
  }
  for (const [app, a] of Object.entries(s.apps)) for (const [key, runs] of Object.entries(a.runs)) for (const r of runs) {
    if (r.phases.sat64.upstream?.highCpu) warnings.push(`${app} ${key} pass ${r.pass}: busy upstream (${r.phases.sat64.upstream.cpuAvgPct.toFixed(1)}% of one core).`);
    if (r.phases.sat64.cpuAvgPct < 95) warnings.push(`${app} ${key} pass ${r.pass}: app CPU ${r.phases.sat64.cpuAvgPct.toFixed(1)}%; saturation not demonstrated.`);
  }
  lines.push("", "## Limits", "", s.measurement.upstream, s.measurement.cpuWindow, ...warnings);
  return lines.join("\n") + "\n";
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node bench/marketplace/report.mjs summary.json");
  console.log(report(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}
