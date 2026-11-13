// Path-scoped observation lets independent native clients run concurrently without
// forwarding benchmark IDs through an app or assigning expected work as observed work.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateRecord } from "../marketplace/records.mjs";

export function loadUpstream(records, token) {
  if (!token) throw new Error("private control token required");
  const bodies = new Map(Object.entries(records).map(([id, record]) => {
    validateRecord(record, id); return [`/marketplace/records/${id}`, JSON.stringify(record, null, 2)];
  }));
  const operations = new Map(), paths = new Map(), orphans = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://upstream");
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/health") return send(200, {});
    if (url.pathname === "/__mixed/control") {
      if (req.headers.authorization !== `Bearer ${token}`) return send(403, {});
      if (req.method === "GET") {
        if (url.searchParams.get("id") === "orphans") return send(200, orphans);
        const op = operations.get(url.searchParams.get("id")); return op ? send(200, op) : send(404, {});
      }
      if (req.method !== "POST") return send(405, {});
      try {
        let body = ""; for await (const part of req) { body += part; if (body.length > 4096) throw new Error(); }
        const v = JSON.parse(body);
        if (!/^[a-zA-Z0-9_-]+$/.test(v.id) || operations.has(v.id) || !bodies.has(v.path)
          || !["normal", "complete", "cancel", "deadline"].includes(v.mode)
          || !Number.isSafeInteger(v.delayMs) || v.delayMs < 0 || v.delayMs > 120000) throw new Error();
        const previous = paths.get(v.path);
        if (previous?.pending) throw new Error(); // Never steal an in-flight native read's identity.
        const op = { ...v, requests: 0, completed: 0, cancelled: 0, pending: 0, events: [] };
        operations.set(v.id, op); paths.set(v.path, op); return send(200, {});
      } catch { return send(400, {}); }
    }
    const op = paths.get(url.pathname);
    if (!op) { orphans.push({ method: req.method, path: url.pathname, at: new Date().toISOString() }); return send(503, {}); }
    const event = { method: req.method, path: url.pathname, startedAt: new Date().toISOString(), result: "pending" };
    op.events.push(event); op.requests++; op.pending++;
    let timer;
    const finish = (result) => {
      if (event.result !== "pending") return;
      clearTimeout(timer); event.result = result; event.endedAt = new Date().toISOString(); op.pending--; op[result]++;
    };
    res.once("finish", () => finish("completed"));
    res.once("close", () => finish(res.writableFinished ? "completed" : "cancelled"));
    const answer = () => {
      res.writeHead(req.method === "GET" ? 200 : 405, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(req.method === "GET" ? bodies.get(url.pathname) : "{}");
    };
    if (op.mode === "normal") answer(); else timer = setTimeout(answer, op.delayMs);
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = loadUpstream(JSON.parse(readFileSync(process.env.MARKETPLACE_FIXTURE_PATH, "utf8")), process.env.MIXED_CONTROL_TOKEN);
  server.listen(8080, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
