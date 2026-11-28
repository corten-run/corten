import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appBefore, appInstance, checkFixture, cpuModelDigest, cpuModelLimit, fixedRateLoad, convergenceLines, convergenceSchema, failureCodes, flattenPoint, flattenRule, heldThrough, intervalSchedule, parseSaved, parseSteadyArgs, readDropped, reconcileCell, readEvents, readWindows, ruleText, savedValue, soakArrivals, soakMemoryClock, soakSchema, startedBeforeLoad, summarizeSoak, timedWarmupVus, unlikeRound, validateConvergence, validateSoak, verdictText } from "./steady-contract.mjs";
import { savedPass } from "./steady-saved-fixture.mjs";
import { cpuSettings, resultSchema, v5Schema } from "./run-contract.mjs";
import { convergenceReport, soakReport, steadyReport } from "./steady-report.mjs";
import { groupApps } from "./groups.mjs";
import { apps } from "./contract.mjs";

const seconds = 15;
// Windows from a list of throughputs, as readWindows returns them.
const windows = (rps, p95 = () => 10, size = seconds) => rps.map((r, index) => ({ index, startSeconds: index * size, seconds: size, requests: r * size, failed: 0, rps: r, p95: r ? p95(index) : null, p99: r ? p95(index) * 2 : null }));
const within = (window, fromSeconds, tailRps, previousRps, headRps) => ({ withinTolerance: true, window, fromSeconds, tailRps, previousRps, headRps });
// A soak's arrivals per interval exactly on its fixed rate's schedule (150 requests/second by default).
const onSchedule = (intervals = 30, size = 60, rate = 150) => intervalSchedule({ rate, seconds: intervals * size, windowSeconds: size });
// Requests completed per interval for soakArrivals: each in the interval its iteration started in,
// up to `requests` in all, so no boundary has more completions than starts before it.
const served = (arrivals, requests) => arrivals.map((n) => { const done = Math.min(n, requests); requests -= done; return done; });
// The rate claim without its intervals, which tests compare separately.
const rateTotals = ({ intervals, ...rest }) => rest;

test("a pass that warms and then holds is within tolerance from the end of the window it reached its level in", () => {
  // The onset is window 3, which starts at 45 s and ends at 60 s: the reading gives its end.
  assert.deepEqual(flattenPoint(windows([400, 700, 900, 980, 1000, 1010, 995, 1005, 1000, 998, 1002, 1000])), within(3, 60, 1000, 1002.5, 800));
  assert.equal(verdictText(flattenPoint(windows([400, 700, 900, 980, 1000, 1010, 995, 1005, 1000, 998, 1002, 1000]))), "within the stated tolerance from the window ending at 60 s");
});
test("an adapter with nothing to warm reads from the end of its first window, never under one window", () => {
  assert.deepEqual(flattenPoint(windows(Array(20).fill(1200))), within(0, 15, 1200, 1200, 1200));
});
test("a stretch inside the bounds with no onset and an upward line, or a short one under a higher last median, is not within tolerance at the end", () => {
  // A steady climb: its final stretch lasts at least 60 s, but no window in it starts a line within 5%.
  const rising = windows(Array.from({ length: 20 }, (_, i) => 500 + 40 * i));
  assert.deepEqual(flattenPoint(rising), { withinTolerance: false, reason: "trend-up", tailRps: 1200, previousRps: 1040, headRps: 560 });
  assert.equal(verdictText(flattenPoint(rising)), "not within tolerance at the end: the final stretch in which every window is within 10% and every three-window median within 5% of the last 60 s median lasts at least 60 s, but no window in it that leaves 60 s to the end is both within 5% of that median and the start of a least-squares line to the end that changes by at most 5% of it; the least-squares line through the whole stretch goes up");
  // A late jump that holds 60 s reads from the jump, not before it.
  assert.deepEqual(flattenPoint(windows([...Array(16).fill(800), 900, 900, 900, 900])), within(16, 255, 900, 800, 800));
  // One that has held for less than 60 s: a short stretch, with the last 60 s median above the 60 s before it.
  const late = flattenPoint(windows([...Array(17).fill(800), 900, 900, 900]));
  assert.equal(late.reason, "short-above-previous");
  assert.equal(verdictText(late), "not within tolerance at the end: the final stretch in which every window is within 10% and every three-window median within 5% of the last 60 s median is shorter than 60 s, and the last 60 s median is more than 5% above the 60 s before it");
});
test("a falling last window is never described as rising", () => {
  // The real local pass's shape: a climb, then the last window at half the level. The empty stretch
  // and the two medians decide it; the text compares the medians and says nothing about a rise.
  const fell = flattenPoint(windows([4546, 8133, 10983, 9275, 10090, 9707, 9613, 4683]));
  assert.equal(fell.reason, "short-above-previous");
  const text = verdictText(fell);
  assert.match(text, /the last 60 s median is more than 5% above the 60 s before it$/);
  assert.doesNotMatch(text, /ris|higher|faster|climb|getting|goes up/);
  // A stretch at least 60 s long with no onset: the line's direction is stated as a line, not as the end.
  const up = verdictText({ withinTolerance: false, reason: "trend-up", tailRps: 1000, previousRps: 1000, headRps: 1000 });
  const down = verdictText({ withinTolerance: false, reason: "trend-not-up", tailRps: 1000, previousRps: 1000, headRps: 1000 });
  assert.match(up, /lasts at least 60 s, but no window in it .* the least-squares line through the whole stretch goes up$/);
  assert.match(down, /the least-squares line through the whole stretch does not go up$/);
  for (const t of [up, down]) assert.doesNotMatch(t, /higher at the end|lower at the end|rising|slower|faster/);
  assert.throws(() => verdictText({ withinTolerance: false, reason: "still-rising" }), /unknown reading/);
  // The old code for a nonpositive slope, which also covered a flat line, is refused.
  assert.throws(() => verdictText({ withinTolerance: false, reason: "trend-down", tailRps: 1000, previousRps: 1000, headRps: 1000 }), /unknown reading/);
});
test("variation inside the stated bounds reads as within tolerance; a window beyond them is not hidden", () => {
  assert.equal(flattenPoint(windows(Array.from({ length: 16 }, (_, i) => (i % 2 ? 1030 : 970)))).window, 0);
  assert.equal(flattenPoint(windows([1000, 1000, 1000, 1000, 1000, 1080, 1000, 1000, 1000, 1000, 1000, 1000])).window, 0);
  // Alternating 8% either side: every window is inside 10%, but each three-window median is 8% off.
  assert.equal(flattenPoint(windows(Array.from({ length: 20 }, (_, i) => (i % 2 ? 1080 : 920)))).reason, "short");
  // A 40% dip ends the run where it falls; one in the last 60 s leaves too little time inside it.
  assert.deepEqual(flattenPoint(windows([500, 800, 1000, 1000, 1000, 600, 1000, 1000, 1000, 1000, 1000, 1000])), within(6, 105, 1000, 1000, 900));
  assert.equal(flattenPoint(windows([500, 800, 1000, 1000, 1000, 600, 1000, 1000, 1000, 1000, 1000, 700])).reason, "short");
  assert.equal(verdictText(flattenPoint(windows([...Array(19).fill(1000), 850]))), "not within tolerance at the end: the final stretch in which every window is within 10% and every three-window median within 5% of the last 60 s median is shorter than 60 s");
  assert.equal(flattenPoint(windows([500, 1000, 500, 600, 800, 1000, 1000, 1000, 1000, 1000, 1000, 1000])).window, 5);
  assert.equal(flattenPoint(windows([...Array(14).fill(1000), 700, 700])).reason, "earlier-above-tail");
  // [1000, 1000, 500, 1000] five times: every three-window median is 1000, but one window in four is half the tail.
  assert.equal(flattenPoint(windows(Array.from({ length: 5 }, () => [1000, 1000, 500, 1000]).flat())).reason, "short");
  // 15 windows at 800 then 5 at 1000: 75 s inside the bounds at the new level.
  assert.deepEqual(flattenPoint(windows([...Array(15).fill(800), ...Array(5).fill(1000)])), within(15, 240, 1000, 800, 800));
});
test("the reviewer's four constructed passes read as the documented limits say", () => {
  // 1. Oscillation inside the bounds: 920, 1000, 1080, 1000 five times. Every window is within 8%
  //    of the tail and every three-window median is the tail, so it reads within tolerance; only
  //    the first window (920) is too far off to be the onset.
  assert.deepEqual(flattenPoint(windows(Array.from({ length: 5 }, () => [920, 1000, 1080, 1000]).flat())), within(1, 30, 1000, 1000, 1000));
  // 2. A last-window shift under 10% can go undetected: nineteen at 1000 then 1090.
  assert.deepEqual(flattenPoint(windows([...Array(19).fill(1000), 1090])), within(0, 15, 1000, 1000, 1000));
  // 3. Drift inside the bounds: a steady climb from 1000 to 1076 reads within tolerance from the
  //    window whose remaining climb is under 5% of the tail.
  const climb = flattenPoint(windows(Array.from({ length: 20 }, (_, i) => 1000 + (76 * i) / 19)));
  assert.deepEqual([climb.withinTolerance, climb.window, climb.fromSeconds, climb.tailRps], [true, 6, 105, 1070]);
  // 4. A pass that started faster and then held: its first 60 s median is 10% above the tail's.
  const started = flattenPoint(windows([...Array(4).fill(1100), ...Array(16).fill(1000)]));
  assert.deepEqual(started, { withinTolerance: false, reason: "earlier-above-tail", tailRps: 1000, previousRps: 1000, headRps: 1100 });
  assert.equal(verdictText(started), "not within tolerance at the end: the median of the first 60 s is more than 5% above the last 60 s median");
  // The stated bounds and limits are what the report prints.
  for (const text of ["not a certificate of steady state", "within 10% of the median of the last 60 s", "every three-window median within 5%", "changed by at most 5% of it",
    "that window's own throughput within 5% of it", "those two are comparisons between medians, not of each window",
    "Oscillation or drift inside those bounds reads as within tolerance", "a shift of under 10% in the last window can go undetected", "resolved to one window and given as that window's end", "readings at different window lengths are not comparable"])
    assert.ok(ruleText.includes(text), text);
});
test("short, empty and degrading passes give no reading or a stated one", () => {
  assert.deepEqual(flattenPoint(windows([1000, 1000, 1000, 1000, 1000, 1000, 1000])), { withinTolerance: false, reason: "too-few-windows" });
  assert.equal(verdictText(flattenPoint(windows([1000, 1000, 1000, 1000, 1000, 1000, 1000]))), "no reading: too few windows");
  assert.equal(verdictText(flattenPoint(windows([1000, 1000, 1000, 1000, 0, 0, 0, 0]))), "no reading: the last 60 s median is zero");
  // The last window served requests, but the median of the last 60 s is zero: the text says the median.
  const lastServed = flattenPoint(windows([1000, 1000, 1000, 1000, 0, 0, 0, 5]));
  assert.equal(lastServed.reason, "no-throughput");
  assert.equal(verdictText(lastServed), "no reading: the last 60 s median is zero");
  assert.deepEqual(flattenPoint(windows([800, 800, 800, 800, 1000, 1000, 600, 600, 1000, 1000, 600, 600])), { withinTolerance: false, reason: "short", tailRps: 800, previousRps: 800, headRps: 800 });
  assert.deepEqual(flattenPoint(windows([1500, 1400, 1300, 1200, 1100, 1000, 1000, 1000, 1000, 1000, 1000, 1000])), { withinTolerance: false, reason: "earlier-above-tail", tailRps: 1000, previousRps: 1000, headRps: 1350 });
  assert.throws(() => flattenPoint(windows([1, 2, 3, 4, 5, 6, 7, 8]), { ...flattenRule, tolerance: 0.5 }), /stated tolerance rule/);
  assert.throws(() => flattenPoint([{ rps: Number.NaN, startSeconds: 0 }]), /finite/);
});
test("a pass whose earlier medians are more than 5% above its last 60 s median is not within tolerance, at any rate of decline", () => {
  const falling = windows(Array.from({ length: 20 }, (_, i) => 1500 - 25 * i));
  assert.deepEqual(flattenPoint(falling), { withinTolerance: false, reason: "earlier-above-tail", tailRps: 1062.5, previousRps: 1162.5, headRps: 1462.5 });
  assert.equal(verdictText(flattenPoint(falling)), "not within tolerance at the end: the median of the first 60 s and the median of the 60 s before the last 60 s are each more than 5% above the last 60 s median");
  assert.equal(flattenPoint(windows(Array.from({ length: 20 }, (_, i) => 1200 - 5 * i))).reason, "earlier-above-tail");
  assert.equal(flattenPoint(windows([...Array(8).fill(1000), 1200, 1200, ...Array(10).fill(1000)])).window, 10);
});
test("the reading's spans are in seconds, but its onset is resolved to one window, so widths are not comparable", () => {
  // 500 req/s for 30 s and 1000 after, in 15, 5 and 10 s windows: the onset window starts at 30 s
  // in each, and the reading gives that window's end, so the three readings differ.
  const at = (size) => flattenPoint(windows(Array.from({ length: 180 / size }, (_, i) => (i * size < 30 ? 500 : 1000)), () => 10, size));
  assert.deepEqual([15, 5, 10].map((size) => at(size).window * size), [30, 30, 30]);
  assert.deepEqual([at(15).fromSeconds, at(5).fromSeconds, at(10).fromSeconds], [45, 35, 40]);
  // 45 s back at the earlier level after a dip is not within tolerance long enough, in either width.
  const short = (size) => flattenPoint(windows(Array.from({ length: 240 / size }, (_, i) => (i * size < 120 ? 1000 : i * size < 195 ? 600 : 1000)), () => 10, size));
  assert.equal(short(15).withinTolerance, false); assert.equal(short(5).withinTolerance, false);
  assert.throws(() => flattenPoint(windows(Array(16).fill(1000), () => 10, 7)), /divides 60 s/);
});

