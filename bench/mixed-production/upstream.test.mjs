import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { records as fixture } from "../marketplace/fixtures.mjs";
import { control, sleep } from "./capture.mjs";
import { mixedUpstream } from "./upstream.mjs";

test("real delayed upstream counts completion, cancellation, and leaks independently across operations", async () => {
  const server = mixedUpstream({ item_1: fixture().item_1 }, "local-test-secret");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/__mixed/control`, { method: "POST", body: JSON.stringify({ id: "bad", mode: "normal", delayMs: 0 }) });
    assert.equal(denied.status, 403);
    await control(base, "local-test-secret", "complete", { mode: "complete", delayMs: 30 });
    const r = await fetch(`${base}/marketplace/records/item_1`); assert.equal(r.status, 200); await r.arrayBuffer();
    let observed = await control(base, "local-test-secret", "complete");
    assert.equal(observed.requests, 1); assert.equal(observed.completed, 1); assert.equal(observed.cancelled, 0);
    await control(base, "local-test-secret", "cancel", { mode: "cancel", delayMs: 1000 });
    const pending = httpRequest(`${base}/marketplace/records/item_1`); pending.on("error", () => {}); pending.end();
    for (let n = 0; n < 100; n++) { observed = await control(base, "local-test-secret", "cancel"); if (observed.requests) break; await sleep(5); }
    assert.equal(observed.pending, 1); assert.equal(observed.cancelled, 0);
    await control(base, "local-test-secret", "next", { mode: "normal", delayMs: 0 });
    // Starting a new operation must not destroy old work and manufacture cancellation.
    assert.equal((await control(base, "local-test-secret", "cancel")).pending, 1);
    pending.destroy();
    for (let n = 0; n < 100; n++) { observed = await control(base, "local-test-secret", "cancel"); if (!observed.pending) break; await sleep(5); }
    assert.equal(observed.cancelled, 1); assert.equal(observed.completed, 0); assert.equal(observed.pending, 0);
    assert.equal((await control(base, "local-test-secret", "next")).requests, 0);
    await assert.rejects(control(base, "local-test-secret", "next", { mode: "normal", delayMs: 0 }), /unavailable/);
    await assert.rejects(control(base, "local-test-secret", "negative", { mode: "complete", delayMs: -1 }), /unavailable/);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
