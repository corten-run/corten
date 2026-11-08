import { readFileSync } from "node:fs";
import type { MarketplaceRecord } from "../../shared/marketplace";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown) => Number.isSafeInteger(value);
const count = (value: unknown) => integer(value) && (value as number) >= 0;
const money = (value: unknown) => value === null || integer(value);
const strings = (value: unknown, keys: string[]) =>
  object(value) && keys.every((key) => typeof value[key] === "string");
const rows = (value: unknown, valid: (row: any) => boolean) => Array.isArray(value) && value.every(valid);

export function parseMarketplaceRecord(value: unknown): MarketplaceRecord {
  if (!object(value) || !strings(value, ["id", "title", "description"]) ||
    !(value.subtitle === null || typeof value.subtitle === "string") ||
    !["badges", "tags", "images"].every((key) => rows(value[key], (row) => typeof row === "string")) ||
    !rows(value.categories, (row) => strings(row, ["name", "slug"])) ||
    !rows(value.fields, (row) => strings(row, ["name", "value"])) ||
    !(value.summary === null || (object(value.summary) && money(value.summary.lowest_minor) &&
      count(value.summary.count) && count(value.summary.quantity))) ||
    !rows(value.listings, (row) => strings(row, ["id", "seller", "condition", "ships_from"]) &&
      (row.rating_hundredths === null || (count(row.rating_hundredths) && row.rating_hundredths <= 500)) &&
      count(row.reviews) && count(row.quantity) && money(row.price_minor)) ||
    !rows(value.offers, (row) => strings(row, ["id", "buyer", "condition"]) && count(row.quantity) && money(row.price_minor)) ||
    !["contents", "included_in"].every((key) => rows(value[key], (row) =>
      strings(row, ["id", "item_id", "title"]) && count(row.quantity))))
    throw new Error("Invalid marketplace record");
  // Reconstruct only the wire fields; never relay extra upstream keys or pre-serialized data.
  const record = value as MarketplaceRecord;
  return {
    id: record.id, title: record.title, subtitle: record.subtitle, description: record.description,
    categories: record.categories.map(({ name, slug }) => ({ name, slug })),
    badges: [...record.badges], tags: [...record.tags], images: [...record.images],
    fields: record.fields.map(({ name, value }) => ({ name, value })),
    summary: record.summary === null ? null : {
      lowest_minor: record.summary.lowest_minor, count: record.summary.count, quantity: record.summary.quantity,
    },
    listings: record.listings.map(({ id, seller, rating_hundredths, reviews, condition, ships_from, quantity, price_minor }) =>
      ({ id, seller, rating_hundredths, reviews, condition, ships_from, quantity, price_minor })),
    offers: record.offers.map(({ id, buyer, condition, quantity, price_minor }) => ({ id, buyer, condition, quantity, price_minor })),
    contents: record.contents.map(({ id, item_id, title, quantity }) => ({ id, item_id, title, quantity })),
    included_in: record.included_in.map(({ id, item_id, title, quantity }) => ({ id, item_id, title, quantity })),
  };
}
const base = process.env.API_BASE ?? "http://localhost:8080";
const fixture = process.env.MARKETPLACE_SOURCE === "fixture"
  ? new Map(Object.entries(JSON.parse(readFileSync(
      process.env.MARKETPLACE_FIXTURE_PATH ?? "/fixtures/marketplace.json", "utf8",
    ))).map(([id, value]) => [id, parseMarketplaceRecord(value)]))
  : null;

export async function fetchMarketplaceRecord(id: string): Promise<MarketplaceRecord | null> {
  if (fixture) return fixture.get(id) ?? null;
  const response = await fetch(`${base}/marketplace/records/${encodeURIComponent(id)}`, { cache: "no-store", redirect: "manual" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`marketplace API returned ${response.status}`);
  return parseMarketplaceRecord(await response.json());
}
