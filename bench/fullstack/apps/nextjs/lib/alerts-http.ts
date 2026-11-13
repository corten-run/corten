import type { IncomingMessage, ServerResponse } from "node:http";
import { alertCookie, alertLifetime, appendAlert, ensureSession, readAlerts } from "./alerts.server";
import { alertMessage, marketplacePath, targetMinor, type Locale, type MarketplaceRecord } from "./marketplace";

type RequestWithCookies = IncomingMessage & { cookies: Partial<Record<string, string>> };
function setCookie(req: RequestWithCookies, res: ServerResponse, token: string) {
  const secure = (req.socket as { encrypted?: boolean }).encrypted ? "; Secure" : "";
  res.appendHeader("Set-Cookie", `${alertCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${alertLifetime}${secure}`);
}
export function alertsFor(req: RequestWithCookies, res: ServerResponse) {
  const previous = req.cookies[alertCookie];
  const token = ensureSession(previous);
  if (token !== previous) setCookie(req, res, token);
  return readAlerts(token);
}
export function submitAlert(req: RequestWithCookies, res: ServerResponse, locale: Locale,
  record: MarketplaceRecord, form: URLSearchParams) {
  // Check the native view's URL encodings before the alert can be committed.
  marketplacePath(locale, record.id);
  for (const line of record.contents) marketplacePath(locale, line.item_id);
  for (const line of record.included_in) marketplacePath(locale, line.item_id);
  const email = form.get("email") ?? "";
  const minor = targetMinor(locale, form.get("target_price") ?? "");
  const message = alertMessage(locale, record.title, form);
  if (email.includes("@") && minor !== null) {
    const previous = req.cookies[alertCookie];
    const token = appendAlert(previous, { item_id: record.id, email, target_minor: minor });
    if (token !== previous) setCookie(req, res, token);
  }
  return message;
}
