import { json } from "@sveltejs/kit";
import { fetchCatalogRecord } from "#lib/server/catalog";
import type { RequestHandler } from "./$types";

export const prerender = false;

export const GET: RequestHandler = async ({ params }) => {
  const record = await fetchCatalogRecord(params.id);
  return record ? json(record) : json({ error: "not found" }, { status: 404 });
};
