import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { records } from "./fixtures.mjs";
import { expectedArticle, expectedPageChecks, verifyDocumentHeaderChecks, verifyDocumentHeaders } from "./contract.mjs";
import { catalogServer } from "./upstream.mjs";
import { checkApp, compareStyle, intentionalDisabledPreload, isScriptPreload, referenceHtml, snapshotArticle } from "./check.mjs";

const documentHeaders = {
  "Content-Security-Policy": "style-src 'unsafe-inline'; SCRIPT-SRC 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "geolocation=()",
  "Cache-Control": "private, no-cache",
};
test("document floor evaluates effective header values and accepts alternate encodings", () => {
  const path = "/catalog/record_1";
  const verify = (changes = {}) => verifyDocumentHeaders({ path, status: 200,
    headers: Object.entries({ "Content-Type": "text/html; charset=utf-8", ...documentHeaders, ...changes })
      .flatMap(([name, values]) => [values].flat().filter((value) => value !== null).map((value) => ({ name: name.toLowerCase(), value })))
      .filter(({ name }) => name !== "content-security-policy-report-only") }, path);
  verify();
  verify({ "Content-Security-Policy": ["OBJECT-SRC 'none'", "DeFaUlT-SrC 'self'; SCRIPT-SRC 'nonce-example'"],
    "X-Frame-Options": " SameOrigin ", "X-Content-Type-Options": " NoSnIfF ",
    "Referrer-Policy": ["unsafe-url", "strict-origin, unknown-policy"], "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": 'same-origin;report-to="diagnostics"' });
  verify({ "Content-Security-Policy": ["script-src 'self'; frame-ancestors *", "frame-ancestors 'self'"] });
  verify({ "Cross-Origin-Opener-Policy": 'same-origin;mode=strict; flag;note="semi;colon";report-to=?0' });
  verify({ "Cross-Origin-Opener-Policy": 'same-origin;bin=:YWJj:;count=3;ratio=1.25' });
  for (const [changes, error] of [
    [{ "Content-Security-Policy": "\u00a0script-src 'self'; frame-ancestors 'none'" }, /restrict inline/],
    [{ "Content-Security-Policy": "script-src 'self' \u00a0; frame-ancestors 'none'" }, /restrict inline/],
    [{ "Cross-Origin-Opener-Policy": "same-origin;mode=?" }, /Cross-Origin-Opener-Policy/],
    [{ "Cross-Origin-Opener-Policy": "same-origin;stamp=@1" }, /Cross-Origin-Opener-Policy/],
    [{ "Cross-Origin-Opener-Policy": 'same-origin;label=%"caf%c3%a9"' }, /Cross-Origin-Opener-Policy/],
    [{ "Cross-Origin-Opener-Policy": 'same-origin;label=%"%ff"' }, /Cross-Origin-Opener-Policy/],
    [{ "Cross-Origin-Opener-Policy": "same-origin;bin=:a:" }, /Cross-Origin-Opener-Policy/],
    [{ "Cross-Origin-Opener-Policy": "same-origin;mode=ok, unsafe-none" }, /Cross-Origin-Opener-Policy/],
    [{ "Content-Type": "application/json" }, /text\/html/],
    [{ "Content-Security-Policy": null, "Content-Security-Policy-Report-Only": documentHeaders["Content-Security-Policy"] }, /enforced Content-Security-Policy/],
    [{ "Content-Security-Policy": "object-src 'none'; frame-ancestors 'none'" }, /enforced Content-Security-Policy/],
    [{ "Content-Security-Policy": "script-src 'unsafe-inline'; SCRIPT-SRC 'none'" }, /restrict inline/],
    [{ "Content-Security-Policy": "script-src 'self'; script-src-elem 'unsafe-inline'" }, /restrict inline/],
    [{ "Content-Security-Policy": "default-src 'self'; script-src-attr 'unsafe-inline'" }, /restrict inline/],
    [{ "Content-Security-Policy": "script-src 'self'; frame-ancestors *", "X-Frame-Options": "DENY" }, /cross-origin framing/],
    [{ "Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "ALLOW-FROM https://example.test" }, /cross-origin framing/],
    [{ "X-Content-Type-Options": "sniff, nosniff" }, /nosniff/],
    [{ "Referrer-Policy": "no-referrer, unsafe-url" }, /Referrer-Policy/],
    [{ "Cross-Origin-Opener-Policy": "same-origin-allow-popups" }, /Cross-Origin-Opener-Policy/],
    [{ "Cross-Origin-Opener-Policy": ["same-origin", "unsafe-none"] }, /Cross-Origin-Opener-Policy/],
    [{ "Permissions-Policy": " " }, /permissions-policy/],
    [{ "Cache-Control": null }, /cache-control/],
  ]) assert.throws(() => verify(changes), error);
});

test("only explicit script preloads blocked with JS disabled and no actual CSP are intentional", () => {
  const failure = { javaScriptEnabled: false, resourceType: "script", errorText: "csp", scriptPreload: true, hasCsp: false };
  for (const link of [{ rel: "modulepreload" }, { rel: "preload", as: "script" }, { rel: "PRELOAD", as: "SCRIPT" }]) {
    assert.equal(isScriptPreload(link), true);
    assert.equal(intentionalDisabledPreload({ ...failure, scriptPreload: isScriptPreload(link) }), true);
    assert.equal(intentionalDisabledPreload({ ...failure, scriptPreload: isScriptPreload(link), hasCsp: true }), false);
  }
  for (const link of [{ rel: "preload", as: "style" }, { rel: "preload", as: "font" }, { rel: "preload" }, { rel: "stylesheet", as: "script" }, { rel: "notmodulepreload" }, {}]) {
    assert.equal(isScriptPreload(link), false);
    assert.equal(intentionalDisabledPreload({ ...failure, scriptPreload: isScriptPreload(link) }), false);
  }
  for (const change of [{ javaScriptEnabled: true }, { resourceType: "stylesheet" }, { errorText: "net::ERR_FAILED" }, { scriptPreload: false }, { hasCsp: true }]) assert.equal(intentionalDisabledPreload({ ...failure, ...change }), false);
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
  let scriptUnavailable = false;
  let omitPolicy = false;
  let revalidations = 0;
  const app = createServer(async (req, res) => {
    const url = new URL(req.url, "http://catalog");
    if (url.pathname === "/required.js") {
      res.writeHead(scriptUnavailable ? 503 : 200, { "Content-Type": "text/javascript" });
      res.end(scriptUnavailable ? "unavailable" : "globalThis.requiredScript = true;");
      return;
    }
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
    const tag = `"${id}-${encodeURIComponent(url.search)}"`;
    if (!json && req.headers["if-none-match"] === tag) {
      revalidations++;
      res.writeHead(304, { ...documentHeaders, ETag: tag }); res.end(); return;
    }
    res.writeHead(200, { "Content-Type": json ? "application/json" : "text/html", ...(json ? {} : { ETag: tag }),
      ...(json ? {} : omitPolicy ? { "Content-Security-Policy-Report-Only": documentHeaders["Content-Security-Policy"] } : documentHeaders) });
    res.end(json ? JSON.stringify(broken ? { ...record, fields: [] } : record) :
      referenceHtml(record, url.searchParams.get("field") ?? "").replace("</head>", '<script defer src="/required.js"></script></head>'));
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = steady(await chromium.launch());
  try {
    for (source of ["fixture", "api"]) {
      const result = await checkApp({ base, catalog, source, upstream: upstreamBase, browser, app: "express" });
      assert.equal(result.jsonRecords, 500);
      assert.equal(result.profiles.length, 8);
      assert.equal(result.pages, expectedPageChecks(catalog));
      assert.equal(result.pages, 120);
      verifyDocumentHeaderChecks(result.documentHeaders, catalog, source);
      assert.equal(revalidations, 0, "document observations must be fresh HTTP representations, not cache revalidations");
      assert.equal(result.documentHeaders.length, 120 + (source === "api" ? 2 : 0));
      assert.ok(result.documentHeaders[0].headers.some(({ name, value }) => name === "content-security-policy" && value === documentHeaders["Content-Security-Policy"]));
      if (source === "api") assert.equal(result.upstream.readsPerRequest, 1);
    }
    source = "fixture";
    omitPolicy = true;
    await assert.rejects(checkApp({ base, catalog, source, upstream: upstreamBase, browser, app: "express" }), /enforced Content-Security-Policy/);
    const nonContender = await checkApp({ base, catalog, source, upstream: upstreamBase, browser, app: "nextjs" });
    assert.equal(Object.hasOwn(nonContender, "documentHeaders"), false);
    omitPolicy = false;
    scriptUnavailable = true;
    await assert.rejects(checkApp({ base, catalog, source, upstream: upstreamBase, browser }),
      (error) => error.actual?.includes(`${base}/required.js: HTTP 503`));
    scriptUnavailable = false;
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      await context.route(`${base}/required.js`, (route) => route.abort("aborted"));
      return context;
    };
    await assert.rejects(checkApp({ base, catalog, source, upstream: upstreamBase, browser }),
      (error) => error.actual?.includes(`${base}/required.js: net::ERR_ABORTED`));
    broken = true;
    await assert.rejects(checkApp({ base, catalog, source: "fixture", upstream: upstreamBase, browser }), /fixture mismatch/);
  } finally {
    await browser.close();
    app.close(); app.closeAllConnections();
    upstream.close(); upstream.closeAllConnections();
    await Promise.all([once(app, "close"), once(upstream, "close")]);
  }
});
