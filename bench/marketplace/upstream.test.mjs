import assert from "node:assert/strict";
import test from "node:test";
import { marketplaceServer } from "./upstream.mjs";
import { records } from "./fixtures.mjs";

test("qualification can hang a record beyond the normal socket timeout, then reset and recover", { timeout: 15000 }, async () => {
  const server = marketplaceServer(records());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const control = (value) => fetch(`${base}/__marketplace/control`, { method: "POST", body: JSON.stringify(value) });
  try {
    assert.equal((await control({ hang: "true" })).status, 400);
    assert.equal((await control({ hang: true })).status, 200);
    let settled = false;
    const pending = fetch(`${base}/marketplace/records/item_1`, { signal: AbortSignal.timeout(10000) }).then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5500));
    assert.equal(settled, false, "the normal five-second socket timeout must not answer the hung-upstream probe");
    assert.equal((await control({})).status, 200);
    await pending;
    assert.equal((await fetch(`${base}/marketplace/records/item_1`)).status, 200);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
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
    assert.deepEqual((await (await fetch(`${base}/__marketplace/control`)).json()).answers, { 302: 1 });
    await control({});
    assert.equal((await fetch(`${base}/marketplace/records/item_501`)).status, 404);
    assert.equal((await fetch(`${base}/marketplace/records/item_2`)).status, 200);
    // what a run reads around each phase: answers to record reads by status
    assert.deepEqual((await (await fetch(`${base}/__marketplace/control`)).json()).answers, { 200: 1, 404: 1 });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
