// Outcome validation only: no injector, native adapter, load runner or readiness claim.
import { isDeepStrictEqual } from "node:util";

export const hardeningContract = "hardening-outcome/v1";
export const hardeningCaptureSchema = "hardening-capture/v1";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim().length > 0;
const number = (v) => Number.isFinite(v) && v >= 0;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const need = (ok, message, kind = "evidence") => {
  if (!ok) throw Object.assign(new Error(`hardening ${kind}: ${message}`), { kind });
};
const unavailable = (v) => object(v) && v.status === "unavailable" && text(v.reason);
const phases = ["slow-headers", "slow-bodies", "slow-readers", "idle-connections", "connection-pressure", "oversized-requests"];

function deployment(shape) {
  need(object(shape) && ["direct", "deployed-edge"].includes(shape.mode), "deployment shape required");
  need(shape.countAllProcesses === true, "all required processes must be counted");
  need(Array.isArray(shape.processes) && shape.processes.length > 0, "process inventory required");
  const ids = new Set();
  for (const p of shape.processes) {
    need(object(p) && text(p.id) && !ids.has(p.id), "invalid or duplicate process id"); ids.add(p.id);
    need(["application", "proxy", "upstream", "store"].includes(p.role) && count(p.count) && p.count > 0, "process role/count required");
  }
  need(shape.processes.some((p) => p.role === "application"), "application process required");
  need(shape.processes.some((p) => p.role === "proxy") === (shape.mode === "deployed-edge"), "direct/edge proxy mismatch");
}

function budgets(serialized) {
  need(text(serialized), "serialized effective budgets required");
  let parsed;
  try { parsed = JSON.parse(serialized); } catch { need(false, "invalid effective budgets JSON"); }
  for (const key of ["attack", "legitimate", "resources", "recovery", "cleanup"]) {
    need(object(parsed?.[key]) && Object.keys(parsed[key]).length > 0, `effective ${key} budget required`);
  }
  const finite = (v) => typeof v === "number" ? Number.isFinite(v)
    : Array.isArray(v) ? v.every(finite) : object(v) ? Object.values(v).every(finite) : true;
  need(finite(parsed), "nonfinite effective budget");
  need(object(parsed.timing) && number(parsed.timing.maxStartLagMs) && number(parsed.timing.maxWindowDriftMs), "reviewed timing tolerances required");
  for (const key of ["before", "during", "after"]) {
    const w = parsed.legitimate[key];
    need(object(w) && number(w.startMs) && number(w.endMs) && w.endMs > w.startMs, "reviewed observation windows required");
    schedule(w.scheduledAtMs, w);
  }
  need(parsed.legitimate.before.endMs <= parsed.legitimate.during.startMs
    && parsed.legitimate.during.endMs <= parsed.legitimate.after.startMs, "overlapping reviewed windows");
  schedule(parsed.attack.scheduledAtMs, parsed.legitimate.during);
  return parsed;
}

function schedule(times, w) {
  need(Array.isArray(times) && times.length > 0 && times.every((at, i) => number(at)
    && at >= w.startMs && at < w.endMs && (i === 0 || at >= times[i - 1])), "ordered nonempty reviewed attempt schedule required");
}

function starts(actual, planned, w, timing) {
  need(Array.isArray(actual) && actual.length === planned.length && actual.every((at, i) => number(at)
    && at >= planned[i] && at - planned[i] <= timing.maxStartLagMs && at >= w.startMs && at < w.endMs),
  "missing, extra, early or late attempted work against reviewed schedule", "harness");
}

function window(w) {
  need(object(w) && number(w.startMs) && number(w.endMs) && w.endMs > w.startMs && text(w.evidence), "legitimate observation window required");
  if (!unavailable(w.counts)) {
    need(object(w.counts) && [w.counts.sent, w.counts.ok, w.counts.errors].every(count), "legitimate counters or explicit unavailable reason required");
    need(w.counts.sent === w.counts.ok + w.counts.errors, "inconsistent legitimate counters");
  }
  if (!unavailable(w.latency)) {
    need(object(w.latency) && [w.latency.p50Ms, w.latency.p99Ms, w.latency.maxMs].every(number), "latency or explicit unavailable reason required");
    need(w.latency.p50Ms <= w.latency.p99Ms && w.latency.p99Ms <= w.latency.maxMs, "inconsistent latency percentiles");
    need(!unavailable(w.counts) && w.counts.ok > 0, "latency describes successful legitimate requests only");
  }
}

