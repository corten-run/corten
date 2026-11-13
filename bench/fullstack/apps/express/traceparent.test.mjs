import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { traceParent } from "./lib/traceparent.mjs";

test("traceparent validates known fields without retaining a previous context", () => {
  const valid = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-00";
  assert.equal(traceParent(valid), valid);
  assert.equal(traceParent(`01${valid.slice(2)}-future`), valid);
  for (const invalid of [undefined, "bad", valid.toUpperCase(), `ff${valid.slice(2)}`,
    valid.replace("0123456789abcdef0123456789abcdef", "0".repeat(32)),
    valid.replace("-0123456789abcdef-", `-${"0".repeat(16)}-`), valid.replaceAll("-", "_"),
    `${valid}-extra`, `${valid}, ${valid}`]) {
    assert.equal(traceParent(invalid), undefined);
    assert.equal(traceParent(undefined), undefined);
  }
});

test("a delayed native source call retains its explicit context after another completes", async () => {
  const record = { id: "item_1", title: "Trace", subtitle: null, description: "", categories: [],
    badges: [], tags: [], images: [], fields: [], summary: null, listings: [], offers: [], contents: [], included_in: [] };
  const parents = [];
  const server = createServer((req, res) => {
    parents.push(req.headers.traceparent);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(record));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const original = process.env.API_BASE;
  try {
    process.env.API_BASE = `http://127.0.0.1:${server.address().port}`;
    const { fetchMarketplaceRecord } = await import("./lib/marketplace.mjs");
    const a = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa-00";
    const b = "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bbbbbbbbbbbbbbbb-00";
    const captured = Object.freeze({ traceparent: a });
    const delayed = () => fetchMarketplaceRecord("late", captured);
    await fetchMarketplaceRecord("current", { traceparent: b });
    await delayed();
    await fetchMarketplaceRecord("invalid", { traceparent: "bad" });
    await fetchMarketplaceRecord("untraced");
    assert.deepEqual(parents, [b, a, undefined, undefined]);
  } finally {
    if (original === undefined) delete process.env.API_BASE;
    else process.env.API_BASE = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
