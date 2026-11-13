import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { records as fixture } from "../marketplace/fixtures.mjs";
import { expectedPage, labels } from "../marketplace/records.mjs";
import { createPlan } from "../workloads/mixed.mjs";
import { control, expectedOutcome, sleep, upstreamEvidence } from "./capture.mjs";
import { loadCycle, loadPaths } from "./load-capture.mjs";
import { loadUpstream } from "./load-upstream.mjs";
import { deriveWindow, observedCpuCeiling } from "./metrics.mjs";
import { cpuSettings } from "../catalog/contract.mjs";
import { measureNativeGroup } from "./measure.mjs";
import { reconcileLedger, upstreamManifest, upstreamPhase } from "./upstream-ledger.mjs";
import { coveredSamples, resourceBoundary, resourceCoveragePolicy } from "./resources.mjs";

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
    seconds: 10, elapsedMs: 10500, startedUnixMs: 100000, finishedUnixMs: 110500,
    eventLoopLagP99Ms: 2, warmup: { passed: true, cycles: 1 },
    cycles: Array.from({ length: cycles }, (_, cycle) => ({ cycle, passed: true, operations: structuredClone(captured.operations) })) };
  const input = { window, captures: Array.from({ length: cycles }, () => structuredClone(captured)), warmups: [structuredClone(captured)], plan, records, source: "fixture", stage: "steady",
    quotas: { app: 1, load: 4, upstream: 2 }, counters: { app: { before: 10, after: 100010 }, load: { before: 20, after: 200020 }, upstream: { before: 0, after: 0 } },
    samples: Object.fromEntries(["app", "upstream", "load"].map((r) => [r,
      Array.from({ length: 22 }, (_, i) => ({ t: 100000 + 500 * i, cpu: i ? 20 : 10, mem: i ? 70 : 64 }))])) };
  input.startupObservation = { id: "startup", path: "/marketplace/records/item_1", mode: "normal", requests: 0, completed: 0, cancelled: 0, pending: 0, events: [] };
  const phases = [...input.warmups.map((c, i) => upstreamPhase("warmup", i, c.capture, "fixture")),
    ...input.captures.map((c, i) => upstreamPhase("cycle", i, c.capture, "fixture"))];
  // Unit ledger vectors, not observations of a native app. The real HTTP test
  // below builds its receipts only from the live server's control endpoint.
  input.admission = { nativePausedUnixMs: 110501, settleMs: 1 };
  input.finalUpstreamLedger = { schema: "mixed-native-upstream-ledger/v1", sealed: true, sealedUnixMs: 110501, snapshotUnixMs: 110502, orphans: [],
    operations: upstreamManifest(plan, "fixture", input.startupObservation, phases).map((op) => ({ id: op.id, path: op.path, mode: op.mode,
      requests: 0, completed: 0, cancelled: 0, pending: 0, events: [] })) };
  return input;
}

test("metrics derive actual complete-cycle counts, elapsed time, latency, cgroup CPU and memory", async () => {
  const input = await metricVector(), actual = deriveWindow(input);
  assert.equal(actual.eligible, true); assert.equal(actual.primaryAttempts, 66);
  assert.equal(actual.achievedPrimaryOperationsPerSecond, 66 / 10.5);
  assert.equal(actual.primaryHttpLatency.p99Ms, 0.1); assert.equal(actual.resources.app.cpuUsec, 100000);
  assert.equal(actual.resources.app.memMaxMiB, 70); assert.equal(actual.cycles, 3);
});

