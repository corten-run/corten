import type { LoaderFunctionArgs } from "react-router";
import { fetchCatalogRecord } from "../catalog.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const record = await fetchCatalogRecord(params.id ?? "");
  return record ? Response.json(record) : Response.json({ error: "not found" }, { status: 404 });
}
