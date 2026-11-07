// Only this upstream pre-serializes. The measured apps must serialize each JSON request.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateCatalog } from "./contract.mjs";

export function catalogServer(catalog) {
  validateCatalog(catalog);
  const bodies = new Map(Object.entries(catalog).map(([id, record]) => [id, JSON.stringify(record)]));
  let requests = {};
  let override = null;
  let status = 200;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://catalog").pathname;
    const send = (code, value) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(value); };
    if (path === "/__catalog/control") {
      if (req.method === "GET") return send(200, JSON.stringify({ requests, status }));
      if (req.method !== "POST") return send(405, '{}');
      try {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 1024 * 1024) throw new Error("control body too large");
        }
        const control = JSON.parse(body);
        if (![200, 503].includes(control.status ?? 200)) throw new Error("invalid control status");
        override = control.record ? { id: control.record.id, body: JSON.stringify(control.record, null, control.pretty ? 2 : undefined) } : null;
        status = control.status ?? 200;
        requests = {};
        return send(200, '{}');
      } catch { return send(400, '{}'); }
    }
    if (path === "/health" && req.method === "GET") return send(200, '{}');
    const match = /^\/catalog\/records\/(record_[1-9]\d*)$/.exec(path);
    if (!match || req.method !== "GET") return send(404, '{}');
    const id = match[1];
    requests[id] = (requests[id] ?? 0) + 1;
    if (status !== 200) return send(status, '{"error":"upstream unavailable"}');
    const body = override?.id === id ? override.body : bodies.get(id);
    return send(body ? 200 : 404, body ?? '{"error":"not found"}');
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = catalogServer(JSON.parse(readFileSync(process.env.CATALOG_FIXTURE_PATH ?? "/fixtures/catalog.json", "utf8")));
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
