import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { productionServer } from "./server-profile.mjs";

async function withServer(run, env = {}, handle = (_req, res) => res.end("native handler")) {
  const server = productionServer(handle, { PROFILE: "matched", ...env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const get = (headers = {}, method = "GET", path = "/marketplace/en-US/item_1") => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "localhost", ...headers }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (part) => body += part);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("test request timeout")));
    req.end();
  });
  try { await run({ server, port, get }); }
  finally { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
}

test("matched profile configures native HTTP parser deadlines and connection cap", async () => {
  await withServer(async ({ server }) => {
    assert.equal(server.headersTimeout, 30_000);
    assert.equal(server.requestTimeout, 30_000);
    assert.equal(server.connectionsCheckingInterval, 1000);
    assert.equal(server.maxHeaderSize, 16 * 1024);
    assert.equal(server.maxConnections, 1000);
  });
  for (const MAX_CONNECTIONS of ["0", "-1", "NaN", "1.5", ""]) {
    assert.throws(() => productionServer(() => {}, { PROFILE: "matched", MAX_CONNECTIONS }), /MAX_CONNECTIONS/);
  }
  assert.throws(() => productionServer(() => {}, { PROFILE: "matched", HOSTS: "localhost,*" }), /HOSTS/);
});

test("host allow-list uses exact hostnames, not forwarded headers or string prefixes", async () => {
  await withServer(async ({ get }) => {
    for (const host of ["marketplace", "MARKETPLACE:8080", "localhost", "localhost:80", "127.0.0.1", "[::1]:8080"]) {
      assert.equal((await get({ host })).status, 200, host);
    }
    for (const host of ["unrecognized.invalid", "localhost.evil", "localhost@evil", "localhost/path", "localhost,evil", "localhost:99999"]) {
      const answer = await get({ host, "x-forwarded-host": "localhost" });
      assert.equal(answer.status, 400, host);
      assert.equal(answer.headers["cache-control"], "private, no-store");
      assert.equal(answer.headers["x-content-type-options"], "nosniff");
    }
  }, { HOSTS: "marketplace,localhost,127.0.0.1,[::1]" });
});

test("server supplies fresh trusted nonces and security headers before native rendering", async () => {
  await withServer(async ({ get }) => {
    const first = await get({ "x-nonce": "attacker", "content-security-policy": "script-src * 'unsafe-eval'" });
    const second = await get();
    const one = JSON.parse(first.body), two = JSON.parse(second.body);
    assert.match(one.nonce, /^[A-Za-z0-9+/]{22}==$/);
    assert.notEqual(one.nonce, two.nonce);
    assert.equal(first.headers["content-security-policy"], one.policy);
    assert.ok(one.policy.includes(`'nonce-${one.nonce}'`));
    assert.doesNotMatch(one.policy, /unsafe-inline|unsafe-eval|\*/);
    for (const header of ["permissions-policy", "x-frame-options", "referrer-policy", "cross-origin-opener-policy"]) {
      assert.ok(first.headers[header], header);
    }
    assert.equal(first.headers["cache-control"], "private, no-store");
  }, {}, (req, res) => res.end(JSON.stringify({ nonce: req.headers["x-nonce"], policy: req.headers["content-security-policy"] })));
});

test("liveness is local, method-aware, private and never calls the application", async () => {
  await withServer(async ({ get }) => {
    for (const method of ["GET", "HEAD", "POST"]) {
      const answer = await get({}, method, "/health/live?probe=1");
      assert.equal(answer.status, method === "POST" ? 405 : 200);
      assert.equal(answer.body, method === "GET" ? "ok" : "");
    }
    assert.equal((await get({ host: "other.invalid" }, "GET", "/health/live")).status, 400);
  }, {}, () => { throw new Error("liveness must not call Next or upstream"); });
});

test("native parser refuses oversized headers and the application still serves", async () => {
  await withServer(async ({ get }) => {
    await get({ "x-large": "x".repeat(65536) }).then(
      (answer) => assert.equal(answer.status, 431),
      (error) => assert.equal(error.code, "ECONNRESET"),
    );
    assert.equal((await get()).status, 200);
  });
});

test("native maxConnections drops excess connections and recovers after release", { timeout: 5000 }, async () => {
  await withServer(async ({ server, port, get }) => {
    const held = [];
    try {
      for (let i = 0; i < 3; i++) {
        const accepted = once(server, "connection");
        const socket = connect({ host: "127.0.0.1", port });
        socket.on("error", () => {});
        held.push(socket);
        await Promise.all([once(socket, "connect"), accepted]);
      }
      const dropped = once(server, "drop");
      await assert.rejects(get(), /ECONNRESET|socket hang up/);
      await dropped;
    } finally {
      const closed = held.map((socket) => { const done = once(socket, "close"); socket.destroy(); return done; });
      await Promise.all(closed);
    }
    // Wait for the server side of the released sockets, not an arbitrary sleep.
    while (await new Promise((resolve) => server.getConnections((_error, n) => resolve(n)))) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal((await get()).status, 200);
  }, { MAX_CONNECTIONS: "3" });
});

test("defaults profile leaves Next's default HTTP server behavior unchanged", async () => {
  await withServer(async ({ server, get }) => {
    assert.equal(server.maxConnections, undefined);
    const answer = await get({ host: "other.invalid", "x-nonce": "client" });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-security-policy"], undefined);
  }, { PROFILE: "" });
});
