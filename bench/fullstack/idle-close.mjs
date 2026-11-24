// Whether an app's upstream clients reuse a pooled connection past the bound the benchmark apps
// keep, seen from outside its image. Every benchmark upstream (bench/catalog/upstream.mjs,
// bench/marketplace/upstream.mjs and item-api/server.mjs) is Node's HTTP server: it answers
// `Keep-Alive: timeout=5` and closes a connection idle for those 5 s plus Node's 1 s buffer. A
// request a client writes to a connection as it closes can be lost before the upstream's handler
// sees it. The apps therefore do not reuse a connection idle for 4 s (`boundMs`; Spring's 1 s is
// under it).
//
// The check: the app answers 200 on every read (readiness); then, one read at a time, two bursts of
// concurrent reads, each read one upstream answer, of which at least one comes on a connection that
// had already answered, so the pool is shown to be in use before the idle (`--no-reuse` for a client
// that opens a connection per request); then nothing until every connection that answered that read
// during its warm-up (its warmed set) and is still open has been idle `boundMs + marginMs` (4.5 s),
// 500 ms past the bound; then a burst again (the probe), before the
// next read starts its own warm bursts and idle. Each read idles after its own warm bursts, so a
// slow read never delays another's probe. The wait rechecks the monotonic clock after every wake,
// so a timer that fires early only means another wait.
// A probe is judged by the upstream's own evidence, at each probe request's arrival, not by when
// the app replies: a request arrives when the read that completed its head came in, before the
// upstream prepares its answer. It counts only if, when every one of its requests arrived, every warmed
// connection had been idle at least 4.5 s and less than `keepAliveMs - slackMs` (4.75 s), 250 ms
// before the upstream here closes (1.25 s before Node's own close). So the pool chose its
// connections inside the window whatever the app does after the upstream answers. A probe with any
// request outside it (a late timer, an app that holds a request before sending it upstream) is
// inconclusive and fails the check: a pool that expires at 4.8 s would pass a probe made at 5.2 s.
// One exception: a warmed connection the upstream saw close before the probe's first request,
// while it was idle under 4.75 s, cannot be reused and was not held past the window, so it is
// counted (`closedInTime`) rather than timed; a client that opens a connection per request closes
// every one this way. A close counts from the warm-up's start, so a connection closed during the
// warm-up itself is counted too, never taken as open; the warm-up's requests are not idle traffic. A connection closed at 4.75 s idle or later is timed like an open one.
// The wait first runs until the oldest warmed connection is idle 4.5 s (by then the upstream has
// seen the close of any connection the app ended with its request), then on until the newest one
// still open is too, which needs the open ones' warm answers to span less than the window's 250 ms;
// a wider warm-up is inconclusive and not probed, since no single moment would put them all inside it.
// Nothing may reach the upstream between the end of the warm-up and the probe's dispatch: every
// request in that interval is recorded, and any one (on a warmed connection or another) makes the
// read inconclusive, since it refreshes the connection it arrives on and the idle was not one.
// It passes when every probe is inside its window, every read after the idle is a 200 from exactly
// one upstream answer and no request, during the idle or the probe, arrived on a connection idle for
// the bound or longer. So a client that still reuses a connection idle 4.5 s fails, as well as one
// that reuses a connection
// the upstream closes: here a request on a connection idle the advertised 5 s or more meets a reset
// and no answer. A library that retries a lost request still shows the reuse. What it verifies is
// that the pool had dropped its idle connections when probed, 4.5 to 4.75 s after their last
// answer, or had closed them under 4.75 s idle before it, under the upstream's 5 s close: a pool
// that expires anywhere between 4 s and the probe
// also passes, so each app's configured 4 s is read from its source, not measured here. Each
// burst's answers are the upstream events recorded after the burst began (by position in the event
// list, not by timestamp), so a readiness answer is never counted.
// The judging (`warmedSet`, `planProbe`, `judgeRead`) is pure over the recorded events and the
// monotonic times in them, so its window, expiry and spread rules are tested on fixed sequences.
//
// Docker is used the way bench/marketplace/alert-probe-run.mjs uses it: every command has a
// deadline; the container carries this run's owner label and is registered only by the immutable
// ID its create returned; every inspect, log read and removal goes through that ID after
// confirming the label, never through its name. A create that returned no ID is looked for at
// teardown by its own attempt label for a bounded window (on the monotonic clock; each lookup gets
// only the time left in it, and none starts once it is spent), and its cleanup is reported
// unconfirmed if nothing appears. The owner-label sweep runs after that search whatever it found.
// Every ID a lookup returns must be a full 64-hex container ID before it is inspected or removed.
// A container counts as gone only when the lookup by its ID comes back empty, or with exactly that
// ID and a removal that confirms it; any other output leaves it unconfirmed. A failed or
// unconfirmed removal fails the run.
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
/** How far past the bound the idle wait goes. */
export const marginMs = 500;
/** How long before the upstream's close every probe request must have reached the upstream. */
export const slackMs = 250;
/** The window a probe must fall in, as every warmed connection's idle when each probe request arrives: from `fromMs`, ending before `belowMs`. */
export const probeWindow = (bound = boundMs) => ({ fromMs: bound + marginMs, belowMs: keepAliveMs - slackMs });
/**
 * Whether `probe` fails to prove the window. `fromMs` and `toMs` are the smallest and largest idle
 * of any timed warmed connection at any probe request's arrival, unrounded; both are null when
 * none was timed, which proves it only when every warmed connection closed in time
 * (`closedInTime`) and some request reached the upstream (`arrivals`). A `skipped` probe was not made.
 */
