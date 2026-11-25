// Read a saved convergence or soak pass (steady.mjs) only. Never builds, runs or changes a benchmark.
// node bench/marketplace/steady-report.mjs bench/marketplace/results/convergence/<name>/summary.json
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { convergenceSchema, failureCodes, flattenRule, parseSaved, ruleText, soakMemoryClock, soakSchema, startups, timedWarmupVus, validateConvergence, validateSoak, verdictText } from "./steady-contract.mjs";

// Every value printed here has been checked by validateConvergence or validateSoak first: a code
// is printed as its text from steady-contract.mjs, and anything else is a validated number or a
// value that matched its saved pattern.
const ms = (v) => (v === null ? "-" : v.toFixed(1));
const header = (s, title) => [`# Marketplace ${title} ${s.name}`, "",
  `Commit: \`${s.commit}\`. CPU: ${s.host.cpu ?? "not recorded"} (online CPUs ${s.host.onlineCpus ?? "not recorded"}). Window: ${s.startedAt} to ${s.finishedAt}.`,
  s.admission ? `Adapters: those timed round ${s.admission.round} (commit \`${s.admission.commit}\`, summary SHA-256 ${s.admission.summarySha256}) admitted, of ${s.admission.selected.join(", ")}.`
    : `Adapters: ${s.options.apps.join(", ")}, as selected; no timed round's admission was checked.`,
  s.options.group ? `Group ${s.options.group}: its images and container settings.` : "No group: the ungrouped images and container settings, not a group's timed configuration.",
  `Each adapter, source and target ran in a fresh container started by ${startups[s.startup]}; windows are the k6 engine's clock from the start of the load, which follows that first 200.`,
  `This is not a timed round and ranks nothing: ${s.schema === soakSchema ? "it reports each adapter's memory at the start and end and its p99 by interval as figures, with no criterion for whether they held, and says whether the fixed rate held and whether the app restarted" : "it gives each adapter's throughput by window and whether the end of the pass stayed within a stated tolerance"}, not how fast it is beside another.`];
