// Synthetic credentials and in-memory request controls only, never provider I/O.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";

const args = ["compute", "droplet", "delete", "123", "--force", "--context", "synthetic-expiry-context"];
const spawn = () => ({ status: 0, stdout: Buffer.from("SYNTHETIC_ONLY_EXPIRY_CREDENTIAL\n") });

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
    const realNow = Date.now, start = realNow(); let offset = 0, connects = 0, sends = 0, destroyed = 0, clockReads = 0;
    Date.now = () => realNow() + offset;
    try {
      const run = createProviderEngine({ repo: resolve("."), spawn, now() {
        const current = Date.now();
        // Engine's last clock sample is fresh; private HTTP sees an expired proof.
        if (phase === "dispatch" && ++clockReads === 3) offset = 61001;
        return current;
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
        return req;
      } });
      if (phase === "fresh") {
        assert.equal((await run(args, 120000, false, start + 60000)).status, 0);
        assert.equal(sends, 1); assert.equal(connects, 1);
      } else {
        await assert.rejects(run(args, 120000, false, start + 60000));
        assert.equal(sends, 0); assert.equal(connects, phase === "end" ? 1 : 0);
        assert.equal(destroyed, connects);
        if (phase === "dispatch") assert.equal(clockReads, 3);
      }
    } finally { Date.now = realNow; }
  }
});
