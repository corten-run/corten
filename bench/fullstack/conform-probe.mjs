// One HTTP/1.1 request, for conform.mjs, run inside a container on the bench network so no port
// proxy stands between it and the app (Docker Desktop's loses an answer sent while the request's
// body is still arriving). Reads the request as JSON on stdin, writes the answer as JSON on stdout:
// { status, headers (those conformance.mjs reads), bodyLength, body (base64, when asked), ms } or
// { timedOut, ms } or { error, ms }. The time limit is for the whole exchange, not for silence; on
// a POST, a status that arrived before it is the answer even if the connection stays open (a GET's
// answer is the whole body, so a head followed by silence is held).
// A request with a body goes over a plain socket: a server may answer before it has read the
// body and close, and node:http then reports the write's EPIPE instead of the answer.
import { request } from "node:http";
import { connect } from "node:net";
import { parseAnswer } from "./conformance.mjs";

/** The response headers conformance.mjs reads, the only ones returned. */
const kept = ["content-type", "content-encoding", "cache-control", "etag", "content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options", "cross-origin-opener-policy", "permissions-policy", "set-cookie", "serverfnerror"];
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
/** @type {{ host: string, port: number, method: string, path: string, headers: Record<string, string>, body?: string, timeoutMs: number, keepBody?: boolean }} */
const r = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const started = Date.now();
const keep = (/** @type {Record<string, string | string[] | undefined>} */ h) => Object.fromEntries(kept.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));

const answer = await new Promise((resolve) => {
  let done = false;
  const finish = (/** @type {Record<string, unknown>} */ a) => { if (!done) { done = true; clearTimeout(timer); resolve(a); } };
  /** @type {{ destroy(): void }} */
  let conn;
  /** @type {() => ReturnType<typeof parseAnswer>} */
  let parsed = () => null;
  if (r.body !== undefined) {
    const body = Buffer.from(r.body, "utf8");
    const head = [`${r.method} ${r.path} HTTP/1.1`, ...Object.entries({ connection: "close", ...r.headers, "content-length": String(body.length) }).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
    /** @type {Buffer[]} */
    const got = [];
    /** @type {string | undefined} */
    let code;
    // The write side stays open, as a browser's does: hyper, by default, and some Node servers
    // take a half-close as the client leaving and drop the request.
    const socket = connect({ host: r.host, port: r.port }, () => { socket.write(head); socket.write(body); });
    conn = socket;
    socket.on("data", (c) => got.push(c));
    // The answer is whatever arrived, however the connection ended (a reset after the answer included).
    const settle = () => {
      const a = parseAnswer(Buffer.concat(got));
      finish(a ? { ...a, headers: keep(a.headers), ms: Date.now() - started } : { error: code ?? "closed without an answer", ms: Date.now() - started });
    };
    parsed = () => parseAnswer(Buffer.concat(got));
    // 'error' comes before 'close', so its code is kept for the answer 'close' settles.
    socket.on("error", (e) => { code = /** @type {any} */ (e).code ?? e.message; });
    socket.on("close", settle);
  } else {
    // A lenient parser, so a server's malformed header does not hide its status.
    const req = request({ host: r.host, port: r.port, method: r.method, path: r.path, headers: { connection: "close", ...r.headers }, agent: false, insecureHTTPParser: true }, (res) => {
      /** @type {Buffer[]} */
      const body = [];
      res.on("data", (c) => body.push(c));
      res.on("end", () => {
        const all = Buffer.concat(body);
        finish({ status: res.statusCode, headers: keep(res.headers), bodyLength: all.length, ...(r.keepBody ? { body: all.toString("base64") } : {}), ms: Date.now() - started });
      });
      res.on("error", (e) => finish({ error: /** @type {any} */ (e).code ?? e.message, ms: Date.now() - started }));
    });
    conn = req;
    req.on("error", (e) => finish({ error: /** @type {any} */ (e).code ?? e.message, ms: Date.now() - started }));
    req.end();
  }
  const timer = setTimeout(() => {
    const a = parsed();
    finish(a ? { ...a, headers: keep(a.headers), ms: Date.now() - started } : { timedOut: true, ms: Date.now() - started });
    conn.destroy();
  }, r.timeoutMs);
});
process.stdout.write(JSON.stringify(answer));
