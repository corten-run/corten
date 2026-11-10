// Read-only reporting, including old/unfinished runs. Never starts Docker or changes results.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { allApps } from "../fullstack/apps.mjs";
import { cpuSettings, expectedPageChecks } from "./contract.mjs";
import { records } from "./fixtures.mjs";

const inventory = Object.keys(allApps).filter((name) => allApps[name].pages !== false);
const keys = ["fixture-page", "fixture-json", "api-page", "api-json"];
const fixture = records();
const canonicalFixtureSha256 = createHash("sha256").update(`${JSON.stringify(fixture)}\n`).digest("hex");
const checkedPageCount = expectedPageChecks(fixture);
const profileKeys = ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].flatMap((p) => [false, true].map((js) => `${p}:${js}`));
function completeChecks(check, source) {
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
function validCpuSettings(cpus) {
  try {
    const roles = ["app", "load", "api"];
    if (!roles.every((role) => cpus?.[role]?.cpuset === null || (typeof cpus?.[role]?.cpuset === "string" && cpus[role].cpuset.length > 0))) return false;
    const checked = cpuSettings(Object.fromEntries(roles.map((role) => [`CATALOG_${role.toUpperCase()}_CPUS`, cpus[role].cpuset])));
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
  const warnings = [];
  const failures = [...summary.failures, ...summary.cleanupFailures].map((f) => `${f.app ?? f.resource ?? "suite"}: ${f.stage ?? "cleanup"}: ${f.error}`);
  const selected = summary.options.apps;
  const allAppsPresent = Array.isArray(selected) && selected.length === inventory.length && new Set(selected).size === inventory.length
    && inventory.every((app) => selected.includes(app))
    && Object.keys(summary.apps).length === inventory.length && inventory.every((app) => Object.hasOwn(summary.apps, app));
  if (!allAppsPresent) warnings.push("Not all twenty page apps are present; this is not a full catalog baseline.");
  if (summary.dirty !== false) warnings.push("The measured tree was dirty or its cleanliness was not recorded.");
  if (summary.checksPassed !== true) warnings.push("The suite's correctness checks did not all pass.");
  const fixtureMatches = summary.fixtureSha256 === canonicalFixtureSha256;
  if (!fixtureMatches) warnings.push("Fixture identity is missing or differs from the canonical catalog-v1 fixture.");
  const config = { duration: summary.options.duration, warmup: summary.options.warmup, rate: summary.options.rate,
    cpus: summary.measurement?.cpus, encoding: summary.measurement?.encoding, fixtureSha256: summary.fixtureSha256,
    startedAt: summary.startedAt, finishedAt: summary.finishedAt };
  const configurationComplete = [config.duration, config.warmup, config.rate].every((n) => Number.isSafeInteger(n) && n > 0)
    && config.encoding === "identity" && summary.measurement?.fixedRate === config.rate
    && validCpuSettings(config.cpus);
  if (!configurationComplete) warnings.push("Measurement configuration is missing or inconsistent; duration, warmup, fixed rate, encoding and CPU placement must be recorded.");
  let everyCheck = true;
  let everyPass = true;
  const apps = Object.fromEntries(inventory.map((app) => {
    const entry = summary.apps[app];
    for (const source of ["fixture", "api"]) if (!completeChecks(entry?.checks?.[source], source)) {
      everyCheck = false;
      warnings.push(`${app} ${source}: missing or contradictory JSON, page, browser-profile or upstream correctness evidence.`);
    }
    if (entry?.failures?.length) { everyCheck = false; warnings.push(`${app}: per-app failures are recorded.`); }
    const results = Object.fromEntries(keys.map((key) => {
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
          && phase.failed === 0 && phase.dropped === 0;
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
          else if (phase.upstream.highCpu || phase.upstream.cpuAvgPct >= 80) warnings.push(`${app} ${key} pass ${run.pass}: busy single-process upstream (${phase.upstream.cpuAvgPct.toFixed(1)}% CPU) may limit throughput.`);
        }
        values.push(phase);
      }
      const complete = values.length === passes && runs.length === passes && runs.every((r) => r.complete === true && !r.failed);
      everyPass &&= complete;
      return [key, { passes: values.length, asked: passes, complete,
        rps: range(values.map((v) => v.rps)), perCpuSecond: range(values.map((v) => v.perCpuSecond)),
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
  const baseline = validClock && summary.complete === true && summary.checksPassed === true && summary.dirty === false
    && allAppsPresent && everyCheck && everyPass && fixtureMatches && configurationComplete && failures.length === 0 && summary.options.checkOnly !== true;
  if (!everyPass) warnings.push(`Some sat64 passes are missing or belong to unsuccessful runs; available values are partial, not a complete ${passes}-pass comparison.`);
  return { round: summary.round, commit: summary.commit, config, baseline, terminal, passes, apps, failures, warnings,
    status: baseline ? "COMPLETE" : terminal ? "FAILED OR INCOMPLETE: not a baseline" : "PRELIMINARY: not a baseline" };
}

const number = (value, digits = 0) => value === null || value === undefined ? "pending" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const cell = (phase) => phase.rps ? `${number(phase.rps.median)} [${number(phase.rps.min)}, ${number(phase.rps.max)}] (${phase.passes}/${phase.asked})` : "pending";
export function renderCatalog(report) {
  const c = report.config;
  const lines = [`# Catalog ${report.round}`, "", `**${report.status}**`, "", `Measured commit: \`${report.commit}\`.`, "",
    `Per phase: duration ${number(c.duration)} s; warmup ${number(c.warmup)} s; fixed rate ${number(c.rate)} req/s; encoding ${c.encoding ?? "unknown"}.`,
    `Started: ${c.startedAt ?? "unknown"}; finished: ${c.finishedAt ?? "not recorded"}.`,
    `Fixture SHA-256: \`${c.fixtureSha256 ?? "unknown"}\`.`, "",
    "| CPU role | Quota, cores | Logical CPU pinning |", "|---|---:|---|"];
  for (const role of ["app", "load", "api"]) lines.push(`| ${role} | ${number(c.cpus?.[role]?.quota, 1)} | ${c.cpus?.[role]?.cpuset === null ? "unpinned" : c.cpus?.[role]?.cpuset ?? "unknown"} |`);
  lines.push("", "First catalog workload results, not changes against marketplace r16. Each cell is the median [minimum, maximum] of available 64-user passes, with collected/requested pass counts. Partial cells are not complete repeated measurements.", "",
    "| Framework | Memory page req/s | Memory JSON req/s | HTTP page req/s | HTTP JSON req/s |",
    "|---|---:|---:|---:|---:|");
  for (const [app, phases] of Object.entries(report.apps)) lines.push(`| ${app} | ${keys.map((key) => cell(phases[key])).join(" | ")} |`);
  lines.push("", "## Corten efficiency", "", "Median and [minimum, maximum] across available passes. Memory is each pass's peak under load; p95 is the median of per-pass p95s, not a pooled percentile.", "",
    "| Source / response | Requests/CPU-second | Peak MiB | Sampled CPU % | p95 ms | req/s range |",
    "|---|---:|---:|---:|---:|---:|");
  const spread = (v, digits) => v ? `${number(v.median, digits)} [${number(v.min, digits)}, ${number(v.max, digits)}]` : "pending";
  for (const key of keys) {
    const p = report.apps.corten[key];
    lines.push(`| ${key} | ${spread(p.perCpuSecond, 0)} | ${spread(p.memMaxMiB, 2)} | ${spread(p.cpuAvgPct, 1)} | ${spread(p.p95, 2)} | ${p.rps ? `${number(p.rps.min)}-${number(p.rps.max)}` : "pending"} |`);
  }
  lines.push("", "## Limits", "", "CPU efficiency is whole-container CPU, not handler-only time. Low sampled CPU flags possible underutilization; it does not diagnose its cause. This suite does not measure build times, instruction counts or browser interactivity.");
  for (const warning of report.warnings) lines.push(`- ${warning}`);
  if (report.failures.length) lines.push("", "## Failures", "", ...report.failures.map((f) => `- ${f.replace(/[\r\n]+/g, " ")}`));
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, ...args] = process.argv.slice(2);
    let expectedCommit;
    let strict = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--require-complete" && !strict) strict = true;
      else if (args[i] === "--commit" && expectedCommit === undefined && /^[0-9a-f]{40}$/.test(args[i + 1] ?? "")) expectedCommit = args[++i];
      else throw new Error(`invalid or duplicate argument ${args[i]}`);
    }
    assert.ok(file, "usage: node bench/catalog/report.mjs <summary.json> [--commit <full SHA>] [--require-complete]");
    const report = inspectCatalog(JSON.parse(readFileSync(file, "utf8")), expectedCommit);
    console.log(renderCatalog(report));
    if (strict && !report.baseline) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
