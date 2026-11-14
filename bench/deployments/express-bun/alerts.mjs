import assert from "node:assert/strict";
import { read } from "./checks.mjs";

export function verifyAlertRows(value, expected) {
  assert.ok(Array.isArray(value), "alert readback must be an array");
  for (const row of value) {
    assert.deepEqual(Object.keys(row).sort(), ["email", "item_id", "target_minor"]);
    assert.equal(typeof row.item_id, "string"); assert.equal(typeof row.email, "string");
    assert.ok(Number.isSafeInteger(row.target_minor) && row.target_minor > 0);
  }
  assert.deepEqual(value, expected, "persisted accepted writes differ from independent readback");
}
export async function checkAlerts({ base, source, upstream, observe, test }) {
  await test("persisted-alerts/http-session-and-rejections", async () => {
    const expected = [], supplied = "marketplace-alerts=" + "1".repeat(64);
    let cookie = "";
    const readback = async (session = cookie) => {
      const before = upstream.reads(), response = await read(base, "/api/alerts", observe, { headers: session ? { cookie: session } : {} });
      assert.equal(response.status, 200); assert.match(response.headers["content-type"], /^application\/json\b/);
      assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.headers["set-cookie"], undefined);
      assert.equal(upstream.reads(), before, "independent alert readback must not fetch records");
      return JSON.parse(response.body);
    };
    const post = (locale, email, target, options = {}) => read(base, `/marketplace/${locale}/${options.id ?? "item_1"}`, observe, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie: options.cookie ?? cookie, ...options.headers },
      body: new URLSearchParams({ email, target_price: target }).toString(),
    });
    verifyAlertRows(await readback(), []); verifyAlertRows(await readback(supplied), []);
    for (const [locale, target, minor] of [["en-US", "12.34", 1234], ["fr-FR", "23,45", 2345], ["de-DE", "34,56", 3456]]) {
      const response = await post(locale, `${locale}@example.test`, target, { cookie: cookie || supplied });
      assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
      if (!cookie) {
        assert.match(response.headers["set-cookie"], /HttpOnly/i); assert.match(response.headers["set-cookie"], /SameSite=Lax/i);
        assert.ok(!/\bDomain=/i.test(response.headers["set-cookie"]));
        cookie = response.headers["set-cookie"].split(";")[0]; assert.notEqual(cookie, supplied, "caller-chosen session was adopted");
      }
      expected.push({ item_id: "item_1", email: `${locale}@example.test`, target_minor: minor });
      verifyAlertRows(await readback(), expected);
    }
    for (const [locale, email, target, options, status] of [
      ["en-US", "bad", "1", {}, 200], ["fr-FR", "ok@example.test", "0", {}, 200],
      ["es-ES", "ok@example.test", "1", {}, 400], ["en-US", "ok@example.test", "1", { id: "missing" }, 404],
      ["en-US", "ok@example.test", "1", { headers: { origin: "https://other.invalid" } }, 403],
      ["en-US", "ok@example.test", "1", { headers: { "sec-fetch-site": "cross-site" } }, 403],
    ]) {
      assert.equal((await post(locale, email, target, options)).status, status);
      verifyAlertRows(await readback(), expected);
    }
    if (source === "api") {
      upstream.fault({ name: "rejected-write-source", status: 503 });
      try { const response = await post("en-US", "ok@example.test", "1"); assert.ok(response.status >= 500 && response.status < 600); }
      finally { upstream.fault(null); }
      verifyAlertRows(await readback(), expected);
    }
    const concurrent = Array.from({ length: 4 }, (_, index) => ({ item_id: "item_1", email: `parallel-${index}@example.test`, target_minor: 100 + index }));
    const replies = await Promise.all(concurrent.map((row) => post("en-US", row.email, (row.target_minor / 100).toFixed(2))));
    for (const response of replies) assert.equal(response.status, 200);
    const rows = await readback(); verifyAlertRows(rows.slice(0, expected.length), expected);
    verifyAlertRows(rows.slice(expected.length).sort((a, b) => a.email.localeCompare(b.email)), concurrent);
    verifyAlertRows(await readback(), rows); verifyAlertRows(await readback(""), []); verifyAlertRows(await readback(supplied), []);
    const other = await post("en-US", "isolated@example.test", "1", { cookie: "" });
    assert.equal(other.status, 200); const otherCookie = other.headers["set-cookie"].split(";")[0];
    assert.notEqual(otherCookie, cookie); verifyAlertRows(await readback(otherCookie), [{ item_id: "item_1", email: "isolated@example.test", target_minor: 100 }]);
    verifyAlertRows(await readback(), rows);
    return { locales: ["en-US", "fr-FR", "de-DE"], acceptedRows: rows.length, simultaneousExistingSessionPosts: 4, sessionIsolation: true, invalidWritesDidNotAppend: true };
  });
}
