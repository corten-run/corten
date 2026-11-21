// Synthetic credentials and in-memory request controls only, never provider I/O.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Agent, request as httpsRequest } from "node:https";
import { Duplex } from "node:stream";
import { resolve } from "node:path";
import test from "node:test";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";

const args = ["compute", "droplet", "delete", "123", "--force", "--context", "synthetic-expiry-context"];
const spawn = () => ({ status: 0, stdout: Buffer.from("SYNTHETIC_ONLY_EXPIRY_CREDENTIAL\n") });

test("absolute retirement expiry gates a real ClientRequest after asynchronous Agent setup", async () => {
  for (const phase of ["fresh", "agent", "connect", "secureConnect", "tls-fresh", "receipt", "sent-no-reply"]) {
    const realNow = Date.now, start = realNow();
    let offset = 0, wireAt, writes = 0;
    Date.now = () => realNow() + offset;
    const agent = new Agent({ keepAlive: false });
    const socket = new Duplex({ read() {}, write(bytes, encoding, done) {
      writes++; wireAt = Date.now();
      assert.match(bytes.toString("ascii"), /^DELETE \/v2\/droplets\/123 HTTP\/1\.1\r\n/);
      done(); queueMicrotask(() => phase === "sent-no-reply" ? socket.destroy() : socket.push("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"));
    } });
    socket.connecting = ["connect", "secureConnect", "tls-fresh"].includes(phase);
    socket.encrypted = ["secureConnect", "tls-fresh"].includes(phase);
    socket.authorized = false;
    agent.createConnection = (_options, callback) => {
      setImmediate(() => {
        if (["agent", "receipt"].includes(phase)) offset = 61001;
        callback(null, socket);
        if (socket.connecting) setImmediate(() => {
          if (phase !== "tls-fresh") offset = 61001;
          socket.connecting = false;
          socket.emit("connect");
          if (socket.encrypted) { socket.authorized = true; socket.emit("secureConnect"); }
        });
      });
      return undefined;
    };
    try {
      const run = createProviderEngine({ repo: resolve("."), spawn, connect(url, options, callback) {
        // Real HTTPS request queue, no DNS, TCP, TLS or provider connection.
        return httpsRequest(url, { ...options, agent, headers: { host: "synthetic.invalid" } }, callback);
      } });
      const expiry = start + 60000;
      if (phase === "receipt") {
        assert.deepEqual(await run(args, 120000, true, expiry), { status: 1, stdout: "", stderr: "", deleteNotDispatched: true });
        assert.equal(writes, 0);
      } else if (phase === "sent-no-reply") {
        await assert.rejects(run(args, 120000, true, expiry)); assert.equal(writes, 1);
      } else if (!["fresh", "tls-fresh"].includes(phase)) {
        await assert.rejects(run(args, 120000, false, expiry));
        assert.equal(writes, 0, phase);
      } else {
        assert.equal((await run(args, 120000, false, expiry)).status, 0);
        assert.equal(writes, 1); assert.ok(wireAt < expiry);
      }
    } finally { agent.destroy(); socket.destroy(); Date.now = realNow; }
  }
});

test("absolute retirement expiry destroys an unsent ClientRequest before a late socket arrives", async () => {
  const realNow = Date.now, start = realNow();
  let offset = 0, supply, request, writes = 0;
  Date.now = () => realNow() + offset;
  const agent = new Agent({ keepAlive: false });
  const socket = new Duplex({ read() {}, write(bytes, encoding, done) { writes++; done(); } });
  agent.createConnection = (_options, callback) => { supply = callback; return undefined; };
  try {
    const run = createProviderEngine({ repo: resolve("."), spawn, connect(url, options, callback) {
      request = httpsRequest(url, { ...options, agent, headers: { host: "synthetic.invalid" } }, callback);
      // Leave 50ms of the original absolute window. No socket is supplied yet.
      offset = 59950;
      return request;
    } });
    await assert.rejects(run(args, 120000, false, start + 60000));
    assert.ok(request.destroyed); assert.equal(typeof supply, "function");
    supply(null, socket);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 0);
  } finally { agent.destroy(); socket.destroy(); Date.now = realNow; }
});

test("absolute retirement expiry survives provider consumption and its asynchronous checkpoint", async () => {
  for (const phase of ["consume", "checkpoint", "fresh", "window", "malformed"]) {
    const realNow = Date.now, start = realNow(); let offset = 0, requests = 0, passedExpiry;
    Date.now = () => realNow() + offset;
    try {
      const expires = phase === "window" ? start + 120000 : phase === "malformed" ? NaN : start + 60000;
      const run = createProviderEngine({ repo: resolve("."), spawn() {
        if (phase === "consume") offset = 61001;
        if (phase === "checkpoint") setImmediate(() => { offset = 61001; });
        return spawn();
      }, request(options) {
        requests++; passedExpiry = options.deleteProofExpiresAtMs;
        return { status: 204, value: null };
      } });
      if (phase === "fresh") {
        assert.equal((await run(args, 120000, false, expires)).status, 0);
        assert.equal(passedExpiry, expires); assert.equal(requests, 1);
      } else {
        await assert.rejects(run(args, 120000, false, expires)); assert.equal(requests, 0, phase);
      }
    } finally { Date.now = realNow; }
  }
});

test("private HTTP dispatch rechecks absolute expiry immediately before connect and end", async () => {
  for (const phase of ["dispatch", "end", "fresh"]) {
    const realNow = Date.now, start = realNow(); let offset = 0, connects = 0, sends = 0, destroyed = 0, privateClockReads = 0;
    Date.now = () => { privateClockReads++; return realNow() + offset; };
    try {
      const run = createProviderEngine({ repo: resolve("."), spawn, now() {
        // Keep the sampled engine clock fresh while the private HTTP clock sees
        // expired proof, independently of credential/engine clock-read counts.
        if (phase === "dispatch") offset = 61001;
        return realNow();
      }, connect(url, options, callback) {
        connects++; assert.equal(url.href, "https://api.digitalocean.com/v2/droplets/123"); assert.equal(options.method, "DELETE");
        if (phase === "end") offset = 61001;
        const req = new EventEmitter();
        req.destroy = () => { destroyed++; };
        req.end = () => {
          sends++;
          const res = new EventEmitter(); res.statusCode = 204;
          callback(res); queueMicrotask(() => res.emit("end"));
        };
        const socket = new EventEmitter(); socket.connecting = false;
        queueMicrotask(() => req.emit("socket", socket));
        return req;
      } });
      if (phase === "fresh") {
        assert.equal((await run(args, 120000, false, start + 60000)).status, 0);
        assert.equal(sends, 1); assert.equal(connects, 1);
      } else {
        await assert.rejects(run(args, 120000, false, start + 60000), (error) => {
          assert.equal(error.providerDiagnostic?.code, "delete-request"); assert.equal(error.controlUncertain, true); return true;
        });
        assert.equal(sends, 0); assert.equal(connects, phase === "end" ? 1 : 0);
        assert.equal(destroyed, connects);
        assert.ok(privateClockReads > 0, "the private HTTP clock, not an earlier engine gate, observed expiry");
      }
    } finally { Date.now = realNow; }
  }
});
