// Source checks: node --test bench/fullstack/apps/express/htmx.test.mjs
// Native browser check against a production image serving both legacy and marketplace fixtures:
// HTMX_APP=express HTMX_BASE_URL=http://127.0.0.1:8080 node --test bench/fullstack/apps/express/htmx.test.mjs
// Run once per app/profile/source. This is compatibility evidence, not a historical timing baseline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const apps = new URL("../", import.meta.url);
const digest = "a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130";
const asset = `--checksum=sha256:${digest} https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js`;
const layouts = {
  aspnet: ["Pages/Shared/_Layout.cshtml"],
  "axum-maud": ["src/pages.rs"],
  django: ["templates/base.html", "templates/marketplace.html"],
  drogon: ["views/Layout.csp", "views/MarketplaceLayout.csp"],
  express: ["views/head.ejs", "views/marketplace.ejs"],
  fastapi: ["templates/base.html", "templates/marketplace.html"],
  gin: ["views.templ", "marketplace.templ"],
  spring: ["src/main/resources/templates/layout.html"],
};

for (const [app, files] of Object.entries(layouts)) {
  test(`${app}: pinned htmx 4 asset and explicit descendant boost policy`, () => {
    assert.ok(readFileSync(new URL(`${app}/Dockerfile`, apps), "utf8").includes(asset));
    for (const file of files) {
      const source = readFileSync(new URL(`${app}/${file}`, apps), "utf8");
      assert.match(source, /hx-boost:inherited/, file);
      assert.doesNotMatch(source, /\bhx-boost\s*=/, `${file}: containers must explicitly pass boost to descendants`);
    }
  });
}

const baseURL = process.env.HTMX_BASE_URL;
const app = process.env.HTMX_APP;
if (baseURL || app) {
  assert.ok(baseURL && Object.hasOwn(layouts, app), "set HTMX_BASE_URL and a supported HTMX_APP together");
}

test("native htmx navigation/forms and marketplace opt-out with and without JavaScript", {
  skip: !baseURL && "set HTMX_BASE_URL and HTMX_APP to check an actual production app",
  timeout: 120000,
}, async () => {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const javaScriptEnabled of [false, true]) {
      const context = await browser.newContext({ baseURL, javaScriptEnabled });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        assert.equal((await page.goto("/")).status(), 200);
        const script = page.locator('script[src*="htmx.min.js"]');
        assert.equal(await script.count(), 1);
        const response = await context.request.get(await script.getAttribute("src"));
        assert.equal(response.status(), 200);
        assert.equal(createHash("sha256").update(await response.body()).digest("hex"), digest, "the running image serves the published bytes");
        if (javaScriptEnabled) await page.waitForFunction(() => window.htmx?.version === "4.0.1");

        const [navigation] = await Promise.all([
          page.waitForResponse(r => new URL(r.url()).pathname === "/items/item_1"),
          page.locator('a[href="/items/item_1"]').first().click(),
        ]);
        assert.equal(navigation.status(), 200);
        assert.equal(navigation.request().isNavigationRequest(), !javaScriptEnabled, "boosted links must not silently fall back to full loads");
        assert.equal(navigation.request().headers()["hx-boosted"], javaScriptEnabled ? "true" : undefined);
        await page.locator("#offers").waitFor();
        assert.equal(await page.locator("#offers tbody tr").count(), 5, "use a legacy fixture with more than five offers");
        const heading = await page.locator("h1").innerText();
        const [offers] = await Promise.all([
          page.waitForResponse(r => new URL(r.url()).searchParams.get("offers") === "all"),
          page.locator('#offers button[name="offers"]').click(),
        ]);
        assert.equal(offers.status(), 200);
        assert.equal(offers.request().isNavigationRequest(), !javaScriptEnabled);
        assert.equal(offers.request().headers()["hx-request"], javaScriptEnabled ? "true" : undefined);
        await page.waitForFunction(() => document.querySelectorAll("#offers tbody tr").length > 5);
        assert.equal(await page.locator("h1").innerText(), heading);

        await page.locator('form[hx-post] [name="email"]').fill("legacy@example.test");
        await page.locator('form[hx-post] [name="target_price"]').fill("7");
        const [post] = await Promise.all([
          page.waitForResponse(r => r.request().method() === "POST"),
          page.locator('form[hx-post] button[type="submit"]').click(),
        ]);
        assert.equal(post.status(), 200);
        assert.equal(post.request().isNavigationRequest(), !javaScriptEnabled);
        assert.equal(post.request().headers()["hx-request"], javaScriptEnabled ? "true" : undefined);
        await page.locator("#alert-message").filter({ hasText: "legacy@example.test" }).waitFor();
        assert.equal(await page.locator("h1").innerText(), heading, "partial response must not replace the document");

        const read = async () => {
          const r = await context.request.get("/api/alerts");
          assert.equal(r.status(), 200);
          assert.match(r.headers()["cache-control"], /no-store/);
          return r.json();
        };
        assert.deepEqual(await read(), [], "legacy forms remain separate from marketplace persistence");
        const expected = [];
        for (const [locale, target] of [["en-US", "8.25"], ["fr-FR", "8,25"], ["de-DE", "8,25"]]) {
          assert.equal((await page.goto(`/marketplace/${locale}/item_1`)).status(), 200);
          assert.equal(await page.locator("html").getAttribute("lang"), locale);
          if (javaScriptEnabled) await page.waitForFunction(() => window.htmx?.version === "4.0.1");
          const email = `${locale}@example.test`;
          await page.locator('.marketplace__alert [name="email"]').fill(email);
          await page.locator('.marketplace__alert [name="target_price"]').fill(target);
          const [result] = await Promise.all([
            page.waitForResponse(r => r.request().method() === "POST"),
            page.locator('.marketplace__alert button[type="submit"]').click(),
          ]);
          assert.equal(result.status(), 200);
          assert.equal(result.request().isNavigationRequest(), true, "marketplace deliberately retains native full-page forms");
          assert.equal(result.request().headers()["hx-request"], undefined, "the nested opt-out must override inherited boost");
          await page.locator(".marketplace__message").filter({ hasText: email }).waitFor();
          assert.equal(await page.locator("html").getAttribute("lang"), locale);
          expected.push({ item_id: "item_1", email, target_minor: 825 });
          assert.deepEqual(await read(), expected, "independent readback must contain exactly one append per native form");
          assert.deepEqual(await read(), expected, "GET cannot reset state");
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
