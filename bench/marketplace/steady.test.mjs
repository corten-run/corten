import assert from "node:assert/strict";
import test from "node:test";
import { checkFixture, convergenceLines, convergenceSchema, flattenPoint, flattenRule, heldThrough, parseSteadyArgs, readDropped, readWindows, ruleText, soakMemoryClock, soakSchema, summarizeSoak, timedStartup, timedWarmupVus, validateConvergence, validateSoak, verdictText } from "./steady-contract.mjs";
import { cpuSettings, resultSchema, v5Schema } from "./run-contract.mjs";
import { convergenceReport, soakReport, steadyReport } from "./steady-report.mjs";
import { groupApps } from "./groups.mjs";
import { apps } from "./contract.mjs";

const seconds = 15;
// Windows from a list of throughputs, as readWindows returns them.
const windows = (rps, p95 = () => 10, size = seconds) => rps.map((r, index) => ({ index, startSeconds: index * size, seconds: size, requests: r * size, failed: 0, rps: r, p95: r ? p95(index) : null, p99: r ? p95(index) * 2 : null }));
const within = (window, fromSeconds, tailRps, previousRps, headRps) => ({ withinTolerance: true, window, fromSeconds, tailRps, previousRps, headRps });

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
  const down = verdictText({ withinTolerance: false, reason: "trend-down", tailRps: 1000, previousRps: 1000, headRps: 1000 });
  assert.match(up, /lasts at least 60 s, but no window in it .* the least-squares line through the whole stretch goes up$/);
  assert.match(down, /the least-squares line through the whole stretch does not go up$/);
  for (const t of [up, down]) assert.doesNotMatch(t, /higher at the end|lower at the end|rising|slower|faster/);
  assert.throws(() => verdictText({ withinTolerance: false, reason: "still-rising" }), /unknown reading/);
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
  // 2. A last-window shift under 10% is not detected: nineteen at 1000 then 1090.
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
  for (const text of ["not a certificate of steady state", "within 10% of the median of the last 60 s", "every three-window median within 5%", "changed by at most 5% of the tail",
    "Oscillation or drift inside those bounds reads as within tolerance", "a shift of under 10% in the last window is not detected", "resolved to one window and given as that window's end", "readings at different window lengths are not comparable"])
    assert.ok(ruleText.includes(text), text);
});
test("short, empty and degrading passes give no reading or a stated one", () => {
  assert.deepEqual(flattenPoint(windows([1000, 1000, 1000, 1000, 1000, 1000, 1000])), { withinTolerance: false, reason: "too-few-windows" });
  assert.equal(verdictText(flattenPoint(windows([1000, 1000, 1000, 1000, 1000, 1000, 1000]))), "no reading: too few windows");
  assert.equal(verdictText(flattenPoint(windows([1000, 1000, 1000, 1000, 0, 0, 0, 0]))), "no reading: nothing served at the end");
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
  const metrics = { http_reqs: { count: counts.reduce((a, b) => a + b, 0) + tail + unfinished, rate: 1 }, iterations: { count: counts.reduce((a, b) => a + b, 0) + tail } };
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
  assert.deepEqual([read.tail, read.unrecorded, read.requests, read.iterations], [7, 0, 907, 907]);
  assert.deepEqual(read.windows.map((w) => [w.startSeconds, w.requests, w.failed, w.rps, w.p95, w.p99]), [[0, 150, 0, 10, 9, 20], [15, 300, 3, 20, 10, 21], [30, 0, 0, 0, null, null], [45, 450, 0, 30, 12, 23]]);
  // A request whose iteration the graceful stop cut off before it was counted.
  assert.equal(readWindows(k6Summary([150, 150], { unfinished: 1 }), { windows: 2, windowSeconds: 15 }).unrecorded, 1);
  for (const [summary, pattern] of [
    [k6Summary([150, 150], { extra: { http_reqs: { count: 400, rate: 1 }, iterations: { count: 400 } } }), /account for every request/],
    [k6Summary([150, 150], { extra: { http_reqs: { count: 250, rate: 1 }, iterations: { count: 250 } } }), /account for every request/],
    [k6Summary([150, 150], { extra: { window_2_requests: { count: 1, rate: 1 } } }), /unexpected k6 window metric/],
    [k6Summary([150, 150], { failed: { 0: 151 } }), /more failures than requests/],
    [k6Summary([150, 150], { extra: { window_1_duration: { "p(95)": 30, "p(99)": 20 } } }), /p95\/p99/],
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
const cleanCleanup = () => ({ complete: true, remaining: { containers: [], networks: [] }, created: 6, removed: 6, recovered: 0, unacknowledged: [] });
// A timed round's per-profile runs with the warmup failures given.
const runs = (failed = 0) => ({ "fixture-rotating-page": [{ warmup: { requests: 1000, failed } }], "fixture-json": [{ warmup: { requests: 1000, failed: 0 } }] });
// A timed round like-for-like with convergencePass() on every compared input.
const likeRound = (warmup = 10) => ({ schema: resultSchema, commit: "c".repeat(40), options: { warmup, startupTimeout: 120 }, host: { cpu: "Synthetic test only", release: "6.8.0-test", onlineCpus: "0-7" },
  measurement: measurement(), fixtureSha256, tools: structuredClone(tools), apps: { corten: { imageId: imageIds.corten, runs: runs() }, aspnet: { imageId: imageIds.aspnet, runs: runs() } } });
const cellOf = (app, source, target, rps) => {
  const w = windows(rps), requests = w.reduce((sum, x) => sum + x.requests, 0) + 3;
  return { app, source, target, windows: w, tail: 3, unrecorded: 0, requests, iterations: requests, failedRequests: 0, verdict: flattenPoint(w) };
};
function convergencePass({ commit = "c".repeat(40), cells } = {}) {
  const options = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "3"], apps, groupApps);
  const rps = { corten: Array(12).fill(1000), aspnet: [200, 400, 600, 800, 900, 1000, 1000, 1000, 1000, 1000, 1000, 1000] };
  return { schema: convergenceSchema, name: "w3", runId: "marketplace-convergence-w3-0", options, rule: flattenRule, commit, finishedCommit: commit, dirty: false, complete: true,
    startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T01:00:00Z", host: { cpu: "Synthetic test only", kernel: "6.8.0-test", onlineCpus: "0-7" }, admission: null, failures: [], cleanupFailures: [], cleanup: cleanCleanup(),
    images: { corten: imageIds.corten, aspnet: imageIds.aspnet }, measurement: measurement(), fixtureSha256, tools: structuredClone(tools), startup: timedStartup,
    cells: cells ?? options.sources.flatMap((source) => options.apps.flatMap((app) => options.targets.map((target) => cellOf(app, source, target, rps[app])))) };
}
test("a saved convergence pass validates, recomputes every reading and sets no warmup", () => {
  const s = convergencePass();
  validateConvergence(s);
  const text = convergenceReport(s);
  assert.match(text, /^\| aspnet \| api \| json \| within the stated tolerance from the window ending at 90 s \| 1000\.0 \| 0 \|$/m);
  assert.match(text, /This pass sets no timed warmup: a timed warmup is set only by a separate reviewed change from a saved pass that is like-for-like with the rounds it applies to .* It ran the timed warmup's 32 users\./);
  assert.match(text, /Tolerance reading marketplace-tolerance\/v4: a screening reading of throughput, not a certificate of steady state\./);
  assert.match(text, /has no reading\./);
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
    [(v) => { delete v.host.kernel; }, /host kernel/],
    [(v) => { delete v.startup; }, /how it started/],
    // What the saved reader refuses beyond the windows: another finishing commit, a suite failure,
    // cleanup that failed or is unconfirmed, totals that do not reconcile, and an empty matrix.
    [(v) => { v.finishedCommit = "d".repeat(40); }, /finishes at the commit it started at/],
    [(v) => { delete v.finishedCommit; }, /finishes at the commit it started at/],
    [(v) => { v.failures = [{ stage: "suite", error: "x" }]; }, /suite failure/],
    [(v) => { v.cleanupFailures = [{ resource: "container x", error: "removal failed" }]; }, /cleanup failed/],
    [(v) => { v.cleanup.complete = false; }, /cleanup is not confirmed complete/],
    [(v) => { v.cleanup.remaining.containers = ["a".repeat(64)]; }, /cleanup is not confirmed complete/],
    [(v) => { v.cleanup.unacknowledged = [{ name: "x-k6", label: "l", outcome: "unconfirmed" }]; }, /cleanup is not confirmed complete/],
    [(v) => { delete v.cleanup; }, /cleanup is not confirmed complete/],
    [(v) => { v.cells[0].requests += 1; }, /do not add up to k6's request total/],
    [(v) => { v.cells[0].unrecorded = 1; v.cells[0].requests += 1; v.cells[0].iterations += 1; }, /more unrecorded requests than unfinished iterations/],
    [(v) => { delete v.cells[0].iterations; }, /request and iteration totals/],
    [(v) => { v.options.apps = []; v.images = {}; v.cells = []; }, /at least one of its apps/],
  ]) { const v = structuredClone(s); mutate(v); assert.throws(() => validateConvergence(v), pattern); }
  const failed = structuredClone(s);
  failed.cells[2] = { app: failed.cells[2].app, source: failed.cells[2].source, target: failed.cells[2].target, verdict: null, failure: "not ready in 120s: HTTP 500" };
  validateConvergence(failed);
  assert.match(convergenceReport(failed), /no reading: the cell failed/);
});

test("a soak reports memory at the start and end, p99 per interval and any restart", () => {
  const w = windows([150, 150, 150, 150, 150, 150], (i) => 10 + i, 15);
  const memory = Array.from({ length: 360 }, (_, i) => ({ atSeconds: i / 4, mib: 100 + i / 10 }));
  const held = { id: "a".repeat(64), startedAt: "2026-11-20T00:00:00Z", restartCount: 0, running: true, oomKilled: false };
  const base = { rate: 150, droppedIterations: 0, failedRequests: 0, windows: w, tail: 0, unrecorded: 0, requests: 13500, iterations: 13500, memory, before: held, after: held, events: [] };
  const cell = summarizeSoak(base);
  assert.equal(cell.memory.samples, 360);
  assert.ok(Math.abs(cell.memory.startMiB - 102.95) < 1e-9 && Math.abs(cell.memory.endMiB - 132.95) < 1e-9 && Math.abs(cell.memory.growthMiB - 30) < 1e-9, JSON.stringify(cell.memory));
  assert.deepEqual(cell.p99, { first: 20, last: 30, max: 30 });
  assert.deepEqual(cell.restarts, { restarted: false, restartCount: 0, replaced: false, events: [], runningAtEnd: true, oomKilled: false });
  const restarted = summarizeSoak({ ...base, after: { ...held, running: false, oomKilled: true }, events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }, { action: "exec_start", atSeconds: 1 }] });
  assert.deepEqual(restarted.restarts, { restarted: true, restartCount: 0, replaced: false, events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }], runningAtEnd: false, oomKilled: true });
  assert.equal(summarizeSoak({ ...base, after: { ...held, restartCount: 2 } }).restarts.restarted, true);
  // A docker restart keeps RestartCount but not StartedAt; another container ID is another instance.
  const restartedInPlace = summarizeSoak({ ...base, after: { ...held, startedAt: "2026-11-20T00:10:00Z" } }).restarts;
  assert.deepEqual([restartedInPlace.restarted, restartedInPlace.replaced], [true, true]);
  assert.equal(summarizeSoak({ ...base, after: { ...held, id: "b".repeat(64) } }).restarts.replaced, true);
  assert.throws(() => summarizeSoak({ ...base, memory: memory.slice(0, 10) }), /first and last interval/);
  assert.throws(() => summarizeSoak({ ...base, before: { ...held, restartCount: 1 } }), /backwards/);
  assert.throws(() => summarizeSoak({ ...base, before: { restartCount: 0, running: true, oomKilled: false } }), /needs id, startedAt/);

  const options = parseSteadyArgs(["soak", "w4", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const long = windows(Array(30).fill(150), (i) => (i === 29 ? 40 : 10), 60);
  const soakCell = (extra = {}) => ({ app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, failedRequests: 0, windows: long, tail: 0, unrecorded: 0, requests: 270000, iterations: 270000,
    memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: i < 60 ? 50 : 80 })), before: held, after: held, events: [], ...extra }) });
  const s = { schema: soakSchema, name: "w4", options, commit: "d".repeat(40), finishedCommit: "d".repeat(40), dirty: false, complete: true, startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T01:00:00Z",
    failures: [], cleanupFailures: [], cleanup: cleanCleanup(), measurement: { ...measurement(), memoryClock: soakMemoryClock },
    host: { cpu: "Synthetic test only" }, admission: { round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: "x", selected: ["corten", "aspnet"], admitted: ["corten"] },
    cells: [soakCell()] };
  validateSoak(s);
  const text = soakReport(s);
  assert.match(text, /^\| corten \| fixture \| page \| held \| 50\.0 \| 80\.0 \| \+30\.0 MiB \(60\.0%\) \| 20\.0 \/ 80\.0 \/ 80\.0 \| 0 \| no \|$/m);
  assert.match(text, /those timed round w2 .* admitted, of corten, aspnet/);
  assert.match(text, /it says whether each adapter's memory, tail latency and process held at the rate asked for/);
  // The report states both clocks: memory intervals are their own, not the latency intervals.
  assert.ok(text.includes(soakMemoryClock));
  assert.match(soakMemoryClock, /intervals of their own/);
  assert.doesNotMatch(text, /was not met/);
  assert.match(text, /^No group: /m);
  const grouped = structuredClone(s); grouped.options.group = "production";
  assert.match(soakReport(grouped), /^Group production: its images and container settings\.$/m);
  assert.equal(steadyReport(s), text);
  const replaced = structuredClone(s); replaced.cells = [soakCell({ after: { ...held, startedAt: "2026-11-20T00:30:00Z" } })];
  assert.match(soakReport(replaced), /\| yes: another instance \(ID or StartedAt\) at the end \|$/m);
  // A saved soak whose claims contradict its own counters, totals or cleanup is refused.
  for (const [mutate, pattern] of [
    [(v) => { v.cells[0].memory.growthMiB = 0; }, /memory/],
    [(v) => { v.cells[0].p99.max = -1; }, /p99 contradicts its intervals/],
    [(v) => { v.cells[0].p99.max = null; }, /p99 contradicts its intervals/],
    [(v) => { v.cells[0].restarts.restartCount = 1; }, /restart claim contradicts/],
    [(v) => { v.cells[0].restarts.runningAtEnd = false; }, /restart claim contradicts/],
    [(v) => { v.cells[0].restarts.oomKilled = true; }, /restart claim contradicts/],
    [(v) => { v.cells[0].restarts.events = [{ action: "die", atSeconds: 5 }]; }, /restart claim contradicts/],
    [(v) => { v.cells[0].restarts.replaced = true; }, /restart claim contradicts/],
    [(v) => { delete v.cells[0].restarts.replaced; }, /restarts/],
    [(v) => { v.cells[0].requests += 1; v.cells[0].iterations += 1; }, /do not add up/],
    [(v) => { v.finishedCommit = "e".repeat(40); }, /finishes at the commit/],
    [(v) => { v.cleanup.complete = false; }, /cleanup is not confirmed/],
    [(v) => { delete v.measurement.memoryClock; }, /clock of its memory samples/],
    [(v) => { v.options.apps = []; v.cells = []; }, /at least one of its apps/],
  ]) { const v = structuredClone(s); mutate(v); assert.throws(() => validateSoak(v), pattern); }
  // A soak whose k6 dropped iterations did not run the fixed rate: stated, and not presented as a fixed-rate result.
  assert.equal(readDropped({ metrics: { dropped_iterations: { count: 37, rate: 0.02 } } }), 37);
  assert.equal(readDropped({ metrics: {} }), 0);
  const dropped = structuredClone(s);
  dropped.cells = [soakCell({ droppedIterations: 37, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 50 })) })];
  assert.deepEqual(dropped.cells[0].rate, { requested: 150, droppedIterations: 37, met: false });
  const droppedText = soakReport(dropped);
  assert.match(droppedText, /^\| corten \| fixture \| page \| not met: 37 iterations dropped \|/m);
  assert.match(droppedText, /^corten fixture page: the fixed 150 requests\/second was not met \(k6 dropped 37 iterations it could not start on time\), so this is not a fixed-rate result/m);
  for (const mutate of [(v) => { v.cells[0].rate.met = true; }, (v) => { v.cells[0].rate.requested = 20; }, (v) => { delete v.cells[0].rate; }]) { const v = structuredClone(dropped); mutate(v); assert.throws(() => validateSoak(v), /rate/); }
  assert.throws(() => summarizeSoak({ rate: 150, windows: long, tail: 0, unrecorded: 0, memory: [], before: held, after: held, events: [] }), /dropped iterations/);
  assert.throws(() => summarizeSoak({ rate: 150, droppedIterations: 0, windows: long, tail: 0, unrecorded: 0, memory, before: held, after: held, events: [] }), /aggregate failed requests/);
  assert.throws(() => steadyReport({ schema: "marketplace-results/v6" }), /not a/);
});

