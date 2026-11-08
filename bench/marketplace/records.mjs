import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { locales } from "./contract.mjs";
export const labels = JSON.parse(readFileSync(new URL("./labels.json", import.meta.url)));
function exact(value, keys, at) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${at}: object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${at}: keys`);
}
const string = (v) => assert.equal(typeof v, "string");
const integer = (v, min = 0, max = 1e9) => assert.ok(Number.isSafeInteger(v) && v >= min && v <= max, "bounded integer");
export function validateRecord(r, id = r?.id) {
  exact(r, ["id", "title", "subtitle", "description", "categories", "badges", "tags", "images", "fields", "summary", "listings", "offers", "contents", "included_in"], id);
  assert.equal(r.id, id);
  for (const k of ["id", "title", "description"]) string(r[k]);
  if (r.subtitle !== null) string(r.subtitle);
  for (const k of ["categories", "badges", "tags", "images", "fields", "listings", "offers", "contents", "included_in"]) assert.ok(Array.isArray(r[k]), k);
  for (const k of ["badges", "tags", "images"]) r[k].forEach(string);
  const rows = (key, keys, check) => r[key].forEach((v) => { exact(v, keys, key); check(v); });
  rows("categories", ["name", "slug"], (v) => { string(v.name); string(v.slug); });
  rows("fields", ["name", "value"], (v) => { string(v.name); string(v.value); });
  if (r.summary !== null) {
    exact(r.summary, ["lowest_minor", "count", "quantity"], "summary");
    if (r.summary.lowest_minor !== null) integer(r.summary.lowest_minor, -1e9);
    integer(r.summary.count); integer(r.summary.quantity);
  }
  rows("listings", ["id", "seller", "rating_hundredths", "reviews", "condition", "ships_from", "quantity", "price_minor"], (v) => {
    [v.id, v.seller, v.condition, v.ships_from].forEach(string); integer(v.reviews); integer(v.quantity);
    if (v.rating_hundredths !== null) integer(v.rating_hundredths, 0, 500);
    if (v.price_minor !== null) integer(v.price_minor, -1e9);
  });
  rows("offers", ["id", "buyer", "condition", "quantity", "price_minor"], (v) => {
    [v.id, v.buyer, v.condition].forEach(string); integer(v.quantity);
    if (v.price_minor !== null) integer(v.price_minor, -1e9);
  });
  for (const k of ["contents", "included_in"]) rows(k, ["id", "item_id", "title", "quantity"], (v) => {
    [v.id, v.item_id, v.title].forEach(string); integer(v.quantity);
  });
  for (const key of ["listings", "offers", "contents", "included_in"]) assert.equal(new Set(r[key].map((v) => v.id)).size, r[key].length, `${key}: duplicate id`);
  return r;
}
export function validateMarketplace(data) {
  assert.deepEqual(Object.keys(data).sort(), Array.from({ length: 500 }, (_, i) => `item_${i + 1}`).sort());
  for (const [id, r] of Object.entries(data)) {
    validateRecord(r, id);
    for (const line of [...r.contents, ...r.included_in]) assert.ok(Object.hasOwn(data, line.item_id));
  }
  return data;
}
export const normalize = (s) => s.replace(/[\u00a0\u202f]/g, " ").replace(/[\t\n\r\f ]+/g, " ").trim();
export function expectedPage(record, locale, { seller = "", sort = "asc", all = false, message = "" } = {}) {
  assert.ok(locales.includes(locale));
  const l = labels[locale];
  const money = (v) => v === null ? "—" : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v / 100);
  const count = (v) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v);
  const rating = (v) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, roundingMode: "halfExpand" }).format(v / 100);
  const plural = (v) => l[`listing_${new Intl.PluralRules(locale).select(v)}`] ?? l.listing_other;
  const listings = record.listings.filter((v) => v.seller.startsWith(seller)).sort((a, b) => a.price_minor === null ? b.price_minor === null ? 0 : 1 : b.price_minor === null ? -1 : (sort === "desc" ? -1 : 1) * (a.price_minor - b.price_minor));
  return {
    locale, title: record.title, subtitle: record.subtitle, categories: record.categories.map((v) => v.name), badges: record.badges,
    images: record.images.map((src, i) => ({ src, label: `${record.title} ${i + 1}` })),
    summary: record.summary ? [`${money(record.summary.lowest_minor)} ${l.lowest}`, `${count(record.summary.count)} ${plural(record.summary.count)}`, `${count(record.summary.quantity)} ${l.available}`] : [l.no_listings],
    headings: [l.listings, l.offers, l.alert, l.details, l.contents, l.included],
    listingHeaders: [l.seller, l.condition, l.ships_from, l.qty, l.price, l.reviews],
    listings: listings.map((v) => ({ id: v.id, cells: [v.seller + (v.rating_hundredths === null ? "" : ` · ${rating(v.rating_hundredths)} ★`), v.condition, v.ships_from, count(v.quantity), money(v.price_minor), count(v.reviews)] })),
    offerHeaders: [l.buyer, l.condition, l.qty, l.price],
    offers: (all ? record.offers : record.offers.slice(0, 5)).map((v) => ({ id: v.id, cells: [v.buyer, v.condition, count(v.quantity), money(v.price_minor)] })),
    more: !all && record.offers.length > 5 ? l.show_all : null, description: record.description, fields: record.fields, tags: record.tags,
    controls: { filterLabel: l.filter, sortLabel: l.sort, emailLabel: l.email, targetLabel: l.target, apply: l.apply, submit: l.submit, options: [l.asc, l.desc] },
    contents: record.contents.map((v) => ({ href: `/marketplace/${locale}/${v.item_id}`, text: `${v.title} × ${count(v.quantity)}` })),
    included: record.included_in.map((v) => ({ href: `/marketplace/${locale}/${v.item_id}`, text: `${v.title} × ${count(v.quantity)}` })),
    message,
  };
}
