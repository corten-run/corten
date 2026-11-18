import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { catalogServer } from "../catalog/upstream.mjs";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { payloads } from "./contract.mjs";
import "./upstream-observer.mjs";

test("actual upstream controls distinguish completed 200/503, hanging and aborted record responses", async () => {
  for (const [payload, factory] of [["catalog-v1", catalogServer], ["marketplace-v2", marketplaceServer]]) {
    const p = payloads[payload], server = factory(p.records());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`, control = `${base}/__${p.path}/control`, record = `${base}/${p.path}/records/${p.first}`;
    const reset = async (body) => { const r = await fetch(control, { method: "POST", body: JSON.stringify(body) }); assert.equal(r.status, 200); await r.text(); };
    const sample = async () => {
      const r = await fetch(control), { requests, status } = await r.json();
      return { requests, status, ...JSON.parse(r.headers.get("X-Json-Bench-Responses")) };
    };
    const until = async (predicate) => {
      for (let i = 0; i < 100; i++) { const value = await sample(); if (predicate(value)) return value; await delay(10); }
      assert.fail("upstream did not reach expected observation");
    };
    try {
      for (const status of [200, 503]) {
        await reset({ status }); assert.deepEqual(await sample(), { requests: {}, status, completed: {}, aborted: 0 });
        const r = await fetch(record); assert.equal(r.status, status); await r.text();
        assert.deepEqual(await sample(), { requests: { [p.first]: 1 }, status, completed: { [status]: 1 }, aborted: 0 });
      }
      if (payload === "marketplace-v2") {
        await reset({ hang: true }); const abort = new AbortController();
        const request = assert.rejects(fetch(record, { signal: abort.signal }), { name: "AbortError" });
        try { const pending = await until((o) => o.requests[p.first] === 1);
          assert.deepEqual(pending.completed, {}); assert.equal(pending.aborted, 0);
        } finally { abort.abort(); await request; }
        const cancelled = await until((o) => o.aborted === 1); assert.deepEqual(cancelled.completed, {});
      }
    } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
  }
});
