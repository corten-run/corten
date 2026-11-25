// Convergence and soak passes for marketplace v2 (#1851): option bounds, the per-window k6
// reader, the tolerance reading, the soak summary, validation of saved results and what the timed
// reporter says about them. Pure: no Docker, k6, files or clock. steady.mjs runs the passes;
// steady-report.mjs and report.mjs read what they saved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resultSchema, timedProfilesFor } from "./run-contract.mjs";

// v2: a cell's reading is withinTolerance/fromSeconds (the onset window's end), cells keep k6's
// request and iteration totals, a soak keeps its memory clock and instance, and a pass keeps its
// cleanup record.
export const convergenceSchema = "marketplace-convergence/v2";
export const soakSchema = "marketplace-soak/v2";
// The targets and sources of the timed profiles: a page in rotating locales and locale-neutral JSON,
// from memory and from the HTTP upstream.
export const steadyTargets = Object.freeze(["page", "json"]);
export const steadySources = Object.freeze(["fixture", "api"]);
// The users the timed warmup phase runs (run.mjs load(): VUS 32 for warmup).
export const timedWarmupVus = 32;
// How a pass starts each app, as run.mjs coldStart starts it before a timed warmup: the app is
// created, a sidecar polls the target's own path (the JSON item, or the first locale's page) from
// docker start until its first 200, and the load follows. A pass with another startup is not
// like-for-like with a timed round (unlikeRound).
export const timedStartup = "marketplace cold start/v1: created app, sidecar polls the target's path from docker start to its first 200, then the load";
/**
 * The tolerance reading: a screening reading of a pass's throughput, not a certificate of steady
 * state. It says whether the end of a pass stayed within stated bounds, and from which window; no
 * report concludes from it that a timed warmup is long enough. Its spans are in seconds:
 * h = holdSeconds / window length windows, and the window length must divide holdSeconds. For a
 * pass of n windows of throughput r[0..n-1] (requests completed in the window over its length):
 * 1. Fewer than 2h windows, or fewer than smoothing: no reading (too-few-windows).
 * 2. tail = median of the last holdSeconds, previous = median of the holdSeconds before them,
 *    head = median of the first holdSeconds. tail = 0: no reading (no-throughput).
 * 3. previous or head > tail * (1 + tolerance): not within tolerance at the end, lower at the end
 *    (slower-at-end), whatever the last windows do.
 * 4. smoothed[j] is the median of three consecutive windows centered on j, clamped to the pass.
 * 5. The run is the longest suffix in which every window lies within tail * (1 +/- windowTolerance)
 *    and every smoothed value within tail * (1 +/- tolerance).
 * 6. The onset is the first window s of that run whose own throughput is within
 *    tail * (1 +/- tolerance), that leaves at least holdSeconds after its start, and from which
 *    the least-squares line through windows s..n-1 changes by at most tolerance * tail. The reading
 *    is "within the stated tolerance from the window ending at (s + 1) * window length s": the
 *    onset is reported at the window's end, so it is never less than one window.
 * 7. Otherwise not within tolerance at the end: higher at the end (still-rising: a run shorter than
 *    holdSeconds with tail > previous * (1 + tolerance), or a longer run whose line rises), lower
 *    at the end (slower-at-end: a longer run whose line falls), or within it for less than
 *    holdSeconds (short-steady).
 * The bounds, then: every window within 10% of the tail median, every three-window median within
 * 5%, and a least-squares change of at most 5% from the onset to the end. What that does not
 * detect, by construction (steady.test.mjs pins each case):
 * - Oscillation or drift inside the bounds reads as within tolerance. 920, 1000, 1080, 1000
 *   repeated five times in 15 s windows reads within tolerance from the window ending at 30 s:
 *   every window is within 8% of the tail and every three-window median is the tail; only the
 *   first window (920, 8% under) is too far off to be the onset. A steady climb from 1000 to 1076
 *   over 20 windows reads within tolerance from the window ending at 105 s, once the climb left
 *   after it is under 5% of the tail.
 * - A shift in the last window under 10% is not detected: nineteen windows at 1000 then one at
 *   1090 reads within tolerance from the window ending at 15 s, since the tail median is still 1000.
 * - A pass that started faster reads as lower at the end even if it then held: four windows at
 *   1100 then sixteen at 1000 is not within tolerance, since its first 60 s ran 10% above the tail.
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
 * @returns {{ windows: {index: number, startSeconds: number, seconds: number, requests: number, failed: number, rps: number, p95: number | null, p99: number | null}[], tail: number, unrecorded: number, requests: number, iterations: number }}
 */
