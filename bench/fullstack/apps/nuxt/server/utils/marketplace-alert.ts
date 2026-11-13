import type { H3Event } from "h3";
import { getCookie, setCookie, getRequestURL, getHeader, createError, setHeader } from "h3";
import { alertCookie, alertLifetime, appendAlert } from "./alerts";
import { alertMessage, isLocale, targetMinor } from "../../shared/marketplace";
import { fetchMarketplaceRecord } from "./marketplace";

export async function submitMarketplaceAlert(event: H3Event, locale: string, id: string, form: FormData) {
  if (!isLocale(locale)) throw createError({ statusCode: 400, statusMessage: "Unsupported locale" });
  const origin = getHeader(event, "origin");
  if (getHeader(event, "sec-fetch-site") === "cross-site" || (origin && origin !== getRequestURL(event).origin))
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  const record = await fetchMarketplaceRecord(id);
  if (!record) throw createError({ statusCode: 404, statusMessage: "Not found" });
  const email = String(form.get("email") ?? ""), target = String(form.get("target_price") ?? "");
  const minor = targetMinor(locale, target);
  const message = alertMessage(locale, record.title, email, target);
  if (email.includes("@") && minor !== null) {
    const previous = getCookie(event, alertCookie);
    const token = appendAlert(previous, { item_id: record.id, email, target_minor: minor });
    if (token !== previous) setCookie(event, alertCookie, token, {
      path: "/", httpOnly: true, sameSite: "lax", secure: getRequestURL(event).protocol === "https:", maxAge: alertLifetime,
    });
  }
  setHeader(event, "Cache-Control", "private, no-store");
  return { record, message };
}
