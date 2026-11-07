import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { records } from "./fixtures.mjs";
import { catalogServer } from "./upstream.mjs";
import { control, get } from "./check.mjs";
import { first200 } from "./cold.mjs";

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
