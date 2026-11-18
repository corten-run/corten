import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { records } from "./fixtures.mjs";
import { catalogServer } from "./upstream.mjs";
import { control, get } from "./check.mjs";
import { first200 } from "./cold.mjs";

test("ordinary upstream reads reuse encoded bytes without an asynchronous handler", () => {
  const catalog = records(), server = catalogServer(catalog);
  const handler = server.listeners("request")[0], bodies = [];
  const response = { writeHead(code, headers) {
    assert.equal(code, 200);
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Cache-Control"], "no-store");
  }, end(body) { bodies.push(body); } };
  for (let i = 0; i < 2; i++)
    assert.equal(handler({ method: "GET", url: "/catalog/records/record_1" }, response), undefined);
  assert.ok(Buffer.isBuffer(bodies[0]), "record bytes must be encoded before request handling");
  assert.equal(bodies[0], bodies[1], "unchanged record reads must reuse the same encoded bytes");
  assert.equal(bodies[0].toString("utf8"), JSON.stringify(catalog.record_1));
});

test("upstream canonical-read shortcut preserves URL parsing, methods and control state", async () => {
  const catalog = records(), server = catalogServer(catalog);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = (path, options) => fetch(base + path, options);
  const state = async () => JSON.parse((await get(`${base}/__catalog/control`)).body);
  try {
    for (const path of ["/catalog/records/record_1", "/catalog/records/record_1?x=1", "/catalog/records/./record_1"]) {
      const response = await read(path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), JSON.stringify(catalog.record_1));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("content-type"), "application/json");
    }
    for (const path of ["/catalog/records/record_01", "/catalog/records/record_1/", "/catalog/records/record_%31"])
      assert.equal((await read(path)).status, 404);
    assert.equal((await read("/catalog/records/record_1", { method: "POST" })).status, 404);
    assert.equal((await read("/catalog/records/record_501")).status, 404);
    assert.deepEqual((await state()).requests, { record_1: 3, record_501: 1 });
    const changed = { ...catalog.record_1, title: "Changed caf\u00e9 \ud83c\udf32" };
    await control(base, { record: changed, pretty: true });
    for (const suffix of ["", "?uncached=1"])
      assert.equal((await get(`${base}/catalog/records/record_1${suffix}`)).body, JSON.stringify(changed, null, 2));
    await control(base, { status: 503 });
    for (const suffix of ["", "?error=1"]) assert.equal((await get(`${base}/catalog/records/record_1${suffix}`)).status, 503);
    await control(base, {});
    assert.deepEqual((await state()).requests, {});
    assert.equal((await get(`${base}/catalog/records/record_1`)).body, JSON.stringify(catalog.record_1));
  } finally { server.close(); server.closeAllConnections(); await once(server, "close"); }
});

test("upstream serves raw records, all 500 IDs, strict paths/404s and controlled uncached/error probes", async () => {
  const catalog = records();
  const server = catalogServer(catalog);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const id of Object.keys(catalog)) {
      const response = await get(`${base}/catalog/records/${id}`);
      assert.equal(response.status, 200);
      assert.equal(response.body, JSON.stringify(catalog[id]));
    }
    for (const path of ["/catalog/records/record_501", "/catalog/records/record_1/extra", "/items/item_1", "/catalog/records/does-not-exist"]) assert.equal((await get(base + path)).status, 404);
    const record = { ...catalog.record_1, title: "changed" };
    await control(base, { record, pretty: true });
    assert.equal((await get(`${base}/catalog/records/record_1`)).body, JSON.stringify(record, null, 2));
    assert.deepEqual(JSON.parse((await get(`${base}/__catalog/control`)).body).requests, { record_1: 1 });
    await control(base, { status: 503 });
    assert.equal((await get(`${base}/catalog/records/record_1`)).status, 503);
    await control(base, {});
    assert.deepEqual(JSON.parse((await get(`${base}/catalog/records/record_1`)).body), catalog.record_1);
    const cold = await first200(base, "/catalog/records/record_1", 1);
    assert.equal(cold.attempts, 1);
    assert.ok(cold.bytes > 0);
    const started = Date.now();
    await assert.rejects(first200(base, "/missing", 0.03), /no first 200/);
    assert.ok(Date.now() - started < 1000);
  } finally { server.close(); server.closeAllConnections(); await once(server, "close"); }
});
