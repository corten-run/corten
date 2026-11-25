// Convergence and soak passes for marketplace v2 (#1851): option bounds, the per-window k6
// reader, the tolerance reading, the soak summary, validation of saved results and what the timed
// reporter says about them. Pure: no Docker, k6, files or clock. steady.mjs runs the passes;
// steady-report.mjs and report.mjs read what they saved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpuSettings, resultSchema, timedProfilesFor } from "./run-contract.mjs";

// v4: summary.json is an allowlist. Every saved field is defined by the checkout (a fixed code or
// text), a validated number, or a value that matches a strict pattern (savedText); the readers
// refuse any other field or value. A cell's failure and a pass's startup are codes from tables in
// this module, a soak saves the state of its Docker event stream, and Docker's, k6's and the host's
// own text stays in the raw files beside the summary. Soak v5: the fixed rate is checked per
// interval from the arrivals k6 started in it, and the event stream is a live one whose coverage of
// the load is shown by a marker container started before and after it.
export const convergenceSchema = "marketplace-convergence/v4";
export const soakSchema = "marketplace-soak/v5";
// The targets and sources of the timed profiles: a page in rotating locales and locale-neutral JSON,
// from memory and from the HTTP upstream.
export const steadyTargets = Object.freeze(["page", "json"]);
export const steadySources = Object.freeze(["fixture", "api"]);
// The users the timed warmup phase runs (run.mjs load(): VUS 32 for warmup).
export const timedWarmupVus = 32;
// How a pass starts each app, by code. The timed one is run.mjs coldStart before a timed warmup:
// the app is created, a sidecar polls the target's own path (the JSON item, or the first locale's
// page) from docker start until its first 200, and the load follows. A pass with another startup is
// not like-for-like with a timed round (unlikeRound); a reader refuses a code not in this table.
export const startups = Object.freeze({
  "marketplace-cold-start/v1": "the timed round's cold start (the app created, then started while a sidecar polls the target's path to its first 200)",
});
export const timedStartup = "marketplace-cold-start/v1";
/**
 * Why a cell or a pass failed, by code: summary.json keeps only the code, a report prints only its
 * text from this table, and the error itself (which can quote Docker, k6 or a saved file) goes to
 * the raw errors.log and run.log.
 */
export const failureCodes = Object.freeze({
  interrupted: "the pass was interrupted",
  checkout: "the checkout was not clean and committed, or moved during the pass",
  fixture: "the marketplace fixture is missing or stale",
  admission: "the round given to --admitted-from could not be read, or admitted no selected adapter",
  image: "an adapter image could not be built or read, or was not built from the measured commit",
  tools: "the k6 or upstream image could not be read or did not match its pin",
  host: "the host could not be read",
  container: "a container or network could not be created, started or inspected",
  upstream: "the marketplace upstream did not start",
  "cold-start": "the app did not start as the timed cold start requires",
  "load-exit": "the k6 load did not finish or exited with an error",
  "load-evidence": "k6's summary export or engine clock was missing, or its counts did not validate",
  "failed-requests": "requests failed, so the cell has no reading",
  "instance-changed": "the app stopped, restarted, was replaced or was OOM-killed during the pass",
  unsettled: "a cell's containers were not all removed, or a create was not acknowledged, so no further cell was measured",
  "summary-invalid": "the summary did not validate as a complete pass",
  error: "another error",
});
/**
 * The patterns a value from Docker, the host or a probe must match to be saved (savedValue), and
 * that the readers check again. Anything else is saved as null (not recorded) and kept only in the
 * raw files. The CPU model is limited to letters, digits, single spaces and ( ) . , @ / + -.
 */
export const savedText = Object.freeze({
  cpu: /^(?=.{1,96}$)[A-Za-z0-9().,@/+-]+( [A-Za-z0-9().,@/+-]+)*$/,
  kernel: /^\d{1,4}\.\d{1,4}[0-9A-Za-z.+_-]{0,64}$/,
  onlineCpus: /^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?){0,63}$/,
  docker: /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,32})?$/,
  node: /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/,
  platform: /^[a-z0-9]{1,16}$/,
  k6Version: /^\d{1,4}\.\d{1,4}\.\d{1,4}$/,
  imageId: /^sha256:[a-f0-9]{64}$/,
  containerId: /^[a-f0-9]{64}$/,
  commit: /^[a-f0-9]{40}$/,
  sha256: /^[a-f0-9]{64}$/,
  name: /^[a-z0-9][a-z0-9-]{0,40}$/,
  runId: /^[a-z0-9][a-z0-9-]{0,127}$/,
  attemptLabel: /^[a-z0-9.]{1,64}=[a-z0-9-]{1,160}$/,
  label: /^[\w.-]+=[\w.:/-]*$/,
  round: /^[rw][1-9]\d{0,8}$/,
  path: /^(?=.{1,240}$)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/,
  time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
});
const matches = (kind, value) => typeof value === "string" && savedText[kind].test(value) && !(kind === "path" && value.split("/").some((part) => part === "." || part === ".."));
/** A value from outside the checkout as summary.json may keep it: whitespace normalized, then its pattern, or null. */
export function savedValue(kind, text) {
  assert.ok(Object.hasOwn(savedText, kind), "unknown saved value kind");
  if (typeof text !== "string") return null;
  const value = text.replace(/\s+/g, " ").trim();
  return matches(kind, value) ? value : null;
}
/**
 * The tolerance reading: a screening reading of a pass's throughput, not a certificate of steady
 * state. It says whether the end of a pass stayed within stated bounds, and from which window; no
 * report concludes from it that a timed warmup is long enough. Its spans are in seconds:
 * h = holdSeconds / window length windows, and the window length must divide holdSeconds. For a
 * pass of n windows of throughput r[0..n-1] (requests completed in the window over its length):
 * 1. Fewer than 2h windows, or fewer than smoothing: no reading (too-few-windows).
 * 2. tail = median of the last holdSeconds, previous = median of the holdSeconds before them,
 *    head = median of the first holdSeconds. tail = 0: no reading (no-throughput).
 * 3. previous or head > tail * (1 + tolerance): not within tolerance at the end
 *    (earlier-above-tail: the 60 s before the last, or the first 60 s, has a median more than 5%
 *    above the last 60 s median), whatever the last windows do.
 * 4. smoothed[j] is the median of three consecutive windows centered on j, clamped to the pass.
 * 5. The run is the longest suffix in which every window lies within tail * (1 +/- windowTolerance)
 *    and every smoothed value within tail * (1 +/- tolerance).
 * 6. The onset is the first window s of that run whose own throughput is within
 *    tail * (1 +/- tolerance), that leaves at least holdSeconds after its start, and from which
 *    the least-squares line through windows s..n-1 changes by at most tolerance * tail. The reading
 *    is "within the stated tolerance from the window ending at (s + 1) * window length s": the
 *    onset is reported at the window's end, so it is never less than one window.
 * 7. Otherwise not within tolerance at the end. A run shorter than holdSeconds is short, or
 *    short-above-previous when also tail > previous * (1 + tolerance). A longer run with no onset
 *    is trend-up or trend-not-up by the sign of the least-squares line through the whole run. Each
 *    reason names the comparison that decided it; verdictText says it in those terms. None of them
 *    says how the last window moved: a pass whose last window halved after a climb is short-above-
 *    previous, since that window leaves the run empty and the last 60 s median is still above the
 *    60 s before it.
 * The bounds, then: every window within 10% of the tail median, every three-window median within
 * 5%, and a least-squares change of at most 5% from the onset to the end. What that does not
 * detect, by construction (steady.test.mjs pins each case):
 * - Oscillation or drift inside the bounds reads as within tolerance. 920, 1000, 1080, 1000
 *   repeated five times in 15 s windows reads within tolerance from the window ending at 30 s:
 *   every window is within 8% of the tail and every three-window median is the tail; only the
 *   first window (920, 8% under) is too far off to be the onset. A steady climb from 1000 to 1076
 *   over 20 windows reads within tolerance from the window ending at 105 s, once the climb left
 *   after it is under 5% of the tail.
 * - A shift in the last window under 10% can go undetected: nineteen windows at 1000 then one at
 *   1090 reads within tolerance from the window ending at 15 s, since the tail median is still 1000.
 * - A pass that started faster is not within tolerance even if it then held: four windows at
 *   1100 then sixteen at 1000 reads that the median of its first 60 s is more than 5% above the tail.
 * - The onset resolution is one window, and readings from passes with different window lengths
 *   are not comparable: the medians, the run and the onset all move with the window length.
 * p95 and p99 are kept per window as evidence; the rule reads throughput only.
 * Why these numbers: 5% and 10% are stated choices, not derived from measured noise; revisit them
 * once saved passes show the window-to-window spread on the measurement host.
 */
