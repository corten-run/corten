// Read-only: strict reporting also checks the requested local Git object.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { descriptor, identity, k6Image, nodeImage, payloads, phases, runtimeContext, scheduledProducerMarker, scheduledProducerSchema, schema, sha256, timingPlan, verifyImage, verifyImageExecution, verifyNativeReceipt, verifyParticipants, verifyRuntime } from "./contract.mjs";
import { reader } from "./artifacts.mjs";
import { functionalVerifier, verifyFunctionalFailure, verifyFunctionalLiveness, verifyAggregates, verifyRun } from "./evidence.mjs";
import { spread } from "../fullstack/passes.mjs";
import { verifyK6Provenance } from "../load-tool.mjs";
import { isDeepStrictEqual } from "node:util";
import { timedSummarySchema, timedCaseProjection } from "./timed-outcomes.mjs";
import { legacyProducerSchema, producerSourceNames, verifyProducer } from "./production.mjs";
import { replayTimedRun } from "./evidence.mjs";
import { describePlacement, recordedPlacement } from "./placement.mjs";

function gitAtMeasuredCheckout(repo, args, options) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return spawnSync("git", ["--no-replace-objects", "-C", repo, ...args], {
    env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true, timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"], ...options,
  });
}
function requireMeasuredCommit(commit) {
  assert.ok(typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit), "full measured commit required for strict reporting");
}
export function producerPolicyAtCommit(commit, repo = process.cwd()) {
  requireMeasuredCommit(commit);
  const result = gitAtMeasuredCheckout(repo, ["ls-tree", "--full-tree", "-z", `${commit}^{commit}`, "--", scheduledProducerMarker],
    { encoding: "utf8", maxBuffer: 16 * 1024 });
  assert.ok(result.status === 0 && !result.error, "cannot read strict JSON producer policy at measured commit");
  if (!result.stdout) return legacyProducerSchema;
  assert.ok(/^100(?:644|755) blob [a-f0-9]{40}\t/.test(result.stdout) && result.stdout.split("\t")[1] === scheduledProducerMarker + "\0",
    "invalid committed JSON load sampler marker");
  return scheduledProducerSchema;
}

export function verifyProducerAtCommit(producer, commit, repo = process.cwd()) {
  requireMeasuredCommit(commit);
  for (const name of producerSourceNames(producer?.schema)) {
    const result = gitAtMeasuredCheckout(repo, ["cat-file", "blob", `${commit}^{commit}:bench/json-api/${name}`], { maxBuffer: 1024 ** 2 });
    assert.ok(result.status === 0 && !result.error, `cannot read measured JSON producer file: ${name}`);
    assert.ok(producer.sources?.[name] === sha256(result.stdout), `JSON producer differs from measured commit: ${name}`);
  }
}

export function inspectJson(summary, { load, commit } = {}) {
  if (commit !== undefined) assert.equal(summary.group?.contractSha256, descriptor().contractSha256,
    "strict comparison requires this checkout's roster; use the measured checkout to qualify a historical group");
  return inspectReport(summary, { load, commit, verifySource: commit === undefined ? undefined : () => {
    const required = producerPolicyAtCommit(commit);
    const timed = summary.schema === timedSummarySchema;
    if (required === scheduledProducerSchema || timed)
      assert.ok(timed && summary.producer?.schema === required, "JSON producer differs from the measured commit policy");
    if (timed) verifyProducerAtCommit(summary.producer, commit);
  } });
}

// Isolated callers supply their trusted source-binding gate instead of probing local Git.
export function inspectBoundJson(summary, { load, commit, verifyBoundProducer }) {
  requireMeasuredCommit(commit);
  verifyBoundProducer(summary);
  return inspectReport(summary, { load, commit });
}

