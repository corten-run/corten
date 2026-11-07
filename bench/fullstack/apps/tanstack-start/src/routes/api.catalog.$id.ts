import { createFileRoute } from "@tanstack/react-router";
import { fetchCatalogRecord } from "../catalog.server";

export const Route = createFileRoute("/api/catalog/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const record = await fetchCatalogRecord(params.id);
        return record ? Response.json(record) : Response.json({ error: "not found" }, { status: 404 });
      },
    },
  },
});
