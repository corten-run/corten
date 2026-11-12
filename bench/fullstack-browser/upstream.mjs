// Instrumented numeric-record source only. Never renders an application answer.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function createUpstream(records) {
  const events = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://upstream").pathname;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (path === "/__browser/counters" && req.method === "GET") return send(200, { events });
    const match = /^\/marketplace\/records\/([^/]+)$/.exec(path);
    if (!match || req.method !== "GET") return send(404, { error: "not found" });
    const id = decodeURIComponent(match[1]);
    const event = { id, started: Date.now(), completed: null, cancelled: null, status: Object.hasOwn(records, id) ? 200 : 404 };
    events.push(event);
    res.on("finish", () => { event.completed = Date.now(); });
    res.on("close", () => { if (event.completed === null) event.cancelled = Date.now(); });
    return send(event.status, records[id] ?? { error: "not found" });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  return server;
}
export function upstreamDelta(before, after) {
  const events = after.events.slice(before.events.length);
  return { started: events.length, completed: events.filter((v) => v.completed !== null).length,
    cancelled: events.filter((v) => v.cancelled !== null).length,
    pending: events.filter((v) => v.completed === null && v.cancelled === null).length, events };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createUpstream(JSON.parse(readFileSync(process.argv[2], "utf8")));
  server.listen(8080, "0.0.0.0");
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { server.close(); server.closeAllConnections(); });
}
