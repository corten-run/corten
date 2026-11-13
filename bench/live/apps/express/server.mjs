import express from "express";
import { fileURLToPath } from "node:url";

const app = express();
app.use(express.json({ limit: "256kb" }));
let rows = new Map(), through = 0, history = [], queueLimit = 2, historyLimit = 4;
let queuePeak = 0, historyPeak = 0, hold = false, dropSeq = 0, snapshotReads = 0;
let bytes = 0, socketPeak = 0;
const clients = new Set();
const resources = () => ({ subscriptions: clients.size, connections: clients.size,
  pendingTasks: clients.size,
  queueLimit, queueEvents: [...clients].reduce((n, c) => n + c.queue.length, 0), queuePeak,
  historyLimit, historyEvents: history.length, historyPeak,
  process: { pid: process.pid, memory: process.memoryUsage(), cpu: process.cpuUsage(), usage: process.resourceUsage(), version: process.version },
  inventory: { applicationQueues: clients.size, nativeWritableBytes: [...clients].reduce((n, c) => n + c.res.writableLength, 0),
    nativeWritablePeakBytes: socketPeak, nativeWritableLimitBytes: 65536, historyRows: rows.size,
    replayCopyLimitEvents: historyLimit, overflowSlotsLimit: 1,
    snapshotReads, transportFrameBytes: bytes, timers: 0, backgroundPublishers: 0 },
});
function send(c, type, value) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  bytes += Buffer.byteLength(frame);
  const ready = c.res.write(frame);
  socketPeak = Math.max(socketPeak, c.res.writableLength);
  if (c.res.writableLength > 65536) { c.res.destroy(); return false; }
  if (!ready) c.blocked = true;
  return ready;
}
function drain(c) {
  while (!hold && !c.blocked && c.queue.length && clients.has(c)) send(c, "update", c.queue.shift());
}
function enqueue(c, event) {
  if (c.queue.length === queueLimit) {
    const saturated = resources();
    c.queue.length = 0;
    hold = false;
    send(c, "overflow", { outcome: "resnapshot", resources: saturated });
    return;
  }
  c.queue.push(event);
  queuePeak = Math.max(queuePeak, c.queue.length);
  drain(c);
}
app.get("/", (_req, res) => res.type("html").send('<!doctype html><html lang="en"><title>Express live parity</title><body><h1>Express native keyed feed</h1><table><tbody id="rows"></tbody></table><output id="effects">0</output><script src="/client.js"></script></body></html>'));
app.get("/client.js", (_req, res) => res.sendFile(fileURLToPath(new URL("client.js", import.meta.url))));
app.post("/parity/configure", (req, res) => {
  if (clients.size) return res.sendStatus(409);
  const p = req.body;
  if (!Array.isArray(p.initial) || p.initial.length > 1000
    || !((p.queueLimit === 2 && p.historyLimit === 4) || (p.queueLimit === 1024 && p.historyLimit === 1025))) return res.sendStatus(400);
  rows = new Map(p.initial.map((r) => [r.id, r])); through = 0; history = [];
  queueLimit = p.queueLimit; historyLimit = p.historyLimit; queuePeak = historyPeak = snapshotReads = bytes = socketPeak = 0;
  hold = false; dropSeq = 0;
  res.json({ configured: true, framework: "express", version: "5.3.0" });
});
app.get("/parity/resources", (_req, res) => res.json(resources()));
app.get("/parity/snapshot", (_req, res) => {
  snapshotReads++;
  res.json({ through, rows: [...rows.values()], work: { reads: 1, rows: rows.size } });
});
app.get("/parity/events", (req, res) => {
  if (clients.size >= 16) return res.sendStatus(429);
  const from = Number(req.query.from);
  if (!Number.isSafeInteger(from) || from < 0 || from > through) return res.sendStatus(400);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const c = { res, queue: [], blocked: false };
  clients.add(c);
  const expired = from < through && (!history.length || from < history[0].seq - 1);
  send(c, "ready", { from, status: expired ? "expired" : "accepted", resources: resources() });
  // Include the retained boundary to exercise the application's duplicate-effect guard.
  if (!expired) for (const e of history.filter((e) => e.seq >= from)) enqueue(c, e);
  res.on("drain", () => { c.blocked = false; drain(c); });
  res.on("close", () => { clients.delete(c); c.queue.length = 0; c.blocked = false; });
});
app.post("/parity/publish", (req, res) => {
  const batch = Object.hasOwn(req.body, "events");
  const events = batch ? req.body.events : [req.body.event];
  if (batch && (queueLimit !== 1024 || Object.hasOwn(req.body, "event")) || !Array.isArray(events) || !events.length || events.length > 1044
    || events.some((e, i) => !e || e.seq !== through + i + 1 || typeof e.key !== "string" || typeof e.effectId !== "string"
      || !["remove", "upsert"].includes(e.op) || e.op === "upsert" && e.row?.id !== e.key)) return res.sendStatus(400);
  const acks = [];
  for (const e of events) {
  through = e.seq;
  if (e.op === "remove") rows.delete(e.key); else rows.set(e.key, e.row);
  if (history.length === historyLimit) history.shift(); history.push(e);
  historyPeak = Math.max(historyPeak, history.length);
  if (e.seq !== dropSeq) for (const c of clients) enqueue(c, e);
    acks.push({ seq: through, resources: resources() });
  }
  res.json(batch ? { acks } : acks[0]);
});
app.post("/parity/control", (req, res) => {
  const p = req.body;
  if (p.action === "hold") hold = true;
  else if (p.action === "drop") dropSeq = p.seq;
  else if (p.action === "duplicate") {
    const event = history.at(-1); if (!event) return res.sendStatus(409);
    for (const c of clients) enqueue(c, event);
  } else return res.sendStatus(400);
  res.json({ resources: resources() });
});
app.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
