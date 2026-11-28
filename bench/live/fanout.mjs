// Bounded native equal-work measurements. Admission is separate from this driver.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { verifyMeasurementBindings } from "./measurement.mjs";
import { createLiveWorkload, liveSnapshot } from "../workloads/live.mjs";
import { wireEvents, wireSnapshots, verifyWireCapture } from "./wire.mjs";
import { captureHttp, captureHtml } from "./native-http.mjs";
import { verifyResources, verifyResourceBounds, verifyResourceLifecycle } from "./resources.mjs";

export const fanoutProfile = Object.freeze({ schema: "native-live-fanout-profile/v1", clients: [1, 2, 4],
  seed: 17, rowCount: 5, eventCount: 60, rate: 20, deadlineMs: 90000, maxScheduleLagMs: 500,
  limits: "one local repeat; bounded browser fan-out, not saturation, dedicated-host throughput or a ranking" });
export const fanoutTeardownRefusals = Object.freeze(["context-close", "fetch", "malformed", "unavailable", "timeout"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Context close can finish before the native endpoint drops its readers.
// A nonzero observation may settle; a failed or ambiguous observation cannot.
export async function waitForFanoutDrain(base, maxCleanupMs, signal, deadline = performance.now() + maxCleanupMs) {
  if (signal.aborted) return;
  const remaining = Math.min(maxCleanupMs, Math.ceil(deadline - performance.now()));
  if (remaining <= 0) return "timeout";
  const timeout = AbortSignal.timeout(remaining);
  const probe = AbortSignal.any([signal, timeout]);
  const expired = () => timeout.aborted || performance.now() >= deadline;
  const refuse = (reason) => signal.aborted ? undefined : expired() ? "timeout" : reason;
  while (!signal.aborted) {
    if (expired()) return "timeout";
    try {
      const response = await fetch(`${base}/parity/resources`, { signal: probe, redirect: "manual" });
      if (expired() || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return refuse("unavailable");
      }
      let counts;
      try { counts = await response.json(); }
      catch (error) {
        return refuse(error instanceof SyntaxError ? "malformed" : "fetch");
      }
      if (signal.aborted) return;
      if (expired()) return "timeout";
      if (!counts || typeof counts !== "object" || Array.isArray(counts)
        || ![counts.connections, counts.subscriptions].every((n) => Number.isSafeInteger(n) && n >= 0)) return "malformed";
      if (counts.connections === 0 && counts.subscriptions === 0) return;
    } catch {
      return refuse("fetch");
    }
    await sleep(Math.max(0, Math.min(25, deadline - performance.now())));
  }
}

async function confirmContextCloses(closes, deadline) {
  let timer;
  try {
    const settled = await Promise.race([Promise.all(closes), new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, Math.ceil(deadline - performance.now())));
    })]);
    return settled?.every((ok) => ok) && performance.now() < deadline;
  } finally { clearTimeout(timer); }
}

const sort = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];

/** @typedef {{sequence: number, lagMs: number, previousSendMs: number | null}} PublisherLag */

/** @returns {PublisherLag | undefined} */
function publisherLagReceipt(sequence, scheduledAt, startedAt, previous) {
  const lagMs = startedAt - scheduledAt;
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > fanoutProfile.eventCount
      || !Number.isFinite(scheduledAt) || !Number.isFinite(startedAt)
      || !(lagMs > fanoutProfile.maxScheduleLagMs && lagMs <= Number.MAX_SAFE_INTEGER)) return;
  if (sequence === 1 && !previous) return { sequence, lagMs, previousSendMs: null };
  if (previous?.seq !== sequence - 1 || !Number.isFinite(previous.startedAt)
      || !Number.isFinite(previous.finishedAt) || previous.finishedAt > startedAt) return;
  const previousSendMs = previous.finishedAt - previous.startedAt;
  if (previousSendMs >= 0 && previousSendMs <= Number.MAX_SAFE_INTEGER) return { sequence, lagMs, previousSendMs };
}

export function kernelObservation(raw) {
  const [cpu, memory] = raw.split("MEMORY\n"), [current, peak] = (memory ?? "").trim().split(/\s+/).map(Number);
  const cpuUsageUs = Number(/^usage_usec\s+(\d+)/m.exec(cpu)?.[1]);
  assert.ok(Number.isFinite(cpuUsageUs) && current > 0 && peak >= current, "missing actual kernel CPU/memory counters");
  return { cpuUsageUs, memoryCurrentBytes: current, memoryPeakBytes: peak, raw };
}

