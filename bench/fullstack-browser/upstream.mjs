// Instrumented numeric-record source only. Never renders an application answer.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

export function createUpstream(records) {
  const events = [];
  const ledger = randomUUID();
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://upstream").pathname;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (path === "/__browser/counters" && req.method === "GET") return send(200, { schema: "native-browser-upstream-counters/v1", ledger, events });
    const match = /^\/marketplace\/records\/([^/]+)$/.exec(path);
    if (!match || req.method !== "GET") return send(404, { error: "not found" });
    const id = decodeURIComponent(match[1]);
    const event = { request: randomUUID(), id, started: Date.now(), completed: null, cancelled: null, status: Object.hasOwn(records, id) ? 200 : 404 };
    events.push(event);
    res.on("finish", () => { event.completed = Date.now(); });
    res.on("close", () => { if (event.completed === null) event.cancelled = Date.now(); });
    return send(event.status, records[id] ?? { error: "not found" });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  return server;
}
export function upstreamDelta(before, after) {
  assertPrefix(before, after);
  const events = after.events.slice(before.events.length);
  return { started: events.length, completed: events.filter((v) => v.completed !== null).length,
    cancelled: events.filter((v) => v.cancelled !== null).length,
    pending: events.filter((v) => v.completed === null && v.cancelled === null).length, events };
}

function assertSnapshot(snapshot) {
  assert.ok(snapshot?.schema === "native-browser-upstream-counters/v1" && typeof snapshot.ledger === "string" && snapshot.ledger
    && Array.isArray(snapshot.events), "Complete upstream counters/ledger identity unavailable");
  const ids = new Set();
  for (const event of snapshot.events) {
    assert.ok(typeof event?.request === "string" && event.request && !ids.has(event.request) && typeof event.id === "string"
      && Number.isFinite(event.started) && [200, 404].includes(event.status), "Malformed/duplicate upstream request identity");
    ids.add(event.request);
    assert.ok([event.completed, event.cancelled].every((at) => at === null || Number.isFinite(at) && at >= event.started)
      && !(event.completed !== null && event.cancelled !== null), "Malformed/conflicting upstream terminal receipt");
  }
}
function assertPrefix(before, after) {
  assertSnapshot(before); assertSnapshot(after);
  assert.equal(before.ledger, after.ledger, "Upstream ledger restarted/replaced");
  assert.ok(after.events.length >= before.events.length, "Upstream ledger truncated");
  before.events.forEach((event, index) => {
    const next = after.events[index];
    for (const key of ["request", "id", "started", "status"]) assert.equal(next[key], event[key], "Upstream request history changed");
    for (const key of ["completed", "cancelled"]) if (event[key] !== null) assert.equal(next[key], event[key], "Upstream terminal receipt changed");
  });
}

export class UpstreamAudit {
  constructor(counters) {
    this.counters = counters;
    this.ledger = { schema: "native-browser-upstream-ledger/v1", baseline: null, phases: [], terminal: null,
      scope: "Independent numeric-source request finish/close receipts only; not app server-peer closure or worker-network coverage" };
  }
  async sample() {
    const row = { startedAt: performance.now(), finishedAt: null, snapshot: null, error: null };
    try { row.snapshot = structuredClone(await this.counters()); } catch (error) { row.error = error.message; }
    row.finishedAt = performance.now(); return row;
  }
  async start() { this.ledger.baseline = await this.sample(); }
  async begin(phase) { const row = { phase, before: await this.sample(), after: null }; this.ledger.phases.push(row); return row; }
  async end(row) {
    row.after = await this.sample();
    return upstreamDelta(row.before.snapshot, row.after.snapshot);
  }
  async finish() { this.ledger.terminal = await this.sample(); }
}

export function reconcileUpstream(ledger, { source, actions, observationMs = 0 } = {}) {
  const result = { outcome: "unknown", reasons: [], phases: [], final: null };
  try {
    assert.ok(ledger?.schema === "native-browser-upstream-ledger/v1" && Array.isArray(ledger.phases), "Final upstream ledger unavailable");
    assert.deepEqual(ledger.phases.map((p) => p.phase), ["initial-store", ...actions, "mutation-probes", "cleanup"], "Incomplete upstream phase coverage");
    let previous = null;
    const sample = (row) => {
      assert.ok(row && !row.error && Number.isFinite(row.startedAt) && Number.isFinite(row.finishedAt) && row.finishedAt >= row.startedAt
        && (!previous || row.startedAt >= previous.finishedAt), "Upstream sample missing/failed or observation order invalid");
      assertSnapshot(row.snapshot);
      if (previous) assertPrefix(previous.snapshot, row.snapshot);
      previous = row; return row.snapshot;
    };
    const baseline = sample(ledger.baseline);
    assert.ok(baseline.events.every((e) => e.completed !== null || e.cancelled !== null), "Upstream baseline has unowned pending work");
    for (const phase of ledger.phases) {
      const prior = previous.snapshot, before = sample(phase.before);
      assert.equal(before.events.length, prior.events.length, `Unassigned upstream requests before ${phase.phase}`);
      const delta = upstreamDelta(before, sample(phase.after));
      assert.equal(delta.pending, 0, `Upstream work pending after ${phase.phase}`);
      result.phases.push({ phase: phase.phase, ...delta });
    }
    const last = previous, terminal = sample(ledger.terminal);
    assert.ok(Number.isFinite(observationMs) && observationMs >= 0 && ledger.terminal.startedAt - last.finishedAt >= observationMs, "Upstream terminal observation interval incomplete");
    assert.equal(terminal.events.length, last.snapshot.events.length, "Late unassigned upstream requests at terminal observation");
    result.final = upstreamDelta(baseline, terminal);
    assert.equal(result.final.pending, 0, "Final upstream work lacks terminal finish/close receipts");
    assert.ok(source === "api" || source === "fixture", "Upstream source identity unavailable");
    if (source === "fixture") assert.equal(result.final.started, 0, "Fixture journey fetched upstream outside/inside actions");
    result.outcome = "reconciled";
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createUpstream(JSON.parse(readFileSync(process.argv[2], "utf8")));
  server.listen(8080, "0.0.0.0");
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { server.close(); server.closeAllConnections(); });
}