export function inconclusive(probe, { fromMs, belowMs }) {
  if (probe.skipped || probe.interrupted || probe.arrivals === 0) return true;
  if (probe.fromMs === null || probe.toMs === null) return !(probe.closedInTime > 0);
  return !(probe.fromMs >= fromMs && probe.toMs < belowMs);
}
const ms = (n) => (n === null ? "none" : n.toFixed(1));
const tenth = (n) => Math.round(n * 10) / 10;
const span = (set) => ({ oldest: Math.min(...set.map((c) => c.last)), newest: Math.max(...set.map((c) => c.last)) });
// When each connection closed, as the upstream saw it, from `events`.
const closes = (events) => new Map(events.filter((e) => e.kind === "closed").map((e) => [e.connection, e.time]));
// A warmed connection seen closed by `t`, while it was idle under `belowMs`: it cannot be reused and
// was not held past the window, so it is counted rather than timed.
const closedInTime = ({ connection, last }, closed, t, { belowMs }) => {
  const at = closed.get(connection);
  return at !== undefined && at <= t && at - last < belowMs;
};
// Requests the upstream received: answered, or refused on a connection idle past its keep-alive.
const requests = (events) => events.filter((e) => e.kind === "answered" || e.kind === "closedIdle");

/**
 * The warmed set: each connection that answered `target` in `warmEvents`, with `last`, the time its
 * latest answer in the warm-up was written.
 */
export function warmedSet(warmEvents, target) {
  const warmed = new Set(warmEvents.filter((e) => e.kind === "answered" && e.path === target).map((e) => e.connection)), last = new Map();
  for (const e of warmEvents) if (e.kind === "answered" && warmed.has(e.connection)) last.set(e.connection, Math.max(last.get(e.connection) ?? -Infinity, e.answeredAt));
  return [...last].map(([connection, at]) => ({ connection, last: at }));
}

/** When to stop the first wait: the oldest warmed connection idle `fromMs`, or null with no warmed set. */
export const firstWait = (conns, limits) => (conns.length ? span(conns).oldest + limits.fromMs : null);

/**
 * Whether and when to probe, at `now`, after the first wait, from the read's events since its
 * warm-up began (`sinceWarmStart`), so a connection closed during the warm-up is not taken as open.
 * The connections still open must all be inside the window at one moment, so their warm answers
 * must span less than it; the probe goes once the newest is idle `fromMs`. Returns
 * `{ open, spread, at }`, or `{ open, spread, skipped }` with the reason no probe is made.
 */