export function checkResources(r, clients, settings, released = false) {
  verifyResourceBounds(r, clients, settings);
  if (released) for (const name of ["subscriptions", "connections", "pendingTasks", "queueEvents"]) assert.equal(r[name], 0, `leaked ${name}`);
  else { assert.equal(r.subscriptions, clients); assert.equal(r.connections, clients); assert.equal(r.pendingTasks, clients); }
}

export function verifyFanout(a, { app, group, provenance, qualification, settings, wire }) {
  assert.ok(["native-live-fanout/v1", "native-live-fanout/v2", "native-live-fanout/v3"].includes(a.schema));
  assert.equal(a.app, app); assert.equal(a.group, group);
  assert.deepEqual(a.profile, fanoutProfile); assert.ok(fanoutProfile.clients.includes(a.clients));
  assert.deepEqual(a.provenance, provenance); assert.deepEqual(a.qualification, qualification);
  assert.deepEqual(a.settings, settings);
  assert.equal(a.comparative, false); assert.equal(a.repeats, 1);
  const workload = createLiveWorkload(fanoutProfile);
  assert.deepEqual(a.workload, workload); assert.equal(a.browsers.length, a.clients);
  checkResources(a.resources.attached, a.clients, a.settings);
  checkResources(a.resources.delivered, a.clients, a.settings);
  checkResources(a.resources.released, a.clients, a.settings, true);
  for (const k of [a.kernel.before, a.kernel.after]) {
    const { receipt, ...counters } = k;
    assert.deepEqual(counters, kernelObservation(k.raw));
  }
  assert.ok(a.kernel.after.cpuUsageUs >= a.kernel.before.cpuUsageUs, "CPU counter regressed");
  assert.ok(a.kernel.after.memoryPeakBytes >= a.kernel.after.memoryCurrentBytes, "missing kernel memory high-water");
  const publisher = a.browsers[0];
  const probes = publisher.records.filter((r) => r.kind === "cleanup-probe");
  assert.equal(probes.length, 1, "cleanup acknowledgement missing");
  assert.deepEqual(probes[0].event, workload.cleanupProbe, "cleanup acknowledgement probe differs");
  const probeAcknowledgedAt = publisher.timeOrigin + probes[0].at;
  const publications = publisher.records.filter((r) => r.kind === "publish");
  assert.deepEqual(publications.map((r) => r.seq), workload.events.map((e) => e.seq));
  const writes = publisher.network.filter((r) => r.kind === "request" && new URL(r.url).pathname === "/parity/publish");
  assert.deepEqual(writes.map((r) => JSON.parse(r.body).event), [...workload.events, workload.cleanupProbe], "wrong native fan-out publication work");
  const acks = publisher.network.filter((r) => r.kind === "response" && new URL(r.url).pathname === "/parity/publish");
  assert.deepEqual(acks.map((r) => { assert.equal(r.status, 200); return JSON.parse(r.body).seq; }),
    [...workload.events, workload.cleanupProbe].map((e) => e.seq), "missing raw fan-out publication acknowledgement");
  assert.equal(a.schedule.length, workload.eventCount);
  for (const [i, entry] of a.schedule.entries()) {
    assert.equal(entry.seq, i + 1); assert.ok(Number.isFinite(entry.startedAt) && Number.isFinite(entry.scheduledAt) && entry.startedAt >= entry.scheduledAt);
    if (i) {
      assert.ok(Math.abs(entry.scheduledAt - a.schedule[i - 1].scheduledAt - 1000 / fanoutProfile.rate) < .001, "offered cadence changed");
      assert.ok(entry.startedAt >= a.schedule[i - 1].startedAt, "publication clock regressed");
    }
    assert.ok(entry.startedAt - entry.scheduledAt <= fanoutProfile.maxScheduleLagMs, "publisher did not maintain offered rate");
  }
  const samples = [];
  for (const b of a.browsers) {
    assert.ok(Number.isFinite(b.timeOrigin) && b.timeOrigin > 0, "browser clock origin missing");
    for (const [i, r] of b.records.entries()) assert.ok(Number.isFinite(r.at) && r.at >= 0
      && (!i || r.at >= b.records[i - 1].at), "browser observation clock regressed");
    verifyResources(b.records, b.network, wire);
    verifyWireCapture(b.network, b.records, wire);
    verifyResourceLifecycle(b.records, a.clients, a.settings);
    assert.deepEqual(b.failures, []);
    const events = b.records.filter((r) => r.kind === "event");
    assert.deepEqual(events.map((r) => r.event), wireEvents(b.network, wire), "fan-out native wire/app mismatch");
    const applied = events.filter((r) => r.disposition === "applied");
    assert.deepEqual(applied.map((r) => r.event), workload.events, "fan-out missing/duplicate/out-of-order native effects");
    assert.ok(events.some((r) => r.disposition === "duplicate"), "duplicate native control missing");
    assert.ok(events.every((r) => ["applied", "duplicate"].includes(r.disposition)), "fan-out gap hidden by recovery");
    const snapshots = b.records.filter((r) => r.kind === "snapshot");
    assert.equal(snapshots.length, 1, "fan-out must not conceal loss with resnapshots");
    assert.equal(snapshots[0].through, 0);
    assert.deepEqual(sort(snapshots[0].rows), sort(workload.initial));
    assert.deepEqual(snapshots.map(({ through, rows, work }) => ({ through, rows, work })), wireSnapshots(b.network, wire));
    assert.deepEqual(sort(snapshots[0].state), sort(workload.initial));
    const effects = [];
    for (const r of events) {
      if (r.receivedAt !== undefined) assert.ok(Number.isFinite(r.receivedAt) && r.receivedAt >= 0 && r.receivedAt <= r.at,
        "visible frame chronology precedes native arrival");
      if (r.disposition === "applied") effects.push(r.event.effectId);
      assert.deepEqual(r.effects, effects); assert.equal(r.effectCount, effects.length);
      assert.deepEqual(sort(r.state), liveSnapshot(workload, effects.length).rows);
    }
    const states = b.records.filter((r) => r.kind === "state");
    assert.ok(states.length >= 2); const final = liveSnapshot(workload, workload.eventCount);
    for (const r of states.slice(-2)) {
      assert.equal(r.through, workload.eventCount); assert.deepEqual(sort(r.rows), final.rows);
      assert.deepEqual(r.effects, workload.events.map((e) => e.effectId)); assert.equal(r.effectCount, workload.eventCount);
    }
    const detach = b.records.find((r) => r.kind === "detach");
    assert.ok(detach && states.at(-1).at - detach.at >= a.settings.cleanupObservationMs);
    assert.ok(b.timeOrigin + detach.at <= probeAcknowledgedAt, "cleanup acknowledgement preceded reader detach");
    const observedAfter = probeAcknowledgedAt + a.settings.cleanupObservationMs;
    assert.ok(b.timeOrigin + states.at(-1).at >= observedAfter, "cleanup observation too short after acknowledgement");
    assert.ok(b.records.some((r) => r.kind === "resources" && b.timeOrigin + r.at >= observedAfter
      && ["subscriptions", "connections", "pendingTasks", "queueEvents"].every((k) => r[k] === 0)),
    "cleanup resource observation too short after acknowledgement");
    const zero = b.records.find((r) => r.kind === "resources" && r.at >= detach.at
      && ["subscriptions", "connections", "pendingTasks", "queueEvents"].every((k) => r[k] === 0));
    assert.ok(zero && zero.at - detach.at <= a.settings.maxCleanupMs
      && probeAcknowledgedAt - (b.timeOrigin + detach.at) <= a.settings.maxCleanupMs, "cleanup exceeded detach deadline");
    const detachIndex = b.records.findIndex((r) => r.kind === "detach");
    assert.equal(b.records.filter((r) => r.kind === "detach").length, 1);
    assert.ok(!b.records.slice(detachIndex + 1).some((r) => r.kind === "event"), "event processing after detach");
    for (const [i, frame] of b.frames.entries()) {
      assert.ok(Number.isSafeInteger(frame.through) && frame.through >= 0 && frame.through <= workload.eventCount
        && Number.isFinite(frame.firstFrameAt) && Number.isFinite(frame.secondFrameAt), "invalid visible frame observation");
      const change = frame.through === 0 ? snapshots[0] : applied[frame.through - 1];
      assert.ok(frame.firstFrameAt >= change.at && frame.secondFrameAt > frame.firstFrameAt,
        "visible frame chronology precedes application state");
      if (i) assert.ok(frame.through > b.frames[i - 1].through && frame.firstFrameAt >= b.frames[i - 1].firstFrameAt
        && frame.secondFrameAt >= b.frames[i - 1].secondFrameAt, "visible frame chronology regressed");
    }
    for (const [i, event] of applied.entries()) {
      const frame = b.frames.find((f) => f.through >= event.event.seq);
      assert.ok(frame && frame.secondFrameAt >= frame.firstFrameAt, "missing browser paint opportunity");
      const latency = b.timeOrigin + frame.secondFrameAt - (publisher.timeOrigin + publications[i].startedAt);
      assert.ok(Number.isFinite(latency) && latency >= 0, "invalid visible latency clock alignment");
      samples.push(latency);
    }
  }
  verifyMeasurementBindings(a);
  const summary = { deliveredEffects: a.clients * workload.eventCount, clients: a.clients,
    visibleLatencyP50Ms: pct(samples, .5), visibleLatencyP95Ms: pct(samples, .95), visibleLatencyMaxMs: Math.max(...samples),
    serverCpuUs: a.kernel.after.cpuUsageUs - a.kernel.before.cpuUsageUs,
    serverMemoryCurrentBytes: a.kernel.after.memoryCurrentBytes, serverMemoryPeakSinceContainerStartBytes: a.kernel.after.memoryPeakBytes };
  if (a.summary) assert.deepEqual(a.summary, summary, "fan-out aggregate differs from actual raw observations");
  return summary;
}

