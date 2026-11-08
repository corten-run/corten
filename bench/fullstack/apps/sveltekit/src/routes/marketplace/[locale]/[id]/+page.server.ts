import { error } from "@sveltejs/kit";
import { isLocale } from "#lib/marketplace";
import { fetchMarketplaceRecord } from "#lib/server/marketplace";
import type { Actions, PageServerLoad } from "./$types";
export const prerender = false;
export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
  if (!isLocale(params.locale)) error(400, "Unsupported locale");
  const record = await fetchMarketplaceRecord(params.id);
  if (!record) error(404, "Not found");
  setHeaders({ "Cache-Control": "no-store" });
  return { record, locale: params.locale, query: url.searchParams.toString() };
};
export const actions: Actions = {
  default: async ({ request, params }) => {
    if (!isLocale(params.locale)) error(400, "Unsupported locale");
    const form = await request.formData();
    // The load function fetches once for the full POST page; validation uses that record's title.
    return { alert: { email: String(form.get("email") ?? ""), target: String(form.get("target_price") ?? "") } };
  },
};
