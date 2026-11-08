import assert from "node:assert/strict";
import test from "node:test";
import { marketplaceServer } from "./upstream.mjs";
import { records } from "./fixtures.mjs";
test("private upstream serves canonical records and exposes uncached-read/error probes", async () => {
  const data = records(), server = marketplaceServer(data);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const control = (value) => fetch(`${base}/__marketplace/control`, { method: "POST", body: JSON.stringify(value) });
  try {
    assert.deepEqual(await (await fetch(`${base}/marketplace/records/item_1`)).json(), data.item_1);
    const changed = { ...data.item_1, title: "New upstream title" };
    assert.equal((await control({ record: changed, pretty: true })).status, 200);
    assert.equal(await (await fetch(`${base}/marketplace/records/item_1`)).text(), JSON.stringify(changed, null, 2));
    assert.deepEqual((await (await fetch(`${base}/__marketplace/control`)).json()).requests, { item_1: 1 });
    await control({ status: 503 });
    assert.equal((await fetch(`${base}/marketplace/records/item_1`)).status, 503);
    await control({ status: 302 });
    const redirected = await fetch(`${base}/marketplace/records/item_1`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), "/marketplace/records/item_2");
    assert.deepEqual((await (await fetch(`${base}/__marketplace/control`)).json()).requests, { item_1: 1 });
    await control({});
    assert.equal((await fetch(`${base}/marketplace/records/item_501`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
