import assert from "node:assert/strict";
import { aggregate as catalogAggregate, cpuSettings as catalogCpuSettings, parseArgs as catalogArgs, phases, sources } from "../catalog/contract.mjs";
import { allApps } from "../fullstack/apps.mjs";
import { spread } from "../fullstack/passes.mjs";
import { apps, locales } from "./contract.mjs";
const labels = {
  nextjs: "Next.js 16.4 (Pages Router, React SSR)",
  phoenix: "Phoenix 1.8 (Elixir, controller + HEEx)",
  laravel: "Laravel 13 (PHP, Octane on FrankenPHP, Blade)",
};
export const inventory = Object.fromEntries(Object.entries(allApps).filter(([, app]) => app.pages !== false)
  .map(([name, app]) => [name, { ...app, label: labels[name] ?? app.label }]));
export { phases, sources, targets } from "../catalog/contract.mjs";
// Saved-result schema: each app has exactly these eight runs/aggregate keys.
// Each publishable key has three passes and fixed/sat64/sat256 phases. JSON has locale:null,
// never an en-US/fr-FR/de-DE alias. Browser parity still covers all locales.
// v3: a phase records what the app failed to serve (readOutcome) instead of failing the run.
// v4: an app container that stops during a load phase is that app's recorded outcome
// (run.stopped, appStop): the profile's later phases and passes do not run, so it can have fewer
// than three passes, and each stage that lost a pass carries the stop (stageAggregate).
export const resultSchema = "marketplace-results/v4";
// The schemas report.mjs and compare.mjs read. A v3 summary is read as a v4 one with no stop
// records: under v3 an app that stopped failed the round, so a valid v3 round has none, and its
// aggregates lack only the stopped field. Rounds are written as v4 only.
export const v3Schema = "marketplace-results/v3";
export const readableSchemas = [v3Schema, resultSchema];
export const timedProfiles = sources.flatMap((source) => [
  ...locales.map((locale) => ({ key: `${source}-${locale}-page`, source, locale, target: "page" })),
  { key: `${source}-neutral-json`, source, locale: null, target: "json" },
]);
export function roundIdentity(round) {
  assert.match(round ?? "", /^[rw][1-9]\d*$/, "round must be rN (N >= 17), or wN for development");
  const number = Number(round.slice(1));
  assert.ok(Number.isSafeInteger(number) && (round[0] === "w" || number >= 17), "official marketplace-v2 rounds start at r17");
  assert.equal(round, `${round[0]}${number}`, "round identity must be canonical, with no whitespace or padding");
  return { kind: round[0] === "r" ? "official" : "development", number };
}
// A round split across droplets started together (#816): every droplet runs Corten, the subject,
// and axum + Maud, the anchor, so each app has a Corten measured on its own machine, and the
// anchor's ratio to Corten shows whether the droplets' machines differ by more than the noise.
export const anchors = ["corten", "axum-maud"];
// At most one non-anchor app per droplet.
export const maxDroplets = apps.length - anchors.length;
/**
 * The apps each droplet of a round split n ways measures, in catalog order: both anchors on every
 * droplet, the other apps dealt round-robin in catalog order, so each app runs on exactly one.
 * @param {number} n droplets, 2 to maxDroplets
 * @returns {string[][]} one list per droplet, d1 first
 */
export function splitApps(n) {
  assert.ok(Number.isSafeInteger(n) && n >= 2 && n <= maxDroplets, `a round splits across 2 to ${maxDroplets} droplets`);
  const shares = Array.from({ length: n }, () => new Set(anchors));
  apps.filter((app) => !anchors.includes(app)).forEach((app, i) => shares[i % n].add(app));
  return shares.map((share) => apps.filter((app) => share.has(app)));
}
/**
 * One droplet's part of a split round, from run.mjs --part k/n or saved state: {index: k, of: n}.
 * @param {string | {index: number, of: number}} value
 */