export const flattenRule = Object.freeze({ name: "marketplace-tolerance/v4", tolerance: 0.05, windowTolerance: 0.1, holdSeconds: 60, smoothing: 3 });
const minConvergenceWindows = 8;
// The default pass runs the timed warmup's users, so that input matches a timed round's warmup
// (unlikeRound). --vus changes it for exploration, and such a pass is listed as not like-for-like.
export const convergenceDefaults = Object.freeze({ minutes: 5, windowSeconds: 15, vus: timedWarmupVus, targets: steadyTargets, sources: steadySources, startupTimeout: 120 });
export const soakDefaults = Object.freeze({ minutes: 30, windowSeconds: 60, rate: 150, targets: Object.freeze(["page"]), sources: steadySources, startupTimeout: 120 });
const maxWindows = 360;
/** The label steady.mjs owns its containers and networks by (run.mjs uses the same key). */
export const ownerLabelKey = "run.corten.marketplace";
/**
 * The marketplace fixture an app container mounts must be the one fixtures.mjs generates now, as
 * run.mjs requires for a timed round: a stale or missing fixture fails before any container starts.
 * @param {Buffer | null} bytes the fixture file, or null when it does not exist
 * @param {unknown} generated records() from fixtures.mjs
 * @param {(value: unknown) => unknown} validate validateMarketplace from records.mjs
 * @returns {string} the fixture's SHA-256
 */
export function checkFixture(bytes, generated, validate) {
  assert.ok(bytes, "the marketplace fixture is missing: run node bench/marketplace/fixtures.mjs");
  assert.deepEqual(validate(JSON.parse(bytes)), generated, "generated fixture is stale: run node bench/marketplace/fixtures.mjs");
  return createHash("sha256").update(bytes).digest("hex");
}

const integer = (value, min, max, name) => {
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be an integer from ${min} to ${max}`);
  return value;
};
const list = (value, allowed, name) => {
  const items = value.split(",");
  assert.ok(items.length > 0 && items.every((v) => allowed.includes(v)) && new Set(items).size === items.length, `${name} takes a comma-separated subset of ${allowed.join(",")}`);
  return allowed.filter((v) => items.includes(v));
};
/**
 * node bench/marketplace/steady.mjs <convergence|soak> <name> [--group g | --apps a,b] [--build]
 *   [--minutes m] [--window s | --interval s] [--vus n] [--rate n] [--targets page,json]
 *   [--sources fixture,api] [--startup-timeout s] [--admitted-from summary.json] [--label key=value ...]
 * Each --label goes on every container and network the pass creates, beside its ownership label.
 * Docker keeps a key's last value, so a caller label in the run.corten.marketplace namespace would
 * take a resource out of the pass's ownership checks: those keys are refused here, before Docker.
 * @param {string[]} args
 * @param {string[]} inventory the adapters that may be named
 * @param {(group: string) => string[]} groupApps
 */
export function parseSteadyArgs(args, inventory, groupApps) {
  const [kind, name, ...rest] = args;
  assert.ok(kind === "convergence" || kind === "soak", "usage: steady.mjs <convergence|soak> <name> [options]");
  assert.match(name ?? "", /^[a-z0-9][a-z0-9-]{0,40}$/, "a pass name is lowercase letters, digits and dashes, for example w3 or r21-runtimes");
  const defaults = kind === "convergence" ? convergenceDefaults : soakDefaults;
  const options = { kind, name, build: false, group: undefined, apps: null, minutes: defaults.minutes, windowSeconds: defaults.windowSeconds,
    vus: kind === "convergence" ? defaults.vus : null, rate: kind === "soak" ? defaults.rate : null, targets: [...defaults.targets], sources: [...defaults.sources],
    startupTimeout: defaults.startupTimeout, admittedFrom: null, labels: [] };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    assert.ok(flag === "--label" || !seen.has(flag), `duplicate option ${flag}`); seen.add(flag);
    if (flag === "--build") { options.build = true; continue; }
    const value = rest[++i];
    assert.ok(value !== undefined && !value.startsWith("--"), `${flag} needs a value`);
    const number = Number(value);
    switch (flag) {
      case "--group": options.group = value; groupApps(value); break;
      case "--apps": options.apps = list(value, inventory, "--apps"); break;
      case "--minutes": options.minutes = kind === "convergence" ? integer(number, 2, 30, "--minutes") : integer(number, 30, 60, "--minutes"); break;
      case "--window": assert.equal(kind, "convergence", "--window is a convergence option; a soak takes --interval"); options.windowSeconds = integer(number, 5, 60, "--window"); break;
      case "--interval": assert.equal(kind, "soak", "--interval is a soak option; a convergence pass takes --window"); options.windowSeconds = integer(number, 10, 300, "--interval"); break;
      case "--vus": assert.equal(kind, "convergence", "a soak runs at a fixed rate: use --rate"); options.vus = integer(number, 1, 1000, "--vus"); break;
      case "--rate": assert.equal(kind, "soak", "a convergence pass is a closed loop: use --vus"); options.rate = integer(number, 1, 10000, "--rate"); break;
      case "--targets": options.targets = list(value, steadyTargets, "--targets"); break;
      case "--sources": options.sources = list(value, steadySources, "--sources"); break;
      case "--startup-timeout": options.startupTimeout = integer(number, 1, 600, "--startup-timeout"); break;
      case "--admitted-from": options.admittedFrom = value; break;
      case "--label": {
        const key = /^([\w.-]+)=[\w.:/-]*$/.exec(value)?.[1];
        assert.ok(key, `--label takes KEY=VALUE, not ${value}`);
        assert.ok(key !== ownerLabelKey && !key.startsWith(`${ownerLabelKey}.`), `--label ${key} is reserved for the pass's ownership labels`);
        assert.ok(!options.labels.some((l) => l.startsWith(`${key}=`)), `duplicate --label ${key}`);
        options.labels.push(value); break;
      }
      default: assert.fail(`unknown option ${flag}`);
    }
  }
  assert.ok(!(options.group !== undefined && options.apps), "--group cannot be combined with --apps");
  options.apps ??= groupApps(options.group);
  assert.ok(options.apps.length > 0 && options.apps.every((a) => inventory.includes(a)), "unknown adapter");
  const seconds = options.minutes * 60;
  if (kind === "convergence") assert.equal(flattenRule.holdSeconds % options.windowSeconds, 0, `--window must divide the tolerance reading's ${flattenRule.holdSeconds} s span (5, 6, 10, 12, 15, 20, 30 or 60)`);
  assert.equal(seconds % options.windowSeconds, 0, "the pass must be a whole number of windows");
  options.windows = integer(seconds / options.windowSeconds, kind === "convergence" ? minConvergenceWindows : 2, maxWindows, "windows (minutes * 60 / window)");
  return options;
}
/** The options summary.json keeps: parseSteadyArgs's, without the --admitted-from path (admission keeps a checked one). */
export function savedOptions(o) {
  return { kind: o.kind, name: o.name, build: o.build, group: o.group ?? null, apps: [...o.apps], minutes: o.minutes, windowSeconds: o.windowSeconds, windows: o.windows,
    vus: o.vus, rate: o.rate, targets: [...o.targets], sources: [...o.sources], startupTimeout: o.startupTimeout, labels: [...o.labels] };
}
/** What each pass says it is, and the clock its windows are on: fixed text a reader requires. */
export const passScope = Object.freeze({
  convergence: "marketplace-v2 convergence: one closed-loop pass per adapter, source and target, throughput and latency per window; not a timed round or a comparison",
  soak: "marketplace-v2 soak: one fixed-rate pass per adapter, source and target, memory at the start and end, p99 per interval and restarts; not a timed round or a comparison",
});
export const windowClock = "windows are the k6 engine's clock from the start of the test; a request counts in the window its answer completed in";
/** The format of a soak's live event stream (steady-run.mjs eventStream): one row per event. */
export const eventFormat = "{{.Actor.ID}}|{{.Action}}|{{.TimeNano}}";
/**
 * The restart-relevant events of a soak's app from its live Docker event stream, with their time in
 * seconds from `startedMs` (the load container's StartedAt, on the daemon's clock as the events
 * are). `docker events --since/--until` replays only what the daemon still buffers (its last 256
 * events), so an empty answer to such a query does not show that nothing happened; a soak reads a
 * live stream instead, filtered to its app and to a marker container, and started before the load.
 * The pass starts the marker once the stream runs, before the load, and again after the app's last
 * inspect. A stream delivers events in the order the daemon publishes them, so one that shows both
 * marker starts was listening before the load began and had delivered every app event published
 * before the load's end. Every row must be one of the two container IDs, an action (lowercase
 * letters and underscores, optionally followed by ": " and detail, as health_status and exec_start
 * are) and a time in nanoseconds. One row that is not, or fewer than two marker starts, makes the
 * whole observation unreadable: this throws a fixed message with a count, and the caller saves the
 * stream as unavailable. Returns the app's start, restart, die, kill and oom events before the
 * second marker start, with no detail.
 */
