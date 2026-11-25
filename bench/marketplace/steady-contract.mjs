// Convergence and soak passes for marketplace v2 (#1851): option bounds, the per-window k6
// reader, the flatten rule, the soak summary, validation of saved results and what the timed
// reporter says about them. Pure: no Docker, k6, files or clock. steady.mjs runs the passes;
// steady-report.mjs and report.mjs read what they saved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const convergenceSchema = "marketplace-convergence/v1";
export const soakSchema = "marketplace-soak/v1";
// The targets and sources of the timed profiles: a page in rotating locales and locale-neutral JSON,
// from memory and from the HTTP upstream.
export const steadyTargets = Object.freeze(["page", "json"]);
export const steadySources = Object.freeze(["fixture", "api"]);
// The users the timed warmup phase runs (run.mjs load(): VUS 32 for warmup).
export const timedWarmupVus = 32;
/**
 * The flatten rule. Its spans are in seconds, so the window length (--window) does not change it:
 * h = holdSeconds / window length windows, and the window length must divide holdSeconds. A pass of
 * n windows of throughput r[0..n-1] (requests completed in the window divided by its length):
 * 1. Fewer than 2h windows, or fewer than smoothing: never flattened (too-few-windows).
 * 2. tail = median of the last holdSeconds, previous = median of the holdSeconds before them,
 *    head = median of the first holdSeconds. tail = 0: nothing was served (no-throughput).
 * 3. tail > previous * (1 + tolerance): not shown steady at the end (still-rising).
 *    previous or head > tail * (1 + tolerance): not shown steady, slower at the end
 *    (slower-at-end). A pass that got slower is never flattened, whatever its last windows do.
 * 4. Each window's smoothed value is the median of three consecutive windows centered on it,
 *    clamped to the pass (the first window uses 0-2, the last n-3..n-1).
 * 5. The steady run is the longest suffix whose smoothed values all lie within
 *    tail * (1 +/- tolerance); the flatten window is its first window whose own throughput does
 *    too. Less than holdSeconds from there to the end: never flattened (short-steady).
 * The adapter stopped changing at the start of the flatten window. p95 and p99 are kept per window
 * as evidence; the rule reads throughput only, since in a closed loop with a fixed number of users
 * throughput and mean latency move together.
 * Why these numbers: 5% is a stated choice, not derived from measured noise. It is wide enough that
 * a window's sampling noise is not read as change, and narrow enough that a runtime still moving by
 * more than a twentieth is not called steady; revisit it once saved passes show the window-to-window
 * spread on the measurement host. The median of three lets one outlier window (a pause, a noisy
 * neighbour) neither start nor end the steady run, while two consecutive outliers still count; a
 * wider median would blur when the change happened. 60 s of steady throughput is the evidence the
 * rule asks for before it names a window, and the same 60 s span is compared with the 60 s before
 * and the first 60 s.
 */
export const flattenRule = Object.freeze({ name: "marketplace-flatten/v2", tolerance: 0.05, holdSeconds: 60, smoothing: 3 });
const minConvergenceWindows = 8;
// The default pass runs the timed warmup's users, so it is like-for-like with a timed round's
// warmup (convergenceLines). --vus changes it for exploration; such a pass does not establish a
// round's warmup.
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
  if (kind === "convergence") assert.equal(flattenRule.holdSeconds % options.windowSeconds, 0, `--window must divide the flatten rule's ${flattenRule.holdSeconds} s span (5, 6, 10, 12, 15, 20, 30 or 60)`);
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
 * iterations).
 * @returns {{ windows: {index: number, startSeconds: number, seconds: number, requests: number, failed: number, rps: number, p95: number | null, p99: number | null}[], tail: number, unrecorded: number }}
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
  return { windows: rows, tail, unrecorded };
}

/**
 * A convergence cell's app container must have run through the whole pass: still running, not
 * OOM-killed and not restarted. Otherwise its throughput says nothing about warming and the cell gets
 * no verdict. Takes Docker inspect output from before and after the load.
 */
