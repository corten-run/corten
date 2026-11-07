// One hardening phase, for harden.mjs, run inside fsw-probe as conform-probe.mjs is: the abuse
// the phase names, sent from many connections at once, and beside it a well-behaved client that
// asks for the item as JSON on a new connection every 100 ms. Reads { host, port, phase, ...the
// phase's numbers } as JSON on stdin and writes JSON on stdout:
//   { phase, opened, closedBy: [ms from its own connect to its close, for each abusive connection
//     the server closed], answers: { [status or "none"]: count }, heldMs,
//     good: { sent, ok, failed, p50, p99, max }, after, statuses?, reset? }
// where opened is how many abusive connections connected, answers what the server sent each one
// before it closed (the first status line it wrote, or none), heldMs how long the hold lasted, good
// the well-behaved client's requests (timed from before its connect; ok: answered 200 within 5 s
// of that; failed: anything else), after the status of one request on a new connection once the
// abuse was closed (null: no answer within 5 s), statuses the oversized phase's answers and reset
// how the server ended the 16 MiB body's connection when it reset it (ECONNRESET or EPIPE), or null. Phases:
//   headFlood: `count` connections each send a request head without its blank line, then nothing.
//   slowHead: `count` connections each send a valid head one byte every `everyMs`.
//   slowBody: `count` POSTs to `formPath` declare a 1 MiB body and send it a byte every `everyMs`.
//   slowReader: `count` connections each send `pipelined` GETs of `pagePath` at once and never read
//     (an empty line a second shows when the server has closed one).
//   idleFlood: `count` connections are opened and send nothing.
//   oversized: three requests on their own connections, a head of 200 headers, a 1 MiB header and a
//     16 MiB body to `formPath`; each one's status, or "closed" when the server closed without one.
// Every phase but oversized holds its connections for `holdMs` (or until the server has closed all
// of them), then closes the rest.
import { connect } from "node:net";
import { parseAnswer } from "./conformance.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
/** @type {{ host: string, port: number, phase: string, count?: number, holdMs?: number, everyMs?: number, pipelined?: number, pagePath?: string, formPath?: string, jsonPath?: string }} */
const r = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));
const jsonPath = r.jsonPath ?? "/api/items/item_5";
const started = Date.now();

/**
 * A connection, once connected (null when it could not within `ms`): when it connected and was
 * closed (ms since the probe started), what it read first, and whether the server reset it.
 */
const open = (ms = 5000) => /** @type {Promise<{ socket: import("node:net").Socket, openedAt: number, closed: () => number | null, reset: () => string | null, got: Buffer[] } | null>} */ (new Promise((done) => {
  const socket = connect({ host: r.host, port: r.port });
  /** @type {number | null} */
  let closedAt = null;
  /** @type {string | null} */
  let reset = null;
  /** @type {Buffer[]} */
  const got = [];
  const limit = setTimeout(() => { socket.destroy(); done(null); }, ms);
  socket.on("data", (c) => { if (got.length < 4) got.push(c); });
  // A reset is seen as ECONNRESET on a read, or EPIPE on a write into the reset connection.
  socket.on("error", (e) => { const code = /** @type {NodeJS.ErrnoException} */ (e).code; if (code === "ECONNRESET" || code === "EPIPE") reset ??= code; });
  socket.on("close", () => { closedAt ??= Date.now() - started; });
  socket.once("connect", () => { clearTimeout(limit); done({ socket, openedAt: Date.now() - started, closed: () => closedAt, reset: () => reset, got }); });
  socket.once("error", () => { clearTimeout(limit); done(null); });
}));

/** One request on a new connection: its status within `ms` of starting to connect, or null. */
const ask = async (/** @type {string} */ raw, ms = 5000) => {
  const at = Date.now();
  const c = await open(ms);
  if (!c) return { status: null, ms: null };
  c.socket.write(raw);
  const end = at + ms;
  while (Date.now() < end && c.closed() === null && parseAnswer(Buffer.concat(c.got)) === null) await sleep(5);
  const status = parseAnswer(Buffer.concat(c.got))?.status ?? null;
  c.socket.destroy();
  return { status: status ?? (c.closed() !== null ? "closed" : null), ms: Date.now() - at };
};
const get = (/** @type {string} */ path) => `GET ${path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n`;

/** The well-behaved client: a request every 100 ms on a new connection until stopped. */
const goodClient = () => {
  /** @type {number[]} */
  const times = [];
  let sent = 0;
  let failed = 0;
  let running = true;
  /** @type {Promise<void>[]} */
  const inFlight = [];
  const loop = (async () => {
    while (running) {
      sent++;
      inFlight.push(ask(get(jsonPath)).then((a) => { if (a.status === 200 && a.ms !== null) times.push(a.ms); else failed++; }));
      await sleep(100);
    }
  })();
  return async () => {
    running = false;
    await loop;
    await Promise.all(inFlight);
    const s = [...times].sort((a, b) => a - b);
    const at = (/** @type {number} */ p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null);
    return { sent, ok: s.length, failed, p50: at(0.5), p99: at(0.99), max: s.length ? s[s.length - 1] : null };
  };
};

/** Opens `count` connections, `batch` at a time, so the burst is many but not one SYN storm. */
const openMany = async (/** @type {number} */ count, batch = 250) => {
  /** @type {NonNullable<Awaited<ReturnType<typeof open>>>[]} */
  const all = [];
  for (let i = 0; i < count; i += batch) {
    const got = await Promise.all(Array.from({ length: Math.min(batch, count - i) }, open));
    for (const c of got) if (c) all.push(c);
  }
  return all;
};