export function parsePart(value) {
  const part = typeof value === "string" ? (() => {
    assert.match(value, /^[1-9]\d*\/[1-9]\d*$/, "--part needs k/n, for example 2/3");
    const [index, of] = value.split("/").map(Number);
    return { index, of };
  })() : value;
  assert.deepEqual(Object.keys(part ?? {}).sort(), ["index", "of"], "a part is {index, of}");
  splitApps(part.of);
  assert.ok(Number.isSafeInteger(part.index) && part.index >= 1 && part.index <= part.of, `part ${part.index} of ${part.of} does not exist`);
  return { index: part.index, of: part.of };
}
// The name of a round's part: r17-d2, or the round itself when it is not split.
export const partName = (round, part) => (part ? `${round}-d${part.index}` : round);
export function parseArgs(args, inventory) {
  const identity = roundIdentity(args[0]);
  // --part k/n measures one droplet's share of a split round (#816); it sets the apps itself.
  const at = args.indexOf("--part", 1);
  const part = at === -1 ? null : parsePart(args[at + 1] ?? "");
  const rest = at === -1 ? args.slice(1) : [...args.slice(1, at), ...args.slice(at + 2)];
  assert.ok(!part || !rest.includes("--part"), "duplicate option --part");
  assert.ok(!part || !rest.includes("--apps"), "--part sets the apps; do not also pass --apps");
  const options = catalogArgs([args[0].replace(/^[rw]/, "c"), ...rest], inventory);
  if (part) options.apps = splitApps(part.of)[part.index - 1];
  if (identity.kind === "official") {
    if (!part) assert.deepEqual([...options.apps].sort(), [...apps].sort(), "official rounds require all twenty apps; use wN for development");
    assert.equal(options.passes, 3, "official rounds require three passes");
    assert.equal(options.checkOnly, false, "use wN for check-only development");
  }
  return { ...options, round: args[0], ...(part ? { part } : {}) };
}
// A phase as measured, with what the app could not serve under its profile (#1128): requests
// that failed (any answer but a 200) or timed out, and fixed-rate iterations k6 could not start,
// are the app's result, kept and marked (appOutcome), not a failed run. A summary that is
// missing or malformed, that sent nothing, in which no request succeeded, or in which a 200 had
// the wrong content type (a parity failure) is not a measurement.
export function readOutcome(summary) {
  const m = summary?.metrics;
  const metric = (name) => m?.[name]?.values ?? m?.[name];
  const requests = metric("http_reqs");
  const duration = metric("http_req_duration");
  const failures = metric("http_req_failed");
  const checks = metric("checks");
  assert.ok(Number.isSafeInteger(requests?.count) && requests.count > 0 && requests.rate > 0 && Number.isFinite(requests.rate), "load sent no requests");
  for (const k of ["avg", "p(50)", "p(95)", "p(99)", "max"]) assert.ok(Number.isFinite(duration?.[k]) && duration[k] >= 0, `load missing duration ${k}`);
  const failedRate = failures?.value ?? failures?.rate;
  assert.ok(Number.isFinite(failedRate) && failedRate >= 0 && failedRate <= 1, "load missing failure rate");
  assert.ok(Number.isSafeInteger(checks?.passes) && Number.isSafeInteger(checks?.fails) && checks.passes >= 0 && checks.fails >= 0 && checks.passes + checks.fails > 0, "load checks missing");
  const named = summary.root_group?.checks ?? {};
  const status = named["marketplace status 200"], kind = named["marketplace content type"];
  assert.ok([status, kind].every((c) => Number.isSafeInteger(c?.passes) && Number.isSafeInteger(c?.fails)), "load checks missing by name");
  assert.equal(kind.fails, 0, "a 200 had the wrong content type under load: a parity failure, not an outcome");
  const dropped = metric("dropped_iterations")?.count ?? 0;
  assert.ok(Number.isSafeInteger(dropped) && dropped >= 0, "load dropped iterations malformed");
  const failed = Math.round(failedRate * requests.count);
  // A request's metrics are recorded before its check, so one cut off at the phase's end can
  // have its failure and not its check; nothing else makes the two differ.
  assert.ok(status.fails <= failed && failed - status.fails <= Math.max(1, requests.count / 100), "status check and failed requests disagree");
  assert.ok(failed < requests.count && status.passes > 0, "no request succeeded: not a measurement");
  return { requests: requests.count, rps: requests.rate, p50: duration["p(50)"], p95: duration["p(95)"], p99: duration["p(99)"],
    failed, failedRate, dropped, checksFailed: status.fails, appOutcome: failed > 0 || dropped > 0 || status.fails > 0 };
}
export function aggregate(runs) {
  return { ...catalogAggregate(runs),
    cpuAvgPct: spread(runs.map((r) => r.cpuAvgPct)),
    cpuMaxPct: spread(runs.map((r) => r.cpuMaxPct)),
    cpuPerRequestUsec: spread(runs.map((r) => r.cpuUsec / r.requests)),
    failedRate: spread(runs.map((r) => r.failedRate)),
    dropped: spread(runs.map((r) => r.dropped)),
    appOutcomes: runs.filter((r) => r.appOutcome).length };
}
// A pass's load phases in the order they run: warmup, then the measured phases.
export const loadPhases = ["warmup", ...phases];
// Whether the app's container stopped during a load phase, from its Docker State after the phase:
// it exited, or a process in it was killed for exceeding the 1 GiB limit (#1128). Either is the
// app's outcome under the profile, recorded, not a failed round. Null while it runs normally.
// exitCode is null when the container still runs after an OOM kill of one of its processes.
export function appStop(state, pass, phase) {
  assert.ok(loadPhases.includes(phase), `not a load phase: ${phase}`);
  assert.ok(Number.isSafeInteger(pass) && pass > 0, "a stop needs its pass");
  assert.ok(typeof state?.Running === "boolean" && typeof state.OOMKilled === "boolean", "app container state missing");
  if (state.Running && !state.OOMKilled) return null;
  assert.ok(state.Running || Number.isSafeInteger(state.ExitCode), "a stopped app container has no exit code");
  return { pass, phase, exitCode: state.Running ? null : state.ExitCode, oomKilled: state.OOMKilled };
}
// The stop that ended a profile's passes, or null. Only the last run of a profile can have one.
export const profileStop = (runs) => runs.find((r) => r.stopped)?.stopped ?? null;
// Whether stop a came before stop b: an earlier pass, or an earlier load phase in the same pass.
export const stopsEarlier = (a, b) => a.pass < b.pass || (a.pass === b.pass && loadPhases.indexOf(a.phase) < loadPhases.indexOf(b.phase));
// A profile's cold starts lost passes to its stop only when a later pass did not run: the
// stopped pass's cold start was measured before its load. Then its cold numbers are not three passes.
export const coldStop = (runs, asked) => (runs.length < asked ? profileStop(runs) : null);
const rotate = (xs, offset) => xs.slice(offset % xs.length).concat(xs.slice(0, offset % xs.length));
/**
 * The order a round measures in: each pass runs every profile for every app, the apps rotated
 * between passes. A profile whose app's container stopped in an earlier pass is yielded with that
 * stop as skip, so it runs no later pass (#1128); runsOf(app, key) is read as each entry is
 * reached, so a stop recorded during the round is seen by the passes after it.
 * @param {number} passes @param {string[]} apps @param {{key: string}[]} profiles
 * @param {(app: string, key: string) => object[]} runsOf the runs recorded so far
 */