export function readEvents(text, startedMs, { app, marker } = {}) {
  assert.ok(typeof text === "string", "docker events returned no text");
  assert.ok(Number.isFinite(startedMs), "the load container's StartedAt is not a time");
  assert.ok(matches("containerId", app) && matches("containerId", marker) && app !== marker, "the event stream reads an app and a marker by their container IDs");
  const rows = text.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
  const events = [];
  let unreadable = 0, markers = 0;
  for (const row of rows) {
    const first = row.indexOf("|"), last = row.lastIndexOf("|");
    const id = row.slice(0, Math.max(first, 0)), action = row.slice(first + 1, Math.max(last, first + 1)), nanos = row.slice(last + 1);
    if (first <= 0 || last <= first || (id !== app && id !== marker) || !/^[a-z_]{1,32}(: .*)?$/.test(action) || !/^[1-9]\d{0,19}$/.test(nanos)) { unreadable++; continue; }
    const name = action.split(":", 1)[0];
    if (id === marker) { if (name === "start") markers++; continue; }
    // After the second marker start: past the end of the observation (teardown).
    if (markers < 2 && restartActions.includes(name)) events.push({ action: name, atSeconds: (Number(nanos) / 1e6 - startedMs) / 1000 });
  }
  assert.ok(unreadable === 0, `${unreadable} docker events row${unreadable === 1 ? " is" : "s are"} not this soak's app or marker, an action and a time`);
  assert.ok(markers >= 2, `the event stream showed ${markers} of the marker's 2 starts, so it does not cover the soak`);
  return events;
}
const restartActions = Object.freeze(["start", "restart", "die", "oom", "kill"]);

const metric = (summary, name) => summary?.metrics?.[name]?.values ?? summary?.metrics?.[name];
const count = (summary, name) => {
  const m = metric(summary, name);
  if (m === undefined) return 0;
  assert.ok(Number.isSafeInteger(m?.count) && m.count >= 0, `k6 ${name} counter malformed`);
  return m.count;
};
/**
 * The windows window-load.js recorded in its k6 summary export: each request is counted in the
 * window its answer completed in, by the k6 engine's own clock, and requests completing during
 * the graceful stop after the last window are kept apart as the tail. A window with no request has
 * no latency. The windows and tail must account for every request k6 counted, except one whose
 * iteration the graceful stop cut off before it was counted (unrecorded, at most the unfinished
 * iterations). `requests` and `iterations` are k6's own totals, kept so a saved pass reconciles.
 * `latencyMaxMs` is k6's aggregate http_req_duration maximum over every request (windows, tail and
 * unrecorded); no window's latency may be above it. A fixed-rate load (`arrivals`, a soak) also
 * counts each iteration in the window k6 started it in (window_N_arrivals), returned as `arrivals`;
 * a closed loop defines no such counter, and one in its export is refused.
 * @returns {{ windows: {index: number, startSeconds: number, seconds: number, requests: number, failed: number, rps: number, p95: number | null, p99: number | null}[], tail: number, unrecorded: number, requests: number, iterations: number, latencyMaxMs: number | null, arrivals?: number[] }}
 */
export function readWindows(summary, { windows, windowSeconds, arrivals = false }) {
  integer(windows, 1, maxWindows, "windows"); integer(windowSeconds, 1, 3600, "windowSeconds");
  const names = Object.keys(summary?.metrics ?? {});
  // Counted, not quoted: a name this load does not define is untrusted output.
  const unexpected = names.filter((n) => n.startsWith("window_") && n !== "window_tail_requests").filter((name) => {
    const m = /^window_(0|[1-9]\d*)_(requests|failed|duration|arrivals)$/.exec(name);
    return !(m && Number(m[1]) < windows && (arrivals || m[2] !== "arrivals"));
  }).length;
  if (unexpected) throw new Error(`${unexpected} k6 window metric${unexpected === 1 ? " is" : "s are"} not among this pass's windows`);
  const rows = Array.from({ length: windows }, (_, index) => {
    const requests = count(summary, `window_${index}_requests`), failed = count(summary, `window_${index}_failed`);
    assert.ok(failed <= requests, `window ${index}: more failures than requests`);
    const d = metric(summary, `window_${index}_duration`);
    let p95 = null, p99 = null;
    if (requests > 0) {
      p95 = d?.["p(95)"]; p99 = d?.["p(99)"];
      assert.ok(Number.isFinite(p95) && Number.isFinite(p99) && p95 >= 0 && p95 <= p99, `window ${index}: latency p95/p99 missing or malformed`);
    } else assert.equal(d, undefined, `window ${index}: latency without requests`);
    return { index, startSeconds: index * windowSeconds, seconds: windowSeconds, requests, failed, rps: requests / windowSeconds, p95, p99 };
  });
  const tail = count(summary, "window_tail_requests");
  const total = metric(summary, "http_reqs")?.count, iterations = metric(summary, "iterations")?.count;
  assert.ok(Number.isSafeInteger(total) && Number.isSafeInteger(iterations) && iterations <= total, "k6 request and iteration counters missing");
  const unrecorded = total - rows.reduce((sum, w) => sum + w.requests, 0) - tail;
  assert.ok(unrecorded >= 0 && unrecorded <= total - iterations, "windows and tail do not account for every request k6 counted");
  const latencyMaxMs = total ? metric(summary, "http_req_duration")?.max : null;
  if (total) assert.ok(Number.isFinite(latencyMaxMs) && latencyMaxMs >= 0, "k6 http_req_duration maximum missing");
  else assert.ok(metric(summary, "http_req_duration") === undefined || metric(summary, "http_req_duration")?.max === undefined, "k6 latency without requests");
  latencyWithin(rows, latencyMaxMs);
  return { windows: rows, tail, unrecorded, requests: total, iterations, latencyMaxMs, ...(arrivals ? { arrivals: rows.map((w) => count(summary, `window_${w.index}_arrivals`)) } : {}) };
}
// Every window's latency is drawn from the same requests as k6's aggregate http_req_duration, so no
// window's p95 or p99 can be above the aggregate maximum.
function latencyWithin(windows, max) {
  for (const w of windows) if (w.p99 !== null) assert.ok(max !== null && w.p95 <= max && w.p99 <= max, `window ${w.index}: latency above k6's aggregate http_req_duration maximum`);
}

// A Docker timestamp a pass compares: savedText's UTC form, and a real start (Docker writes
// 0001-01-01T00:00:00Z for a container that never started).
const startTime = (value) => matches("time", value) && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0;
/**
 * The app's instance as a pass compares it, from Docker inspect output: its 64-hex container ID,
 * StartedAt as a timestamp, RestartCount as a count, and Running and OOMKilled as booleans. Any of
 * them missing or of another form refuses the snapshot with a fixed message naming `which`, before
 * any comparison: two missing counters or two identical malformed timestamps are not the same
 * instance. The raw snapshots (app-container.json, app-container-after.json) keep RestartCount.
 * @returns {{id: string, startedAt: string, restartCount: number, running: boolean, oomKilled: boolean}}
 */
export function appInstance(info, which) {
  const s = info?.State;
  assert.ok(matches("containerId", info?.Id) && nonNegative(info.RestartCount) && s !== null && typeof s === "object" && startTime(s.StartedAt)
    && typeof s.Running === "boolean" && typeof s.OOMKilled === "boolean", `the app's instance ${which} the load is not recorded as a container ID, a StartedAt time, a RestartCount and its running and OOM states`);
  return { id: info.Id, startedAt: s.StartedAt, restartCount: info.RestartCount, running: s.Running, oomKilled: s.OOMKilled };
}
/** The app before the load: a valid snapshot (appInstance) of a running app that was not OOM-killed. */
export function appBefore(info) {
  const before = appInstance(info, "before");
  assert.ok(before.running && !before.oomKilled, "the app was not running, or was OOM-killed, before the load");
  return before;
}
/**
 * A convergence cell's app must be the same running instance through the whole pass: the same
 * container ID and StartedAt, still running, not OOM-killed and not restarted. Otherwise its
 * throughput says nothing about warming and the cell gets no reading. Takes Docker inspect output
 * from before and after the load; both are validated (appBefore, appInstance) before they are compared.
 */
