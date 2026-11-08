import { createFileRoute, useLocation } from "@tanstack/react-router";
import { getMarketplacePage } from "../marketplace-api";
import { Marketplace } from "../marketplace-page";
import { isLocale, readQuery, sameOrigin } from "../marketplace";
import { NotFound } from "../not-found";

export const Route = createFileRoute("/marketplace/$locale/$id")({
  server: { handlers: {
    GET: ({ params, next }) => isLocale(params.locale) ? next() : new Response("Unsupported locale", { status: 400 }),
    POST: async ({ request, params, next }) => {
      if (!isLocale(params.locale)) return new Response("Unsupported locale", { status: 400 });
      if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
      return next();
    },
  } },
  loader: ({ params }) => {
    if (!isLocale(params.locale)) throw new Error("Unsupported locale");
    return getMarketplacePage({ data: { locale: params.locale, id: params.id } });
  },
  staleTime: 0,
  gcTime: 0,
  head: () => ({ meta: [{ title: "Marketplace | Card Market" }], links: [{ rel: "stylesheet", href: "/marketplace.css" }] }),
  notFoundComponent: NotFound,
  component: MarketplacePage,
});
function MarketplacePage() {
  const props = Route.useLoaderData();
  const search = useLocation({ select: (location) => location.searchStr });
  return <Marketplace {...props} query={readQuery(new URLSearchParams(search))} />;
}
