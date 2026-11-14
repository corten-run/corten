import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const directory = new URL("./src/", import.meta.url);
const model = await import(new URL("marketplace.ts", directory));
const record = {
  id: "item_1", title: '<script>&"{price}', subtitle: "", description: "<b>Data</b>",
  categories: [{ name: "Cards", slug: "cards" }], badges: ["Rare"], tags: ["foil"],
  images: ["/one.webp", "/two.webp"], fields: [{ name: "Set", value: "Ember" }],
  summary: { lowest_minor: -123450, count: 1000000, quantity: 1234 },
  listings: [
    { id: "a", seller: "Alice", rating_hundredths: 425, reviews: 1234, condition: "NM", ships_from: "US", quantity: 2, price_minor: 100 },
    { id: "b", seller: "Alice B", rating_hundredths: 499, reviews: 0, condition: "NM", ships_from: "DE", quantity: 1000, price_minor: 100 },
    { id: "c", seller: "bob", rating_hundredths: null, reviews: 1, condition: "", ships_from: "FR", quantity: 0, price_minor: null },
    { id: "d", seller: "Alice", rating_hundredths: 0, reviews: 2, condition: "NM", ships_from: "US", quantity: 1, price_minor: -1 },
  ],
  offers: Array.from({ length: 7 }, (_, i) => ({ id: "offer_" + i, buyer: "Buyer", condition: "NM", quantity: 1000, price_minor: i === 0 ? null : i })),
  contents: [{ id: "line_1", item_id: "item/2", title: "Other", quantity: 1000 }],
  included_in: [{ id: "line_2", item_id: "item_3", title: "Bundle", quantity: 2 }],
};
const query = model.readQuery(new URLSearchParams());
const spaces = (value) => value.replace(/[\u00a0\u202f]/g, " ");

test("native URL encoding rejects unpaired surrogates and preserves Unicode pairs", () => {
  for (const locale of ["en-US", "fr-FR", "de-DE"]) {
    for (const id of ["\ud800", "\udc00", "item/\ud800", "item/\udc00"]) {
      assert.throws(() => model.marketplacePath(locale, id), URIError);
    }
    assert.equal(model.marketplacePath(locale, "item/\ud83d\ude00"), "/marketplace/" + locale + "/item%2F%F0%9F%98%80");
  }
});

test("native Intl formats signed money, half-away ratings, grouped counts and cardinal plurals", () => {
  const expected = {
    "en-US": ["-$1,234.50", "$0.01", "4.3", "5", "1,000", "other"],
    "fr-FR": ["-1 234,50 $US", "0,01 $US", "4,3", "5", "1 000", "many"],
    "de-DE": ["-1.234,50 $", "0,01 $", "4,3", "5", "1.000", "other"],
  };
  for (const locale of Object.keys(expected)) {
    const f = model.formatters(locale);
    assert.deepEqual([f.money.format(-1234.5), f.money.format(.01), f.rating.format(4.25),
      f.rating.format(4.99), f.count.format(1000), f.plurals.select(1000000)].map(spaces), expected[locale]);
    assert.equal(f.plurals.select(1), "one");
    assert.equal(f.plurals.select(0), locale === "fr-FR" ? "one" : "other");
  }
  for (const locale of ["en-US", "fr-FR", "de-DE"]) assert.equal(model.isLocale(locale), true);
  for (const locale of ["en", "en-us", "FR-fr", "__proto__", "toString"]) assert.equal(model.isLocale(locale), false);
});