export function planProbe(conns, sinceWarmStart, now, limits) {
  if (!conns.length) return { open: 0, spread: 0, skipped: "no upstream answer in the warm-up" };
  const closed = closes(sinceWarmStart), open = conns.filter((c) => !closedInTime(c, closed, now, limits));
  const timing = span(open.length ? open : conns), spread = open.length ? timing.newest - timing.oldest : 0;
  if (spread >= limits.belowMs - limits.fromMs) return { open: open.length, spread, skipped: `the warm answers span ${ms(spread)} ms, not less than the window's ${limits.belowMs - limits.fromMs} ms` };
  return { open: open.length, spread, at: timing.newest + limits.fromMs };
}

/**
 * One read's verdict from its recorded events: `warmEvents` (the warm bursts), `idleEvents` (from
 * the warm-up's end to the probe's dispatch, or to the skip) and `probeEvents` (from the dispatch).
 * Each probe request is judged at its arrival against every warmed connection not closed in time
 * by the first arrival, counting closes from the warm-up's start; any request during the idle (not
 * the warm-up's own) makes the probe inconclusive (`interrupted`).
 * Returns `{ warm, after, closedIdle, reusedPastBound }`, the last two from the idle and the probe.
 */
export function judgeRead({ target, warmStatuses, warmEvents, plan, idleEvents = [], statuses = [], probeEvents = [], sentMs = null, limits, bound }) {
  const answers = (events) => events.filter((e) => e.kind === "answered" && e.path === target);
  const warmed = answers(warmEvents), conns = warmedSet(warmEvents, target), later = [...idleEvents, ...probeEvents];
  const warm = { statuses: warmStatuses, answers: warmed.length, reused: warmed.filter((e) => e.idle !== null).length,
    connections: conns.length, open: plan.open, spreadMs: tenth(plan.spread) };
  const intervening = requests(idleEvents), warmedIds = new Set(conns.map((c) => c.connection));
  const interrupted = intervening.length ? { requests: intervening.length, onWarmed: intervening.filter((e) => warmedIds.has(e.connection)).length } : undefined;
  let after;
  if (plan.skipped) {
    after = { statuses: [], answers: 0, connections: [], probe: { fromMs: null, toMs: null, arrivals: 0, skipped: plan.skipped, ...(interrupted && { interrupted }) } };
  } else {
    const seen = answers(probeEvents), arrivals = seen.map((e) => e.arrival), first = Math.min(...arrivals), closed = closes([...warmEvents, ...later]);
    const timed = arrivals.length ? conns.filter((c) => !closedInTime(c, closed, first, limits)) : conns;
    const judged = timed.length && arrivals.length ? span(timed) : null;
    const probe = { fromMs: judged && first - judged.newest, toMs: judged && Math.max(...arrivals) - judged.oldest,
      arrivals: arrivals.length, closedInTime: conns.length - timed.length, sentMs, ...(interrupted && { interrupted }) };
    after = { statuses, answers: seen.length, connections: seen.map(({ connection, idle }) => ({ connection, idle })), probe };
  }
  after.inconclusive = inconclusive(after.probe, limits);
  return { warm, after, closedIdle: later.filter((e) => e.kind === "closedIdle"),
    reusedPastBound: later.filter((e) => e.kind === "answered" && e.idle !== null && e.idle >= bound) };
}
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
 * bound that leaves the probe a window before the upstream's close.
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
  assert.ok(Number.isInteger(bound) && bound > 0 && probeWindow(bound).fromMs < probeWindow(bound).belowMs,
    `the bound (${bound} ms) plus the ${marginMs} ms margin must end before the upstream's ${keepAliveMs} ms close less ${slackMs} ms`);
  assert.ok(Number.isInteger(concurrency) && concurrency > 1, "concurrency is an integer above 1");
}

