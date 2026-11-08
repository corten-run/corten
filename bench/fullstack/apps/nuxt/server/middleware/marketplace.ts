// Let Nuxt render the ordinary page for a native form POST, retaining request-local inputs.
export default defineEventHandler(async (event) => {
  if (event.method !== "POST" || !/^\/marketplace\/[^/]+\/[^/]+\/?$/.test(getRequestURL(event).pathname)) return;
  const origin = getHeader(event, "origin");
  if (getHeader(event, "sec-fetch-site") === "cross-site" ||
      (origin && origin !== getRequestURL(event).origin)) {
    throw createError({ statusCode: 403, statusMessage: "Cross-site form submission forbidden" });
  }
  const form = await readFormData(event);
  event.context.marketplaceAlert = {
    email: String(form.get("email") ?? ""), target: String(form.get("target_price") ?? ""),
  };
});