export function heldThrough(before, after) {
  const b = appBefore(before), a = appInstance(after, "after");
  // The message names which checks failed, never Docker's values (the receipts keep those).
  const changed = [a.id !== b.id && "another container ID", a.startedAt !== b.startedAt && "another StartedAt", !a.running && "not running",
    a.oomKilled && "OOM-killed", a.restartCount !== b.restartCount && "another RestartCount"].filter(Boolean);
  assert.ok(changed.length === 0, `app container stopped, restarted, was replaced or was OOM-killed during the pass: ${changed.join(", ")}`);
}
/** The iterations k6 dropped because it could not start them on time (constant-arrival-rate), 0 when none. */
export function readDropped(summary) { return count(summary, "dropped_iterations"); }
const median = (values) => {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// The change from the first to the last value of the least-squares line through equally spaced values.
const fittedChange = (values) => {
  const k = values.length, mean = (k - 1) / 2, avg = values.reduce((a, b) => a + b, 0) / k;
  let num = 0, den = 0;
  values.forEach((v, i) => { num += (i - mean) * (v - avg); den += (i - mean) ** 2; });
  return den === 0 ? 0 : (num / den) * (k - 1);
};
/**
 * The tolerance reading of a pass, by flattenRule (above).
 * @param {{rps: number, startSeconds: number}[]} windows in order
 */
export function flattenPoint(windows, rule = flattenRule) {
  assert.deepEqual(rule, flattenRule, "only the stated tolerance rule is applied");
  const { tolerance: t, windowTolerance: w, holdSeconds, smoothing } = rule, n = windows.length, rps = windows.map((x) => x.rps);
  assert.ok(rps.every((r) => Number.isFinite(r) && r >= 0), "window throughput must be finite and not negative");
  const size = windows[0]?.seconds;
  assert.ok(n === 0 || (Number.isSafeInteger(size) && size > 0 && holdSeconds % size === 0 && windows.every((x) => x.seconds === size)), `windows must share one length that divides ${holdSeconds} s`);
  const h = n ? holdSeconds / size : 1;
  if (n < 2 * h || n < smoothing) return { withinTolerance: false, reason: "too-few-windows" };
  const tail = median(rps.slice(n - h)), previous = median(rps.slice(n - 2 * h, n - h)), head = median(rps.slice(0, h));
  if (tail === 0) return { withinTolerance: false, reason: "no-throughput", tailRps: 0 };
  const evidence = { tailRps: tail, previousRps: previous, headRps: head };
  if (previous > tail * (1 + t) || head > tail * (1 + t)) return { withinTolerance: false, reason: "earlier-above-tail", ...evidence };
  const within = (r, band) => r >= tail * (1 - band) && r <= tail * (1 + band);
  const smoothed = rps.map((_, j) => { const c = Math.min(Math.max(j, 1), n - 2); return median(rps.slice(c - 1, c + 2)); });
  let run = n;
  while (run > 0 && within(rps[run - 1], w) && within(smoothed[run - 1], t)) run--;
  for (let s = run; s <= n - h; s++) {
    if (within(rps[s], t) && Math.abs(fittedChange(rps.slice(s))) <= t * tail) return { withinTolerance: true, window: s, fromSeconds: windows[s].startSeconds + size, ...evidence };
  }
  if (n - run < h) return { withinTolerance: false, reason: tail > previous * (1 + t) ? "short-above-previous" : "short", ...evidence };
  return { withinTolerance: false, reason: fittedChange(rps.slice(run)) > 0 ? "trend-up" : "trend-not-up", ...evidence };
}

const cellKey = (c) => `${c.app} ${c.source} ${c.target}`;
function windowsEvidence(windows, n, seconds) {
  assert.ok(Array.isArray(windows) && windows.length === n, "a pass keeps every window");
  windows.forEach((w, index) => {
    assert.deepEqual(Object.keys(w).sort(), ["failed", "index", "p95", "p99", "requests", "rps", "seconds", "startSeconds"], `window ${index}: fields`);
    assert.ok(w.index === index && w.seconds === seconds && w.startSeconds === index * seconds, `window ${index}: its position and length`);
    assert.ok(Number.isSafeInteger(w.requests) && w.requests >= 0 && Number.isSafeInteger(w.failed) && w.failed >= 0 && w.failed <= w.requests, `window ${index}: counts`);
    assert.equal(w.rps, w.requests / seconds, `window ${index}: throughput contradicts its count`);
    if (w.requests) assert.ok(Number.isFinite(w.p95) && w.p95 >= 0 && w.p95 <= w.p99 && Number.isFinite(w.p99), `window ${index}: latency`);
    else assert.deepEqual([w.p95, w.p99], [null, null], `window ${index}: latency without requests`);
  });
}
// A cell's windows, graceful-stop tail and unrecorded requests must add up to k6's own request total;
// no window's latency may be above k6's aggregate maximum; and k6's aggregate failures are at least
// the windows' and at most the windows' plus every request outside them (tail and unrecorded).
// Checked when a cell is captured and again when a saved pass is read.
export function reconcileCell(c) {
  assert.ok(Number.isSafeInteger(c.requests) && Number.isSafeInteger(c.iterations) && c.iterations >= 0 && c.iterations <= c.requests, `${cellKey(c)}: k6 request and iteration totals`);
  assert.ok(Number.isSafeInteger(c.tail) && c.tail >= 0 && Number.isSafeInteger(c.unrecorded) && c.unrecorded >= 0, `${cellKey(c)}: tail and unrecorded requests`);
  assert.equal(c.windows.reduce((sum, w) => sum + w.requests, 0) + c.tail + c.unrecorded, c.requests, `${cellKey(c)}: windows, tail and unrecorded requests do not add up to k6's request total`);
  assert.ok(c.unrecorded <= c.requests - c.iterations, `${cellKey(c)}: more unrecorded requests than unfinished iterations`);
  assert.ok(c.requests === 0 ? c.latencyMaxMs === null : Number.isFinite(c.latencyMaxMs) && c.latencyMaxMs >= 0, `${cellKey(c)}: k6's aggregate latency maximum`);
  latencyWithin(c.windows, c.latencyMaxMs);
  const inWindows = c.windows.reduce((sum, w) => sum + w.failed, 0);
  assert.ok(Number.isSafeInteger(c.failedRequests) && c.failedRequests >= inWindows && c.failedRequests - inWindows <= c.tail + c.unrecorded,
    `${cellKey(c)}: k6's aggregate failures are fewer than its windows' or more than its windows' plus the requests outside them`);
}
// An object with exactly the named fields (optional ones may be absent). The message names `where`,
// which callers pass from this module, never a saved key or value.
function fields(value, required, where, optional = []) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${where} is not recorded`);
  const keys = Object.keys(value);
  assert.ok(required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k)), `${where} has fields its schema does not save, or lacks one it does`);
}
const nullable = (kind, value, message) => assert.ok(value === null || matches(kind, value), message);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const nonNegative = (value) => Number.isSafeInteger(value) && value >= 0;
// The saved options: parseSteadyArgs's bounds again, so every option a report prints is checked.
function optionsEvidence(o, kind) {
  fields(o, ["kind", "name", "build", "group", "apps", "minutes", "windowSeconds", "windows", "vus", "rate", "targets", "sources", "startupTimeout", "labels"], "the pass's options");
  assert.ok(o.kind === kind && matches("name", o.name) && typeof o.build === "boolean" && (o.group === null || matches("name", o.group)), "the pass's options: kind, name, build or group");
  for (const key of ["apps", "sources", "targets"]) assert.ok(Array.isArray(o[key]) && o[key].length > 0, `a pass names at least one of its ${key}`);
  assert.ok(o.apps.every((a) => matches("name", a)) && new Set(o.apps).size === o.apps.length, "the pass's options: adapters");
  assert.ok(o.targets.every((t) => steadyTargets.includes(t)) && new Set(o.targets).size === o.targets.length && o.sources.every((t) => steadySources.includes(t)) && new Set(o.sources).size === o.sources.length, "the pass's options: sources and targets");
  const convergence = kind === "convergence";
  const within = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  assert.ok(convergence ? within(o.minutes, 2, 30) && within(o.windowSeconds, 5, 60) && flattenRule.holdSeconds % o.windowSeconds === 0 : within(o.minutes, 30, 60) && within(o.windowSeconds, 10, 300), "the pass's options: length and window");
  assert.ok(within(o.windows, convergence ? minConvergenceWindows : 2, maxWindows) && o.windows * o.windowSeconds === o.minutes * 60, "windows contradict the pass length");
  assert.ok(convergence ? within(o.vus, 1, 1000) && o.rate === null : within(o.rate, 1, 10000) && o.vus === null, "the pass's options: users or rate");
  assert.ok(within(o.startupTimeout, 1, 600), "the pass's options: startup timeout");
  assert.ok(Array.isArray(o.labels) && o.labels.every((l) => matches("label", l) && !(l.startsWith(`${ownerLabelKey}=`) || l.startsWith(`${ownerLabelKey}.`))), "the pass's options: labels");
}
// The fields both kinds of pass save, each checked: a saved pass holds nothing else.
function passEvidence(s, schema) {
  assert.equal(s?.schema, schema, `not a ${schema} result`);
  const kind = schema === convergenceSchema ? "convergence" : "soak";
  assert.ok(matches("name", s.name) && matches("runId", s.runId), "a pass records its name and run");
  assert.ok(matches("commit", s.commit), "a pass records its measured commit");
  assert.equal(s.finishedCommit, s.commit, "a pass finishes at the commit it started at");
  assert.equal(s.dirty, false, "a pass measures a clean checkout");
  assert.equal(s.complete, true, "an incomplete pass is not evidence");
  assert.deepEqual(s.failures, [], "a pass with a suite failure is not evidence");
  // Cleanup must be confirmed: no failure, nothing left with the owner label, and every create
  // Docker did not acknowledge found and removed (cleanup.json keeps the whole record).
  const k = s.cleanup;
  assert.ok(k?.complete === true && Array.isArray(k.remaining?.containers) && Array.isArray(k.remaining?.networks) && k.remaining.containers.length === 0 && k.remaining.networks.length === 0
    && Array.isArray(k.unacknowledged) && k.unacknowledged.every((a) => a?.outcome === "removed"), "a pass whose cleanup is not confirmed complete is not evidence");
  assert.ok(k.failures === 0, "a pass whose cleanup failed is not evidence");
  fields(k, ["complete", "remaining", "created", "removed", "recovered", "failures", "unacknowledged"], "the pass's cleanup");
  fields(k.remaining, ["containers", "networks"], "the pass's remaining resources");
  assert.ok([k.created, k.removed, k.recovered].every(nonNegative), "the pass's cleanup counts");
  for (const a of k.unacknowledged) { fields(a, ["name", "label", "outcome"], "an unacknowledged create"); nullable("runId", a.name, "an unacknowledged create's name"); nullable("attemptLabel", a.label, "an unacknowledged create's label"); }
  assert.ok(matches("time", s.startedAt) && matches("time", s.finishedAt) && Date.parse(s.finishedAt) >= Date.parse(s.startedAt), "a pass records its window");
  const host = s.host;
  fields(host, ["platform", "release", "node", "docker", "kernel", "cpu", "onlineCpus"], "the pass's host");
  for (const key of Object.keys(host)) nullable(key === "release" ? "kernel" : key, host[key], `the pass's host ${key} is not a value it saves`);
  assert.ok(Object.hasOwn(startups, s.startup), "a pass records how it started each app, by a known code");
  assert.equal(s.scope, passScope[kind], "a pass states its scope");
  // What makes a pass comparable with a timed round (unlikeRound): its image IDs and CPU settings,
  // the fixture, upstream and k6 images.
  const o = s.options;
  optionsEvidence(o, kind);
  assert.equal(o.name, s.name, "the pass's options name another pass");
  const m = s.measurement;
  fields(m, ["cpus", "appMemoryBytes", "upstreamMemoryBytes", "encoding", "clock", ...(kind === "soak" ? ["memoryClock"] : [])], "the pass's CPU settings and measurement");
  const pins = cpuRoles.map((role) => m.cpus?.[role]?.cpuset);
  assert.ok(pins.every((p) => p === null || (typeof p === "string" && /^\d{1,4}(?:-\d{1,4})?(?:,\d{1,4}(?:-\d{1,4})?){0,63}$/.test(p))), "a pass records its CPU settings");
  let cpus;
  try { cpus = cpuSettings(Object.fromEntries(cpuRoles.map((role, i) => [`MARKETPLACE_${role.toUpperCase()}_CPUS`, pins[i] ?? undefined]))); } catch { assert.fail("a pass records its CPU settings"); }
  assert.deepEqual(m.cpus, cpus, "a pass records its CPU settings");
  assert.ok(Number.isSafeInteger(m.appMemoryBytes) && m.appMemoryBytes > 0 && Number.isSafeInteger(m.upstreamMemoryBytes) && m.upstreamMemoryBytes > 0 && m.encoding === "identity" && m.clock === windowClock, "the pass's measurement");
  assert.deepEqual(Object.keys(s.images ?? {}).sort(), [...o.apps].sort(), "a pass records the image ID of every adapter it ran");
  for (const id of Object.values(s.images)) assert.ok(matches("imageId", id), "image IDs are Docker sha256 IDs");
  assert.ok(matches("sha256", s.fixtureSha256), "a pass records its fixture hash");
  for (const tool of ["upstream", "k6"]) assert.ok(matches("imageId", s.tools?.[tool]?.imageId), `a pass records its ${tool} image ID`);
  fields(s.tools, ["k6", "upstream"], "the pass's tools");
  fields(s.tools.upstream, ["imageId"], "the pass's upstream image");
  fields(s.tools.k6, ["imageId", "version"], "the pass's k6 image");
  assert.ok(matches("k6Version", s.tools.k6.version), "a pass records its k6 version");
  if (s.admission !== null) {
    const a = s.admission;
    fields(a, ["round", "commit", "summarySha256", "path", "selected", "admitted"], "the pass's admission");
    assert.ok(matches("round", a.round) && matches("commit", a.commit) && matches("sha256", a.summarySha256) && (a.path === null || matches("path", a.path))
      && [a.selected, a.admitted].every((list) => Array.isArray(list) && list.every((x) => matches("name", x))) && o.apps.every((x) => a.selected.includes(x) && a.admitted.includes(x)), "the pass's admission");
  }
  fields(s, ["schema", "name", "runId", "options", ...(kind === "convergence" ? ["rule"] : []), "startedAt", "finishedAt", "complete", "failures", "cleanup", "cells", "admission", "startup",
    "host", "scope", "measurement", "commit", "finishedCommit", "dirty", "fixtureSha256", "images", "tools"], "the pass");
  assert.ok(Array.isArray(s.cells) && s.cells.length === o.apps.length * o.sources.length * o.targets.length, "a pass has one cell per adapter, source and target");
  const expected = o.sources.flatMap((source) => o.apps.flatMap((app) => o.targets.map((target) => `${app} ${source} ${target}`)));
  assert.deepEqual(s.cells.map((c) => (typeof c?.app === "string" && typeof c.source === "string" && typeof c.target === "string" ? cellKey(c) : null)), expected, "cells are not the pass's adapters, sources and targets in order");
}
// A cell that failed keeps its code from failureCodes and nothing it measured.
function failedCell(c, extra = []) {
  fields(c, ["app", "source", "target", "failure", ...extra], `${cellKey(c)}: a failed cell`);
  assert.ok(Object.hasOwn(failureCodes, c.failure), `${cellKey(c)}: a failed cell keeps a known failure code`);
}
/**
 * A reader's refusal, without the values that failed: an assertion this module wrote keeps the
 * first line of its message (each is one line of fixed text, or names only checked fields and
 * numbers; Node appends a diff of the compared values below it for some assertions, and that is
 * dropped); any other error (an assertion message Node generated from the values, a TypeError on a
 * malformed field) becomes a fixed one. The values themselves are never on the thrown error.
 */
