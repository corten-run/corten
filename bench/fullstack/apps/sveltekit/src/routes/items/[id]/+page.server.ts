import { error } from "@sveltejs/kit";
import { fetchItem } from "#lib/server/api";
import { alertMessage } from "#lib/view-model";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => {
  const item = await fetchItem(params.id);
  if (!item) error(404, "Not found");
  // "Show all" without JavaScript (or before hydration) loads the page with ?offers=all.
  return { item, allOffers: url.searchParams.get("offers") === "all" };
};

export const actions: Actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    return { message: alertMessage(String(form.get("title") ?? ""), String(form.get("email") ?? ""), String(form.get("target_price") ?? "")) };
  },
};
