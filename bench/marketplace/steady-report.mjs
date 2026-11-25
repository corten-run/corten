// Read a saved convergence or soak pass (steady.mjs) only. Never builds, runs or changes a benchmark.
// node bench/marketplace/steady-report.mjs bench/marketplace/results/convergence/<name>/summary.json
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { convergenceSchema, flattenRule, soakSchema, supportedWarmup, timedWarmupVus, validateConvergence, validateSoak } from "./steady-contract.mjs";

const ms = (v) => (v === null ? "-" : v.toFixed(1));
const header = (s, title) => [`# Marketplace ${title} ${s.name}`, "",
  `Commit: \`${s.commit}\`. CPU: ${s.host.cpu} (online CPUs ${s.host.onlineCpus ?? "not recorded"}). Window: ${s.startedAt} to ${s.finishedAt}.`,
  s.admission ? `Adapters: those timed round ${s.admission.round} (commit \`${s.admission.commit}\`, summary SHA-256 ${s.admission.summarySha256}) admitted, of ${s.admission.selected.join(", ")}.`
    : `Adapters: ${s.options.apps.join(", ")}, as selected; no timed round's admission was checked.`,
  "Each adapter, source and target ran in a fresh container started as a timed round starts it; windows are the k6 engine's clock from the start of the load, which begins after readiness.",
  "This is not a timed round and ranks nothing: it says when each adapter stopped changing, not how fast it is beside another."];
/** A convergence pass as Markdown, with its flatten windows and the warmup it supports. */
export function convergenceReport(s) {
  validateConvergence(s);
  const o = s.options, warmup = supportedWarmup(s);
  const lines = [...header(s, "convergence pass"), "",
    `One ${o.vus}-user closed loop of ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s windows.`,
    `Flatten rule ${flattenRule.name}: tail = median throughput of the last ${flattenRule.holdWindows} windows; still getting faster when it exceeds the median of the ${flattenRule.holdWindows} before by more than ${flattenRule.tolerance * 100}%. Otherwise the adapter flattened at the first window of the longest final run whose three-window medians stay within ${flattenRule.tolerance * 100}% below the tail (and whose own throughput is too), if that run holds at least ${flattenRule.holdWindows} windows. p95 is evidence, not part of the rule.`,
    "", "| Adapter | Source | Target | Flattened | Tail req/s | Failed requests |", "|---|---|---|---|---:|---:|"];
  const verdict = (v) => v.flattened ? `window ${v.window} (${v.atSeconds} s)${v.slowerAtEnd ? "; slower at the end" : ""}` : `never (${v.reason})`;
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`| ${c.app} | ${c.source} | ${c.target} | no verdict: pass failed | - | - |`); continue; }
    lines.push(`| ${c.app} | ${c.source} | ${c.target} | ${verdict(c.verdict)} | ${c.verdict.tailRps === undefined ? "-" : c.verdict.tailRps.toFixed(1)} | ${c.windows.reduce((n, w) => n + w.failed, 0)} |`);
  }
  lines.push("", warmup === null ? "Supported timed warmup: none. At least one adapter's pass failed or never flattened, so this pass does not support a warmup length."
    : `Supported timed warmup: at least ${warmup} s, the latest flatten window's start. The timed warmup runs ${timedWarmupVus} users after a cold start; this pass ran ${o.vus}, so the length carries by time, not by work done.`);
  lines.push("", "## Windows", "");
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`${c.app} ${c.source} ${c.target}: failed: ${c.failure.split("\n")[0]}`, ""); continue; }
    lines.push(`${c.app} ${c.source} ${c.target} req/s by window: ${c.windows.map((w) => w.rps.toFixed(1)).join(", ")}`, "",
      `${c.app} ${c.source} ${c.target} p95 ms by window: ${c.windows.map((w) => ms(w.p95)).join(", ")}`, "",
      `${c.app} ${c.source} ${c.target} p99 ms by window: ${c.windows.map((w) => ms(w.p99)).join(", ")}`, "");
  }
  return lines.join("\n");
}
/** A soak as Markdown: memory at the start and end, p99 per interval and any restart. */
export function soakReport(s) {
  validateSoak(s);
  const o = s.options;
  const lines = [...header(s, "soak"), "",
    `A fixed ${o.rate} requests/second for ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s intervals. Memory is the median docker stats sample in the first and the last interval.`,
    "", "| Adapter | Source | Target | Start MiB | End MiB | Growth | p99 first / last / max ms | Failed requests | Restarted |", "|---|---|---|---:|---:|---:|---|---:|---|"];
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`| ${c.app} | ${c.source} | ${c.target} | - | - | - | - | - | pass failed: ${c.failure.split("\n")[0].replace(/\|/g, "\\|")} |`); continue; }
    const r = c.restarts, m = c.memory;
    lines.push(`| ${c.app} | ${c.source} | ${c.target} | ${m.startMiB.toFixed(1)} | ${m.endMiB.toFixed(1)} | ${m.growthMiB >= 0 ? "+" : ""}${m.growthMiB.toFixed(1)} MiB (${m.growthPct.toFixed(1)}%) | ${ms(c.p99.first)} / ${ms(c.p99.last)} / ${ms(c.p99.max)} | ${c.failed} | ${r.restarted ? `yes: ${[r.restartCount ? `RestartCount +${r.restartCount}` : null, ...r.events.map((e) => `${e.action} at ${e.atSeconds.toFixed(0)} s`), r.runningAtEnd ? null : "not running at the end", r.oomKilled ? "OOM-killed" : null].filter(Boolean).join(", ")}` : "no"} |`);
  }
  lines.push("", "## Intervals", "");
  for (const c of s.cells) if (c.failure === undefined) lines.push(`${c.app} ${c.source} ${c.target} p99 ms by interval: ${c.windows.map((w) => ms(w.p99)).join(", ")}`, "");
  return lines.join("\n");
}
export function steadyReport(s) {
  if (s?.schema === convergenceSchema) return convergenceReport(s);
  assert.equal(s?.schema, soakSchema, `not a ${convergenceSchema} or ${soakSchema} result`);
  return soakReport(s);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node bench/marketplace/steady-report.mjs summary.json");
  console.log(steadyReport(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}