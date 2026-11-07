import { error } from "@sveltejs/kit";
import { fetchCatalogRecord } from "#lib/server/catalog";
import type { PageServerLoad } from "./$types";

export const prerender = false;

export const load: PageServerLoad = async ({ params, url }) => {
  const record = await fetchCatalogRecord(params.id);
  if (!record) error(404, "Not found");
  return { record, field: url.searchParams.get("field") ?? "" };
};
