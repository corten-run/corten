// Import the item source at startup, so a fixture is loaded before the first request.
import "#lib/server/api";
import "#lib/server/catalog";
import "#lib/server/marketplace";
import { isLocale } from "#lib/marketplace";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = ({ event, resolve }) => {
  const locale = event.url.pathname.match(/^\/marketplace\/([^/]+)\/[^/]+\/?$/)?.[1];
  if (!locale || !isLocale(locale)) return resolve(event);
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('<html lang="en">', `<html lang="${locale}">`),
  });
};
