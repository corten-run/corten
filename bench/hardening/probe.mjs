// Native sockets only. This process never renders a target page or implements a defense.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateBudget } from "./plan.mjs";
import { observe } from "./native.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const localErrors = new Set(["EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);
export class Connections {
  sockets = new Set();
  errors = [];
  async close() {
    const sockets = [...this.sockets];
    const closed = sockets.map((socket) => new Promise((resolve) => socket.closed ? resolve() : socket.once("close", resolve)));
    sockets.forEach((s) => s.destroy());
    await Promise.all(closed);
    assert.equal(this.sockets.size, 0, "owned connection leak");
  }
  socket(target) {
    const socket = target.tls ? tlsConnect({ host: target.host, port: target.port, servername: "localhost", ca: target.caPem })
      : connect({ host: target.host, port: target.port });
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", (e) => { if (localErrors.has(e.code)) this.errors.push(e.code); });
    return socket;
  }
}

export function payload(phase, index, target, attack, form) {
  const get = `GET /marketplace/en-US/item_1 HTTP/1.1\r\nHost: ${target.authority}\r\n`;
  const bodyHead = (bytes) => `POST ${form.path} HTTP/1.1\r\nHost: ${target.authority}\r\nOrigin: ${target.origin}\r\nCookie: ${form.cookie}\r\nContent-Type: ${form.type}\r\nContent-Length: ${bytes}\r\n\r\n`;
  if (phase === "slow-headers") return { first: get + "X-Slow: ", drip: "x", repeat: true };
  if (phase === "slow-bodies") {
    // Exercise waiting for bytes, not an unrelated oversized-form rejection.
    const declaredBodyBytes = Math.min(4096, attack.bodyBytes);
    assert.ok(Buffer.byteLength(form.prefix) < declaredBodyBytes, "native form prefix exceeds slow-body budget");
    return { first: bodyHead(declaredBodyBytes) + form.prefix, declaredBodyBytes, drip: "x", repeat: true };
  }
  if (phase === "slow-readers") return { first: (get + "Connection: keep-alive\r\n\r\n").repeat(attack.pipelined), paused: true };
  if (phase === "idle-connections") return { first: "" };
  if (phase === "connection-pressure") return { first: get + "Connection: close\r\n\r\n" };
  assert.equal(phase, "oversized-requests");
  if (index % 3 === 0) return { first: get + Array.from({ length: attack.headerCount }, (_, i) => `X-${i}: x\r\n`).join("") + "\r\n", variant: "header-count" };
  if (index % 3 === 1) return { first: get + "X-Large: " + "x".repeat(attack.headerBytes) + "\r\n\r\n", variant: "header-size" };
  return { first: bodyHead(attack.bodyBytes) + form.prefix, body: attack.bodyBytes - Buffer.byteLength(form.prefix), variant: "body-size" };
}

export function tcpQueues(body, remotePort) {
  const result = new Map();
  const loopback = new Set(["0100007F", "00000000000000000000000001000000", "0000000000000000FFFF00000100007F"]);
  for (const line of body.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length <= 4) continue;
    const [localAddress, localPort] = f[1].split(":"), [remoteAddress, peerPort] = f[2].split(":");
    if (remotePort !== undefined && (parseInt(peerPort, 16) !== remotePort || !loopback.has(localAddress) || !loopback.has(remoteAddress))) continue;
    result.set(parseInt(localPort, 16), parseInt(f[4].split(":")[1], 16));
  }
  return result;
}
let queuesCache;
export function unread(port, remotePort) {
  const at = process.hrtime.bigint();
  // A burst of paused readers must not scan the whole TCP table once per socket.
  // Preserve the sample age rather than presenting cached observations as fresh.
  const absent = { kernelBytes: { status: "unavailable", reason: "connection absent from TCP sample" } };
  if (queuesCache && queuesCache.remotePort === remotePort && at - queuesCache.at < 50_000_000n) return { ...(queuesCache.values.get(port) ?? absent), sampleAgeMs: Number(at - queuesCache.at) / 1e6, scanMs: queuesCache.scanMs };
  try {
    const values = new Map();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) for (const [key, bytes] of tcpQueues(readFileSync(file, "utf8"), remotePort)) values.set(key, { kernelBytes: bytes });
    const scanMs = Number(process.hrtime.bigint() - at) / 1e6; queuesCache = { at, values, scanMs, remotePort };
    return { ...(values.get(port) ?? absent), sampleAgeMs: scanMs, scanMs };
  } catch { return { kernelBytes: { status: "unavailable", reason: "Linux /proc TCP receive queues unavailable" }, sampleAgeMs: 0, scanMs: 0 }; }
}

