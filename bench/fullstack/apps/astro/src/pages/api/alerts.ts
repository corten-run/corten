import type { APIRoute } from "astro";
import { alertCookie, alertLifetime, ensureSession, readAlerts } from "../../lib/alerts.server";

export const GET: APIRoute = ({ cookies, url }) => {
  const previous = cookies.get(alertCookie)?.value;
  const token = ensureSession(previous);
  if (token !== previous) cookies.set(alertCookie, token, {
    path: "/", httpOnly: true, sameSite: "lax", secure: url.protocol === "https:", maxAge: alertLifetime,
  });
  return Response.json(readAlerts(token), { headers: { "Cache-Control": "private, no-store" } });
};
