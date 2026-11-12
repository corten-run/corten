// Independent browser oracle. This module is never imported by a measured app.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { locales } from "./contract.mjs";
import { expectedPage, labels, normalize, validateMarketplace, validateRecord } from "./records.mjs";
import { get } from "../catalog/check.mjs";
import { referenceHtml } from "./reference.mjs";

export function snapshotPage() {
  const norm = (s) => s.replace(/[\u00a0\u202f]/g, " ").replace(/[\t\n\r\f ]+/g, " ").trim();
  const roots = document.querySelectorAll("main article.marketplace");
  if (roots.length !== 1) throw new Error(`expected one marketplace article, got ${roots.length}`);
  const root = roots[0];
  if (globalThis.marketplaceInjected) throw new Error("fixture executed script");
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (["script", "style"].includes(el.localName) || el.matches('input[type="hidden"]')) continue;
    const s = getComputedStyle(el);
    if (el.hidden || el.localName === "template" || el.getAttribute("aria-hidden") === "true" || s.display === "none" || s.visibility !== "visible" || Number(s.opacity) === 0) throw new Error(`hidden work: ${el.localName}`);
  }
  const q = (s) => { const nodes = root.querySelectorAll(s); if (nodes.length !== 1) throw new Error(`${s}: expected one, got ${nodes.length}`); return nodes[0]; };
  const texts = (s) => [...root.querySelectorAll(s)].map((v) => norm(v.textContent));
  const rows = (s, attr) => [...q(s).querySelectorAll("tbody tr")].map((v) => ({ id: v.getAttribute(attr), cells: [...v.querySelectorAll("td")].map((c) => norm(c.textContent)) }));
  const links = (s) => [...q(s).querySelectorAll("ul li")].map((v) => { const a = v.querySelectorAll("a"); if (a.length !== 1) throw new Error("expected one related link"); return { href: a[0].getAttribute("href"), text: norm(v.textContent) }; });
  const message = q(".marketplace__message");
  const subtitle = root.querySelector(".marketplace__subtitle");
  const fields = q(".marketplace__details dl");
  const names = [...fields.querySelectorAll("dt")], values = [...fields.querySelectorAll("dd")];
  if (names.length !== values.length) throw new Error("unpaired fields");
  for (const s of [".marketplace__badges", ".marketplace__images", ".marketplace__details > ul"]) q(s);
  for (const control of root.querySelectorAll("input:not([type=hidden]),select,button")) {
    if (control.disabled || control.readOnly) throw new Error("disabled control");
    if (control.matches("input,select") && ![...root.querySelectorAll("label")].some((l) => l.contains(control) || l.htmlFor && l.htmlFor === control.id)) throw new Error(`unlabelled ${control.name}`);
  }
  const controlLabel = (name) => {
    const control = q(`[name="${name}"]`), label = [...root.querySelectorAll("label")].find((l) => l.contains(control) || l.htmlFor && l.htmlFor === control.id);
    const clone = label.cloneNode(true); clone.querySelectorAll("input,select").forEach((el) => el.remove()); return norm(clone.textContent);
  };
  const filter = q(".marketplace__listings form"), alert = q(".marketplace__alert form");
  if (filter.method !== "get" || alert.method !== "post") throw new Error("native GET/POST methods required");
  for (const form of [filter, alert]) if (new URL(form.action).pathname !== location.pathname) throw new Error("form action must retain locale and record");
  if (q('[name="email"]').type !== "email" || q('[name="target_price"]').type !== "text" || q('[name="target_price"]').inputMode !== "decimal") throw new Error("input semantics");
  return {
    locale: document.documentElement.lang, title: norm(q("h1").textContent), subtitle: subtitle ? norm(subtitle.textContent) : null,
    categories: texts(".marketplace__categories a"), badges: texts(".marketplace__badges li"),
    images: [...root.querySelectorAll(".marketplace__image")].map((v) => { if (v.getAttribute("role") !== "img") throw new Error("image role"); return { src: v.getAttribute("data-src"), label: norm(v.getAttribute("aria-label")) }; }),
    summary: texts(".marketplace__summary > span"), headings: texts("section h2"), listingHeaders: texts(".marketplace__listings thead th"),
    listings: rows(".marketplace__listings table", "data-listing-id"), offerHeaders: texts(".marketplace__offers thead th"), offers: rows(".marketplace__offers table", "data-offer-id"),
    more: root.querySelector(".marketplace__more") ? norm(root.querySelector(".marketplace__more").textContent) : null,
    controls: { filterLabel: controlLabel("seller"), sortLabel: controlLabel("sort"), emailLabel: controlLabel("email"), targetLabel: controlLabel("target_price"), apply: norm(filter.querySelector('[type="submit"]').textContent), submit: norm(alert.querySelector('[type="submit"]').textContent), options: [...q('[name="sort"]').options].map((o) => norm(o.textContent)) },
    description: norm(q(".marketplace__details > p").textContent), fields: names.map((v, i) => ({ name: norm(v.textContent), value: norm(values[i].textContent) })), tags: texts(".marketplace__details > ul li"),
    contents: links(".marketplace__contents"), included: links(".marketplace__included"), message: norm(message.textContent),
  };
}
const normalized = (v) => typeof v === "string" ? normalize(v) : Array.isArray(v) ? v.map(normalized) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalized(x)])) : v;
export function styleSnapshot() {
  const properties = ["display", "position", "max-width", "margin-top", "margin-right", "margin-bottom", "margin-left", "font-family", "font-size", "font-weight", "line-height", "color", "background-color", "border-collapse", "border-bottom-width", "border-bottom-style", "padding-top", "padding-right", "padding-bottom", "padding-left", "gap", "flex-wrap", "text-align", "list-style-type"];
  const root = document.querySelector("article.marketplace"), origin = root.getBoundingClientRect();
  const selector = "h1,h2,p,nav,ul,li,a,section,span,strong,form,label,input,select,button,table,thead,tbody,tr,th,td,dl,dt,dd,.marketplace__images,.marketplace__image";
  return [root, ...root.querySelectorAll(selector)].filter((el) => !el.matches('input[type="hidden"]')).map((el) => {
    const box = el.getBoundingClientRect();
    return { tag: el.localName, style: properties.map((p) => getComputedStyle(el).getPropertyValue(p)), box: [box.x - origin.x, box.y - origin.y, box.width, box.height] };
  });
}
// Only numeric formatting spaces may vary with CLDR versions. Keep the reference
// markup and all nonnumeric text independent of the adapter under test.
export function numericFields(record, locale) {
  const p = expectedPage(record, locale), fields = [];
  const add = (selector, text, prefix = "", suffix = "") => fields.push({ selector, text, prefix, suffix });
  if (record.summary) {
    add(".marketplace__summary > span:nth-child(1) strong", p.summary[0].slice(0, -labels[locale].lowest.length - 1));
    const count = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    for (const [i, value] of [record.summary.count, record.summary.quantity].entries()) {
      const text = count.format(value);
      add(`.marketplace__summary > span:nth-child(${i + 2})`, text, "", p.summary[i + 1].slice(text.length));
    }
  }
  for (const [section, rows, columns] of [["listings", p.listings, [3, 4, 5]], ["offers", p.offers, [2, 3]]]) {
    for (const [i, row] of rows.entries()) for (const column of columns) add(`.marketplace__${section} tbody tr:nth-child(${i + 1}) td:nth-child(${column + 1})`, row.cells[column]);
  }
  for (const section of ["contents", "included"]) for (const [i, row] of p[section].entries()) {
    const at = row.text.lastIndexOf(" × ") + 3;
    add(`.marketplace__${section} li:nth-child(${i + 1})`, row.text.slice(at), row.text.slice(0, at));
  }
  return fields;
}
export function numericText(fields) {
  return fields.map(({ selector, prefix, suffix }) => {
    const nodes = document.querySelectorAll(`article.marketplace ${selector}`);
    if (nodes.length !== 1) throw new Error(`numeric field ${selector}: expected one`);
    let value = nodes[0].textContent.replace(/^[\t\n\r\f ]+|[\t\n\r\f ]+$/g, "");
    // Template indentation around the related-link separator or a label is not
    // part of number formatting. Never collapse whitespace inside the number.
    if (prefix) {
      const at = value.lastIndexOf("×") + 1;
      const norm = (s) => s.replace(/[\t\n\r\f ]+/g, " ").trim();
      if (!at || norm(value.slice(0, at)) !== norm(prefix)) throw new Error(`numeric prefix ${selector}`);
      value = value.slice(at).replace(/^[\t\n\r\f ]+/, "");
    }
    if (suffix) {
      const label = suffix.trim();
      if (!value.endsWith(label)) throw new Error(`numeric suffix ${selector}`);
      value = value.slice(0, -label.length).replace(/[\t\n\r\f ]+$/, "");
    }
    return value;
  });
}
export function verifyNumberSpaces(fields, values) {
  assert.equal(values.length, fields.length);
  const spaces = (s) => s.replace(/[\u00a0\u202f]/g, " ");
  return fields.map(({ selector, text }, i) => {
    const number = values[i];
    assert.equal(spaces(number), spaces(text), `numeric formatting ${selector}`);
    return number;
  });
}
export function alignNumberSpaces({ fields, numbers }) {
  fields.forEach(({ selector, text, prefix, suffix }, i) => {
    const el = document.querySelector(`article.marketplace ${selector}`);
    if (el.textContent !== prefix + text + suffix) throw new Error(`independent reference ${selector}`);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, offset = 0;
    while ((node = walker.nextNode())) {
      const start = offset;
      offset += node.data.length;
      node.data = node.data.split("").map((c, j) => {
        const at = start + j - prefix.length;
        return at >= 0 && at < text.length && /[ \u00a0\u202f]/.test(c) ? numbers[i][at] : c;
      }).join("");
    }
  });
}
export function compareStyles(actual, expected) {
  assert.equal(actual.length, expected.length, "style element count, including strong summary price");
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].tag, expected[i].tag, `style tag ${i}`);
    assert.deepEqual(actual[i].style, expected[i].style, `computed styles ${i} ${actual[i].tag}`);
    for (let j = 0; j < 4; j++) assert.ok(Math.abs(actual[i].box[j] - expected[i].box[j]) <= 1, `geometry ${i}/${j} ${actual[i].tag}: ${actual[i].box[j]} vs ${expected[i].box[j]}`);
  }
}
export function comparePage(actual, record, locale, options) {
  assert.deepEqual(actual, normalized(expectedPage(record, locale, options)));
}
export async function navigationFinished(page) {
  await page.waitForLoadState("load");
  // An intercepted navigation can commit its URL before replacing the DOM.
  // Await the platform lifecycle rather than disabling framework enhancement.
  await page.evaluate(() => globalThis.navigation?.transition?.finished);
}

