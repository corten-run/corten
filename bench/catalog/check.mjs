import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { articleHtml, expectedArticle, expectedPageChecks, filterPrefixes, representativeIds, validateCatalog, validateRecord } from "./contract.mjs";
import { steady } from "../../scripts/steady.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export async function get(url, accept = "application/json") {
  const response = await fetch(url, { headers: { Accept: accept, "Accept-Encoding": "identity" }, redirect: "manual", signal: AbortSignal.timeout(10000) });
  return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
}
export function isScriptPreload({ rel = "", as = "" }) {
  const tokens = rel.toLowerCase().split(/\s+/);
  return tokens.includes("modulepreload") || (tokens.includes("preload") && as.toLowerCase() === "script");
}
export function intentionalDisabledPreload({ javaScriptEnabled, resourceType, errorText, scriptPreload, hasCsp }) {
  // Chromium reports an intentionally disabled modulepreload as "csp" even
  // without a CSP. Never suppress real policies, stylesheet failures, or JS-on errors.
  return !javaScriptEnabled && resourceType === "script" && errorText === "csp" && scriptPreload && !hasCsp;
}

// Executed in the browser. Only framework wrappers/metadata are transparent, not native
// elements, hidden data rows, extra text, or missing list/table containers.
export function snapshotArticle() {
  const articles = document.querySelectorAll('main article[aria-label="Catalog record"]');
  if (articles.length !== 1) throw new Error(`expected one catalog article in main, got ${articles.length}`);
  const norm = (s) => s.replace(/[\t\n\r\f ]+/g, " ").trim();
  const transparent = (el) => (el.localName === "div" && !el.hasAttribute("role")) || el.localName.includes("-");
  const omitted = (el) => ["script", "style", "template"].includes(el.localName);
  const checkVisible = (el) => {
    const style = getComputedStyle(el);
    if (el.hidden || el.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) throw new Error(`hidden catalog element: ${el.localName}`);
  };
  const children = (el) => [...el.children].flatMap((child) => {
    if (omitted(child)) return [];
    checkVisible(child);
    if (transparent(child)) {
      if (norm([...child.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""))) throw new Error("text in framework wrapper");
      return children(child);
    }
    return [walk(child)];
  });
  const walk = (el) => {
    checkVisible(el);
    const attrs = {};
    for (const name of ["aria-label", "scope", "name", "href", "action"]) if (el.hasAttribute(name)) attrs[name] = el.getAttribute(name);
    if (el.localName === "form") attrs.method = el.method.toLowerCase();
    if (el.localName === "input") { attrs.type = el.type; attrs.value = el.value; }
    if (el.localName === "button") attrs.type = el.type;
    if (el.disabled || el.readOnly) throw new Error(`disabled catalog control: ${el.localName}`);
    return { tag: el.localName, attrs, text: norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("")), children: children(el) };
  };
  if (globalThis.catalogInjected) throw new Error("fixture HTML executed");
  return walk(articles[0]);
}