function refusing(validate) {
  return (s) => {
    try { return validate(s); } catch (error) {
      throw new Error(error?.code === "ERR_ASSERTION" && error.generatedMessage === false ? String(error.message).split("\n", 1)[0] : "the saved pass is not one this schema reads");
    }
  };
}
/** A saved pass's JSON, or a fixed refusal: JSON.parse's own message quotes the input. */
export function parseSaved(text) {
  try { return JSON.parse(text); } catch { throw new Error("the saved pass is not JSON"); }
}
/** Validates a saved convergence pass and recomputes every verdict. Returns it. */
export const validateConvergence = refusing(checkConvergence);
function checkConvergence(s) {
  passEvidence(s, convergenceSchema);
  assert.deepEqual(s.rule, flattenRule, "a convergence pass applies the stated tolerance reading");
  for (const c of s.cells) {
    if (c.failure !== undefined) {
      failedCell(c, ["verdict"]);
      assert.equal(c.verdict, null, `${cellKey(c)}: a failed cell has no verdict`);
      continue;
    }
    fields(c, ["app", "source", "target", "windows", "tail", "unrecorded", "requests", "iterations", "latencyMaxMs", "failedRequests", "verdict"], `${cellKey(c)}: a convergence cell`);
    windowsEvidence(c.windows, s.options.windows, s.options.windowSeconds);
    // A failed answer can be faster than a served one: a cell with any failure, in a window or in
    // k6's aggregate (which also counts the graceful stop), has no verdict, so none is saved.
    assert.ok(c.windows.every((x) => x.failed === 0), `${cellKey(c)}: a cell with failed requests in its windows has no verdict`);
    assert.equal(c.failedRequests, 0, `${cellKey(c)}: a cell with failed requests in k6's aggregate has no verdict`);
    reconcileCell(c);
    assert.deepEqual(c.verdict, flattenPoint(c.windows), `${cellKey(c)}: saved verdict differs from the stated tolerance reading`);
  }
  return s;
}
/**
 * The clock a soak's memory samples and restart events are on. Memory samples are stamped on the
 * workstation clock from the moment the load's docker start was issued, so their intervals are
 * their own: the same length as the latency intervals but from that origin, which leads the k6
 * engine's start by the load container's startup. Restart events are on the Docker daemon's clock
 * from the load container's StartedAt.
 */
export const soakMemoryClock = "memory: docker stats samples on the workstation clock from the issue of the load's docker start, in intervals of their own (the latency intervals' length, from that origin, which leads the k6 engine's start by the load container's startup); start and end memory are medians of the samples in the first and last of those intervals. Restart events: the Docker daemon's clock from the load container's StartedAt";
/**
 * The fixed rate's schedule per interval: constant-arrival-rate starts one iteration per tick of
 * floor(1e9 / rate) ns from slot 0, so interval i holds the slots from i * windowSeconds up to, not
 * including, (i + 1) * windowSeconds, and the last interval also the boundary slot at the very end
 * when the duration is a whole number of ticks. The counts add up to soakArrivals's `scheduled`.
 */
