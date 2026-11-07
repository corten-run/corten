import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { records } from "./fixtures.mjs";
import { expectedArticle } from "./contract.mjs";
import { catalogServer } from "./upstream.mjs";
import { checkApp, compareStyle, intentionalDisabledPreload, referenceHtml, snapshotArticle } from "./check.mjs";

test("only Chromium's policy-free, JS-disabled modulepreload block is intentional", () => {
  const failure = { javaScriptEnabled: false, resourceType: "script", errorText: "csp", modulePreload: true, hasCsp: false };
  assert.equal(intentionalDisabledPreload(failure), true);
  for (const change of [{ javaScriptEnabled: true }, { resourceType: "stylesheet" }, { errorText: "net::ERR_FAILED" }, { modulePreload: false }, { hasCsp: true }]) assert.equal(intentionalDisabledPreload({ ...failure, ...change }), false);
});

test("browser outline detects extra native markup, text, hidden rows, wrong scope, and escaping", { timeout: 60000 }, async () => {
  const browser = steady(await chromium.launch());
  const page = await browser.newPage();
  const record = records().record_1;
  try {
    await page.setContent(referenceHtml(record));
    assert.deepEqual(await page.evaluate(snapshotArticle), expectedArticle(record));
    for (const mutate of [
      () => document.querySelector("article").append(document.createElement("strong")),
      () => document.querySelector("article h1").textContent = "wrong",
      () => document.querySelector("tbody tr").hidden = true,
      () => document.querySelector("tbody th").scope = "col",
      () => document.querySelector("article ul").insertAdjacentHTML("beforeend", '<li><img src="x"></li>'),
      () => document.querySelector("input").disabled = true,
    ]) {
      await page.setContent(referenceHtml(record));
      await page.evaluate(mutate);
      await assert.rejects(async () => assert.deepEqual(await page.evaluate(snapshotArticle), expectedArticle(record)));
    }
    await page.setContent(referenceHtml(record));
    await page.evaluate(() => { globalThis.catalogInjected = true; });
    await assert.rejects(page.evaluate(snapshotArticle), /fixture HTML executed/);
    const shape = [{ tag: "article", box: [0, 0, 100, 20], style: { display: "block" } }];
    assert.doesNotThrow(() => compareStyle(shape, shape, "reference"));
    assert.throws(() => compareStyle([{ ...shape[0], box: [0, 0, 100, 30] }], shape, "reference"));
    assert.throws(() => compareStyle([{ ...shape[0], style: {} }], shape, "reference"));
  } finally { await browser.close(); }
});

test("complete check exercises both sources, no-JS/JS forms, independent styles, error propagation and single uncached reads", { timeout: 180000 }, async () => {
  const catalog = records();
  const upstream = catalogServer(catalog);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  let source = "fixture";
  let broken = false;
  const app = createServer(async (req, res) => {
    const url = new URL(req.url, "http://catalog");
    const match = /^(\/api)?\/catalog\/(record_[1-9]\d*)$/.exec(url.pathname);
    if (!match) { res.writeHead(404); res.end("not found"); return; }
    const json = !!match[1];
    const id = match[2];
    let record = catalog[id];
    if (source === "api") {
      const response = await fetch(`${upstreamBase}/catalog/records/${id}`);
      if (!response.ok) { res.writeHead(response.status); res.end("upstream error"); return; }
      record = await response.json();
    }
    if (!record) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": json ? "application/json" : "text/html" });
    res.end(json ? JSON.stringify(broken ? { ...record, fields: [] } : record) : referenceHtml(record, url.searchParams.get("field") ?? ""));
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = steady(await chromium.launch());
  try {
    for (source of ["fixture", "api"]) {
      const result = await checkApp({ base, catalog, source, upstream: upstreamBase, browser });
      assert.equal(result.jsonRecords, 500);
      assert.equal(result.profiles.length, 8);
      assert.ok(result.pages > 50);
      if (source === "api") assert.equal(result.upstream.readsPerRequest, 1);
    }
    broken = true;
    await assert.rejects(checkApp({ base, catalog, source: "fixture", upstream: upstreamBase, browser }), /fixture mismatch/);
  } finally {
    await browser.close();
    app.close(); app.closeAllConnections();
    upstream.close(); upstream.closeAllConnections();
    await Promise.all([once(app, "close"), once(upstream, "close")]);
  }
});
