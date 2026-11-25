import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { checkFixture, convergenceLines, convergenceSchema, flattenPoint, flattenRule, parseSteadyArgs, readWindows, soakSchema, summarizeSoak, supportedWarmup, validateConvergence, validateSoak } from "./steady-contract.mjs";
import { convergenceReport, soakReport, steadyReport } from "./steady-report.mjs";
import { groupApps } from "./groups.mjs";
import { apps } from "./contract.mjs";

const seconds = 15;
// Windows from a list of throughputs, as readWindows returns them.
const windows = (rps, p95 = () => 10, size = seconds) => rps.map((r, index) => ({ index, startSeconds: index * size, seconds: size, requests: r * size, failed: 0, rps: r, p95: r ? p95(index) : null, p99: r ? p95(index) * 2 : null }));

test("a pass that warms and then holds flattens at the window it stopped getting faster", () => {
  const v = flattenPoint(windows([400, 700, 900, 980, 1000, 1010, 995, 1005, 1000, 998, 1002, 1000]));
  assert.deepEqual(v, { flattened: true, window: 3, atSeconds: 45, tailRps: 1000, previousRps: 1002.5, slowerAtEnd: false });
});
test("an adapter with nothing to warm flattens in its first window", () => {
  const v = flattenPoint(windows(Array(20).fill(1200)));
  assert.equal(v.flattened, true); assert.equal(v.window, 0); assert.equal(v.atSeconds, 0);
});
test("a pass still getting faster at its end never flattened", () => {
  const rising = windows(Array.from({ length: 20 }, (_, i) => 500 + 40 * i));
  assert.deepEqual(flattenPoint(rising), { flattened: false, reason: "still-rising", tailRps: 1200, previousRps: 1040, slowerAtEnd: false });
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
  // Two consecutive dips at the very end are not noise: steady state did not hold to the end.
  assert.equal(flattenPoint(windows([...Array(14).fill(1000), 700, 700])).reason, "short-steady");
});
test("short, empty and degrading passes are stated, not forced to a window", () => {
  assert.deepEqual(flattenPoint(windows([1000, 1000, 1000, 1000, 1000, 1000, 1000])), { flattened: false, reason: "too-few-windows" });
  assert.equal(flattenPoint(windows([1000, 1000, 1000, 1000, 0, 0, 0, 0])).reason, "no-throughput");
  // Back within the tolerance for only the last two windows: steady for less than the hold.
  assert.deepEqual(flattenPoint(windows([...Array(8).fill(1000), 800, 800, 1000, 1000])), { flattened: false, reason: "short-steady", tailRps: 900, previousRps: 1000, slowerAtEnd: true });
  const slower = flattenPoint(windows([1500, 1400, 1300, 1200, 1100, 1000, 1000, 1000, 1000, 1000, 1000, 1000]));
  assert.equal(slower.flattened, true); assert.equal(slower.slowerAtEnd, true);
  assert.throws(() => flattenPoint(windows([1, 2, 3, 4, 5, 6, 7, 8]), { ...flattenRule, tolerance: 0.5 }), /stated flatten rule/);
  assert.throws(() => flattenPoint([{ rps: Number.NaN, startSeconds: 0 }]), /finite/);
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
  assert.deepEqual([c.minutes, c.windowSeconds, c.windows, c.vus, c.rate, c.targets, c.sources, c.apps], [5, 15, 20, 64, null, ["page", "json"], ["fixture", "api"], groupApps("production")]);
  const s = parseSteadyArgs(["soak", "w4", "--apps", "corten,aspnet", "--minutes", "60", "--interval", "30", "--targets", "json,page"], inventory, groupApps);
  assert.deepEqual([s.minutes, s.windowSeconds, s.windows, s.rate, s.vus, s.targets, s.apps], [60, 30, 120, 150, null, ["page", "json"], ["corten", "aspnet"]]);
  for (const [args, pattern] of [
    [["soak", "w4", "--minutes", "20"], /30 to 60/], [["soak", "w4", "--minutes", "61"], /30 to 60/],
    [["convergence", "w3", "--minutes", "1"], /2 to 30/], [["convergence", "w3", "--interval", "30"], /soak option/],
    [["soak", "w4", "--vus", "64"], /fixed rate/], [["convergence", "w3", "--window", "7"], /whole number of windows/],
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
  assert.match(source, /docker\(\[args\[0\], "--name", name, \.\.\.ownerArgs,/);
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

function convergencePass({ commit = "c".repeat(40), cells } = {}) {
  const options = parseSteadyArgs(["convergence", "w3", "--apps", "corten,aspnet", "--minutes", "3"], apps, groupApps);
  const rps = { corten: Array(12).fill(1000), aspnet: [200, 400, 600, 800, 900, 1000, 1000, 1000, 1000, 1000, 1000, 1000] };
  return { schema: convergenceSchema, name: "w3", runId: "marketplace-convergence-w3-0", options, rule: flattenRule, commit, dirty: false, complete: true,
    startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T01:00:00Z", host: { cpu: "Synthetic test only", onlineCpus: "0-7" }, admission: null, failures: [], cleanupFailures: [],
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
  assert.match(text, /Supported timed warmup: at least 75 s/);
  assert.match(text, /^corten fixture page req\/s by window: 1000\.0, 1000\.0/m);
  assert.equal(steadyReport(s), text);
  for (const mutate of [
    (v) => { v.cells[0].verdict = { ...v.cells[0].verdict, window: 4 }; },
    (v) => { v.cells[1].windows[3].rps = 9999; },
    (v) => { v.cells.pop(); },
    (v) => { v.complete = false; },
    (v) => { v.dirty = true; },
    (v) => { v.rule = { ...flattenRule, holdWindows: 2 }; },
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
  const cell = summarizeSoak({ windows: w, tail: 0, unrecorded: 0, memory, before: held, after: held, events: [] });
  // Medians of the samples in the first interval (100.0 to 105.9 MiB) and the last (130.0 to 135.9).
  assert.equal(cell.memory.samples, 360);
  assert.ok(Math.abs(cell.memory.startMiB - 102.95) < 1e-9 && Math.abs(cell.memory.endMiB - 132.95) < 1e-9 && Math.abs(cell.memory.growthMiB - 30) < 1e-9, JSON.stringify(cell.memory));
  assert.deepEqual(cell.p99, { first: 20, last: 30, max: 30 });
  assert.deepEqual(cell.restarts, { restarted: false, restartCount: 0, events: [], runningAtEnd: true, oomKilled: false });
  const restarted = summarizeSoak({ windows: w, tail: 0, unrecorded: 0, memory, before: held, after: { restartCount: 0, running: false, oomKilled: true }, events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }, { action: "exec_start", atSeconds: 1 }] });
  assert.deepEqual(restarted.restarts, { restarted: true, restartCount: 0, events: [{ action: "oom", atSeconds: 70 }, { action: "die", atSeconds: 70.1 }], runningAtEnd: false, oomKilled: true });
  assert.equal(summarizeSoak({ windows: w, tail: 0, unrecorded: 0, memory, before: held, after: { ...held, restartCount: 2 }, events: [] }).restarts.restarted, true);
  assert.throws(() => summarizeSoak({ windows: w, tail: 0, unrecorded: 0, memory: memory.slice(0, 10), before: held, after: held, events: [] }), /first and last interval/);
  assert.throws(() => summarizeSoak({ windows: w, tail: 0, unrecorded: 0, memory, before: { ...held, restartCount: 1 }, after: held, events: [] }), /backwards/);

  const options = parseSteadyArgs(["soak", "w4", "--apps", "corten", "--targets", "page", "--sources", "fixture"], apps, groupApps);
  const long = windows(Array(30).fill(150), (i) => (i === 29 ? 40 : 10), 60);
  const s = { schema: soakSchema, name: "w4", options, commit: "d".repeat(40), dirty: false, complete: true, startedAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T01:00:00Z",
    host: { cpu: "Synthetic test only" }, admission: { round: "w2", commit: "e".repeat(40), summarySha256: "f".repeat(64), path: "x", selected: ["corten", "aspnet"], admitted: ["corten"] },
    cells: [{ app: "corten", source: "fixture", target: "page", ...summarizeSoak({ windows: long, tail: 0, unrecorded: 0, memory: Array.from({ length: 1800 }, (_, i) => ({ atSeconds: i, mib: i < 60 ? 50 : 80 })), before: held, after: held, events: [] }) }] };
  validateSoak(s);
  const text = soakReport(s);
  assert.match(text, /^\| corten \| fixture \| page \| 50\.0 \| 80\.0 \| \+30\.0 MiB \(60\.0%\) \| 20\.0 \/ 80\.0 \/ 80\.0 \| 0 \| no \|$/m);
  assert.match(text, /those timed round w2 .* admitted, of corten, aspnet/);
  assert.equal(steadyReport(s), text);
  const bad = structuredClone(s); bad.cells[0].memory.growthMiB = 0; assert.throws(() => validateSoak(bad), /memory/);
  assert.throws(() => steadyReport({ schema: "marketplace-results/v6" }), /not a/);
});

test("the timed reporter's convergence statement says none exists, or which pass and what it shows", () => {
  const round = { commit: "c".repeat(40), options: { warmup: 10 } };
  assert.deepEqual(convergenceLines(round, ["corten", "aspnet"], null), ["Convergence evidence: none exists for this round. Nothing saved shows that each measured adapter had stopped getting faster by the end of its 10s warmup; the timed numbers may include warming."]);
  const lines = convergenceLines(round, ["corten", "aspnet"], convergencePass());
  assert.match(lines[0], /^Convergence evidence: pass w3 \(marketplace-convergence\/v1, rule marketplace-flatten\/v1\), measured at commit `c{40}`, this round's commit, on Synthetic test only\./);
  assert.ok(lines.includes("Flatten: aspnet api page: window 5 (75 s)."));
  assert.ok(lines.includes("Flatten: corten fixture json: window 0 (0 s)."));
  assert.match(lines.at(-1), /^The slowest measured adapter flattened at 75 s \(aspnet fixture page\); this round's 10s warmup is shorter than that point\./);
  assert.match(convergenceLines({ ...round, options: { warmup: 90 } }, ["corten"], convergencePass()).at(-1), /flattened at 0 s \(corten fixture page\); this round's 90s warmup reaches that point/);
  const other = convergenceLines({ ...round, commit: "a".repeat(40) }, ["corten"], convergencePass());
  assert.match(other[0], /not this round's `a{40}`: adapter inputs may differ/);
  const missing = convergenceLines(round, ["corten", "drogon"], convergencePass());
  assert.ok(missing.includes("No convergence pass for: drogon fixture page, drogon fixture json, drogon api page, drogon api json."));
  assert.match(missing.at(-1), /does not establish the round's 10s warmup/);
  const never = convergencePass();
  never.cells[0].windows = windows(Array.from({ length: 12 }, (_, i) => 500 + 50 * i)); never.cells[0].verdict = flattenPoint(never.cells[0].windows);
  const neverLines = convergenceLines(round, ["corten"], never);
  assert.ok(neverLines.includes("Flatten: corten fixture page: never: still getting faster at the end."));
  assert.match(neverLines.at(-1), /Not every measured adapter is shown at steady state/);
  const forged = convergencePass(); forged.cells[0].verdict = { flattened: true, window: 0, atSeconds: 0, tailRps: 1, previousRps: 1, slowerAtEnd: false };
  forged.cells[0].windows = windows(Array.from({ length: 12 }, (_, i) => 500 + 50 * i));
  assert.throws(() => convergenceLines(round, ["corten"], forged), /saved verdict differs/);
});