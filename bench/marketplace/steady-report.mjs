// Read a saved convergence or soak pass (steady.mjs) only. Never builds, runs or changes a benchmark.
// node bench/marketplace/steady-report.mjs bench/marketplace/results/convergence/<name>/summary.json
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { convergenceSchema, flattenRule, ruleText, soakSchema, supportedWarmup, timedWarmupVus, validateConvergence, validateSoak, verdictText } from "./steady-contract.mjs";

const ms = (v) => (v === null ? "-" : v.toFixed(1));
const header = (s, title) => [`# Marketplace ${title} ${s.name}`, "",
  `Commit: \`${s.commit}\`. CPU: ${s.host.cpu} (online CPUs ${s.host.onlineCpus ?? "not recorded"}). Window: ${s.startedAt} to ${s.finishedAt}.`,
  s.admission ? `Adapters: those timed round ${s.admission.round} (commit \`${s.admission.commit}\`, summary SHA-256 ${s.admission.summarySha256}) admitted, of ${s.admission.selected.join(", ")}.`
    : `Adapters: ${s.options.apps.join(", ")}, as selected; no timed round's admission was checked.`,
  s.options.group ? `Group ${s.options.group}: its images and container settings.` : "No group: the ungrouped images and container settings, not a group's timed configuration.",
  "Each adapter, source and target ran in a fresh container started as a timed round starts it (created, then started while a sidecar waits for the target's first 200); windows are the k6 engine's clock from the start of the load, which follows that first 200.",
  `This is not a timed round and ranks nothing: ${s.schema === soakSchema ? "it says whether each adapter's memory, tail latency and process held at the rate asked for" : "it says when each adapter stopped changing"}, not how fast it is beside another.`];
/** A convergence pass as Markdown, with its flatten windows and the warmup it supports. */
export function convergenceReport(s) {
  validateConvergence(s);
  const o = s.options, warmup = supportedWarmup(s);
  const lines = [...header(s, "convergence pass"), "",
    `One ${o.vus}-user closed loop of ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s windows.`,
    `Flatten rule ${flattenRule.name}: ${ruleText}`,
    "A cell with any failed request, in a window or in k6's aggregate count (which includes the graceful stop), has no verdict.",
    "", "| Adapter | Source | Target | Flattened | Tail req/s | Failed requests |", "|---|---|---|---|---:|---:|"];
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`| ${c.app} | ${c.source} | ${c.target} | no verdict: pass failed | - | - |`); continue; }
    lines.push(`| ${c.app} | ${c.source} | ${c.target} | ${verdictText(c.verdict)} | ${c.verdict.tailRps === undefined ? "-" : c.verdict.tailRps.toFixed(1)} | ${c.failedRequests} |`);
  }
  lines.push("", warmup === null ? "Supported timed warmup: none. At least one adapter's pass failed or never flattened, so this pass does not support a warmup length."
    : `Supported timed warmup: at least ${warmup} s, the latest flatten window's start, for the commit, images, fixture, CPU settings, host and kernel this pass ran on. ${o.vus === timedWarmupVus ? `It ran the timed warmup's ${timedWarmupVus} users.` : `It ran ${o.vus} users, not the timed warmup's ${timedWarmupVus}, so it is exploration: report.mjs will not count it toward a round's warmup.`}`);
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
    `A fixed rate of ${o.rate} requests/second asked for, for ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s intervals. Memory is the median docker stats sample in the first and the last interval.`,
    "", "| Adapter | Source | Target | Fixed rate | Start MiB | End MiB | Growth | p99 first / last / max ms | Failed requests | Restarted |", "|---|---|---|---|---:|---:|---:|---|---:|---|"];
  const unmet = s.cells.filter((c) => c.failure === undefined && !c.rate.met);
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`| ${c.app} | ${c.source} | ${c.target} | - | - | - | - | - | - | pass failed: ${c.failure.split("\n")[0].replace(/\|/g, "\\|")} |`); continue; }
    const r = c.restarts, m = c.memory;
    lines.push(`| ${c.app} | ${c.source} | ${c.target} | ${c.rate.met ? "held" : `not met: ${c.rate.droppedIterations} iterations dropped`} | ${m.startMiB.toFixed(1)} | ${m.endMiB.toFixed(1)} | ${m.growthMiB >= 0 ? "+" : ""}${m.growthMiB.toFixed(1)} MiB (${m.growthPct.toFixed(1)}%) | ${ms(c.p99.first)} / ${ms(c.p99.last)} / ${ms(c.p99.max)} | ${c.failedRequests} | ${r.restarted ? `yes: ${[r.restartCount ? `RestartCount +${r.restartCount}` : null, ...r.events.map((e) => `${e.action} at ${e.atSeconds.toFixed(0)} s`), r.runningAtEnd ? null : "not running at the end", r.oomKilled ? "OOM-killed" : null].filter(Boolean).join(", ")}` : "no"} |`);
  }
  for (const c of unmet) lines.push("", `${c.app} ${c.source} ${c.target}: the fixed ${o.rate} requests/second was not met (k6 dropped ${c.rate.droppedIterations} iterations it could not start on time), so this is not a fixed-rate result: its memory and p99 are under a lower, uneven load.`);
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