export function* passPlan(passes, apps, profiles, runsOf) {
  for (let pass = 1; pass <= passes; pass++) for (const profile of profiles) for (const app of rotate(apps, Math.floor((pass - 1) * apps.length / passes))) {
    yield { pass, profile, app, skip: profileStop(runsOf(app, profile.key)) };
  }
}

// Steps of a load phase whose error the app's stop explains when the error came after the app
// finished: its docker stats go with its container, and each stats error is stamped when it
// happened. The stats sampler running past its deadline, the CPU counter read before the phase,
// k6 failing to start or finish, a missing summary, or anything else does not.
const explainedSteps = new Set(["stats"]);
// Docker actions on the app container that mean something other than the app ended it: the
// harness itself does none of these to the app during a phase (remove() runs after it).
const outsideActions = new Set(["kill", "stop", "start", "restart", "pause", "unpause"]);
/**
 * How a load phase ended, from what run.mjs saw after it (#1128). Returns the app's stop record
 * when its container stopped and nothing else explains it, null when the app ran through the
 * phase and nothing failed, and throws for anything that fails the round.
 * @param {object} seen
 * @param {number} seen.pass @param {string} seen.phase
 * @param {string} seen.phaseStart when the phase began (before its k6 container was created); the
 *   app must have stopped after it, or the stop belongs to the cold start or the gap between phases
 * @param {object|null} seen.app the app container's Docker State, null when it could not be read
 * @param {{step: string, error: Error, at: string}[]} [seen.errors] what failed during the phase, and when
 * @param {{name: string, startedAt: string, state: object|null}[]} [seen.sidecars] containers the
 *   phase depends on (the CPU counter sidecar, and the upstream for an API profile), with the
 *   StartedAt recorded when each was created; read only when the app stopped
 * @param {{action: string}[]} [seen.events] Docker events for the app container since phaseStart
 * @param {object|null} [seen.summary] the phase's k6 summary, when it was saved
 */
