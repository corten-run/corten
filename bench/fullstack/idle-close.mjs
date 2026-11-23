// Whether an app's upstream clients reuse a pooled connection past the bound the benchmark apps
// keep, seen from outside its image. Every benchmark upstream (bench/catalog/upstream.mjs,
// bench/marketplace/upstream.mjs and item-api/server.mjs) is Node's HTTP server: it answers
// `Keep-Alive: timeout=5` and closes a connection idle for those 5 s plus Node's 1 s buffer. A
// request a client writes to a connection as it closes can be lost before the upstream's handler
// sees it. The apps therefore do not reuse a connection idle for 4 s (`boundMs`; Spring's 1 s is
// under it).
//
// The check, per read: the app answers 200 (readiness); two bursts of concurrent reads, each read
// one upstream answer, of which at least one comes on a connection that had already answered, so
// the pool is shown to be in use before the idle (`--no-reuse` for a client that opens a connection
// per request); then nothing for `boundMs + marginMs` (4.5 s) after the last answer, which is
// 500 ms past the bound and 500 ms before the upstream here closes (1.5 s before Node's own close);
// then a burst again. It passes when every read after the idle is a 200 from exactly one upstream
// answer and no request arrived on a connection idle for the bound or longer. So a client whose
// expiry slipped just past the bound (anything from 4.5 s) fails, as well as one that reuses a
// connection the upstream closes: here a request on a connection idle the advertised 5 s or more
// meets a reset and no answer. A library that retries a lost request still shows the reuse.
//
// Docker is used the way bench/marketplace/alert-probe-run.mjs uses it: every command has a
// deadline; the container carries this run's owner label and is registered only by the immutable
// ID its create returned; every inspect, log read and removal goes through that ID after
// confirming the label, never through its name. A create that returned no ID is looked for at
// teardown by its own attempt label for a bounded window, and its cleanup is reported unconfirmed
// if nothing appears. A failed or unconfirmed removal fails the run.
// Usage: node bench/fullstack/idle-close.mjs <image> [catalog,marketplace,items] [NAME=value ...] [--json-only] [--no-reuse] [--bound-ms=N] [--label=key=value ...]
// A functional check, not a measurement.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { allApps } from "./inventory.mjs";
import { records as catalogRecords } from "../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../marketplace/fixtures.mjs";

/** The keep-alive every benchmark upstream advertises (`Keep-Alive: timeout=5`); the upstream here closes at it. */
export const keepAliveMs = 5000;
/** The idle time past which the apps' clients do not reuse a connection. */
export const boundMs = 4000;
/** How far past the bound the idle wait goes; the wait must still end before `keepAliveMs`. */
export const marginMs = 500;
export const ownerKey = "run.corten.fullstack.idle-close";
// The create's own label, so a create whose acknowledgement never came back can be found as itself.
export const attemptKey = `${ownerKey}.create`;
const commandTimeout = 30_000;
// How long teardown looks for what an unacknowledged create made before calling its cleanup unconfirmed.
export const reconcileWindow = 10_000;

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
 * The run's options, checked before anything is opened or any Docker command is sent: a nonempty
 * list of known reads without repeats, caller labels outside this run's own label namespace, and a
 * bound whose idle wait ends before the upstream's close.
 */
export function checkOptions({ names, labels = [], bound = boundMs, concurrency = 6 }) {
  const known = Object.keys(reads());
  assert.ok(Array.isArray(names) && names.length > 0, `no reads selected; choose from ${known.join(",")}`);
  for (const name of names) assert.ok(known.includes(name), `unknown read ${JSON.stringify(name)}; choose from ${known.join(",")}`);
  assert.equal(new Set(names).size, names.length, `a read is selected twice: ${names.join(",")}`);
  for (const label of labels) {
    const key = /^([\w.-]+)=[\w.:/-]*$/.exec(label)?.[1];
    assert.ok(key, `labels are key=value, not ${JSON.stringify(label)}`);
    assert.ok(key !== ownerKey && !key.startsWith(`${ownerKey}.`), `label ${key} is reserved for the check's ownership labels`);
  }
  assert.ok(Number.isInteger(bound) && bound > 0 && bound + marginMs < keepAliveMs,
    `the bound (${bound} ms) plus the ${marginMs} ms margin must end before the upstream's ${keepAliveMs} ms close`);
  assert.ok(Number.isInteger(concurrency) && concurrency > 1, "concurrency is an integer above 1");
}