function inspectReport(summary, { load, commit, verifySource }) {
  const timed = summary.schema === timedSummarySchema;
  assert.ok(summary.schema === schema || timed, "not a json-api result schema");
  assert.deepEqual(summary.group, descriptor(summary.group?.contractSha256), "JSON group contract/selection differs");
  assert.deepEqual(summary.options?.apps, summary.group.apps, "exact JSON registry selection required");
  assert.equal(summary.options.group, "json-api");
  assert.match(summary.round ?? "", /^j[1-9]\d*$/); assert.equal(summary.options.round, summary.round);
  assert.ok([1, 3, 5].includes(summary.options.passes), "invalid pass count");
  assert.ok(typeof load === "function", "raw evidence reader required");
  const warnings = [], apps = {}, cases = summary.group.cases, preparationGates = [], execution = new Map();
  const gated = summary.timingDisposition === "gated-functional";
  const preparation = timed && summary.options.checkOnly === true;
  const problem = (label, error) => warnings.push(`${label}: ${error.message ?? error}`);
  const check = (label, fn, preparation = true) => {
    let valid = false;
    try { fn(); valid = true; } catch (error) { problem(label, error); }
    if (preparation) preparationGates.push(valid);
    return valid;
  };
  check("provenance", () => {
    assert.match(summary.commit ?? "", /^[a-f0-9]{40}$/, "full measured commit missing");
    if (commit !== undefined) assert.equal(summary.commit, commit, "measured commit differs");
    assert.equal(summary.commitAfter, summary.commit, "after-run HEAD missing/changed");
    assert.equal(summary.dirty, false, "tree dirty before run"); assert.equal(summary.dirtyAfter, false, "tree dirty after run");
    assert.ok(Number.isFinite(Date.parse(summary.startedAt)) && Number.isFinite(Date.parse(summary.finishedAt))
      && Date.parse(summary.finishedAt) >= Date.parse(summary.startedAt), "missing/invalid terminal clock");
  });
  if (verifySource) check("producer provenance", verifySource);
  check("configuration", () => {
    if (timed) verifyProducer(summary.producer);
    assert.deepEqual(summary.timingPlan, timingPlan(summary.options, summary.group.contractSha256), "missing/wrong effective timing plan");
    for (const [key, max] of [["duration", 300], ["warmup", 120], ["rate", 10000], ["startupTimeout", 300]]) {
      assert.ok(Number.isSafeInteger(summary.options[key]) && summary.options[key] >= 1 && summary.options[key] <= max, `invalid ${key}`);
    }
    // An unmarked summary is the default placement exactly as before; only an explicit
    // A named layout with its own recorded cold probe and sampler CPUs admits a wider generator.
    let placed;
    try { placed = recordedPlacement(summary.measurement); }
    catch { assert.fail("missing/wrong CPU quotas or placement"); }
    const { cpus: expected, generatorPlacement } = placed;
    assert.deepEqual(summary.measurement, { cpus: expected,
      ...(generatorPlacement === undefined ? {} : { loadLayout: placed.placement, generatorPlacement }), encoding: "identity", fixedRate: summary.options.rate,
      appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, loadMemoryBytes: 2 ** 31,
      nativeProfile: "framework-default", phases: ["warmup", ...phases] }, "measurement settings differ");
    assert.ok(summary.timingDisposition === undefined || gated, "unknown timing disposition");
    for (const tool of ["node", "k6"]) {
      assert.match(summary.tools?.[tool]?.imageId ?? "", /^sha256:[0-9a-f]{64}$/, `missing ${tool} immutable tool image`);
      // Image pins are this checkout's, so saved evidence replays from a checkout of its measured commit.
      const pin = tool === "node" ? nodeImage : k6Image;
      const measured = typeof summary.commit === "string" && /^[a-f0-9]{40}$/.test(summary.commit) ? `the measured commit ${summary.commit}` : "its measured commit";
      assert.ok(summary.tools[tool].image === pin, `wrong ${tool} image reference: not this checkout's pin ${pin}; report from a checkout of ${measured}`);
      verifyImageExecution(summary.toolExecutions?.[tool]);
    }
    verifyK6Provenance(summary.tools.k6, { verb: "report", commit: summary.commit });
  });
  const fixtures = {}, functionalVerifiers = {};
  check("fixture set", () => assert.deepEqual(Object.keys(summary.fixtures ?? {}).sort(), Object.keys(payloads).sort()));
  for (const [payload, p] of Object.entries(payloads)) check(`${payload} fixture`, () => {
    const fixture = load(summary.fixtures[payload]);
    assert.deepEqual(fixture, p.records(), "fixture differs from canonical payload"); fixtures[payload] = fixture;
    for (const profile of cases.filter((p) => p.payload === payload)) functionalVerifiers[profile.key] = functionalVerifier(profile, fixture);
  });
  check("selected apps", () => assert.deepEqual(Object.keys(summary.apps ?? {}).sort(), [...summary.group.apps].sort(), "missing/extra selected app rows"));
  for (const app of summary.group.apps) {
    const entry = summary.apps?.[app], rows = apps[app] = {};
    check(`${app} images`, () => {
      assert.deepEqual(Object.keys(entry?.images ?? {}).sort(), Object.keys(payloads).sort(), "missing/extra native image payload");
      for (const payload of Object.keys(payloads)) verifyImage(entry.images[payload], summary.commit, app, payload, summary.group.contractSha256);
    });
    for (const section of ["checks", "runs", "aggregates", ...(timed ? ["projections"] : [])]) check(`${app} ${section} matrix`, () => {
      assert.deepEqual(Object.keys(entry?.[section] ?? {}).sort(), cases.map((c) => c.key).sort(), "missing/extra payload/source/target evidence");
    });
    for (const profile of cases) {
      const key = profile.key, row = rows[key] = { functional: false, nativeQualified: false, complete: false, passes: 0, rps: null };
      const expected = entry && summary.measurement ? identity(summary, app, profile) : null;
      if (timed) row.projection = timedCaseProjection([], summary.options.passes);
      let native, derivedRuns = [];
      const checked = entry?.checks?.[key];
      row.functionalComplete = check(`${app} ${key} functional`, () => {
        assert.deepEqual(checked?.identity, expected, "missing/wrong functional identity");
        const raw = load(checked.raw); assert.deepEqual(raw.identity, expected, "wrong raw functional identity");
        const context = runtimeContext(summary, profile);
        verifyRuntime(raw.runtime, expected, context); verifyParticipants(raw, expected, context, ["upstream"]);
        if (checked.failure !== undefined) {
          assert.equal(checked.functional, undefined, "contradictory positive/negative check");
          const failure = load(checked.failure);
          verifyFunctionalFailure(failure, raw.events, expected, fixtures[profile.payload], { historical: !timed });
          verifyFunctionalLiveness(raw, failure);
          assert.ok(failure.clock.startedAt >= Date.parse(summary.startedAt) && failure.clock.finishedAt <= Date.parse(summary.finishedAt), "checker outside native run");
          assert.ok(Object.values(raw.liveness).every((s) => Date.parse(s.startedAt) >= Date.parse(summary.startedAt)), "participant started before native run");
        } else { functionalVerifiers[key](checked.functional, raw.events); row.functional = true; }
      });
      row.nativeQualified = check(`${app} ${key} native audit`, () => {
        native = load(checked?.native);
        verifyNativeReceipt(native.receipt, expected, native.files, { timed });
        assert.equal(checked.nativeSerializationVerified, true, "native audit not qualified");
        assert.equal(checked.nativeSourceVerified, true, "native source audit not qualified");
      }, false);
      const runs = entry?.runs?.[key] ?? [];
      let observationComplete = true, targetFailed = false;
      const timing = check(`${app} ${key} timing`, () => {
        if (gated || preparation) {
          assert.deepEqual(entry.runs[key], [], "timing started despite global parity gate or check-only mode");
          assert.deepEqual(entry.aggregates[key], {}, "aggregates present despite global parity gate");
          if (timed) assert.ok(isDeepStrictEqual(entry.projections?.[key], timedCaseProjection([], summary.options.passes)), "timing projection present despite global parity gate");
          return;
        }
        assert.ok(Array.isArray(runs), "timing passes must be an array");
        const used = new Set(); let replayed = true;
        // Each saved pass replays on its own, so an invalid or unfinished pass cannot
        // hide later valid passes; its own failure stays a warning and the row incomplete.
        for (const run of runs) replayed = check(`${app} ${key} timing pass ${run?.pass}`, () => {
          assert.ok(Number.isInteger(run?.pass) && run.pass >= 1 && run.pass <= summary.options.passes && !used.has(run.pass), "duplicate/wrong pass");
          used.add(run.pass);
          const passExpected = { ...expected, pass: run.pass }, context = runtimeContext(summary, profile);
          if (timed) {
            let replay;
            try { replay = replayTimedRun(run, passExpected, summary.options, load, summary.tools, context, native); }
            catch (error) {
              // Keep the independently joined phases before an apparatus fault, never as a complete pass.
              try { derivedRuns.push(replayTimedRun(run, passExpected, summary.options, load, summary.tools, context, native, { prefix: true })); } catch {}
              throw error;
            }
            derivedRuns.push(replay);
            execution.set(`${app}/${key}/${run.pass}`, replay.window);
          } else verifyRun(run, passExpected, summary.options, load, summary.tools, context);
          row.passes++;
        }, false) && replayed;
        if (timed) {
          row.projection = timedCaseProjection(derivedRuns, summary.options.passes);
          assert.ok(isDeepStrictEqual(row.projection, entry.projections?.[key]), "saved timed pass projection differs from raw replay");
        }
        assert.ok(replayed, "one or more JSON timing passes failed replay");
        assert.equal(runs.length, summary.options.passes, "missing requested JSON passes");
        verifyAggregates(entry.aggregates[key], runs, summary.options.passes);
      }, preparation);
      if (timed) {
        // Preserve only independently replayed cells when another pass is missing
        // or invalid. A saved projection never supplies trusted fallback numbers.
        row.projection = timedCaseProjection(derivedRuns, summary.options.passes);
        for (const replay of derivedRuns) for (const o of Object.values(replay.phases)) {
          observationComplete &&= o.observationComplete; targetFailed ||= o.targetOutcome === "failed";
        }
        observationComplete &&= timing && row.projection.loadOutcome !== "incomplete";
        row.timedOutcome = gated ? "not-run-functional-gate" : preparation ? "not-run-check-only" : !observationComplete ? "incomplete" : targetFailed ? "failed" : "passed";
        row.comparisonEligible = observationComplete && !targetFailed ? true : null;
        if (!observationComplete && timing && !gated && !preparation) problem(`${app} ${key} attribution`, Object.values(derivedRuns).flatMap((r) => Object.values(r.phases).flatMap((p) => p.incompleteReasons)).join("; "));
      }
      // Partial values are retained and labeled, never zero-filled or a complete comparison.
      const available = timed ? derivedRuns.filter((r) => r.phases.sat64).map((r) => ({ phases: Object.fromEntries(Object.entries(r.phases).map(([p, metrics]) => [p, { metrics }])) }))
        : Array.isArray(runs) ? runs.filter((r) => r.phases?.sat64?.metrics?.rps > 0) : [];
      if (available.length) {
        const values = available.map((r) => r.phases.sat64.metrics.rps).sort((a, b) => a - b);
        row.rps = { median: values[Math.floor((values.length - 1) / 2)], min: values[0], max: values.at(-1), unverifiedPartial: !timing };
        row.efficiency = Object.fromEntries(["perCpuSecond", "memMaxMiB", "p95", "cpuAvgPct"].map((metric) => [metric, spread(available.map((r) => r.phases.sat64.metrics[metric]))]));
        row.efficiency.upstreamCpuAvgPct = spread(available.map((r) => r.phases.sat64.metrics.upstream?.cpuAvgPct));
      }
      row.complete = row.functional && row.nativeQualified && timing && !gated && (!timed || observationComplete && !targetFailed);
      row.attemptComplete = row.functionalComplete && row.nativeQualified && timing && (!timed || gated || observationComplete);
      if (row.rps && !row.complete) row.rps.unverifiedPartial = true;
    }
  }
  const negative = Object.values(apps).some((rows) => Object.values(rows).some((r) => r.functionalComplete && !r.functional));
  if (timed && !gated && !preparation) check("executed matrix continuity", () => {
    const seen = new Set(), tails = {}, upstreamLives = {}; let previousEnd = Date.parse(summary.startedAt);
    for (const item of timingPlan(summary.options, summary.group.contractSha256)) {
      const window = execution.get(`${item.app}/${item.profile.key}/${item.pass}`), payload = item.profile.payload;
      assert.ok(window && window.startedAt >= previousEnd && window.finishedAt >= window.startedAt, "missing/overlapping/reordered native timing cell");
      assert.ok(!seen.has(window.appId), "native app reused across timing passes/cases"); seen.add(window.appId);
      assert.ok(isDeepStrictEqual(window.readsBefore, tails[payload] ?? {}), "cross-case upstream reads/contamination");
      if (upstreamLives[payload]) assert.ok(isDeepStrictEqual(window.upstreamLife, upstreamLives[payload]), "upstream replaced/restarted between timing cases");
      upstreamLives[payload] = window.upstreamLife; tails[payload] = window.readsAfter; previousEnd = window.finishedAt;
    }
    const terminal = load(summary.readTail);
    assert.ok(Number.isSafeInteger(terminal.at) && terminal.at >= previousEnd && terminal.at <= Date.parse(summary.finishedAt), "final upstream read observation clock missing");
    assert.ok(isDeepStrictEqual(terminal.reads, tails), "upstream reads after final app teardown");
  }, false);
  const timedNegative = timed && Object.values(apps).some((rows) => Object.values(rows).some((r) => r.timedOutcome === "failed"));
  if (negative || timed) check("owned cleanup", () => assert.deepEqual(load(summary.cleanup), { runId: summary.runId, containers: [], networks: [] }, "owned resource cleanup is not proven"));
  check("suite outcome", () => {
    assert.equal(gated, negative, "global timing disposition differs from replayed functional outcomes");
    assert.equal(summary.complete, timed ? !preparation && !gated && !timedNegative && Object.values(apps).every((rows) => Object.values(rows).every((r) => r.complete)) : !gated, "runner outcome differs from replayed gates");
    assert.equal(summary.checksPassed, preparation ? Object.values(apps).every((rows) => Object.values(rows).every((r) => r.functional && r.nativeQualified)) : !gated);
    if (timed) assert.equal(summary.attemptComplete, !preparation && Object.values(apps).every((rows) => Object.values(rows).every((r) => r.attemptComplete)), "runner attempt outcome differs from replay");
    if (gated) {
      assert.ok(negative, "no replayed target violation for global gate");
    }
    assert.deepEqual(summary.failures, [], "recorded runner failures"); assert.deepEqual(summary.cleanupFailures, [], "recorded cleanup failures");
    assert.notEqual(summary.options.checkOnly, true, "check-only evidence is not a timed baseline");
  }, false);
  const baseline = warnings.length === 0 && !gated && !negative && !timedNegative;
  const attemptComplete = warnings.length === 0;
  const functionalAttemptComplete = preparationGates.every(Boolean);
  const outcomes = summary.group.apps.map((app) => ({ app, outcome: timed && !attemptComplete ? "incomplete"
    : Object.values(apps[app]).some((r) => r.functionalComplete && !r.functional || r.timedOutcome === "failed") ? "failed"
    : Object.values(apps[app]).some((r) => !r.functionalComplete || timed && !r.attemptComplete) ? "incomplete" : "passed" }));
  // A coherent, supported timed target failure blames only its app. Peers stay comparable
  // only when every report-wide and per-row gate (harness, provenance, source/native audit,
  // headroom, continuity, cleanup) passed, i.e. the attempt has no warning at all.
  const peers = timed && attemptComplete && !gated && !negative && timedNegative;
  const comparisonEligibleApps = baseline ? [...summary.group.apps]
    : peers ? summary.group.apps.filter((app) => Object.values(apps[app]).every((r) => r.complete)) : [];
  for (const [app, rows] of Object.entries(apps)) for (const row of Object.values(rows)) {
    const eligible = comparisonEligibleApps.includes(app);
    if (row.rps) row.rps.unverifiedPartial = !eligible;
    if (timed) row.comparisonEligible = eligible ? true : null;
    if (timed && !attemptComplete && ["passed", "failed"].includes(row.timedOutcome)) row.timedOutcome = "incomplete";
  }
  const failedApps = outcomes.filter((o) => o.outcome === "failed").map((o) => o.app);
  return { group: summary.group, round: summary.round, commit: summary.commit, baseline, attemptComplete, functionalAttemptComplete,
    outcomes, comparisonEligibleApps, apps, warnings,
    config: { options: summary.options, measurement: summary.measurement, timingPlan: summary.timingPlan, commitAfter: summary.commitAfter, dirty: summary.dirty, dirtyAfter: summary.dirtyAfter },
    status: baseline ? "COMPLETE" : !attemptComplete ? "INCOMPLETE: not a baseline"
      : peers ? `COMPLETE ATTEMPT: timed target failure (${failedApps.join(", ")}); not a baseline; comparison eligible only for independently complete apps (${comparisonEligibleApps.join(", ") || "none"})`
      : `COMPLETE ATTEMPT: ${timedNegative ? "timed target" : "functional"} failure; not a baseline`,
    fixtureHashes: Object.fromEntries(Object.entries(fixtures).map(([p, f]) => [p, sha256(JSON.stringify(f))])) };
}

