// Same view model and rules as sveltekit/src/lib/view-model.ts.
import { readFileSync } from "node:fs";

const money = (amount, code) => (amount == null || code == null ? null : code === "USD" ? `$${amount}` : `${amount} ${code}`);

export function toItemView(a) {
  return {
    id: String(a.catalog_item_id),
    title: a.title ?? "",
    subtitle: a.subtitle ?? null,
    description: a.description ?? "",
    badges: (a.display_badges ?? []).map((b) => String(b.label)),
    tags: (a.tags ?? []).map(String),
    categories: (a.categories ?? []).map((c) => ({ name: String(c.name), slug: String(c.slug) })),
    fields: (a.field_values ?? []).map((f) => ({
      name: String(f.fieldName ?? f.fieldId),
      value: typeof f.value === "string" ? f.value : JSON.stringify(f.value),
    })),
    images: (a.image_urls ?? []).slice(0, 2).map(String),
    summary: a.market_summary
      ? {
          lowest: money(a.market_summary.lowest_price_amount, a.market_summary.lowest_price_currency_code),
          count: Number(a.market_summary.active_listing_count),
          quantity: Number(a.market_summary.total_visible_quantity),
        }
      : null,
    listings: (a.market_listings ?? []).map((l) => ({
      id: String(l.listing_id),
      seller: l.seller_display_name ?? "Seller",
      rating: l.seller_average_rating ?? null,
      reviews: Number(l.seller_review_count ?? 0),
      condition: l.product_summary ?? "",
      ships_from: l.ship_from_code ?? "",
      quantity: Number(l.visible_quantity ?? 0),
      price: money(l.price_amount, l.price_currency_code) ?? "",
      price_value: Number(l.price_amount),
    })),
    offers: (a.offer_demand_matches ?? []).map((o) => ({
      id: String(o.offer_id),
      buyer: o.buyer_display_name ?? "Buyer",
      condition: o.product_summary ?? "",
      quantity: Number(o.quantity_requested ?? 0),
      price: money(o.price_amount, o.price_currency_code) ?? "",
    })),
    contents: (a.contents ?? []).map((c) => ({
      id: String(c.line_id),
      item_id: String(c.contained_catalog_item_id),
      title: c.contained_item?.title ?? String(c.contained_catalog_item_id),
      quantity: Number(c.quantity ?? 1),
    })),
    included_in: (a.included_in ?? []).map((c) => ({
      id: String(c.line_id),
      item_id: String(c.container_catalog_item_id),
      title: c.container_item?.title ?? String(c.container_catalog_item_id),
      quantity: Number(c.quantity ?? 1),
    })),
  };
}

const base = process.env.API_BASE ?? "http://localhost:8080";
// ITEM_SOURCE=fixture: API responses from FIXTURE_PATH, converted once, so the benchmark measures
// the web server alone.
const fixture = process.env.ITEM_SOURCE === "fixture"
  ? new Map(Object.entries(JSON.parse(readFileSync(process.env.FIXTURE_PATH ?? "fixtures/items.json", "utf8"))).map(([id, value]) => [id, toItemView(value)]))
  : null;

/** The items the home page lists: the first 50 by id with items in memory, none from the item API. */
export function shelf() {
  if (!fixture) return [];
  return Array.from({ length: 50 }, (_, i) => fixture.get(`item_${i + 1}`)).filter(Boolean);
}

export async function fetchItem(id) {
  if (fixture) return fixture.get(id) ?? null;
  const response = await fetch(`${base}/api/discovery/items/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`item API returned ${response.status}`);
  return toItemView(await response.json());
}

export function alertMessage(title, email, target) {
  const price = Number(target.trim());
  if (!email.includes("@")) return "Enter a valid email address.";
  if (!(price > 0)) return "Enter a target price above zero.";
  return `Alert set: we will email ${email} when ${title} drops below $${price.toFixed(2)}.`;
}