/**
 * An upstream that answers `bodies` (path to JSON) over keep-alive connections and resets a
 * connection whose next request arrives `keepAlive` ms or more after its last answer. `events`
 * lists `{ at, connection, kind, path?, idle?, lastPath? }` with `at` in ms from the start; an `answered` event's
 * `idle` is how long its connection had been idle when the request arrived (null on a connection's
 * first request), and a `closedIdle` event's `lastPath` is the path its connection last answered. The
 * event is recorded before the answer is written. `close()` ends every
 * connection and the listener.
 */
export function closingUpstream(bodies, keepAlive = keepAliveMs) {
  const started = performance.now(), events = [], sockets = new Set();
  const now = () => Math.round(performance.now() - started);
  let next = 0;
  const server = createServer((socket) => {
    const connection = next++;
    let buffer = Buffer.alloc(0), answered, lastPath;
    sockets.add(socket);
    events.push({ at: now(), connection, kind: "accepted" });
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); events.push({ at: now(), connection, kind: "closed" }); });
    socket.on("data", (data) => {
      const idle = answered === undefined ? null : Math.round(performance.now() - answered);
      if (idle !== null && performance.now() - answered >= keepAlive) {
        events.push({ at: now(), connection, kind: "closedIdle", idle, lastPath });
        socket.resetAndDestroy();
        return;
      }
      buffer = Buffer.concat([buffer, data]);
      for (let end; (end = buffer.indexOf("\r\n\r\n")) !== -1;) {
        const [method, path] = buffer.subarray(0, end).toString("latin1").split("\r\n")[0].split(" ");
        buffer = buffer.subarray(end + 4);
        const json = method === "GET" && bodies[path];
        const body = json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0);
        events.push({ at: now(), connection, kind: "answered", path, idle: answered === undefined ? null : Math.round(performance.now() - answered) });
        socket.write(`HTTP/1.1 ${json ? "200 OK" : "404 Not Found"}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n` +
          "connection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n");
        socket.write(body);
        answered = performance.now();
        lastPath = path;
      }
    });
  });
  const close = () => new Promise((done) => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close(() => done()); else done();
  });
  return { server, events, now, close, lastAnswer: () => Math.max(...events.filter((e) => e.kind === "answered").map((e) => e.at)) };
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
const brief = (error) => String(error?.message ?? error).slice(0, 2048);

/**
 * One Docker command with a deadline, run without blocking the upstream this process serves. A
 * client that could not be started (`sent: false`) never reached the daemon; any other failure
 * may have.
 */
export function docker(args, { timeout = commandTimeout, combined = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 2 ** 20 }, (error, stdout, stderr) => {
      const what = `docker ${args.slice(0, 2).join(" ")}`;
      if (error?.code === "ENOENT") return reject(Object.assign(new Error(`${what}: docker not found`), { sent: false }));
      if (error?.killed) return reject(new Error(`${what}: timeout after ${timeout} ms`));
      if (error) return reject(new Error(`${what}: exit ${error.code}\n${(stderr || stdout).slice(-4096)}`));
      resolve(combined ? stdout + stderr : stdout.trim());
    });
  });
}

