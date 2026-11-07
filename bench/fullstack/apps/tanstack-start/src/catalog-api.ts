import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

export const getCatalogRecord = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { fetchCatalogRecord } = await import("./catalog.server");
    const record = await fetchCatalogRecord(id);
    if (!record) throw notFound();
    return record;
  });
