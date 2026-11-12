import assert from "node:assert/strict";
import { join } from "node:path";
import { expectedArticle, representativeIds, filterPrefixes } from "../../catalog/contract.mjs";
import { snapshotArticle } from "../../catalog/check.mjs";
import { snapshotPage, comparePage, submitAlert, navigationFinished } from "../../marketplace/check.mjs";
import { labels } from "../../marketplace/records.mjs";
import { read } from "./checks.mjs";
import { verifyAlertRows } from "./alerts.mjs";

// Only observers and independent oracles are shared. Express still renders every document.
export async function checkPages({ base, source, records, upstream, browser, observe, test, out }) {
  const capture = async (page, kind, record, locale, options = {}) => {
    const actual = await page.evaluate(kind === "catalog" ? snapshotArticle : snapshotPage);
    observe({ kind: "dom", workload: kind, path: new URL(page.url()).pathname + new URL(page.url()).search, locale, options, actual, html: await page.content() });
    if (kind === "catalog") assert.deepEqual(actual, expectedArticle(record, options.prefix ?? ""));
    else comparePage(actual, record, locale, options);
  };
  for (const javaScriptEnabled of [false, true]) {
    await test(`catalog/browser-js-${javaScriptEnabled}`, async () => {
      const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
      const timer = setTimeout(() => context.close().catch(() => {}), 75000);
      try {
        const page = await context.newPage(), errors = []; page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(10000);
        const visit = async (id, prefix = "") => {
          const response = await page.goto(`${base}/catalog/${id}?${new URLSearchParams({ field: prefix })}`, { waitUntil: "load" });
          assert.equal(response.status(), 200); await capture(page, "catalog", records.catalog[id], null, { prefix });
        };
        for (const id of representativeIds(records.catalog)) await visit(id);
        for (const prefix of filterPrefixes(records.catalog.record_1)) await visit("record_1", prefix);
        await visit("record_1");
        const prefix = filterPrefixes(records.catalog.record_1)[1];
        await page.locator('[name="field"]').fill(prefix);
        await Promise.all([page.waitForURL((url) => url.searchParams.get("field") === prefix), page.locator('article form button[type="submit"]').click()]);
        await navigationFinished(page); await capture(page, "catalog", records.catalog.record_1, null, { prefix });
        await page.screenshot({ path: join(out, `catalog-js-${javaScriptEnabled}.png`) });
        assert.deepEqual(errors, []);
        return { javaScriptEnabled, representativeIds: representativeIds(records.catalog), nativeGetForm: true, screenshots: true };
      } finally { clearTimeout(timer); await context.close(); }
    });
    for (const locale of ["en-US", "fr-FR", "de-DE"]) await test(`marketplace/${locale}/browser-js-${javaScriptEnabled}`, async () => {
      const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
      const timer = setTimeout(() => context.close().catch(() => {}), 75000);
      try {
        const page = await context.newPage(), errors = []; page.on("pageerror", (error) => errors.push(error.message)); page.setDefaultTimeout(10000);
        const visit = async (id, query = "", options = {}) => {
          const response = await page.goto(`${base}/marketplace/${locale}/${id}${query}`, { waitUntil: "load" });
          assert.equal(response.status(), 200); await capture(page, "marketplace", records.marketplace[id], locale, options);
        };
        for (const id of ["item_1", "item_7", "item_11", "item_13", "item_17", "item_500"]) await visit(id);
        await visit("item_1");
        const form = page.locator(".marketplace__listings form");
        await form.locator('[name="seller"]').fill("Alice"); await form.locator('[name="sort"]').selectOption("desc");
        await Promise.all([page.waitForURL((url) => url.searchParams.get("seller") === "Alice" && url.searchParams.get("sort") === "desc"), form.locator('[type="submit"]').click()]);
        await navigationFinished(page); await capture(page, "marketplace", records.marketplace.item_1, locale, { seller: "Alice", sort: "desc" });
        await Promise.all([page.waitForURL((url) => url.searchParams.get("offers") === "all"), page.locator(".marketplace__more").click()]);
        await navigationFinished(page); await capture(page, "marketplace", records.marketplace.item_1, locale, { seller: "Alice", sort: "desc", all: true });
        const accepted = [];
        const readback = async () => {
          const response = await context.request.get(`${base}/api/alerts`);
          const actual = await response.json();
          observe({ kind: "browser-alert-readback", locale, javaScriptEnabled, status: response.status(), actual });
          assert.equal(response.status(), 200); assert.equal(response.headers()["cache-control"], "no-store");
          verifyAlertRows(actual, accepted);
        };
        await readback();
        for (const [email, price, message] of [["invalid", "1", labels[locale].invalid_email], ["test@example.test", "0", labels[locale].invalid_price],
          ["test@example.test", locale === "en-US" ? "1234.50" : "1234,50", labels[locale].alert_set.replace("{email}", "test@example.test").replace("{title}", records.marketplace.item_1.title).replace("{price}", new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(1234.5))]]) {
          await visit("item_1"); const alert = page.locator(".marketplace__alert form");
          await alert.locator('[name="email"]').fill(email); await alert.locator('[name="target_price"]').fill(price);
          await alert.evaluate((element) => { element.noValidate = true; });
          await submitAlert(page, alert, javaScriptEnabled);
          await capture(page, "marketplace", records.marketplace.item_1, locale, { message });
          if (price !== "0" && email.includes("@")) accepted.push({ item_id: "item_1", email, target_minor: 123450 });
          await readback();
        }
        if (locale === "fr-FR") await page.screenshot({ path: join(out, `marketplace-fr-FR-js-${javaScriptEnabled}.png`) });
        assert.deepEqual(errors, []);
        return { locale, javaScriptEnabled, nativeGetForm: true, nativePostForm: true, persistedRows: accepted.length, validationErrors: true };
      } finally { clearTimeout(timer); await context.close(); }
    });
  }
  if (source === "api") for (const kind of ["catalog", "marketplace"]) await test(`${kind}/fresh-page-source`, async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage(), id = kind === "catalog" ? "record_1" : "item_1";
      for (const version of [1, 2]) {
        const record = { ...structuredClone(records[kind][id]), title: `Fresh source ${version} <&"` };
        await read(upstream.url, `/__${kind}/control`, observe, { method: "POST", body: JSON.stringify({ record, pretty: true }) });
        const response = await page.goto(`${base}${kind === "catalog" ? "/catalog" : "/marketplace/en-US"}/${id}`);
        assert.equal(response.status(), 200); await capture(page, kind, record, "en-US");
        const counters = await read(upstream.url, `/__${kind}/control`, observe);
        assert.deepEqual(JSON.parse(counters.body).requests, { [id]: 1 });
      }
    } finally { await read(upstream.url, `/__${kind}/control`, observe, { method: "POST", body: "{}" }); await context.close(); }
  });
}
