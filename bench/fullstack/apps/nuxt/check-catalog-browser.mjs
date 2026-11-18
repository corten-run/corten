import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { records } from "../../../catalog/fixtures.mjs";

const [base] = process.argv.slice(2);
assert.ok(base, "usage: node check-catalog-browser.mjs BASE");
const record = records().record_1;
const entry = new URL(`/catalog/${record.id}`, base).href;
const related = record.related[0];
const homeURL = new URL("/", base).href;
const itemURL = new URL("/items/item_1", base).href;
const header = (page) => page.getByRole("banner").getByRole("link", { name: "Card Market", exact: true });
const heading = (page, name) => page.getByRole("heading", { level: 1, name, exact: true });
const modules = (page) => page.locator('link[rel="modulepreload"]').evaluateAll((links) => links.map((link) => link.href));

async function prefetchOpportunity(page) {
  await header(page).scrollIntoViewIfNeeded();
  // Nuxt registers visibility prefetch after onNuxtReady and a second idle callback.
  // Give both a turn, then wait for the visible header to be delivered by the real observer.
  await header(page).evaluate(async (link) => {
    await new Promise((resolve) => requestIdleCallback(() => requestIdleCallback(resolve)));
    await new Promise((resolve) => {
      const observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          requestAnimationFrame(resolve);
        }
      });
      observer.observe(link);
    });
  }, undefined, { timeout: 10_000 });
}

test("production Nuxt catalog header", { timeout: 75_000 }, async (t) => {
  await expect.poll(async () => (await fetch(entry, { signal: AbortSignal.timeout(1000) }).catch(() => null))?.status,
    { timeout: 10_000, message: "catalog app ready" }).toBe(200);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  console.log(`Chromium ${browser.version()}`);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  let homeChunk;
  try {
    await t.test("Home works without JavaScript and exposes its built chunk", async () => {
      assert.equal((await page.goto(entry)).status(), 200);
      const catalogModules = await modules(page);
      const [response] = await Promise.all([
        page.waitForResponse((response) => response.url() === homeURL && response.request().resourceType() === "document"),
        header(page).click(),
      ]);
      assert.equal(response.status(), 200);
      await expect(heading(page, "Popular items")).toBeVisible();
      const homeModules = (await modules(page)).filter((url) => !catalogModules.includes(url));
      assert.equal(homeModules.length, 1, "expected one Home-specific modulepreload in the SSR build");
      [homeChunk] = homeModules;
    });
  } finally { await context.close(); }
  if (!homeChunk) return; // The subtest already reported why the chunk could not be identified.

  async function coldCatalog(run) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(10_000);
    const page = await context.newPage();
    const requests = [];
    const documents = [];
    page.on("request", (request) => {
      if (request.url() === homeChunk) requests.push(request.url());
      if (request.resourceType() === "document") documents.push(request.url());
    });
    try {
      assert.equal((await page.goto(entry)).status(), 200);
      await page.waitForFunction(() => window.__hydratedAt);
      await prefetchOpportunity(page);
      assert.deepEqual(requests, [], "cold hydrated catalog requested Home before activation");
      await run(page, requests);
      assert.deepEqual(documents, [entry], "JavaScript navigation must stay in the same document");
    } finally { await context.close(); }
  }

  await t.test("related catalog navigation does not prefetch; Enter opens Home and keeps focus", () => coldCatalog(async (page, requests) => {
    await page.getByRole("navigation", { name: "Related records" }).getByRole("link", { name: related.title, exact: true }).click();
    await expect(page).toHaveURL(new URL(`/catalog/${related.id}`, base).href);
    await expect(heading(page, related.title)).toBeVisible();
    await header(page).focus();
    await prefetchOpportunity(page);
    assert.deepEqual(requests, [], "related catalog navigation or focus requested Home before activation");
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url() === homeChunk),
      page.keyboard.press("Enter"),
    ]);
    assert.ok(response.ok(), "activating Home must load the Home chunk");
    await expect(page).toHaveURL(homeURL);
    await expect(heading(page, "Popular items")).toBeVisible();
    await expect(header(page)).toBeFocused();
  }));

  await t.test("an SPA transition re-enables Home prefetch outside catalog and keeps header focus", () => coldCatalog(async (page) => {
    // Catalog deliberately has no item link. Use the real router and stub only the
    // unrelated item's data; the production route and its chunk requests are untouched.
    await page.route(new URL("/api/items/item_1", base).href, (route) => route.fulfill({
      json: { id: "item_1", title: "Test item", badges: [], categories: [], images: [], listings: [], offers: [], fields: [], tags: [], contents: [], included_in: [] },
    }));
    const navigate = (path) => page.evaluate(async (path) => {
      await document.querySelector("#__nuxt").__vue_app__.config.globalProperties.$router.push(path);
    }, path);
    await header(page).focus();
    const [prefetched] = await Promise.all([
      page.waitForResponse((response) => response.url() === homeChunk),
      navigate("/items/item_1"),
    ]);
    assert.ok(prefetched.ok(), "visible Home link must really prefetch its chunk outside catalog");
    assert.equal(await prefetched.finished(), null);
    await expect(heading(page, "Test item")).toBeVisible();
    await expect(page).toHaveURL(itemURL);
    await expect(header(page)).toBeFocused();
    await navigate(new URL(entry).pathname);
    await expect(heading(page, record.title)).toBeVisible();
    await expect(header(page)).toBeFocused();
  }));
});
