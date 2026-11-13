// Bounded native equal-work measurements. Admission is separate from this driver.
import assert from "node:assert/strict";
import { createLiveWorkload, liveSnapshot } from "../workloads/live.mjs";
import { wireEvents, wireSnapshots } from "./wire.mjs";
import { verifyResources } from "./resources.mjs";

export const fanoutProfile = Object.freeze({ schema: "native-live-fanout-profile/v1", clients: [1, 2, 4],
  seed: 17, rowCount: 5, eventCount: 60, rate: 20, deadlineMs: 90000, maxScheduleLagMs: 500,
  limits: "one local repeat; bounded browser fan-out, not saturation, dedicated-host throughput or a ranking" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sort = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];

export function kernelObservation(raw) {
  const [cpu, memory] = raw.split("MEMORY\n"), [current, peak] = (memory ?? "").trim().split(/\s+/).map(Number);
  const cpuUsageUs = Number(/^usage_usec\s+(\d+)/m.exec(cpu)?.[1]);
  assert.ok(Number.isFinite(cpuUsageUs) && current > 0 && peak >= current, "missing actual kernel CPU/memory counters");
  return { cpuUsageUs, memoryCurrentBytes: current, memoryPeakBytes: peak, raw };
}

export function checkResources(r, clients, settings, released = false) {
  for (const name of ["subscriptions", "connections", "pendingTasks", "queueEvents", "queuePeak", "historyEvents", "historyPeak"]) {
    assert.ok(Number.isSafeInteger(r[name]) && r[name] >= 0, `missing native ${name}`);
  }
  assert.equal(r.queueLimit, settings.queueLimit); assert.equal(r.historyLimit, settings.historyLimit);
  assert.ok(r.queueEvents <= clients * settings.queueLimit && r.queuePeak <= settings.queueLimit, "fan-out queue exceeded budget");
  assert.ok(r.historyEvents <= settings.historyLimit && r.historyPeak <= settings.historyLimit, "fan-out history exceeded budget");
  if (released) for (const name of ["subscriptions", "connections", "pendingTasks", "queueEvents"]) assert.equal(r[name], 0, `leaked ${name}`);
  else { assert.equal(r.subscriptions, clients); assert.equal(r.connections, clients); assert.equal(r.pendingTasks, clients); }
}

export function verifyFanout(a, { app, group, provenance, qualification, settings, wire }) {
  assert.equal(a.schema, "native-live-fanout/v1");
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
  assert.deepEqual(a.kernel.before, kernelObservation(a.kernel.before.raw));
  assert.deepEqual(a.kernel.after, kernelObservation(a.kernel.after.raw));
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
    assert.ok(!events.some((r) => r.event.seq === workload.cleanupProbe.seq), "post-detach delivery");
    for (const frame of b.frames) assert.ok(Number.isSafeInteger(frame.through) && frame.through >= 0 && frame.through <= workload.eventCount
      && Number.isFinite(frame.firstFrameAt) && Number.isFinite(frame.secondFrameAt), "invalid visible frame observation");
    for (const [i, event] of applied.entries()) {
      const frame = b.frames.find((f) => f.through >= event.event.seq);
      assert.ok(frame && frame.secondFrameAt >= frame.firstFrameAt, "missing browser paint opportunity");
      const latency = b.timeOrigin + frame.secondFrameAt - (publisher.timeOrigin + publications[i].startedAt);
      assert.ok(Number.isFinite(latency) && latency >= 0, "invalid visible latency clock alignment");
      samples.push(latency);
    }
  }
  const summary = { deliveredEffects: a.clients * workload.eventCount, clients: a.clients,
    visibleLatencyP50Ms: pct(samples, .5), visibleLatencyP95Ms: pct(samples, .95), visibleLatencyMaxMs: Math.max(...samples),
    serverCpuUs: a.kernel.after.cpuUsageUs - a.kernel.before.cpuUsageUs,
    serverMemoryCurrentBytes: a.kernel.after.memoryCurrentBytes, serverMemoryPeakSinceContainerStartBytes: a.kernel.after.memoryPeakBytes };
  if (a.summary) assert.deepEqual(a.summary, summary, "fan-out aggregate differs from actual raw observations");
  return summary;
}

