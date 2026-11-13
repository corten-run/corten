// Run against this app's production server with ALERTS_BASE_URL set.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";

const base = process.env.ALERTS_BASE_URL;
assert.ok(base, "ALERTS_BASE_URL must identify the native server under test");
test("native browser forms persist alerts with and without JavaScript using their own cookie jar", { timeout: 180000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ["--renderer-process-limit=2"] });
  try {
    for (const javaScriptEnabled of [true, false]) for (const locale of ["en-US", "fr-FR", "de-DE"]) {
      await t.test(`${locale}, JavaScript ${javaScriptEnabled}`, async () => {
        const context = await browser.newContext({ javaScriptEnabled });
        const page = await context.newPage();
        const errors = [], posts = [], responses = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.method() === "POST") posts.push({ url: request.url(), type: request.resourceType() });
        });
        page.on("response", async (response) => {
          if (response.request().method() === "POST") responses.push({ status: response.status(),
            url: response.url(), body: (await response.text().catch(() => "")).slice(0, 300) });
          if (response.request().method() === "POST" && response.status() >= 400)
            errors.push(`POST ${response.status()} ${response.url()}`);
        });
        try {
          const initial = await context.request.get(base + "/api/alerts");
          assert.equal(initial.status(), 200);
          assert.deepEqual(await initial.json(), []);
          await page.goto(base + `/marketplace/${locale}/item_1`);
          if (javaScriptEnabled) await page.waitForFunction(() =>
            window.__hydratedAt !== undefined || window.next?.router?.isReady === true, undefined, { timeout: 15000 });
          const form = page.locator(".marketplace__alert form");
          await form.locator('[name="email"]').fill("browser@example.test");
          await form.locator('[name="target_price"]').fill(locale === "en-US" ? "1234.50" : "1234,50");
          await form.locator('button[type="submit"]').click();
          await expect(page.locator(".marketplace__message")).toContainText("browser@example.test", { timeout: 15000 });
          const saved = await context.request.get(base + "/api/alerts");
          assert.equal(saved.status(), 200);
          const expected = [{ item_id: "item_1", email: "browser@example.test", target_minor: 123450 }];
          assert.deepEqual(await saved.json(), expected);
          assert.equal(posts.length, 1, JSON.stringify(posts));
          assert.equal(posts[0].type === "document", !javaScriptEnabled, JSON.stringify(posts));
          for (const [target, minor] of [["2.005", 201], ["12.505", 1251], ["70368744177664.01", 7036874417766401]]) {
            const email = `round${expected.length}@example.test`;
            await form.locator('[name="email"]').fill(email);
            await form.locator('[name="target_price"]').fill(locale === "en-US" ? target : target.replace(".", ","));
            await form.locator('button[type="submit"]').click();
            await expect(page.locator(".marketplace__message")).toContainText(email, { timeout: 15000 });
            const digits = String(minor).padStart(3, "0");
            const price = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
              digits.slice(0, -2) + "." + digits.slice(-2));
            await expect(page.locator(".marketplace__message")).toContainText(price, { timeout: 15000 });
            expected.push({ item_id: "item_1", email, target_minor: minor });
            assert.deepEqual(await (await context.request.get(base + "/api/alerts")).json(), expected);
          }
          assert.equal(posts.length, 4, JSON.stringify(posts));
          assert.ok(posts.every((post) => (post.type === "document") === !javaScriptEnabled), JSON.stringify(posts));
          await form.locator('[name="email"]').fill("rejected@example.test");
          await form.locator('[name="target_price"]').fill("0");
          const previous = await page.locator(".marketplace__message").textContent();
          await form.locator('button[type="submit"]').click();
          await expect(page.locator(".marketplace__message")).not.toHaveText(previous, { timeout: 15000 });
          assert.deepEqual(await (await context.request.get(base + "/api/alerts")).json(), expected);
          assert.deepEqual(errors, []);
          const fresh = await browser.newContext();
          try { assert.deepEqual(await (await fresh.request.get(base + "/api/alerts")).json(), []); }
          finally { await fresh.close(); }
        } catch (error) {
          throw new Error(`${locale} JS=${javaScriptEnabled}: ${error.message}; probes=${JSON.stringify({ posts, responses, errors,
            readback: await (await context.request.get(base + "/api/alerts")).json().catch(() => null),
            message: await page.locator(".marketplace__message").textContent().catch(() => null) })}`, { cause: error });
        } finally { await context.close(); }
      });
    }
  } finally { await browser.close(); }
});