const properties = ["display", "position", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "border-collapse", "list-style-type", "flex-wrap", "gap", "align-items", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-bottom", "border-bottom-width", "border-bottom-style", "border-bottom-color", "vertical-align", "overflow-wrap", "opacity"];
export function measureArticle(properties) {
  const article = document.querySelector('main article[aria-label="Catalog record"]');
  const root = article.getBoundingClientRect();
  return [article, ...article.querySelectorAll("*")].filter((el) => !["script", "template", "style", "div"].includes(el.localName) && !el.localName.includes("-")).map((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { tag: el.localName, box: [rect.x - root.x, rect.y - root.y, rect.width, rect.height], style: Object.fromEntries(properties.map((p) => [p, style.getPropertyValue(p)])) };
  });
}
export function compareStyle(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: style element count`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i].tag, expected[i].tag, `${label}: style tag ${i}`);
    assert.deepEqual(actual[i].style, expected[i].style, `${label}: ${expected[i].tag} styles at ${i}`);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(actual[i].box[k] - expected[i].box[k]) <= 1, `${label}: ${expected[i].tag} box ${i}/${k}: ${actual[i].box[k]} != ${expected[i].box[k]}`);
  }
}
const css = () => [
  readFileSync(join(here, "../fullstack/apps/axum-maud/static/style.css"), "utf8"),
  readFileSync(join(here, "../fullstack/apps/axum-maud/static/components.css"), "utf8"),
  readFileSync(join(here, "catalog.css"), "utf8"),
].join("\n");
export const referenceHtml = (record, prefix = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Catalog reference</title><style>${css()}</style></head><body><main>${articleHtml(record, prefix)}</main></body></html>`;

export async function control(upstream, value) {
  const response = await fetch(`${upstream}/__catalog/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, "upstream control");
  await response.text();
}
async function once(upstream, id) {
  const state = await get(`${upstream}/__catalog/control`);
  assert.equal(state.status, 200);
  assert.deepEqual(JSON.parse(state.body).requests, { [id]: 1 }, "expected exactly one upstream read for the request");
}

export async function checkApp({ base, catalog, source, upstream, browser }) {
  validateCatalog(catalog);
  const result = { jsonRecords: 0, pages: 0, profiles: [], upstream: source === "api" ? {} : null };
  // JSON every record, not a comparison with another framework's implementation.
  const ids = Object.keys(catalog);
  let next = 0;
  let jsonFailure;
  await Promise.all(Array.from({ length: 8 }, async () => {
    try {
    while (next < ids.length) {
      if (jsonFailure) return;
      const id = ids[next++];
      const response = await get(`${base}/api/catalog/${id}`);
      assert.equal(response.status, 200, `JSON ${id}`);
      assert.match(response.type ?? "", /^application\/json\b/);
      const actual = JSON.parse(response.body);
      validateRecord(actual, id);
      assert.deepEqual(actual, catalog[id], `JSON ${id}: fixture mismatch`);
      result.jsonRecords++;
    }
    } catch (error) { jsonFailure ??= error; }
  }));
  if (jsonFailure) throw jsonFailure;
  for (const path of ["/catalog/record_501", "/api/catalog/record_501", "/catalog/does-not-exist", "/api/catalog/does-not-exist"]) assert.equal((await get(base + path, path.startsWith("/api/") ? "application/json" : "text/html")).status, 404, `${path}: unknown must be 404`);

  const representative = representativeIds(catalog);
  const record = catalog.record_1;
  for (const javaScriptEnabled of [false, true]) {
    for (const [profile, viewport, colorScheme] of [["desktop-light", { width: 1280, height: 800 }, "light"], ["desktop-dark", { width: 1280, height: 800 }, "dark"], ["phone-light", { width: 390, height: 844 }, "light"], ["phone-dark", { width: 390, height: 844 }, "dark"]]) {
      const context = await browser.newContext({ javaScriptEnabled, viewport, colorScheme, reducedMotion: "reduce", serviceWorkers: "block" });
      context.setDefaultTimeout(10000);
      context.setDefaultNavigationTimeout(20000);
      const page = await context.newPage();
      const reference = await context.newPage();
      const failures = [];
      const failedResources = [];
      const documentResponses = [];
      const scriptPreloads = new Set();
      let metaCsp = false;
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
      page.on("requestfailed", (request) => { if (["stylesheet", "script"].includes(request.resourceType())) failedResources.push({ url: request.url(), resourceType: request.resourceType(), errorText: request.failure()?.errorText }); });
      page.on("response", (response) => {
        if (response.request().resourceType() === "document") documentResponses.push(response);
        if (["stylesheet", "script"].includes(response.request().resourceType()) && response.status() >= 400) failures.push(`${response.url()}: HTTP ${response.status()}`);
      });
      const visit = async (r, prefix = "") => {
        const path = `/catalog/${r.id}${prefix ? `?${new URLSearchParams({ field: prefix })}` : ""}`;
        const response = await page.goto(base + path, { waitUntil: "load" });
        assert.equal(response?.status(), 200, path);
        await page.waitForFunction(() => [...document.querySelectorAll('link[rel="stylesheet"]')].every((l) => l.sheet));
        await page.evaluate(() => document.fonts.ready);
        for (const link of await page.locator('link[rel]').evaluateAll((links) => links.map((link) => ({ href: link.href, rel: link.rel, as: link.as })))) {
          if (isScriptPreload(link)) scriptPreloads.add(link.href);
        }
        metaCsp ||= await page.locator('meta[http-equiv="Content-Security-Policy" i]').count() > 0;
        assert.deepEqual(await page.evaluate(snapshotArticle), expectedArticle(r, prefix), `${profile} js=${javaScriptEnabled} ${path}`);
        result.pages++;
      };
      try {
        for (const id of representative) await visit(catalog[id]);
        for (const prefix of filterPrefixes(record)) await visit(record, prefix);
        // Reference is generated from the contract, not from Corten's output. The normal
        // fullstack shell styles and catalog.css are shared by all eighteen apps.
        for (const r of [record, catalog.record_500]) {
          await visit(r);
          await reference.setContent(referenceHtml(r), { waitUntil: "load" });
          compareStyle(await page.evaluate(measureArticle, properties), await reference.evaluate(measureArticle, properties), `${profile} js=${javaScriptEnabled} ${r.id}`);
        }
        await visit(record);
        const prefix = filterPrefixes(record)[1];
        await page.locator('article input[name="field"]').fill(prefix);
        await page.locator('article button[type="submit"]').click();
        await page.waitForURL((url) => url.pathname === `/catalog/${record.id}` && url.searchParams.get("field") === prefix);
        await page.waitForFunction(() => document.querySelector('article input[name="field"]')?.value === new URL(location.href).searchParams.get("field"));
        assert.deepEqual(await page.evaluate(snapshotArticle), expectedArticle(record, prefix), "GET form submission");
        const related = record.related[0];
        assert.ok(related, "record_1 must exercise related navigation");
        await page.locator(`article nav a[href="/catalog/${related.id}"]`).click();
        await page.waitForURL((url) => url.pathname === `/catalog/${related.id}`);
        await page.waitForFunction((title) => document.querySelector("article h1")?.textContent === title, catalog[related.id].title);
        assert.deepEqual(await page.evaluate(snapshotArticle), expectedArticle(catalog[related.id]), "related navigation");
        const hasCsp = metaCsp || (await page.locator('meta[http-equiv="Content-Security-Policy" i]').count() > 0) || (await Promise.all(documentResponses.map((response) => response.headerValue("content-security-policy")))).some(Boolean);
        const disabledScriptPreloads = [];
        for (const failure of failedResources) {
          if (intentionalDisabledPreload({ ...failure, javaScriptEnabled, scriptPreload: scriptPreloads.has(failure.url), hasCsp })) disabledScriptPreloads.push(failure.url);
          else failures.push(`${failure.url}: ${failure.errorText}`);
        }
        assert.deepEqual(failures, [], `${profile}: browser/resource errors`);
        result.profiles.push({ profile, javaScriptEnabled, forms: true, related: true, styles: true, disabledScriptPreloads: [...new Set(disabledScriptPreloads)] });
      } finally { await context.close(); }
    }
  }
  if (source === "api") {
    assert.ok(upstream, "API checks need upstream control URL");
    const context = await browser.newContext({ javaScriptEnabled: false });
    context.setDefaultNavigationTimeout(20000);
    const page = await context.newPage();
    try {
      for (const target of ["page", "json"]) {
        for (const version of ["one", "two"]) {
          const changed = { ...record, title: `${record.title} upstream ${version}` };
          await control(upstream, { record: changed, pretty: true });
          if (target === "json") {
            const response = await get(`${base}/api/catalog/${record.id}`);
            assert.equal(response.status, 200);
            assert.deepEqual(JSON.parse(response.body), changed, "JSON cannot reuse a cached upstream record");
            assert.notEqual(response.body, JSON.stringify(changed, null, 2), "JSON must serialize, not forward the upstream body");
          } else {
            assert.equal((await page.goto(`${base}/catalog/${record.id}`, { waitUntil: "load" }))?.status(), 200);
            assert.deepEqual(await page.evaluate(snapshotArticle), expectedArticle(changed), "page cannot reuse a cached upstream record");
          }
          await once(upstream, record.id);
        }
        await control(upstream, { status: 503 });
        const response = await get(`${base}${target === "json" ? "/api" : ""}/catalog/${record.id}`, target === "json" ? "application/json" : "text/html");
        assert.ok(response.status >= 500 && response.status < 600, `${target}: upstream 503 became ${response.status}`);
        await once(upstream, record.id);
      }
      result.upstream = { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true };
    } finally { await context.close(); await control(upstream, {}); }
  }
  assert.equal(result.pages, expectedPageChecks(catalog), "incomplete page checks");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, source = "fixture", upstream, output] = process.argv.slice(2);
  if (!base || !["fixture", "api"].includes(source)) throw new Error("usage: node bench/catalog/check.mjs BASE [fixture|api] [UPSTREAM]");
  const catalog = validateCatalog(JSON.parse(readFileSync(join(here, "fixtures/catalog.json"), "utf8")));
  const { chromium } = await import("@playwright/test");
  const browser = steady(await chromium.launch({ headless: true }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { browser.close().finally(() => process.exit(1)); });
  const watchdog = setTimeout(() => { console.error("catalog checks exceeded 15 minutes"); browser.close().finally(() => process.exit(1)); }, 15 * 60 * 1000);
  try {
    const result = JSON.stringify(await checkApp({ base, catalog, source, upstream, browser }), null, 2);
    if (output) writeFileSync(output, result);
    console.log(result);
  }
  finally { clearTimeout(watchdog); await browser.close(); }
}
