import { createFileRoute } from "@tanstack/react-router";
import { fetchMarketplaceRecord } from "../marketplace.server";

export const Route = createFileRoute("/api/marketplace/$id")({
  server: { handlers: { GET: async ({ params }) => {
    const record = await fetchMarketplaceRecord(params.id);
    return record ? Response.json(record, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "not found" }, { status: 404 });
  } } },
});