export function renderJson(report) {
  const config = report.config;
  const lines = [`# JSON API ${report.round}`, "", `**${report.status}**`, "", `Measured commit: \`${report.commit ?? "unknown"}\`.`,
    `Registry: \`${report.group.registrySchema}\`; contract SHA-256: \`${report.group.contractSha256}\`.`, "",
    `After-run commit: \`${config.commitAfter ?? "missing"}\`; dirty before/after: ${config.dirty ?? "missing"}/${config.dirtyAfter ?? "missing"}.`,
    `Requested passes: ${config.options.passes}; duration/warmup: ${config.options.duration}/${config.options.warmup} s; fixed rate: ${config.options.rate} req/s; encoding: ${config.measurement?.encoding ?? "missing"}.`,
    "Timing order: pass, registry profile, then rotated app order; rotation offset is floor((pass - 1) * apps / passes). The exact effective schedule is retained in summary.timingPlan, not proof it executed.",
    "Native JSON only: catalog-v1 and marketplace-v2 stay distinct, with fixture/API sources. No HTML, forms or browser qualification.",
    "Functional checks do not prove native serialization. A separate audited native source receipt is required for every app/case.",
    "Throughput is the median [min, max] of sat64 passes, not a claim of CPU saturation. Unverified partial numbers are not comparisons.",
    `Outcomes: ${report.outcomes.map((o) => `${o.app} ${o.outcome}`).join(", ")}. Comparison-eligible apps: ${report.comparisonEligibleApps.join(", ") || "none"}.`, "",
    "| App | Payload / source | Functional | Native audit | Verified passes | req/s | req/CPU-s | Peak MiB | p95 ms | App CPU % | Upstream CPU % |", "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const [app, rows] of Object.entries(report.apps)) for (const profile of report.group.cases) {
    const r = rows[profile.key], rate = r.rps ? `${r.rps.median} [${r.rps.min}, ${r.rps.max}]${r.rps.unverifiedPartial ? " (unverified partial)" : ""}` : "pending";
    const metric = (key) => r.efficiency?.[key]?.median ?? "pending";
    lines.push(`| ${app} | ${profile.payload} / ${profile.source} | ${r.functional} | ${r.nativeQualified} | ${r.passes} | ${rate} | ${metric("perCpuSecond")} | ${metric("memMaxMiB")} | ${metric("p95")} | ${metric("cpuAvgPct")} | ${metric("upstreamCpuAvgPct")} |`);
  }
  if (Object.values(report.apps).some((rows) => Object.values(rows).some((r) => r.projection))) {
    lines.push("", "## Timed Outcomes", "", "Observed request/offer extent is separate from nominal configuration. Null comparisons are not zero baselines.",
      "", "| App | Case | Phase | Failed passes | Missing/incomplete passes | Requests min/median/max | Failed requests min/median/max | Successful req/s min/median/max |", "|---|---|---|---|---|---|---|---|");
    const range = (r) => r ? `${r.min}/${r.median}/${r.max}` : "missing";
    for (const [app, rows] of Object.entries(report.apps)) for (const [key, row] of Object.entries(rows)) for (const phase of phases) {
      const cell = row.projection.byPhase[phase];
      lines.push(`| ${app} | ${key} | ${phase} | ${cell.failedPasses.join(",") || "none"} | ${cell.incompletePasses.join(",") || "none"} | ${range(cell.ranges.requests)} | ${range(cell.ranges.failed)} | ${range(cell.ranges.successfulRps)} |`);
    }
  }
  lines.push("", "| CPU role | Quota, cores | Logical CPU pinning |", "|---|---:|---|");
  for (const role of ["app", "load", "api"]) {
    const budget = config.measurement?.cpus?.[role]; lines.push(`| ${role} | ${budget?.quota ?? "missing"} | ${budget?.cpuset === null ? "unpinned" : budget?.cpuset ?? "missing"} |`);
  }
  // Fixed text from this checkout's layout, never the saved values; the configuration check validates those.
  if (config.measurement?.loadLayout !== undefined) {
    const layout = config.measurement.loadLayout, setting = describePlacement(layout);
    lines.push("", setting
      ? `Load layout ${layout}: the untimed cold probe ran on CPUs ${setting.coldProbe.cpuset} at quota ${setting.coldProbe.quota}; load resource samples are bounded against k6's quota ${setting.loadSampler.quota} on CPUs ${setting.loadSampler.cpuset}. This is apparatus placement for a ${setting.logicalCpus}-CPU host, not a measured speedup.`
      : "Load layout: unknown (see the configuration check).");
  }
  lines.push("", "## Limits", "", "CPU is whole-container cgroup usage. The upstream is a single Node process and can limit throughput independently. Cold time is Docker container-start to first complete 200, not process exec. No build, browser, instruction-count or deployment parity claim is made.");
  for (const warning of report.warnings) lines.push(`- ${warning.replace(/[\r\n]+/g, " ")}`);
  return `${lines.join("\n")}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, ...args] = process.argv.slice(2); assert.ok(file, "summary.json required");
    let commit, strict = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--require-complete" && !strict) strict = true;
      else if (args[i] === "--commit" && commit === undefined && /^[0-9a-f]{40}$/.test(args[i + 1] ?? "")) commit = args[++i];
      else throw new Error(`unknown/duplicate report argument ${args[i]}`);
    }
    const summary = JSON.parse(readFileSync(file, "utf8"));
    const load = reader(dirname(file));
    const measured = commit ?? summary.commit;
    if (strict) requireMeasuredCommit(measured);
    const report = strict ? inspectJson(summary, { load, commit: measured }) : inspectReport(summary, { load, commit });
    console.log(renderJson(report));
    if (strict && !report.baseline) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