test("stable numeric sorting leaves missing prices last and never mutates cached records", () => {
  assert.deepEqual(model.sortedListings(record, query).map((r) => r.id), ["d", "a", "b", "c"]);
  assert.deepEqual(model.sortedListings(record, { ...query, sort: "desc" }).map((r) => r.id), ["a", "b", "d", "c"]);
  assert.deepEqual(model.sortedListings(record, { ...query, seller: "Alice B" }).map((r) => r.id), ["b"]);
  for (const seller of ["alice", " Alice", "Alice "]) {
    const expected = seller === "Alice " ? ["b"] : [];
    assert.deepEqual(model.sortedListings(record, { ...query, seller }).map((r) => r.id), expected);
  }
  assert.deepEqual(record.listings.map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(model.readQuery(new URLSearchParams("seller=+Alice&sort=desc&offers=all")),
    { seller: " Alice", sort: "desc", allOffers: true });
});

test("locale-decimal alert validation uses native money, not stored formatted strings", () => {
  for (const locale of ["en-US", "fr-FR", "de-DE"]) {
    const decimal = locale === "en-US" ? "." : ",";
    const f = model.formatters(locale);
    assert.equal(model.targetMinor(locale, "1234" + decimal + "50"), 123450);
    for (const bad of ["", "0", "-1", "Infinity", "1e3", "12wrong", "1" + decimal + "234", locale === "en-US" ? "1,50" : "1.50"]) {
      assert.equal(model.targetMinor(locale, bad), null, bad);
    }
    const form = new URLSearchParams({ email: "bad", target_price: "1" });
    assert.equal(model.alertMessage(locale, record.title, form), f.labels.invalid_email);
    form.set("email", "a@example.test"); form.set("target_price", "0");
    assert.equal(model.alertMessage(locale, record.title, form), f.labels.invalid_price);
    form.set("target_price", "1234" + decimal + "50");
    const message = model.alertMessage(locale, record.title, form);
    assert.ok(message.includes(f.money.format(1234.5)));
    assert.ok(message.includes(record.title));
    assert.ok(message.includes("a@example.test"));
  }
  assert.equal(model.sameOrigin(new Request("http://localhost:8080/a", { headers: { origin: "http://localhost:8080" } })), true);
  assert.equal(model.sameOrigin(new Request("http://localhost:8080/a", { headers: { origin: "http://evil.test" } })), false);
  assert.equal(model.sameOrigin(new Request("http://localhost:8080/a", { headers: { "sec-fetch-site": "cross-site" } })), false);
});

test("native React page renders complete escaped data, only visible offers, localized links and empty states", async () => {
  const source = (await readFile(new URL("marketplace-page.tsx", directory), "utf8")).replace('from "./marketplace"', 'from "./marketplace.ts"');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  const path = new URL(".marketplace-test-render.mjs", directory);
  try {
    await writeFile(path, compiled.outputText);
    const { Marketplace } = await import(path.href);
    for (const locale of ["en-US", "fr-FR", "de-DE"]) {
      const html = renderToStaticMarkup(createElement(Marketplace, { record, locale, query }));
      assert.equal((html.match(/<article/g) ?? []).length, 1);
      assert.ok(html.includes('class="marketplace"'));
      assert.ok(!html.includes("<script>"));
      assert.ok(html.includes("&lt;script&gt;&amp;&quot;{price}"));
      assert.equal((html.match(/data-offer-id=/g) ?? []).length, 5);
      assert.equal((html.match(/role="img"/g) ?? []).length, 2);
      assert.ok(html.includes('class="marketplace__subtitle"'));
      assert.ok(html.includes("/marketplace/" + locale + "/item%2F2"));
      const count = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
      assert.ok(html.includes('href="/marketplace/' + locale + '/item%2F2">Other</a> \u00d7 ' + count.format(1000)),
        "contents quantity must follow, not be part of, the title link");
      assert.ok(html.includes('href="/marketplace/' + locale + '/item_3">Bundle</a> \u00d7 ' + count.format(2)),
        "included-in quantity must follow, not be part of, the title link");
      assert.ok(html.includes("offers=all"));
      assert.ok(html.includes('method="post"'));
      assert.ok(!html.includes("<img"));
      const all = renderToStaticMarkup(createElement(Marketplace, { record, locale, query: { ...query, allOffers: true } }));
      assert.equal((all.match(/data-offer-id=/g) ?? []).length, 7);
      assert.ok(!all.includes('class="marketplace__more"'));
      if (locale === "fr-FR") assert.ok(html.includes("d’annonces"));
    }
    const empty = { ...record, subtitle: null, summary: null, listings: [], offers: [], tags: [], fields: [], images: [], badges: [], contents: [], included_in: [] };
    const html = renderToStaticMarkup(createElement(Marketplace, { record: empty, locale: "en-US", query }));
    assert.ok(!html.includes("marketplace__subtitle"));
    assert.ok(html.includes("No listings yet"));
    assert.ok(html.includes('class="marketplace__badges"></ul>'));
    assert.ok(html.includes('class="marketplace__contents"'));
    assert.ok(html.includes('class="marketplace__included"'));
    // Rendering twice reads the current numbers, not a cached formatted view model.
    const changed = renderToStaticMarkup(createElement(Marketplace, { record: { ...record, summary: { ...record.summary, lowest_minor: 1 } }, locale: "en-US", query }));
    assert.ok(changed.includes("$0.01"));
  } finally { await rm(path, { force: true }); }
});

test("fixture parses at startup, accepts nulls/empties, rejects malformed numeric records", async () => {
  const temp = await mkdtemp(join(tmpdir(), "marketplace-react-"));
  const path = join(temp, "fixture.json");
  const previousSource = process.env.MARKETPLACE_SOURCE;
  const previousPath = process.env.MARKETPLACE_FIXTURE_PATH;
  try {
    await writeFile(path, JSON.stringify({ item_1: record }));
    process.env.MARKETPLACE_SOURCE = "fixture"; process.env.MARKETPLACE_FIXTURE_PATH = path;
    const source = new URL("marketplace.server.ts", directory);
    const { fetchMarketplaceRecord, parseMarketplaceRecord } = await import(source.href + "?fixture");
    await rm(path);
    const bundle = await import(source.href + "?bundle");
    assert.deepEqual(await fetchMarketplaceRecord("item_1"), record);
    assert.deepEqual(await bundle.fetchMarketplaceRecord("item_1"), record);
    assert.equal(await fetchMarketplaceRecord("missing"), null);
    assert.deepEqual(JSON.parse(JSON.stringify(await fetchMarketplaceRecord("item_1"))), record);
    const empty = { ...record, summary: null, subtitle: null, listings: [], offers: [], contents: [], included_in: [] };
    assert.deepEqual(parseMarketplaceRecord(empty), empty);
    for (const bad of [
      { ...record, title: null }, { ...record, tags: undefined }, { ...record, extra: true },
      { ...record, summary: { ...record.summary, lowest_minor: 1.5 } },
      { ...record, summary: { ...record.summary, count: -1 } },
      { ...record, listings: [{ ...record.listings[0], rating_hundredths: 501 }] },
      { ...record, offers: [{ ...record.offers[0], price_minor: "1" }] },
      { ...record, included_in: [{ id: "a", title: "Bad", quantity: 2 }] },
    ]) assert.throws(() => parseMarketplaceRecord(bad), /Invalid marketplace record/);
  } finally {
    delete globalThis.__marketplaceFixture;
    if (previousSource === undefined) delete process.env.MARKETPLACE_SOURCE; else process.env.MARKETPLACE_SOURCE = previousSource;
    if (previousPath === undefined) delete process.env.MARKETPLACE_FIXTURE_PATH; else process.env.MARKETPLACE_FIXTURE_PATH = previousPath;
    await rm(temp, { recursive: true, force: true });
  }
});

test("HTTP parses once per request, encodes IDs, does not cache, propagates failures", async () => {
  const previousSource = process.env.MARKETPLACE_SOURCE;
  const previousBase = process.env.API_BASE;
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.MARKETPLACE_SOURCE; process.env.API_BASE = "http://marketplace.test";
    const { fetchMarketplaceRecord } = await import(new URL("marketplace.server.ts?http", directory));
    let fetches = 0, parses = 0, status = 200;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "http://marketplace.test/marketplace/records/item%2F1");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "manual");
      fetches++;
      return { status, ok: status === 200, json: async () => { parses++; return { ...record, title: String(fetches) }; } };
    };
    assert.equal((await fetchMarketplaceRecord("item/1")).title, "1");
    assert.equal((await fetchMarketplaceRecord("item/1")).title, "2");
    assert.equal(fetches, 2); assert.equal(parses, 2);
    status = 404; assert.equal(await fetchMarketplaceRecord("item/1"), null);
    status = 503; await assert.rejects(fetchMarketplaceRecord("item/1"), /API returned 503/);
    assert.equal(parses, 2);
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ...record, offers: null }) });
    await assert.rejects(fetchMarketplaceRecord("item/1"), /Invalid marketplace record/);
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad JSON"); } });
    await assert.rejects(fetchMarketplaceRecord("item/1"), /bad JSON/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSource === undefined) delete process.env.MARKETPLACE_SOURCE; else process.env.MARKETPLACE_SOURCE = previousSource;
    if (previousBase === undefined) delete process.env.API_BASE; else process.env.API_BASE = previousBase;
  }
});

test("HTTP rejects redirects without following Location or reading a second record", async () => {
  const previousSource = process.env.MARKETPLACE_SOURCE;
  const previousBase = process.env.API_BASE;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith("/redirect-target")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(record));
    } else {
      const status = Number(request.url.split("/").at(-1));
      response.writeHead(status, { Location: "/marketplace/records/redirect-target" });
      response.end();
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    delete process.env.MARKETPLACE_SOURCE;
    process.env.API_BASE = "http://127.0.0.1:" + server.address().port;
    const { fetchMarketplaceRecord } = await import(new URL("marketplace.server.ts?redirect", directory));
    for (const status of [301, 302, 303, 307, 308]) {
      await assert.rejects(fetchMarketplaceRecord(String(status)), new RegExp("API returned " + status));
    }
    assert.deepEqual(requests, [301, 302, 303, 307, 308].map((status) => "/marketplace/records/" + status));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousSource === undefined) delete process.env.MARKETPLACE_SOURCE; else process.env.MARKETPLACE_SOURCE = previousSource;
    if (previousBase === undefined) delete process.env.API_BASE; else process.env.API_BASE = previousBase;
  }
});