test("the timed reporter lists every differing or missing input and never judges the warmup", () => {
  assert.throws(() => convergenceLines(likeRound(), ["corten"], null), /reads a convergence pass/);
  const lines = convergenceLines(likeRound(), ["corten", "aspnet"], convergencePass());
  assert.match(lines[0], /^Convergence evidence: pass w3 \(marketplace-convergence\/v2, reading marketplace-tolerance\/v4\), measured at commit `c{40}`\. Host CPU: Synthetic test only\. One 32-user closed-loop pass .* after the timed round's cold start\.$/);
  assert.match(lines[1], /^The pass is like-for-like with this round on every input compared: commit, group, adapter images, .* startup timeout, memory limits, response encoding, .* a timed warmup with no failed request\.$/);
  assert.match(lines[2], /^Tolerance reading marketplace-tolerance\/v4: a screening reading of throughput, not a certificate of steady state\./);
  assert.ok(lines.includes("Reading: aspnet api page: within the stated tolerance from the window ending at 90 s."));
  assert.ok(lines.includes("Reading: corten fixture json: within the stated tolerance from the window ending at 15 s."));
  const judged = (warmup) => `This report does not judge whether this round's ${warmup}s warmup was long enough: a timed warmup is set only by a separate reviewed change from a saved like-for-like pass.`;
  assert.equal(lines.at(-1), judged(10));
  // Even a like-for-like pass whose readings all start before the warmup's end is not a conclusion.
  const long = convergenceLines(likeRound(300), ["corten"], convergencePass());
  assert.equal(long.at(-1), judged(300));
  for (const text of [lines, long]) assert.ok(!text.some((l) => /reaches|is shorter than|is enough|supports|establish/.test(l)), text.join("\n"));

  const pass = convergencePass(), explore = convergencePass(); explore.options.vus = 64;
  const otherStart = convergencePass(); otherStart.startup = "one readiness request/v0";
  const host = likeRound().host;
  const withMeasurement = (change) => { const round = likeRound(90); change(round.measurement); return round; };
  const unpinnedPass = convergencePass(); unpinnedPass.measurement.cpus = cpuSettings({});
  const unlike = [
    [{ ...likeRound(90), commit: "a".repeat(40) }, pass, /the pass measured commit `c{40}`, this round `a{40}`/],
    [{ ...likeRound(90), options: { warmup: 90, startupTimeout: 120, group: "production" } }, pass, /the pass ran no group, this round group production/],
    [{ ...likeRound(90), apps: { corten: { imageId: `sha256:${"3".repeat(64)}`, runs: runs() } } }, pass, /the image IDs differ for corten/],
    [{ ...likeRound(90), apps: { corten: { runs: runs() } } }, pass, /image IDs are not recorded on both sides for corten/],
    [withMeasurement((m) => { m.cpus.app.quota = 2; }), pass, /the app CPU quota differs \(pass: 1; round: 2\)/],
    [withMeasurement((m) => { m.cpus = cpuSettings({ ...pinnedEnv, MARKETPLACE_APP_CPUS: "0" }); }), pass, /the app CPU pinning \(cpuset\) differs \(pass: 1; round: 0\)/],
    // Missing pinning is missing on either side, not equal because both are absent.
    [withMeasurement((m) => { m.cpus = cpuSettings({}); }), pass, /the app CPU pinning \(cpuset\) is not recorded on both sides \(pass: 1; round: not recorded\)/],
    [withMeasurement((m) => { m.cpus = cpuSettings({}); }), unpinnedPass, /the app CPU pinning \(cpuset\) is not recorded on both sides \(pass: not recorded; round: not recorded\)/],
    [{ ...likeRound(90), measurement: {} }, pass, /the app CPU quota is not recorded on both sides/],
    [withMeasurement((m) => { m.appMemoryBytes = 2 ** 31; }), pass, /the app memory limit \(bytes\) differs \(pass: 1073741824; round: 2147483648\)/],
    [withMeasurement((m) => { delete m.upstreamMemoryBytes; }), pass, /the upstream memory limit \(bytes\) is not recorded on both sides/],
    [withMeasurement((m) => { m.encoding = "br"; }), pass, /the response encoding differs \(pass: identity; round: br\)/],
    [{ ...likeRound(90), options: { warmup: 90, startupTimeout: 60 } }, pass, /the startup timeout \(s\) differs \(pass: 120; round: 60\)/],
    [{ ...likeRound(90), options: { warmup: 90 } }, pass, /the startup timeout \(s\) is not recorded on both sides/],
    [{ ...likeRound(90), host: { ...host, cpu: "Another CPU" } }, pass, /the host CPU differs \(pass: Synthetic test only; round: Another CPU\)/],
    [{ ...likeRound(90), host: {} }, pass, /the host CPU is not recorded on both sides \(pass: Synthetic test only; round: not recorded\)/],
    [likeRound(90), explore, /the pass ran 64 users, the timed warmup 32/],
    [{ ...likeRound(90), split: { droplets: 2, parts: [] } }, pass, /split across droplets/],
    [{ ...likeRound(90), fixtureSha256: "e".repeat(64) }, pass, /the fixture SHA-256 differs/],
    [{ ...likeRound(90), fixtureSha256: undefined }, pass, /the fixture SHA-256 is not recorded on both sides \(pass: f{64}; round: not recorded\)/],
    [{ ...likeRound(90), tools: { ...tools, upstream: { imageId: `sha256:${"6".repeat(64)}` } } }, pass, /the upstream image ID differs/],
    [{ ...likeRound(90), tools: {} }, pass, /the upstream image ID is not recorded on both sides/],
    [{ ...likeRound(90), tools: { ...tools, k6: { imageId: `sha256:${"6".repeat(64)}` } } }, pass, /the k6 image ID differs/],
    [{ ...likeRound(90), host: { ...host, release: "6.8.0-other" } }, pass, /the kernel release differs \(pass: 6\.8\.0-test; round: 6\.8\.0-other\)/],
    [{ ...likeRound(90), host: { ...host, onlineCpus: "0-3" } }, pass, /the online CPU set differs \(pass: 0-7; round: 0-3\)/],
    [likeRound(90), otherStart, /the pass started each app another way than the timed round's cold start \(one readiness request\/v0\)/],
    [{ ...likeRound(90), schema: v5Schema }, pass, /this round's page warmup \(marketplace-results\/v5\) used one locale per profile, while the pass rotates locales/],
    [{ ...likeRound(90), schema: undefined }, pass, /this round's page warmup does not record its locale profiles/],
    // A timed warmup that itself failed requests, or does not say, makes the round not comparable.
    [{ ...likeRound(90), apps: { corten: { imageId: imageIds.corten, runs: runs(3) } } }, pass, /this round's timed warmup had failed requests for corten \(fixture-rotating-page: 3\), so it is not comparable/],
    [{ ...likeRound(90), apps: { corten: { imageId: imageIds.corten, runs: { "fixture-json": [{ warmup: { requests: 5 } }] } } } }, pass, /this round does not record the failed requests of corten's timed warmup \(fixture-json\)/],
    [{ ...likeRound(90), apps: { corten: { imageId: imageIds.corten } } }, pass, /this round records no timed warmup for corten/],
  ];
  for (const [round, p, reason] of unlike) {
    const text = convergenceLines(round, ["corten"], p);
    assert.match(text[1], /^The pass is not like-for-like with this round\. Differing or missing inputs: /);
    assert.match(text[1], reason);
    assert.ok(text.some((l) => /^Reading: corten fixture page: /.test(l)), "the readings stay listed");
    assert.equal(text.at(-1), judged(90));
  }
  const missing = convergenceLines(likeRound(), ["corten", "drogon"], convergencePass());
  assert.ok(missing.includes("No convergence pass for: drogon fixture page, drogon fixture json, drogon api page, drogon api json."));
  assert.match(missing[1], /image IDs are not recorded on both sides for drogon/);
  const falling = convergencePass(); falling.options = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "5"], apps, groupApps);
  falling.cells = falling.cells.map((c) => cellOf(c.app, c.source, c.target, Array.from({ length: 20 }, (_, i) => (c.app === "corten" && c.source === "fixture" && c.target === "page" ? 1500 - 25 * i : 1000))));
  const fallingText = "not within tolerance at the end: the median of the first 60 s and the median of the 60 s before the last 60 s are each more than 5% above the last 60 s median";
  assert.ok(convergenceLines(likeRound(90), ["corten"], falling).includes(`Reading: corten fixture page: ${fallingText}.`));
  assert.ok(convergenceReport(falling).includes(`| corten | fixture | page | ${fallingText} |`));
  const forged = convergencePass(); forged.cells[0] = cellOf("corten", "fixture", "page", Array.from({ length: 12 }, (_, i) => 500 + 50 * i));
  forged.cells[0].verdict = { withinTolerance: true, window: 0, fromSeconds: 15, tailRps: 1, previousRps: 1, headRps: 1 };
  assert.throws(() => convergenceLines(likeRound(), ["corten"], forged), /saved verdict differs/);
});

test("a convergence cell refuses an app that stopped, restarted, was replaced or was OOM-killed", () => {
  const inspect = (o = {}) => ({ Id: "a".repeat(64), RestartCount: 0, ...o, State: { Running: true, OOMKilled: false, ExitCode: 0, StartedAt: "2026-11-20T00:00:00.000000001Z", ...o.State } });
  heldThrough(inspect(), inspect());
  for (const after of [inspect({ State: { OOMKilled: true } }), inspect({ State: { Running: false, ExitCode: 137 } }), inspect({ RestartCount: 1 }),
    // A docker restart keeps RestartCount and the ID but not StartedAt; another ID is another container.
    inspect({ State: { StartedAt: "2026-11-20T00:01:00.000000001Z" } }), inspect({ Id: "b".repeat(64) })])
    assert.throws(() => heldThrough(inspect(), after), /stopped, restarted, was replaced or was OOM-killed/);
  assert.throws(() => heldThrough({ RestartCount: 0, State: { Running: true } }, inspect()), /instance before the load is not recorded/);
  // steady-run.test.mjs shows the runner applying it to a cell whose app was OOM-killed or restarted under load.
});
