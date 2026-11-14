// Test-only entry dependency: synthetic consumption and owned loopback HTTPS.
// The production worker has no flag/env/IPC switch selecting this entry.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { serveProviderWorker } from "./cloud-provider-worker.mjs";

const [mode, output] = process.argv.slice(2);
// This test-only file entry substitutes for the stdin snapshot entry.
process.stdin.resume();
assert.ok(basename(dirname(output)).startsWith("cloud-diagnostic-test-"));
const state = { consumes: 0, requests: 0, execArgv: process.execArgv,
  diagnosticNames: Object.keys(process.env).filter((name) => /^(?:NODE_OPTIONS|NODE_DEBUG|NODE_DEBUG_NATIVE|SSLKEYLOGFILE|LD_PRELOAD|NODE_EXTRA_CA_CERTS)$/.test(name)),
  reportOnSignal: process.report.reportOnSignal, calls: [] };
const save = () => writeFileSync(output, JSON.stringify(state)); save();
if (mode === "worker-new-debug") process.env.NODE_DEBUG = "https";
if (mode === "worker-new-report") process.report.reportOnSignal = true;
const server = createServer((socket) => socket.destroy());
server.listen(0, "127.0.0.1"); await once(server, "listening");
let created;
const syntheticRequest = ["success", "hang", "hang-create", "withhold-close", "reflect"].includes(mode) ? async ({ method, path, body, credential }) => {
  state.requests++; state.calls.push({ method, path, originalCredential: credential === "SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL" }); save();
  if (mode === "hang" || mode === "hang-create" && method === "POST") return new Promise(() => {});
  if (mode === "reflect") return { status: 200, value: { account: { uuid: credential } } };
  if (path === "/v2/account") return { status: 200, value: { account: { uuid: "synthetic-user-0001", droplet_limit: 20 } } };
  if (path.startsWith("/v2/droplets?")) return { status: 200, value: { droplets: created ? [created] : [], meta: { total: created ? 1 : 0 }, links: {} } };
  if (method === "DELETE") { created = undefined; return { status: 204, value: null }; }
  if (method === "POST") {
    created = { id: 123, name: body.name, tags: body.tags, size_slug: body.size, region: { slug: body.region }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } };
    return { status: 202, value: { droplet: created, links: { actions: [{ id: 456, rel: "create", href: "https://api.digitalocean.com/v2/actions/456" }] } } };
  }
  return { status: 200, value: { action: { id: 456, type: "create", resource_type: "droplet", resource_id: 123, status: "completed" } } };
} : undefined;
serveProviderWorker({ ...(syntheticRequest ? { request: syntheticRequest } : {}), spawn() {
  state.consumes++; save();
  if (mode === "worker-late-debug") process.env.NODE_DEBUG = "https";
  if (mode === "worker-late-report") process.report.reportOnSignal = true;
  return { status: 0, stdout: Buffer.from("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL\n") };
}, connect(url, options, callback) {
  assert.equal(url.origin, "https://api.digitalocean.com");
  state.requests++; save();
  return httpsRequest(new URL(`https://127.0.0.1:${server.address().port}/v2/account`), options, callback);
} });
if (mode === "withhold-close") {
  const listeners = process.listeners("message");
  for (const listener of listeners) process.off("message", listener);
  process.on("message", (message) => {
    if (message?.schema === "cloud-provider-close/v1") return;
    for (const listener of listeners) listener(message);
  });
}
