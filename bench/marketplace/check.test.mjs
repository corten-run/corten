import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { records } from "./fixtures.mjs";
import { expectedPage, labels } from "./records.mjs";
import { alignNumberSpaces, comparePage, compareStyles, navigationFinished, numericFields, numericText, snapshotPage, styleSnapshot, submitAlert, verifyNumberSpaces } from "./check.mjs";
import { referenceHtml } from "./reference.mjs";

test("script-free alert POST checks the new document at the same URL", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route("http://localhost/**", async (route) => {
      const post = route.request().method() === "POST";
      if (post) await new Promise((r) => setTimeout(r, 100));
      await route.fulfill({ contentType: "text/html", body: `<form method="post"><button type="submit">Send</button></form><p class="marketplace__message">${post ? "new result" : "old result"}</p>` });
    });
    await page.goto("http://localhost/marketplace/en-US/item_1");
    await submitAlert(page, page.locator("form"), false);
    assert.equal(await page.locator(".marketplace__message").textContent(), "new result");
  } finally { await browser.close(); }
});

test("alert failure retains the exact form case, response and original timeout", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const html = '<form method="post"><input name="email" value="invalid"><input name="target_price" value="1"><button type="submit">Send</button></form><p class="marketplace__message"></p>';
    await page.route("http://localhost/**", (route) => route.fulfill({ status: route.request().method() === "POST" ? 500 : 200,
      contentType: "text/html", body: html + "server failure fixture" }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    page.setDefaultTimeout(500);
    await assert.rejects(submitAlert(page, page.locator("form"), false), (error) => {
      assert.match(error.message, /Alert POST 500 .*JS=false; fields=.*invalid.*target_price.*1/);
      assert.match(error.message, /server failure fixture/);
      assert.match(error.message, /message=""/);
      assert.match(error.cause.message, /Timeout 500ms exceeded/);
      return true;
    });
  } finally { await browser.close(); }
});

test("unfinished alert response cannot hang failure diagnostics", { timeout: 10000 }, async () => {
  const html = '<form method="post"><input name="email" value="invalid"><button type="submit">Send</button></form><p class="marketplace__message"></p>';
  const server = createServer((req, res) => {
    res.writeHead(req.method === "POST" ? 500 : 200, { "content-type": "text/html" });
    if (req.method === "POST") res.write(html); else res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/marketplace/en-US/item_1`);
    await page.evaluate(() => document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); fetch(location.href, { method: "POST" }); }));
    page.setDefaultTimeout(500);
    await assert.rejects(submitAlert(page, page.locator("form"), true), (error) => {
      assert.match(error.message, /Alert POST 500 .*unavailable: diagnostic timeout/);
      assert.match(error.cause.message, /Timeout 500ms exceeded/);
      return true;
    });
  } finally {
    await browser.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("navigation waits for intercepted DOM work after URL commitment", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost/**", (route) => route.fulfill({ contentType: "text/html", body: '<a href="?filtered=1">Filter</a><p>old</p>' }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    await page.evaluate(() => {
      navigation.addEventListener("navigate", (event) => event.intercept({ handler: async () => {
        await new Promise((resolve) => { globalThis.finishMarketplaceNavigation = resolve; });
        document.querySelector("p").textContent = "filtered";
      } }));
    });
    await Promise.all([page.waitForURL((url) => url.searchParams.get("filtered") === "1"), page.locator("a").click()]);
    assert.equal(await page.locator("p").textContent(), "old");
    await page.evaluate(() => { setTimeout(() => globalThis.finishMarketplaceNavigation(), 50); });
    await navigationFinished(page);
    assert.equal(await page.locator("p").textContent(), "filtered");
  } finally { await browser.close(); }
});
test("browser oracle rejects hidden work, missing sections, wrong control semantics and executed fixture HTML", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); const r = records().item_17;
  try {
    // A URL gives native form.action and location the same origin/path.
    await page.route("http://localhost/**", (route) => route.fulfill({ contentType: "text/html", body: referenceHtml(r, "fr-FR") }));
    await page.goto(`http://localhost/marketplace/fr-FR/${r.id}`);
    comparePage(await page.evaluate(snapshotPage), r, "fr-FR");
    for (const mutate of [
      () => { document.querySelector("tbody tr").hidden = true; },
      () => { document.querySelector(".marketplace__details").remove(); },
      () => { document.querySelector('[name="target_price"]').inputMode = "text"; },
      () => { document.querySelector(".marketplace__listings form").method = "post"; },
      () => { document.querySelector(".marketplace__offers tbody tr").cloneNode(true) && document.querySelector(".marketplace__offers tbody").append(document.querySelector(".marketplace__offers tbody tr").cloneNode(true)); },
      () => { globalThis.marketplaceInjected = true; },
    ]) {
      await page.reload(); await page.evaluate(mutate);
      await assert.rejects(async () => comparePage(await page.evaluate(snapshotPage), r, "fr-FR"));
    }
  } finally { await browser.close(); }
});
test("geometry permits only verified numeric spaces, not different content, markup or CSS", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const r = records().item_1, fields = numericFields(r, "fr-FR");
  const css = ["../fullstack/apps/axum-maud/static/style.css", "../fullstack/apps/axum-maud/static/components.css", "./marketplace.css"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
  const html = referenceHtml(r, "fr-FR").replace("</head>", `<style>${css}</style></head>`);
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage(), reference = await context.newPage();
      try {
        const reset = async () => {
          await page.setContent(html); await reference.setContent(html);
          await page.evaluate((fields) => {
            for (const { selector } of fields) {
              const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) node.data = node.data.replace(/[\u00a0\u202f]/g, " ");
            }
          }, fields);
        };
        const check = async () => {
          const numbers = verifyNumberSpaces(fields, await page.evaluate(numericText, fields));
          await reference.evaluate(alignNumberSpaces, { fields, numbers });
          compareStyles(await page.evaluate(styleSnapshot), await reference.evaluate(styleSnapshot));
        };
        await reset(); await check();
        await page.evaluate(() => {
          for (const el of document.querySelectorAll(".marketplace__contents li, .marketplace__included li")) {
            for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) node.data = node.data.replace(" × ", "\n  ×\n  ");
          }
        });
        await reference.setContent(html); await check();
        for (const mutate of [
          () => { document.querySelector(".marketplace__summary strong").textContent = "9,99 $US"; },
          () => { document.querySelector(".marketplace__summary strong").textContent = document.querySelector(".marketplace__summary strong").textContent.replace(" ", "  "); },
          () => { const el = document.querySelector(".marketplace__summary strong"); el.replaceWith(el.textContent); },
          () => { document.querySelector(".marketplace__listings td").style.padding = "20px"; },
          () => { document.querySelector(".marketplace__listings table").style.width = "2000px"; },
          () => { document.querySelector(".marketplace__listings table").style.fontSize = "20px"; },
        ]) {
          await reset(); await page.evaluate(mutate); await assert.rejects(check);
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
