import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { alertMessage, toItemView, type ItemView } from "./view-model";

const base = process.env.API_BASE ?? "http://localhost:8080";

// ITEM_SOURCE=fixture: API responses from FIXTURE_PATH, converted once, so the benchmark
// measures the web server alone.
let fixture: Map<string, ItemView> | null | undefined;
async function loadFixture() {
  if (fixture === undefined) {
    if (process.env.ITEM_SOURCE === "fixture") {
      const { readFileSync } = await import("node:fs");
      const raw = JSON.parse(readFileSync(process.env.FIXTURE_PATH ?? "fixtures/items.json", "utf8"));
      fixture = new Map(Object.entries(raw).map(([id, value]) => [id, toItemView(value)] as const));
    } else {
      fixture = null;
    }
  }
  return fixture;
}

/** The item, or null when there is no such item. Server only. */
export async function fetchItem(id: string): Promise<ItemView | null> {
  const items = await loadFixture();
  if (items) return items.get(id) ?? null;
  const res = await fetch(`${base}/api/discovery/items/${encodeURIComponent(id)}`);
  if (!res.ok && res.status !== 404) throw new Error(`item API returned ${res.status}`);
  return res.status === 404 ? null : toItemView(await res.json());
}

export const getItem = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<ItemView> => {
    const item = await fetchItem(id);
    if (!item) throw notFound();
    return item;
  });

/** A card on the home page. */
export type Card = { id: string; title: string; subtitle: string | null; from: string };

/** Corten's home page cards: the first 50 items by id with items in memory, none from the item API (which cannot list items). */
export const getShelf = createServerFn({ method: "GET" }).handler(async (): Promise<Card[]> => {
  const items = await loadFixture();
  if (!items) return [];
  return Array.from({ length: 50 }, (_, i) => items.get(`item_${i + 1}`))
    .filter((item) => item !== undefined)
    .map((item) => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      from: item.summary ? `From ${item.summary.lowest ?? "—"}` : "No listings yet",
    }));
});

export const createAlert = createServerFn({ method: "POST" })
  .validator((form: FormData) => ({
    title: String(form.get("title") ?? ""),
    email: String(form.get("email") ?? ""),
    target: String(form.get("target_price") ?? ""),
  }))
  .handler(async ({ data }) => ({ message: alertMessage(data.title, data.email, data.target) }));