export function phaseEnd({ pass, phase, phaseStart, app, errors = [], sidecars = [], events = [], summary = null }) {
  const stop = app ? appStop(app, pass, phase) : null;
  if (!stop) {
    if (errors.length) throw errors[0].error;
    assert.ok(app, "app container state unavailable");
    return null;
  }
  const harness = `during ${phase}, and the app container stopped: a harness failure, not the app's outcome`;
  const start = Date.parse(phaseStart);
  assert.ok(!Number.isNaN(start), "a stopped app needs its phase's start");
  for (const s of sidecars) assert.ok(s.state?.Running === true && s.state.StartedAt === s.startedAt, `${s.name} stopped or restarted ${harness}`);
  assert.ok(!app.Error, `Docker reported an error for the app container (${app.Error}) ${harness}`);
  const outside = events.find((e) => outsideActions.has(e.action));
  assert.ok(!outside, `Docker ${outside?.action} on the app container ${harness}`);
  // The stop must fall in the phase: an app that stopped after its cold start's first 200 but
  // before warmup, or between two phases, did not stop under this phase's load, and an outside
  // kill then is not in the phase's events. Both clocks are the Docker host's (run.mjs runs there).
  // An exited container says when by FinishedAt; one still running after an OOM kill only by
  // Docker's oom event, and its time explains no error.
  let finished = Infinity;
  if (stop.exitCode === null) assert.ok(events.some((e) => e.action === "oom"), `the app container was OOM-killed with no oom event since ${phase} began: not shown to be under its load, so the round fails`);
  else {
    finished = Date.parse(app.FinishedAt);
    assert.ok(!Number.isNaN(finished), "a stopped app container has no FinishedAt");
    assert.ok(finished >= start, `the app container stopped at ${app.FinishedAt}, before ${phase} began at ${phaseStart}: not under its load, so the round fails`);
  }
  const unexplained = errors.find((e) => !(explainedSteps.has(e.step) && !/exceeded its deadline/.test(e.error?.message ?? "") && Date.parse(e.at) >= finished));
  if (unexplained) throw unexplained.error;
  // A 200 of the wrong content type before the app stopped is still a parity failure.
  const kind = summary?.root_group?.checks?.["marketplace content type"];
  assert.ok(!kind?.fails, `a 200 had the wrong content type under load before the app stopped (${kind?.fails}): a parity failure, not an outcome`);
  return stop;
}
/**
 * The reads after a load phase, in the order run.mjs makes them, for phaseEnd (#1128).
 * The app's State is read first. Its CPU counters are read again only while it runs: after a stop
 * they go with its container, so the read is skipped, not failed. The k6 summary is always copied.
 * The sidecars and the app's Docker events are read only when the app stopped.
 * @param {object} phase {pass, phase, phaseStart} as phaseEnd takes them
 * @param {{step: string, error: Error, at: string}[]} errors what failed during the phase; more are added
 * @param {object} read async readers: app() its State, counters() the CPU counters after the phase,
 *   summary() the k6 summary (copied and parsed), sidecars() as phaseEnd takes them, events() since phaseStart
 * @param {(error: {step: string, error: Error}) => void} [note] told each error when the app stopped
 * @returns {Promise<{after: object, seen: object}>} the counters after the phase, and phaseEnd's input
 */