test("resource receipts covering only 489 ms cannot admit a 22487.98 ms native window", async () => {
  const input = await metricVector();
  input.stage = "calibration"; input.window.seconds = 22; input.window.elapsedMs = 22487.98;
  input.window.startedUnixMs = 100000; input.window.finishedUnixMs = 122488;
  input.finalUpstreamLedger.sealedUnixMs = 122489; input.finalUpstreamLedger.snapshotUnixMs = 122490;
  input.admission.nativePausedUnixMs = 122489;
  input.samples = Object.fromEntries(["app", "upstream", "load"].map((role) => [role,
    [{ t: 100000, cpu: 10, mem: 64 }, { t: 100489, cpu: 20, mem: 70 }]]));
  assert.throws(() => deriveWindow(input), /resource coverage/);
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
  "missing leading resource boundary": (x) => { x.samples.app.shift(); },
  "missing trailing resource boundary": (x) => { x.samples.load.pop(); },
  "long internal sampling gap": (x) => { x.samples.upstream.splice(5, 5); },
  "stale leading resource boundary": (x) => { x.samples.app[0].t -= 2000; },
  "stale trailing resource boundary": (x) => { x.samples.load.at(-1).t += 2000; },
  "wall clock inconsistent with measured window": (x) => { x.window.finishedUnixMs += 1000; },
  "backwards sample clock": (x) => { x.samples.app[1].t = 0; },
  "samples without any observed clock span": (x) => { x.samples.app[1].t = 1; },
  "unattributed upstream work": (x) => { x.window.orphans.push({ path: "/wrong" }); },
  "failed native warmup": (x) => { x.window.warmup.passed = false; },
  "declared warmup without real captures": (x) => { x.warmups = []; },
  "latency without a native receipt": (x) => { x.captures[0].observations[0].evidence.stages[0].elapsedMs = 999; },
  "missing final ledger": (x) => { delete x.finalUpstreamLedger; },
  "missing native producer cutoff": (x) => { delete x.admission; },
  "ledger read before native producer cutoff": (x) => { x.admission.nativePausedUnixMs += 1000; },
  "ledger read without post-cutoff settlement": (x) => { x.admission.settleMs = 1000; },
  "unsealed final ledger": (x) => { x.finalUpstreamLedger.sealed = false; },
  "seal before measurement end": (x) => { x.finalUpstreamLedger.sealedUnixMs = 110499; },
  "pending old operation": (x) => { x.finalUpstreamLedger.operations[0].pending = 1; },
  "late bound work after saved capture": (x) => { const op = x.finalUpstreamLedger.operations.find((o) => o.id.startsWith("cycle_0_") && !o.id.includes("prep_") && !o.id.includes("state_"));
    op.requests = 1; op.completed = 1; op.events.push({ method: "GET", path: op.path, result: "completed" }); },
  "late preparation read": (x) => { const op = x.finalUpstreamLedger.operations.find((o) => o.id.includes("prep_")); op.requests = op.completed = 1;
    op.events.push({ method: "GET", path: op.path, result: "completed" }); },
  "late readback record fetch": (x) => { const op = x.finalUpstreamLedger.operations.find((o) => o.id.includes("state_")); op.requests = op.completed = 1;
    op.events.push({ method: "GET", path: op.path, result: "completed" }); },
  "startup counters changed": (x) => { x.finalUpstreamLedger.operations[0].requests = 1; },
  "unknown final operation": (x) => { x.finalUpstreamLedger.operations.push({ id: "unplanned" }); },
  "duplicate final operation": (x) => { x.finalUpstreamLedger.operations.push(structuredClone(x.finalUpstreamLedger.operations[0])); },
  "late final orphan despite clean saved window": (x) => { x.finalUpstreamLedger.orphans.push({ reason: "after-seal" }); },
})) test(`load metrics reject ${name}`, async () => { const x = await metricVector(); mutate(x); assert.throws(() => deriveWindow(x)); });

test("buffered Docker samples keep their actual receipt timestamps without manufactured spacing", async () => {
  const x = await metricVector(), count = x.samples.app.length; x.samples.app.push({ t: x.window.finishedUnixMs, cpu: 25, mem: 72 });
  const actual = deriveWindow(x);
  assert.equal(actual.resources.app.samples, count + 1); assert.equal(actual.resources.app.sampleReceiptCollisions, 1);
  assert.equal(actual.resources.app.sampleReceiptSpanMs, 10500); assert.equal(actual.resources.app.memMaxMiB, 72);
});

