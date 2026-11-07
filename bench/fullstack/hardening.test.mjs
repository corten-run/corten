// Checks how the hardening step's results read (hardening.mjs) and harden-probe.mjs's phases
// against local servers, without Docker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { cellsOf, closureOf, coresOf, phases, stateOf, survived } from "./hardening.mjs";

test("every phase has a key, a label, a limit and the probe's numbers, each key once", () => {
  assert.equal(new Set(phases.map((p) => p.key)).size, phases.length);
  for (const p of phases) {
    assert.ok(p.label && p.limitMs > 0, p.key);
    // The probe's own hold fits in the limit, with time to open its connections (250 at a time,
    // each allowed 5 s) and a minute for the good client and the request after.
    const opening = Math.ceil((p.input.count ?? 0) / 250) * 5000;
    if (p.input.holdMs) assert.ok(p.input.holdMs + opening + 60_000 <= p.limitMs, `${p.key}: ${p.input.holdMs} + ${opening} + 60000 > ${p.limitMs}`);
  }
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

/**
 * Runs harden-probe.mjs against a local server.
 * @param {import("node:net").Server} server
 * @param {Record<string, unknown>} request
 */
const probeAgainst = async (server, request) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const child = spawn(process.execPath, [join(import.meta.dirname, "harden-probe.mjs")]);
  child.stdin.end(JSON.stringify({ host: "127.0.0.1", port, ...request }));
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  await new Promise((r) => child.on("close", r));
  server.close();
  assert.ok(out, err);
  return JSON.parse(out);
};

/** A server that answers a complete request head with a 200, and does what `partial` says with one that never completes. */
const serving = (/** @type {(s: import("node:net").Socket) => void} */ partial) => createServer((s) => {
  s.on("error", () => {});
  let head = "";
  s.on("data", (c) => {
    head += c;
    if (head.includes("\r\n\r\n")) { s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"); return; }
    partial(s);
  });
});

test("the head flood sees a server close unfinished heads, and the good client and the request after are answered", async () => {
  const r = await probeAgainst(serving((s) => setTimeout(() => s.destroy(), 300)), { phase: "headFlood", count: 20, holdMs: 5000 });
  assert.equal(r.opened, 20);
  assert.equal(r.closedBy.length, 20);
  assert.ok(r.heldMs < 5000, "ended once all were closed");
  assert.ok(r.good.ok > 0 && r.good.failed === 0, JSON.stringify(r.good));
  assert.equal(r.after, 200);
});

test("idle connections a server keeps are held to the end of the phase and then closed", async () => {
  const r = await probeAgainst(serving(() => {}), { phase: "idleFlood", count: 10, holdMs: 600 });
  assert.equal(r.opened, 10);
  assert.deepEqual(r.closedBy, []);
  assert.ok(r.heldMs >= 600);
  assert.equal(r.after, 200);
});

test("a slow head is sent a byte at a time until the server closes it", async () => {
  /** @type {number[]} */
  const sizes = [];
  const server = createServer((s) => {
    s.on("error", () => {});
    let n = 0;
    s.on("data", (c) => { n += c.length; if (n >= 5) { sizes.push(n); s.destroy(); } });
  });
  // The good client's requests reach this server too and are closed unanswered: counted as failed.
  const r = await probeAgainst(server, { phase: "slowHead", count: 3, everyMs: 20, holdMs: 3000 });
  assert.equal(r.closedBy.length, 3);
  // Each slow connection had sent exactly five bytes, one a tick, when it was closed.
  assert.equal(sizes.filter((n) => n === 5).length, 3, JSON.stringify(sizes));
});

test("the oversized requests' answers are each one's status, or closed", async () => {
  const server = createServer((s) => {
    s.on("error", () => {});
    let n = 0;
    let answered = false;
    s.on("data", (c) => {
      n += c.length;
      // Once answered, the rest is read and dropped: a reset now could lose the answer.
      if (answered) return;
      const text = String(c);
      if (text.startsWith("POST")) { answered = true; s.end("HTTP/1.1 413 Content Too Large\r\nContent-Length: 0\r\n\r\n"); return; }
      if (n > 64 * 1024) { s.destroy(); return; }
      if (text.includes("x-h199")) s.end("HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\n\r\n");
      else if (text.includes("\r\n\r\n")) s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
    });
  });
  const r = await probeAgainst(server, { phase: "oversized" });
  assert.deepEqual(r.statuses, { manyHeaders: 431, hugeHeader: "closed", hugeBody: 413 });
  // The huge header's server destroyed the connection while the probe was still sending.
  assert.ok(r.reset.hugeHeader === "ECONNRESET" || r.reset.hugeHeader === "EPIPE", JSON.stringify(r.reset));
  assert.equal(r.reset.hugeBody, null);
  assert.equal(r.after, 200);
});

test("a slow body's answer is counted, and each close is timed from that connection's connect", async () => {
  // Refuses every other body at once with a 429, as a write limiter would, and closes the rest after 400 ms.
  let n = 0;
  const server = createServer((s) => {
    s.on("error", () => {});
    let head = "";
    let decided = false;
    s.on("data", (c) => {
      head += c;
      if (decided || !head.includes("\r\n\r\n")) return;
      decided = true;
      // The well-behaved client's GETs are answered.
      if (!head.startsWith("POST")) { s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"); return; }
      if (n++ % 2 === 0) s.end("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n");
      else setTimeout(() => s.destroy(), 400);
    });
  });
  const r = await probeAgainst(server, { phase: "slowBody", count: 6, everyMs: 50, holdMs: 5000 });
  assert.equal(r.opened, 6);
  assert.equal(r.closedBy.length, 6);
  assert.deepEqual(r.answers, { 429: 3, none: 3 });
  assert.ok(r.closedBy.at(-1) < 2000, JSON.stringify(r.closedBy));
  assert.equal(r.after, 200);
});

test("a client that stops reading sees the server close it once its writes are blocked", async () => {
  // Answers each pipelined request with 64 KiB until its writes block, then gives the reader 500 ms.
  const server = createServer((s) => {
    s.on("error", () => {});
    const page = Buffer.alloc(64 * 1024, "a");
    let blocked = false;
    s.on("data", () => {
      while (!blocked) blocked = !s.write(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${page.length}\r\n\r\n`), page]));
      setTimeout(() => s.destroy(), 500);
    });
  });
  const r = await probeAgainst(server, { phase: "slowReader", count: 3, pipelined: 10, everyMs: 100, holdMs: 10_000 });
  assert.equal(r.opened, 3);
  assert.equal(r.closedBy.length, 3, "each close was seen on the paused socket");
  assert.ok(r.closedBy.at(-1) < 3000, JSON.stringify(r.closedBy));
  assert.ok(r.heldMs < 10_000, "ended once all were closed");
});
