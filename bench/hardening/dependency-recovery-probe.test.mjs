import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { records } from "../marketplace/fixtures.mjs";
import { assessRecovery, recoveryProfile } from "./dependency-recovery-contract.mjs";
import { dependencyRecoveryServer } from "./dependency-recovery-upstream.mjs";
import { runRecovery, validRecord } from "./dependency-recovery-probe.mjs";

async function listen(server, t) {
  const listening = once(server, "listening"); server.listen(0, "127.0.0.1"); await listening;
  t.after(async () => {
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
  });
  return "http://127.0.0.1:" + server.address().port;
}

test("partial, malformed, oversized, non-JSON and wrong records never count as successes", () => {
  const expected = { value: 1 }, receipt = { status: 200, contentType: "application/json; charset=utf-8",
    complete: true, error: null, bodyBase64: Buffer.from(JSON.stringify(expected)).toString("base64") };
  assert.ok(validRecord(receipt, expected));
  for (const edit of [{ status: 503 }, { complete: false }, { error: "deadline" }, { bodyBase64: "%%%" },
    { contentType: "text/plain" }, { bodyBase64: "e30=" }, { bodyBase64: "A".repeat(100000) }]) {
    assert.equal(validRecord({ ...receipt, ...edit }, expected), false);
  }
});

// Real time, HTTP and full record validation, without a cloud host. The app is a
// test double, not a framework adapter; no number from this test is publishable.
test("the API path experiences the delay; the fixture path makes no upstream reads", { timeout: 60000 }, async t => {
  const catalog = records(), item = catalog.item_1;
  const lanes = [];
  for (const source of ["fixture", "api"]) {
    const apparatus = dependencyRecoveryServer(catalog), upstream = await listen(apparatus.server, t);
    const target = await listen(createServer(async (_req, res) => {
      try {
        const record = source === "fixture" ? item : await (await fetch(upstream + "/marketplace/records/item_1")).json();
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(record));
      } catch { res.writeHead(503); res.end(); }
    }), t);
    lanes.push({ source, target, upstream, apparatus });
  }
  const results = await Promise.allSettled(lanes.map(async ({ source, target, upstream, apparatus }) => {
    const rows = [];
    await runRecovery({ phase: "dependency-recovery", source, upstream, target: { origin: target },
      expected: item, budget: { dependencyRecovery: recoveryProfile } }, {
      clock: () => ({ monotonicNs: String(process.hrtime.bigint()), bootId: "test" }),
      trigger: () => assert.ok(apparatus.start()), emit: row => rows.push(row), sample: () => ({}),
    });
    const evidence = rows.at(-1), result = assessRecovery(evidence.samples, { source, restoredAtMs: evidence.restoredAtMs });
    assert.equal(result.status, source === "api" ? "recovered" : "fixture-control", JSON.stringify(result));
    assert.equal(rows.filter(r => r.type === "resources").length, 3);
    const counters = Object.values(evidence.upstream.after.responses200);
    if (source === "api") {
      assert.ok(counters.every(n => n > 0)); assert.equal(counters.reduce((a,b) => a+b, 0), evidence.samples.length);
      assert.ok(result.windows.during.p95Ms >= recoveryProfile.delayMs);
    } else assert.deepEqual(counters, [0,0,0]);
  }));
  for (const r of results) if (r.status === "rejected") throw r.reason;
});
