import { getCookie, getRequest, setCookie, setResponseHeader } from "@tanstack/react-start/server";
import { alertCookie, alertLifetime, appendAlert } from "./alerts.server";
import { alertMessage, sameOrigin, targetMinor, type Locale, type MarketplaceRecord } from "./marketplace";

export function submitMarketplaceAlert(locale: Locale, record: MarketplaceRecord, form: FormData) {
  const request = getRequest();
  if (!sameOrigin(request)) throw new Response("Forbidden", { status: 403 });
  const email = String(form.get("email") ?? "");
  const minor = targetMinor(locale, String(form.get("target_price") ?? ""));
  const message = alertMessage(locale, record.title, form);
  if (email.includes("@") && minor !== null) {
    const previous = getCookie(alertCookie);
    const token = appendAlert(previous, { item_id: record.id, email, target_minor: minor });
    if (token !== previous) setCookie(alertCookie, token, {
      path: "/", httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", maxAge: alertLifetime,
    });
  }
  setResponseHeader("Cache-Control", "private, no-store");
  return { message };
}
