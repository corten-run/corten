import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { isLocale, sameOrigin, type Locale } from "./marketplace";

export const getMarketplacePage = createServerFn({ method: "GET" })
  .validator((input: { locale: Locale; id: string }) => input)
  .handler(async ({ data }) => {
    const { fetchMarketplaceRecord } = await import("./marketplace.server");
    const record = await fetchMarketplaceRecord(data.id);
    if (!record) throw notFound();
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest();
    const form = request.method === "POST" ? await request.formData() : null;
    let message = "";
    if (form) {
      const { submitMarketplaceAlert } = await import("./marketplace-alert.server");
      message = submitMarketplaceAlert(data.locale, record, form).message;
    }
    return { record, locale: data.locale, message };
  });

export const createMarketplaceAlert = createServerFn({ method: "POST" })
  .validator((form: FormData) => {
    if (!(form instanceof FormData)) throw new Error("Expected form data");
    return { locale: String(form.get("locale") ?? ""), id: String(form.get("item_id") ?? ""),
      email: String(form.get("email") ?? ""), target: String(form.get("target_price") ?? "") };
  })
  .handler(async ({ data }) => {
    if (!isLocale(data.locale)) throw new Response("Unsupported locale", { status: 400 });
    const { getRequest } = await import("@tanstack/react-start/server");
    if (!sameOrigin(getRequest())) throw new Response("Forbidden", { status: 403 });
    const { fetchMarketplaceRecord } = await import("./marketplace.server");
    const record = await fetchMarketplaceRecord(data.id);
    if (!record) throw notFound();
    const { submitMarketplaceAlert } = await import("./marketplace-alert.server");
    const form = new FormData();
    form.set("email", data.email); form.set("target_price", data.target);
    return submitMarketplaceAlert(data.locale, record, form);
  });
