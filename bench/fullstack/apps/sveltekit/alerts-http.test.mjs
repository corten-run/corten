// Run against this app's production server: ALERTS_BASE_URL=http://127.0.0.1:<port> node --test alerts-http.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const base = process.env.ALERTS_BASE_URL;
assert.ok(base, "ALERTS_BASE_URL must identify the native server under test");
const origin = process.env.ALERTS_ORIGIN ?? base;
function client() {
  const jar = new Map();
  return async (path, options = {}) => {
    const response = await fetch(new URL(path, base), { ...options, redirect: "manual",
      headers: { Accept: "text/html", Cookie: [...jar].map(([name, value]) => name + "=" + value).join("; "), ...options.headers },
      signal: AbortSignal.timeout(15000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0], equals = pair.indexOf("=");
      jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  };
}
test("native HTTP alerts: accepted writes, independent reads, rejected writes, ordering and session isolation", { timeout: 60000 }, async () => {
  const a = client(), b = client();
  let response = await a("/api/alerts");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const cookie = response.headers.getSetCookie().join(";");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//i);
  assert.match(cookie, /=([a-f0-9]{64});/);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(await (await b("/api/alerts")).json(), []);
  const expected = [];
  for (const locale of ["en-US", "fr-FR", "de-DE"]) {
    const post = (email, target_price, path = `/marketplace/${locale}/item_1`, headers = {}) => a(path, {
      method: "POST", headers: { Origin: origin, ...headers }, body: new URLSearchParams({ email, target_price }),
    });
    response = await post("native@example.test", locale === "en-US" ? "1234.50" : "1234,50");
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok((await response.text()).includes("native@example.test"));
    expected.push({ item_id: "item_1", email: "native@example.test", target_minor: 123450 });
    assert.deepEqual(await (await a("/api/alerts")).json(), expected);
    assert.deepEqual(await (await a("/api/alerts")).json(), expected, "GET must not consume or reset alerts");
    for (const [email, target] of [["bad", "1"], ["native@example.test", "0"], ["native@example.test", "not-a-price"], ["", ""]]) {
      response = await post(email, target);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.deepEqual(await (await a("/api/alerts")).json(), expected, "invalid form must not mutate");
    }
    for (const headers of [{ Origin: "https://attacker.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
      response = await post("native@example.test", "1", undefined, headers);
      assert.equal(response.status, 403);
      await response.arrayBuffer();
    }
    response = await post("native@example.test", "1", `/marketplace/${locale}/missing`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
    assert.deepEqual(await (await a("/api/alerts")).json(), expected);
    assert.deepEqual(await (await b("/api/alerts")).json(), []);
  }
  const parallel = await Promise.all(Array.from({ length: 12 }, (_, i) => a("/marketplace/en-US/item_1", {
    method: "POST", headers: { Origin: origin },
    body: new URLSearchParams({ email: `parallel${i}@example.test`, target_price: "1.25" }),
  })));
  for (const response of parallel) {
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const rows = await (await a("/api/alerts")).json();
  assert.deepEqual(rows.slice(0, expected.length), expected);
  assert.equal(rows.length, expected.length + 12);
  assert.deepEqual(rows.slice(expected.length).map((row) => row.email).sort(),
    Array.from({ length: 12 }, (_, i) => `parallel${i}@example.test`).sort());
  assert.ok(rows.slice(expected.length).every((row) => row.target_minor === 125 && row.item_id === "item_1"));
  assert.deepEqual(await (await b("/api/alerts")).json(), []);
  const fresh = client();
  assert.deepEqual(await (await fresh("/api/alerts")).json(), []);
  const firstPost = client();
  response = await firstPost("/marketplace/en-US/item_1", {
    method: "POST", headers: { Origin: origin },
    body: new URLSearchParams({ email: "first-post@example.test", target_price: "0.01" }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(await (await firstPost("/api/alerts")).json(),
    [{ item_id: "item_1", email: "first-post@example.test", target_minor: 1 }]);
  response = await a("/marketplace/es-ES/item_1", {
    method: "POST", headers: { Origin: origin },
    body: new URLSearchParams({ email: "native@example.test", target_price: "1" }),
  });
  assert.equal(response.status, 400);
  await response.arrayBuffer();
  assert.deepEqual(await (await a("/api/alerts")).json(), rows);
  response = await b("/marketplace/de-DE/item_2", {
    method: "POST", headers: { Origin: origin },
    body: new URLSearchParams({ email: "other@example.test", target_price: "2,50" }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(await (await b("/api/alerts")).json(), [{ item_id: "item_2", email: "other@example.test", target_minor: 250 }]);
  assert.deepEqual(await (await a("/api/alerts")).json(), rows);
});