/**
 * An upstream that answers `bodies` (path to JSON) over keep-alive connections and resets a
 * connection whose next request arrives `keepAlive` ms or more after its last answer. `events`
 * lists `{ at, connection, kind, time?, path?, idle?, arrival?, answeredAt?, lastPath? }` in the order they happened, with `at`
 * from `stamp` (ms from the start by default; a report only, never used to select events); an
 * `accepted` or `closed` event's `time` is the unrounded `performance.now()` at which it happened;
 * an `answered` event's `arrival` is the `performance.now()` at which the read that completed its
 * request head came in, taken before the answer is prepared, its `idle` how long its connection had
 * been idle then (null on a connection's first request) and its `answeredAt` the `performance.now()`
 * once its answer was written; a `closedIdle` event's `lastPath` is the path its connection last
 * answered. The event is recorded before the answer is prepared. `lastAnswerOf(connection)` is the
 * `performance.now()` of that connection's latest answer (kept after the connection closes), and
 * `closedAt(connection)` of its close as the upstream saw it, or null while it is open.
 * `close()` ends every connection and the listener.
 */
export function closingUpstream(bodies, keepAlive = keepAliveMs, { stamp } = {}) {
  const started = performance.now(), events = [], sockets = new Set();
  const now = stamp ?? (() => Math.round(performance.now() - started));
  const lastByConnection = new Map(), closedByConnection = new Map();
  let next = 0;
  const server = createServer((socket) => {
    const connection = next++;
    let buffer = Buffer.alloc(0), answered, lastPath;
    sockets.add(socket);
    events.push({ at: now(), connection, kind: "accepted", time: performance.now() });
    socket.on("error", () => {});
    socket.on("close", () => {
      const time = performance.now();
      closedByConnection.set(connection, time); sockets.delete(socket); events.push({ at: now(), connection, kind: "closed", time });
    });
    socket.on("data", (data) => {
      // Every request whose head this read completes arrived now, whatever its answer then costs.
      const arrival = performance.now(), idle = answered === undefined ? null : Math.round(arrival - answered);
      if (idle !== null && arrival - answered >= keepAlive) {
        events.push({ at: now(), connection, kind: "closedIdle", idle, arrival, lastPath });
        socket.resetAndDestroy();
        return;
      }
      buffer = Buffer.concat([buffer, data]);
      for (let end; (end = buffer.indexOf("\r\n\r\n")) !== -1;) {
        const [method, path] = buffer.subarray(0, end).toString("latin1").split("\r\n")[0].split(" ");
        buffer = buffer.subarray(end + 4);
        // A request pipelined behind an answer written after this read arrived waited no idle.
        const event = { at: now(), connection, kind: "answered", path, idle: answered === undefined ? null : Math.max(0, Math.round(arrival - answered)), arrival };
        events.push(event);
        const json = method === "GET" && bodies[path];
        const body = json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0);
        socket.write(`HTTP/1.1 ${json ? "200 OK" : "404 Not Found"}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n` +
          "connection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n");
        socket.write(body);
        answered = event.answeredAt = performance.now();
        lastByConnection.set(connection, answered);
        lastPath = path;
      }
    });
  });
  const close = () => new Promise((done) => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close(() => done()); else done();
  });
  return { server, events, now, close, lastAnswerOf: (connection) => lastByConnection.get(connection) ?? null,
    closedAt: (connection) => closedByConnection.get(connection) ?? null };
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
 * Waits until `now()` reaches `target`, rechecking after every wake, so a timer that fires early
 * (or a fractional delay Node truncates) only means another wait. Returns how many waits it took.
 */
export async function waitUntil(target, { now = () => performance.now(), wait = sleep } = {}) {
  let waits = 0;
  for (let left; (left = target - now()) > 0; waits++) await wait(Math.ceil(left));
  return waits;
}
const canonical = /^[0-9a-f]{64}$/;
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
 * and records every failure. It never throws. `removed` (the created container) and `recovered`
 * (any other) list IDs confirmed gone: removed here by confirmed ID, or absent from a clean lookup
 * by that ID. A lookup by ID that returns anything but nothing or exactly that ID is a failure and
 * leaves the container in neither list.
 */
