// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { ready } from "./ready.mjs";

/**
 * Runs `ready` against a stand-in app answering each request with `handle(n, req, res)`, n counting
 * from 1, and returns what it did and how many requests the stand-in saw.
 * @param {(n: number, req: http.IncomingMessage, res: http.ServerResponse) => void} handle
 * @param {{ budget?: number, now?: () => number, auth?: string }} [options]
 */
async function against(handle, { auth = "", ...options } = {}) {
  let n = 0;
  const app = http.createServer((req, res) => handle(++n, req, res));
  await new Promise((r) => app.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (app.address()).port;
  try {
    await ready(`http://${auth}127.0.0.1:${port}`, options);
    return { outcome: "ready", requests: n };
  } catch (e) {
    return { outcome: String(/** @type {Error} */ (e).message).replaceAll(String(port), "PORT"), requests: n };
  } finally {
    app.closeAllConnections();
    app.close();
  }
}
const ok = (/** @type {http.ServerResponse} */ res) => res.writeHead(200).end("ok");
const unavailable = (/** @type {http.ServerResponse} */ res) => res.writeHead(503).end("unavailable");
/** A clock that jumps past any budget after `calls` readings. */
const jumps = (/** @type {number} */ calls) => {
  let read = 0;
  return () => performance.now() + (++read > calls ? 1e9 : 0);
};

test("a 503, a reset connection and a body that breaks off are waited out until a whole 200", async () => {
  assert.deepEqual(await against((n, _q, s) => (n < 4 ? unavailable(s) : ok(s))), { outcome: "ready", requests: 4 });
  assert.deepEqual(await against((n, q, s) => (n < 3 ? q.socket.destroy() : ok(s))), { outcome: "ready", requests: 3 });
  for (const status of [200, 503]) {
    const cut = await against((n, q, s) => {
      if (n > 1) return ok(s);
      s.writeHead(status, { "content-length": "10" }).write("x");
      setTimeout(() => q.socket.destroy(), 50);
    });
    assert.deepEqual(cut, { outcome: "ready", requests: 2 });
  }
});

test("any other status ends the wait at its headers, a 421, 407 or 101 included", async () => {
  for (const status of [500, 302, 421, 407]) {
    const got = await against((n, _q, s) => (n < 2 ? s.writeHead(status, { location: "/" }).end("x") : ok(s)));
    assert.deepEqual(got, { outcome: `http://127.0.0.1:PORT/health/ready answered ${status}, not 200 or 503`, requests: 1 });
  }
  // A 101 the request did not ask for, written on the socket as a server could.
  const upgrade = await against((n, _q, s) =>
    n < 2 ? s.socket?.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n") : ok(s),
  );
  assert.deepEqual(upgrade, { outcome: "http://127.0.0.1:PORT/health/ready answered 101, not 200 or 503", requests: 1 });
  // A refused status is refused at its headers: its body, which never ends here, is not waited for.
  const started = performance.now();
  const open = await against((_n, _q, s) => void s.writeHead(500, { "content-length": "10" }).write("x"), { budget: 3000 });
  assert.deepEqual(open, { outcome: "http://127.0.0.1:PORT/health/ready answered 500, not 200 or 503", requests: 1 });
  assert.ok(performance.now() - started < 1000, `refused after ${Math.round(performance.now() - started)} ms`);
  // A success that is not a 200 is not readiness.
  const empty = await against((n, _q, s) => (n < 2 ? s.writeHead(204).end() : ok(s)));
  assert.deepEqual(empty, { outcome: "http://127.0.0.1:PORT/health/ready answered 204, not 200 or 503", requests: 1 });
});

test("the budget ends the wait naming the last outcome, and nothing after it counts", async () => {
  const always = await against((_n, _q, s) => unavailable(s), { budget: 1234.75 });
  assert.equal(always.outcome, "http://127.0.0.1:PORT/health/ready did not answer 200 within 1.23475 s (last: 503)");
  // The attempt that stalls is cancelled when the budget runs out, not at its own 5 s.
  const from = performance.now();
  const stalled = await against((n, _q, s) => (n < 2 ? unavailable(s) : s.writeHead(200, { "content-length": "10" }).write("o")), { budget: 1500 });
  const took = performance.now() - from;
  assert.ok(took >= 1400 && took < 2500, `stalled attempt ended after ${Math.round(took)} ms`);
  assert.deepEqual(stalled, {
    outcome: "http://127.0.0.1:PORT/health/ready did not answer 200 within 1.5 s (last: 200, then its body broke off (ABORT_ERR))",
    requests: 2,
  });
  for (const status of [200, 500]) {
    const late = await against((_n, _q, s) => s.writeHead(status).end("x"), { now: jumps(2) });
    assert.deepEqual(late, { outcome: `http://127.0.0.1:PORT/health/ready did not answer 200 within 120 s (last: ${status})`, requests: 1 });
  }
  const noPause = await against((_n, _q, s) => unavailable(s), { now: jumps(3) });
  assert.deepEqual(noPause, { outcome: "http://127.0.0.1:PORT/health/ready did not answer 200 within 120 s (last: 503)", requests: 1 });
});

test("a base is named without its credentials, and one that cannot be read or is not plain http is refused by name", async () => {
  const refused = await against((_n, _q, s) => s.writeHead(500).end("x"), { auth: "user:secret@" });
  assert.equal(refused.outcome, "http://127.0.0.1:PORT/health/ready answered 500, not 200 or 503");
  // A base Node cannot parse is refused without the input, whose credentials Node's error would carry.
  const malformed = await ready("http://user:secret@[::1/").then(
    () => "ready",
    (e) => e,
  );
  assert.equal(malformed.message, "/health/ready: the readiness wait was not given a URL it can read");
  assert.equal(malformed.cause, undefined);
  assert.doesNotMatch(JSON.stringify(malformed, Object.getOwnPropertyNames(malformed)), /secret/);
  await assert.rejects(ready("https://user:secret@127.0.0.1:1"), {
    message: "https://127.0.0.1:1/health/ready: the readiness wait asks the app over plain http",
  });
});

test("a proxy set in the environment never answers for the app", async () => {
  let proxied = 0;
  const proxy = http.createServer((_q, s) => (proxied++, ok(s)));
  let asked = 0;
  const app = http.createServer((_q, s) => (asked++, unavailable(s)));
  await Promise.all([proxy, app].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)))));
  const port = (/** @type {http.Server} */ s) => /** @type {import("node:net").AddressInfo} */ (s.address()).port;
  const proxyUrl = `http://127.0.0.1:${port(proxy)}`;
  const code = `import("${new URL("./ready.mjs", import.meta.url).href}").then(({ ready }) => ready("http://127.0.0.1:${port(app)}", { budget: 1000 })).then(() => console.log("ready"), (e) => console.log(e.message))`;
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", code], {
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" },
    });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.on("close", () => resolve(text.trim()));
  });
  proxy.close();
  app.closeAllConnections();
  app.close();
  assert.match(String(out), /did not answer 200 within 1 s \(last: 503\)$/);
  assert.equal(proxied, 0);
  assert.ok(asked > 0);
});