export function intervalSchedule({ rate, seconds, windowSeconds }) {
  assert.ok(Number.isSafeInteger(rate) && rate > 0 && Number.isSafeInteger(windowSeconds) && windowSeconds > 0 && Number.isSafeInteger(seconds) && seconds > 0 && seconds % windowSeconds === 0, "a soak's rate, length and interval");
  const tick = Math.floor(1e9 / rate), n = seconds / windowSeconds, scheduled = Math.floor((seconds * 1e9) / tick) + 1;
  // The first slot at or after `s` seconds.
  const first = (s) => Math.ceil((s * 1e9) / tick);
  const counts = Array.from({ length: n }, (_, i) => first((i + 1) * windowSeconds) - first(i * windowSeconds));
  counts[n - 1] += scheduled - counts.reduce((a, b) => a + b, 0);
  return counts;
}
/**
 * Whether a soak's load held the fixed rate it asked for, throughout, from k6's own counts.
 * constant-arrival-rate starts one iteration (one request: window-load.js makes one, with no
 * redirects) per tick of floor(1e9 / rate) ns from slot 0 through the configured duration, so at
 * most floor(duration / tick) + 1 starts (load-evidence.mjs counts slots the same way). Each start
 * ends as a request k6 recorded or an iteration it dropped, except one the engine's stop cut off
 * before its request was counted. `arrivals` are the iterations window-load.js counted as started in
 * each interval, by the k6 engine's clock (window_N_arrivals); they add up to no more than the
 * schedule less k6's drops, and to at least k6's requests, since every request is made by a started
 * iteration after it is counted. The tolerance is one second of arrivals plus the boundary slot
 * (`allowance`, rate + 1): for the whole soak, the allowance for an iteration the engine's stop cut
 * off; for each interval, for a start counted on the far side of an interval boundary. The rate held
 * only when k6 dropped nothing, its recorded requests fall short of the schedule by at most the
 * allowance, and every interval's arrivals are within the allowance of that interval's schedule
 * (intervalSchedule): 270,000 requests that all arrived in the first minute of a 30-minute soak at
 * 150 requests/second did not hold it. The counts reported are k6's; the schedule is only compared.
 */
export function soakArrivals({ rate, seconds, windowSeconds, requests, droppedIterations, arrivals }) {
  assert.ok(Number.isSafeInteger(rate) && rate > 0 && Number.isSafeInteger(seconds) && seconds > 0, "a soak's rate and length");
  assert.ok(Number.isSafeInteger(requests) && requests >= 0 && Number.isSafeInteger(droppedIterations) && droppedIterations >= 0, "k6's requests and dropped iterations");
  const schedule = intervalSchedule({ rate, seconds, windowSeconds });
  assert.ok(Array.isArray(arrivals) && arrivals.length === schedule.length && arrivals.every(nonNegative), "a soak counts the arrivals k6 started in each interval");
  const tick = Math.floor(1e9 / rate), scheduled = Math.floor((seconds * 1e9) / tick) + 1, allowance = rate + 1;
  const started = arrivals.reduce((a, b) => a + b, 0);
  assert.ok(requests + droppedIterations <= scheduled, "k6 recorded more requests and dropped iterations than the fixed rate schedules");
  assert.ok(started + droppedIterations <= scheduled && requests <= started, "the arrivals per interval do not reconcile with k6's requests, its drops and the schedule");
  const shortfall = scheduled - requests - droppedIterations;
  const intervals = schedule.map((expected, index) => ({ index, startSeconds: index * windowSeconds, scheduled: expected, arrivals: arrivals[index], held: Math.abs(arrivals[index] - expected) <= allowance }));
  return { requested: rate, seconds, scheduled, requests, droppedIterations, shortfall, allowance, intervals, held: droppedIterations === 0 && shortfall <= allowance && intervals.every((i) => i.held) };
}
// The memory reading when it cannot be made: the reason is fixed text (validateSoak checks it), and
// the restart, stop and OOM observations are kept either way.
const memoryUnavailable = (samples, unavailable) => ({ samples, unavailable, startMiB: null, endMiB: null, growthMiB: null, growthPct: null });
const memoryReasons = /^(memory sampling failed|[1-9]\d* memory samples? had no time or no positive size|no memory sample in the (first|last|first or last) interval)$/;
function soakMemory(memory, seconds, end) {
  if (!Array.isArray(memory)) return memoryUnavailable(0, "memory sampling failed");
  const bad = memory.filter((m) => !(Number.isFinite(m?.atSeconds) && Number.isFinite(m?.mib) && m.mib > 0)).length;
  if (bad) return memoryUnavailable(memory.length, `${bad} memory sample${bad === 1 ? "" : "s"} had no time or no positive size`);
  const at = (from, to) => memory.filter((m) => m.atSeconds >= from && m.atSeconds < to).map((m) => m.mib);
  const first = at(0, seconds), last = at(end - seconds, end);
  if (!first.length || !last.length) return memoryUnavailable(memory.length, `no memory sample in the ${!first.length && !last.length ? "first or last" : !first.length ? "first" : "last"} interval`);
  const startMiB = median(first), endMiB = median(last);
  return { samples: memory.length, startMiB, endMiB, growthMiB: endMiB - startMiB, growthPct: (endMiB - startMiB) / startMiB * 100 };
}
/**
 * A soak cell from its intervals, its app's memory samples and what Docker said about the container
 * before and after: memory at the start and end is the median of the samples taken in the first and
 * the last memory interval (soakMemoryClock), or unavailable with a stated reason (sampling failed,
 * a sample with no positive size, or none in the first or last interval) while everything else is
 * still reported; p99 is kept per interval; the fixed rate is held only as soakArrivals says, from
 * `arrivals` per interval; a restart is any RestartCount increase, another container ID or
 * StartedAt at the end (a `docker restart` keeps RestartCount), any start, restart, die, kill or OOM
 * event during the soak, or a container not running or OOM-killed at the end. `before` and `after`
 * have appInstance's forms, and the app must have been running before the load. `memory` is null
 * when sampling failed. `events` is readEvents's list, or null when the live event stream could not
 * be read or did not show it covered the load; the stream's state is saved as eventStream:
 * "unavailable", "clean" (read and covering the load, with no restart-relevant event) or "seen" (at
 * least one). With no other sign of a restart, an unavailable stream leaves `restarted` null (not
 * established) rather than false. Memory and the event stream are independent: either can be
 * unavailable while the other and the container states are reported.
 */