/**
 * Validate one phase, not group readiness. Settings MUST be supplied from a reviewed run plan;
 * Attack/legitimate budgets contain deterministic scheduledAtMs arrays, plus legitimate
 * startMs/endMs windows; timing supplies maxStartLagMs/maxWindowDriftMs. These are reviewed
 * caller settings, never inherited legacy limits. Captures record startedAtMs per attempt
 * (including target errors/refusals), in schedule-index order, not just self-reported totals.
 * Captures use monotonic milliseconds from the runner, never a clock manufactured by this oracle.
 * Evidence fields reference retained raw records. The integrating runner must verify those
 * records, control assertions, exact images/config/source and inventory completeness itself.
 * A target refusal is an attack counter, not an injector error. Missing/unsupported defenses
 * remain outcomes. A failed apparatus throws a tagged error, never a defense-failure result.
 */
export function validateHardeningOutcome(capture, settings) {
  need(object(settings) && text(settings.review), "reviewed settings reference required");
  deployment(settings.deployment);
  const plan = budgets(settings.effectiveBudgets);
  need(phases.includes(settings.phase), "unknown attack phase");
  need(settings.case === settings.deployment.mode, "case/deployment mismatch");
  need(object(capture) && capture.schema === hardeningCaptureSchema && capture.contract === hardeningContract, "capture version mismatch");
  for (const key of ["case", "phase", "deployment", "effectiveBudgets"]) {
    need(isDeepStrictEqual(capture[key], settings[key]), `capture differs from reviewed ${key}`);
  }
  const { parity, apparatus, attack, legitimate, resources, recovery, defense, provenance } = capture;
  need(object(parity) && ["passed", "failed", "unsupported", "not-run"].includes(parity.status)
    && text(parity.contract) && text(parity.evidence), "functional parity prerequisite required");
  need(object(apparatus), "apparatus evidence required", "harness");
  for (const key of ["injector", "host"]) {
    need(apparatus[key]?.healthy === true && text(apparatus[key].evidence), `unhealthy or missing ${key}`, "harness");
  }
  need(apparatus.controls?.attackValid === true && apparatus.controls?.legitimateValid === true
    && text(apparatus.controls.evidence), "valid attack and legitimate controls required", "harness");
  need(apparatus.artifacts?.complete === true && text(apparatus.artifacts.evidence), "incomplete/corrupt artifacts");
  const injector = apparatus.injector;
  need(count(injector.scheduled) && injector.scheduled > 0 && injector.attempted === injector.scheduled
    && injector.errors === 0 && injector.dropped === 0, "broken/incomplete injector", "harness");
  need(object(attack) && [attack.attempted, attack.established, attack.failed, attack.closed, attack.held].every(count)
    && text(attack.evidence), "attack counters required");
  need(attack.attempted === injector.attempted && attack.established + attack.failed === attack.attempted
    && attack.closed + attack.held === attack.established, "inconsistent attack counters");
  need(injector.scheduled === plan.attack.scheduledAtMs.length, "incomplete attack injection against reviewed schedule", "harness");
  need(object(legitimate), "legitimate observations required");
  for (const key of ["before", "during", "after"]) window(legitimate[key]);
  need(legitimate.before.endMs <= legitimate.during.startMs && legitimate.during.endMs <= legitimate.after.startMs, "overlapping/reordered observations");
  for (const key of ["before", "during", "after"]) {
    const w = legitimate[key], expected = plan.legitimate[key];
    need(Math.abs(w.startMs - expected.startMs) <= plan.timing.maxWindowDriftMs
      && Math.abs(w.endMs - expected.endMs) <= plan.timing.maxWindowDriftMs, "observation window differs from reviewed schedule", "harness");
    starts(w.startedAtMs, expected.scheduledAtMs, w, plan.timing);
    need(unavailable(w.counts) || w.counts.sent === expected.scheduledAtMs.length,
      "incomplete legitimate injection against reviewed schedule", "harness");
  }
  starts(attack.startedAtMs, plan.attack.scheduledAtMs, legitimate.during, plan.timing);
  const processes = capture.deployment.processes;
  need(Array.isArray(provenance) && provenance.length === processes.length, "per-process provenance required");
  need(object(resources), "resource observations required");
  for (const p of processes) {
    const origins = provenance.filter((v) => object(v) && v.id === p.id);
    need(origins.length === 1 && text(origins[0].source) && text(origins[0].image) && text(origins[0].config), "exact process image/config/source required");
  }
  for (const key of ["before", "during", "after"]) {
    const samples = resources[key], w = legitimate[key];
    need(Array.isArray(samples) && samples.length === processes.length, "resource observation for every process required");
    for (const p of processes) {
      const matches = samples.filter((s) => object(s) && s.id === p.id), s = matches[0];
      need(matches.length === 1 && s.count === p.count && number(s.atMs) && s.atMs >= w.startMs && s.atMs <= w.endMs
        && typeof s.running === "boolean" && typeof s.oomKilled === "boolean" && text(s.evidence), "invalid/incomplete process resource observation");
      need(!s.oomKilled || !s.running, "OOM-killed process cannot be running");
      need((number(s.cpuSeconds) || unavailable(s.cpuSeconds)) && (number(s.memoryBytes) || unavailable(s.memoryBytes)), "CPU/memory observations or unavailable reasons required");
    }
  }
  need(object(recovery) && recovery.attempted === true && number(recovery.startMs) && number(recovery.endMs)
    && recovery.startMs >= legitimate.during.endMs && recovery.endMs >= recovery.startMs
    && recovery.endMs <= legitimate.after.endMs && text(recovery.evidence), "recovery attempt and observed duration required");
  need(["recovered", "not-recovered", "stopped", "terminated"].includes(recovery.disposition), "terminal recovery disposition required");
  if (recovery.disposition === "recovered") {
    need(!unavailable(legitimate.after.counts) && legitimate.after.counts.ok > 0
      && resources.after.filter((s) => processes.find((p) => p.id === s.id).role === "application").every((s) => s.running), "recovery claim needs service and running application evidence");
  }
  if (["stopped", "terminated"].includes(recovery.disposition)) {
    need(resources.after.filter((s) => processes.find((p) => p.id === s.id).role === "application").every((s) => !s.running), "stopped/terminated disposition needs stopped application evidence");
  }
  const cleanup = apparatus.cleanup;
  need(cleanup?.complete === true && text(cleanup.evidence) && number(cleanup.atMs)
    && cleanup.atMs >= Math.max(recovery.endMs, legitimate.after.endMs)
    && cleanup.connections === 0 && cleanup.processes === 0 && cleanup.tasks === 0, "failed/incomplete cleanup", "harness");
  need(object(defense) && ["observed", "missing", "unsupported", "inconclusive"].includes(defense.protection)
    && text(defense.reason) && Array.isArray(defense.attribution) && defense.attribution.length > 0, "defense outcome/attribution required");
  for (const a of defense.attribution) {
    need(object(a) && ["application", "server", "proxy", "host", "unknown"].includes(a.layer) && text(a.mechanism) && text(a.evidence), "defense layer evidence required");
    need(a.layer !== "proxy" || capture.case === "deployed-edge", "proxy attribution on direct deployment");
  }
  const serviceCounts = ["before", "during", "after"].every((key) => !unavailable(legitimate[key].counts))
    && legitimate.before.counts.ok > 0;
  return structuredClone({ ...capture, measurement: parity.status !== "passed" ? "parity-blocked"
    : serviceCounts ? "complete" : "unavailable" });
}

/**
 * Revalidate captures, requiring observed baseline service and comparable request counts.
 * Native inventories may differ: compare direct/edge mode and serialized total charged
 * budgets, not process identities or topology. Each inventory still matches its own review.
 * Unavailable latency/resource metrics remain nonnumeric, even in comparable service counts.
 */
export function validateHardeningComparison(entries) {
  need(Array.isArray(entries) && entries.length >= 2, "at least two captures required");
  const results = entries.map((entry) => {
    need(object(entry), "capture/settings pair required");
    return validateHardeningOutcome(entry.capture, entry.settings);
  });
  for (const result of results) {
    need(result.parity.status === "passed", "functional parity has not passed", "parity");
    need(result.measurement === "complete", "observed baseline service and all legitimate counts required for numeric comparison");
    for (const key of ["case", "phase", "effectiveBudgets"]) {
      need(isDeepStrictEqual(result[key], results[0][key]), `incomparable ${key}`);
    }
    need(result.deployment.mode === results[0].deployment.mode, "incomparable deployment mode");
    need(result.parity.contract === results[0].parity.contract, "incomparable functional parity contract", "parity");
  }
  return results;
}