// A k6 summary export from window-load.js with these per-window request counts.
function k6Summary(counts, { tail = 0, failed = {}, extra = {}, unfinished = 0 } = {}) {
  const metrics = { http_reqs: { count: counts.reduce((a, b) => a + b, 0) + tail + unfinished, rate: 1 }, iterations: { count: counts.reduce((a, b) => a + b, 0) + tail },
    http_req_duration: { avg: 5, "p(95)": 9, "p(99)": 20, max: 30 + counts.length } };
  counts.forEach((n, i) => {
    if (!n) return;
    metrics[`window_${i}_requests`] = { count: n, rate: 1 };
    metrics[`window_${i}_duration`] = { avg: 5, "p(50)": 4, "p(95)": 9 + i, "p(99)": 20 + i, max: 30 };
    if (failed[i]) metrics[`window_${i}_failed`] = { count: failed[i], rate: 1 };
  });
  if (tail) metrics.window_tail_requests = { count: tail, rate: 1 };
  return { metrics: { ...metrics, ...extra } };
}
test("readWindows keeps every window's throughput and latency and accounts for every request", () => {
  const read = readWindows(k6Summary([150, 300, 0, 450], { tail: 7, failed: { 1: 3 } }), { windows: 4, windowSeconds: 15 });
  assert.deepEqual([read.tail, read.unrecorded, read.requests, read.iterations, read.latencyMaxMs], [7, 0, 907, 907, 34]);
  assert.deepEqual(read.windows.map((w) => [w.startSeconds, w.requests, w.failed, w.rps, w.p95, w.p99]), [[0, 150, 0, 10, 9, 20], [15, 300, 3, 20, 10, 21], [30, 0, 0, 0, null, null], [45, 450, 0, 30, 12, 23]]);
  // A request whose iteration the graceful stop cut off before it was counted.
  assert.equal(readWindows(k6Summary([150, 150], { unfinished: 1 }), { windows: 2, windowSeconds: 15 }).unrecorded, 1);
  for (const [summary, pattern] of [
    [k6Summary([150, 150], { extra: { http_reqs: { count: 400, rate: 1 }, iterations: { count: 400 } } }), /account for every request/],
    [k6Summary([150, 150], { extra: { http_reqs: { count: 250, rate: 1 }, iterations: { count: 250 } } }), /account for every request/],
    [k6Summary([150, 150], { extra: { window_2_requests: { count: 1, rate: 1 } } }), /^Error: 1 k6 window metric is not among this pass's windows$/],
    [k6Summary([150, 150], { failed: { 0: 151 } }), /more failures than requests/],
    [k6Summary([150, 150], { extra: { window_1_duration: { "p(95)": 30, "p(99)": 20 } } }), /p95\/p99/],
    // A window's p99 of 20 ms beside an aggregate maximum of 1 ms cannot both be k6's.
    [k6Summary([150, 150], { extra: { http_req_duration: { avg: 1, "p(95)": 1, "p(99)": 1, max: 1 } } }), /window 0: latency above k6's aggregate http_req_duration maximum/],
    [k6Summary([150, 150], { extra: { http_req_duration: { avg: 1 } } }), /http_req_duration maximum missing/],
  ]) assert.throws(() => readWindows(summary, { windows: 2, windowSeconds: 15 }), pattern);
});

test("steady.mjs options keep convergence and soak apart and bound each", () => {
  const inventory = apps;
  const c = parseSteadyArgs(["convergence", "w3", "--group", "production"], inventory, groupApps);
  // The default pass runs the timed warmup's 32 users; --vus is for exploration.
  assert.deepEqual([c.minutes, c.windowSeconds, c.windows, c.vus, c.rate, c.targets, c.sources, c.apps], [5, 15, 20, timedWarmupVus, null, ["page", "json"], ["fixture", "api"], groupApps("production")]);
  assert.equal(timedWarmupVus, 32);
  assert.equal(parseSteadyArgs(["convergence", "w3", "--vus", "64"], inventory, groupApps).vus, 64);
  assert.equal(parseSteadyArgs(["convergence", "w3", "--minutes", "2", "--window", "5"], inventory, groupApps).windows, 24);
  const s = parseSteadyArgs(["soak", "w4", "--apps", "corten,aspnet", "--minutes", "60", "--interval", "30", "--targets", "json,page"], inventory, groupApps);
  assert.deepEqual([s.minutes, s.windowSeconds, s.windows, s.rate, s.vus, s.targets, s.apps], [60, 30, 120, 150, null, ["page", "json"], ["corten", "aspnet"]]);
  for (const [args, pattern] of [
    [["soak", "w4", "--minutes", "20"], /30 to 60/], [["soak", "w4", "--minutes", "61"], /30 to 60/],
    [["convergence", "w3", "--minutes", "1"], /2 to 30/], [["convergence", "w3", "--interval", "30"], /soak option/],
    [["soak", "w4", "--vus", "64"], /fixed rate/], [["convergence", "w3", "--window", "7"], /must divide/], [["convergence", "w3", "--window", "25"], /must divide/],
    [["convergence", "w3", "--minutes", "2", "--window", "30"], /windows/], [["soak", "w4", "--interval", "45", "--minutes", "31"], /whole number of windows/],
    [["convergence", "w3", "--group", "production", "--apps", "corten"], /cannot be combined/], [["convergence", "W3"], /pass name/],
    [["timed", "w3"], /usage/], [["convergence", "w3", "--apps", "nope"], /subset/], [["convergence", "w3", "--minutes", "5", "--minutes", "6"], /duplicate/],
  ]) assert.throws(() => parseSteadyArgs(args, inventory, groupApps), pattern);
});

test("caller labels go on every resource and cannot take the ownership key", () => {
  const c = parseSteadyArgs(["convergence", "w3", "--apps", "corten", "--label", "agent.owner=codex", "--label", "agent.task=i1851"], apps, groupApps);
  assert.deepEqual(c.labels, ["agent.owner=codex", "agent.task=i1851"]);
  assert.deepEqual(parseSteadyArgs(["soak", "w4", "--apps", "corten"], apps, groupApps).labels, []);
  for (const [value, pattern] of [["run.corten.marketplace=x", /reserved/], ["run.corten.marketplace.commit=x", /reserved/], ["agent.owner", /KEY=VALUE/], ["a b=c", /KEY=VALUE/]])
    assert.throws(() => parseSteadyArgs(["convergence", "w3", "--label", value], apps, groupApps), pattern);
  assert.throws(() => parseSteadyArgs(["convergence", "w3", "--label", "a=1", "--label", "a=2"], apps, groupApps), /duplicate --label a/);
  // steady-run.test.mjs shows them on every create and network against a fake Docker.
});

test("a pass refuses a missing or stale fixture and records the one it mounts", () => {
  const generated = { item_1: { id: "item_1" } }, identity = (v) => v;
  const bytes = Buffer.from(JSON.stringify(generated));
  assert.match(checkFixture(bytes, generated, identity), /^[a-f0-9]{64}$/);
  assert.throws(() => checkFixture(null, generated, identity), /fixture is missing/);
  assert.throws(() => checkFixture(Buffer.from(JSON.stringify({ item_1: { id: "item_2" } })), generated, identity), /stale/);
  assert.throws(() => checkFixture(bytes, generated, () => { throw new Error("invalid marketplace record"); }), /invalid marketplace record/);
});

const imageIds = { corten: `sha256:${"1".repeat(64)}`, aspnet: `sha256:${"2".repeat(64)}` };
const fixtureSha256 = "f".repeat(64), tools = { upstream: { imageId: `sha256:${"4".repeat(64)}` }, k6: { imageId: `sha256:${"5".repeat(64)}` } };
const pinnedEnv = { MARKETPLACE_APP_CPUS: "1", MARKETPLACE_LOAD_CPUS: "4-7", MARKETPLACE_API_CPUS: "2-3" };
const measurement = () => ({ cpus: cpuSettings(pinnedEnv), appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, encoding: "identity" });
// A timed round's per-profile runs with the warmup failures given.
const runs = (failed = 0) => ({ "fixture-rotating-page": [{ warmup: { requests: 1000, failed } }], "fixture-json": [{ warmup: { requests: 1000, failed: 0 } }] });
// A timed round like-for-like with convergencePass() on every compared input.
const likeRound = (warmup = 10) => ({ schema: resultSchema, commit: "c".repeat(40), options: { warmup, startupTimeout: 120 }, host: { cpu: "Synthetic test only", release: "6.8.0-test", onlineCpus: "0-7" },
  measurement: measurement(), fixtureSha256, tools: structuredClone(tools), apps: { corten: { imageId: imageIds.corten, runs: runs() }, aspnet: { imageId: imageIds.aspnet, runs: runs() } } });
const cellOf = (app, source, target, rps) => {
  const w = windows(rps), requests = w.reduce((sum, x) => sum + x.requests, 0) + 3;
  return { app, source, target, windows: w, tail: 3, unrecorded: 0, requests, iterations: requests, latencyMaxMs: 25, failedRequests: 0, verdict: flattenPoint(w) };
};
function convergencePass({ commit = "c".repeat(40), cells } = {}) {
  const options = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "3"], apps, groupApps);
  const rps = { corten: Array(12).fill(1000), aspnet: [200, 400, 600, 800, 900, 1000, 1000, 1000, 1000, 1000, 1000, 1000] };
  return savedPass(options, cells ?? options.sources.flatMap((source) => options.apps.flatMap((app) => options.targets.map((target) => cellOf(app, source, target, rps[app])))), { commit });
}
test("a saved convergence pass validates, recomputes every reading and sets no warmup", () => {
  const s = convergencePass();
  validateConvergence(s);
  const text = convergenceReport(s);
  assert.match(text, /^\| aspnet \| api \| json \| within the stated tolerance from the window ending at 90 s \| 1000\.0 \| 0 \|$/m);
  assert.match(text, /This pass sets no timed warmup: a timed warmup is set only by a separate reviewed change from a saved pass that is like-for-like with the rounds it applies to .* It ran the timed warmup's 32 users\./);
  assert.match(text, /Tolerance reading marketplace-tolerance\/v4: a screening reading of throughput, not a certificate of steady state\./);
  assert.match(text, /has no reading\./);
  // Its API-source cells are listed, and the report says they are not compared with a timed round,
  // as report.mjs --convergence does; a pass without the API source does not say it.
  assert.match(text, /^An API-source cell's reading is listed, but it is not compared with a timed round \(report\.mjs --convergence lists it as not compared\): .* nothing shows that the cell's requests reached the upstream\.$/m);
  const fixtureOnly = structuredClone(s); fixtureOnly.options.sources = ["fixture"]; fixtureOnly.cells = fixtureOnly.cells.filter((c) => c.source === "fixture");
  fixtureOnly.cleanup.created = fixtureOnly.cleanup.removed = 4 + fixtureOnly.cells.length * 4;
  assert.doesNotMatch(convergenceReport(fixtureOnly), /API-source/);
  assert.doesNotMatch(text, /Supported timed warmup|flattened|reaches/);
  const explore = structuredClone(s); explore.options.vus = 64;
  assert.match(convergenceReport(explore), /It ran 64 users, not the timed warmup's 32, so it is exploration and is not like-for-like with any timed round\./);
  assert.match(text, /^corten fixture page req\/s by window: 1000\.0, 1000\.0/m);
  assert.match(text, /^corten fixture page p99 ms by window: \d/m);
  assert.match(text, /^No group: the ungrouped images and container settings, not a group's timed configuration\.$/m);
  assert.equal(steadyReport(s), text);
  for (const [mutate, pattern] of [
    [(v) => { v.cells[0].verdict = { ...v.cells[0].verdict, window: 4 }; }, /saved verdict differs/],
    [(v) => { v.cells[1].windows[3].rps = 9999; }, /throughput contradicts its count/],
    [(v) => { v.cells.pop(); }, /one cell per adapter/],
    [(v) => { v.complete = false; }, /incomplete/],
    [(v) => { v.dirty = true; }, /clean checkout/],
    [(v) => { v.rule = { ...flattenRule, holdSeconds: 30 }; }, /stated tolerance reading/],
    [(v) => { delete v.images.aspnet; }, /image ID of every adapter/],
    [(v) => { v.images.corten = "cb-marketplace-corten"; }, /sha256 IDs/],
    [(v) => { delete v.measurement; }, /CPU settings/],
    [(v) => { v.cells[0].windows[0].p95 = null; }, /latency/],
    [(v) => { v.cells[0].windows[2].failed = v.cells[0].windows[2].requests; }, /failed requests in its windows/],
    [(v) => { v.cells[0].failedRequests = 1; }, /failed requests in k6's aggregate/],
    [(v) => { delete v.fixtureSha256; }, /fixture hash/],
    [(v) => { delete v.tools.upstream; }, /upstream image ID/],
    [(v) => { delete v.host.kernel; }, /the pass's host has fields its schema does not save, or lacks one it does/],
    [(v) => { delete v.startup; }, /how it started/],
    // What the saved reader refuses beyond the windows: another finishing commit, a suite failure,
    // cleanup that failed or is unconfirmed, totals that do not reconcile, and an empty matrix.
    [(v) => { v.finishedCommit = "d".repeat(40); }, /finishes at the commit it started at/],
    [(v) => { delete v.finishedCommit; }, /finishes at the commit it started at/],
    [(v) => { v.failures = [{ stage: "suite", code: "error" }]; }, /suite failure/],
    [(v) => { v.cleanup.failures = 1; }, /cleanup failed/],
    [(v) => { v.cleanup.complete = false; }, /cleanup is not confirmed complete/],
    [(v) => { v.cleanup.remaining.containers = 1; }, /cleanup is not confirmed complete/],
    [(v) => { v.cleanup.unacknowledged = [{ name: "x-k6", label: "l", outcome: "unconfirmed" }]; }, /create Docker did not acknowledge/],
    [(v) => { delete v.cleanup; }, /cleanup is not confirmed complete/],
    // Complete, with counts that do not show every acknowledged create removed by its ID: none or
    // one fewer removed, one counted as recovered instead, or more removed than were created.
    [(v) => { Object.assign(v.cleanup, { created: 36, removed: 0, recovered: 0 }); }, /^Error: a pass whose acknowledged creates were not each confirmed removed is not evidence$/],
    [(v) => { Object.assign(v.cleanup, { created: 36, removed: 35, recovered: 0 }); }, /acknowledged creates were not each confirmed removed/],
    [(v) => { Object.assign(v.cleanup, { created: 36, removed: 35, recovered: 1 }); }, /acknowledged creates were not each confirmed removed/],
    [(v) => { Object.assign(v.cleanup, { created: 36, removed: 37, recovered: 0 }); }, /acknowledged creates were not each confirmed removed/],
    // Six created, seven removed, none recovered, and one unacknowledged create marked removed: an
    // unacknowledged create is accounted only by a recovered resource.
    [(v) => { Object.assign(v.cleanup, { created: 6, removed: 7, recovered: 0, unacknowledged: [{ name: "x-k6", label: "a.b=x-1", outcome: "removed" }] }); }, /acknowledged creates were not each confirmed removed/],
    // A complete pass has no create Docker did not acknowledge and recovered nothing by its label: the
    // runner ends the pass at a cell whose create was not acknowledged, even when teardown recovers
    // it. Every expected create acknowledged plus two recovered attempts, one recovered attempt with
    // its record, a record without a recovery, or a recovery without a record: each is refused.
    [(v) => { Object.assign(v.cleanup, { recovered: 2, unacknowledged: [{ name: "x-k6", label: "a.b=x-1", outcome: "removed" }, { name: "x-k6", label: "a.b=x-2", outcome: "removed" }] }); },
      /^Error: a pass with a create Docker did not acknowledge, or a resource recovered by its label, is not evidence$/],
    [(v) => { Object.assign(v.cleanup, { recovered: 1, unacknowledged: [{ name: "x-k6", label: "a.b=x-1", outcome: "removed" }] }); }, /create Docker did not acknowledge, or a resource recovered by its label/],
    [(v) => { v.cleanup.unacknowledged = [{ name: "x-k6", label: "a.b=x-1", outcome: "removed" }]; }, /create Docker did not acknowledge, or a resource recovered by its label/],
    [(v) => { Object.assign(v.cleanup, { created: 36, removed: 36, recovered: 1 }); }, /create Docker did not acknowledge, or a resource recovered by its label/],
    // Counts that agree with each other but not with the cells: measured cells with no create at all,
    // or one fewer or more than the eight measured cells and the pass made.
    [(v) => { Object.assign(v.cleanup, { created: 0, removed: 0, recovered: 0 }); }, /^Error: a pass's creates are not the ones its cells imply$/],
    [(v) => { Object.assign(v.cleanup, { created: 35, removed: 35 }); }, /creates are not the ones its cells imply/],
    [(v) => { Object.assign(v.cleanup, { created: 37, removed: 37 }); }, /creates are not the ones its cells imply/],
    [(v) => { v.cells[0].requests += 1; }, /do not add up to k6's request total/],
    [(v) => { v.cells[0].unrecorded = 1; v.cells[0].requests += 1; v.cells[0].iterations += 1; }, /more unrecorded requests than unfinished iterations/],
    [(v) => { delete v.cells[0].iterations; }, /a convergence cell has fields its schema does not save, or lacks one it does/],
    [(v) => { v.cells[0].iterations = v.cells[0].requests + 1; }, /request and iteration totals/],
    // Each of the pass's 32 VUs has at most one unfinished iteration, so k6's requests less its
    // completed iterations are at most 32: no completed iteration at all, or 33 unfinished, is refused.
    [(v) => { v.cells[0].iterations = 0; }, /^Error: [a-z]+ [a-z]+ [a-z]+: more unfinished iterations than the load has VUs$/],
    [(v) => { v.cells[0].iterations = v.cells[0].requests - 33; }, /^Error: [a-z]+ [a-z]+ [a-z]+: more unfinished iterations than the load has VUs$/],
    [(v) => { v.options.apps = []; v.images = {}; v.cells = []; }, /at least one of its apps/],
    [(v) => { v.cells[0].latencyMaxMs = 1; }, /latency above k6's aggregate http_req_duration maximum/],
    [(v) => { v.cells[0].latencyMaxMs = null; }, /aggregate latency maximum/],
    [(v) => { v.schema = "marketplace-convergence/v7"; }, /not a marketplace-convergence\/v8 result/],
    // v5 saves the host's CPU model only as its digest: a v4-style text field is not read.
    [(v) => { v.host = { ...v.host, cpu: "Synthetic test only" }; delete v.host.cpuModelSha256; }, /the pass's host has fields its schema does not save/],
    [(v) => { v.host.cpuModelSha256 = "Synthetic test only"; }, /the pass's host cpuModelSha256 is not a value it saves/],
  ]) { const v = structuredClone(s); mutate(v); assert.throws(() => validateConvergence(v), pattern); }
  // 32 unfinished iterations, one per VU, reconcile and read.
  { const v = structuredClone(s); v.cells[0].iterations = v.cells[0].requests - 32; assert.equal(v.cells[0].unrecorded, 0); validateConvergence(v); }
  // Every acknowledged create removed (four for the pass and four for each of its eight cells), with
  // none unacknowledged and nothing recovered, reads.
  assert.deepEqual([s.cleanup.created, s.cleanup.removed, s.cleanup.recovered, s.cleanup.unacknowledged], [36, 36, 0, []]);
  validateConvergence(structuredClone(s));
  // A complete pass whose cells failed stays reportable: each such cell reads "no reading", with the
  // text of its failure code.
  const failed = structuredClone(s);
  failed.cells[2] = { app: failed.cells[2].app, source: failed.cells[2].source, target: failed.cells[2].target, verdict: null, failure: "cold-start" };
  validateConvergence(failed);
  // A failed cell made at most its four creates, and the seven measured ones made theirs.
  for (const [created, reads] of [[32, true], [31, false]]) {
    const v = structuredClone(failed); Object.assign(v.cleanup, { created, removed: created });
    if (reads) validateConvergence(v); else assert.throws(() => validateConvergence(v), /creates are not the ones its cells imply/);
  }
  assert.match(convergenceReport(failed), /\| aspnet \| fixture \| page \| no reading: the cell failed \(the app did not start as the timed cold start requires\) \| - \| - \|/);
});

test("a soak reports memory at the start and end, p99 per interval and any restart", () => {
  const w = windows([150, 150, 150, 150, 150, 150], (i) => 10 + i, 15);
  const memory = Array.from({ length: 360 }, (_, i) => ({ atSeconds: i / 4, mib: 100 + i / 10 }));
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const base = { rate: 150, droppedIterations: 0, failedRequests: 0, windows: w, tail: 0, unrecorded: 0, requests: 13500, iterations: 13500, latencyMaxMs: 40, memory, before: held, after: held, events: [], arrivals: onSchedule(6, 15) };
  const cell = summarizeSoak(base);
  assert.equal(cell.memory.samples, 360);
  assert.ok(Math.abs(cell.memory.startMiB - 102.95) < 1e-9 && Math.abs(cell.memory.endMiB - 132.95) < 1e-9 && Math.abs(cell.memory.growthMiB - 30) < 1e-9, JSON.stringify(cell.memory));
  assert.deepEqual(cell.p99, { first: 20, last: 30, max: 30 });
  assert.deepEqual(cell.restarts, { restarted: false, restartCount: 0, replaced: false, eventStream: "none-seen", events: [], runningAtEnd: true, oomKilled: false });
  // An OOM kill and an exit with no start after them: stopped, not restarted.
  const stopped = summarizeSoak({ ...base, after: { ...held, running: false, oomKilled: true }, events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }] });
  assert.deepEqual(stopped.restarts, { restarted: false, restartCount: 0, replaced: false, eventStream: "seen", events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }], runningAtEnd: false, oomKilled: true });
  // Restart evidence is a changed RestartCount or StartedAt (below), a restart event, or a start after
  // a die. A kill alone (any signal, SIGCONT among them) is not, nor a start with no die before it,
  // and a stream that is not read leaves the cell with no reading at all (below).
  for (const [events, restarted] of [[[{ action: "kill", atSeconds: 1 }], false], [[{ action: "die", atSeconds: 1 }], false], [[{ action: "start", atSeconds: 1 }], false],
    [[{ action: "start", atSeconds: 1 }, { action: "die", atSeconds: 2 }], false], [[{ action: "kill", atSeconds: 1 }, { action: "die", atSeconds: 1.1 }, { action: "start", atSeconds: 2 }], true],
    [[{ action: "restart", atSeconds: 1 }], true],
    // Paired by time, never by delivery order: a start stamped at the same time as a die, or before
    // it though delivered after it, is not a restart; one stamped after a die delivered later is.
    [[{ action: "die", atSeconds: 1 }, { action: "start", atSeconds: 1 }], false], [[{ action: "die", atSeconds: 2 }, { action: "start", atSeconds: 1 }], false],
    [[{ action: "start", atSeconds: 2 }, { action: "die", atSeconds: 1 }], true]])
    assert.equal(summarizeSoak({ ...base, events }).restarts.restarted, restarted, JSON.stringify(events));
  // Only readEvents's restart-relevant list is accepted.
  assert.throws(() => summarizeSoak({ ...base, events: [{ action: "exec_start", atSeconds: 1 }] }), /readEvents's list of the app's events/);
  assert.equal(summarizeSoak({ ...base, after: { ...held, restartCount: 2 } }).restarts.restarted, true);
  // A docker restart keeps RestartCount but not StartedAt; another container ID is another instance.
  const restartedInPlace = summarizeSoak({ ...base, after: { ...held, startedAt: "2026-11-20T00:10:00Z" } }).restarts;
  assert.deepEqual([restartedInPlace.restarted, restartedInPlace.replaced], [true, true]);
  assert.equal(summarizeSoak({ ...base, after: { ...held, id: "b".repeat(64) } }).restarts.replaced, true);
  assert.deepEqual(summarizeSoak({ ...base, memory: memory.slice(0, 10) }).memory, { samples: 10, unavailable: "no memory sample in the last interval", startMiB: null, endMiB: null, growthMiB: null, growthPct: null });
  assert.throws(() => summarizeSoak({ ...base, before: { ...held, restartCount: 1 } }), /backwards/);
  assert.throws(() => summarizeSoak({ ...base, before: { restartCount: 0, running: true, oomKilled: false } }), /needs id, startedAt/);
  // Each side's snapshot is validated before any comparison: two missing counters, the same
  // malformed or never-started StartedAt on both sides, or an app not running before the load.
  for (const bad of [{ ...held, restartCount: undefined }, { ...held, startedAt: "yesterday" }, { ...held, startedAt: "0001-01-01T00:00:00Z" }])
    assert.throws(() => summarizeSoak({ ...base, before: bad, after: bad }), /needs id, startedAt/);
  for (const before of [{ ...held, running: false }, { ...held, oomKilled: true }])
    assert.throws(() => summarizeSoak({ ...base, before, after: before }), /not running, or was OOM-killed, before the load/);

  const options = parseSteadyArgs(["soak", "w4", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const long = windows(Array(30).fill(150), (i) => (i === 29 ? 40 : 10), 60);
  const soakCell = (extra = {}) => ({ app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: long, tail: 0, unrecorded: 0, requests: 270000, iterations: 270000, latencyMaxMs: 90,
    memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: i < 60 ? 50 : 80 })), before: held, after: held, events: [], arrivals: onSchedule(), ...extra }) });
  const s = savedPass(options, [soakCell()], { commit: "d".repeat(40),
    admission: { round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: "bench/marketplace/results/w2/summary.json", selected: ["corten", "aspnet"], admitted: ["corten"] } });
  validateSoak(s);
  const text = soakReport(s);
  assert.match(text, /^\| corten \| fixture \| page \| held \| 50\.0 \| 80\.0 \| \+30\.0 MiB \(60\.0%\) \| 20\.0 \/ 80\.0 \/ 80\.0 \| 0 \| none \| no \|$/m);
  assert.match(text, /those timed round w2 .* admitted, of corten, aspnet/);
  // Memory and p99 are figures; only the fixed rate has a held criterion.
  assert.match(text, /it reports, for each cell with a reading, the adapter's memory at the start and end and its p99 by interval as figures, with no criterion for whether they held, whether the fixed rate held, any observed evidence that the app restarted, and the app's observed exit, signal and OOM events that qualify for the cell \(below\)/);
  assert.match(text, /^Memory and p99 are reported figures, not held or not held: no criterion is applied to them\./m);
  assert.doesNotMatch(text, /memory, tail latency and process held/);
  // The report states both clocks: memory intervals are their own, not the latency intervals.
  assert.ok(text.includes(soakMemoryClock));
  assert.match(soakMemoryClock, /intervals of their own/);
  assert.doesNotMatch(text, /was not met/);
  assert.match(text, /^No group: /m);
  // A grouped pass selected all of its group's adapters and ran those the round admitted.
  const grouped = structuredClone(s); grouped.options.group = "production"; grouped.admission.selected = groupApps("production");
  assert.match(soakReport(grouped), /^Group production: its images and container settings\.$/m);
  assert.equal(steadyReport(s), text);
  const replaced = structuredClone(s); replaced.cells = [soakCell({ after: { ...held, startedAt: "2026-11-20T00:30:00Z" } })];
  assert.match(soakReport(replaced), /\| none \| yes: another instance \(ID or StartedAt\) at the end \|$/m);
  // One kill of a still-running app with StartedAt and RestartCount unchanged is a signal, not a restart.
  const signalled = structuredClone(s); signalled.cells = [soakCell({ events: [{ action: "kill", atSeconds: 1 }] })];
  validateSoak(signalled);
  assert.equal(signalled.cells[0].restarts.restarted, false);
  assert.match(soakReport(signalled), /\| signal \(kill\) at 1 s \| no \|$/m);
  // A saved v6 soak that claims a restart from the kill alone contradicts its own observations.
  const claimed = structuredClone(signalled); claimed.cells[0].restarts.restarted = true;
  assert.throws(() => validateSoak(claimed), /the restart claim contradicts its counters, events and final state/);
  // A saved soak whose claims contradict its own counters, totals or cleanup is refused.
  for (const [mutate, pattern] of [
    [(v) => { v.cells[0].memory.growthMiB = 0; }, /memory/],
    [(v) => { v.cells[0].p99.max = -1; }, /p99 contradicts its intervals/],
    [(v) => { v.cells[0].p99.max = null; }, /p99 contradicts its intervals/],
    [(v) => { v.cells[0].restarts.restartCount = 1; }, /restart claim contradicts/],
    [(v) => { v.cells[0].restarts.events = [{ action: "die", atSeconds: 5 }]; }, /event stream's state contradicts its events/],
    [(v) => { v.cells[0].restarts.events = [{ action: "die", atSeconds: 5 }, { action: "start", atSeconds: 6 }]; v.cells[0].restarts.eventStream = "seen"; }, /restart claim contradicts/],
    [(v) => { v.cells[0].restarts.events = [{ action: "restart", atSeconds: 5 }]; v.cells[0].restarts.eventStream = "seen"; }, /restart claim contradicts/],
    // A saved soak that claims a restart from a start delivered after a die but not stamped after it.
    [(v) => { Object.assign(v.cells[0].restarts, { events: [{ action: "die", atSeconds: 5 }, { action: "start", atSeconds: 5 }], eventStream: "seen", restarted: true }); }, /restart claim contradicts/],
    [(v) => { Object.assign(v.cells[0].restarts, { events: [{ action: "die", atSeconds: 6 }, { action: "start", atSeconds: 5 }], eventStream: "seen", restarted: true }); }, /restart claim contradicts/],
    // Only the exact action words are saved events: a restart with detail is refused, whatever it claims.
    [(v) => { Object.assign(v.cells[0].restarts, { events: [{ action: "restart: x", atSeconds: 5 }], eventStream: "seen", restarted: true }); }, /restarts/],
    [(v) => { v.cells[0].restarts.eventStream = "unavailable"; }, /restarts/],
    [(v) => { v.cells[0].restarts.eventStream = "maybe"; }, /restarts/],
    // v9's word for an app with no event in its stream, which said more than the stream shows.
    [(v) => { v.cells[0].restarts.eventStream = "clean"; }, /restarts/],
    [(v) => { v.cells[0].restarts.replaced = true; }, /restart claim contradicts/],
    [(v) => { delete v.cells[0].restarts.replaced; }, /restarts/],
    [(v) => { v.cells[0].requests += 1; v.cells[0].iterations += 1; }, /do not add up/],
    // The fixed rate runs at most 1000 VUs, each with at most one unfinished iteration: no completed
    // iteration at all, or 1001 unfinished, is refused.
    [(v) => { v.cells[0].iterations = 0; }, /^Error: corten fixture page: more unfinished iterations than the load has VUs$/],
    [(v) => { v.cells[0].iterations = v.cells[0].requests - 1001; }, /^Error: corten fixture page: more unfinished iterations than the load has VUs$/],
    [(v) => { v.finishedCommit = "e".repeat(40); }, /finishes at the commit/],
    [(v) => { v.cleanup.complete = false; }, /cleanup is not confirmed/],
    [(v) => { delete v.measurement.memoryClock; }, /the pass's CPU settings and measurement has fields/],
    [(v) => { v.measurement.memoryClock = "another clock"; }, /clock of its memory samples/],
    [(v) => { v.measurement.containerChecks = "the settings held through the load"; }, /a pass states what its container checks observed, and their limit/],
    [(v) => { delete v.measurement.containerChecks; }, /the pass's CPU settings and measurement has fields/],
    [(v) => { v.options.apps = []; v.cells = []; }, /at least one of its apps/],
    [(v) => { v.cells[0].latencyMaxMs = 1; }, /latency above k6's aggregate/],
    // More failures than requests, or failures outside the windows beyond the requests outside them.
    [(v) => { v.cells[0].failedRequests = 270001; }, /aggregate failures/],
    [(v) => { v.cells[0].failedRequests = 1; }, /aggregate failures/],
  ]) { const v = structuredClone(s); mutate(v); assert.throws(() => validateSoak(v), pattern); }
  // 1000 unfinished iterations, one per VU, reconcile and read: of the 270,001 starts, 999 whose
  // request k6 counted and the one it did not (soakArrivals bounds every start, not only the requests).
  { const v = structuredClone(s); v.cells[0].iterations = v.cells[0].requests - 999; assert.equal(validateSoak(v).cells[0].rate.held, true); }
  // A stop, an OOM kill or an exit with no start after it is an observation, not restart evidence:
  // saved with no restart, it reads.
  for (const mutate of [(r) => { r.runningAtEnd = false; }, (r) => { r.oomKilled = true; }, (r) => { r.events = [{ action: "die", atSeconds: 5 }]; r.eventStream = "seen"; }]) {
    const v = structuredClone(s); mutate(v.cells[0].restarts); validateSoak(v);
  }
  // A soak whose k6 dropped iterations did not run the fixed rate: stated, and not presented as a fixed-rate result.
  assert.equal(readDropped({ metrics: { dropped_iterations: { count: 37, rate: 0.02 } } }), 37);
  assert.equal(readDropped({ metrics: {} }), 0);
  const dropped = structuredClone(s);
  const behind = windows([...Array(29).fill(150), 149.5], (i) => (i === 29 ? 40 : 10), 60);
  // The 31 dropped iterations never started: the last interval started 31 fewer than scheduled.
  const droppedArrivals = onSchedule(); droppedArrivals[29] -= 31;
  dropped.cells = [soakCell({ windows: behind, requests: 269970, iterations: 269970, droppedIterations: 31, arrivals: droppedArrivals, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 50 })) })];
  assert.deepEqual(rateTotals(dropped.cells[0].rate), { requested: 150, seconds: 1800, scheduled: 270001, requests: 269970, droppedIterations: 31, shortfall: 0, allowance: 151, held: false });
  assert.ok(dropped.cells[0].rate.intervals.every((i) => i.held), "each interval is within the allowance; the drops alone fail the rate");
  validateSoak(dropped);
  const droppedText = soakReport(dropped);
  assert.match(droppedText, /^\| corten \| fixture \| page \| not held \|/m);
  assert.match(droppedText, /^corten fixture page: k6 recorded 269970 requests and dropped 31 iterations; the schedule has at most 270001 arrivals, so 0 are not accounted for \(allowance 151\)\. 30 of 30 intervals held the rate\.$/m);
  assert.match(droppedText, /^corten fixture page: the fixed 150 requests\/second was not held, so this is not a fixed-rate result/m);
  for (const [mutate, pattern] of [[(v) => { v.cells[0].rate.held = true; }, /rate/], [(v) => { v.cells[0].rate.requested = 20; }, /rate/],
    [(v) => { delete v.cells[0].rate; }, /a soak cell has fields its schema does not save, or lacks one it does/], [(v) => { v.cells[0].rate.met = true; }, /rate/]]) {
    const v = structuredClone(dropped); mutate(v); assert.throws(() => validateSoak(v), pattern);
  }
  assert.throws(() => summarizeSoak({ rate: 150, windows: long, tail: 0, unrecorded: 0, memory: [], before: held, after: held, events: [], arrivals: onSchedule() }), /dropped iterations/);
  assert.throws(() => steadyReport({ schema: "marketplace-results/v6" }), /not a/);
});

test("a report states its container checks only for the cells with a reading, and says so, and omits them when it has none", () => {
  const one = (kind, failure) => {
    const options = parseSteadyArgs([kind, "w8", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
    return savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...(kind === "convergence" ? { verdict: null } : {}), failure }]);
  };
  // A convergence pass whose only cell failed `settings`, and a soak whose only cell failed
  // `unconfirmed`: neither had the checks it would state, so neither report states them.
  const settings = one("convergence", "settings"), unconfirmed = one("soak", "unconfirmed");
  validateConvergence(settings); validateSoak(unconfirmed);
  // The saved text itself says which cells it describes, so a save whose only cell failed does not
  // claim, read alone, that its settings matched: it describes only what a cell with a reading rests on.
  for (const [name, saved] of [["convergence settings", settings], ["soak unconfirmed", unconfirmed]]) {
    assert.match(saved.measurement.containerChecks, /^what each cell with a reading rests on; a cell that failed has no reading, nor has a convergence cell whose tolerance reading gave none, and this says nothing of either: the app's and the load's settings/, name);
  }
  for (const [name, text] of [["convergence settings", convergenceReport(settings)], ["soak unconfirmed", soakReport(unconfirmed)]]) {
    assert.doesNotMatch(text, /^Container checks/m, name);
    assert.doesNotMatch(text, /matched what the pass records|delivered no update/, name);
    assert.doesNotMatch(text, /event stream for its app/, name);
    // Nor does it say a cell ran in a fresh container: it states the procedure instead.
    assert.doesNotMatch(text, /ran in a fresh container/, name);
    assert.match(text, /^No cell has a reading\. The pass's procedure gives each adapter, source and target a fresh container started by the timed round's cold start/m, name);
  }
  // A pass with one failed cell among readings scopes the line to the cells with a reading.
  const { containerChecks } = convergencePass().measurement;
  const partial = convergencePass(); partial.cells[2] = { app: partial.cells[2].app, source: partial.cells[2].source, target: partial.cells[2].target, verdict: null, failure: "settings" };
  Object.assign(partial.cleanup, { created: 32, removed: 32 });
  validateConvergence(partial);
  assert.ok(convergenceReport(partial).split("\n").includes(`Container checks (7 of 8 cells have a reading): ${containerChecks}.`));
  assert.ok(convergenceReport(convergencePass()).split("\n").includes(`Container checks (every cell has a reading): ${containerChecks}.`));
  assert.match(convergenceReport(partial), /^Each cell with a reading \(7 of 8\) ran in a fresh container started by the timed round's cold start/m);
  assert.match(convergenceReport(convergencePass()), /^Each cell ran in a fresh container started by the timed round's cold start/m);
});

test("a soak report's opening promises only what its table reports: observed restart evidence and qualifying events, for cells with a reading", () => {
  const options = parseSteadyArgs(["soak", "w11", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const failed = savedPass(options, [{ app: "corten", source: "fixture", target: "page", failure: "settings" }]);
  validateSoak(failed);
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const read = savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows(Array(30).fill(150), () => 10, 60), tail: 0, unrecorded: 0,
    requests: 270000, iterations: 270000, latencyMaxMs: 25, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 50 })), before: held, after: held, events: [], arrivals: onSchedule() }) }]);
  validateSoak(read);
  for (const text of [soakReport(failed), soakReport(read)]) {
    const opening = text.split("\n").find((l) => l.startsWith("This is not a timed round"));
    assert.ok(opening, text);
    assert.doesNotMatch(opening, /whether the app restarted|any exit, signal or OOM kill/);
    assert.match(opening, /for each cell with a reading, .*observed evidence that the app restarted.*the app's observed exit, signal and OOM events that qualify for the cell/);
  }
});
test("a convergence cell whose tolerance reading gave none (a zero last-60 s median) is not a reading, so neither report states container checks for it", () => {
  const zeroTail = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0];
  const { containerChecks } = convergencePass().measurement;
  const checksIn = (lines) => lines.filter((l) => l.startsWith("Container checks"));
  // A valid one-cell save with a zero tail median: "no reading" in both reports, and no checks.
  const options = parseSteadyArgs(["convergence", "w10", "--apps", "corten", "--targets", "page", "--sources", "fixture", "--minutes", "3"], apps, groupApps);
  const one = savedPass(options, [cellOf("corten", "fixture", "page", zeroTail)]);
  validateConvergence(one);
  assert.equal(one.cells[0].verdict.reason, "no-throughput");
  const oneReport = convergenceReport(one).split("\n"), oneLines = convergenceLines(likeRound(90), ["corten"], one);
  assert.ok(oneReport.includes("| corten | fixture | page | no reading: the last 60 s median is zero | 0.0 | 0 |"), oneReport.join("\n"));
  assert.ok(oneLines.includes("Reading: corten fixture page: no reading: the last 60 s median is zero."));
  assert.deepEqual([checksIn(oneReport), checksIn(oneLines)], [[], []]);
  // Every cell of a full pass with a zero tail median: no reading anywhere, so no checks either.
  const allZero = convergencePass(); allZero.cells = allZero.cells.map((c) => cellOf(c.app, c.source, c.target, zeroTail));
  validateConvergence(allZero);
  assert.deepEqual([checksIn(convergenceReport(allZero).split("\n")), checksIn(convergenceLines(likeRound(90), ["corten", "aspnet"], allZero))], [[], []]);
  // One such cell among readings: the steady report scopes the line to the 7 cells with a reading,
  // and the timed report still states the checks its readings rest on.
  const oneZero = convergencePass(); oneZero.cells[0] = cellOf("corten", "fixture", "page", zeroTail);
  assert.deepEqual(checksIn(convergenceReport(oneZero).split("\n")), [`Container checks (7 of 8 cells have a reading): ${containerChecks}.`]);
  assert.deepEqual(checksIn(convergenceLines(likeRound(90), ["corten", "aspnet"], oneZero)), [`Container checks: ${containerChecks}.`]);
});
test("a cell that did not fail sent a request: replay refuses a saved cell with none, by the rule capture applies, and a zero last-60 s median after earlier requests stays no reading", () => {
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  // A soak that started nothing: no arrival, no request, every scheduled slot dropped. Its memory
  // and restart observations would otherwise read as a measured cell.
  const idle = { app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 270000, failedRequests: 0, windows: windows(Array(30).fill(0), () => 10, 60),
    tail: 0, unrecorded: 0, requests: 0, iterations: 0, latencyMaxMs: null, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals: Array(30).fill(0) }) };
  const soakOptions = parseSteadyArgs(["soak", "w9", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const soak = savedPass(soakOptions, [idle], { commit: "d".repeat(40) });
  for (const read of [validateSoak, soakReport, steadyReport]) assert.throws(() => read(structuredClone(soak)), /^Error: corten fixture page: load sent no requests$/);
  // Capture checks the same rule: the runner calls reconcileCell on every cell it measured.
  assert.throws(() => reconcileCell(idle, fixedRateLoad.maxVUs), /: load sent no requests$/);
  // A convergence cell with no request at all is refused the same way, on replay and capture.
  const options = parseSteadyArgs(["convergence", "w10", "--apps", "corten", "--targets", "page", "--sources", "fixture", "--minutes", "3"], apps, groupApps);
  const w = windows(Array(12).fill(0));
  const none = { app: "corten", source: "fixture", target: "page", windows: w, tail: 0, unrecorded: 0, requests: 0, iterations: 0, latencyMaxMs: null, failedRequests: 0, verdict: flattenPoint(w) };
  const empty = savedPass(options, [none]);
  for (const read of [validateConvergence, convergenceReport, (x) => convergenceLines(likeRound(90), ["corten"], x)]) assert.throws(() => read(structuredClone(empty)), /^Error: corten fixture page: load sent no requests$/);
  assert.throws(() => reconcileCell(none, timedWarmupVus), /: load sent no requests$/);
  // Requests earlier in the pass and none in its last 60 s: valid, and "no reading".
  const zeroTail = { ...none, ...cellOf("corten", "fixture", "page", [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0]), tail: 0 };
  zeroTail.requests -= 3; zeroTail.iterations -= 3;
  reconcileCell(zeroTail, timedWarmupVus);
  const late = savedPass(options, [zeroTail]);
  assert.equal(validateConvergence(late).cells[0].verdict.reason, "no-throughput");
  assert.ok(convergenceLines(likeRound(90), ["corten"], late).includes("Reading: corten fixture page: no reading: the last 60 s median is zero."));
});
test("a soak report lists only the observed events that qualify for the cell, never claiming the whole stream", () => {
  const options = parseSteadyArgs(["soak", "w9", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const cell = { app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows(Array(30).fill(150), () => 10, 60), tail: 0, unrecorded: 0,
    requests: 270000, iterations: 270000, latencyMaxMs: 25, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 50 })), before: held, after: held, events: [], arrivals: onSchedule() }) };
  const s = savedPass(options, [cell]);
  validateSoak(s);
  const text = soakReport(s);
  // A delivered app signal stamped after the load finished and received after the second marker
  // start is teardown, which readEvents leaves out: the report does not say it lists every event.
  assert.doesNotMatch(text, /read in full|every other event the stream delivered/);
  assert.match(text, /"Exits, signals, OOM" lists the app's observed events that qualify for the cell, excluding teardown \(an event received after the marker's second start and stamped after the load finished\)/);
});

