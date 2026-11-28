// window-load.js itself, run in Node with fake k6 modules: its completion-time bucketing (window
// boundaries, the graceful-stop tail, a fractional engine clock) and its handleSummary clock export,
// read back through steady-contract.mjs readWindows. No k6, Docker or app.
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { fixedRateLoad, readWindows } from "./steady-contract.mjs";

// The k6 modules window-load.js imports. Node evaluates each once, so each delegates at call time
// to the current engine in globalThis.__k6.
const fakes = {
  "k6/http": "export default { get: (...a) => globalThis.__k6.http.get(...a), setResponseCallback: (...a) => globalThis.__k6.http.setResponseCallback(...a), expectedStatuses: (...a) => globalThis.__k6.http.expectedStatuses(...a) };",
  "k6/execution": "export default { instance: { get currentTestRunDuration() { return globalThis.__k6.now; } }, scenario: { get iterationInTest() { return globalThis.__k6.iteration; } } };",
  "k6/metrics": "export function Counter(...a) { return new globalThis.__k6.Counter(...a); } export function Trend(...a) { return new globalThis.__k6.Trend(...a); }",
  k6: "export const check = (...a) => globalThis.__k6.check(...a);",
};
registerHooks({
  resolve(specifier, context, next) { return Object.hasOwn(fakes, specifier) ? { url: `k6-fake:${specifier}`, shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url.startsWith("k6-fake:") ? { format: "module", source: fakes[url.slice("k6-fake:".length)], shortCircuit: true } : next(url, context); },
});

// A k6 engine in memory: the clock and iteration the script reads, the metrics it adds to, and the
// status each request gets. Each http.get moves the engine clock on by `latencyMs`, as a request
// that takes that long does, so a test can start a request in one window and complete it in the next.
function engine() {
  const k6 = { now: 0, iteration: 0, status: 200, latencyMs: 0, metrics: new Map(), requests: [] };
  const metric = (name, type) => { assert.ok(!k6.metrics.has(name), `metric ${name} defined twice`); k6.metrics.set(name, { type, values: [] }); return name; };
  k6.Counter = class { constructor(name) { this.name = metric(name, "counter"); } add(v) { k6.metrics.get(this.name).values.push(v); } };
  k6.Trend = class { constructor(name, isTime) { assert.equal(isTime, true); this.name = metric(name, "trend"); } add(v) { k6.metrics.get(this.name).values.push(v); } };
  k6.http = {
    get(url, params) {
      const startedAt = k6.now;
      k6.now += k6.latencyMs;
      const r = { status: k6.status, timings: { duration: k6.latencyMs || 3 + k6.requests.length }, headers: { "Content-Type": "text/html; charset=utf-8" } };
      k6.requests.push({ url, params, startedAt, completedAt: k6.now, ...r });
      return r;
    },
    setResponseCallback() {}, expectedStatuses: (...statuses) => statuses,
  };
  k6.check = (response, checks) => Object.values(checks).every((fn) => fn(response));
  return k6;
}
// k6's summary export from what the script recorded, with k6's own request and iteration totals.
function summaryExport(k6, iterations) {
  const pct = (sorted, p) => { const at = (sorted.length - 1) * p, lo = Math.floor(at); return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo); };
  const trend = (values) => { const s = [...values].sort((a, b) => a - b); return { avg: s.reduce((a, b) => a + b, 0) / s.length, "p(95)": pct(s, 0.95), "p(99)": pct(s, 0.99), max: s.at(-1) }; };
  const metrics = {};
  for (const [name, { type, values }] of k6.metrics) if (values.length) metrics[name] = type === "counter" ? { count: values.reduce((a, b) => a + b, 0), rate: 1 } : trend(values);
  metrics.http_reqs = { count: k6.requests.length, rate: 1 };
  metrics.iterations = { count: iterations, rate: 1 };
  metrics.http_req_duration = trend(k6.requests.map((r) => r.timings.duration));
  return { metrics };
}
let loads = 0;
async function load(env) {
  const k6 = globalThis.__k6 = engine();
  globalThis.__ENV = env;
  const script = await import(`./window-load.js?load=${++loads}`);
  return { k6, script };
}
const closed = { TARGET: "page", MODE: "closed", WINDOWS: "2", WINDOW_SECONDS: "15", VUS: "32", BASE: "http://app:8080" };

test("window-load.js counts each answer in the window its engine clock reads, the tail after the last, and failures in their window", async () => {
  const { k6, script } = await load(closed);
  assert.deepEqual(script.options.scenarios.steady, { executor: "constant-vus", vus: 32, duration: "30s", gracefulStop: "10s" });
  // Fractional engine clock readings either side of each boundary; one 500 in the second window.
  for (const [now, status] of [[0, 200], [14_999.999, 200], [15_000, 200], [20_000.75, 500], [29_999.5, 200], [30_000, 200], [39_999.25, 200]]) {
    k6.now = now; k6.status = status; script.default(); k6.iteration++;
  }
  const count = (name) => k6.metrics.get(name).values.reduce((a, b) => a + b, 0);
  assert.deepEqual([count("window_0_requests"), count("window_1_requests"), count("window_0_failed"), count("window_1_failed"), count("window_tail_requests")], [2, 3, 0, 1, 2]);
  assert.deepEqual([k6.metrics.get("window_0_duration").values.length, k6.metrics.get("window_1_duration").values.length], [2, 3]);
  // Page requests rotate the three locales by iteration.
  assert.deepEqual(k6.requests.slice(0, 4).map((r) => r.url.replace(/item_\d+$/, "item_")), ["http://app:8080/marketplace/en-US/item_", "http://app:8080/marketplace/fr-FR/item_", "http://app:8080/marketplace/de-DE/item_", "http://app:8080/marketplace/en-US/item_"]);
  // readWindows reads the export back: every request is in a window or the tail.
  const read = readWindows(summaryExport(k6, 7), { windows: 2, windowSeconds: 15 });
  assert.deepEqual(read.windows.map((w) => [w.startSeconds, w.requests, w.failed]), [[0, 2, 0], [15, 3, 1]]);
  assert.deepEqual([read.tail, read.unrecorded, read.requests, read.iterations, read.latencyMaxMs], [2, 0, 7, 7, 9]);
  // A request whose iteration the stop cut off before the script counted it is unrecorded.
  k6.requests.push({ timings: { duration: 1 } });
  assert.equal(readWindows(summaryExport(k6, 7), { windows: 2, windowSeconds: 15 }).unrecorded, 1);
});