export function readWindows(summary, { windows, windowSeconds }) {
  integer(windows, 1, maxWindows, "windows"); integer(windowSeconds, 1, 3600, "windowSeconds");
  const names = Object.keys(summary?.metrics ?? {});
  for (const name of names.filter((n) => n.startsWith("window_") && n !== "window_tail_requests")) {
    const m = /^window_(0|[1-9]\d*)_(requests|failed|duration)$/.exec(name);
    assert.ok(m && Number(m[1]) < windows, `unexpected k6 window metric ${name}`);
  }
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
  return { windows: rows, tail, unrecorded, requests: total, iterations };
}

/**
 * A convergence cell's app must be the same running instance through the whole pass: the same
 * container ID and StartedAt, still running, not OOM-killed and not restarted. Otherwise its
 * throughput says nothing about warming and the cell gets no reading. Takes Docker inspect output
 * from before and after the load.
 */
export function heldThrough(before, after) {
  const state = (i) => ({ id: i.Id, startedAt: i.State.StartedAt, restartCount: i.RestartCount, running: i.State.Running, oomKilled: i.State.OOMKilled, exitCode: i.State.ExitCode });
  assert.ok(typeof before.Id === "string" && typeof before.State?.StartedAt === "string", "the app's instance before the load is not recorded");
  assert.ok(after.Id === before.Id && after.State.StartedAt === before.State.StartedAt && after.State.Running === true && after.State.OOMKilled === false && after.RestartCount === before.RestartCount,
    `app container stopped, restarted, was replaced or was OOM-killed during the pass: before ${JSON.stringify(state(before))}, after ${JSON.stringify(state(after))}`);
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
  if (previous > tail * (1 + t) || head > tail * (1 + t)) return { withinTolerance: false, reason: "slower-at-end", ...evidence };
  const within = (r, band) => r >= tail * (1 - band) && r <= tail * (1 + band);
  const smoothed = rps.map((_, j) => { const c = Math.min(Math.max(j, 1), n - 2); return median(rps.slice(c - 1, c + 2)); });
  let run = n;
  while (run > 0 && within(rps[run - 1], w) && within(smoothed[run - 1], t)) run--;
  for (let s = run; s <= n - h; s++) {
    if (within(rps[s], t) && Math.abs(fittedChange(rps.slice(s))) <= t * tail) return { withinTolerance: true, window: s, fromSeconds: windows[s].startSeconds + size, ...evidence };
  }
  if (n - run < h) return { withinTolerance: false, reason: tail > previous * (1 + t) ? "still-rising" : "short-steady", ...evidence };
  return { withinTolerance: false, reason: fittedChange(rps.slice(run)) > 0 ? "still-rising" : "slower-at-end", ...evidence };
}

