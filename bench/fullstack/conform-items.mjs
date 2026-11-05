// The item API conform.mjs's apps read: the fixture's items over HTTP, as item-api/server.mjs
// serves them (one process, which a probe's few requests need), and one more, `brokenItem`,
// answered 500: a read that fails, so each app's answer shows its error format for a 5xx.
// item-api/server.mjs stays as the benchmark measures it.
// Usage: node conform-items.mjs <items.json> [port=8080]
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { brokenItem } from "./conformance.mjs";

const [file = "/b/fixtures/items.json", port = "8080"] = process.argv.slice(2);
const items = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8"))).map(([id, item]) => [id, Buffer.from(JSON.stringify(item))]));
const prefix = "/api/discovery/items/";
createServer((req, res) => {
  const id = req.url?.startsWith(prefix) ? decodeURIComponent(req.url.slice(prefix.length)) : undefined;
  if (id === brokenItem) {
    res.writeHead(500, { "content-type": "text/plain" }).end("item API failure");
    return;
  }
  const body = id === undefined ? undefined : items.get(id);
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "content-length": body.length }).end(body);
}).listen(Number(port), "0.0.0.0", () => console.log(`conform item API: ${items.size} items and ${brokenItem} on ${port}`));
