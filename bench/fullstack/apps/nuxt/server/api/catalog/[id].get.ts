export default defineEventHandler(async (event) => {
  const record = await fetchCatalogRecord(getRouterParam(event, "id") ?? "");
  if (!record) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return record;
});
