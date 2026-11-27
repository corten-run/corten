// Read-only reporting, including old/unfinished runs. Never starts Docker or changes results.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { allApps } from "../fullstack/apps.mjs";
import { aggregate, cpuSettings, expectedPageChecks, phases, leanApps, leanProfile, recordedLeanApps, verifyDocumentHeaderChecks } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { groupDescriptor, inspectGroupEvidence } from "./group.mjs";
import { dirname } from "node:path";

const inventory = Object.keys(allApps).filter((name) => allApps[name].pages !== false);
const keys = ["fixture-page", "fixture-json", "api-page", "api-json"];
const fixture = records();
const canonicalFixtureSha256 = createHash("sha256").update(`${JSON.stringify(fixture)}\n`).digest("hex");
const checkedPageCount = expectedPageChecks(fixture);
const profileKeys = ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].flatMap((p) => [false, true].map((js) => `${p}:${js}`));
export function completeChecks(check, source) {
  if (check?.jsonRecords !== 500 || !Number.isInteger(check.pages) || check.pages < checkedPageCount || !Array.isArray(check.profiles) || check.profiles.length !== 8) return false;
  const profiles = check.profiles.map((p) => `${p.profile}:${p.javaScriptEnabled}`);
  if (new Set(profiles).size !== 8 || !profileKeys.every((key) => profiles.includes(key))
    || !check.profiles.every((p) => typeof p.javaScriptEnabled === "boolean" && p.forms === true && p.related === true && p.styles === true)) return false;
  return source === "fixture" || (check.upstream?.readsPerRequest === 1
    && ["uncachedPage", "uncachedJson", "jsonReserialized", "errors"].every((key) => check.upstream[key] === true));
}
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const range = (values) => values.length ? { median: median(values), min: Math.min(...values), max: Math.max(...values) } : null;
const documentHeaderContract = groupDescriptor("catalog-page").documentHeaders;
// Ungrouped runs since the document header contract check only the lean contenders, so
// their twenty-app table mixes two correctness contracts. Legacy ungrouped runs carry
// neither the recorded scope nor header evidence and keep their original report.
function documentHeaderScope(summary, group, apps) {
  const recorded = summary.measurement?.documentHeaders;
  if (group) {
    assert.equal(recorded, undefined, "group runs record their document header contract in the group descriptor");
    return null;
  }
  if (recorded !== undefined) assert.deepEqual(recorded, { contract: documentHeaderContract, apps: recordedLeanApps(summary) }, "catalog document header scope differs");
  const evidence = Object.values(summary.apps).some((entry) => ["fixture", "api"].some((source) =>
    entry?.checks?.[source] && Object.hasOwn(entry.checks[source], "documentHeaders")));
  if (recorded === undefined && !evidence) return null;
  return { contract: documentHeaderContract, scope: recorded === undefined ? "inferred from header evidence" : "recorded by the runner",
    checked: apps.filter((app) => leanApps.includes(app)), unchecked: apps.filter((app) => !leanApps.includes(app)) };
}
function validCpuSettings(cpus, loadLayout, grouped) {
  try {
    const roles = ["app", "load", "api"];
    if (!roles.every((role) => cpus?.[role]?.cpuset === null || (typeof cpus?.[role]?.cpuset === "string" && cpus[role].cpuset.length > 0))) return false;
    if (loadLayout !== undefined && !grouped) return false;
    const checked = cpuSettings(Object.fromEntries(roles.map((role) => [`CATALOG_${role.toUpperCase()}_CPUS`, cpus[role].cpuset])), loadLayout);
    return roles.every((role) => cpus[role].quota === checked[role].quota);
  } catch { return false; }
}