export function summarizeSoak({ windows, tail, unrecorded, requests, iterations, latencyMaxMs, memory, before, after, events, rate, droppedIterations, failedRequests, arrivals }) {
  assert.ok(Array.isArray(windows) && windows.length >= 2, "a soak has at least two intervals");
  const seconds = windows[0].seconds, end = windows.length * seconds;
  // The same forms appInstance requires of Docker's inspect output, and a running app before the load.
  for (const c of [before, after]) assert.ok(matches("containerId", c?.id) && startTime(c.startedAt) && nonNegative(c.restartCount) && typeof c.running === "boolean" && typeof c.oomKilled === "boolean", "container state needs id, startedAt, restartCount, running and oomKilled");
  assert.ok(before.running && !before.oomKilled, "the app was not running, or was OOM-killed, before the load");
  assert.ok(after.restartCount >= before.restartCount, "RestartCount moved backwards");
  assert.ok(events === null || (Array.isArray(events) && events.every((e) => restartActions.includes(e?.action) && finite(e.atSeconds))), "events are readEvents's list or null");
  const restartEvents = (events ?? []).map((e) => ({ action: e.action, atSeconds: e.atSeconds }));
  const eventStream = events === null ? "unavailable" : restartEvents.length ? "seen" : "clean";
  const replaced = after.id !== before.id || after.startedAt !== before.startedAt;
  const p99 = windows.filter((w) => w.p99 !== null).map((w) => w.p99);
  return { windows, tail, unrecorded, requests, iterations, latencyMaxMs, rate: soakArrivals({ rate, seconds: end, windowSeconds: seconds, requests, droppedIterations, arrivals }), memory: soakMemory(memory, seconds, end),
    p99: { first: windows[0].p99, last: windows.at(-1).p99, max: p99.length ? Math.max(...p99) : null },
    failed: windows.reduce((sum, w) => sum + w.failed, 0), failedRequests,
    restarts: restartClaim({ restartCount: after.restartCount - before.restartCount, replaced, eventStream, events: restartEvents, runningAtEnd: after.running, oomKilled: after.oomKilled }) };
}
// The restart claim from its observations: true on any sign of a restart, false only when the
// event stream was read, covered the load and showed none, and null (not established) otherwise.
function restartClaim(r) {
  const seen = r.restartCount > 0 || r.replaced || r.events.length > 0 || !r.runningAtEnd || r.oomKilled;
  return { restarted: seen ? true : r.eventStream === "unavailable" ? null : false, ...r };
}
/** Validates a saved soak, including that its rate, p99, memory and restart claims agree with its own counters. Returns it. */
export const validateSoak = refusing(checkSoak);
function checkSoak(s) {
  passEvidence(s, soakSchema);
  assert.ok(Number.isSafeInteger(s.options.rate) && s.options.rate > 0, "a soak records its rate");
  assert.equal(s.measurement?.memoryClock, soakMemoryClock, "a soak states the clock of its memory samples");
  for (const c of s.cells) {
    if (c.failure !== undefined) { failedCell(c); continue; }
    fields(c, ["app", "source", "target", "windows", "tail", "unrecorded", "requests", "iterations", "latencyMaxMs", "rate", "memory", "p99", "failed", "failedRequests", "restarts"], `${cellKey(c)}: a soak cell`);
    windowsEvidence(c.windows, s.options.windows, s.options.windowSeconds);
    reconcileCell(c);
    const m = c.memory;
    if (m?.unavailable !== undefined) {
      fields(m, ["samples", "unavailable", "startMiB", "endMiB", "growthMiB", "growthPct"], `${cellKey(c)}: unavailable memory`);
      assert.ok(typeof m.unavailable === "string" && memoryReasons.test(m.unavailable) && nonNegative(m.samples) && [m.startMiB, m.endMiB, m.growthMiB, m.growthPct].every((x) => x === null), `${cellKey(c)}: unavailable memory`);
    } else {
      fields(m, ["samples", "startMiB", "endMiB", "growthMiB", "growthPct"], `${cellKey(c)}: memory`);
      // Numbers before any arithmetic: a string would pass a comparison and break the report.
      assert.ok(nonNegative(m.samples) && m.samples > 1 && finite(m.startMiB) && m.startMiB > 0 && finite(m.endMiB) && m.endMiB > 0 && finite(m.growthMiB) && finite(m.growthPct)
        && m.growthMiB === m.endMiB - m.startMiB && m.growthPct === m.growthMiB / m.startMiB * 100, `${cellKey(c)}: memory`);
    }
    const p99 = c.windows.filter((w) => w.p99 !== null).map((w) => w.p99);
    assert.deepEqual(c.p99, { first: c.windows[0].p99, last: c.windows.at(-1).p99, max: p99.length ? Math.max(...p99) : null }, `${cellKey(c)}: p99 contradicts its intervals`);
    assert.equal(c.failed, c.windows.reduce((sum, w) => sum + w.failed, 0), `${cellKey(c)}: failures`);
    const r = c.restarts;
    fields(r, ["restarted", "restartCount", "replaced", "eventStream", "events", "runningAtEnd", "oomKilled"], `${cellKey(c)}: restarts`);
    assert.ok(nonNegative(r.restartCount) && typeof r.replaced === "boolean" && typeof r.runningAtEnd === "boolean" && typeof r.oomKilled === "boolean" && ["unavailable", "clean", "seen"].includes(r.eventStream)
      && Array.isArray(r.events) && r.events.every((e) => e !== null && typeof e === "object" && Object.keys(e).sort().join() === "action,atSeconds" && restartActions.includes(e.action) && finite(e.atSeconds)), `${cellKey(c)}: restarts`);
    assert.ok((r.eventStream === "seen") === (r.events.length > 0), `${cellKey(c)}: the event stream's state contradicts its events`);
    assert.deepEqual(r, restartClaim({ restartCount: r.restartCount, replaced: r.replaced, eventStream: r.eventStream, events: r.events, runningAtEnd: r.runningAtEnd, oomKilled: r.oomKilled }),
      `${cellKey(c)}: the restart claim contradicts its counters, events and final state`);
    assert.ok(Number.isSafeInteger(c.rate?.droppedIterations) && Array.isArray(c.rate.intervals) && c.rate.intervals.length === s.options.windows
      && c.rate.intervals.every((i) => i !== null && typeof i === "object" && nonNegative(i.arrivals)), `${cellKey(c)}: rate`);
    // The saved arrivals per interval are the input; everything else in the claim is recomputed from them.
    assert.deepEqual(c.rate, soakArrivals({ rate: s.options.rate, seconds: s.options.windows * s.options.windowSeconds, windowSeconds: s.options.windowSeconds, requests: c.requests,
      droppedIterations: c.rate.droppedIterations, arrivals: c.rate.intervals.map((i) => i.arrivals) }), `${cellKey(c)}: the fixed-rate claim contradicts k6's counts and the schedule`);
  }
  return s;
}

const pct = (x) => `${x * 100}%`;
/** The tolerance reading in words: its bounds and what it does not detect. */
export const ruleText = `a screening reading of throughput, not a certificate of steady state. "Within the stated tolerance from the window ending at N s" means that from that window to the end of the pass, at least ${flattenRule.holdSeconds} s, every window's throughput was within ${pct(flattenRule.windowTolerance)} of the median of the last ${flattenRule.holdSeconds} s (the tail), every three-window median within ${pct(flattenRule.tolerance)} of it, that window's own throughput within ${pct(flattenRule.tolerance)} of it, and the least-squares line through those windows changed by at most ${pct(flattenRule.tolerance)} of it; and that neither the median of the first ${flattenRule.holdSeconds} s nor the median of the ${flattenRule.holdSeconds} s before the tail was more than ${pct(flattenRule.tolerance)} above the tail median (those two are comparisons between medians, not of each window). Oscillation or drift inside those bounds reads as within tolerance; a shift of under ${pct(flattenRule.windowTolerance)} in the last window can go undetected; the onset is resolved to one window and given as that window's end; readings at different window lengths are not comparable. p95 and p99 are kept as evidence and not read.`;
/**
 * A reading in words. An end-state reading says literally what was compared, never how the
 * throughput moved: "the last 60 s median is more than 5% above the 60 s before it" is a comparison
 * of two medians, and holds for a pass whose last window fell.
 */
export function verdictText(v) {
  if (v.withinTolerance) return `within the stated tolerance from the window ending at ${v.fromSeconds} s`;
  const span = `${flattenRule.holdSeconds} s`, by = pct(flattenRule.tolerance), over = (x) => x > v.tailRps * (1 + flattenRule.tolerance);
  const stretch = `the final stretch in which every window is within ${pct(flattenRule.windowTolerance)} and every three-window median within ${by} of the last ${span} median`;
  const short = `${stretch} is shorter than ${span}`;
  const noOnset = `${stretch} lasts at least ${span}, but no window in it that leaves ${span} to the end is both within ${by} of that median and the start of a least-squares line to the end that changes by at most ${by} of it`;
  const end = {
    "too-few-windows": "no reading: too few windows",
    "no-throughput": `no reading: the last ${span} median is zero`,
    "earlier-above-tail": () => {
      const earlier = [over(v.headRps) ? `the first ${span}` : null, over(v.previousRps) ? `the ${span} before the last ${span}` : null].filter(Boolean);
      assert.ok(earlier.length > 0, "an earlier-above-tail reading records the earlier median above the tail");
      return `not within tolerance at the end: the median of ${earlier.join(" and the median of ")} ${earlier.length > 1 ? "are each" : "is"} more than ${by} above the last ${span} median`;
    },
    "short-above-previous": `not within tolerance at the end: ${short}, and the last ${span} median is more than ${by} above the ${span} before it`,
    short: `not within tolerance at the end: ${short}`,
    "trend-up": `not within tolerance at the end: ${noOnset}; the least-squares line through the whole stretch goes up`,
    "trend-not-up": `not within tolerance at the end: ${noOnset}; the least-squares line through the whole stretch does not go up`,
  }[v.reason];
  assert.ok(end !== undefined, `unknown reading ${v.reason}`);
  return typeof end === "function" ? end() : end;
}
const cpuRoles = ["app", "load", "api"];
/**
 * Why a convergence pass is not like-for-like with a timed round, or [] when it is: the same
 * commit, group, image ID for every measured adapter, fixture, upstream and k6 images, CPU quota
 * and pinning for each role, host CPU model, kernel and online CPUs, startup timeout, memory limits,
 * response encoding, the timed warmup's users, the same startup before the load, and a round whose
 * page warmup rotated locales as the pass does and whose measured adapters' timed warmups had no
 * failed request. A value either side does not record cannot be matched, so it is a difference: an
 * unpinned container's CPU placement is not recorded. A split round ran on several droplets.
 * Each reason is fixed text naming the input (and, for counts, a validated number): neither side's
 * values are quoted, since the round's and the pass's are read from saved files. `apps` are the
 * adapters compared, and `pages` whether page cells are (convergenceLines passes those with a
 * reading); the locale profiles are compared only for pages.
 */
