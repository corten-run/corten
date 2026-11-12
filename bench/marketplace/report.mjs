// Read saved evidence only. Never builds, runs, collects or changes a benchmark.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { apps, locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { aggregateCold, anchors, cpuSettings, loadPhases, parsePart, phases, readableSchemas, roundIdentity, sources, splitApps, stageAggregate, timedProfiles, v3Schema } from "./run-contract.mjs";
import { anchorMetrics, betweenDroplets, differText } from "./split.mjs";
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
// Docker's OOMKilled does not say whose limit was hit (the container's 1 GiB, or the host's), so the
// text does not either.
const stopText = (s) => `its container ${s.oomKilled ? `was OOM-killed (${s.exitCode === null ? "a process in it; the container kept running" : `exit code ${s.exitCode}`})` : `exited with code ${s.exitCode}`} during ${s.phase} in pass ${s.pass}`;
// A stage the app's stop left with fewer than three passes says what its number is: of two passes
// spread takes the lower value in each column on its own (req/s and p95 may come from different
// passes), and one pass has no range.
const stoppedMark = (n, asked) => n >= asked ? "" : ` (stopped: ${n} of ${asked} passes${n === 2 ? "; the lower of two values per column, not a median" : n === 1 ? "; one pass, no range" : ""})`;
function statsEvidence(p) {
  finite(p.cpuAvgPct); finite(p.cpuMaxPct); assert.ok(p.cpuMaxPct >= p.cpuAvgPct);
  finite(p.memAvgMiB, Number.MIN_VALUE); finite(p.memMaxMiB, p.memAvgMiB);
  assert.ok(Number.isSafeInteger(p.samples) && p.samples > 0);
  assert.ok(Number.isSafeInteger(p.cpuUsec) && p.cpuUsec > 0);
}
function hostEvidence(host, tools) {
  assert.ok(typeof host.cpu === "string" && host.cpu.length > 0);
  assert.match(host.onlineCpus, /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/);
  for (const tool of ["upstream", "checker", "k6"]) assert.match(tools[tool].imageId, /^sha256:[a-f0-9]{64}$/);
}
// A round split across droplets (#816): its parts, each with its anchors, host and window, must
// be the split of all twenty apps. Returns the window each app was measured in.
function splitEvidence(s, v3, start, end) {
  const { split } = s;
  assert.deepEqual(Object.keys(split ?? {}).sort(), ["droplets", "parts"], "a split round records its droplets and parts");
  const shares = splitApps(split.droplets);
  assert.ok(Array.isArray(split.parts) && split.parts.length === split.droplets, "a split round has one part per droplet");
  const windows = {};
  split.parts.forEach((p, i) => {
    assert.deepEqual(Object.keys(p).sort(), ["anchors", "apps", "finishedAt", "host", "index", "runId", "startedAt", "tools"], `d${i + 1}: unexpected part fields`);
    assert.equal(p.index, i + 1); assert.deepEqual(p.apps, shares[i], `d${p.index} measured other apps than its share`);
    assert.ok(typeof p.runId === "string" && p.runId.length > 0);
    const partStart = time(p.startedAt), partEnd = time(p.finishedAt);
    assert.ok(partStart >= start && partEnd > partStart && partEnd <= end, `d${p.index}'s window is outside the round's`);
    hostEvidence(p.host, p.tools);
    assert.deepEqual(Object.keys(p.anchors).sort(), [...anchors].sort(), `d${p.index} needs both anchors`);
    for (const app of anchors) validateApp(s, p.anchors[app], partStart, partEnd, v3);
    for (const app of p.apps) windows[app] ??= [partStart, partEnd];
  });
  assert.equal(Math.min(...split.parts.map((p) => time(p.startedAt))), start, "the round starts with its first droplet");
  assert.equal(Math.max(...split.parts.map((p) => time(p.finishedAt))), end, "the round finishes with its last droplet");
  assert.deepEqual(split.parts[0].host, s.host, "the round's host is d1's");
  assert.deepEqual(split.parts[0].tools, s.tools, "the round's tools are d1's");
  for (const app of anchors) assert.deepEqual(split.parts[0].anchors[app], s.apps[app], `the round's ${app} is d1's`);
  return windows;
}
function validateApp(s, a, start, end, v3) {
  assert.match(a.imageId, /^sha256:[a-f0-9]{64}$/);
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
        assert.ok(!v3 || run.stopped === undefined, "a v3 round cannot record a stop: an app that stopped failed it");
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
      // A v3 aggregate has no stopped field at all.
      for (const phase of phases) {
        const expected = stageAggregate(runs, phase, 3);
        if (v3) delete expected.stopped;
        assert.deepEqual(a.phases[key][phase], expected, "aggregate must match saved passes");
      }
    }
  }
}
/**
 * Validates a round's summary: a whole round, one droplet's part of a split round (options.part,
 * its share of the apps), or a split round merged from its parts (split). Returns it.
 */
