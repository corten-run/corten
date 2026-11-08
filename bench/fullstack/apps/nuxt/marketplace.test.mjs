import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { marketplaceRecord, marketplaceFixture } from "./marketplace.fixture.mjs";
import { locales, isLocale, marketplacePath, marketplaceView, alertMessage } from "./shared/marketplace.ts";

const source = new URL("./server/utils/marketplace.ts", import.meta.url);
const spaces = (text) => text.replace(/[\u00a0\u202f]/g, " ");
const restore = (key, value) => value === undefined ? delete process.env[key] : process.env[key] = value;

test("copied contract assets remain byte-identical", async () => {
  assert.deepEqual(await readFile(new URL("./public/marketplace.css", import.meta.url)), await readFile(new URL("../../../marketplace/marketplace.css", import.meta.url)));
  assert.deepEqual(await readFile(new URL("./shared/marketplace-labels.json", import.meta.url)), await readFile(new URL("../../../marketplace/labels.json", import.meta.url)));
});

test("native Intl formats signed minor prices, half-away ratings, grouped counts and CLDR plurals", () => {
  assert.equal(isLocale("en"), false);
  assert.equal(isLocale("fr-FR"), true);
  assert.equal(marketplacePath("de-DE", "item/2"), "/marketplace/de-DE/item%2F2");
  const prices = {
    "en-US": ["$0.00", "$0.01", "$0.10", "$1.25", "$1,234.50", "$1,234,567.89", "-$1,234.50"],
    "fr-FR": ["0,00 $US", "0,01 $US", "0,10 $US", "1,25 $US", "1 234,50 $US", "1 234 567,89 $US", "-1 234,50 $US"],
    "de-DE": ["0,00 $", "0,01 $", "0,10 $", "1,25 $", "1.234,50 $", "1.234.567,89 $", "-1.234,50 $"],
  };
  for (const locale of locales) {
    const record = marketplaceRecord();
    const view = marketplaceView(record, locale, new URLSearchParams());
    const byId = new Map(view.listings.map((row) => [row.id, row]));
    prices[locale].forEach((price, i) => assert.equal(spaces(byId.get(`listing_${i}`).priceText), price));
    assert.equal(byId.get("listing_7").priceText, "—");
    for (const [i, rating] of [[0, "0"], [1, "4"], [2, locale === "en-US" ? "4.3" : "4,3"], [3, locale === "en-US" ? "4.8" : "4,8"], [4, "5"]])
      assert.equal(byId.get(`listing_${i}`).sellerText, `Alice ${i} · ${rating} ★`);
    const count = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const word = locale === "fr-FR" ? ["annonce", "annonce", "annonces", "annonces", "d’annonces"]
      : locale === "de-DE" ? ["Angebote", "Angebot", "Angebote", "Angebote", "Angebote"]
      : ["listings", "listing", "listings", "listings", "listings"];
    [0, 1, 2, 1000, 1000000].forEach((value, i) => {
      record.summary.count = value;
      assert.equal(marketplaceView(record, locale, new URLSearchParams()).summary.count, `${count.format(value)} ${word[i]}`);
    });
  }
});

test("stable numeric sort, nulls last, exact prefix, offers and locale-preserving links", () => {
  const record = marketplaceRecord();
  const get = (query = "") => marketplaceView(record, "fr-FR", new URLSearchParams(query));
  assert.deepEqual(get().listings.map((row) => row.id), [6, 0, 1, 2, 3, 8, 4, 5, 7].map((i) => `listing_${i}`));
  assert.deepEqual(get("sort=desc").listings.map((row) => row.id), [5, 4, 3, 8, 2, 1, 0, 6, 7].map((i) => `listing_${i}`));
  assert.equal(get("seller=alice").listings[0].id, "listing_7");
  assert.equal(get("seller=%20Alice").listings[0].id, "listing_8");
  assert.equal(get("seller=ALICE").listings.length, 0);
  assert.equal(get().offers.length, 5);
  assert.equal(get("offers=all").offers.length, 8);
  assert.equal(get("offers=all").more, null);
  const more = new URL(get("seller=Alice+%26&sort=desc").more, "http://test");
  assert.equal(more.pathname, "/marketplace/fr-FR/item_1");
  assert.equal(more.searchParams.get("seller"), "Alice &");
  assert.equal(more.searchParams.get("sort"), "desc");
  assert.equal(more.searchParams.get("offers"), "all");
  assert.equal(get().contents[0].href, "/marketplace/fr-FR/item_2");
  assert.equal(get().included[0].href, "/marketplace/fr-FR/item_3");
  const empty = marketplaceView(marketplaceFixture().item_2, "de-DE", new URLSearchParams());
  assert.equal(empty.summary, null);
  assert.deepEqual(empty.listings, []);
  assert.deepEqual(empty.offers, []);
  record.summary.lowest_minor = null;
  assert.equal(get().summary.lowest, "—");
  record.summary.lowest_minor = 1;
  assert.equal(spaces(get().summary.lowest), "0,01 $US");
});

