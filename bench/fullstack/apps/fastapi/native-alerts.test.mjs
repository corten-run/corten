// Functional HTTP/browser checks, not a throughput benchmark.
// ALERT_BASE_URL=http://127.0.0.1:8080 ALERT_FRAMEWORK=fastapi node --test native-alerts.test.mjs
// Serve item_1 from Django's marketplace_test_fixture.json and the legacy fixture below.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { chromium, request } = createRequire(import.meta.url)("playwright");
const baseURL = process.env.ALERT_BASE_URL;
const framework = process.env.ALERT_FRAMEWORK;
assert.ok(baseURL, "ALERT_BASE_URL is required");
assert.ok(["fastapi", "django", "spring"].includes(framework), "ALERT_FRAMEWORK is required");
const path = "/marketplace/en-US/item_1";

async function read(client) {
  const response = await client.get("/api/alerts");
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-type"], /application\/json/);
  assert.match(response.headers()["cache-control"], /no-store/);
  return response.json();
}

async function csrf(client) {
  const response = await client.get(path);
  assert.equal(response.status(), 200);
  const html = await response.text();
  const token = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/);
  if (framework === "django") assert.ok(token, "native CSRF form field");
  return token ? { csrfmiddlewaretoken: token[1] } : {};
}

test(`${framework}: real HTTP session writes and independent reads`, { timeout: 120000 }, async () => {
  const client = await request.newContext({ baseURL, timeout: 10000 });
  const other = await request.newContext({ baseURL, timeout: 10000 });
  try {
    assert.deepEqual(await read(client), []);
    assert.deepEqual(await read(other), []);
    const token = await csrf(client);
    const expected = [];
    for (const [locale, target, minor] of [["en-US", "12.505", 1251], ["fr-FR", "1,25", 125], ["de-DE", "2,50", 250]]) {
      const response = await client.post(`/marketplace/${locale}/item_1`, {
        form: { ...token, email: `${locale}@example.test`, target_price: target },
      });
      assert.equal(response.status(), 200);
      expected.push({ item_id: "item_1", email: `${locale}@example.test`, target_minor: minor });
      assert.deepEqual(await read(client), expected);
    }
    const cookies = (await client.storageState()).cookies;
    const cookie = cookies.find(c => c.name === ({ django: "sessionid", fastapi: "marketplace_session", spring: "JSESSIONID" })[framework]);
    assert.ok(cookie && cookie.value.length >= 24, "native/random session cookie");
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
    const forged = await request.newContext({ baseURL, timeout: 10000, storageState: {
      cookies: [{ ...cookie, value: "x".repeat(32) }], origins: [],
    } });
    try {
      assert.deepEqual(await read(forged), []);
      const forgedToken = await csrf(forged);
      assert.equal((await forged.post(path, { form: { ...forgedToken, email: "forged@example.test", target_price: "5" } })).status(), 200);
      const issued = (await forged.storageState()).cookies.find(c => c.name === cookie.name);
      assert.ok(issued && issued.value !== "x".repeat(32), "unknown token must be replaced");
      assert.deepEqual(await read(forged), [{ item_id: "item_1", email: "forged@example.test", target_minor: 500 }]);
      assert.deepEqual(await read(client), expected);
    } finally { await forged.dispose(); }
    for (const form of [{}, { email: "bad", target_price: "1" }, { email: "a@b", target_price: "NaN" }, { email: "a@b", target_price: "0" }, { email: "a@b", target_price: "999999999999999999999999999999" }]) {
      const response = await client.post(path, { form: { ...token, ...form } });
      assert.equal(response.status(), 200);
      assert.deepEqual(await read(client), expected);
    }
    const good = { ...token, email: "reject@example.test", target_price: "2" };
    assert.equal((await client.post("/marketplace/en-US/missing", { form: good })).status(), 404);
    assert.equal((await client.post("/marketplace/es-ES/item_1", { form: good })).status(), 400);
    for (const headers of [{ Origin: "http://attacker.invalid" }, { "Sec-Fetch-Site": "cross-site" }])
      assert.equal((await client.post(path, { form: good, headers })).status(), 403);
    if (framework === "django")
      assert.equal((await client.post(path, { form: { email: "a@b", target_price: "2" } })).status(), 403);
    assert.deepEqual(await read(client), expected);
    assert.deepEqual(await read(client), expected, "GET must not reset alerts");
    const forgedRead = await client.get("/api/alerts?email=not-stored&target_minor=999");
    assert.deepEqual(await forgedRead.json(), expected, "readback must not echo request data");
    assert.deepEqual(await read(other), []);
    const otherToken = await csrf(other);
    assert.equal((await other.post(path, { form: { ...otherToken, email: "other@example.test", target_price: "3" } })).status(), 200);
    assert.deepEqual(await read(other), [{ item_id: "item_1", email: "other@example.test", target_minor: 300 }]);
    assert.deepEqual(await read(client), expected);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => client.post(path, {
      form: { ...token, email: `concurrent-${i}@example.test`, target_price: "4" },
    })));
    assert.deepEqual(responses.map(r => r.status()), Array(8).fill(200));
    const rows = await read(client);
    assert.equal(rows.length, 11);
    assert.deepEqual(rows.slice(0, 3), expected);
    assert.deepEqual(rows.slice(3).map(r => r.email).sort(), Array.from({ length: 8 }, (_, i) => `concurrent-${i}@example.test`));
    assert.ok(rows.slice(3).every(r => r.item_id === "item_1" && r.target_minor === 400));
    assert.deepEqual(await read(other), [{ item_id: "item_1", email: "other@example.test", target_minor: 300 }]);
  } finally {
    await client.dispose();
    await other.dispose();
  }
});

