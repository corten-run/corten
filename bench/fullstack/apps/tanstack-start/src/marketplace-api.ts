import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { alertMessage, type Locale } from "./marketplace";

export const getMarketplacePage = createServerFn({ method: "GET" })
  .validator((input: { locale: Locale; id: string }) => input)
  .handler(async ({ data }) => {
    const { fetchMarketplaceRecord } = await import("./marketplace.server");
    const record = await fetchMarketplaceRecord(data.id);
    if (!record) throw notFound();
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest();
    const form = request.method === "POST" ? await request.formData() : null;
    return { record, locale: data.locale, message: form ? alertMessage(data.locale, record.title, form) : "" };
  });