/** A convergence pass as Markdown, with each cell's tolerance reading and windows. It sets no timed warmup. */
export function convergenceReport(s) {
  validateConvergence(s);
  const o = s.options;
  const lines = [...header(s, "convergence pass"), "",
    `One ${o.vus}-user closed loop of ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s windows.`,
    `Tolerance reading ${flattenRule.name}: ${ruleText}`,
    "A cell with any failed request, in a window or in k6's aggregate count (which includes the graceful stop), has no reading.",
    "", "| Adapter | Source | Target | Reading | Tail req/s | Failed requests |", "|---|---|---|---|---:|---:|"];
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`| ${c.app} | ${c.source} | ${c.target} | no reading: the cell failed (${failureCodes[c.failure]}) | - | - |`); continue; }
    lines.push(`| ${c.app} | ${c.source} | ${c.target} | ${verdictText(c.verdict)} | ${c.verdict.tailRps === undefined ? "-" : c.verdict.tailRps.toFixed(1)} | ${c.failedRequests} |`);
  }
  lines.push("", `This pass sets no timed warmup: a timed warmup is set only by a separate reviewed change from a saved pass that is like-for-like with the rounds it applies to (report.mjs --convergence lists every differing or missing input). ${o.vus === timedWarmupVus ? `It ran the timed warmup's ${timedWarmupVus} users.` : `It ran ${o.vus} users, not the timed warmup's ${timedWarmupVus}, so it is exploration and is not like-for-like with any timed round.`}`);
  lines.push("", "## Windows", "");
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`${c.app} ${c.source} ${c.target}: failed: ${failureCodes[c.failure]}`, ""); continue; }
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
    `A fixed rate of ${o.rate} requests/second asked for, for ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s intervals of the k6 engine's clock. Clocks: ${soakMemoryClock}.`,
    "", "| Adapter | Source | Target | Fixed rate | Start MiB | End MiB | Growth | p99 first / last / max ms | Failed requests | Restarted |", "|---|---|---|---|---:|---:|---:|---|---:|---|"];
  const unmet = s.cells.filter((c) => c.failure === undefined && !c.rate.held), blind = s.cells.filter((c) => c.failure === undefined && c.memory.unavailable !== undefined);
  const mib = (v) => (v === null ? "unavailable" : v.toFixed(1));
  for (const c of s.cells) {
    if (c.failure !== undefined) { lines.push(`| ${c.app} | ${c.source} | ${c.target} | - | - | - | - | - | - | no reading: the cell failed (${failureCodes[c.failure]}) |`); continue; }
    const r = c.restarts, m = c.memory;
    const why = [r.restartCount ? `RestartCount +${r.restartCount}` : null, r.replaced ? "another instance (ID or StartedAt) at the end" : null, ...r.events.map((e) => `${e.action} at ${e.atSeconds.toFixed(0)} s`), r.runningAtEnd ? null : "not running at the end", r.oomKilled ? "OOM-killed" : null,
      r.eventStream === "unavailable" ? "event stream unavailable" : null];
    const restarted = r.restarted === null ? "not established: the event stream was unavailable or did not cover the load, and nothing else showed a restart" : r.restarted ? `yes: ${why.filter(Boolean).join(", ")}` : "no";
    const growth = m.growthMiB === null ? "unavailable" : `${m.growthMiB >= 0 ? "+" : ""}${m.growthMiB.toFixed(1)} MiB (${m.growthPct.toFixed(1)}%)`;
    lines.push(`| ${c.app} | ${c.source} | ${c.target} | ${c.rate.held ? "held" : "not held"} | ${mib(m.startMiB)} | ${mib(m.endMiB)} | ${growth} | ${ms(c.p99.first)} / ${ms(c.p99.last)} / ${ms(c.p99.max)} | ${c.failedRequests} | ${restarted} |`);
  }
  lines.push("", `Fixed rate: "held" means the rate was sustained throughout: k6 dropped no iteration, recorded at least the schedule's floor(1e9 / rate) ns arrivals over the soak (${s.options.windows * s.options.windowSeconds} s, from slot 0) less the allowance of one second of arrivals plus the boundary slot (for an iteration the engine's stop cut off), and in every interval started a number of iterations, by the k6 engine's clock, within that allowance of the interval's own share of the schedule. A soak whose requests arrived early and left later intervals short did not hold it. The counts below are k6's own.`);
  for (const c of s.cells.filter((x) => x.failure === undefined)) {
    const a = c.rate, short = a.intervals.filter((i) => !i.held);
    lines.push("", `${c.app} ${c.source} ${c.target}: k6 recorded ${a.requests} requests and dropped ${a.droppedIterations} iterations; the schedule has at most ${a.scheduled} arrivals, so ${a.shortfall} are not accounted for (allowance ${a.allowance}). ${a.intervals.length - short.length} of ${a.intervals.length} intervals held the rate${short.length ? `; not held: ${short.map((i) => `interval ${i.index} from ${i.startSeconds} s, ${i.arrivals} arrivals of ${i.scheduled} scheduled`).join("; ")}` : ""}.`);
  }
  for (const c of unmet) lines.push("", `${c.app} ${c.source} ${c.target}: the fixed ${o.rate} requests/second was not held, so this is not a fixed-rate result: its memory and p99 are under a lower or uneven load.`);
  for (const c of blind) lines.push("", `${c.app} ${c.source} ${c.target}: memory unavailable (${c.memory.unavailable}); its restart, stop and OOM observations are still reported.`);
  lines.push("", "Memory and p99 are reported figures, not held or not held: no criterion is applied to them. \"Restarted\" is yes on any RestartCount increase, another instance at the end, a start, restart, die, kill or OOM event, or an app not running or OOM-killed at the end; no only when Docker's live event stream for the app, started before the load, was read in full, showed a marker container's starts before and after the load (so it covered the load), and showed none of these; not established when that stream could not be read or did not show that it covered the load, and nothing else showed a restart.");
  lines.push("", "## Intervals", "");
  for (const c of s.cells) if (c.failure === undefined) lines.push(`${c.app} ${c.source} ${c.target} p99 ms by interval: ${c.windows.map((w) => ms(w.p99)).join(", ")}`, "", `${c.app} ${c.source} ${c.target} arrivals by interval (scheduled): ${c.rate.intervals.map((i) => `${i.arrivals} (${i.scheduled})`).join(", ")}`, "");
  return lines.join("\n");
}
export function steadyReport(s) {
  if (s?.schema === convergenceSchema) return convergenceReport(s);
  // A plain error with a fixed message, like the validators' refusals: nothing of the file on it.
  if (s?.schema !== soakSchema) throw new Error(`not a ${convergenceSchema} or ${soakSchema} result`);
  return soakReport(s);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node bench/marketplace/steady-report.mjs summary.json");
  console.log(steadyReport(parseSaved(readFileSync(process.argv[2], "utf8"))));
}
