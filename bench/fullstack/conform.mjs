// Conformance: what each app does around the page and the JSON with its defaults, observed rather
// than claimed (bench/fullstack/README.md, "Feature matrix"). parity.mjs, look.mjs and check-app.mjs check that
// the apps send the same output; this checks the work around it, so a table never compares an app
// that sends security headers, checks the host and keeps a deadline with one that does none of it.
// For each app it starts the app twice, from its cb-* image:
// 1. On the fixture (items in memory): the headers on a page, on the JSON and on a JSON 404, the
//    error formats of a 404 and a 405, HEAD, an unknown Host, compression when asked, an ETag and
//    a conditional GET, the price-alert form posted from another site and with a 3 MiB body, a
//    64 KiB request header, and the health endpoints.
// 2. On an item API that accepts connections and never answers (fsw-stall): how long a page (or,
//    for an app without pages, the JSON) takes to answer and with what, which is its deadline,
//    and what /health/ready says while the items cannot be read.
// Every probe is a plain HTTP/1.1 request (node:http, no decompression), each on its own
// connection. It replaces the fsw-<app> containers it starts and removes them, and fsw-stall, when
// it ends.
// Usage: node conform.mjs [apps=all] [out=<round>]
// Writes results/<out>/conformance.json when given out, and prints the matrix.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apps as all, network, runArgs } from "./apps.mjs";
import { features, rowOf } from "./conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [appsArg, out] = process.argv.slice(2);
const names = appsArg && appsArg !== "all" ? appsArg.split(",") : Object.keys(all);
for (const n of names) if (!all[n]) throw new Error("unknown app " + n);
const docker = (/** @type {string[]} */ ...args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request on a fresh connection. Resolves with the status, headers and body, or with
 * { timedOut } after timeoutMs, or { error } when the connection failed.
 * @param {number} port
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} r
 * @returns {Promise<{ status?: number, headers?: import("node:http").IncomingHttpHeaders, body?: Buffer, ms: number, timedOut?: boolean, error?: string }>}
 */
const probe = (port, { method = "GET", path, headers = {}, body, timeoutMs = 10_000 }) =>
  new Promise((resolve) => {
    const started = Date.now();
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "localhost:" + port, connection: "close", ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
      res.on("error", (e) => resolve({ error: e.message, ms: Date.now() - started }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ timedOut: true, ms: Date.now() - started }); });
    req.on("error", (e) => resolve({ error: e.message, ms: Date.now() - started }));
    // A server may answer and close before reading a body it refuses; that is its answer, not an error.
    req.on("error", () => {});
    req.end(body);
  });

/** Waits until the app answers anything at all on a path that needs no items, up to two minutes. */
const up = async (/** @type {number} */ port) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const r = await probe(port, { path: "/conform-missing-page", timeoutMs: 2000 });
    if (r.status) return true;
    await sleep(250);
  }
  return false;
};

const start = (/** @type {string} */ name, /** @type {"fixture" | "stall"} */ mode) => {
  docker("rm", "-f", "fsw-" + name);
  const args = runArgs(name, all[name], mode === "fixture" ? "fixture" : "api", join(here, "fixtures"));
  // For the stall run the item API is fsw-stall (API_BASE is runArgs' first -e).
  if (mode === "stall") args.splice(args.indexOf("-e") + 1, 1, "API_BASE=http://fsw-stall:8080");
  const run = docker(...args);
  if (run.status !== 0) throw new Error(name + ": " + run.stderr);
};

docker("network", "create", network);
docker("rm", "-f", "fsw-stall");
// Accepts every connection and never writes a byte: an item API that hangs.
const stall = docker("run", "-d", "--name", "fsw-stall", "--network", network, "node:24-alpine", "node", "-e", "require('net').createServer(() => {}).listen(8080)");
if (stall.status !== 0) throw new Error("fsw-stall: " + stall.stderr);
const started = new Set(["stall"]);
process.on("exit", () => { for (const n of started) docker("rm", "-f", "fsw-" + n); });
process.on("SIGINT", () => process.exit(130));

