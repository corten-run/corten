import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { records as fixture } from "../marketplace/fixtures.mjs";
import { expectedPage, labels } from "../marketplace/records.mjs";
import { createPlan } from "../workloads/mixed.mjs";
import { control, expectedOutcome, sleep } from "./capture.mjs";
import { loadCycle, loadPaths } from "./load-capture.mjs";
import { loadUpstream } from "./load-upstream.mjs";
import { deriveWindow, observedCpuCeiling } from "./metrics.mjs";
import { cpuSettings } from "../catalog/contract.mjs";
import { measureNativeGroup } from "./measure.mjs";

const records = fixture(), plan = createPlan({ seed: 42, clients: 2, repetitions: 1, records });
const settings = { completeDelayMs: 1, slowDelayMs: 50, cleanupMs: 1 };

// Oracle test vectors only. These objects are never native app/benchmark receipts.
async function vector(source, corrupt = false) {
  const states = new Map(), modes = new Map(), saved = [];
  let active = 0, maximumActive = 0, unitClock = 0;
  const transport = {
    async discover(request) { return { client: request.client, source, locale: request.locale, itemId: request.itemId, method: "POST", action: request.formPage,
      contentType: "application/x-www-form-urlencoded", fields: ["email", "target_price"], transport: { secret: "PRIVATE-TRANSPORT" } }; },
    async readState(request) { return structuredClone(states.get(request.client) ?? []); },
    async send(request, binding, evidence) {
      active++; maximumActive = Math.max(maximumActive, active); await sleep(1); active--;
      if (!corrupt && request.category === "accepted-write") states.set(request.client, [...(states.get(request.client) ?? []), { item_id: request.itemId, email: request.input.email, target_minor: request.targetMinor }]);
      const outcome = expectedOutcome(request), status = outcome === "cancelled" ? 0 : outcome === "deadline" ? 503 : 200;
      evidence.stages.push({ stage: "primary", status, elapsedMs: 0.1 });
      return { status, error: outcome === "cancelled" ? "cancelled" : null, contentType: outcome === "cancelled" ? null : request.accept,
        contentEncoding: outcome === "cancelled" ? null : "identity", body: Buffer.from(JSON.stringify(records[request.itemId])) };
    },
    async snapshot(response, request) {
      const record = records[request.itemId], message = request.category === "rejected-write" ? labels[request.locale][request.variant]
        : request.category === "accepted-write" ? labels[request.locale].alert_set.replace("{email}", request.input.email).replace("{title}", record.title)
          .replace("{price}", new Intl.NumberFormat(request.locale, { style: "currency", currency: "USD" }).format(request.targetMinor / 100)) : "";
      return expectedPage(record, request.locale, { ...request.query, message });
    },
  };
  const injector = {
    async begin(id, mode, delayMs, path) { assert.ok(path.startsWith("/marketplace/records/")); modes.set(id, { mode, path }); },
    async read(id) {
      const { mode, path } = modes.get(id), cancelled = source === "api" && ["deadline", "cancel"].includes(mode);
      return { requests: source === "api" ? 1 : 0, completed: source === "api" && !cancelled ? 1 : 0, cancelled: cancelled ? 1 : 0,
        pending: 0, mode, events: source === "api" ? [{ path }] : [] };
    },
  };
  const captured = await loadCycle({ plan, records, app: "corten", source, settings, transport, injector,
    // Unit metric vectors must not inherit a loaded host's process-start delay.
    // The real native worker supplies its own actual performance.now() epoch.
    now: () => ++unitClock, save: async (request, value) => saved.push({ requestId: request.id, ...value }) });
  captured.observations = saved.filter((s) => !s.incomplete);
  return { captured, maximumActive, saved };
}
let good;
const goodVector = () => good ??= vector("fixture");

test("parallel native-client scheduling retains exact source mix, per-client order and independent state", async () => {
  const { captured, maximumActive, saved } = await goodVector();
  assert.equal(maximumActive, 2); assert.equal(captured.passed, true); assert.equal(captured.operations.length, 22);
  for (const client of [0, 1]) assert.deepEqual(captured.operations.filter((r) => r.client === client).map((r) => r.requestId),
    plan.requests.filter((r) => r.source === "fixture" && r.client === client).map((r) => r.id));
  assert.equal(saved.filter((s) => s.incomplete).length, 22);
  assert.ok(!JSON.stringify({ captured, saved }).includes("PRIVATE-TRANSPORT"));
});