export function inspectCatalog(summary, expectedCommit) {
  assert.equal(summary.workload, "catalog-v1", "not a catalog-v1 result");
  assert.match(summary.round ?? "", /^c[1-9]\d*$/, "not a catalog round");
  assert.match(summary.commit ?? "", /^[0-9a-f]{40}$/, "missing full measured commit");
  if (expectedCommit !== undefined) assert.equal(summary.commit, expectedCommit, "measured commit differs");
  const passes = summary.options?.passes;
  assert.ok([1, 3, 5].includes(passes), "invalid requested pass count");
  assert.ok(summary.apps && !Array.isArray(summary.apps), "missing apps");
  assert.ok(Array.isArray(summary.failures) && Array.isArray(summary.cleanupFailures), "missing failure records");
  if (summary.measurement?.leanProfile !== undefined) {
    assert.deepEqual(summary.measurement.leanProfile, { name: leanProfile, apps: recordedLeanApps(summary) }, "catalog lean configuration differs");
  }
  const group = inspectGroupEvidence(summary, phases, aggregate);
  const workers = summary.savedEvidence?.schema === "catalog-saved-evidence/v4";
  const timed = workers || summary.savedEvidence?.schema === "catalog-saved-evidence/v3";
  assert.ok(!timed || group?.descriptor.group === "catalog-page", "timed catalog reporting requires --group catalog-page");
  const expectedApps = group?.descriptor.apps ?? inventory;
  const reportKeys = group?.keys ?? keys;
  const headerScope = documentHeaderScope(summary, group, expectedApps.filter((app) => Object.hasOwn(summary.apps, app)));
  const mixed = headerScope !== null && headerScope.checked.length > 0 && headerScope.unchecked.length > 0;
  const warnings = [...(group?.warnings ?? [])];
  if (mixed) warnings.push(`Mixed correctness contracts: ${headerScope.checked.length} apps were checked against ${headerScope.contract} and ${headerScope.unchecked.length} were not; this run is not a feature-parity comparison or baseline. Use --group catalog-page for a qualified comparison.`);
  const failures = [...summary.failures, ...summary.cleanupFailures].map((f) => `${f.app ?? f.resource ?? "suite"}: ${f.stage ?? "cleanup"}: ${f.error}`);
  const selected = summary.options.apps;
  const allAppsPresent = Array.isArray(selected) && selected.length === expectedApps.length && new Set(selected).size === expectedApps.length
    && expectedApps.every((app) => selected.includes(app))
    && Object.keys(summary.apps).length === expectedApps.length && expectedApps.every((app) => Object.hasOwn(summary.apps, app));
  if (!allAppsPresent) warnings.push(group ? "Not all registry group apps are present; this is not a complete group comparison." : "Not all twenty page apps are present; this is not a full catalog baseline.");
  if (summary.dirty !== false) warnings.push("The measured tree was dirty or its cleanliness was not recorded.");
  if (summary.checksPassed !== true) warnings.push("The suite's correctness checks did not all pass.");
  const fixtureMatches = summary.fixtureSha256 === canonicalFixtureSha256;
  if (!fixtureMatches) warnings.push("Fixture identity is missing or differs from the canonical catalog-v1 fixture.");
  const config = { duration: summary.options.duration, warmup: summary.options.warmup, rate: summary.options.rate,
    cpus: summary.measurement?.cpus, encoding: summary.measurement?.encoding, fixtureSha256: summary.fixtureSha256,
    ...(summary.measurement?.leanProfile ? { leanProfile: summary.measurement.leanProfile } : {}),
    ...(workers ? { apparatus: summary.measurement.apparatus, qualification: "first-host preflight required; summary-only report is not raw replay" } : {}),
    startedAt: summary.startedAt, finishedAt: summary.finishedAt,
    ...(group ? { commitAfter: summary.commitAfter, dirtyAfter: summary.dirtyAfter } : {}) };
  const configurationComplete = [config.duration, config.warmup, config.rate].every((n) => Number.isSafeInteger(n) && n > 0)
    && config.encoding === "identity" && summary.measurement?.fixedRate === config.rate
    && validCpuSettings(config.cpus, summary.measurement?.loadLayout, group?.descriptor?.group === "catalog-page" && workers);
  if (!configurationComplete) warnings.push("Measurement configuration is missing or inconsistent; duration, warmup, fixed rate, encoding and CPU placement must be recorded.");
  let everyCheck = true;
  let everyPass = true;
  const apps = Object.fromEntries(expectedApps.map((app) => {
    const entry = summary.apps[app];
    for (const source of ["fixture", "api"]) if (!completeChecks(entry?.checks?.[source], source)) {
      everyCheck = false;
      warnings.push(`${app} ${source}: missing or contradictory JSON, page, browser-profile or upstream correctness evidence.`);
    }
    if (headerScope?.unchecked.includes(app)) for (const source of ["fixture", "api"]) {
      if (entry?.checks?.[source] && Object.hasOwn(entry.checks[source], "documentHeaders")) {
        everyCheck = false;
        warnings.push(`${app} ${source}: document header evidence outside the runner's header-checked apps.`);
      }
    }
    if (group?.descriptor.documentHeaders || headerScope?.checked.includes(app)) for (const source of ["fixture", "api"]) {
      try { verifyDocumentHeaderChecks(entry?.checks?.[source]?.documentHeaders, fixture, source); }
      catch {
        everyCheck = false;
        warnings.push(`${app} ${source}: missing or invalid document header observations.`);
      }
    }
    if (entry?.failures?.length) { everyCheck = false; warnings.push(`${app}: per-app failures are recorded.`); }
    const results = Object.fromEntries(reportKeys.map((key) => {
      const runs = entry?.runs?.[key] ?? [];
      assert.ok(Array.isArray(runs), `${app} ${key}: runs must be an array`);
      const used = new Set();
      const values = [];
      for (const run of runs) {
        assert.ok(Number.isInteger(run.pass) && run.pass >= 1 && run.pass <= passes && !used.has(run.pass), `${app} ${key}: duplicate or invalid pass`);
        used.add(run.pass);
        const phase = run.phases?.sat64;
        if (!phase) continue;
        const valid = [phase.rps, phase.perCpuSecond, phase.memMaxMiB].every((n) => finite(n) && n > 0)
          && finite(phase.cpuAvgPct) && phase.cpuAvgPct >= 0 && finite(phase.p95) && phase.p95 >= 0
          && (timed ? ["passed", "failed"].includes(phase.outcome) && finite(phase.successfulRps) : phase.failed === 0 && phase.dropped === 0);
        if (!valid) {
          warnings.push(`${app} ${key} pass ${run.pass}: invalid or unsuccessful sat64 measurement omitted.`);
          continue;
        }
        if (run.complete !== true || run.failed) warnings.push(`${app} ${key} pass ${run.pass}: sat64 is available, but the whole run did not complete successfully.`);
        const quota = summary.measurement?.cpus?.app?.quota;
        if (!finite(quota) || quota <= 0) warnings.push(`${app} ${key} pass ${run.pass}: app CPU quota missing; saturation cannot be assessed.`);
        else if (phase.cpuAvgPct < quota * 95) warnings.push(`${app} ${key} pass ${run.pass}: app CPU ${phase.cpuAvgPct.toFixed(1)}% of ${quota * 100}%; observed throughput is not proven capacity.`);
        if (key.startsWith("api-")) {
          if (!finite(phase.upstream?.cpuAvgPct)) warnings.push(`${app} ${key} pass ${run.pass}: upstream CPU missing; upstream limit cannot be assessed.`);
          else if (phase.upstream.highCpu || !workers && phase.upstream.cpuAvgPct >= 80) warnings.push(`${app} ${key} pass ${run.pass}: busy ${workers ? "fixed two-worker" : "single-process"} upstream (${phase.upstream.cpuAvgPct.toFixed(1)}% CPU) may limit throughput.`);
        }
        values.push(phase);
      }
      const complete = values.length === passes && runs.length === passes && runs.every((r) => r.complete === true && !r.failed);
      everyPass &&= complete;
      return [key, { passes: values.length, asked: passes, complete,
        rps: range(values.map((v) => timed ? v.successfulRps : v.rps)), perCpuSecond: range(values.map((v) => v.perCpuSecond)),
        memMaxMiB: range(values.map((v) => v.memMaxMiB)), cpuAvgPct: range(values.map((v) => v.cpuAvgPct)),
        p95: range(values.map((v) => v.p95)) }];
    }));
    return [app, results];
  }));
  const terminal = typeof summary.finishedAt === "string" && Number.isFinite(Date.parse(summary.finishedAt));
  if (summary.finishedAt !== undefined && !terminal) warnings.push("Invalid completion timestamp; terminal status cannot be established.");
  const started = Date.parse(summary.startedAt);
  const validClock = terminal && Number.isFinite(started) && Date.parse(summary.finishedAt) >= started;
  if (!validClock) warnings.push("Start/end timestamps do not establish a completed, non-negative elapsed duration.");
  const targetFailures = timed ? expectedApps.flatMap((app) => (group?.descriptor.cases ?? []).flatMap(({ source, target }) =>
    (summary.apps[app]?.runs?.[`${source}-${target}`] ?? []).flatMap((run) => phases.flatMap((phase) => {
      const metrics = run.phases?.[phase];
      return metrics?.outcome === "failed" ? [{ app, source, target, pass: run.pass, phase, failed: metrics.failed,
        timeouts: metrics.timeouts, httpErrors: metrics.httpErrors, dropped: metrics.dropped }] : [];
    })))) : [];
  const ordered = (rows) => [...rows].sort((a, b) => `${a?.app}/${a?.source}/${a?.target}/${a?.pass}/${a?.phase}`.localeCompare(`${b?.app}/${b?.source}/${b?.target}/${b?.pass}/${b?.phase}`));
  const dispositionComplete = !timed || Array.isArray(summary.targetFailures)
    && isDeepStrictEqual(ordered(summary.targetFailures), ordered(targetFailures)) && summary.complete === (targetFailures.length === 0);
  if (!dispositionComplete) warnings.push("Timed target failure ledger or baseline disposition is missing or differs from retained phases.");
  const uniformBaseline = validClock && summary.complete === true && summary.checksPassed === true && summary.dirty === false
    && allAppsPresent && everyCheck && everyPass && fixtureMatches && configurationComplete && failures.length === 0 && summary.options.checkOnly !== true
    && (!timed || summary.attemptComplete === true && dispositionComplete)
    && (group === null || group.complete);
  const baseline = uniformBaseline && !mixed;
  const attemptComplete = timed && validClock && summary.attemptComplete === true && summary.checksPassed === true && summary.dirty === false
    && allAppsPresent && everyCheck && everyPass && fixtureMatches && configurationComplete && failures.length === 0
    && summary.options.checkOnly !== true && group?.attemptComplete === true && dispositionComplete;
  const timedCells = timed ? Object.entries(summary.apps).flatMap(([app, entry]) => Object.entries(entry.runs ?? {}).flatMap(([profile, runs]) => phases.map((phase) => {
    const values = runs.map((r) => r.phases?.[phase]).filter(Boolean);
    return { app, profile, phase, ...aggregate(values), asked: passes };
  }))) : undefined;
  if (!everyPass) warnings.push(`Some sat64 passes are missing or belong to unsuccessful runs; available values are partial, not a complete ${passes}-pass comparison.`);
  return { round: summary.round, commit: summary.commit, config, baseline, terminal, passes, apps, failures, warnings,
    ...(timed ? { attemptComplete, timedCells } : {}),
    attemptGates: { validClock, allAppsPresent, fixtureMatches, configurationComplete }, ...(group ? { group: group.descriptor } : {}),
    ...(headerScope ? { documentHeaders: { ...headerScope, mixed } } : {}),
    status: baseline ? "COMPLETE" : uniformBaseline ? "COMPLETE MIXED-CONTRACT RUN: not a feature-parity baseline" : attemptComplete ? "COMPLETE ATTEMPT: observed load/request failure; not a baseline" : terminal ? "FAILED OR INCOMPLETE: not a baseline" : "PRELIMINARY: not a baseline" };
}