export function ownedContainer({ docker: run = docker, runId, labels = [], window = reconcileWindow, wait = sleep, now = () => performance.now() }) {
  const owner = `${ownerKey}=${runId}`, attempt = `${attemptKey}=${runId}`;
  const record = { runId, ownerLabel: owner, created: null, unacknowledged: null, removed: [], recovered: [], failures: [], complete: false };
  let id = null;
  const fail = (resource, error) => record.failures.push({ resource, error: brief(error) });
  // Only full container IDs come back; anything else is a failure and is never inspected or removed.
  const list = async (filter, timeout) => {
    const lines = (await run(["ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"], timeout === undefined ? {} : { timeout }))
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const odd = lines.filter((l) => !canonical.test(l));
    if (odd.length) fail(`containers matching ${filter}`, `docker ps returned ${JSON.stringify(odd[0].slice(0, 200))}, not a full container ID; it is not inspected or removed`);
    return lines.filter((l) => canonical.test(l));
  };
  // Whether `target` still exists, from a lookup by its own ID.
  const present = async (target) => {
    const lines = (await run(["ps", "-a", "--no-trunc", "--filter", `id=${target}`, "--format", "{{.ID}}"]))
      .split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    assert.ok(lines.length === 1 && lines[0] === target,
      `docker ps --filter id=${target} returned ${JSON.stringify(lines.join(" ").slice(0, 200))}, not that full ID; its removal is unconfirmed`);
    return true;
  };
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
      if (!canonical.test(out)) {
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
        // The create may still be under way in the daemon: look for it by its own label until the
        // window ends. Each lookup is cut to the time left, and none starts once it is spent. A
        // failed lookup ends the search and is kept; the owner sweep below does not depend on it.
        const end = now() + window;
        try {
          for (;;) {
            const left = Math.floor(end - now());
            if (left < 1) break;
            const found = await list(`label=${attempt}`, left);
            if (found.length) { record.unacknowledged.ids = found; found.forEach((f) => targets.add(f)); break; }
            const pause = Math.min(250, end - now());
            if (pause <= 0) break;
            await wait(pause);
          }
        } catch (error) { fail(`containers labelled ${attempt}`, error); }
      }
      try { for (const found of await list(`label=${owner}`)) targets.add(found); }
      catch (error) { fail(`containers labelled ${owner}`, error); }
      for (const target of targets) {
        try {
          if (await present(target)) {
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
 * `stamp` replaces the clock of the upstream's event timestamps, which are reported but never
 * used to decide which events belong to a burst (a test holds it still to show that). `idleWait`
 * replaces the timer of the idle wait (a test makes it fire early or late). `onUpstream` is called
 * with the upstream once it exists, so a test can follow that one listener rather than the process's.
 */
export async function checkImage(image, { names = ["catalog", "marketplace", "items"], env = [], labels = [], pages = true, concurrency = 6, bound = boundMs,
  docker: run = docker, runId = `idle-close-${randomBytes(5).toString("hex")}`, window = reconcileWindow, readyTimeout = 180_000, stamp, idleWait = sleep, onUpstream } = {}) {
  checkOptions({ names, labels, bound, concurrency });
  const all = reads(pages), chosen = Object.fromEntries(names.map((name) => [name, all[name]]));
  const upstream = closingUpstream(Object.fromEntries(Object.values(chosen).map((r) => [r.upstream, r.body])), keepAliveMs, { stamp });
  onUpstream?.(upstream);
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
    // Marks are indexes into the upstream's event list, taken before a burst or at a boundary.
    const { events } = upstream;
    const burst = async (path) => Promise.all(Array.from({ length: concurrency }, () => get(base + path)));
    const limits = probeWindow(bound), checked = {}, closedIdle = [], reusedPastBound = [];
    // One read at a time, each with its own idle, so no read's probe waits on another's.
    for (const [read, { path, upstream: target }] of Object.entries(chosen)) {
      // Two bursts, to show the pool reuses connections before the idle.
      const warmMark = events.length, warmStatuses = [...await burst(path)];
      await sleep(100);
      warmStatuses.push(...await burst(path));
      // From here every upstream event is recorded against the idle until the probe's dispatch.
      const warmEnd = events.length, warmEvents = events.slice(warmMark, warmEnd), conns = warmedSet(warmEvents, target);
      // Wait until the oldest warmed connection is idle `fromMs`; by then the upstream has seen the
      // close of any the app ended with its request, so the open ones are known.
      if (conns.length) await waitUntil(firstWait(conns, limits), { wait: idleWait });
      // Closes during the warm-up count: a connection the app ended then is not open.
      const plan = planProbe(conns, events.slice(warmMark), performance.now(), limits);
      let dispatch = events.length, statuses = [], sentMs = null;
      if (!plan.skipped) {
        // On until the newest open warmed connection is idle `fromMs` too, which the spread leaves
        // before the oldest reaches `belowMs`.
        await waitUntil(plan.at, { wait: idleWait });
        dispatch = events.length;
        sentMs = tenth(performance.now() - (plan.at - limits.fromMs));
        statuses = await burst(path);
      }
      // Judged where the pool's choice shows, at the upstream: each probe request's arrival against
      // every timed warmed connection's last answer. When the app replies does not matter.
      const { warm, after, ...seen } = judgeRead({ target, warmStatuses, warmEvents, plan, idleEvents: events.slice(warmEnd, dispatch),
        statuses, probeEvents: plan.skipped ? [] : events.slice(dispatch), sentMs, limits, bound });
      closedIdle.push(...seen.closedIdle);
      reusedPastBound.push(...seen.reusedPastBound);
      checked[read] = { warm, after };
    }
    result = { image, boundMs: bound, marginMs, keepAliveMs, slackMs, window: limits, concurrency, reads: checked, closedIdle, reusedPastBound };
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
 * The check. Every probe fell inside its window after an idle nothing interrupted; one outside it,
 * not made, or after a request during the idle, is inconclusive and
 * fails. Before the idle, every read answers 200 from one upstream answer each and, unless `reuse`
 * is false, some on a connection that had answered already. After it, the same, with none on a
 * connection idle for the bound or longer and none meeting the upstream's close.
 */
export function assertPasses(result, { reuse = true } = {}) {
  assert.ok(Object.keys(result.reads).length > 0, "no reads were checked");
  assert.deepEqual(result.window, probeWindow(result.boundMs), "the probe window is not the bound's");
  const { fromMs, belowMs } = result.window;
  for (const [read, { after: { probe } }] of Object.entries(result.reads)) {
    assert.ok(!inconclusive(probe, result.window), probe.interrupted ? `${read}: inconclusive: ${probe.interrupted.requests} upstream request(s) arrived ` +
      `between the warm-up and the probe (${probe.interrupted.onWarmed} on warmed connections), so the warmed connections were not idle` :
      probe.skipped ? `${read}: inconclusive: not probed: ${probe.skipped}` :
      `${read}: inconclusive: probe requests reached the upstream with the warmed connections idle ${ms(probe.fromMs)} to ${ms(probe.toMs)} ms, outside ${fromMs} to below ${belowMs} ms`);
  }
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

/**
 * The command line's line for a passing result: the idle range over the probes that timed a
 * warmed connection only, and how many warmed connections closed in time instead.
 */
export function summary(result, image) {
  const probes = Object.values(result.reads).map(({ after: { probe } }) => probe);
  const timed = probes.filter((p) => p.fromMs !== null && p.toMs !== null), closed = probes.reduce((n, p) => n + (p.closedInTime ?? 0), 0);
  const counted = `${closed} warmed connection${closed === 1 ? "" : "s"} closed in time before the probe`;
  const seen = timed.length
    ? `when probed with the timed warmed connections idle ${ms(Math.min(...timed.map((p) => p.fromMs)))} to ${ms(Math.max(...timed.map((p) => p.toMs)))} ms` +
      (closed ? ` (${counted}, not timed)` : "")
    : `when probed: ${counted}, so no connection needed timing`;
  return `${image}: no upstream connection reused ${seen} (window ${result.window.fromMs} to below ${result.window.belowMs} ms, ` +
    `bound ${result.boundMs} ms, upstream close ${result.keepAliveMs} ms)`;
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
  console.log(summary(result, image));
}