test("a message without actual committed readback still rejects the whole loaded cycle", async () => {
  const { captured } = await vector("fixture", true);
  assert.equal(captured.passed, false); assert.equal(captured.oracle.valid, false);
  assert.equal(captured.operations.length, 22, "a bad write must not erase later requests");
});

test("API slow/cancel/deadline vectors retain path-scoped observations and unchanged shared oracle", async () => {
  const { captured } = await vector("api");
  assert.equal(captured.passed, true); assert.equal(captured.operations.length, 31);
  assert.equal(captured.operations.filter((r) => r.category === "slow").length, 9);
});

test("ambiguous native paths are refused rather than manufacturing request attribution or changing the seed", () => {
  const changed = structuredClone(plan), rows = changed.requests.filter((r) => r.source === "fixture");
  rows[1].itemId = rows[0].itemId;
  assert.throws(() => loadPaths(changed, "fixture"), /ambiguous/);
});

test("measurement rejects missing native inventory before any qualification, container or clock operation", async () => {
  let touched = false;
  await assert.rejects(measureNativeGroup({ summary: { inventory: ["corten", "express"] }, options: { apps: ["corten"] }, plan, records, captures: {},
    own: () => { touched = true; }, io: { command: () => { touched = true; } } }));
  assert.equal(touched, false);
});

test("prior failed native cleanup blocks measurement even when unit oracle vectors are valid", async () => {
  const fixture = (await goodVector()).captured.capture, api = (await vector("api")).captured.capture;
  const capture = { ...fixture, results: plan.requests.map((r) => (r.source === "fixture" ? fixture : api).results[r.index]) };
  let touched = false;
  await assert.rejects(measureNativeGroup({ summary: { inventory: ["corten"], cleanupFailures: [{ name: "left-behind-native-app" }] },
    options: { apps: ["corten"] }, plan, records, captures: { corten: capture },
    own: () => { touched = true; }, io: { command: () => { touched = true; } } }), /unclean native participants/);
  assert.equal(touched, false);
});

async function metricVector(cycles = 3) {
  const { captured } = await goodVector();
  const window = { schema: "mixed-native-window/v1", source: "fixture", complete: true, failure: null, orphans: [],
    seconds: 10, elapsedMs: 10500, eventLoopLagP99Ms: 2, warmup: { passed: true, cycles: 1 },
    cycles: Array.from({ length: cycles }, (_, cycle) => ({ cycle, passed: true, operations: structuredClone(captured.operations) })) };
  return { window, captures: Array.from({ length: cycles }, () => structuredClone(captured)), warmups: [structuredClone(captured)], plan, records, source: "fixture", stage: "steady",
    quotas: { app: 1, load: 4, upstream: 2 }, counters: { app: { before: 10, after: 100010 }, load: { before: 20, after: 200020 }, upstream: { before: 0, after: 0 } },
    samples: Object.fromEntries(["app", "upstream", "load"].map((r) => [r, [{ t: 1, cpu: 10, mem: 64 }, { t: 2, cpu: 20, mem: 70 }]])) };
}

test("metrics derive actual complete-cycle counts, elapsed time, latency, cgroup CPU and memory", async () => {
  const input = await metricVector(), actual = deriveWindow(input);
  assert.equal(actual.eligible, true); assert.equal(actual.primaryAttempts, 66);
  assert.equal(actual.achievedPrimaryOperationsPerSecond, 66 / 10.5);
  assert.equal(actual.primaryHttpLatency.p99Ms, 0.1); assert.equal(actual.resources.app.cpuUsec, 100000);
  assert.equal(actual.resources.app.memMaxMiB, 70); assert.equal(actual.cycles, 3);
});

