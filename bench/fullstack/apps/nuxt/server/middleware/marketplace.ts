// Let Nuxt render the ordinary page for a native form POST, retaining request-local inputs.
import { submitMarketplaceAlert } from "../utils/marketplace-alert";
export default defineEventHandler(async (event) => {
  if (event.method !== "POST" || !/^\/marketplace\/[^/]+\/[^/]+\/?$/.test(getRequestURL(event).pathname)) return;
  const origin = getHeader(event, "origin");
  if (getHeader(event, "sec-fetch-site") === "cross-site" ||
      (origin && origin !== getRequestURL(event).origin)) {
    throw createError({ statusCode: 403, statusMessage: "Cross-site form submission forbidden" });
  }
  const form = await readFormData(event);
  const parts = getRequestURL(event).pathname.split("/");
  event.context.marketplaceAlert = await submitMarketplaceAlert(event, decodeURIComponent(parts[2]!), decodeURIComponent(parts[3]!), form);
});
