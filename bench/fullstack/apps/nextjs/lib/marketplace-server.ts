import { readFileSync } from "node:fs";
import type { MarketplaceRecord } from "./marketplace";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string";
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const count = (value: unknown) => integer(value) && value >= 0;
const nullable = (check: (value: unknown) => boolean) => (value: unknown) => value === null || check(value);
const array = (check: (value: unknown) => boolean) => (value: unknown) => Array.isArray(value) && value.every(check);
const shape = (fields: Record<string, (value: unknown) => boolean>) => (value: unknown) =>
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
export function parseMarketplaceRecord(value: unknown): MarketplaceRecord {
  if (!checkRecord(value)) throw new Error("Invalid marketplace record");
  return value as MarketplaceRecord;
}
const base = process.env.API_BASE ?? "http://localhost:8080";
const startup = globalThis as typeof globalThis & { __marketplaceFixture?: Map<string, MarketplaceRecord> };
const fixture = process.env.MARKETPLACE_SOURCE === "fixture"
  ? startup.__marketplaceFixture ??= new Map(Object.entries(JSON.parse(readFileSync(
      process.env.MARKETPLACE_FIXTURE_PATH ?? "/fixtures/marketplace.json", "utf8",
    ))).map(([id, value]) => [id, parseMarketplaceRecord(value)]))
  : null;

export async function fetchMarketplaceRecord(id: string): Promise<MarketplaceRecord | null> {
  if (fixture) return fixture.get(id) ?? null;
  const response = await fetch(base + "/marketplace/records/" + encodeURIComponent(id), { cache: "no-store", redirect: "manual" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("marketplace API returned " + response.status);
  return parseMarketplaceRecord(await response.json());
}