export async function inject({ phase, index, target, attack, form, pool, now, releaseAtMs, emit, releaseSignal, onConnected }) {
  const p = payload(phase, index, target, attack, form);
  const row = { type: "attack", index, phase, startedAtMs: now(), established: false, variant: p.variant ?? phase,
    firstBytes: Buffer.byteLength(p.first), firstSha256: sha(p.first), bytesQueued: 0, writes: 0, drips: 0, backpressure: 0,
    responsePrefix: "", targetClosedAtMs: null, releasedAtMs: null };
  if (p.declaredBodyBytes) row.declaredBodyBytes = p.declaredBodyBytes;
  const socket = pool.socket(target);
  let opened = false, timer, dripTimer;
  const close = new Promise((resolve) => socket.once("close", resolve));
  const wait = async (ms) => {
    let pending;
    try { await Promise.race([close, new Promise((resolve) => { pending = setTimeout(resolve, Math.max(0, ms)); }), ...(releaseSignal ? [releaseSignal] : [])]); }
    finally { clearTimeout(pending); }
  };
  const write = (bytes) => {
    if (socket.destroyed) return;
    row.bytesQueued += Buffer.byteLength(bytes); row.writes++;
    if (!socket.write(bytes)) row.backpressure++;
  };
  socket.on("error", (e) => { row.error ??= e.code ?? e.message; });
  socket.on("close", () => { if (row.releasedAtMs === null) row.targetClosedAtMs = now(); });
  if (!p.paused) socket.on("data", (c) => { if (row.responsePrefix.length < 512) row.responsePrefix += c.toString("latin1").slice(0, 512 - row.responsePrefix.length); });
  else socket.pause();
  try {
    await new Promise((resolve) => {
      socket.once(target.tls ? "secureConnect" : "connect", () => { opened = true; resolve(); });
      socket.once("close", resolve);
      timer = setTimeout(() => { row.connectTimedOut = true; socket.destroy(); }, Math.min(attack.connectTimeoutMs, Math.max(1, releaseAtMs - now())));
    });
    clearTimeout(timer);
    if (opened) {
      row.established = true; row.connectedAtMs = now(); row.localPort = socket.localPort;
      onConnected?.(row.localPort);
      write(p.first);
      if (p.body) {
        // Bound injector buffers: honor writable backpressure instead of queuing MiB per client.
        let remaining = p.body;
        while (remaining > 0 && !socket.destroyed && now() < releaseAtMs) {
          const chunk = "x".repeat(Math.min(16384, remaining)); write(chunk); remaining -= chunk.length;
          if (socket.writableNeedDrain) await new Promise((resolve) => {
            const finish = () => { socket.off("drain", finish); socket.off("close", finish); clearTimeout(timer); resolve(); };
            socket.once("drain", finish); socket.once("close", finish); timer = setTimeout(finish, Math.max(1, releaseAtMs - now()));
          });
        }
        row.bodyBytesQueued = p.body - remaining;
        row.declaredBodyBytes = attack.bodyBytes;
        row.bodyPrefixBytes = Buffer.byteLength(form.prefix);
      }
      if (p.repeat) dripTimer = setInterval(() => { if (!socket.destroyed) { write(p.drip); row.drips++; } }, attack.everyMs);
      const midpoint = now() + Math.max(0, releaseAtMs - now()) / 2;
      await wait(midpoint - now());
      const snapshotUnread = () => { const sample = unread(row.localPort, target.port); return { atMs: now(), ...sample, nodeBytes: socket.readableLength, paused: socket.isPaused() }; };
      if (p.paused && !socket.destroyed) row.unreadMidpoint = snapshotUnread();
      await wait(releaseAtMs - now());
      if (p.paused && !socket.destroyed) row.unreadEnd = snapshotUnread();
    }
  } finally {
    clearTimeout(timer); clearInterval(dripTimer);
    if (!socket.destroyed) { row.releasedAtMs = now(); socket.destroy(); }
    await close;
    row.endedAtMs = now(); emit(row);
  }
  return row;
}

