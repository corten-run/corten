import type { IncomingMessage, ServerResponse } from "node:http";
import { alertCookie, alertLifetime, appendAlert, ensureSession, readAlerts } from "./alerts.server";
import { alertMessage, targetAmount, type Locale, type MarketplaceRecord } from "./marketplace";

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
  const email = form.get("email") ?? "";
  const amount = targetAmount(locale, form.get("target_price") ?? "");
  if (email.includes("@") && amount !== null) {
    const previous = req.cookies[alertCookie];
    const token = appendAlert(previous, { item_id: record.id, email, target_minor: Math.round(amount * 100) });
    if (token !== previous) setCookie(req, res, token);
  }
  return alertMessage(locale, record.title, form);
}
