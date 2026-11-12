import { getCookie, getRequest, setCookie, setResponseHeader } from "@tanstack/react-start/server";
import { alertCookie, alertLifetime, appendAlert } from "./alerts.server";
import { alertMessage, sameOrigin, targetAmount, type Locale, type MarketplaceRecord } from "./marketplace";

export function submitMarketplaceAlert(locale: Locale, record: MarketplaceRecord, form: FormData) {
  const request = getRequest();
  if (!sameOrigin(request)) throw new Response("Forbidden", { status: 403 });
  const email = String(form.get("email") ?? "");
  const amount = targetAmount(locale, String(form.get("target_price") ?? ""));
  if (email.includes("@") && amount !== null) {
    const previous = getCookie(alertCookie);
    const token = appendAlert(previous, { item_id: record.id, email, target_minor: Math.round(amount * 100) });
    if (token !== previous) setCookie(alertCookie, token, {
      path: "/", httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", maxAge: alertLifetime,
    });
  }
  setResponseHeader("Cache-Control", "private, no-store");
  return { message: alertMessage(locale, record.title, form) };
}
