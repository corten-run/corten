// Whether an app's upstream clients reuse a pooled connection past the upstream's keep-alive, seen
// from outside its image. Every benchmark upstream (bench/catalog/upstream.mjs,
// bench/marketplace/upstream.mjs and item-api/server.mjs) is Node's HTTP server: it answers
// `Keep-Alive: timeout=5` and closes a connection idle for those 5 s plus Node's 1 s buffer. A
// request a client writes to a connection as it closes is lost before the upstream's handler sees
// it. The upstream here makes that close certain: a request that arrives on a connection idle for
// the advertised 5 s or more meets a reset and no answer. An app passes when, after its upstream
// connections have sat idle that long, every read still answers 200 from exactly one upstream
// answer and none of its requests met the close. A library that retries a lost request still
// shows the close here, which is what the pool policy (an idle bound under 5 s) prevents.
// Usage: node bench/fullstack/idle-close.mjs <image> [catalog,marketplace,items] [NAME=value ...] [--json-only] [--label=key=value ...]
// A functional check, not a measurement; it starts one container, removed when it ends.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { allApps } from "./inventory.mjs";
import { records as catalogRecords } from "../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../marketplace/fixtures.mjs";

/** The keep-alive every benchmark upstream advertises (`Keep-Alive: timeout=5`). */
export const keepAliveMs = 5000;

/** The app reads checked, the upstream path each makes, and the body that path answers. */
export function reads(pages = true) {
  const items = JSON.parse(readFileSync(new URL("../../examples/card-market/fixtures/demo.json", import.meta.url), "utf8"));
  return {
    catalog: { path: pages ? "/catalog/record_1" : "/api/catalog/record_1", upstream: "/catalog/records/record_1", body: catalogRecords().record_1 },
    marketplace: { path: "/api/marketplace/item_1", upstream: "/marketplace/records/item_1", body: marketplaceRecords().item_1 },
    items: { path: pages ? "/items/item_1" : "/api/items/item_1", upstream: "/api/discovery/items/item_1", body: items.item_1 },
  };
}

/**
 * An upstream that answers `bodies` (path to JSON) over keep-alive connections and resets a
 * connection whose next request arrives `keepAlive` ms or more after its last answer. `events`
 * lists `{ at, connection, kind, path?, idle? }` with `at` in ms from the start.
 */
export function closingUpstream(bodies, keepAlive = keepAliveMs) {
  const started = performance.now(), events = [];
  const now = () => Math.round(performance.now() - started);
  let next = 0;
  const server = createServer((socket) => {
    const connection = next++;
    let buffer = Buffer.alloc(0), answered;
    events.push({ at: now(), connection, kind: "accepted" });
    socket.on("error", () => {});
    socket.on("close", () => events.push({ at: now(), connection, kind: "closed" }));
    socket.on("data", (data) => {
      if (answered !== undefined && performance.now() - answered >= keepAlive) {
        events.push({ at: now(), connection, kind: "closedIdle", idle: Math.round(performance.now() - answered) });
        socket.resetAndDestroy();
        return;
      }
      buffer = Buffer.concat([buffer, data]);
      for (let end; (end = buffer.indexOf("\r\n\r\n")) !== -1;) {
        const [method, path] = buffer.subarray(0, end).toString("latin1").split("\r\n")[0].split(" ");
        buffer = buffer.subarray(end + 4);
        const json = method === "GET" && bodies[path];
        const body = json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0);
        socket.write(`HTTP/1.1 ${json ? "200 OK" : "404 Not Found"}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n` +
          "connection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n");
        socket.write(body);
        answered = performance.now();
        events.push({ at: now(), connection, kind: "answered", path });
      }
    });
  });
  return { server, events, now, lastAnswer: () => Math.max(...events.filter((e) => e.kind === "answered").map((e) => e.at)) };
}