const cellKey = (c) => `${c.app} ${c.source} ${c.target}`;
function windowsEvidence(windows, n, seconds) {
  assert.ok(Array.isArray(windows) && windows.length === n, "a pass keeps every window");
  windows.forEach((w, index) => {
    assert.deepEqual(Object.keys(w).sort(), ["failed", "index", "p95", "p99", "requests", "rps", "seconds", "startSeconds"], `window ${index}: fields`);
    assert.equal(w.index, index); assert.equal(w.seconds, seconds); assert.equal(w.startSeconds, index * seconds);
    assert.ok(Number.isSafeInteger(w.requests) && w.requests >= 0 && Number.isSafeInteger(w.failed) && w.failed >= 0 && w.failed <= w.requests, `window ${index}: counts`);
    assert.equal(w.rps, w.requests / seconds, `window ${index}: throughput contradicts its count`);
    if (w.requests) assert.ok(Number.isFinite(w.p95) && w.p95 >= 0 && w.p95 <= w.p99 && Number.isFinite(w.p99), `window ${index}: latency`);
    else assert.deepEqual([w.p95, w.p99], [null, null], `window ${index}: latency without requests`);
  });
}
// A cell's windows, graceful-stop tail and unrecorded requests must add up to k6's own request total.
function reconciles(c) {
  assert.ok(Number.isSafeInteger(c.requests) && Number.isSafeInteger(c.iterations) && c.iterations >= 0 && c.iterations <= c.requests, `${cellKey(c)}: k6 request and iteration totals`);
  assert.ok(Number.isSafeInteger(c.tail) && c.tail >= 0 && Number.isSafeInteger(c.unrecorded) && c.unrecorded >= 0, `${cellKey(c)}: tail and unrecorded requests`);
  assert.equal(c.windows.reduce((sum, w) => sum + w.requests, 0) + c.tail + c.unrecorded, c.requests, `${cellKey(c)}: windows, tail and unrecorded requests do not add up to k6's request total`);
  assert.ok(c.unrecorded <= c.requests - c.iterations, `${cellKey(c)}: more unrecorded requests than unfinished iterations`);
}
function passEvidence(s, schema) {
  assert.equal(s?.schema, schema, `not a ${schema} result`);
  assert.match(s.name ?? "", /^[a-z0-9][a-z0-9-]{0,40}$/);
  assert.match(s.commit ?? "", /^[a-f0-9]{40}$/, "a pass records its measured commit");
  assert.equal(s.finishedCommit, s.commit, "a pass finishes at the commit it started at");
  assert.equal(s.dirty, false, "a pass measures a clean checkout");
  assert.equal(s.complete, true, "an incomplete pass is not evidence");
  assert.deepEqual(s.failures, [], "a pass with a suite failure is not evidence");
  // Cleanup must be confirmed: no failure, nothing left with the owner label, and every create
  // Docker did not acknowledge found and removed (cleanup.json keeps the whole record).
  assert.deepEqual(s.cleanupFailures, [], "a pass whose cleanup failed is not evidence");
  const k = s.cleanup;
  assert.ok(k?.complete === true && Array.isArray(k.remaining?.containers) && Array.isArray(k.remaining?.networks) && k.remaining.containers.length === 0 && k.remaining.networks.length === 0
    && Array.isArray(k.unacknowledged) && k.unacknowledged.every((a) => a?.outcome === "removed"), "a pass whose cleanup is not confirmed complete is not evidence");
  assert.ok(typeof s.host?.cpu === "string" && s.host.cpu.length > 0, "a pass records its host CPU");
  assert.ok(Number.isFinite(Date.parse(s.startedAt)) && Date.parse(s.finishedAt) > Date.parse(s.startedAt), "a pass records its window");
  const o = s.options;
  assert.equal(o.kind, schema === convergenceSchema ? "convergence" : "soak"); assert.equal(o.name, s.name);
  for (const key of ["apps", "sources", "targets"]) assert.ok(Array.isArray(o[key]) && o[key].length > 0, `a pass names at least one of its ${key}`);
  assert.equal(o.windows * o.windowSeconds, o.minutes * 60, "windows contradict the pass length");
  assert.ok(Array.isArray(s.cells) && s.cells.length === o.apps.length * o.sources.length * o.targets.length, "a pass has one cell per adapter, source and target");
  const expected = o.sources.flatMap((source) => o.apps.flatMap((app) => o.targets.map((target) => `${app} ${source} ${target}`)));
  assert.deepEqual(s.cells.map(cellKey), expected, "cells are not the pass's adapters, sources and targets in order");
}
/** Validates a saved convergence pass and recomputes every verdict. Returns it. */
export function validateConvergence(s) {
  passEvidence(s, convergenceSchema);
  assert.deepEqual(s.rule, flattenRule, "a convergence pass applies the stated tolerance reading");
  assert.ok(Number.isSafeInteger(s.options.vus) && s.options.vus > 0);
  // What makes a pass comparable with a timed round (unlikeRound): its image IDs and CPU settings.
  assert.deepEqual(Object.keys(s.images ?? {}).sort(), [...s.options.apps].sort(), "a pass records the image ID of every adapter it ran");
  for (const id of Object.values(s.images)) assert.match(id, /^sha256:[a-f0-9]{64}$/, "image IDs are Docker sha256 IDs");
  assert.ok(cpuRoles.every((role) => Number.isFinite(s.measurement?.cpus?.[role]?.quota)), "a pass records its CPU settings");
  // And the other inputs a timed round records: fixture, upstream and k6 images, kernel, online CPUs, startup.
  assert.match(s.fixtureSha256 ?? "", /^[a-f0-9]{64}$/, "a pass records its fixture hash");
  for (const tool of ["upstream", "k6"]) assert.match(s.tools?.[tool]?.imageId ?? "", /^sha256:[a-f0-9]{64}$/, `a pass records its ${tool} image ID`);
  for (const key of ["kernel", "onlineCpus"]) assert.ok(typeof s.host[key] === "string" && s.host[key].length > 0, `a pass records its host ${key}`);
  assert.ok(typeof s.startup === "string" && s.startup.length > 0, "a pass records how it started each app");
  for (const c of s.cells) {
    if (c.failure !== undefined) {
      assert.ok(typeof c.failure === "string" && c.failure.length > 0 && c.windows === undefined && c.verdict === null, `${cellKey(c)}: a failed cell keeps its reason and no verdict`);
      continue;
    }
    windowsEvidence(c.windows, s.options.windows, s.options.windowSeconds);
    // A failed answer can be faster than a served one: a cell with any failure, in a window or in
    // k6's aggregate (which also counts the graceful stop), has no verdict, so none is saved.
    assert.ok(c.windows.every((x) => x.failed === 0), `${cellKey(c)}: a cell with failed requests in its windows has no verdict`);
    assert.equal(c.failedRequests, 0, `${cellKey(c)}: a cell with failed requests in k6's aggregate has no verdict`);
    reconciles(c);
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
 * A soak cell from its intervals, its app's memory samples and what Docker said about the container
 * before and after: memory at the start and end is the median of the samples taken in the first and
 * the last memory interval (soakMemoryClock); p99 is kept per interval; a restart is any
 * RestartCount increase, another container ID or StartedAt at the end (a `docker restart` keeps
 * RestartCount), any start, restart, die, kill or OOM event during the soak, or a container not
 * running or OOM-killed at the end.
 */
export function summarizeSoak({ windows, tail, unrecorded, requests, iterations, memory, before, after, events, rate, droppedIterations, failedRequests }) {
  assert.ok(Number.isSafeInteger(rate) && rate > 0 && Number.isSafeInteger(droppedIterations) && droppedIterations >= 0, "a soak records its requested rate and k6's dropped iterations");
  // k6's aggregate failures, which also count answers that completed during the graceful stop.
  assert.ok(Number.isSafeInteger(failedRequests) && failedRequests >= windows.reduce((sum, w) => sum + w.failed, 0), "a soak records k6's aggregate failed requests, at least those in its intervals");
  assert.ok(Array.isArray(windows) && windows.length >= 2, "a soak has at least two intervals");
  const seconds = windows[0].seconds, end = windows.length * seconds;
  assert.ok(Array.isArray(memory) && memory.every((m) => Number.isFinite(m.atSeconds) && Number.isFinite(m.mib) && m.mib > 0), "memory samples need a time and a positive size");
  const at = (from, to) => memory.filter((m) => m.atSeconds >= from && m.atSeconds < to).map((m) => m.mib);
  const first = at(0, seconds), last = at(end - seconds, end);
  assert.ok(first.length && last.length, "a soak needs memory samples in its first and last interval");
  const startMiB = median(first), endMiB = median(last);
  for (const c of [before, after]) assert.ok(typeof c?.id === "string" && typeof c.startedAt === "string" && Number.isSafeInteger(c.restartCount) && c.restartCount >= 0 && typeof c.running === "boolean" && typeof c.oomKilled === "boolean", "container state needs id, startedAt, restartCount, running and oomKilled");
  assert.ok(after.restartCount >= before.restartCount, "RestartCount moved backwards");
  const restartEvents = events.filter((e) => ["start", "restart", "die", "oom", "kill"].includes(e.action)).map((e) => ({ action: e.action, atSeconds: e.atSeconds }));
  const replaced = after.id !== before.id || after.startedAt !== before.startedAt;
  const restarted = after.restartCount > before.restartCount || replaced || restartEvents.length > 0 || !after.running || after.oomKilled;
  const p99 = windows.filter((w) => w.p99 !== null).map((w) => w.p99);
  // k6 drops an iteration it could not start on time (no free user): then the load was not the fixed rate asked for.
  return { windows, tail, unrecorded, requests, iterations, rate: { requested: rate, droppedIterations, met: droppedIterations === 0 }, memory: { samples: memory.length, startMiB, endMiB, growthMiB: endMiB - startMiB, growthPct: (endMiB - startMiB) / startMiB * 100 },
    p99: { first: windows[0].p99, last: windows.at(-1).p99, max: p99.length ? Math.max(...p99) : null },
    failed: windows.reduce((sum, w) => sum + w.failed, 0), failedRequests,
    restarts: { restarted, restartCount: after.restartCount - before.restartCount, replaced, events: restartEvents, runningAtEnd: after.running, oomKilled: after.oomKilled } };
}
/** Validates a saved soak, including that its p99, memory and restart claims agree with its own counters. Returns it. */
export function validateSoak(s) {
  passEvidence(s, soakSchema);
  assert.ok(Number.isSafeInteger(s.options.rate) && s.options.rate > 0);
  assert.equal(s.measurement?.memoryClock, soakMemoryClock, "a soak states the clock of its memory samples");
  for (const c of s.cells) {
    if (c.failure !== undefined) { assert.ok(typeof c.failure === "string" && c.failure.length > 0 && c.windows === undefined, `${cellKey(c)}: a failed cell keeps its reason`); continue; }
    windowsEvidence(c.windows, s.options.windows, s.options.windowSeconds);
    reconciles(c);
    const m = c.memory;
    assert.ok(Number.isSafeInteger(m?.samples) && m.samples > 1 && m.startMiB > 0 && m.endMiB > 0 && m.growthMiB === m.endMiB - m.startMiB && m.growthPct === m.growthMiB / m.startMiB * 100, `${cellKey(c)}: memory`);
    const p99 = c.windows.filter((w) => w.p99 !== null).map((w) => w.p99);
    assert.deepEqual(c.p99, { first: c.windows[0].p99, last: c.windows.at(-1).p99, max: p99.length ? Math.max(...p99) : null }, `${cellKey(c)}: p99 contradicts its intervals`);
    assert.equal(c.failed, c.windows.reduce((sum, w) => sum + w.failed, 0), `${cellKey(c)}: failures`);
    assert.ok(Number.isSafeInteger(c.failedRequests) && c.failedRequests >= c.failed, `${cellKey(c)}: aggregate failures`);
    const r = c.restarts;
    assert.ok(Number.isSafeInteger(r?.restartCount) && r.restartCount >= 0 && typeof r.replaced === "boolean" && typeof r.runningAtEnd === "boolean" && typeof r.oomKilled === "boolean"
      && Array.isArray(r.events) && r.events.every((e) => ["start", "restart", "die", "oom", "kill"].includes(e?.action) && Number.isFinite(e.atSeconds)), `${cellKey(c)}: restarts`);
    assert.equal(r.restarted, r.restartCount > 0 || r.replaced || r.events.length > 0 || !r.runningAtEnd || r.oomKilled, `${cellKey(c)}: the restart claim contradicts its counters, events and final state`);
    assert.ok(c.rate?.requested === s.options.rate && Number.isSafeInteger(c.rate.droppedIterations) && c.rate.droppedIterations >= 0 && c.rate.met === (c.rate.droppedIterations === 0), `${cellKey(c)}: rate`);
  }
  return s;
}

const pct = (x) => `${x * 100}%`;
/** The tolerance reading in words: its bounds and what it does not detect. */
export const ruleText = `a screening reading of throughput, not a certificate of steady state. "Within the stated tolerance from the window ending at N s" means that from that window to the end of the pass, at least ${flattenRule.holdSeconds} s, every window's throughput was within ${pct(flattenRule.windowTolerance)} of the median of the last ${flattenRule.holdSeconds} s (the tail), every three-window median within ${pct(flattenRule.tolerance)}, and the least-squares line through those windows changed by at most ${pct(flattenRule.tolerance)} of the tail, and that neither the first nor the second-to-last ${flattenRule.holdSeconds} s ran more than ${pct(flattenRule.tolerance)} above the tail. Oscillation or drift inside those bounds reads as within tolerance; a shift of under ${pct(flattenRule.windowTolerance)} in the last window is not detected; the onset is resolved to one window and given as that window's end; readings at different window lengths are not comparable. p95 and p99 are kept as evidence and not read.`;
/** A reading in words. */
export const verdictText = (v) => v.withinTolerance ? `within the stated tolerance from the window ending at ${v.fromSeconds} s`
  : { "too-few-windows": "no reading: too few windows", "no-throughput": "no reading: nothing served at the end", "still-rising": "not within tolerance at the end: higher at the end",
    "slower-at-end": "not within tolerance at the end: lower at the end", "short-steady": `not within tolerance at the end: within it for less than ${flattenRule.holdSeconds} s` }[v.reason];
const cpuRoles = ["app", "load", "api"];
/**
 * Why a convergence pass is not like-for-like with a timed round, or [] when it is: the same
 * commit, group, image ID for every measured adapter, fixture, upstream and k6 images, CPU quota
 * and pinning for each role, host CPU model, kernel and online CPUs, startup timeout, memory limits,
 * response encoding, the timed warmup's users, the same startup before the load, and a round whose
 * page warmup rotated locales as the pass does and whose measured adapters' timed warmups had no
 * failed request. A value either side does not record cannot be matched, so it is a difference: an
 * unpinned container's CPU placement is not recorded. A split round ran on several droplets.
 */
export function unlikeRound(round, apps, c) {
  const reasons = [], o = c.options;
  const same = (what, pass, timed) => {
    if (pass == null || timed == null) reasons.push(`${what} is not recorded on both sides (pass: ${pass ?? "not recorded"}; round: ${timed ?? "not recorded"})`);
    else if (pass !== timed) reasons.push(`${what} differs (pass: ${pass}; round: ${timed})`);
  };
  if (round.split) reasons.push("this round was split across droplets, each its own host");
  if (c.commit !== round.commit) reasons.push(`the pass measured commit \`${c.commit}\`, this round \`${round.commit}\``);
  if ((round.options.group ?? null) !== (o.group ?? null)) reasons.push(`the pass ran ${o.group ? `group ${o.group}` : "no group"}, this round ${round.options.group ? `group ${round.options.group}` : "no group"}, so their images and container settings differ`);
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
  if (c.startup !== timedStartup) reasons.push(`the pass started each app another way than the timed round's cold start (${c.startup ?? "not recorded"})`);
  // window-load.js rotates locales on pages; a round of an earlier schema warmed one locale per profile.
  const fixedLocales = o.targets.includes("page") && (!round.schema || timedProfilesFor(round.schema).some((p) => p.target === "page" && p.locale !== "rotating"));
  if (fixedLocales) reasons.push(`this round's page warmup ${round.schema ? `(${round.schema}) used one locale per profile` : "does not record its locale profiles"}, while the pass rotates locales as ${resultSchema} does`);
  // A timed warmup that itself failed requests is not the served load the pass measured.
  for (const app of apps) {
    const runs = Object.entries(round.apps?.[app]?.runs ?? {}).flatMap(([profile, list]) => (Array.isArray(list) ? list : []).map((run) => ({ profile, failed: run?.warmup?.failed })));
    const unknown = runs.filter((run) => !Number.isSafeInteger(run.failed) || run.failed < 0), failed = runs.filter((run) => Number.isSafeInteger(run.failed) && run.failed > 0);
    if (!runs.length) reasons.push(`this round records no timed warmup for ${app}`);
    if (unknown.length) reasons.push(`this round does not record the failed requests of ${app}'s timed warmup (${[...new Set(unknown.map((run) => run.profile))].join(", ")})`);
    if (failed.length) reasons.push(`this round's timed warmup had failed requests for ${app} (${failed.map((run) => `${run.profile}: ${run.failed}`).join(", ")}), so it is not comparable`);
  }
  return reasons;
}
/**
 * What the timed reporter says about a convergence pass it was given (#1851): which pass, whether
 * it is like-for-like with the round with every differing or missing input listed, and each
 * measured adapter's tolerance reading per source and target. It never concludes that the round's
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
  const c = validateConvergence(convergence), o = c.options;
  const lines = [`Convergence evidence: pass ${c.name} (${convergenceSchema}, reading ${flattenRule.name}), measured at commit \`${c.commit}\`. Host CPU: ${c.host.cpu}. One ${o.vus}-user closed-loop pass of ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s windows from the start of the load, after ${c.startup === timedStartup ? "the timed round's cold start" : `another startup (${c.startup})`}.`];
  const reasons = unlikeRound(round, apps, c);
  lines.push(reasons.length ? `The pass is not like-for-like with this round. Differing or missing inputs: ${reasons.join("; ")}.`
    : `The pass is like-for-like with this round on every input compared: commit, group, adapter images, fixture, upstream and k6 images, CPU quota and pinning for each role, host CPU, kernel, online CPUs, startup timeout, memory limits, response encoding, the timed warmup's ${timedWarmupVus} users, the cold start before the load, rotating page locales and a timed warmup with no failed request.`);
  lines.push(`Tolerance reading ${flattenRule.name}: ${ruleText}`);
  const found = [], missing = [];
  for (const app of apps) for (const source of steadySources) for (const target of steadyTargets) {
    const cell = c.cells.find((x) => x.app === app && x.source === source && x.target === target);
    if (!cell) missing.push(`${app} ${source} ${target}`);
    else found.push({ name: `${app} ${source} ${target}`, cell });
  }
  for (const { name, cell } of found) lines.push(`Reading: ${name}: ${cell.failure !== undefined ? `no reading, the cell failed (${cell.failure.split("\n")[0]})` : verdictText(cell.verdict)}.`);
  if (missing.length) lines.push(`No convergence pass for: ${missing.join(", ")}.`);
  lines.push(`This report does not judge whether this round's ${warmup}s warmup was long enough: a timed warmup is set only by a separate reviewed change from a saved like-for-like pass.`);
  return lines;
}
