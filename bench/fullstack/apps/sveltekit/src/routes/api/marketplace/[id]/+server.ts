import { json } from "@sveltejs/kit";
import { fetchMarketplaceRecord } from "#lib/server/marketplace";
import type { RequestHandler } from "./$types";
export const prerender = false;
export const GET: RequestHandler = async ({ params }) => {
  const record = await fetchMarketplaceRecord(params.id);
  return record ? json(record, { headers: { "Cache-Control": "no-store" } }) : json({ error: "not found" }, { status: 404 });
};