/**
 * The one container of a run, as bench/marketplace/alert-probe-run.mjs owns its resources: known only
 * by the ID its create returned, confirmed to carry this run's owner label before every inspect, log
 * read and removal. `teardown()` removes it, and anything else carrying the owner label, by
 * confirmed ID; reconciles a create that returned no ID by its attempt label within `window` ms;
 * and records every failure. It never throws.
 */
export function ownedContainer({ docker: run = docker, runId, labels = [], window = reconcileWindow, wait = sleep }) {
  const owner = `${ownerKey}=${runId}`, attempt = `${attemptKey}=${runId}`;
  const record = { runId, ownerLabel: owner, created: null, unacknowledged: null, removed: [], recovered: [], failures: [], complete: false };
  let id = null;
  const fail = (resource, error) => record.failures.push({ resource, error: brief(error) });
  const list = async (filter) => (await run(["ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"])).split("\n").map((l) => l.trim()).filter(Boolean);
  const confirm = async (target) => {
    const [info] = JSON.parse(await run(["container", "inspect", target]));
    assert.equal(info?.Id, target, `container ${target}: inspect returned a different object`);
    assert.equal(info.Config?.Labels?.[ownerKey], runId, `refusing unowned container ${target}`);
    return info;
  };
  const current = () => { assert.ok(id, "no container was created"); return id; };
  return {
    record,
    async create(args, name) {
      let out;
      try { out = await run(["create", "--pull", "never", "--name", name, "--label", owner, "--label", attempt, ...labels.flatMap((l) => ["--label", l]), ...args]); }
      catch (error) {
        if (error.sent !== false) record.unacknowledged = { name, label: attempt, error: brief(error) };
        throw error;
      }
      if (!/^[0-9a-f]{64}$/.test(out)) {
        record.unacknowledged = { name, label: attempt, error: `returned no ID: ${JSON.stringify(out.slice(0, 200))}` };
        throw new Error(`docker create ${name} returned no ID`);
      }
      id = out; record.created = { id, name };
      return id;
    },
    inspect: () => confirm(current()),
    async start() { const target = current(); await confirm(target); assert.equal(await run(["start", target]), target, `docker start did not confirm ${target}`); },
    async logs() { const target = current(); await confirm(target); return run(["logs", target], { combined: true }); },
    async teardown() {
      const targets = new Set(id ? [id] : []);
      if (record.unacknowledged) {
        // The create may still be under way in the daemon: look for it by its own label.
        const end = Date.now() + window;
        try {
          for (;;) {
            const found = await list(`label=${attempt}`);
            if (found.length) { record.unacknowledged.ids = found; found.forEach((f) => targets.add(f)); break; }
            if (Date.now() >= end) break;
            await wait(Math.min(250, Math.max(0, end - Date.now())));
          }
        } catch (error) { fail(`containers labelled ${attempt}`, error); }
      }
      try { for (const found of await list(`label=${owner}`)) targets.add(found); }
      catch (error) { fail(`containers labelled ${owner}`, error); }
      for (const target of targets) {
        try {
          if ((await list(`id=${target}`)).includes(target)) {
            await confirm(target);
            assert.equal(await run(["rm", "-f", "-v", target]), target, `docker rm did not confirm ${target}`);
          }
          (target === id ? record.removed : record.recovered).push(target);
        } catch (error) { fail(`container ${target}`, error); }
      }
      if (record.unacknowledged) {
        const gone = new Set([...record.removed, ...record.recovered]), ids = record.unacknowledged.ids;
        record.unacknowledged.outcome = !ids ? "unconfirmed" : ids.every((found) => gone.has(found)) ? "removed" : "not removed";
        if (!ids) fail(`container ${record.unacknowledged.name} (${attempt})`, `its create was not acknowledged and nothing with that label was found in ${window} ms; Docker may still make it, so its cleanup is unconfirmed`);
      }
      record.complete = record.failures.length === 0;
      return record;
    },
  };
}