export async function afterPhase({ pass, phase, phaseStart }, errors, read, note = () => {}) {
  const failed = (step, error) => errors.push({ step, error, at: new Date().toISOString() });
  let app = null;
  try { app = await read.app(); } catch (e) { failed("inspect", e); }
  const stopped = Boolean(app && (!app.Running || app.OOMKilled));
  let after = {};
  if (!stopped) { try { after = await read.counters(); } catch (e) { failed("counters", e); } }
  let summary = null;
  try { summary = await read.summary(); } catch (e) { failed("summary", e); }
  const seen = { pass, phase, phaseStart, app, errors, summary };
  if (stopped) {
    // Only when the app stopped: is everything else the phase depends on the same, still running?
    seen.sidecars = await read.sidecars();
    try { seen.events = await read.events(); } catch (e) { failed("events", e); }
    for (const e of errors) note(e);
  }
  return { after, seen };
}
// A stage's aggregate over the passes that measured it. A stage the profile's stop kept a pass
// from (the stopped phase and those after it in that pass, every phase of the passes after it)
// carries the stop record: the report's mark and compare.mjs's outcome come from it.
export function stageAggregate(runs, phase, asked) {
  const stop = profileStop(runs);
  const lost = stop && (stop.pass < asked || loadPhases.indexOf(phase) >= loadPhases.indexOf(stop.phase));
  return { ...aggregate(runs.filter((r) => r.phases[phase]).map((r) => r.phases[phase])), asked, stopped: lost ? { ...stop } : null };
}
// The single upstream's answers to record reads in a phase, from its counters before and after.
// Any but a 200 is the harness failing the app, not the app's outcome, so the run fails on it.
// A slow upstream answers 200s late; the report names it beside an outcome (busy upstream).
export function upstreamErrors(before, after) {
  for (const c of [before, after]) {
    assert.ok(c && c.answers && typeof c.answers === "object", "upstream counters missing");
    for (const n of Object.values(c.answers)) assert.ok(Number.isSafeInteger(n) && n >= 0, "bad upstream counter");
  }
  const statuses = new Set([...Object.keys(before.answers), ...Object.keys(after.answers)]);
  const moved = Object.fromEntries([...statuses].map((s) => [s, (after.answers[s] ?? 0) - (before.answers[s] ?? 0)]));
  assert.ok(Object.values(moved).every((n) => n >= 0), "upstream counters moved backwards");
  return Object.entries(moved).filter(([s]) => s !== "200").reduce((sum, [, n]) => sum + n, 0);
}
export function aggregateCold(runs) {
  return Object.fromEntries(["first200MsFromContainerStart", "successfulRequestMs"].map((key) => [key, spread(runs.map((r) => r.cold[key]))]));
}
export function cpuSettings(env) {
  return catalogCpuSettings(Object.fromEntries(["APP", "LOAD", "API"].map((role) => [`CATALOG_${role}_CPUS`, env[`MARKETPLACE_${role}_CPUS`]])));
}
export function imageProvenance(labels, commit, checkOnly) {
  const builtCommit = labels?.["run.corten.marketplace.commit"] ?? null;
  const builtDirty = labels?.["run.corten.marketplace.dirty"] !== "false";
  assert.ok(checkOnly || (builtCommit === commit && !builtDirty), "image was not built from a clean measured commit; use --build");
  return { builtCommit, builtDirty };
}