for (const [name, mutate] of Object.entries({
  "missing native operation": (x) => { x.window.cycles[0].operations.pop(); },
  "invented timing": (x) => { x.window.cycles[0].operations[0].primaryMs = 1e9; },
  "invented client journey": (x) => { const row = x.window.cycles[0].operations[0]; row.startedMs = 0; row.journeyMs = row.finishedMs; },
  "changed effective request": (x) => { x.captures[0].capture.results[0].request.input.email = "tampered"; },
  "success message without state": (x) => { const r = x.captures[0].capture.results.find((r) => r.request.source === "fixture" && r.request.category === "accepted-write"); r.state.after = []; },
  "missing CPU counter": (x) => { delete x.counters.app; },
  "backwards CPU counter": (x) => { x.counters.load.after = 0; },
  "missing memory evidence": (x) => { x.samples.app = []; },
  "backwards sample clock": (x) => { x.samples.app[1].t = 0; },
  "samples without any observed clock span": (x) => { x.samples.app[1].t = 1; },
  "unattributed upstream work": (x) => { x.window.orphans.push({ path: "/wrong" }); },
  "failed native warmup": (x) => { x.window.warmup.passed = false; },
  "declared warmup without real captures": (x) => { x.warmups = []; },
  "latency without a native receipt": (x) => { x.captures[0].observations[0].evidence.stages[0].elapsedMs = 999; },
})) test(`load metrics reject ${name}`, async () => { const x = await metricVector(); mutate(x); assert.throws(() => deriveWindow(x)); });

test("buffered Docker samples keep their actual receipt timestamps without manufactured spacing", async () => {
  const x = await metricVector(); x.samples.app.push({ t: 2, cpu: 25, mem: 72 });
  const actual = deriveWindow(x);
  assert.equal(actual.resources.app.samples, 3); assert.equal(actual.resources.app.sampleReceiptCollisions, 1);
  assert.equal(actual.resources.app.sampleReceiptSpanMs, 1); assert.equal(actual.resources.app.memMaxMiB, 72);
});

test("headroom, adequate repeated cycles and bounded drain are observed gates, not supplied qualification flags", async () => {
  const x = await metricVector(); x.window.eventLoopLagP99Ms = 21; assert.equal(deriveWindow(x).eligible, false);
  const y = await metricVector(); y.counters.load.after = 40e6; assert.equal(deriveWindow(y).eligible, false);
  assert.equal(deriveWindow(await metricVector(1)).eligible, false);
  const z = await metricVector(); z.window.elapsedMs = 20000; assert.equal(deriveWindow(z).eligible, false);
});

test("a narrower actual CPU placement cannot manufacture unused generator headroom", async () => {
  const roles = cpuSettings({ CATALOG_APP_CPUS: "0", CATALOG_LOAD_CPUS: "1", CATALOG_API_CPUS: "2-3" });
  assert.equal(observedCpuCeiling(roles.load), 1);
  assert.equal(observedCpuCeiling({ quota: 4, cpuset: "1-3,5" }), 4);
  assert.equal(observedCpuCeiling({ quota: 4, cpuset: null }), 4);
  const input = await metricVector(); input.counters.load.after = input.counters.load.before + 8e6;
  assert.equal(deriveWindow(input).eligible, true, "nominal four-CPU quota would show false headroom");
  input.quotas.load = observedCpuCeiling(roles.load);
  assert.equal(deriveWindow(input).eligible, false);
});

test("real concurrent upstream paths cannot change each other's fault mode or cancel an older read", async () => {
  const server = loadUpstream({ item_1: records.item_1, item_2: records.item_2 }, "test-private");
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await control(base, "test-private", "slow", { mode: "cancel", delayMs: 1000, path: "/marketplace/records/item_1" });
    const pending = httpRequest(`${base}/marketplace/records/item_1`); pending.on("error", () => {}); pending.end();
    for (let i = 0; i < 100 && !(await control(base, "test-private", "slow")).pending; i++) await sleep(5);
    await control(base, "test-private", "other", { mode: "normal", delayMs: 0, path: "/marketplace/records/item_2" });
    const r = await fetch(`${base}/marketplace/records/item_2`); assert.equal(r.status, 200); await r.arrayBuffer();
    assert.equal((await control(base, "test-private", "slow")).pending, 1);
    await assert.rejects(control(base, "test-private", "stolen", { mode: "normal", delayMs: 0, path: "/marketplace/records/item_1" }));
    pending.destroy();
    for (let i = 0; i < 100 && (await control(base, "test-private", "slow")).pending; i++) await sleep(5);
    assert.equal((await control(base, "test-private", "slow")).cancelled, 1);
    assert.equal((await control(base, "test-private", "other")).completed, 1);
    await fetch(`${base}/marketplace/records/item_3`);
    assert.equal((await control(base, "test-private", "orphans")).length, 1);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
