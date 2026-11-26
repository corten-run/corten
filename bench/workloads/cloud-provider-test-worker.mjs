// Test-only entry dependency: synthetic consumption and owned loopback HTTPS.
// The production worker has no flag/env/IPC switch selecting this entry.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { serveProviderWorker } from "./cloud-provider-worker.mjs";

const [mode, output] = process.argv.slice(2);
if (process.env.NODE_OPTIONS === "--max-old-space-size=128") delete process.env.NODE_OPTIONS;
// This test-only file entry substitutes for the stdin snapshot entry.
process.stdin.resume();
assert.ok(basename(dirname(output)).startsWith("cloud-diagnostic-test-"));
const state = { consumes: 0, requests: 0, execArgv: process.execArgv,
  diagnosticNames: Object.keys(process.env).filter((name) => /^(?:NODE_OPTIONS|NODE_DEBUG|NODE_DEBUG_NATIVE|SSLKEYLOGFILE|LD_PRELOAD|NODE_EXTRA_CA_CERTS)$/.test(name)),
  reportOnSignal: process.report.reportOnSignal, calls: [] };
const save = () => writeFileSync(output, JSON.stringify(state)); save();
if (mode === "worker-new-debug") process.env.NODE_DEBUG = "https";
if (mode === "worker-new-report") process.report.reportOnSignal = true;
// Plain HTTP rejects the HTTPS handshake without a retryable connection reset.
// These controls count native client constructions, not account-read retries.
const server = createServer((_req, res) => { res.writeHead(400); res.end(); });
server.listen(0, "127.0.0.1"); await once(server, "listening");
let created, clock = 0;
const censusModes = ["shape", "total", "id", "duplicate", "links", "pages", "next", "last", "count", "bounds", "partial", "oversized", "ipc-bound"].map((predicate) => `list-${predicate}`);
const syntheticRequest = ["success", "scoped-create-link", "hang", "hang-create", "withhold-close", "reflect", "post-invalid-action-id",
  "post-link-shape", "post-link-count", "post-link-id", "post-link-rel", "post-link-href-variant", "post-link-href-type", "arbitrary-create-hints",
  "first-action-http-failure", "zero-resource-create", "first-action-invalid", "first-action-errored", "pending-create", "create-http-failure", "list-converges", "get-http-failure", ...censusModes].includes(mode) ? async ({ method, path, body, credential }) => {
  state.requests++; state.calls.push({ method, path, originalCredential: credential === "SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL" }); save();
  if (mode === "hang" || mode === "hang-create" && method === "POST") return new Promise(() => {});
  if (mode === "reflect") return { status: 200, value: { account: { uuid: credential } } };
  if (path === "/v2/account") return { status: 200, value: { account: { uuid: "synthetic-user-0001", droplet_limit: 20 } } };
  if (method === "GET" && /^\/v2\/droplets\/[1-9]\d*$/.test(path)) {
    if (mode === "get-http-failure") return { status: 503, value: { raw: credential } };
    return created && path === `/v2/droplets/${created.id}` ? { status: 200, value: { droplet: created } }
      : { status: 404, value: { raw: credential } };
  }
  if (path.startsWith("/v2/droplets?")) {
    if (mode === "list-ipc-bound") {
      // Valid JSON under the native HTTP cap. Its full projection grows when
      // 1e15 is serialized as a 16-digit ID; the last row is the only target.
      const cap = 16 * 1024 ** 2, head = '{"droplets":[', tail = '{"id":201,"tags":["saved-tag"]}],"meta":{"total":0}}';
      const row = `{"id":1e15,"name":"other","tags":["${"x".repeat(240)}"]},`;
      const count = Math.floor((cap - head.length - tail.length) / row.length);
      const raw = head + row.repeat(count) + tail;
      assert.ok(raw.length <= cap && raw.length + count * 12 > cap);
      return { status: 200, value: JSON.parse(raw) };
    }
    const value = { droplets: created ? [created] : [], meta: { total: created ? 1 : 0 }, links: {} };
    if (mode === "list-shape") value.droplets = { raw: credential };
    if (mode === "list-total") value.meta.total = credential;
    if (mode === "list-id") value.droplets = [{ id: credential }];
    if (mode === "list-duplicate") { value.droplets = [{ id: 1 }, { id: 1 }]; value.meta.total = 2; }
    if (mode === "list-links") value.links = credential;
    if (mode === "list-pages") value.links.pages = credential;
    if (mode === "list-next") value.links.pages = { next: `https://foreign.invalid/${credential}` };
    if (mode === "list-last") value.links.pages = { last: "https://api.digitalocean.com/v2/droplets?page=2&per_page=200" };
    if (mode === "list-partial") {
      value.droplets = [{ id: 123, name: "saved-name", tags: null }, { id: 124, name: null, tags: ["saved-tag", null] }];
      value.meta.total = 2;
    }
    if (mode === "list-oversized") {
      value.droplets = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: "other", tags: [] }));
      value.droplets.push({ id: 201, name: "saved-name", tags: [...Array(256).fill("other"), "saved-tag"] });
      value.meta.total = 201;
    }
    if (mode === "list-count") value.meta.total = 1;
    if (mode === "list-converges" && state.calls.filter((call) => call.path.startsWith("/v2/droplets?")).length <= 2) value.meta.total = 1;
    if (mode === "list-bounds") value.meta.total = 20001;
    return { status: 200, value };
  }
  if (method === "DELETE") { created = undefined; return { status: 204, value: null }; }
  if (method === "POST") {
    if (mode === "create-http-failure") return { status: 422, value: { raw: credential } };
    created = { id: 123, name: body.name, tags: body.tags, size_slug: body.size, region: { slug: body.region }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } };
    const response = { status: 202, value: { droplet: created, links: { actions: [{ id: 456, rel: "create", href: "https://api.digitalocean.com/v2/actions/456" }] } } };
    if (mode === "scoped-create-link") response.value.links.actions[0].href = "https://api.digitalocean.com/v2/droplets/123/actions/456";
    if (mode === "post-link-shape") response.value.links.actions = { raw: credential };
    if (mode === "post-link-count") response.value.links.actions = [];
    if (mode === "post-link-id" || mode === "post-invalid-action-id") response.value.links.actions[0].id = credential;
    if (mode === "post-link-rel") response.value.links.actions[0].rel = credential;
    if (mode === "post-link-href-variant") response.value.links.actions[0].href = "https://api.digitalocean.com:443/v2/actions/456";
    if (mode === "post-link-href-type") response.value.links.actions[0].href = { raw: credential };
    if (mode === "arbitrary-create-hints") {
      response.value.links.actions[0] = { id: 456, rel: [credential, { type: "delete" }],
        href: `https://${credential}@foreign.invalid/v2/actions/999#private` };
      response.value.droplet = { ...created, unused: { raw: credential } };
    }
    return response;
  }
  if (mode === "first-action-http-failure") return { status: 403, value: { raw: credential } };
  if (mode === "first-action-errored") {
    created = undefined; // The provider failed the create and holds no droplet.
    return { status: 200, value: { action: { id: 456, type: "create", resource_type: "droplet", resource_id: 123, status: "errored" } } };
  }
  if (mode === "first-action-invalid") return { status: 200, value: { action: { id: 456, type: credential, resource_type: "droplet", resource_id: 123, status: "completed" } } };
  if (mode === "pending-create") return { status: 200, value: { action: { id: 456, type: "create", resource_type: "droplet", resource_id: 0, status: "in-progress" } } };
  if (mode === "zero-resource-create" && state.calls.filter((call) => call.path === "/v2/actions/456").length === 1)
    return { status: 200, value: { action: { id: 456, type: "create", resource_type: "droplet", resource_id: 0, status: "in-progress" } } };
  return { status: 200, value: { action: { id: 456, type: "create", resource_type: "droplet", resource_id: 123, status: "completed" } } };
} : undefined;
serveProviderWorker({ ...(syntheticRequest ? { request: syntheticRequest } : {}),
  ...(["pending-create", "list-count", "list-converges"].includes(mode) ? { now: () => clock, sleep: async (ms) => { clock += ms; } } : {}), spawn() {
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