test("a soak says the fixed rate held only when k6's counts reconcile with the schedule, and never claims more than k6 recorded", () => {
  // 1,800 requests over 30 min at a 150 req/s target, nothing dropped: the schedule has 270,001
  // arrivals, so the rate did not hold, although k6 reported no drop.
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const sparse = windows(Array(30).fill(1), () => 10, 60);
  const cell = summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: sparse, tail: 0, unrecorded: 0, requests: 1800, iterations: 1800, latencyMaxMs: 25,
    memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals: Array(30).fill(60) });
  assert.deepEqual(rateTotals(cell.rate), { requested: 150, seconds: 1800, scheduled: 270001, requests: 1800, droppedIterations: 0, shortfall: 268201, allowance: 151, held: false });
  const options = parseSteadyArgs(["soak", "w5", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const s = savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...cell }], { commit: "d".repeat(40) });
  validateSoak(s);
  const text = soakReport(s);
  assert.match(text, /^\| corten \| fixture \| page \| not held \|/m);
  assert.match(text, /^corten fixture page: k6 recorded 1800 requests and dropped 0 iterations; the schedule has at most 270001 arrivals, so 268201 are not accounted for \(allowance 151\)\. 0 of 30 intervals held the rate; not held: interval 0 from 0 s, 60 arrivals of 9001 scheduled; /m);
  assert.match(text, /the fixed 150 requests\/second was not held, so this is not a fixed-rate result/);
  assert.doesNotMatch(text, /\| held \|/);
  // A saved soak that claims the rate held is refused.
  const forged = structuredClone(s); forged.cells[0].rate.held = true;
  assert.throws(() => validateSoak(forged), /fixed-rate claim contradicts/);
  // Within the allowance it held; one arrival beyond it did not; more than the schedule is refused.
  const rate = { rate: 150, seconds: 1800, windowSeconds: 60 }, oneDropped = onSchedule(); oneDropped[29] -= 1;
  assert.equal(soakArrivals({ ...rate, requests: 270001 - 151, iterations: 270001 - 151, droppedIterations: 0, arrivals: onSchedule(), completions: served(onSchedule(), 270001 - 151) }).held, true);
  assert.equal(soakArrivals({ ...rate, requests: 270001 - 152, iterations: 270001 - 152, droppedIterations: 0, arrivals: onSchedule(), completions: served(onSchedule(), 270001 - 152) }).held, false);
  assert.equal(soakArrivals({ ...rate, requests: 270000, iterations: 270000, droppedIterations: 1, arrivals: oneDropped, completions: served(oneDropped, 270000) }).held, false);
  assert.throws(() => soakArrivals({ ...rate, requests: 270001, iterations: 270001, droppedIterations: 1, arrivals: onSchedule(), completions: served(onSchedule(), 270001) }), /more requests and dropped iterations than the fixed rate schedules|arrivals per interval do not reconcile/);
  // The schedule per interval adds up to the whole schedule, the boundary slot in the last interval.
  assert.equal(onSchedule().reduce((a, b) => a + b, 0), 270001);
  // Slot 0 at 0 s puts 9,001 in the first interval; 1,800 s is not a whole number of 6,666,666 ns
  // ticks, so no boundary slot lands on the very end, and the last holds 9,000.
  assert.deepEqual([onSchedule()[0], onSchedule()[1], onSchedule()[29]], [9001, 9000, 9000]);
  // At 125 requests/second the tick is exactly 8 ms, so the boundary slot at 1,800 s goes to the last interval.
  assert.deepEqual([onSchedule(30, 60, 125)[0], onSchedule(30, 60, 125)[29]], [7500, 7501]);
  // Arrivals that do not reconcile with k6's requests and drops, or are not one count per interval, are refused.
  for (const arrivals of [Array(30).fill(0), onSchedule().slice(1), [...onSchedule().slice(0, 29), "9001"], undefined])
    assert.throws(() => soakArrivals({ ...rate, requests: 270000, iterations: 270000, droppedIterations: 0, arrivals, completions: served(onSchedule(), 270000) }), /arrivals/);
  // Completions that are not one count per interval, or add up to more than k6's requests, are refused.
  for (const completions of [undefined, served(onSchedule(), 270000).slice(1), [...served(onSchedule(), 270000).slice(0, 29), "9000"], served(onSchedule(), 270001)])
    assert.throws(() => soakArrivals({ ...rate, requests: 270000, iterations: 270000, droppedIterations: 0, arrivals: onSchedule(), completions }), /^AssertionError \[ERR_ASSERTION\]: a soak counts the requests completed in each interval, no more than k6's requests$/);
});

