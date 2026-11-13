import { error } from "@sveltejs/kit";
import { isLocale, alertMessage, targetMinor } from "#lib/marketplace";
import { alertCookie, alertLifetime, appendAlert } from "#lib/server/alerts";
import { fetchMarketplaceRecord } from "#lib/server/marketplace";
import type { Actions, PageServerLoad } from "./$types";
export const prerender = false;
export const load: PageServerLoad = async ({ params, url, setHeaders, locals }) => {
  if (!isLocale(params.locale)) error(400, "Unsupported locale");
  const record = locals.marketplaceAlertRecord ?? await fetchMarketplaceRecord(params.id);
  if (!record) error(404, "Not found");
  if (!locals.marketplaceAlertRecord) setHeaders({ "Cache-Control": "no-store" });
  return { record, locale: params.locale, query: url.searchParams.toString() };
};
export const actions: Actions = {
  default: async ({ request, params, cookies, url, setHeaders, locals }) => {
    if (!isLocale(params.locale)) error(400, "Unsupported locale");
    const origin = request.headers.get("origin");
    if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== url.origin)) error(403, "Forbidden");
    const form = await request.formData();
    const record = await fetchMarketplaceRecord(params.id);
    if (!record) error(404, "Not found");
    locals.marketplaceAlertRecord = record;
    const email = String(form.get("email") ?? ""), target = String(form.get("target_price") ?? "");
    const minor = targetMinor(params.locale, target);
    const message = alertMessage(params.locale, record.title, email, target);
    if (email.includes("@") && minor !== null) {
      const previous = cookies.get(alertCookie);
      const token = appendAlert(previous, { item_id: record.id, email, target_minor: minor });
      if (token !== previous) cookies.set(alertCookie, token, {
        path: "/", httpOnly: true, sameSite: "lax", secure: url.protocol === "https:", maxAge: alertLifetime,
      });
    }
    setHeaders({ "Cache-Control": "private, no-store" });
    return { message };
  },
};
