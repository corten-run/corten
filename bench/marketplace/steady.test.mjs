import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { checkFixture, convergenceLines, convergenceSchema, flattenPoint, flattenRule, heldThrough, parseSteadyArgs, readDropped, readWindows, soakSchema, summarizeSoak, supportedWarmup, timedWarmupVus, validateConvergence, validateSoak } from "./steady-contract.mjs";
import { cpuSettings } from "./run-contract.mjs";
import { convergenceReport, soakReport, steadyReport } from "./steady-report.mjs";
import { groupApps } from "./groups.mjs";
import { apps } from "./contract.mjs";

const seconds = 15;
// Windows from a list of throughputs, as readWindows returns them.
const windows = (rps, p95 = () => 10, size = seconds) => rps.map((r, index) => ({ index, startSeconds: index * size, seconds: size, requests: r * size, failed: 0, rps: r, p95: r ? p95(index) : null, p99: r ? p95(index) * 2 : null }));

test("a pass that warms and then holds flattens at the window it stopped getting faster", () => {
  const v = flattenPoint(windows([400, 700, 900, 980, 1000, 1010, 995, 1005, 1000, 998, 1002, 1000]));
  assert.deepEqual(v, { flattened: true, window: 3, atSeconds: 45, tailRps: 1000, previousRps: 1002.5, headRps: 800 });
});
test("an adapter with nothing to warm flattens in its first window", () => {
  const v = flattenPoint(windows(Array(20).fill(1200)));
  assert.equal(v.flattened, true); assert.equal(v.window, 0); assert.equal(v.atSeconds, 0);
});
test("a pass still moving up at its end is not shown steady", () => {
  const rising = windows(Array.from({ length: 20 }, (_, i) => 500 + 40 * i));
  assert.deepEqual(flattenPoint(rising), { flattened: false, reason: "still-rising", tailRps: 1200, previousRps: 1040, headRps: 560 });
  // A late jump (a tier-up after most of the pass) also counts as still rising.
  assert.equal(flattenPoint(windows([...Array(14).fill(800), 800, 800, 900, 900, 900, 900])).reason, "still-rising");
});
test("one noisy window neither ends nor starts steady state", () => {
  // A dip in the middle of steady state and another in the last window.
  const v = flattenPoint(windows([500, 800, 1000, 1000, 1000, 600, 1000, 1000, 1000, 1000, 1000, 700]));
  assert.equal(v.flattened, true); assert.equal(v.window, 2);
  // A single early spike does not start steady state before warming ends.
  assert.equal(flattenPoint(windows([500, 1000, 500, 600, 800, 1000, 1000, 1000, 1000, 1000, 1000, 1000])).window, 5);
  // Noise within the tolerance either side of steady throughput flattens at once.
  assert.equal(flattenPoint(windows(Array.from({ length: 16 }, (_, i) => (i % 2 ? 1030 : 970)))).window, 0);
  // Two consecutive dips at the very end are not noise: the pass got slower at the end.
  assert.equal(flattenPoint(windows([...Array(14).fill(1000), 700, 700])).reason, "slower-at-end");
});
test("short, empty and degrading passes are stated, not forced to a window", () => {
  assert.deepEqual(flattenPoint(windows([1000, 1000, 1000, 1000, 1000, 1000, 1000])), { flattened: false, reason: "too-few-windows" });
  assert.equal(flattenPoint(windows([1000, 1000, 1000, 1000, 0, 0, 0, 0])).reason, "no-throughput");
  // A pass oscillating more than the tolerance either side of its tail never holds within the band.
  assert.deepEqual(flattenPoint(windows([800, 800, 800, 800, 1000, 1000, 600, 600, 1000, 1000, 600, 600])), { flattened: false, reason: "short-steady", tailRps: 800, previousRps: 800, headRps: 800 });
  // A pass that got slower and then held is not called steady: its first 60 s were faster.
  assert.deepEqual(flattenPoint(windows([1500, 1400, 1300, 1200, 1100, 1000, 1000, 1000, 1000, 1000, 1000, 1000])), { flattened: false, reason: "slower-at-end", tailRps: 1000, previousRps: 1000, headRps: 1350 });
  assert.throws(() => flattenPoint(windows([1, 2, 3, 4, 5, 6, 7, 8]), { ...flattenRule, tolerance: 0.5 }), /stated flatten rule/);
  assert.throws(() => flattenPoint([{ rps: Number.NaN, startSeconds: 0 }]), /finite/);
});

