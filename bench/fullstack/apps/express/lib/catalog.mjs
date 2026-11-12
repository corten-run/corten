// Strings-only catalog records, independent of the marketplace view model.
import { readFileSync } from "node:fs";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCatalogRecord(value) {
  if (
    !isObject(value) ||
    !["id", "title", "subtitle", "description"].every((key) => typeof value[key] === "string") ||
    !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string") ||
    !Array.isArray(value.fields) || !value.fields.every((field) =>
      isObject(field) && typeof field.name === "string" && typeof field.value === "string") ||
    !Array.isArray(value.related) || !value.related.every((record) =>
      isObject(record) && typeof record.id === "string" && typeof record.title === "string")
  ) throw new Error("Invalid catalog record");
  return value;
}

const base = process.env.API_BASE ?? "http://localhost:8080";
const fixture = process.env.CATALOG_SOURCE === "fixture"
  ? new Map(Object.entries(JSON.parse(readFileSync(process.env.CATALOG_FIXTURE_PATH ?? "/fixtures/catalog.json", "utf8")))
    .map(([id, value]) => [id, parseCatalogRecord(value)]))
  : null;

export async function fetchCatalogRecord(id, { signal } = {}) {
  if (fixture) return fixture.get(id) ?? null;
  const response = await fetch(`${base}/catalog/records/${encodeURIComponent(id)}`, { redirect: "manual", signal });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error(`catalog API returned ${response.status}`);
  }
  return parseCatalogRecord(await response.json());
}