/**
 * Runs `image` against a closing upstream and returns what each read saw before and after the
 * idle, with the container's cleanup record. Rejects, after closing the upstream and tearing down
 * the container, if a step fails or the teardown is incomplete; the error carries `cleanup`.
 */
export async function checkImage(image, { names = ["catalog", "marketplace", "items"], env = [], labels = [], pages = true, concurrency = 6, bound = boundMs,
  docker: run = docker, runId = `idle-close-${randomBytes(5).toString("hex")}`, window = reconcileWindow, readyTimeout = 180_000 } = {}) {
  checkOptions({ names, labels, bound, concurrency });
  const all = reads(pages), chosen = Object.fromEntries(names.map((name) => [name, all[name]]));
  const upstream = closingUpstream(Object.fromEntries(Object.values(chosen).map((r) => [r.upstream, r.body])));
  const owned = ownedContainer({ docker: run, runId, labels, window });
  let result, failure;
  try {
    await new Promise((done, fail) => { upstream.server.once("error", fail); upstream.server.listen(0, "0.0.0.0", done); });
    const port = upstream.server.address().port;
    await owned.create(["--cpus", "2", "--memory", "1g", "-p", "127.0.0.1::8080",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "-e", `API_BASE=http://host.docker.internal:${port}`, "-e", "PORT=8080", "-e", "HOSTS=localhost,127.0.0.1",
      "-e", "CATALOG_SOURCE=api", "-e", "MARKETPLACE_SOURCE=api", "-e", "ITEM_SOURCE=api", ...env.flatMap((e) => ["-e", e]), image], runId);
    await owned.start();
    const binding = (await owned.inspect()).NetworkSettings.Ports["8080/tcp"][0];
    const base = `http://127.0.0.1:${binding.HostPort}`;
    for (const [read, { path }] of Object.entries(chosen)) {
      const deadline = Date.now() + readyTimeout;
      let status;
      while ((status = await get(base + path)) !== 200) {
        if (Date.now() > deadline) {
          let logs;
          try { logs = await owned.logs(); } catch (error) { logs = `app log unavailable: ${brief(error)}`; }
          throw new Error(`${read}: ${path} did not answer 200 (last ${status})\n${logs.slice(-16384)}`);
        }
        await sleep(250);
      }
    }
    const answers = (from, target) => upstream.events.filter((e) => e.kind === "answered" && e.at >= from && e.path === target);
    const burst = async (path) => Promise.all(Array.from({ length: concurrency }, () => get(base + path)));
    // Two bursts per read, to show the pool reuses connections before the idle.
    const warm = {};
    for (const [read, { path, upstream: target }] of Object.entries(chosen)) {
      const from = upstream.now(), statuses = [...await burst(path)];
      await sleep(100);
      statuses.push(...await burst(path));
      const seen = answers(from, target);
      warm[read] = { statuses, answers: seen.length, reused: seen.filter((e) => e.idle !== null).length };
    }
    const idleFrom = upstream.lastAnswer();
    await sleep(Math.max(0, idleFrom + bound + marginMs - upstream.now()));
    const after = upstream.now();
    const checked = {};
    for (const [read, { path, upstream: target }] of Object.entries(chosen)) {
      const from = upstream.now(), statuses = await burst(path), seen = answers(from, target);
      checked[read] = { warm: warm[read], after: { statuses, answers: seen.length, connections: seen.map(({ connection, idle }) => ({ connection, idle })) } };
    }
    const closedIdle = upstream.events.filter((e) => e.kind === "closedIdle" && e.at >= after);
    const reusedPastBound = upstream.events.filter((e) => e.kind === "answered" && e.at >= after && e.idle !== null && e.idle >= bound);
    result = { image, boundMs: bound, marginMs, keepAliveMs, idleMs: after - idleFrom, concurrency, reads: checked, closedIdle, reusedPastBound };
  } catch (error) {
    failure = error;
  } finally {
    await upstream.close();
  }
  const cleanup = await owned.teardown();
  if (failure) throw Object.assign(failure, { cleanup });
  if (!cleanup.complete) throw Object.assign(new Error(`teardown failed: ${JSON.stringify(cleanup.failures)}`), { cleanup, result });
  return { ...result, cleanup };
}

