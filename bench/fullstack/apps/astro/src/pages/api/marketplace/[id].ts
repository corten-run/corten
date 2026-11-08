import type { APIRoute } from "astro";
import { fetchMarketplaceRecord } from "../../../lib/marketplace";
export const prerender = false;
export const GET: APIRoute = async ({ params }) => {
  const record = await fetchMarketplaceRecord(params.id ?? "");
  return record ? Response.json(record, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "not found" }, { status: 404 });
};