export function unlikeRound(round, apps, c, { pages = c.options.targets.includes("page") } = {}) {
  const reasons = [], o = c.options;
  const side = (value) => (value == null ? "not recorded" : "recorded");
  const same = (what, pass, timed) => {
    if (pass == null || timed == null) reasons.push(`${what} is not recorded on both sides (pass: ${side(pass)}; round: ${side(timed)})`);
    else if (pass !== timed) reasons.push(`${what} differs`);
  };
  if (round.split) reasons.push("this round was split across droplets, each its own host");
  if (c.commit !== round.commit) reasons.push("the pass measured another commit than this round");
  if ((round.options.group ?? null) !== (o.group ?? null)) reasons.push(`the pass ran ${o.group ? "a group" : "no group"} and this round ${round.options.group ? "a group" : "no group"}${o.group && round.options.group ? " (another one)" : ""}, so their images and container settings differ`);
  const images = apps.map((app) => ({ app, round: round.apps?.[app]?.imageId ?? null, pass: c.images?.[app] ?? null }));
  const unrecorded = images.filter((i) => !i.round || !i.pass).map((i) => i.app), differ = images.filter((i) => i.round && i.pass && i.round !== i.pass).map((i) => i.app);
  if (unrecorded.length) reasons.push(`image IDs are not recorded on both sides for ${unrecorded.join(", ")}`);
  if (differ.length) reasons.push(`the image IDs differ for ${differ.join(", ")}`);
  same("the fixture SHA-256", c.fixtureSha256, round.fixtureSha256);
  same("the upstream image ID", c.tools?.upstream?.imageId, round.tools?.upstream?.imageId);
  same("the k6 image ID", c.tools?.k6?.imageId, round.tools?.k6?.imageId);
  for (const role of cpuRoles) {
    same(`the ${role} CPU quota`, c.measurement?.cpus?.[role]?.quota, round.measurement?.cpus?.[role]?.quota);
    same(`the ${role} CPU pinning (cpuset)`, c.measurement?.cpus?.[role]?.cpuset, round.measurement?.cpus?.[role]?.cpuset);
  }
  same("the host CPU", c.host?.cpu, round.host?.cpu);
  // run.mjs records the host's os.release(); containers share that kernel, which the pass reads in one.
  same("the kernel release", c.host?.kernel, round.host?.release);
  same("the online CPU set", c.host?.onlineCpus, round.host?.onlineCpus);
  same("the startup timeout (s)", o.startupTimeout, round.options?.startupTimeout);
  same("the app memory limit (bytes)", c.measurement?.appMemoryBytes, round.measurement?.appMemoryBytes);
  same("the upstream memory limit (bytes)", c.measurement?.upstreamMemoryBytes, round.measurement?.upstreamMemoryBytes);
  same("the response encoding", c.measurement?.encoding, round.measurement?.encoding);
  if (o.vus !== timedWarmupVus) reasons.push(`the pass ran ${o.vus} users, the timed warmup ${timedWarmupVus}`);
  if (c.startup !== timedStartup) reasons.push("the pass started each app another way than the timed round's cold start");
  // window-load.js rotates locales on pages; a round of an earlier schema warmed one locale per profile.
  const known = typeof round.schema === "string" && readable(round.schema);
  const fixedLocales = pages && (!known || timedProfilesFor(round.schema).some((p) => p.target === "page" && p.locale !== "rotating"));
  if (fixedLocales) reasons.push(`this round's page warmup ${known ? "used one locale per profile" : "does not record its locale profiles"}, while the pass rotates locales as ${resultSchema} does`);
  // A timed warmup that itself failed requests is not the served load the pass measured.
  for (const app of apps) {
    const runs = Object.values(round.apps?.[app]?.runs ?? {}).flatMap((list) => (Array.isArray(list) ? list : []).map((run) => run?.warmup?.failed));
    const unknown = runs.filter((failed) => !nonNegative(failed)).length, failed = runs.filter((n) => nonNegative(n) && n > 0);
    if (!runs.length) reasons.push(`this round records no timed warmup for ${app}`);
    if (unknown) reasons.push(`this round does not record the failed requests of ${app}'s timed warmup in ${unknown} run${unknown === 1 ? "" : "s"}`);
    if (failed.length) reasons.push(`this round's timed warmup had ${failed.reduce((a, b) => a + b, 0)} failed requests for ${app} in ${failed.length} run${failed.length === 1 ? "" : "s"}, so it is not comparable`);
  }
  return reasons;
}
const readable = (schema) => { try { timedProfilesFor(schema); return true; } catch { return false; } };
/**
 * What the timed reporter says about a convergence pass it was given (#1851): which pass, which of
 * the round's measured adapter, source and target cells it has a reading for (stated before any
 * comparison), whether it is like-for-like with the round for those cells with every differing or
 * missing input listed, and each cell's tolerance reading. Inputs are compared only for the cells
 * with a reading: a pass covering some of them is like-for-like for those alone, and a pass with
 * none is not compared. Only a pass with a reading for every cell is like-for-like with the round
 * as a whole. It never concludes that the round's
 * warmup was long enough or too short: a timed warmup is set only by a separate reviewed change
 * from a saved like-for-like pass. report.mjs states the case with no pass itself, so a report
 * without one never loads this module.
 * @param {{commit: string, options: {warmup: number, group?: string}, host?: {cpu?: string}, measurement?: {cpus?: object}, apps?: object, split?: object}} round a validated timed summary
 * @param {string[]} apps the round's measured adapters
 * @param {object} convergence a saved convergence pass
 */
export function convergenceLines(round, apps, convergence) {
  const warmup = round.options.warmup;
  assert.ok(convergence != null, "convergenceLines reads a convergence pass");
  // The round is validated by report.mjs; its adapter names and warmup are printed, so check them here too.
  assert.ok(Array.isArray(apps) && apps.every((app) => matches("name", app)) && finite(warmup) && warmup >= 0, "convergenceLines reads a validated round's adapters and warmup");
  const c = validateConvergence(convergence), o = c.options;
  const lines = [`Convergence evidence: pass ${c.name} (${convergenceSchema}, reading ${flattenRule.name}), measured at commit \`${c.commit}\`. Host CPU: ${c.host.cpu ?? "not recorded"}. One ${o.vus}-user closed-loop pass of ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s windows from the start of the load, after ${startups[c.startup]}.`];
  const found = [], read = [], failed = [], missing = [];
  for (const app of apps) for (const source of steadySources) for (const target of steadyTargets) {
    const name = `${app} ${source} ${target}`, cell = c.cells.find((x) => x.app === app && x.source === source && x.target === target);
    if (!cell) { missing.push(name); continue; }
    found.push({ name, cell });
    (cell.failure === undefined ? read : failed).push({ name, cell });
  }
  const total = apps.length * steadySources.length * steadyTargets.length, complete = read.length === total;
  lines.push(complete ? `Coverage: the pass has a reading for every one of this round's ${total} measured adapter, source and target cells.`
    : `Coverage: the pass has a reading for ${read.length} of this round's ${total} measured adapter, source and target cells${read.length ? ` (${read.map((r) => r.name).join(", ")})` : ""}${failed.length ? `; no reading, the cell failed: ${failed.map((f) => f.name).join(", ")}` : ""}${missing.length ? `; no convergence pass for: ${missing.join(", ")}` : ""}.`);
  if (!read.length) lines.push("No cell of this round has a reading in the pass, so the pass is not compared with this round on any input.");
  else {
    // Inputs are compared for the cells with a reading only, and the statement says which.
    const pages = read.some((r) => r.cell.target === "page");
    const reasons = unlikeRound(round, apps.filter((app) => read.some((r) => r.cell.app === app)), c, { pages });
    const scope = complete ? "with this round" : `with this round for its ${read.length} cell${read.length === 1 ? "" : "s"} with a reading`;
    const inputs = `commit, group, adapter images, fixture, upstream and k6 images, CPU quota and pinning for each role, host CPU, kernel, online CPUs, startup timeout, memory limits, response encoding, the timed warmup's ${timedWarmupVus} users, the cold start before the load, ${pages ? "rotating page locales and " : ""}a timed warmup with no failed request`;
    lines.push(reasons.length ? `The pass is not like-for-like ${scope}. Differing or missing inputs: ${reasons.join("; ")}.`
      : complete ? `The pass is like-for-like ${scope} on every input compared: ${inputs}.`
        : `The pass is like-for-like ${scope} only, on every input compared for them: ${inputs}. It says nothing about this round's other cells.`);
  }
  lines.push(`Tolerance reading ${flattenRule.name}: ${ruleText}`);
  for (const { name, cell } of found) lines.push(`Reading: ${name}: ${cell.failure !== undefined ? `no reading, the cell failed (${failureCodes[cell.failure]})` : verdictText(cell.verdict)}.`);
  lines.push(`This report does not establish whether this round's ${warmup}s timed warmup was sufficient: the pass is a screening reading of throughput, and a timed warmup is set only by a separate reviewed change from a saved like-for-like pass.`);
  return lines;
}