/**
 * The check. Before the idle, every read answers 200 from one upstream answer each and, unless
 * `reuse` is false, some on a connection that had answered already. After it, the same, with none
 * on a connection idle for the bound or longer and none meeting the upstream's close.
 */
export function assertPasses(result, { reuse = true } = {}) {
  assert.ok(Object.keys(result.reads).length > 0, "no reads were checked");
  assert.ok(result.idleMs >= result.boundMs + result.marginMs, `the idle (${result.idleMs} ms) ended before the bound and its margin`);
  for (const [read, { warm, after }] of Object.entries(result.reads)) {
    assert.deepEqual(warm.statuses, warm.statuses.map(() => 200), `${read}: statuses before the idle`);
    assert.equal(warm.answers, warm.statuses.length, `${read}: one upstream answer per read before the idle`);
    if (reuse) assert.ok(warm.reused > 0, `${read}: no upstream connection was reused before the idle, so the idle tests no pool (--no-reuse for a client without one)`);
    assert.deepEqual(after.statuses, after.statuses.map(() => 200), `${read}: statuses after the idle`);
    assert.equal(after.answers, after.statuses.length, `${read}: one upstream answer per read after the idle`);
  }
  assert.deepEqual(result.reusedPastBound, [], `an upstream connection idle ${result.boundMs} ms or more was reused`);
  assert.deepEqual(result.closedIdle, [], "an upstream connection was reused past its keep-alive");
}

/** The command line's options, checked before anything runs. */
export function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith("--")), rest = argv.filter((a) => !a.startsWith("--"));
  const usage = "usage: node bench/fullstack/idle-close.mjs <image> [catalog,marketplace,items] [NAME=value ...] [--json-only] [--no-reuse] [--bound-ms=N] [--label=key=value ...]";
  for (const flag of flags) assert.ok(["--json-only", "--no-reuse"].includes(flag) || /^--(label|bound-ms)=/.test(flag), `unknown option ${flag}\n${usage}`);
  const labels = flags.filter((a) => a.startsWith("--label=")).map((a) => a.slice("--label=".length));
  const bounds = flags.filter((a) => a.startsWith("--bound-ms=")).map((a) => a.slice("--bound-ms=".length));
  assert.ok(bounds.length <= 1 && bounds.every((b) => /^[1-9]\d*$/.test(b)), `--bound-ms takes one positive integer\n${usage}`);
  const [image, list = "catalog,marketplace,items", ...env] = rest;
  assert.ok(image, usage);
  for (const e of env) assert.match(e, /^[A-Z_][A-Z0-9_]*=/, `environment entries are NAME=value, not ${e}\n${usage}`);
  const options = { image, names: list.split(","), env, labels, bound: bounds.length ? Number(bounds[0]) : boundMs, jsonOnly: flags.includes("--json-only"), reuse: !flags.includes("--no-reuse") };
  checkOptions(options);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { image, names, env, labels, bound, jsonOnly, reuse } = parseArgs(process.argv.slice(2));
  const app = Object.values(allApps).find((a) => a.image === image || image.startsWith(`${a.image}:`));
  let result;
  try {
    result = await checkImage(image, { names, env, labels, bound, pages: !jsonOnly && app?.pages !== false });
  } catch (error) {
    if (error.cleanup) console.error(JSON.stringify({ cleanup: error.cleanup }));
    throw error;
  }
  console.log(JSON.stringify(result));
  assertPasses(result, { reuse });
  console.log(`${image}: no upstream connection reused after ${result.idleMs} ms idle (bound ${bound} ms, upstream close ${keepAliveMs} ms)`);
}
