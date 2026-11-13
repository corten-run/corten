import { alertCookie, alertLifetime, ensureSession, readAlerts } from "../utils/alerts";

export default defineEventHandler((event) => {
  const previous = getCookie(event, alertCookie);
  const token = ensureSession(previous);
  if (token !== previous) setCookie(event, alertCookie, token, {
    path: "/", httpOnly: true, sameSite: "lax", secure: getRequestURL(event).protocol === "https:", maxAge: alertLifetime,
  });
  setHeader(event, "Cache-Control", "private, no-store");
  return readAlerts(token);
});