/** Holds `conns` until holdMs has passed or the server closed all of them, then closes the rest. */
const holdAll = async (/** @type {NonNullable<Awaited<ReturnType<typeof open>>>[]} */ conns, /** @type {(() => void) | undefined} */ tick, /** @type {number} */ everyMs) => {
  const from = Date.now();
  const end = from + (r.holdMs ?? 60_000);
  let next = Date.now();
  while (Date.now() < end && conns.some((c) => c.closed() === null)) {
    if (tick && Date.now() >= next) { tick(); next = Date.now() + everyMs; }
    await sleep(Math.min(250, everyMs));
  }
  const heldMs = Date.now() - from;
  const closedBy = conns.flatMap((c) => { const t = c.closed(); return t === null ? [] : [t - c.openedAt]; }).sort((a, b) => a - b);
  /** @type {Record<string, number>} */
  const answers = {};
  for (const c of conns) {
    const key = String(parseAnswer(Buffer.concat(c.got))?.status ?? "none");
    answers[key] = (answers[key] ?? 0) + 1;
  }
  for (const c of conns) c.socket.destroy();
  return { heldMs, closedBy, answers };
};

const count = r.count ?? 0;
const everyMs = r.everyMs ?? 1000;
/** @type {Record<string, unknown>} */
let out;
if (r.phase === "oversized") {
  const many = `GET ${jsonPath} HTTP/1.1\r\nhost: localhost\r\n${Array.from({ length: 200 }, (_, i) => `x-h${i}: v\r\n`).join("")}connection: close\r\n\r\n`;
  const huge = `GET ${jsonPath} HTTP/1.1\r\nhost: localhost\r\nx-padding: ${"x".repeat(1024 * 1024)}\r\nconnection: close\r\n\r\n`;
  const body = 16 * 1024 * 1024;
  /** @type {string | null} */
  let hugeBodyReset = null;
  const post = `POST ${r.formPath ?? "/items/item_5"} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/x-www-form-urlencoded\r\ncontent-length: ${body}\r\nconnection: close\r\n\r\n`;
  const stop = goodClient();
  const statuses = { manyHeaders: (await ask(many)).status, hugeHeader: (await ask(huge)).status, hugeBody: await (async () => {
    const c = await open();
    if (!c) return null;
    c.socket.write(post);
    // The body in 64 KiB pieces as the socket takes them, until all is sent or the server answers or closes.
    const piece = Buffer.alloc(64 * 1024, "a");
    for (let sent = 0; sent < body && c.closed() === null && parseAnswer(Buffer.concat(c.got)) === null; sent += piece.length) {
      // A server that stops reading without answering or closing holds the write: 10 s, then stop sending.
      if (!c.socket.write(piece) && !(await Promise.race([new Promise((done) => { c.socket.once("drain", () => done(true)); c.socket.once("close", () => done(true)); }), new Promise((done) => setTimeout(() => done(false), 10_000).unref())]))) break;
    }
    const end = Date.now() + 10_000;
    while (Date.now() < end && c.closed() === null && parseAnswer(Buffer.concat(c.got)) === null) await sleep(10);
    const status = parseAnswer(Buffer.concat(c.got))?.status ?? null;
    hugeBodyReset = c.reset();
    c.socket.destroy();
    return status ?? (c.closed() !== null ? "closed" : null);
  })() };
  const good = await stop();
  out = { phase: r.phase, statuses, reset: { hugeBody: hugeBodyReset }, good, after: (await ask(get(jsonPath))).status };
} else {
  const stop = goodClient();
  const conns = await openMany(count);
  /** @type {(() => void) | undefined} */
  let tick;
  if (r.phase === "headFlood") {
    for (const c of conns) c.socket.write(`GET ${jsonPath} HTTP/1.1\r\nhost: localhost\r\nx-wait: `);
  } else if (r.phase === "slowHead" || r.phase === "slowBody") {
    const head = r.phase === "slowHead"
      ? Buffer.from(`GET ${jsonPath} HTTP/1.1\r\nhost: localhost\r\nuser-agent: ${"a".repeat(4096)}\r\n\r\n`)
      : Buffer.from("a".repeat(1024 * 1024));
    if (r.phase === "slowBody") for (const c of conns) c.socket.write(`POST ${r.formPath ?? "/items/item_5"} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/x-www-form-urlencoded\r\ncontent-length: ${head.length}\r\n\r\n`);
    let at = 0;
    tick = () => { for (const c of conns) if (c.closed() === null && at < head.length) c.socket.write(head.subarray(at, at + 1)); at++; };
  } else if (r.phase === "slowReader") {
    const many = get(r.pagePath ?? "/items/item_5").replace("connection: close\r\n", "").repeat(r.pipelined ?? 200);
    for (const c of conns) { c.socket.pause(); c.socket.write(many); }
    // A paused socket reads nothing, its peer's FIN included, so a close would never be seen: an
    // empty line each tick (which a server ignores before a request line) fails once the server
    // has closed or reset the connection, and that error closes the socket.
    tick = () => { for (const c of conns) if (c.closed() === null) c.socket.write("\r\n"); };
  } else if (r.phase !== "idleFlood") {
    throw new Error("unknown phase " + r.phase);
  }
  const { heldMs, closedBy, answers } = await holdAll(conns, tick, everyMs);
  const good = await stop();
  await sleep(1000);
  out = { phase: r.phase, opened: conns.length, closedBy, answers, heldMs, good, after: (await ask(get(jsonPath))).status };
}
process.stdout.write(JSON.stringify(out));