export async function submitAlert(page, form, javaScriptEnabled) {
  const fields = await form.evaluate((f) => {
    const data = new FormData(f);
    return { email: data.get("email"), target_price: data.get("target_price") };
  });
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/marketplace/")),
    form.locator('[type="submit"]').click(),
  ]);
  try {
    await page.waitForFunction(() => document.querySelector(".marketplace__message")?.textContent.trim().length > 0);
    await page.waitForLoadState("networkidle");
  } catch (error) {
    throw new Error(`Alert POST ${response.status()} ${response.url()}; JS=${javaScriptEnabled}; fields=${JSON.stringify(fields)}; navigation=${response.request().isNavigationRequest()}; message=${JSON.stringify(await page.locator(".marketplace__message").textContent().catch(() => null))}; response=${(await response.text().catch(() => "unavailable")).slice(-2048)}`, { cause: error });
  }
}
async function control(upstream, value) {
  const response = await fetch(`${upstream}/__marketplace/control`, { method: "POST", body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); await response.text();
}
async function once(upstream, id) {
  const response = await get(`${upstream}/__marketplace/control`);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).requests, { [id]: 1 }, "one upstream request, no cache");
}
export async function checkApp({ base, catalog, source, upstream, browser }) {
  validateMarketplace(catalog);
  const result = { workload: "marketplace-v2", source, jsonRecords: 0, pages: 0, profiles: [], upstream: null };
  for (const [id, record] of Object.entries(catalog)) {
    const response = await get(`${base}/api/marketplace/${id}`);
    assert.equal(response.status, 200, id); assert.match(response.type ?? "", /^application\/json\b/);
    const value = validateRecord(JSON.parse(response.body), id);
    assert.deepEqual(value, record, `${id}: canonical numeric JSON`); result.jsonRecords++;
  }
  for (const path of ["/api/marketplace/not_found", "/marketplace/en-US/not_found"]) assert.equal((await get(base + path, "text/html")).status, 404);
  assert.equal((await get(`${base}/marketplace/es-ES/item_1`, "text/html")).status, 400);
  const css = readFileSync(new URL("./marketplace.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const locale of locales) for (const javaScriptEnabled of [false, true]) for (const mobile of [false, true]) {
    console.log(`marketplace parity ${source} ${locale} JS=${javaScriptEnabled} mobile=${mobile}`);
    const context = await browser.newContext({ javaScriptEnabled, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(20000);
    try {
      const page = await context.newPage();
      const errors = []; page.on("pageerror", (e) => errors.push(e.message));
      const visit = async (id, query = "", options = {}) => {
        const response = await page.goto(`${base}/marketplace/${locale}/${id}${query}`, { waitUntil: "load" });
        if (javaScriptEnabled) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(response.status(), 200);
        comparePage(await page.evaluate(snapshotPage), catalog[id], locale, options); result.pages++;
      };
      for (const id of ["item_1", "item_7", "item_11", "item_13", "item_17", "item_500"]) await visit(id);
      for (const seller of ["Alice", "alice", " Alice", '<&"\' +']) await visit("item_1", `?${new URLSearchParams({ seller })}`, { seller });
      await visit("item_1", "?sort=desc", { sort: "desc" });
      await visit("item_1", "?offers=all", { all: true });
      await visit("item_1");
      const sheets = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((l) => l.href));
      let canonicalSheet = false;
      for (const href of sheets) { const response = await context.request.get(href); if (response.ok() && (await response.text()).replaceAll("\r\n", "\n").includes(css)) canonicalSheet = true; }
      assert.ok(canonicalSheet, "canonical marketplace stylesheet must be served and linked");
      const style = await page.locator("article.marketplace").evaluate((el) => ({ padding: getComputedStyle(el).paddingTop, width: el.getBoundingClientRect().width, font: getComputedStyle(el).fontSize }));
      assert.equal(style.padding, mobile ? "8px" : "16px", "responsive stylesheet applied");
      const reference = await context.newPage();
      try {
        const baseCss = ["../fullstack/apps/axum-maud/static/style.css", "../fullstack/apps/axum-maud/static/components.css"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
        await reference.setContent(referenceHtml(catalog.item_1, locale).replace("</head>", `<style>${baseCss}\n${css}</style></head>`));
        const fields = numericFields(catalog.item_1, locale);
        const numbers = verifyNumberSpaces(fields, await page.evaluate(numericText, fields));
        await reference.evaluate(alignNumberSpaces, { fields, numbers });
        compareStyles(await page.evaluate(styleSnapshot), await reference.evaluate(styleSnapshot));
      } finally { await reference.close(); }
      const filter = page.locator(".marketplace__listings form");
      await filter.locator('[name="seller"]').fill("Alice"); await filter.locator('[name="sort"]').selectOption("desc");
      await Promise.all([page.waitForURL((u) => u.searchParams.get("seller") === "Alice" && u.searchParams.get("sort") === "desc"), filter.locator('[type="submit"]').click()]);
      await navigationFinished(page);
      comparePage(await page.evaluate(snapshotPage), catalog.item_1, locale, { seller: "Alice", sort: "desc" }); result.pages++;
      await Promise.all([page.waitForURL((u) => u.searchParams.get("offers") === "all"), page.locator(".marketplace__more").click()]);
      await navigationFinished(page);
      comparePage(await page.evaluate(snapshotPage), catalog.item_1, locale, { seller: "Alice", sort: "desc", all: true }); result.pages++;
      const link = page.locator(".marketplace__contents a").first();
      await Promise.all([page.waitForURL(`**/marketplace/${locale}/item_2`), link.click()]);
      await navigationFinished(page);
      comparePage(await page.evaluate(snapshotPage), catalog.item_2, locale); result.pages++;
      // Submit native forms so each framework keeps its normal CSRF protection.
      for (const [email, price, message] of [["invalid", "1", labels[locale].invalid_email], ["todd@example.test", "0", labels[locale].invalid_price],
        ["todd@example.test", locale === "en-US" ? "1234.50" : "1234,50", labels[locale].alert_set.replace("{email}", "todd@example.test").replace("{title}", catalog.item_1.title).replace("{price}", new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(1234.5))]]) {
        await visit("item_1");
        const form = page.locator(".marketplace__alert form");
        await form.locator('[name="email"]').fill(email); await form.locator('[name="target_price"]').fill(price);
        // HTML email validation would otherwise prevent the invalid-email server case.
        await form.evaluate((f) => { f.noValidate = true; });
        await submitAlert(page, form, javaScriptEnabled);
        comparePage(await page.evaluate(snapshotPage), catalog.item_1, locale, { message }); result.pages++;
      }
      assert.deepEqual(errors, [], "browser runtime errors");
      result.profiles.push({ locale, javaScriptEnabled, mobile, passed: true });
    } finally { await context.close(); }
  }
  if (source === "api") {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      for (const target of ["page", "json"]) {
        for (const locale of locales) {
        for (const version of [1, 2]) {
          const changed = { ...structuredClone(catalog.item_1), title: `Fresh title ${version}`, summary: { lowest_minor: version * 1234567, count: version === 1 ? 1 : 1000000, quantity: version * 1000 } };
          for (const [i, listing] of changed.listings.entries()) Object.assign(listing, { price_minor: i === version ? null : (version * 12345 + i) * (i % 3 ? 1 : -1), rating_hundredths: i === version ? null : 125 + version * 100, quantity: version * 1000 + i, reviews: version * 1000000 + i });
          for (const [i, offer] of changed.offers.entries()) Object.assign(offer, { price_minor: i === version ? null : version * 123450 + i, quantity: version * 1000 + i });
          for (const line of [...changed.contents, ...changed.included_in]) line.quantity = version * 1234567;
          await control(upstream, { record: changed, pretty: true });
          if (target === "page") {
            assert.equal((await page.goto(`${base}/marketplace/${locale}/item_1`)).status(), 200);
            comparePage(await page.evaluate(snapshotPage), changed, locale);
          } else {
            const response = await get(`${base}/api/marketplace/item_1`);
            assert.deepEqual(JSON.parse(response.body), changed);
            assert.notEqual(response.body, JSON.stringify(changed, null, 2), "JSON must be serialized by the app");
          }
          await once(upstream, "item_1");
        }
        }
        for (const status of [503, 302]) {
          await control(upstream, { status });
          const response = await get(`${base}${target === "page" ? "/marketplace/en-US" : "/api/marketplace"}/item_1`, target === "page" ? "text/html" : "application/json");
          assert.ok(response.status >= 500 && response.status < 600, `upstream ${status} must be refused`);
          await once(upstream, "item_1");
        }
      }
      result.upstream = { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true };
    } finally { await context.close(); await control(upstream, {}); }
  }
  assert.equal(result.profiles.length, 12);
  assert.equal(result.pages, 264);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, source = "fixture", upstream, output] = process.argv.slice(2);
  assert.ok(base && ["fixture", "api"].includes(source));
  const catalog = JSON.parse(readFileSync(new URL("./fixtures/marketplace.json", import.meta.url)));
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try { const value = JSON.stringify(await checkApp({ base, catalog, source, upstream, browser }), null, 2); if (output) writeFileSync(output, value); console.log(value); }
  finally { await browser.close(); }
}
