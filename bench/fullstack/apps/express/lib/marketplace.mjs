// Numeric marketplace records and request-local CLDR presentation (Intl).
import { readFileSync } from "node:fs";

export const labels = JSON.parse(readFileSync(new URL("./marketplace-labels.json", import.meta.url), "utf8"));

export const isLocale = (value) => Object.hasOwn(labels, value);

function createFormatters(locale) {
  return {
    labels: labels[locale],
    money: new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "symbol",
      useGrouping: true, minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: "halfExpand" }),
    rating: new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 0,
      maximumFractionDigits: 1, roundingMode: "halfExpand" }),
    count: new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }),
    plurals: new Intl.PluralRules(locale, { type: "cardinal" }),
  };
}
const formats = new Map();
export function formatters(locale) {
  let result = formats.get(locale);
  if (!result) {
    result = createFormatters(locale);
    formats.set(locale, result);
  }
  return result;
}

export const marketplacePath = (locale, id) => `/marketplace/${locale}/${encodeURIComponent(id)}`;

export function readQuery(query) {
  return { seller: typeof query.seller === "string" ? query.seller : "", sort: query.sort === "desc" ? "desc" : "asc", allOffers: query.offers === "all" };
}

export function sortedListings(record, query) {
  return record.listings.filter((row) => row.seller.startsWith(query.seller)).sort((a, b) => {
    if (a.price_minor === null) return b.price_minor === null ? 0 : 1;
    if (b.price_minor === null) return -1;
    return (a.price_minor - b.price_minor) * (query.sort === "desc" ? -1 : 1);
  });
}

// Intl exposes decimal symbols, but not a parser. Accept ungrouped decimals only
// instead of guessing whether a separator means grouping or a fraction.
export function targetAmount(locale, text) {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal").value;
  const escaped = decimal === "." ? "\\." : decimal;
  if (!new RegExp("^\\d+(?:" + escaped + "\\d{1,2})?$").test(text)) return null;
  const amount = Number(text.replace(decimal, "."));
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(Math.round(amount * 100)) ? amount : null;
}

export function alertMessage(locale, title, email, target) {
  const f = formatters(locale);
  if (!email.includes("@")) return f.labels.invalid_email;
  const amount = targetAmount(locale, target);
  if (amount === null) return f.labels.invalid_price;
  const replacements = { email, title, price: f.money.format(amount) };
  return f.labels.alert_set.replace(/\{(email|title|price)\}/g, (_, name) => replacements[name]);
}

/** What the page shows, formatted for this request. */
export function pageModel(locale, record, query, form) {
  const f = formatters(locale);
  const money = (minor) => (minor === null ? "\u2014" : f.money.format(minor / 100));
  const path = marketplacePath(locale, record.id);
  return {
    locale, record, labels: f.labels, query, path,
    itemPath: (id) => marketplacePath(locale, id),
    more: `${path}?${new URLSearchParams({ seller: query.seller, sort: query.sort, offers: "all" })}`,
    summary: record.summary && {
      lowest: money(record.summary.lowest_minor),
      count: `${f.count.format(record.summary.count)} ${f.labels[`listing_${f.plurals.select(record.summary.count)}`]}`,
      quantity: f.count.format(record.summary.quantity),
    },
    listings: sortedListings(record, query).map((row) => ({ ...row,
      rating: row.rating_hundredths === null ? null : f.rating.format(row.rating_hundredths / 100),
      quantityText: f.count.format(row.quantity), price: money(row.price_minor), reviewsText: f.count.format(row.reviews) })),
    offers: (query.allOffers ? record.offers : record.offers.slice(0, 5)).map((row) => ({ ...row,
      quantityText: f.count.format(row.quantity), price: money(row.price_minor) })),
    contents: record.contents.map((row) => ({ ...row, quantityText: f.count.format(row.quantity) })),
    included: record.included_in.map((row) => ({ ...row, quantityText: f.count.format(row.quantity) })),
    email: form?.email ?? "", target: form?.target ?? "",
    message: form ? alertMessage(locale, record.title, form.email, form.target) : "",
  };
}

const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => typeof value === "string";
const integer = (value) => Number.isSafeInteger(value);
const count = (value) => integer(value) && value >= 0;
const nullable = (check) => (value) => value === null || check(value);
const array = (check) => (value) => Array.isArray(value) && value.every(check);
const shape = (fields) => (value) =>
  object(value) && Object.keys(value).length === Object.keys(fields).length &&
  Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const line = shape({ id: text, item_id: text, title: text, quantity: count });
const checkRecord = shape({
  id: text, title: text, subtitle: nullable(text), description: text,
  categories: array(shape({ name: text, slug: text })), badges: array(text), tags: array(text), images: array(text),
  fields: array(shape({ name: text, value: text })),
  summary: nullable(shape({ lowest_minor: nullable(integer), count, quantity: count })),
  listings: array(shape({ id: text, seller: text,
    rating_hundredths: nullable((value) => integer(value) && value >= 0 && value <= 500),
    reviews: count, condition: text, ships_from: text, quantity: count, price_minor: nullable(integer) })),
  offers: array(shape({ id: text, buyer: text, condition: text, quantity: count, price_minor: nullable(integer) })),
  contents: array(line), included_in: array(line),
});
export function parseMarketplaceRecord(value) {
  if (!checkRecord(value)) throw new Error("Invalid marketplace record");
  return value;
}

const base = process.env.API_BASE ?? "http://localhost:8080";
const fixture = process.env.MARKETPLACE_SOURCE === "fixture"
  ? new Map(Object.entries(JSON.parse(readFileSync(process.env.MARKETPLACE_FIXTURE_PATH ?? "/fixtures/marketplace.json", "utf8")))
    .map(([id, value]) => [id, parseMarketplaceRecord(value)]))
  : null;

export async function fetchMarketplaceRecord(id) {
  if (fixture) return fixture.get(id) ?? null;
  const response = await fetch(`${base}/marketplace/records/${encodeURIComponent(id)}`, { redirect: "manual" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`marketplace API returned ${response.status}`);
  return parseMarketplaceRecord(await response.json());
}