test("native locale-aware form validation and safe placeholder substitution", () => {
  for (const locale of locales) {
    const words = marketplaceView(marketplaceRecord(), locale, new URLSearchParams()).words;
    assert.equal(alertMessage(locale, "Title", "bad", "12"), words.invalid_email);
    for (const value of ["", "0", "-1", "NaN", "Infinity", "1e2", "1,2,3", "1.2.3", locale === "en-US" ? "1,25" : "1.25"])
      assert.equal(alertMessage(locale, "Title", "x@y", value), words.invalid_price);
    const result = alertMessage(locale, "{email} $&", "x@y", locale === "en-US" ? "1234.50" : "1234,50");
    assert.ok(result.includes("{email} $&"));
    assert.ok(result.includes("x@y"));
    assert.ok(result.includes(new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(1234.5)));
  }
});

test("fixture is read and parsed once, retains nulls/numbers, strips extra upstream fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-test-"));
  const path = join(directory, "records.json");
  const oldSource = process.env.MARKETPLACE_SOURCE, oldPath = process.env.MARKETPLACE_FIXTURE_PATH;
  try {
    await writeFile(path, JSON.stringify(marketplaceFixture()));
    process.env.MARKETPLACE_SOURCE = "fixture"; process.env.MARKETPLACE_FIXTURE_PATH = path;
    const { fetchMarketplaceRecord, parseMarketplaceRecord } = await import(source.href + "?fixture");
    await rm(path);
    assert.deepEqual(await fetchMarketplaceRecord("item_1"), marketplaceRecord());
    assert.equal(await fetchMarketplaceRecord("missing"), null);
    assert.deepEqual(parseMarketplaceRecord({ ...marketplaceRecord(), extra: "omit" }), marketplaceRecord());
    for (const invalid of [{ ...marketplaceRecord(), subtitle: undefined }, { ...marketplaceRecord(), listings: [{ seller: 1 }] },
      { ...marketplaceRecord(), offers: [{ ...marketplaceRecord().offers[0], price_minor: "1" }] },
      { ...marketplaceRecord(), summary: { lowest_minor: 1, count: -1, quantity: 1 } }])
      assert.throws(() => parseMarketplaceRecord(invalid), /Invalid marketplace record/);
  } finally {
    restore("MARKETPLACE_SOURCE", oldSource); restore("MARKETPLACE_FIXTURE_PATH", oldPath);
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP source fetches/parses once per request, URL-encodes IDs and propagates failures", async () => {
  const oldSource = process.env.MARKETPLACE_SOURCE, oldBase = process.env.API_BASE, originalFetch = globalThis.fetch;
  try {
    delete process.env.MARKETPLACE_SOURCE; process.env.API_BASE = "http://marketplace.test";
    const { fetchMarketplaceRecord } = await import(source.href + "?http");
    let calls = 0, parses = 0, status = 200;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, "http://marketplace.test/marketplace/records/item%2F1");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "manual");
      return { status, ok: status === 200, json: async () => { parses++; return { ...marketplaceRecord(), title: String(calls) }; } };
    };
    assert.equal((await fetchMarketplaceRecord("item/1")).title, "1");
    assert.equal((await fetchMarketplaceRecord("item/1")).title, "2");
    assert.equal(calls, 2); assert.equal(parses, 2);
    status = 404; assert.equal(await fetchMarketplaceRecord("item/1"), null);
    status = 503; await assert.rejects(fetchMarketplaceRecord("item/1"), /marketplace API returned 503/);
    status = 302; await assert.rejects(fetchMarketplaceRecord("item/1"), /marketplace API returned 302/);
    assert.equal(parses, 2);
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({}) });
    await assert.rejects(fetchMarketplaceRecord("item/1"), /Invalid marketplace record/);
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(fetchMarketplaceRecord("item/1"), /offline/);
  } finally {
    globalThis.fetch = originalFetch; restore("MARKETPLACE_SOURCE", oldSource); restore("API_BASE", oldBase);
  }
});