test("a runtime that keeps getting slower is never flattened, at any rate of decline", () => {
  // 20 windows falling 1500 to 1025 req/s: a lower bound alone read this as flattened at window 0.
  const falling = windows(Array.from({ length: 20 }, (_, i) => 1500 - 25 * i));
  assert.deepEqual(flattenPoint(falling), { flattened: false, reason: "slower-at-end", tailRps: 1062.5, previousRps: 1162.5, headRps: 1462.5 });
  // A decline too slow for the last two minutes to tell apart is caught by the first 60 s.
  const slow = flattenPoint(windows(Array.from({ length: 20 }, (_, i) => 1200 - 5 * i)));
  assert.equal(slow.flattened, false); assert.equal(slow.reason, "slower-at-end");
  // The band has an upper bound too: two consecutive windows above it end the steady run before them.
  assert.equal(flattenPoint(windows([...Array(8).fill(1000), 1200, 1200, ...Array(10).fill(1000)])).window, 10);
});

test("the flatten rule is in seconds, so the window length does not change it", () => {
  // The same curve, 500 req/s for 30 s and 1000 after, in 15, 5 and 10 s windows.
  const at = (size) => flattenPoint(windows(Array.from({ length: 180 / size }, (_, i) => (i * size < 30 ? 500 : 1000)), () => 10, size));
  assert.deepEqual([at(15).atSeconds, at(5).atSeconds, at(10).atSeconds], [30, 30, 30]);
  // 45 s back at the earlier level after a dip is not shown steady, in either window length.
  const short = (size) => flattenPoint(windows(Array.from({ length: 240 / size }, (_, i) => (i * size < 120 ? 1000 : i * size < 195 ? 600 : 1000)), () => 10, size));
  assert.equal(short(15).flattened, false); assert.equal(short(5).flattened, false);
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
  assert.equal(read.tail, 7); assert.equal(read.unrecorded, 0);
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
  // steady.mjs puts the same arguments on every container it creates, its network and the k6 probe.
  const source = readFileSync(new URL("./steady.mjs", import.meta.url), "utf8");
  assert.match(source, /const id = await docker\(\[args\[0\], "--name", name, \.\.\.ownerArgs,/);
  assert.match(source, /describeK6\(docker, ownerArgs,/);
  assert.match(source, /\["network", "create", \.\.\.ownerArgs, network\]/);
  assert.doesNotMatch(source, /agent\.owner/);
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
// A timed round like-for-like with convergencePass(): the same commit, images, CPU settings and host.
const likeRound = (warmup = 10) => ({ commit: "c".repeat(40), options: { warmup }, host: { cpu: "Synthetic test only" }, measurement: { cpus: cpuSettings({}) },
  apps: { corten: { imageId: imageIds.corten }, aspnet: { imageId: imageIds.aspnet } } });
function convergencePass({ commit = "c".repeat(40), cells } = {}) {
  const options = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "3"], apps, groupApps);
  const rps = { corten: Array(12).fill(1000), aspnet: [200, 400, 600, 800, 900, 1000, 1000, 1000, 1000, 1000, 1000, 1000] };
  return { schema: convergenceSchema, name: "w3", runId: "marketplace-convergence-w3-0", options, rule: flattenRule, commit, dirty: false, complete: true,
    startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T01:00:00Z", host: { cpu: "Synthetic test only", onlineCpus: "0-7" }, admission: null, failures: [], cleanupFailures: [],
    images: { corten: imageIds.corten, aspnet: imageIds.aspnet }, measurement: { cpus: cpuSettings({}) },
    cells: cells ?? options.sources.flatMap((source) => options.apps.flatMap((app) => options.targets.map((target) => {
      const w = windows(rps[app]);
      return { app, source, target, windows: w, tail: 3, unrecorded: 0, verdict: flattenPoint(w) };
    }))) };
}
test("a saved convergence pass validates, recomputes every verdict and supports a warmup", () => {
  const s = convergencePass();
  validateConvergence(s);
  assert.equal(supportedWarmup(s), 75);
  const text = convergenceReport(s);
  assert.match(text, /^\| aspnet \| api \| json \| window 5 \(75 s\) \| 1000\.0 \| 0 \|$/m);
  assert.match(text, /Supported timed warmup: at least 75 s, the latest flatten window's start, for the commit, images, CPU settings and host this pass ran on\. It ran the timed warmup's 32 users\./);
  const explore = structuredClone(s); explore.options.vus = 64;
  assert.match(convergenceReport(explore), /It ran 64 users, not the timed warmup's 32, so it is exploration/);
  assert.match(text, /^corten fixture page req\/s by window: 1000\.0, 1000\.0/m);
  assert.match(text, /^corten fixture page p95 ms by window: \d/m);
  assert.match(text, /^corten fixture page p99 ms by window: \d/m);
  assert.match(text, /it says when each adapter stopped changing/);
  assert.match(text, /^No group: the ungrouped images and container settings, not a group's timed configuration\.$/m);
  assert.equal(steadyReport(s), text);
  for (const mutate of [
    (v) => { v.cells[0].verdict = { ...v.cells[0].verdict, window: 4 }; },
    (v) => { v.cells[1].windows[3].rps = 9999; },
    (v) => { v.cells.pop(); },
    (v) => { v.complete = false; },
    (v) => { v.dirty = true; },
    (v) => { v.rule = { ...flattenRule, holdSeconds: 30 }; },
    (v) => { delete v.images.aspnet; },
    (v) => { v.images.corten = "cb-marketplace-corten"; },
    (v) => { delete v.measurement; },
    (v) => { v.cells[0].windows[0].p95 = null; },
  ]) { const v = structuredClone(s); mutate(v); assert.throws(() => validateConvergence(v)); }
  const failed = structuredClone(s);
  Object.assign(failed.cells[2], { windows: undefined, tail: undefined, unrecorded: undefined, verdict: null, failure: "not ready in 120s: HTTP 500" });
  for (const key of ["windows", "tail", "unrecorded"]) delete failed.cells[2][key];
  validateConvergence(failed);
  assert.equal(supportedWarmup(failed), null);
  assert.match(convergenceReport(failed), /Supported timed warmup: none/);
});

test("a soak reports memory at the start and end, p99 per interval and any restart", () => {
  const w = windows([150, 150, 150, 150, 150, 150], (i) => 10 + i, 15);
  const memory = Array.from({ length: 360 }, (_, i) => ({ atSeconds: i / 4, mib: 100 + i / 10 }));
  const held = { restartCount: 0, running: true, oomKilled: false };
  const cell = summarizeSoak({ rate: 150, droppedIterations: 0, windows: w, tail: 0, unrecorded: 0, memory, before: held, after: held, events: [] });
  // Medians of the samples in the first interval (100.0 to 105.9 MiB) and the last (130.0 to 135.9).
  assert.equal(cell.memory.samples, 360);
  assert.ok(Math.abs(cell.memory.startMiB - 102.95) < 1e-9 && Math.abs(cell.memory.endMiB - 132.95) < 1e-9 && Math.abs(cell.memory.growthMiB - 30) < 1e-9, JSON.stringify(cell.memory));
  assert.deepEqual(cell.p99, { first: 20, last: 30, max: 30 });
  assert.deepEqual(cell.restarts, { restarted: false, restartCount: 0, events: [], runningAtEnd: true, oomKilled: false });
  const restarted = summarizeSoak({ rate: 150, droppedIterations: 0, windows: w, tail: 0, unrecorded: 0, memory, before: held, after: { restartCount: 0, running: false, oomKilled: true }, events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }, { action: "exec_start", atSeconds: 1 }] });
  assert.deepEqual(restarted.restarts, { restarted: true, restartCount: 0, events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }], runningAtEnd: false, oomKilled: true });
  assert.equal(summarizeSoak({ rate: 150, droppedIterations: 0, windows: w, tail: 0, unrecorded: 0, memory, before: held, after: { ...held, restartCount: 2 }, events: [] }).restarts.restarted, true);
  assert.throws(() => summarizeSoak({ rate: 150, droppedIterations: 0, windows: w, tail: 0, unrecorded: 0, memory: memory.slice(0, 10), before: held, after: held, events: [] }), /first and last interval/);
  assert.throws(() => summarizeSoak({ rate: 150, droppedIterations: 0, windows: w, tail: 0, unrecorded: 0, memory, before: { ...held, restartCount: 1 }, after: held, events: [] }), /backwards/);

  const options = parseSteadyArgs(["soak", "w4", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const long = windows(Array(30).fill(150), (i) => (i === 29 ? 40 : 10), 60);
  const s = { schema: soakSchema, name: "w4", options, commit: "d".repeat(40), dirty: false, complete: true, startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T01:00:00Z",
    host: { cpu: "Synthetic test only" }, admission: { round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: "x", selected: ["corten", "aspnet"], admitted: ["corten"] },
    cells: [{ app: "corten", source: "fixture", target: "page", ...summarizeSoak({ rate: 150, droppedIterations: 0, windows: long, tail: 0, unrecorded: 0, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: i < 60 ? 50 : 80 })), before: held, after: held, events: [] }) }] };
  validateSoak(s);
  const text = soakReport(s);
  assert.match(text, /^\| corten \| fixture \| page \| held \| 50\.0 \| 80\.0 \| \+30\.0 MiB \(60\.0%\) \| 20\.0 \/ 80\.0 \/ 80\.0 \| 0 \| no \|$/m);
  assert.match(text, /those timed round w2 .* admitted, of corten, aspnet/);
  // The soak says what a soak shows, not the convergence pass's "stopped changing".
  assert.match(text, /it says whether each adapter's memory, tail latency and process held at the rate asked for/);
  assert.doesNotMatch(text, /was not met/);
  assert.doesNotMatch(text, /stopped changing/);
  assert.match(text, /^No group: /m);
  const grouped = structuredClone(s); grouped.options.group = "production";
  assert.match(soakReport(grouped), /^Group production: its images and container settings\.$/m);
  assert.equal(steadyReport(s), text);
  const bad = structuredClone(s); bad.cells[0].memory.growthMiB = 0; assert.throws(() => validateSoak(bad), /memory/);
  // A soak whose k6 dropped iterations did not run the fixed rate: stated, and not presented as a fixed-rate result.
  assert.equal(readDropped({ metrics: { dropped_iterations: { count: 37, rate: 0.02 } } }), 37);
  assert.equal(readDropped({ metrics: {} }), 0);
  const dropped = structuredClone(s);
  Object.assign(dropped.cells[0], summarizeSoak({ rate: 150, droppedIterations: 37, windows: long, tail: 0, unrecorded: 0, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: 50 })), before: held, after: held, events: [] }));
  assert.deepEqual(dropped.cells[0].rate, { requested: 150, droppedIterations: 37, met: false });
  const droppedText = soakReport(dropped);
  assert.match(droppedText, /^\| corten \| fixture \| page \| not met: 37 iterations dropped \|/m);
  assert.match(droppedText, /^corten fixture page: the fixed 150 requests\/second was not met \(k6 dropped 37 iterations it could not start on time\), so this is not a fixed-rate result/m);
  for (const mutate of [(v) => { v.cells[0].rate.met = true; }, (v) => { v.cells[0].rate.requested = 20; }, (v) => { delete v.cells[0].rate; }]) { const v = structuredClone(dropped); mutate(v); assert.throws(() => validateSoak(v), /rate/); }
  assert.throws(() => summarizeSoak({ rate: 150, windows: long, tail: 0, unrecorded: 0, memory: [], before: held, after: held, events: [] }), /dropped iterations/);
  assert.throws(() => steadyReport({ schema: "marketplace-results/v6" }), /not a/);
});

