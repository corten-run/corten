import { submitMarketplaceAlert } from "../../utils/marketplace-alert";

export default defineEventHandler(async (event) => {
  const form = await readFormData(event);
  const result = await submitMarketplaceAlert(event, String(form.get("locale") ?? ""), getRouterParam(event, "id") ?? "", form);
  return { message: result.message };
});