export async function fanoutJourney(browser, base, settings, clients, { wire }, kernelCounters, recordRenderer, teardown = {}) {
  const workload = createLiveWorkload(fanoutProfile), contexts = [], readers = [];
  const host = { timeOrigin: performance.timeOrigin, base, requests: [] }, resourceObservations = {};
  /** @type {PublisherLag | undefined} */
  let publisherLag;
  let failed = false;
  const closing = new Map();
  const closeContexts = () => {
    teardown.deadline ??= performance.now() + settings.maxCleanupMs;
    return contexts.map((context) => {
      if (!closing.has(context)) closing.set(context, Promise.resolve().then(() => context.close()).then(() => true, () => false));
      return closing.get(context);
    });
  };
  const deadline = setTimeout(closeContexts, fanoutProfile.deadlineMs);
  const api = async (name, data, phase = name) => {
    const startedAt = performance.now();
    const r = await fetch(`${base}/parity/${name}`, { ...(data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), signal: AbortSignal.timeout(10000) });
    const body = await r.text(), finishedAt = performance.now();
    host.requests.push({ request: { method: data === undefined ? "GET" : "POST", url: `${base}/parity/${name}`,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) }, phase, status: r.status, body, startedAt, finishedAt });
    assert.ok(r.ok, `native ${name} failed: ${r.status}`); return JSON.parse(body);
  };
  try {
    const configuration = await api("configure", { initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit });
    for (let i = 0; i < clients; i++) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      recordRenderer?.(true);
      const cdp = await context.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Performance.enable");
      const identityReceipt = await cdp.send("Target.getTargetInfo");
      const identity = { receipt: identityReceipt, targetId: identityReceipt.targetInfo.targetId, contextId: identityReceipt.targetInfo.browserContextId };
      const network = [], failures = [], pending = [];
      cdp.on("Network.requestWillBeSent", (e) => network.push({ kind: "native-request", requestId: e.requestId,
        url: e.request.url, method: e.request.method, type: e.type, timestamp: e.timestamp }));
      for (const [event, kind] of [["Network.eventSourceMessageReceived", "native-sse"], ["Network.webSocketFrameReceived", "native-websocket-received"],
        ["Network.webSocketFrameSent", "native-websocket-sent"], ["Network.webSocketCreated", "native-websocket-created"], ["Network.loadingFinished", "received-bytes"]]) cdp.on(event, (e) => network.push({ kind, ...e }));
      page.on("pageerror", (e) => failures.push(e.message));
      captureHttp(page, network, pending, wire);
      await page.goto(base); await page.waitForFunction(() => !!window.liveApp);
      await page.evaluate((s) => window.liveApp.setup(s), settings);
      await page.evaluate(() => {
        window.livePaint = { frames: [], stopped: false };
        let last = -1;
        const tick = () => {
          if (window.livePaint.stopped) return;
          const through = window.liveApp.through;
          if (through !== last) {
            last = through; const firstFrameAt = performance.now();
            requestAnimationFrame(() => window.livePaint.frames.push({ through, firstFrameAt, secondFrameAt: performance.now() }));
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      readers.push({ page, cdp, network, failures, pending, identity });
    }
    let attached;
    const attachDeadline = performance.now() + 10000;
    do { attached = await api("resources", undefined, "attach-poll"); if (attached.subscriptions === clients && attached.connections === clients) break;
      assert.ok(performance.now() < attachDeadline, "fan-out readers failed to attach"); await sleep(10);
    } while (true);
    checkResources(attached, clients, settings);
    resourceObservations.attached = host.requests.length - 1;
    const interval = { id: randomUUID(), clients };
    const before = kernelCounters(interval.id, "before"); interval.startedAt = before.receipt.startedAt;
    const schedule = [], start = performance.now() + 50;
    for (const event of workload.events) {
      const scheduledAt = start + (event.seq - 1) * 1000 / fanoutProfile.rate;
      while (performance.now() < scheduledAt) await sleep(Math.max(1, scheduledAt - performance.now()));
      const startedAt = performance.now();
      if (!(startedAt - scheduledAt <= fanoutProfile.maxScheduleLagMs)) {
        publisherLag = publisherLagReceipt(event.seq, scheduledAt, startedAt, schedule.at(-1));
        assert.fail("native publisher behind offered rate");
      }
      await readers[0].page.evaluate((e) => window.liveApp.publish(e), event);
      schedule.push({ seq: event.seq, scheduledAt, startedAt, finishedAt: performance.now() });
    }
    await Promise.all(readers.map(async ({ page }) => { await page.waitForFunction((n) => window.liveApp.through === n, workload.eventCount); await page.evaluate(() => window.liveApp.settle()); }));
    await sleep(50);
    const after = kernelCounters(interval.id, "after"); interval.finishedAt = after.receipt.finishedAt;
    const delivered = await api("resources", undefined, "delivered"); resourceObservations.delivered = host.requests.length - 1;
    await readers[0].page.evaluate(() => window.liveApp.duplicate());
    await Promise.all(readers.map(async ({ page }) => {
      await page.waitForFunction(() => window.liveApp.records.some((r) => r.kind === "event" && r.disposition === "duplicate"));
      await page.evaluate(async () => { await window.liveApp.settle(); window.liveApp.state(); });
    }));
    await Promise.all(readers.map(({ page }) => page.evaluate(() => window.liveApp.detach())));
    await readers[0].page.evaluate((e) => window.liveApp.publish(e, true), workload.cleanupProbe);
    await sleep(settings.cleanupObservationMs + 10);
    await Promise.all(readers.map(({ page }) => page.evaluate(async () => { await window.liveApp.released(); window.liveApp.state(); window.livePaint.stopped = true; })));
    const released = await api("resources", undefined, "released"); resourceObservations.released = host.requests.length - 1;
    const browsers = [];
    for (const r of readers) {
      await Promise.all(r.pending);
      browsers.push({ ...await r.page.evaluate(() => ({ records: window.liveApp.records, frames: window.livePaint.frames, timeOrigin: performance.timeOrigin })),
        identity: r.identity, network: r.network, failures: r.failures, html: await captureHtml(r.page, wire), version: browser.version(),
        costs: { performance: await r.cdp.send("Performance.getMetrics"), dom: await r.cdp.send("Memory.getDOMCounters") } });
    }
    return { clients, configuration, workload, settings, resources: { attached, delivered, released }, resourceObservations,
      host, interval, kernel: { before, after }, browsers, schedule };
  } catch (error) {
    failed = true;
    error.evidence = { workload, settings, ...(publisherLag ? { publisherLag } : {}), browsers: await Promise.all(readers.map(async (r) => ({
      network: r.network, failures: r.failures, records: await r.page.evaluate(() => window.liveApp?.records ?? []).catch(() => []),
      html: await captureHtml(r.page, wire).catch(() => ""),
    }))) };
    throw error;
  } finally {
    recordRenderer?.(false);
    clearTimeout(deadline);
    if (!await confirmContextCloses(closeContexts(), teardown.deadline)) {
      teardown.failure = "context-close";
      if (!failed) throw new Error("native fanout context closure unconfirmed");
    }
  }
}