export async function legitimate({ target, path, expected, timeoutMs, pool, now, emit, index, window, timers = globalThis }) {
  const row = { type: "legitimate", index, window, path, startedAtMs: now(), ok: false };
  await new Promise((resolve) => {
    const request = target.tls ? httpsRequest : httpRequest;
    const req = request({ host: target.host, port: target.port, path, method: "GET", agent: false,
      ca: target.caPem, headers: { host: target.authority, "accept-encoding": "identity", connection: "close" } }, (res) => {
      const chunks = []; let bytes = 0;
      res.on("data", (c) => { bytes += c.length; if (bytes > 2 ** 20) req.destroy(new Error("legitimate response exceeded recorder budget")); else chunks.push(c); });
      res.on("error", (e) => { row.error = e.code ?? e.message; });
      res.on("end", () => {
        const body = Buffer.concat(chunks); row.status = res.statusCode; row.bodyBytes = bytes; row.bodySha256 = sha(body);
        // Full numeric record, not merely an HTTP 200. Pages already pass the complete browser gate.
        if (path.startsWith("/api/")) {
          try { row.ok = res.statusCode === 200 && isDeepStrictEqual(JSON.parse(body), expected); } catch { row.ok = false; }
        } else row.ok = res.statusCode === 200 && body.includes("marketplace__listings") && body.includes(expected.title) && body.includes("marketplace__offers");
      });
    });
    const timer = timers.setTimeout(() => { row.timedOut = true; req.destroy(); }, timeoutMs);
    req.on("socket", (socket) => { pool.sockets.add(socket); socket.on("close", () => pool.sockets.delete(socket)); });
    req.on("error", (e) => { row.error = e.code ?? e.message; if (localErrors.has(e.code)) pool.errors.push(e.code); });
    req.once("close", () => { timers.clearTimeout(timer); resolve(); });
    req.end();
  });
  row.endedAtMs = now(); row.latencyMs = row.endedAtMs - row.startedAtMs; emit(row); return row;
}

