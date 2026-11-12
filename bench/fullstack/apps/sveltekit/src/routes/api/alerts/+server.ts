import { json } from "@sveltejs/kit";
import { alertCookie, alertLifetime, ensureSession, readAlerts } from "#lib/server/alerts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ cookies, url }) => {
  const previous = cookies.get(alertCookie);
  const token = ensureSession(previous);
  if (token !== previous) cookies.set(alertCookie, token, {
    path: "/", httpOnly: true, sameSite: "lax", secure: url.protocol === "https:", maxAge: alertLifetime,
  });
  return json(readAlerts(token), { headers: { "Cache-Control": "private, no-store" } });
};
