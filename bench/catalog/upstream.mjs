// Only this upstream pre-serializes. The measured apps must serialize each JSON request.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validateCatalog } from "./contract.mjs";

export function catalogServer(catalog, admin = null) {
  validateCatalog(catalog);
  const bodies = new Map(Object.entries(catalog).map(([id, record]) => [id, Buffer.from(JSON.stringify(record))]));
  const routes = new Map([...bodies.keys()].map((id) => [`/catalog/records/${id}`, id]));
  let requests = {};
  let override = null;
  let status = 200;
  const handle = (req, res) => {
    const direct = req.method === "GET" ? routes.get(req.url) : undefined;
    const path = direct === undefined ? new URL(req.url, "http://catalog").pathname : null;
    const send = (code, value) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(value); };
    if (admin && !admin.ready()) return send(503, '{}');
    if (path === "/__catalog/control") {
      if (admin) return void admin.control(req, send);
      if (req.method === "GET") return send(200, JSON.stringify({ requests, status }));
      if (req.method !== "POST") return send(405, '{}');
      void applyControl(req, send);
      return;
    }
    if (admin && path === "/__catalog/observe") return void admin.control(req, send, true);
    if (path === "/health" && req.method === "GET") return send(admin && !admin.ready() ? 503 : 200, '{}');
    const id = direct ?? /^\/catalog\/records\/(record_[1-9]\d*)$/.exec(path)?.[1];
    if (!id || req.method !== "GET") return send(404, '{}');
    requests[id] = (requests[id] ?? 0) + 1;
    if (status !== 200) return send(status, '{"error":"upstream unavailable"}');
    const body = override?.id === id ? override.body : bodies.get(id);
    return send(body ? 200 : 404, body ?? '{"error":"not found"}');
  };
  const server = createServer((req, res) => admin ? admin.dispatch(req, res, handle) : handle(req, res));
  server.catalogState = () => ({ requests: { ...requests }, status,
    configuration: createHash("sha256").update(JSON.stringify({ status,
      override: override ? { id: override.id, body: override.body.toString("utf8") } : null })).digest("hex") });
  server.catalogApply = (control) => {
    override = control.record ? { id: control.record.id, body: Buffer.from(JSON.stringify(control.record, null, control.pretty ? 2 : undefined)) } : null;
    status = control.status ?? 200;
    requests = {};
  };
  async function applyControl(req, send) {
    try {
      let body = "";
      for await (const part of req) {
        body += part;
        if (body.length > 1024 * 1024) throw new Error("control body too large");
      }
      const control = JSON.parse(body);
      if (![200, 503].includes(control.status ?? 200)) throw new Error("invalid control status");
      server.catalogApply(control);
      send(200, '{}');
    } catch { send(400, '{}'); }
  }
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--fixed-workers")) {
    await (await import("./upstream-workers.mjs")).startWorkers(catalogServer);
  } else {
    const server = catalogServer(JSON.parse(readFileSync(process.env.CATALOG_FIXTURE_PATH ?? "/fixtures/catalog.json", "utf8")));
    server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
    const stop = () => { server.close(); server.closeAllConnections(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}
