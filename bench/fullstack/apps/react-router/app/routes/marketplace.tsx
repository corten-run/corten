import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Marketplace } from "../marketplace-page";
import { alertMessage, isLocale, readQuery, sameOrigin } from "../marketplace";
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
  if (!isLocale(params.locale ?? "")) throw new Response("Unsupported locale", { status: 400 });
  if (!sameOrigin(request)) throw new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  return { email: String(form.get("email") ?? ""), target_price: String(form.get("target_price") ?? "") };
}
export default function MarketplacePage() {
  const props = useLoaderData<typeof loader>();
  const form = useActionData<typeof action>();
  const message = form ? alertMessage(props.locale, props.record.title, new URLSearchParams(form)) : "";
  return <Marketplace {...props} message={message} />;
}
