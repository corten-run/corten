import { createRouter, defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { NotFound } from "./not-found";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    // The catalog's ordinary GET field is text, not a JSON-encoded search value.
    parseSearch: (search) => {
      const parsed = defaultParseSearch(search);
      const field = new URLSearchParams(search).get("field");
      if (field !== null) parsed.field = field;
      return parsed;
    },
    stringifySearch: (search) => {
      const { field, ...rest } = search;
      if (typeof field !== "string") return defaultStringifySearch(search);
      const encoded = defaultStringifySearch(rest);
      return encoded + (encoded ? "&" : "?") + new URLSearchParams({ field });
    },
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFound,
    scrollRestoration: true,
  });
}
