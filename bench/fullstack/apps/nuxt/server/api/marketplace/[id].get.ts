import { fetchMarketplaceRecord } from "../../utils/marketplace";
export default defineEventHandler(async (event) => {
  const record = await fetchMarketplaceRecord(getRouterParam(event, "id") ?? "");
  if (!record) throw createError({ statusCode: 404, statusMessage: "Not found" });
  setResponseHeader(event, "Cache-Control", "no-store");
  return record;
});