test("a soak says held only when every interval matched its share of the schedule within tolerance, and names those that did not", () => {
  // All 270,000 requests arrived in the first minute: the totals match the schedule, the later 29
  // intervals are empty, and the rate was not sustained.
  const concentrated = [270001, ...Array(29).fill(0)];
  const rate = soakArrivals({ rate: 150, seconds: 1800, windowSeconds: 60, requests: 270000, iterations: 270000, droppedIterations: 0, arrivals: concentrated, completions: served(concentrated, 270000) });
  assert.deepEqual([rate.shortfall, rate.held], [1, false]);
  assert.deepEqual(rate.intervals.filter((i) => !i.held).map((i) => i.index), Array.from({ length: 30 }, (_, i) => i));
  // One interval short (a minute at half the rate, the next catching up) is named on its own.
  const uneven = onSchedule(); uneven[10] -= 4500; uneven[11] += 4500;
  assert.deepEqual(soakArrivals({ rate: 150, seconds: 1800, windowSeconds: 60, requests: 270000, iterations: 270000, droppedIterations: 0, arrivals: uneven, completions: served(uneven, 270000) }).intervals.filter((i) => !i.held).map((i) => i.index), [10, 11]);
  // Within the allowance of one second's arrivals plus one, an interval held.
  const edge = onSchedule(); edge[3] -= 151; edge[4] += 151;
  assert.equal(soakArrivals({ rate: 150, seconds: 1800, windowSeconds: 60, requests: 270000, iterations: 270000, droppedIterations: 0, arrivals: edge, completions: served(edge, 270000) }).held, true);

  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const cell = (arrivals) => ({ app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows([270000 / 60, ...Array(29).fill(0)], () => 10, 60),
    tail: 0, unrecorded: 0, requests: 270000, iterations: 270000, latencyMaxMs: 25, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals }) });
  const options = parseSteadyArgs(["soak", "w9", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const s = savedPass(options, [cell(concentrated)], { commit: "d".repeat(40) });
  validateSoak(s);
  const text = soakReport(s);
  assert.match(text, /^\| corten \| fixture \| page \| not held \|/m);
  assert.match(text, /0 of 30 intervals held the rate; not held: interval 0 from 0 s, 270001 arrivals of 9001 scheduled; interval 1 from 60 s, 0 arrivals of 9000 scheduled;/);
  assert.match(text, /the fixed 150 requests\/second was not held, so this is not a fixed-rate result/);
  assert.match(text, /"held" means the rate matched the schedule within tolerance in every recorded interval:/);
  assert.doesNotMatch(text, /sustained throughout/);
  // A saved soak that claims it held, or forges an interval's claim or schedule, is refused: the reader recomputes them from the arrivals.
  for (const mutate of [(v) => { v.cells[0].rate.held = true; }, (v) => { for (const i of v.cells[0].rate.intervals) i.held = true; }, (v) => { v.cells[0].rate.intervals[1].scheduled = 0; v.cells[0].rate.intervals[1].held = true; },
    (v) => { v.cells[0].rate.intervals.pop(); }, (v) => { delete v.cells[0].rate.intervals; }])
  { const v = structuredClone(s); mutate(v); assert.throws(() => validateSoak(v), /rate/); }
  // A sustained soak reads held, with every interval held.
  const steady = savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows(Array(30).fill(150), () => 10, 60),
    tail: 0, unrecorded: 0, requests: 270000, iterations: 270000, latencyMaxMs: 25, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals: onSchedule() }) }], { commit: "d".repeat(40) });
  assert.match(soakReport(steady), /^\| corten \| fixture \| page \| held \|/m);
  assert.match(soakReport(steady), /30 of 30 intervals held the rate\.$/m);
});