export function heldThrough(before, after) {
  const state = (i) => ({ restartCount: i.RestartCount, running: i.State.Running, oomKilled: i.State.OOMKilled, exitCode: i.State.ExitCode });
  assert.ok(after.State.Running === true && after.State.OOMKilled === false && after.RestartCount === before.RestartCount,
    `app container stopped, restarted or was OOM-killed during the pass: ${JSON.stringify(state(after))}`);
}
/** The iterations k6 dropped because it could not start them on time (constant-arrival-rate), 0 when none. */
export function readDropped(summary) { return count(summary, "dropped_iterations"); }
const median = (values) => {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/**
 * The window each pass stopped getting faster in, by flattenRule (above).
 * @param {{rps: number, startSeconds: number}[]} windows in order
 */
export function flattenPoint(windows, rule = flattenRule) {
  assert.deepEqual(rule, flattenRule, "only the stated flatten rule is applied");
  const { tolerance: t, holdSeconds, smoothing } = rule, n = windows.length, rps = windows.map((w) => w.rps);
  assert.ok(rps.every((r) => Number.isFinite(r) && r >= 0), "window throughput must be finite and not negative");
  const size = windows[0]?.seconds;
  assert.ok(n === 0 || (Number.isSafeInteger(size) && size > 0 && holdSeconds % size === 0 && windows.every((w) => w.seconds === size)), `windows must share one length that divides ${holdSeconds} s`);
  const h = n ? holdSeconds / size : 1;
  if (n < 2 * h || n < smoothing) return { flattened: false, reason: "too-few-windows" };
  const tail = median(rps.slice(n - h)), previous = median(rps.slice(n - 2 * h, n - h)), head = median(rps.slice(0, h));
  if (tail === 0) return { flattened: false, reason: "no-throughput", tailRps: 0 };
  const evidence = { tailRps: tail, previousRps: previous, headRps: head };
  if (tail > previous * (1 + t)) return { flattened: false, reason: "still-rising", ...evidence };
  if (previous > tail * (1 + t) || head > tail * (1 + t)) return { flattened: false, reason: "slower-at-end", ...evidence };
  const within = (r) => r >= tail * (1 - t) && r <= tail * (1 + t);
  const smoothed = rps.map((_, j) => { const c = Math.min(Math.max(j, 1), n - 2); return median(rps.slice(c - 1, c + 2)); });
  let start = n;
  while (start > 0 && within(smoothed[start - 1])) start--;
  while (start < n && !within(rps[start])) start++;
  if (n - start < h) return { flattened: false, reason: "short-steady", ...evidence };
  return { flattened: true, window: start, atSeconds: windows[start].startSeconds, ...evidence };
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
function passEvidence(s, schema) {
  assert.equal(s?.schema, schema, `not a ${schema} result`);
  assert.match(s.name ?? "", /^[a-z0-9][a-z0-9-]{0,40}$/);
  assert.match(s.commit ?? "", /^[a-f0-9]{40}$/, "a pass records its measured commit");
  assert.equal(s.dirty, false, "a pass measures a clean checkout");
  assert.equal(s.complete, true, "an incomplete pass is not evidence");
  assert.ok(typeof s.host?.cpu === "string" && s.host.cpu.length > 0, "a pass records its host CPU");
  assert.ok(Number.isFinite(Date.parse(s.startedAt)) && Date.parse(s.finishedAt) > Date.parse(s.startedAt), "a pass records its window");
  const o = s.options;
  assert.equal(o.kind, schema === convergenceSchema ? "convergence" : "soak"); assert.equal(o.name, s.name);
  assert.equal(o.windows * o.windowSeconds, o.minutes * 60, "windows contradict the pass length");
  assert.ok(Array.isArray(s.cells) && s.cells.length === o.apps.length * o.sources.length * o.targets.length, "a pass has one cell per adapter, source and target");
  const expected = o.sources.flatMap((source) => o.apps.flatMap((app) => o.targets.map((target) => `${app} ${source} ${target}`)));
  assert.deepEqual(s.cells.map(cellKey), expected, "cells are not the pass's adapters, sources and targets in order");
}
/** Validates a saved convergence pass and recomputes every verdict. Returns it. */
export function validateConvergence(s) {
  passEvidence(s, convergenceSchema);
  assert.deepEqual(s.rule, flattenRule, "a convergence pass applies the stated flatten rule");
  assert.ok(Number.isSafeInteger(s.options.vus) && s.options.vus > 0);
  // What makes a pass comparable with a timed round (unlikeRound): its image IDs and CPU settings.
  assert.deepEqual(Object.keys(s.images ?? {}).sort(), [...s.options.apps].sort(), "a pass records the image ID of every adapter it ran");
  for (const id of Object.values(s.images)) assert.match(id, /^sha256:[a-f0-9]{64}$/, "image IDs are Docker sha256 IDs");
  assert.ok(cpuRoles.every((role) => Number.isFinite(s.measurement?.cpus?.[role]?.quota)), "a pass records its CPU settings");
  for (const c of s.cells) {
    if (c.failure !== undefined) {
      assert.ok(typeof c.failure === "string" && c.failure.length > 0 && c.windows === undefined && c.verdict === null, `${cellKey(c)}: a failed cell keeps its reason and no verdict`);
      continue;
    }
    windowsEvidence(c.windows, s.options.windows, s.options.windowSeconds);
    assert.ok(Number.isSafeInteger(c.tail) && c.tail >= 0 && Number.isSafeInteger(c.unrecorded) && c.unrecorded >= 0, `${cellKey(c)}: tail and unrecorded requests`);
    assert.deepEqual(c.verdict, flattenPoint(c.windows), `${cellKey(c)}: saved verdict differs from the flatten rule`);
  }
  return s;
}
/**
 * A soak cell from its intervals, its app's memory samples and what Docker said about the container
 * before and after: memory at the start and end is the median of the samples taken in the first and
 * the last interval; p99 is kept per interval; a restart is any RestartCount increase, any start,
 * restart, die or OOM event during the soak, or a container not running at the end.
 */
export function summarizeSoak({ windows, tail, unrecorded, memory, before, after, events, rate, droppedIterations }) {
  assert.ok(Number.isSafeInteger(rate) && rate > 0 && Number.isSafeInteger(droppedIterations) && droppedIterations >= 0, "a soak records its requested rate and k6's dropped iterations");
  assert.ok(Array.isArray(windows) && windows.length >= 2, "a soak has at least two intervals");
  const seconds = windows[0].seconds, end = windows.length * seconds;
  assert.ok(Array.isArray(memory) && memory.every((m) => Number.isFinite(m.atSeconds) && Number.isFinite(m.mib) && m.mib > 0), "memory samples need a time and a positive size");
  const at = (from, to) => memory.filter((m) => m.atSeconds >= from && m.atSeconds < to).map((m) => m.mib);
  const first = at(0, seconds), last = at(end - seconds, end);
  assert.ok(first.length && last.length, "a soak needs memory samples in its first and last interval");
  const startMiB = median(first), endMiB = median(last);
  for (const c of [before, after]) assert.ok(Number.isSafeInteger(c?.restartCount) && c.restartCount >= 0 && typeof c.running === "boolean" && typeof c.oomKilled === "boolean", "container state needs restartCount, running and oomKilled");
  assert.ok(after.restartCount >= before.restartCount, "RestartCount moved backwards");
  const restartEvents = events.filter((e) => ["start", "restart", "die", "oom", "kill"].includes(e.action)).map((e) => ({ action: e.action, atSeconds: e.atSeconds }));
  const restarted = after.restartCount > before.restartCount || restartEvents.length > 0 || !after.running || after.oomKilled;
  const p99 = windows.filter((w) => w.p99 !== null).map((w) => w.p99);
  // k6 drops an iteration it could not start on time (no free user): then the load was not the fixed rate asked for.
  return { windows, tail, unrecorded, rate: { requested: rate, droppedIterations, met: droppedIterations === 0 }, memory: { samples: memory.length, startMiB, endMiB, growthMiB: endMiB - startMiB, growthPct: (endMiB - startMiB) / startMiB * 100 },
    p99: { first: windows[0].p99, last: windows.at(-1).p99, max: p99.length ? Math.max(...p99) : null },
    failed: windows.reduce((sum, w) => sum + w.failed, 0),
    restarts: { restarted, restartCount: after.restartCount - before.restartCount, events: restartEvents, runningAtEnd: after.running, oomKilled: after.oomKilled } };
}
/** Validates a saved soak. Returns it. */
export function validateSoak(s) {
  passEvidence(s, soakSchema);
  assert.ok(Number.isSafeInteger(s.options.rate) && s.options.rate > 0);
  for (const c of s.cells) {
    if (c.failure !== undefined) { assert.ok(typeof c.failure === "string" && c.failure.length > 0 && c.windows === undefined, `${cellKey(c)}: a failed cell keeps its reason`); continue; }
    windowsEvidence(c.windows, s.options.windows, s.options.windowSeconds);
    const m = c.memory;
    assert.ok(Number.isSafeInteger(m?.samples) && m.samples > 1 && m.startMiB > 0 && m.endMiB > 0 && m.growthMiB === m.endMiB - m.startMiB && m.growthPct === m.growthMiB / m.startMiB * 100, `${cellKey(c)}: memory`);
    assert.deepEqual(c.p99.first, c.windows[0].p99); assert.deepEqual(c.p99.last, c.windows.at(-1).p99);
    assert.equal(c.failed, c.windows.reduce((sum, w) => sum + w.failed, 0), `${cellKey(c)}: failures`);
    assert.equal(typeof c.restarts?.restarted, "boolean", `${cellKey(c)}: restarts`);
    assert.ok(c.rate?.requested === s.options.rate && Number.isSafeInteger(c.rate.droppedIterations) && c.rate.droppedIterations >= 0 && c.rate.met === (c.rate.droppedIterations === 0), `${cellKey(c)}: rate`);
  }
  return s;
}

/** A verdict in words: the flatten window, or why the pass did not show the adapter steady. */
export const verdictText = (v) => v.flattened ? `window ${v.window} (${v.atSeconds} s)`
  : { "too-few-windows": "not shown steady: too few windows", "no-throughput": "not shown steady: nothing served at the end", "still-rising": "not shown steady at the end",
    "slower-at-end": "not shown steady: slower at the end", "short-steady": `not shown steady: steady for less than ${flattenRule.holdSeconds} s` }[v.reason];
const cpuRoles = ["app", "load", "api"];
const cpuText = (cpus) => cpuRoles.map((role) => `${role} ${cpus?.[role]?.quota ?? "?"} CPU${cpus?.[role]?.cpuset ? ` on ${cpus[role].cpuset}` : " unpinned"}`).join(", ");
/**
 * Why a convergence pass is not like-for-like with a timed round, or [] when it is: the same
 * commit, group, image ID for every measured adapter, CPU quotas and pinning, host CPU model, and
 * the timed warmup's users. A round that does not record one of these cannot be matched on it, and
 * a split round ran on several droplets.
 */
export function unlikeRound(round, apps, c) {
  const reasons = [], o = c.options;
  if (round.split) reasons.push("this round was split across droplets, each its own host");
  if (c.commit !== round.commit) reasons.push(`the pass measured commit \`${c.commit}\`, this round \`${round.commit}\``);
  if ((round.options.group ?? null) !== (o.group ?? null)) reasons.push(`the pass ran ${o.group ? `group ${o.group}` : "no group"}, this round ${round.options.group ? `group ${round.options.group}` : "no group"}, so their images and container settings differ`);
  const images = apps.map((app) => ({ app, round: round.apps?.[app]?.imageId ?? null, pass: c.images?.[app] ?? null }));
  const unrecorded = images.filter((i) => !i.round || !i.pass).map((i) => i.app), differ = images.filter((i) => i.round && i.pass && i.round !== i.pass).map((i) => i.app);
  if (unrecorded.length) reasons.push(`image IDs are not recorded on both sides for ${unrecorded.join(", ")}`);
  if (differ.length) reasons.push(`the image IDs differ for ${differ.join(", ")}`);
  const roundCpus = round.measurement?.cpus, passCpus = c.measurement?.cpus;
  if (!roundCpus || !passCpus || cpuRoles.some((role) => roundCpus[role]?.quota !== passCpus[role]?.quota || (roundCpus[role]?.cpuset ?? null) !== (passCpus[role]?.cpuset ?? null)))
    reasons.push(`the CPU settings differ (pass: ${cpuText(passCpus)}; round: ${cpuText(roundCpus)})`);
  if (!round.host?.cpu || round.host.cpu !== c.host.cpu) reasons.push(`the host CPU differs (pass: ${c.host.cpu}; round: ${round.host?.cpu ?? "not recorded"})`);
  if (o.vus !== timedWarmupVus) reasons.push(`the pass ran ${o.vus} users, the timed warmup ${timedWarmupVus}`);
  return reasons;
}
/**
 * What the timed reporter says about a convergence pass it was given (#1851): which pass, whether
 * it is like-for-like with the round, each measured adapter's flatten window per source and target,
 * and, only for a like-for-like pass in which every measured cell flattened, whether the round's
 * warmup reaches the slowest one. Any other pass's flatten times are context only. report.mjs states
 * the case with no pass itself, so a report without one never loads this module.
 * @param {{commit: string, options: {warmup: number, group?: string}, host?: {cpu?: string}, measurement?: {cpus?: object}, apps?: object, split?: object}} round a validated timed summary
 * @param {string[]} apps the round's measured adapters
 * @param {object} convergence a saved convergence pass
 */
export function convergenceLines(round, apps, convergence) {
  const warmup = round.options.warmup;
  assert.ok(convergence != null, "convergenceLines reads a convergence pass");
  const c = validateConvergence(convergence), o = c.options;
  const lines = [`Convergence evidence: pass ${c.name} (${convergenceSchema}, rule ${flattenRule.name}), measured at commit \`${c.commit}\`. Host CPU: ${c.host.cpu}. One ${o.vus}-user closed-loop pass of ${o.minutes} min per adapter, source and target, in ${o.windowSeconds}s windows from the start of the load, after readiness.`];
  const reasons = unlikeRound(round, apps, c);
  lines.push(reasons.length ? `The pass is not like-for-like with this round, so its flatten times below are context only: ${reasons.join("; ")}.`
    : `The pass is like-for-like with this round: the same commit, group, images, CPU settings and host CPU, and the timed warmup's ${timedWarmupVus} users.`);
  const found = [], missing = [];
  for (const app of apps) for (const source of steadySources) for (const target of steadyTargets) {
    const cell = c.cells.find((x) => x.app === app && x.source === source && x.target === target);
    if (!cell) missing.push(`${app} ${source} ${target}`);
    else found.push({ name: `${app} ${source} ${target}`, cell });
  }
  for (const { name, cell } of found) lines.push(`Flatten: ${name}: ${cell.failure !== undefined ? `no verdict, the pass failed (${cell.failure.split("\n")[0]})` : verdictText(cell.verdict)}.`);
  if (missing.length) lines.push(`No convergence pass for: ${missing.join(", ")}.`);
  if (reasons.length) {
    lines.push(`This pass does not establish this round's ${warmup}s warmup.`);
    return lines;
  }
  const verdicts = found.map(({ name, cell }) => ({ name, v: cell.verdict }));
  if (missing.length || verdicts.some(({ v }) => !v?.flattened)) {
    lines.push(`Not every measured adapter is shown at steady state, so this evidence does not establish the round's ${warmup}s warmup.`);
    return lines;
  }
  const slowest = verdicts.reduce((x, y) => (y.v.atSeconds > x.v.atSeconds ? y : x));
  lines.push(`The slowest measured adapter flattened at ${slowest.v.atSeconds} s (${slowest.name}); this round's ${warmup}s warmup ${warmup >= slowest.v.atSeconds ? "reaches" : "is shorter than"} that point. The comparison is by time: the timed warmup runs after a cold start, the convergence pass after one readiness request.`);
  return lines;
}
/**
 * The shortest timed warmup a convergence pass supports: the latest flatten window's start over
 * every cell, or null when any cell failed or never flattened.
 */
export function supportedWarmup(convergence) {
  const c = validateConvergence(convergence);
  if (c.cells.some((x) => !x.verdict?.flattened)) return null;
  return Math.max(...c.cells.map((x) => x.verdict.atSeconds));
}