test(`${framework}: native browser forms with and without JavaScript`, { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const javaScriptEnabled of [false, true]) {
      const context = await browser.newContext({ baseURL, javaScriptEnabled });
      try {
        assert.deepEqual(await read(context.request), []);
        const page = await context.newPage();
        await page.goto(path);
        if (javaScriptEnabled) assert.ok(await page.evaluate(() => !!window.htmx), "existing native htmx loaded");
        await page.locator('.marketplace__alert [name="email"]').fill("browser@example.test");
        await page.locator('.marketplace__alert [name="target_price"]').fill("8.25");
        await Promise.all([
          page.waitForResponse(r => r.request().method() === "POST"),
          page.locator('.marketplace__alert button[type="submit"]').click(),
        ]);
        await page.locator(".marketplace__message").filter({ hasText: "browser@example.test" }).waitFor();
        assert.deepEqual(await read(context.request), [{ item_id: "item_1", email: "browser@example.test", target_minor: 825 }]);
        await page.goto(path);
        assert.equal((await read(context.request)).length, 1);
        await page.locator('.marketplace__alert [name="email"]').fill("browser@example.test");
        await page.locator('.marketplace__alert [name="target_price"]').fill("0");
        await Promise.all([
          page.waitForResponse(r => r.request().method() === "POST"),
          page.locator('.marketplace__alert button[type="submit"]').click(),
        ]);
        await page.locator(".marketplace__message").filter({ hasText: "above zero" }).waitFor();
        assert.equal((await read(context.request)).length, 1);
        if (javaScriptEnabled) {
          // The legacy item's native enhancement still submits through htmx, without
          // a document navigation. Marketplace itself intentionally uses full pages.
          await page.goto("/items/item_1");
          await page.waitForFunction(() => !!window.htmx);
          let navigations = 0;
          page.on("framenavigated", () => navigations++);
          await page.locator('form[hx-post] [name="email"]').fill("legacy@example.test");
          await page.locator('form[hx-post] [name="target_price"]').fill("7");
          const [response] = await Promise.all([
            page.waitForResponse(r => r.request().method() === "POST"),
            page.locator('form[hx-post] button[type="submit"]').click(),
          ]);
          assert.equal(response.request().headers()["hx-request"], "true");
          await page.locator("#alert-message").filter({ hasText: "legacy@example.test" }).waitFor();
          assert.equal(navigations, 0);
          assert.equal((await read(context.request)).length, 1, "legacy handler remains separate");
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
