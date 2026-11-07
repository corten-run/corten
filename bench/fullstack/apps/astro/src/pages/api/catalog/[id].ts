import type { APIRoute } from "astro";
import { fetchCatalogRecord } from "../../../lib/catalog";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const record = await fetchCatalogRecord(params.id ?? "");
  return record ? Response.json(record) : Response.json({ error: "not found" }, { status: 404 });
};