/** @type {Record<string, Record<string, unknown>>} */
const results = {};
for (const name of names) {
  const app = all[name];
  const pages = app.pages !== false;
  const port = app.port;
  started.add(name);
  start(name, "fixture");
  if (!(await up(port))) { results[name] = { error: "did not answer in 120 s" }; console.error(name + ": did not answer"); continue; }
  // Let a JIT or a lazy first route settle, so no probe reads a cold start as behavior.
  for (const path of [pages ? "/items/item_5" : null, "/api/items/item_5"].filter(Boolean)) for (let i = 0; i < 3; i++) await probe(port, { path: /** @type {string} */ (path), timeoutMs: 30_000 });
  const page = pages ? await probe(port, { path: "/items/item_5" }) : null;
  const pageBr = pages ? await probe(port, { path: "/items/item_5", headers: { "accept-encoding": "br, gzip" } }) : null;
  // Corten tags only a compressed page (the bytes a 304 saves), so the tag is read from that answer.
  const etag = pageBr?.headers?.etag ?? page?.headers?.etag;
  const pageAgain = pages && etag ? await probe(port, { path: "/items/item_5", headers: { "accept-encoding": "br, gzip", "if-none-match": String(etag) } }) : null;
  const json = await probe(port, { path: "/api/items/item_5" });
  const jsonBr = await probe(port, { path: "/api/items/item_5", headers: { "accept-encoding": "br, gzip" } });
  const jsonGzip = await probe(port, { path: "/api/items/item_5", headers: { "accept-encoding": "gzip" } });
  const head = await probe(port, { method: "HEAD", path: "/api/items/item_5" });
  const json404 = await probe(port, { path: "/api/items/does-not-exist" });
  const json405 = await probe(port, { method: "DELETE", path: "/api/items/item_5" });
  const page404 = pages ? await probe(port, { path: "/items/does-not-exist" }) : null;
  const badHost = await probe(port, { path: "/api/items/item_5", headers: { host: "attacker.example" } });
  const bigHead = await probe(port, { path: "/api/items/item_5", headers: { "x-padding": "x".repeat(64 * 1024) } });
  // The price-alert form, as a browser on another site would send it, and as one on this site would with a 3 MiB body.
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const crossSite = pages ? await probe(port, { method: "POST", path: "/items/item_5", headers: { ...form, origin: "https://attacker.example", "sec-fetch-site": "cross-site" }, body: "title=a&email=a%40example.com&target_price=1" }) : null;
  const bigBody = pages ? await probe(port, { method: "POST", path: "/items/item_5", headers: { ...form, origin: "http://localhost:" + port, "sec-fetch-site": "same-origin" }, body: "title=" + "a".repeat(3 * 1024 * 1024) + "&email=a%40example.com&target_price=1", timeoutMs: 30_000 }) : null;
  const live = await probe(port, { path: "/health/live" });
  const ready = await probe(port, { path: "/health/ready" });
  docker("rm", "-f", "fsw-" + name);
  start(name, "stall");
  const stalledUp = await up(port);
  const slow = stalledUp ? await probe(port, { path: pages ? "/items/item_5" : "/api/items/item_5", timeoutMs: 45_000 }) : { error: "did not start" , ms: 0 };
  const readyDown = stalledUp ? await probe(port, { path: "/health/ready", timeoutMs: 45_000 }) : { error: "did not start", ms: 0 };
  docker("rm", "-f", "fsw-" + name);
  started.delete(name);
  results[name] = rowOf({ pages, page, pageBr, pageAgain, crossSite, bigBody, json, jsonBr, jsonGzip, head, json404, json405, page404, badHost, bigHead, live, ready, slow, readyDown });
  console.error(name + " done");
}

const header = ["app", ...features.map((f) => f.label)];
const lines = ["| " + header.join(" | ") + " |", "|" + header.map(() => "---").join("|") + "|"];
for (const [name, row] of Object.entries(results)) lines.push("| " + [name, ...features.map((f) => String(row[f.key] ?? row.error ?? "?"))].join(" | ") + " |");
console.log(lines.join("\n"));
if (out) {
  mkdirSync(join(here, "results", out), { recursive: true });
  writeFileSync(join(here, "results", out, "conformance.json"), JSON.stringify({ results }, null, 2) + "\n");
}