/** One GET on a new connection to the app: its status, or the error that ended it. */
export function get(url) {
  return new Promise((resolve) => {
    const req = request(url, { agent: false, timeout: 30000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
      res.on("error", (error) => resolve(error.code ?? error.message));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve(error.code ?? error.message));
    req.end();
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Runs `image` against a closing upstream and returns what each read saw after the idle: its
 * statuses, the upstream answers it took, the connections opened after the idle and the requests
 * that met the close.
 */
export async function checkImage(image, { names = ["catalog", "marketplace", "items"], env = [], labels = [], pages = true, concurrency = 6 } = {}) {
  const chosen = Object.fromEntries(Object.entries(reads(pages)).filter(([name]) => names.includes(name)));
  const upstream = closingUpstream(Object.fromEntries(Object.values(chosen).map((r) => [r.upstream, r.body])));
  await new Promise((done) => upstream.server.listen(0, "0.0.0.0", done));
  const port = upstream.server.address().port;
  const docker = (...args) => {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`docker ${args[0]}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const name = `idle-close-${process.pid}`;
  docker("run", "-d", "--rm", "--name", name, ...labels.flatMap((l) => ["--label", l]), "--cpus", "2", "--memory", "1g", "-p", "127.0.0.1::8080",
    ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
    "-e", `API_BASE=http://host.docker.internal:${port}`, "-e", "PORT=8080", "-e", "HOSTS=localhost,127.0.0.1",
    "-e", "CATALOG_SOURCE=api", "-e", "MARKETPLACE_SOURCE=api", "-e", "ITEM_SOURCE=api", ...env.flatMap((e) => ["-e", e]), image);
  try {
    const binding = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["8080/tcp"][0];
    const base = `http://127.0.0.1:${binding.HostPort}`;
    for (const [read, { path }] of Object.entries(chosen)) {
      const deadline = Date.now() + 180000;
      let status;
      while ((status = await get(base + path)) !== 200) {
        if (Date.now() > deadline) throw new Error(`${read}: ${path} did not answer 200 (last ${status})\n${docker("logs", name)}`);
        await sleep(250);
      }
    }
    // Open pooled connections in as many of the app's workers as a burst reaches.
    for (const { path } of Object.values(chosen)) await Promise.all(Array.from({ length: concurrency }, () => get(base + path)));
    await sleep(upstream.lastAnswer() + keepAliveMs + 250 - upstream.now());
    const after = upstream.now();
    const result = {};
    for (const [read, { path, upstream: target }] of Object.entries(chosen)) {
      const from = upstream.now();
      const statuses = await Promise.all(Array.from({ length: concurrency }, () => get(base + path)));
      const during = upstream.events.filter((e) => e.at >= from);
      result[read] = { statuses, answers: during.filter((e) => e.kind === "answered" && e.path === target).length };
    }
    const closedIdle = upstream.events.filter((e) => e.kind === "closedIdle" && e.at >= after);
    const opened = upstream.events.filter((e) => e.kind === "accepted" && e.at >= after).length;
    return { image, sentAfterIdleMs: after, concurrency, reads: result, opened, closedIdle };
  } finally {
    spawnSync("docker", ["rm", "-f", name]);
    upstream.server.close();
  }
}

/** The check: after the idle, every read answers 200 from one upstream answer each, and none met the close. */
export function assertPasses(result) {
  for (const [read, { statuses, answers }] of Object.entries(result.reads)) {
    assert.deepEqual(statuses, statuses.map(() => 200), `${read}: statuses after the idle`);
    assert.equal(answers, statuses.length, `${read}: one upstream answer per read`);
  }
  assert.deepEqual(result.closedIdle, [], "an upstream connection was reused past its keep-alive");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const labels = flags.filter((a) => a.startsWith("--label=")).map((a) => a.slice("--label=".length));
  const [image, list = "catalog,marketplace,items", ...env] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!image) throw new Error("usage: node bench/fullstack/idle-close.mjs <image> [catalog,marketplace,items] [NAME=value ...] [--json-only] [--label=key=value ...]");
  const app = Object.values(allApps).find((a) => a.image === image || image.startsWith(`${a.image}:`));
  const result = await checkImage(image, { names: list.split(","), env, labels, pages: !flags.includes("--json-only") && app?.pages !== false });
  console.log(JSON.stringify(result));
  assertPasses(result);
  console.log(`${image}: no upstream connection reused past ${keepAliveMs} ms idle`);
}