test("window-load.js writes the engine clock k6 reports, unrounded, and refuses an unknown mode before it runs", async () => {
  const { script } = await load({ ...closed, MODE: "fixed", RATE: "150", TARGET: "json" });
  // The VUs and graceful stop steady-contract.mjs bounds a soak's outstanding iterations by (soakArrivals).
  assert.deepEqual(script.options.scenarios.steady, { executor: "constant-arrival-rate", rate: 150, timeUnit: "1s", duration: "30s", preAllocatedVUs: fixedRateLoad.preAllocatedVUs,
    maxVUs: fixedRateLoad.maxVUs, gracefulStop: `${fixedRateLoad.gracefulStopSeconds}s` });
  assert.deepEqual(script.handleSummary({ state: { testRunDurationMs: 40_000.5 } }), { "/tmp/marketplace-clock.json": JSON.stringify({ testRunDurationMs: 40_000.5 }) });
  await assert.rejects(load({ ...closed, MODE: "open" }), /MODE must be fixed or closed/);
  await assert.rejects(load({ ...closed, WINDOWS: "0" }), /WINDOWS and WINDOW_SECONDS must be positive integers/);
});

test("window-load.js counts a request that starts before a boundary and completes after it in the later window, by its completion", async () => {
  const { k6, script } = await load(closed);
  // Each request takes 2 ms of engine clock. One starts 1 ms before the first boundary, one 1 ms
  // before the end of the last window, and one well inside the first window.
  k6.latencyMs = 2;
  for (const [start, status] of [[1000, 200], [14_999, 500], [29_999, 200]]) { k6.now = start; k6.status = status; script.default(); k6.iteration++; }
  assert.deepEqual(k6.requests.map((r) => [r.startedAt, r.completedAt]), [[1000, 1002], [14_999, 15_001], [29_999, 30_001]]);
  const count = (name) => (k6.metrics.get(name)?.values ?? []).reduce((a, b) => a + b, 0);
  // The one started at 14,999 ms completed at 15,001 ms: it counts in window 1, with its failure and
  // its latency there; the one started at 29,999 ms completed after the last window: the tail.
  assert.deepEqual([count("window_0_requests"), count("window_1_requests"), count("window_0_failed"), count("window_1_failed"), count("window_tail_requests")], [1, 1, 0, 1, 1]);
  assert.deepEqual([k6.metrics.get("window_0_duration").values, k6.metrics.get("window_1_duration").values], [[2], [2]]);
  const read = readWindows(summaryExport(k6, 3), { windows: 2, windowSeconds: 15 });
  assert.deepEqual(read.windows.map((w) => [w.requests, w.failed]), [[1, 0], [1, 1]]);
  assert.equal(read.tail, 1);
});

test("window-load.js counts a fixed-rate iteration's arrival in the window it started in, and a closed loop counts none", async () => {
  const { k6, script } = await load({ ...closed, MODE: "fixed", RATE: "150" });
  // A request started 1 ms before the boundary completes 1 ms after it: its arrival is in window 0,
  // its answer in window 1. A start the engine reads at the end of the last window (its own lag) is
  // that window's arrival.
  k6.latencyMs = 2;
  for (const start of [1000, 14_999, 29_999, 30_000]) { k6.now = start; script.default(); k6.iteration++; }
  const count = (name) => (k6.metrics.get(name)?.values ?? []).reduce((a, b) => a + b, 0);
  assert.deepEqual([count("window_0_arrivals"), count("window_1_arrivals"), count("window_0_requests"), count("window_1_requests"), count("window_tail_requests")], [2, 2, 1, 1, 2]);
  const read = readWindows(summaryExport(k6, 4), { windows: 2, windowSeconds: 15, arrivals: true });
  assert.deepEqual(read.arrivals, [2, 2]);
  // A closed-loop reader refuses arrivals it does not define, without naming them.
  assert.throws(() => readWindows(summaryExport(k6, 4), { windows: 2, windowSeconds: 15 }), /^Error: 2 k6 window metrics are not among this pass's windows$/);
  const looped = await load(closed);
  looped.k6.now = 1000; looped.script.default();
  assert.ok(![...looped.k6.metrics.keys()].some((name) => name.endsWith("_arrivals")), "a closed loop defines no arrival counter");
  assert.equal(readWindows(summaryExport(looped.k6, 1), { windows: 2, windowSeconds: 15 }).arrivals, undefined);
});