export async function controls(phase, { receiveDelayMs = 0 } = {}) {
  assert.ok(Number.isFinite(receiveDelayMs) && receiveDelayMs >= 0 && receiveDelayMs <= 1000, "bounded control receiver delay required");
  const pool = new Connections(), peers = new Set(), observed = [], releases = new Map(), receiverTimers = new Set();
  const received = (observation) => {
    const control = releases.get(observation.sourcePort);
    if (control && observation.bytes >= control.bytes && (phase !== "slow-readers" || observation.responseBackpressure)) control.resolve();
  };
  const server = createServer((socket) => {
    peers.add(socket); socket.on("close", () => peers.delete(socket)); socket.on("error", () => {});
    if (receiveDelayMs) {
      socket.pause();
      const timer = setTimeout(() => { receiverTimers.delete(timer); socket.resume(); }, receiveDelayMs); receiverTimers.add(timer);
    }
    const observation = { bytes: 0, prefix: "", sourcePort: socket.remotePort, responseBackpressure: false }; observed.push(observation);
    received(observation);
    socket.on("data", (c) => {
      observation.bytes += c.length; observation.prefix = (observation.prefix + c.toString("latin1")).slice(0, 512);
      if (observation.prefix.startsWith("GET /api/control ") && !observation.responded) {
        observation.responded = true;
        const body = JSON.stringify({ id: "control", value: 37 });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      }
      if (phase === "slow-readers" && !observation.responded) {
        observation.responded = true;
        const chunk = Buffer.alloc(16384, 120); observation.responseBytes = 0;
        while (observation.responseBytes < 64 * 2 ** 20) {
          observation.responseBytes += chunk.length;
          if (!socket.write(chunk)) { observation.responseBackpressure = true; break; }
        }
      }
      received(observation);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = { host: "127.0.0.1", port: server.address().port, authority: "localhost", origin: "http://localhost" };
  const start = performance.now(), now = () => performance.now() - start;
  let result;
  try {
    const count = phase === "oversized-requests" ? 3 : 1;
    const attack = { connectTimeoutMs: 1000, everyMs: 40, pipelined: 32, headerCount: 200, headerBytes: 128 * 1024, bodyBytes: 4 * 2 ** 20 };
    const form = { path: "/form", cookie: "", type: "application/x-www-form-urlencoded", prefix: "email=a%40b.test&target_price=1&padding=" };
    // A control proves delivery, not workstation throughput in 350 ms. Its same
    // injector releases on actual receipt (two trickles, or the entire payload),
    // with a separate finite 5 s apparatus deadline. Native schedules are untouched.
    const rows = await Promise.all(Array.from({ length: count }, (_, index) => {
      const p = payload(phase, index, target, attack, form);
      let resolve; const releaseSignal = new Promise((r) => { resolve = r; });
      return inject({ phase, index, target, attack, form, pool, now, releaseAtMs: 5000, emit: () => {}, releaseSignal,
        onConnected: (port) => {
          releases.set(port, { bytes: Buffer.byteLength(p.first) + (p.body ?? 0) + (p.repeat ? 2 : 0), resolve });
          const observation = observed.find((o) => o.sourcePort === port); if (observation) received(observation);
        } });
    }));
    assert.equal(pool.errors.length, 0);
    const good = await legitimate({ target, path: "/api/control", expected: { id: "control", value: 37 }, timeoutMs: 1000, pool, now, emit: () => {}, index: 0, window: "control" });
    result = { phase, passed: true, observations: observed.filter((o) => !o.prefix.startsWith("GET /api/control ")), rows, legitimate: good };
    validateControl(result);
  } finally {
    for (const timer of receiverTimers) clearTimeout(timer);
    await pool.close(); for (const s of peers) s.destroy(); await new Promise((resolve) => server.close(resolve));
  }
  return result;
}

export function validateControl(result) {
    const { phase, rows, observations: observed, legitimate: good } = result;
    const count = phase === "oversized-requests" ? 3 : 1;
    assert.equal(result.passed, true); assert.equal(rows.length, count); assert.ok(rows.every((r) => r.established && !r.error));
    assert.deepEqual(rows.map((r) => r.index), Array.from({ length: count }, (_, i) => i));
    assert.ok(rows.every((r) => r.phase === phase)); assert.equal(new Set(rows.map((r) => r.localPort)).size, count);
    if (phase === "oversized-requests") assert.deepEqual(rows.map((r) => r.variant), ["header-count", "header-size", "body-size"]);
    assert.equal(observed.length, count);
    for (let i = 0; i < count; i++) {
      const r = rows[i], receipt = observed.find((o) => o.sourcePort === r.localPort); assert.ok(receipt);
      assert.equal(receipt.bytes, r.bytesQueued, "control receiver did not receive the emitted attack bytes");
      if (["slow-headers", "slow-bodies"].includes(phase)) {
        assert.ok(r.drips >= 2, "trickle timer did not run");
        if (phase === "slow-headers") assert.ok(!receipt.prefix.includes("\r\n\r\n"));
        else assert.ok(receipt.prefix.includes("Content-Length: 4096\r\n\r\n") && receipt.bytes < 4096);
      }
      if (phase === "slow-readers") assert.ok(receipt.responseBackpressure && r.unreadEnd?.paused, `paused-reader control failed: ${JSON.stringify({ receipt, row: r })}`);
      if (phase === "idle-connections") assert.equal(receipt.bytes, 0);
      if (phase === "connection-pressure") assert.ok(receipt.prefix.includes("Connection: close\r\n\r\n"));
      if (r.variant === "body-size") assert.equal(r.bodyBytesQueued + r.bodyPrefixBytes, 4 * 2 ** 20);
    }
    assert.equal(good.ok, true, "legitimate recorder control failed");
    assert.equal(good.bodySha256, sha('{"id":"control","value":37}')); assert.equal(good.status, 200);
}

export function cgroupDirectory(id, root = "/sys/fs/cgroup") {
  assert.match(id, /^[a-f0-9]{64}$/);
  const search = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === id || entry.name === `docker-${id}.scope`) return path;
      if (depth > 0) { const found = search(path, depth - 1); if (found) return found; }
    }
  };
  const path = search(root, 3); assert.ok(path, `missing native cgroup ${id}`); return path;
}
const counters = (body) => Object.fromEntries(body.trim().split("\n").map((line) => { const [k, v] = line.split(/\s+/); return [k, Number(v)]; }));
export function resource(path) {
  try {
    const cpu = readFileSync(join(path, "cpu.stat"), "utf8"), memory = readFileSync(join(path, "memory.current"), "utf8"), events = readFileSync(join(path, "memory.events"), "utf8");
    const procs = readFileSync(join(path, "cgroup.procs"), "utf8").trim().split("\n").filter(Boolean);
    assert.ok(Number.isFinite(counters(cpu).usage_usec) && Number.isFinite(Number(memory)));
    return { cpu, memory, events, procs, cpuSeconds: counters(cpu).usage_usec / 1e6, memoryBytes: Number(memory), running: procs.length > 0, oomKilled: counters(events).oom_kill > 0 };
  } catch (error) { return { unavailable: error.message }; }
}

// cgroup files may block on a busy virtualized host. Never read them on the
// socket scheduler's event loop during a measured window.
export async function resourceAsync(path) {
  const startedNs = process.hrtime.bigint();
  try {
    const [cpu, memory, events, tasks] = await Promise.all(["cpu.stat", "memory.current", "memory.events", "cgroup.procs"].map((file) => readFile(join(path, file), "utf8")));
    const procs = tasks.trim().split("\n").filter(Boolean);
    assert.ok(Number.isFinite(counters(cpu).usage_usec) && Number.isFinite(Number(memory)));
    return { cpu, memory, events, procs, cpuSeconds: counters(cpu).usage_usec / 1e6, memoryBytes: Number(memory), running: procs.length > 0,
      oomKilled: counters(events).oom_kill > 0, startedNs: String(startedNs), endedNs: String(process.hrtime.bigint()) };
  } catch (error) { return { unavailable: error.message, startedNs: String(startedNs), endedNs: String(process.hrtime.bigint()) }; }
}

export async function runProbe(config, emit, sample) {
  const { budget: b, phase, target, form, expected } = config; validateBudget(b);
  const controlBefore = await controls(phase); emit({ type: "control-before", ...controlBefore });
  if (config.source === "api") {
    const response = await observe(config.upstream + "/__marketplace/control", { method: "POST", body: "{}" });
    emit({ type: "upstream-control-before", response });
    assert.ok(response.complete && response.status === 200 && !response.error && response.body === "{}", "API upstream reset failed before timed injection");
  }
  const pool = new Connections(), delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const start = process.hrtime.bigint(), now = () => Number(process.hrtime.bigint() - start) / 1e6;
  emit({ type: "clock", wallAtStart: new Date().toISOString(), monotonicNs: String(start), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() });
  const tasks = [], attacks = [], good = [], failures = [];
  const at = async (ms, work) => { while (now() < ms) await sleep(ms - now()); return work(); };
  try {
    const boundaries = new Map();
    for (const [window, w] of Object.entries(b.legitimate)) for (const boundary of ["startMs", "endMs"]) {
      const sameTime = boundaries.get(w[boundary]) ?? []; sameTime.push({ window, boundary }); boundaries.set(w[boundary], sameTime);
    }
    // One clock sample for a shared boundary prevents timer wakeup order from
    // creating fictitious overlap between adjacent observation windows.
    for (const [ms, events] of boundaries) tasks.push(at(ms, () => { const atMs = now(); for (const event of events) emit({ type: "window", ...event, atMs }); }));
    for (const [window, w] of Object.entries(b.legitimate)) {
      for (const [index, ms] of w.scheduledAtMs.entries()) tasks.push(at(ms, async () => {
        const paths = ["/marketplace/en-US/item_1", "/marketplace/fr-FR/item_1", "/marketplace/de-DE/item_1", "/api/marketplace/item_1"];
        good.push(await legitimate({ target, path: paths[index % paths.length], expected, timeoutMs: b.recovery.requestTimeoutMs, pool, now, emit, index, window }));
      }));
      tasks.push(at((w.startMs + w.endMs) / 2, async () => {
        const atMs = now(), samples = await sample(); emit({ type: "resources", window, atMs, collectedAtMs: now(), samples });
      }));
    }
    for (const [index, ms] of b.attack.scheduledAtMs.entries()) tasks.push(at(ms, async () => {
      attacks.push(await inject({ phase, index, target, attack: b.attack, form, pool, now, releaseAtMs: b.attack.releaseAtMs, emit }));
    }));
    // allSettled also reaps siblings if one fails. No rejected task can strand an injector.
    const settled = await Promise.allSettled(tasks);
    failures.push(...settled.filter((r) => r.status === "rejected").map((r) => r.reason.message));
    await sleep(b.legitimate.after.endMs - now());
  } finally { delay.disable(); await pool.close(); }
  emit({ type: "probe-cleanup", atMs: now(), connections: pool.sockets.size, tasks: 0, errors: pool.errors, failures, eventLoopMaxMs: delay.max / 1e6 });
  if (config.source === "api") emit({ type: "upstream-control-after", response: await observe(config.upstream + "/__marketplace/control") });
  const controlAfter = await controls(phase); emit({ type: "control-after", ...controlAfter });
  assert.deepEqual(failures, [], "injector task failure"); assert.deepEqual(pool.errors, [], "local injector resource failure");
  assert.equal(attacks.length, b.attack.scheduledAtMs.length); assert.equal(good.length, Object.values(b.legitimate).reduce((n, w) => n + w.scheduledAtMs.length, 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [configFile, output] = process.argv.slice(2), config = JSON.parse(readFileSync(configFile, "utf8"));
  const paths = Object.fromEntries(config.processes.map((p) => [p.id, cgroupDirectory(p.containerId)]));
  const journal = []; let bytes = 0;
  try {
    await runProbe(config, (row) => {
      const line = JSON.stringify(row) + "\n"; bytes += Buffer.byteLength(line); assert.ok(bytes <= 64 * 2 ** 20, "raw recorder memory budget exhausted"); journal.push(line);
    }, async () => Object.fromEntries(await Promise.all(config.processes.map(async (p) => [p.id, await resourceAsync(paths[p.id])]))));
  } finally { writeFileSync(output, journal.join("")); }
}