export async function fanoutJourney(browser, base, settings, clients, port, kernelCounters) {
  const workload = createLiveWorkload(fanoutProfile), contexts = [], readers = [];
  const deadline = setTimeout(() => { for (const c of contexts) c.close().catch(() => {}); }, fanoutProfile.deadlineMs);
  const api = async (name, data) => {
    const r = await fetch(`${base}/parity/${name}`, { ...(data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), signal: AbortSignal.timeout(10000) });
    assert.ok(r.ok, `native ${name} failed: ${r.status}`); return r.json();
  };
  try {
    const configuration = await api("configure", { initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit });
    for (let i = 0; i < clients; i++) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const cdp = await context.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Performance.enable");
      const network = [], failures = [], pending = [];
      for (const [event, kind] of [["Network.eventSourceMessageReceived", "native-sse"], ["Network.webSocketFrameReceived", "native-websocket-received"],
        ["Network.webSocketFrameSent", "native-websocket-sent"], ["Network.webSocketCreated", "native-websocket-created"], ["Network.loadingFinished", "received-bytes"]]) cdp.on(event, (e) => network.push({ kind, ...e }));
      page.on("pageerror", (e) => failures.push(e.message));
      page.on("request", (r) => network.push({ kind: "request", method: r.method(), url: r.url(), body: r.postData() }));
      page.on("response", (r) => {
        const observation = { kind: "response", url: r.url(), status: r.status(), headers: r.headers() }; network.push(observation);
        if (r.headers()["content-type"]?.includes("application/json")) pending.push(r.text().then((body) => { observation.body = body; }));
      });
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
      readers.push({ page, cdp, network, failures, pending });
    }
    let attached;
    const attachDeadline = performance.now() + 10000;
    do { attached = await api("resources"); if (attached.subscriptions === clients && attached.connections === clients) break;
      assert.ok(performance.now() < attachDeadline, "fan-out readers failed to attach"); await sleep(10);
    } while (true);
    checkResources(attached, clients, settings);
    const before = kernelCounters();
    const schedule = [], start = performance.now() + 50;
    for (const event of workload.events) {
      const scheduledAt = start + (event.seq - 1) * 1000 / fanoutProfile.rate;
      while (performance.now() < scheduledAt) await sleep(Math.max(1, scheduledAt - performance.now()));
      const startedAt = performance.now(); schedule.push({ seq: event.seq, scheduledAt, startedAt });
      assert.ok(startedAt - scheduledAt <= fanoutProfile.maxScheduleLagMs, "native publisher behind offered rate");
      await readers[0].page.evaluate((e) => window.liveApp.publish(e), event);
    }
    await Promise.all(readers.map(async ({ page }) => { await page.waitForFunction((n) => window.liveApp.through === n, workload.eventCount); await page.evaluate(() => window.liveApp.settle()); }));
    await sleep(50);
    const after = kernelCounters(), delivered = await api("resources");
    await readers[0].page.evaluate(() => window.liveApp.duplicate());
    await Promise.all(readers.map(async ({ page }) => {
      await page.waitForFunction(() => window.liveApp.records.some((r) => r.kind === "event" && r.disposition === "duplicate"));
      await page.evaluate(async () => { await window.liveApp.settle(); window.liveApp.state(); });
    }));
    await Promise.all(readers.map(({ page }) => page.evaluate(() => window.liveApp.detach())));
    await readers[0].page.evaluate((e) => window.liveApp.publish(e, true), workload.cleanupProbe);
    await sleep(settings.cleanupObservationMs + 10);
    await Promise.all(readers.map(({ page }) => page.evaluate(async () => { await window.liveApp.released(); window.liveApp.state(); window.livePaint.stopped = true; })));
    const released = await api("resources");
    const browsers = [];
    for (const r of readers) {
      await Promise.all(r.pending);
      browsers.push({ ...await r.page.evaluate(() => ({ records: window.liveApp.records, frames: window.livePaint.frames, timeOrigin: performance.timeOrigin })),
        network: r.network, failures: r.failures, html: await r.page.content(), version: browser.version(),
        costs: { performance: await r.cdp.send("Performance.getMetrics"), dom: await r.cdp.send("Memory.getDOMCounters") } });
    }
    return { clients, configuration, workload, settings, resources: { attached, delivered, released }, kernel: { before, after }, browsers, schedule };
  } catch (error) {
    error.evidence = { workload, settings, browsers: await Promise.all(readers.map(async (r) => ({
      network: r.network, failures: r.failures, records: await r.page.evaluate(() => window.liveApp?.records ?? []).catch(() => []),
      html: await r.page.content().catch(() => ""),
    }))) };
    throw error;
  } finally { clearTimeout(deadline); await Promise.all(contexts.map((c) => c.close())); }
}
