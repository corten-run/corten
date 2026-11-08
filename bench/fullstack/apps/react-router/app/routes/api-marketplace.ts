import type { LoaderFunctionArgs } from "react-router";
import { fetchMarketplaceRecord } from "../marketplace.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const record = await fetchMarketplaceRecord(params.id ?? "");
  return record ? Response.json(record, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "not found" }, { status: 404 });
}