const number = (value, digits = 0) => value === null || value === undefined ? "pending" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const cell = (phase) => phase.rps ? `${number(phase.rps.median)} [${number(phase.rps.min)}, ${number(phase.rps.max)}] (${phase.passes}/${phase.asked})` : "pending";
export function renderCatalog(report) {
  const c = report.config;
  const reportKeys = report.group?.cases.map((profile) => `${profile.source}-${profile.target}`) ?? keys;
  const headings = reportKeys.map((key) => `${key.startsWith("fixture-") ? "Memory" : "HTTP"} ${key.endsWith("-json") ? "JSON" : "page"} ${report.timedCells ? "successful " : ""}req/s`);
  const lines = [`# Catalog ${report.round}`, "", `**${report.status}**`, "", `Measured commit: \`${report.commit}\`.`, "",
    `Per phase: duration ${number(c.duration)} s; warmup ${number(c.warmup)} s; fixed rate ${number(c.rate)} req/s; encoding ${c.encoding ?? "unknown"}.`,
    `Started: ${c.startedAt ?? "unknown"}; finished: ${c.finishedAt ?? "not recorded"}.`,
    `Fixture SHA-256: \`${c.fixtureSha256 ?? "unknown"}\`.`, "",
    "| CPU role | Quota, cores | Logical CPU pinning |", "|---|---:|---|"];
  for (const role of ["app", "load", "api"]) lines.push(`| ${role} | ${number(c.cpus?.[role]?.quota, 1)} | ${c.cpus?.[role]?.cpuset === null ? "unpinned" : c.cpus?.[role]?.cpuset ?? "unknown"} |`);
  if (c.leanProfile) lines.push("", `Speed configuration: \`${c.leanProfile.name}\`; configured contenders: ${c.leanProfile.apps.map((app) => `\`${app}\``).join(", ")}.`);
  const h = report.documentHeaders;
  if (h) lines.push("", `Document header contract \`${h.contract}\` (${h.scope}): checked for ${h.checked.length ? h.checked.map((app) => `\`${app}\``).join(", ") : "no reported app"}; not checked for ${h.unchecked.length ? h.unchecked.map((app) => `\`${app}\``).join(", ") : "no reported app"}.`,
    ...(h.mixed ? ["This ungrouped run mixes correctness contracts. It is not a feature-parity comparison or a baseline; rows in the two tables below must not be ranked against each other."] : []));
  if (c.apparatus) lines.push("", `Upstream: \`${c.apparatus.schema}\`, exactly two request workers plus coordinator; unchanged 2-CPU/512-MiB budget. Raw replay: ${report.rawVerified === true ? "verified" : "not verified"}; first-host admission: ${report.apparatusPreflight ?? "not verified"}. Legacy evidence is not retroqualified.`);
  if (report.group) lines.push("", `Group: \`${report.group.group}\`; registry: \`${report.group.registrySchema}\`; contract SHA-256: \`${report.group.contractSha256}\`.`,
    report.group.documentHeaders ? `Document header contract: \`${report.group.documentHeaders}\`.` : "Historical contract: the current document header floor was not checked.",
    `After-run commit: \`${c.commitAfter ?? "not recorded"}\`; tree dirty after run: ${c.dirtyAfter ?? "not recorded"}.`,
    `Exact apps: ${report.group.apps.map((app) => `\`${app}\``).join(", ")}.`,
    "Timing targets: page only, fixture and API sources. Native correctness gates remain page AND JSON; JSON is not timed. This is a group comparison, not the historical twenty-app catalog baseline.");
  lines.push("", "First catalog workload results, not changes against marketplace r16. Each cell is the median [minimum, maximum] of available 64-user passes, with collected/requested pass counts. Partial cells are not complete repeated measurements.");
  const reported = Object.keys(report.apps);
  const tables = h?.mixed ? [[`Checked against \`${h.contract}\``, reported.filter((app) => leanApps.includes(app))],
    ["Not checked against the document header contract", reported.filter((app) => !leanApps.includes(app))]] : [[null, reported]];
  for (const [title, apps] of tables) {
    if (title) lines.push("", `### ${title}`);
    lines.push("", `| Framework | ${headings.join(" | ")} |`, `|---|${reportKeys.map(() => "---:").join("|")}|`);
    for (const app of apps) lines.push(`| ${app} | ${reportKeys.map((key) => cell(report.apps[app][key])).join(" | ")} |`);
  }
  if (report.timedCells) {
    lines.push("", "## Timed outcomes", "", "Observed load/request outcomes, not root-cause diagnoses. Successful req/s excludes failed requests; attempted req/s includes them. Ranges retain every observed pass. Failed apps are not comparison-eligible, including when a different phase passed.", "",
      "| App | Profile | Phase | Passed / failed / requested passes | Successful req/s median [min, max] | Attempted req/s median [min, max] | Failed requests median [min, max] | Drops median [min, max] |", "|---|---|---|---|---|---|---|---|");
    const value = (v) => v ? `${number(v.median, 2)} [${number(v.min, 2)}, ${number(v.max, 2)}]` : "pending";
    for (const c of report.timedCells) lines.push(`| ${c.app} | ${c.profile} | ${c.phase} | ${c.outcomes?.passed ?? 0} / ${c.outcomes?.failed ?? 0} / ${c.asked} | ${value(c.successfulRps)} | ${value(c.rps)} | ${value(c.failed)} | ${value(c.dropped)} |`);
  }
  lines.push("", "## Corten efficiency", "", "Median and [minimum, maximum] across available passes. Memory is each pass's peak under load; p95 is the median of per-pass p95s, not a pooled percentile.", "",
    `| Source / response | ${report.timedCells ? "Attempted requests" : "Requests"}/CPU-second | Peak MiB | Sampled CPU % | p95 ms | ${report.timedCells ? "Successful " : ""}req/s range |`,
    "|---|---:|---:|---:|---:|---:|");
  const spread = (v, digits) => v ? `${number(v.median, digits)} [${number(v.min, digits)}, ${number(v.max, digits)}]` : "pending";
  for (const key of reportKeys) {
    const p = report.apps.corten[key];
    lines.push(`| ${key} | ${spread(p.perCpuSecond, 0)} | ${spread(p.memMaxMiB, 2)} | ${spread(p.cpuAvgPct, 1)} | ${spread(p.p95, 2)} | ${p.rps ? `${number(p.rps.min)}-${number(p.rps.max)}` : "pending"} |`);
  }
  lines.push("", "## Limits", "", "CPU efficiency is whole-container CPU, not handler-only time. Low sampled CPU flags possible underutilization; it does not diagnose its cause. This suite does not measure build times, instruction counts or browser interactivity.");
  for (const warning of report.warnings) lines.push(`- ${warning}`);
  if (report.failures.length) lines.push("", "## Failures", "", ...report.failures.map((f) => `- ${f.replace(/[\r\n]+/g, " ")}`));
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => { try {
    const [file, ...args] = process.argv.slice(2);
    let expectedCommit;
    let strict = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--require-complete" && !strict) strict = true;
      else if (args[i] === "--commit" && expectedCommit === undefined && /^[0-9a-f]{40}$/.test(args[i + 1] ?? "")) expectedCommit = args[++i];
      else throw new Error(`invalid or duplicate argument ${args[i]}`);
    }
    assert.ok(file, "usage: node bench/catalog/report.mjs <summary.json> [--commit <full SHA>] [--require-complete]");
    const summary = JSON.parse(readFileSync(file, "utf8"));
    let report = inspectCatalog(summary, expectedCommit);
    if (summary.savedEvidence?.schema === "catalog-saved-evidence/v4") {
      const { validateSaved } = await import("./verify.mjs");
      const result = validateSaved({ folder: dirname(file), round: summary.round, commit: expectedCommit ?? summary.commit });
      if (result.status === "verified") report = result.report;
      else {
        report.baseline = false; report.attemptComplete = false; report.status = "FAILED OR INCOMPLETE: worker-aware raw replay required";
        report.warnings.push(...result.errors);
      }
    }
    // Preserve pre-header v3's original strict ledger semantics. For a header-checked
    // group, do not let a retired roster qualify as the current comparison.
    if (strict && summary.group?.documentHeaders && summary.group.contractSha256 !== groupDescriptor("catalog-page").contractSha256)
      throw new Error("strict header-checked comparison requires this checkout's roster; use the measured checkout for a historical group");
    console.log(renderCatalog(report));
    if (strict && !report.baseline) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; } })();
}
