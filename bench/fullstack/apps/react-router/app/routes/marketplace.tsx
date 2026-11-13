import { data, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Marketplace } from "../marketplace-page";
import { alertMessage, isLocale, marketplacePath, readQuery, sameOrigin, targetMinor, type MarketplaceRecord } from "../marketplace";
import { appendAlert } from "../alerts.server";
import { sessionCookie } from "../alert-cookie.server";
import { fetchMarketplaceRecord } from "../marketplace.server";

export const links = () => [{ rel: "stylesheet", href: "/marketplace.css" }];
export const meta = () => [{ title: "Marketplace | Card Market" }];
declare module "react-router" {
  interface AppLoadContext { marketplaceAlertRecord?: MarketplaceRecord }
}
export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const locale = params.locale ?? "";
  if (!isLocale(locale)) throw new Response("Unsupported locale", { status: 400 });
  const record = context.marketplaceAlertRecord ?? await fetchMarketplaceRecord(params.id ?? "");
  if (!record) throw new Response("Not found", { status: 404 });
  return { record, locale, query: readQuery(new URL(request.url).searchParams) };
}
export async function action({ request, params, context }: ActionFunctionArgs) {
  if (request.method !== "POST") throw new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  const locale = params.locale ?? "";
  if (!isLocale(locale)) throw new Response("Unsupported locale", { status: 400 });
  if (!sameOrigin(request)) throw new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const record = await fetchMarketplaceRecord(params.id ?? "");
  if (!record) throw new Response("Not found", { status: 404 });
  // Check the native view's URL encodings before the alert can be committed.
  marketplacePath(locale, record.id);
  for (const line of record.contents) marketplacePath(locale, line.item_id);
  for (const line of record.included_in) marketplacePath(locale, line.item_id);
  const email = String(form.get("email") ?? "");
  const minor = targetMinor(locale, String(form.get("target_price") ?? ""));
  const message = alertMessage(locale, record.title, form);
  context.marketplaceAlertRecord = record;
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (email.includes("@") && minor !== null) {
    const previous = await sessionCookie.parse(request.headers.get("Cookie"));
    const token = appendAlert(previous, { item_id: record.id, email, target_minor: minor });
    if (token !== previous) headers.append("Set-Cookie", await sessionCookie.serialize(token, {
      secure: new URL(request.url).protocol === "https:",
    }));
  }
  return data({ message }, { headers });
}
export default function MarketplacePage() {
  const props = useLoaderData<typeof loader>();
  const form = useActionData<typeof action>();
  const message = form?.message ?? "";
  return <Marketplace {...props} message={message} />;
}