export function validateSummary(s) {
  assert.ok(readableSchemas.includes(s.schema), `unreadable result schema ${s.schema}; this reader takes ${readableSchemas.join(" or ")}`);
  // A v3 round is read as v4 with no stop records: under v3 an app that stopped failed the round.
  const v3 = s.schema === v3Schema;
  assert.equal(s.workload, workload); roundIdentity(s.round);
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
  hostEvidence(s.host, s.tools);
  const part = s.options.part === undefined ? null : parsePart(s.options.part);
  assert.ok(!(part && s.split !== undefined), "a part of a split round is not itself split");
  const measured = part ? splitApps(part.of)[part.index - 1] : apps;
  if (part) assert.deepEqual(s.options.apps, measured, `part d${part.index} of ${part.of} measures its share of the apps, in catalog order`);
  assert.deepEqual([...s.options.apps].sort(), [...measured].sort());
  assert.deepEqual(Object.keys(s.apps).sort(), [...measured].sort());
  assert.equal(s.fixtureSha256, createHash("sha256").update(JSON.stringify(records())).digest("hex"));
  const windows = s.split === undefined ? {} : splitEvidence(s, v3, start, end);
  for (const app of measured) validateApp(s, s.apps[app], ...(windows[app] ?? [start, end]), v3);
  return s;
}
export function report(s) {
  validateSummary(s);
  const identity = roundIdentity(s.round);
  const part = s.options.part, split = s.split;
  const cpu = (host) => `${host.cpu} (online CPUs ${host.onlineCpus})`;
  const gate = split ? "All twenty apps pass both sources and twelve browser profiles on their own droplet before that droplet's load."
    : part ? `This part's ${s.options.apps.length} apps pass both sources and twelve browser profiles before any load.`
    : "All twenty apps pass both sources and twelve browser profiles before any load.";
  const lines = [`# Marketplace v2 ${s.round}${part ? ` part d${part.index} of ${part.of}` : split ? ` (split across ${split.droplets} droplets)` : ""}${identity.kind === "development" ? " (development)" : ""}`, "",
    `Commit: \`${s.commit}\`. Schema: \`${s.schema}\`${s.schema === v3Schema ? " (read as v4: a v3 round has no stop records, since an app that stopped failed it)" : ""}. CPU: ${split ? split.parts.map((p) => `d${p.index} ${cpu(p.host)}`).join("; ") : cpu(s.host)}.`,
    "A new localized baseline, not a change from marketplace r16 or catalog c1.", "",
    "Every number is the median [min-max] of three measured passes, not a confidence interval, except in a row marked stopped, which has fewer: of two passes each number is the lower of the two values in its column, of one pass that pass. Overlapping ranges do not establish a speed difference.",
    `Pages cover all three locales; JSON is locale-neutral and timed once per source/pass. ${gate}`,
    `Fixed load asks for ${s.options.rate} requests/second. Closed-loop 64/256-user results are observed throughput and latency, not proven maximum capacity. Warmup ${s.options.warmup}s; each phase ${s.options.duration}s; identity encoding.`,
    "CPU % is sampled app-container usage (100% = one core). CPU us/request and requests/CPU-second use counted whole-container cgroup CPU, not instructions or handler-only time. CPU % and steady memory average the central 15%-95% of samples; peak memory is the sampled maximum, not an unsampled high-water mark.",
    "These load results do not measure browser interactivity, bytes, build cost or instructions.",
    "A stage marked * is the app's measured outcome under this profile: some requests got an answer other than 200 or timed out (10 s), or the fixed rate could not be started. It is recorded, not retried, and the later phases still ran. Its req/s, latency percentiles and requests/CPU-second count every request sent, failed ones included.",
    "A stage marked (stopped: n of 3 passes) is also the app's outcome: its container exited or was OOM-killed during a load phase (warmup included), and the line below the table says when. That profile's later phases and passes were not run, so the stage's numbers come from the n passes before the stop, or none. A 200 of the wrong content type, an app that stopped during its cold start or before a phase began, or an upstream error fails the run instead."];
  const cell = (r, digits = 2) => `${r.median.toFixed(digits)} [${r.min.toFixed(digits)}-${r.max.toFixed(digits)}]`;
  const label = (v) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const warnings = [];
  if (s.options.duration < 60) warnings.push(`Short ${s.options.duration}s phase windows (${s.options.warmup}s warmup): variability and sampling limits matter; not comparable to manual 60s phases with 30s warmup.`);
  if (Object.values(s.measurement.cpus).some((c) => !c.cpuset)) warnings.push("CPU quotas without disjoint pinning do not prove CPU isolation.");
  for (const warning of warnings) lines.push("", `Warning: ${warning}`);
  // The rows of every table: a split round's, each droplet's anchors and share with its own Corten
  // (#816); otherwise the apps measured, in catalog order.
  const rows = split ? split.parts.flatMap((p) => p.apps.map((app) => ({ app, a: anchors.includes(app) ? p.anchors[app] : s.apps[app],
    droplet: `${s.round}-d${p.index}`, at: `@${s.round}-d${p.index}`, corten: p.anchors.corten })))
    : (part ? s.options.apps : apps).map((app) => ({ app, a: s.apps[app], droplet: null, at: "", corten: null }));
  if (split) lines.push(...betweenLines(s, cell));
  for (const locale of [...locales, null]) {
    lines.push("", `## ${locale ?? "Locale-neutral JSON"}`);
    for (const { key, source } of timedProfiles.filter((p) => p.locale === locale)) {
      lines.push("", `### ${source === "fixture" ? "Memory source" : "HTTP source"}`);
      lines.push("", "#### Cold start", "", "Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.", "",
        `| Framework |${split ? " Droplet |" : ""} First 200 from container start ms | Successful request ms |`, `|---|${split ? "---|" : ""}---:|---:|`);
      for (const { a, droplet } of rows) {
        const runs = a.runs[key], cold = aggregateCold(runs);
        const mark = stoppedMark(runs.length, 3);
        lines.push(`| ${label(a.label)}${mark} |${droplet ? ` ${droplet} |` : ""} ${cell(cold.first200MsFromContainerStart)} | ${cell(cold.successfulRequestMs)} |`);
      }
      for (const { app, a, at } of rows) for (const r of a.runs[key]) if (r.warmup?.appOutcome) lines.push("", `App outcome in warmup (not measured): ${app}${at} ${key} pass ${r.pass}: ${outcomeText(r.warmup)}.`);
      for (const phase of phases) {
        lines.push("", `#### ${phase === "fixed" ? `Fixed ${s.options.rate} req/s` : `${phase === "sat64" ? 64 : 256}-user closed loop`}`, "",
          `| Framework |${split ? " Droplet |" : ""} req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |${split ? " req/s ratio to Corten | CPU us/request ratio to Corten |" : ""}`,
          `|---|${split ? "---|" : ""}---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|${split ? "---:|---:|" : ""}`);
        for (const { a, droplet, corten } of rows) {
          const p = a.phases[key][phase];
          const mark = (p.appOutcomes ? ` * (${p.appOutcomes} of ${p.passes} passes)` : "") + (p.stopped ? stoppedMark(p.passes, p.asked) : "");
          const metrics = ["rps", "p50", "p95", "p99", "cpuAvgPct", "cpuPerRequestUsec", "memAvgMiB", "memMaxMiB", "perCpuSecond"];
          const failed = p.passes ? { median: p.failedRate.median * 100, min: p.failedRate.min * 100, max: p.failedRate.max * 100 } : null;
          // Each app beside its own droplet's Corten, as a ratio of medians.
          const c = corten?.phases[key][phase];
          const ratios = !corten ? "" : ["rps", "cpuPerRequestUsec"].map((m) => ` ${p.passes && c.passes ? (p[m].median / c[m].median).toFixed(2) : "-"} |`).join("");
          lines.push(`| ${label(a.label)}${mark} |${droplet ? ` ${droplet} |` : ""} ${p.passes ? `${metrics.map((metric) => cell(p[metric])).join(" | ")} | ${cell(failed)}` : Array(metrics.length + 1).fill("-").join(" | ")} |${ratios}`);
        }
        for (const { app, a, at } of rows) {
          const p = a.phases[key][phase];
          if (p.stopped) lines.push("", `App stopped: ${app}${at} ${key} ${phase}: ${stopText(p.stopped)}. The profile's later phases and passes were not run; this stage has ${p.passes} of ${p.asked} passes.`);
        }
        for (const { app, a, at } of rows) for (const r of a.runs[key]) {
          const p = r.phases[phase];
          if (!p) continue;
          if (p.appOutcome) lines.push("", `App outcome: ${app}${at} ${key} ${phase} pass ${r.pass}: ${outcomeText(p)}.`);
          if (p.upstream?.highCpu) lines.push("", `Warning: ${app}${at} ${key} ${phase} pass ${r.pass}: busy single-process upstream (${p.upstream.cpuAvgPct.toFixed(1)}% of one core); upstream may limit throughput.`);
          if (phase !== "fixed" && p.cpuAvgPct < 95) lines.push("", `Warning: ${app}${at} ${key} ${phase} pass ${r.pass}: app CPU ${p.cpuAvgPct.toFixed(1)}%; saturation not demonstrated.`);
        }
      }
    }
  }
  lines.push("", "## Limits", "", s.measurement.upstream, s.measurement.cpuWindow);
  return lines.join("\n") + "\n";
}
// A split round's droplets, and whether their machines agree (#816), from betweenDroplets.
function betweenLines(s, cell) {
  const { split } = s, check = betweenDroplets(s);
  const name = (index) => `${s.round}-d${index}`;
  const value = (c) => (c.range ? cell(c.range) : "-");
  const lines = ["", "## Between droplets", "",
    `This round ran on ${split.droplets} droplets started together. Each ran corten and axum-maud beside its share of the other apps, so each app's ratio to Corten uses the Corten on its own droplet. Compare apps on different droplets by those ratios: their raw numbers also carry any difference between the droplets' machines.`,
    "", "| Droplet | CPU | Online CPUs | Apps |", "|---|---|---|---|",
    ...split.parts.map((p) => `| ${name(p.index)} | ${p.host.cpu.replace(/\|/g, "\\|")} | ${p.host.onlineCpus} | ${p.apps.join(", ")} |`),
    "", "The check is axum-maud's ratio to Corten on each droplet, for req/s and CPU us/request: the median of the medians [lowest axum-maud over highest Corten - highest over lowest]. Two droplets whose ratio ranges do not overlap differ by more than the noise, the rule this report uses for every range; that stage is flagged, and ratios to Corten that compare apps on those droplets are not like for like there.",
    "", check.flagged.length ? `Flagged: ${check.flagged.length} of ${check.ratios.length} stages (${[...new Set(check.flagged.map((r) => differText(r.differ)))].join("; ")}).` : `Flagged: none. No two droplets' axum-maud ratios to Corten differ by more than the noise in any of the ${check.ratios.length} stages.`,
    "", `| Profile | Phase | Metric |${split.parts.map((p) => ` d${p.index} |`).join("")} Flag |`, `|---|---|---|${split.parts.map(() => "---:|").join("")}---|`,
    ...check.ratios.map((r) => `| ${r.profile} | ${r.phase} | ${anchorMetrics[r.metric]} |${r.cells.map((c) => ` ${value(c)} |`).join("")} ${differText(r.differ)} |`),
    "", "The anchors' raw numbers across droplets (information, not the flag):", ""];
  for (const anchor of anchors) for (const [metric, metricLabel] of Object.entries(anchorMetrics)) {
    const raw = check.raw.filter((r) => r.anchor === anchor && r.metric === metric);
    const widest = raw.filter((r) => r.spread !== null).sort((a, b) => b.spread - a.spread)[0];
    const beyond = raw.filter((r) => r.differ.length).length;
    lines.push(`- ${anchor} ${metricLabel}: ${widest ? `the droplets' medians differ by up to ${(widest.spread * 100).toFixed(1)}% (${widest.profile} ${widest.phase})` : "no stage has two droplets with passes"}; ranges apart in ${beyond} of ${raw.length} stages.`);
  }
  if (check.rawBeyondNoise.length) {
    lines.push("", `Note: the anchors' raw numbers differ by more than the noise in ${check.rawBeyondNoise.length} of ${check.raw.length} anchor stages (${[...new Set(check.rawBeyondNoise.map((r) => differText(r.differ)))].join("; ")}). The droplets' machines are not the same speed; read apps on different droplets through their ratio to Corten, not their raw numbers.`);
  }
  return lines;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node bench/marketplace/report.mjs summary.json");
  console.log(report(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}
