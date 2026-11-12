// Private fault injector. No app imports this module or the offline oracle.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateRecord } from "../marketplace/records.mjs";

export function mixedUpstream(records, token) {
  if (!token) throw new Error("control authentication required");
  for (const [id, record] of Object.entries(records)) validateRecord(record, id);
  const bodies = new Map(Object.entries(records).map(([id, record]) => [id, JSON.stringify(record, null, 2)]));
  const operations = new Map();
  let current;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://upstream");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/health") return send(200, {});
    if (url.pathname === "/__mixed/control") {
      if (req.headers.authorization !== `Bearer ${token}`) return send(403, {});
      if (req.method === "GET") {
        const op = operations.get(url.searchParams.get("id"));
        return op ? send(200, { ...op, events: [...op.events] }) : send(404, {});
      }
      if (req.method !== "POST") return send(405, {});
      try {
        let body = "";
        for await (const part of req) { body += part; if (body.length > 4096) throw new Error(); }
        const value = JSON.parse(body);
        if (!/^[a-zA-Z0-9_-]+$/.test(value.id) || operations.has(value.id)
          || !["normal", "complete", "deadline", "cancel"].includes(value.mode)
          || !Number.isSafeInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 120000) throw new Error();
        current = { id: value.id, mode: value.mode, delayMs: value.delayMs, requests: 0, completed: 0, cancelled: 0, pending: 0, events: [] };
        operations.set(current.id, current);
        return send(200, {});
      } catch { return send(400, {}); }
    }
    const op = current;
    if (!op) return send(503, {});
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
      const match = /^\/marketplace\/records\/(item_[1-9]\d*)$/.exec(url.pathname);
      const body = req.method === "GET" && match && bodies.get(match[1]);
      res.writeHead(body ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body || "{}");
    };
    if (op.mode !== "normal") timer = setTimeout(answer, op.delayMs); else answer();
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = mixedUpstream(JSON.parse(readFileSync(process.env.MARKETPLACE_FIXTURE_PATH, "utf8")), process.env.MIXED_CONTROL_TOKEN);
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
