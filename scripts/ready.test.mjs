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
  // Only the readiness route, asked with GET, is the stand-in's to answer; anything else is a 404 the wait refuses.
  const app = http.createServer((req, res) => (req.method === "GET" && req.url === "/health/ready" ? handle(++n, req, res) : res.writeHead(404).end()));
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
/** A clock that moves `by` milliseconds ahead after `calls` readings. */
const shifts = (/** @type {number} */ calls, /** @type {number} */ by) => {
  let read = 0;
  return () => performance.now() + (++read > calls ? by : 0);
};
/** A clock that jumps past any budget after `calls` readings. */
const jumps = (/** @type {number} */ calls) => {
  let read = 0;
  return () => performance.now() + (++read > calls ? 1e9 : 0);
};

test("a 503, a reset connection and a body that breaks off are waited out until a whole 200", async () => {
  // Three 503s are three pauses of 250 ms: the wait does not ask again at once.
  const began = performance.now();
  assert.deepEqual(await against((n, _q, s) => (n < 4 ? unavailable(s) : ok(s))), { outcome: "ready", requests: 4 });
  const paced = performance.now() - began;
  assert.ok(paced >= 600, `three retries took ${Math.round(paced)} ms`);
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
  // A refused status is refused at its headers: its body never ends here, so a wait for it would
  // run out of budget instead.
  const open = await against((_n, _q, s) => void s.writeHead(500, { "content-length": "10" }).write("x"), { budget: 3000 });
  assert.deepEqual(open, { outcome: "http://127.0.0.1:PORT/health/ready answered 500, not 200 or 503", requests: 1 });
  // A body framed in a way that is not HTTP is refused too, unlike one cut short.
  const framing = await against((n, q, s) => (n < 2 ? q.socket?.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nx\r\n") : ok(s)));
  assert.equal(framing.requests, 1);
  assert.match(framing.outcome, /answered what is not HTTP \(HPE_[A-Z_]+\)$/);
  // An answer that is not HTTP (here two lengths) is refused, not retried until a 200 comes.
  const malformed = await against((n, q, s) => (n < 2 ? q.socket?.end("HTTP/1.1 500 x\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx") : ok(s)));
  assert.equal(malformed.requests, 1);
  assert.match(malformed.outcome, /^http:\/\/127\.0\.0\.1:PORT\/health\/ready answered what is not HTTP \(HPE_[A-Z_]+\)$/);
  // A success that is not a 200 is not readiness.
  const empty = await against((n, _q, s) => (n < 2 ? s.writeHead(204).end() : ok(s)));
  assert.deepEqual(empty, { outcome: "http://127.0.0.1:PORT/health/ready answered 204, not 200 or 503", requests: 1 });
});

test("the budget ends the wait naming the last outcome, and nothing after it counts", async () => {
  const always = await against((_n, _q, s) => unavailable(s), { budget: 1234.75 });
  // The last attempt may be a short one the end of the budget cut off.
  assert.match(always.outcome, /^http:\/\/127\.0\.0\.1:PORT\/health\/ready did not answer 200 within 1\.23475 s \(last: (503|ABORT_ERR)\)$/);
  // The attempt that stalls is cancelled when the budget runs out, not at its own 5 s. It is the
  // first and only attempt, so no pause or second exchange has to fit in the budget.
  const from = performance.now();
  const stalled = await against((_n, _q, s) => void s.writeHead(200, { "content-length": "10" }).write("o"), { budget: 1500 });
  const took = performance.now() - from;
  // Not before the budget, and well short of the attempt's own 5 s.
  assert.ok(took >= 1400 && took < 4500, `stalled attempt ended after ${Math.round(took)} ms`);
  assert.deepEqual(stalled, {
    outcome: "http://127.0.0.1:PORT/health/ready did not answer 200 within 1.5 s (last: 200, then its body broke off (ABORT_ERR))",
    requests: 1,
  });
  for (const status of [200, 500]) {
    const late = await against((_n, _q, s) => s.writeHead(status).end("x"), { now: jumps(2) });
    assert.deepEqual(late, { outcome: `http://127.0.0.1:PORT/health/ready did not answer 200 within 120 s (last: ${status})`, requests: 1 });
  }
  const noPause = await against((_n, _q, s) => unavailable(s), { now: jumps(3) });
  assert.deepEqual(noPause, { outcome: "http://127.0.0.1:PORT/health/ready did not answer 200 within 120 s (last: 503)", requests: 1 });
});

test("an attempt that hangs is given up after 5 s and the next one is made", async () => {
  const from = performance.now();
  // The budget leaves the second exchange 25 s, so a slow runner cannot crowd it out, while an
  // attempt given the whole budget would still hang past it.
  const got = await against((n, _q, s) => void (n > 1 && ok(s)), { budget: 30_000 });
  const took = performance.now() - from;
  assert.deepEqual(got, { outcome: "ready", requests: 2 });
  // A second request at all is the cap at work; the first attempt lasted its 5 s.
  assert.ok(took >= 4900, `ready after ${Math.round(took)} ms`);
});

test("an answer that comes after its attempt's 5 s is not read, and the attempt is asked again", async () => {
  // The clock reads 5.1 s later from the read after the first answer, as if the loop had stalled
  // past the attempt's 5 s before its abort ran.
  const got = await against((n, _q, s) => (n < 2 ? s.writeHead(500).end("x") : ok(s)), { now: shifts(2, 5100) });
  assert.deepEqual(got, { outcome: "ready", requests: 2 });
  // A whole 200 that comes that late is not readiness either: the attempt is asked again.
  const late200 = await against((n, _q, s) => (n < 2 ? ok(s) : s.writeHead(500).end("x")), { now: shifts(2, 5100) });
  assert.deepEqual(late200, { outcome: "http://127.0.0.1:PORT/health/ready answered 500, not 200 or 503", requests: 2 });
});

test("a refused connection is waited out until the app listens", async () => {
  // The port is picked below every default ephemeral range (Linux 32768, Windows and macOS 49152),
  // so no server another process starts on port 0 takes it. Before the app listens, the port must
  // be seen to refuse: on a clock that ends the budget after a second attempt, two refusals in a
  // row are retried and the second is named, which no answer from another listener can give. A port
  // that is not free all the way through (it answers, the app cannot bind it, or another client's
  // request reaches the app) proves nothing either way, so another is picked.
  for (let tries = 0; ; tries++) {
    assert.ok(tries < 5, "five ports below the ephemeral range were not free for the whole test");
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const refusing = await ready(`http://127.0.0.1:${port}`, { now: jumps(5) }).then(
      () => "ready",
      (e) => String(e.message),
    );
    if (refusing !== `http://127.0.0.1:${port}/health/ready did not answer 200 within 120 s (last: ECONNREFUSED)`) continue;
    let asked = 0;
    const app = http.createServer((_q, s) => (asked++, ok(s)));
    /** @type {Promise<Error | undefined>} */
    const listened = new Promise((r) => {
      app.once("error", r);
      app.once("listening", () => r(undefined));
    });
    const later = setTimeout(() => app.listen(port, "127.0.0.1"), 600);
    try {
      const outcome = await ready(`http://127.0.0.1:${port}`, { budget: 30_000 }).then(
        () => "ready",
        (e) => String(e.message),
      );
      if ((await listened) !== undefined || asked !== 1) continue;
      assert.equal(outcome, "ready");
      return;
    } finally {
      clearTimeout(later);
      app.closeAllConnections();
      app.close();
    }
  }
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
  // The app refuses at once and the proxy would say ready, so the outcome names which one answered
  // with no timeout in it.
  const app = http.createServer((_q, s) => (asked++, s.writeHead(500).end("x")));
  await Promise.all([proxy, app].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)))));
  const port = (/** @type {http.Server} */ s) => /** @type {import("node:net").AddressInfo} */ (s.address()).port;
  const proxyUrl = `http://127.0.0.1:${port(proxy)}`;
  const code = `import("${new URL("./ready.mjs", import.meta.url).href}").then(({ ready }) => ready("http://127.0.0.1:${port(app)}", { budget: 30_000 })).then(() => console.log("ready"), (e) => console.log(e.message))`;
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
  assert.match(String(out), /answered 500, not 200 or 503$/);
  assert.equal(proxied, 0);
  assert.equal(asked, 1);
});
