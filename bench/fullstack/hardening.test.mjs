// Offline reader coverage for archived fullstack hardening results.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellsOf, closureOf, coresOf, keptFrom, phases, replacing, stateOf, survived } from "./hardening.mjs";

test("the archived report retains its phase keys in column order", () => {
  assert.deepEqual(phases.map((p) => p.key), ["headFlood", "slowHead", "slowBody", "slowReader", "idleFlood", "oversized"]);
  for (const p of phases) assert.ok(p.label, p.key);
});

test("an app survives a phase when it still runs, was not killed for memory and answers after", () => {
  const ok = { running: true, oomKilled: false, after: 200 };
  assert.equal(survived(ok), true);
  assert.equal(survived({ ...ok, after: null }), false);
  assert.equal(survived({ ...ok, running: false }), false);
  assert.equal(survived({ ...ok, oomKilled: true }), false);
  assert.equal(survived({ ...ok, error: "probe failed" }), false);
  // Up, but more than 1% of the well-behaved client's requests failed: degraded.
  assert.equal(stateOf({ ...ok, good: { sent: 100, failed: 1 } }), "up");
  assert.equal(stateOf({ ...ok, good: { sent: 100, failed: 2 } }), "degraded");
  assert.equal(stateOf({ ...ok, good: { sent: 2, failed: 1 } }), "up", "one request of a short phase");
  assert.equal(stateOf({ ...ok, running: false }), "DOWN");
  assert.equal(stateOf({ ...ok, oomKilled: true }), "DOWN (out of memory)");
});

test("a rerun keeps the phases it does not run with the commit they were taken at, and what it replaces", () => {
  const header = { commit: "aaa", dirty: true, date: "2026-11-07T17:38:27Z" };
  const fresh = { taken: { commit: "bbb", dirty: false, date: "2026-11-07T18:00:00Z" }, cpuSeconds: 2 };
  const kept = keptFrom({ corten: { probes: { headFlood: { cpuSeconds: 1 }, slowReader: fresh, slowHead: { error: "probe failed" } }, cells: {} } }, header);
  assert.deepEqual(kept.corten.probes.headFlood.taken, { ...header, fromHeader: true }, "an old phase is given the file's header, marked as such");
  assert.equal(kept.corten.probes.slowReader, fresh, "one with its own taken keeps it");
  assert.equal(kept.corten.probes.slowHead.taken, undefined, "an error was not taken");
  assert.deepEqual(kept.corten.cells, {});
  assert.equal(replacing(undefined, fresh), fresh);
  const once = replacing(kept.corten.probes.headFlood, fresh);
  assert.deepEqual(once.earlier, [kept.corten.probes.headFlood]);
  const twice = replacing(once, { ...fresh, cpuSeconds: 3 });
  assert.deepEqual(twice.earlier.map((/** @type {any} */ p) => p.cpuSeconds), [1, 2], "oldest first, none nested");
  assert.equal(twice.earlier[1].earlier, undefined);
  // An app that did not start is a pass too: the result it replaces is kept.
  const failed = replacing(twice, { error: "did not answer in 120 s", taken: fresh.taken });
  assert.equal(failed.error, "did not answer in 120 s");
  assert.deepEqual(failed.earlier.map((/** @type {any} */ p) => p.cpuSeconds), [1, 2, 3]);
});

test("a phase's cell says what the app did with the connections, what a good client saw and the memory it reached", () => {
  assert.equal(closureOf({ opened: 3, closedBy: [100, 29_000, 30_150], heldMs: 30_200 }), "closed all 3 within 30.1 s");
  assert.equal(closureOf({ opened: 3, closedBy: [], heldMs: 60_010 }), "held all 3 to the end of the hold (60 s)");
  assert.equal(closureOf({ opened: 3, closedBy: [31_000], heldMs: 60_010 }), "closed 1 of 3 within 31.0 s, held the rest to the end of the hold (60 s)");
  assert.equal(closureOf({ opened: 3, closedBy: [100, 120, 10_100], answers: { none: 1, 429: 2 }, heldMs: 10_200 }), "closed all 3 within 10.1 s (429 to 2)");
  assert.equal(coresOf({ cpuSeconds: 4.5, wallMs: 90_000 }), 0.05);
  assert.equal(coresOf({ cpuSeconds: null, wallMs: 90_000 }), null);
  assert.equal(closureOf({ opened: 0 }), "none connected");
  const good = { sent: 300, ok: 300, failed: 0, p50: 2, p99: 9, max: 20 };
  const cells = cellsOf({
    headFlood: { opened: 2, closedBy: [30_000, 30_100], heldMs: 30_200, good, after: 200, running: true, oomKilled: false, memMaxMiB: 48.2 },
    idleFlood: { opened: 2, closedBy: [], heldMs: 60_000, good: { ...good, failed: 300, ok: 0, p99: null }, after: null, running: false, oomKilled: true, memMaxMiB: 1024 },
    oversized: { statuses: { manyHeaders: 431, hugeHeader: "closed", hugeBody: "closed" }, reset: { hugeBody: "ECONNRESET" }, good, after: 200, running: true, oomKilled: false, memMaxMiB: null, cpuSeconds: 1.2, wallMs: 4000 },
    slowHead: { error: "probe failed: exit 1" },
    slowReader: { opened: 2, closedBy: [], heldMs: 90_000, blocked: { open: 3, stalled: 1, silent: 1, unreadMiB: 3.1 }, good, after: 200, running: true, oomKilled: false },
  });
  assert.equal(cells.headFlood, "up: closed all 2 within 30.1 s; good p99 9 ms, 0 of 300 failed; 48.2 MiB peak");
  assert.equal(cells.idleFlood, "DOWN (out of memory): held all 2 to the end of the hold (60 s); good p99 - ms, 300 of 300 failed; 1024 MiB peak");
  assert.equal(cells.oversized, "up: 431 / closed / reset; good p99 9 ms, 0 of 300 failed; 0.3 cores");
  assert.equal(cells.slowHead, "error probe failed: exit 1");
  assert.equal(cells.slowReader, "up: held all 2 to the end of the hold (90 s) (1 of 3 open no longer sent to, 1 sent nothing); good p99 9 ms, 0 of 300 failed");
});