test("the timed reporter concludes on the warmup only from a like-for-like pass", () => {
  assert.throws(() => convergenceLines(likeRound(), ["corten"], null), /reads a convergence pass/);
  const lines = convergenceLines(likeRound(), ["corten", "aspnet"], convergencePass());
  assert.match(lines[0], /^Convergence evidence: pass w3 \(marketplace-convergence\/v1, rule marketplace-flatten\/v2\), measured at commit `c{40}`\. Host CPU: Synthetic test only\. One 32-user closed-loop pass/);
  assert.equal(lines[1], "The pass is like-for-like with this round: the same commit, group, images, CPU settings and host CPU, and the timed warmup's 32 users.");
  assert.ok(lines.includes("Flatten: aspnet api page: window 5 (75 s)."));
  assert.ok(lines.includes("Flatten: corten fixture json: window 0 (0 s)."));
  assert.match(lines.at(-1), /^The slowest measured adapter flattened at 75 s \(aspnet fixture page\); this round's 10s warmup is shorter than that point\./);
  assert.match(convergenceLines(likeRound(90), ["corten"], convergencePass()).at(-1), /flattened at 0 s \(corten fixture page\); this round's 90s warmup reaches that point/);
  // Any difference from the round makes the flatten times context only, even when every cell flattened.
  const pass = convergencePass(), explore = convergencePass(); explore.options.vus = 64;
  const unlike = [
    [{ ...likeRound(90), commit: "a".repeat(40) }, pass, /the pass measured commit `c{40}`, this round `a{40}`/],
    [{ ...likeRound(90), options: { warmup: 90, group: "production" } }, pass, /the pass ran no group, this round group production, so their images and container settings differ/],
    [{ ...likeRound(90), apps: { corten: { imageId: `sha256:${"3".repeat(64)}` } } }, pass, /the image IDs differ for corten/],
    [{ ...likeRound(90), apps: { corten: {} } }, pass, /image IDs are not recorded on both sides for corten/],
    [{ ...likeRound(90), measurement: { cpus: cpuSettings({ MARKETPLACE_APP_CPUS: "2" }) } }, pass, /the CPU settings differ \(pass: app 1 CPU/],
    [{ ...likeRound(90), measurement: {} }, pass, /the CPU settings differ/],
    [{ ...likeRound(90), host: { cpu: "Another CPU" } }, pass, /the host CPU differs \(pass: Synthetic test only; round: Another CPU\)/],
    [{ ...likeRound(90), host: {} }, pass, /round: not recorded/],
    [likeRound(90), explore, /the pass ran 64 users, the timed warmup 32/],
    [{ ...likeRound(90), split: { droplets: 2, parts: [] } }, pass, /split across droplets/],
  ];
  for (const [round, p, reason] of unlike) {
    const text = convergenceLines(round, ["corten"], p);
    assert.match(text[1], /^The pass is not like-for-like with this round, so its flatten times below are context only: /);
    assert.match(text[1], reason);
    assert.ok(text.includes("Flatten: corten fixture page: window 0 (0 s)."), "the flatten times stay as context");
    assert.equal(text.at(-1), "This pass does not establish this round's 90s warmup.");
    assert.ok(!text.some((l) => /reaches|is shorter than/.test(l)));
  }
  const missing = convergenceLines(likeRound(), ["corten", "drogon"], convergencePass());
  assert.ok(missing.includes("No convergence pass for: drogon fixture page, drogon fixture json, drogon api page, drogon api json."));
  assert.match(missing.at(-1), /does not establish/);
  const never = convergencePass();
  never.cells[0].windows = windows(Array.from({ length: 12 }, (_, i) => 500 + 50 * i)); never.cells[0].verdict = flattenPoint(never.cells[0].windows);
  const neverLines = convergenceLines(likeRound(), ["corten"], never);
  assert.ok(neverLines.includes("Flatten: corten fixture page: not shown steady at the end."));
  assert.match(neverLines.at(-1), /Not every measured adapter is shown at steady state/);
  // The runtime that keeps getting slower: no warmup is supported and the report does not say it reaches one.
  const falling = convergencePass(); falling.options = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "5"], apps, groupApps);
  falling.cells = falling.cells.map((c) => { const w = windows(Array.from({ length: 20 }, (_, i) => (c.app === "corten" && c.source === "fixture" && c.target === "page" ? 1500 - 25 * i : 1000))); return { ...c, windows: w, verdict: flattenPoint(w) }; });
  assert.equal(supportedWarmup(falling), null);
  const fallingLines = convergenceLines(likeRound(90), ["corten"], falling);
  assert.ok(fallingLines.includes("Flatten: corten fixture page: not shown steady: slower at the end."));
  assert.ok(!fallingLines.some((l) => /reaches/.test(l)));
  assert.match(convergenceReport(falling), /^\| corten \| fixture \| page \| not shown steady: slower at the end \|/m);
  const forged = convergencePass(); forged.cells[0].verdict = { flattened: true, window: 0, atSeconds: 0, tailRps: 1, previousRps: 1, headRps: 1 };
  forged.cells[0].windows = windows(Array.from({ length: 12 }, (_, i) => 500 + 50 * i));
  assert.throws(() => convergenceLines(likeRound(), ["corten"], forged), /saved verdict differs/);
});

test("a convergence cell refuses an app that stopped, restarted or was OOM-killed", () => {
  const inspect = (o = {}) => ({ RestartCount: 0, ...o, State: { Running: true, OOMKilled: false, ExitCode: 0, ...o.State } });
  heldThrough(inspect(), inspect());
  for (const after of [inspect({ State: { OOMKilled: true } }), inspect({ State: { Running: false, ExitCode: 137 } }), inspect({ RestartCount: 1 })])
    assert.throws(() => heldThrough(inspect(), after), /stopped, restarted or was OOM-killed/);
  // steady.mjs applies it to every convergence cell before the verdict.
  assert.match(readFileSync(new URL("./steady.mjs", import.meta.url), "utf8"), /heldThrough\(before, after\);\n\s+const failed/);
});

test("steady.mjs binds every container read and removal to the ID Docker printed", () => {
  const source = readFileSync(new URL("./steady.mjs", import.meta.url), "utf8");
  assert.match(source, /assert\.match\(id, containerId, `docker \$\{args\[0\]\} \$\{name\} did not print a container ID`\)/);
  for (const call of ['docker(["logs", app])', 'docker(["start", "-a", k6]', 'docker(["start", "-a", hostProbe])', 'docker(["rm", "-f", "-v", id]', 'await inspect(app)', 'await inspect(k6)', 'await portOf(upstreamId)'])
    assert.ok(source.includes(call), call);
  // No container is looked up, read or removed by name; a lost create is found by its owner label.
  assert.doesNotMatch(source, /"ps", "-a",[^\]]*`name=/);
  assert.doesNotMatch(source, /inspect\((?:name|upstreamName|hostProbe)\b|"logs", name|remove\(name\)/);
  assert.match(source, /"--filter", `label=\$\{label\}=\$\{runId\}`, "--format", "\{\{\.ID\}\}"\], \{ cleanup: true \}\)\)\.split\("\\n"\)\.filter\(Boolean\);\n\s+for \(const id of found\) await remove\(id, \{ recovered: true \}\)/);
});
