// The matched tier's two connection probes, for conform.mjs, run inside fsw-probe as
// conform-probe.mjs is. Reads { host, port, mode, ... } as JSON on stdin, writes JSON on stdout.
// mode "head": a request head that is never finished (the request line and one header, then
//   nothing): { closedMs } when the server closed the connection, { timedOutMs } when it still
//   held it at timeoutMs, or { error }.
// mode "cap": `hold` connections opened and left idle, then one request on a connection of its
//   own: whether it was answered within waitMs while they were held, and then, the held ones
//   closed, whether it was answered within releaseMs (a server at its cap leaves the new one
//   queued, or closes it). { held, whileHeld: status | null, afterRelease: status | "closed" |
//   null, releaseMs } or { error }; held is how many of the `hold` connected.
import { connect } from "node:net";
import { parseAnswer } from "./conformance.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
/** @type {{ host: string, port: number, mode: "head" | "cap", path: string, timeoutMs?: number, hold?: number, waitMs?: number, releaseMs?: number }} */
const r = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));
const request = `GET ${r.path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n`;

/** Opens a connection; resolves to it once connected, or null when it could not. */
const open = () => /** @type {Promise<import("node:net").Socket | null>} */ (new Promise((done) => {
  const socket = connect({ host: r.host, port: r.port });
  socket.once("connect", () => done(socket));
  socket.once("error", () => done(null));
  socket.setTimeout(30_000, () => socket.destroy());
}));

if (r.mode === "head") {
  const started = Date.now();
  const socket = await open();
  if (!socket) {
    process.stdout.write(JSON.stringify({ error: "could not connect" }));
  } else {
    socket.setTimeout(0);
    socket.write(`GET ${r.path} HTTP/1.1\r\nhost: localhost\r\n`);
    socket.on("data", () => {});
    socket.on("error", () => {});
    // The limit's timer is cleared once the server closes, so the probe ends then, not at the limit.
    /** @type {NodeJS.Timeout | undefined} */
    let limit;
    const closed = await new Promise((done) => {
      limit = setTimeout(() => done(false), r.timeoutMs ?? 45_000);
      socket.once("close", () => done(true));
    });
    clearTimeout(limit);
    process.stdout.write(JSON.stringify(closed ? { closedMs: Date.now() - started } : { timedOutMs: Date.now() - started }));
    socket.destroy();
  }
} else {
  const held = (await Promise.all(Array.from({ length: r.hold ?? 0 }, open))).filter((s) => s !== null);
  for (const s of held) { s.on("error", () => {}); s.on("data", () => {}); }
  // Give the server time to accept what it will.
  await sleep(500);
  const socket = await open();
  /** @type {Buffer[]} */
  const got = [];
  let closed = false;
  if (socket) {
    socket.setTimeout(0);
    socket.on("data", (c) => got.push(c));
    socket.on("error", () => {});
    socket.on("close", () => { closed = true; });
    socket.write(request);
  }
  const status = () => parseAnswer(Buffer.concat(got))?.status ?? null;
  const until = async (/** @type {number} */ ms) => { const end = Date.now() + ms; while (Date.now() < end && status() === null && !closed) await sleep(25); };
  await until(r.waitMs ?? 3000);
  const whileHeld = status();
  for (const s of held) s.destroy();
  const released = Date.now();
  if (whileHeld === null && !closed) await until(r.releaseMs ?? 10_000);
  const after = whileHeld !== null ? null : status() ?? (closed ? "closed" : null);
  process.stdout.write(JSON.stringify(socket ? { held: held.length, whileHeld, afterRelease: after, releaseMs: Date.now() - released } : { error: "could not connect" }));
  socket?.destroy();
}