test("headroom, adequate repeated cycles and bounded drain are observed gates, not supplied qualification flags", async () => {
  const x = await metricVector(); x.window.eventLoopLagP99Ms = 21; assert.equal(deriveWindow(x).eligible, false);
  const y = await metricVector(); y.counters.load.after = 40e6; assert.equal(deriveWindow(y).eligible, false);
  assert.equal(deriveWindow(await metricVector(1)).eligible, false);
  const z = await metricVector(); z.window.seconds = 5; assert.equal(deriveWindow(z).eligible, false);
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

test("real delayed HTTP read cannot escape the final ledger through an old path binding", async () => {
  const token = "test-final-ledger", path = "/marketplace/records/item_1", server = loadUpstream({ item_1: records.item_1 }, token);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let delayed;
  try {
    await control(base, token, "old", { path, mode: "complete", delayMs: 100 });
    await (await fetch(`${base}${path}`)).arrayBuffer();
    const saved = await control(base, token, "old");
    const manifest = [{ id: "old", path, mode: "complete", requests: 1, cancelled: 0, receipt: upstreamEvidence(saved) }];
    // A second real read begins after the observation was saved, without arming
    // a new identity. This was requests=1 in the saved row, live=2, orphans=[].
    await sleep(20);
    delayed = fetch(`${base}${path}`).then((r) => r.arrayBuffer());
    for (let i = 0; i < 100 && !(await control(base, token, "old")).pending; i++) await sleep(1);
    assert.equal(saved.requests, 1);
    const pending = await control(base, token, "old");
    assert.equal(pending.requests, 2); assert.equal(pending.pending, 1);
    assert.deepEqual(await control(base, token, "orphans"), []);
    await control(base, token, "seal", { action: "seal" });
    const early = await control(base, token, "ledger"), rejected = reconcileLedger(early, manifest);
    assert.equal(rejected.valid, false);
    assert.ok(rejected.cells[0].issues.includes("pending-or-unaccounted-work"));
    await delayed;
    const final = await control(base, token, "ledger");
    assert.equal(final.operations[0].pending, 0); assert.equal(final.operations[0].completed, 2);
    assert.deepEqual(final.orphans, []);
    assert.ok(reconcileLedger(final, manifest).cells[0].issues.includes("saved-observation-drifted"));
    assert.equal((await fetch(`${base}${path}`)).status, 503);
    const late = await control(base, token, "ledger");
    assert.equal(late.operations[0].requests, 3);
    assert.equal(late.orphans[0].reason, "after-seal"); assert.equal(late.orphans[0].operationId, "old");
    assert.equal(reconcileLedger(late, manifest).valid, false);
    await assert.rejects(control(base, token, "hidden", { path, mode: "normal", delayMs: 0 }));
  } finally { await delayed?.catch(() => {}); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("final live ledger can admit exactly one completed native HTTP read with no late work", async () => {
  const token = "test-exact-read", path = "/marketplace/records/item_1", server = loadUpstream({ item_1: records.item_1 }, token);
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await control(base, token, "single", { path, mode: "normal", delayMs: 0 });
    await (await fetch(`${base}${path}`)).arrayBuffer();
    const saved = await control(base, token, "single");
    await control(base, token, "seal", { action: "seal" });
    assert.equal(reconcileLedger(await control(base, token, "ledger"), [{ id: "single", path, mode: "normal", requests: 1,
      cancelled: 0, receipt: upstreamEvidence(saved) }]).valid, true);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("all warmup/preparation/primary/readback API operations retain their exact one-read and cancellation contracts", async () => {
  const { captured } = await vector("api"), startup = { id: "startup", path: "/marketplace/records/item_1", mode: "normal",
    requests: 1, completed: 1, cancelled: 0, pending: 0, events: [{ method: "GET", path: "/marketplace/records/item_1", result: "completed" }] };
  const manifest = upstreamManifest(plan, "api", startup, [upstreamPhase("warmup", 0, captured.capture, "api"), upstreamPhase("cycle", 0, captured.capture, "api")]);
  const ledger = { schema: "mixed-native-upstream-ledger/v1", sealed: true, sealedUnixMs: 1, snapshotUnixMs: 2, orphans: [],
    operations: manifest.map((op) => ({ id: op.id, path: op.path, mode: op.mode, requests: op.requests, cancelled: op.cancelled,
      completed: op.requests - op.cancelled, pending: 0, events: Array.from({ length: op.requests }, () => ({ method: "GET", path: op.path,
        result: op.cancelled ? "cancelled" : "completed" })) })) };
  assert.equal(reconcileLedger(ledger, manifest).valid, true);
  assert.equal(manifest.filter((op) => op.id.startsWith("cycle_") && op.id.includes("prep_") && op.requests === 1).length, 9);
  assert.equal(manifest.filter((op) => op.id.startsWith("cycle_") && op.id.includes("state_") && op.requests === 0).length, 9);
  assert.equal(manifest.filter((op) => op.id.startsWith("cycle_") && op.cancelled === 1).length, 6);
  const primary = ledger.operations.find((op) => op.mode === "cancel"); primary.requests++; primary.completed++;
  primary.events.push({ method: "GET", path: primary.path, result: "completed" });
  assert.equal(reconcileLedger(ledger, manifest).valid, false);
});

test("duplicate receipt timestamps cannot fill an unsampled resource gap or hide a late memory peak", () => {
  const window = { startedUnixMs: 1000, finishedUnixMs: 11000, elapsedMs: 10000 };
  const clustered = Array.from({ length: 100 }, () => ({ t: 1000, cpu: 1, mem: 10 }));
  clustered.push({ t: 11000, cpu: 1, mem: 900 });
  assert.throws(() => coveredSamples(clustered, window), /sampling gap/);
  const covered = Array.from({ length: 21 }, (_, i) => ({ t: 1000 + i * 500, cpu: 1, mem: 10 }));
  covered.push({ t: 11000, cpu: 1, mem: 900 });
  assert.equal(coveredSamples(covered, window).selected.at(-1).mem, 900);
  assert.equal(coveredSamples(covered, window).maximumGapMs, resourceCoveragePolicy.targetIntervalMs);
});

test("boundary collection uses real Docker fields and refuses absent, duplicated or invalid participants", async () => {
  const rows = [{ Name: "app", CPUPerc: "12.5%", MemUsage: "70MiB / 1GiB" },
    { Name: "load", CPUPerc: "20%", MemUsage: "0.5GiB / 2GiB" }];
  let args;
  const actual = await resourceBoundary(async (a) => { args = a; return rows.map((r) => JSON.stringify(r)).join("\n"); }, ["app", "load"]);
  assert.deepEqual(args, ["stats", "--no-stream", "--format", "{{json .}}", "app", "load"]);
  assert.equal(actual.samples.app[0].cpu, 12.5); assert.equal(actual.samples.load[0].mem, 512);
  assert.equal(actual.samples.app[0].t, actual.receivedUnixMs); assert.ok(actual.receivedUnixMs >= actual.startedUnixMs);
  for (const bad of [[rows[0]], [rows[0], rows[0]], [{ ...rows[0], CPUPerc: "unknown" }, rows[1]]])
    await assert.rejects(resourceBoundary(async () => bad.map((r) => JSON.stringify(r)).join("\n"), ["app", "load"]));
});
