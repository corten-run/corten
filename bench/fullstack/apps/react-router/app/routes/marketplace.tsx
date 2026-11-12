import { data, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Marketplace } from "../marketplace-page";
import { alertMessage, isLocale, readQuery, sameOrigin, targetAmount } from "../marketplace";
import { appendAlert } from "../alerts.server";
import { sessionCookie } from "../alert-cookie.server";
import { fetchMarketplaceRecord } from "../marketplace.server";

export const links = () => [{ rel: "stylesheet", href: "/marketplace.css" }];
export const meta = () => [{ title: "Marketplace | Card Market" }];
export async function loader({ params, request }: LoaderFunctionArgs) {
  const locale = params.locale ?? "";
  if (!isLocale(locale)) throw new Response("Unsupported locale", { status: 400 });
  const record = await fetchMarketplaceRecord(params.id ?? "");
  if (!record) throw new Response("Not found", { status: 404 });
  return { record, locale, query: readQuery(new URL(request.url).searchParams) };
}
export async function action({ request, params }: ActionFunctionArgs) {
  const locale = params.locale ?? "";
  if (!isLocale(locale)) throw new Response("Unsupported locale", { status: 400 });
  if (!sameOrigin(request)) throw new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const record = await fetchMarketplaceRecord(params.id ?? "");
  if (!record) throw new Response("Not found", { status: 404 });
  const email = String(form.get("email") ?? "");
  const amount = targetAmount(locale, String(form.get("target_price") ?? ""));
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (email.includes("@") && amount !== null) {
    const previous = await sessionCookie.parse(request.headers.get("Cookie"));
    const token = appendAlert(previous, { item_id: record.id, email, target_minor: Math.round(amount * 100) });
    if (token !== previous) headers.append("Set-Cookie", await sessionCookie.serialize(token, {
      secure: new URL(request.url).protocol === "https:",
    }));
  }
  return data({ message: alertMessage(locale, record.title, form) }, { headers });
}
export default function MarketplacePage() {
  const props = useLoaderData<typeof loader>();
  const form = useActionData<typeof action>();
  const message = form?.message ?? "";
  return <Marketplace {...props} message={message} />;
}
