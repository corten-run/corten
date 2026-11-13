import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { catalogServer } from "../../catalog/upstream.mjs";
import { marketplaceServer } from "../../marketplace/upstream.mjs";
import { checkJsonApp } from "../../workloads/json-check.mjs";

export async function waitFor(check, message, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error(message);
}
export async function upstream(records, observe) {
  const originals = { catalog: catalogServer(records.catalog), marketplace: marketplaceServer(records.marketplace) };
  let fault = null, reads = 0, requests = 0, unavailable = false;
  const calls = [], held = new Set();
  const server = createServer((req, res) => {
    requests++;
    const match = /^\/(catalog|marketplace)\/records\/([^/?]+)/.exec(req.url);
    if (match) reads++;
    if (unavailable) {
      observe({ kind: "fixture-upstream-attempt", path: req.url, method: req.method, status: 503 });
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end('{"error":"fixture upstream unavailable"}');
    }
    if (!fault || !match) return originals[req.url.includes("marketplace") ? "marketplace" : "catalog"].emit("request", req, res);
    const call = { path: req.url, closed: false }; calls.push(call);
    res.once("close", () => { call.closed = true; held.delete(res); observe({ kind: "fault-upstream-closed", path: req.url }); });
    observe({ kind: "fault-upstream-read", path: req.url, fault: fault.name });
    if (["headers", "body"].includes(fault.name)) {
      req.socket.setTimeout(0); held.add(res);
      if (fault.name === "body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"id":'); }
      return;
    }
    res.writeHead(fault.status ?? 200, { "Content-Type": "application/json", ...(fault.status === 302 ? { Location: "/catalog/records/record_2" } : {}) });
    res.end(fault.body ?? "{}");
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, calls,
    reads: () => reads,
    requests: () => requests,
    unavailable(value) { const previous = unavailable; unavailable = value; return previous; },
    fault(value) { fault = value; for (const response of held) response.destroy(); held.clear(); },
    async close() { for (const response of held) response.destroy(); server.closeAllConnections(); await new Promise((done) => server.close(done)); for (const original of Object.values(originals)) original.closeAllConnections(); },
  };
}
export async function fixtureIndependent(api, observe, scope, action) {
  const before = api.requests(), previous = api.unavailable(true);
  try { return await action(); }
  finally {
    api.unavailable(previous);
    const attempts = api.requests() - before;
    observe({ kind: "fixture-source-independence", scope, upstreamStatus: 503, attempts });
    assert.equal(attempts, 0, "fixture check contacted upstream while unavailable");
  }
}
export async function read(base, path, observe, { method = "GET", headers = {}, body, timeout = 14000 } = {}) {
  const response = await fetch(base + path, { method, headers: { "accept-encoding": "identity", ...headers }, body, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  const result = { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  const redact = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, /^(set-cookie|cookie)$/i.test(key)
    ? value.replace(/\b[a-f0-9]{64}\b/g, (token) => `sha256:${createHash("sha256").update(token).digest("hex")}`) : value]));
  observe({ kind: "http", method, path, requestHeaders: redact(headers), requestBody: body ?? null, bodyEncoding: "utf8-after-fetch-decompression", ...result, headers: redact(result.headers) });
  return result;
}
export function requireJsonError(response, status) {
  if (status !== undefined) assert.equal(response.status, status);
  else assert.ok(response.status >= 500 && response.status < 600, "bad upstream data must not be accepted");
  assert.match(response.headers["content-type"] ?? "", /^application\/(?:problem\+)?json\b/);
  assert.equal(response.headers["cache-control"], "no-store");
  JSON.parse(response.body); assert.ok(!response.body.includes("private fault marker"), "upstream detail leaked");
}
export function invalidRecords(kind, record) {
  const changed = (modify) => { const copy = structuredClone(record); modify(copy); return JSON.stringify(copy); };
  return {
    malformed: "{invalid", incomplete: "{}",
    "wrong-id": changed((r) => r.id = kind === "catalog" ? "record_2" : "item_2"),
    "unknown-key": changed((r) => r.unexpected = "not in contract"),
    "wrong-type": changed((r) => r.title = 17),
    "lone-surrogate": changed((r) => r.title = "\ud800"),
    ...(kind === "marketplace" ? {
      "rating-out-of-range": changed((r) => r.listings[0].rating_hundredths = 501),
      "negative-count": changed((r) => r.listings[0].quantity = -1),
      "duplicate-row-id": changed((r) => r.listings[1].id = r.listings[0].id),
    } : {}),
  };
}
export async function checkHttp({ base, source, profile, records, upstream: api, observe, test }) {
  for (const kind of ["catalog", "marketplace"]) {
    const id = kind === "catalog" ? "record_1" : "item_1", path = `/api/${kind}/${id}`;
    await test(`${kind}/all-500-json-and-source`, async () => {
      const action = () => checkJsonApp({ payload: kind === "catalog" ? "catalog-v1" : "marketplace-v2", base, records: records[kind], source, upstream: api.url, observe });
      return source === "fixture" ? fixtureIndependent(api, observe, `${kind}/json`, action) : action();
    });
    await test(`${kind}/headers-head-method-errors`, async () => {
      const success = await read(base, path, observe); assert.equal(success.status, 200); assert.equal(success.headers["cache-control"], "no-store");
      const head = await read(base, path, observe, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body, "");
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const before = api.reads(), response = await read(base, path, observe, { method }); requireJsonError(response, 405);
        assert.equal(response.headers.allow, "GET, HEAD"); assert.equal(api.reads(), before, "rejected method fetched a record");
      }
      for (const alias of [`/API/${kind}/%ZZ`, `/api/${kind}/missing`]) requireJsonError(await read(base, alias, observe), alias.endsWith("%ZZ") ? 400 : 404);
    });
    if (source === "api") {
      for (const [name, body] of Object.entries(invalidRecords(kind, records[kind][id]))) await test(`${kind}/reject-${name}`, async () => {
        api.fault({ name, body });
        try { requireJsonError(await read(base, path, observe)); } finally { api.fault(null); }
      });
      for (const status of [302, 503]) await test(`${kind}/page-json-upstream-${status}`, async () => {
        api.fault({ name: "status", status, body: '{"error":"private fault marker"}' });
        try {
          for (const route of [path, kind === "catalog" ? `/catalog/${id}` : `/marketplace/en-US/${id}`]) {
            const before = api.reads(), response = await read(base, route, observe);
            assert.ok(response.status >= 500 && response.status < 600); assert.equal(api.reads(), before + 1, "redirect followed or read count differs");
            assert.ok(!response.body.includes("private fault marker"));
            if (route === path) requireJsonError(response);
          }
        } finally { api.fault(null); }
      });
      for (const phase of ["headers", "body"]) {
        await test(`${kind}/${phase}/caller-disconnect`, async () => {
          api.fault({ name: phase }); const before = api.calls.length;
          const pending = request(base + path); pending.on("error", () => {}); pending.end();
          try {
            await waitFor(() => api.calls.length > before, "request did not reach source");
            await delay(100); pending.destroy();
            await waitFor(() => api.calls[before].closed, "caller disconnect did not close upstream");
          } finally { pending.destroy(); api.fault(null); }
        });
        await test(`${kind}/${phase}/whole-read-deadline`, async () => {
          api.fault({ name: phase }); const before = api.calls.length, started = performance.now();
          try {
            requireJsonError(await read(base, path, observe));
            const elapsedMs = performance.now() - started;
            assert.ok(elapsedMs >= 9000 && elapsedMs < 13500, "whole-read deadline must expire near ten seconds");
            observe({ kind: "deadline", workload: kind, phase, elapsedMs });
            assert.equal(api.calls.length, before + 1);
            await waitFor(() => api.calls[before].closed, "deadline did not close upstream");
          } finally { api.fault(null); }
        });
      }
      await test(`${kind}/recovery`, async () => assert.deepEqual(JSON.parse((await read(base, path, observe)).body), records[kind][id]));
    }
  }
  await test("native-form-cross-site-and-errors", async () => {
    const path = "/marketplace/en-US/item_1", body = "email=test%40example.test&target_price=12.34";
    for (const headers of [{ origin: "https://other.invalid" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }]) {
      const before = api.reads(), response = await read(base, path, observe, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
      assert.equal(response.status, 403); assert.equal(api.reads(), before, "cross-site write fetched source data");
    }
    assert.equal((await read(base, path, observe, { method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body })).status, 200);
    assert.equal((await read(base, "/marketplace/es-ES/item_1", observe)).status, 400);
    assert.equal((await read(base, "/catalog/missing", observe)).status, 404);
    assert.equal((await read(base, "/marketplace/en-US/missing", observe)).status, 404);
  });
  await test("production-profile-cache-security-compression", async () => {
    const page = await read(base, "/catalog/record_1", observe);
    assert.equal(page.status, 200); assert.equal(page.headers["x-powered-by"], undefined);
    if (profile === "matched") {
      assert.equal(page.headers["cache-control"], "private, no-cache");
      assert.equal(page.headers["x-content-type-options"], "nosniff");
      assert.ok(page.headers["content-security-policy"]?.includes("form-action 'self'"));
      for (const encoding of ["br", "gzip"]) {
        const compressed = await read(base, "/api/marketplace/item_1", observe, { headers: { "accept-encoding": encoding } });
        assert.equal(compressed.headers["content-encoding"], encoding);
        assert.match(compressed.headers.vary ?? "", /accept-encoding/i);
        assert.deepEqual(JSON.parse(compressed.body), records.marketplace.item_1);
      }
    } else assert.equal(page.headers["content-security-policy"], undefined, "default profile unexpectedly replaced");
  });
}