test("a soak refuses counts whose requests completed before their iterations started, whatever the totals", () => {
  // Every iteration started on schedule (9,001 by the end of the first minute), k6 dropped none, and
  // the totals reconcile, but 270,000 requests completed in the first minute: more than had started.
  const front = [270000, ...Array(29).fill(0)];
  const counts = { rate: 150, seconds: 1800, windowSeconds: 60, requests: 270000, iterations: 270000, droppedIterations: 0, arrivals: onSchedule() };
  const order = /^AssertionError \[ERR_ASSERTION\]: more requests completed by the end of interval 0 than iterations had started by then$/;
  assert.throws(() => soakArrivals({ ...counts, completions: front }), order);
  // One completion too many at a later boundary is refused there; exactly as many as started is not.
  const late = served(onSchedule(), 270000); late[3] += 1; late[4] -= 1;
  assert.throws(() => soakArrivals({ ...counts, completions: late }), /more requests completed by the end of interval 3 than iterations had started by then/);
  assert.equal(soakArrivals({ ...counts, completions: served(onSchedule(), 270000) }).held, true);
  // The runner's summary refuses it, and so does the reader of a saved soak with those windows.
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const soak = (w) => summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: w, tail: 0, unrecorded: 0, requests: 270000, iterations: 270000, latencyMaxMs: 25,
    memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals: onSchedule() });
  const frontWindows = windows(front.map((n) => n / 60), () => 10, 60);
  assert.throws(() => soak(frontWindows), order);
  const options = parseSteadyArgs(["soak", "w9", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const s = savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...soak(windows(Array(30).fill(150), () => 10, 60)) }], { commit: "d".repeat(40) });
  validateSoak(s);
  const forged = structuredClone(s);
  Object.assign(forged.cells[0], { windows: frontWindows, p99: { first: 20, last: null, max: 20 } });
  assert.throws(() => validateSoak(forged), /^Error: more requests completed by the end of interval 0 than iterations had started by then$/);
});

test("a soak refuses a backlog of started iterations larger than the load's VUs can hold in flight", () => {
  assert.equal(fixedRateLoad.maxVUs, 1000);
  const counts = { rate: 150, seconds: 1800, windowSeconds: 60, requests: 270001, iterations: 270001, droppedIterations: 0, arrivals: onSchedule() };
  // Every arrival on schedule and no request completed in any interval: all 270,001 in the
  // graceful-stop tail. 9,001 iterations were outstanding at the first boundary, with 1,000 VUs.
  const none = Array(30).fill(0);
  const backlog = /^AssertionError \[ERR_ASSERTION\]: more iterations were outstanding at the end of interval 0 than the load's 1000 VUs hold in flight$/;
  assert.throws(() => soakArrivals({ ...counts, completions: none }), backlog);
  // A realistic lag: 300 requests in flight at every boundary, answered in the next interval, the
  // last 300 in the graceful stop. It holds the rate.
  const lagged = onSchedule().map((n, i) => (i === 0 ? n - 300 : n));
  assert.equal(soakArrivals({ ...counts, completions: lagged }).held, true);
  // Exactly the VUs outstanding at a boundary is possible; one more is not, whatever the graceful
  // stop later cut off: work lost at the stop does not explain a backlog in an earlier interval.
  const at = (outstanding) => onSchedule().map((n, i) => (i === 4 ? n - outstanding : i === 5 ? n + outstanding : n));
  assert.equal(soakArrivals({ ...counts, completions: at(1000) }).held, true);
  assert.throws(() => soakArrivals({ ...counts, completions: at(1001) }), /^AssertionError \[ERR_ASSERTION\]: more iterations were outstanding at the end of interval 4 than the load's 1000 VUs hold in flight$/);
  // At the last boundary too: 1,001 still outstanding when the intervals ended.
  const last = onSchedule().map((n, i) => (i === 29 ? n - 1001 : n));
  assert.throws(() => soakArrivals({ ...counts, completions: last }), /outstanding at the end of interval 29 than the load's 1000 VUs hold in flight$/);
  assert.equal(soakArrivals({ ...counts, completions: onSchedule().map((n, i) => (i === 29 ? n - 1000 : n)) }).held, true);
  // The runner's summary refuses the zero-completion counts, and so does the reader of a saved soak.
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const intervals = (completions) => completions.map((n, index) => ({ index, startSeconds: index * 60, seconds: 60, requests: n, failed: 0, rps: n / 60, p95: n ? 10 : null, p99: n ? 20 : null }));
  const soak = (completions, tail) => summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: intervals(completions), tail, unrecorded: 0, requests: 270001, iterations: 270001, latencyMaxMs: 25,
    memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals: onSchedule() });
  assert.throws(() => soak(none, 270001), backlog);
  // The same counts with every request the graceful stop cut off unrecorded instead, and no iteration
  // finished: 270,001 arrivals, 270,001 unrecorded, no completion in any interval.
  const unrecordedSoak = () => summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: intervals(none), tail: 0, unrecorded: 270001, requests: 270001, iterations: 0, latencyMaxMs: 25,
    memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals: onSchedule() });
  assert.throws(unrecordedSoak, backlog);
  const options = parseSteadyArgs(["soak", "w9", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const s = savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...soak(lagged, 300) }], { commit: "d".repeat(40) });
  assert.equal(validateSoak(s).cells[0].rate.held, true);
  const forged = structuredClone(s);
  Object.assign(forged.cells[0], { windows: intervals(none), tail: 270001, p99: { first: null, last: null, max: null } });
  assert.throws(() => validateSoak(forged), /^Error: more iterations were outstanding at the end of interval 0 than the load's 1000 VUs hold in flight$/);
  // A saved soak with those counts unrecorded (270,001 requests, none of them a finished iteration):
  // the reader refuses it rather than reading it held, already on its totals, since 270,001 unfinished
  // iterations are more than the load's 1000 VUs hold (the runner's summary above refuses the same
  // counts at the first boundary).
  const unrecorded = structuredClone(s);
  Object.assign(unrecorded.cells[0], { windows: intervals(none), tail: 0, unrecorded: 270001, requests: 270001, iterations: 0, p99: { first: null, last: null, max: null } });
  assert.throws(() => validateSoak(unrecorded), /^Error: corten fixture page: more unfinished iterations than the load has VUs$/);
});

test("a soak refuses more unfinished starts than the load's VUs, counting an iteration that never reached k6's request counter", () => {
  // 270,001 iterations started on schedule, k6 counted 270,000 requests, all completed in an
  // interval, and the start it did not count never made its request. Each VU holds one iteration from
  // its start until it completes, so with 1,000 VUs at most 1,000 of the 270,001 starts are
  // unfinished: 269,001 completed iterations is possible, 269,000 is not, though k6's requests less
  // its completed iterations (999 or 1,000) are within the VUs either way.
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const completions = served(onSchedule(), 270000);
  const intervals = completions.map((n, index) => ({ index, startSeconds: index * 60, seconds: 60, requests: n, failed: 0, rps: n / 60, p95: n ? 10 : null, p99: n ? 20 : null }));
  const soak = (iterations) => summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: intervals, tail: 0, unrecorded: 0, requests: 270000, iterations, latencyMaxMs: 25,
    memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 60 })), before: held, after: held, events: [], arrivals: onSchedule() });
  const unfinished = /^AssertionError \[ERR_ASSERTION\]: more iterations started without completing than the load's 1000 VUs hold$/;
  const counts = { rate: 150, seconds: 1800, windowSeconds: 60, requests: 270000, droppedIterations: 0, arrivals: onSchedule(), completions };
  assert.equal(soakArrivals({ ...counts, iterations: 269001 }).held, true);
  assert.throws(() => soakArrivals({ ...counts, iterations: 269000 }), unfinished);
  // The runner's summary: exactly 1,000 unfinished starts reads held; 1,001 is refused.
  assert.equal(soak(269001).rate.held, true);
  assert.throws(() => soak(269000), unfinished);
  // The reader of a saved soak: the same boundary, from the saved arrivals and completed iterations.
  const options = parseSteadyArgs(["soak", "w9", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const s = savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...soak(269001) }], { commit: "d".repeat(40) });
  assert.equal(validateSoak(s).cells[0].rate.held, true);
  const forged = structuredClone(s); forged.cells[0].iterations = 269000;
  assert.equal(forged.cells[0].rate.held, true);
  assert.throws(() => validateSoak(forged), /^Error: more iterations started without completing than the load's 1000 VUs hold$/);
});

