import { createFileRoute } from "@tanstack/react-router";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import { alertCookie, alertLifetime, ensureSession, readAlerts } from "../alerts.server";

export const Route = createFileRoute("/api/alerts")({
  server: { handlers: { GET: ({ request }) => {
    const previous = getCookie(alertCookie);
    const token = ensureSession(previous);
    if (token !== previous) setCookie(alertCookie, token, {
      path: "/", httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", maxAge: alertLifetime,
    });
    return Response.json(readAlerts(token), { headers: { "Cache-Control": "private, no-store" } });
  } } },
});
