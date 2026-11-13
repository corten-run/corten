// TLS client probes only. The native application and existing nginx profile are unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { connect } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAnswer } from "../fullstack/conformance.mjs";
import { qualify } from "../marketplace/qualify.mjs";

const kept = ["content-type", "content-encoding", "cache-control", "etag", "content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options", "cross-origin-opener-policy", "permissions-policy", "set-cookie", "serverfnerror"];
const keep = (headers) => Object.fromEntries(kept.filter((key) => headers[key] !== undefined).map((key) => [key, headers[key]]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = (r, ca) => ({ host: r.host, port: r.port, servername: "localhost", ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });

export function tlsRequest(r, ca) {
  return new Promise((resolve) => {
    const started = performance.now(), chunks = [];
    let connection, timer, done = false, size = 0, code;
    const elapsed = () => performance.now() - started;
    const finish = (answer) => {
      if (done) return;
      done = true; clearTimeout(timer); connection?.destroy(); resolve({ ...answer, ms: elapsed() });
    };
    const append = (chunk) => {
      size += chunk.length;
      if (size > 16 * 2 ** 20) finish({ error: "TLS qualification response budget exceeded" });
      else chunks.push(chunk);
    };
    let parsed = () => null;
    if (r.body !== undefined) {
      const body = Buffer.from(r.body), head = [`${r.method} ${r.path} HTTP/1.1`,
        ...Object.entries({ connection: "close", ...r.headers, "content-length": String(body.length) }).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
      const socket = connection = connect(options(r, ca));
      let offset = 0, responding = false;
      const writeBody = () => {
        while (!responding && !socket.destroyed && offset < body.length) {
          const end = Math.min(offset + 16384, body.length), chunk = body.subarray(offset, end); offset = end;
          if (!socket.write(chunk)) return;
        }
      };
      socket.once("secureConnect", () => { if (socket.write(head)) writeBody(); });
      socket.on("drain", writeBody);
      socket.on("data", (chunk) => { responding = true; append(chunk); });
      parsed = () => { const answer = parseAnswer(Buffer.concat(chunks)); return answer && { ...answer, headers: keep(answer.headers) }; };
      socket.on("error", (error) => { code = error.code ?? error.message; });
      socket.once("close", () => finish(parsed() ?? { error: code ?? "closed without an answer" }));
    } else {
      const req = connection = request({ ...options(r, ca), path: r.path, method: r.method, agent: false, insecureHTTPParser: true,
        headers: { connection: "close", ...r.headers } }, (res) => {
        res.on("data", append);
        res.on("error", (error) => finish({ error: error.code ?? error.message }));
        res.once("end", () => finish({ status: res.statusCode, headers: keep(res.headers), bodyLength: size,
          ...(r.keepBody ? { body: Buffer.concat(chunks).toString("base64") } : {}) }));
      });
      req.on("error", (error) => finish({ error: error.code ?? error.message })); req.end();
    }
    timer = setTimeout(() => finish(parsed() ?? { timedOut: true }), r.timeoutMs);
  });
}

export async function tlsHold(r, ca) {
  const open = () => new Promise((resolve) => {
    const socket = connect(options(r, ca)); let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { socket.destroy(); finish(null); }, r.connectMs ?? 5000);
    socket.on("error", () => finish(null));
    socket.once("close", () => finish(null));
    socket.once("secureConnect", () => finish(socket));
  });
  const sockets = new Set();
  const trackedOpen = async () => { const socket = await open(); if (socket) sockets.add(socket); return socket; };
  try {
    if (r.mode === "head") {
      const started = performance.now(), socket = await trackedOpen();
      if (!socket) return { error: "could not connect" };
      socket.on("data", () => {});
      const closed = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), r.timeoutMs ?? 45000);
        socket.once("close", () => { clearTimeout(timer); resolve(true); });
        socket.write(`GET ${r.path} HTTP/1.1\r\nhost: localhost\r\n`);
      });
      return { [closed ? "closedMs" : "timedOutMs"]: performance.now() - started };
    }
    assert.equal(r.mode, "cap");
    const holding = async (count) => {
      const held = (await Promise.all(Array.from({ length: count }, trackedOpen))).filter(Boolean);
      for (const socket of held) socket.on("data", () => {});
      await sleep(500);
      const socket = await trackedOpen(), chunks = [], state = { closed: !socket };
      if (socket) {
        socket.on("data", (chunk) => chunks.push(chunk)); socket.once("close", () => { state.closed = true; });
        socket.write(`GET ${r.path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n`);
      }
      const status = () => parseAnswer(Buffer.concat(chunks))?.status ?? null;
      const until = async (ms) => { const end = performance.now() + ms; while (performance.now() < end && status() === null && !state.closed) await sleep(25); };
      await until(r.waitMs ?? 3000);
      return { held, socket, state, status, until };
    };
    const first = await holding(r.below ?? 0), belowHeld = first.status();
    for (const socket of first.held) socket.destroy(); first.socket?.destroy();
    await sleep(1000);
    const second = await holding(r.hold ?? 0), whileHeld = second.status();
    for (const socket of second.held) socket.destroy();
    const released = performance.now();
    if (whileHeld === null && !second.state.closed) await second.until(r.releaseMs ?? 10000);
    const afterRelease = whileHeld !== null ? null : second.status() ?? (!second.socket ? "refused" : second.state.closed ? "closed" : null);
    const releaseMs = performance.now() - released; second.socket?.destroy();
    await sleep(1000);
    const last = await holding(0), afterwards = last.status(); last.socket?.destroy();
    return { below: first.held.length, belowHeld, held: second.held.length, whileHeld, afterRelease, releaseMs, afterwards };
  } finally { for (const socket of sockets) socket.destroy(); }
}

export function tlsProbe(script, input, ca) {
  assert.ok(["conform-probe", "conform-hold"].includes(script));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--probe", script], {
    input: JSON.stringify({ input, ca }), encoding: "utf8", timeout: 90000, maxBuffer: 8 * 2 ** 20,
  });
  assert.ok(!child.error && child.status === 0, `TLS qualification apparatus failed: ${child.error?.message ?? child.stderr}`);
  return JSON.parse(child.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--probe") {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const { input, ca } = JSON.parse(Buffer.concat(chunks));
    process.stdout.write(JSON.stringify(await (process.argv[3] === "conform-probe" ? tlsRequest(input, ca) : tlsHold(input, ca))));
  } else {
    const [base, source, upstream, output] = process.argv.slice(2);
    assert.equal(new URL(base).protocol, "https:");
    const ca = readFileSync(process.env.BENCH_EDGE_CERT, "utf8");
    const result = await qualify({ base, source, upstream, probe: (script, input) => tlsProbe(script, input, ca) });
    writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(`${source} TLS deployment: ${result.eligible ? "qualified" : `missing: ${result.missing.join(", ")}`}`);
  }
}