test("memory that cannot be read leaves the restart, stop and OOM observations in place", () => {
  const before = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const after = { ...before, running: false, oomKilled: true };
  const w = windows(Array(30).fill(150), () => 10, 60);
  const base = { rate: 150, droppedIterations: 0, failedRequests: 0, windows: w, tail: 0, unrecorded: 0, requests: 270000, iterations: 270000, latencyMaxMs: 25, before, after, events: [{ action: "oom", atSeconds: 900 }], arrivals: onSchedule() };
  // A zero sample (an app the kernel killed reads 0 B), and a sampler that failed outright.
  const zero = summarizeSoak({ ...base, memory: [{ atSeconds: 1, mib: 60 }, { atSeconds: 1799, mib: 0 }] });
  assert.deepEqual(zero.memory, { samples: 2, unavailable: "1 memory sample had no time or no positive size", startMiB: null, endMiB: null, growthMiB: null, growthPct: null });
  assert.deepEqual(zero.restarts, { restarted: false, restartCount: 0, replaced: false, eventStream: "seen", events: [{ action: "oom", atSeconds: 900 }], runningAtEnd: false, oomKilled: true });
  const failed = summarizeSoak({ ...base, memory: null });
  assert.equal(failed.memory.unavailable, "memory sampling failed");
  assert.equal(failed.restarts.oomKilled, true);
  const options = parseSteadyArgs(["soak", "w6", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const s = savedPass(options, [{ app: "corten", source: "fixture", target: "page", ...zero }], { commit: "d".repeat(40) });
  validateSoak(s);
  const text = soakReport(s);
  assert.match(text, /^\| corten \| fixture \| page \| held \| unavailable \| unavailable \| unavailable \| .* \| OOM kill \(oom\) at 900 s, not running at the end, OOM-killed at the end \| no \|$/m);
  assert.match(text, /^corten fixture page: memory unavailable \(1 memory sample had no time or no positive size\); its restart, stop and OOM observations are still reported\.$/m);
  for (const mutate of [(v) => { v.cells[0].memory.unavailable = "something Docker said"; }, (v) => { v.cells[0].memory.startMiB = 60; }]) {
    const v = structuredClone(s); mutate(v); assert.throws(() => validateSoak(v), /unavailable memory/);
  }
});

test("the timed reporter lists every differing or missing input and never judges the warmup", () => {
  assert.throws(() => convergenceLines(likeRound(), ["corten"], null), /reads a convergence pass/);
  const lines = convergenceLines(likeRound(), ["corten", "aspnet"], convergencePass());
  assert.match(lines[0], /^Convergence evidence: pass w3 \(marketplace-convergence\/v8, reading marketplace-tolerance\/v4\), measured at commit `c{40}`\. Host CPU model: compared by its SHA-256, not printed\. One 32-user closed-loop pass .* after the timed round's cold start \(the app created, then started while a sidecar polls the target's path to its first 200\)\.$/);
  // The API-source cells have readings but are not compared: nothing in the pass shows their requests went through the upstream.
  assert.equal(lines[1], "Coverage: the pass has a reading for 4 of this round's 8 measured adapter, source and target cells (corten fixture page, corten fixture json, aspnet fixture page, aspnet fixture json); not compared, the pass does not record that the requests of these API-source cells reached the upstream: corten api page, corten api json, aspnet api page, aspnet api json.");
  assert.match(lines[2], /^The pass is like-for-like with this round for its 4 cells with a reading only, on every input compared for them: commit, group, adapter images, .* startup timeout, memory limits, response encoding, .* rotating page locales and a timed warmup with no failed request\. It says nothing about this round's other cells\.$/);
  assert.ok(!lines.some((l) => /like-for-like with this round on every input/.test(l)), "never like-for-like with a round whose API source the pass does not show it exercised");
  assert.match(lines[3], /^Tolerance reading marketplace-tolerance\/v4: a screening reading of throughput, not a certificate of steady state\./);
  assert.ok(lines.includes("Reading: aspnet api page: within the stated tolerance from the window ending at 90 s (not compared with this round: the pass does not record that this cell's requests reached the upstream)."));
  assert.ok(lines.includes("Reading: corten fixture json: within the stated tolerance from the window ending at 15 s."));
  const judged = (warmup) => `This report does not establish whether this round's ${warmup}s timed warmup was sufficient: the pass is a screening reading of throughput, and a timed warmup is set only by a separate reviewed change from a saved like-for-like pass.`;
  assert.equal(lines.at(-1), judged(10));
  // Even a like-for-like pass whose readings all start before the warmup's end is not a conclusion.
  const long = convergenceLines(likeRound(300), ["corten"], convergencePass());
  assert.equal(long.at(-1), judged(300));
  for (const text of [lines, long]) assert.ok(!text.some((l) => /reaches|is shorter than|is enough|supports|establishes|was sufficient\b(?!:)/.test(l.replace(/^This report does not establish whether [^:]*:/, ""))), text.join("\n"));

  const pass = convergencePass(), explore = convergencePass(); explore.options.vus = 64;
  const host = likeRound().host;
  const withMeasurement = (change) => { const round = likeRound(90); change(round.measurement); return round; };
  const unpinnedPass = convergencePass(); unpinnedPass.measurement.cpus = cpuSettings({});
  const unlike = [
    [{ ...likeRound(90), commit: "a".repeat(40) }, pass, /the pass measured another commit than this round/],
    [{ ...likeRound(90), options: { warmup: 90, startupTimeout: 120, group: "production" } }, pass, /the pass ran no group and this round a group, so their images and container settings differ/],
    [{ ...likeRound(90), apps: { corten: { imageId: `sha256:${"3".repeat(64)}`, runs: runs() } } }, pass, /the image IDs differ for corten/],
    [{ ...likeRound(90), apps: { corten: { runs: runs() } } }, pass, /image IDs are not recorded on both sides for corten/],
    [withMeasurement((m) => { m.cpus.app.quota = 2; }), pass, /the app CPU quota differs(;|\.$)/],
    [withMeasurement((m) => { m.cpus = cpuSettings({ ...pinnedEnv, MARKETPLACE_APP_CPUS: "0" }); }), pass, /the app CPU pinning \(cpuset\) differs(;|\.$)/],
    // Missing pinning is missing on either side, not equal because both are absent.
    [withMeasurement((m) => { m.cpus = cpuSettings({}); }), pass, /the app CPU pinning \(cpuset\) is not recorded on both sides \(pass: recorded; round: not recorded\)/],
    [withMeasurement((m) => { m.cpus = cpuSettings({}); }), unpinnedPass, /the app CPU pinning \(cpuset\) is not recorded on both sides \(pass: not recorded; round: not recorded\)/],
    [{ ...likeRound(90), measurement: {} }, pass, /the app CPU quota is not recorded on both sides/],
    [withMeasurement((m) => { m.appMemoryBytes = 2 ** 31; }), pass, /the app memory limit \(bytes\) differs(;|\.$)/],
    [withMeasurement((m) => { delete m.upstreamMemoryBytes; }), pass, /the upstream memory limit \(bytes\) is not recorded on both sides/],
    [withMeasurement((m) => { m.encoding = "br"; }), pass, /the response encoding differs(;|\.$)/],
    [{ ...likeRound(90), options: { warmup: 90, startupTimeout: 60 } }, pass, /the startup timeout \(s\) differs(;|\.$)/],
    [{ ...likeRound(90), options: { warmup: 90 } }, pass, /the startup timeout \(s\) is not recorded on both sides/],
    [{ ...likeRound(90), host: { ...host, cpu: "Another CPU" } }, pass, /the host CPU differs(;|\.$)/],
    [{ ...likeRound(90), host: {} }, pass, /the host CPU is not recorded on both sides \(pass: recorded; round: not recorded\)/],
    [likeRound(90), explore, /the pass ran 64 users, the timed warmup 32/],
    [{ ...likeRound(90), split: { droplets: 2, parts: [] } }, pass, /split across droplets/],
    [{ ...likeRound(90), fixtureSha256: "e".repeat(64) }, pass, /the fixture SHA-256 differs/],
    [{ ...likeRound(90), fixtureSha256: undefined }, pass, /the fixture SHA-256 is not recorded on both sides \(pass: recorded; round: not recorded\)/],
    [{ ...likeRound(90), tools: { ...tools, upstream: { imageId: `sha256:${"6".repeat(64)}` } } }, pass, /the upstream image ID differs/],
    [{ ...likeRound(90), tools: {} }, pass, /the upstream image ID is not recorded on both sides/],
    [{ ...likeRound(90), tools: { ...tools, k6: { imageId: `sha256:${"6".repeat(64)}` } } }, pass, /the k6 image ID differs/],
    [{ ...likeRound(90), host: { ...host, release: "6.8.0-other" } }, pass, /the kernel release differs(;|\.$)/],
    [{ ...likeRound(90), host: { ...host, onlineCpus: "0-3" } }, pass, /the online CPU set differs(;|\.$)/],
    [{ ...likeRound(90), schema: v5Schema }, pass, /this round's page warmup used one locale per profile, while the pass rotates locales/],
    [{ ...likeRound(90), schema: undefined }, pass, /this round's page warmup does not record its locale profiles/],
    // A timed warmup that itself failed requests, or does not say, makes the round not comparable.
    [{ ...likeRound(90), apps: { corten: { imageId: imageIds.corten, runs: runs(3) } } }, pass, /this round's timed warmup had 3 failed requests for corten in 1 run, so it is not comparable/],
    [{ ...likeRound(90), apps: { corten: { imageId: imageIds.corten, runs: { "fixture-json": [{ warmup: { requests: 5 } }] } } } }, pass, /this round does not record the failed requests of corten's timed warmup in 1 run/],
    [{ ...likeRound(90), apps: { corten: { imageId: imageIds.corten } } }, pass, /this round records no timed warmup for corten/],
  ];
  for (const [round, p, reason] of unlike) {
    const text = convergenceLines(round, ["corten"], p);
    assert.match(text[2], /^The pass is not like-for-like with this round for its 2 cells with a reading\. Differing or missing inputs: /);
    assert.match(text[2], reason);
    assert.ok(text.some((l) => /^Reading: corten fixture page: /.test(l)), "the readings stay listed");
    assert.equal(text.at(-1), judged(90));
  }
  // A startup other than the timed cold start is a difference; a reader refuses a code it does not
  // know, so this is reached only through unlikeRound itself.
  assert.ok(unlikeRound(likeRound(90), ["corten"], { ...pass, startup: "another-start/v0" }).includes("the pass started each app another way than the timed round's cold start"));
  const missing = convergenceLines(likeRound(), ["corten", "drogon"], convergencePass());
  // Coverage is stated before any comparison, and inputs are compared for the cells with a reading only.
  assert.equal(missing[1], "Coverage: the pass has a reading for 2 of this round's 8 measured adapter, source and target cells (corten fixture page, corten fixture json); not compared, the pass does not record that the requests of these API-source cells reached the upstream: corten api page, corten api json; no convergence pass for: drogon fixture page, drogon fixture json, drogon api page, drogon api json.");
  assert.match(missing[2], /^The pass is like-for-like with this round for its 2 cells with a reading only, on every input compared for them: .* It says nothing about this round's other cells\.$/);
  assert.ok(!missing.some((l) => /like-for-like with this round on every input/.test(l)), "never like-for-like with the whole round");
  const fallingOptions = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "5"], apps, groupApps);
  const falling = savedPass(fallingOptions, fallingOptions.sources.flatMap((source) => fallingOptions.apps.flatMap((app) => fallingOptions.targets.map((target) =>
    cellOf(app, source, target, Array.from({ length: 20 }, (_, i) => (app === "corten" && source === "fixture" && target === "page" ? 1500 - 25 * i : 1000)))))));
  const fallingText = "not within tolerance at the end: the median of the first 60 s and the median of the 60 s before the last 60 s are each more than 5% above the last 60 s median";
  assert.ok(convergenceLines(likeRound(90), ["corten"], falling).includes(`Reading: corten fixture page: ${fallingText}.`));
  assert.ok(convergenceReport(falling).includes(`| corten | fixture | page | ${fallingText} |`));
  const forged = convergencePass(); forged.cells[0] = cellOf("corten", "fixture", "page", Array.from({ length: 12 }, (_, i) => 500 + 50 * i));
  forged.cells[0].verdict = { withinTolerance: true, window: 0, fromSeconds: 15, tailRps: 1, previousRps: 1, headRps: 1 };
  assert.throws(() => convergenceLines(likeRound(), ["corten"], forged), /saved verdict differs/);
});

test("a pass is compared with a round only for the cells it has readings for, and like-for-like with the whole round only when it covers it", () => {
  const judged = "This report does not establish whether this round's 90s timed warmup was sufficient: the pass is a screening reading of throughput, and a timed warmup is set only by a separate reviewed change from a saved like-for-like pass.";
  // A JSON-only pass against a round whose metadata matches it on every input: it has no page
  // reading, so it says nothing about page locales and is like-for-like with its own cells only.
  const jsonOptions = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "3", "--targets", "json"], apps, groupApps);
  const jsonOnly = savedPass(jsonOptions, jsonOptions.sources.flatMap((source) => jsonOptions.apps.flatMap((app) => [cellOf(app, source, "json", Array(12).fill(1000))])), { commit: "c".repeat(40) });
  for (const round of [likeRound(90), { ...likeRound(90), schema: v5Schema }]) {
    const lines = convergenceLines(round, ["corten", "aspnet"], jsonOnly);
    assert.equal(lines[1], "Coverage: the pass has a reading for 2 of this round's 8 measured adapter, source and target cells (corten fixture json, aspnet fixture json); not compared, the pass does not record that the requests of these API-source cells reached the upstream: corten api json, aspnet api json; no convergence pass for: corten fixture page, corten api page, aspnet fixture page, aspnet api page.");
    assert.match(lines[2], /^The pass is like-for-like with this round for its 2 cells with a reading only, on every input compared for them: .* the cold start before the load, a timed warmup with no failed request\. It says nothing about this round's other cells\.$/);
    assert.ok(!lines.some((l) => /locale/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /like-for-like with this round on every input/.test(l)));
    assert.equal(lines.at(-1), judged);
  }
  // A pass whose every cell failed has no reading: it is compared on no input and its failures are
  // stated in the coverage line before anything else.
  const allFailed = convergencePass();
  allFailed.cells = allFailed.cells.map((c) => ({ app: c.app, source: c.source, target: c.target, failure: "load-exit", verdict: null }));
  const failedLines = convergenceLines(likeRound(90), ["corten", "aspnet"], allFailed);
  assert.equal(failedLines[1], "Coverage: the pass has a reading for 0 of this round's 8 measured adapter, source and target cells; no reading, the cell failed: corten fixture page, corten fixture json, corten api page, corten api json, aspnet fixture page, aspnet fixture json, aspnet api page, aspnet api json.");
  assert.equal(failedLines[2], "No cell of this round has a reading in the pass, so the pass is not compared with this round on any input.");
  // The closing line's "a saved like-for-like pass" is about how a warmup is set, not this pass.
  assert.ok(!failedLines.slice(0, -1).some((l) => /like-for-like|locale|matched/.test(l)), failedLines.join("\n"));
  assert.equal(failedLines.filter((l) => l.startsWith("Reading: ")).length, 8);
  assert.equal(failedLines.at(-1), judged);
  assert.ok(!failedLines.some((l) => l.startsWith("Container checks: ")), "no container checks line for a pass with no reading");
  // One failed cell makes coverage partial even with every other cell read, and the failed cell's
  // app is still compared for the cells of it that have a reading.
  const oneFailed = convergencePass(); oneFailed.cells[0] = { app: "corten", source: "fixture", target: "page", failure: "load-exit", verdict: null };
  const partial = convergenceLines(likeRound(90), ["corten", "aspnet"], oneFailed);
  assert.match(partial[1], /^Coverage: the pass has a reading for 3 of this round's 8 .*; no reading, the cell failed: corten fixture page; not compared, .*: corten api page, corten api json, aspnet api page, aspnet api json\.$/);
  assert.match(partial[2], /^The pass is like-for-like with this round for its 3 cells with a reading only, on every input compared for them: .*rotating page locales and a timed warmup/);
  // A cell whose tolerance reading is itself "no reading" (a zero last-60 s median) keeps its
  // explanation but is not coverage and is compared on no input.
  const zeroTail = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0];
  const oneZero = convergencePass(); oneZero.cells[0] = cellOf("corten", "fixture", "page", zeroTail);
  assert.equal(oneZero.cells[0].verdict.reason, "no-throughput");
  const zeroLines = convergenceLines(likeRound(90), ["corten", "aspnet"], oneZero);
  assert.equal(zeroLines[1], "Coverage: the pass has a reading for 3 of this round's 8 measured adapter, source and target cells (corten fixture json, aspnet fixture page, aspnet fixture json); no reading, the tolerance reading gave none: corten fixture page; not compared, the pass does not record that the requests of these API-source cells reached the upstream: corten api page, corten api json, aspnet api page, aspnet api json.");
  assert.match(zeroLines[2], /^The pass is like-for-like with this round for its 3 cells with a reading only, on every input compared for them: /);
  assert.ok(zeroLines.includes("Reading: corten fixture page: no reading: the last 60 s median is zero."));
  // Every page cell without a reading: the pass has no page reading, so page locales are not
  // compared, and a round whose page warmup used one locale per profile is like-for-like for the JSON cells.
  const pagesZero = convergencePass();
  pagesZero.cells = pagesZero.cells.map((c) => (c.target === "page" ? cellOf(c.app, c.source, c.target, zeroTail) : c));
  const pageLines = convergenceLines({ ...likeRound(90), schema: v5Schema }, ["corten", "aspnet"], pagesZero);
  assert.match(pageLines[1], /^Coverage: the pass has a reading for 2 of this round's 8 .*; no reading, the tolerance reading gave none: corten fixture page, corten api page, aspnet fixture page, aspnet api page; not compared, .*: corten api json, aspnet api json\.$/);
  assert.match(pageLines[2], /^The pass is like-for-like with this round for its 2 cells with a reading only, on every input compared for them: .* the cold start before the load, a timed warmup with no failed request\. It says nothing about this round's other cells\.$/);
  // No cell with a reading at all: compared on no input.
  const allZero = convergencePass(); allZero.cells = allZero.cells.map((c) => cellOf(c.app, c.source, c.target, zeroTail));
  const noneLines = convergenceLines(likeRound(90), ["corten", "aspnet"], allZero);
  assert.match(noneLines[1], /^Coverage: the pass has a reading for 0 of this round's 8 measured adapter, source and target cells; no reading, the tolerance reading gave none: /);
  assert.equal(noneLines[2], "No cell of this round has a reading in the pass, so the pass is not compared with this round on any input.");
  // An API-source pass whose every input matches the round: its readings are listed, but none is
  // compared, since the pass does not record that its requests reached the upstream.
  const apiOptions = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "3", "--sources", "api"], apps, groupApps);
  const apiOnly = savedPass(apiOptions, apiOptions.apps.flatMap((app) => apiOptions.targets.map((target) => cellOf(app, "api", target, Array(12).fill(1000)))), { commit: "c".repeat(40) });
  const apiLines = convergenceLines(likeRound(90), ["corten", "aspnet"], apiOnly);
  assert.equal(apiLines[1], "Coverage: the pass has a reading for 0 of this round's 8 measured adapter, source and target cells; not compared, the pass does not record that the requests of these API-source cells reached the upstream: corten api page, corten api json, aspnet api page, aspnet api json; no convergence pass for: corten fixture page, corten fixture json, aspnet fixture page, aspnet fixture json.");
  assert.equal(apiLines[2], "No cell of this round has a reading in the pass that is compared (an API-source cell's is not), so the pass is not compared with this round on any input.");
  assert.ok(!apiLines.slice(0, -1).some((l) => /like-for-like/.test(l)), apiLines.join("\n"));
  assert.ok(apiLines.includes("Reading: corten api json: within the stated tolerance from the window ending at 15 s (not compared with this round: the pass does not record that this cell's requests reached the upstream)."));
});
test("only the timed warmups of the profiles a pass is compared on decide whether it is like-for-like", () => {
  // A fixture and API JSON pass: its fixture JSON reading is compared, its API JSON one is listed only.
  const options = parseSteadyArgs(["convergence", "w3", "--apps", "corten", "--minutes", "3", "--targets", "json"], apps, groupApps);
  const pass = savedPass(options, options.sources.map((source) => cellOf("corten", source, "json", Array(12).fill(1000))), { commit: "c".repeat(40) });
  const withRuns = (extra) => { const round = likeRound(90); Object.assign(round.apps.corten.runs, extra); return round; };
  const like = /^The pass is like-for-like with this round for its 1 cell with a reading only, on every input compared for them: /;
  assert.match(convergenceLines(likeRound(90), ["corten"], pass)[2], like);
  // Failures only in warmups it is not compared on (the API JSON one, or the fixture page one) do
  // not change the fixture JSON reading's verdict.
  for (const round of [withRuns({ "api-json": [{ warmup: { requests: 1000, failed: 3 } }] }), { ...likeRound(90), apps: { corten: { imageId: imageIds.corten, runs: runs(3) } } }]) {
    const lines = convergenceLines(round, ["corten"], pass);
    assert.match(lines[2], like);
    assert.ok(!lines.some((l) => /failed requests for corten/.test(l)), lines.join("\n"));
  }
  // Failures in the compared profile's own warmup still make it not like-for-like.
  const covered = convergenceLines(withRuns({ "fixture-json": [{ warmup: { requests: 1000, failed: 3 } }] }), ["corten"], pass);
  assert.match(covered[2], /^The pass is not like-for-like with this round for its 1 cell with a reading. Differing or missing inputs: this round's timed warmup had 3 failed requests for corten in 1 run, so it is not comparable.$/);
  // A round with no warmup for the compared profile, only for others, is not like-for-like either.
  const elsewhere = convergenceLines({ ...likeRound(90), apps: { corten: { imageId: imageIds.corten, runs: { "fixture-rotating-page": [{ warmup: { requests: 1000, failed: 0 } }], "api-json": [{ warmup: { requests: 1000, failed: 0 } }] } } } }, ["corten"], pass);
  assert.match(elsewhere[2], /this round records no timed warmup for corten.$/);
});

test("a convergence cell refuses an app that stopped, restarted, was replaced or was OOM-killed", () => {
  const inspect = (o = {}) => ({ Id: "a".repeat(64), RestartCount: 0, ...o, State: { Running: true, OOMKilled: false, ExitCode: 0, StartedAt: "2026-11-20T00:00:00.000000001Z", ...o.State } });
  heldThrough(inspect(), inspect());
  for (const after of [inspect({ State: { OOMKilled: true } }), inspect({ State: { Running: false, ExitCode: 137 } }), inspect({ RestartCount: 1 }),
    // A docker restart keeps RestartCount and the ID but not StartedAt; another ID is another container.
    inspect({ State: { StartedAt: "2026-11-20T00:01:00.000000001Z" } }), inspect({ Id: "b".repeat(64) })])
    assert.throws(() => heldThrough(inspect(), after), /stopped, restarted, was replaced or was OOM-killed/);
  assert.throws(() => heldThrough({ RestartCount: 0, State: { Running: true } }, inspect()), /instance before the load is not recorded/);
  // Each snapshot is validated before they are compared: two missing counters, or the same malformed
  // or never-started StartedAt on both sides, are not the same instance.
  const noCount = inspect(); delete noCount.RestartCount;
  for (const [snapshot, which] of [[noCount, "before"], [inspect({ RestartCount: "0" }), "before"], [inspect({ State: { StartedAt: "not a time" } }), "before"],
    [inspect({ State: { StartedAt: "0001-01-01T00:00:00Z" } }), "before"], [inspect({ State: { StartedAt: "2026-13-45T00:00:00Z" } }), "before"], [inspect({ State: { Running: "true" } }), "before"]])
    assert.throws(() => heldThrough(snapshot, structuredClone(snapshot)), new RegExp(`^AssertionError \\[ERR_ASSERTION\\]: the app's instance ${which} the load is not recorded as a container ID, a StartedAt time, a RestartCount and its running and OOM states$`));
  assert.throws(() => heldThrough(inspect(), noCount), /instance after the load is not recorded/);
  // The app must be running, and not OOM-killed, before the load.
  for (const before of [inspect({ State: { Running: false } }), inspect({ State: { OOMKilled: true } })]) assert.throws(() => heldThrough(before, structuredClone(before)), /not running, or was OOM-killed, before the load/);
  assert.deepEqual(appBefore(inspect()), { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00.000000001Z", restartCount: 0, running: true, oomKilled: false });
  assert.deepEqual(appInstance(inspect({ State: { Running: false } }), "after").running, false);
  // steady-run.test.mjs shows the runner applying it to a cell whose app was OOM-killed or restarted under load.
});

test("a soak's app whose StartedAt after the load is a later start stamped before the load's own refuses the cell, read in nanoseconds", () => {
  const launched = { startedAt: "2026-11-20T00:00:00.000000001Z" }, load = "2026-11-20T00:01:00.000000500Z";
  const after = (startedAt) => ({ startedAt });
  // Unchanged, or started again at or after the load's own StartedAt (a restart during the load, the load's to read).
  for (const at of [launched.startedAt, load, "2026-11-20T00:01:00.000000501Z"]) startedBeforeLoad(launched, after(at), load);
  // Started again before the load: in the same millisecond, a nanosecond earlier, is still before.
  for (const at of ["2026-11-20T00:01:00.000000499Z", "2026-11-20T00:00:30Z"])
    assert.throws(() => startedBeforeLoad(launched, after(at), load), /^AssertionError \[ERR_ASSERTION\]: the app started again after the launch check and before the load started$/);
  // A time that is not one is refused with a fixed message naming no value.
  for (const [a, l] of [["not a time", load], [launched.startedAt, "0001-01-01T00:00:00Z"]])
    assert.throws(() => startedBeforeLoad(launched, after(a), l), /^AssertionError \[ERR_ASSERTION\]: the load's or the app's StartedAt is not a time$/);
});

test("a value from outside the checkout is saved only when it matches its pattern", () => {
  const canary = "leaked canary";
  for (const [kind, good, bad] of [
    ["kernel", "6.8.0-49-generic", [`6.8.0 ${canary}`, "linux", "6.8.0/../x"]],
    ["onlineCpus", "0-3,8-11", ["0-7;", `0-7 ${canary}`, "all"]],
    ["docker", "27.5.1", [`27.5.1 ${canary}`, "27.5.1-ce+abc", "v27.5.1"]],
    ["k6Version", "2.4.0", ["2.4.0-canary", "v2.4.0", "2.4"]],
    ["imageId", `sha256:${"a".repeat(64)}`, [`sha256:${"a".repeat(63)}`, `sha256:${"a".repeat(65)}`, `sha256:${"A".repeat(64)}`, `example.com/x@sha256:${"a".repeat(64)}`]],
    ["sha256", "f".repeat(64), ["f".repeat(63), `sha256:${"f".repeat(64)}`]],
    ["commit", "c".repeat(40), ["c".repeat(39), "C".repeat(40)]],
    ["path", "bench/marketplace/results/w2/summary.json", ["../w2/summary.json", "bench/./x", "/abs/path", "C:\\Users\\x", `bench/${canary}`]],
    ["label", "agent.owner=codex", [`a=${canary}`, "noequals"]],
    ["time", "2026-11-20T00:00:00.000Z", ["2026-11-20 00:00:00", `2026-11-20T00:00:00Z ${canary}`]],
  ]) {
    assert.equal(savedValue(kind, good), good, kind);
    // Whitespace around a value (a probe's line ending) is normalized; anything else is not recorded.
    assert.equal(savedValue(kind, ` ${good}\n`), good, kind);
    for (const value of bad) assert.equal(savedValue(kind, value), null, `${kind}: ${value}`);
    assert.equal(savedValue(kind, undefined), null);
  }
  assert.throws(() => savedValue("hostname", "x"), /^AssertionError \[ERR_ASSERTION\]: unknown saved value kind$/);
  // A CPU model is never a saved text kind; it is saved and compared only as its digest.
  assert.throws(() => savedValue("cpu", "AMD EPYC 7543 32-Core Processor"), /unknown saved value kind/);
});

test("a host's CPU model is saved and compared only as the SHA-256 of its normalized text", () => {
  const model = "AMD EPYC 7543 32-Core Processor", digest = cpuModelDigest(model);
  assert.match(digest, /^[a-f0-9]{64}$/);
  // Whitespace is normalized as savedValue normalizes it, so a probe's line and os.cpus() text agree.
  assert.equal(cpuModelDigest(`\t${model.replace(" ", "  ")}\n`), digest);
  assert.notEqual(cpuModelDigest(`${model} `.repeat(2).trim()), digest);
  // Any text is hashed, never kept: a model with characters a saved value could not hold has a digest too.
  assert.match(cpuModelDigest("Synthetic <leaked canary> | x"), /^[a-f0-9]{64}$/);
  for (const none of [undefined, null, 7, "", "   ", "X".repeat(cpuModelLimit + 1)]) assert.equal(cpuModelDigest(none), null, String(none));
  assert.match(cpuModelDigest("X".repeat(cpuModelLimit)), /^[a-f0-9]{64}$/);
});

test("a soak's event stream covers the load only when it shows the marker's start before and after it, and every row is read", () => {
  const startedMs = Date.parse("2026-11-20T00:00:00Z"), at = (seconds) => String(BigInt(startedMs + seconds * 1000) * 1_000_000n);
  // A 30-minute load: the marker's starts at -1 s and 2000 s bracket it.
  const app = "a".repeat(64), marker = "b".repeat(64), ids = { app, marker, startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T00:30:00Z" };
  const row = (id, action, seconds) => `${id}|${action}|${at(seconds)}\n`;
  const mark = (seconds) => row(marker, "start", seconds) + row(marker, "die", seconds + 0.1);
  const read = (body) => readEvents(mark(-1) + body + mark(2000), ids).events;
  assert.deepEqual(read(""), []);
  // Rows that are not restart-relevant are read and dropped, with any detail.
  assert.deepEqual(read(row(app, "exec_start: sh -c true", 1) + row(app, "health_status: healthy", 2).replace("\n", "\r\n")), []);
  assert.deepEqual(read(row(app, "kill", 3) + row(app, "die", 3.5) + row(app, "start", 4)), [{ action: "kill", atSeconds: 3 }, { action: "die", atSeconds: 3.5 }, { action: "start", atSeconds: 4 }]);
  // An app row naming a restart-relevant event is that event only as the exact word: with detail
  // after it (`restart: x`) it is no event at all, so the whole stream is unreadable, never a restart.
  for (const action of ["start", "restart", "die", "kill", "oom"]) {
    assert.throws(() => read(row(app, `${action}: leaked-canary`, 5)), (error) => {
      assert.match(error.message, /^1 docker events row is not this cell's app, load, upstream or marker, an action and a time$/);
      assert.ok(!error.message.includes("canary"));
      return true;
    }, action);
  }
  // App events after the second marker start are teardown, past the observation.
  assert.deepEqual(readEvents(mark(-1) + mark(2000) + row(app, "kill", 2001) + row(app, "die", 2001), ids).events, []);
  // A response that looks clean but does not show both marker starts (a retrospective query whose
  // buffer no longer held the first, a stream that started late, or one stopped early) does not
  // bracket the load, so it is not read as "no restart".
  for (const text of ["", mark(2000), mark(-1), row(app, "exec_start: true", 1)]) {
    assert.throws(() => readEvents(text, ids), /^AssertionError \[ERR_ASSERTION\]: the event stream showed [01] of the marker's 2 starts, so it does not bracket the load$/, JSON.stringify(text));
  }
  // Uppercase, so not an action: Docker's actions are lowercase, with underscores or dashes.
  const canary = "leaked_Canary";
  for (const text of [`${app}|oom|NOT_A_TIMESTAMP\n`, `${app}|die|${at(1)}\n${canary}\n`, `${app}|${canary}|${at(1)}\n`, `${app}|die|-5\n`, `${app}|die|${at(1)}|${canary}\n`, `${app}||${at(1)}\n`, `${app}|DIE|${at(1)}\n`,
    // Another container's row, or a row with no ID, is not this cell's.
    row("c".repeat(64), "die", 1), `die|${at(1)}\n`, row(`${canary}${"0".repeat(51)}`, "die", 1)]) {
    assert.throws(() => read(text), (error) => {
      assert.match(error.message, /^1 docker events row is not this cell's app, load, upstream or marker, an action and a time$/);
      assert.ok(!error.message.includes(canary) && !error.message.includes("NOT_A_TIMESTAMP"));
      return true;
    }, text);
  }
  assert.throws(() => read(`a|b\nc|d\n`), /^AssertionError \[ERR_ASSERTION\]: 2 docker events rows are not this cell's app, load, upstream or marker, an action and a time$/);
  assert.throws(() => readEvents(null, ids), /returned no text/);
  for (const bad of [undefined, Number.NaN, startedMs, "not a time", "0001-01-01T00:00:00Z", "2026-13-45T00:00:00Z"]) assert.throws(() => readEvents("", { ...ids, startedAt: bad }), /StartedAt is not a time/);
  for (const bad of [{}, { app, marker: app }, { app: "x", marker }, { app, marker: `${marker}\n` }]) assert.throws(() => readEvents(mark(-1) + mark(2000), { startedAt: ids.startedAt, finishedAt: ids.finishedAt, ...bad }), /by their container IDs/);
  // The load's FinishedAt must be a Docker time, at or after its StartedAt to the nanosecond.
  for (const bad of [undefined, Number.NaN, startedMs + 1_800_000, "not a time", "0001-01-01T00:00:00Z", "2026-11-19T23:59:59.999999999Z"])
    assert.throws(() => readEvents(mark(-1) + mark(2000), { ...ids, finishedAt: bad }), /FinishedAt is not a time at or after its StartedAt/);
});

test("a soak's two marker starts must be distinct and bracket the load: one at or before its start, one after it finished", () => {
  const startedMs = Date.parse("2026-11-20T00:00:00Z"), at = (seconds) => String(BigInt(startedMs + seconds * 1000) * 1_000_000n);
  const app = "a".repeat(64), marker = "b".repeat(64), ids = { app, marker, startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T00:30:00Z" };
  const row = (id, action, seconds) => `${id}|${action}|${at(seconds)}\n`;
  const start = (seconds) => row(marker, "start", seconds);
  // The real stream: a start before the load, a start after it, each followed by the marker's exit.
  assert.deepEqual(readEvents(start(-1) + row(marker, "die", -0.9) + row(app, "kill", 900) + start(1801) + row(marker, "die", 1801.1), ids).events, [{ action: "kill", atSeconds: 900 }]);
  // At the load's start exactly is still before it.
  assert.deepEqual(readEvents(start(0) + start(1801) + row(marker, "die", 1801.1), ids).events, []);
  // A marker action with detail is not a start, in the reader as in the live watcher (markerIs): two
  // `start: canary` rows bracketing the load and a later die show no start at all.
  assert.throws(() => readEvents(row(marker, "start: canary", -1) + row(app, "kill", 900) + row(marker, "start: canary", 1801) + row(marker, "die", 1801.1), ids),
    /^AssertionError \[ERR_ASSERTION\]: the event stream showed 0 of the marker's 2 starts, so it does not bracket the load$/);
  // Nor is a die with detail the fence.
  assert.throws(() => readEvents(start(-1) + start(1801) + row(marker, "die: canary", 1801.1), ids), /not that start's exit stamped later than it/);
  // Without the fence, a marker row after the second start stamped after the load finished, the
  // stream does not show the client delivered what came before that start: not read.
  const unfenced = /^AssertionError \[ERR_ASSERTION\]: the event stream's next marker row after its second start is not that start's exit stamped later than it, so it does not show the client delivered what came before that start$/;
  assert.throws(() => readEvents(start(-1) + start(1801), ids), unfenced);
  assert.throws(() => readEvents(start(-1) + start(1801) + row(app, "kill", 900), ids), unfenced);
  assert.throws(() => readEvents(start(-1) + start(1801) + row(marker, "die", 1799), ids), unfenced);
  // The fence is the second start's own exit, its die stamped strictly later than that start: a copy
  // of the second start is not it, with or without the real exit after it, nor is a die stamped after
  // the load finished but at or before the second start. Each would otherwise read a kill-free stream
  // as clean; here a kill during the load, delivered after the second start, is what is at stake.
  const kill = row(app, "kill", 900);
  for (const [name, text] of [["copy of the second start", start(-1) + start(1801) + start(1801) + kill],
    ["copy of the second start, then its exit", start(-1) + start(1801) + start(1801) + kill + row(marker, "die", 1801.1)],
    ["die after the load, before the second start", start(-1) + start(1801) + row(marker, "die", 1800.5) + kill],
    ["die at the second start", start(-1) + start(1801) + row(marker, "die", 1801) + kill]]) {
    assert.throws(() => readEvents(text, ids), unfenced, name);
  }
  // The same kill before the real exit is the load's.
  assert.deepEqual(readEvents(start(-1) + start(1801) + kill + row(marker, "die", 1801.1), ids).events, [{ action: "kill", atSeconds: 900 }]);
  const before = /^AssertionError \[ERR_ASSERTION\]: the marker's first start in the event stream is not at or before the load's start, so it does not show the stream was listening when the load began$/;
  const after = /^AssertionError \[ERR_ASSERTION\]: the marker's second start in the event stream is not a later start than the first and after the load finished, so it does not show the stream ran past the load$/;
  // Two identical pre-load rows and then a die during the load: two starts, but no second witness,
  // and the die would otherwise have been read as past the observation's end.
  assert.throws(() => readEvents(start(-1) + start(-1) + row(app, "die", 900), ids), after);
  // Two distinct starts both before the load, or the second inside it or at its FinishedAt exactly.
  for (const second of [-0.5, 900, 1800]) assert.throws(() => readEvents(start(-1) + start(second) + row(app, "die", 1700), ids), after, String(second));
  // A first start after the load began: the stream may have missed the load's start.
  assert.throws(() => readEvents(start(0.001) + start(1801), ids), before);
  // Out of order: a later start first.
  assert.throws(() => readEvents(start(1801) + start(-1), ids), before);
  // The three states of the stream are independent of the memory samples.
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const base = { rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows(Array(30).fill(150), () => 10, 60), tail: 0, unrecorded: 0, requests: 270000, iterations: 270000, latencyMaxMs: 25,
    memory: null, before: held, after: held, arrivals: onSchedule() };
  // A stream that was not read gives the cell no reading (the runner fails it unconfirmed), so a
  // soak summary needs readEvents's list: null is refused, never saved as an unestablished claim.
  assert.throws(() => summarizeSoak({ ...base, events: null }), /readEvents's list of the app's events/);
  assert.deepEqual([summarizeSoak({ ...base, events: [] }).restarts.eventStream, summarizeSoak({ ...base, events: [] }).restarts.restarted], ["none-seen", false]);
  const oom = summarizeSoak({ ...base, events: [{ action: "oom", atSeconds: 70 }], after: { ...held, running: false, oomKilled: true } });
  assert.deepEqual([oom.restarts.eventStream, oom.restarts.restarted, oom.memory.unavailable], ["seen", false, "memory sampling failed"]);
});

test("a cell's event stream reports every update of its app, load and upstream, and the upstream's restart-relevant events, by role", () => {
  const startedMs = Date.parse("2026-11-20T00:00:00Z"), at = (seconds) => String(BigInt(startedMs + seconds * 1000) * 1_000_000n);
  const app = "a".repeat(64), marker = "b".repeat(64), load = "c".repeat(64), upstream = "d".repeat(64);
  const ids = { app, marker, load, upstream, startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T00:30:00Z" };
  const row = (id, action, seconds) => `${id}|${action}|${at(seconds)}\n`;
  const mark = (seconds) => row(marker, "start", seconds) + row(marker, "die", seconds + 0.1);
  const read = (body, with_ = ids) => readEvents(mark(-1) + body + mark(2000), with_);
  // The load's own lifecycle and copy rows are read and not kept; nothing else changes.
  assert.deepEqual(read(row(load, "attach", 0) + row(load, "start", 0) + row(load, "die", 1800) + row(load, "archive-path", 1801) + row(upstream, "exec_start: sh -c true", 5)), { events: [], updates: [], upstream: [] });
  // An update of any of them, even one undone before the next inspect, is kept with its role and
  // time; so is one before the load's start (between the launch check and the load).
  assert.deepEqual(read(row(app, "update", 600) + row(app, "update", 601) + row(load, "update", 10) + row(upstream, "update", -0.5)).updates,
    [{ role: "app", atSeconds: 600 }, { role: "app", atSeconds: 601 }, { role: "load", atSeconds: 10 }, { role: "upstream", atSeconds: -0.5 }]);
  // The marker is not one of them: an update of it between its starts is read and not kept, so the
  // README names the app, the load and the upstream as the containers whose update fails a cell.
  assert.deepEqual(read(row(marker, "update", 600)), { events: [], updates: [], upstream: [] });
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes("An `update` of the app, the load or an API cell's upstream (not the marker) the stream delivers fails the cell `settings`"));
  assert.ok(!readme.includes("An `update` of any of those containers"));
  // The upstream's start, restart, die, kill and oom are kept apart from the app's.
  assert.deepEqual(read(row(upstream, "kill", 300) + row(upstream, "die", 300.1) + row(upstream, "start", 301) + row(app, "kill", 400)),
    { events: [{ action: "kill", atSeconds: 400 }], updates: [], upstream: [{ action: "kill", atSeconds: 300 }, { action: "die", atSeconds: 300.1 }, { action: "start", atSeconds: 301 }] });
  // An update row with detail, or an upstream restart-relevant row with detail, is not that event, so
  // the whole stream is unreadable; the message never echoes what Docker wrote.
  for (const text of [row(app, "update: leaked-canary", 5), row(load, "update: leaked-canary", 5), row(upstream, "update: leaked-canary", 5), row(upstream, "restart: leaked-canary", 5), row(upstream, "die: leaked-canary", 5)]) {
    assert.throws(() => read(text), (error) => {
      assert.match(error.message, /^1 docker events row is not this cell's app, load, upstream or marker, an action and a time$/);
      assert.ok(!error.message.includes("canary"));
      return true;
    }, text);
  }
  // A fixture cell reads no upstream: an upstream ID's row is another container's, so it is not read.
  const { upstream: _, ...fixture } = ids;
  assert.throws(() => read(row(upstream, "update", 5), fixture), /^AssertionError \[ERR_ASSERTION\]: 1 docker events row is not this cell's app, load, upstream or marker, an action and a time$/);
  // Every watched ID is a distinct container ID.
  for (const bad of [{ load: app }, { upstream: marker }, { load: upstream }, { load: "x" }, { upstream: `${upstream}\n` }]) {
    assert.throws(() => read("", { ...ids, ...bad }), /by their container IDs/, JSON.stringify(bad));
  }
});

test("a soak keeps an app event stamped inside the load wherever the stream put it, and compares the load's times to the nanosecond", () => {
  const startedAt = "2026-11-20T00:00:00Z", base = BigInt(Date.parse(startedAt)) * 1_000_000n;
  const app = "a".repeat(64), marker = "b".repeat(64), ids = { app, marker, startedAt, finishedAt: "2026-11-20T00:30:00Z" };
  const row = (id, action, nanos) => `${id}|${action}|${base + nanos}\n`, s = 1_000_000_000n;
  // The fence the stream must show: the marker's exit after its second start.
  const fence = row(marker, "die", 1802n * s);
  // An OOM kill stamped 15 s into the load, delivered after the second marker start: it is the
  // load's, not teardown, so it is kept and the stream reads seen, never clean.
  const late = readEvents(row(marker, "start", -s) + row(marker, "start", 1801n * s) + row(app, "oom", 15n * s) + row(app, "die", 15n * s + 1n) + fence, ids).events;
  assert.deepEqual(late, [{ action: "oom", atSeconds: 15 }, { action: "die", atSeconds: 15.000000001 }]);
  const held = { id: app, startedAt, restartCount: 0, running: true, oomKilled: false };
  const restarts = summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows(Array(30).fill(150), () => 10, 60), tail: 0, unrecorded: 0, requests: 270000, iterations: 270000,
    latencyMaxMs: 25, memory: null, before: held, after: held, arrivals: onSchedule(), events: late }).restarts;
  assert.deepEqual([restarts.eventStream, restarts.events.map((e) => e.action)], ["seen", ["oom", "die"]]);
  // Stamped at the load's FinishedAt exactly is still inside it; one nanosecond later, after the
  // second marker start, is teardown and is left out.
  assert.deepEqual(readEvents(row(marker, "start", -s) + row(marker, "start", 1801n * s) + row(app, "kill", 1800n * s) + row(app, "die", 1800n * s + 1n) + fence, ids).events, [{ action: "kill", atSeconds: 1800 }]);
  // FinishedAt with nanoseconds: a second marker start 0.4 ms before it, in the same millisecond,
  // is not after the load finished; one nanosecond after it is.
  const precise = { ...ids, finishedAt: "2026-11-20T00:30:00.000900000Z" };
  const after = /^AssertionError \[ERR_ASSERTION\]: the marker's second start in the event stream is not a later start than the first and after the load finished, so it does not show the stream ran past the load$/;
  assert.throws(() => readEvents(row(marker, "start", -s) + row(marker, "start", 1800n * s + 500_000n), precise), after);
  assert.throws(() => readEvents(row(marker, "start", -s) + row(marker, "start", 1800n * s + 900_000n), precise), after);
  assert.deepEqual(readEvents(row(marker, "start", -s) + row(marker, "start", 1800n * s + 900_001n) + fence, precise).events, []);
  // The same at the start: a first marker start 1 ns after a StartedAt with nanoseconds is too late.
  const startPrecise = { ...ids, startedAt: "2026-11-20T00:00:00.000000500Z" };
  assert.throws(() => readEvents(row(marker, "start", 501n) + row(marker, "start", 1801n * s), startPrecise), /first start in the event stream is not at or before the load's start/);
  assert.deepEqual(readEvents(row(marker, "start", 500n) + row(marker, "start", 1801n * s) + fence, startPrecise).events, []);
  // The fence is compared to the nanosecond too: a marker row 1 ns before the precise FinishedAt,
  // though after the second start in the stream, is not it.
  assert.throws(() => readEvents(row(marker, "start", -s) + row(marker, "start", 1800n * s + 900_001n) + row(marker, "die", 1800n * s + 899_999n), precise), /next marker row after its second start is not that start's exit stamped later than it/);
  // And to the second start's nanosecond: a die stamped at it is not later; 1 ns after it is.
  assert.throws(() => readEvents(row(marker, "start", -s) + row(marker, "start", 1800n * s + 900_001n) + row(marker, "die", 1800n * s + 900_001n), precise), /not that start's exit stamped later than it/);
  assert.deepEqual(readEvents(row(marker, "start", -s) + row(marker, "start", 1800n * s + 900_001n) + row(marker, "die", 1800n * s + 900_002n), precise).events, []);
});

test("a saved pass's own text never reaches an error or a report: every field is refused unless it validates", () => {
  const canary = "<leaked canary>";
  const soakOptions = parseSteadyArgs(["soak", "w7", "--apps", "corten", "--targets", "page"], apps, groupApps);
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const soakCell = { app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows(Array(30).fill(150), () => 10, 60), tail: 0, unrecorded: 0,
    requests: 270000, iterations: 270000, latencyMaxMs: 25, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 50 })), before: held, after: held, events: [{ action: "kill", atSeconds: 5 }], arrivals: onSchedule() }) };
  const soak = savedPass(soakOptions, [soakCell, { app: "corten", source: "api", target: "page", failure: "cold-start" }],
    { admission: { round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: "bench/marketplace/results/w2/summary.json", selected: ["corten"], admitted: ["corten"] } });
  const convergence = convergencePass();
  convergence.cells[1] = { app: convergence.cells[1].app, source: convergence.cells[1].source, target: convergence.cells[1].target, failure: "load-exit", verdict: null };
  convergence.options.labels = ["agent.owner=codex"];
  validateSoak(soak); validateConvergence(convergence);
  // Every value in the saved pass (of the windows, the first two and the last of each cell, which
  // the reader checks alike): replaced by text, and a number by the same number as text.
  const sampled = ([k], i, all) => i < 2 || i === all.length - 1;
  const leaves = (value, path = []) => (value !== null && typeof value === "object"
    ? Object.entries(value).filter((entry, i, all) => path.at(-1) !== "windows" || sampled(entry, i, all)).flatMap(([k, v]) => leaves(v, [...path, k])) : [path]);
  const objects = (value, path = []) => (value !== null && typeof value === "object" ? [path, ...Object.entries(value).flatMap(([k, v]) => objects(v, [...path, k]))] : []);
  const at = (root, path) => path.reduce((v, k) => v[k], root);
  let checked = 0;
  for (const [pass, validate, kind] of [[convergence, validateConvergence, "convergence"], [soak, validateSoak, "soak"]]) {
    const refused = (mutate, what) => {
      const v = structuredClone(pass); mutate(v);
      for (const read of [validate, steadyReport, ...(kind === "convergence" ? [(x) => convergenceLines(likeRound(), ["corten", "aspnet"], x)] : [])]) {
        assert.throws(() => read(v), (error) => {
          assert.ok(!error.message.includes("leaked") && !error.message.includes("\n") && Object.keys(error).length === 0, `${kind} ${what}: ${error.message}`);
          return true;
        }, `${kind} ${what}`);
      }
      checked++;
    };
    for (const path of leaves(pass)) {
      const value = at(pass, path), parent = (v) => at(v, path.slice(0, -1)), key = path.at(-1);
      refused((v) => { parent(v)[key] = typeof value === "string" ? `${value}${canary}` : canary; }, path.join("."));
      if (typeof value === "number") refused((v) => { parent(v)[key] = String(value); }, `${path.join(".")} as text`);
    }
    for (const path of objects(pass)) {
      const target = at(pass, path);
      if (Array.isArray(target)) continue;
      refused((v) => { at(v, path)[`leaked${canary}`] = 1; }, `${path.join(".")} with an extra field`);
    }
  }
  assert.ok(checked > 400, `${checked} mutations`);
});

test("a saved pass names only adapters and groups this checkout has, and never prints an invented one", () => {
  // A syntactically valid name, so only the inventory check can refuse it.
  const invented = "leaked-adapter";
  assert.ok(!apps.includes(invented));
  const rename = (v) => {
    v.options.apps = v.options.apps.map((a) => (a === "aspnet" ? invented : a));
    v.images = Object.fromEntries(Object.entries(v.images).map(([a, id]) => [a === "aspnet" ? invented : a, id]));
    for (const c of v.cells) if (c.app === "aspnet") c.app = invented;
  };
  const s = convergencePass();
  for (const [what, mutate, pattern] of [
    ["an adapter", rename, /^the pass's options: adapters \(each one this checkout's adapter inventory has\)$/],
    ["a group", (v) => { v.options.group = "leaked-group"; }, /^the pass's options: kind, name, build or group \(a group this checkout has\)$/],
    ["an adapter selected for admission", (v) => { v.admission = { round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: null, selected: ["corten", "aspnet", invented], admitted: ["corten", "aspnet"] }; },
      /^the pass's admission$/],
  ]) {
    const v = structuredClone(s); mutate(v);
    for (const read of [validateConvergence, steadyReport, (x) => convergenceLines(likeRound(), ["corten", "aspnet"], x)]) {
      assert.throws(() => read(v), (error) => { assert.match(error.message, pattern, what); assert.ok(!error.message.includes("leaked"), what); return true; }, what);
    }
  }
  // The same pass with the checkout's own names, a group it has, and an admission of them, reads.
  const admitted = structuredClone(s);
  admitted.admission = { round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: null, selected: ["corten", "aspnet"], admitted: ["corten", "aspnet"] };
  validateConvergence(admitted);
  assert.match(steadyReport(admitted), /^Adapters: those timed round w2 .* admitted, of corten, aspnet\.$/m);
});

test("a saved pass with a group ran that group's adapters, or the subset of them its admission admitted, as steady.mjs runs it", () => {
  const performant = groupApps("production-performant");
  assert.deepEqual([performant.includes("aspnet"), performant.includes("rails"), apps.includes("rails")], [true, false, true]);
  const admission = (selected, admitted) => ({ round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: null, selected, admitted });
  // An adapter this checkout has, but not the group's: steady.mjs --group never runs it.
  const rails = (v) => {
    v.options.apps = v.options.apps.map((a) => (a === "aspnet" ? "rails" : a));
    v.images = Object.fromEntries(Object.entries(v.images).map(([a, id]) => [a === "aspnet" ? "rails" : a, id]));
    for (const c of v.cells) if (c.app === "aspnet") c.app = "rails";
  };
  const s = convergencePass();
  s.options.group = "production-performant";
  for (const [what, mutate] of [
    ["an adapter outside the group", (v) => { rails(v); v.admission = null; }],
    ["an adapter outside the group, selected for admission", (v) => { rails(v); v.admission = admission(["corten", "rails"], ["corten", "rails"]); }],
    ["a subset of the group with no admission", (v) => { v.admission = null; }],
    ["an admission that did not select the whole group", (v) => { v.admission = admission(["corten", "aspnet"], ["corten", "aspnet"]); }],
    ["fewer adapters than the admission admitted", (v) => { v.admission = admission(performant, ["corten", "aspnet", "topcoat"]); }],
  ]) {
    const v = structuredClone(s); mutate(v);
    for (const read of [validateConvergence, steadyReport, (x) => convergenceLines(likeRound(), ["corten", "aspnet"], x)]) {
      assert.throws(() => read(v), (error) => {
        assert.equal(error.message, "the pass's adapters are not its group's, or the subset of them its admission admitted", what);
        assert.ok(!error.message.includes("rails"), what);
        return true;
      }, what);
    }
  }
  // The subset of the group that a round admitted, selected as the whole group, reads, as that group.
  const subset = structuredClone(s); subset.admission = admission(performant, ["corten", "aspnet"]);
  validateConvergence(subset);
  assert.match(steadyReport(subset), /^Group production-performant: its images and container settings\.$/m);
});

test("saved memory medians and growth must be numbers before the report does any arithmetic", () => {
  const options = parseSteadyArgs(["soak", "w8", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const cell = { app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: windows(Array(30).fill(150), () => 10, 60), tail: 0, unrecorded: 0,
    requests: 270000, iterations: 270000, latencyMaxMs: 25, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: i < 60 ? 10 : 20 })), before: held, after: held, events: [], arrivals: onSchedule() }) };
  const s = savedPass(options, [cell]);
  assert.match(soakReport(s), /\| 10\.0 \| 20\.0 \| \+10\.0 MiB \(100\.0%\) \|/);
  for (const mutate of [(m) => { m.startMiB = "10"; m.endMiB = "20"; }, (m) => { m.startMiB = "10"; }, (m) => { m.growthMiB = "10"; }, (m) => { m.growthPct = "100"; },
    (m) => { m.startMiB = 0; m.growthMiB = 20; m.growthPct = Infinity; }, (m) => { m.endMiB = Infinity; m.growthMiB = Infinity; }, (m) => { m.samples = "1800"; }]) {
    const v = structuredClone(s); mutate(v.cells[0].memory);
    assert.throws(() => validateSoak(v), /^Error: corten fixture page: memory$/);
    assert.throws(() => soakReport(v), /^Error: corten fixture page: memory$/);
  }
});

test("a pass's failure and startup are codes the reader knows, printed as their text", () => {
  assert.ok(Object.values(failureCodes).every((text) => typeof text === "string" && !/[<>`|]/.test(text)));
  const s = convergencePass();
  for (const failure of ["Error: docker rm exited 1", "cold probe exited 1; its output is in cold.log", "toString", "__proto__"]) {
    const v = structuredClone(s); v.cells[0] = { app: "corten", source: "fixture", target: "page", failure, verdict: null };
    assert.throws(() => validateConvergence(v), /^Error: corten fixture page: a failed cell keeps a known failure code$/);
  }
  for (const startup of ["the timed round's cold start", "marketplace-cold-start/v2", "toString"]) {
    const v = structuredClone(s); v.startup = startup;
    assert.throws(() => validateConvergence(v), /^Error: a pass records how it started each app, by a known code$/);
  }
  assert.throws(() => parseSaved("{\"leaked canary\": "), (error) => error.message === "the saved pass is not JSON");
  assert.deepEqual(parseSaved("{\"a\":1}"), { a: 1 });
});

test("a soak's event stream is read only as complete, nonblank lines, before any restart is claimed", () => {
  const startedMs = Date.parse("2026-11-20T00:00:00Z"), at = (seconds) => String(BigInt(startedMs + seconds * 1000) * 1_000_000n);
  const app = "a".repeat(64), marker = "b".repeat(64), ids = { app, marker, startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T00:30:00Z" };
  const row = (id, action, seconds) => `${id}|${action}|${at(seconds)}\n`;
  const mark = (seconds) => row(marker, "start", seconds) + row(marker, "die", seconds + 0.1);
  const covered = mark(-1) + row(app, "restart", 900) + mark(2000);
  // A complete stream reads, and its restart is the load's.
  assert.deepEqual(readEvents(covered, ids).events, [{ action: "restart", atSeconds: 900 }]);
  // A suffix the client was still writing (no newline), even one that would be a whole row: not read.
  for (const suffix of [`${app}|die|${at(2001)}`, `${app}|kil`, "\r", " "]) {
    assert.throws(() => readEvents(covered + suffix, ids), /^AssertionError \[ERR_ASSERTION\]: the event stream ends with a row that has no newline, so it is not read$/, JSON.stringify(suffix));
  }
  assert.throws(() => readEvents(covered.slice(0, -1), ids), /ends with a row that has no newline/);
  // A blank complete row, anywhere: not read, and never quoted.
  for (const [text, n] of [[mark(-1) + "\n" + row(app, "restart", 900) + mark(2000), 1], [covered + "\r\n", 1], [mark(-1) + "\n\n" + mark(2000) + "\n", 3], ["\n" + covered, 1]]) {
    assert.throws(() => readEvents(text, ids), new RegExp(`^AssertionError \\[ERR_ASSERTION\\]: ${n} docker events rows? (is|are) blank, so the stream is not read$`), JSON.stringify(text.slice(0, 20)));
  }
  // An empty stream is still read as one that showed none of the marker's starts.
  assert.throws(() => readEvents("", ids), /showed 0 of the marker's 2 starts/);
});
